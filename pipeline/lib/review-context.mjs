// Plumbing shared by the review-loop commands (codex-review, triage, arbiter, state, review-complete, followups).
// Why one module: they all read and write the same .review/ tree and must agree on what "the content that was
// reviewed" means. In particular `currentContentHash` is the single definition of the hash that round coverage and
// the merge gate compare, so a command that hashed differently would let a stale review look current.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { EXIT } from './cli.mjs';
import { Fail } from './cmd-common.mjs';
import { GitError, contentHash, revParse } from './git.mjs';
import { LockTimeoutError, withLock } from './locks.mjs';
import { loadState } from './state.mjs';

export const EXCERPT_RADIUS = 20;

export const sha256 = (text) => createHash('sha256').update(text).digest('hex');
export const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

// ---- content hash ---------------------------------------------------------------------------

// `origin/<branch>` is what the PR will be merged into (the default branch unless the PR names its own base); a repo
// without that remote ref (a fresh clone of a local fixture, a test) falls back to the local branch. Any other git
// failure is not swallowed.
export function reviewBaseRef(root, config, branch = config.default_branch) {
  const remote = `origin/${branch}`;
  try {
    revParse(remote, { cwd: root });
    return remote;
  } catch (err) {
    if (err instanceof GitError) return branch;
    throw err;
  }
}

// What the branch changes relative to where it forked, minus the agent log the pipeline itself appends to.
export function currentContentHash(root, config) {
  return contentHash(reviewBaseRef(root, config), 'HEAD', {
    cwd: root,
    exclude: config.agent_log ? [config.agent_log] : [],
  });
}

// ---- .review/ layout ------------------------------------------------------------------------

export const reviewDir = (root) => path.join(root, '.review');
export const roundDir = (root, n) => path.join(reviewDir(root), `round-${n}`);

export function ensureRoundDir(root, n) {
  const dir = roundDir(root, n);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// Write-then-rename so a reader (or a crash) never sees half a file.
export function writeFileAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

export const writeJson = (file, value) => writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`);

export function readFileOrFail(file, what) {
  try {
    return readFileSync(file, 'utf8');
  } catch (err) {
    throw new Fail(EXIT.USAGE, { ok: false, error: 'read', message: `cannot read ${what} ${file}: ${err.code ?? err.message}` });
  }
}

// ---- locking --------------------------------------------------------------------------------

// Every command that reads-modifies-writes .review/state.json holds this lock for the whole read-modify-write, so two
// sessions (a ship loop and a person with a terminal, two ship loops on one PR) cannot lose each other's update.
// One lock per repository checkout and PR. The lock directory is ~/.claude/pipeline-state/locks unless
// PIPELINE_LOCK_DIR says otherwise (tests); PIPELINE_LOCK_WAIT_MS shortens the wait (tests).
export const LOCK_WAIT_MS = 2 * 60 * 1000;

export const reviewLockName = (root, pr) => `review-${sha256(root).slice(0, 12)}-pr${pr}`;

export async function withReviewLock(root, pr, ctx, fn) {
  const env = ctx?.env ?? process.env;
  const wait = Number(env.PIPELINE_LOCK_WAIT_MS);
  try {
    return await withLock(reviewLockName(root, pr), fn, { dir: env.PIPELINE_LOCK_DIR || undefined, waitMs: wait > 0 ? wait : LOCK_WAIT_MS });
  } catch (err) {
    if (err instanceof LockTimeoutError) throw new Fail(EXIT.USAGE, { ok: false, error: 'lock-timeout', message: err.message });
    throw err;
  }
}

// For commands that do not know the PR up front: the state on disk names it. No readable state means the command
// fails on its own (requireState) before it changes anything, so it runs unlocked rather than under a made-up name.
export function withStateLock(root, ctx, fn, pr) {
  let n = pr;
  if (n === undefined) {
    try {
      n = loadState(root)?.pr;
    } catch {
      n = undefined;
    }
  }
  return n === undefined ? fn() : withReviewLock(root, n, ctx, fn);
}

// ---- state access ---------------------------------------------------------------------------

// No state, or state that cannot be read, is an environment problem (exit 2), never "start fresh".
export function requireState(root) {
  let state;
  try {
    state = loadState(root);
  } catch (err) {
    throw new Fail(EXIT.USAGE, { ok: false, error: 'state', message: err.message });
  }
  if (!state) {
    throw new Fail(EXIT.USAGE, {
      ok: false, error: 'no-state', message: `no review state at ${path.join(reviewDir(root), 'state.json')}`,
    });
  }
  return state;
}

export function findRound(state, n) {
  const round = (state.rounds ?? []).find((r) => r.n === n);
  if (!round) throw new Fail(EXIT.USAGE, { ok: false, error: 'no-round', message: `round ${n} is not in the review state` });
  return round;
}

export const allItems = (state) => (state.rounds ?? []).flatMap((r) => r.items ?? []);

// Ids look like R<round>-<letter><k>, so they are unique across rounds; the round is read from the owning round.
export function findItem(state, id) {
  for (const round of state.rounds ?? []) {
    const item = (round.items ?? []).find((i) => i.id === id);
    if (item) return { round, item };
  }
  throw new Fail(EXIT.USAGE, { ok: false, error: 'no-item', message: `no item ${id} in the review state` });
}

// New state with `patch` merged into round n (state.mjs only offers updateItems).
export function patchRound(state, n, patch) {
  return { ...state, rounds: state.rounds.map((r) => (r.n === n ? { ...r, ...patch } : r)) };
}

// ---- code excerpts --------------------------------------------------------------------------

// The window of a file around `line` (1-based, +/- radius). Line 0 means "not line-specific": the whole file, or its
// first `maxLines` lines for display. Returns lines with their numbers, or null when the file is empty.
export function excerptWindow(content, line, { radius = EXCERPT_RADIUS, maxLines = Infinity } = {}) {
  if (typeof content !== 'string') return null;
  const all = content.split(/\r?\n/);
  if (all.length > 0 && all.at(-1) === '') all.pop(); // the newline that ends the file is not a line
  if (all.length === 0) return null;
  let start = 1;
  let end = all.length;
  if (Number.isInteger(line) && line > 0) {
    start = Math.max(1, line - radius);
    end = Math.min(all.length, line + radius);
  } else {
    end = Math.min(end, maxLines);
  }
  if (start > end) return null; // a line number past the end of the file
  return { start, end, lines: all.slice(start - 1, end) };
}
