// Deterministic rules of the review loop: when the arbiter must be called, which rulings are final,
// when a PR must go to a human, and when the loop may exit. A model never makes these decisions;
// this file does. Everything is pure: functions return new values and never mutate their inputs.

export const SECURITY_CATEGORIES = ['security', 'auth', 'permissions', 'data-integrity', 'data-loss'];
export const BUCKETS = ['BLOCKING', 'SUGGESTION', 'WORTH_CONSIDERING'];
export const DECISIONS = ['ACCEPT', 'FOLLOW-UP', 'REJECT'];
export const CONFIDENCES = ['high', 'low'];

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const idsOf = (items) => items.map((i) => i.id);

// ---- validation -----------------------------------------------------------------------------

// Shared id bookkeeping: every wanted id exactly once, nothing else. `list` is the model's array.
function checkIds(list, itemIds, listName, errors) {
  const wanted = new Set(itemIds);
  const seen = new Set();
  list.forEach((entry, i) => {
    if (!isObject(entry)) {
      errors.push(`${listName}[${i}] must be an object`);
      return;
    }
    if (typeof entry.id !== 'string' || entry.id === '') {
      errors.push(`${listName}[${i}].id must be a non-empty string`);
      return;
    }
    if (seen.has(entry.id)) errors.push(`duplicate id ${entry.id}`);
    seen.add(entry.id);
    if (!wanted.has(entry.id)) errors.push(`unknown id ${entry.id}`);
  });
  for (const id of wanted) if (!seen.has(id)) errors.push(`missing id ${id}`);
}

const oneOf = (value, allowed) => allowed.includes(value);

export function validateTriage(json, itemIds) {
  const errors = [];
  if (!isObject(json) || !Array.isArray(json.items)) {
    return { ok: false, errors: ['triage output must be an object {"items": [...]}'] };
  }
  checkIds(json.items, itemIds, 'items', errors);
  for (const e of json.items) {
    if (!isObject(e) || typeof e.id !== 'string') continue; // already reported by checkIds
    if (!oneOf(e.decision, DECISIONS)) errors.push(`${e.id}: decision must be one of ${DECISIONS.join('|')}`);
    if (!oneOf(e.confidence, CONFIDENCES)) errors.push(`${e.id}: confidence must be one of ${CONFIDENCES.join('|')}`);
    if (typeof e.reason !== 'string') errors.push(`${e.id}: reason must be a string`);
    if (typeof e.disputedBug !== 'boolean') errors.push(`${e.id}: disputedBug must be a boolean`);
    if (!isObject(e.settleTest)) {
      errors.push(`${e.id}: settleTest must be an object {possible, plan}`);
    } else {
      if (typeof e.settleTest.possible !== 'boolean') errors.push(`${e.id}: settleTest.possible must be a boolean`);
      if (typeof e.settleTest.plan !== 'string') errors.push(`${e.id}: settleTest.plan must be a string`);
    }
  }
  return { ok: errors.length === 0, errors };
}

export function validateRulings(json, itemIds) {
  const errors = [];
  if (!isObject(json) || !Array.isArray(json.rulings)) {
    return { ok: false, errors: ['rulings output must be an object {"rulings": [...]}'] };
  }
  checkIds(json.rulings, itemIds, 'rulings', errors);
  for (const r of json.rulings) {
    if (!isObject(r) || typeof r.id !== 'string') continue;
    if (!oneOf(r.ruling, DECISIONS)) errors.push(`${r.id}: ruling must be one of ${DECISIONS.join('|')}`);
    if (!oneOf(r.confidence, CONFIDENCES)) errors.push(`${r.id}: confidence must be one of ${CONFIDENCES.join('|')}`);
    if (typeof r.reasoning !== 'string') errors.push(`${r.id}: reasoning must be a string`);
  }
  return { ok: errors.length === 0, errors };
}

// ---- judge, tests ---------------------------------------------------------------------------

// `triage` may be the judge's whole output ({items}) or just its array.
export function applyJudge(items, triage) {
  const list = Array.isArray(triage) ? triage : (triage?.items ?? []);
  const byId = new Map(list.map((e) => [e.id, e]));
  return items.map((item) => {
    const next = structuredClone(item);
    const e = byId.get(item.id);
    if (!e) return next;
    next.judge = {
      decision: e.decision,
      confidence: e.confidence,
      reason: e.reason,
      disputedBug: e.disputedBug === true,
      settleTest: { possible: e.settleTest?.possible === true, plan: String(e.settleTest?.plan ?? '') },
    };
    return next;
  });
}

// A test outranks every opinion: it is evidence, and it settles the item without the arbiter.
export function applyTestResult(item, status, evidence = '') {
  if (status !== 'bug-confirmed' && status !== 'bug-disproved') {
    throw new Error(`test status must be bug-confirmed or bug-disproved, got ${JSON.stringify(status)}`);
  }
  const next = structuredClone(item);
  next.test = { status, evidence };
  next.final =
    status === 'bug-confirmed'
      ? { decision: 'ACCEPT', by: 'test', needsHuman: false, reason: `test confirmed: ${evidence}` }
      : { decision: 'REJECT', by: 'test', needsHuman: false, reason: `test disproved: ${evidence}` };
  return next;
}

// ---- when the arbiter is needed -------------------------------------------------------------

export function arbiterNeeded(item, { lightLane = false, force = false } = {}) {
  if (item.final) return false; // already settled by cache, test, or light lane
  if ((item.test?.status ?? 'none') !== 'none') return false; // a test result settles it
  if (force) return true;
  const j = item.judge;
  if (!j) return false; // not triaged yet; nothing to dispute
  const gating = item.bucket === 'BLOCKING' || item.bucket === 'SUGGESTION';
  const dismissed = gating && (j.decision === 'REJECT' || j.decision === 'FOLLOW-UP'); // rule (b)
  const disputedUntestable = j.disputedBug === true && !j.settleTest?.possible; // rule (d)
  // Light lane: spend the arbiter only on a disputed BLOCKING item.
  if (lightLane) return item.bucket === 'BLOCKING' && (dismissed || disputedUntestable);
  return dismissed || j.confidence === 'low' || disputedUntestable; // rules (b), (c), (d)
}

export function finalizeWithoutArbiter(items, opts = {}) {
  return items.map((item) => {
    const next = structuredClone(item);
    if (next.judge && !next.final && !arbiterNeeded(next, opts)) {
      next.final = { decision: next.judge.decision, by: 'judge', needsHuman: false, reason: next.judge.reason };
    }
    return next;
  });
}

// ---- arbiter rulings ------------------------------------------------------------------------

// A ruling is final unless it must go to a human. Checked in this order; the first match wins.
// `rulings` may be the arbiter's whole output ({rulings}) or just its array. A missing proofOk
// fails closed.
export function applyRulings(items, rulings, { proofOk, transcript } = {}) {
  const list = Array.isArray(rulings) ? rulings : (rulings?.rulings ?? []);
  const byId = new Map(list.map((r) => [r.id, r]));
  return items.map((item) => {
    const next = structuredClone(item);
    const r = byId.get(item.id);
    if (!r) return next;
    next.arbiter = { ruling: r.ruling, confidence: r.confidence, reasoning: r.reasoning, transcript: transcript ?? null };
    const dismissesBlockingSecurity =
      item.bucket === 'BLOCKING' &&
      SECURITY_CATEGORIES.includes(item.category) &&
      (r.ruling === 'REJECT' || r.ruling === 'FOLLOW-UP');
    if (!proofOk) {
      // The ruling is not provably from Fable, so it must not steer the decision: fall back to the
      // judge's (a human decides anyway). With no judge on record the ruling is all there is.
      next.final = {
        decision: item.judge?.decision ?? r.ruling,
        by: 'arbiter',
        needsHuman: true,
        reason: 'model-proof failed: ruling not provably from Fable',
      };
    } else if (r.confidence === 'low') {
      next.final = { decision: r.ruling, by: 'arbiter', needsHuman: true, reason: 'arbiter low confidence' };
    } else if (dismissesBlockingSecurity) {
      next.final = { decision: r.ruling, by: 'arbiter', needsHuman: true, reason: 'would dismiss a blocking security/data item' };
    } else {
      next.final = { decision: r.ruling, by: 'arbiter', needsHuman: false, reason: r.reasoning };
    }
    return next;
  });
}

// ---- cache and light lane -------------------------------------------------------------------

// A ruled item is not reopened unless its code changed (the fingerprint covers file, title and excerpt).
export function reuseRuled(items, ruledCache) {
  return items.map((item) => {
    const next = structuredClone(item);
    if (next.final || !next.fingerprint) return next;
    if (!Object.hasOwn(ruledCache, next.fingerprint)) return next;
    next.final = { ...structuredClone(ruledCache[next.fingerprint]), by: 'cache' };
    return next;
  });
}

// Only settled rulings are worth reusing; an item waiting for a human must be looked at again.
export function ruledCacheFrom(items) {
  const cache = {};
  for (const item of items) {
    if (item.fingerprint && item.final && !item.final.needsHuman) cache[item.fingerprint] = structuredClone(item.final);
  }
  return cache;
}

export function markLightLane(items) {
  return items.map((item) => {
    const next = structuredClone(item);
    if (next.bucket === 'WORTH_CONSIDERING' && !next.final) {
      next.final = { decision: 'REJECT', by: 'light-lane', needsHuman: false, reason: 'light lane — not triaged' };
    }
    return next;
  });
}

// ---- exit rules -----------------------------------------------------------------------------

const isNewAccept = (item) => item.final?.decision === 'ACCEPT' && item.final.by !== 'cache';
const isOpenBlocking = (item) =>
  item.bucket === 'BLOCKING' && (!item.final || (item.final.decision === 'ACCEPT' && !item.implemented));

const hasContentHash = (h) => typeof h === 'string' && h !== '';

// Only the last round counts. A round that ACCEPTED anything is never clean: the fixes it caused
// need a further round to review them. Clean also needs the round to have reviewed exactly the
// content that exists now (coverageValid).
export function roundOutcome(state) {
  const rounds = state?.rounds ?? [];
  const last = rounds.at(-1);
  const items = last?.items ?? [];
  const pending = idsOf(items.filter((i) => !i.final));
  const needsHuman = idsOf(items.filter((i) => i.final?.needsHuman));
  const openBlocking = idsOf(items.filter(isOpenBlocking));
  const newAccepted = idsOf(items.filter(isNewAccept));
  const coverageValid =
    last !== undefined &&
    hasContentHash(last.contentHashAtToHead) &&
    hasContentHash(state.currentContentHash) &&
    last.contentHashAtToHead === state.currentContentHash;
  const clean =
    pending.length === 0 && needsHuman.length === 0 && openBlocking.length === 0 && newAccepted.length === 0 && coverageValid;
  const reachedMax = Number.isFinite(state?.maxRounds) && rounds.length >= state.maxRounds && !clean;
  return { clean, openBlocking, newAccepted, needsHuman, pending, reachedMax, coverageValid };
}

// True when some round reviewed exactly `contentHash` and ended with everything settled: no pending
// item, no human needed, nothing newly accepted. Also no unimplemented BLOCKING ACCEPT (a cached
// one would otherwise slip through) so this never says "valid" for a round roundOutcome calls dirty.
export function reviewValidFor(state, contentHash) {
  if (!hasContentHash(contentHash)) return false;
  return (state?.rounds ?? []).some(
    (round) =>
      round.contentHashAtToHead === contentHash &&
      (round.items ?? []).every(
        (item) => item.final && !item.final.needsHuman && !isNewAccept(item) && !isOpenBlocking(item),
      ),
  );
}
