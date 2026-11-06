// `P merge --owner-go` merge-carry loop (lib/owner-go-carry-loop.mjs): the owner's "merge" for H0, given with the Carry line, survives updates that only merge main in.
// In process, against a stateful fake GitHub over a REAL bare origin (test/helpers/carry-world.mjs): real fetch, real fast-forward, real proof.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ownerSays } from './helpers/owner-go.mjs';
import { carryWorld, sh } from './helpers/carry-world.mjs';
import { MERGE_JOB_MARKER } from '../pipeline/lib/merge-job.mjs';
import { runCarryLoop } from '../pipeline/lib/owner-go-carry-loop.mjs';
import { addRound, emptyState, saveState } from '../pipeline/lib/state.mjs';
import { run as mergeRun } from '../pipeline/commands/merge.mjs';
import { PR, reviewState } from './helpers/gate-env.mjs';
import { answer, blocker, holdFiles, holdYml, seq } from './helpers/merge-hold-env.mjs';

const world = (t, opts) => { const w = carryWorld(opts); t.after(() => w.cleanup()); return w; };
const go = (t, w, opts) => ownerSays(t, 'merge', w.request(opts));
const text = (r) => JSON.stringify(r.output);
const localHead = (w) => sh(w.root, 'rev-parse', 'HEAD');

test('as-is: a PR that is not behind merges exactly as before and is never updated; no carried field', async (t) => {
  const w = world(t);
  go(t, w);
  const r = await w.merge();
  assert.equal(r.exitCode, 0, text(r));
  assert.equal(r.output.merged, true);
  assert.equal(r.output.carried, undefined);
  assert.equal(w.updates, 0);
  assert.match(w.mergeCalls()[0], new RegExp(`--match-head-commit ${w.h0}`));
});

test('behind + a record WITHOUT the Carry line: today\'s behind-base refusal plus the hint; nothing is updated or merged', async (t) => {
  const w = world(t);
  w.mainMoves();
  go(t, w, { carry: false });
  const r = await w.merge();
  assert.equal(r.exitCode, 1);
  assert.equal(r.output.error, 'live-check');
  assert.match(r.output.reasons.join('\n'), /behind-base: GitHub reports the PR is BEHIND/);
  assert.match(r.output.reasons.join('\n'), /Carry: also covers main-only updates/);
  assert.equal(w.updates, 0);
  assert.deepEqual(w.mergeCalls(), []);
});

test('behind + a Carry record: update, proof, fast-forward, review refresh, CI, final, merged with --match-head-commit H1 and a carried summary', async (t) => {
  const w = world(t);
  w.mainMoves();
  go(t, w);
  const r = await w.merge();
  assert.equal(r.exitCode, 0, text(r));
  const h1 = w.head();
  assert.notEqual(h1, w.h0);
  assert.equal(r.output.merged, true);
  assert.equal(r.output.head, h1);
  assert.deepEqual(r.output.carried, { from: w.h0, to: h1, cycles: 1, updates: 1 });
  assert.match(w.mergeCalls()[0], new RegExp(`--match-head-commit ${h1}`));
  assert.equal(localHead(w), h1, 'the checkout was advanced to the new head');
  assert.deepEqual(w.refreshed, [h1]);
  assert.equal(w.updates, 1);
  assert.equal(existsSync(join(w.root, MERGE_JOB_MARKER)), false, 'the checkout marker is released');
});

test('an update GitHub did not make (merge not signed by GitHub) is refused by the proof: terminal, the go is void, no merge', async (t) => {
  const w = world(t);
  w.foreignMerge = true;
  w.mainMoves();
  go(t, w);
  const r = await w.merge();
  assert.equal(r.exitCode, 1);
  assert.equal(r.output.error, 'carry-proof');
  assert.equal(r.output.goVoid, true);
  assert.match(r.output.reasons.join(), /not made by GitHub/);
  assert.deepEqual(w.mergeCalls(), []);
  assert.equal(localHead(w), w.h0, 'the checkout was not advanced');
});

test('an external push during the update (GitHub refuses, head moved) is terminal when the proof refuses the ordinary commit', async (t) => {
  const w = world(t);
  w.mainMoves();
  w.hooks.beforeUpdate = () => w.externalPush();
  go(t, w);
  const r = await w.merge();
  assert.equal(r.exitCode, 1);
  assert.equal(r.output.error, 'carry-proof');
  assert.match(r.output.reasons.join(), /ordinary commit/);
  assert.equal(w.updates, 0);
  assert.deepEqual(w.mergeCalls(), []);
});

test('main advanced between the compare and the update: GitHub merged a newer base (head-moved), the complete proof passes and the head is accepted', async (t) => {
  const w = world(t);
  w.mainMoves();
  w.hooks.beforeUpdate = () => w.mainMoves();
  go(t, w);
  const r = await w.merge();
  assert.equal(r.exitCode, 0, text(r));
  assert.equal(r.output.carried.to, w.head());
  assert.equal(r.output.carried.updates, 1);
  assert.match(w.mergeCalls()[0], new RegExp(`--match-head-commit ${w.head()}`));
});

test('main moves during the CI wait: the final phase sees the PR behind again and a second cycle updates and merges', async (t) => {
  const w = world(t);
  w.mainMoves();
  w.hooks.ci = () => w.mainMoves();
  go(t, w);
  const r = await w.merge();
  assert.equal(r.exitCode, 0, text(r));
  assert.deepEqual(r.output.carried, { from: w.h0, to: w.head(), cycles: 2, updates: 2 });
  assert.equal(w.updates, 2);
  assert.equal(w.mergeCalls().length, 1);
});

test('main keeps moving: three cycles then a terminal cycle-cap refusal (the go still stands), no merge command', async (t) => {
  const w = world(t);
  w.mainMoves();
  const keepMoving = () => { w.mainMoves(); w.hooks.ci = keepMoving; };
  w.hooks.ci = keepMoving;
  go(t, w);
  const r = await w.merge();
  assert.equal(r.exitCode, 1);
  assert.equal(r.output.error, 'carry-cycle-cap');
  assert.equal(r.output.goVoid, false);
  assert.equal(w.updates, 3);
  assert.deepEqual(w.mergeCalls(), []);
});

test('C10: the merge command armed auto-merge, the base moved and disarming fails: terminal, zero further updates', async (t) => {
  const w = world(t);
  w.mainMoves();
  w.mergeResult = 'arm';
  w.hooks.afterMerge = () => w.mainMoves();
  go(t, w);
  const r = await w.merge({ disableAuto: () => false });
  assert.equal(r.exitCode, 1);
  assert.equal(r.output.error, 'carry-disarm');
  assert.equal(w.updates, 1, 'no update after the merge command ran');
  assert.equal(w.mergeCalls().length, 1);
});

test('C10: when the disarm is confirmed (PR open, nothing queued) the base-moved failure retries: second cycle merges', async (t) => {
  const w = world(t);
  w.mainMoves();
  w.mergeResult = ['arm', 'merged'];
  w.hooks.afterMerge = () => w.mainMoves();
  go(t, w);
  const r = await w.merge({ disableAuto: () => { w.disarmed = true; return true; } });
  assert.equal(r.exitCode, 0, text(r));
  assert.equal(r.output.carried.cycles, 2);
  assert.equal(w.mergeCalls().length, 2);
  assert.equal(w.updates, 2);
});

test('a needs-human label appearing after a base-moved retry is terminal before the next update (a held PR never carries)', async (t) => {
  const w = world(t);
  w.mainMoves();
  w.mergeResult = ['arm', 'merged'];
  w.hooks.afterMerge = () => w.mainMoves();
  go(t, w);
  const r = await w.merge({ disableAuto: () => { w.disarmed = true; w.labels.push('needs-human'); return true; } });
  assert.equal(r.exitCode, 1);
  assert.equal(r.output.error, 'carry-hold');
  assert.equal(r.output.goVoid, true);
  assert.equal(w.updates, 1, 'no second update');
  assert.equal(w.mergeCalls().length, 1);
});

test('a needs-human label that appears during the CI wait is caught by the final scan: terminal, nothing merged', async (t) => {
  const w = world(t);
  w.mainMoves();
  w.hooks.ci = () => w.labels.push('needs-human');
  go(t, w);
  const r = await w.merge();
  assert.equal(r.exitCode, 1);
  assert.match(r.output.reasons.join('\n'), /labels:/);
  assert.deepEqual(w.mergeCalls(), []);
});

test('a PR that carries a needs-human label from the start never enters the loop (today\'s refusal, no update)', async (t) => {
  const w = world(t);
  w.mainMoves();
  w.labels.push('needs-human');
  go(t, w);
  const r = await w.merge();
  assert.equal(r.exitCode, 1);
  assert.equal(r.output.error, 'live-check');
  assert.equal(w.updates, 0);
});

test('the checkout: dirty at the start is terminal (nothing updated); a branch switch during the job is terminal at the final phase', async (t) => {
  const dirty = world(t);
  dirty.mainMoves();
  writeFileSync(join(dirty.root, 'scratch.txt'), 'x');
  go(t, dirty);
  const a = await dirty.merge();
  assert.equal(a.output.error, 'carry-checkout');
  assert.equal(dirty.updates, 0);

  const switched = world(t);
  switched.mainMoves();
  go(t, switched);
  const b = await switched.merge({ refreshReview: async () => { sh(switched.root, 'checkout', '-q', '-b', 'elsewhere'); return { ok: true, kind: 'not-applicable' }; } });
  assert.equal(b.output.error, 'carry-checkout');
  assert.deepEqual(switched.mergeCalls(), []);
});

test('C1: a review state written (unpublished) during the CI wait makes the final review-completion check refuse', async (t) => {
  const w = world(t);
  w.mainMoves();
  w.hooks.ci = () => saveState(w.root, reviewState('a'.repeat(64)));
  go(t, w);
  const r = await w.merge();
  assert.equal(r.exitCode, 1);
  assert.match(r.output.reasons.join('\n'), /review-complete/);
  assert.deepEqual(w.mergeCalls(), []);
});

test('F2: a PR whose base is not the default branch never gets an update', async (t) => {
  const w = world(t);
  w.mainMoves();
  go(t, w);
  const gh = { ...w.gh, repo: () => ({ ...w.gh.repo(), defaultBranch: 'trunk' }) };
  const r = await w.merge({ gh });
  assert.equal(r.exitCode, 1);
  assert.equal(w.updates, 0);
});

test('a dead earlier job left a marker and armed auto-merge: it is disarmed first, then the job carries on', async (t) => {
  const w = world(t);
  w.mainMoves();
  go(t, w);
  mkdirSync(join(w.root, '.review'), { recursive: true });
  writeFileSync(join(w.root, '.review', 'merge-job.json'), JSON.stringify({ pr: 12, pid: 2 ** 22 + 12345, branch: 'agent/feature', expectedHead: w.h0, startedAt: '2026-11-06T00:00:00.000Z' }));
  let disarmed = 0;
  const armed = { v: true };
  const gh = { ...w.gh, prView: (n, f) => { const v = w.gh.prView(n, f); return f.includes('autoMergeRequest') && armed.v && !w.mergeRan() ? { ...v, autoMergeRequest: { enabledAt: 'x' } } : v; } };
  const r = await w.merge({ gh, disableAuto: () => { disarmed += 1; armed.v = false; return true; } });
  assert.equal(r.exitCode, 0, text(r));
  assert.equal(disarmed, 1);
});

test('conservative: behind AND a red check on H0 is not "behind only" - today\'s refusal, no update, even with a Carry record', async (t) => {
  const w = world(t);
  w.mainMoves();
  w.ci[w.h0] = 'fail';
  go(t, w);
  const r = await w.merge();
  assert.equal(r.exitCode, 1);
  assert.equal(r.output.error, 'live-check');
  assert.match(r.output.reasons.join('\n'), /ci:/);
  assert.equal(w.updates, 0);
});

test('X1: main adds a protected-path rule that covers the PR: the rules are reloaded at the new head, the owner items change, the go is void and nothing merges', async (t) => {
  const w = world(t);
  const yml = readFileSync(join(w.root, '.claude', 'pipeline.yml'), 'utf8');
  w.mainMoves({ '.claude/pipeline.yml': `${yml}hard_stops:\n  paths: ['src/**']\n` });
  go(t, w);
  const r = await w.merge();
  assert.equal(r.exitCode, 1);
  assert.equal(r.output.error, 'owner-go');
  assert.equal(r.output.goVoid, true);
  assert.equal(w.updates, 1);
  assert.deepEqual(w.mergeCalls(), []);
});

test('N3/C7: a merge hold that appears before the update is terminal (queued-behind), nothing is updated', async (t) => {
  const w = world(t, { yml: holdYml(), baseFiles: holdFiles });
  w.env.FAKE_HOLD_CHECK_SEQ = seq(answer(PR), answer(PR, [blocker()]));
  w.mainMoves();
  go(t, w);
  const r = await w.merge();
  assert.equal(r.exitCode, 1);
  assert.equal(r.output.error, 'queued-behind');
  assert.equal(r.output.doNotUpdate, true);
  assert.equal(w.updates, 0);
  assert.deepEqual(w.mergeCalls(), []);
});

// ---- review round 1 (R1-B1): the dead job's marker is reconciled at the top of the --owner-go route, whatever the outcome of the evaluation ----
const writeJobMarker = (w, pid, pr = 12) => {
  mkdirSync(join(w.root, '.review'), { recursive: true });
  writeFileSync(join(w.root, '.review', 'merge-job.json'), JSON.stringify({ pr, pid, branch: 'agent/feature', expectedHead: w.h0, startedAt: '2026-11-06T00:00:00.000Z' }));
};
const DEAD_PID = 2 ** 22 + 12345;
const armedGh = (w, armed) => ({ ...w.gh, prView: (n, f) => { const v = w.gh.prView(n, f); return f.includes('autoMergeRequest') && armed.v ? { ...v, autoMergeRequest: { enabledAt: 'x' } } : v; } });

test('R1-B1: a dead job left auto-merge armed and the PR now carries a blocking label: auto-merge is disarmed and the marker removed BEFORE the refusal (the loop is never entered)', async (t) => {
  const w = world(t);
  go(t, w);
  w.labels.push('pipeline-blocked');
  writeJobMarker(w, DEAD_PID);
  const armed = { v: true };
  let disarmed = 0;
  const r = await w.merge({ gh: armedGh(w, armed), disableAuto: () => { disarmed += 1; armed.v = false; return true; } });
  assert.equal(disarmed, 1, 'the armed auto-merge was disabled');
  assert.equal(r.exitCode, 1);
  assert.equal(r.output.error, 'live-check');
  assert.equal(w.updates, 0);
  assert.deepEqual(w.mergeCalls(), []);
  assert.equal(existsSync(join(w.root, MERGE_JOB_MARKER)), false, 'the stale marker is gone');
});

test('R1-B1: a dead job whose PR is MERGED: the route reports it merged and runs nothing', async (t) => {
  const w = world(t);
  go(t, w);
  writeJobMarker(w, DEAD_PID);
  const gh = { ...w.gh, prView: (n, f) => (f.includes('mergeCommit') ? { state: 'MERGED', mergeCommit: { oid: 'c'.repeat(40) }, autoMergeRequest: null } : w.gh.prView(n, f)) };
  const r = await w.merge({ gh });
  assert.equal(r.exitCode, 0, text(r));
  assert.equal(r.output.merged, true);
  assert.equal(r.output.mergeSha, 'c'.repeat(40));
  assert.deepEqual(w.mergeCalls(), []);
});

test('R1-B1: a dead job\'s auto-merge that cannot be confirmed off refuses the whole run, even one that would not enter the loop', async (t) => {
  const w = world(t);
  go(t, w);
  w.labels.push('pipeline-blocked');
  writeJobMarker(w, DEAD_PID);
  const r = await w.merge({ gh: armedGh(w, { v: true }), disableAuto: () => false });
  assert.equal(r.exitCode, 1);
  assert.equal(r.output.error, 'carry-disarm');
  assert.match(r.output.reasons.join(), /auto-merge/);
  assert.deepEqual(w.mergeCalls(), []);
});

test('R1-B1: a LIVE marker of another process refuses busy before any evaluation; a dead marker of another PR is left alone', async (t) => {
  const live = world(t);
  go(t, live);
  writeJobMarker(live, process.ppid);
  const a = await live.merge();
  assert.equal(a.exitCode, 1);
  assert.equal(a.output.error, 'carry-checkout');
  assert.match(a.output.reasons.join(), /already owns this checkout/);
  assert.deepEqual(live.mergeCalls(), []);

  const other = world(t);
  go(t, other);
  writeJobMarker(other, DEAD_PID, 99);
  const b = await other.merge();
  assert.equal(b.exitCode, 0, text(b));
});

test('R1-B1: the dry run reports a dead job marker for this PR as a blocker, read-only (nothing disarmed, marker kept)', async (t) => {
  const w = world(t);
  writeJobMarker(w, DEAD_PID);
  let disarmed = 0;
  const r = await mergeRun(['--pr', String(PR), '--owner-go', '--dry-run', '--repo', w.root], { cwd: w.root, env: w.env, carry: { gh: w.gh, home: w.home, disableAuto: () => { disarmed += 1; return true; } } });
  assert.equal(r.output.wouldMerge, false);
  assert.ok(r.output.blockers.some((b) => b.kind === 'merge-job-dead'), text(r));
  assert.equal(disarmed, 0);
  assert.equal(existsSync(join(w.root, MERGE_JOB_MARKER)), true);
});

// ---- review round 1 (R1-F2): label mode never carries, whatever the record says ----
test('R1-F2: under owner_approval: label a Carry record is ignored: today\'s behind-base refusal, no Carry hint, nothing updated', async (t) => {
  const w = world(t, { ownerApproval: 'label' });
  w.mainMoves();
  go(t, w);
  const r = await w.merge();
  assert.equal(r.exitCode, 1);
  assert.equal(r.output.error, 'live-check');
  assert.match(r.output.reasons.join('\n'), /behind-base: GitHub reports the PR is BEHIND/);
  assert.doesNotMatch(r.output.reasons.join('\n'), /Carry/);
  assert.equal(w.updates, 0);
  assert.deepEqual(w.mergeCalls(), []);
});

// ---- review round 1 (R1-F1): the claim is bound to the head the as-is evaluation saw and to the PR's own branch ----
const loopArgs = (w, over = {}) => ({
  root: w.root, config: {}, pr: PR, gh: w.gh, ctx: { env: w.env, carry: { log: () => {} } }, head: w.h0, prefix: w.h0.slice(0, 16),
  refuse: (code, reasons, extra) => ({ exitCode: 1, output: { error: code, reasons, ...extra } }),
  holdRefuse: (held) => ({ exitCode: 1, output: { error: 'hold', held } }),
  final: async () => { throw new Error('final must not be reached'); }, ...over,
});

test('R1-F1: the checkout holds another head than the one the as-is evaluation saw: carry-checkout, the go stands, nothing updated, marker released', async (t) => {
  const w = world(t);
  w.mainMoves();
  const r = await runCarryLoop(loopArgs(w, { head: 'f'.repeat(40) }));
  assert.equal(r.output.error, 'carry-checkout');
  assert.equal(r.output.goVoid, false);
  assert.equal(w.updates, 0);
  assert.equal(existsSync(join(w.root, MERGE_JOB_MARKER)), false);
});

test('R1-F1: the checked-out branch is not the PR\'s head branch: carry-checkout, nothing updated', async (t) => {
  const w = world(t);
  w.mainMoves();
  sh(w.root, 'branch', '-m', 'agent/renamed');
  const r = await runCarryLoop(loopArgs(w));
  assert.equal(r.output.error, 'carry-checkout');
  assert.match(r.output.reasons.join(), /agent\/renamed/);
  assert.equal(w.updates, 0);
  assert.equal(existsSync(join(w.root, MERGE_JOB_MARKER)), false);
});

// ---- review round 1 (R1-B2): an interrupted review refresh (base-only round recorded locally, review-complete failed) can be resumed ----
const rcFailed = { ok: false, code: 'review-complete-failed', reason: 'GitHub said no', command: 'review-complete', exitCode: 1 };
const baseOnlyState = (w, { counted = false } = {}) => {
  let s = emptyState({ repo: w.slug, pr: PR, branch: 'agent/feature', risk: 'low', maxRounds: 2 });
  s.currentContentHash = 'a'.repeat(64);
  s = addRound(s, { n: 1, fromHead: 'a', toHead: counted ? 'b' : 'c', contentHashAtToHead: 'a'.repeat(64), items: [] });
  if (!counted) s = addRound(s, { n: 2, fromHead: 'c', toHead: w.h0, contentHashAtToHead: 'a'.repeat(64), items: [], baseOnly: true });
  return s;
};

test('R1-B2: review-complete failing once inside the loop is retried once (the second call takes the review-complete-only branch) and the merge carries on', async (t) => {
  const w = world(t);
  w.mainMoves();
  go(t, w);
  const calls = [];
  const r = await w.merge({ refreshReview: async ({ head }) => { calls.push(head); return calls.length === 1 ? rcFailed : { ok: true, kind: 'review-complete' }; } });
  assert.equal(r.exitCode, 0, text(r));
  assert.equal(calls.length, 2);
  assert.equal(calls[0], calls[1], 'the retry is for the same head');
  assert.equal(calls[0], w.head());
});

test('R1-B2: review-complete failing twice stops the loop, and the message names the manual recovery', async (t) => {
  const w = world(t);
  w.mainMoves();
  go(t, w);
  let n = 0;
  const r = await w.merge({ refreshReview: async () => { n += 1; return rcFailed; } });
  assert.equal(r.exitCode, 1);
  assert.equal(n, 2, 'one retry, no more');
  assert.match(r.output.reasons.join(), /P review-complete --pr 12/);
  assert.deepEqual(w.mergeCalls(), []);
});

test('R1-B2: a retry of --owner-go whose only failing check is review-complete, with a base-only round already recorded for this head, finishes the review first and then merges', async (t) => {
  const w = world(t);
  go(t, w);
  saveState(w.root, baseOnlyState(w));
  const calls = [];
  const r = await w.merge({ refreshReview: async ({ head }) => { calls.push(head); rmSync(join(w.root, '.review', ['state', 'json'].join('.'))); return { ok: true, kind: 'review-complete' }; } });
  assert.deepEqual(calls, [w.h0]);
  assert.equal(r.exitCode, 0, text(r));
  assert.equal(r.output.merged, true);
});

test('R1-B2: the route does not resume a review whose last round is not a base-only round at this head: today\'s review-complete refusal', async (t) => {
  const w = world(t);
  go(t, w);
  saveState(w.root, baseOnlyState(w, { counted: true })); // the last round ends at 'b', a counted round
  let called = 0;
  const r = await w.merge({ refreshReview: async () => { called += 1; return { ok: true, kind: 'review-complete' }; } });
  assert.equal(called, 0);
  assert.equal(r.exitCode, 1);
  assert.match(r.output.reasons.join('\n'), /review-complete/);
});

test('R1-B2: a resume whose review-complete fails again refuses with the manual recovery named; nothing merges', async (t) => {
  const w = world(t);
  go(t, w);
  saveState(w.root, baseOnlyState(w));
  const r = await w.merge({ refreshReview: async () => rcFailed });
  assert.equal(r.exitCode, 1);
  assert.match(r.output.reasons.join(), /P review-complete --pr 12/);
  assert.deepEqual(w.mergeCalls(), []);
});
