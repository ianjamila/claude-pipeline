// Who reviews a round, and at what effort: the decision table of plan 2026-11-11-codex-substitute-reviewer (R4-4, with R5-4's restriction), pure.
// `P codex-review` asks it before Codex runs (lib/review-round.mjs#planRound gathers the facts); the answer is `{route, evidence, effort, why}`.
//
// Rows, first match wins:
//   1  review.substitute.mode off                      -> Codex (the effort scaling below still applies; budget / governor never substitute)
//   2  a PROTECTED round                               -> Codex at the normal effort; a substitute only on a real quota refusal (decided later, from Codex's own error)
//   3  governor hard (>= codex_budget.hard) and the round is a SMALL fix-check       -> substitute, evidence 'governor'
//   4  the per-PR Codex budget is used up and the round is a SMALL fix-check          -> substitute, evidence 'budget'
//   5  otherwise                                       -> Codex; effort is lowered to review.effort.small_fix for a small fix-check or when the governor is soft
// Protected rounds: round 1, the first round after a maxRisk rise, a round with confirmFixed items, a resolution-only round, a whole-PR round that is owed.
// A SMALL fix-check (R5-4): the reviewed range is at most review.effort.small_fix_lines changed lines, adds no new file and touches no sensitive path
// (risk.high_risk_paths, review.arbiter_always_paths). Any other non-protected round stays on Codex however much was spent.
import { RISK_LEVELS, higherRisk, isSubstituteRound } from './state.mjs';

export const PROTECTED_KINDS = Object.freeze(['round-1', 'post-rise', 'confirm-fixed', 'resolution-only', 'whole-pr']);

const isRisk = (v) => RISK_LEVELS.includes(v);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// The effort of an ordinary Codex round, before any lowering: the risk lane's for round 1 and a whole-PR round, the follow-up lane's after that.
export function baseEffort({ effort, firstOrWholePr, level }) {
  return firstOrWholePr ? (effort[level] ?? effort.high) : effort.followup;
}

// -> { route: 'codex'|'substitute', evidence: 'none'|'budget'|'governor', effort, why, protected: [kinds], small, lowered?: 'small-fix'|'governor-soft' }
//   mode: review.substitute.mode; protectedKinds: subset of PROTECTED_KINDS; small: boolean; effort: { small_fix, ... } + `normal` (the base effort);
//   governor: null | { usedPct, soft, hard } (null: unreadable, governor off); budget: { used, budget }.
export function decideRoute({ mode, protectedKinds = [], small = false, normal, smallFix, governor = null, budget = null }) {
  const isProtected = protectedKinds.length > 0;
  const usedPct = governor !== null && Number.isFinite(governor.usedPct) ? governor.usedPct : null;
  const hard = usedPct !== null && usedPct >= governor.hard;
  const soft = usedPct !== null && usedPct >= governor.soft;
  const spent = budget !== null && Number.isFinite(budget.budget) && budget.used >= budget.budget;
  const codex = (why) => {
    const lowered = !isProtected && (small ? 'small-fix' : soft ? 'governor-soft' : null);
    return { route: 'codex', evidence: 'none', effort: lowered ? smallFix : normal, why: lowered ? `${why}; ${lowered}` : why, protected: protectedKinds, small, ...(lowered ? { lowered } : {}) };
  };
  if (mode === 'off') return codex('mode-off');
  if (isProtected) return codex(`protected: ${protectedKinds.join(', ')}`);
  if (hard && small) return { route: 'substitute', evidence: 'governor', effort: smallFix, why: 'governor-hard', protected: protectedKinds, small };
  if (spent && small) return { route: 'substitute', evidence: 'budget', effort: smallFix, why: 'budget-spent', protected: protectedKinds, small };
  return codex('codex');
}

// ---- what the state says -------------------------------------------------------------------------------------------------------------------

// Codex spend on this PR as the STATE records it (R5-4: a killed or retried process run costs nothing): every recorded Codex round (not base-only, not a
// substitute round, not a Fable refresh) plus every recorded Codex second review (one Codex run per distinct packet: inputDigest).
export function codexSpend(state) {
  const rounds = Array.isArray(state?.rounds) ? state.rounds : [];
  const codexRounds = rounds.filter((r) => r?.baseOnly !== true && r?.fableRefresh !== true && !isSubstituteRound(r)).length;
  const packets = new Set();
  let anonymous = 0;
  for (const r of rounds) {
    for (const item of Array.isArray(r?.items) ? r.items : []) {
      const sr = item?.secondReview;
      if (!isObject(sr) || (typeof sr.by === 'string' && sr.by.startsWith('substitute'))) continue;
      if (typeof sr.inputDigest === 'string' && sr.inputDigest !== '') packets.add(sr.inputDigest);
      else anonymous += 1;
    }
  }
  return codexRounds + packets.size + anonymous;
}

// Did the LAST recorded round raise the PR's maxRisk above what the rounds before it had? (The round after a rise is protected.)
export function lastRoundRaisedRisk(state) {
  const rounds = (Array.isArray(state?.rounds) ? state.rounds : []).filter((r) => r?.baseOnly !== true);
  if (rounds.length < 2) return false;
  const before = rounds.slice(0, -1).map((r) => r.risk).filter(isRisk).reduce((a, b) => higherRisk(a, b), undefined);
  const now = rounds.at(-1).risk;
  return before !== undefined && isRisk(now) && higherRisk(before, now) !== before;
}

// A whole-PR round is owed (R4-5, R5-9) only when an OPUS substitute round came before maxRisk rose to high and no whole-PR round (Codex or Fable)
// came after the rise: an all-Codex history owes nothing. An incremental round after the rise does not clear it.
export function wholePrOwed(state) {
  let seen;
  let opusBefore = false;
  let owed = false;
  for (const r of Array.isArray(state?.rounds) ? state.rounds : []) {
    if (r?.baseOnly === true) continue;
    if (isRisk(r.risk)) {
      const next = seen === undefined ? r.risk : higherRisk(seen, r.risk);
      if (seen !== undefined && next === 'high' && seen !== 'high' && opusBefore) owed = true;
      seen = next;
    }
    if (r.wholePr === true) owed = false;
    if (isSubstituteRound(r) && r.substitute?.agent !== 'substitute-fable') opusBefore = true;
  }
  return owed;
}

// Which protected kinds apply to the next round? `risen`: this round's own assessment is above the PR's maxRisk so far.
export function protectedKindsFor({ state, round, resolutionOnly = false, confirmCount = 0, risen = false }) {
  const kinds = [];
  if (round === 1 || (state?.rounds ?? []).length === 0) kinds.push('round-1');
  if (risen || lastRoundRaisedRisk(state)) kinds.push('post-rise');
  if (confirmCount > 0) kinds.push('confirm-fixed');
  if (resolutionOnly) kinds.push('resolution-only');
  if (wholePrOwed(state)) kinds.push('whole-pr');
  return kinds;
}
