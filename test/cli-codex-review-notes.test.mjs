// #445: say where the effort and the model come from. codex-review reads each review.effort lane as the HIGHER of the working tree's and the default branch's fork point (or the built-in lane),
// and review.codex_model from the fork point alone; when the working tree's own value would have given something else the output says which source won (effortNote, modelNote).
// The real CLI against a throwaway repo with a fake gh and a scripted fake Codex.
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { roundWorld, findingsOf } from './helpers/round-world.mjs';
import { assertExit } from './helpers/assert-exit.mjs';
import { DEFAULTS } from '../pipeline/lib/config.mjs';

const lanes = (low) => `  effort: {low: ${low}, medium: medium, high: high, followup: medium, small_fix: low, small_fix_lines: 40}\n`;
const plan = (w) => w.cli(['codex-review', '--pr', '7', '--round', '1', '--base', w.base, '--head', w.head, '--plan']);
const review = (w, effort, extra = []) => w.cli(['codex-review', '--pr', '7', '--round', '1', '--base', w.base, '--head', w.head, '--effort', effort, ...extra], { FAKE_CODEX_OUTPUT: w.file('f.json', findingsOf()) });

test('the working tree lowers a lane the fork point holds higher: --plan and the effort-mismatch say the working tree alone gives the lower one, and why it does not apply (fork-point lane)', (t) => {
  const w = roundWorld(t, { max: 3, review: lanes('high') });
  w.config({ review: lanes('medium') }); // working tree only: the fork point still says low: high
  const p = plan(w);
  assertExit(p, 0, p.stdout + p.stderr);
  assert.equal(p.json.expectedEffort, 'high');
  assert.deepEqual(p.json.plan.effortNote, { workingTree: 'medium', configured: 'high', lane: 'low', from: 'fork-point' });
  const r = review(w, 'medium');
  assertExit(r, 2, r.stdout + r.stderr);
  assert.equal(r.json.error, 'effort-mismatch');
  assert.deepEqual(r.json.effortNote, p.json.plan.effortNote);
  assert.ok(r.json.message.includes("; the working tree's pipeline.yml alone gives medium, but each review.effort lane is the higher of the working tree's and the lane in the pipeline.yml at main's fork point (here high), so a lower lane applies only once it is on main"), r.json.message);
  assert.match(r.json.message, /--effort medium is not the configured effort for round 1: use --effort high/);
  const ok = review(w, 'high');
  assertExit(ok, 0, ok.stdout + ok.stderr);
  assert.deepEqual(ok.json.effortNote, p.json.plan.effortNote, 'a round that runs carries the note too');
});

test('equal lanes: no effortNote anywhere, and the mismatch message is the plain one', (t) => {
  const w = roundWorld(t, { max: 3, review: lanes('high') });
  const p = plan(w);
  assertExit(p, 0, p.stdout + p.stderr);
  assert.equal('effortNote' in p.json.plan, false);
  const r = review(w, 'medium');
  assertExit(r, 2);
  assert.equal(r.json.error, 'effort-mismatch');
  assert.equal(r.json.message.includes('working tree'), false);
  assert.equal('effortNote' in r.json, false);
  // a working tree that RAISES a lane needs no note either: its own value is the one that applies
  w.config({ review: lanes('xhigh') });
  const up = plan(w);
  assertExit(up, 0, up.stdout + up.stderr);
  assert.equal(up.json.expectedEffort, 'xhigh');
  assert.equal('effortNote' in up.json.plan, false);
});

test('an unreadable fork-point config holds the working tree against the built-in lane: the note says so (from built-in)', (t) => {
  const w = roundWorld(t, { max: 3, review: `  codex_model: gpt 5\n${lanes('high')}` }); // malformed at the fork point: unreadable base
  w.config({ review: lanes('low') });
  const p = plan(w);
  assertExit(p, 0, p.stdout + p.stderr);
  assert.deepEqual(p.json.plan.effortNote, { workingTree: 'low', configured: DEFAULTS.review.effort.low, lane: 'low', from: 'built-in' });
  const r = review(w, 'low');
  assertExit(r, 2);
  assert.ok(r.json.message.includes("the higher of the working tree's and the built-in lane"), r.json.message);
});

test('the working tree names another review.codex_model: the round runs the fork point\'s model, and --plan, the round output and an exit-3 stop carry modelNote; equal models carry none', (t) => {
  const w = roundWorld(t, { max: 3, review: '  codex_model: gpt-test-1\n' });
  w.config({ review: '  codex_model: gpt-test-9\n' });
  const note = "review.codex_model gpt-test-9 in the working tree is not used: this round runs gpt-test-1, the value at main's fork point; the edit applies once it is on main and this branch includes it";
  const p = plan(w);
  assertExit(p, 0, p.stdout + p.stderr);
  assert.equal(p.json.modelNote, note);
  const r = review(w, 'high');
  assertExit(r, 0, r.stdout + r.stderr);
  assert.equal(r.json.modelNote, note);
  assert.equal(w.state().rounds[0].codexModel, 'gpt-test-1');
  // --model naming the trusted model is accepted and the note stays
  const w2 = roundWorld(t, { max: 3, review: '  codex_model: gpt-test-1\n' });
  w2.config({ review: '  codex_model: gpt-test-9\n' });
  const named = review(w2, 'high', ['--model', 'gpt-test-1']);
  assertExit(named, 0, named.stdout + named.stderr);
  assert.equal(named.json.modelNote, note);
  // a failed run says it too
  const w3 = roundWorld(t, { max: 3, review: '  codex_model: gpt-test-1\n' });
  w3.config({ review: '  codex_model: gpt-test-9\n' });
  const failed = w3.cli(['codex-review', '--pr', '7', '--round', '1', '--base', w3.base, '--head', w3.head, '--effort', 'high'], { FAKE_CODEX_EXIT: '1', FAKE_CODEX_TURN_FAILED: 'unexpected status 401 Unauthorized' });
  assertExit(failed, 3, failed.stdout + failed.stderr);
  assert.equal(failed.json.modelNote, note);
  // the same model on both sides: no note
  const same = roundWorld(t, { max: 3, review: '  codex_model: gpt-test-1\n' });
  const q = plan(same);
  assertExit(q, 0, q.stdout + q.stderr);
  assert.equal('modelNote' in q.json, false);
  const done = review(same, 'high');
  assertExit(done, 0, done.stdout + done.stderr);
  assert.equal('modelNote' in done.json, false);
});

test('a working tree that omits review.codex_model reads "unset (built-in default <model>)" when the fork point names another', (t) => {
  const w = roundWorld(t, { max: 3, review: '  codex_model: gpt-test-1\n' });
  w.config({ review: '' });
  const p = plan(w);
  assertExit(p, 0, p.stdout + p.stderr);
  assert.equal(p.json.modelNote, `review.codex_model unset (built-in default ${DEFAULTS.review.codex_model}) in the working tree is not used: this round runs gpt-test-1, the value at main's fork point; the edit applies once it is on main and this branch includes it`);
});

// The follow-up rounds: the note names the lane that decided the round (followup, or small_fix when the round was lowered) and where the higher value came from.
const laneSet = ({ followup = 'high', small_fix: fix = 'low' } = {}) => `  effort: {low: high, medium: high, high: high, followup: ${followup}, small_fix: ${fix}, small_fix_lines: 40}\n`;
const bigLines = (f) => Array.from({ length: 60 }, (_, i) => f(i)).join('\n') + '\n';
const planAt = (w, round, from, to) => w.cli(['codex-review', '--pr', '7', '--round', String(round), '--base', from, '--head', to, '--plan'], w.env);
const reviewAt = (w, round, from, to, effort) => w.cli(['codex-review', '--pr', '7', '--round', String(round), '--base', from, '--head', to, '--effort', effort], { ...w.env, FAKE_CODEX_OUTPUT: w.file(`ok-${round}.json`, findingsOf()) });
// A world whose round 1 is recorded under the fork point's lanes; `change(n)` then commits a rewrite of n of big.js's 60 lines (2n changed lines), -> its sha.
function followWorld(t, review) {
  const w = roundWorld(t, { max: 5, review });
  w.env = {}; // the fake Codex home of floorEnv() (no session logs): the weekly governor is off unless a test writes a reading
  const r1 = review === undefined ? null : reviewAt(w, 1, w.base, w.head, 'high');
  assertExit(r1, 0, r1.stdout + r1.stderr);
  let version = 0;
  w.change = (n) => {
    version += 1;
    w.repo.write('src/big.js', bigLines((i) => (i < n ? `export const big${i} = ${i + 1000 * version};` : `export const big${i} = ${i};`)));
    return w.repo.commit(`tweak ${version}`);
  };
  return w;
}

test('a follow-up round whose working tree lowers the followup lane: the note names lane followup from the fork point, --plan, the effort-mismatch message and the round output carry it', (t) => {
  const w = followWorld(t, laneSet({ followup: 'high' }));
  const h1 = w.change(30); // 60 changed lines > small_fix_lines 40: not a small fix, so the followup lane decides
  w.config({ review: laneSet({ followup: 'medium' }) }); // working tree only (the fork point still says followup: high)
  const p = planAt(w, 2, w.head, h1);
  assertExit(p, 0, p.stdout + p.stderr);
  assert.equal(p.json.plan.small, false);
  assert.equal(p.json.expectedEffort, 'high');
  assert.deepEqual(p.json.plan.effortNote, { workingTree: 'medium', configured: 'high', lane: 'followup', from: 'fork-point' });
  const r = reviewAt(w, 2, w.head, h1, 'medium');
  assertExit(r, 2, r.stdout + r.stderr);
  assert.equal(r.json.error, 'effort-mismatch');
  assert.deepEqual(r.json.effortNote, p.json.plan.effortNote);
  assert.ok(r.json.message.includes("; the working tree's pipeline.yml alone gives medium, but each review.effort lane is the higher of the working tree's and the lane in the pipeline.yml at main's fork point (here high), so a lower lane applies only once it is on main"), r.json.message);
  const ok = reviewAt(w, 2, w.head, h1, 'high');
  assertExit(ok, 0, ok.stdout + ok.stderr);
  assert.deepEqual(ok.json.effortNote, p.json.plan.effortNote);
});

test('a small fix-check whose working tree lowers small_fix: the note names lane small_fix (not followup), configured is the fork point\'s small_fix lane', (t) => {
  const w = followWorld(t, laneSet({ followup: 'high', small_fix: 'medium' }));
  const h1 = w.change(1); // 2 changed lines, no new file, no sensitive path
  w.config({ review: laneSet({ followup: 'high', small_fix: 'low' }) });
  const p = planAt(w, 2, w.head, h1);
  assertExit(p, 0, p.stdout + p.stderr);
  assert.deepEqual([p.json.plan.small, p.json.plan.lowered, p.json.expectedEffort], [true, 'small-fix', 'medium']);
  assert.deepEqual(p.json.plan.effortNote, { workingTree: 'low', configured: 'medium', lane: 'small_fix', from: 'fork-point' });
  const r = reviewAt(w, 2, w.head, h1, 'low');
  assertExit(r, 2, r.stdout + r.stderr);
  assert.deepEqual(r.json.effortNote, p.json.plan.effortNote);
  assert.ok(r.json.message.includes("alone gives low, but each review.effort lane is the higher of the working tree's and the lane in the pipeline.yml at main's fork point (here medium)"), r.json.message);
  // a followup edit alone does not touch a small fix: the small_fix lanes are equal, so no note
  w.config({ review: laneSet({ followup: 'medium', small_fix: 'medium' }) });
  const same = planAt(w, 2, w.head, h1);
  assertExit(same, 0, same.stdout + same.stderr);
  assert.equal('effortNote' in same.json.plan, false);
});

// The weekly governor (soft: 75%) lowers every non-protected round to the small_fix lane, so the note compares the working tree's lanes under the SAME governor decision.
function usageHome(t, pct) {
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), 'cp-notes-home-')));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const day = new Date();
  const dir = join(home, 'sessions', String(day.getUTCFullYear()), String(day.getUTCMonth() + 1).padStart(2, '0'), String(day.getUTCDate()).padStart(2, '0'));
  mkdirSync(dir, { recursive: true });
  const event = { type: 'event_msg', timestamp: day.toISOString(), payload: { type: 'token_count', rate_limits: { limit_id: 'codex', primary: { used_percent: pct, window_minutes: 10080, resets_at: Math.floor(Date.now() / 1000) + 2 * 86400 } } } };
  writeFileSync(join(dir, 'rollout-test.jsonl'), `${JSON.stringify(event)}\n`);
  return { CODEX_HOME: home, PIPELINE_CODEX_HOME: home };
}

test('governor soft: a large follow-up round runs at the small_fix lane, and the note compares the working tree\'s small_fix lane (a followup-only edit gives no note; without the governor it is the followup lane)', (t) => {
  const w = followWorld(t, laneSet({ followup: 'high', small_fix: 'medium' }));
  const h1 = w.change(30); // large: not a small fix
  const soft = usageHome(t, 80);
  // the working tree lowers small_fix: under the governor that lane decides
  w.config({ review: laneSet({ followup: 'high', small_fix: 'low' }) });
  w.env = soft;
  const p = planAt(w, 2, w.head, h1);
  assertExit(p, 0, p.stdout + p.stderr);
  assert.deepEqual([p.json.plan.small, p.json.plan.lowered, p.json.plan.governor.usedPct, p.json.expectedEffort], [false, 'governor-soft', 80, 'medium']);
  assert.deepEqual(p.json.plan.effortNote, { workingTree: 'low', configured: 'medium', lane: 'small_fix', from: 'fork-point' });
  // the working tree lowers only followup: the governor takes both sides to small_fix (equal), so no note
  w.config({ review: laneSet({ followup: 'medium', small_fix: 'medium' }) });
  const equal = planAt(w, 2, w.head, h1);
  assertExit(equal, 0, equal.stdout + equal.stderr);
  assert.deepEqual([equal.json.plan.lowered, equal.json.expectedEffort], ['governor-soft', 'medium']);
  assert.equal('effortNote' in equal.json.plan, false);
  // the same edit with the governor off (no readable usage) is a followup note
  w.env = {};
  const off = planAt(w, 2, w.head, h1);
  assertExit(off, 0, off.stdout + off.stderr);
  assert.equal(off.json.plan.governor, null);
  assert.deepEqual(off.json.plan.effortNote, { workingTree: 'medium', configured: 'high', lane: 'followup', from: 'fork-point' });
  // a reading just under the soft threshold is not lowered: the small_fix edit alone gives no note
  w.config({ review: laneSet({ followup: 'high', small_fix: 'low' }) });
  w.env = usageHome(t, 70);
  const under = planAt(w, 2, w.head, h1);
  assertExit(under, 0, under.stdout + under.stderr);
  assert.deepEqual([under.json.plan.lowered, under.json.expectedEffort], [undefined, 'high']);
  assert.equal('effortNote' in under.json.plan, false);
});

test('a working tree that moves default_branch with a trusted anchor (origin/HEAD): the note says the lane comes from main\'s genuine fork point (anchored-fork-point)', (t) => {
  const w = roundWorld(t, { max: 3, review: lanes('high') });
  w.repo.git(['update-ref', 'refs/remotes/origin/main', 'main']);
  w.repo.git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
  w.repo.git(['branch', 'side', 'main']);
  w.config({ review: lanes('medium'), yml: 'default_branch: side\n' });
  const p = plan(w);
  assertExit(p, 0, p.stdout + p.stderr);
  assert.equal(p.json.expectedEffort, 'high');
  assert.deepEqual(p.json.plan.effortNote, { workingTree: 'medium', configured: 'high', lane: 'low', from: 'anchored-fork-point' });
  const r = review(w, 'medium');
  assertExit(r, 2, r.stdout + r.stderr);
  // the trusted default branch (what the remote calls its default), never the moved one the working tree names
  assert.ok(r.json.message.includes("the higher of the working tree's and the lane at main's genuine fork point (here high), so a lower lane applies only once it is on main"), r.json.message);
  assert.equal(r.json.message.includes('side'), false, r.json.message);
});

test('a working tree that moves default_branch with a trusted anchor and names another review.codex_model: the modelNote names main\'s genuine fork point and main, not the moved branch', (t) => {
  const w = roundWorld(t, { max: 3, review: '  codex_model: gpt-test-1\n' });
  w.repo.git(['update-ref', 'refs/remotes/origin/main', 'main']);
  w.repo.git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
  w.repo.git(['branch', 'side', 'main']);
  w.config({ review: '  codex_model: gpt-test-9\n', yml: 'default_branch: side\n' });
  const p = plan(w);
  assertExit(p, 0, p.stdout + p.stderr);
  assert.equal(p.json.modelNote, "review.codex_model gpt-test-9 in the working tree is not used: this round runs gpt-test-1, the value at main's genuine fork point (the working tree moved default_branch); the edit applies once it is on main and this branch includes it");
});
