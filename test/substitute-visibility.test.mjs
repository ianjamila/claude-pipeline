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

// ---- round pile-up stats and the Codex usage line ----------------------------------------------------------------------------------------
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { roundStats } from '../pipeline/lib/round-stats.mjs';
import { kindOf, summariseUsage } from '../pipeline/lib/codex-usage-kinds.mjs';
import { run as codexStatus } from '../pipeline/commands/codex-status.mjs';

test('roundStats: items per round by bucket, and how often a finding that was already ruled came back', () => {
  const it = (id, bucket, fp, final) => ({ id, bucket, fingerprint: fp, final: final ?? null });
  const s = stateWith([{ items: [it('R1-B1', 'BLOCKING', 'a', { decision: 'REJECT' }), it('R1-S1', 'SUGGESTION', 'b')] }, { items: [it('R2-B1', 'BLOCKING', 'a'), it('R2-S1', 'SUGGESTION', 'b'), it('R2-W1', 'WORTH_CONSIDERING', 'c')] }]);
  assert.deepEqual(roundStats(s), {
    rounds: [{ n: 1, items: 2, byBucket: { BLOCKING: 1, SUGGESTION: 1 } }, { n: 2, items: 3, byBucket: { BLOCKING: 1, SUGGESTION: 1, WORTH_CONSIDERING: 1 } }],
    reRaised: 2, ruledReRaised: 1,
  });
  assert.deepEqual(roundStats(null), { rounds: [], reRaised: 0, ruledReRaised: 0 });
});

test('codex usage: sessions are summed by kind from the prompt header; unknown is `other`; sessions before --since are left out; the line is one line', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'cp-usage-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const day = join(home, 'sessions', '2026', '11', '11');
  mkdirSync(day, { recursive: true });
  const session = (name, text, tokens, ts = '2026-11-11T10:00:00Z') => writeFileSync(join(day, name), [
    { type: 'session_meta', payload: { timestamp: ts } },
    { type: 'response_item', payload: { role: 'user', content: [{ type: 'input_text', text }] } },
    { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { total_tokens: tokens } } } },
  ].map((e) => JSON.stringify(e)).join('\n'));
  session('a.jsonl', 'You are an independent reviewer of a pull request.\nReview round: 1', 3_000_000);
  session('b.jsonl', 'You are an independent reviewer of a pull request.\nReview round: 3', 1_000_000);
  session('c.jsonl', 'You are an independent second reviewer.', 500_000);
  session('d.jsonl', 'hello', 100_000);
  session('e.jsonl', 'You are an independent reviewer of a pull request.\nReview round: 1', 9_000_000, '2026-11-01T10:00:00Z');
  const u = summariseUsage({ env: { CODEX_HOME: home }, now: Date.parse('2026-11-12T00:00:00Z'), since: '2026-11-10T00:00:00Z' });
  assert.equal(u.sessions, 4);
  assert.deepEqual(u.byKind['pipeline round 1'], { sessions: 1, tokens: 3_000_000 });
  assert.deepEqual(u.byKind['pipeline fix-check'], { sessions: 1, tokens: 1_000_000 });
  assert.deepEqual(u.byKind['pipeline second review'], { sessions: 1, tokens: 500_000 });
  assert.deepEqual(u.byKind.other, { sessions: 1, tokens: 100_000 });
  assert.match(u.line, /^- 2026-11-12 · Codex usage since 2026-11-10 · 4\.6M tokens in 4 sessions · pipeline round 1 3\.0M \(1\)/);
  assert.ok(!u.line.includes('\n'));
  assert.equal(kindOf(['no header']), 'other');
  const cmd = await codexStatus(['--usage', '--since', '2026-11-10T00:00:00Z'], { env: { CODEX_HOME: home }, now: () => Date.parse('2026-11-12T00:00:00Z') });
  assert.equal(cmd.exitCode, 0);
  assert.equal(cmd.output.sessions, 4);
  await assert.rejects(() => codexStatus(['--since', '2026-11-10'], {}), /needs --usage/);
});
