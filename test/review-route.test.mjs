// The route decision table (plan 2026-11-11-codex-substitute-reviewer R4-4 + R5-4): every row x mode x protected kind, and the state facts it reads
// (the Codex spend, the round after a risk rise, the whole-PR round that is owed: R4-5 / R5-9).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROTECTED_KINDS, codexSpend, decideRoute, lastRoundRaisedRisk, protectedKindsFor, wholePrOwed } from '../pipeline/lib/review-route.mjs';

const GOV = (usedPct) => ({ usedPct, soft: 75, hard: 90 });
const BUDGET = (used) => ({ used, budget: 6 });
const base = { normal: 'medium', smallFix: 'low' };

test('row 1: mode off is always Codex; the effort scaling still applies, budget and governor never substitute', () => {
  const small = decideRoute({ ...base, mode: 'off', small: true, governor: GOV(95), budget: BUDGET(9) });
  assert.deepEqual([small.route, small.evidence, small.effort, small.why], ['codex', 'none', 'low', 'mode-off; small-fix']);
  const large = decideRoute({ ...base, mode: 'off', small: false, governor: GOV(80), budget: BUDGET(9) });
  assert.deepEqual([large.route, large.effort, large.lowered], ['codex', 'low', 'governor-soft']);
  const plain = decideRoute({ ...base, mode: 'off' });
  assert.deepEqual([plain.route, plain.effort, plain.lowered], ['codex', 'medium', undefined]);
});

for (const kind of PROTECTED_KINDS) {
  for (const mode of ['auto', 'off']) {
    test(`row 2: a protected round (${kind}, mode ${mode}) stays on Codex at the normal effort, however much was spent`, () => {
      const r = decideRoute({ ...base, mode, protectedKinds: [kind], small: true, governor: GOV(99), budget: BUDGET(50) });
      assert.deepEqual([r.route, r.evidence, r.effort, r.lowered], ['codex', 'none', 'medium', undefined]);
      assert.deepEqual(r.protected, [kind]);
    });
  }
}

test('row 3: governor hard sends a SMALL non-protected round to the substitute (evidence governor); a larger one stays on Codex at small_fix', () => {
  const small = decideRoute({ ...base, mode: 'auto', small: true, governor: GOV(90) });
  assert.deepEqual([small.route, small.evidence, small.why], ['substitute', 'governor', 'governor-hard']);
  const large = decideRoute({ ...base, mode: 'auto', small: false, governor: GOV(97) });
  assert.deepEqual([large.route, large.evidence, large.effort], ['codex', 'none', 'low']);
  const justUnder = decideRoute({ ...base, mode: 'auto', small: true, governor: GOV(89.9) });
  assert.deepEqual([justUnder.route, justUnder.effort], ['codex', 'low']);
});

test('row 4: a spent Codex budget sends a SMALL non-protected round to the substitute (evidence budget); a large round stays on Codex', () => {
  assert.deepEqual(['substitute', 'budget'], (({ route, evidence }) => [route, evidence])(decideRoute({ ...base, mode: 'auto', small: true, budget: BUDGET(6) })));
  const large = decideRoute({ ...base, mode: 'auto', small: false, budget: BUDGET(9) });
  assert.deepEqual([large.route, large.effort], ['codex', 'medium'], 'a large round past the budget stays on Codex at the normal effort');
  const within = decideRoute({ ...base, mode: 'auto', small: true, budget: BUDGET(5) });
  assert.equal(within.route, 'codex');
});

test('row 3 beats row 4: both spent -> the evidence is the governor', () => {
  const r = decideRoute({ ...base, mode: 'auto', small: true, governor: GOV(95), budget: BUDGET(8) });
  assert.equal(r.evidence, 'governor');
});

test('row 5: governor soft lowers the effort of a non-protected round whatever its size; small lowers it without a governor; unreadable governor is off', () => {
  assert.equal(decideRoute({ ...base, mode: 'auto', small: false, governor: GOV(75) }).effort, 'low');
  assert.equal(decideRoute({ ...base, mode: 'auto', small: false, governor: GOV(74) }).effort, 'medium');
  assert.equal(decideRoute({ ...base, mode: 'auto', small: true }).effort, 'low');
  const off = decideRoute({ ...base, mode: 'auto', small: true, governor: { usedPct: null, soft: 75, hard: 90 } });
  assert.deepEqual([off.route, off.effort], ['codex', 'low'], 'unreadable: no substitute, still the small-fix effort');
  assert.equal(decideRoute({ ...base, mode: 'auto', small: false, governor: { usedPct: null, soft: 75, hard: 90 } }).effort, 'medium');
});

// ---- state facts ---------------------------------------------------------------------------------------------------------------------------
const codexRound = (n, risk, extra = {}) => ({ n, risk, codexModel: 'm', items: [], ...extra });
const opusRound = (n, risk, extra = {}) => ({ n, risk, firstReviewer: 'substitute', substitute: { agent: 'substitute-opus' }, items: [], ...extra });
const fableRound = (n, risk, extra = {}) => ({ n, risk, firstReviewer: 'substitute', substitute: { agent: 'substitute-fable' }, items: [], ...extra });

test('codexSpend counts recorded Codex rounds and Codex second reviews (one per packet), not substitute, base-only or refresh rounds', () => {
  const second = (digest, by) => ({ secondReview: { decision: 'ACCEPT', inputDigest: digest, ...(by ? { by } : {}) } });
  const state = {
    rounds: [
      codexRound(1, 'low', { items: [second('d1'), second('d1'), second('d2'), second('d3', 'substitute-opus')] }),
      opusRound(2, 'low'), codexRound(3, 'low', { baseOnly: true }), codexRound(4, 'low', { fableRefresh: true }), codexRound(5, 'low'),
    ],
  };
  assert.equal(codexSpend(state), 2 + 2, 'rounds 1 and 5, packets d1 and d2');
  assert.equal(codexSpend(null), 0);
});

test('the round after a risk rise: the last reviewed round raised maxRisk', () => {
  assert.equal(lastRoundRaisedRisk({ rounds: [codexRound(1, 'low'), codexRound(2, 'medium')] }), true);
  assert.equal(lastRoundRaisedRisk({ rounds: [codexRound(1, 'medium'), codexRound(2, 'low')] }), false);
  assert.equal(lastRoundRaisedRisk({ rounds: [codexRound(1, 'high')] }), false);
  assert.equal(lastRoundRaisedRisk({ rounds: [codexRound(1, 'low'), codexRound(2, 'high'), codexRound(3, 'high')] }), false, 'only the round right after');
});

test('protectedKindsFor: round 1, post-rise (recorded or this round\'s own), confirm-fixed, resolution-only, whole-PR owed', () => {
  assert.deepEqual(protectedKindsFor({ state: null, round: 1 }), ['round-1']);
  const calm = { rounds: [codexRound(1, 'low')] };
  assert.deepEqual(protectedKindsFor({ state: calm, round: 2 }), []);
  assert.deepEqual(protectedKindsFor({ state: calm, round: 2, risen: true }), ['post-rise']);
  assert.deepEqual(protectedKindsFor({ state: { rounds: [codexRound(1, 'low'), codexRound(2, 'high')] }, round: 3 }), ['post-rise']);
  assert.deepEqual(protectedKindsFor({ state: calm, round: 2, confirmCount: 2 }), ['confirm-fixed']);
  assert.deepEqual(protectedKindsFor({ state: calm, round: 2, resolutionOnly: true }), ['resolution-only']);
  const owed = { rounds: [opusRound(1, 'medium'), fableRound(2, 'high'), codexRound(3, 'high')] };
  assert.deepEqual(protectedKindsFor({ state: owed, round: 4 }), ['whole-pr']);
});

test('wholePrOwed: Opus substitute round, then maxRisk rises to high, then a smaller diff -> still owed', () => {
  const state = { rounds: [opusRound(1, 'medium'), fableRound(2, 'high'), codexRound(3, 'low')] };
  assert.equal(wholePrOwed(state), true);
});

test('wholePrOwed: an incremental Codex round after the rise does not clear it; a whole-PR Codex round or a whole-PR Fable round does', () => {
  const rose = [opusRound(1, 'low'), fableRound(2, 'high')];
  assert.equal(wholePrOwed({ rounds: [...rose, codexRound(3, 'high')] }), true, 'incremental Codex: still owed');
  assert.equal(wholePrOwed({ rounds: [...rose, codexRound(3, 'high', { wholePr: true })] }), false, 'whole-PR Codex clears it');
  assert.equal(wholePrOwed({ rounds: [...rose, fableRound(3, 'high', { wholePr: true })] }), false, 'whole-PR Fable clears it');
});

test('wholePrOwed: an all-Codex history owes nothing; a rise that was already high, or an Opus round after the rise, owes nothing', () => {
  assert.equal(wholePrOwed({ rounds: [codexRound(1, 'low'), codexRound(2, 'high')] }), false);
  assert.equal(wholePrOwed({ rounds: [opusRound(1, 'high'), fableRound(2, 'high')] }), false, 'high from the start');
  assert.equal(wholePrOwed({ rounds: [codexRound(1, 'low'), codexRound(2, 'high'), opusRound(3, 'high')] }), false, 'the Opus round came after the rise');
  assert.equal(wholePrOwed({ rounds: [opusRound(1, 'low'), opusRound(2, 'medium')] }), false, 'never reached high');
  assert.equal(wholePrOwed(null), false);
});
