import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ciStatus,
  ciDetail,
  lastActivity,
  classifyPr,
  classifyStranded,
  triageGroups,
} from '../pipeline/lib/inbox.mjs';

const NOW = new Date('2026-10-12T12:00:00Z');
const HEAD = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const DAY = 86400000;
const ago = (ms) => new Date(NOW.getTime() - ms).toISOString();

// ---- ciStatus ---------------------------------------------------------------------------------

const run = (name, status, conclusion = null) => ({ name, status, conclusion });
const ok = (name) => run(name, 'COMPLETED', 'SUCCESS');

test('ciStatus: every required name successful => passed', () => {
  assert.equal(ciStatus([ok('a'), ok('b'), ok('extra')], ['a', 'b']), 'passed');
});

test('ciStatus: a missing required name => incomplete', () => {
  assert.equal(ciStatus([ok('a')], ['a', 'b']), 'incomplete');
});

test('ciStatus: pending / queued / in-progress required row => incomplete', () => {
  assert.equal(ciStatus([ok('a'), run('b', 'IN_PROGRESS')], ['a', 'b']), 'incomplete');
  assert.equal(ciStatus([ok('a'), run('b', 'QUEUED')], ['a', 'b']), 'incomplete');
  assert.equal(ciStatus([ok('a'), { context: 'b', state: 'PENDING' }], ['a', 'b']), 'incomplete');
  assert.equal(ciStatus([ok('a'), { context: 'b', state: 'EXPECTED' }], ['a', 'b']), 'incomplete');
});

test('ciStatus: any failing required row => failed, even when another is missing', () => {
  assert.equal(ciStatus([run('a', 'COMPLETED', 'FAILURE')], ['a', 'b']), 'failed');
  for (const c of ['CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE']) {
    assert.equal(ciStatus([run('a', 'COMPLETED', c)], ['a']), 'failed', c);
  }
});

test('ciStatus: STALE and unknown conclusions are incomplete, never failed or passed', () => {
  assert.equal(ciStatus([run('a', 'COMPLETED', 'STALE')], ['a']), 'incomplete');
  assert.equal(ciStatus([run('a', 'COMPLETED', 'WHO_KNOWS')], ['a']), 'incomplete');
  assert.equal(ciStatus([run('a', 'COMPLETED', null)], ['a']), 'incomplete');
});

test('ciStatus: NEUTRAL and SKIPPED count as success', () => {
  assert.equal(ciStatus([run('a', 'COMPLETED', 'NEUTRAL'), run('b', 'COMPLETED', 'SKIPPED')], ['a', 'b']), 'passed');
});

test('ciStatus: latest row per name wins (input is oldest first)', () => {
  assert.equal(ciStatus([run('a', 'COMPLETED', 'FAILURE'), ok('a')], ['a']), 'passed');
  assert.equal(ciStatus([ok('a'), run('a', 'COMPLETED', 'FAILURE')], ['a']), 'failed');
  assert.equal(ciStatus([ok('a'), run('a', 'IN_PROGRESS')], ['a']), 'incomplete');
});

test('ciStatus: StatusContext rows (context + state)', () => {
  assert.equal(ciStatus([{ context: 'vercel', state: 'SUCCESS' }], ['vercel']), 'passed');
  assert.equal(ciStatus([{ context: 'vercel', state: 'FAILURE' }], ['vercel']), 'failed');
  assert.equal(ciStatus([{ context: 'vercel', state: 'ERROR' }], ['vercel']), 'failed');
  assert.equal(ciStatus([ok('a'), { context: 'vercel', state: 'SUCCESS' }], ['a', 'vercel']), 'passed');
});

test('ciStatus: empty required list judges all rows the same way', () => {
  assert.equal(ciStatus([ok('a'), ok('b')], []), 'passed');
  assert.equal(ciStatus([ok('a'), run('b', 'COMPLETED', 'FAILURE')], []), 'failed');
  assert.equal(ciStatus([ok('a'), run('b', 'IN_PROGRESS')], []), 'incomplete');
});

test('ciStatus: no rows is incomplete with or without required names', () => {
  assert.equal(ciStatus([], []), 'incomplete');
  assert.equal(ciStatus([], ['a']), 'incomplete');
  assert.equal(ciStatus(undefined, undefined), 'incomplete');
});

test('ciStatus: a non-required failing row does not fail a run with required names', () => {
  assert.equal(ciStatus([ok('a'), run('flaky', 'COMPLETED', 'FAILURE')], ['a']), 'passed');
});

// ---- lastActivity -----------------------------------------------------------------------------

test('lastActivity: picks the max instant and names its kind', () => {
  const r = lastActivity(
    {
      commitDate: '2026-10-01T00:00:00Z',
      commentUpdatedAts: ['2026-10-03T00:00:00Z', '2026-10-02T00:00:00Z'],
      reviewDates: ['2026-10-02T12:00:00Z'],
      createdAt: '2026-09-20T00:00:00Z',
    },
    NOW,
  );
  assert.deepEqual(r, { at: '2026-10-03T00:00:00.000Z', kind: 'comment' });
});

test('lastActivity: kinds commit, review, created', () => {
  assert.equal(lastActivity({ commitDate: '2026-10-05T00:00:00Z', createdAt: '2026-09-01T00:00:00Z' }, NOW).kind, 'commit');
  assert.equal(lastActivity({ reviewDates: ['2026-10-05T00:00:00Z'], createdAt: '2026-09-01T00:00:00Z' }, NOW).kind, 'review');
  assert.deepEqual(lastActivity({ createdAt: '2026-09-01T00:00:00Z' }, NOW), { at: '2026-09-01T00:00:00.000Z', kind: 'created' });
});

test('lastActivity: compares instants, not strings (+08:00 vs Z)', () => {
  // 2026-10-05T09:00+08:00 is 01:00Z, which is EARLIER than 2026-10-05T05:00Z although "09" > "05" as text.
  const r = lastActivity({ commitDate: '2026-10-05T09:00:00+08:00', commentUpdatedAts: ['2026-10-05T05:00:00Z'], createdAt: '2026-01-01T00:00:00Z' }, NOW);
  assert.deepEqual(r, { at: '2026-10-05T05:00:00.000Z', kind: 'comment' });
  const r2 = lastActivity({ commitDate: '2026-10-05T14:00:00+08:00', commentUpdatedAts: ['2026-10-05T05:00:00Z'], createdAt: '2026-01-01T00:00:00Z' }, NOW);
  assert.deepEqual(r2, { at: '2026-10-05T06:00:00.000Z', kind: 'commit' });
});

test('lastActivity: future instants clamp to now', () => {
  const r = lastActivity({ commitDate: '2027-01-01T00:00:00Z', createdAt: '2026-09-01T00:00:00Z' }, NOW);
  assert.deepEqual(r, { at: NOW.toISOString(), kind: 'commit' });
});

test('lastActivity: unparsable values are ignored', () => {
  const r = lastActivity({ commitDate: 'not a date', commentUpdatedAts: ['', null, 'garbage', '2026-10-02T00:00:00Z'], reviewDates: undefined, createdAt: '2026-09-01T00:00:00Z' }, NOW);
  assert.deepEqual(r, { at: '2026-10-02T00:00:00.000Z', kind: 'comment' });
});

test('lastActivity: nothing parsable => at null', () => {
  assert.deepEqual(lastActivity({ createdAt: 'x' }, NOW), { at: null, kind: null });
  assert.deepEqual(lastActivity({}, NOW), { at: null, kind: null });
});

// ---- classifyPr fixtures ----------------------------------------------------------------------

const record = (over = {}) => ({
  step: 'gate',
  outcome: null,
  head: HEAD,
  heartbeat: { host: 'mac', at: ago(10 * DAY) },
  inFlight: null,
  verify: null,
  ...over,
});
const triage = (over = {}) => ({ rounds: 1, lastRound: 1, clean: true, lastContentHash: 'h1', followupsPending: false, ...over });

function facts(over = {}) {
  return {
    number: 7,
    title: 'T',
    isDraft: false,
    labels: [],
    headRefOid: HEAD,
    isCrossRepository: false,
    ci: 'passed',
    conflicts: false,
    alreadyOnBase: false,
    record: record({ step: 'awaiting-owner-merge', outcome: 'awaiting-owner-merge' }),
    recordStatus: 'ok',
    triage: triage(),
    contentHash: 'h1',
    needsHumanReason: null,
    needsHumanHardStopOnly: false,
    activity: { commitDate: ago(DAY), createdAt: ago(3 * DAY) },
    local: null,
    ...over,
  };
}
const opts = { staleDays: 14, now: NOW, ownerApproval: 'label' };
const cls = (over, o = {}) => classifyPr(facts(over), { ...opts, ...o });
const untrackedStale = { record: null, recordStatus: 'absent', triage: null, activity: { commitDate: ago(30 * DAY), createdAt: ago(40 * DAY) } };

test('category owner-merge: gated, clean, passing', () => {
  const r = cls({});
  assert.equal(r.waitingOn, 'owner-merge');
  assert.equal(r.suggest, 'merge');
  assert.equal(r.nextAction, 'say "merge" (head a1b2c3d)');
  assert.equal(r.stale, false);
  assert.equal(r.lastActivity.kind, 'commit');
});

test('category nothing-left: head already on base', () => {
  const r = cls({ alreadyOnBase: true });
  assert.equal(r.waitingOn, 'nothing-left');
  assert.equal(r.suggest, 'close');
  assert.equal(r.nextAction, 'close');
});

test('category running: fresh heartbeat', () => {
  const r = cls({ record: record({ heartbeat: { host: 'pc', at: ago(20 * 60000) } }) });
  assert.equal(r.waitingOn, 'running');
  assert.equal(r.suggest, 'leave');
  assert.equal(r.nextAction, 'leave: running on pc, 20 min ago');
});

test('running: heartbeat exactly at the freshness limit is not fresh; just under is', () => {
  assert.notEqual(cls({ record: record({ heartbeat: { host: 'pc', at: ago(90 * 60000) } }) }).waitingOn, 'running');
  assert.equal(cls({ record: record({ heartbeat: { host: 'pc', at: ago(89 * 60000) } }) }).waitingOn, 'running');
});

test('running: heartbeatFreshMinutes is configurable', () => {
  const f = { record: record({ step: 'awaiting-owner-merge', outcome: 'awaiting-owner-merge', heartbeat: { host: 'pc', at: ago(30 * 60000) } }) };
  assert.equal(cls(f, { heartbeatFreshMinutes: 20 }).waitingOn, 'owner-merge');
  assert.equal(cls(f, { heartbeatFreshMinutes: 40 }).waitingOn, 'running');
});

test('running: live inFlight within maxMinutes, with an old heartbeat', () => {
  const r = cls({ record: record({ inFlight: { kind: 'merge', host: 'mac', startedAt: ago(5 * 60000), maxMinutes: 30 } }) });
  assert.equal(r.waitingOn, 'running');
  assert.equal(r.nextAction, 'leave: running on mac, 5 min ago');
});

test('running: inFlight past maxMinutes is dead', () => {
  const r = cls({ record: record({ inFlight: { kind: 'merge', host: 'mac', startedAt: ago(31 * 60000), maxMinutes: 30 } }) });
  assert.notEqual(r.waitingOn, 'running');
});

test('running: a future heartbeat (clock skew) counts as fresh; an unparsable one does not', () => {
  assert.equal(cls({ record: record({ heartbeat: { host: 'pc', at: '2027-01-01T00:00:00Z' } }) }).waitingOn, 'running');
  assert.notEqual(cls({ record: record({ heartbeat: { host: 'pc', at: 'garbage' } }) }).waitingOn, 'running');
});

// the run ended at the owner: only then does the label alone decide the category
const atOwner = record({ step: 'ended', outcome: 'needs-human' });

test('category owner-decision: needs-human label with the reason', () => {
  const r = cls({ labels: ['needs-human'], record: atOwner, needsHumanReason: 'touches migrations' });
  assert.equal(r.waitingOn, 'owner-decision');
  assert.equal(r.suggest, 'leave');
  assert.match(r.reason, /touches migrations/);
});

test('owner-decision without a recorded reason still explains itself', () => {
  const r = cls({ labels: ['needs-human'], record: atOwner });
  assert.equal(r.waitingOn, 'owner-decision');
  assert.ok(r.reason.length > 0);
});

test('label-mode leftover: chat repo + hard-stop-only needs-human', () => {
  const r = cls({ labels: ['needs-human'], record: atOwner, needsHumanReason: 'migrations', needsHumanHardStopOnly: true }, { ownerApproval: 'chat' });
  assert.equal(r.waitingOn, 'owner-decision');
  assert.equal(r.reason, 'label-mode leftover: remove the needs-human label, then ship resume 7');
});

test('label-mode repo keeps hard-stop-only needs-human as a plain owner decision', () => {
  const r = cls({ labels: ['needs-human'], record: atOwner, needsHumanReason: 'migrations', needsHumanHardStopOnly: true }, { ownerApproval: 'label' });
  assert.equal(r.waitingOn, 'owner-decision');
  assert.doesNotMatch(r.reason, /label-mode leftover/);
});

test('chat repo, needs-human NOT hard-stop-only, is a plain owner decision', () => {
  const r = cls({ labels: ['needs-human'], record: atOwner, needsHumanReason: 'judge disagreed', needsHumanHardStopOnly: false }, { ownerApproval: 'chat' });
  assert.doesNotMatch(r.reason, /label-mode leftover/);
  assert.match(r.reason, /judge disagreed/);
});

// A run that stalls mid-review on a hard-stop PR carries the label before it has stopped: only a run that ENDED (or one we
// cannot read) is waiting on the owner.
const LABEL_FRAGMENT = 'needs-human label present: the run continues but ends at the owner (no merge)';
const midRun = (over = {}) => record({ step: 'pr', outcome: null, heartbeat: { host: 'mac', at: ago(3 * DAY) }, ...over });

test('needs-human + a record that ended needs-human => owner-decision', () => {
  const r = cls({ labels: ['needs-human'], needsHumanReason: 'touches migrations', record: midRun({ step: 'ended', outcome: 'needs-human' }) });
  assert.equal(r.waitingOn, 'owner-decision');
  assert.equal(r.suggest, 'leave');
  assert.match(r.reason, /touches migrations/);
});

test('needs-human + no usable record => owner-decision', () => {
  for (const recordStatus of ['absent', 'legacy', 'invalid', 'unsupported', 'mismatch']) {
    const r = cls({ labels: ['needs-human'], recordStatus, record: null, triage: triage() });
    assert.equal(r.waitingOn, 'owner-decision', recordStatus);
  }
});

test('needs-human + a mid-run record (outcome null) does not short-circuit: normal precedence, plus the label fragment', () => {
  const stalled = cls({ labels: ['needs-human'], record: midRun() });
  assert.equal(stalled.waitingOn, 'pipeline');
  assert.equal(stalled.suggest, 'resume');
  assert.ok(stalled.reason.includes(LABEL_FRAGMENT));
  assert.match(stalled.nextAction, /ship resume 7/);
  const failing = cls({ labels: ['needs-human'], record: midRun(), ci: 'failed' });
  assert.equal(failing.waitingOn, 'failing-check');
  assert.ok(failing.reason.includes(LABEL_FRAGMENT));
  const review = cls({ labels: ['needs-human'], record: midRun(), contentHash: 'changed' });
  assert.equal(review.waitingOn, 'review');
  assert.equal(review.suggest, 'resume');
  assert.ok(review.reason.includes(LABEL_FRAGMENT));
  // a live run still outranks it, with no fragment
  const live = cls({ labels: ['needs-human'], record: midRun({ heartbeat: { host: 'pc', at: ago(60000) } }) });
  assert.equal(live.waitingOn, 'running');
  assert.ok(!live.reason.includes(LABEL_FRAGMENT));
});

test('needs-human + a resumable ended outcome: awaiting-review => review, blocked => failing-check, awaiting-owner-merge => re-gate', () => {
  const review = cls({ labels: ['needs-human'], record: midRun({ step: 'ended', outcome: 'awaiting-review' }) });
  assert.equal(review.waitingOn, 'review');
  assert.ok(review.reason.includes(LABEL_FRAGMENT));
  const blocked = cls({ labels: ['needs-human'], record: midRun({ step: 'ended', outcome: 'blocked' }) });
  assert.equal(blocked.waitingOn, 'failing-check');
  assert.ok(blocked.reason.includes(LABEL_FRAGMENT));
  const gated = cls({ labels: ['needs-human'], record: midRun({ step: 'awaiting-owner-merge', outcome: 'awaiting-owner-merge', head: HEAD }) });
  assert.equal(gated.waitingOn, 'pipeline');
  assert.equal(gated.suggest, 'resume');
  assert.equal(gated.nextAction, 're-gate: ship resume 7');
  assert.ok(gated.reason.includes(LABEL_FRAGMENT));
});

test('needs-human + any other ended outcome on an open PR => owner-decision', () => {
  assert.equal(cls({ labels: ['needs-human'], record: midRun({ step: 'ended', outcome: 'merged' }) }).waitingOn, 'owner-decision');
});

test('category failing-check: CI failed', () => {
  const r = cls({ ci: 'failed' });
  assert.equal(r.waitingOn, 'failing-check');
  assert.equal(r.suggest, 'resume');
  assert.equal(r.nextAction, 'ship resume 7 (fix the failing check)');
  const named = cls({ ci: 'failed', ciFailed: ['Test integrity', 'e2e'] });
  assert.equal(named.reason, 'required checks failed: Test integrity, e2e');
  assert.equal(named.nextAction, 'ship resume 7 (fix the failing checks: Test integrity, e2e)');
  assert.equal(cls({ ci: 'failed', ciFailed: ['ci'] }).reason, 'required check failed: ci');
});

test('failing-check: conflicts name the base and say what to do', () => {
  const r = cls({ conflicts: true, baseRefName: 'develop' });
  assert.equal(r.waitingOn, 'failing-check');
  assert.equal(r.reason, 'conflicts with develop');
  assert.equal(r.nextAction, 'ship resume 7 (update with develop, resolve conflicts)');
  const both = cls({ conflicts: true, baseRefName: 'main', ci: 'failed', ciFailed: ['ci'] });
  assert.equal(both.reason, 'required check failed: ci; conflicts with main');
  assert.equal(both.nextAction, 'ship resume 7 (fix the failing check: ci; update with main, resolve conflicts)');
  assert.equal(cls({ conflicts: true }).reason, 'conflicts with the base branch');
});

test('failing-check: conflicts, pipeline-blocked label, failed verify for this head', () => {
  assert.equal(cls({ conflicts: true }).waitingOn, 'failing-check');
  assert.equal(cls({ labels: ['pipeline-blocked'] }).waitingOn, 'failing-check');
  const v = (head) => ({
    record: record({ step: 'awaiting-owner-merge', outcome: 'awaiting-owner-merge', verify: { head, ok: false, failedStep: 'typecheck' } }),
  });
  const bad = cls(v(HEAD));
  assert.equal(bad.waitingOn, 'failing-check');
  assert.match(bad.reason, /typecheck/);
  // a failed verify for an OLDER head says nothing about this one
  assert.equal(cls(v('0000000000000000000000000000000000000000')).waitingOn, 'owner-merge');
});

test('category review: awaiting-review label or outcome', () => {
  const byLabel = cls({ labels: ['awaiting-review'], record: record({ outcome: 'awaiting-review', step: 'review' }) });
  assert.equal(byLabel.waitingOn, 'review');
  assert.equal(byLabel.suggest, 'resume');
  assert.equal(cls({ record: record({ outcome: 'awaiting-review', step: 'review' }) }).waitingOn, 'review');
  assert.equal(cls({ labels: ['awaiting-review'] }).waitingOn, 'review');
});

test('review: content hash differs from the last reviewed one', () => {
  const r = cls({ contentHash: 'h2' });
  assert.equal(r.waitingOn, 'review');
  assert.match(r.reason, /changed since/);
});

test('review: unknown content hash does not by itself force a review', () => {
  assert.equal(cls({ contentHash: null }).waitingOn, 'owner-merge');
});

test('review: last round not clean; follow-ups pending', () => {
  assert.equal(cls({ triage: triage({ clean: false }) }).waitingOn, 'review');
  const f = cls({ triage: triage({ followupsPending: true }) });
  assert.equal(f.waitingOn, 'review');
  assert.match(f.reason, /follow-up/);
});

test('review: untracked and active => never reviewed, adopt', () => {
  const r = cls({ record: null, recordStatus: 'absent', triage: null, contentHash: 'h9' });
  assert.equal(r.waitingOn, 'review');
  assert.equal(r.reason, 'never reviewed: ship resume 7 adopts it');
  assert.equal(r.nextAction, 'ship resume 7');
  assert.equal(r.suggest, 'resume');
});

test('category abandoned: untracked and stale', () => {
  const r = cls(untrackedStale);
  assert.equal(r.waitingOn, 'abandoned');
  assert.equal(r.suggest, 'close');
  assert.equal(r.nextAction, 'close');
  assert.equal(r.stale, true);
  assert.equal(r.reason, `no pipeline history, last activity ${ago(30 * DAY).slice(0, 10)}`);
});

test('untracked means NO record and NO triage: triage alone is tracked', () => {
  const r = cls({ ...untrackedStale, triage: triage({ clean: true }), contentHash: 'h1' });
  assert.equal(r.waitingOn, 'pipeline');
});

test('a legacy / unsupported / invalid record is not untracked', () => {
  for (const recordStatus of ['legacy', 'unsupported', 'invalid']) {
    const r = cls({ ...untrackedStale, recordStatus });
    assert.equal(r.waitingOn, 'pipeline', recordStatus);
    assert.match(r.reason, new RegExp(recordStatus));
  }
});

test('category pipeline: stalled mid-run names the host and when', () => {
  const at = ago(3 * DAY);
  const r = cls({ record: record({ step: 'verify', outcome: null, heartbeat: { host: 'mac', at } }), triage: null, contentHash: null });
  assert.equal(r.waitingOn, 'pipeline');
  assert.equal(r.suggest, 'resume');
  assert.equal(r.nextAction, `stalled on mac since ${at.slice(0, 10)}: ship resume 7`);
});

test('pipeline: a draft that was never gated', () => {
  const r = cls({ isDraft: true, record: record({ step: 'pr', outcome: null, heartbeat: { host: 'mac', at: ago(3 * DAY) } }), triage: triage(), contentHash: 'h1' });
  assert.equal(r.waitingOn, 'pipeline');
});

// ---- precedence ties --------------------------------------------------------------------------

test('tie: alreadyOnBase beats needs-human, running and failing CI', () => {
  const r = cls({ alreadyOnBase: true, labels: ['needs-human'], ci: 'failed', record: record({ heartbeat: { host: 'pc', at: ago(60000) } }) });
  assert.equal(r.waitingOn, 'nothing-left');
});

test('tie: running beats needs-human and failing CI', () => {
  const r = cls({ labels: ['needs-human'], ci: 'failed', record: record({ heartbeat: { host: 'pc', at: ago(60000) } }) });
  assert.equal(r.waitingOn, 'running');
});

test('tie: needs-human beats failing CI', () => {
  assert.equal(cls({ labels: ['needs-human'], record: atOwner, ci: 'failed' }).waitingOn, 'owner-decision');
});

test('tie: failing CI beats review', () => {
  assert.equal(cls({ ci: 'failed', labels: ['awaiting-review'] }).waitingOn, 'failing-check');
});

test('tie: review beats owner-merge', () => {
  assert.equal(cls({ contentHash: 'changed' }).waitingOn, 'review');
});

test('tie: untracked + stale is abandoned even with failing CI, conflicts, an incomplete CI or a draft', () => {
  const failed = cls({ ...untrackedStale, ci: 'failed', ciFailed: ['ci'], conflicts: true, baseRefName: 'main' });
  assert.equal(failed.waitingOn, 'abandoned');
  assert.equal(failed.suggest, 'close');
  assert.equal(failed.nextAction, 'close');
  assert.match(failed.reason, /^no pipeline history, last activity \d{4}-\d{2}-\d{2}; also required check failed: ci; conflicts with main$/);
  assert.match(cls({ ...untrackedStale, conflicts: true, baseRefName: 'main' }).reason, /; also conflicts with main$/);
  assert.equal(cls({ ...untrackedStale, ci: 'incomplete' }).waitingOn, 'abandoned');
  const draft = cls({ ...untrackedStale, isDraft: true });
  assert.equal(draft.waitingOn, 'abandoned');
  assert.match(draft.reason, /; also still a draft$/);
  assert.equal(cls({ ...untrackedStale }).reason.includes('also'), false);
});
test('tie: untracked + stale is never review; an untracked ACTIVE PR with a failure is still failing-check', () => {
  assert.notEqual(cls({ ...untrackedStale, labels: ['awaiting-review'] }).waitingOn, 'review');
  const active = { record: null, recordStatus: 'absent', triage: null, activity: { commitDate: ago(DAY), createdAt: ago(3 * DAY) } };
  assert.equal(cls({ ...active, conflicts: true }).waitingOn, 'failing-check');
});
test('tie: owner-decision and running still outrank untracked + stale', () => {
  assert.equal(cls({ ...untrackedStale, labels: ['needs-human'] }).waitingOn, 'owner-decision');
  assert.equal(cls({ ...untrackedStale, alreadyOnBase: true }).waitingOn, 'nothing-left');
});

test('owner-merge record with CI incomplete => pipeline re-gate', () => {
  const r = cls({ ci: 'incomplete' });
  assert.equal(r.waitingOn, 'pipeline');
  assert.equal(r.nextAction, 're-gate: ship resume 7');
  assert.equal(r.suggest, 'resume');
});

test('owner-merge record on a draft => pipeline re-gate', () => {
  const r = cls({ isDraft: true });
  assert.equal(r.waitingOn, 'pipeline');
  assert.equal(r.nextAction, 're-gate: ship resume 7');
});

test('owner-merge record with a head mismatch => pipeline re-gate', () => {
  const r = cls({ record: record({ step: 'awaiting-owner-merge', outcome: 'awaiting-owner-merge', head: 'ffffffffffffffffffffffffffffffffffffffff' }) });
  assert.equal(r.waitingOn, 'pipeline');
  assert.equal(r.nextAction, 're-gate: ship resume 7');
});

test('owner-merge: conflicts null (unknown) is allowed, true is not', () => {
  assert.equal(cls({ conflicts: null }).waitingOn, 'owner-merge');
  assert.equal(cls({ conflicts: true }).waitingOn, 'failing-check');
});

test('CI incomplete / failing / draft / conflicts never suggest merge', () => {
  for (const over of [{ ci: 'incomplete' }, { ci: 'failed' }, { isDraft: true }, { conflicts: true }]) {
    assert.notEqual(cls(over).suggest, 'merge');
  }
});

// ---- stale, fork, local -----------------------------------------------------------------------

test('stale boundary is inclusive at exactly staleDays', () => {
  const at = (ms) => ({ activity: { commitDate: ago(ms), createdAt: ago(60 * DAY) } });
  assert.equal(cls(at(14 * DAY)).stale, true);
  assert.equal(cls(at(14 * DAY - 1)).stale, false);
  assert.equal(cls(at(14 * DAY + 1)).stale, true);
});

test('stale boundary decides abandoned vs review for an untracked PR', () => {
  const u = (ms) => ({ ...untrackedStale, activity: { commitDate: ago(ms), createdAt: ago(60 * DAY) } });
  assert.equal(cls(u(14 * DAY)).waitingOn, 'abandoned');
  assert.equal(cls(u(14 * DAY - 1)).waitingOn, 'review');
});

test('fork PR: not resumable by the pipeline', () => {
  const r = cls({ isCrossRepository: true, ci: 'failed' });
  assert.equal(r.waitingOn, 'failing-check');
  assert.equal(r.nextAction, 'fork PR: not resumable by the pipeline');
  assert.notEqual(r.suggest, 'resume');
});

test('local unpushed work prefixes nextAction without changing waitingOn', () => {
  const r = cls({ local: { worktree: '/w/x', unpushed: 2, dirty: 0, state: 'ahead' } });
  assert.equal(r.waitingOn, 'owner-merge');
  assert.equal(r.nextAction, 'push/commit the local work in /w/x first; then say "merge" (head a1b2c3d)');
});

test('local dirty work prefixes nextAction', () => {
  const r = cls({ ci: 'failed', local: { worktree: '/w/x', unpushed: 0, dirty: 3, state: 'equal' } });
  assert.equal(r.waitingOn, 'failing-check');
  assert.equal(r.nextAction, 'push/commit the local work in /w/x first; then ship resume 7 (fix the failing check)');
});

test('local diverged branch: owner decides', () => {
  const r = cls({ local: { worktree: '/w/x', unpushed: 0, dirty: 0, state: 'diverged' } });
  assert.equal(r.waitingOn, 'owner-merge');
  assert.equal(r.nextAction, 'local branch diverged in /w/x: owner decides; say "merge" (head a1b2c3d)');
});

test('local equal/behind with nothing pending leaves nextAction alone', () => {
  for (const state of ['equal', 'behind']) {
    const r = cls({ local: { worktree: '/w/x', unpushed: 0, dirty: 0, state } });
    assert.equal(r.nextAction, 'say "merge" (head a1b2c3d)');
  }
});

test('fork wins over local work', () => {
  const r = cls({ isCrossRepository: true, local: { worktree: '/w/x', unpushed: 1, dirty: 0, state: 'ahead' } });
  assert.equal(r.nextAction, 'fork PR: not resumable by the pipeline');
});

test('suggest map covers every waitingOn', () => {
  const expected = {
    'nothing-left': 'close',
    running: 'leave',
    'owner-decision': 'leave',
    'failing-check': 'resume',
    review: 'resume',
    'owner-merge': 'merge',
    pipeline: 'resume',
    abandoned: 'close',
  };
  const samples = {
    'nothing-left': { alreadyOnBase: true },
    running: { record: record({ heartbeat: { host: 'h', at: ago(60000) } }) },
    'owner-decision': { labels: ['needs-human'], record: atOwner },
    'failing-check': { ci: 'failed' },
    review: { contentHash: 'zzz' },
    'owner-merge': {},
    pipeline: { ci: 'incomplete' },
    abandoned: untrackedStale,
  };
  for (const [k, over] of Object.entries(samples)) {
    const r = cls(over);
    assert.equal(r.waitingOn, k);
    assert.equal(r.suggest, expected[k], k);
  }
});

test('classifyPr is pure: the same facts give the same answer and facts are not mutated', () => {
  const f = facts({ labels: ['needs-human'] });
  const snap = JSON.stringify(f);
  const a = classifyPr(f, opts);
  const b = classifyPr(f, opts);
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(f), snap);
});

// ---- classifyStranded -------------------------------------------------------------------------

const ev = (over = {}) => ({ rollbackIntent: false, rollbackResult: false, ...over });
const merged = (number, over = {}) => ({
  number,
  mergedAt: ago(2 * DAY),
  recordStatus: 'ok',
  record: record({ step: 'prod-watch', outcome: null }),
  events: ev(),
  ...over,
});

test('stranded: step prod-watch with no outcome', () => {
  const [s] = classifyStranded([merged(5)], NOW);
  assert.equal(s.number, 5);
  assert.equal(s.nextAction, 'ship resume 5 (observes production; never rolls back)');
  assert.equal(s.mergedAt, ago(2 * DAY));
});

test('stranded: step merge with no outcome', () => {
  assert.equal(classifyStranded([merged(5, { record: record({ step: 'merge', outcome: null }) })], NOW).length, 1);
});

test('not stranded: owner merged by hand from an awaiting-owner-merge record', () => {
  const m = merged(5, { record: record({ step: 'awaiting-owner-merge', outcome: 'awaiting-owner-merge' }) });
  assert.equal(classifyStranded([m], NOW).length, 0);
});

test('not stranded: legacy / invalid / unsupported record without a rollback event', () => {
  for (const recordStatus of ['legacy', 'invalid', 'unsupported']) {
    assert.equal(classifyStranded([merged(5, { record: null, recordStatus })], NOW).length, 0, recordStatus);
  }
});

test('not stranded: a mid-merge record that is not ok (recordStatus gate)', () => {
  assert.equal(classifyStranded([merged(5, { recordStatus: 'invalid' })], NOW).length, 0);
});

test('not stranded: merged / ended (prod-watch finished) and every other ended outcome', () => {
  for (const outcome of ['merged', 'superseded', 'recovered', 'rollback-failed', 'changed-during-recovery', 'rollback-skipped', 'not-live', 'deploy-failed', 'deploy-not-observed', 'no-production']) {
    assert.equal(classifyStranded([merged(5, { record: record({ step: 'ended', outcome }) })], NOW).length, 0, outcome);
  }
});

test('stranded: rollback-intent without rollback-result, even on a terminal outcome', () => {
  const [s] = classifyStranded([merged(5, { record: record({ step: 'ended', outcome: 'recovered' }), events: ev({ rollbackIntent: true }) })], NOW);
  assert.equal(s.number, 5);
  assert.match(s.reason, /rollback/);
});

test('not stranded: rollback-intent WITH rollback-result and a terminal outcome', () => {
  const m = merged(5, { record: record({ step: 'ended', outcome: 'recovered' }), events: ev({ rollbackIntent: true, rollbackResult: true }) });
  assert.equal(classifyStranded([m], NOW).length, 0);
});

test('not stranded: no pipeline record at all (not our run)', () => {
  assert.equal(classifyStranded([merged(5, { record: null, recordStatus: 'absent' })], NOW).length, 0);
});

test('stranded: rollback-intent without result and no record at all is still reported', () => {
  const [s] = classifyStranded([merged(5, { record: null, recordStatus: 'absent', events: ev({ rollbackIntent: true }) })], NOW);
  assert.equal(s.number, 5);
});

test('stranded: results are sorted by PR number', () => {
  const out = classifyStranded([merged(9), merged(3), merged(6)], NOW);
  assert.deepEqual(out.map((s) => s.number), [3, 6, 9]);
});

// ---- triageGroups -----------------------------------------------------------------------------

test('triageGroups: groups by suggest in PR-number order', () => {
  const c = [
    { number: 12, suggest: 'merge' },
    { number: 3, suggest: 'resume' },
    { number: 8, suggest: 'close' },
    { number: 5, suggest: 'merge' },
    { number: 1, suggest: 'leave' },
    { number: 9, suggest: 'resume' },
  ];
  assert.deepEqual(triageGroups(c), {
    merge: [c[3], c[0]],
    resume: [c[1], c[5]],
    close: [c[2]],
    leave: [c[4]],
  });
});

test('triageGroups: empty input gives four empty groups', () => {
  assert.deepEqual(triageGroups([]), { merge: [], resume: [], close: [], leave: [] });
});

test('ciDetail: names the failed and the missing required checks', () => {
  const d = ciDetail([ok('a'), run('b', 'COMPLETED', 'FAILURE'), run('c', 'IN_PROGRESS')], ['a', 'b', 'c', 'd']);
  assert.equal(d.status, 'failed');
  assert.deepEqual(d.failed, ['b']);
  assert.deepEqual(d.missing, ['c', 'd']);
  assert.deepEqual(ciDetail([ok('a')], ['a']), { status: 'passed', failed: [], missing: [] });
  assert.equal(ciDetail([], []).status, 'incomplete');
  assert.deepEqual(ciDetail([run('x', 'COMPLETED', 'TIMED_OUT')], []).failed, ['x']);
});
