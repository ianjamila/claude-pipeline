// `pipeline redraft --pr N [--reason CODE]` through the real CLI against the scripted fake gh and the fake hold provider
// (test/helpers/merge-hold-env.mjs): release the merge hold, then (ci.draft_while_iterating) turn a ready PR back to draft.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BASE_SHA, LOCK_DIR, PR, cli, scenario, ymlFor } from './helpers/gate-env.mjs';
import { assertExit } from './helpers/assert-exit.mjs';
import { FAKE_HOLD, holdCalls, holdFiles, holdPuts, holdYml } from './helpers/merge-hold-env.mjs';
import { RELEASE_REASONS, recordSuccessor } from '../pipeline/lib/merge-hold.mjs';
import { mergeLockName } from '../pipeline/lib/hold.mjs';
import { openRecord, queueRecordPath } from '../pipeline/lib/merge-queue.mjs';
import { release as releaseLock, tryAcquire } from '../pipeline/lib/locks.mjs';

// The step-1 read (plus headRefName with --before-push) and the re-reads after a failed conversion all use this view.
const VIEW_ANY = '^pr view 12 --json number,state,isDraft,headRefOid,autoMergeRequest(,headRefName)?$';
const NODE = { match: 'PrNodeId', stdoutJson: { data: { repository: { pullRequest: { id: 'PR_node12' } } } } };
const mutation = (pullRequest = { isDraft: true, autoMergeRequest: null }) => ({ match: 'convertPullRequestToDraft', stdoutJson: { data: { convertPullRequestToDraft: { pullRequest } } } });
const MUTATES = /convertPullRequestToDraft|-X (POST|PUT|PATCH|DELETE)|^pr (merge|ready|edit)/;
// The fake hold script logs `<verb> <n>` with n = the convert mutations the fake gh had seen when the hold command ran (0 = before the mutation).
const holdBeforeMutation = { ...holdFiles, 'scripts/fake-hold.mjs': FAKE_HOLD.replace("includes('-X PUT')", "includes('convertPullRequestToDraft')") };

const ymlWith = (base, iterating, guards = false) => base.replace('  guard_checks: false\n', `  guard_checks: ${guards}\n  draft_while_iterating: ${iterating}\n`);

// view: the PR as `pr view` reports it (viewReply replaces the whole reply); entries: scripted gh entries (or a function of the scenario) placed first; the rest are the gate-env defaults.
function world({ iterating = true, holds = true, guards = false, view = {}, viewReply = null, entries = [], gh = {}, baseFiles } = {}) {
  return scenario({
    yml: ymlWith(holds ? holdYml() : ymlFor(), iterating, guards),
    baseFiles: baseFiles ?? holdBeforeMutation,
    report: null,
    state: null,
    gh: {
      ...gh,
      extra: (o) => [
        { match: VIEW_ANY, ...((typeof viewReply === 'function' ? viewReply(o) : viewReply) ?? { stdoutJson: { number: PR, state: 'OPEN', isDraft: false, headRefOid: o.prHead, headRefName: 'agent/feature', autoMergeRequest: null, ...view } }) },
        NODE,
        ...(Array.isArray(entries) ? entries : entries(o)),
      ],
    },
  });
}
// PIPELINE_REDRAFT_PAUSE_MS shortens the pauses between re-reads and hold-release retries.
const redraft = (s, args = [], env = {}) => cli(['redraft', '--pr', String(PR), ...args], { dir: s.repo.dir, fake: s.fake, env: { PIPELINE_REDRAFT_PAUSE_MS: '1', ...env } });
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
  assert.equal('autoMergeDisabled' in r.json, false, 'nothing armed: no do-not-push signal');
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
  assert.equal('autoMergeDisabled' in r.json, false);
  assert.equal(r.json.holdRelease.confirmed, true);
  assert.deepEqual(holdCalls(s), [`release ${PR} ${RELEASE_REASONS.redraft}`]);
  assert.deepEqual(mutations(s), []);

  const from = 'a'.repeat(40);
  const own = world({ view: { isDraft: true }, entries: (o) => [{ match: `commits/${o.prHead} --jq`, stdoutJson: [from, BASE_SHA] }, mutation()] });
  recordSuccessor(own.repo.dir, PR, { from, to: own.head, baseSha: BASE_SHA });
  const k = redraft(own);
  assertExit(k, 0, k.stdout);
  assert.equal(k.json.changed, false);
  assert.equal('autoMergeDisabled' in k.json, false);
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
  assert.equal('autoMergeDisabled' in r.json, false);
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

test('7b. an unreadable local merge-queue record (malformed JSON) fails closed: exit 1 merge-in-progress, no release, no mutation, nothing written', () => {
  for (const [label, text] of [['invalid JSON', '{"pr": 12, "head": '], ['not a record', '[]']]) {
    const s = world({ entries: [mutation()] });
    const file = queueRecordPath(s.repo.dir, PR);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
    const r = redraft(s);
    assertExit(r, 1, `${label}: ${r.stdout}`);
    assert.equal(r.json.ok, false, label);
    assert.equal(r.json.reason, 'merge-in-progress', label);
    assert.match(r.json.message, /unreadable/, label);
    assert.match(r.json.message, /do NOT push/, label);
    assert.deepEqual(holdCalls(s), [], `${label}: a corrupt record may own a lifted hold, so no release`);
    assert.deepEqual(writes(s), [], `${label}: no conversion, no other write`);
    assert.equal(readFileSync(file, 'utf8'), text, `${label}: the record is left as found`);
  }
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
  assert.equal(b.json.stage, 'convert');
  assert.match(b.json.message, /Resource not accessible/);

  const down = world({ entries: [{ match: 'convertPullRequestToDraft', code: 1, stderr: 'gh: Server Error (HTTP 502)' }] });
  const c = redraft(down);
  assertExit(c, 3, c.stdout);
  assert.equal(c.json.unavailable, true);
  assert.equal(c.json.stage, 'convert', 'the refusal checks had passed: only this exit 3 may be pushed past');

  const readFails = world({ viewReply: { code: 1, stderr: 'gh: Server Error (HTTP 502)' } });
  const d = redraft(readFails);
  assertExit(d, 3, d.stdout);
  assert.equal(d.json.ok, false);
  assert.equal(d.json.unavailable, true);
  assert.equal(d.json.stage, 'read', 'the merge-in-progress check could not run: never pushed past');
  assert.deepEqual(holdCalls(readFails), [], 'a failed read changes nothing');

  const queueFails = world({ gh: { queue: 'error' }, entries: [mutation()] });
  const e = redraft(queueFails);
  assertExit(e, 3, e.stdout);
  assert.equal(e.json.unavailable, true);
  assert.equal(e.json.stage, 'read');
  assert.deepEqual(holdCalls(queueFails), []);
  assert.deepEqual(mutations(queueFails), []);
});

test('8b. the repo read that names the merge lock fails before the lock exists: exit 3 stage:read, nothing changed, no lock left behind', () => {
  const s = world({ entries: [{ match: '^repo view', code: 1, stderr: 'gh: Server Error (HTTP 502)' }, mutation()] });
  const r = redraft(s);
  assertExit(r, 3, r.stdout);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.unavailable, true);
  assert.equal(r.json.stage, 'read', 'Rule 8: stage read means do NOT push');
  assert.notEqual(r.json.error, 'internal');
  assert.deepEqual(holdCalls(s), []);
  assert.deepEqual(writes(s), []);
  const after = tryAcquire(mergeLockName('acme/widgets', PR), { dir: LOCK_DIR, machineId: 'gate-env-test-machine' });
  assert.equal(after.acquired, true, 'no merge lock left behind');
  releaseLock(after.lock);
});

test('9. a release that is NOT confirmed is still exit 0 with holdRelease.confirmed:false and a warning; the conversion is done', () => {
  const s = world({ entries: [mutation()] });
  const r = redraft(s, [], { FAKE_HOLD_RELEASE_EXIT: '1' });
  assertExit(r, 0, r.stdout);
  assert.equal(r.json.holdRelease.confirmed, false);
  assert.equal(r.json.holdRelease.code, 1);
  assert.equal(r.json.holdRelease.attempts, 2, 'the release is tried once more');
  assert.equal(holdCalls(s).length, 2);
  assert.match(r.json.warnings[0], /again/);
  assert.equal(r.json.changed, true);
  assert.equal(r.json.draft, true);
  assert.equal(r.json.warnings.length, 1);
  assert.match(r.json.warnings[0], /NOT released/);
  assert.match(r.json.warnings[0], new RegExp(`merge-hold --pr ${PR} --release --reason redraft`));
  assert.equal(mutations(s).length, 1);
});

test('10. auto-merge armed in the mutation answer is disabled and ALWAYS reported: exit 0, a warning that the owner\'s merge was cancelled, do NOT push (#303)', () => {
  const s = world({ entries: [mutation({ isDraft: true, autoMergeRequest: { enabledAt: '2026-11-12T01:00:00Z' } })] });
  const r = redraft(s);
  assertExit(r, 0, r.stdout);
  assert.equal(r.json.changed, true);
  assert.equal(r.json.autoMergeDisabled, true);
  assert.equal(r.json.warnings.length, 1);
  assert.match(r.json.warnings[0], /cancelled/);
  assert.match(r.json.warnings[0], /do NOT push/);
  assert.match(r.json.warnings[0], /tell the owner/);
  assert.ok(s.fake.lines().some((l) => /^pr merge 12 --disable-auto/.test(l)));

  const stuck = world({ gh: { disableAutoCode: 1 }, entries: [mutation({ isDraft: true, autoMergeRequest: { enabledAt: '2026-11-12T01:00:00Z' } })] });
  const k = redraft(stuck);
  assertExit(k, 0, k.stdout);
  assert.equal(k.json.autoMergeDisabled, false);
  assert.equal(k.json.warnings.length, 1);
  assert.match(k.json.warnings[0], /could not be disabled/);
  assert.match(k.json.warnings[0], new RegExp(`ask the owner to run \`gh pr merge ${PR} --disable-auto\`, confirm it is off, and wait for their word`));
  assert.match(k.json.warnings[0], /do NOT push/);
  assert.match(k.json.warnings[0], /tell the owner/);
});

test('11. exit 3 vs convert-failed is judged on gh\'s stderr: a "network" in the gh arguments or GitHub\'s "Could not resolve to a node" refusal is convert-failed; "could not resolve host" is exit 3', () => {
  // The node id reaches the error message through the gh arguments (pullRequestId=...), never the stderr; "network" and "timeout" in it must not make a refusal exit 3.
  const named = world({ entries: [
    { match: 'PrNodeId', stdoutJson: { data: { repository: { pullRequest: { id: 'PR_network_timeout_connection' } } } } },
    { match: 'convertPullRequestToDraft', code: 1, stderr: 'gh: Resource not accessible by integration' },
  ] });
  const a = redraft(named);
  assertExit(a, 1, a.stdout);
  assert.match(a.json.message, /Resource not accessible/);
  assert.equal(a.json.reason, 'convert-failed');

  const node = world({ entries: [{ match: 'convertPullRequestToDraft', code: 1, stderr: 'gh: Could not resolve to a node with the global id of \'PR_node12\'' }] });
  const b = redraft(node);
  assertExit(b, 1, b.stdout);
  assert.equal(b.json.reason, 'convert-failed');
  assert.equal(b.json.stage, 'convert');

  const host = world({ entries: [{ match: 'convertPullRequestToDraft', code: 1, stderr: 'gh: error connecting: could not resolve host: api.github.com' }] });
  const c = redraft(host);
  assertExit(c, 3, c.stdout);
  assert.equal(c.json.stage, 'convert');
});

test('12. the PR\'s merge lock is held through the hold release and the conversion: a merge started meanwhile cannot take it, and it is free again afterwards', () => {
  const name = mergeLockName('acme/widgets', PR);
  const locks = new URL('../pipeline/lib/locks.mjs', import.meta.url).href;
  // The hold provider plays the second merge: while redraft's release is running it tries to take the same merge lock.
  const probe = [
    "if (verb === 'release') {",
    `  const { tryAcquire } = await import(${JSON.stringify(locks)});`,
    `  const got = tryAcquire(${JSON.stringify(name)}, { dir: process.env.PIPELINE_LOCK_DIR, machineId: 'gate-env-test-machine' });`,
    "  appendFileSync('.review/lock-probe.log', `${got.acquired}\\n`);",
    '}',
  ].join('\n');
  const probing = { ...holdFiles, 'scripts/fake-hold.mjs': FAKE_HOLD.replace("const exit = (name)", `${probe}\nconst exit = (name)`) };
  const s = world({ baseFiles: probing, entries: [mutation()] });
  const r = redraft(s);
  assertExit(r, 0, r.stdout);
  assert.equal(r.json.changed, true);
  assert.equal(readFileSync(join(s.repo.dir, '.review', 'lock-probe.log'), 'utf8').trim(), 'false', 'a second merge could not take the lock during the release');
  // ...and the lock is gone once redraft has returned.
  const after = tryAcquire(name, { dir: LOCK_DIR, machineId: 'gate-env-test-machine' });
  assert.equal(after.acquired, true);
  releaseLock(after.lock);
});

// ---- B1: a lost reply to the conversion is reconciled before anything is said about pushing -----------------------------------------

const LOST = { match: 'convertPullRequestToDraft', code: 1, stderr: 'gh: Server Error (HTTP 502)' };
const EMPTY_ANSWER = { match: 'convertPullRequestToDraft', stdoutJson: { data: { convertPullRequestToDraft: { pullRequest: null } } } };
const ARMED = { enabledAt: '2026-11-12T01:00:00Z' };
const unreadable = { code: 1, stderr: 'gh: Server Error (HTTP 502)' };
const queueEntry = { data: { repository: { pullRequest: { id: 'PR_node12', state: 'OPEN', headRefOid: 'f'.repeat(40), isMergeQueueEnabled: true, mergeCommit: null, mergeQueueEntry: { id: 'MQE_1', state: 'QUEUED', position: 2, enqueuedAt: '2026-11-12T01:00:00Z', headCommit: null } } } } };
const noEntry = { data: { repository: { pullRequest: { id: 'PR_node12', state: 'OPEN', headRefOid: 'f'.repeat(40), isMergeQueueEnabled: true, mergeCommit: null, mergeQueueEntry: null } } } };
// The nth `pr view` answers seq[n] (the last repeats): each item is the fields that differ from a ready, unarmed PR on the head of step 1.
const viewSeq = (...steps) => (o) => ({ seq: steps.map((s) => (s.code ? s : { stdoutJson: { number: PR, state: 'OPEN', isDraft: false, headRefOid: o.prHead, autoMergeRequest: null, ...s } })) });
const viewCalls = (s) => s.fake.lines().filter((l) => /^pr view 12 --json number,state,isDraft/.test(l)).length;
const lost = (steps, extra = {}) => world({ viewReply: viewSeq(...steps), entries: [LOST], ...extra });

test('13. a lost reply, the PR is a draft on re-read: reconciled-converted, exit 0, changed, push allowed (no autoMergeDisabled)', () => {
  const s = lost([{}, { isDraft: true }]);
  const r = redraft(s);
  assertExit(r, 0, r.stdout);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.outcome, 'reconciled-converted');
  assert.equal(r.json.changed, true);
  assert.equal(r.json.draft, true);
  assert.equal('autoMergeDisabled' in r.json, false);
  assert.equal(r.json.holdRelease.confirmed, true);
  assert.equal(mutations(s).length, 1, 'the mutation is not repeated');
  assert.equal(viewCalls(s), 2, 'step 1 plus one re-read');
});

test('13a. a lost reply, the draft has auto-merge armed: it is disabled (autoMergeDisabled:true, do NOT push); not disabled: false', () => {
  const s = lost([{}, { isDraft: true, autoMergeRequest: ARMED }]);
  const r = redraft(s);
  assertExit(r, 0, r.stdout);
  assert.equal(r.json.outcome, 'reconciled-converted');
  assert.equal(r.json.autoMergeDisabled, true);
  assert.match(r.json.warnings.at(-1), /cancelled/);
  assert.match(r.json.warnings.at(-1), /do NOT push/);
  assert.ok(s.fake.lines().some((l) => /^pr merge 12 --disable-auto/.test(l)));

  const stuck = lost([{}, { isDraft: true, autoMergeRequest: ARMED }], { gh: { disableAutoCode: 1 } });
  const k = redraft(stuck);
  assertExit(k, 0, k.stdout);
  assert.equal(k.json.outcome, 'reconciled-converted');
  assert.equal(k.json.autoMergeDisabled, false);
  assert.match(k.json.warnings.at(-1), /could not be disabled/);
});

test('13b. a lost reply, a merge-queue entry appears (or auto-merge is armed on the still-ready PR): merge-in-progress, exit 1, no push', () => {
  const queued = world({ viewReply: viewSeq({}, { isDraft: true }), entries: [LOST, { match: 'QueueState', seq: [{ stdoutJson: noEntry }, { stdoutJson: queueEntry }] }] });
  const a = redraft(queued);
  assertExit(a, 1, a.stdout);
  assert.equal(a.json.reason, 'merge-in-progress');
  assert.equal(a.json.outcome, 'merge-in-progress');
  assert.match(a.json.message, /merge queue/);
  assert.match(a.json.message, /do NOT push/);

  const armed = lost([{}, { autoMergeRequest: ARMED }]);
  const b = redraft(armed);
  assertExit(b, 1, b.stdout);
  assert.equal(b.json.outcome, 'merge-in-progress');
  assert.match(b.json.message, /auto-merge is armed/);
  assert.deepEqual(armed.fake.lines().filter((l) => /--disable-auto/.test(l)), [], 'a ready PR with armed auto-merge is the owner\'s merge: not touched');
});

test('13c. a lost reply, the head moved or the PR closed during the re-reads: head-moved / not-open, exit 1, no push', () => {
  const moved = lost([{}, { headRefOid: 'e'.repeat(40) }]);
  const a = redraft(moved);
  assertExit(a, 1, a.stdout);
  assert.equal(a.json.reason, 'head-moved');
  assert.equal(a.json.outcome, 'head-moved');
  assert.match(a.json.message, /do NOT push/);

  for (const state of ['CLOSED', 'MERGED']) {
    const gone = lost([{}, { state }]);
    const b = redraft(gone);
    assertExit(b, 1, `${state}: ${b.stdout}`);
    assert.equal(b.json.reason, 'not-open', state);
    assert.equal(b.json.outcome, 'not-open', state);
  }
});

test('13d. a lost reply, still ready after 3 re-reads: convert-unconfirmed, exit 3 stage convert, do NOT push; an unreadable re-read is unknown', () => {
  const s = lost([{}]);
  const r = redraft(s);
  assertExit(r, 3, r.stdout);
  assert.equal(r.json.unavailable, true);
  assert.equal(r.json.stage, 'convert');
  assert.equal(r.json.outcome, 'convert-unconfirmed');
  assert.match(r.json.message, /do NOT push/);
  assert.match(r.json.message, /redraft --pr 12/);
  assert.equal(viewCalls(s), 4, 'step 1 plus three re-reads');
  assert.equal(mutations(s).length, 1);

  const blind = lost([{}, unreadable]);
  const u = redraft(blind);
  assertExit(u, 3, u.stdout);
  assert.equal(u.json.stage, 'convert');
  assert.equal(u.json.outcome, 'unknown');
  assert.match(u.json.message, /do NOT push/);
  assert.equal(viewCalls(blind), 4, 'every re-read was tried');
});

test('13e. a delayed completion: three re-reads still ready, the mutation lands later; the next redraft run sees the draft (auto-merge armed) and settles it', () => {
  const s = lost([{}, {}, {}, {}, { isDraft: true, autoMergeRequest: ARMED }]);
  const first = redraft(s);
  assertExit(first, 3, first.stdout);
  assert.equal(first.json.outcome, 'convert-unconfirmed');
  const second = redraft(s);
  assertExit(second, 0, second.stdout);
  assert.equal(second.json.wasDraft, true);
  assert.equal(second.json.outcome, 'already-draft');
  assert.equal(second.json.autoMergeDisabled, true);
  assert.equal(mutations(s).length, 1, 'the second run does not convert again');
});

test('13f. the code-0 answer without a pull request is a lost reply (reconciled), not a rejection; a GraphQL errors body or a refusal is a rejection', () => {
  const draft = world({ viewReply: viewSeq({}, { isDraft: true }), entries: [EMPTY_ANSWER] });
  const a = redraft(draft);
  assertExit(a, 0, a.stdout);
  assert.equal(a.json.outcome, 'reconciled-converted');

  const stillReady = world({ entries: [EMPTY_ANSWER] });
  const b = redraft(stillReady);
  assertExit(b, 3, b.stdout);
  assert.equal(b.json.outcome, 'convert-unconfirmed');

  const graphql = world({ entries: [{ match: 'convertPullRequestToDraft', stdoutJson: { errors: [{ message: 'Pull request is not in a convertible state' }] } }] });
  const c = redraft(graphql);
  assertExit(c, 1, c.stdout);
  assert.equal(c.json.reason, 'convert-failed');
  assert.equal(c.json.outcome, 'convert-failed');
  assert.equal(c.json.stage, 'convert');
  assert.equal(viewCalls(graphql), 2, 'a proven rejection is checked with one fresh read');
});

test('13g. a definite rejection keeps "push anyway" only when the fresh read shows an open, ready PR on the same head with no queue entry and no armed auto-merge', () => {
  const rejected = { match: 'convertPullRequestToDraft', code: 1, stderr: 'gh: Resource not accessible by integration' };
  const clean = world({ entries: [rejected] });
  const a = redraft(clean);
  assertExit(a, 1, a.stdout);
  assert.equal(a.json.outcome, 'convert-failed');
  assert.equal(a.json.reason, 'convert-failed');
  assert.equal(a.json.holdRelease.confirmed, true);

  const armed = world({ viewReply: viewSeq({}, { autoMergeRequest: ARMED }), entries: [rejected] });
  const b = redraft(armed);
  assertExit(b, 1, b.stdout);
  assert.equal(b.json.reason, 'merge-in-progress', 'the owner armed auto-merge during the attempt: never push anyway');
  assert.equal(b.json.outcome, 'merge-in-progress');

  const moved = world({ viewReply: viewSeq({}, { headRefOid: 'e'.repeat(40) }), entries: [rejected] });
  assert.equal(redraft(moved).json.reason, 'head-moved');

  const queued = world({ entries: [rejected, { match: 'QueueState', seq: [{ stdoutJson: noEntry }, { stdoutJson: queueEntry }] }] });
  assert.equal(redraft(queued).json.reason, 'merge-in-progress');

  const blind = world({ viewReply: viewSeq({}, unreadable), entries: [rejected] });
  const e = redraft(blind);
  assertExit(e, 3, e.stdout);
  assert.equal(e.json.outcome, 'unknown', 'not proven: do not push');
});

test('13h. an already-draft PR with auto-merge armed is no merge in progress (GitHub cannot arm a draft): it is disarmed and reported; other triggers still refuse', () => {
  const s = world({ view: { isDraft: true, autoMergeRequest: ARMED }, entries: [mutation()] });
  const r = redraft(s);
  assertExit(r, 0, r.stdout);
  assert.equal(r.json.wasDraft, true);
  assert.equal(r.json.changed, false);
  assert.equal(r.json.outcome, 'already-draft');
  assert.equal(r.json.autoMergeDisabled, true);
  assert.match(r.json.warnings.at(-1), /still armed/);
  assert.match(r.json.warnings.at(-1), /do NOT push/);
  assert.deepEqual(mutations(s), []);

  const stuck = world({ gh: { disableAutoCode: 1 }, view: { isDraft: true, autoMergeRequest: ARMED }, entries: [mutation()] });
  const k = redraft(stuck);
  assertExit(k, 0, k.stdout);
  assert.equal(k.json.autoMergeDisabled, false);
  assert.match(k.json.warnings.at(-1), /could not be disabled/);

  const queued = world({ view: { isDraft: true }, entries: [{ match: 'QueueState', stdoutJson: queueEntry }, mutation()] });
  const q = redraft(queued);
  assertExit(q, 1, q.stdout);
  assert.equal(q.json.reason, 'merge-in-progress');
});

// ---- B4: --before-push ----------------------------------------------------------------------------------------------------------------

const beforePush = (s, env) => redraft(s, ['--before-push'], env);
const refusedNothing = (s) => {
  const r = beforePush(s);
  assertExit(r, 1, r.stdout);
  assert.equal(r.json.reason, 'nothing-to-push');
  assert.deepEqual(holdCalls(s), [], 'nothing released');
  assert.deepEqual(writes(s), [], 'nothing changed');
};

test('14. --before-push refuses (nothing-to-push) when local HEAD equals the PR head, or is an ancestor of it; nothing is released or changed', () => {
  refusedNothing(world({ entries: [mutation()] }));
  const behind = world({ entries: [mutation()] });
  behind.repo.git(['reset', '-q', '--hard', behind.baseTip]); // local is the base commit; the PR head (still in the object store) is a descendant
  refusedNothing(behind);
});

test('14a. --before-push proceeds for a descendant of the PR head and for a diverged HEAD (rebase, amend)', () => {
  const ahead = world({ entries: [mutation()] });
  ahead.repo.write('src/app.js', 'export const a = 3;\n');
  ahead.repo.commit('fix');
  const a = beforePush(ahead);
  assertExit(a, 0, a.stdout);
  assert.equal(a.json.changed, true);
  assert.equal('beforePushUnchecked' in a.json, false);
  assert.equal(mutations(ahead).length, 1);

  const diverged = world({ entries: [mutation()] });
  diverged.repo.git(['reset', '-q', '--hard', diverged.baseTip]);
  diverged.repo.write('src/app.js', 'export const a = 4;\n');
  diverged.repo.commit('rewritten fix');
  const d = beforePush(diverged);
  assertExit(d, 0, d.stdout);
  assert.equal(d.json.changed, true);
});

test('14b. --before-push on another branch than the PR\'s skips the check with beforePushUnchecked and a warning, and proceeds; without the flag nothing is checked', () => {
  const s = world({ entries: [mutation()] });
  s.repo.branch('scratch');
  const r = beforePush(s);
  assertExit(r, 0, r.stdout);
  assert.equal(r.json.beforePushUnchecked, true);
  assert.equal(r.json.changed, true);
  assert.match(r.json.warnings[0], /--before-push could not check/);
  assert.match(r.json.warnings[0], /scratch/);

  const plain = world({ entries: [mutation()] }); // local HEAD == PR head: plain redraft (the late case) still works
  const p = redraft(plain);
  assertExit(p, 0, p.stdout);
  assert.equal(p.json.changed, true);
  assert.equal('beforePushUnchecked' in p.json, false);
});

// ---- B3: an approval label on this head will not survive the fix push -----------------------------------------------------------------

const committedAt = (o, at) => ({ event: 'committed', sha: o.prHead, committer: { date: at }, author: { date: at } });
const labeled = (name, at, event = 'labeled') => ({ event, label: { name }, created_at: at, actor: { login: 'owner' } });
const timeline = (...events) => (o) => [{ match: 'issues/12/timeline', stdoutJson: events.map((e) => (typeof e === 'function' ? e(o) : e)) }, mutation()];
const timelineReads = (s) => s.fake.lines().filter((l) => l.includes('/timeline')).length;

test('15. an approval label newer than the last head change: approvalVoided:true and a warning (no wait, no refusal); an older one, or one removed again, or other labels: none', () => {
  const voided = world({ guards: true, entries: timeline((o) => committedAt(o, '2026-11-12T01:00:00Z'), labeled('human-approved', '2026-11-12T02:00:00Z')) });
  const a = redraft(voided);
  assertExit(a, 0, a.stdout);
  assert.equal(a.json.approvalVoided, true);
  assert.equal(a.json.changed, true, 'the conversion still happens');
  assert.match(a.json.warnings[0], /will not survive the fix push/);
  assert.match(a.json.warnings[0], /re-apply the label/);

  const testApproval = world({ guards: true, entries: timeline((o) => committedAt(o, '2026-11-12T01:00:00Z'), labeled('test-change-approved', '2026-11-12T02:00:00Z')) });
  assert.equal(redraft(testApproval).json.approvalVoided, true);

  for (const [label, events] of [
    ['older than the head', [labeled('human-approved', '2026-11-12T00:00:00Z'), (o) => committedAt(o, '2026-11-12T01:00:00Z')]],
    ['older than a force push', [labeled('human-approved', '2026-11-12T00:00:00Z'), { event: 'head_ref_force_pushed', created_at: '2026-11-12T03:00:00Z' }]],
    ['removed again', [labeled('human-approved', '2026-11-12T02:00:00Z'), labeled('human-approved', '2026-11-12T02:30:00Z', 'unlabeled')]],
    ['another label', [labeled('needs-human', '2026-11-12T02:00:00Z')]],
  ]) {
    const s = world({ guards: true, entries: timeline(...events) });
    const r = redraft(s);
    assertExit(r, 0, `${label}: ${r.stdout}`);
    assert.equal('approvalVoided' in r.json, false, label);
    assert.deepEqual(r.json.warnings, [], label);
  }
});

test('15a. the timeline is read only to convert a ready PR in a repo with guard checks: an already-draft PR, guard_checks false and a non-iterating repo make no read; an unreadable timeline is a warning only', () => {
  const draft = world({ guards: true, view: { isDraft: true }, entries: timeline() });
  assertExit(redraft(draft), 0);
  assert.equal(timelineReads(draft), 0, 'already draft');

  const noGuards = world({ guards: false, entries: timeline() });
  assertExit(redraft(noGuards), 0);
  assert.equal(timelineReads(noGuards), 0, 'guard_checks false');

  const notIterating = world({ guards: true, iterating: false, entries: timeline() });
  assertExit(redraft(notIterating), 0);
  assert.equal(timelineReads(notIterating), 0, 'draft_while_iterating false');

  const read = world({ guards: true, entries: timeline() });
  assertExit(redraft(read), 0);
  assert.equal(timelineReads(read), 1, 'one read');

  const broken = world({ guards: true, entries: [{ match: 'issues/12/timeline', code: 1, stderr: 'gh: Server Error (HTTP 502)' }, mutation()] });
  const b = redraft(broken);
  assertExit(b, 0, b.stdout);
  assert.equal(b.json.changed, true);
  assert.equal('approvalVoided' in b.json, false);
  assert.match(b.json.warnings[0], /timeline could not be read/);
});

// ---- B2: an unconfirmed hold release is run once more ----------------------------------------------------------------------------------

// The release exits 1 the first FAKE_HOLD_RELEASE_FAILS times it is called, then 0.
const flakyRelease = FAKE_HOLD.replace("if (verb === 'release') { console.log('hold released'); exit('FAKE_HOLD_RELEASE_EXIT'); }",
  "if (verb === 'release') { const n = readFileSync(log, 'utf8').split('\\n').filter((l) => l.startsWith('release')).length; console.log('hold released'); process.exit(n <= Number(process.env.FAKE_HOLD_RELEASE_FAILS ?? 0) ? 1 : 0); }");
const flaky = { ...holdBeforeMutation, 'scripts/fake-hold.mjs': flakyRelease.replace("includes('-X PUT')", "includes('convertPullRequestToDraft')") };

test('9b. a release that is not confirmed is run once more: the second confirms (attempts 2, no warning); both failing keeps the warning, now saying "again"', () => {
  assert.ok(flakyRelease.includes('FAKE_HOLD_RELEASE_FAILS'), 'the flaky provider replaced the release line');
  const once = world({ baseFiles: flaky, entries: [mutation()] });
  const a = redraft(once, [], { FAKE_HOLD_RELEASE_FAILS: '1' });
  assertExit(a, 0, a.stdout);
  assert.equal(a.json.holdRelease.confirmed, true);
  assert.equal(a.json.holdRelease.attempts, 2);
  assert.deepEqual(a.json.warnings, []);
  assert.equal(holdCalls(once).length, 2);
  assert.deepEqual(holdPuts(once), ['release 0', 'release 0'], 'both attempts before the conversion');

  const both = world({ baseFiles: flaky, entries: [mutation()] });
  const b = redraft(both, [], { FAKE_HOLD_RELEASE_FAILS: '2' });
  assertExit(b, 0, b.stdout);
  assert.equal(b.json.holdRelease.confirmed, false);
  assert.equal(b.json.holdRelease.attempts, 2);
  assert.equal(b.json.warnings.length, 1);
  assert.match(b.json.warnings[0], /NOT released/);
  assert.match(b.json.warnings[0], new RegExp(`merge-hold --pr ${PR} --release --reason redraft\` again`));
  assert.equal(b.json.changed, true);

  const first = world({ entries: [mutation()] });
  const c = redraft(first);
  assert.equal(c.json.holdRelease.attempts, 1, 'a confirmed first release is not repeated');
  assert.equal(holdCalls(first).length, 1);
});
