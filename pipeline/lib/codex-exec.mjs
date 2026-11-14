// The part of "run Codex and read its answer file" that codex-review and triage second-review share: start the command with the prompt on
// stdin, classify a failure (never readable as "found nothing"), and accept the output file only when this run wrote it.
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { analyzeCodexFailure, isCapacityFailure, parseModelNotFound, parseQuotaReset } from './codex.mjs';
import { findSessionLog, readSessionModel, readTaskCompleteError } from './codex-session.mjs';
import { codexCommand, runAsync } from './proc.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const CODEX_TIMEOUT_MS = 30 * 60 * 1000;
// How long to wait before the one retry of a "model is at capacity" failure; 0 is allowed (tests), unlike the timeout.
export const CODEX_CAPACITY_RETRY_MS = 30 * 1000;
const capacityRetryMs = (env) => {
  const raw = env?.PIPELINE_CODEX_CAPACITY_RETRY_MS;
  const n = raw === undefined || String(raw).trim() === '' ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : CODEX_CAPACITY_RETRY_MS;
};
// A file system may round mtimes down (1-2 s on some); the file was unlinked before the run, so this only has to
// tell "written during this run" from "left over from long ago".
export const MTIME_SLACK_MS = 2000;
const DETAIL_CHARS = 1000;

export const tail = (s) => {
  const text = String(s ?? '').trim();
  return text.length > DETAIL_CHARS ? text.slice(-DETAIL_CHARS) : text;
};

// One attempt: remove whatever is at outPath (it was not written by this run), run Codex, and tell a clean exit from a failure.
// On a timeout the whole process tree is killed, so a helper Codex started cannot write its answer afterwards.
async function attempt({ root, env, args, promptBytes, outPath, maxTimeoutMs = Infinity }) {
  rmSync(outPath, { force: true });
  const startedAt = Date.now();
  const { cmd, prefixArgs } = codexCommand(env);
  const timeoutMs = Math.min(Number(env?.PIPELINE_CODEX_TIMEOUT_MS) || CODEX_TIMEOUT_MS, maxTimeoutMs);
  const r = await runAsync(cmd, [...prefixArgs, ...args], { cwd: root, env, input: promptBytes, timeoutMs });
  return { r, startedAt };
}

// What a quota failure carries: whether it may be treated as a real quota stop, how that is proven, and when Codex says to come back.
// The turn.failed message alone proves it ('stream'); the session log of that thread, when it can be found, has the last word: Codex's own
// typed error there must be usage_limit_exceeded, anything else means the message was not a quota stop.
function quotaFacts({ message, threadId }, { env, now, timeZone }) {
  const logFile = threadId ? findSessionLog(threadId, { env, now }) : null;
  const logged = logFile ? readTaskCompleteError(logFile) : null;
  const proof = logged ? 'session-log' : 'stream';
  const eligible = logged ? logged.codexErrorInfo === 'usage_limit_exceeded' : true;
  const reset = parseQuotaReset(message, { now, timeZone });
  const fromLog = reset.resetAt === null && logged?.message ? parseQuotaReset(logged.message, { now, timeZone }) : reset;
  return { eligible, proof, resetAt: fromLog.resetAt, resetText: fromLog.resetText, message, threadId };
}

// What a refused-model failure carries (cp #431): whether it may be treated as proof that Codex refuses the CONFIGURED model, and how that is proven. All of this must hold, else
// `eligible` is false and `unproven` names the first thing that did not (never a reason to trust the provider's message text):
//   1. the session log of the run's thread is found (a stream alone proves nothing for a model), its last task_complete error is model_not_found too, the model of its last turn_context is
//      the one this run asked for (`requestedModel`: the argv carries it as -c model="...", the caller passes it), and it names a provider; a refusal that names another model than the one asked for is not it;
//   2. a CONFIRMATION run (same argv and effort, but in a fresh empty directory and with a one-line prompt: it reads nothing of the project and a 400 costs no quota) is refused as model_not_found
//      too, its own session log names the same model and the SAME provider. It is not logged to the codex-usage ledger (not a review run).
// -> { eligible, proof: 'session-log' | 'stream', model: requestedModel, provider, message, threadId, confirm: { threadId } | null, unproven? }.
export const CONFIRM_PROMPT = 'Reply OK';
const CONFIRM_TIMEOUT_MS = 2 * 60 * 1000;
const argAfter = (args, flag, value) => {
  const out = [...args];
  const at = out.indexOf(flag);
  if (at >= 0 && at + 1 < out.length) out[at + 1] = value;
  return out;
};

// Is this thread's session log a refusal of `requestedModel`? -> { ok, provider, unproven? }
function loggedRefusal(threadId, requestedModel, { env, now }) {
  const logFile = threadId ? findSessionLog(threadId, { env, now }) : null;
  if (!logFile) return { ok: false, unproven: 'no-session-log' };
  const logged = readTaskCompleteError(logFile);
  const parsed = logged ? parseModelNotFound(logged.message) : null;
  if (parsed === null) return { ok: false, unproven: 'log-disagrees' };
  if (parsed.model !== null && parsed.model !== requestedModel) return { ok: false, unproven: 'model-differs' };
  const session = readSessionModel(logFile);
  if (session === null || session.model !== requestedModel) return { ok: false, unproven: 'model-differs' };
  if (session.provider === null) return { ok: false, unproven: 'no-provider' };
  return { ok: true, provider: session.provider };
}

async function modelFacts({ message, threadId }, { env, now, args, requestedModel }) {
  const facts = (extra) => ({ eligible: false, proof: 'stream', model: requestedModel ?? null, provider: null, message, threadId, confirm: null, ...extra });
  if (typeof requestedModel !== 'string' || requestedModel === '') return facts({ unproven: 'no-requested-model' });
  const named = parseModelNotFound(message);
  if (named === null || (named.model !== null && named.model !== requestedModel)) return facts({ unproven: 'model-differs' });
  const main = loggedRefusal(threadId, requestedModel, { env, now });
  if (!main.ok) return facts({ unproven: main.unproven, proof: main.unproven === 'no-session-log' ? 'stream' : 'session-log' });
  // Every step of the confirmation run, the temp dir included, is inside the try: whatever fails here leaves the main run's proof standing but unconfirmed, never an error out of execCodex
  // after a real Codex run (R1-F2). The cleanup is best effort.
  let dir = null;
  const base = { proof: 'session-log', provider: main.provider };
  try {
    dir = mkdtempSync(path.join(tmpdir(), 'cp-model-check-'));
    const outPath = path.join(dir, 'out.json');
    const confirmArgs = argAfter(argAfter(args, '-C', dir), '-o', outPath);
    const { r } = await attempt({ root: dir, env, args: confirmArgs, promptBytes: CONFIRM_PROMPT, outPath, maxTimeoutMs: CONFIRM_TIMEOUT_MS });
    const verdict = analyzeCodexFailure({ code: r.code, signal: r.signal, stderr: r.stderr, stdout: r.stdout, timedOut: r.timedOut });
    if (verdict.reason !== 'model') return facts({ ...base, unproven: 'confirm-failed' });
    const again = loggedRefusal(verdict.threadId, requestedModel, { env, now });
    if (!again.ok) return facts({ ...base, unproven: 'confirm-unproven' });
    if (again.provider !== main.provider) return facts({ ...base, unproven: 'provider-differs' });
    return facts({ ...base, eligible: true, confirm: { threadId: verdict.threadId } });
  } catch {
    return facts({ ...base, unproven: 'confirm-failed' });
  } finally {
    if (dir !== null) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort: the verdict is already decided */ }
    }
  }
}

// Runs `codex <args>` with `promptBytes` on stdin (stdout is Codex's --json event stream). Whatever is at outPath beforehand was not
// written by this run, so it is removed first. A timeout, or a failure whose LAST turn.failed says the model is at capacity (isCapacityFailure; after
// PIPELINE_CODEX_CAPACITY_RETRY_MS, default 30 s), is retried ONCE IN TOTAL with the same prompt bytes, the same outPath and the same remove-first guard
// (`retried: {reason:'timeout'|'capacity'}` on the result; it is the same attempt, not a new Codex run). A second timeout is unavailable with
// timedOut:true, never quota; a second capacity failure is classified exactly as before (error). A quota stop is never retried.
// -> {ok:true, startedAt, retried?} or {ok:false, reason: quota|model|auth|unavailable|error, code, timedOut, detail, retried?, quota?, modelStop?}.
// `detail` is the turn.failed message when Codex gave one, else the stderr tail. `quota` (reason 'quota' only) is
// {eligible, proof: 'session-log'|'stream', resetAt, resetText, message, threadId}.
// `modelStop` (reason 'model' only; a model stop is never retried) is modelFacts' record: the caller passes `requestedModel`, the model its argv asks for. `now`/`timeZone` are for tests.
export async function execCodex({ root, env, args, promptBytes, outPath, now, timeZone, requestedModel }) {
  let retried;
  let { r, startedAt } = await attempt({ root, env, args, promptBytes, outPath });
  if (r.timedOut) {
    retried = { reason: 'timeout' };
    ({ r, startedAt } = await attempt({ root, env, args, promptBytes, outPath }));
  } else if (isCapacityFailure({ code: r.code, signal: r.signal, stdout: r.stdout, timedOut: r.timedOut })) {
    retried = { reason: 'capacity' };
    rmSync(outPath, { force: true });
    await sleep(capacityRetryMs(env));
    ({ r, startedAt } = await attempt({ root, env, args, promptBytes, outPath }));
  }
  if (r.code !== 0 || r.timedOut) {
    rmSync(outPath, { force: true });
    // A spawn failure is reported as stderr "spawn <cmd> ENOENT"; classify it as the missing binary it is.
    const spawnError = /^spawn(?:Sync)? .*\bENOENT\b/.test(r.stderr) ? { code: 'ENOENT', message: r.stderr } : undefined;
    const verdict = analyzeCodexFailure({ code: r.code, signal: r.signal, stderr: r.stderr, stdout: r.stdout, timedOut: r.timedOut, spawnError });
    const out = { ok: false, reason: verdict.reason, code: r.code, timedOut: r.timedOut, detail: tail(verdict.message || r.stderr) };
    if (retried) out.retried = retried;
    if (verdict.reason === 'quota') out.quota = quotaFacts(verdict, { env, now: now ?? Date.now(), timeZone });
    if (verdict.reason === 'model') out.modelStop = await modelFacts(verdict, { env, now: now ?? Date.now(), args, requestedModel });
    return out;
  }
  return retried ? { ok: true, startedAt, retried } : { ok: true, startedAt };
}

// The parsed answer file of a run that exited 0; throws (Error) when it is missing, left over from before this run, or not JSON.
export function readCodexAnswer(outPath, startedAt) {
  if (!existsSync(outPath)) throw new Error('codex exited 0 but wrote no output file');
  if (statSync(outPath).mtimeMs < startedAt - MTIME_SLACK_MS) throw new Error('codex output file predates this run');
  return JSON.parse(readFileSync(outPath, 'utf8'));
}
