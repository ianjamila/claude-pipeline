// Review state: one JSON document that survives restarts (.review/state.json) and can be rebuilt
// from the PR's triage comment when the local copy is gone. The only IO in this module is
// loadState/saveState; everything else is pure.
import {
  closeSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';

const STATE_MARKER = /<!-- claude-pipeline:state:([A-Za-z0-9+/=]+) -->/g;
// A PR comment is at most 64 KiB, so real state is tiny; cap decompression so a hostile comment
// cannot make resume allocate gigabytes.
const MAX_DECODED_BYTES = 8 * 1024 * 1024;
// Windows (AV scanners, indexers) can briefly hold the target open, and rename then fails with a
// transient error. 20 retries x 50 ms is ~1 s of patience before giving up.
const RENAME_RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RENAME_RETRIES = 20;
const RENAME_WAIT_MS = 50;
const STRAY_TMP = /^state\.json\..+\.tmp$/;
const STRAY_TMP_MAX_AGE_MS = 60 * 60 * 1000;

// The newest state format this code understands. A state with a higher `version` was written by a newer pipeline: loadState refuses it and
// decodeFromComment reads it as no state, so an older reader never rules from a state it cannot fully see. Version 2: a Claude ruling or a
// second review wrote it. Version 3: `triage defer-fixes` wrote it (a deferral is a Claude dismissal an installation from before this change
// would leave out of the Rulings block and let Claude reopen). Version 4: the state holds a substitute-reviewed round or second review (a Claude stand-in for
// Codex while its quota was spent) or a budget / governor decision: a pipeline from before the substitute would read it as an ordinary Codex review.
// Every other state stays 1. (The plan 2026-11-11-codex-substitute-reviewer called this "3"; main had already used 3 for the deferral.)
export const SUPPORTED_STATE_VERSION = 4;
export const STATE_VERSION_CLAUDE = 2;
export const STATE_VERSION_DEFERRAL = 3;
export const STATE_VERSION_SUBSTITUTE = 4;
// The state at (at least) `version`: a writer never lowers the version a state already carries.
export const withStateVersion = (state, version) => ({ ...state, version: Math.max(Number.isFinite(state?.version) ? state.version : 1, version) });
const newerThanSupported = (state) => Number.isFinite(state.version) && state.version > SUPPORTED_STATE_VERSION;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// ---- substitute rounds and the sticky risk --------------------------------------------------------------------------------------------------
// A round reviewed first by the substitute (Claude) instead of Codex.
export const isSubstituteRound = (round) => round?.firstReviewer === 'substitute' || isPlainObject(round?.substitute);
const isSubstituteSecondReview = (item) => typeof item?.secondReview?.by === 'string' && item.secondReview.by.startsWith('substitute');
// The lowest version that may hold this state: 4 when it holds a substitute round / second review or a governor / budget decision.
export function requiredStateVersion(state) {
  const rounds = Array.isArray(state?.rounds) ? state.rounds : [];
  const needs = rounds.some((r) => isSubstituteRound(r) || isPlainObject(r?.governor) || isPlainObject(r?.budget) || (Array.isArray(r?.items) && r.items.some(isSubstituteSecondReview)));
  return needs ? STATE_VERSION_SUBSTITUTE : 1;
}
const withRequiredVersion = (state) => {
  const need = requiredStateVersion(state);
  return need > 1 ? withStateVersion(state, need) : state;
};

export const RISK_LEVELS = Object.freeze(['low', 'medium', 'high']);
const isRisk = (v) => RISK_LEVELS.includes(v);
export const higherRisk = (a, b) => (RISK_LEVELS.indexOf(b) > RISK_LEVELS.indexOf(a) ? b : a);
// The highest risk the PR ever had (it only goes up, so a shrinking diff never brings the cheaper reviewer back). `state.risk` is overwritten each round
// and shown as-is; agent choice and every gate use this. A state from before `maxRisk` existed starts it from state.risk and every round's recorded
// risk, and from 'high' when none of them is readable (fail toward the stronger reviewer).
export function maxRiskOf(state) {
  const known = [state?.maxRisk, state?.risk, ...(Array.isArray(state?.rounds) ? state.rounds.map((r) => r?.risk) : [])].filter(isRisk);
  return known.length === 0 ? 'high' : known.reduce(higherRisk);
}
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function emptyState({ repo, pr, branch, risk, lightLane = false, maxRounds = 3 }) {
  return {
    version: 1,
    repo,
    pr,
    branch,
    risk: risk ?? null,
    lightLane: lightLane === true,
    maxRounds,
    currentContentHash: '',
    rounds: [],
  };
}

const stateFile = (dir) => join(dir, '.review', 'state.json');

// A crashed save can leave state.json.<pid>.<id>.tmp behind. One that is over an hour old cannot be
// a write in progress, so it is safe to delete. Best effort: failing to clean never fails a load.
function removeStrayTmpFiles(reviewDir) {
  let names;
  try {
    names = readdirSync(reviewDir);
  } catch {
    return;
  }
  const now = Date.now();
  for (const name of names.filter((n) => STRAY_TMP.test(n))) {
    try {
      if (now - statSync(join(reviewDir, name)).mtimeMs > STRAY_TMP_MAX_AGE_MS) rmSync(join(reviewDir, name), { force: true });
    } catch {
      /* raced with another process, or not ours to remove */
    }
  }
}

// cleanup: false (P merge --dry-run) reads without deleting stray tmp files: a dry run writes and removes nothing.
export function loadState(dir, { cleanup = true } = {}) {
  const file = stateFile(dir);
  if (cleanup) removeStrayTmpFiles(join(dir, '.review'));
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  // Not null: a caller that treats "no state" as "start fresh" would silently overwrite real history.
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`corrupt review state at ${file}: ${err.message}`);
  }
  if (!isPlainObject(parsed)) throw new Error(`corrupt review state at ${file}: expected a JSON object`);
  if (newerThanSupported(parsed)) {
    throw new Error(`corrupt review state at ${file}: it is format version ${parsed.version}, this pipeline supports up to ${SUPPORTED_STATE_VERSION} (a newer pipeline wrote it): update the pipeline`);
  }
  return parsed;
}

function renameWithRetry(from, to, rename, sleep) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      rename(from, to);
      return;
    } catch (err) {
      if (!RENAME_RETRYABLE.has(err.code) || attempt >= RENAME_RETRIES) throw err;
      sleep(RENAME_WAIT_MS);
    }
  }
}

// Write a sibling tmp file, fsync it, then rename over the target: readers see the old or the
// new state, never half of one, and a crash mid-write leaves the old state intact.
export function saveState(dir, state, { rename = renameSync, sleep = sleepSync } = {}) {
  const reviewDir = join(dir, '.review');
  mkdirSync(reviewDir, { recursive: true });
  const file = stateFile(dir);
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    const data = `${JSON.stringify(withRequiredVersion(state), null, 2)}\n`;
    const fd = openSync(tmp, 'w');
    try {
      writeSync(fd, data);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameWithRetry(tmp, file, rename, sleep);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

// base64 never contains "--", so the payload cannot terminate the HTML comment early.
export function encodeForComment(state) {
  return `<!-- claude-pipeline:state:${gzipSync(Buffer.from(JSON.stringify(withRequiredVersion(state)))).toString('base64')} -->`;
}

// Bad data of any kind yields null, never an exception: resume must fall back to a fresh review,
// not crash on someone's edited comment. The LAST marker wins so that quoted or forged markers
// earlier in a body cannot override the real one the pipeline writes at the end.
export function decodeFromComment(body) {
  if (typeof body !== 'string') return null;
  const matches = [...body.matchAll(STATE_MARKER)];
  if (matches.length === 0) return null;
  try {
    const raw = gunzipSync(Buffer.from(matches.at(-1)[1], 'base64'), { maxOutputLength: MAX_DECODED_BYTES });
    const state = JSON.parse(raw.toString('utf8'));
    // Anything that is not recognisably a review state (an array of rounds, a real PR number) is
    // treated as garbage, so a hand-edited comment cannot feed resume a half-made state.
    return isPlainObject(state) && Array.isArray(state.rounds) && Number.isInteger(state.pr) && state.pr > 0 && !newerThanSupported(state) ? state : null;
  } catch {
    return null;
  }
}

// reviewBase / reviewBaseKind: what the round was actually diffed against (see git.mjs#effectiveReviewBase); baseOnly: the
// round only merged the base branch in, so Codex did not run. Each is recorded only when given.
// resolutionOnly: the round is only how a conflict with the base branch was resolved (git.mjs#resolutionReviewBase); it is a
// real review but does not count toward the round cap. conflicted (at most 50 paths) / conflictedCount / blocks (at most 50:
// { path, block, droppedTheirs }, dropped blocks first) describe that resolution, with blockCount / blocksWithDrops /
// droppedTheirsTotal counted over ALL blocks (the stored list may be cut); ensureReviewBase needs conflicted to rebuild the base elsewhere.
// fableRefresh: the round only re-runs the Fable pass on a head whose Fable proof is below MIN_FABLE (commands/state.mjs fable-refresh): no Codex, no items of its own
// until Fable raises findings, and it never counts toward the round cap. Its Fable pass reviews the whole PR (arbiter.mjs#writeFableDiff).
// fableRequired: the round's second reviewer is the Fable pass (triage.mjs#fablePendingRounds), with fableReasons and the
// sensitivePaths it was told to attack. forkPoint: the PR's merge base at this round (the whole-PR range starts there).
// codexModel: the model Codex was run with. promptSha256: sha256 (hex) of the exact prompt bytes sent to Codex (the round's prompt.md).
// admission: which rule let a COUNTED round start, 'normal' | 'auto-extra' | 'owner' (recorded on every new counted round, never on a
// baseOnly / resolutionOnly / fableRefresh one; an ownerGrant implies 'owner'). ownerGrant: { grantId, k, quote, ownerTs } of the owner's extra-round
// record that admitted it (hooks/lib/owner-go.mjs claimGrantMarkers; the final gate re-verifies it against the record and its marker).
// confirmFixed: the ids of accepted items marked implemented through other files (item.implementedVia 'other-files') that this round's prompt
// asked Codex to confirm; recorded only when there are some, so an ordinary round is unchanged. review-complete needs every such item to appear
// in the confirmFixed of a LATER round (triage.mjs#reviewEligibilityProblems).
// firstReviewer: 'substitute' when the Claude stand-in reviewed the round instead of Codex; substitute: { agent, models, reason, resetAt, outageAt, proof ... }
// (no codexModel then). wholePr: the round reviewed the whole PR (reviewBase is its merge base), patchSha256: sha256 of the patch it reviewed. risk: this round's
// risk assessment (the state's maxRisk is the highest of them). governor / budget: the Codex-spend decision that sent the round to the substitute, or (governor)
// that lowered a Codex round's effort. effort: the effort a Codex round ran at.
// Any of substitute / governor / budget makes the saved state version 4 (STATE_VERSION_SUBSTITUTE).
export function addRound(state, {
  n, fromHead, toHead, contentHashAtToHead, items, reviewBase, reviewBaseKind, baseOnly, resolutionOnly, conflicted, conflictedCount, blocks, blockCount, blocksWithDrops, droppedTheirsTotal, forkPoint, codexModel, promptSha256, fableRequired, fableReasons, sensitivePaths, admission, ownerGrant, confirmFixed, fableRefresh,
  firstReviewer, substitute, wholePr, patchSha256, risk, governor, budget, effort,
}) {
  if (!Array.isArray(items)) throw new Error(`round ${n}: items must be an array`);
  if (state.rounds.some((r) => r.n === n)) throw new Error(`round ${n} already exists in the review state`);
  const counted = baseOnly !== true && resolutionOnly !== true && fableRefresh !== true;
  const how = ownerGrant === undefined ? admission : 'owner';
  // maxRisk: what the state knew (legacy states: maxRiskOf, fail toward high) raised by this round; a brand-new state with no risk anywhere records none.
  const seen = state.rounds.length > 0 || isRisk(state.maxRisk) || isRisk(state.risk) ? maxRiskOf(state) : undefined;
  const maxRisk = [seen, risk].filter(isRisk).reduce((a, b) => higherRisk(a, b), undefined) ?? undefined;
  return withRequiredVersion({
    ...state,
    ...(maxRisk === undefined ? {} : { maxRisk }),
    rounds: [...state.rounds, {
      n, fromHead, toHead, ...(reviewBase === undefined ? {} : { reviewBase, reviewBaseKind }), contentHashAtToHead,
      ...(forkPoint === undefined ? {} : { forkPoint }), ...(codexModel === undefined ? {} : { codexModel }),
      ...(promptSha256 === undefined ? {} : { promptSha256 }),
      ...(isRisk(risk) ? { risk } : {}),
      ...(firstReviewer === undefined ? {} : { firstReviewer }),
      ...(substitute === undefined ? {} : { substitute: structuredClone(substitute) }),
      ...(wholePr === true ? { wholePr: true } : {}),
      ...(patchSha256 === undefined ? {} : { patchSha256 }),
      ...(typeof effort === 'string' ? { effort } : {}),
      ...(governor === undefined ? {} : { governor: structuredClone(governor) }),
      ...(budget === undefined ? {} : { budget: structuredClone(budget) }),
      ...(baseOnly === true ? { baseOnly: true } : {}),
      ...(fableRefresh === true ? { fableRefresh: true } : {}),
      ...(Array.isArray(confirmFixed) && confirmFixed.length > 0 ? { confirmFixed: [...confirmFixed] } : {}),
      ...(counted && how !== undefined ? { admission: how } : {}),
      ...(counted && ownerGrant !== undefined ? { ownerGrant: structuredClone(ownerGrant) } : {}),
      ...(resolutionOnly === true
        ? {
          resolutionOnly: true, conflicted: structuredClone(conflicted ?? []), conflictedCount: conflictedCount ?? (conflicted ?? []).length,
          blocks: structuredClone(blocks ?? []),
          ...(Number.isInteger(blockCount) ? { blockCount, blocksWithDrops, droppedTheirsTotal } : {}),
        }
        : {}),
      ...(fableRequired === true ? { fableRequired: true, fableReasons: [...(fableReasons ?? [])], sensitivePaths: [...(sensitivePaths ?? [])] } : {}),
      items: structuredClone(items),
    }],
  });
}

// Replace items of round n by id and keep the rest, so a caller can pass either the whole
// updated list or just the items it changed. Unknown ids are appended.
export function updateItems(state, n, items) {
  const at = state.rounds.findIndex((r) => r.n === n);
  if (at < 0) throw new Error(`round ${n} not found in the review state`);
  const merged = state.rounds[at].items.map((existing) => {
    const update = items.find((i) => i.id === existing.id);
    return update ? structuredClone(update) : existing;
  });
  const known = new Set(merged.map((i) => i.id));
  for (const item of items) {
    if (!known.has(item.id)) {
      known.add(item.id);
      merged.push(structuredClone(item));
    }
  }
  const rounds = state.rounds.map((r, i) => (i === at ? { ...r, items: merged } : r));
  return withRequiredVersion({ ...state, rounds });
}
