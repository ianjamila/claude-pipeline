import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  SECURITY_CATEGORIES,
  BUCKETS,
  DECISIONS,
  CONFIDENCES,
  validateTriage,
  validateRulings,
  applyJudge,
  applyTestResult,
  arbiterNeeded,
  finalizeWithoutArbiter,
  applyRulings,
  reuseRuled,
  ruledCacheFrom,
  markLightLane,
  roundOutcome,
  reviewValidFor,
  applyOwnerRuling,
  isOwnerRuled,
  ownerRuledItems,
  fablePendingRounds,
  fableFindingItems,
  roundCapProblem,
  FABLE_FINDINGS_MAX,
} from '../pipeline/lib/triage.mjs';

// ---- fixtures -------------------------------------------------------------------------------

let seq = 0;
function item(over = {}) {
  seq += 1;
  return {
    id: `R1-B${seq}`,
    round: 1,
    bucket: 'BLOCKING',
    category: 'logic',
    title: `finding ${seq}`,
    file: 'src/a.js',
    line: 10,
    detail: 'detail',
    codexReasoning: 'codex reasoning',
    testable: false,
    fingerprint: `fp-${seq}`,
    judge: null,
    test: { status: 'none', evidence: '' },
    arbiter: null,
    final: null,
    implemented: false,
    followupIssue: null,
    ...over,
  };
}

function judge(decision, confidence = 'high', extra = {}) {
  return {
    decision,
    confidence,
    reason: `judge says ${decision}`,
    disputedBug: false,
    settleTest: { possible: false, plan: '' },
    ...extra,
  };
}

const judged = (bucket, decision, confidence = 'high', extra = {}, over = {}) =>
  item({ bucket, judge: judge(decision, confidence, extra), ...over });

const settled = (decision, by = 'judge', extra = {}) => ({
  decision,
  by,
  needsHuman: false,
  reason: 'because',
  ...extra,
});

function round(n, items, hash = 'h-final', over = {}) {
  return { n, fromHead: `from${n}`, toHead: `to${n}`, contentHashAtToHead: hash, items, ...over };
}

// ---- arbiterNeeded --------------------------------------------------------------------------

test('arbiterNeeded: BLOCKING ACCEPT high needs no arbiter', () => {
  assert.equal(arbiterNeeded(judged('BLOCKING', 'ACCEPT')), false);
});

test('arbiterNeeded: BLOCKING REJECT high needs the arbiter', () => {
  assert.equal(arbiterNeeded(judged('BLOCKING', 'REJECT')), true);
});

test('arbiterNeeded: BLOCKING downgraded to FOLLOW-UP needs the arbiter', () => {
  assert.equal(arbiterNeeded(judged('BLOCKING', 'FOLLOW-UP')), true);
});

test('arbiterNeeded: SUGGESTION FOLLOW-UP high needs the arbiter', () => {
  assert.equal(arbiterNeeded(judged('SUGGESTION', 'FOLLOW-UP')), true);
});

test('arbiterNeeded: SUGGESTION REJECT high needs the arbiter, ACCEPT high does not', () => {
  assert.equal(arbiterNeeded(judged('SUGGESTION', 'REJECT')), true);
  assert.equal(arbiterNeeded(judged('SUGGESTION', 'ACCEPT')), false);
});

test('arbiterNeeded: WORTH_CONSIDERING REJECT or FOLLOW-UP high needs no arbiter', () => {
  assert.equal(arbiterNeeded(judged('WORTH_CONSIDERING', 'REJECT')), false);
  assert.equal(arbiterNeeded(judged('WORTH_CONSIDERING', 'FOLLOW-UP')), false);
});

test('arbiterNeeded: low judge confidence needs the arbiter in every bucket and decision', () => {
  for (const bucket of BUCKETS) {
    for (const decision of DECISIONS) {
      assert.equal(
        arbiterNeeded(judged(bucket, decision, 'low')),
        true,
        `${bucket} ${decision} low`,
      );
    }
  }
});

test('arbiterNeeded: disputed bug confirmed by test is final ACCEPT by test, no arbiter', () => {
  // The judge doubted a Codex BLOCKING bug (REJECT) and proposed a test; the test fails => bug is real.
  const it = judged('BLOCKING', 'REJECT', 'high', {
    disputedBug: true,
    settleTest: { possible: true, plan: 'assert x' },
  });
  assert.equal(arbiterNeeded(it), true, 'before the test ran the arbiter would be needed');
  const after = applyTestResult(it, 'bug-confirmed', 'a.test.js > x: expected 1 got 2');
  assert.equal(after.final.decision, 'ACCEPT');
  assert.equal(after.final.by, 'test');
  assert.equal(after.final.needsHuman, false);
  assert.match(after.final.reason, /a\.test\.js > x: expected 1 got 2/);
  assert.equal(after.test.status, 'bug-confirmed');
  assert.equal(after.test.evidence, 'a.test.js > x: expected 1 got 2');
  assert.equal(arbiterNeeded(after), false);
});

test('applyTestResult: bug-disproved is final REJECT by test with the evidence in the reason', () => {
  const it = judged('SUGGESTION', 'ACCEPT', 'low', {
    disputedBug: true,
    settleTest: { possible: true, plan: 'p' },
  });
  const after = applyTestResult(it, 'bug-disproved', 'passes: handles empty list');
  assert.deepEqual(after.final, {
    decision: 'REJECT',
    by: 'test',
    needsHuman: false,
    reason: 'test disproved: passes: handles empty list',
  });
  assert.equal(after.test.status, 'bug-disproved');
  assert.equal(arbiterNeeded(after), false, 'a tested item never goes to the arbiter');
  assert.equal(it.final, null, 'input not mutated');
  assert.equal(it.test.status, 'none', 'input not mutated');
});

test('applyTestResult: a bug-disproved test on a security/auth/permissions/data item is needsHuman; a bug-confirmed one is not', () => {
  for (const category of ['security', 'auth', 'permissions', 'data-integrity', 'data-loss']) {
    const it = { ...judged('BLOCKING', 'REJECT', 'high', { disputedBug: true, settleTest: { possible: true, plan: 'p' } }), category };
    const disproved = applyTestResult(it, 'bug-disproved', 'x', { cmd: 'c', file: 'f', exitCode: 0, head: 'h' });
    assert.equal(disproved.final.needsHuman, true, category);
    assert.equal(disproved.final.decision, 'REJECT');
    assert.equal(disproved.final.by, 'test');
    assert.deepEqual(disproved.test, { status: 'bug-disproved', evidence: 'x', cmd: 'c', file: 'f', exitCode: 0, head: 'h' });
    assert.equal(applyTestResult(it, 'bug-confirmed', 'x').final.needsHuman, false, category);
  }
  const plain = { ...judged('BLOCKING', 'REJECT', 'high', {}), category: 'performance' };
  assert.equal(applyTestResult(plain, 'bug-disproved', 'x').final.needsHuman, false);
});

test('applyTestResult: rejects a status that is not a test outcome', () => {
  assert.throws(() => applyTestResult(item(), 'none', ''), /bug-confirmed|bug-disproved/);
  assert.throws(() => applyTestResult(item(), 'maybe', ''), /bug-confirmed|bug-disproved/);
});

test('arbiterNeeded: disputed bug with settleTest.possible false needs the arbiter', () => {
  const it = judged('WORTH_CONSIDERING', 'ACCEPT', 'high', {
    disputedBug: true,
    settleTest: { possible: false, plan: '' },
  });
  assert.equal(arbiterNeeded(it), true);
});

test('arbiterNeeded: disputed bug that a test can settle does not by itself need the arbiter', () => {
  const it = judged('WORTH_CONSIDERING', 'ACCEPT', 'high', {
    disputedBug: true,
    settleTest: { possible: true, plan: 'p' },
  });
  assert.equal(arbiterNeeded(it), false);
});

test('arbiterNeeded: a final already set (cache, light lane) or a test result means no arbiter', () => {
  const cached = judged('BLOCKING', 'REJECT', 'low', {}, { final: settled('REJECT', 'cache') });
  assert.equal(arbiterNeeded(cached), false);
  assert.equal(arbiterNeeded(cached, { force: true }), false, 'force does not reopen a final');
  const tested = judged('BLOCKING', 'REJECT', 'low', {}, { test: { status: 'bug-disproved', evidence: 'e' } });
  assert.equal(arbiterNeeded(tested), false);
  assert.equal(arbiterNeeded(tested, { force: true }), false);
});

test('arbiterNeeded: an item the judge has not triaged does not need the arbiter unless forced', () => {
  assert.equal(arbiterNeeded(item()), false);
  assert.equal(arbiterNeeded(item(), { force: true }), true);
});

test('arbiterNeeded: light lane SUGGESTION REJECT needs no arbiter but BLOCKING REJECT does', () => {
  const opts = { lightLane: true };
  assert.equal(arbiterNeeded(judged('SUGGESTION', 'REJECT'), opts), false);
  assert.equal(arbiterNeeded(judged('SUGGESTION', 'FOLLOW-UP'), opts), false);
  assert.equal(arbiterNeeded(judged('BLOCKING', 'REJECT'), opts), true);
  assert.equal(arbiterNeeded(judged('BLOCKING', 'FOLLOW-UP'), opts), true);
});

test('arbiterNeeded: light lane ignores low confidence, still arbitrates an untestable disputed BLOCKING', () => {
  const opts = { lightLane: true };
  assert.equal(arbiterNeeded(judged('BLOCKING', 'ACCEPT', 'low'), opts), false);
  assert.equal(arbiterNeeded(judged('SUGGESTION', 'ACCEPT', 'low'), opts), false);
  const disputed = { disputedBug: true, settleTest: { possible: false, plan: '' } };
  assert.equal(arbiterNeeded(judged('BLOCKING', 'ACCEPT', 'high', disputed), opts), true);
  assert.equal(arbiterNeeded(judged('SUGGESTION', 'ACCEPT', 'high', disputed), opts), false);
});

test('arbiterNeeded: force sends any untested, unsettled item to the arbiter, light lane or not', () => {
  const it = judged('BLOCKING', 'ACCEPT', 'high');
  assert.equal(arbiterNeeded(it), false);
  assert.equal(arbiterNeeded(it, { force: true }), true);
  assert.equal(arbiterNeeded(it, { force: true, lightLane: true }), true);
  assert.equal(arbiterNeeded(judged('WORTH_CONSIDERING', 'REJECT'), { force: true, lightLane: true }), true);
});

// ---- applyJudge / finalizeWithoutArbiter ----------------------------------------------------

test('applyJudge: sets judge from the triage output without mutating inputs', () => {
  const a = item({ id: 'R1-B1' });
  const b = item({ id: 'R1-S1', bucket: 'SUGGESTION' });
  const items = [a, b];
  const triage = {
    items: [
      { id: 'R1-B1', decision: 'ACCEPT', confidence: 'high', reason: 'real', disputedBug: false, settleTest: { possible: false, plan: '' } },
      { id: 'R1-S1', decision: 'REJECT', confidence: 'low', reason: 'meh', disputedBug: true, settleTest: { possible: true, plan: 'do x' } },
    ],
  };
  const out = applyJudge(items, triage);
  assert.deepEqual(out[0].judge, {
    decision: 'ACCEPT', confidence: 'high', reason: 'real', disputedBug: false, settleTest: { possible: false, plan: '' },
  });
  assert.deepEqual(out[1].judge, {
    decision: 'REJECT', confidence: 'low', reason: 'meh', disputedBug: true, settleTest: { possible: true, plan: 'do x' },
  });
  assert.equal(a.judge, null, 'input item not mutated');
  assert.equal(b.judge, null, 'input item not mutated');
  assert.notEqual(out[0], a);
  assert.equal(applyJudge(items, triage.items).length, 2, 'accepts the bare array too');
});

test('applyJudge: an item the judge did not mention is returned unchanged', () => {
  const a = item({ id: 'R1-B1' });
  const [out] = applyJudge([a], { items: [] });
  assert.deepEqual(out, a);
  assert.notEqual(out, a);
});

test('finalizeWithoutArbiter: judge decision becomes final where no arbiter is needed', () => {
  const ok = judged('BLOCKING', 'ACCEPT');
  const worth = judged('WORTH_CONSIDERING', 'REJECT');
  const [a, b] = finalizeWithoutArbiter([ok, worth]);
  assert.deepEqual(a.final, { decision: 'ACCEPT', by: 'judge', needsHuman: false, reason: 'judge says ACCEPT' });
  assert.deepEqual(b.final, { decision: 'REJECT', by: 'judge', needsHuman: false, reason: 'judge says REJECT' });
  assert.equal(ok.final, null, 'input not mutated');
});

test('finalizeWithoutArbiter: leaves arbiter-needed, untriaged and already-final items untouched', () => {
  const needs = judged('BLOCKING', 'REJECT');
  const low = judged('WORTH_CONSIDERING', 'ACCEPT', 'low');
  const untriaged = item();
  const cached = judged('SUGGESTION', 'ACCEPT', 'high', {}, { final: settled('REJECT', 'cache') });
  const out = finalizeWithoutArbiter([needs, low, untriaged, cached]);
  assert.equal(out[0].final, null);
  assert.equal(out[1].final, null);
  assert.equal(out[2].final, null);
  assert.equal(out[3].final.by, 'cache');
  assert.equal(out[3].final.decision, 'REJECT');
});

test('finalizeWithoutArbiter: honours light lane and force options', () => {
  const sugg = judged('SUGGESTION', 'REJECT');
  const blocking = judged('BLOCKING', 'REJECT');
  const [s, b] = finalizeWithoutArbiter([sugg, blocking], { lightLane: true });
  assert.equal(s.final.decision, 'REJECT');
  assert.equal(s.final.by, 'judge');
  assert.equal(b.final, null);
  const forced = finalizeWithoutArbiter([judged('BLOCKING', 'ACCEPT')], { force: true });
  assert.equal(forced[0].final, null);
});

// ---- applyRulings ---------------------------------------------------------------------------

const ruling = (id, r, confidence = 'high', reasoning = 'because of x') => ({ id, ruling: r, confidence, reasoning });

test('SECURITY_CATEGORIES is exactly the five security-class categories', () => {
  assert.deepEqual(SECURITY_CATEGORIES, ['security', 'auth', 'permissions', 'data-integrity', 'data-loss']);
});

test('applyRulings: REJECT high on a BLOCKING security-class item goes to a human', () => {
  // Literal list on purpose: importing the constant here would let a deleted category pass unnoticed.
  for (const category of ['security', 'auth', 'permissions', 'data-integrity', 'data-loss']) {
    const it = judged('BLOCKING', 'REJECT', 'high', {}, { id: 'R1-B1', category });
    const [out] = applyRulings([it], [ruling('R1-B1', 'REJECT')], { proofOk: true, transcript: 't.jsonl' });
    assert.equal(out.final.needsHuman, true, category);
    assert.equal(out.final.by, 'arbiter');
    assert.equal(out.final.reason, 'would dismiss a blocking security/data item');
  }
});

test('applyRulings: FOLLOW-UP on a BLOCKING security item also goes to a human', () => {
  const it = judged('BLOCKING', 'REJECT', 'high', {}, { id: 'R1-B1', category: 'auth' });
  const [out] = applyRulings([it], [ruling('R1-B1', 'FOLLOW-UP')], { proofOk: true });
  assert.equal(out.final.needsHuman, true);
});

test('applyRulings: ACCEPT high on a BLOCKING security item is a plain final ACCEPT', () => {
  const it = judged('BLOCKING', 'REJECT', 'high', {}, { id: 'R1-B1', category: 'security' });
  const [out] = applyRulings([it], [ruling('R1-B1', 'ACCEPT', 'high', 'real hole')], { proofOk: true, transcript: 't.jsonl' });
  assert.deepEqual(out.final, { decision: 'ACCEPT', by: 'arbiter', needsHuman: false, reason: 'real hole' });
});

test('applyRulings: REJECT high on a non-security BLOCKING, or on a security SUGGESTION, is final', () => {
  const logic = judged('BLOCKING', 'REJECT', 'high', {}, { id: 'R1-B1', category: 'logic' });
  const sugg = judged('SUGGESTION', 'REJECT', 'high', {}, { id: 'R1-S1', category: 'security' });
  const out = applyRulings(
    [logic, sugg],
    [ruling('R1-B1', 'REJECT', 'high', 'not a bug'), ruling('R1-S1', 'FOLLOW-UP', 'high', 'later')],
    { proofOk: true },
  );
  assert.deepEqual(out[0].final, { decision: 'REJECT', by: 'arbiter', needsHuman: false, reason: 'not a bug' });
  assert.deepEqual(out[1].final, { decision: 'FOLLOW-UP', by: 'arbiter', needsHuman: false, reason: 'later' });
});

test('applyRulings: arbiter low confidence goes to a human whatever the ruling', () => {
  const it = judged('SUGGESTION', 'REJECT', 'high', {}, { id: 'R1-S1' });
  for (const r of DECISIONS) {
    const [out] = applyRulings([it], [ruling('R1-S1', r, 'low')], { proofOk: true });
    assert.equal(out.final.needsHuman, true, r);
    assert.equal(out.final.reason, 'arbiter low confidence');
    assert.equal(out.final.by, 'arbiter');
  }
});

test('applyRulings: proofOk false sends every ruled item to a human with a model-proof reason', () => {
  const a = judged('BLOCKING', 'REJECT', 'high', {}, { id: 'R1-B1', category: 'logic' });
  const b = judged('SUGGESTION', 'FOLLOW-UP', 'high', {}, { id: 'R1-S1' });
  const c = judged('WORTH_CONSIDERING', 'ACCEPT', 'low', {}, { id: 'R1-W1' });
  const d = judged('BLOCKING', 'ACCEPT', 'high', {}, { id: 'R1-B2' });
  const out = applyRulings(
    [a, b, c, d],
    [ruling('R1-B1', 'ACCEPT'), ruling('R1-S1', 'REJECT'), ruling('R1-W1', 'REJECT')],
    { proofOk: false, transcript: 'bad.jsonl' },
  );
  for (const o of out.slice(0, 3)) {
    assert.equal(o.final.needsHuman, true);
    assert.match(o.final.reason, /model-proof/);
    assert.equal(o.final.by, 'arbiter');
  }
  // The unproven ruling must not leak into the decision: it falls back to the judge's.
  assert.equal(out[0].final.decision, 'REJECT');
  assert.equal(out[1].final.decision, 'FOLLOW-UP');
  assert.equal(out[2].final.decision, 'ACCEPT');
  // The ruling is still kept for the human to read.
  assert.equal(out[0].arbiter.ruling, 'ACCEPT');
  // An item the arbiter was not asked about is untouched.
  assert.equal(out[3].final, null);
  assert.equal(out[3].arbiter, null);
});

test('applyRulings: a missing proofOk fails closed', () => {
  const it = judged('SUGGESTION', 'REJECT', 'high', {}, { id: 'R1-S1' });
  const [out] = applyRulings([it], [ruling('R1-S1', 'REJECT')], {});
  assert.equal(out.final.needsHuman, true);
  assert.match(out.final.reason, /model-proof/);
});

test('applyRulings: stores the arbiter record with the transcript and does not mutate inputs', () => {
  const it = judged('SUGGESTION', 'REJECT', 'high', {}, { id: 'R1-S1' });
  const rulings = [ruling('R1-S1', 'ACCEPT', 'high', 'worth it')];
  const [out] = applyRulings([it], rulings, { proofOk: true, transcript: '/tmp/t.jsonl' });
  assert.deepEqual(out.arbiter, {
    ruling: 'ACCEPT', confidence: 'high', reasoning: 'worth it', transcript: '/tmp/t.jsonl',
  });
  assert.equal(it.arbiter, null);
  assert.equal(it.final, null);
  assert.equal(applyRulings([it], { rulings }, { proofOk: true })[0].final.decision, 'ACCEPT', 'accepts the {rulings} object too');
});

// ---- cache ----------------------------------------------------------------------------------

test('reuseRuled: a matching fingerprint, bucket and category reuses the earlier final, marked by cache', () => {
  const earlier = settled('REJECT', 'arbiter', { reason: 'not a bug' });
  const it = item({ fingerprint: 'same-fp' }); // BLOCKING, logic
  const [out] = reuseRuled([it], { 'same-fp': { ...earlier, bucket: 'BLOCKING', category: 'logic' } });
  assert.deepEqual(out.final, { ...earlier, by: 'cache' }, 'the bucket and category of the entry are not part of the final');
  assert.equal(it.final, null, 'input not mutated');
});

test('reuseRuled: a ruling is reused only for the same bucket AND category', () => {
  const entry = { ...settled('REJECT', 'arbiter'), bucket: 'WORTH_CONSIDERING', category: 'performance' };
  const cache = { fp: entry };
  const reused = (over) => reuseRuled([item({ fingerprint: 'fp', ...over })], cache)[0].final;
  assert.equal(reused({ bucket: 'WORTH_CONSIDERING', category: 'performance' }).by, 'cache');
  assert.equal(reused({ bucket: 'BLOCKING', category: 'performance' }), null, 'higher severity bucket');
  assert.equal(reused({ bucket: 'SUGGESTION', category: 'performance' }), null, 'other bucket');
  assert.equal(reused({ bucket: 'WORTH_CONSIDERING', category: 'bug' }), null, 'other category');
  assert.equal(reuseRuled([item({ fingerprint: 'fp', bucket: 'WORTH_CONSIDERING', category: 'performance' })], { fp: settled('REJECT', 'arbiter') })[0].final, null, 'an entry that does not say what it was ruled for');
});

test('reuseRuled: a dismissal of a security, auth, permissions or data category is never reused, an acceptance is', () => {
  for (const category of SECURITY_CATEGORIES) {
    for (const decision of ['REJECT', 'FOLLOW-UP']) {
      const cache = { fp: { ...settled(decision, 'arbiter'), bucket: 'BLOCKING', category } };
      assert.equal(reuseRuled([item({ fingerprint: 'fp', bucket: 'BLOCKING', category })], cache)[0].final, null, `${decision} ${category}`);
    }
    const accepted = { fp: { ...settled('ACCEPT', 'arbiter'), bucket: 'BLOCKING', category } };
    assert.equal(reuseRuled([item({ fingerprint: 'fp', bucket: 'BLOCKING', category })], accepted)[0].final.by, 'cache', `ACCEPT ${category}`);
  }
});

test('reuseRuled: the follow-up issue filed for the earlier item comes with the cached ruling', () => {
  const entry = { ...settled('FOLLOW-UP', 'judge'), bucket: 'BLOCKING', category: 'logic', followupIssue: 'https://x/1' };
  const [out] = reuseRuled([item({ fingerprint: 'fp' })], { fp: entry });
  assert.equal(out.followupIssue, 'https://x/1');
  assert.ok(!('followupIssue' in out.final) && !('bucket' in out.final));
  const [kept] = reuseRuled([item({ fingerprint: 'fp', followupIssue: 'https://x/own' })], { fp: entry });
  assert.equal(kept.followupIssue, 'https://x/own', 'an issue the item already has is not replaced');
});

test('reuseRuled: a different fingerprint (the code changed) is not reused', () => {
  const it = item({ fingerprint: 'new-fp' });
  const [out] = reuseRuled([it], { 'old-fp': settled('REJECT', 'arbiter') });
  assert.equal(out.final, null);
});

test('reuseRuled: never replaces a final already set, and ignores items without a fingerprint', () => {
  const own = item({ fingerprint: 'fp-x', final: settled('ACCEPT', 'test') });
  const none = item({ fingerprint: '' });
  const proto = item({ fingerprint: 'constructor' });
  const out = reuseRuled([own, none, proto], { 'fp-x': settled('REJECT', 'arbiter'), '': settled('REJECT', 'arbiter') });
  assert.equal(out[0].final.by, 'test');
  assert.equal(out[1].final, null);
  assert.equal(out[2].final, null);
});

test('ruledCacheFrom: keeps settled finals, drops pending and needs-human ones', () => {
  const ok = item({ fingerprint: 'a', final: settled('REJECT', 'arbiter') });
  const human = item({ fingerprint: 'b', final: settled('REJECT', 'arbiter', { needsHuman: true }) });
  const pending = item({ fingerprint: 'c' });
  const cache = ruledCacheFrom([ok, human, pending]);
  assert.deepEqual(Object.keys(cache), ['a']);
  assert.equal(cache.a.decision, 'REJECT');
  assert.deepEqual([cache.a.bucket, cache.a.category], [ok.bucket, ok.category], 'the entry remembers what it was ruled for');
  // Round trip: a cache built from round N pre-fills the same item in round N+1.
  const [again] = reuseRuled([item({ fingerprint: 'a' })], cache);
  assert.equal(again.final.by, 'cache');
});

test('ruledCacheFrom: the follow-up issue of an item (or of an earlier item with the same fingerprint) is kept', () => {
  const filed = item({ fingerprint: 'fp', final: settled('FOLLOW-UP', 'judge'), followupIssue: 'https://x/9' });
  const again = item({ fingerprint: 'fp', final: settled('FOLLOW-UP', 'cache') });
  assert.equal(ruledCacheFrom([filed, again]).fp.followupIssue, 'https://x/9');
  assert.equal(ruledCacheFrom([item({ fingerprint: 'z', final: settled('REJECT', 'judge') })]).z.followupIssue, undefined);
});

test('markLightLane: untriaged WORTH_CONSIDERING items are rejected by the light lane', () => {
  const w = item({ bucket: 'WORTH_CONSIDERING' });
  const wDone = item({ bucket: 'WORTH_CONSIDERING', final: settled('FOLLOW-UP', 'cache') });
  const s = item({ bucket: 'SUGGESTION' });
  const out = markLightLane([w, wDone, s]);
  assert.deepEqual(out[0].final, {
    decision: 'REJECT', by: 'light-lane', needsHuman: false, reason: 'light lane — not triaged',
  });
  assert.equal(out[1].final.by, 'cache');
  assert.equal(out[2].final, null);
  assert.equal(w.final, null, 'input not mutated');
});

// ---- validators -----------------------------------------------------------------------------

const goodTriage = (...ids) => ({
  items: ids.map((id) => ({
    id, decision: 'ACCEPT', confidence: 'high', reason: 'r', disputedBug: false, settleTest: { possible: false, plan: '' },
  })),
});

test('validateTriage: accepts a complete, well-formed judge output', () => {
  assert.deepEqual(validateTriage(goodTriage('R1-B1', 'R1-S1'), ['R1-B1', 'R1-S1']), { ok: true, errors: [] });
});

test('validateTriage: catches a missing id', () => {
  const r = validateTriage(goodTriage('R1-B1'), ['R1-B1', 'R1-S1']);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /missing/i.test(e) && e.includes('R1-S1')), r.errors.join('\n'));
});

test('validateTriage: catches a duplicate id', () => {
  const r = validateTriage(goodTriage('R1-B1', 'R1-B1'), ['R1-B1']);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /duplicate/i.test(e) && e.includes('R1-B1')), r.errors.join('\n'));
});

test('validateTriage: catches an unknown id', () => {
  const r = validateTriage(goodTriage('R1-B1', 'R9-X9'), ['R1-B1']);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /unknown/i.test(e) && e.includes('R9-X9')), r.errors.join('\n'));
});

test('validateTriage: catches a bad enum, a non-boolean disputedBug and a malformed settleTest', () => {
  const bad = (patch) => {
    const j = goodTriage('R1-B1');
    Object.assign(j.items[0], patch);
    return validateTriage(j, ['R1-B1']);
  };
  let r = bad({ decision: 'MAYBE' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /decision/.test(e)), r.errors.join('\n'));
  r = bad({ decision: 'accept' });
  assert.equal(r.ok, false, 'enums are case-sensitive');
  r = bad({ confidence: 'Medium' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /confidence/.test(e)));
  r = bad({ disputedBug: 'yes' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /disputedBug/.test(e)));
  r = bad({ settleTest: undefined });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /settleTest/.test(e)));
  r = bad({ settleTest: { possible: 'no', plan: '' } });
  assert.equal(r.ok, false);
  r = bad({ settleTest: { possible: true } });
  assert.equal(r.ok, false);
  r = bad({ reason: 42 });
  assert.equal(r.ok, false);
});

test('validateTriage: rejects output that is not {items: [...]}', () => {
  for (const j of [null, undefined, 'x', [], {}, { items: 'x' }, { items: [null] }]) {
    const r = validateTriage(j, ['R1-B1']);
    assert.equal(r.ok, false, JSON.stringify(j));
    assert.ok(r.errors.length > 0);
  }
});

test('validateTriage: an empty item list is valid only when there is nothing to triage', () => {
  assert.equal(validateTriage({ items: [] }, []).ok, true);
  assert.equal(validateTriage({ items: [] }, ['R1-B1']).ok, false);
});

test('validateRulings: accepts a complete set and catches missing, duplicate, unknown and bad enums', () => {
  const good = { rulings: [ruling('R1-B1', 'ACCEPT'), ruling('R1-S1', 'REJECT', 'low')] };
  assert.deepEqual(validateRulings(good, ['R1-B1', 'R1-S1']), { ok: true, errors: [] });

  const missing = validateRulings({ rulings: [ruling('R1-B1', 'ACCEPT')] }, ['R1-B1', 'R1-S1']);
  assert.equal(missing.ok, false);
  assert.ok(missing.errors.some((e) => /missing/i.test(e) && e.includes('R1-S1')));

  const dup = validateRulings({ rulings: [ruling('R1-B1', 'ACCEPT'), ruling('R1-B1', 'REJECT')] }, ['R1-B1']);
  assert.equal(dup.ok, false);
  assert.ok(dup.errors.some((e) => /duplicate/i.test(e)));

  const unknown = validateRulings({ rulings: [ruling('R1-B1', 'ACCEPT'), ruling('R2-B9', 'ACCEPT')] }, ['R1-B1']);
  assert.equal(unknown.ok, false);
  assert.ok(unknown.errors.some((e) => /unknown/i.test(e) && e.includes('R2-B9')));

  assert.equal(validateRulings({ rulings: [ruling('R1-B1', 'NOPE')] }, ['R1-B1']).ok, false);
  assert.equal(validateRulings({ rulings: [ruling('R1-B1', 'ACCEPT', 'Medium')] }, ['R1-B1']).ok, false);
  assert.equal(validateRulings({ rulings: [{ id: 'R1-B1', ruling: 'ACCEPT', confidence: 'high' }] }, ['R1-B1']).ok, false);
  assert.equal(validateRulings(null, ['R1-B1']).ok, false);
  assert.equal(validateRulings({}, ['R1-B1']).ok, false);
});

test('schemas on disk list exactly the enums the validators enforce', () => {
  const read = (f) => JSON.parse(readFileSync(fileURLToPath(new URL(`../pipeline/schemas/${f}`, import.meta.url)), 'utf8'));
  const t = read('triage.schema.json');
  const r = read('rulings.schema.json');
  assert.equal(t.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(r.$schema, 'https://json-schema.org/draft/2020-12/schema');
  const tItem = t.properties.items.items;
  assert.deepEqual(tItem.properties.decision.enum, DECISIONS);
  assert.deepEqual(tItem.properties.confidence.enum, CONFIDENCES);
  assert.deepEqual(
    [...tItem.required].sort(),
    ['confidence', 'decision', 'disputedBug', 'id', 'reason', 'settleTest'],
  );
  assert.deepEqual([...tItem.properties.settleTest.required].sort(), ['plan', 'possible']);
  assert.deepEqual(t.required, ['items']);
  const rItem = r.properties.rulings.items;
  assert.deepEqual(rItem.properties.ruling.enum, DECISIONS);
  assert.deepEqual(rItem.properties.confidence.enum, CONFIDENCES);
  assert.deepEqual([...rItem.required].sort(), ['confidence', 'id', 'reasoning', 'ruling']);
  assert.deepEqual(r.required, ['rulings']);
});

// ---- roundOutcome ---------------------------------------------------------------------------

const stateOf = (rounds, extra = {}) => ({ rounds, maxRounds: 3, currentContentHash: 'h-final', ...extra });

test('roundOutcome: clean when every item is settled, nothing accepted, and the hash matches', () => {
  const items = [
    item({ id: 'R2-B1', bucket: 'BLOCKING', final: settled('REJECT', 'arbiter') }),
    item({ id: 'R2-S1', bucket: 'SUGGESTION', final: settled('FOLLOW-UP', 'arbiter') }),
    item({ id: 'R2-W1', bucket: 'WORTH_CONSIDERING', final: settled('REJECT', 'judge') }),
  ];
  const o = roundOutcome(stateOf([round(1, []), round(2, items)]));
  assert.deepEqual(o, {
    clean: true, openBlocking: [], newAccepted: [], needsHuman: [], pending: [], unimplemented: [], reachedMax: false, extraRound: false, effectiveMaxRounds: 3, coverageValid: true, fablePending: [],
  });
});

test('roundOutcome: a round with no findings at all is clean when coverage is valid', () => {
  assert.equal(roundOutcome(stateOf([round(1, [])])).clean, true);
});

test('roundOutcome: an ACCEPT in the last round is never clean, even once implemented', () => {
  const blocking = item({ id: 'R1-B1', bucket: 'BLOCKING', final: settled('ACCEPT', 'judge') });
  let o = roundOutcome(stateOf([round(1, [blocking])]));
  assert.equal(o.clean, false);
  assert.deepEqual(o.openBlocking, ['R1-B1']);
  assert.deepEqual(o.newAccepted, ['R1-B1']);

  const fixed = { ...blocking, implemented: true };
  o = roundOutcome(stateOf([round(1, [fixed])]));
  assert.deepEqual(o.openBlocking, [], 'implemented BLOCKING is no longer open');
  assert.deepEqual(o.newAccepted, ['R1-B1'], 'but the fix still needs a further review round');
  assert.equal(o.clean, false);

  const sugg = item({ id: 'R1-S1', bucket: 'SUGGESTION', final: settled('ACCEPT', 'arbiter'), implemented: true });
  o = roundOutcome(stateOf([round(1, [sugg])]));
  assert.deepEqual(o.newAccepted, ['R1-S1']);
  assert.deepEqual(o.openBlocking, []);
  assert.equal(o.clean, false);
});

test('roundOutcome: an ACCEPT reused from the cache is not "new", but an unimplemented BLOCKING one stays open', () => {
  const cachedSugg = item({ id: 'R2-S1', bucket: 'SUGGESTION', final: settled('ACCEPT', 'cache'), implemented: true });
  let o = roundOutcome(stateOf([round(2, [cachedSugg])]));
  assert.deepEqual(o.newAccepted, []);
  assert.equal(o.clean, true);

  const cachedBlocking = item({ id: 'R2-B1', bucket: 'BLOCKING', final: settled('ACCEPT', 'cache') });
  o = roundOutcome(stateOf([round(2, [cachedBlocking])]));
  assert.deepEqual(o.newAccepted, []);
  assert.deepEqual(o.openBlocking, ['R2-B1']);
  assert.equal(o.clean, false);
});

test('roundOutcome: a BLOCKING item without a final is open and pending', () => {
  const o = roundOutcome(stateOf([round(1, [item({ id: 'R1-B1', bucket: 'BLOCKING' }), item({ id: 'R1-S1', bucket: 'SUGGESTION' })])]));
  assert.deepEqual(o.openBlocking, ['R1-B1']);
  assert.deepEqual(o.pending, ['R1-B1', 'R1-S1']);
  assert.equal(o.clean, false);
});

test('roundOutcome: needsHuman is never clean', () => {
  const human = item({ id: 'R1-B1', bucket: 'BLOCKING', category: 'security', final: settled('REJECT', 'arbiter', { needsHuman: true }) });
  const o = roundOutcome(stateOf([round(1, [human])]));
  assert.deepEqual(o.needsHuman, ['R1-B1']);
  assert.equal(o.clean, false);
});

test('roundOutcome: coverage mismatch is not clean', () => {
  const items = [item({ id: 'R1-S1', bucket: 'SUGGESTION', final: settled('REJECT', 'judge') })];
  let o = roundOutcome(stateOf([round(1, items, 'h-old')]));
  assert.equal(o.coverageValid, false);
  assert.equal(o.clean, false);
  // Both hashes must be non-empty for coverage to count.
  o = roundOutcome(stateOf([round(1, items, '')], { currentContentHash: '' }));
  assert.equal(o.coverageValid, false);
  assert.equal(o.clean, false);
  o = roundOutcome(stateOf([round(1, items, 'h-final')], { currentContentHash: undefined }));
  assert.equal(o.coverageValid, false);
  assert.equal(o.clean, false);
});

test('roundOutcome: newAccepted is last-round only, an implemented earlier ACCEPT does not block', () => {
  const messy = [item({ id: 'R1-B1', bucket: 'BLOCKING', final: settled('ACCEPT', 'judge'), implemented: true })];
  const o = roundOutcome(stateOf([round(1, messy, 'h-1'), round(2, [], 'h-final')]));
  assert.equal(o.clean, true);
});

// One extra round past the cap, only when the last round's sole open items are accepted fixes already implemented.
const fixed = (n) => item({ id: `R${n}-B1`, bucket: 'BLOCKING', final: settled('ACCEPT', 'judge'), implemented: true });
const upTo = (n, last, hash = 'h-final') => [...Array.from({ length: n - 1 }, (_, i) => round(i + 1, [fixed(i + 1)])), round(n, last, hash)];
const extraCases = [
  ['at the cap, only implemented new accepts and a stale hash', () => stateOf(upTo(3, [fixed(3)], 'h-old')), { extraRound: true, reachedMax: false, effectiveMaxRounds: 4, clean: false }],
  ['at the cap with an unimplemented accept too', () => stateOf(upTo(3, [fixed(3), item({ id: 'R3-S1', bucket: 'SUGGESTION', final: settled('ACCEPT', 'judge') })], 'h-old')), { extraRound: false, reachedMax: true, effectiveMaxRounds: 3 }],
  ['at the cap with a needsHuman item', () => stateOf(upTo(3, [fixed(3), item({ id: 'R3-B2', final: settled('REJECT', 'arbiter', { needsHuman: true }) })], 'h-old')), { extraRound: false, reachedMax: true, effectiveMaxRounds: 3 }],
  ['at the cap with an open BLOCKING accept', () => stateOf(upTo(3, [fixed(3), item({ id: 'R3-B2', bucket: 'BLOCKING', final: settled('ACCEPT', 'judge') })], 'h-old')), { extraRound: false, reachedMax: true, effectiveMaxRounds: 3 }],
  ['at the cap with a pending item', () => stateOf(upTo(3, [fixed(3), item({ id: 'R3-S1', bucket: 'SUGGESTION' })], 'h-old')), { extraRound: false, reachedMax: true, effectiveMaxRounds: 3 }],
  ['at the cap, no new accepts, only a stale hash', () => stateOf(upTo(3, [item({ id: 'R3-S1', bucket: 'SUGGESTION', final: settled('REJECT') })], 'h-old')), { extraRound: false, reachedMax: true, effectiveMaxRounds: 3 }],
  ['the extra round (4) accepted again', () => stateOf(upTo(4, [fixed(4)])), { extraRound: false, reachedMax: true, effectiveMaxRounds: 4, clean: false }],
  ['the extra round (4) is clean', () => stateOf(upTo(4, [])), { extraRound: false, reachedMax: false, effectiveMaxRounds: 4, clean: true }],
  ['below the cap with new accepts', () => stateOf(upTo(2, [fixed(2)])), { extraRound: false, reachedMax: false, effectiveMaxRounds: 3, clean: false }],
  ['no maxRounds', () => stateOf(upTo(3, [fixed(3)]), { maxRounds: undefined }), { extraRound: false, reachedMax: false, effectiveMaxRounds: null }],
];
for (const [name, build, want] of extraCases) {
  test(`roundOutcome extraRound: ${name}`, () => {
    const o = roundOutcome(build());
    for (const [k, v] of Object.entries(want)) assert.equal(o[k], v, `${k}`);
  });
}

test('roundOutcome: no rounds yet is not clean', () => {
  const o = roundOutcome(stateOf([]));
  assert.equal(o.clean, false);
  assert.equal(o.coverageValid, false);
  assert.equal(o.reachedMax, false);
});

test('roundOutcome: reachedMax after the extra round is also unclean, not before, and not when clean', () => {
  const accepting = (n) => round(n, [item({ id: `R${n}-B1`, bucket: 'BLOCKING', final: settled('ACCEPT', 'judge'), implemented: true })]);
  assert.equal(roundOutcome(stateOf([accepting(1), accepting(2)])).reachedMax, false);
  // three rounds whose last only accepted implemented fixes: one extra round, not a park
  const three = roundOutcome(stateOf([accepting(1), accepting(2), accepting(3)]));
  assert.equal(three.reachedMax, false);
  assert.equal(three.extraRound, true);
  assert.equal(three.clean, false);
  const four = roundOutcome(stateOf([accepting(1), accepting(2), accepting(3), accepting(4)]));
  assert.equal(four.reachedMax, true);
  assert.equal(four.extraRound, false);
  assert.equal(four.clean, false);
  const cleanThird = roundOutcome(stateOf([accepting(1), accepting(2), round(3, [])]));
  assert.equal(cleanThird.clean, true);
  assert.equal(cleanThird.reachedMax, false, 'a clean exit on the last allowed round is not a failure');
});

// ---- reviewValidFor -------------------------------------------------------------------------

test('reviewValidFor: true when a round is fully settled, accepts nothing new, and covers the content hash', () => {
  const items = [
    item({ bucket: 'BLOCKING', final: settled('REJECT', 'arbiter') }),
    item({ bucket: 'SUGGESTION', final: settled('FOLLOW-UP', 'judge') }),
    item({ bucket: 'SUGGESTION', final: settled('ACCEPT', 'cache'), implemented: true }),
  ];
  const s = stateOf([round(1, items, 'h-final')]);
  assert.equal(reviewValidFor(s, 'h-final'), true);
  assert.equal(reviewValidFor(stateOf([round(1, [], 'h-final')]), 'h-final'), true);
});

test('reviewValidFor: false for another content hash, an empty hash, or no rounds', () => {
  const s = stateOf([round(1, [], 'h-final')]);
  assert.equal(reviewValidFor(s, 'h-other'), false);
  assert.equal(reviewValidFor(s, ''), false);
  assert.equal(reviewValidFor(s, undefined), false);
  assert.equal(reviewValidFor(stateOf([]), 'h-final'), false);
  assert.equal(reviewValidFor({}, 'h-final'), false);
});

test('reviewValidFor: false while an item is pending, needs a human, or was newly accepted', () => {
  const check = (it) => reviewValidFor(stateOf([round(1, [it], 'h-final')]), 'h-final');
  assert.equal(check(item({ bucket: 'SUGGESTION' })), false, 'pending');
  assert.equal(check(item({ final: settled('REJECT', 'arbiter', { needsHuman: true }) })), false, 'needsHuman');
  assert.equal(check(item({ bucket: 'SUGGESTION', final: settled('ACCEPT', 'judge'), implemented: true })), false, 'ACCEPT by judge');
  assert.equal(check(item({ bucket: 'BLOCKING', final: settled('ACCEPT', 'arbiter'), implemented: true })), false, 'ACCEPT by arbiter');
  assert.equal(check(item({ bucket: 'BLOCKING', final: settled('ACCEPT', 'test'), implemented: true })), false, 'ACCEPT by test');
});

test('reviewValidFor: an unimplemented BLOCKING ACCEPT reused from the cache is not a valid review', () => {
  const it = item({ bucket: 'BLOCKING', final: settled('ACCEPT', 'cache') });
  assert.equal(reviewValidFor(stateOf([round(1, [it], 'h-final')]), 'h-final'), false);
  assert.equal(roundOutcome(stateOf([round(1, [it], 'h-final')])).clean, false, 'agrees with roundOutcome');
});

test('reviewValidFor: a later round with an unsettled BLOCKING item invalidates an earlier clean round', () => {
  const good = round(1, [item({ final: settled('REJECT', 'judge') })], 'h-final');
  const later = round(2, [item({ bucket: 'BLOCKING' })], 'h-later');
  assert.equal(reviewValidFor(stateOf([good, later]), 'h-final'), false);
  assert.equal(reviewValidFor(stateOf([good, later]), 'h-later'), false);
  // And an earlier round does not need to be the one whose hash matches.
  const earlierOk = round(1, [item({ final: settled('REJECT', 'judge') })], 'h-1');
  const laterOk = round(2, [], 'h-final');
  assert.equal(reviewValidFor(stateOf([earlierOk, laterOk]), 'h-final'), true);
});

test('reviewValidFor: only the MOST RECENT clean round counts: a later round that accepted something invalidates an earlier clean match (R3\')', () => {
  const clean = round(1, [item({ final: settled('REJECT', 'judge') })], 'h-final');
  const accepting = round(2, [item({ bucket: 'SUGGESTION', final: settled('ACCEPT', 'judge'), implemented: true })], 'h-other');
  // everything is resolved and implemented, but round 2 was not clean and round 1's content is the current one again
  assert.equal(reviewValidFor(stateOf([clean, accepting]), 'h-final'), false);
  assert.equal(reviewValidFor(stateOf([clean, accepting]), 'h-other'), false);
  // once a clean round 3 reviews the fix, that round decides
  const third = round(3, [], 'h-third');
  assert.equal(reviewValidFor(stateOf([clean, accepting, third]), 'h-third'), true);
  assert.equal(reviewValidFor(stateOf([clean, accepting, third]), 'h-final'), false, 'an older clean round no longer vouches');
});

// ---- review fixes: fail-closed rules --------------------------------------------------------

// -- 1. roll-ups across ALL rounds

test('roundOutcome: a needsHuman item in an EARLIER round keeps the outcome unclean', () => {
  const human = item({ id: 'R1-S1', bucket: 'SUGGESTION', final: settled('REJECT', 'arbiter', { needsHuman: true }) });
  const s = stateOf([round(1, [human], 'h-1'), round(2, [], 'h-final')]);
  const o = roundOutcome(s);
  assert.equal(o.coverageValid, true);
  assert.deepEqual(o.needsHuman, ['R1-S1']);
  assert.equal(o.clean, false);
  assert.equal(reviewValidFor(s, 'h-final'), false);
  assert.equal(reviewValidFor(s, 'h-1'), false);
});

test('roundOutcome: a BLOCKING item without a final in an EARLIER round stays open', () => {
  const s = stateOf([round(1, [item({ id: 'R1-B1', bucket: 'BLOCKING' })], 'h-1'), round(2, [], 'h-final')]);
  const o = roundOutcome(s);
  assert.deepEqual(o.openBlocking, ['R1-B1']);
  assert.equal(o.clean, false);
  assert.equal(reviewValidFor(s, 'h-final'), false);
});

test('roundOutcome: an unimplemented ACCEPT of ANY bucket in an earlier round keeps it unclean', () => {
  for (const bucket of ['BLOCKING', 'SUGGESTION', 'WORTH_CONSIDERING']) {
    const accepted = item({ id: 'R1-X1', bucket, final: settled('ACCEPT', 'judge') });
    const s = stateOf([round(1, [accepted], 'h-1'), round(2, [], 'h-final')]);
    const o = roundOutcome(s);
    assert.deepEqual(o.unimplemented, ['R1-X1'], bucket);
    assert.deepEqual(o.newAccepted, [], 'newAccepted stays last-round only');
    assert.equal(o.clean, false, bucket);
    assert.equal(reviewValidFor(s, 'h-final'), false, bucket);
  }
});

test('roundOutcome: an unimplemented ACCEPT reused from the cache in the last round is not clean', () => {
  const cached = item({ id: 'R2-S1', bucket: 'SUGGESTION', final: settled('ACCEPT', 'cache') });
  const s = stateOf([round(2, [cached], 'h-final')]);
  const o = roundOutcome(s);
  assert.deepEqual(o.newAccepted, []);
  assert.deepEqual(o.unimplemented, ['R2-S1']);
  assert.equal(o.clean, false);
  assert.equal(reviewValidFor(s, 'h-final'), false);
});

test('roundOutcome: the normal flow (round 1 accepted and implemented, round 2 reviews the fix) is clean', () => {
  const fixed = item({ id: 'R1-B1', bucket: 'BLOCKING', final: settled('ACCEPT', 'judge'), implemented: true });
  const s = stateOf([round(1, [fixed], 'h-1'), round(2, [], 'h-final')]);
  const o = roundOutcome(s);
  assert.equal(o.clean, true);
  assert.deepEqual(o.unimplemented, []);
  assert.equal(reviewValidFor(s, 'h-final'), true);
});

test('roundOutcome: a pending item that is not BLOCKING keeps the round unclean on its own', () => {
  const o = roundOutcome(stateOf([round(1, [item({ id: 'R1-S1', bucket: 'SUGGESTION' })])]));
  assert.deepEqual(o.pending, ['R1-S1']);
  assert.deepEqual(o.openBlocking, []);
  assert.deepEqual(o.needsHuman, []);
  assert.deepEqual(o.newAccepted, []);
  assert.equal(o.coverageValid, true);
  assert.equal(o.clean, false);
  const w = roundOutcome(stateOf([round(1, [item({ id: 'R1-W1', bucket: 'WORTH_CONSIDERING' })])]));
  assert.equal(w.clean, false);
});

test('roundOutcome: a pending non-BLOCKING item in an earlier round keeps it unclean', () => {
  const s = stateOf([round(1, [item({ id: 'R1-S1', bucket: 'SUGGESTION' })], 'h-1'), round(2, [], 'h-final')]);
  assert.equal(roundOutcome(s).clean, false);
  assert.equal(reviewValidFor(s, 'h-final'), false);
});

test('roundOutcome: each of needsHuman / newAccepted alone makes the round unclean', () => {
  const human = item({ id: 'R1-S1', bucket: 'SUGGESTION', final: settled('REJECT', 'arbiter', { needsHuman: true }) });
  const o1 = roundOutcome(stateOf([round(1, [human])]));
  assert.deepEqual([o1.pending, o1.openBlocking, o1.newAccepted], [[], [], []]);
  assert.equal(o1.clean, false);
  const acc = item({ id: 'R1-S2', bucket: 'SUGGESTION', final: settled('ACCEPT', 'judge'), implemented: true });
  const o2 = roundOutcome(stateOf([round(1, [acc])]));
  assert.deepEqual([o2.pending, o2.openBlocking, o2.needsHuman, o2.unimplemented], [[], [], [], []]);
  assert.equal(o2.clean, false);
});

test('reviewValidFor: undefined content hash never matches a round whose hash is undefined', () => {
  const noHash = { n: 1, fromHead: 'a', toHead: 'b', items: [] };
  assert.equal(reviewValidFor({ rounds: [noHash], currentContentHash: undefined }, undefined), false);
  assert.equal(reviewValidFor({ rounds: [{ ...noHash, contentHashAtToHead: undefined }] }, undefined), false);
  assert.equal(reviewValidFor({ rounds: [{ ...noHash, contentHashAtToHead: null }] }, null), false);
  assert.equal(reviewValidFor({ rounds: [{ ...noHash, contentHashAtToHead: '' }] }, ''), false);
});

// -- 2. fail closed on invalid model output

test('arbiterNeeded: any confidence other than exactly "high" counts as low', () => {
  for (const confidence of ['HIGH', 'High', 'medium', 'low', '', undefined, null, 1, true]) {
    // Built explicitly: judged() would turn an undefined confidence back into the 'high' default.
    const mkItem = (bucket) => item({ bucket, judge: { ...judge('ACCEPT'), confidence } });
    assert.equal(arbiterNeeded(mkItem('BLOCKING')), true, String(confidence));
    assert.equal(arbiterNeeded(mkItem('WORTH_CONSIDERING')), true, String(confidence));
  }
  assert.equal(arbiterNeeded(judged('BLOCKING', 'ACCEPT', 'high')), false);
  // Light lane still ignores low confidence for non-disputed items, valid or not.
  assert.equal(arbiterNeeded(judged('BLOCKING', 'ACCEPT', 'HIGH'), { lightLane: true }), false);
});

test('applyJudge: a decision outside ACCEPT|FOLLOW-UP|REJECT sends the item to a human', () => {
  for (const decision of ['accept', 'Accept', 'MAYBE', 'FOLLOWUP', '', undefined, null, 3]) {
    const a = item({ id: 'R1-B1' });
    const [out] = applyJudge([a], { items: [{ id: 'R1-B1', decision, confidence: 'high', reason: 'r', disputedBug: false, settleTest: { possible: false, plan: '' } }] });
    assert.equal(out.final.needsHuman, true, String(decision));
    assert.equal(out.final.reason, 'invalid judge output');
    assert.equal(out.final.by, 'judge');
    assert.ok(!['ACCEPT', 'FOLLOW-UP', 'REJECT'].includes(out.final.decision), 'no decision is invented');
    assert.equal(roundOutcome({ rounds: [round(1, [out])], maxRounds: 3, currentContentHash: 'h-final' }).clean, false);
  }
  // A valid decision still leaves final alone (the arbiter / finalize step decides).
  const [ok] = applyJudge([item({ id: 'R1-B1' })], goodTriage('R1-B1'));
  assert.equal(ok.final, null);
});

test('applyJudge: an invalid judge entry never overwrites a final already set by a test or the cache', () => {
  const tested = applyTestResult(item({ id: 'R1-B1' }), 'bug-confirmed', 'e');
  const [out] = applyJudge([tested], { items: [{ id: 'R1-B1', decision: 'nope', confidence: 'high', reason: 'r', disputedBug: false, settleTest: { possible: false, plan: '' } }] });
  assert.equal(out.final.by, 'test');
  assert.equal(out.final.needsHuman, false);
});

test('finalizeWithoutArbiter: an invalid judge decision that skipped validation goes to a human', () => {
  const it = item({ bucket: 'WORTH_CONSIDERING', judge: { ...judge('ACCEPT'), decision: 'accept' } });
  const [out] = finalizeWithoutArbiter([it]);
  assert.equal(out.final.needsHuman, true);
  assert.equal(out.final.reason, 'invalid judge output');
});

test('applyRulings: a ruling or confidence outside the enums goes to a human (case-sensitive)', () => {
  const cases = [
    ['accept', 'high'], ['Reject', 'high'], ['FOLLOWUP', 'high'], [undefined, 'high'], [null, 'high'], ['', 'high'],
    ['ACCEPT', 'HIGH'], ['ACCEPT', 'Medium'], ['ACCEPT', undefined], ['ACCEPT', null], ['ACCEPT', ''],
  ];
  for (const [r, confidence] of cases) {
    const it = judged('SUGGESTION', 'REJECT', 'high', {}, { id: 'R1-S1' });
    const [out] = applyRulings([it], [{ id: 'R1-S1', ruling: r, confidence, reasoning: 'x' }], { proofOk: true, transcript: 't' });
    assert.equal(out.final.needsHuman, true, `${r}/${confidence}`);
    assert.equal(out.final.reason, 'invalid arbiter output');
    assert.equal(out.final.by, 'arbiter');
    assert.equal(out.final.decision, 'REJECT', 'falls back to the judge decision, never the invalid ruling');
  }
  // Valid pair is unaffected.
  const it = judged('SUGGESTION', 'REJECT', 'high', {}, { id: 'R1-S1' });
  assert.equal(applyRulings([it], [ruling('R1-S1', 'ACCEPT', 'high')], { proofOk: true })[0].final.needsHuman, false);
});

test('applyRulings: with no usable judge decision an invalid ruling leaves final.decision null, never the invalid text', () => {
  const [out] = applyRulings([item({ id: 'R1-S1', bucket: 'SUGGESTION' })], [{ id: 'R1-S1', ruling: 'sure', confidence: 'high', reasoning: 'x' }], { proofOk: true });
  assert.equal(out.final.decision, null);
  assert.equal(out.final.needsHuman, true);
});

test('applyRulings: a failed proof never turns an unusable ruling or judge decision into a decision', () => {
  const bad = { id: 'R1-S1', ruling: 'garbage', confidence: 'high', reasoning: 'x' };
  const noJudge = item({ id: 'R1-S1', bucket: 'SUGGESTION' });
  const badJudge = item({ id: 'R1-S1', bucket: 'SUGGESTION', judge: { ...judge('ACCEPT'), decision: 'accept' } });
  for (const it of [noJudge, badJudge]) {
    const [out] = applyRulings([it], [bad], { proofOk: false, transcript: 't' });
    assert.equal(out.final.decision, null);
    assert.equal(out.final.needsHuman, true);
    assert.match(out.final.reason, /model-proof/);
  }
  // With nothing else to go on, a well-formed (if unproven) ruling is shown to the human as-is.
  const [shown] = applyRulings([noJudge], [ruling('R1-S1', 'REJECT')], { proofOk: false });
  assert.equal(shown.final.decision, 'REJECT');
  assert.equal(shown.final.needsHuman, true);
});

// -- 3. a test outranks any opinion

test('applyRulings: never overwrites an item a test already settled', () => {
  const tested = applyTestResult(judged('BLOCKING', 'REJECT', 'high', {}, { id: 'R1-B1', category: 'security' }), 'bug-confirmed', 'fails: x');
  for (const proofOk of [true, false]) {
    const [out] = applyRulings([tested], [ruling('R1-B1', 'REJECT', 'high')], { proofOk, transcript: 't' });
    assert.deepEqual(out, tested, `proofOk=${proofOk}`);
    assert.equal(out.arbiter, null);
    assert.equal(out.final.by, 'test');
  }
  // A final by anything else IS replaced (a re-run after a failed proof must be able to fix it).
  const stale = item({ id: 'R1-S1', bucket: 'SUGGESTION', judge: judge('REJECT'), final: settled('REJECT', 'arbiter', { needsHuman: true }) });
  assert.equal(applyRulings([stale], [ruling('R1-S1', 'ACCEPT')], { proofOk: true })[0].final.needsHuman, false);
});

// -- 4. light lane

test('ruledCacheFrom: never caches a light-lane auto-rejection, it was not a ruling', () => {
  const lane = item({ fingerprint: 'lane', bucket: 'WORTH_CONSIDERING', final: settled('REJECT', 'light-lane') });
  const ruled = item({ fingerprint: 'ruled', final: settled('REJECT', 'arbiter') });
  assert.deepEqual(Object.keys(ruledCacheFrom([lane, ruled])), ['ruled']);
});

test('markLightLane: only WORTH_CONSIDERING items with neither a judge nor a final are touched', () => {
  const untouchedJudged = item({ id: 'R1-W2', bucket: 'WORTH_CONSIDERING', judge: judge('ACCEPT') });
  const untouchedFinal = item({ id: 'R1-W3', bucket: 'WORTH_CONSIDERING', final: settled('FOLLOW-UP', 'cache') });
  const blocking = item({ id: 'R1-B1', bucket: 'BLOCKING' });
  const target = item({ id: 'R1-W1', bucket: 'WORTH_CONSIDERING' });
  const out = markLightLane([target, untouchedJudged, untouchedFinal, blocking]);
  assert.equal(out[0].final.by, 'light-lane');
  assert.equal(out[1].final, null, 'a judged item is the judge\'s to finalise');
  assert.equal(out[2].final.by, 'cache');
  assert.equal(out[3].final, null);
});

// -- 6. evidence cap

test('applyTestResult: evidence is capped at 500 characters with an ellipsis, in test and reason', () => {
  const long = 'e'.repeat(2000);
  for (const status of ['bug-confirmed', 'bug-disproved']) {
    const out = applyTestResult(item(), status, long);
    assert.equal(out.test.evidence, 'e'.repeat(500) + '…');
    assert.ok(out.final.reason.endsWith('e'.repeat(500) + '…'));
    assert.ok(out.final.reason.length < 600);
  }
  const exact = 'x'.repeat(500);
  assert.equal(applyTestResult(item(), 'bug-confirmed', exact).test.evidence, exact);
  assert.equal(applyTestResult(item(), 'bug-confirmed', 'short').test.evidence, 'short');
  assert.equal(applyTestResult(item(), 'bug-confirmed', undefined).test.evidence, '');
  // Capped by code point: an emoji at the boundary is never split.
  const emoji = '😀'.repeat(600);
  assert.equal(Array.from(applyTestResult(item(), 'bug-confirmed', emoji).test.evidence).length, 501);
});

// ---- owner rulings (owner_approval: chat) ---------------------------------------------------

const needsHumanFinal = (decision = 'FOLLOW-UP', by = 'arbiter') => ({ decision, by, needsHuman: true, reason: 'model-proof failed' });
const ownerOk = (decision, over = {}) => ({ decision, reason: 'owner agrees', ownerQuote: 'yes, follow-up', ruledAt: '2026-10-14T01:02:03.000Z', ...over });

test('applyOwnerRuling: records the owner as the decider, keeps the old final as overruled, never mutates its input', () => {
  const before = item({ id: 'R1-B1', final: needsHumanFinal() });
  const out = applyOwnerRuling(before, ownerOk('REJECT'));
  assert.deepEqual(out.final, {
    decision: 'REJECT', by: 'owner', needsHuman: false, reason: 'owner agrees', ownerQuote: 'yes, follow-up',
    ruledAt: '2026-10-14T01:02:03.000Z', overruled: needsHumanFinal(),
  });
  assert.deepEqual(before.final, needsHumanFinal(), 'input not mutated');
  assert.equal(isOwnerRuled(out), true);
  assert.equal(isOwnerRuled(before), false);
  assert.equal(out.implemented, false, 'ACCEPT still has to be built');
});

test('applyOwnerRuling: refuses a decision outside ACCEPT|FOLLOW-UP|REJECT and an item that needs no human', () => {
  assert.throws(() => applyOwnerRuling(item({ final: needsHumanFinal() }), ownerOk('MAYBE')), /decision/);
  assert.throws(() => applyOwnerRuling(item({ final: settled('ACCEPT') }), ownerOk('REJECT')), /needs no human/);
  assert.throws(() => applyOwnerRuling(item(), ownerOk('REJECT')), /needs no human/);
});

test('ownerRuledItems: finds owner rulings in every round, including cached copies', () => {
  const owner = applyOwnerRuling(item({ id: 'R1-B1', fingerprint: 'fp', final: needsHumanFinal() }), ownerOk('REJECT'));
  const cache = ruledCacheFrom([owner]);
  const [cached] = reuseRuled([item({ id: 'R2-B1', fingerprint: 'fp' })], { fp: { ...cache.fp, bucket: 'BLOCKING', category: 'logic' } });
  assert.equal(cached.final.by, 'cache');
  assert.equal(cached.final.ownerQuote, 'yes, follow-up', 'the cached copy still carries the owner quote');
  assert.equal(isOwnerRuled(cached), true);
  const found = ownerRuledItems(stateOf([round(1, [owner, item({ id: 'R1-B9', final: settled('REJECT') })]), round(2, [cached])]));
  assert.deepEqual(found.map((i) => i.id), ['R1-B1', 'R2-B1']);
});

test('owner ruling: REJECT and FOLLOW-UP clear a needs-human item, ACCEPT stays unclean until built and re-reviewed', () => {
  const stuck = (id) => item({ id, bucket: 'BLOCKING', final: needsHumanFinal('FOLLOW-UP') });
  const blocked = roundOutcome(stateOf([round(1, [stuck('R1-B1')])]));
  assert.equal(blocked.clean, false);
  assert.deepEqual(blocked.needsHuman, ['R1-B1']);
  for (const decision of ['REJECT', 'FOLLOW-UP']) {
    const s = stateOf([round(1, [applyOwnerRuling(stuck('R1-B1'), ownerOk(decision))])]);
    assert.equal(roundOutcome(s).clean, true, decision);
    assert.equal(reviewValidFor(s, 'h-final'), true, decision);
  }
  const accepted = applyOwnerRuling(stuck('R1-B1'), ownerOk('ACCEPT'));
  let s = stateOf([round(1, [accepted])]);
  assert.equal(roundOutcome(s).clean, false);
  assert.deepEqual(roundOutcome(s).unimplemented, ['R1-B1']);
  assert.equal(reviewValidFor(s, 'h-final'), false);
  s = stateOf([round(1, [{ ...accepted, implemented: true }])]);
  assert.equal(roundOutcome(s).clean, false, 'built, but the fix is not reviewed yet');
  s = stateOf([round(1, [{ ...accepted, implemented: true }]), round(2, [])]);
  assert.equal(roundOutcome(s).clean, true, 'a later clean round reviews the fix');
  assert.equal(reviewValidFor(s, 'h-final'), true);
});

test('an owner ruling is not overridden by an arbiter ruling or a test result', () => {
  const owner = applyOwnerRuling(item({ id: 'R1-B1', final: needsHumanFinal() }), ownerOk('REJECT'));
  const [after] = applyRulings([owner], { rulings: [{ id: 'R1-B1', ruling: 'ACCEPT', confidence: 'high', reasoning: 'x' }] }, { proofOk: true });
  assert.deepEqual(after.final, owner.final);
});

test('an owner ruling reused from the cache (by cache, ownerQuote kept) is not overridden either, and stays owner-ruled', () => {
  const owner = applyOwnerRuling(item({ id: 'R1-B1', fingerprint: 'fp', final: needsHumanFinal() }), ownerOk('REJECT'));
  const [cached] = reuseRuled([item({ id: 'R2-B1', fingerprint: 'fp' })], ruledCacheFrom([owner]));
  assert.equal(cached.final.by, 'cache');
  const ruling = { rulings: [{ id: 'R2-B1', ruling: 'ACCEPT', confidence: 'high', reasoning: 'x' }] };
  const [after] = applyRulings([cached], ruling, { proofOk: true });
  assert.deepEqual(after.final, cached.final, 'the arbiter cannot replace it');
  assert.equal(after.final.ownerQuote, 'yes, follow-up');
  assert.equal(isOwnerRuled(after), true);
});

test('reuseRuled: a security dismissal the OWNER ruled on is reused next round and still counts as owner-ruled; a non-owner one is not', () => {
  for (const category of SECURITY_CATEGORIES) {
    for (const decision of ['REJECT', 'FOLLOW-UP']) {
      const stuck = item({ id: 'R1-B1', fingerprint: 'fp', bucket: 'BLOCKING', category, final: needsHumanFinal(decision) });
      const owner = applyOwnerRuling(stuck, ownerOk(decision));
      const [again] = reuseRuled([item({ id: 'R2-B1', fingerprint: 'fp', bucket: 'BLOCKING', category })], ruledCacheFrom([owner]));
      assert.equal(again.final?.by, 'cache', `${decision} ${category}: reused`);
      assert.equal(isOwnerRuled(again), true, `${decision} ${category}: still the owner's word`);
      assert.equal(again.final.needsHuman, false);
      assert.equal(ownerRuledItems(stateOf([round(2, [again])])).length, 1);
      const plain = item({ id: 'R1-B2', fingerprint: 'fp', bucket: 'BLOCKING', category, final: settled(decision, 'arbiter') });
      assert.equal(reuseRuled([item({ fingerprint: 'fp', bucket: 'BLOCKING', category })], ruledCacheFrom([plain]))[0].final, null, `${decision} ${category}: non-owner not reused`);
    }
  }
});

// ---- confidence "medium" ----------------------------------------------------------------------

test('validateRulings and validateTriage accept confidence "medium"', () => {
  assert.deepEqual(validateRulings({ rulings: [ruling('R1-B1', 'ACCEPT', 'medium')] }, ['R1-B1']), { ok: true, errors: [] });
  const t = goodTriage('R1-B1');
  t.items[0].confidence = 'medium';
  assert.deepEqual(validateTriage(t, ['R1-B1']), { ok: true, errors: [] });
});

test('confidence stays strict: "Medium" and "unsure" are invalid', () => {
  for (const c of ['Medium', 'unsure', 'High']) {
    assert.equal(validateRulings({ rulings: [ruling('R1-B1', 'ACCEPT', c)] }, ['R1-B1']).ok, false, c);
    const t = goodTriage('R1-B1');
    t.items[0].confidence = c;
    assert.equal(validateTriage(t, ['R1-B1']).ok, false, c);
  }
});

test('applyRulings: arbiter "medium" ACCEPT stands like high and keeps the literal confidence', () => {
  const it = judged('SUGGESTION', 'REJECT', 'high', {}, { id: 'R1-S1' });
  const [out] = applyRulings([it], [ruling('R1-S1', 'ACCEPT', 'medium', 'fine')], { proofOk: true, transcript: 't.jsonl' });
  assert.deepEqual(out.final, { decision: 'ACCEPT', by: 'arbiter', needsHuman: false, reason: 'fine' });
  assert.equal(out.arbiter.confidence, 'medium');
});

test('applyRulings: arbiter "medium" REJECT of a BLOCKING security item still goes to a human', () => {
  const it = judged('BLOCKING', 'REJECT', 'high', {}, { id: 'R1-B1', category: 'security' });
  const [out] = applyRulings([it], [ruling('R1-B1', 'REJECT', 'medium')], { proofOk: true });
  assert.equal(out.final.needsHuman, true);
  assert.equal(out.final.reason, 'would dismiss a blocking security/data item');
});

test('applyRulings: arbiter "medium" without proof still goes to a human', () => {
  const it = judged('SUGGESTION', 'REJECT', 'high', {}, { id: 'R1-S1' });
  const [out] = applyRulings([it], [ruling('R1-S1', 'ACCEPT', 'medium')], { proofOk: false });
  assert.equal(out.final.needsHuman, true);
});

test('applyRulings: arbiter "Medium" or "unsure" is invalid output and goes to a human', () => {
  const it = judged('SUGGESTION', 'REJECT', 'high', {}, { id: 'R1-S1' });
  for (const c of ['Medium', 'unsure', null]) {
    const [out] = applyRulings([it], [ruling('R1-S1', 'ACCEPT', c)], { proofOk: true });
    assert.equal(out.final.needsHuman, true, String(c));
    assert.equal(out.final.reason, 'invalid arbiter output');
  }
});

test('arbiterNeeded: judge "medium" confidence needs the arbiter', () => {
  for (const bucket of ['BLOCKING', 'SUGGESTION', 'WORTH_CONSIDERING']) {
    assert.equal(arbiterNeeded(judged(bucket, 'ACCEPT', 'medium')), true, bucket);
  }
});

// ---- Phase 2: Fable review rounds -----------------------------------------------------------

const fableFinding = (over = {}) => ({
  bucket: 'BLOCKING', category: 'auth', title: 'role check skipped', file: 'lib/auth.ts', line: 3, detail: 'a guest reaches it',
  ruling: 'ACCEPT', confidence: 'high', reasoning: 'lib/auth.ts:3 returns early', ...over,
});

test('fablePendingRounds: a fableRequired round is pending until its arbiter pass is proven; baseOnly and judge rounds never are', () => {
  const rounds = [
    round(1, [], 'h1', { fableRequired: true }),
    round(2, [], 'h2', { fableRequired: true, arbiter: { proofOk: false } }),
    round(3, [], 'h3', { fableRequired: true, arbiter: { proofOk: true } }),
    round(4, [], 'h4', { fableRequired: true, baseOnly: true }),
    round(5, [], 'h-final'),
  ];
  assert.deepEqual(fablePendingRounds({ rounds }), [1, 2]);
  assert.deepEqual(fablePendingRounds(null), []);
});

test('a sensitive round with ZERO Codex findings is not clean and not valid until the Fable pass is proven', () => {
  const pending = stateOf([round(1, [], 'h-final', { fableRequired: true })]);
  const o = roundOutcome(pending);
  assert.equal(o.clean, false);
  assert.deepEqual(o.fablePending, [1]);
  assert.equal(o.extraRound, false);
  assert.equal(reviewValidFor(pending, 'h-final'), false);
  const unproven = stateOf([round(1, [], 'h-final', { fableRequired: true, arbiter: { proofOk: false } })]);
  assert.equal(roundOutcome(unproven).clean, false);
  const proven = stateOf([round(1, [], 'h-final', { fableRequired: true, arbiter: { proofOk: true } })]);
  assert.equal(roundOutcome(proven).clean, true);
  assert.equal(reviewValidFor(proven, 'h-final'), true);
  // An earlier pending round blocks too: the clean last round does not vouch for it.
  const early = stateOf([round(1, [], 'h1', { fableRequired: true }), round(2, [], 'h-final', { fableRequired: true, arbiter: { proofOk: true } })]);
  assert.equal(reviewValidFor(early, 'h-final'), false);
});

test('validateRulings review mode: findings are required (an empty list is fine) and checked; dispute mode refuses them', () => {
  assert.equal(validateRulings({ rulings: [], findings: [] }, [], { review: true }).ok, true);
  assert.equal(validateRulings({ rulings: [], findings: [fableFinding()] }, [], { review: true }).ok, true);
  const missing = validateRulings({ rulings: [] }, [], { review: true });
  assert.equal(missing.ok, false);
  assert.match(missing.errors.join('|'), /findings must be an array/);
  assert.match(validateRulings({ rulings: [], findings: [] }, []).errors.join('|'), /only accepted in a Fable review round/);
  const bad = [
    [{ ruling: 'REJECT' }, /ruling must be one of ACCEPT\|FOLLOW-UP/],
    [{ bucket: 'blocking' }, /bucket must be one of/],
    [{ category: 'Security' }, /category must be one of/],
    [{ line: -1 }, /line must be an integer/],
    [{ line: 1.5 }, /line must be an integer/],
    [{ title: ' ' }, /title must be a non-empty string/],
    [{ confidence: 'sure' }, /confidence must be one of/],
    [{ file: null }, /file must be a string/],
    [{ extra: 1 }, /unexpected key "extra"/],
    [{ detail: 'x'.repeat(4001) }, /longer than 4000/],
  ];
  for (const [over, re] of bad) {
    const r = validateRulings({ rulings: [], findings: [fableFinding(over)] }, [], { review: true });
    assert.equal(r.ok, false, JSON.stringify(over));
    assert.match(r.errors.join('|'), re, JSON.stringify(over));
  }
  const many = Array.from({ length: FABLE_FINDINGS_MAX + 1 }, () => fableFinding());
  assert.match(validateRulings({ rulings: [], findings: many }, [], { review: true }).errors.join('|'), /at most 20 findings/);
});

test('fableFindingItems: ids R<n>-F<k>, ruled by the arbiter; low confidence or a deferred blocking security finding -> human', () => {
  const items = fableFindingItems([
    fableFinding(),
    fableFinding({ bucket: 'SUGGESTION', category: 'maintainability', ruling: 'FOLLOW-UP' }),
    fableFinding({ confidence: 'low' }),
    fableFinding({ ruling: 'FOLLOW-UP' }),
  ], 2, { transcript: '/t.jsonl', fingerprintFor: (f) => `fp:${f.title}` });
  assert.deepEqual(items.map((i) => i.id), ['R2-F1', 'R2-F2', 'R2-F3', 'R2-F4']);
  assert.ok(items.every((i) => i.source === 'fable' && i.round === 2 && i.final.by === 'arbiter' && i.fingerprint === 'fp:role check skipped'));
  assert.deepEqual(items.map((i) => [i.final.decision, i.final.needsHuman]), [['ACCEPT', false], ['FOLLOW-UP', false], ['ACCEPT', true], ['FOLLOW-UP', true]]);
  assert.equal(items[0].arbiter.transcript, '/t.jsonl');
  assert.throws(() => fableFindingItems([fableFinding({ ruling: 'REJECT' })], 1), /invalid findings/);
  assert.throws(() => fableFindingItems([], 0), /invalid round/);
  // A proven ACCEPT finding is new work: the round is not clean until it is fixed and reviewed again.
  const s = stateOf([round(1, fableFindingItems([fableFinding()], 1), 'h-final', { fableRequired: true, arbiter: { proofOk: true } })]);
  assert.equal(roundOutcome(s).clean, false);
  assert.deepEqual(roundOutcome(s).openBlocking, ['R1-F1']);
});

test('roundCapProblem: rounds stop at maxRounds plus ONE extra confirm round, only when roundOutcome grants it', () => {
  const fixedAccept = (n) => item({ id: `R${n}-B1`, round: n, final: settled('ACCEPT'), implemented: true });
  const twoRounds = (last) => ({ rounds: [round(1, []), round(2, [last])], maxRounds: 2, currentContentHash: 'h-new' });
  assert.equal(roundCapProblem(twoRounds(fixedAccept(2)), 2), null);
  assert.equal(roundCapProblem(twoRounds(fixedAccept(2)), 3), null); // extraRound: only accepted, fixed items open
  assert.match(roundCapProblem(twoRounds(item({ id: 'R2-B1', final: null })), 3), /only one extra round is allowed/);
  const three = { rounds: [round(1, []), round(2, [fixedAccept(2)]), round(3, [fixedAccept(3)])], maxRounds: 2, currentContentHash: 'h-new' };
  assert.match(roundCapProblem(three, 4), /and its one extra round/);
  assert.equal(roundCapProblem({ rounds: [] }, 9), null); // not capped without a finite maxRounds
});

test('reuseRuled: an ACCEPT that was already fixed comes back implemented (else mark-implemented could never clear it)', () => {
  const fixed = item({ fingerprint: 'fx', final: settled('ACCEPT'), implemented: true });
  const notYet = item({ fingerprint: 'nf', final: settled('ACCEPT'), implemented: false });
  const rejected = item({ fingerprint: 'rj', final: settled('REJECT'), implemented: true });
  const cache = ruledCacheFrom([fixed, notYet, rejected]);
  assert.equal(cache.fx.implemented, true);
  assert.equal(cache.nf.implemented, undefined);
  assert.equal(cache.rj.implemented, undefined, 'only an ACCEPT carries a fix');
  const [a, b, c] = reuseRuled([item({ fingerprint: 'fx' }), item({ fingerprint: 'nf' }), item({ fingerprint: 'rj' })], cache);
  assert.deepEqual([a.final.by, a.final.decision, a.implemented], ['cache', 'ACCEPT', true]);
  assert.equal(a.final.implemented, undefined, 'the flag is not part of the final');
  assert.equal(b.implemented, false);
  assert.equal(c.implemented, false);
  // The reused, fixed ACCEPT is neither unimplemented nor a new accept: the round can be clean.
  const o = roundOutcome({ rounds: [round(1, [fixed]), round(2, [a])], maxRounds: 2, currentContentHash: 'h-final' });
  assert.deepEqual([o.clean, o.unimplemented], [true, []]);
  // A later unfixed copy of the same finding does not erase the earlier fix.
  assert.equal(ruledCacheFrom([fixed, item({ fingerprint: 'fx', final: settled('ACCEPT', 'cache'), implemented: false })]).fx.implemented, true);
});
