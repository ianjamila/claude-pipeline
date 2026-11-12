// .review/round-R/route.json: the ONE record of how a Codex attempt for a round went and whether a Claude substitute may stand in for it
// (plan 2026-11-11-codex-substitute-reviewer, R4-10, R4-12, R5-7). Its lifecycle:
//
//   start   every codex-review attempt first replaces route.json atomically (write-then-rename, WITHOUT the review lock: Codex itself runs unlocked) with
//           { attemptId, evidence: 'pending', round, base, head, patchSha256, risk, agent, at }, so evidence from an earlier attempt is gone before
//           Codex runs. The attempt's files live in round-R/attempt-<attemptId>/ (codex-raw.json, prompt.md): a later attempt can neither read nor
//           remove them.
//   finish  the final evidence ('quota' | 'none') and a successful round are written by compare-and-swap UNDER THE REVIEW LOCK, and only while
//           route.json still holds this attempt in 'pending'. Otherwise the attempt is superseded (exit 2, `superseded`): it writes nothing and
//           deletes nothing. Only the winner's files are copied from its attempt folder to round-R/.
//
// Final evidence by kind (every kind keeps the pending record's fields, `at` becomes the time the evidence was formed, `startedAt` the attempt's start):
//   quota  { outcome:'failed', reason:'quota', resetAt, resetText, errorEvent:{type, message}, threadId, promptSha256, proof }  (`proof`: 'session-log' | 'stream')
//   none   { outcome:'recorded' } for a round that was recorded, or { outcome:'failed', reason, timedOut?, detail? } for any other failure
// A quota record with `resetAt: null` is valid for 2 hours from `at` (OUTAGE_NO_RESET_MS), after which Codex must be retried.
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { EXIT } from './cli.mjs';
import { Fail } from './cmd-common.mjs';
import { OUTAGE_NO_RESET_MS } from './codex-usage.mjs';
import { ensureRoundDir, roundDir, withReviewLock, writeJson } from './review-context.mjs';

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

// Inside the review lock: is route.json still this attempt, unfinished? Else exit 2 `superseded` (the caller writes and deletes nothing).
export function assertCurrentAttempt(root, round, attemptId, file = ROUTE_FILE) {
  const current = readRoute(root, round, file);
  if (current === null || current.attemptId !== attemptId || current.evidence !== 'pending') throw superseded();
  return current;
}

// Atomically replaces route.json with a fresh pending record and makes the attempt's folder. -> { attemptId, dir, route }.
// `extra` adds fields to the record (a second review's kind, ids and packet identity); `file` is the record's name.
export async function startAttempt({ root, round, base, head, patchSha256, risk, agent, now = Date.now(), file = ROUTE_FILE, extra = {} }) {
  const attemptId = newAttemptId();
  const route = { attemptId, evidence: 'pending', round, base, head, patchSha256, risk, agent, ...extra, at: new Date(now).toISOString() };
  const dir = attemptDir(root, round, attemptId);
  // No review lock: the review lock is held only to record a round, never while Codex runs. The rename is atomic; the compare-and-swap that needs the lock is the final write.
  ensureRoundDir(root, round);
  mkdirSync(dir, { recursive: true });
  writeJson(routeFile(root, round, file), route);
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

// Inside the review lock: writes the attempt's final evidence over its pending record. `final` = { evidence, ...fields }.
export function writeFinalRoute(root, round, pending, final, now = Date.now(), file = ROUTE_FILE) {
  writeJson(routeFile(root, round, file), { ...pending, ...final, at: new Date(now).toISOString(), startedAt: pending.at });
}

// The failure path: under the review lock, only while this attempt is still the current one, copy its files to round-R/ and write the final evidence.
// A superseded attempt throws (exit 2) and touches nothing.
export async function finishAttempt({ root, pr, ctx, round, attempt, final, files = ['prompt.md'], now, file = ROUTE_FILE }) {
  return withReviewLock(root, pr, ctx, () => {
    const pending = assertCurrentAttempt(root, round, attempt.attemptId, file);
    publishAttemptFiles(root, round, attempt.attemptId, files);
    writeFinalRoute(root, round, pending, final, now, file);
  });
}

// When does a quota record stop being evidence (epoch ms)? At resetAt; with no reset time, 2 hours after it was formed.
export function quotaValidUntilMs(route) {
  const reset = route?.resetAt ? Date.parse(route.resetAt) : NaN;
  if (Number.isFinite(reset)) return reset;
  const at = Date.parse(route?.at);
  return Number.isFinite(at) ? at + OUTAGE_NO_RESET_MS : NaN;
}

// May a substitute stand in for this failed Codex run? (plan Rev 6: a real quota stop, proven by Codex's own structured events.)
//   reason / timedOut / quota: what execCodex reported ({eligible, proof, resetAt, ...} for a quota); mode / minWaitMinutes: review.substitute.
// -> { eligible, why, agent, resetAt, waitUntil? }. min_wait_minutes 0 (the default) never waits; above 0, a reset within that many minutes is waited for instead
// (eligible false, waitUntil = the reset), and a quota with no reset time is never waited for (nothing to wait until).
export function substituteEligibility({ reason, timedOut = false, quota, mode, minWaitMinutes = 0, agent, now = Date.now() }) {
  const resetAt = quota?.resetAt ?? null;
  const out = (eligible, why, extra = {}) => ({ eligible, why, agent, resetAt, ...extra });
  if (timedOut) return out(false, 'timed-out');
  if (reason !== 'quota') return out(false, `not-quota:${reason}`);
  if (mode === 'off') return out(false, 'mode-off');
  if (quota?.eligible !== true) return out(false, 'quota-unproven');
  const resetMs = resetAt === null ? NaN : Date.parse(resetAt);
  if (minWaitMinutes > 0 && Number.isFinite(resetMs) && resetMs - now <= minWaitMinutes * 60_000) return out(false, 'reset-near', { waitUntil: resetAt });
  return out(true, 'quota');
}
