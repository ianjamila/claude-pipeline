// `pipeline redraft --pr N [--reason CODE]` through the real CLI against the scripted fake gh and the fake hold provider
// (test/helpers/merge-hold-env.mjs): release the merge hold, then (ci.draft_while_iterating) turn a ready PR back to draft.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BASE_SHA, LOCK_DIR, PR, cli, scenario, ymlFor } from './helpers/gate-env.mjs';
import { assertExit } from './helpers/assert-exit.mjs';
import { FAKE_HOLD, holdCalls, holdFiles, holdPuts, holdYml } from './helpers/merge-hold-env.mjs';
import { RELEASE_REASONS, recordSuccessor } from '../pipeline/lib/merge-hold.mjs';
import { mergeLockName } from '../pipeline/lib/hold.mjs';
import { openRecord } from '../pipeline/lib/merge-queue.mjs';
import { release as releaseLock, tryAcquire } from '../pipeline/lib/locks.mjs';

const VIEW = '^pr view 12 --json number,state,isDraft,headRefOid,autoMergeRequest$';
const NODE = { match: 'PrNodeId', stdoutJson: { data: { repository: { pullRequest: { id: 'PR_node12' } } } } };
const mutation = (pullRequest = { isDraft: true, autoMergeRequest: null }) => ({ match: 'convertPullRequestToDraft', stdoutJson: { data: { convertPullRequestToDraft: { pullRequest } } } });
const MUTATES = /convertPullRequestToDraft|-X (POST|PUT|PATCH|DELETE)|^pr (merge|ready|edit)/;
// The fake hold script logs `<verb> <n>` with n = the convert mutations the fake gh had seen when the hold command ran (0 = before the mutation).
const holdBeforeMutation = { ...holdFiles, 'scripts/fake-hold.mjs': FAKE_HOLD.replace("includes('-X PUT')", "includes('convertPullRequestToDraft')") };

const ymlWith = (base, iterating) => base.replace('  guard_checks: false\n', `  guard_checks: false\n  draft_while_iterating: ${iterating}\n`);

// view: the PR as `pr view` reports it (viewReply replaces the whole reply); entries: scripted gh entries (or a function of the scenario) placed first; the rest are the gate-env defaults.
function world({ iterating = true, holds = true, view = {}, viewReply = null, entries = [], gh = {}, baseFiles } = {}) {
  return scenario({
    yml: ymlWith(holds ? holdYml() : ymlFor(), iterating),
    baseFiles: baseFiles ?? holdBeforeMutation,
    report: null,
    state: null,
    gh: {
      ...gh,
      extra: (o) => [
        { match: VIEW, ...(viewReply ?? { stdoutJson: { number: PR, state: 'OPEN', isDraft: false, headRefOid: o.prHead, autoMergeRequest: null, ...view } }) },
        NODE,
        ...(Array.isArray(entries) ? entries : entries(o)),
      ],
    },
  });
}
const redraft = (s, args = [], env = {}) => cli(['redraft', '--pr', String(PR), ...args], { dir: s.repo.dir, fake: s.fake, env });
const writes = (s) => s.fake.lines().filter((l) => MUTATES.test(l));
const mutations = (s) => s.fake.lines().filter((l) => l.includes('convertPullRequestToDraft'));

test('redraft is a registered command whose usage names its flags and refusals', () => {
  const s = world();
  const r = cli(['redraft', '--help'], { dir: s.repo.dir, fake: s.fake });
  assertExit(r, 0);
  assert.match(r.json.usage, /pipeline redraft --pr N \[--reason <new-commits\|/);
  assert.match(r.json.usage, /merge-in-progress/);
  assert.match(r.json.usage, /draft-not-iterating/);
  assert.ok(cli(['--help'], { dir: s.repo.dir, fake: s.fake }).json.commands.includes('redraft'));
});

test('1. ready + iterating + holds: the hold is released (redraft sentence) BEFORE the convert mutation; exit 0 changed:true, draft:true', () => {
  const s = world({ entries: [mutation()] });
  const r = redraft(s);
  assertExit(r, 0, r.stdout);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.pr, PR);
  assert.equal(r.json.head, s.head);
  assert.equal(r.json.wasDraft, false);
  assert.equal(r.json.draft, true);
  assert.equal(r.json.changed, true);
  assert.equal('skipped' in r.json, false);
  assert.equal(r.json.holdRelease.reason, 'redraft');
  assert.equal(r.json.holdRelease.confirmed, true);
  assert.deepEqual(r.json.warnings, []);
  assert.deepEqual(holdCalls(s), [`release ${PR} ${RELEASE_REASONS.redraft}`]);
  assert.deepEqual(holdPuts(s), ['release 0'], 'the release ran before any convert mutation');
  assert.equal(mutations(s).length, 1);
  assert.match(mutations(s)[0], /pullRequestId=PR_node12/);
});

test('2. --reason ci-failed releases with the ci-failed sentence; an unknown reason is exit 2 and runs nothing', () => {
  const s = world({ entries: [mutation()] });
  const r = redraft(s, ['--reason', 'ci-failed']);
  assertExit(r, 0, r.stdout);
  assert.equal(r.json.holdRelease.reason, 'ci-failed');
  assert.deepEqual(holdCalls(s), [`release ${PR} ${RELEASE_REASONS['ci-failed']}`]);

  const bad = world({ entries: [mutation()] });
  const b = redraft(bad, ['--reason', 'because; echo pwned']);
  assertExit(b, 2, b.stdout);
  assert.equal(b.json.error, 'usage');
  assert.match(b.json.message, /--reason must be one of .*redraft/);
  assert.deepEqual(holdCalls(bad), []);
  assert.deepEqual(bad.fake.calls(), []);
});

test('3. already draft + holds: the release runs, no mutation, changed:false; a draft on the pipeline\'s own successor head keeps the hold', () => {
  const s = world({ view: { isDraft: true }, entries: [mutation()] });
  const r = redraft(s);
  assertExit(r, 0, r.stdout);
  assert.equal(r.json.wasDraft, true);
  assert.equal(r.json.draft, true);
  assert.equal(r.json.changed, false);
  assert.equal(r.json.holdRelease.confirmed, true);
  assert.deepEqual(holdCalls(s), [`release ${PR} ${RELEASE_REASONS.redraft}`]);
  assert.deepEqual(mutations(s), []);

  const from = 'a'.repeat(40);
  const own = world({ view: { isDraft: true }, entries: (o) => [{ match: `commits/${o.prHead} --jq`, stdoutJson: [from, BASE_SHA] }, mutation()] });
  recordSuccessor(own.repo.dir, PR, { from, to: own.head, baseSha: BASE_SHA });
  const k = redraft(own);
  assertExit(k, 0, k.stdout);
  assert.equal(k.json.changed, false);
  assert.equal('holdRelease' in k.json, false, 'the hold taken for the pipeline\'s own catch-up is kept');
  assert.deepEqual(holdCalls(own), []);
  assert.deepEqual(mutations(own), []);
});

test('4. not iterating (ci.draft_while_iterating false): the release runs, no mutation, skipped:draft-not-iterating', () => {
  const s = world({ iterating: false, entries: [mutation()] });
  const r = redraft(s);
  assertExit(r, 0, r.stdout);
  assert.equal(r.json.changed, false);
  assert.equal(r.json.draft, false);
  assert.equal(r.json.skipped, 'draft-not-iterating');
  assert.equal(r.json.holdRelease.confirmed, true);
  assert.deepEqual(holdCalls(s), [`release ${PR} ${RELEASE_REASONS.redraft}`]);
  assert.deepEqual(mutations(s), []);
});

test('5. holds not configured: no release (and no hold output); the conversion still happens', () => {
  const s = world({ holds: false, entries: [mutation()] });
  const r = redraft(s);
  assertExit(r, 0, r.stdout);
  assert.equal(r.json.changed, true);
  assert.equal(r.json.draft, true);
  assert.equal('holdRelease' in r.json, false);
  assert.deepEqual(holdCalls(s), []);
  assert.equal(mutations(s).length, 1);
});

test('6. a closed or merged PR is exit 1 not-open and nothing is written (no release, no mutation)', () => {
  for (const state of ['CLOSED', 'MERGED']) {
    const s = world({ view: { state }, entries: [mutation()] });
    const r = redraft(s);
    assertExit(r, 1, r.stdout);
    assert.equal(r.json.ok, false);
    assert.equal(r.json.reason, 'not-open', state);
    assert.deepEqual(holdCalls(s), []);
    assert.deepEqual(writes(s), []);
  }
});

test('7. merge-in-progress, each trigger (queue entry, armed auto-merge, local merge lock, live queue record): exit 1, no release, no mutation', () => {
  const refused = (s, label, pattern) => {
    const r = redraft(s);
    assertExit(r, 1, `${label}: ${r.stdout}`);
    assert.equal(r.json.ok, false, label);
    assert.equal(r.json.reason, 'merge-in-progress', label);
    assert.match(r.json.message, pattern, label);
    assert.deepEqual(holdCalls(s), [], `${label}: no release`);
    assert.deepEqual(writes(s), [], `${label}: no writes`);
  };

  const queued = world({
    entries: [{ match: 'QueueState', stdoutJson: { data: { repository: { pullRequest: { id: 'PR_node12', state: 'OPEN', headRefOid: 'f'.repeat(40), isMergeQueueEnabled: true, mergeCommit: null, mergeQueueEntry: { id: 'MQE_1', state: 'QUEUED', position: 1, enqueuedAt: '2026-11-12T01:00:00Z', headCommit: null } } } } } }, mutation()],
  });
  refused(queued, 'queue entry', /merge queue/);

  refused(world({ view: { autoMergeRequest: { enabledAt: '2026-11-12T01:00:00Z' } }, entries: [mutation()] }), 'armed auto-merge', /auto-merge is armed/);

  const locked = world({ entries: [mutation()] });
  const lock = tryAcquire(mergeLockName('acme/widgets', PR), { dir: LOCK_DIR, pid: process.pid, machineId: 'gate-env-test-machine' });
  assert.equal(lock.acquired, true);
  try {
    refused(locked, 'local merge', /another `P merge` for #12 is running/);
  } finally {
    releaseLock(lock.lock);
  }

  const recorded = world({ entries: [mutation()] });
  openRecord(recorded.repo.dir, PR, recorded.head, {}, { repo: 'acme/widgets', repoId: 1 });
  refused(recorded, 'live queue record', /merge-queue record/);
});

test('8. a mutation that answers isDraft:false, or errors, is exit 1 convert-failed; an unreachable GitHub (read, queue read, mutation) is exit 3', () => {
  const notDraft = world({ entries: [mutation({ isDraft: false, autoMergeRequest: null })] });
  const a = redraft(notDraft);
  assertExit(a, 1, a.stdout);
  assert.equal(a.json.reason, 'convert-failed');
  assert.equal(a.json.holdRelease.confirmed, true, 'the release already ran and is reported');
  assert.equal(a.json.changed, false);

  const refusedMutation = world({ entries: [{ match: 'convertPullRequestToDraft', code: 1, stderr: 'gh: Resource not accessible by integration' }] });
  const b = redraft(refusedMutation);
  assertExit(b, 1, b.stdout);
  assert.equal(b.json.reason, 'convert-failed');
  assert.match(b.json.message, /Resource not accessible/);

  const down = world({ entries: [{ match: 'convertPullRequestToDraft', code: 1, stderr: 'gh: Server Error (HTTP 502)' }] });
  const c = redraft(down);
  assertExit(c, 3, c.stdout);
  assert.equal(c.json.unavailable, true);

  const readFails = world({ viewReply: { code: 1, stderr: 'gh: Server Error (HTTP 502)' } });
  const d = redraft(readFails);
  assertExit(d, 3, d.stdout);
  assert.equal(d.json.ok, false);
  assert.equal(d.json.unavailable, true);
  assert.deepEqual(holdCalls(readFails), [], 'a failed read changes nothing');

  const queueFails = world({ gh: { queue: 'error' }, entries: [mutation()] });
  const e = redraft(queueFails);
  assertExit(e, 3, e.stdout);
  assert.equal(e.json.unavailable, true);
  assert.deepEqual(holdCalls(queueFails), []);
  assert.deepEqual(mutations(queueFails), []);
});

test('9. a release that is NOT confirmed is still exit 0 with holdRelease.confirmed:false and a warning; the conversion is done', () => {
  const s = world({ entries: [mutation()] });
  const r = redraft(s, [], { FAKE_HOLD_RELEASE_EXIT: '1' });
  assertExit(r, 0, r.stdout);
  assert.equal(r.json.holdRelease.confirmed, false);
  assert.equal(r.json.holdRelease.code, 1);
  assert.equal(r.json.changed, true);
  assert.equal(r.json.draft, true);
  assert.equal(r.json.warnings.length, 1);
  assert.match(r.json.warnings[0], /NOT released/);
  assert.match(r.json.warnings[0], new RegExp(`merge-hold --pr ${PR} --release --reason redraft`));
  assert.equal(mutations(s).length, 1);
});

test('10. auto-merge armed in the mutation answer is disabled and reported (autoMergeDisabled:true)', () => {
  const s = world({ entries: [mutation({ isDraft: true, autoMergeRequest: { enabledAt: '2026-11-12T01:00:00Z' } })] });
  const r = redraft(s);
  assertExit(r, 0, r.stdout);
  assert.equal(r.json.changed, true);
  assert.equal(r.json.autoMergeDisabled, true);
  assert.ok(s.fake.lines().some((l) => /^pr merge 12 --disable-auto/.test(l)));

  const stuck = world({ gh: { disableAutoCode: 1 }, entries: [mutation({ isDraft: true, autoMergeRequest: { enabledAt: '2026-11-12T01:00:00Z' } })] });
  const k = redraft(stuck);
  assertExit(k, 0, k.stdout);
  assert.equal(k.json.autoMergeDisabled, false);
  assert.match(k.json.warnings.join(' '), /could not be disabled/);
});
