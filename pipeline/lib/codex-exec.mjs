// The part of "run Codex and read its answer file" that codex-review and triage second-review share: start the command with the prompt on
// stdin, classify a failure (never readable as "found nothing"), and accept the output file only when this run wrote it.
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { analyzeCodexFailure, parseQuotaReset } from './codex.mjs';
import { findSessionLog, readTaskCompleteError } from './codex-session.mjs';
import { codexCommand, runAsync } from './proc.mjs';

export const CODEX_TIMEOUT_MS = 30 * 60 * 1000;
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
async function attempt({ root, env, args, promptBytes, outPath }) {
  rmSync(outPath, { force: true });
  const startedAt = Date.now();
  const { cmd, prefixArgs } = codexCommand(env);
  const timeoutMs = Number(env?.PIPELINE_CODEX_TIMEOUT_MS) || CODEX_TIMEOUT_MS;
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

// Runs `codex <args>` with `promptBytes` on stdin (stdout is Codex's --json event stream). Whatever is at outPath beforehand was not
// written by this run, so it is removed first. A timeout is retried ONCE with the same prompt bytes, the same outPath and the same
// remove-first guard (`retried: {reason:'timeout'}` on the result); a second timeout is unavailable with timedOut:true, never quota.
// -> {ok:true, startedAt, retried?} or {ok:false, reason: quota|auth|unavailable|error, code, timedOut, detail, retried?, quota?}.
// `detail` is the turn.failed message when Codex gave one, else the stderr tail. `quota` (reason 'quota' only) is
// {eligible, proof: 'session-log'|'stream', resetAt, resetText, message, threadId}. `now`/`timeZone` are for tests.
export async function execCodex({ root, env, args, promptBytes, outPath, now, timeZone }) {
  let retried;
  let { r, startedAt } = await attempt({ root, env, args, promptBytes, outPath });
  if (r.timedOut) {
    retried = { reason: 'timeout' };
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
