// `P merge`, `P update-branch` and `P merge --dry-run` for a repo that keeps a cooperative merge hold (merge.hold_* keys; plan
// 2026-11-05-merge-hold-queue), through the real CLI against the scripted fake gh and a fake hold provider script. A repo without the keys
// is covered by the existing merge tests, which stay unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeRequest, ownerSays } from './helpers/owner-go.mjs';
import { BASE_SHA, bump, cli, ghEntries, scenario, ymlFor, PR } from './helpers/gate-env.mjs';
import { assertExit } from './helpers/assert-exit.mjs';
import { readyLine } from '../pipeline/hooks/lib/owner-go.mjs';
import { RELEASE_REASONS, readSuccessor } from '../pipeline/lib/merge-hold.mjs';
import { EW_QUEUED_LINE, answer, blocker, holdCalls, holdFiles, holdPuts, holdYml, seq } from './helpers/merge-hold-env.mjs';

const BLOCKED = answer(PR, [blocker(1400)]);
const CLEAR = answer(PR, []);
const writes = (s) => s.fake.lines().filter((l) => /-X (POST|PUT|PATCH|DELETE)\b/.test(l) || /^pr (merge|edit|ready|close|comment)\b/.test(l) || /update-branch/.test(l));
const puts = (s) => s.fake.lines().filter((l) => l.includes('-X PUT'));
const checks = (s) => holdCalls(s).filter((l) => l.startsWith('check'));
const timing = { PIPELINE_UPDATE_WAIT_MS: '0', PIPELINE_UPDATE_POLL_MS: '1' };
const NEW_HEAD = 'd'.repeat(40);

// A gh that, once the update-branch PUT has been made, switches to `entries` (the PR head is then the merge commit GitHub made).
function swapOnUpdate(s, entries) {
  const swap = join(s.fake.dir, 'swap.json');
  const wrapper = join(s.fake.dir, 'swap-gh.mjs');
  writeFileSync(swap, JSON.stringify(entries));
  writeFileSync(wrapper, [
    "import { copyFileSync } from 'node:fs';",
    "if (process.argv.slice(2).join(' ').includes('update-branch')) copyFileSync(process.argv[1].replace(/swap-gh\\.mjs$/, 'swap.json'), process.env.PIPELINE_FAKE_GH_SCRIPT);",
    `await import(${JSON.stringify(new URL('./fixtures/fake-gh.mjs', import.meta.url).href)});`,
    '',
  ].join('\n'));
  return { PIPELINE_GH: `node "${wrapper}"` };
}
// The PR after a good catch-up: head NEW_HEAD = merge of the old head and the base tip; `o` overrides ghEntries (e.g. a failing CI).
const caughtUp = (s, o = {}) => swapOnUpdate(s, ghEntries({ prHead: NEW_HEAD, behindBy: 0, commitParents: { [NEW_HEAD]: [s.head, BASE_SHA] }, ...o }));

// ---- --owner-go ----------------------------------------------------------------------------------------------------------------

const goMergeCmd = 'node scripts/fake-merge.mjs {pr} --match-head-commit {sha}';
// A unique head per fixture: the owner's records are matched on repo, PR and head (see test/owner-go-scan-range.test.mjs).
const unique = (repo) => { bump(repo); repo.write('.salt', randomUUID()); };
const goWorld = (opts = {}) => scenario({ yml: holdYml({ merge: goMergeCmd }), baseFiles: holdFiles, report: null, state: null, change: unique, ...opts });
const goMerge = (s, env = {}) => cli(['merge', '--pr', String(PR), '--owner-go'], { dir: s.repo.dir, fake: s.fake, env: { ...s.env, ...env } });
const approve = (t, s) => ownerSays(t, 'merge', mergeRequest(PR, s.head, 'none'));

test('--owner-go, a hold ahead on a STALE PR: refused as queued-behind BEFORE the live check, no "update the branch" advice, zero GitHub writes', (t) => {
  const s = goWorld({ gh: { mergeStateStatus: 'BEHIND' } });
  approve(t, s);
  const r = goMerge(s, { FAKE_HOLD_CHECK_SEQ: seq(BLOCKED) });
  assertExit(r, 1);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.merged, false);
  assert.equal(r.json.error, 'queued-behind');
  assert.equal(r.json.verdict, 'hold:queued-behind');
  assert.deepEqual(r.json.blockedBy, [1400]);
  assert.equal(r.json.doNotUpdate, true);
  assert.match(r.json.reasons[0], /#1400 "Roster card"/);
  assert.match(r.json.reasons[0], /15:35 PHT/);
  assert.doesNotMatch(JSON.stringify(r.json), /update the branch|behind-base|P update-branch/i, 'the stale-PR advice never appears');
  assert.deepEqual(writes(s), [], 'zero GitHub writes');
  assert.ok(!s.fake.lines().some((l) => /^pr view 12 --json state,headRefOid/.test(l)), 'evaluateOwnerGo never ran (no live PR read)');
  assert.deepEqual(s.mergeCalls(), []);
  assert.equal(checks(s).length, 1);
});

test('--owner-go, contrast: the same stale PR without the hold keys still gets the live-check refusal', (t) => {
  const s = scenario({ yml: ymlFor().replace('{pr} {sha}', '{pr} --match-head-commit {sha}'), report: null, state: null, change: unique, gh: { mergeStateStatus: 'BEHIND' } });
  approve(t, s);
  const r = goMerge(s);
  assertExit(r, 1);
  assert.equal(r.json.error, 'live-check');
  assert.match(JSON.stringify(r.json), /update the branch/);
});

test('--owner-go, an unreadable hold check: hold-unreadable, nothing runs', (t) => {
  const s = goWorld();
  approve(t, s);
  for (const env of [{ FAKE_HOLD_CHECK_EXIT: '1', FAKE_HOLD_CHECK_SEQ: seq(CLEAR) }, { FAKE_HOLD_CHECK_SEQ: seq('not json') }, { FAKE_HOLD_CHECK_SEQ: seq(answer(99, [])) }]) {
    const r = goMerge(s, env);
    assertExit(r, 1);
    assert.equal(r.json.error, 'hold-unreadable', JSON.stringify(env));
    assert.match(r.json.reasons[0], /could not be read/);
    assert.equal('doNotUpdate' in r.json, false);
    assert.deepEqual(s.mergeCalls(), []);
    assert.deepEqual(writes(s), []);
  }
});

test('--owner-go, nothing ahead: merges as before, the check ran once', (t) => {
  const s = goWorld();
  approve(t, s);
  const r = goMerge(s, { FAKE_HOLD_CHECK_SEQ: seq(CLEAR) });
  assertExit(r, 0);
  assert.equal(r.json.merged, true);
  assert.deepEqual(s.mergeCalls(), [`${PR} --match-head-commit ${s.head}`]);
  assert.equal(checks(s).length, 1);
});

test('--owner-go, the merge command prints the queued-behind line on STDERR only and exits 1: queued-behind, blockedBy [1400], auto-merge disarmed and reported', (t) => {
  const s = goWorld({ baseFiles: holdFiles, gh: { mergeView: { state: 'OPEN', mergeCommit: null } } });
  approve(t, s);
  const r = goMerge(s, { FAKE_HOLD_CHECK_SEQ: seq(CLEAR), FAKE_MERGE_QUEUED: EW_QUEUED_LINE });
  assertExit(r, 1);
  assert.equal(r.json.error, 'queued-behind');
  assert.deepEqual(r.json.blockedBy, [1400]);
  assert.equal(r.json.doNotUpdate, true);
  assert.equal(r.json.merged, false);
  assert.equal(r.json.autoMergeDisabled, true);
  assert.equal(r.json.commandExitCode, 1);
  assert.equal(r.json.mode, 'owner-go');
  assert.match(r.json.reasons[0], /queued behind #1400/);
  assert.ok(s.fake.lines().includes('pr merge 12 --disable-auto'), 'auto-merge abandonment still ran first');
  assert.equal(s.mergeCalls().length, 1);
});

test('--owner-go, the queued-behind line placed above 40 lines of output (past the 30-line display tail) is still found', (t) => {
  const s = goWorld({ gh: { mergeView: { state: 'OPEN', mergeCommit: null } } });
  approve(t, s);
  const r = goMerge(s, { FAKE_HOLD_CHECK_SEQ: seq(CLEAR), FAKE_MERGE_QUEUED: EW_QUEUED_LINE, FAKE_MERGE_NOISE: '45' });
  assertExit(r, 1);
  assert.equal(r.json.error, 'queued-behind');
  assert.deepEqual(r.json.blockedBy, [1400]);
  assert.doesNotMatch(r.json.commandOutput, /queued behind/, 'the display tail no longer holds the line');
});

test('--owner-go, the PR is MERGED despite the queued-behind text: reported as merged', (t) => {
  const s = goWorld();
  approve(t, s);
  const r = goMerge(s, { FAKE_HOLD_CHECK_SEQ: seq(CLEAR), FAKE_MERGE_QUEUED: EW_QUEUED_LINE });
  assertExit(r, 0);
  assert.equal(r.json.merged, true);
  assert.equal(r.json.commandExitCode, 1);
  assert.equal('error' in r.json, false);
});

test('--owner-go, a failure that is not queued-behind keeps the generic reason', (t) => {
  const s = goWorld({ gh: { mergeView: { state: 'OPEN', mergeCommit: null } } });
  approve(t, s);
  const r = goMerge(s, { FAKE_HOLD_CHECK_SEQ: seq(CLEAR), FAKE_MERGE_EXIT: '1' });
  assertExit(r, 1);
  assert.equal('error' in r.json, false);
  assert.match(r.json.reason, /merge command failed \(exit 1\) and the PR is not merged/);
});

test('--owner-go, a repo WITHOUT the hold keys ignores the text: the generic reason (existing behaviour)', (t) => {
  const s = scenario({
    yml: ymlFor().replace('{pr} {sha}', '{pr} --match-head-commit {sha}'), baseFiles: holdFiles, report: null, state: null, change: unique,
    gh: { mergeView: { state: 'OPEN', mergeCommit: null } },
  });
  approve(t, s);
  const r = goMerge(s, { FAKE_MERGE_QUEUED: EW_QUEUED_LINE });
  assertExit(r, 1);
  assert.equal('error' in r.json, false);
  assert.match(r.json.reason, /merge command failed \(exit 1\)/);
});

// The two features meet: an eligible needs-human hold is lifted for the owner's "merge" (test/owner-go-hold-lift.test.mjs), the merge
// command then refuses with EagleWatch's queued-behind line (a hold taken after the pre-check). The refusal must reach the caller as
// queued-behind (blockedBy, doNotUpdate kept) AND needs-human must be put back (withHoldLifted wraps mergeAndWait).
const fakeGhHold = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-gh-hold.mjs');
const LIFT = { id: 'LE_hold1', login: 'jamila', at: '2026-11-05T09:00:00Z' };
const LIFT_EVENT = { event: 'labeled', id: 1, node_id: LIFT.id, created_at: LIFT.at, actor: { login: LIFT.login }, label: { name: 'needs-human' } };
const liftWorld = () => {
  const s = scenario({
    yml: `${holdYml({ merge: goMergeCmd })}hard_stops:\n  paths: ['src/**']\nowner_approval: chat\n`, baseFiles: holdFiles, report: null, state: null, change: unique,
    gh: { mergeStateStatus: 'CLEAN', labels: ['needs-human'], mergeView: { state: 'OPEN', mergeCommit: null } }, env: { PIPELINE_HOLD_RETRY_MS: '1' },
  });
  const file = join(s.fake.dir, 'hold-state.json');
  writeFileSync(file, JSON.stringify({ labels: ['needs-human'], timeline: [LIFT_EVENT], comments: [], clock: 100, seq: 0, hooks: [], overrides: { timeline: {} }, fail: {} }));
  s.fake.env.PIPELINE_GH = `node "${fakeGhHold}"`;
  s.fake.env.PIPELINE_FAKE_GH_STATE = file;
  s.st = () => JSON.parse(readFileSync(file, 'utf8'));
  return s;
};

test('--owner-go, an eligible needs-human hold is lifted and the merge command then prints the queued-behind line: queued-behind kept AND needs-human put back', (t) => {
  const s = liftWorld();
  // The owner's reply is exactly what the dry run printed (nothing retyped), as in test/owner-go-hold-lift.test.mjs.
  const d = cli(['merge', '--pr', String(PR), '--dry-run', '--owner-go'], { dir: s.repo.dir, fake: s.fake, env: { ...s.env, FAKE_HOLD_CHECK_SEQ: seq(CLEAR) } });
  assertExit(d, 0, `${d.stderr}${d.stdout}`);
  const step = d.json.ownerStep;
  assert.equal(step.kind, 'say-merge');
  ownerSays(t, 'merge', ['Protected areas and the hold are listed above.', step.areas, step.hold, step.line, step.ready ?? readyLine([PR])].filter(Boolean).join('\n'));
  const dryChecks = checks(s).length;
  const r = goMerge(s, { FAKE_HOLD_CHECK_SEQ: seq(CLEAR), FAKE_MERGE_QUEUED: EW_QUEUED_LINE });
  assertExit(r, 1, `${r.stderr}${r.stdout}`);
  assert.equal(r.json.error, 'queued-behind', r.stdout);
  assert.equal(r.json.merged, false);
  assert.deepEqual(r.json.blockedBy, [1400]);
  assert.equal(r.json.doNotUpdate, true);
  assert.equal(r.json.holdRestored, true, 'the needs-human hold is back');
  assert.equal(s.mergeCalls().length, 1, 'the merge command ran once (the hold was lifted for it)');
  assert.ok(s.st().labels.includes('needs-human'), 'the label is on the PR again');
  assert.ok(s.fake.lines().some((l) => /^pr edit 12 --add-label needs-human$/.test(l)), 'GitHub saw the label re-added');
  assert.ok(s.st().timeline.some((e) => e.event === 'labeled' && e.label.name === 'needs-human' && e.node_id !== LIFT.id), 'a new labeled event exists: it really is a new hold');
  assert.equal(checks(s).length - dryChecks, 1, 'the real run checked the hold once');
});

// ---- the gate path (step 1b) ---------------------------------------------------------------------------------------------------

const gateWorld = (opts = {}) => {
  const s = scenario({ yml: holdYml(), baseFiles: holdFiles, ...opts });
  assertExit(s.gate(), 0);
  return s;
};
const staleScript = (s, o = {}) => s.fake.setScript(ghEntries({ prHead: s.head, behindBy: 2, ...o }));
const gateMerge = (s, env = {}) => s.merge({ ...timing, ...env });

test('merge, gate path: a hold ahead is checked BEFORE the update: zero update-branch calls, queued-behind, the merge command never runs', () => {
  const s = gateWorld();
  staleScript(s);
  const r = gateMerge(s, { FAKE_HOLD_CHECK_SEQ: seq(BLOCKED) });
  assertExit(r, 1);
  assert.equal(r.json.error, 'queued-behind');
  assert.deepEqual(r.json.blockedBy, [1400]);
  assert.equal(r.json.doNotUpdate, true);
  assert.match(r.json.message, /do NOT update this branch/);
  assert.deepEqual(puts(s), []);
  assert.deepEqual(writes(s), []);
  assert.deepEqual(s.mergeCalls(), []);
  assert.equal(checks(s).length, 1);
});

test('merge, gate path: a hold ahead refuses even when the PR is up to date (the merge itself would be refused)', () => {
  const s = gateWorld();
  s.fake.setScript(ghEntries({ prHead: s.head, behindBy: 0 }));
  const r = gateMerge(s, { FAKE_HOLD_CHECK_SEQ: seq(BLOCKED) });
  assertExit(r, 1);
  assert.equal(r.json.error, 'queued-behind');
  assert.deepEqual(s.mergeCalls(), []);
});

test('merge, gate path: an unreadable check is hold-unreadable: no update, no merge', () => {
  const s = gateWorld();
  staleScript(s);
  const r = gateMerge(s, { FAKE_HOLD_CHECK_SEQ: seq(CLEAR), FAKE_HOLD_CHECK_EXIT: '2' });
  assertExit(r, 1);
  assert.equal(r.json.error, 'hold-unreadable');
  assert.deepEqual(puts(s), []);
  assert.deepEqual(s.mergeCalls(), []);
});

test('merge, gate path: first check clear, a hold appears before the PUT: the exact error (not behind-base), blocker metadata kept, zero PUTs, merge never runs', () => {
  const s = gateWorld();
  staleScript(s);
  const r = gateMerge(s, { FAKE_HOLD_CHECK_SEQ: seq(CLEAR, BLOCKED) });
  assertExit(r, 1);
  assert.equal(r.json.error, 'queued-behind');
  assert.notEqual(r.json.error, 'behind-base');
  assert.deepEqual(r.json.blockedBy, [1400]);
  assert.equal(r.json.doNotUpdate, true);
  assert.equal(r.json.outcome, 'queued-behind');
  assert.equal(r.json.updated, false);
  assert.equal(r.json.head, s.head);
  assert.deepEqual(puts(s), [], 'zero PUTs');
  assert.deepEqual(s.mergeCalls(), []);
  assert.equal(checks(s).length, 2, 'once before bringUpToDate, once right before the PUT');
});

test('merge, gate path: first check clear, then unreadable before the PUT: hold-unreadable, zero PUTs', () => {
  const s = gateWorld();
  staleScript(s);
  const r = gateMerge(s, { FAKE_HOLD_CHECK_SEQ: seq(CLEAR, 'garbage') });
  assertExit(r, 1);
  assert.equal(r.json.error, 'hold-unreadable');
  assert.equal(r.json.outcome, 'hold-unreadable');
  assert.deepEqual(puts(s), []);
  assert.deepEqual(s.mergeCalls(), []);
});

test('merge, gate path: nothing ahead updates as before (one PUT, then the usual behind-base refusal)', () => {
  const s = gateWorld();
  staleScript(s);
  const r = gateMerge(s, { FAKE_HOLD_CHECK_SEQ: seq(CLEAR) });
  assertExit(r, 1);
  assert.equal(r.json.error, 'behind-base');
  assert.equal(puts(s).length, 1);
  assert.deepEqual(JSON.parse(s.fake.calls().find((c) => c.argv.includes('PUT')).stdin), { expected_head_sha: s.head });
  assert.deepEqual(s.mergeCalls(), []);
});

test('merge, gate path: nothing ahead and up to date merges; the merge command printing the queued-behind line maps to queued-behind', () => {
  const ok = gateWorld();
  const merged = gateMerge(ok, { FAKE_HOLD_CHECK_SEQ: seq(CLEAR) });
  assertExit(merged, 0);
  assert.equal(merged.json.merged, true);

  const s = gateWorld({ gh: { mergeView: { state: 'OPEN', mergeCommit: null } } });
  const r = gateMerge(s, { FAKE_HOLD_CHECK_SEQ: seq(CLEAR), FAKE_MERGE_QUEUED: EW_QUEUED_LINE });
  assertExit(r, 1);
  assert.equal(r.json.error, 'queued-behind');
  assert.deepEqual(r.json.blockedBy, [1400]);
  assert.equal(r.json.autoMergeDisabled, true);
  assert.equal(r.json.commandExitCode, 1);
  assert.ok(s.fake.lines().includes('pr merge 12 --disable-auto'));
});

// ---- the gate path takes the hold for its catch-up (step 1b) ------------------------------------------------------------------------

const catchUp = { PIPELINE_UPDATE_WAIT_MS: '2000', PIPELINE_UPDATE_POLL_MS: '1' };

test('merge, gate path: step 1b TAKES the hold before its update PUT (check, check, take, check), records the successor, keeps the hold, refuses behind-base with hold + successors', () => {
  const s = gateWorld();
  staleScript(s);
  const r = gateMerge(s, { ...catchUp, FAKE_HOLD_CHECK_SEQ: seq(CLEAR), ...caughtUp(s) });
  assertExit(r, 1, r.stdout);
  assert.equal(r.json.error, 'behind-base');
  assert.equal(r.json.outcome, 'updated');
  assert.equal(r.json.head, NEW_HEAD);
  assert.deepEqual(holdCalls(s), [`check ${PR}`, `check ${PR}`, `take ${PR}`, `check ${PR}`], 'early check, gate before the PUT, take, re-check; no release');
  assert.deepEqual(holdPuts(s), ['check 0', 'check 0', 'take 0', 'check 0'], 'all before the PUT');
  assert.equal(puts(s).length, 1);
  assert.deepEqual(r.json.hold, { taken: true, tookThisCall: true, mayHold: true, take: { confirmed: true, code: 0, lines: ['hold taken'] } });
  assert.deepEqual(r.json.successors, [{ from: s.head, to: NEW_HEAD, baseSha: BASE_SHA }]);
  assert.equal(readSuccessor(s.repo.dir, PR, NEW_HEAD)?.baseSha, BASE_SHA);
  assert.deepEqual(s.mergeCalls(), []);
});

test('merge, gate path: a RACE at step 1b (clear, clear, take, older hold shows): released at once as queued-behind; the refusal has holdTaken, holdRelease and zero PUTs', () => {
  const s = gateWorld();
  staleScript(s);
  const r = gateMerge(s, { FAKE_HOLD_CHECK_SEQ: seq(CLEAR, CLEAR, BLOCKED) });
  assertExit(r, 1, r.stdout);
  assert.equal(r.json.error, 'queued-behind');
  assert.equal(r.json.holdTaken, true);
  assert.deepEqual(r.json.holdRelease, { reason: 'queued-behind', confirmed: true, code: 0, lines: ['hold released'] });
  assert.deepEqual(r.json.blockedBy, [1400]);
  assert.equal(r.json.doNotUpdate, true);
  assert.equal(r.json.outcome, 'queued-behind');
  assert.deepEqual(r.json.successors, []);
  assert.deepEqual(holdCalls(s), [`check ${PR}`, `check ${PR}`, `take ${PR}`, `check ${PR}`, `release ${PR} ${RELEASE_REASONS['queued-behind']}`]);
  assert.deepEqual(puts(s), []);
  assert.deepEqual(s.mergeCalls(), []);
  assert.equal('warnings' in r.json, false);
});

test('merge, gate path (#199): the post-take re-check is UNREADABLE after a CONFIRMED take: the hold is KEPT (no release, holdTaken true)', () => {
  const s = gateWorld();
  staleScript(s);
  const r = gateMerge(s, { FAKE_HOLD_CHECK_SEQ: seq(CLEAR, CLEAR, 'garbage') });
  assertExit(r, 1, r.stdout);
  assert.equal(r.json.error, 'hold-unreadable');
  assert.equal(r.json.outcome, 'hold-unreadable');
  assert.equal(r.json.holdTaken, true);
  assert.equal(r.json.hold.taken, true);
  assert.equal('holdRelease' in r.json, false);
  assert.deepEqual(holdCalls(s).filter((l) => l.startsWith('release')), []);
  assert.deepEqual(puts(s), []);
  assert.equal('warnings' in r.json, false);
});

test('merge, gate path: the post-take re-check is UNREADABLE after an UNCONFIRMED take that may have written the label (exit 2): released at once as hold-unreadable; a cleanly refused take (exit 1) releases nothing; a release that fails is a warning', () => {
  const s0 = gateWorld();
  staleScript(s0);
  const r0 = gateMerge(s0, { FAKE_HOLD_CHECK_SEQ: seq(CLEAR, CLEAR, 'garbage'), FAKE_HOLD_TAKE_EXIT: '2' });
  assertExit(r0, 1, r0.stdout);
  assert.equal(r0.json.error, 'hold-unreadable');
  assert.equal(r0.json.holdTaken, false);
  assert.equal(r0.json.holdRelease.reason, 'hold-unreadable');
  assert.equal(r0.json.holdRelease.confirmed, true);
  assert.deepEqual(holdCalls(s0).at(-1), `release ${PR} ${RELEASE_REASONS['hold-unreadable']}`);
  assert.deepEqual(puts(s0), []);

  const refused = gateWorld();
  staleScript(refused);
  const r1 = gateMerge(refused, { FAKE_HOLD_CHECK_SEQ: seq(CLEAR, CLEAR, 'garbage'), FAKE_HOLD_TAKE_EXIT: '1' });
  assert.equal(r1.json.error, 'hold-unreadable');
  assert.equal(r1.json.holdTaken, false);
  assert.equal('holdRelease' in r1.json, false);
  assert.deepEqual(holdCalls(refused).filter((l) => l.startsWith('release')), []);

  const s = gateWorld();
  staleScript(s);
  const r = gateMerge(s, { FAKE_HOLD_CHECK_SEQ: seq(CLEAR, CLEAR, 'garbage'), FAKE_HOLD_TAKE_EXIT: '2', FAKE_HOLD_RELEASE_EXIT: '1' });
  assert.equal(r.json.holdRelease.confirmed, false);
  assert.equal(r.json.warnings.length, 1);
  assert.match(r.json.warnings[0], /NOT released \(hold-unreadable; exit 1\)/);
});

test('merge, gate path: a refusal BEFORE this call took anything releases nothing (hold ahead at entry; unreadable gate before the take)', () => {
  const ahead = gateWorld();
  staleScript(ahead);
  const a = gateMerge(ahead, { FAKE_HOLD_CHECK_SEQ: seq(BLOCKED) });
  assert.equal(a.json.error, 'queued-behind');
  assert.deepEqual(holdCalls(ahead), [`check ${PR}`]);
  assert.equal('holdRelease' in a.json, false);
  assert.equal('holdTaken' in a.json, false);

  const unreadable = gateWorld();
  staleScript(unreadable);
  const b = gateMerge(unreadable, { FAKE_HOLD_CHECK_SEQ: seq(CLEAR, 'garbage') });
  assert.equal(b.json.error, 'hold-unreadable');
  assert.deepEqual(holdCalls(unreadable), [`check ${PR}`, `check ${PR}`], 'no take, so no release');
  assert.equal('holdRelease' in b.json, false);
});

test('merge, gate path: the update conflicts (rebase-needed) -> the hold THIS call took is released with update-conflict; the behind-base refusal carries hold, holdRelease and successors []', () => {
  const s = gateWorld();
  staleScript(s, { update: 'conflict' });
  const r = gateMerge(s, { FAKE_HOLD_CHECK_SEQ: seq(CLEAR) });
  assertExit(r, 1, r.stdout);
  assert.equal(r.json.error, 'behind-base');
  assert.equal(r.json.outcome, 'rebase-needed');
  assert.equal(r.json.hold.taken, true);
  assert.deepEqual(r.json.successors, []);
  assert.deepEqual(r.json.holdRelease, { reason: 'update-conflict', confirmed: true, code: 0, lines: ['hold released'] });
  assert.deepEqual(holdCalls(s).filter((l) => l.startsWith('release')), [`release ${PR} ${RELEASE_REASONS['update-conflict']}`]);
  assert.deepEqual(holdPuts(s).at(-1), 'release 1', 'released after the conflicting PUT');
  assert.equal('warnings' in r.json, false);

  const failing = gateWorld();
  staleScript(failing, { update: 'conflict' });
  const f = gateMerge(failing, { FAKE_HOLD_CHECK_SEQ: seq(CLEAR), FAKE_HOLD_RELEASE_EXIT: '1' });
  assert.equal(f.json.holdRelease.confirmed, false);
  assert.equal(f.json.holdRelease.code, 1);
  assert.equal(f.json.warnings.length, 1);
  assert.match(f.json.warnings[0], /NOT released \(update-conflict; exit 1\).*merge-hold --pr 12 --release --reason update-conflict/);
});

test('merge, gate path (#199): a race loss after a CONFIRMED take still releases queued-behind (unchanged: P merge stops, so it does not wait on the younger hold)', () => {
  const s = gateWorld();
  staleScript(s);
  const r = gateMerge(s, { FAKE_HOLD_CHECK_SEQ: seq(CLEAR, CLEAR, BLOCKED) });
  assert.equal(r.json.error, 'queued-behind');
  assert.equal(r.json.holdTaken, true);
  assert.equal(r.json.holdRelease.reason, 'queued-behind');
  assert.deepEqual(holdCalls(s).filter((l) => l.startsWith('release')), [`release ${PR} ${RELEASE_REASONS['queued-behind']}`]);
});

test('merge, gate path (#198): a take the provider cleanly REFUSED (exit 1) wrote no label: a race loss and an update conflict release NOTHING; an exit-2 take is released', () => {
  const race = gateWorld();
  staleScript(race);
  const a = gateMerge(race, { FAKE_HOLD_CHECK_SEQ: seq(CLEAR, CLEAR, BLOCKED), FAKE_HOLD_TAKE_EXIT: '1' });
  assert.equal(a.json.error, 'queued-behind');
  assert.equal(a.json.holdTaken, false);
  assert.equal('holdRelease' in a.json, false);
  assert.deepEqual(holdCalls(race).filter((l) => l.startsWith('release')), []);

  const conflict = gateWorld();
  staleScript(conflict, { update: 'conflict' });
  const b = gateMerge(conflict, { FAKE_HOLD_CHECK_SEQ: seq(CLEAR), FAKE_HOLD_TAKE_EXIT: '1' });
  assert.equal(b.json.outcome, 'rebase-needed');
  assert.equal('holdRelease' in b.json, false);
  assert.deepEqual(holdCalls(conflict).filter((l) => l.startsWith('release')), []);

  const odd = gateWorld();
  staleScript(odd);
  const c = gateMerge(odd, { FAKE_HOLD_CHECK_SEQ: seq(CLEAR, CLEAR, BLOCKED), FAKE_HOLD_TAKE_EXIT: '2' });
  assert.equal(c.json.error, 'queued-behind');
  assert.equal(c.json.holdTaken, false);
  assert.equal(c.json.holdRelease.reason, 'queued-behind');
  assert.deepEqual(holdCalls(odd).filter((l) => l.startsWith('release')), [`release ${PR} ${RELEASE_REASONS['queued-behind']}`]);
});

test('merge, gate path: other failed catch-ups (head-timeout, head-moved) KEEP the hold this call took', () => {
  const timeout = gateWorld();
  staleScript(timeout);
  const a = gateMerge(timeout, { FAKE_HOLD_CHECK_SEQ: seq(CLEAR) }); // the fake GitHub never shows a new head
  assert.equal(a.json.error, 'behind-base');
  assert.equal(a.json.outcome, 'head-timeout');
  assert.equal(a.json.hold.taken, true);
  assert.equal('holdRelease' in a.json, false);
  assert.deepEqual(holdCalls(timeout).filter((l) => l.startsWith('release')), []);

  const moved = gateWorld();
  staleScript(moved, { update: 'head-moved' });
  const b = gateMerge(moved, { FAKE_HOLD_CHECK_SEQ: seq(CLEAR) });
  assert.equal(b.json.outcome, 'head-moved');
  assert.equal(b.json.hold.taken, true);
  assert.equal('holdRelease' in b.json, false);
  assert.deepEqual(holdCalls(moved).filter((l) => l.startsWith('release')), []);
});

test('merge, gate path, a repo WITHOUT the hold keys: the successor is still recorded, no hold field, no hold call', () => {
  const s = scenario({ baseFiles: holdFiles });
  assertExit(s.gate(), 0);
  staleScript(s);
  const r = gateMerge(s, { ...catchUp, ...caughtUp(s) });
  assertExit(r, 1, r.stdout);
  assert.equal(r.json.error, 'behind-base');
  assert.equal('hold' in r.json, false);
  assert.deepEqual(holdCalls(s), []);
  assert.deepEqual(r.json.successors.map((x) => x.to), [NEW_HEAD]);
  assert.equal(readSuccessor(s.repo.dir, PR, NEW_HEAD)?.from, s.head);
});

// ---- update-branch -------------------------------------------------------------------------------------------------------------

const updateCli = (s, env = {}, extra = []) => cli(['update-branch', '--pr', String(PR), ...extra], { dir: s.repo.dir, fake: s.fake, env: { ...timing, ...env } });

test('update-branch: a hold ahead at entry -> exit 1, outcome queued-behind, doNotUpdate, zero PUTs, updated:false', () => {
  const s = scenario({ yml: holdYml(), baseFiles: holdFiles, gh: { behindBy: 2 } });
  const r = updateCli(s, { FAKE_HOLD_CHECK_SEQ: seq(BLOCKED) });
  assertExit(r, 1);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.outcome, 'queued-behind');
  assert.equal(r.json.error, 'queued-behind');
  assert.deepEqual(r.json.blockedBy, [1400]);
  assert.equal(r.json.doNotUpdate, true);
  assert.equal(r.json.updated, false);
  assert.equal(r.json.cycles, 0);
  assert.equal(r.json.head, s.head);
  assert.equal(r.json.pullNeeded, false);
  assert.deepEqual(puts(s), []);
});

test('update-branch: an unreadable check -> hold-unreadable, zero PUTs', () => {
  const s = scenario({ yml: holdYml(), baseFiles: holdFiles, gh: { behindBy: 2 } });
  const r = updateCli(s, { FAKE_HOLD_CHECK_SEQ: seq('{"pr":12'), });
  assertExit(r, 1);
  assert.equal(r.json.outcome, 'hold-unreadable');
  assert.deepEqual(puts(s), []);
});

test('update-branch: nothing ahead updates as before (one PUT); an up-to-date branch never runs the check', () => {
  const s = scenario({ yml: holdYml(), baseFiles: holdFiles, gh: { behindBy: 2 } });
  const r = updateCli(s, { FAKE_HOLD_CHECK_SEQ: seq(CLEAR) });
  assert.equal(r.json.outcome, 'head-timeout', 'the fake GitHub never shows a new head; the update itself was made');
  assert.equal(puts(s).length, 1);
  assert.equal(checks(s).length, 2, 'the check before the take and the re-check after it');

  const upToDate = scenario({ yml: holdYml(), baseFiles: holdFiles });
  const done = updateCli(upToDate, { FAKE_HOLD_CHECK_SEQ: seq(BLOCKED) });
  assertExit(done, 0);
  assert.equal(done.json.outcome, 'up-to-date');
  assert.deepEqual(holdCalls(upToDate), []);
});

// ---- update-branch takes the hold before its PUT (plan 2026-11-06-f1-lite-build) ---------------------------------------------------------

const heldWorld = (gh = { behindBy: 2 }) => scenario({ yml: holdYml(), baseFiles: holdFiles, gh });
const upd = (s, env = {}, extra = []) => updateCli(s, { ...env }, extra);
const recordFile = (s) => join(s.repo.git(['rev-parse', '--path-format=absolute', '--git-common-dir']).trim(), 'pipeline', 'merge-hold', `pr-${PR}`, `${NEW_HEAD}.json`);
const releases = (s) => holdCalls(s).filter((l) => l.startsWith('release'));

test('update-branch with holds: check, TAKE, check, THEN the update; the take is confirmed, the successor is recorded, nothing is released', () => {
  const s = heldWorld();
  const r = upd(s, { PIPELINE_UPDATE_WAIT_MS: '2000', FAKE_HOLD_CHECK_SEQ: seq(CLEAR), ...caughtUp(s) });
  assertExit(r, 0, r.stdout);
  assert.equal(r.json.outcome, 'up-to-date');
  assert.deepEqual(holdCalls(s), [`check ${PR}`, `take ${PR}`, `check ${PR}`], 'in this order, nothing released');
  assert.deepEqual(holdPuts(s), ['check 0', 'take 0', 'check 0'], 'all three ran BEFORE the update PUT');
  assert.equal(puts(s).length, 1);
  assert.deepEqual(r.json.hold, { taken: true, tookThisCall: true, mayHold: true, take: { confirmed: true, code: 0, lines: ['hold taken'] } });
  assert.deepEqual(r.json.successors, [{ from: s.head, to: NEW_HEAD, baseSha: BASE_SHA }]);
  assert.equal('holdRelease' in r.json, false);
  assert.equal('warnings' in r.json, false);
  assert.equal('successorWarnings' in r.json, false, 'warnings are merged into warnings[]');
  assert.deepEqual(readSuccessor(s.repo.dir, PR, NEW_HEAD)?.from, s.head);
  assert.ok(existsSync(recordFile(s)), 'one immutable file per successor in the git common dir');
});

test('update-branch with holds, end to end: the recorded successor is kept by merge-hold --release --reason new-commits (no release command), a PR-side head is not', () => {
  const s = heldWorld();
  assertExit(upd(s, { PIPELINE_UPDATE_WAIT_MS: '2000', FAKE_HOLD_CHECK_SEQ: seq(CLEAR), ...caughtUp(s) }), 0);
  s.fake.setScript(ghEntries({ prHead: NEW_HEAD, commitParents: { [NEW_HEAD]: [s.head, BASE_SHA] }, extra: [{ match: '^pr view 12 --json headRefOid$', stdoutJson: { headRefOid: NEW_HEAD } }] }));
  const kept = cli(['merge-hold', '--pr', String(PR), '--release', '--reason', 'new-commits'], { dir: s.repo.dir, fake: s.fake });
  assertExit(kept, 0, kept.stdout);
  assert.deepEqual(kept.json, { ok: true, configured: true, kept: true, why: 'own-successor', head: NEW_HEAD });
  assert.deepEqual(releases(s), []);
  const pushed = 'e'.repeat(40);
  s.fake.setScript(ghEntries({ prHead: pushed, commitParents: { [pushed]: [NEW_HEAD] }, extra: [{ match: '^pr view 12 --json headRefOid$', stdoutJson: { headRefOid: pushed } }] }));
  const gone = cli(['merge-hold', '--pr', String(PR), '--release', '--reason', 'new-commits'], { dir: s.repo.dir, fake: s.fake });
  assertExit(gone, 0, gone.stdout);
  assert.equal(gone.json.confirmed, true);
  assert.equal(releases(s).length, 1);
});

test('update-branch with holds: a hold ahead at entry takes NOTHING (check only), hold says so, no release', () => {
  const s = heldWorld();
  const r = upd(s, { FAKE_HOLD_CHECK_SEQ: seq(BLOCKED) });
  assertExit(r, 1);
  assert.deepEqual(holdCalls(s), [`check ${PR}`]);
  assert.deepEqual(r.json.hold, { taken: false, tookThisCall: false, mayHold: false, take: null });
  assert.equal('holdTaken' in r.json, false);
  assert.equal('holdRelease' in r.json, false);
});

test('update-branch with holds: the take is not confirmed -> carries on without a hold (hold.taken false), updates, releases nothing', () => {
  const s = heldWorld();
  const r = upd(s, { PIPELINE_UPDATE_WAIT_MS: '2000', FAKE_HOLD_CHECK_SEQ: seq(CLEAR), FAKE_HOLD_TAKE_EXIT: '1', ...caughtUp(s) });
  assertExit(r, 0, r.stdout);
  assert.equal(puts(s).length, 1);
  assert.equal(r.json.hold.taken, false);
  assert.equal(r.json.hold.tookThisCall, true);
  assert.equal(r.json.hold.take.confirmed, false);
  assert.equal(r.json.hold.take.code, 1);
  assert.deepEqual(releases(s), []);
});

test('update-branch with holds, --wait-checks and the updated head FAILS its checks: the hold this call took is released with ci-failed (holdRelease confirmed)', () => {
  const s = heldWorld();
  const r = upd(s, { PIPELINE_UPDATE_WAIT_MS: '2000', FAKE_HOLD_CHECK_SEQ: seq(CLEAR), ...caughtUp(s, { ci: [{ name: 'ci', state: 'FAILURE', bucket: 'fail' }] }) }, ['--wait-checks']);
  assertExit(r, 1, r.stdout);
  assert.equal(r.json.outcome, 'checks-failed');
  assert.deepEqual(releases(s), [`release ${PR} ${RELEASE_REASONS['ci-failed']}`]);
  assert.deepEqual(holdPuts(s).at(-1), 'release 1', 'released after the update');
  assert.deepEqual(r.json.holdRelease, { reason: 'ci-failed', confirmed: true, code: 0, lines: ['hold released'] });
  assert.equal('warnings' in r.json, false);
  assert.deepEqual(r.json.successors.map((x) => x.to), [NEW_HEAD], 'the accepted update is still listed');
});

test('update-branch with holds: a release that is NOT confirmed shows holdRelease.confirmed false and a warning with the retry command', () => {
  const s = heldWorld();
  const r = upd(s, { PIPELINE_UPDATE_WAIT_MS: '2000', FAKE_HOLD_CHECK_SEQ: seq(CLEAR), FAKE_HOLD_RELEASE_EXIT: '1', ...caughtUp(s, { ci: [{ name: 'ci', state: 'FAILURE', bucket: 'fail' }] }) }, ['--wait-checks']);
  assertExit(r, 1, r.stdout);
  assert.equal(r.json.holdRelease.confirmed, false);
  assert.equal(r.json.holdRelease.code, 1);
  assert.equal(r.json.warnings.length, 1);
  assert.match(r.json.warnings[0], /NOT released \(ci-failed; exit 1\).*merge-hold --pr 12 --release --reason ci-failed/);
});

test('update-branch with holds: the update conflicts (rebase-needed) -> released with update-conflict', () => {
  const s = heldWorld({ behindBy: 2, update: 'conflict' });
  const r = upd(s, { FAKE_HOLD_CHECK_SEQ: seq(CLEAR) });
  assertExit(r, 1);
  assert.equal(r.json.outcome, 'rebase-needed');
  assert.deepEqual(releases(s), [`release ${PR} ${RELEASE_REASONS['update-conflict']}`]);
  assert.equal(r.json.holdRelease.reason, 'update-conflict');
  assert.equal(r.json.holdRelease.confirmed, true);
});

test('update-branch with holds (#198): a take the provider cleanly REFUSED (exit 1) wrote no label: rebase-needed releases NOTHING; an exit-2 take may have: it is released with update-conflict', () => {
  const refused = heldWorld({ behindBy: 2, update: 'conflict' });
  const a = upd(refused, { FAKE_HOLD_CHECK_SEQ: seq(CLEAR), FAKE_HOLD_TAKE_EXIT: '1' });
  assertExit(a, 1);
  assert.equal(a.json.outcome, 'rebase-needed');
  assert.deepEqual(a.json.hold.mayHold, false);
  assert.equal(a.json.hold.tookThisCall, true);
  assert.deepEqual(releases(refused), []);
  assert.equal('holdRelease' in a.json, false);

  const odd = heldWorld({ behindBy: 2, update: 'conflict' });
  const b = upd(odd, { FAKE_HOLD_CHECK_SEQ: seq(CLEAR), FAKE_HOLD_TAKE_EXIT: '2' });
  assert.equal(b.json.outcome, 'rebase-needed');
  assert.equal(b.json.hold.taken, false);
  assert.equal(b.json.hold.mayHold, true);
  assert.deepEqual(releases(odd), [`release ${PR} ${RELEASE_REASONS['update-conflict']}`]);
  assert.equal(b.json.holdRelease.reason, 'update-conflict');
});

test('update-branch with holds (#198): checks-failed after a cleanly refused take releases nothing', () => {
  const s = heldWorld();
  const r = upd(s, { PIPELINE_UPDATE_WAIT_MS: '2000', FAKE_HOLD_CHECK_SEQ: seq(CLEAR), FAKE_HOLD_TAKE_EXIT: '1', ...caughtUp(s, { ci: [{ name: 'ci', state: 'FAILURE', bucket: 'fail' }] }) }, ['--wait-checks']);
  assertExit(r, 1, r.stdout);
  assert.equal(r.json.outcome, 'checks-failed');
  assert.deepEqual(releases(s), []);
  assert.equal('holdRelease' in r.json, false);
});

test('update-branch with holds: every other outcome KEEPS the hold (head-timeout, head-moved, cycle-cap, checks-timeout)', () => {
  const timeout = heldWorld();
  const a = upd(timeout, { FAKE_HOLD_CHECK_SEQ: seq(CLEAR) });
  assert.equal(a.json.outcome, 'head-timeout');
  assert.equal(a.json.hold.taken, true);
  assert.deepEqual(releases(timeout), [], 'head-timeout');

  const moved = heldWorld();
  const b = upd(moved, { FAKE_HOLD_CHECK_SEQ: seq(CLEAR), PIPELINE_UPDATE_WAIT_MS: '2000' }, ['--expect-head', 'f'.repeat(40)]);
  assert.equal(b.json.outcome, 'head-moved');
  assert.deepEqual(holdCalls(moved), [], 'head-moved before any hold call');

  const cap = heldWorld();
  const c = upd(cap, { FAKE_HOLD_CHECK_SEQ: seq(CLEAR), PIPELINE_UPDATE_WAIT_MS: '2000', ...swapOnUpdate(cap, ghEntries({ prHead: NEW_HEAD, behindBy: 1, commitParents: { [NEW_HEAD]: [cap.head, BASE_SHA] } })) }, ['--max-cycles', '1']);
  assert.equal(c.json.outcome, 'cycle-cap');
  assert.deepEqual(releases(cap), [], 'cycle-cap');

  const slow = heldWorld();
  const d = upd(slow, { FAKE_HOLD_CHECK_SEQ: seq(CLEAR), PIPELINE_UPDATE_WAIT_MS: '2000', ...caughtUp(slow, { ci: [{ name: 'ci', state: 'PENDING', bucket: 'pending' }] }), PIPELINE_UPDATE_POLL_MS: '1' }, ['--wait-checks']);
  assert.equal(d.json.outcome, 'checks-timeout');
  assert.equal(d.json.hold.taken, true);
  assert.deepEqual(releases(slow), [], 'checks-timeout');
});

test('update-branch with holds, a RACE (clear, take, then an older hold shows): exit 1 queued-behind with holdTaken true, no PUT, the younger hold is KEPT (no release)', () => {
  const s = heldWorld();
  const r = upd(s, { FAKE_HOLD_CHECK_SEQ: seq(CLEAR, BLOCKED) });
  assertExit(r, 1);
  assert.equal(r.json.outcome, 'queued-behind');
  assert.equal(r.json.error, 'queued-behind');
  assert.equal(r.json.holdTaken, true);
  assert.deepEqual(r.json.blockedBy, [1400]);
  assert.equal(r.json.doNotUpdate, true);
  assert.deepEqual(holdCalls(s), [`check ${PR}`, `take ${PR}`, `check ${PR}`]);
  assert.deepEqual(puts(s), []);
  assert.equal('holdRelease' in r.json, false);
  assert.equal(r.json.hold.tookThisCall, true);
});

test('update-branch with holds (#199), the re-check after the take is UNREADABLE and the take was CONFIRMED: the hold is KEPT (no release), the refusal says holdTaken true', () => {
  const s = heldWorld();
  const r = upd(s, { FAKE_HOLD_CHECK_SEQ: seq(CLEAR, 'garbage') });
  assertExit(r, 1);
  assert.equal(r.json.outcome, 'hold-unreadable');
  assert.equal(r.json.holdTaken, true);
  assert.equal(r.json.hold.taken, true);
  assert.deepEqual(releases(s), []);
  assert.equal('holdRelease' in r.json, false);
  assert.equal('warnings' in r.json, false);
  assert.deepEqual(puts(s), []);
});

test('update-branch with holds, the re-check after the take is UNREADABLE and the take was NOT confirmed but may have written the label (exit 2): released at once with hold-unreadable; a cleanly refused take (exit 1) releases nothing; a failing release is reported', () => {
  const s0 = heldWorld();
  const r0 = upd(s0, { FAKE_HOLD_CHECK_SEQ: seq(CLEAR, 'garbage'), FAKE_HOLD_TAKE_EXIT: '2' });
  assertExit(r0, 1);
  assert.equal(r0.json.outcome, 'hold-unreadable');
  assert.equal(r0.json.holdTaken, false);
  assert.deepEqual(releases(s0), [`release ${PR} ${RELEASE_REASONS['hold-unreadable']}`]);
  assert.deepEqual(r0.json.holdRelease, { reason: 'hold-unreadable', confirmed: true, code: 0, lines: ['hold released'] });
  assert.deepEqual(puts(s0), []);

  const refused = heldWorld();
  const r1 = upd(refused, { FAKE_HOLD_CHECK_SEQ: seq(CLEAR, 'garbage'), FAKE_HOLD_TAKE_EXIT: '1' });
  assert.equal(r1.json.outcome, 'hold-unreadable');
  assert.equal(r1.json.holdTaken, false);
  assert.deepEqual(releases(refused), []);
  assert.equal('holdRelease' in r1.json, false);

  const s = heldWorld();
  const r = upd(s, { FAKE_HOLD_CHECK_SEQ: seq(CLEAR, 'garbage'), FAKE_HOLD_TAKE_EXIT: '2', FAKE_HOLD_RELEASE_EXIT: '1' });
  assert.equal(r.json.holdRelease.confirmed, false);
  assert.match(r.json.warnings[0], /NOT released \(hold-unreadable/);
});

test('update-branch with holds, an unreadable FIRST check releases nothing (nothing was taken)', () => {
  const s = heldWorld();
  const r = upd(s, { FAKE_HOLD_CHECK_SEQ: seq('garbage') });
  assert.equal(r.json.outcome, 'hold-unreadable');
  assert.deepEqual(holdCalls(s), [`check ${PR}`]);
  assert.equal('holdRelease' in r.json, false);
});

test('update-branch with holds: a successor record that cannot be written is a warning, never a failure (the update and the hold go on)', () => {
  const s = heldWorld();
  const common = s.repo.git(['rev-parse', '--path-format=absolute', '--git-common-dir']).trim();
  writeFileSync(join(common, 'pipeline'), 'in the way'); // mkdir -p <common>/pipeline/merge-hold/pr-12 fails (ENOTDIR)
  const r = upd(s, { PIPELINE_UPDATE_WAIT_MS: '2000', FAKE_HOLD_CHECK_SEQ: seq(CLEAR), ...caughtUp(s) });
  assertExit(r, 0, r.stdout);
  assert.equal(r.json.outcome, 'up-to-date');
  assert.equal(r.json.warnings.length, 1);
  assert.match(r.json.warnings[0], /could not record the successor d{40}/);
  assert.deepEqual(r.json.successors.map((x) => x.to), [NEW_HEAD], 'the proof is still listed in the output');
});

// ---- the dry run ---------------------------------------------------------------------------------------------------------------

const prReply = (s, o = {}) => ({
  state: 'OPEN', headRefOid: s.head, baseRefName: 'main', isDraft: false, labels: [], mergeable: 'MERGEABLE', mergeStateStatus: o.merge ?? 'CLEAN', baseRefOid: s.baseTip,
});
const dryScript = (s, o = {}) => [
  { match: '^pr view 12 --json state,headRefOid.*baseRefOid', stdoutJson: prReply(s, o) },
  ...ghEntries({ prHead: s.head, prFiles: s.prFiles, mergeStateStatus: o.merge ?? 'CLEAN', behindBy: o.behindBy }),
];
const dry = (s, env = {}, args = []) => cli(['merge', '--pr', String(PR), '--dry-run', ...args], { dir: s.repo.dir, fake: s.fake, env: { ...s.env, ...env } });
const kinds = (r) => r.json.blockers.map((b) => b.kind);
const dryWorld = (opts = {}) => {
  const s = scenario({ yml: holdYml(), baseFiles: holdFiles, ...opts });
  s.fake.setScript(dryScript(s));
  assertExit(s.gate(), 0);
  s.fake.setScript(dryScript(s, opts.dry)); // (a stale PR cannot pass the gate itself: it goes stale after it)
  return s;
};

test('dry run, nothing ahead: wouldMerge, holds {readable:true, blockedBy:[]}, exactly ONE shell call (the check), zero gh writes, the merge command never ran', () => {
  const s = dryWorld();
  const d = dry(s, { FAKE_HOLD_CHECK_SEQ: seq(CLEAR) });
  assertExit(d, 0, `${d.stderr}${d.stdout}`);
  assert.equal(d.json.wouldMerge, true, JSON.stringify(d.json.blockers));
  assert.deepEqual(d.json.holds, { readable: true, blockedBy: [] });
  assert.deepEqual(holdCalls(s), [`check ${PR}`], 'one call, and it is the read-only check');
  assert.deepEqual(s.mergeCalls(), []);
  assert.deepEqual(writes(s), []);
});

test('dry run, a hold ahead: blocker merge-hold naming #1400, holds lists it, wouldMerge false, still read-only', () => {
  const s = dryWorld();
  const d = dry(s, { FAKE_HOLD_CHECK_SEQ: seq(BLOCKED) });
  assertExit(d, 1, `${d.stderr}${d.stdout}`);
  assert.equal(d.json.wouldMerge, false);
  assert.ok(kinds(d).includes('merge-hold'), JSON.stringify(d.json.blockers));
  assert.match(d.json.blockers.find((b) => b.kind === 'merge-hold').detail, /queued behind #1400 "Roster card"/);
  assert.equal(d.json.holds.readable, true);
  assert.deepEqual(d.json.holds.blockedBy.map((b) => b.number), [1400]);
  assert.deepEqual(holdCalls(s), [`check ${PR}`]);
  assert.deepEqual(writes(s), []);
  assert.deepEqual(s.mergeCalls(), []);
});

test('dry run, a STALE PR with nothing ahead: only the read-only check runs (never a take or a release), no PUT, no write', () => {
  const s = dryWorld({ dry: { merge: 'BEHIND' } });
  const d = dry(s, { FAKE_HOLD_CHECK_SEQ: seq(CLEAR) });
  assertExit(d, 1, `${d.stderr}${d.stdout}`);
  assert.ok(kinds(d).includes('behind-base'), JSON.stringify(d.json.blockers));
  assert.ok(holdCalls(s).length > 0 && holdCalls(s).every((l) => l.startsWith('check')), JSON.stringify(holdCalls(s)));
  assert.deepEqual(puts(s), []);
  assert.deepEqual(writes(s), []);
});

test('dry run, an unreadable check: blocker merge-hold, holds.readable false', () => {
  const s = dryWorld();
  const d = dry(s, { FAKE_HOLD_CHECK_SEQ: seq(CLEAR), FAKE_HOLD_CHECK_EXIT: '1' });
  assertExit(d, 1);
  assert.ok(kinds(d).includes('merge-hold'));
  assert.deepEqual(d.json.holds, { readable: false, blockedBy: [] });
  assert.match(d.json.blockers.find((b) => b.kind === 'merge-hold').detail, /could not be read/);
});

test('dry run, a stale PR behind a hold: the "update the branch" advice is withdrawn from the behind-base blocker', () => {
  const s = dryWorld({ dry: { merge: 'BEHIND' } });
  const d = dry(s, { FAKE_HOLD_CHECK_SEQ: seq(BLOCKED) });
  assertExit(d, 1);
  assert.ok(kinds(d).includes('behind-base') && kinds(d).includes('merge-hold'), JSON.stringify(d.json.blockers));
  const behind = d.json.blockers.find((b) => b.kind === 'behind-base');
  assert.match(behind.detail, /do NOT update the branch/);
  assert.doesNotMatch(behind.detail, /P update-branch/);
  // The pr-open live check carries the same advice ("behind-base: …; update the branch from main and re-verify before merging").
  const everything = JSON.stringify(d.json);
  assert.doesNotMatch(everything.replace(/do NOT update the branch/g, ''), /update the branch|P update-branch|re-verify before merging/i, 'no stale-branch advice anywhere in the output');
  assert.ok(d.json.blockers.some((b) => b.kind === 'live-check' && /behind-base/.test(b.detail) && /do NOT update the branch/.test(b.detail)), 'the live-check entry is rewritten, not dropped');
});

test('dry run --owner-go, a stale PR behind a hold: no "update the branch" advice anywhere either', () => {
  const s = scenario({ yml: holdYml({ merge: goMergeCmd }), baseFiles: holdFiles, report: null, state: null, change: unique });
  s.fake.setScript(dryScript(s, { merge: 'BEHIND' }));
  const d = dry(s, { FAKE_HOLD_CHECK_SEQ: seq(BLOCKED) }, ['--owner-go']);
  assertExit(d, 1);
  assert.ok(kinds(d).includes('merge-hold'), JSON.stringify(d.json.blockers));
  assert.ok(d.json.blockers.some((b) => b.kind === 'live-check' && /behind-base/.test(b.detail)), JSON.stringify(d.json.blockers));
  assert.doesNotMatch(JSON.stringify(d.json).replace(/do NOT update the branch/g, ''), /update the branch|P update-branch|re-verify before merging/i);
});

// ---- ownerStep.holdEligible: may this hand-off take the merge hold? Computed in code, read by the review skill -------------------

const hardStopHoldYml = () => `${holdYml({ merge: goMergeCmd })}hard_stops:\n  paths: ['**']\n`;
const ownerRunsWorld = (o = {}) => {
  const s = scenario({ yml: hardStopHoldYml(), baseFiles: holdFiles, report: null, state: null, change: unique });
  s.fake.setScript(dryScript(s, o));
  return s;
};

test('dry run --owner-go, say-merge with nothing ahead: wouldMerge and ownerStep.holdEligible true', () => {
  const s = scenario({ yml: holdYml({ merge: goMergeCmd }), baseFiles: holdFiles, report: null, state: null, change: unique });
  s.fake.setScript(dryScript(s));
  const d = dry(s, { FAKE_HOLD_CHECK_SEQ: seq(CLEAR) }, ['--owner-go']);
  assertExit(d, 0, `${d.stderr}${d.stdout}`);
  assert.equal(d.json.ownerStep.kind, 'say-merge');
  assert.equal(d.json.ownerStep.holdEligible, true);
});

test('dry run --owner-go, owner-runs whose ONLY blockers are the owner-items check and the hardstops check behind it: holdEligible true although wouldMerge is false', () => {
  const s = ownerRunsWorld();
  const d = dry(s, { FAKE_HOLD_CHECK_SEQ: seq(CLEAR) }, ['--owner-go']);
  assertExit(d, 1, `${d.stderr}${d.stdout}`);
  assert.equal(d.json.wouldMerge, false);
  assert.equal(d.json.ownerStep.kind, 'owner-runs');
  assert.deepEqual(d.json.blockers.map((x) => x.detail.split(':')[0]), ['hardstops', 'owner-items'], JSON.stringify(d.json.blockers));
  assert.equal(d.json.ownerStep.holdEligible, true);
});

test('dry run --owner-go, owner-runs with a hold ahead: holdEligible false (the merge-hold blocker disqualifies)', () => {
  const s = ownerRunsWorld();
  const d = dry(s, { FAKE_HOLD_CHECK_SEQ: seq(BLOCKED) }, ['--owner-go']);
  assertExit(d, 1);
  assert.equal(d.json.ownerStep.kind, 'owner-runs');
  assert.ok(kinds(d).includes('merge-hold'));
  assert.equal(d.json.ownerStep.holdEligible, false);
});

test('dry run --owner-go, owner-runs with another blocker (the PR is behind): holdEligible false', () => {
  const s = ownerRunsWorld({ merge: 'BEHIND' });
  const d = dry(s, { FAKE_HOLD_CHECK_SEQ: seq(CLEAR) }, ['--owner-go']);
  assertExit(d, 1);
  assert.equal(d.json.ownerStep.kind, 'owner-runs');
  assert.ok(kinds(d).includes('behind-base'), JSON.stringify(d.json.blockers));
  assert.equal(d.json.ownerStep.holdEligible, false);
});

test('dry run --owner-go, say-merge: a hold ahead makes the hand-off ineligible, and so does an unreadable check', () => {
  const s = scenario({ yml: holdYml({ merge: goMergeCmd }), baseFiles: holdFiles, report: null, state: null, change: unique });
  s.fake.setScript(dryScript(s));
  assert.equal(dry(s, { FAKE_HOLD_CHECK_SEQ: seq(BLOCKED) }, ['--owner-go']).json.ownerStep.holdEligible, false);
  assert.equal(dry(s, { FAKE_HOLD_CHECK_SEQ: seq(CLEAR), FAKE_HOLD_CHECK_EXIT: '1' }, ['--owner-go']).json.ownerStep.holdEligible, false);
  assert.equal(dry(s, { FAKE_HOLD_CHECK_SEQ: seq(CLEAR) }, ['--owner-go']).json.ownerStep.holdEligible, true);
});

test('dry run, a repo WITHOUT the hold keys: no `holds` key at all and no shell call', () => {
  const s = scenario({ baseFiles: holdFiles });
  s.fake.setScript(dryScript(s));
  assertExit(s.gate(), 0);
  const d = dry(s, { FAKE_HOLD_CHECK_SEQ: seq(BLOCKED) });
  assertExit(d, 0, `${d.stderr}${d.stdout}`);
  assert.equal('holds' in d.json, false);
  assert.deepEqual(holdCalls(s), []);
  assert.ok(!kinds(d).includes('merge-hold'));
});

test('dry run --owner-go: a hold ahead is a merge-hold blocker and holds is reported; one shell call', () => {
  const s = scenario({ yml: holdYml({ merge: goMergeCmd }), baseFiles: holdFiles, report: null, state: null, change: unique });
  s.fake.setScript(dryScript(s));
  const d = dry(s, { FAKE_HOLD_CHECK_SEQ: seq(BLOCKED) }, ['--owner-go']);
  assertExit(d, 1, `${d.stderr}${d.stdout}`);
  assert.equal(d.json.mode, 'owner-go');
  assert.ok(kinds(d).includes('merge-hold'), JSON.stringify(d.json.blockers));
  assert.deepEqual(d.json.holds.blockedBy.map((b) => b.number), [1400]);
  assert.deepEqual(holdCalls(s), [`check ${PR}`]);
  assert.deepEqual(writes(s), []);
});

// A scan that CRASHED (safely() turns the throw into a failed 'could not evaluate' check) is no verdict: it also fails owner-items, but a PR whose
// hard-stop / integrity scan never ran is not an owner-runs hand-off (the owner would merge it by hand with no scan): ownerStep stays null, the
// blockers are the answer, and nothing takes the merge hold.
const TOO_COMPLEX = `${'*/'.repeat(20)}x`; // more wildcards than a glob may have (lib/glob.mjs tooComplex): the matcher throws
const crashWorld = (extraYml) => {
  const s = scenario({ yml: `${holdYml({ merge: goMergeCmd })}${extraYml}`, baseFiles: holdFiles, report: null, state: null, change: unique });
  s.fake.setScript(dryScript(s));
  return s;
};

test('dry run --owner-go, a hardstops scan that threw: no owner-runs hand-off (ownerStep null), the crash is the blocker', () => {
  const s = crashWorld(`hard_stops:\n  paths: ['${TOO_COMPLEX}']\n`);
  const d = dry(s, { FAKE_HOLD_CHECK_SEQ: seq(CLEAR) }, ['--owner-go']);
  assertExit(d, 1, `${d.stderr}${d.stdout}`);
  assert.equal(d.json.wouldMerge, false);
  assert.equal(d.json.ownerStep, null);
  assert.ok(d.json.blockers.some((b) => /^hardstops: could not evaluate/.test(b.detail)), JSON.stringify(d.json.blockers));
});

test('dry run --owner-go, an integrity scan that threw: no owner-runs hand-off (ownerStep null), the crash is the blocker', () => {
  const s = crashWorld(`integrity:\n  test_globs: ['${TOO_COMPLEX}']\n`);
  const d = dry(s, { FAKE_HOLD_CHECK_SEQ: seq(CLEAR) }, ['--owner-go']);
  assertExit(d, 1, `${d.stderr}${d.stdout}`);
  assert.equal(d.json.wouldMerge, false);
  assert.equal(d.json.ownerStep, null);
  assert.ok(d.json.blockers.some((b) => /^integrity: could not evaluate/.test(b.detail)), JSON.stringify(d.json.blockers));
});

test('dry run --owner-go, a real hard-stop hit still hands off with holdEligible true (the crash guard does not cover verdicts)', () => {
  const s = ownerRunsWorld();
  const d = dry(s, { FAKE_HOLD_CHECK_SEQ: seq(CLEAR) }, ['--owner-go']);
  assert.match(d.json.blockers.find((b) => /^hardstops:/.test(b.detail)).detail, /hard-stop hit\(s\)/);
  assert.equal(d.json.ownerStep.holdEligible, true);
});

// The other scan can still carry an ownerMerge count while one crashed (chat mode: a skipped test is an owner-merge integrity item). That count
// must not turn the crash into an owner-runs hand-off either, on the gate route (counts from the live gate) or on --owner-go.
const skipChange = (repo) => { unique(repo); repo.write('src/app.test.js', "test.skip('x', () => {});\n"); };
const crashWithItemWorld = () => {
  const s = scenario({
    yml: `${holdYml({ merge: goMergeCmd })}owner_approval: chat\nintegrity:\n  test_globs: ['**/*.test.js']\nhard_stops:\n  paths: ['${TOO_COMPLEX}']\n`,
    baseFiles: holdFiles, report: null, state: null, change: skipChange,
  });
  s.fake.setScript(dryScript(s));
  return s;
};

test('dry run (gate route), a hardstops scan that threw while integrity carries an owner-merge item: ownerStep null, not owner-runs', () => {
  const s = crashWithItemWorld();
  const d = dry(s, { FAKE_HOLD_CHECK_SEQ: seq(CLEAR) });
  assertExit(d, 1, `${d.stderr}${d.stdout}`);
  assert.ok(d.json.blockers.some((b) => /^hardstops: could not evaluate/.test(b.detail)), JSON.stringify(d.json.blockers));
  assert.equal(d.json.ownerStep, null);
});

test('dry run --owner-go, a hardstops scan that threw while integrity carries an owner-merge item: ownerStep null, not owner-runs', () => {
  const s = crashWithItemWorld();
  const d = dry(s, { FAKE_HOLD_CHECK_SEQ: seq(CLEAR) }, ['--owner-go']);
  assertExit(d, 1, `${d.stderr}${d.stdout}`);
  assert.ok(d.json.blockers.some((b) => /^hardstops: could not evaluate/.test(b.detail)), JSON.stringify(d.json.blockers));
  assert.equal(d.json.ownerStep, null);
});
