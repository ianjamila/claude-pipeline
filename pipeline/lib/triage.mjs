// Deterministic rules of the review loop: when the arbiter must be called, which rulings are final,
// when a PR must go to a human, and when the loop may exit. A model never makes these decisions;
// this file does. Everything is pure: functions return new values and never mutate their inputs.

export const SECURITY_CATEGORIES = ['security', 'auth', 'permissions', 'data-integrity', 'data-loss'];
export const BUCKETS = ['BLOCKING', 'SUGGESTION', 'WORTH_CONSIDERING'];
export const DECISIONS = ['ACCEPT', 'FOLLOW-UP', 'REJECT'];
export const CONFIDENCES = ['high', 'low'];

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const idsOf = (items) => items.map((i) => i.id);
const validDecision = (d) => (DECISIONS.includes(d) ? d : null);
const EVIDENCE_MAX = 500;

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

const invalidJudgeFinal = () => ({ decision: null, by: 'judge', needsHuman: true, reason: 'invalid judge output' });

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
    // Fail closed even if the caller skipped validateTriage: a decision we cannot read is not
    // "no decision" (which would fall through to the arbiter rules), it is a human's call. An
    // existing final (test, cache) is never overwritten by garbage.
    if (validDecision(e.decision) === null && !next.final) next.final = invalidJudgeFinal();
    return next;
  });
}

// A test outranks every opinion: it is evidence, and it settles the item without the arbiter. `proof` ({cmd, file,
// exitCode, head}) is what the PIPELINE ran to get it (see `triage settle`). A test that DISMISSES a security / auth /
// permissions / data item (bug-disproved) still goes to a human, exactly like an arbiter dismissal: a passing test only
// shows the behaviour the test author chose to assert.
export function applyTestResult(item, status, evidence = '', proof = null) {
  if (status !== 'bug-confirmed' && status !== 'bug-disproved') {
    throw new Error(`test status must be bug-confirmed or bug-disproved, got ${JSON.stringify(status)}`);
  }
  // Evidence is raw test output; it ends up in a PR comment, so cap it (by code point).
  const chars = Array.from(String(evidence ?? ''));
  evidence = chars.length > EVIDENCE_MAX ? `${chars.slice(0, EVIDENCE_MAX).join('')}…` : chars.join('');
  const next = structuredClone(item);
  next.test = { status, evidence, ...(proof ? { cmd: proof.cmd, file: proof.file, exitCode: proof.exitCode, head: proof.head } : {}) };
  if (status === 'bug-confirmed') {
    next.final = { decision: 'ACCEPT', by: 'test', needsHuman: false, reason: `test confirmed: ${evidence}` };
  } else if (SECURITY_CATEGORIES.includes(item.category)) {
    next.final = { decision: 'REJECT', by: 'test', needsHuman: true, reason: `test disproved, but it would dismiss a security/data item: ${evidence}` };
  } else {
    next.final = { decision: 'REJECT', by: 'test', needsHuman: false, reason: `test disproved: ${evidence}` };
  }
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
  // Rule (c), failing closed: anything but exactly 'high' (bad case, missing, wrong type) is low.
  return dismissed || j.confidence !== 'high' || disputedUntestable; // rules (b), (c), (d)
}

export function finalizeWithoutArbiter(items, opts = {}) {
  return items.map((item) => {
    const next = structuredClone(item);
    if (next.judge && !next.final) {
      if (validDecision(next.judge.decision) === null) next.final = invalidJudgeFinal();
      else if (!arbiterNeeded(next, opts)) {
        next.final = { decision: next.judge.decision, by: 'judge', needsHuman: false, reason: next.judge.reason };
      }
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
    if (next.final?.by === 'test') return next; // a test is evidence; no opinion overrides it
    next.arbiter = { ruling: r.ruling, confidence: r.confidence, reasoning: r.reasoning, transcript: transcript ?? null };
    const rulingValid = DECISIONS.includes(r.ruling) && CONFIDENCES.includes(r.confidence);
    const dismissesBlockingSecurity =
      item.bucket === 'BLOCKING' &&
      SECURITY_CATEGORIES.includes(item.category) &&
      (r.ruling === 'REJECT' || r.ruling === 'FOLLOW-UP');
    if (!proofOk) {
      // The ruling is not provably from Fable, so it must not steer the decision: fall back to the
      // judge's (a human decides anyway). With no judge on record the ruling is all there is.
      next.final = {
        decision: validDecision(item.judge?.decision) ?? validDecision(r.ruling),
        by: 'arbiter',
        needsHuman: true,
        reason: 'model-proof failed: ruling not provably from Fable',
      };
    } else if (!rulingValid) {
      // Output a validator would have refused (wrong case, missing, wrong type): never act on it.
      next.final = {
        decision: validDecision(item.judge?.decision),
        by: 'arbiter',
        needsHuman: true,
        reason: 'invalid arbiter output',
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

// A ruled item is not reopened unless its code changed (the fingerprint covers file, title and excerpt) AND it is the
// same kind of finding: the fingerprint says nothing about severity, so a ruling made for a WORTH CONSIDERING
// performance idea must not settle the same text when it comes back as a BLOCKING security bug. A cache entry (see
// ruledCacheFrom) therefore carries the bucket and category it was ruled under, and is reused only when both match.
// A dismissal (REJECT / FOLLOW-UP) of a security, auth, permissions or data category is never reused, whatever the
// bucket: those are looked at every time. An entry without bucket and category (a hand-built cache) is not reused.
export function reuseRuled(items, ruledCache) {
  return items.map((item) => {
    const next = structuredClone(item);
    if (next.final || !next.fingerprint) return next;
    if (!Object.hasOwn(ruledCache, next.fingerprint)) return next;
    const { bucket, category, followupIssue, ...final } = structuredClone(ruledCache[next.fingerprint]);
    if (bucket !== next.bucket || category !== next.category) return next;
    const dismissal = final.decision === 'REJECT' || final.decision === 'FOLLOW-UP';
    if (dismissal && SECURITY_CATEGORIES.includes(next.category)) return next;
    next.final = { ...final, by: 'cache' };
    // The issue filed for the earlier item is the issue for this one: carrying it keeps `followups create` from
    // filing the same suggestion again every round.
    if (typeof followupIssue === 'string' && followupIssue !== '' && !next.followupIssue) next.followupIssue = followupIssue;
    return next;
  });
}

// Only settled rulings are worth reusing; an item waiting for a human must be looked at again. Each entry is the
// final plus the bucket and category it was ruled under and the follow-up issue filed for it (if any).
export function ruledCacheFrom(items) {
  const cache = {};
  for (const item of items) {
    // A light-lane rejection is a default ("not triaged"), not a ruling: nobody looked at it.
    if (item.fingerprint && item.final && !item.final.needsHuman && item.final.by !== 'light-lane') {
      const issue = item.followupIssue || (Object.hasOwn(cache, item.fingerprint) ? cache[item.fingerprint].followupIssue : null);
      cache[item.fingerprint] = {
        ...structuredClone(item.final), bucket: item.bucket, category: item.category, ...(issue ? { followupIssue: issue } : {}),
      };
    }
  }
  return cache;
}

export function markLightLane(items) {
  return items.map((item) => {
    const next = structuredClone(item);
    if (next.bucket === 'WORTH_CONSIDERING' && !next.judge && !next.final) {
      next.final = { decision: 'REJECT', by: 'light-lane', needsHuman: false, reason: 'light lane — not triaged' };
    }
    return next;
  });
}

// ---- exit rules -----------------------------------------------------------------------------

const isNewAccept = (item) => item.final?.decision === 'ACCEPT' && item.final.by !== 'cache';
const isUnimplementedAccept = (item) => item.final?.decision === 'ACCEPT' && !item.implemented;
const isOpenBlocking = (item) => item.bucket === 'BLOCKING' && (!item.final || isUnimplementedAccept(item));

const hasContentHash = (h) => typeof h === 'string' && h !== '';
const allItems = (state) => (state?.rounds ?? []).flatMap((r) => r.items ?? []);

// Problems in ANY round, not just the last: an unresolved item from round 1 does not go away
// because round 2 happened to find nothing. (Items of earlier rounds are always final and
// implemented in a normal run, so this only ever bites on an abnormal one, which is the point.)
const unresolved = (item) => !item.final || item.final.needsHuman || isOpenBlocking(item) || isUnimplementedAccept(item);

// Clean needs: nothing pending, needing a human, open, or accepted-but-unfixed anywhere; nothing
// newly accepted in the LAST round (its fixes still need a round to review them); and the last
// round reviewed exactly the content that exists now (coverageValid).
export function roundOutcome(state) {
  const rounds = state?.rounds ?? [];
  const last = rounds.at(-1);
  const everything = allItems(state);
  const pending = idsOf(everything.filter((i) => !i.final));
  const needsHuman = idsOf(everything.filter((i) => i.final?.needsHuman));
  const openBlocking = idsOf(everything.filter(isOpenBlocking));
  const unimplemented = idsOf(everything.filter(isUnimplementedAccept));
  const newAccepted = idsOf((last?.items ?? []).filter(isNewAccept));
  const coverageValid =
    last !== undefined &&
    hasContentHash(last.contentHashAtToHead) &&
    hasContentHash(state.currentContentHash) &&
    last.contentHashAtToHead === state.currentContentHash;
  const clean =
    pending.length === 0 &&
    needsHuman.length === 0 &&
    openBlocking.length === 0 &&
    unimplemented.length === 0 &&
    newAccepted.length === 0 &&
    coverageValid;
  const reachedMax = Number.isFinite(state?.maxRounds) && rounds.length >= state.maxRounds && !clean;
  return { clean, openBlocking, newAccepted, needsHuman, pending, unimplemented, reachedMax, coverageValid };
}

// True when the MOST RECENT clean round (one that accepted nothing new) reviewed exactly `contentHash`, no later
// round exists that is not clean, and no round has an unresolved item (spec R3'). An earlier clean round never
// vouches for content that a later round went on to change or to accept fixes for. Agrees with roundOutcome.
export function reviewValidFor(state, contentHash) {
  if (!hasContentHash(contentHash)) return false;
  if (allItems(state).some(unresolved)) return false;
  const rounds = state?.rounds ?? [];
  const isClean = (round) => (round.items ?? []).every((item) => !isNewAccept(item));
  const lastClean = rounds.findLast(isClean);
  if (lastClean === undefined || lastClean !== rounds.at(-1)) return false;
  return lastClean.contentHashAtToHead === contentHash;
}
