// The two briefs a Fable review round can carry (arbiter needed picks one, arbiter apply proves against it).
//   full        today's brief: the whole review job, agent `arbiter`, proven at effort `high`.
//   fix-verify  a FIX ROUND: the previous counted round had ACCEPT items, so this round's diff is mostly their fixes. Fable still
//               reviews it (same model pin, same JSON contract, same proof-required rule) but with a narrow "verify these fixes" brief,
//               agent `arbiter-fix`, proven at effort `medium` or higher.
// The choice never decides WHETHER Fable runs (every Fable round still needs a proven pass: triage.mjs#fablePendingRounds), only how much
// exploration it is asked for. Anything that is not clearly a fix round is `full`.
import { applyPostMaxDefault, countsTowardCap, postMaxPolicy } from './triage.mjs';
import { DEFAULTS, baseConfigAt, loadConfig } from './config.mjs';
import { matchAny } from './glob.mjs';
import { isDocPath } from './doc-paths.mjs';

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

// ---- #374: the late lane and the fix-round scope ---------------------------------------------------------------------------------------------------------

// The 1-based ordinal of counted round n: how many counted rounds (triage.mjs#countsTowardCap) have a number up to and including n.
export const countedOrdinal = (state, n) => (state?.rounds ?? []).filter((r) => countsTowardCap(r) && r.n <= n).length;

// review.post_max_suggestions for the items of round `round` (#374 PR B): lib/triage.mjs#applyPostMaxDefault with the policy of the working-tree AND the fork-point config ('review' in either, or a
// config that cannot be read, is off) and the round's counted ordinal. Reads no config at all unless the round is past max + 1. Callers: `arbiter apply` and `triage validate` (the judge); nobody else.
export async function postMaxSettings({ state, round, root }) {
  const max = state?.maxRounds;
  if (!Number.isInteger(max)) return { policy: 'review' };
  const ordinal = countedOrdinal(state, round.n);
  if (ordinal <= max + 1) return { policy: 'review' };
  let configs;
  try {
    const loaded = await loadConfig(root);
    const fork = baseConfigAt(round.forkPoint, root);
    configs = [loaded.ok ? loaded.config : null, fork.ok ? fork.config : null];
  } catch {
    configs = [null];
  }
  return { policy: postMaxPolicy(configs), ordinal, max };
}
export async function postMaxApply(items, ctx) {
  return applyPostMaxDefault(items, await postMaxSettings(ctx));
}

const NEW_EXPORT = /^\s*export\s+(async\s+)?(function|class|const|let)\b/;

// What a FIX round adds, from the round's diffFiles entries: -> { nonTestLines, newFiles, newExports, limit, flagged, reasons }. Pure and total over valid input
// (a bad `files` or a missing config is a TypeError, so a mistake never reads as "not flagged").
// A file is a test only when EVERY config given (the working-tree and the trusted one: a fix round must not widen integrity.test_globs and then add code there) classifies
// it as one; a rename counts as a new file unless both its paths are test paths under every config. Flagged = more non-test added lines than the smallest
// review.fix_round_max_lines, or a new non-test SOURCE file (a document or a review.docs_exempt_paths file is not one). New exports are counted for the text only.
export function fixRoundScope({ files, config, configs }) {
  if (!Array.isArray(files)) throw new TypeError('fixRoundScope: files must be an array');
  const all = configs ?? (config ? [config] : []);
  if (all.length === 0 || all.some((c) => c === null || typeof c !== 'object')) throw new TypeError('fixRoundScope: a config is required');
  const isTest = (p) => all.every((c) => matchAny(p, c.integrity?.test_globs ?? DEFAULTS.integrity.test_globs, { nocase: true }));
  const isDocument = (p) => isDocPath(p) || all.some((c) => (c.review?.docs_exempt_paths ?? []).includes(p));
  const limit = Math.min(...all.map((c) => (Number.isInteger(c.review?.fix_round_max_lines) ? c.review.fix_round_max_lines : DEFAULTS.review.fix_round_max_lines)));
  let nonTestLines = 0;
  let newExports = 0;
  const newFiles = [];
  for (const f of files) {
    const paths = [...new Set([f.oldPath, f.newPath, f.path].filter(Boolean))];
    if (paths.every(isTest)) continue;
    const shown = f.path ?? f.newPath ?? f.oldPath;
    const added = Array.isArray(f.added) ? f.added : [];
    nonTestLines += added.length;
    newExports += added.filter((l) => NEW_EXPORT.test(String(l?.text ?? ''))).length;
    const isNew = f.status === 'A' || f.status === 'R' || f.status === 'C';
    if (isNew && !isDocument(shown)) newFiles.push(shown);
  }
  const reasons = [];
  if (nonTestLines > limit) reasons.push(`${nonTestLines} non-test added lines > ${limit} (review.fix_round_max_lines)`);
  if (newFiles.length > 0) reasons.push(`new non-test file${newFiles.length === 1 ? '' : 's'}: ${newFiles.slice(0, 5).join(', ')}${newFiles.length > 5 ? ` (+${newFiles.length - 5} more)` : ''}`);
  return { nonTestLines, newFiles, newExports, limit, flagged: reasons.length > 0, reasons };
}
