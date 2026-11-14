// Codex keeps a session log of every `codex exec` run under $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<timestamp>-<thread id>.jsonl; its last
// `task_complete` event says why a run failed in Codex's own typed words (`codex_error_info: "usage_limit_exceeded"` for a quota stop).
// Everything here is best effort: a missing, unreadable or odd file gives null, never an exception.
import { closeSync, openSync, readFileSync, readSync, readdirSync, fstatSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { THREAD_ID_RE } from './codex.mjs';

const TAIL_BYTES = 512 * 1024;

export function codexHomeDir(env = process.env) {
  const own = env?.CODEX_HOME;
  return typeof own === 'string' && own.trim() !== '' ? own : join(env?.HOME || env?.USERPROFILE || homedir(), '.codex');
}

const two = (n) => String(n).padStart(2, '0');

// The session log of a thread, or null. A run that started just before midnight may have its log under yesterday's date, and the folder
// date is local or UTC depending on the Codex build, so today and yesterday are looked in both ways.
export function findSessionLog(threadId, { env = process.env, now = Date.now() } = {}) {
  if (typeof threadId !== 'string' || !THREAD_ID_RE.test(threadId)) return null;
  const ms = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(ms)) return null;
  const sessions = join(codexHomeDir(env), 'sessions');
  const dirs = new Set();
  for (const back of [0, 1]) {
    const d = new Date(ms - back * 24 * 60 * 60 * 1000);
    dirs.add(join(sessions, String(d.getFullYear()), two(d.getMonth() + 1), two(d.getDate())));
    dirs.add(join(sessions, String(d.getUTCFullYear()), two(d.getUTCMonth() + 1), two(d.getUTCDate())));
  }
  const suffix = `-${threadId}.jsonl`.toLowerCase();
  for (const dir of dirs) {
    try {
      const hit = readdirSync(dir).find((name) => name.toLowerCase().endsWith(suffix));
      if (hit) return join(dir, hit);
    } catch { /* no such day folder */ }
  }
  return null;
}

// The last `task_complete` event of a session log -> {message, codexErrorInfo} (both null when that turn ended without an error), or null
// when the file cannot be read or has no task_complete. Only the tail is read: the event is the last thing Codex writes.
export function readTaskCompleteError(file) {
  let fd;
  try {
    fd = openSync(file, 'r');
    const size = fstatSync(fd).size;
    const length = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, size - length);
    const lines = buf.toString('utf8').split('\n');
    if (size > length) lines.shift(); // starts mid-line
    for (let i = lines.length - 1; i >= 0; i--) {
      const text = lines[i].trim();
      if (!text.startsWith('{')) continue;
      let e;
      try { e = JSON.parse(text); } catch { continue; }
      if (e?.type !== 'event_msg' || e.payload?.type !== 'task_complete') continue;
      const err = e.payload.error;
      return {
        message: typeof err?.message === 'string' ? err.message : null,
        codexErrorInfo: err?.codex_error_info ?? null,
      };
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* already gone */ }
  }
}

const MODEL_LOG_MAX_BYTES = 4 * 1024 * 1024;

// Which model and provider a session log says its run used -> { model, provider } (each null when the log does not say), or null when the file cannot be read. `model` is the
// model of the LAST `turn_context` event (what the turn that failed was asked to run), `provider` is `session_meta.payload.model_provider`. A refused-model session is a few
// lines; a log over 4 MB is not read (null: the caller treats the run as unproven).
export function readSessionModel(file) {
  try {
    if (statSync(file).size > MODEL_LOG_MAX_BYTES) return null;
    let model = null;
    let provider = null;
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const text = line.trim();
      if (!text.startsWith('{')) continue;
      let e;
      try { e = JSON.parse(text); } catch { continue; }
      if (e?.type === 'session_meta' && provider === null && typeof e.payload?.model_provider === 'string') provider = e.payload.model_provider;
      else if (e?.type === 'turn_context' && typeof e.payload?.model === 'string') model = e.payload.model;
    }
    return { model, provider };
  } catch {
    return null;
  }
}
