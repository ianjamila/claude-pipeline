// planResume: the routing table of `ship resume <pr>` (plan section E). Pure facts in, a plan out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planResume } from '../pipeline/lib/resume-plan.mjs';

const NOW = Date.parse('2026-10-12T12:00:00Z');
const ago = (min) => new Date(NOW - min * 60000).toISOString();
const HEAD = 'a'.repeat(40);
const HASH = 'h'.repeat(64);

const record = (over = {}) => ({
  v: 1, repo: 'acme/widgets', pr: 7, branch: 'agent/x', baseRef: 'main', step: 'review', outcome: null, next: '', detail: '',
  head: HEAD, request: '', tasks: [], verify: { head: HEAD, tree: 't', mode: 'full', ok: true, failedStep: null }, round: 1, mergeSha: null,
  inFlight: null, heartbeat: { host: 'pc', at: ago(600) }, agentLogLine: null, cliVersion: null, history: [], ...over,
});
const cleanTriage = (over = {}) => ({ rounds: 1, lastRound: 1, lastRoundComplete: true, lastContentHash: HASH, clean: true, followupsPending: false, ...over });
const local = (over = {}) => ({ state: 'equal', localRef: HEAD, unpushed: 0, dirty: 0, worktrees: [], ...over });

const facts = (over = {}) => ({
  state: 'OPEN', isCrossRepository: false, labels: [], liveHead: HEAD, autoMergeArmed: false, host: 'pc',
  recordStatus: 'ok', record: record(), triage: cleanTriage(), contentHash: HASH, needsHumanReason: null, events: [],
  local: local(), ...over,
});
const plan = (over, opts) => planResume(facts(over), { now: NOW, ...opts });

// ---- routing table: every `enter` value ------------------------------------------------------

test('closed: a PR closed without a merge', () => {
  const p = plan({ state: 'CLOSED' });
  assert.equal(p.enter, 'closed');
  assert.deepEqual(p.worktree, { action: 'none' });
  assert.equal(p.confirm, null);
});

test('merged with an ended record is ended; merged with no record at all is ended', () => {
  assert.equal(plan({ state: 'MERGED', record: record({ step: 'ended', outcome: 'merged' }) }).enter, 'ended');
  assert.equal(plan({ state: 'MERGED', recordStatus: 'absent', record: null, triage: null }).enter, 'ended');
  const p = plan({ state: 'MERGED', record: record({ step: 'ended', outcome: 'recovered' }) });
  assert.match(p.reason, /recovered/);
});

test('merged mid merge / prod-watch with no outcome observes production, from a detached worktree, never a rollback', () => {
  for (const step of ['merge', 'prod-watch']) {
    const p = plan({ state: 'MERGED', record: record({ step }) });
    assert.equal(p.enter, 'observe-prod', step);
    assert.deepEqual(p.worktree, { action: 'none' });
    assert.ok(p.notes.includes('run from a detached worktree of origin/<base> at the merge commit'));
    assert.ok(p.notes.some((n) => /never roll production back/.test(n)));
    assert.equal(p.autoMerge, null);
  }
  // a step before the merge is not stranded after it
  assert.equal(plan({ state: 'MERGED', record: record({ step: 'gate' }) }).enter, 'ended');
  // a record at prod-watch that already has an outcome is finished
  assert.equal(plan({ state: 'MERGED', record: record({ step: 'prod-watch', outcome: 'recovered' }) }).enter, 'ended');
});

test('merged: a rollback-intent without a rollback-result observes production and warns, whatever the record says', () => {
  const p = plan({ state: 'MERGED', record: record({ step: 'ended', outcome: 'merged' }), events: [{ kind: 'prod-before' }, { kind: 'rollback-intent' }] });
  assert.equal(p.enter, 'observe-prod');
  assert.ok(p.notes.some((n) => /rollback may have been in progress/.test(n)));
  // with a result recorded it is done
  assert.equal(plan({ state: 'MERGED', record: record({ step: 'ended', outcome: 'merged' }), events: [{ kind: 'rollback-intent' }, { kind: 'rollback-result' }] }).enter, 'ended');
  // no record at all but an open rollback: still observe
  assert.equal(plan({ state: 'MERGED', recordStatus: 'absent', record: null, events: [{ kind: 'rollback-intent' }] }).enter, 'observe-prod');
});

test('a fork PR is not resumable', () => {
  const p = plan({ isCrossRepository: true, local: null });
  assert.equal(p.enter, 'not-resumable');
  assert.equal(p.adopt, false);
  assert.deepEqual(p.worktree, { action: 'none' });
});

test('local-work: a diverged branch or a dirty worktree stops everything', () => {
  const diverged = plan({ local: local({ state: 'diverged', unpushed: 2 }) });
  assert.equal(diverged.enter, 'local-work');
  assert.match(diverged.reason, /diverged/);
  assert.deepEqual(diverged.worktree, { action: 'none' });
  const dirty = plan({ local: local({ dirty: 3, worktrees: [{ path: '/w/x', dirty: 3 }] }) });
  assert.equal(dirty.enter, 'local-work');
  assert.match(dirty.reason, /\/w\/x/);
  // dirty beats needs-human: the local work is surfaced first
  assert.equal(plan({ labels: ['needs-human'], local: local({ dirty: 1 }) }).enter, 'local-work');
});

const LABEL_NOTE = 'needs-human label present: the run continues but ends at the owner (no merge)';

test('decision: needs-human shows the first sentence of our reason and does nothing', () => {
  // fixture: the run ended at needs-human (a mid-run record no longer short-circuits, see below)
  const ended = record({ step: 'ended', outcome: 'needs-human' });
  const p = plan({ labels: ['needs-human'], record: ended, needsHumanReason: 'The change touches auth. A second sentence follows.' });
  assert.equal(p.enter, 'decision');
  assert.equal(p.reason, 'The change touches auth.');
  assert.deepEqual(p.worktree, { action: 'none' });
  assert.equal(plan({ labels: ['needs-human'], record: ended }).reason, 'needs-human label set (no reason recorded)');
});

test('decision: needs-human with any other ended outcome is still the owner\'s', () => {
  assert.equal(plan({ labels: ['needs-human'], record: record({ step: 'ended', outcome: 'blocked' }) }).enter, 'decision');
});

test('decision: needs-human with no usable record cannot tell, so it stays the owner\'s', () => {
  for (const recordStatus of ['absent', 'legacy', 'invalid', 'unsupported', 'mismatch']) {
    const p = plan({ labels: ['needs-human'], recordStatus, record: null });
    assert.equal(p.enter, 'decision', recordStatus);
  }
});

test('needs-human on a mid-run record (outcome null) does not stop the resume: it routes normally', () => {
  // review not yet clean => review, with the label note
  const review = plan({ labels: ['needs-human'], record: record({ step: 'pr' }), triage: cleanTriage({ clean: false }) });
  assert.equal(review.enter, 'review');
  assert.ok(review.notes.includes(LABEL_NOTE));
  // never reviewed
  assert.equal(plan({ labels: ['needs-human'], record: record({ step: 'pr' }), triage: null }).enter, 'review');
  // tasks left => build
  const tasks = [{ id: '1', title: 'one', spec: 's', done: false }];
  const build = plan({ labels: ['needs-human'], record: record({ step: 'build', tasks }) });
  assert.equal(build.enter, 'build');
  assert.ok(build.notes.includes(LABEL_NOTE));
  // followups
  assert.equal(plan({ labels: ['needs-human'], triage: cleanTriage({ followupsPending: true }) }).enter, 'followups');
});

test('needs-human on a mid-run record, review clean => gate, and the notes say Step 5 ends in needs-human', () => {
  const p = plan({ labels: ['needs-human'], record: record({ step: 'review' }) });
  assert.equal(p.enter, 'gate');
  assert.ok(p.notes.includes(LABEL_NOTE));
  assert.ok(p.notes.some((n) => /Step 5 ends in needs-human/.test(n) && /no owner-merge stop/.test(n)));
  // without the label there is neither note
  const plain = plan({});
  assert.equal(plain.enter, 'gate');
  assert.ok(!plain.notes.some((n) => /needs-human/.test(n)));
});

test('build: tasks left to do', () => {
  const tasks = [{ id: '1', title: 'one', spec: 's', done: true }, { id: '2', title: 'two', spec: 's', done: false }];
  const p = plan({ record: record({ step: 'build', tasks }) });
  assert.equal(p.enter, 'build');
  assert.match(p.reason, /1 of 2 tasks not done.*two/);
  assert.equal(p.adopt, false);
});

test('verify: reached build/verify with no passing verify for the live head', () => {
  assert.equal(plan({ record: record({ step: 'verify', verify: null }) }).enter, 'verify');
  assert.equal(plan({ record: record({ step: 'build', verify: { head: 'b'.repeat(40), ok: true } }) }).enter, 'verify');
  const failed = plan({ record: record({ step: 'verify', verify: { head: HEAD, ok: false, failedStep: 'unit' } }) });
  assert.equal(failed.enter, 'verify');
  assert.match(failed.reason, /failed.*unit/);
  assert.equal(plan({ record: record({ step: 'ended', outcome: 'blocked', verify: { head: HEAD, ok: false } }) }).enter, 'verify');
  // verified for this head: on to the review route
  assert.equal(plan({ record: record({ step: 'verify' }), triage: null }).enter, 'review');
  // an abbreviated recorded head still matches
  assert.equal(plan({ record: record({ step: 'verify', verify: { head: HEAD.slice(0, 10), ok: true } }), triage: null }).enter, 'review');
  // a later step does not re-verify just because the head moved: the review/gate route decides
  assert.equal(plan({ record: record({ step: 'gate', verify: { head: 'b'.repeat(40), ok: true } }) }).enter, 'gate');
});

test('review: no triage state, an incomplete round, changed content, or a round that is not clean', () => {
  assert.equal(plan({ triage: null }).enter, 'review');
  assert.equal(plan({ triage: cleanTriage({ lastRoundComplete: false }) }).enter, 'review');
  const changed = plan({ contentHash: 'x'.repeat(64) });
  assert.equal(changed.enter, 'review');
  assert.match(changed.reason, /content changed/);
  assert.equal(plan({ triage: cleanTriage({ clean: false }) }).enter, 'review');
  // the awaiting-review label (Codex was down) is a review, even over a clean-looking state
  assert.equal(plan({ labels: ['awaiting-review'] }).enter, 'review');
  assert.equal(plan({ record: record({ step: 'ended', outcome: 'awaiting-review' }) }).enter, 'review');
  // unknown live hash does not force a review by itself, but is noted
  assert.equal(plan({ contentHash: null }).enter, 'gate');
  // a not-clean round with follow-ups pending still reviews first
  assert.equal(plan({ triage: cleanTriage({ clean: false, followupsPending: true }) }).enter, 'review');
});

test('followups: a clean published round whose follow-ups have no issue', () => {
  const p = plan({ triage: cleanTriage({ followupsPending: true }) });
  assert.equal(p.enter, 'followups');
  assert.equal(p.adopt, false);
});

test('gate: every other open reviewed PR; resume itself never merges', () => {
  const p = plan({});
  assert.equal(p.enter, 'gate');
  assert.match(p.reason, /owner's "merge"/);
  const awaitingOwner = plan({ record: record({ step: 'awaiting-owner-merge', outcome: 'awaiting-owner-merge' }) });
  assert.equal(awaitingOwner.enter, 'gate', 'an owner-merge record is re-gated, never trusted as approval');
});

// ---- adopt -----------------------------------------------------------------------------------

test('adopt: no run record routes to review without a review state, and keeps a valid published state', () => {
  for (const recordStatus of ['absent', 'legacy']) {
    const p = plan({ recordStatus, record: null, triage: null });
    assert.equal(p.enter, 'review', recordStatus);
    assert.equal(p.adopt, true, recordStatus);
  }
  const withTriage = plan({ recordStatus: 'absent', record: null });
  assert.equal(withTriage.enter, 'gate', 'a clean published state is "no run record" but not "no review state"');
  assert.equal(withTriage.adopt, true);
  assert.ok(withTriage.notes.some((n) => /published review state/.test(n)));
  assert.equal(plan({ recordStatus: 'absent', record: null, triage: cleanTriage({ followupsPending: true }) }).enter, 'followups');
  assert.equal(plan({ recordStatus: 'absent', record: null, triage: cleanTriage({ clean: false }) }).enter, 'review');
  assert.ok(plan({ recordStatus: 'legacy', record: null, triage: null }).notes.some((n) => /legacy summary/.test(n)));
  // an unusable record is treated as none
  for (const recordStatus of ['invalid', 'unsupported', 'mismatch']) assert.equal(plan({ recordStatus, record: null, triage: null }).adopt, true, recordStatus);
  assert.equal(plan({}).adopt, false);
});

// ---- worktree --------------------------------------------------------------------------------

test('worktree: reuse a worktree that holds the branch; behind => ff-only, ahead => push', () => {
  const held = [{ path: '/w/agent-x', dirty: 0 }];
  assert.deepEqual(plan({ local: local({ worktrees: held }) }).worktree, { action: 'reuse', path: '/w/agent-x' });
  assert.deepEqual(plan({ local: local({ state: 'behind', worktrees: held }) }).worktree, { action: 'reuse', path: '/w/agent-x', then: 'ff-only' });
  const ahead = plan({ local: local({ state: 'ahead', unpushed: 2, worktrees: held }) });
  assert.deepEqual(ahead.worktree, { action: 'reuse', path: '/w/agent-x', then: 'push' });
  assert.ok(ahead.notes.some((n) => /2 commits exist only on this machine/.test(n)));
});

test('worktree: an existing local ref without a worktree is checked out, never reset', () => {
  assert.deepEqual(plan({ local: local() }).worktree, { action: 'add-existing-ref' });
  assert.deepEqual(plan({ local: local({ state: 'behind' }) }).worktree, { action: 'add-existing-ref', then: 'ff-only' });
  assert.deepEqual(plan({ local: local({ state: 'ahead', unpushed: 1 }) }).worktree, { action: 'add-existing-ref', then: 'push' });
});

test('worktree: no local ref at all is made from the remote branch', () => {
  assert.deepEqual(plan({ local: local({ state: 'none', localRef: null }) }).worktree, { action: 'add-from-remote' });
  const unknownLocal = plan({ local: null });
  assert.deepEqual(unknownLocal.worktree, { action: 'add-from-remote' });
  assert.ok(unknownLocal.notes.some((n) => /local branch state unavailable/.test(n)));
  const unknown = plan({ local: local({ state: 'unknown' }) });
  assert.deepEqual(unknown.worktree, { action: 'add-existing-ref' });
  assert.ok(unknown.notes.some((n) => /git fetch origin/.test(n)));
});

// ---- confirm ---------------------------------------------------------------------------------

test('confirm: a fresh heartbeat from another host asks the owner first', () => {
  const p = plan({ record: record({ heartbeat: { host: 'mac', at: ago(30) } }) });
  assert.deepEqual(p.confirm, { host: 'mac', step: 'review', minutesAgo: 30, why: 'the last heartbeat came from another machine 30 min ago' });
});

test('confirm: the same host, a stale heartbeat, or a heartbeat at the window edge does not', () => {
  assert.equal(plan({ record: record({ heartbeat: { host: 'pc', at: ago(5) } }) }).confirm, null, 'same host');
  assert.equal(plan({ record: record({ heartbeat: { host: 'mac', at: ago(91) } }) }).confirm, null, 'stale');
  assert.equal(plan({ record: record({ heartbeat: { host: 'mac', at: ago(90) } }) }).confirm, null, 'exactly the window is not younger than it');
  assert.notEqual(plan({ record: record({ heartbeat: { host: 'mac', at: ago(89) } }) }).confirm, null);
  assert.equal(plan({ record: record({ heartbeat: { host: 'mac', at: 'garbage' } }) }).confirm, null, 'an unreadable heartbeat proves nothing');
  assert.equal(plan({ record: record({ heartbeat: null }) }).confirm, null);
  assert.notEqual(plan({ record: record({ heartbeat: { host: 'mac', at: ago(100) } }) }, { heartbeatFreshMinutes: 120 }).confirm, null, 'the window is configurable');
});

test('confirm: a command in flight within its budget asks, on any host; an expired one does not', () => {
  const same = plan({ record: record({ inFlight: { kind: 'prod-watch', host: 'pc', startedAt: ago(10), maxMinutes: 60 } }) });
  assert.equal(same.confirm.host, 'pc');
  assert.equal(same.confirm.minutesAgo, 10);
  assert.match(same.confirm.why, /prod-watch/);
  const other = plan({ record: record({ inFlight: { kind: 'update-branch', host: 'mac', startedAt: ago(5), maxMinutes: 30 } }) });
  assert.equal(other.confirm.host, 'mac');
  assert.equal(plan({ record: record({ inFlight: { kind: 'update-branch', host: 'mac', startedAt: ago(31), maxMinutes: 30 } }) }).confirm, null, 'expired');
  // inFlight wins over a heartbeat when both apply
  const both = plan({ record: record({ heartbeat: { host: 'mac', at: ago(1) }, inFlight: { kind: 'merge', host: 'mac', startedAt: ago(2), maxMinutes: 45 } }) });
  assert.match(both.confirm.why, /merge command/);
});

test('confirm: report-only routes never ask', () => {
  const hb = record({ heartbeat: { host: 'mac', at: ago(1) } });
  assert.equal(plan({ state: 'CLOSED', record: hb }).confirm, null);
  assert.equal(plan({ state: 'MERGED', record: { ...hb, step: 'ended', outcome: 'merged' } }).confirm, null);
  assert.equal(plan({ labels: ['needs-human'], record: { ...hb, step: 'ended', outcome: 'needs-human' } }).confirm, null);
  assert.notEqual(plan({ state: 'MERGED', record: { ...hb, step: 'prod-watch' } }).confirm, null, 'observing production is real work');
});

// ---- auto-merge ------------------------------------------------------------------------------

test('autoMerge: armed with no live merge is disarmed; a live in-flight merge keeps it', () => {
  assert.deepEqual(plan({ autoMergeArmed: true }).autoMerge, { armed: true, action: 'disarm' });
  assert.equal(plan({ autoMergeArmed: false }).autoMerge, null);
  const live = plan({ autoMergeArmed: true, record: record({ inFlight: { kind: 'merge', host: 'mac', startedAt: ago(3), maxMinutes: 75 } }) });
  assert.equal(live.autoMerge, null);
  assert.notEqual(live.confirm, null);
  // an expired merge is not live
  assert.deepEqual(plan({ autoMergeArmed: true, record: record({ inFlight: { kind: 'merge', host: 'mac', startedAt: ago(100), maxMinutes: 75 } }) }).autoMerge, { armed: true, action: 'disarm' });
  // a different in-flight command does not own the auto-merge
  assert.deepEqual(plan({ autoMergeArmed: true, record: record({ inFlight: { kind: 'prod-watch', host: 'mac', startedAt: ago(3), maxMinutes: 75 } }) }).autoMerge, { armed: true, action: 'disarm' });
  // no record: still disarmed
  assert.deepEqual(plan({ autoMergeArmed: true, recordStatus: 'absent', record: null }).autoMerge, { armed: true, action: 'disarm' });
  // a merged or closed PR has nothing to disarm
  assert.equal(plan({ state: 'MERGED', autoMergeArmed: true }).autoMerge, null);
});

test('the plan always has the full shape', () => {
  const p = plan({});
  assert.deepEqual(Object.keys(p).sort(), ['adopt', 'autoMerge', 'confirm', 'enter', 'notes', 'reason', 'worktree']);
  assert.ok(Array.isArray(p.notes));
});
