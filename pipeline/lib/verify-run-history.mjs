// One JSON line per `scripts/verify.mjs` run, appended to a machine-wide file. Each worktree's .verify/report.json only
// keeps its LAST run, so the local Command Centre wallboard could not count how many verify runs happened per day; this
// file is that count. Keys are an interface to that wallboard: change them only by bumping `v`. Vendored into projects
// (scripts/pipeline/lib/), so it imports only sibling vendored libs and knows nothing about any one project's steps.
//
// Concurrency: worktrees append at the same time, so a line stays under MAX_LINE_BYTES and goes out in ONE O_APPEND
// write (atomic for small writes); rotating the file takes a lock. Best effort: the caller swallows every error, a broken
// history file never changes a verify result.
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { release, tryAcquire } from './locks.mjs';

export const MAX_LINE_BYTES = 4000;
export const MAX_FILE_BYTES = 2 * 1024 * 1024; // past this the file moves to <file>.1 (one generation is kept)
const MAX_ERROR = 300;
const MAX_SKIP = 200;
const MAX_PROJECT = 200; // config accepts any project string; `dir` stays whole (readers match on it)
const LOCK_NAME = 'verify-run-history';

const cut = (s, n) => s.slice(0, n);

/**
 * Where the history goes, or null when it is switched off / cannot be placed. `env` is the env verify was given (never
 * os.homedir(): a test with a minimal env must not touch the real home). Order: override, VERIFY_RUN_HISTORY, then
 * <HOME or USERPROFILE>/.claude/pipeline-state/verify-runs.jsonl. CI or VERIFY_RUN_HISTORY=off disables it.
 */
export function historyPath(env = {}, override) {
  if (env.CI || env.VERIFY_RUN_HISTORY === 'off') return null;
  if (override) return override;
  if (env.VERIFY_RUN_HISTORY) return env.VERIFY_RUN_HISTORY;
  const home = env.HOME || env.USERPROFILE;
  return home ? join(home, '.claude', 'pipeline-state', 'verify-runs.jsonl') : null;
}

/** The JSON line (no trailing newline) for a finished run; throws when even the step-less line is over the limit (a very long `dir`). `report` is the object verify wrote to .verify/report.json. */
export function buildHistoryLine(report, { project, dir, exitCode }) {
  const rows = report.steps ?? [];
  const plain = rows.map((s) => ({ name: s.name, status: s.status, durationMs: s.durationMs }));
  const detailed = rows.map((s, i) => ({
    ...plain[i],
    ...(typeof s.skipReason === 'string' ? { skipReason: cut(s.skipReason, MAX_SKIP) } : {}),
    ...(typeof s.skipCheck === 'string' ? { skipCheck: cut(s.skipCheck, MAX_SKIP) } : {}),
  }));
  const entry = (steps) => ({
    v: 1,
    project: cut(String(project), MAX_PROJECT),
    dir,
    head: report.git?.head ?? null,
    mode: report.mode,
    ok: report.ok === true,
    exitCode,
    startedAt: report.startedAt,
    finishedAt: report.finishedAt,
    durationMs: Date.parse(report.finishedAt) - Date.parse(report.startedAt),
    steps,
    ...(report.error ? { error: cut(String(report.error), MAX_ERROR) } : {}),
  });
  for (const steps of [detailed, plain]) {
    const line = JSON.stringify(entry(steps));
    if (Buffer.byteLength(line) < MAX_LINE_BYTES) return line;
  }
  const bare = JSON.stringify(entry([]));
  if (Buffer.byteLength(bare) < MAX_LINE_BYTES) return bare;
  throw new Error(`line would be ${Buffer.byteLength(bare)} bytes even without steps (limit ${MAX_LINE_BYTES})`);
}

/**
 * Appends `line` + newline to `file` (creating its folder), first moving a file over `maxBytes` to `<file>.1`. Throws on failure.
 * Rotation is serialized by a lock (`lockDir`, default the machine-wide lock folder): without it, two writers could both see
 * the big file, A rename + append to a fresh file, then B rename the near-empty fresh file over `.1` and lose the old
 * generation. The holder looks at the size again, so only the first writer rotates. A busy lock skips rotation (the next run
 * rotates); the append itself is always one O_APPEND write outside the lock.
 * `hooks.afterSizeCheck` is a test-only seam between the unlocked size check and the lock.
 * @param {string} file
 * @param {string} line
 * @param {{ maxBytes?: number, lockDir?: string, hooks?: { afterSizeCheck?: () => void } }} [opts]
 */
export function appendHistory(file, line, { maxBytes = MAX_FILE_BYTES, lockDir, hooks = {} } = {}) {
  mkdirSync(dirname(file), { recursive: true });
  if (sizeOf(file) > maxBytes) {
    hooks.afterSizeCheck?.();
    rotate(file, maxBytes, lockDir);
  }
  appendFileSync(file, `${line}\n`);
}

function sizeOf(file) {
  try {
    return statSync(file).size;
  } catch (e) {
    if (e.code === 'ENOENT') return 0; // missing file: nothing to rotate
    throw e;
  }
}

function rotate(file, maxBytes, lockDir) {
  const got = tryAcquire(LOCK_NAME, lockDir ? { dir: lockDir } : {});
  if (!got.acquired) return; // another writer is rotating (or the lock is unusable): just append
  try {
    if (sizeOf(file) > maxBytes) renameSync(file, `${file}.1`); // still big now that we hold the lock
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  } finally {
    release(got.lock);
  }
}
