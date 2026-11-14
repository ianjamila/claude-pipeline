// Deterministic rules of the review loop: when the arbiter must be called, which rulings are final,
// when a PR must go to a human, and when the loop may exit. A model never makes these decisions;
// this file does. Everything is pure: functions return new values and never mutate their inputs.
import { createHash } from 'node:crypto';
import { CATEGORIES } from './codex.mjs';
import { MIN_FABLE, compareVersions, parseModelId } from './model-floor.mjs';
import { isSensitivePath, threatModelsFor } from './risk.mjs';
import { RISK_LEVELS, isSubstituteRound, maxRiskOf, secondReviewerOf } from './state.mjs';
import { wholePrOwed } from './review-route.mjs';

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
    if (r.scope !== undefined && r.scope !== OUT_OF_MODEL) errors.push(`${r.id}: scope must be "${OUT_OF_MODEL}" when given`);
    else if (r.scope !== undefined && r.ruling !== 'FOLLOW-UP') errors.push(`${r.id}: scope is only allowed with ruling FOLLOW-UP`);
  }
  if (review) errors.push(...findingErrors(json.findings));
  else if (json.findings !== undefined) errors.push('findings are only accepted in a Fable review round');
  return { ok: errors.length === 0, errors };
}

// ---- Fable review rounds --------------------------------------------------------------------

// ---- threat models (review.threat_models, read from the trusted default-branch config; #374) ---------------------------------------------------------
// The one value `scope` may take on a ruling or a Fable finding: it says the item lies outside the threat model the arbiter's input stated for its file.
export const OUT_OF_MODEL = 'out-of-model';
const modelsAmong = (models, paths) => threatModelsFor(paths.map((p) => ({ path: p })), { review: { threat_models: Array.isArray(models) ? models : [] } });

// -> { name, waive } | null. `name` is the first model (config order) whose paths match the item's file: the marker `final.outOfModel`, set for every validated
// out-of-model FOLLOW-UP on such a file (so the filing gate sees it), whatever its bucket. `waive` is true only when the BLOCKING-security needsHuman
// exception may apply: (a) the file is a clean repo path that resolves to exactly ONE entry of the reviewed diff (`files`, git.mjs#diffFiles entries),
// (b) every path of that entry (old and new) matches one model (a rename out of the model is a human's), (c) the category is literally `security`
// (auth, permissions, data-integrity and data-loss keep their security-dismissal). Anything else: no waiver, today's rule.
function outOfModelOf(item, { models, files }) {
  if (!Array.isArray(models) || models.length === 0 || typeof item.file !== 'string' || item.file === '') return null;
  const hit = modelsAmong(models, [item.file])[0];
  if (hit === undefined) return null;
  const entries = Array.isArray(files) && locationProblem(item.file) === null ? files.filter((f) => entryPaths(f).includes(item.file)) : [];
  if (item.category === 'security' && entries.length === 1) {
    const paths = entryPaths(entries[0]);
    const whole = models.find((m) => modelsAmong([m], paths).length === 1 && paths.every((p) => modelsAmong([m], [p]).length === 1));
    if (whole !== undefined) return { name: whole.name, waive: true };
  }
  return { name: hit.name, waive: false };
}

// What Fable may raise on its own. A finding it raises is something to do, so it is ACCEPT (fix it here) or FOLLOW-UP (an
// issue), never REJECT. The cap keeps a runaway answer from flooding the triage comment.
export const FABLE_FINDINGS_MAX = 20;
const FINDING_DECISIONS = ['ACCEPT', 'FOLLOW-UP'];
const FINDING_KEYS = ['bucket', 'category', 'title', 'file', 'line', 'detail', 'ruling', 'confidence', 'reasoning', 'scope'];
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
    if (f.scope !== undefined && f.scope !== OUT_OF_MODEL) errors.push(`${at}.scope must be "${OUT_OF_MODEL}" when given`);
    else if (f.scope !== undefined && f.ruling !== 'FOLLOW-UP') errors.push(`${at}.scope is only allowed with ruling FOLLOW-UP`);
  });
  return errors;
}

// Fable's own findings as review items `R<n>-F<k>` (source 'fable'), already ruled by Fable itself. Only called with a
// PROVEN answer: an unproven one adds nothing (the round stays Fable-pending, see fablePendingRounds). Low confidence, or
// deferring a BLOCKING security / data finding to a follow-up, goes to a human exactly like an arbiter ruling would.
// `fingerprintFor(finding)` gives the cache fingerprint (it reads the code at head, so it is the caller's).
// `models` / `diffFiles`: the threat models in force and the reviewed diff (see outOfModelOf); none = today's rules.
export function fableFindingItems(findings, round, { transcript = null, fingerprintFor = () => null, models = [], diffFiles = null } = {}) {
  if (!Number.isInteger(round) || round < 1) throw new Error(`invalid round ${String(round)}`);
  const errors = findingErrors(findings);
  if (errors.length > 0) throw new Error(`invalid findings: ${errors.join('; ')}`);
  return findings.map((f, i) => {
    const defersBlockingSecurity = f.bucket === 'BLOCKING' && SECURITY_CATEGORIES.includes(f.category) && f.ruling === 'FOLLOW-UP';
    let final = { decision: f.ruling, by: 'arbiter', needsHuman: false, reason: f.reasoning };
    if (f.confidence === 'low') final = { decision: f.ruling, by: 'arbiter', needsHuman: true, reason: 'arbiter low confidence', cause: 'low-confidence' };
    else {
      const oom = f.scope === OUT_OF_MODEL && f.ruling === 'FOLLOW-UP' ? outOfModelOf(f, { models, files: diffFiles }) : null;
      if (oom !== null && (oom.waive || !defersBlockingSecurity)) final = { ...final, outOfModel: oom.name };
      else if (defersBlockingSecurity) final = { decision: f.ruling, by: 'arbiter', needsHuman: true, reason: 'would defer a blocking security/data finding', cause: 'security-dismissal' };
    }
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

// A round recorded with `fableRequired` (codex-review: risk.mjs#rateBranch / reviewLane said fable; a low-risk or size-only-medium PR gets the judge) is reviewed by ONE Fable pass that
// rules on every Codex item and reviews the diff itself. Until that pass is PROVEN (`arbiter.proofOk === true`) the round
// is not reviewed, even when Codex found nothing: the Fable pass is the second review, not a dispute tie-break.
// The Fable steps that stopped on the floor or a stale terminal and have not been proven since (round.arbiter.failure, written by arbiter.mjs).
export const arbiterFailures = (state) => (state?.rounds ?? [])
  .filter((r) => r?.arbiter?.failure && typeof r.arbiter.failure === 'object' && r.arbiter.proofOk !== true)
  .map((r) => ({ round: r.n, cause: r.arbiter.failure.cause, advice: r.arbiter.failure.advice ?? null }));

export const fablePendingRounds = (state) => (state?.rounds ?? [])
  .filter((r) => r?.fableRequired === true && r.baseOnly !== true && r.arbiter?.proofOk !== true)
  .map((r) => r.n);

// ---- Fable proofs below the floor (plan 2026-11-10 A4b: old proofs are re-reviewed, not grandfathered) -------------------------
// A proven Fable round: the Fable pass answered and its transcript was accepted (arbiter.mjs publishes modelProof only then).
const isProvenFableRound = (r) => r?.fableRequired === true && r.baseOnly !== true && r.arbiter?.proofOk === true;
// `gate` = { threshold, allow }: the version below which a proof is re-reviewed and the Fable ids the owner allowed by exact name. The commands read
// it from the registry (model-floor.mjs#readReviewGate: the owner's hold when it is below MIN_FABLE, else MIN_FABLE) and pass it in; these helpers stay pure.
const DEFAULT_GATE = { threshold: MIN_FABLE, allow: [] };
// The Fable ids a round was proven with (modelProof.models is keyed by model id) split by the threshold. A `claude-fable-*` id the parser cannot read
// is stale (fail closed, like the floor itself) unless the owner allowed it; an id of another family is not a Fable and is ignored. The allowance covers
// only an id the parser cannot read: an allowed id that parses is judged by version like any other, so one a later threshold has passed is stale again.
const fableModelsOf = (r, { threshold = MIN_FABLE, allow = [] } = DEFAULT_GATE) => {
  const min = parseModelId(threshold);
  const stale = [];
  const current = [];
  for (const id of Object.keys(r?.modelProof?.models && typeof r.modelProof.models === 'object' ? r.modelProof.models : {})) {
    const p = parseModelId(id);
    if (p === null) {
      if (allow.includes(id)) current.push(id);
      else if (/^claude-fable(-|$)/.test(id)) stale.push(id);
    } else if (p.family === 'fable') {
      (compareVersions(p, min) < 0 ? stale : current).push(id);
    }
  }
  return { stale, current };
};
// A later proven pass that supersedes older ones: every Fable id in it is at or above the threshold, and it reviewed the WHOLE PR
// (round.arbiter.scope 'whole-pr', stored when arbiter needed wrote the diff). A round without the stored scope is not one.
const supersedes = (r, gate) => {
  const { stale, current } = fableModelsOf(r, gate);
  return isProvenFableRound(r) && stale.length === 0 && current.length > 0 && r.arbiter?.scope === 'whole-pr';
};
// The proven Fable rounds whose recorded Fable model is below the threshold and that no LATER whole-PR pass at or above it replaced:
// [{ round, models }] in round order. review-complete and the final gate refuse a PR while this is non-empty; `state fable-refresh` is the way out.
export function staleFableRounds(state, gate = DEFAULT_GATE) {
  const rounds = state?.rounds ?? [];
  const out = [];
  for (const r of rounds) {
    if (!isProvenFableRound(r)) continue;
    const { stale } = fableModelsOf(r, gate);
    if (stale.length === 0) continue;
    if (rounds.some((later) => later.n > r.n && supersedes(later, gate))) continue;
    out.push({ round: r.n, models: [...stale].sort() });
  }
  return out;
}
// "rounds 1 (claude-fable-5-1), 3 (...)" for the refusal text.
export const staleFableSummary = (stale) => stale.map((s) => `${s.round} (${s.models.join(', ')})`).join(', ');
// Why review-complete and the final gate refuse such a PR, and the one command that fixes it.
export const staleFableReason = (stale, pr, threshold = MIN_FABLE) => `the Fable review pass of round ${staleFableSummary(stale)} was proven with a Fable older than ${threshold}: run \`pipeline state fable-refresh --pr ${pr}\` (one extra Fable pass that re-reviews the whole PR with the current Fable; it is not counted against review.max_rounds)`;
// A proven Fable pass that is not below the threshold (any scope; a proof that recorded no Fable id counts as it always did): the passes below it do
// not count for arbiter.mjs#writeFableDiff's "the first pass reviews the whole PR" rule, so the first fresh-model pass after old ones reads everything.
export const provenNotStale = (r, gate = DEFAULT_GATE) => isProvenFableRound(r) && fableModelsOf(r, gate).stale.length === 0;

// The proven Fable rounds that count as current ONLY because of an owner allowance (an id the parser cannot read) or a hold below MIN_FABLE (an id older
// than MIN_FABLE that the lowered threshold admits): [{ round, via: 'allow' | 'hold', id }] in round order. A round that is stale is not listed (the refusal
// names it). Pure: `gate` = { threshold, allow } as for staleFableRounds.
export function fableBypassRounds(state, gate = DEFAULT_GATE) {
  const min = parseModelId(MIN_FABLE);
  const out = [];
  for (const r of state?.rounds ?? []) {
    if (!provenNotStale(r, gate)) continue;
    for (const id of fableModelsOf(r, gate).current) {
      const p = parseModelId(id);
      if (p === null) out.push({ round: r.n, via: 'allow', id });
      else if (compareVersions(p, min) < 0) out.push({ round: r.n, via: 'hold', id });
    }
  }
  return out;
}
// One short line for review-complete and the final gate: "Fable round 3 counted via owner allowance X; Fable round 4 counted via owner hold Y (below Z)". null when none.
// The hold is named by the threshold it set (gate.threshold), which is the registry's hold whenever it is below MIN_FABLE.
export const fableBypassNote = (bypass, gate = DEFAULT_GATE) => (bypass.length === 0 ? null : bypass
  .map((b) => (b.via === 'allow' ? `Fable round ${b.round} counted via owner allowance ${b.id}` : `Fable round ${b.round} counted via owner hold ${gate.threshold} (below ${MIN_FABLE})`))
  .join('; '));

// ---- judge, tests ---------------------------------------------------------------------------

const invalidJudgeFinal = () => ({ decision: null, by: 'judge', needsHuman: true, reason: 'invalid judge output', cause: 'invalid-judge' });

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
    next.final = { decision: 'REJECT', by: 'test', needsHuman: true, reason: `test disproved, but it would dismiss a security/data item: ${evidence}`, cause: 'test-security' };
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
// `proofCause` names why an unproven answer is unproven when it is not the plain model-proof failure ('stale-model': the proof failed on the
// Fable floor alone).
// `models` / `diffFiles`: the threat models in force and the reviewed diff (see outOfModelOf); none = today's rules.
export function applyRulings(items, rulings, { proofOk, transcript, proofCause, models = [], diffFiles = null } = {}) {
  const list = Array.isArray(rulings) ? rulings : (rulings?.rulings ?? []);
  const byId = new Map(list.map((r) => [r.id, r]));
  return items.map((item) => {
    const next = structuredClone(item);
    const r = byId.get(item.id);
    if (!r) return next;
    // a test is evidence, the owner's word is final (also its cached copy, by 'cache'), and a Claude or forced final (also its cached copy) is
    // protected (E10): no opinion overrides any of them
    if (next.final?.by === 'test' || isOwnerRuled(next) || isProtectedFinal(next)) return next;
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
        reason: proofCause === 'stale-model' ? 'stale-model: the ruling came from a Fable older than this machine\'s floor' : 'model-proof failed: ruling not provably from Fable',
        cause: proofCause === 'stale-model' ? 'stale-model' : 'model-proof',
      };
    } else if (!rulingValid) {
      // Output a validator would have refused (wrong case, missing, wrong type): never act on it.
      next.final = {
        decision: validDecision(item.judge?.decision),
        by: 'arbiter',
        needsHuman: true,
        reason: 'invalid arbiter output',
        cause: 'invalid-arbiter',
      };
    } else if (r.confidence === 'low') {
      next.final = { decision: r.ruling, by: 'arbiter', needsHuman: true, reason: 'arbiter low confidence', cause: 'low-confidence' };
    } else {
      const oom = r.scope === OUT_OF_MODEL && r.ruling === 'FOLLOW-UP' ? outOfModelOf(item, { models, files: diffFiles }) : null;
      if (dismissesBlockingSecurity && !(oom?.waive === true)) {
        next.final = { decision: r.ruling, by: 'arbiter', needsHuman: true, reason: 'would dismiss a blocking security/data item', cause: 'security-dismissal' };
      } else {
        next.final = { decision: r.ruling, by: 'arbiter', needsHuman: false, reason: r.reasoning, ...(oom === null ? {} : { outOfModel: oom.name }) };
      }
    }
    return next;
  });
}

// ---- Claude's own rulings (plan 2026-11-05-claude-rulings.md section 10 and E1-E11) ----------------------------------------------

// Why an item waits for a human: `final.cause` (set where the final is made). The first five are malfunctions (a judge or arbiter answer that
// could not be used, or a terminal that cannot give the pinned Fable): Claude may not dismiss through them, only ACCEPT, or have the arbiter run again. The others are judgements a human may make.
// stale-model (the Fable that answered is older than this machine's floor) and stale-terminal (this terminal runs an older Claude Code build than
// the installed one) are malfunctions too: restart the terminal, update Claude Code, and run the review again.
export const MALFUNCTION_CAUSES = ['model-proof', 'invalid-arbiter', 'invalid-judge', 'stale-model', 'stale-terminal'];
// 'round-cap': an accepted fix taken out of the PR at the round limit and filed as a follow-up (applyRoundCapDefer). A judgement the owner can re-make, not a malfunction.
export const ROUND_CAP_CAUSE = 'round-cap';
const NEEDS_HUMAN_CAUSES = [...MALFUNCTION_CAUSES, 'low-confidence', 'security-dismissal', 'test-security', ROUND_CAP_CAUSE];
// The reason strings of states written before `cause` existed.
const LEGACY_CAUSES = [
  [/^model-proof failed/, 'model-proof'],
  [/^stale-model:/, 'stale-model'],
  [/^invalid arbiter output$/, 'invalid-arbiter'],
  [/^invalid judge output$/, 'invalid-judge'],
  [/^arbiter low confidence$/, 'low-confidence'],
  [/^would (dismiss a blocking security\/data item|defer a blocking security\/data finding)$/, 'security-dismissal'],
  [/^test disproved, but it would dismiss a security\/data item/, 'test-security'],
];

// A Claude ruling (or a cached copy of one, which keeps `final.claude`) and a final a second review forced (`forcedBy`): no later writer
// (settle, arbiter apply, the cache) may replace these; only Claude tightening to ACCEPT or the owner's typed ruling can.
export const isClaudeRuled = (item) => item?.final?.by === 'claude' || isObject(item?.final?.claude);
export const isProtectedFinal = (item) => isClaudeRuled(item) || typeof item?.final?.forcedBy === 'string';

// The cause of the item's needs-human final, kept in `final.claude.cause` once Claude has ruled; for an older state the reason string says;
// anything else is 'unknown', which is treated as critical.
export function needsHumanCause(item) {
  const final = item?.final;
  const kept = final?.claude?.cause;
  if (NEEDS_HUMAN_CAUSES.includes(kept)) return kept;
  if (NEEDS_HUMAN_CAUSES.includes(final?.cause)) return final.cause;
  if (isProtectedFinal(item)) return 'unknown';
  const reason = typeof final?.reason === 'string' ? final.reason : '';
  return LEGACY_CAUSES.find(([re]) => re.test(reason))?.[1] ?? 'unknown';
}

// Dismissing (REJECT or FOLLOW-UP) is critical, and needs a second review that also dismisses it, unless it is a FOLLOW-UP of a non-BLOCKING,
// non-security item with a known cause. ACCEPT is never a dismissal.
export function isCriticalDismissal(item, decision) {
  if (decision === 'ACCEPT') return false;
  return decision === 'REJECT' || item.bucket === 'BLOCKING' || SECURITY_CATEGORIES.includes(item.category) || needsHumanCause(item) === 'unknown';
}

const STRICTNESS = { ACCEPT: 3, 'FOLLOW-UP': 2, REJECT: 1 };
const strictest = (a, b) => (STRICTNESS[a] >= STRICTNESS[b] ? a : b);
const claudeFinalIsAccept = (item) => isProtectedFinal(item) && item.final.decision === 'ACCEPT';
const claudeDismissal = (item) => isClaudeRuled(item) && item.final.decision !== 'ACCEPT' && item.final.needsHuman !== true;
// A final the writers may still reopen (a second review, a Claude ruling): one waiting for a human, or a Claude dismissal. Anything else is settled.
export const finalIsReopenable = (item) => item.final?.needsHuman === true || claudeDismissal(item);
const RERUN = 're-run the judge/arbiter (\`arbiter needed\`) so it answers again, or rule ACCEPT';

// Why a second review (Codex) may not be run for this item, or null. Not for what is settled, built, already reviewed, or a malfunction.
export function secondReviewRefusal(item) {
  if (!isObject(item)) return 'no item given';
  // A deferral is a Claude dismissal, but a second review must not reopen it (it would spend Codex on what only the owner's typed ruling can change).
  if (isRoundCapDeferral(item)) return `${item.id} was deferred past the round limit (its fix is out of the PR and filed as a follow-up): only the owner's typed ruling can reopen it`;
  if (item.implemented === true) return `${item.id} is already implemented`;
  if (item.secondReview !== undefined) return `${item.id} already has a second review`;
  if (!finalIsReopenable(item)) {
    return `${item.id} is not waiting for a human decision and is not a Claude dismissal (settled finals are not reopened)`;
  }
  if (MALFUNCTION_CAUSES.includes(needsHumanCause(item))) return `${item.id} waits because of a ${needsHumanCause(item)} malfunction: ${RERUN}`;
  return null;
}

// Why Claude may not record this ruling alone, or null. `secondReview` overrides item.secondReview (the Codex verdict stored in the item).
export function claudeRulingRefusal(item, decision, { secondReview } = {}) {
  if (!isObject(item)) return 'no item given';
  const id = item.id;
  if (!DECISIONS.includes(decision)) return `decision must be one of ${DECISIONS.join('|')}`;
  // A fix deferred past the round limit is the owner's to reopen (owner-ruling); Claude's own ruling never touches it.
  if (isRoundCapDeferral(item)) return `${id} was deferred past the round limit (its fix is out of the PR and filed as a follow-up): only the owner's typed ruling can reopen it`;
  if (item.implemented === true) return `${id} is already implemented`;
  if (claudeFinalIsAccept(item)) {
    return decision === 'ACCEPT'
      ? `${id} is already ACCEPT`
      : `${id} is ACCEPT by Claude or a second review: Claude cannot loosen it; only the owner's typed ruling can`;
  }
  // A post-limit FOLLOW-UP (applyPostMaxDefault) may be tightened back to ACCEPT, never any other way (secondReviewRefusal keeps finalIsReopenable: a second review does not reopen it).
  if (!finalIsReopenable(item) && !(decision === 'ACCEPT' && isPostMaxFinal(item))) {
    return `${id} is not waiting for a human decision and is not a Claude dismissal (settled finals are not reopened)`;
  }
  if (decision === 'ACCEPT') return null;
  const cause = needsHumanCause(item);
  if (MALFUNCTION_CAUSES.includes(cause)) return `${id} waits because of a ${cause} malfunction, which Claude cannot dismiss: ${RERUN}`;
  const verdict = secondReview ?? item.secondReview;
  if (verdict?.decision === 'ACCEPT') return `${id}: the second review says ACCEPT, so it cannot be dismissed`;
  if (!isCriticalDismissal(item, decision)) return null;
  if (!isObject(verdict)) {
    return `${id}: this dismissal (REJECT, BLOCKING, security, or an unknown cause) needs a second review that also dismisses it at high confidence: run the second review first`;
  }
  if (!DECISIONS.includes(verdict.decision)) return `${id}: the second review verdict is unreadable (decision ${JSON.stringify(verdict.decision)})`;
  if (verdict.confidence !== 'high') return `${id}: the second review dismissed it only at ${JSON.stringify(verdict.confidence)} confidence, high is needed`;
  return null;
}

// The ruling itself: the stricter of Claude's and the second review's decision (ACCEPT > FOLLOW-UP > REJECT). Throws on anything refused.
export function applyClaudeRuling(item, { decision, reason, ruledAt }) {
  const refusal = claudeRulingRefusal(item, decision);
  if (refusal) throw new Error(refusal);
  const next = structuredClone(item);
  const codex = DECISIONS.includes(item.secondReview?.decision) ? item.secondReview.decision : null;
  next.final = {
    decision: codex === null ? decision : strictest(decision, codex),
    by: 'claude',
    needsHuman: false,
    reason,
    claude: { ruledAt, cause: needsHumanCause(item), critical: isCriticalDismissal(item, decision), overruled: structuredClone(item.final) },
  };
  return next;
}

// ---- deferring accepted fixes past the round limit (plan 2026-11-11-round-discipline-one-implementer.md, Item 1b) ---------------------------------
// The item-level mark `roundCapDeferral` ({ fixHead, reviewedHead, at }) outlives any later ruling (an owner ruling replaces `final`, not this), so the Rulings
// inventory keeps listing the item and the result cache never reuses it.
export const isRoundCapDeferral = (item) => isObject(item?.roundCapDeferral);
// Still the deferral Claude's CLI wrote (not yet re-ruled by the owner).
const isDeferralFinal = (item) => item?.final?.claude?.cause === ROUND_CAP_CAUSE;
// Only an ACCEPT the judge or the arbiter made may be deferred: never a test result, Claude's or a second review's final, the owner's word, or a cached copy.
export const DEFERRABLE_BY = Object.freeze(['judge', 'arbiter']);

// Why this item's accepted fix may not be deferred, or null (the item-level rules; the severity and the state-wide rules are deferEligibility's).
export function roundCapDeferRefusal(item) {
  if (!isObject(item)) return 'no item given';
  const id = item.id;
  if (item.final?.decision !== 'ACCEPT' || item.final.needsHuman === true) return `${id} is not an accepted fix`;
  if (item.implemented !== true) return `${id} is accepted but its fix is not implemented`;
  if (isOwnerRuled(item)) return `${id} was ruled by the owner: only the owner's typed ruling can loosen it`;
  if (isProtectedFinal(item)) return `${id} was ruled by Claude or forced by a second review: it cannot be loosened`;
  if (!DEFERRABLE_BY.includes(item.final.by)) return `${id} was accepted by ${item.final.by ?? 'unknown'}, not by the judge or the arbiter`;
  if (isRoundCapDeferral(item)) return `${id} was already deferred`;
  return null;
}

// The deferral: the accepted fix is out of the tree, so the item is a FOLLOW-UP again (the issue is filed by `followups create`). `implemented` and
// `implementedVia` go: nothing was built that a round would have to confirm. Throws on anything refused.
export function applyRoundCapDefer(item, { reason, ruledAt, fixHead, reviewedHead }) {
  const refusal = roundCapDeferRefusal(item);
  if (refusal) throw new Error(refusal);
  const { implementedVia: _via, implementedAfterRound: _mark, ...rest } = structuredClone(item);
  return {
    ...rest,
    implemented: false,
    final: {
      decision: 'FOLLOW-UP', by: 'claude', needsHuman: false, reason,
      claude: { ruledAt, cause: ROUND_CAP_CAUSE, critical: false, overruled: structuredClone(item.final), fixHead, reviewedHead },
    },
    roundCapDeferral: { fixHead, reviewedHead, at: ruledAt },
  };
}

// The state with those items deferred (each in its own round), nothing else touched.
export function deferItemsInState(state, ids, params) {
  const wanted = new Set(ids);
  return { ...state, rounds: (state.rounds ?? []).map((r) => ({ ...r, items: (r.items ?? []).map((i) => (wanted.has(i.id) ? applyRoundCapDefer(i, params) : i)) })) };
}

// Codex's answer to the second-review packet: {items:[{id, decision, confidence, reasoning}]}, strict like second-review.schema.json (no extra keys; every
// requested id exactly once; a real decision and confidence; a non-empty reasoning). Nothing is recorded unless this passes.
export function validateSecondReview(json, itemIds) {
  const errors = [];
  if (!isObject(json) || !Array.isArray(json.items)) return { ok: false, errors: ['second review output must be an object {"items": [...]}'] };
  for (const k of Object.keys(json)) if (k !== 'items') errors.push(`unexpected key "${k}"`);
  checkIds(json.items, itemIds, 'items', errors);
  for (const e of json.items) {
    if (!isObject(e) || typeof e.id !== 'string') continue; // already reported by checkIds
    for (const k of Object.keys(e)) if (!['id', 'decision', 'confidence', 'reasoning'].includes(k)) errors.push(`${e.id}: unexpected key "${k}"`);
    if (!oneOf(e.decision, DECISIONS)) errors.push(`${e.id}: decision must be one of ${DECISIONS.join('|')}`);
    if (!oneOf(e.confidence, CONFIDENCES)) errors.push(`${e.id}: confidence must be one of ${CONFIDENCES.join('|')}`);
    if (typeof e.reasoning !== 'string' || e.reasoning.trim() === '') errors.push(`${e.id}: reasoning must be a non-empty string`);
  }
  return { ok: errors.length === 0, errors };
}

// Stores the second review's verdict ({decision, confidence, reasoning, model, effort, inputDigest, ranAt}). A Codex ACCEPT forces the final ACCEPT at
// once (it only ever asks for more work); a dismissal leaves the final as it was: the item still waits for Claude's ruling or a human.
export function settleSecondReview(item, verdict) {
  const refusal = secondReviewRefusal(item);
  if (refusal) throw new Error(refusal);
  if (!isObject(verdict) || !DECISIONS.includes(verdict.decision)) throw new Error(`second review decision must be one of ${DECISIONS.join('|')}`);
  if (!CONFIDENCES.includes(verdict.confidence)) throw new Error(`second review confidence must be one of ${CONFIDENCES.join('|')}`);
  const next = structuredClone(item);
  next.secondReview = structuredClone(verdict);
  if (verdict.decision === 'ACCEPT') {
    next.final = {
      decision: 'ACCEPT',
      by: 'claude',
      forcedBy: 'second-review',
      needsHuman: false,
      reason: verdict.reasoning,
      claude: { ruledAt: verdict.ranAt, cause: needsHumanCause(item), critical: false, overruled: structuredClone(item.final) },
    };
  }
  return next;
}

// ---- owner ruling (owner_approval: chat) ---------------------------------------------------

// A ruling the owner made in chat (`pipeline triage owner-ruling`) on an item that was waiting for a human. The quote is
// the owner's own words, kept so the ruling stays visible and checkable: it is published in the triage comment and counted at
// the final gate, where it never replaces the owner's "merge". The final it overrules is kept as `overruled`. ACCEPT leaves
// `implemented` false, so the exit rules still ask for the fix and a review round that covers it.
export function applyOwnerRuling(item, { decision, reason, ownerQuote, ruledAt }) {
  if (!DECISIONS.includes(decision)) throw new Error(`decision must be one of ${DECISIONS.join('|')}`);
  // The owner may rule on an item waiting for a human, and (E6) on a Claude or forced final that is not implemented yet: the typed
  // override is the one path that may loosen what Claude settled.
  if (item.final?.needsHuman !== true && !(isProtectedFinal(item) && item.implemented !== true)) {
    throw new Error(isProtectedFinal(item) ? `${item.id} is already implemented; an owner ruling cannot reopen it` : `${item.id} needs no human decision`);
  }
  const next = structuredClone(item);
  next.final = { decision, by: 'owner', needsHuman: false, reason, ownerQuote, ruledAt, overruled: structuredClone(item.final) };
  return next;
}

// #110: what an owner ruling request is bound to. The owner is asked about the finding's TEXT, so the request carries a digest of
// it (`P triage ruling-request`) and `owner-ruling` recomputes it: a rebuilt review that reuses an id for a finding that says something
// else cannot reuse the ruling. Only the finding text is hashed (the fields of codex.mjs assignIds and of fableFindingItems, whose
// reasoning is item.arbiter.reasoning), never a decision field (final, owner-ruling results, implemented), so applying one ruling of
// a request leaves the digest of the others alone. First 12 hex of sha256 over one tuple per item, sorted by id.
export function rulingContentDigest(items) {
  const tuples = [...items]
    .map((i) => [String(i.id).toUpperCase(), i.source, i.bucket, i.category, i.title, i.file, i.line, i.detail, i.codexReasoning, i.arbiter?.reasoning].map((v) => v ?? null))
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return createHash('sha256').update(JSON.stringify(tuples)).digest('hex').slice(0, 12);
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
// `round` (the number of the round the copies belong to): a carried fix is recorded as made before that round (`implementedAfterRound` = round - 1), see markedBefore.
export function reuseRuled(items, ruledCache, { round } = {}) {
  return items.map((item) => {
    const next = structuredClone(item);
    if (next.final || !next.fingerprint) return next;
    if (!Object.hasOwn(ruledCache, next.fingerprint)) return next;
    const { bucket, category, followupIssue, implemented, ...final } = structuredClone(ruledCache[next.fingerprint]);
    if (bucket !== next.bucket || category !== next.category) return next;
    if (final.claude?.cause === ROUND_CAP_CAUSE) return next; // (a cache written by hand, or by a copy that kept it)
    const dismissal = final.decision === 'REJECT' || final.decision === 'FOLLOW-UP';
    if (dismissal && SECURITY_CATEGORIES.includes(next.category) && !isOwnerRuled({ final })) return next;
    next.final = { ...final, by: 'cache' };
    // The issue filed for the earlier item is the issue for this one: carrying it keeps `followups create` from
    // filing the same suggestion again every round.
    if (typeof followupIssue === 'string' && followupIssue !== '' && !next.followupIssue) next.followupIssue = followupIssue;
    // The same suggestion (same code, same kind) was already accepted AND fixed: carrying the fix keeps it from reading as an
    // unimplemented ACCEPT that `mark-implemented` can never clear. Never for a BLOCKING or security / data finding: raised
    // again on unchanged code, that is evidence the fix may be missing, so it stays open (and parks for a human) instead.
    const carriesFix = next.bucket !== 'BLOCKING' && !SECURITY_CATEGORIES.includes(next.category);
    if (final.decision === 'ACCEPT' && implemented === true && carriesFix) {
      next.implemented = true;
      if (Number.isInteger(round)) next.implementedAfterRound = round - 1;
    }
    return next;
  });
}

// A finding raised again after its fix was deferred past the round limit (same fingerprint as an item with roundCapDeferral whose follow-up issue is filed): the new
// item links that issue (followupIssue) and says so (`reraisedDeferral`, shown in the triage comment), so `followups create` reuses the issue instead of filing a second one.
// Only an item with no issue of its own is touched; the newest deferral wins. Pure: returns copies.
export function linkDeferredFollowups(items, priorItems) {
  const deferred = new Map();
  for (const p of priorItems ?? []) {
    if (!isRoundCapDeferral(p) || typeof p.fingerprint !== 'string' || p.fingerprint === '') continue;
    const issue = typeof p.followupIssue === 'string' ? p.followupIssue : p.followupIssue?.url;
    if (typeof issue === 'string' && issue !== '') deferred.set(p.fingerprint, { id: p.id, issue });
  }
  return items.map((item) => {
    const hit = typeof item?.fingerprint === 'string' ? deferred.get(item.fingerprint) : undefined;
    if (hit === undefined || item.followupIssue || isRoundCapDeferral(item)) return item;
    return { ...structuredClone(item), followupIssue: hit.issue, reraisedDeferral: { id: hit.id, issue: hit.issue } };
  });
}

// Only settled rulings are worth reusing; an item waiting for a human must be looked at again. Each entry is the
// final plus the bucket and category it was ruled under and the follow-up issue filed for it (if any).
export function ruledCacheFrom(items) {
  const cache = {};
  for (const item of items) {
    // A light-lane rejection is a default ("not triaged"), not a ruling: nobody looked at it.
    if (item.fingerprint && item.final && !item.final.needsHuman && item.final.by !== 'light-lane') {
      // A fix deferred past the round limit is never reused as a settled dismissal: the same text in a later round is looked at again.
      if (isDeferralFinal(item)) continue;
      // A Claude or forced dismissal of a BLOCKING or security item (or one that was critical when ruled) is looked at again, never reused (E10).
      if (isProtectedFinal(item) && item.final.decision !== 'ACCEPT'
        && (item.bucket === 'BLOCKING' || SECURITY_CATEGORIES.includes(item.category) || item.final.claude?.critical === true)) continue;
      const prev = Object.hasOwn(cache, item.fingerprint) ? cache[item.fingerprint] : null;
      const issue = item.followupIssue || prev?.followupIssue || null;
      // Newest wins: a later copy that is not marked fixed clears the flag.
      const fixed = item.final.decision === 'ACCEPT' && item.implemented === true;
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

// A round that only merged the base branch in ("Update branch") reviewed nothing of the PR's own: it does not count toward
// maxRounds. Nor does a round that is only the resolution of a merge conflict with the base branch (resolutionOnly: git.mjs#
// resolutionReviewBase proved the resolver only chose lines the two sides already had). That one IS a real review (Codex, triage
// and Fable all run), only the cap is waived. Nor does a Fable refresh round (fableRefresh: state fable-refresh re-runs ONLY the Fable pass on a head
// whose Fable proof is older than MIN_FABLE; it asks Codex nothing). Only the other rounds are counted by the cap.
export const countsTowardCap = (r) => r?.baseOnly !== true && r?.resolutionOnly !== true && r?.fableRefresh !== true;
export const reviewedRoundCount = (state) => (state?.rounds ?? []).filter(countsTowardCap).length;

// ---- owner-granted rounds (the pure side; the owner's records are looked up by the caller and INJECTED) ---------------------------
// `grants` is a function k -> [{ grantId, head, quote }]: the owner's open extra-round records for counted ordinal k (any head, newest first;
// hooks/lib/owner-go.mjs#ownerGrantedRounds with anyHead). A throwing or malformed lookup is no grant. `head` is the head under review: a
// record covers it when its (>= 12 hex) head is a prefix of it; with no head given every record counts (advisory callers).
const grantsOf = (grants, k) => {
  if (typeof grants !== 'function') return [];
  try {
    const found = grants(k);
    return Array.isArray(found) ? found.filter((g) => typeof g?.grantId === 'string' && typeof g.head === 'string') : [];
  } catch {
    return [];
  }
};
const coversHead = (g, head) => head === undefined || (typeof head === 'string' && head.startsWith(g.head));
// A grant with `past: true` is the owner's approval of a round that ALREADY ran (`state past-round-grant`): it admits nothing, so it lifts no limit and is not counted here.
const grantedRetained = (state) => (state?.rounds ?? []).filter((r) => countsTowardCap(r) && typeof r.ownerGrant?.grantId === 'string' && r.ownerGrant.past !== true).length;

// The counted ordinal (1-based) the automatic extra round took, or null. It is the counted round at max + 1 that no owner grant admitted:
// recorded `admission: 'auto-extra'`, or (a state written before admission was recorded) no admission and no ownerGrant.
export function autoExtraOrdinal(state) {
  const max = state?.maxRounds;
  if (!Number.isFinite(max)) return null;
  const r = (state?.rounds ?? []).filter(countsTowardCap)[max];
  if (r === undefined || (r.ownerGrant !== undefined && r.ownerGrant.past !== true)) return null;
  return r.admission === 'auto-extra' || r.admission === undefined ? max + 1 : null;
}

// The rounds whose new accepts still wait for a round that reviews their fixes: from the end back through the rounds that
// reviewed nothing of their own (baseOnly, skipped) and the resolution-only ones (their own accepts count, and so do the
// earlier round's, which a conflict resolved before the fix was made must not hide), up to the first round that counts toward
// the cap. Without that, a resolution round recorded between an accept and its fix would strand the confirm round.
const roundsAwaitingFixReview = (rounds) => {
  const out = [];
  for (let i = rounds.length - 1; i >= 0; i -= 1) {
    if (rounds[i]?.baseOnly === true) continue;
    out.push(rounds[i]);
    if (countsTowardCap(rounds[i])) break;
  }
  return out;
};

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
// Which Claude stands in for Codex on a round Codex refused: Fable when the PR EVER had high risk (maxRisk; a shrinking diff never brings Opus back), else
// Opus. An unreadable risk fails toward the stronger reviewer.
export const substituteAgentFor = (maxRisk) => (RISK_LEVELS.includes(maxRisk) && maxRisk !== 'high' ? 'substitute-opus' : 'substitute-fable');

// substituteRounds: the rounds a substitute reviewed first (state.mjs isSubstituteRound); maxRisk: the highest risk the PR ever had (state.mjs maxRiskOf).
export function roundOutcome(state, { grants, head } = {}) {
  const rounds = state?.rounds ?? [];
  const last = rounds.at(-1);
  const everything = allItems(state);
  const pending = idsOf(everything.filter((i) => !i.final));
  const needsHuman = idsOf(everything.filter((i) => i.final?.needsHuman));
  const openBlocking = idsOf(everything.filter(isOpenBlocking));
  const unimplemented = idsOf(everything.filter(isUnimplementedAccept));
  // What the last REVIEWED round newly accepted still needs a round to review its fixes. A baseOnly round (main merged in) has
  // no items, and must neither hide those accepts (clean) nor strand the confirm round once the fixes are made (extraRound).
  // A resolutionOnly round is reviewed (it has items, accepts and a Fable obligation like any round); only the cap skips it.
  const lastReviewed = rounds.findLast((r) => r?.baseOnly !== true);
  const newAccepted = idsOf(roundsAwaitingFixReview(rounds).flatMap((r) => r.items ?? []).filter(isNewAccept));
  const coverageValid =
    last !== undefined &&
    hasContentHash(last.contentHashAtToHead) &&
    hasContentHash(state.currentContentHash) &&
    last.contentHashAtToHead === state.currentContentHash;
  const fablePending = fablePendingRounds(state);
  const clean =
    lastReviewed !== undefined && // a state of base-only rounds alone reviewed nothing
    fablePending.length === 0 &&
    pending.length === 0 &&
    needsHuman.length === 0 &&
    openBlocking.length === 0 &&
    unimplemented.length === 0 &&
    newAccepted.length === 0 &&
    coverageValid;
  // Why: a PR whose LAST allowed round only accepted items that were then fixed and verified is not in trouble,
  // it just has fixes nobody re-reviewed (owner ruling 2026-10-20). One extra round rechecks them instead of
  // parking. It is the last: more than maxRounds reviewed rounds is the record that it was used, so extraRound is false
  // afterwards and anything not clean parks as before. A stale coverage hash with no new accepts does not qualify.
  // Rounds that only merged the base branch in (baseOnly) or only resolved a conflict with it (resolutionOnly) are not counted:
  // they neither use up a round nor the extra one.
  // newAccepted comes from the last REVIEWED round: a baseOnly round can be recorded before the accepted fixes are made (it needs
  // only an empty patch of the PR's own), and must change nothing about them.
  const reviewed = reviewedRoundCount(state);
  const capped = Number.isFinite(state?.maxRounds);
  const extraRound =
    capped &&
    reviewed === state.maxRounds &&
    !clean &&
    fablePending.length === 0 &&
    pending.length === 0 &&
    needsHuman.length === 0 &&
    openBlocking.length === 0 &&
    unimplemented.length === 0 &&
    newAccepted.length > 0;
  // An owner-granted round (REVISIONS 1-3): the automatic extra round wins (a grant for the ordinal it admits is never claimed, so it is not
  // counted twice), and a grant counts only while it is open for the round that would be next, for the head under review.
  const autoOrd = autoExtraOrdinal(state);
  const open = capped && !clean && reviewed >= state.maxRounds && !extraRound
    ? grantsOf(grants, reviewed + 1).find((g) => coversHead(g, head))
    : undefined;
  const effectiveMaxRounds = capped ? state.maxRounds + (extraRound || autoOrd !== null ? 1 : 0) + grantedRetained(state) + (open ? 1 : 0) : null;
  const reachedMax = capped && !clean && reviewed >= state.maxRounds && !extraRound && !open;
  const grantedRound = open ? { k: reviewed + 1, grantId: open.grantId, head: open.head, quote: typeof open.quote === 'string' ? open.quote : null } : null;
  return {
    clean, openBlocking, newAccepted, needsHuman, pending, unimplemented, reachedMax, extraRound, effectiveMaxRounds, coverageValid, fablePending,
    grantedRound, autoExtraOrdinal: autoOrd,
    substituteRounds: rounds.filter(isSubstituteRound).map((r) => r.n), maxRisk: maxRiskOf(state),
  };
}

// How may round `n` start? -> { admission, problem }. admission: 'uncounted' (baseOnly / resolutionOnly / fableRefresh: never capped, never needs or uses a
// grant), 'normal' (within maxRounds, or no finite maxRounds), 'auto-extra' (the one extra confirm round roundOutcome grants), 'owner' (an
// open owner grant for counted ordinal reviewed + 1 that covers `head`), or null with `problem` (the reason it may not). The automatic
// extra is checked first and wins; a grant only admits what ordinary admission does not cover.
export function roundAdmission(state, n, { baseOnly = false, resolutionOnly = false, fableRefresh = false, head, grants } = {}) {
  const max = state?.maxRounds;
  if (baseOnly || resolutionOnly || fableRefresh) return { admission: 'uncounted', problem: null };
  if (!Number.isFinite(max)) return { admission: 'normal', problem: null };
  const reviewed = reviewedRoundCount(state);
  const next = reviewed + 1;
  if (next <= max) return { admission: 'normal', problem: null };
  if (next === max + 1 && reviewed === max && roundOutcome(state).extraRound) return { admission: 'auto-extra', problem: null };
  const open = grantsOf(grants, next);
  if (open.some((g) => coversHead(g, head))) return { admission: 'owner', problem: null, k: next };
  if (open.length > 0) {
    return { admission: null, problem: `round ${n} is granted for head ${open[0].head.slice(0, 12)}, not ${String(head).slice(0, 12)}: ask again (triage round-request)` };
  }
  return {
    admission: null,
    problem: next === max + 1
      ? `round ${n} would pass review.max_rounds (${max}): only one extra round is allowed, and only when the last round's open items are all accepted fixes, or an owner-granted round`
      : `round ${n} would pass review.max_rounds (${max}) and its one extra round, or an owner-granted round`,
  };
}

// May round `n` start? Reviewed rounds stop at maxRounds, plus the one extra confirm round roundOutcome grants (extraRound) or one round the
// owner granted (roundAdmission). The round being started counts as one more reviewed round unless it is baseOnly (only the base branch
// merged in) or resolutionOnly (only a conflict with it resolved), which are never capped. A state without a finite maxRounds (hand-built)
// is not capped. -> null when it may, else the reason it may not.
export const roundCapProblem = (state, n, flags = {}) => roundAdmission(state, n, flags).problem;

// True when the last REVIEWED round (not baseOnly: a round that only merged the base branch in reviewed nothing) accepted
// nothing new, the latest round, base-only or not, covers exactly `contentHash`, and no round has an unresolved item (spec R3').
// An earlier clean round never vouches for content that a later round went on to change or to accept fixes for; base-only
// rounds after a clean reviewed round only carry its approval forward to the merged-in content. Agrees with roundOutcome.clean.
export function reviewValidFor(state, contentHash) {
  if (!hasContentHash(contentHash)) return false;
  if (allItems(state).some(unresolved)) return false;
  if (fablePendingRounds(state).length > 0) return false;
  const rounds = state?.rounds ?? [];
  const isClean = (round) => (round.items ?? []).every((item) => !isNewAccept(item));
  const lastReviewed = rounds.findLast((round) => round.baseOnly !== true);
  if (lastReviewed === undefined || !roundsAwaitingFixReview(rounds).every(isClean)) return false;
  return rounds.at(-1).contentHashAtToHead === contentHash;
}

// ---- the rulings inventory (E11) and review eligibility (E7, E9) -------------------------------------------------------------------
// The visible record of what was dismissed without the owner reading it: every dismissed (REJECT or FOLLOW-UP) BLOCKING or security-category
// item whose final is settled, one row each, with who decided it. The owner-go block prints it, the review-complete marker carries its
// digest, and the merge check compares both with the live state, so a dismissal nobody showed the owner cannot ride along.

const TITLE_MAX = 60;
const WHY_MAX = 140;
// Printable ASCII only (anything else becomes ?), white space collapsed, cut with "..." at max: a row is one line of one fixed shape, and a
// finding's text can never add a separator (the middle dot is not ASCII), a line or a quote of its own.
export const asciiLine = (s, max) => {
  const text = String(s ?? '').replace(/\s+/g, ' ').trim().replace(/[^\x20-\x7e]/g, '?');
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
};
// The issue number of a filed follow-up (a URL ending /issues/N), or null.
const issueNumber = (issue) => /\/issues\/(\d{1,9})$/.exec(typeof issue === 'string' ? issue : issue?.url ?? '')?.[1] ?? null;
// The "why" of a row. A deferral Claude's CLI wrote says what happened in the CLI's own words (never the agent's reason, which stays in the state and the triage
// comment): who accepted the fix, that it is out of this merge, and the issue. Anything else, and a deferral the owner re-ruled, shows the final's reason.
function rowWhy(item) {
  if (isPostMaxFinal(item)) {
    const pmx = item.final.postMax;
    const issue = issueNumber(item.followupIssue);
    return `accepted by ${pmx.by === 'judge' ? 'judge' : 'arbiter'} in round ${asciiLine(pmx.ordinal, 6)} past limit ${asciiLine(pmx.max, 6)}; NOT fixed in this merge; ${issue ? `issue #${issue}` : 'issue not filed yet'}`;
  }
  if (!(isRoundCapDeferral(item) && isDeferralFinal(item))) return item.final.reason;
  const accepted = item.final.claude.overruled?.by;
  const issue = issueNumber(item.followupIssue);
  return `deferred past the round limit; accepted by ${accepted === 'arbiter' ? 'arbiter' : 'judge'}; fix ${String(item.roundCapDeferral.fixHead ?? '').slice(0, 12)} removed, NOT in this merge; ${issue ? `issue #${issue}` : 'issue not filed yet'}`;
}
const byLabel = (item) => {
  const by = item.final?.by;
  if (by === 'claude' && isRoundCapDeferral(item)) return 'claude (round limit)';
  // who reviewed it second is part of the bound Rulings row (R5-5): claude+codex | claude+substitute-opus | claude+substitute-fable
  if (by === 'claude') return item.secondReview !== undefined ? `claude+${secondReviewerOf(item.secondReview)}` : 'claude';
  if (by === 'arbiter' && typeof item.final?.outOfModel === 'string' && item.final.outOfModel !== '') return `arbiter (outside threat model ${asciiLine(item.final.outOfModel, 40)})`;
  return typeof by === 'string' && by !== '' ? by : 'unknown';
};
const isCriticalItem = (item) => item.bucket === 'BLOCKING' || SECURITY_CATEGORIES.includes(item.category);
const byIdAsc = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// -> { rows: [line], count }. Sorted by id; a by:'cache' copy is skipped when an item with the same fingerprint is already listed (a ruling
// that was carried into later rounds is one dismissal, not several).
function inventoryEntries(state) {
  const dismissed = allItems(state)
    .filter((i) => (i.final?.decision === 'REJECT' || i.final?.decision === 'FOLLOW-UP') && i.final.needsHuman !== true && (isCriticalItem(i) || isRoundCapDeferral(i) || isPostMaxFinal(i)))
    .map((i) => ({ item: i, id: String(i.id) }))
    .sort(byIdAsc);
  const listed = new Set();
  const kept = [];
  for (const entry of [...dismissed.filter((e) => e.item.final.by !== 'cache'), ...dismissed.filter((e) => e.item.final.by === 'cache')]) {
    const fp = typeof entry.item.fingerprint === 'string' && entry.item.fingerprint !== '' ? entry.item.fingerprint : null;
    if (entry.item.final.by === 'cache' && fp !== null && listed.has(fp)) continue;
    if (fp !== null) listed.add(fp);
    kept.push(entry);
  }
  // Deferral rows (a fix taken out at the round limit, an ACCEPT turned into a FOLLOW-UP past it) are their own group, after the critical rows; within a group by id.
  const group = (item) => (isRoundCapDeferral(item) || isPostMaxFinal(item) ? 1 : 0);
  return kept.sort((a, b) => group(a.item) - group(b.item) || byIdAsc(a, b)).map(({ item, id }) => ({ item, id, row: [
    id, item.final.decision, item.bucket, asciiLine(item.category, 40) || '-', `by ${byLabel(item)}`, `content ${rulingContentDigest([item])}`,
    `"${asciiLine(String(item.title ?? '').replace(/"/g, "'"), TITLE_MAX)}"`, `why: ${asciiLine(rowWhy(item), WHY_MAX)}`,
  ].join(' · ') }));
}

export function rulingsInventory(state) {
  const rows = inventoryEntries(state).map((e) => e.row);
  return { rows, count: rows.length };
}

// The inventory rows of the dismissals CLAUDE made (final.by 'claude', or a cached copy carrying final.claude): [{ id, row }]. The gated merge route counts each as an owner item (E3).
export const claudeRulingRows = (state) => inventoryEntries(state).filter((e) => isClaudeRuled(e.item)).map(({ id, row }) => ({ id, row }));

// sha256 hex of the rows joined by a newline; 'none' when there are no rulings.
export function rulingsDigest(state) {
  const { rows } = rulingsInventory(state);
  return rows.length === 0 ? 'none' : createHash('sha256').update(rows.join('\n')).digest('hex');
}

// ---- the substitute inventory (plan 2026-11-11-codex-substitute-reviewer R4-1) --------------------------------------------------------------
// Every review a Claude stand-in did instead of Codex: each substitute FIRST review (a round) and each substitute SECOND review (an item whose
// secondReview.by starts with `substitute`). ONE list, read by the final gate's review check, the owner-go scan, review-complete and the merge routes,
// so none of them can disagree about whether a PR carries one. [{ round | item, agent, evidence, models }], rounds first (by number), then items (by id).
const strOrNull = (v) => (typeof v === 'string' && v !== '' ? v : null);
// (the proof keeps models as an object keyed by model id, like modelProof.models; a list is read the same way)
const modelsOf = (v) => [...new Set((Array.isArray(v) ? v : v !== null && typeof v === 'object' ? Object.keys(v) : []).filter((m) => typeof m === 'string' && m !== ''))].sort();
export function substituteInventory(state) {
  const rounds = (Array.isArray(state?.rounds) ? state.rounds : []).filter(isSubstituteRound)
    .map((r) => ({ round: r.n, agent: strOrNull(r.substitute?.agent) ?? 'substitute', evidence: strOrNull(r.substitute?.evidence), models: modelsOf(r.substitute?.models ?? r.substitute?.proof?.models) }))
    .sort((a, b) => a.round - b.round);
  const seen = new Set();
  const items = [];
  for (const item of allItems(state)) {
    const sr = item?.secondReview;
    if (typeof sr?.by !== 'string' || !sr.by.startsWith('substitute')) continue;
    // a cached copy of a ruled item carries its secondReview into later rounds: one review, listed once
    const key = typeof item.fingerprint === 'string' && item.fingerprint !== '' ? `${item.fingerprint}|${sr.by}` : `${String(item.id)}|${sr.by}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ item: String(item.id), agent: sr.by, evidence: strOrNull(sr.evidence), models: modelsOf(sr.models ?? sr.proof?.models) });
  }
  items.sort((a, b) => (a.item < b.item ? -1 : a.item > b.item ? 1 : 0));
  return [...rounds, ...items];
}

// sha256 hex of the inventory; 'none' when the PR has no substitute review. The marker's `substituteDigest` and the owner item both come from it.
export function substituteDigest(state) {
  const inv = substituteInventory(state);
  return inv.length === 0 ? 'none' : createHash('sha256').update(JSON.stringify(inv)).digest('hex');
}

// The owner-merge item line (`<kind> <area> <sha12>`: areasOf reads the second word, the owner-go hook binds the digest of the lines); null without substitute reviews.
export function substituteItemLine(state) {
  const digest = substituteDigest(state);
  return digest === 'none' ? null : `review-substitute substitute ${digest.slice(0, 12)}`;
}

// What the marker records beside the digest: { rounds, agents, models }; null without substitute reviews. `rounds` are the first-review rounds only.
export function substituteSummary(state) {
  const inv = substituteInventory(state);
  if (inv.length === 0) return null;
  return {
    rounds: inv.filter((e) => e.round !== undefined).map((e) => e.round),
    agents: [...new Set(inv.map((e) => e.agent))].sort(),
    models: [...new Set(inv.flatMap((e) => e.models))].sort(),
  };
}

// Why ONE recorded substitute review (a round's `substitute`, or the {agent, proof} of a second review) does not stand as proof: [string], one per problem, each led by `label`.
// The agent is one of the two pinned ones and is the strength the risk needed (`risk`: where the highest risk so far was high needs substitute-fable; a stronger agent than needed is
// fine), the proof names its transcript, the models in it are the agent's family (claude-opus-* / claude-fable-*), effort is high, and a Fable is not below the floor (`gate` = { threshold,
// allow } as for staleFableRounds: a floor raised between the apply and the merge makes the review stale).
// `floorOk`: a later whole-PR pass at or above the floor replaced this review's Fable (staleFableRounds' supersession rule): its Fable being old is then no problem. `pr` names the fix.
function substituteProofIssues(sub, risk, gate, label, { floorOk = false, pr } = {}) {
  const out = [];
  const why = (text) => out.push(`${label}: ${text}`);
  if (sub === null || typeof sub !== 'object' || Array.isArray(sub)) { why('marked as a substitute review but records no substitute proof'); return out; }
  if (sub.agent !== 'substitute-opus' && sub.agent !== 'substitute-fable') { why(`agent ${JSON.stringify(sub.agent ?? null)} is not substitute-opus or substitute-fable`); return out; }
  if (sub.agent === 'substitute-opus' && substituteAgentFor(risk) === 'substitute-fable') why('the PR was high-risk at this review, which needs substitute-fable, but substitute-opus reviewed it');
  const proof = sub.proof;
  const models = modelsOf(proof?.models);
  if (proof === null || typeof proof !== 'object' || typeof proof.transcript !== 'string' || proof.transcript === '') why('no proof transcript recorded');
  else if (models.length === 0) why('the proof records no model');
  else {
    const family = sub.agent === 'substitute-fable' ? /^claude-fable(-|$)/ : /^claude-opus(-|$)/;
    const wrong = models.filter((m) => !family.test(m));
    if (wrong.length > 0) why(`${sub.agent} was proven with ${wrong.join(', ')}, not a ${sub.agent === 'substitute-fable' ? 'Fable' : 'Opus'}`);
    if (sub.agent === 'substitute-fable' && wrong.length === 0) {
      const { stale, current } = fableModelsOf({ modelProof: { models: Object.fromEntries(models.map((m) => [m, 1])) } }, gate);
      if (!floorOk && (stale.length > 0 || current.length === 0)) why(`its Fable ${stale.join(', ') || models.join(', ')} is below the Fable floor ${gate.threshold}: run \`pipeline state fable-refresh${pr === undefined ? '' : ` --pr ${pr}`}\` (one extra Fable pass that re-reviews the whole PR with the current Fable; it is not counted against review.max_rounds)`);
    }
  }
  if (String(proof?.effort ?? '') !== 'high') why(`effort ${JSON.stringify(proof?.effort ?? null)} is not high`);
  return out;
}

// Why a recorded substitute review does not stand as proof, or []. Re-judged from the state at every gate (a state file is just JSON): every substitute FIRST review (a round) and every
// substitute SECOND review (an item whose secondReview.by starts with `substitute`), by the same rules (substituteProofIssues). The risk a round needed: the highest known up to and
// including it, else (no risk recorded) the PR's, failing toward the stronger reviewer; a second review is judged at the round that first holds it (a cached copy in a later round is
// the same review, listed once as in the inventory). [string] one per problem.
export function substituteProofProblems(state, gate = DEFAULT_GATE) {
  const out = [];
  const rounds = Array.isArray(state?.rounds) ? state.rounds : [];
  const judged = new Set();
  let seen;
  for (const r of rounds) {
    const known = RISK_LEVELS.includes(r?.risk);
    if (known) seen = seen === undefined || RISK_LEVELS.indexOf(r.risk) > RISK_LEVELS.indexOf(seen) ? r.risk : seen;
    const risk = seen ?? maxRiskOf(state);
    const floorOk = rounds.some((later) => later.n > r.n && supersedes(later, gate));
    if (isSubstituteRound(r)) out.push(...substituteProofIssues(r.substitute, risk, gate, `round ${r.n}`, { floorOk, pr: state?.pr }));
    for (const item of Array.isArray(r?.items) ? r.items : []) {
      const sr = item?.secondReview;
      if (typeof sr?.by !== 'string' || !sr.by.startsWith('substitute')) continue;
      const key = typeof item.fingerprint === 'string' && item.fingerprint !== '' ? `${item.fingerprint}|${sr.by}` : `${String(item.id)}|${sr.by}`;
      if (judged.has(key)) continue;
      judged.add(key);
      out.push(...substituteProofIssues({ agent: sr.by, proof: sr.proof }, risk, gate, `second review of ${String(item.id)}`, { floorOk, pr: state?.pr }));
    }
  }
  return out;
}

// The rounds holding a substitute-fable review (a round's own, or a second review first held there) whose Fable is below the floor and that no LATER whole-PR pass at or above
// it replaced: [{ round, models }] in round order. Like staleFableRounds for the arbiter's pass: `state fable-refresh` is the way out (its whole-PR Fable pass supersedes them),
// and the historical substitute inventory stays as recorded.
export function staleSubstituteFableRounds(state, gate = DEFAULT_GATE) {
  const rounds = Array.isArray(state?.rounds) ? state.rounds : [];
  const staleOf = (sub) => {
    if (sub?.agent !== 'substitute-fable') return [];
    const models = modelsOf(sub.proof?.models);
    if (models.length === 0 || models.some((m) => !/^claude-fable(-|$)/.test(m))) return [];
    return fableModelsOf({ modelProof: { models: Object.fromEntries(models.map((m) => [m, 1])) } }, gate).stale;
  };
  const out = [];
  const judged = new Set();
  for (const r of rounds) {
    const stale = new Set(isSubstituteRound(r) ? staleOf(r.substitute) : []);
    for (const item of Array.isArray(r?.items) ? r.items : []) {
      const sr = item?.secondReview;
      if (typeof sr?.by !== 'string' || !sr.by.startsWith('substitute')) continue;
      const key = typeof item.fingerprint === 'string' && item.fingerprint !== '' ? `${item.fingerprint}|${sr.by}` : `${String(item.id)}|${sr.by}`;
      if (judged.has(key)) continue;
      judged.add(key);
      for (const m of staleOf({ agent: sr.by, proof: sr.proof })) stale.add(m);
    }
    if (stale.size === 0 || rounds.some((later) => later.n > r.n && supersedes(later, gate))) continue;
    out.push({ round: r.n, models: [...stale].sort() });
  }
  return out;
}

// A high-risk PR whose substitute rounds are Opus alone: nothing since reviewed the WHOLE PR at the strength its risk needs. Either the rise to high came after an Opus
// round and no whole-PR round followed (review-route.mjs#wholePrOwed), or maxRisk is high with an Opus round and no whole-PR round after the last of them. null = fine.
export function substituteEscalationProblem(state) {
  if (maxRiskOf(state) !== 'high') return null;
  const rounds = Array.isArray(state?.rounds) ? state.rounds : [];
  const lastOpus = rounds.findLastIndex((r) => isSubstituteRound(r) && r.substitute?.agent !== 'substitute-fable');
  if (lastOpus < 0) return null;
  if (!wholePrOwed(state) && rounds.slice(lastOpus + 1).some((r) => r?.wholePr === true)) return null;
  const opus = rounds.filter((r) => isSubstituteRound(r) && r.substitute?.agent !== 'substitute-fable').map((r) => r.n);
  return `this PR is high-risk but its substitute review round(s) ${opus.join(', ')} were Opus and no whole-PR round (Codex or substitute-fable) has run since: run a whole-PR review round (pipeline state outcome shows base), then review-complete`;
}

// Why review-complete and every gate route refuse a PR that holds substitute reviews, or null: { error: 'substitute-escalation' | 'substitute-unproven', reason }.
export function substituteRefusal(state, gate = DEFAULT_GATE) {
  const escalation = substituteEscalationProblem(state);
  if (escalation !== null) return { error: 'substitute-escalation', reason: escalation };
  const problems = substituteProofProblems(state, gate);
  return problems.length === 0 ? null : { error: 'substitute-unproven', reason: `a substitute review is not proven: ${problems.join('; ')}` };
}

// `Rulings <digest first 12>` then the rows, one per line; '' when there are none.
export function rulingsBlock(state) {
  const { rows } = rulingsInventory(state);
  return rows.length === 0 ? '' : [`Rulings ${rulingsDigest(state).slice(0, 12)}`, ...rows].join('\n');
}

// What keeps a review from completing even though its items read as resolved (local, no marker, no GitHub). One line per problem, naming the ids:
// - a FOLLOW-UP that Claude ruled (or a cached copy of one) with no follow-up issue filed yet (E9: the issue is what makes the dismissal real);
// - an item marked implemented through files other than the one it names (item.implementedVia 'other-files', E7) that no LATER round's prompt
//   asked Codex to confirm (round.confirmFixed).
export function reviewEligibilityProblems(state) {
  const problems = [];
  const rounds = state?.rounds ?? [];
  const noIssue = allItems(state).filter((i) => isClaudeRuled(i) && i.final?.decision === 'FOLLOW-UP' && !i.followupIssue).map((i) => i.id);
  if (noIssue.length > 0) problems.push(`Claude-ruled follow-up(s) without a filed issue: ${noIssue.join(', ')} (run followups create, or rule them ACCEPT)`);
  // An arbiter FOLLOW-UP ruled outside a threat model (final.outOfModel) leaves the merge only through its issue, like the Claude-ruled one above (#374). Only here: roundOutcome is untouched.
  const noModelIssue = allItems(state).filter((i) => typeof i.final?.outOfModel === 'string' && i.final.decision === 'FOLLOW-UP' && !i.followupIssue).map((i) => i.id);
  if (noModelIssue.length > 0) problems.push(`out-of-model follow-up(s) without a filed issue: ${noModelIssue.join(', ')} (run followups create)`);
  // A post-limit FOLLOW-UP (final.postMax: an ACCEPT the judge or arbiter made, turned into a follow-up by review.post_max_suggestions) leaves the merge only through its issue. Only here: roundOutcome is untouched.
  const noPostMaxIssue = allItems(state).filter((i) => isPostMaxFinal(i) && !i.followupIssue).map((i) => i.id);
  if (noPostMaxIssue.length > 0) problems.push(`post-limit follow-up(s) without a filed issue: ${noPostMaxIssue.join(', ')} (run followups create)`);
  const unconfirmed = rounds.flatMap((r) => (r.items ?? [])
    .filter((i) => i.implementedVia === 'other-files' && !rounds.some((later) => later.n > r.n && Array.isArray(later.confirmFixed) && later.confirmFixed.includes(i.id)))
    .map((i) => i.id));
  if (unconfirmed.length > 0) problems.push(`fix(es) made outside the file the finding names, not yet confirmed by a later review round: ${unconfirmed.join(', ')} (run another codex-review round)`);
  return problems;
}

// ---- severity of an open item, and whether the round limit may be closed by deferring the fixes (plan Item 1a / 1b) ---------------------------------------
// ONE predicate for the ask (`triage round-request`, display only) and the command (`triage defer-fixes`, which decides). An item is LOW only when ALL hold, else HIGH
// (fail closed): a known non-BLOCKING bucket and a category on the allowlist (a bug is never low); not marked fixed through other files; not in the file of any BLOCKING or
// security ACCEPT; its location resolves to exactly one file of the reviewed diff; and that file (old and new path) is on no risk.high_risk_paths / review.arbiter_always_paths
// glob. hard_stops.paths is NOT consulted (owner 2026-11-11: with it a repository whose hard stops cover everything could never defer). A config error throws (TypeError):
// defer-fixes refuses on it, round-request shows the items as high with a warning.
export const LOW_SEVERITY_CATEGORIES = Object.freeze(['performance', 'maintainability', 'testing', 'design', 'docs', 'other']);

// A location the review can trust: repo-relative POSIX, nothing that climbs out, no drive letter, no leading ./ (git prints none).
const locationProblem = (file) => {
  if (typeof file !== 'string' || file === '') return 'it names no file';
  if (file.includes('\\') || file.startsWith('/') || /^[A-Za-z]:/.test(file)) return `its location (${asciiLine(file, 60)}) is not repo-relative`;
  if (file.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) return `its location (${asciiLine(file, 60)}) is not a clean repo path`;
  return null;
};
const entryPaths = (f) => [...new Set([f?.oldPath, f?.newPath, f?.path].filter((p) => typeof p === 'string' && p !== ''))];

// -> { level: 'low' | 'high', reasons: [why it is high] }. `files` = the PR's reviewed diff (git.mjs#diffFiles entries); null/undefined = unknown, so high.
export function itemSeverity(item, { state, config, files, baseConfig } = {}) {
  const high = (reason) => ({ level: 'high', reasons: [reason] });
  if (!isObject(item)) return high('not a review item');
  if (!BUCKETS.includes(item.bucket)) return high(`unknown bucket ${asciiLine(item.bucket, 30)}`);
  if (item.bucket === 'BLOCKING') return high('it is a BLOCKING finding');
  if (!LOW_SEVERITY_CATEGORIES.includes(item.category)) return high(`category ${asciiLine(item.category, 30) || 'unknown'} is not a low-severity kind`);
  if (item.implementedVia === 'other-files') return high('its fix was made in other files than the one it names');
  const bad = locationProblem(item.file);
  if (bad) return high(bad);
  if (!Array.isArray(files)) return high('the reviewed diff is not known');
  const hits = files.filter((f) => entryPaths(f).includes(item.file));
  if (hits.length === 0) return high(`${asciiLine(item.file, 60)} is not a file of the reviewed diff`);
  if (hits.length > 1) return high(`${asciiLine(item.file, 60)} is ambiguous in the reviewed diff`);
  // The same file under either side of a rename: the entry resolved above names both paths, and a finding at the other one is in this file too.
  const sameFile = entryPaths(hits[0]);
  if (allItems(state).some((i) => i.final?.decision === 'ACCEPT' && sameFile.includes(i.file) && (i.bucket === 'BLOCKING' || SECURITY_CATEGORIES.includes(i.category)))) {
    return high(`${asciiLine(item.file, 60)} also holds an accepted BLOCKING or security finding`);
  }
  // The union of the working-tree and the default branch's committed sensitive lists (callers pass baseConfig; a PR must not shrink its own list).
  if (isSensitivePath(hits[0], config) || (baseConfig && isSensitivePath(hits[0], baseConfig))) return high(`${asciiLine(item.file, 60)} is on a sensitive path`);
  return { level: 'low', reasons: [] };
}

const idList = (ids) => ids.join(', ');
// Was this implemented item's fix made before the last counted round? `implementedAfterRound` (the newest round number when it was marked) is below that round's number.
const markedBefore = (item, rounds) => {
  const counted = rounds.filter(countsTowardCap).at(-1);
  return Number.isInteger(item.implementedAfterRound) && counted !== undefined && counted.n > item.implementedAfterRound;
};

// May the round limit be closed by taking the accepted fixes OUT and filing them as follow-ups? Refusals 1, 2 and 5 of `defer-fixes`, evaluated on this state as if the tree were
// already back at the reviewed content (refusals 3 and 4 need git and are the command's). Pure. `grants` = k -> the owner's open extra-round records for counted round k at ANY head
// (a function, as roundOutcome takes it): an unspent grant for the next round always wins over a deferral, and a lookup that fails (or a `grantGap` of 'provenance') refuses.
// -> { eligible, refusals: [plain words], ids: [the accepts a round would have to review], severities: [{ id, level, reasons }] }. Throws (TypeError) on a config error.
export function deferEligibility(state, config, files, { grants, grantGap, baseConfig } = {}) {
  const refusals = [];
  const rounds = state?.rounds ?? [];
  const last = rounds.at(-1);
  if (last === undefined) return { eligible: false, refusals: ['no review round is recorded'], ids: [], severities: [] };
  if (!hasContentHash(last.contentHashAtToHead)) refusals.push('the last review round records no content hash');
  const o = roundOutcome({ ...state, currentContentHash: last.contentHashAtToHead });
  const reviewed = reviewedRoundCount(state);
  // Refusal 1: the limit is reached for good, and nothing else is open.
  if (!Number.isFinite(state?.maxRounds)) refusals.push('review.max_rounds is not set, so there is no limit to defer past');
  else if (reviewed < state.maxRounds) refusals.push(`the round limit (${state.maxRounds}) is not reached yet`);
  else if (o.extraRound) refusals.push('the automatic extra round is still available: run it');
  for (const [list, what] of [[o.fablePending.map(String), 'a Fable pass is owed for round(s)'], [o.pending, 'items still pending:'], [o.needsHuman, 'items wait for a human:'], [o.openBlocking, 'open BLOCKING items:'], [o.unimplemented, 'accepted items not implemented:']]) {
    if (list.length > 0) refusals.push(`${what} ${idList(list)}`);
  }
  const k = reviewed + 1;
  // Unlike roundOutcome (no readable grant = no round), here the permissive reading is "no grant", so what cannot be read refuses: a lookup that throws or answers
  // with anything but a list, and a record the owner may have typed but whose provenance could not be confirmed (`grantGap`: k -> 'none' | 'provenance' | 'ok').
  // Both callers pass the STRICT lookups (owner-go.mjs ownerGrantLookups: any skipped read throws); in the round-request ask a failure there is a warning and an 'extra-round' recommendation, never a missing line.
  let granted = [];
  let unreadable = false;
  if (typeof grants === 'function') {
    try {
      const found = grants(k);
      if (Array.isArray(found)) granted = found;
      else {
        unreadable = true;
        refusals.push(`the owner's extra-round records for round ${k} could not be read (the lookup answered with something other than a list): ask the owner for an extra round`);
      }
    } catch (err) {
      unreadable = true;
      refusals.push(`the owner's extra-round records for round ${k} could not be read (${asciiLine(err?.message, 120)}): ask the owner for an extra round`);
    }
  }
  if (granted.length > 0) refusals.push(`the owner granted extra round ${k} (unspent): run it, a typed "extra round" always wins`);
  else if (typeof grantGap === 'function' && !unreadable) {
    let gap;
    try {
      gap = grantGap(k);
    } catch (err) {
      refusals.push(`the owner's extra-round records for round ${k} could not be checked (${asciiLine(err?.message, 120)}): ask the owner for an extra round`);
    }
    if (gap === 'provenance') refusals.push(`an extra round is recorded for round ${k} but cannot be confirmed as typed by the owner: it may still be the owner's, so ask the owner for an extra round instead of deferring`);
  }
  // Refusal 2: exactly the accepts no round has reviewed, each low and each the judge's or the arbiter's.
  const ids = o.newAccepted;
  const byId = new Map(allItems(state).map((i) => [i.id, i]));
  if (ids.length === 0) refusals.push('no accepted fix is waiting for a review round, so there is nothing to defer');
  const severities = [];
  for (const id of ids) {
    const item = byId.get(id);
    const sev = itemSeverity(item, { state, config, files, baseConfig });
    severities.push({ id, ...sev });
    if (sev.level !== 'low') refusals.push(`${id} is not low severity (${sev.reasons.join('; ')})`);
    const why = roundCapDeferRefusal(item);
    if (why) refusals.push(why);
  }
  // Refusal 2b: every OTHER implemented accept, in ANY round, must be provably fixed before the last reviewed (counted) round: the state records when it was marked
  // (`implementedAfterRound`, the newest round number then; set by `state mark-implemented`, and by reuseRuled for a carried copy), and a later counted round reviewed a head that holds the fix.
  // Nothing makes an earlier round's accept fixed before the next round starts (a final can turn ACCEPT after it, a judge's accept can be left open), so a fix marked AFTER the last reviewed
  // round is out of the tree once every commit since that head is reverted while the state still says implemented, and the review would read clean without it. A mark with no
  // record (a state from before the field) cannot be proven: it refuses, and the extra round runs as before.
  const asked = new Set(ids);
  for (const i of allItems(state)) {
    if (i.final?.decision === 'ACCEPT' && i.implemented === true && !asked.has(i.id) && !markedBefore(i, rounds)) {
      refusals.push(`${i.id} is an accepted ${i.bucket === 'BLOCKING' || SECURITY_CATEGORIES.includes(i.category) ? 'BLOCKING or security ' : ''}fix marked implemented that is not proven to be in the last reviewed head (it was marked after that round, or the state does not say when): taking the fixes out would drop it, so run the round`);
    }
  }
  // Refusal 5: the state with those fixes deferred must read as a clean review (nothing left but the issues still to file).
  if (refusals.length === 0) {
    const proposed = deferItemsInState(state, ids, { reason: 'dry run', ruledAt: new Date(0).toISOString(), fixHead: 'dry', reviewedHead: 'dry' });
    const filed = { ...proposed, rounds: proposed.rounds.map((r) => ({ ...r, items: (r.items ?? []).map((i) => (isRoundCapDeferral(i) && !i.followupIssue ? { ...i, followupIssue: 'dry-run' } : i)) })) };
    const after = roundOutcome({ ...filed, currentContentHash: last.contentHashAtToHead });
    if (!after.clean) refusals.push('the review would still not be clean after the fixes are taken out');
    const problems = reviewEligibilityProblems(filed);
    if (problems.length > 0) refusals.push(problems.join('; '));
  }
  return { eligible: refusals.length === 0, refusals, ids, severities };
}

// ---- past the limit, a low-severity ACCEPT becomes a FOLLOW-UP (#374 PR B, review.post_max_suggestions) ------------------------------------------------
// 'follow-up' only when EVERY config given (working tree, fork point, trusted default branch) says so: 'review' in any, a config that cannot be read (null) or one without the key, is off.
export const postMaxPolicy = (configs) => (Array.isArray(configs) && configs.length > 0 && configs.every((c) => c?.review?.post_max_suggestions === 'follow-up') ? 'follow-up' : 'review');

// A settled FOLLOW-UP that applyPostMaxDefault made (final.postMax), still the judge's / arbiter's word (or a cached copy of it): not the owner's, not Claude's, not waiting for a human.
export const isPostMaxFinal = (item) => isObject(item?.final?.postMax) && item.final.decision === 'FOLLOW-UP' && item.final.needsHuman !== true && !isProtectedFinal(item) && !isOwnerRuled(item);

// `ordinal`: the counted ordinal of the round these items belong to (fix-verify.mjs#countedOrdinal; an uncounted round gets the counted rounds before it); `max`: review.max_rounds.
// Only a round past max + 1 is touched: the first round past the limit (the automatic extra round, or the owner's first grant when there was none) keeps its ACCEPTs; later owner-granted rounds are
// affected. Only an ACCEPT the judge or arbiter made on a SUGGESTION / WORTH_CONSIDERING item that itemSeverity rates LOW (a low-severity category, a location that resolves to one file of the reviewed
// diff, no accepted BLOCKING / security item in that file, no sensitive path under the working-tree or the trusted config), not yet implemented; never a bug, security item or BLOCKING one, a test
// result, a cached copy, Claude's, the owner's or a forced final. `severity` = { state, round, config, files, baseConfig } as itemSeverity takes them (`round`: the number of the round `items` belong
// to, whose items in `state` are replaced by `items` so this round's own accepts count); none given, an unreadable diff or config (null) or a config error (itemSeverity throws) keeps the ACCEPT.
export function applyPostMaxDefault(items, { policy, ordinal, max, severity } = {}) {
  if (policy !== 'follow-up' || !Number.isInteger(ordinal) || !Number.isInteger(max) || ordinal <= max + 1) return items;
  let view = null;
  if (isObject(severity) && isObject(severity.state)) {
    const ids = new Set(items.map((i) => i?.id));
    view = { ...severity.state, rounds: (severity.state.rounds ?? []).map((r) => (r?.n === severity.round ? { ...r, items: [...(r.items ?? []).filter((i) => !ids.has(i?.id)), ...items] } : r)) };
  }
  const lowSeverity = (item) => {
    if (view === null || !isObject(severity.config) || !isObject(severity.baseConfig)) return false;
    try {
      return itemSeverity(item, { state: view, config: severity.config, files: severity.files, baseConfig: severity.baseConfig }).level === 'low';
    } catch {
      return false;
    }
  };
  return items.map((item) => {
    const final = item?.final;
    if (!isObject(final) || final.decision !== 'ACCEPT' || final.needsHuman === true || !DEFERRABLE_BY.includes(final.by)) return item;
    if (item.implemented === true || isProtectedFinal(item) || isOwnerRuled(item)) return item;
    if (item.bucket !== 'SUGGESTION' && item.bucket !== 'WORTH_CONSIDERING') return item;
    if (!LOW_SEVERITY_CATEGORIES.includes(item.category)) return item;
    if (!lowSeverity(item)) return item;
    return { ...structuredClone(item), final: { ...structuredClone(final), decision: 'FOLLOW-UP', postMax: { from: 'ACCEPT', by: final.by, ordinal, max }, reason: `past review.max_rounds (round ${ordinal}, limit ${max}): ${final.reason}` } };
  });
}

// ---- the round trip-wire (#374 PR B): a prompt, not a gate ---------------------------------------------------------------------------------------------
// New ACCEPTs (not cached copies) per COUNTED round, in order. Trips when the PR has reviewed max + extraRounds counted rounds, or when at least `notFalling` past-limit rounds accepted
// at least as many new items as the round before AND some (zero accepts is not "not falling": nothing was found). Past the limit only; no finite maxRounds never trips.
// -> { tripped, reviewed, max, acceptsByRound, reasons }
export function roundTripWire(state, { extraRounds, notFalling }) {
  const counted = (state?.rounds ?? []).filter(countsTowardCap);
  const acceptsByRound = counted.map((r) => (r.items ?? []).filter(isNewAccept).length);
  const reviewed = counted.length;
  const max = state?.maxRounds;
  const reasons = [];
  if (Number.isFinite(max)) {
    if (reviewed >= max + extraRounds) reasons.push(`${reviewed} counted rounds reached review.max_rounds ${max} + ${extraRounds} (review.trip_wire_extra_rounds)`);
    let flat = 0;
    for (let k = max; k < reviewed; k += 1) if (k >= 1 && acceptsByRound[k] > 0 && acceptsByRound[k] >= acceptsByRound[k - 1]) flat += 1;
    if (flat >= notFalling) reasons.push(`${flat} past-limit round(s) accepted at least as many new items as the round before (review.trip_wire_not_falling ${notFalling}): ${acceptsByRound.join(', ')}`);
  }
  return { tripped: reasons.length > 0, reviewed, max: Number.isFinite(max) ? max : null, acceptsByRound, reasons };
}
