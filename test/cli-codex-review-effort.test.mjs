// codex-review decides the effort of a round itself and routes a small fix-check away from Codex when the PR's Codex budget or the weekly Codex quota is spent
// (plan 2026-11-11-codex-substitute-reviewer: C2 cheaper fix-checks, C3 the weekly governor, R4-4 table + R5-4, R4-5 / R5-9 whole-PR rounds). The real CLI against a
// throwaway repo with a fake gh and a scripted fake Codex.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { roundWorld, findingsOf } from './helpers/round-world.mjs';
import { assertExit } from './helpers/assert-exit.mjs';

const EFFORT = '  effort: {low: medium, medium: medium, high: high, followup: medium, small_fix: low, small_fix_lines: 40}\n';
const bigLines = (f) => Array.from({ length: 60 }, (_, i) => f(i)).join('\n') + '\n';

// A world whose efforts are told apart (round 1 medium, later rounds medium, small fix low) and a private Codex home for the governor.
function world(t, { review = '', yml = "", max = 5 } = {}) {
  const w = roundWorld(t, { max, review: EFFORT + review, yml });
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), 'cp-effort-home-')));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  w.home = home;
  w.env = { CODEX_HOME: home, PIPELINE_CODEX_HOME: home };
  // a weekly reading in Codex's own session logs: used_percent p, observed now, resetting in two days
  w.usage = (p) => {
    const day = new Date();
    const dir = join(home, 'sessions', String(day.getUTCFullYear()), String(day.getUTCMonth() + 1).padStart(2, '0'), String(day.getUTCDate()).padStart(2, '0'));
    mkdirSync(dir, { recursive: true });
    const event = { type: 'event_msg', timestamp: day.toISOString(), payload: { type: 'token_count', rate_limits: { limit_id: 'codex', primary: { used_percent: p, window_minutes: 10080, resets_at: Math.floor(Date.now() / 1000) + 2 * 86400 } } } };
    writeFileSync(join(dir, 'rollout-test.jsonl'), `${JSON.stringify(event)}\n`);
  };
  w.ok = () => ({ FAKE_CODEX_OUTPUT: w.file('ok.json', findingsOf([], [])) });
  w.review = (round, from, to, effort, env = {}) => w.cli(
    ['codex-review', '--pr', '7', '--round', String(round), '--base', from, '--head', to, '--effort', effort],
    { ...w.env, ...w.ok(), ...env },
  );
  w.plan = (round, from, to, env = {}) => w.cli(['codex-review', '--pr', '7', '--round', String(round), '--base', from, '--head', to, '--plan'], { ...w.env, ...env });
  w.route = (round) => JSON.parse(readFileSync(join(w.repo.dir, '.review', `round-${round}`, 'route.json'), 'utf8'));
  let version = 0;
  // a commit that rewrites `n` of big.js's 60 lines (n added + n removed lines), -> its sha
  w.edit60 = (n, msg = 'tweak') => {
    version += 1;
    w.repo.write('src/big.js', bigLines((i) => (i < n ? `export const big${i} = ${i + 1000 * version};` : `export const big${i} = ${i};`)));
    return w.repo.commit(`${msg} ${version}`);
  };
  // round 1 recorded -> its head (w.head)
  w.round1 = (env = {}) => {
    const r = w.review(1, w.base, w.head, 'medium', env);
    assertExit(r, 0, r.stdout + r.stderr);
    return w.head;
  };
  return w;
}

test('--plan prints the round\'s route and expected effort and writes nothing: round 1 keeps the risk lane effort', (t) => {
  const w = world(t);
  const r = w.plan(1, w.base, w.head);
  assertExit(r, 0, r.stdout + r.stderr);
  assert.equal(r.json.expectedEffort, 'medium');
  assert.deepEqual([r.json.plan.route, r.json.plan.evidence, r.json.plan.protected], ['codex', 'none', ['round-1']]);
  assert.ok(!existsSync(join(w.repo.dir, '.review', 'state.json')), 'no round');
  assert.ok(!existsSync(join(w.repo.dir, '.review', 'round-1', 'route.json')), 'no attempt');
  const wrong = w.review(1, w.base, w.head, 'low');
  assertExit(wrong, 2, wrong.stdout);
  assert.equal(wrong.json.error, 'effort-mismatch');
  assert.equal(wrong.json.expected, 'medium');
  assert.match(wrong.json.message, /use --effort medium/);
  assert.ok(!existsSync(join(w.repo.dir, '.review', 'state.json')), 'refused before Codex ran');
});

test('a 29-line fix-check gets small_fix; the wrong --effort is refused naming it; the round records its effort', (t) => {
  const w = world(t);
  const h0 = w.round1();
  w.repo.write('src/big.js', bigLines((i) => (i < 14 ? `export const big${i} = ${i + 77};` : `export const big${i} = ${i};`)) + 'export const extra = 1;\n');
  const h1 = w.repo.commit('29 lines');
  const p = w.plan(2, h0, h1);
  assertExit(p, 0, p.stdout + p.stderr);
  assert.equal(p.json.plan.facts.changedLines, 29);
  assert.deepEqual([p.json.plan.small, p.json.plan.lowered, p.json.expectedEffort], [true, 'small-fix', 'low']);
  const wrong = w.review(2, h0, h1, 'medium');
  assertExit(wrong, 2, wrong.stdout);
  assert.deepEqual([wrong.json.error, wrong.json.expected], ['effort-mismatch', 'low']);
  const ok = w.review(2, h0, h1, 'low');
  assertExit(ok, 0, ok.stdout + ok.stderr);
  assert.equal(w.state().rounds[1].effort, 'low');
});

test('a fix-check that is not small keeps the follow-up effort: too many lines, a new file, a sensitive path', (t) => {
  const w = world(t, { yml: 'risk:\n  high_risk_paths: ["src/secret.js"]\n' });
  const h0 = w.round1();
  const big = w.edit60(21); // 42 changed lines > 40
  assert.equal(w.plan(2, h0, big).json.expectedEffort, 'medium', 'too many lines');
  w.repo.write('src/new.js', 'export const n = 1;\n');
  const added = w.repo.commit('new file');
  assert.equal(w.plan(2, h0, added).json.plan.facts.newFile, true);
  assert.equal(w.plan(2, h0, added).json.expectedEffort, 'medium', 'a new file');
  w.repo.write('src/secret.js', 'export const s = 1;\n');
  const secret = w.repo.commit('sensitive');
  const p = w.plan(2, h0, secret);
  assert.equal(p.json.plan.facts.sensitive, true);
  assert.equal(p.json.expectedEffort, 'medium', 'a sensitive path');
});

test('the round after a risk rise keeps the normal effort even when the fix is small', (t) => {
  const w = world(t);
  const h0 = w.round1();
  const h1 = w.edit60(1);
  assert.equal(w.plan(2, h0, h1).json.expectedEffort, 'low', 'before the rise: small');
  w.config({ yml: 'risk:\n  high_risk_paths: ["src/a.js"]\n' }); // the PR now touches a high-risk path: its risk rose
  const p = w.plan(2, h0, h1);
  assert.deepEqual([p.json.plan.protected, p.json.expectedEffort, p.json.plan.lowered], [['post-rise'], 'medium', undefined]);
});

test('budget: a small fix-check past review.codex_round_budget goes to the substitute (exit 3 withheld, route.json budget); a killed retry does not count; a large round stays on Codex', (t) => {
  const w = world(t, { review: '  codex_round_budget: 3\n' });
  const h0 = w.round1();
  const h1 = w.edit60(1);
  // a Codex run that dies does not use up the budget
  for (let k = 0; k < 2; k += 1) assertExit(w.review(2, h0, h1, 'low', { FAKE_CODEX_EXIT: '2', FAKE_CODEX_STDERR: 'segfault' }), 3);
  assertExit(w.review(2, h0, h1, 'low'), 0);
  const h2 = w.edit60(1);
  assertExit(w.review(3, h1, h2, 'low'), 0);
  // three Codex rounds are recorded: a large fourth round stays on Codex (at the normal effort), a small one is withheld
  const h3 = w.edit60(30);
  const large = w.plan(4, h2, h3);
  assert.deepEqual([large.json.plan.route, large.json.plan.small, large.json.expectedEffort, large.json.plan.budget], ['codex', false, 'medium', { used: 3, budget: 3 }]);
  const h4 = w.edit60(1);
  const small = w.review(4, h2, h4, 'low');
  assertExit(small, 3, small.stdout);
  assert.deepEqual([small.json.reason, small.json.unavailable, small.json.substitute.eligible, small.json.substitute.evidence, small.json.substitute.agent], ['withheld', true, true, 'budget', 'substitute-opus']);
  const route = w.route(4);
  assert.deepEqual([route.evidence, route.budget, route.outcome, route.base, route.head], ['budget', { used: 3, budget: 3 }, 'withheld', h2, h4]);
  assert.equal(w.state().rounds.length, 3, 'no round was recorded for the withheld one');
  // Codex still runs for the large range
  const run = w.review(4, h2, h3 === h4 ? h3 : h4, 'low');
  assert.equal(run.code, 3, 'the same withheld small round again');
});

test('review.substitute.mode off: a spent budget never substitutes (the small fix-check still runs on Codex at small_fix)', (t) => {
  const w = world(t, { review: '  codex_round_budget: 1\n  substitute:\n    mode: off\n' });
  const h0 = w.round1();
  const h1 = w.edit60(1);
  const r = w.review(2, h0, h1, 'low');
  assertExit(r, 0, r.stdout + r.stderr);
});

test('governor: unreadable weekly usage is off; soft lowers every non-protected round to small_fix and records the decision; hard substitutes only a small round', (t) => {
  const w = world(t);
  const h0 = w.round1();
  const large = w.edit60(30);
  assert.equal(w.plan(2, h0, large).json.expectedEffort, 'medium', 'no readable usage: governor off');
  assert.equal(w.plan(2, h0, large).json.plan.governor, null);
  w.usage(80);
  const soft = w.plan(2, h0, large);
  assert.deepEqual([soft.json.plan.lowered, soft.json.expectedEffort, soft.json.plan.governor.usedPct, soft.json.plan.route], ['governor-soft', 'low', 80, 'codex']);
  assertExit(w.review(2, h0, large, 'medium'), 2);
  const done = w.review(2, h0, large, 'low');
  assertExit(done, 0, done.stdout + done.stderr);
  const round = w.state().rounds[1];
  assert.deepEqual([round.effort, round.governor.usedPct, round.governor.threshold, w.state().version], ['low', 80, 75, 4]);
  // hard: a large round stays on Codex at small_fix, a small one is withheld with the governor evidence
  w.usage(95);
  const h2 = w.edit60(30);
  const bigHard = w.plan(3, large, h2);
  assert.deepEqual([bigHard.json.plan.route, bigHard.json.expectedEffort], ['codex', 'low']);
  const h3 = w.edit60(1);
  const smallHard = w.review(3, large, h3 === h2 ? h2 : h3, 'low');
  assert.equal(smallHard.code, 0, 'two commits since round 2 make a large range, still Codex');
});

test('governor hard withholds a small non-protected round: exit 3 withheld, route.json governor {usedPct, threshold, observedAt}', (t) => {
  const w = world(t);
  const h0 = w.round1();
  const h1 = w.edit60(1);
  w.usage(95);
  const r = w.review(2, h0, h1, 'low');
  assertExit(r, 3, r.stdout);
  assert.deepEqual([r.json.reason, r.json.substitute.eligible, r.json.substitute.evidence], ['withheld', true, 'governor']);
  const route = w.route(2);
  assert.equal(route.evidence, 'governor');
  assert.deepEqual([route.governor.usedPct, route.governor.threshold], [95, 90]);
  assert.ok(route.governor.observedAt);
  assert.equal(w.state().rounds.length, 1);
  // round 1 is protected: Codex runs even at 95 %
  const w2 = world(t);
  w2.usage(99);
  const first = w2.review(1, w2.base, w2.head, 'medium');
  assertExit(first, 0, first.stdout + first.stderr);
});

test('whole-PR round (R4-5 / R5-9): owed after an Opus substitute round and a rise to high; state outcome says so, base must be the merge base, the round records wholePr and clears it', (t) => {
  const w = world(t);
  const h0 = w.round1();
  // round 1 was an Opus substitute round at low risk (a hand-edited state: the substitute path itself is a later task)
  w.edit((s) => { Object.assign(s.rounds[0], { firstReviewer: 'substitute', substitute: { agent: 'substitute-opus' }, risk: 'low' }); delete s.rounds[0].codexModel; s.version = 4; });
  const h1 = w.edit60(1);
  w.config({ yml: 'risk:\n  high_risk_paths: ["src/a.js"]\n' });
  assert.equal(JSON.parse(w.cli(['state', 'outcome'], w.env).stdout).wholePrOwed, false);
  const r2 = w.review(2, h0, h1, 'medium'); // the round that sees the rise (incremental, protected as post-rise)
  assertExit(r2, 0, r2.stdout + r2.stderr);
  assert.equal(w.state().rounds[1].risk, 'high');
  const out = w.cli(['state', 'outcome'], w.env);
  assert.deepEqual([out.json.wholePrOwed, out.json.base, out.json.nextRound.round, out.json.nextRound.wholePrOwed], [true, w.base, 3, true]);
  const h2 = w.edit60(1); // a smaller diff than the PR as a whole
  const wrong = w.review(3, h1, h2, 'high');
  assertExit(wrong, 2, wrong.stdout);
  assert.equal(wrong.json.error, 'base-mismatch');
  assert.match(wrong.json.message, /whole PR/);
  const p = w.plan(3, w.base, h2);
  assert.deepEqual([p.json.plan.wholePrOwed, p.json.plan.protected, p.json.expectedEffort], [true, ['post-rise', 'whole-pr'], 'high']);
  const ok = w.review(3, w.base, h2, 'high');
  assertExit(ok, 0, ok.stdout + ok.stderr);
  const round = w.state().rounds[2];
  assert.deepEqual([round.wholePr, round.reviewBase, round.reviewBaseKind, round.fromHead], [true, w.base, 'merge-base', w.base]);
  assert.match(round.patchSha256, /^[0-9a-f]{64}$/);
  assert.equal(w.cli(['state', 'outcome'], w.env).json.wholePrOwed, false, 'the whole-PR round cleared it');
});

test('an all-Codex history owes no whole-PR round, whatever the risk does', (t) => {
  const w = world(t);
  const h0 = w.round1();
  const h1 = w.edit60(1);
  w.config({ yml: 'risk:\n  high_risk_paths: ["src/a.js"]\n' });
  assertExit(w.review(2, h0, h1, 'medium'), 0);
  const out = w.cli(['state', 'outcome'], w.env);
  assert.deepEqual([out.json.wholePrOwed, out.json.base], [false, undefined]);
  const h2 = w.edit60(1);
  assertExit(w.review(3, h1, h2, 'medium'), 0);
});
