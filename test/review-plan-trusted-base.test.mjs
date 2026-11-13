// planRound reads the routing facts and knobs under the working-tree config AND the trusted base config (the PR's fork point), stricter wins (R13-B1, R13-F1),
// and a base-only round's plan names a valid effort (R13-B2). The real CLI against a throwaway repo, a fake gh and a scripted fake Codex.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { roundWorld, findingsOf, low, aFile } from './helpers/round-world.mjs';
import { assertExit } from './helpers/assert-exit.mjs';
import { strictestRouteConfig } from '../pipeline/lib/review-round.mjs';

const lines = (n, tag) => Array.from({ length: n }, (_, i) => `export const ${tag}${i} = ${i};`).join('\n') + '\n';

// Round 1 recorded (one Codex run spent), then a fix commit that CHANGES src/b.js (an existing file) by `n` lines. -> the fix commit.
function afterRoundOne(w, n) {
  const one = w.codex(1, findingsOf([], [low()]));
  assertExit(one, 0, one.stderr + one.stdout);
  w.repo.write('src/b.js', lines(n, 'edit'));
  const fix = w.repo.commit('fix b');
  w.prHead(fix);
  return fix;
}
const plan = (w, from, to) => w.cli(['codex-review', '--pr', '7', '--round', '2', '--base', from, '--head', to, '--plan']);

test('R13-B1: a path the PR dropped from review.arbiter_always_paths in the working tree is still sensitive under the base config: the fix-check is not routed to a substitute', (t) => {
  const w = roundWorld(t, { max: 3, review: '  codex_round_budget: 1\n  arbiter_always_paths: ["src/b.js"]\n' });
  const fix = afterRoundOne(w, 1);
  w.config({ review: '  codex_round_budget: 1\n' }); // the working tree drops the sensitive path
  const r = plan(w, w.head, fix);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.equal(r.json.plan.facts.sensitive, true, 'sensitive under the base config');
  assert.equal(r.json.plan.small, false);
  assert.equal(r.json.plan.route, 'codex', 'a sensitive fix-check is never withheld for the budget');
});

test('R13-B1: a path the PR dropped from risk.high_risk_paths is still sensitive under the base config', (t) => {
  const w = roundWorld(t, { max: 3, review: '  codex_round_budget: 1\n', yml: 'risk:\n  high_risk_paths: ["src/b.js"]\n' });
  const fix = afterRoundOne(w, 1);
  w.config({ review: '  codex_round_budget: 1\n', yml: '' });
  const r = plan(w, w.head, fix);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.equal(r.json.plan.facts.sensitive, true);
});

test('R13-F1: working-tree small_fix_lines 10000 / codex_round_budget 1 do not loosen the base config (defaults: 40 lines, budget 6): the plan records the base budget and does not withhold Codex', (t) => {
  const w = roundWorld(t, { max: 3 });
  const fix = afterRoundOne(w, 5);
  w.config({ review: '  codex_round_budget: 1\n  effort: {low: high, medium: high, high: high, followup: high, small_fix: high, small_fix_lines: 10000}\n' });
  const r = plan(w, w.head, fix);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.deepEqual([r.json.plan.route, r.json.plan.budget], ['codex', { used: 1, budget: 6 }], 'the stricter (higher) budget is what the plan uses and records');
});

test('R13-F1: a 50-line fix is not small under the base small_fix_lines 40 even though the working tree says 10000', (t) => {
  const w = roundWorld(t, { max: 3, review: '  codex_round_budget: 1\n' });
  const fix = afterRoundOne(w, 50);
  w.config({ review: '  codex_round_budget: 1\n  effort: {low: high, medium: high, high: high, followup: high, small_fix: high, small_fix_lines: 10000}\n' });
  const r = plan(w, w.head, fix);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.deepEqual([r.json.plan.small, r.json.plan.route], [false, 'codex']);
});

test('R13-F1: substitute.mode off in the base config holds although the working tree says auto', (t) => {
  const w = roundWorld(t, { max: 3, review: '  codex_round_budget: 1\n  substitute:\n    mode: off\n' });
  const fix = afterRoundOne(w, 5);
  w.config({ review: '  codex_round_budget: 1\n' });
  const r = plan(w, w.head, fix);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.equal(r.json.plan.route, 'codex', 'a small fix-check past the budget is withheld only when the mode is auto');
  assert.match(r.json.plan.why, /^mode-off/);
  assert.match(r.json.plan.modeOffFrom, /default branch's fork point sets review\.substitute\.mode off/, 'the plan says the off came from the base config');
});

test('strictestRouteConfig: lower small_fix_lines, higher budgets, mode off if either says off; an unreadable base is the strictest', () => {
  const cfg = (o = {}) => ({
    review: {
      effort: { small_fix_lines: 40, ...(o.effort ?? {}) }, codex_round_budget: 6, codex_budget: { soft: 75, hard: 90, ...(o.budget ?? {}) },
      substitute: { mode: o.mode ?? 'auto', min_wait_minutes: o.wait ?? 0, max_packet_mb: o.packet ?? 8 }, ...(o.top ?? {}),
    },
  });
  const a = strictestRouteConfig(cfg({ effort: { small_fix_lines: 10000 }, top: { codex_round_budget: 1 }, budget: { hard: 50 } }), { ok: true, config: cfg() });
  assert.deepEqual([a.smallFixLines, a.codexRoundBudget, a.hard, a.mode], [40, 6, 90, 'auto']);
  const b = strictestRouteConfig(cfg({ mode: 'off' }), { ok: true, config: cfg() });
  assert.equal(b.mode, 'off');
  const c = strictestRouteConfig(cfg(), { ok: true, config: cfg({ mode: 'off' }) });
  assert.equal(c.mode, 'off');
  const e = strictestRouteConfig(cfg({ wait: 0, packet: 1000 }), { ok: true, config: cfg({ wait: 60, packet: 8 }) });
  assert.deepEqual([e.minWaitMinutes, e.maxPacketMb], [60, 8], 'a higher wait, a lower packet limit');
  const g = strictestRouteConfig(cfg({ wait: 90, packet: 2 }), { ok: true, config: cfg({ wait: 60, packet: 8 }) });
  assert.deepEqual([g.minWaitMinutes, g.maxPacketMb], [90, 2]);
  const d = strictestRouteConfig(cfg({ effort: { small_fix_lines: 10000 } }), { ok: false, reason: 'none' });
  assert.deepEqual([d.smallFixLines, d.mode], [40, 'off'], 'unreadable base: never looser than the defaults, substitute off');
  assert.match(d.modeOffFrom, /could not be read \(none\)/);
  assert.equal(strictestRouteConfig(cfg(), { ok: true, config: cfg() }).modeOffFrom, null);
  assert.match(strictestRouteConfig(cfg({ mode: 'off' }), { ok: true, config: cfg() }).modeOffFrom, /working-tree/);
});

test('R13-B2: the plan of a base-only round names the follow-up effort, and codex-review with it records the base-only round', (t) => {
  const w = roundWorld(t, { max: 3 });
  const one = w.codex(1, findingsOf([], [low()]));
  assertExit(one, 0, one.stderr + one.stdout);
  w.repo.git(['checkout', '-q', 'main']);
  w.repo.write('src/a.js', aFile(false).replace('export const v10 = 10;', 'export const v10 = 1000;'));
  w.repo.commit('main moves');
  w.repo.git(['checkout', '-q', 'feat/x']);
  w.repo.git(['merge', '--no-edit', 'main']);
  const merged = w.repo.git(['rev-parse', 'HEAD']).trim();
  w.prHead(merged);
  const p = plan(w, w.head, merged);
  assertExit(p, 0, p.stderr + p.stdout);
  assert.equal(p.json.plan.baseOnly, true);
  assert.equal(p.json.expectedEffort, 'high', 'review.effort.followup, not null');
  const run = w.cli(['codex-review', '--pr', '7', '--round', '2', '--base', w.head, '--head', merged, '--effort', p.json.expectedEffort]);
  assertExit(run, 0, run.stderr + run.stdout);
  assert.equal(w.state().rounds.at(-1).baseOnly, true);
});

// A readable base config that names another default_branch than the working tree's is no trusted base for ROUTING either (the PR may have moved the anchor): trustedBaseOf reads it
// as unreadable, so the substitute is off and every path is sensitive (round-status.mjs#trustedBaseConfig keeps its lists for the severity display only).
test('a committed base config naming another default_branch than the working tree reads as an unreadable base: substitute off, every path sensitive', (t) => {
  const w = roundWorld(t, { max: 3, review: '  codex_round_budget: 1\n' });
  const fix = afterRoundOne(w, 5);
  w.repo.git(['branch', 'other', 'main']); // a branch the edited config can name that forks from the same commit, so the fork point still resolves
  w.config({ review: '  codex_round_budget: 1\n', yml: 'default_branch: other\n' }); // the working tree moves the anchor; the committed config says main
  const r = plan(w, w.head, fix);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.equal(r.json.plan.facts.sensitive, true, 'an unreadable base counts every path as sensitive');
  assert.equal(r.json.plan.small, false);
  assert.equal(r.json.plan.route, 'codex', 'a sensitive fix-check is never withheld for the budget');
  assert.match(r.json.plan.modeOffFrom, /could not be read .*default_branch/, 'the plan says the off came from an unreadable base, naming the mismatch');
});
