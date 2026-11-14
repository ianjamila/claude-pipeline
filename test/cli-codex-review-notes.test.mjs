// #445: say where the effort and the model come from. codex-review reads each review.effort lane as the HIGHER of the working tree's and the default branch's fork point (or the built-in lane),
// and review.codex_model from the fork point alone; when the working tree's own value would have given something else the output says which source won (effortNote, modelNote).
// The real CLI against a throwaway repo with a fake gh and a scripted fake Codex.
import { test } from 'node:test';
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
