// `P merge`, `P update-branch` and `P merge --dry-run` for a repo that keeps a cooperative merge hold (merge.hold_* keys; plan
// 2026-11-05-merge-hold-queue), through the real CLI against the scripted fake gh and a fake hold provider script. A repo without the keys
// is covered by the existing merge tests, which stay unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mergeRequest, ownerSays } from './helpers/owner-go.mjs';
import { bump, cli, ghEntries, scenario, ymlFor, PR } from './helpers/gate-env.mjs';
import { assertExit } from './helpers/assert-exit.mjs';
import { EW_QUEUED_LINE, answer, blocker, holdCalls, holdFiles, holdYml, seq } from './helpers/merge-hold-env.mjs';

const BLOCKED = answer(PR, [blocker(1400)]);
const CLEAR = answer(PR, []);
const writes = (s) => s.fake.lines().filter((l) => /-X (POST|PUT|PATCH|DELETE)\b/.test(l) || /^pr (merge|edit|ready|close|comment)\b/.test(l) || /update-branch/.test(l));
const puts = (s) => s.fake.lines().filter((l) => l.includes('-X PUT'));
const checks = (s) => holdCalls(s).filter((l) => l.startsWith('check'));
const timing = { PIPELINE_UPDATE_WAIT_MS: '0', PIPELINE_UPDATE_POLL_MS: '1' };

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
  assert.equal(checks(s).length, 1);

  const upToDate = scenario({ yml: holdYml(), baseFiles: holdFiles });
  const done = updateCli(upToDate, { FAKE_HOLD_CHECK_SEQ: seq(BLOCKED) });
  assertExit(done, 0);
  assert.equal(done.json.outcome, 'up-to-date');
  assert.deepEqual(holdCalls(upToDate), []);
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
