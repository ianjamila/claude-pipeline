// Deterministic rules of the review loop: when the arbiter must be called, which rulings are final,
// when a PR must go to a human, and when the loop may exit. A model never makes these decisions;
// this file does. Everything is pure: functions return new values and never mutate their inputs.
import { CATEGORIES } from './codex.mjs';

export const SECURITY_CATEGORIES = ['security', 'auth', 'permissions', 'data-integrity', 'data-loss'];
export const BUCKETS = ['BLOCKING', 'SUGGESTION', 'WORTH_CONSIDERING'];
export const DECISIONS = ['ACCEPT', 'FOLLOW-UP', 'REJECT'];
// 'medium' is accepted so a wording slip does not park an item: the judge's escalates to the arbiter (anything but 'high'),
// the arbiter's stands like 'high' (only 'low' sends it to a human).
export const CONFIDENCES = ['high', 'medium', 'low'];

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

// `review: true` (a Fable review round, see fablePendingRounds): the output must ALSO carry `findings`, Fable's own review of
// the diff, as an array (empty when it found nothing): a missing list means the review was not done, not that it was clean.
export function validateRulings(json, itemIds, { review = false } = {}) {
  const errors = [];
  if (!isObject(json) || !Array.isArray(json.rulings)) {
    return { ok: false, errors: [`rulings output must be an object {"rulings": [...]${review ? ', "findings": [...]' : ''}}`] };
  }
  checkIds(json.rulings, itemIds, 'rulings', errors);
  for (const r of json.rulings) {
    if (!isObject(r) || typeof r.id !== 'string') continue;
    if (!oneOf(r.ruling, DECISIONS)) errors.push(`${r.id}: ruling must be one of ${DECISIONS.join('|')}`);
    if (!oneOf(r.confidence, CONFIDENCES)) errors.push(`${r.id}: confidence must be one of ${CONFIDENCES.join('|')}`);
    if (typeof r.reasoning !== 'string') errors.push(`${r.id}: reasoning must be a string`);
  }
  if (review) errors.push(...findingErrors(json.findings));
  else if (json.findings !== undefined) errors.push('findings are only accepted in a Fable review round');
  return { ok: errors.length === 0, errors };
}

// ---- Fable review rounds --------------------------------------------------------------------

// What Fable may raise on its own. A finding it raises is something to do, so it is ACCEPT (fix it here) or FOLLOW-UP (an
// issue), never REJECT. The cap keeps a runaway answer from flooding the triage comment.
export const FABLE_FINDINGS_MAX = 20;
const FINDING_DECISIONS = ['ACCEPT', 'FOLLOW-UP'];
const FINDING_KEYS = ['bucket', 'category', 'title', 'file', 'line', 'detail', 'ruling', 'confidence', 'reasoning'];
const FINDING_TEXT_MAX = 4000;

function findingErrors(findings) {
  if (!Array.isArray(findings)) return ['findings must be an array (empty when the review found nothing)'];
  if (findings.length > FABLE_FINDINGS_MAX) return [`at most ${FABLE_FINDINGS_MAX} findings (got ${findings.length})`];
  const errors = [];
  findings.forEach((f, i) => {
    const at = `findings[${i}]`;
    if (!isObject(f)) {
      errors.push(`${at} must be an object`);
      return;
    }
    for (const k of Object.keys(f)) if (!FINDING_KEYS.includes(k)) errors.push(`${at}: unexpected key "${k}"`);
    if (!oneOf(f.bucket, BUCKETS)) errors.push(`${at}.bucket must be one of ${BUCKETS.join('|')}`);
    if (!oneOf(f.category, CATEGORIES)) errors.push(`${at}.category must be one of ${CATEGORIES.join('|')}`);
    for (const k of ['title', 'detail', 'reasoning']) {
      if (typeof f[k] !== 'string' || f[k].trim() === '') errors.push(`${at}.${k} must be a non-empty string`);
      else if (f[k].length > FINDING_TEXT_MAX) errors.push(`${at}.${k} is longer than ${FINDING_TEXT_MAX} characters`);
    }
    if (typeof f.file !== 'string') errors.push(`${at}.file must be a string ("" when not file-specific)`);
    if (!Number.isInteger(f.line) || f.line < 0) errors.push(`${at}.line must be an integer >= 0`);
    if (!oneOf(f.ruling, FINDING_DECISIONS)) errors.push(`${at}.ruling must be one of ${FINDING_DECISIONS.join('|')}`);
    if (!oneOf(f.confidence, CONFIDENCES)) errors.push(`${at}.confidence must be one of ${CONFIDENCES.join('|')}`);
  });
  return errors;
}

// Fable's own findings as review items `R<n>-F<k>` (source 'fable'), already ruled by Fable itself. Only called with a
// PROVEN answer: an unproven one adds nothing (the round stays Fable-pending, see fablePendingRounds). Low confidence, or
// deferring a BLOCKING security / data finding to a follow-up, goes to a human exactly like an arbiter ruling would.
// `fingerprintFor(finding)` gives the cache fingerprint (it reads the code at head, so it is the caller's).
export function fableFindingItems(findings, round, { transcript = null, fingerprintFor = () => null } = {}) {
  if (!Number.isInteger(round) || round < 1) throw new Error(`invalid round ${String(round)}`);
  const errors = findingErrors(findings);
  if (errors.length > 0) throw new Error(`invalid findings: ${errors.join('; ')}`);
  return findings.map((f, i) => {
    const defersBlockingSecurity = f.bucket === 'BLOCKING' && SECURITY_CATEGORIES.includes(f.category) && f.ruling === 'FOLLOW-UP';
    let final = { decision: f.ruling, by: 'arbiter', needsHuman: false, reason: f.reasoning };
    if (f.confidence === 'low') final = { decision: f.ruling, by: 'arbiter', needsHuman: true, reason: 'arbiter low confidence' };
    else if (defersBlockingSecurity) final = { decision: f.ruling, by: 'arbiter', needsHuman: true, reason: 'would defer a blocking security/data finding' };
    const item = {
      id: `R${round}-F${i + 1}`,
      round,
      source: 'fable',
      bucket: f.bucket,
      category: f.category,
      title: f.title,
      file: f.file,
      line: f.line,
      detail: f.detail,
      codexReasoning: '',
      testable: false,
      arbiter: { ruling: f.ruling, confidence: f.confidence, reasoning: f.reasoning, transcript },
      final,
    };
    const fp = fingerprintFor(f);
    return fp ? { ...item, fingerprint: fp } : item;
  });
}

// A round recorded with `fableRequired` (codex-review: risk.mjs#reviewLane said fable) is reviewed by ONE Fable pass that
// rules on every Codex item and reviews the diff itself. Until that pass is PROVEN (`arbiter.proofOk === true`) the round
// is not reviewed, even when Codex found nothing: the Fable pass is the second review, not a dispute tie-break.
export const fablePendingRounds = (state) => (state?.rounds ?? [])
  .filter((r) => r?.fableRequired === true && r.baseOnly !== true && r.arbiter?.proofOk !== true)
  .map((r) => r.n);

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
    if (next.final?.by === 'test' || isOwnerRuled(next)) return next; // a test is evidence and the owner's word is final (also its cached copy, by 'cache'); no opinion overrides either
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

// ---- owner ruling (owner_approval: chat) ---------------------------------------------------

// A ruling the owner made in chat (`pipeline triage owner-ruling`) on an item that was waiting for a human. The quote is
// the owner's own words, kept so the ruling stays visible and checkable: it is published in the triage comment and counted at
// the final gate, where it never replaces the owner's "merge". The final it overrules is kept as `overruled`. ACCEPT leaves
// `implemented` false, so the exit rules still ask for the fix and a review round that covers it.
export function applyOwnerRuling(item, { decision, reason, ownerQuote, ruledAt }) {
  if (!DECISIONS.includes(decision)) throw new Error(`decision must be one of ${DECISIONS.join('|')}`);
  if (item.final?.needsHuman !== true) throw new Error(`${item.id} needs no human decision`);
  const next = structuredClone(item);
  next.final = { decision, by: 'owner', needsHuman: false, reason, ownerQuote, ruledAt, overruled: structuredClone(item.final) };
  return next;
}

// The marker is the quote, not `by`: a later round's cached copy of the ruling has by 'cache' and is still the owner's word.
export const isOwnerRuled = (item) => typeof item.final?.ownerQuote === 'string' && item.final.ownerQuote !== '';

export const ownerRuledItems = (state) => allItems(state).filter(isOwnerRuled);

// ---- cache and light lane -------------------------------------------------------------------

// A ruled item is not reopened unless its code changed (the fingerprint covers file, title and excerpt) AND it is the
// same kind of finding: the fingerprint says nothing about severity, so a ruling made for a WORTH CONSIDERING
// performance idea must not settle the same text when it comes back as a BLOCKING security bug. A cache entry (see
// ruledCacheFrom) therefore carries the bucket and category it was ruled under, and is reused only when both match.
// A dismissal (REJECT / FOLLOW-UP) of a security, auth, permissions or data category is never reused, whatever the
// bucket: those are looked at every time, unless the OWNER ruled on it (its final keeps the ownerQuote): asking again would make
// the owner rule twice on the same finding, and the copy still counts as ownerMerge at the final gate. An entry without bucket and category (a hand-built cache) is not reused.
export function reuseRuled(items, ruledCache) {
  return items.map((item) => {
    const next = structuredClone(item);
    if (next.final || !next.fingerprint) return next;
    if (!Object.hasOwn(ruledCache, next.fingerprint)) return next;
    const { bucket, category, followupIssue, implemented, ...final } = structuredClone(ruledCache[next.fingerprint]);
    if (bucket !== next.bucket || category !== next.category) return next;
    const dismissal = final.decision === 'REJECT' || final.decision === 'FOLLOW-UP';
    if (dismissal && SECURITY_CATEGORIES.includes(next.category) && !isOwnerRuled({ final })) return next;
    next.final = { ...final, by: 'cache' };
    // The issue filed for the earlier item is the issue for this one: carrying it keeps `followups create` from
    // filing the same suggestion again every round.
    if (typeof followupIssue === 'string' && followupIssue !== '' && !next.followupIssue) next.followupIssue = followupIssue;
    // The same finding (same code, same kind) was already accepted AND fixed: carrying the fix keeps it from reading as an
    // unimplemented ACCEPT that `mark-implemented` can never clear (no code changes for an already-fixed finding).
    if (final.decision === 'ACCEPT' && implemented === true) next.implemented = true;
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
      const prev = Object.hasOwn(cache, item.fingerprint) ? cache[item.fingerprint] : null;
      const issue = item.followupIssue || prev?.followupIssue || null;
      const fixed = item.final.decision === 'ACCEPT' && (item.implemented === true || (prev?.decision === 'ACCEPT' && prev.implemented === true));
      cache[item.fingerprint] = {
        ...structuredClone(item.final), bucket: item.bucket, category: item.category, ...(issue ? { followupIssue: issue } : {}),
        ...(fixed ? { implemented: true } : {}),
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
  const fablePending = fablePendingRounds(state);
  const clean =
    fablePending.length === 0 &&
    pending.length === 0 &&
    needsHuman.length === 0 &&
    openBlocking.length === 0 &&
    unimplemented.length === 0 &&
    newAccepted.length === 0 &&
    coverageValid;
  // Why: a PR whose LAST allowed round only accepted items that were then fixed and verified is not in trouble,
  // it just has fixes nobody re-reviewed (owner ruling 2026-10-20). One extra round rechecks them instead of
  // parking. It is the last: rounds.length > maxRounds is the record that it was used, so extraRound is false
  // afterwards and anything not clean parks as before. A stale coverage hash with no new accepts does not qualify.
  const capped = Number.isFinite(state?.maxRounds);
  const extraRound =
    capped &&
    rounds.length === state.maxRounds &&
    !clean &&
    fablePending.length === 0 &&
    pending.length === 0 &&
    needsHuman.length === 0 &&
    openBlocking.length === 0 &&
    unimplemented.length === 0 &&
    newAccepted.length > 0;
  const effectiveMaxRounds = capped ? state.maxRounds + (extraRound || rounds.length > state.maxRounds ? 1 : 0) : null;
  const reachedMax = capped && !clean && rounds.length >= state.maxRounds && !extraRound;
  return { clean, openBlocking, newAccepted, needsHuman, pending, unimplemented, reachedMax, extraRound, effectiveMaxRounds, coverageValid, fablePending };
}

// May round `n` start? Rounds stop at maxRounds, plus the one extra confirm round roundOutcome grants (extraRound). A state
// without a finite maxRounds (hand-built) is not capped. -> null when it may, else the reason it may not.
export function roundCapProblem(state, n) {
  const max = state?.maxRounds;
  if (!Number.isFinite(max) || n <= max) return null;
  if (n === max + 1 && (state.rounds ?? []).length === max && roundOutcome(state).extraRound) return null;
  return n === max + 1
    ? `round ${n} would pass review.max_rounds (${max}): only one extra round is allowed, and only when the last round's open items are all accepted fixes`
    : `round ${n} would pass review.max_rounds (${max}) and its one extra round`;
}

// True when the MOST RECENT clean round (one that accepted nothing new) reviewed exactly `contentHash`, no later
// round exists that is not clean, and no round has an unresolved item (spec R3'). An earlier clean round never
// vouches for content that a later round went on to change or to accept fixes for. Agrees with roundOutcome.
export function reviewValidFor(state, contentHash) {
  if (!hasContentHash(contentHash)) return false;
  if (allItems(state).some(unresolved)) return false;
  if (fablePendingRounds(state).length > 0) return false;
  const rounds = state?.rounds ?? [];
  const isClean = (round) => (round.items ?? []).every((item) => !isNewAccept(item));
  const lastClean = rounds.findLast(isClean);
  if (lastClean === undefined || lastClean !== rounds.at(-1)) return false;
  return lastClean.contentHashAtToHead === contentHash;
}
