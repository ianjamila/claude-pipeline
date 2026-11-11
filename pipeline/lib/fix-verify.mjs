// The two briefs a Fable review round can carry (arbiter needed picks one, arbiter apply proves against it).
//   full        today's brief: the whole review job, agent `arbiter`, proven at effort `high`.
//   fix-verify  a FIX ROUND: the previous counted round had ACCEPT items, so this round's diff is mostly their fixes. Fable still
//               reviews it (same model pin, same JSON contract, same proof-required rule) but with a narrow "verify these fixes" brief,
//               agent `arbiter-fix`, proven at effort `medium` or higher.
// The choice never decides WHETHER Fable runs (every Fable round still needs a proven pass: triage.mjs#fablePendingRounds), only how much
// exploration it is asked for. Anything that is not clearly a fix round is `full`.
import { countsTowardCap } from './triage.mjs';

export const BRIEF_FULL = 'full';
export const BRIEF_FIX_VERIFY = 'fix-verify';

export const BRIEFS = Object.freeze({
  [BRIEF_FULL]: Object.freeze({ brief: BRIEF_FULL, effort: 'high', agent: 'arbiter' }),
  [BRIEF_FIX_VERIFY]: Object.freeze({ brief: BRIEF_FIX_VERIFY, effort: 'medium', agent: 'arbiter-fix' }),
});

// Claude Code's effort levels, lowest first. A fix-verify pass is accepted at its own effort or any higher one (more effort is never a weaker review).
export const EFFORT_LEVELS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
export const effortsAtLeast = (min) => (EFFORT_LEVELS.includes(min) ? EFFORT_LEVELS.slice(EFFORT_LEVELS.indexOf(min)) : [min]);

// What a round's stored arbiter data expects. Legacy state (no `brief`), an unknown value a brief on a dispute-mode input or a forced --full (arbiter.forcedFull) is `full`.
export function expectationOf(arbiter) {
  return arbiter?.brief === BRIEF_FIX_VERIFY && arbiter.mode === 'review' && arbiter.forcedFull !== true ? BRIEFS[BRIEF_FIX_VERIFY] : BRIEFS[BRIEF_FULL];
}

// The effort(s) the proof accepts for an expectation: `high` exactly for full; `medium` or higher for fix-verify.
export const acceptedEfforts = (expectation) => (expectation.brief === BRIEF_FIX_VERIFY ? effortsAtLeast(expectation.effort) : expectation.effort);

// The ACCEPT items of the previous COUNTED round (baseOnly / resolutionOnly / fableRefresh rounds are skipped: countsTowardCap), or null
// when there is no such round. An ACCEPT that still waits for a human is not a fix anyone is making, so it does not count.
export function previousAccepts(state, n) {
  const previous = (state?.rounds ?? []).filter((r) => r.n < n && countsTowardCap(r)).at(-1);
  if (!previous) return null;
  const accepted = (previous.items ?? []).filter((i) => i?.final?.decision === 'ACCEPT' && i.final.needsHuman !== true);
  return { round: previous.n, accepted };
}

// The state-only part of the decision. -> { ok: true, previous } | { ok: false, reason }. The caller adds the git part (hard stops, paths).
export function fixRoundCandidate(state, round, { scope }) {
  if (scope !== 'round') return { ok: false, reason: 'whole-pr scope' };
  // The scope label only says an earlier proven pass exists; what the round was diffed against is its review base kind. Allow-list: 'previous'
  // (the plain from..head slice) and a round stored before the kind existed. 'whole-pr' (a conflicting base merge: the whole PR against the new
  // base) is a broad review; 'synthetic' is a tree id (the base branch was merged in cleanly) that merge-base-driven hard-stop scanning cannot take;
  // 'resolution' and anything unknown are not a plain fix slice either.
  const kind = round.reviewBaseKind;
  if (kind === 'synthetic') return { ok: false, reason: 'synthetic review base (the base branch was merged in since the previous round: its range cannot be hard-stop scanned against a tree)' };
  if (kind !== undefined && kind !== 'previous') return { ok: false, reason: `review base kind ${JSON.stringify(kind)} (only a plain previous-round slice can be a fix round)` };
  if (round.fableRefresh === true) return { ok: false, reason: 'fable refresh round' };
  if (round.resolutionOnly === true) return { ok: false, reason: 'resolution-only round' };
  const previous = previousAccepts(state, round.n);
  if (previous === null || previous.accepted.length === 0) return { ok: false, reason: 'no accepted item in the previous counted round' };
  return { ok: true, previous };
}
