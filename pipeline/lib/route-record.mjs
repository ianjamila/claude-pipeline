// .review/round-R/route.json: the ONE record of how a Codex attempt for a round went and whether a Claude substitute may stand in for it
// (plan 2026-11-11-codex-substitute-reviewer, R4-10, R4-12, R5-7). Its lifecycle:
//
//   start   every codex-review attempt first replaces route.json atomically (write-then-rename, under the ROUTE lock for that write only: Codex itself runs unlocked, and a held review lock does not stop it) with
//           { attemptId, evidence: 'pending', round, base, head, patchSha256, risk, agent, at }, so evidence from an earlier attempt is gone before
//           Codex runs. The attempt's files live in round-R/attempt-<attemptId>/ (codex-raw.json, prompt.md): a later attempt can neither read nor
//           remove them.
//   finish  the final evidence ('quota' | 'none') and a successful round are written by compare-and-swap UNDER THE REVIEW LOCK and the ROUTE lock (review, then route), and only while
//           route.json still holds this attempt in 'pending'. Otherwise the attempt is superseded (exit 2, `superseded`): it writes nothing and
//           deletes nothing. Only the winner's files are copied from its attempt folder to round-R/.
//
// Final evidence by kind (every kind keeps the pending record's fields, `at` becomes the time the evidence was formed, `startedAt` the attempt's start):
//   quota  { outcome:'failed', reason:'quota', resetAt, resetText, errorEvent:{type, message}, threadId, promptSha256, proof }  (`proof`: 'session-log' | 'stream')
//   model  { outcome:'failed', reason:'model', model, provider, errorEvent:{type, message}, threadId, promptSha256, proof:'session-log', confirm:{threadId} }  (cp #431: Codex refused the
//          CONFIGURED model; `model` is always the trusted review.codex_model string, never a name from the provider's message; the confirmation run is lib/codex-exec.mjs's)
//   none   { outcome:'recorded' } for a round that was recorded, or { outcome:'failed', reason, timedOut?, detail? } for any other failure
// A quota record with `resetAt: null`, and every model record, is valid for 2 hours from `at` (OUTAGE_NO_RESET_MS), after which Codex must be retried.
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { EXIT } from './cli.mjs';
import { Fail } from './cmd-common.mjs';
import { OUTAGE_NO_RESET_MS } from './codex-usage.mjs';
import { ensureRoundDir, roundDir, withReviewLock, withRouteLock, writeJson } from './review-context.mjs';

export const ROUTE_FILE = 'route.json';
// `file` names another record of the same lifecycle in the round folder: a second review's `route-2nd-<packetId8>.json` (R5-7); the default is the round's own route.json.
export const routeFile = (root, round, file = ROUTE_FILE) => path.join(roundDir(root, round), file);
export const attemptDir = (root, round, attemptId) => path.join(roundDir(root, round), `attempt-${attemptId}`);
export const newAttemptId = () => randomBytes(8).toString('hex');

// The record as it is on disk, or null (missing, unreadable, not an object). Never throws.
export function readRoute(root, round, file = ROUTE_FILE) {
  try {
    const route = JSON.parse(readFileSync(routeFile(root, round, file), 'utf8'));
    return route !== null && typeof route === 'object' && !Array.isArray(route) ? route : null;
  } catch {
    return null;
  }
}

export const superseded = () => new Fail(EXIT.USAGE, {
  ok: false, error: 'superseded',
  message: 'a newer codex-review attempt for this round replaced this one: its result was discarded and nothing was written; run the round again only if the newer attempt did not finish',
});

// Inside the review and route locks: is route.json still this attempt, unfinished? Else exit 2 `superseded` (the caller writes and deletes nothing).
export function assertCurrentAttempt(root, round, attemptId, file = ROUTE_FILE) {
  const current = readRoute(root, round, file);
  if (current === null || current.attemptId !== attemptId || current.evidence !== 'pending') throw superseded();
  return current;
}

// Atomically replaces route.json with a fresh pending record and makes the attempt's folder. -> { attemptId, dir, route }.
// `extra` adds fields to the record (a second review's kind, ids and packet identity); `file` is the record's name.
export async function startAttempt({ root, pr, ctx, round, base, head, patchSha256, risk, agent, now = Date.now(), file = ROUTE_FILE, extra = {} }) {
  const attemptId = newAttemptId();
  const route = { attemptId, evidence: 'pending', round, base, head, patchSha256, risk, agent, ...extra, at: new Date(now).toISOString() };
  const dir = attemptDir(root, round, attemptId);
  // The ROUTE lock (not the review lock: Codex must start while a round is being recorded) is taken for this one write only, never while Codex runs: the final write is a
  // compare-and-swap under the same lock, and a pending record installed between its compare and its write would be overwritten by the older attempt (R1-B2).
  ensureRoundDir(root, round);
  mkdirSync(dir, { recursive: true });
  await withRouteLock(root, pr, ctx, () => writeJson(routeFile(root, round, file), route));
  return { attemptId, dir, route };
}

// Copies the named files of the attempt's folder to round-R/ (atomically, one by one); files that do not exist are skipped.
export function publishAttemptFiles(root, round, attemptId, names) {
  const from = attemptDir(root, round, attemptId);
  const to = roundDir(root, round);
  for (const name of names) {
    const src = path.join(from, name);
    if (!existsSync(src)) continue;
    const tmp = path.join(to, `${name}.${process.pid}.tmp`);
    copyFileSync(src, tmp);
    renameSync(tmp, path.join(to, name));
  }
}

// Inside the review and route locks: writes the attempt's final evidence over its pending record. `final` = { evidence, ...fields }.
export function writeFinalRoute(root, round, pending, final, now = Date.now(), file = ROUTE_FILE) {
  writeJson(routeFile(root, round, file), { ...pending, ...final, at: new Date(now).toISOString(), startedAt: pending.at });
}

// The failure path: under the review lock and the route lock, only while this attempt is still the current one, copy its files to round-R/ and write the final evidence.
// A superseded attempt throws (exit 2) and touches nothing.
export async function finishAttempt({ root, pr, ctx, round, attempt, final, files = ['prompt.md'], now, file = ROUTE_FILE }) {
  return withReviewLock(root, pr, ctx, () => withRouteLock(root, pr, ctx, () => {
    const pending = assertCurrentAttempt(root, round, attempt.attemptId, file);
    publishAttemptFiles(root, round, attempt.attemptId, files);
    writeFinalRoute(root, round, pending, final, now, file);
  }));
}

// When does a quota or model record stop being evidence (epoch ms)? At resetAt; with no reset time (a model record never has one), 2 hours after it was formed: the owner may have
// fixed review.codex_model on the default branch in the meantime.
export function quotaValidUntilMs(route) {
  const reset = route?.resetAt ? Date.parse(route.resetAt) : NaN;
  if (Number.isFinite(reset)) return reset;
  const at = Date.parse(route?.at);
  return Number.isFinite(at) ? at + OUTAGE_NO_RESET_MS : NaN;
}

// Is Codex due back soon enough to wait for it (review.substitute.min_wait_minutes)? A reset time within that many minutes of `now` is; 0 never waits, and no reset time
// (nothing to wait until) is never waited for. The one place the rule lives: substituteEligibility (the verdict codex-review gives) and `substitute prepare` (which admits the
// evidence later) both ask it, so a caller cannot skip a wait the verdict asked for (cp #256 R8-B1).
export function resetNear({ resetAt, minWaitMinutes = 0, now = Date.now() }) {
  const resetMs = resetAt === null || resetAt === undefined ? NaN : Date.parse(resetAt);
  return minWaitMinutes > 0 && Number.isFinite(resetMs) && resetMs - now <= minWaitMinutes * 60_000;
}

// May a substitute stand in for this failed Codex run? (plan Rev 6: a real quota stop, proven by Codex's own structured events; cp #431: or a refused model, proven by the session log and a confirmation run.)
//   reason / timedOut / quota / modelStop: what execCodex reported ({eligible, proof, resetAt, ...} for a quota; {eligible, unproven?, ...} for a refused model); mode / minWaitMinutes: review.substitute.
// -> { eligible, why, agent, resetAt, waitUntil?, unproven? }; `why` is 'quota' or 'model' when eligible. A model stop has no reset time, so min_wait_minutes never waits for it. min_wait_minutes 0 (the default) never waits; above 0, a reset within that many minutes is waited for instead
// (eligible false, waitUntil = the reset), and a quota with no reset time is never waited for (nothing to wait until).
export function substituteEligibility({ reason, timedOut = false, quota, modelStop, mode, modeOffFrom = null, minWaitMinutes = 0, agent, now = Date.now() }) {
  const resetAt = quota?.resetAt ?? null;
  const out = (eligible, why, extra = {}) => ({ eligible, why, agent, resetAt, ...extra });
  if (timedOut) return out(false, 'timed-out');
  if (reason !== 'quota' && reason !== 'model') return out(false, `not-quota:${reason}`); // the string predates 'model' and is kept: tests and skills match it
  if (mode === 'off') return out(false, 'mode-off', modeOffFrom === null ? {} : { modeOffFrom }); // modeOffFrom: where the off came from (strictestRouteConfig)
  if (reason === 'model') return modelStop?.eligible === true ? out(true, 'model') : out(false, 'model-unproven', typeof modelStop?.unproven === 'string' ? { unproven: modelStop.unproven } : {});
  if (quota?.eligible !== true) return out(false, 'quota-unproven');
  if (resetNear({ resetAt, minWaitMinutes, now })) return out(false, 'reset-near', { waitUntil: resetAt });
  return out(true, 'quota');
}

// The message a refused-model stop gives (codex-review and triage second-review): what happened, where review.codex_model is read from and how to fix it, then the ACTUAL substitute
// verdict (proof is not permission: R1-3). \`model\` is the trusted review.codex_model string, never a name from the provider's message. An unreadable base config (R3-4) says to repair it.
// `next` is the caller's next step once a substitute is eligible: codex-review has nothing prepared yet (the default: `pipeline substitute prepare`), while triage second-review has already
// prepared the packet, so its next step is one call of the named agent and then --apply (R1-F1: `substitute prepare` there reads the round's own record and is refused).
export function modelRefusalMessage({ model, verdict, defaultBranch, next = '`pipeline substitute prepare`' }) {
  const head = `Codex refused the configured model ${model} (model_not_found: retired, renamed, or not available to this Codex login). review.codex_model is read from the pipeline.yml at ${defaultBranch}'s fork point: fix it on ${defaultBranch}, then bring that fix into this branch (merge/update-branch) so its fork point moves.`;
  if (verdict.eligible) return `${head} A substitute (${verdict.agent}) may stand in: ${next}.`;
  if (verdict.why === 'mode-off') {
    const unreadable = /could not be read \((.*)\); an unreadable base config/.exec(verdict.modeOffFrom ?? '');
    if (unreadable) return `${head} No substitute may stand in: the pipeline.yml at ${defaultBranch}'s fork point is not a valid config (${unreadable[1]}): repair .claude/pipeline.yml on ${defaultBranch} with an owner commit; no PR can get a substitute until then.`;
    return `${head} No substitute may stand in: ${verdict.modeOffFrom ?? 'review.substitute.mode is off'}.`;
  }
  if (verdict.why === 'model-unproven') return `${head} No substitute may stand in: the refusal could not be proven (${verdict.unproven ?? 'unproven'}); run codex-review again once review.codex_model is fixed on ${defaultBranch}.`;
  return `${head} No substitute may stand in (${verdict.why}).`;
}
