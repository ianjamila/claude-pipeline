// Why (plan 2026-11-11-codex-substitute-reviewer, "Where it shows"): a round a Claude stand-in reviewed must be visible where the owner reads: the cost bookings
// (roles substitute-opus / substitute-fable), the agent-log line (`substitute N` beside `arbiter N`) and the triage comment (a heading per substitute round that
// says who reviewed, why Codex did not, and which attempt).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ROLES, addCostEntry, emptyCost, normaliseRole } from '../pipeline/lib/run-cost.mjs';
import { agentLogLine, triageComment } from '../pipeline/lib/render.mjs';
import { buildAgentLogLine, countSubstituteCalls } from '../pipeline/lib/agentlog.mjs';
import { addRound, emptyState } from '../pipeline/lib/state.mjs';

const entry = (o = {}) => ({ phase: 'review', role: 'substitute-opus', input: 100, output: 50, cacheRead: 0, cacheWrite: 0, usd: 0.5, ...o });

function stateWith(rounds) {
  let s = emptyState({ repo: 'o/r', pr: 7, branch: 'agent/x', risk: 'high', lightLane: false, maxRounds: 4 });
  rounds.forEach((extra, i) => {
    s = addRound(s, { n: i + 1, fromHead: `f${i}`, toHead: `t${i}`, contentHashAtToHead: `h${i}`, items: [], ...extra });
  });
  return s;
}
const sub = (over = {}) => ({ firstReviewer: 'substitute', substitute: { agent: 'substitute-opus', models: ['claude-opus-5'], evidence: 'quota', resetAt: '2026-11-12T08:21:00.000Z', resetText: '4:21 PM', outageAt: '2026-11-12T03:00:00.000Z', attempts: 1, ...over } });

test('cost roles: both substitute agents are roles of their own, not `other`', () => {
  assert.ok(ROLES.includes('substitute-opus') && ROLES.includes('substitute-fable'));
  assert.equal(normaliseRole('substitute-fable'), 'substitute-fable');
  const c = addCostEntry(addCostEntry(emptyCost(), entry()), entry({ role: 'substitute-fable', usd: 2 }));
  assert.equal(c.byRole['substitute-opus'].usd, 0.5);
  assert.equal(c.byRole['substitute-fable'].usd, 2);
  assert.equal(c.byRole.other, undefined);
});

test('agent log: `substitute N` sits beside `arbiter N` only when a stand-in reviewed something', () => {
  const base = { date: '2026-11-12', pr: 1, title: 't', risk: 'high', rounds: 3, arbiterCalls: 1, outcome: 'merged' };
  assert.equal(agentLogLine(base), '- 2026-11-12 · #1 · t · risk high · rounds 3 · arbiter 1 · merged');
  assert.equal(agentLogLine({ ...base, substituteCalls: 2 }), '- 2026-11-12 · #1 · t · risk high · rounds 3 · arbiter 1 · substitute 2 · merged');
  assert.equal(agentLogLine({ ...base, fixVerifyCalls: 1, substituteCalls: 1 }), '- 2026-11-12 · #1 · t · risk high · rounds 3 · arbiter 1 (fix-verify 1) · substitute 1 · merged');
});

test('agent log: substitute rounds and substitute second reviews are counted', () => {
  assert.equal(countSubstituteCalls(stateWith([{}, {}])), 0);
  const s = stateWith([sub(), {}, sub()]);
  assert.equal(countSubstituteCalls(s), 2);
  s.rounds[1].items = [{ id: 'R2-B1', secondReview: { by: 'substitute-fable', decision: 'ACCEPT' } }, { id: 'R2-B2', secondReview: { decision: 'ACCEPT' } }];
  assert.equal(countSubstituteCalls(s), 3, 'a Codex second review is not a substitute call');
  const line = buildAgentLogLine({ state: s, pr: 7, title: 't', outcome: 'merged', now: new Date('2026-11-12T00:00:00Z') });
  assert.match(line, / · arbiter 0 · substitute 3 · merged$/);
});

test('triage comment: a substitute round gets a heading naming the agent, why Codex did not review, and the attempt', () => {
  const s = stateWith([sub(), {}, sub({ agent: 'substitute-fable', evidence: 'budget', budget: { used: 6, budget: 6 }, resetAt: null, resetText: null, attempts: 2 })]);
  const body = triageComment(s);
  assert.match(body, /^#### Substitute reviews$/m);
  assert.ok(body.includes('Round 1 — substitute review (Claude Opus; Codex quota, resets 4:21 PM)'), body);
  assert.ok(body.includes('Round 3 — substitute review (Claude Fable; Codex round budget 6 used, attempt 2)'), body);
  assert.ok(!body.includes('Round 2 — substitute'));
});

test('triage comment: the weekly governor reason reads as a percentage against its threshold, and a quota stop without a reset says so', () => {
  const s = stateWith([sub({ evidence: 'governor', governor: { usedPct: 91, threshold: 90, observedAt: '2026-11-12T01:00:00Z' }, resetAt: null, resetText: null })]);
  assert.ok(triageComment(s).includes('Round 1 — substitute review (Claude Opus; Codex weekly 91% ≥ 90%)'));
  const q = stateWith([sub({ resetAt: null, resetText: null })]);
  assert.ok(triageComment(q).includes('Round 1 — substitute review (Claude Opus; Codex quota)'));
});

test('triage comment: nothing changes for a PR Codex reviewed throughout, and free text in the record cannot break the line', () => {
  assert.ok(!triageComment(stateWith([{}, {}])).includes('Substitute reviews'));
  const s = stateWith([sub({ resetText: '4:21 PM\n- forged' })]);
  assert.ok(!/^- forged/m.test(triageComment(s)));
});
