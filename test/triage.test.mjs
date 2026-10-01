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

test('applyRulings: REJECT high on a BLOCKING security-class item goes to a human', () => {
  for (const category of SECURITY_CATEGORIES) {
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

test('reuseRuled: a matching fingerprint reuses the earlier final, marked by cache', () => {
  const earlier = settled('REJECT', 'arbiter', { reason: 'not a bug' });
  const it = item({ fingerprint: 'same-fp' });
  const [out] = reuseRuled([it], { 'same-fp': earlier });
  assert.deepEqual(out.final, { ...earlier, by: 'cache' });
  assert.equal(it.final, null, 'input not mutated');
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
  // Round trip: a cache built from round N pre-fills the same item in round N+1.
  const [again] = reuseRuled([item({ fingerprint: 'a' })], cache);
  assert.equal(again.final.by, 'cache');
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
  r = bad({ confidence: 'medium' });
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
  assert.equal(validateRulings({ rulings: [ruling('R1-B1', 'ACCEPT', 'medium')] }, ['R1-B1']).ok, false);
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
    clean: true, openBlocking: [], newAccepted: [], needsHuman: [], pending: [], reachedMax: false, coverageValid: true,
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

test('roundOutcome: only the last round is considered', () => {
  const messy = [item({ id: 'R1-B1', bucket: 'BLOCKING', final: settled('ACCEPT', 'judge'), implemented: true })];
  const o = roundOutcome(stateOf([round(1, messy, 'h-1'), round(2, [], 'h-final')]));
  assert.equal(o.clean, true);
});

test('roundOutcome: no rounds yet is not clean', () => {
  const o = roundOutcome(stateOf([]));
  assert.equal(o.clean, false);
  assert.equal(o.coverageValid, false);
  assert.equal(o.reachedMax, false);
});

test('roundOutcome: reachedMax after three unclean rounds, not before, and not when clean', () => {
  const accepting = (n) => round(n, [item({ id: `R${n}-B1`, bucket: 'BLOCKING', final: settled('ACCEPT', 'judge'), implemented: true })]);
  assert.equal(roundOutcome(stateOf([accepting(1), accepting(2)])).reachedMax, false);
  const three = roundOutcome(stateOf([accepting(1), accepting(2), accepting(3)]));
  assert.equal(three.reachedMax, true);
  assert.equal(three.clean, false);
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

test('reviewValidFor: any one qualifying round is enough, whatever the later rounds look like', () => {
  const good = round(1, [item({ final: settled('REJECT', 'judge') })], 'h-final');
  const later = round(2, [item({ bucket: 'BLOCKING' })], 'h-later');
  assert.equal(reviewValidFor(stateOf([good, later]), 'h-final'), true);
  assert.equal(reviewValidFor(stateOf([good, later]), 'h-later'), false);
});
