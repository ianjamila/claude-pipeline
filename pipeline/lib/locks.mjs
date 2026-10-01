// Machine-wide named locks. Several Claude sessions (one per git worktree) share one machine, and two things must
// never overlap: resetting/testing the dedicated local database, and production recovery (rolling back a deploy).
// A lock is a directory made with mkdirSync (atomic: EEXIST means held) holding owner.json. A crashed holder is
// reclaimed only when that is provably safe: its PID is dead on this host, or the lock was never finished (no usable
// owner.json for 60 s). A live PID is never reclaimed however old; another host's lock is never reclaimed at all.
import { mkdirSync, rmdirSync, rmSync, renameSync, writeFileSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

const NAME_RE = /^[A-Za-z0-9._-]+$/;
// A lock directory with no usable owner.json this old was abandoned between mkdir and the owner write.
export const INCOMPLETE_STALE_MS = 60_000;
// The reclaim guard protects a millisecond-long section; one this old means its holder crashed inside it.
const GUARD_STALE_MS = 30_000;
const MAX_ATTEMPTS = 5;
// Windows refuses to rename a directory while another process has a file inside it open; retry briefly.
const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

export class LockTimeoutError extends Error {
  constructor(lockName, owner, waitedMs) {
    super(`timed out after ${waitedMs} ms waiting for lock "${lockName}" held by ${describeOwner(owner)}`);
    this.name = 'LockTimeoutError';
    this.lockName = lockName;
    this.owner = owner;
  }
}

function describeOwner(owner) {
  if (!owner) return 'an unknown owner';
  if (owner.incomplete) return 'an unfinished lock (no owner file yet)';
  return `pid ${owner.pid} on ${owner.host} (run ${owner.runId}, since ${owner.startedAt})`;
}

export function defaultLockDir() {
  return path.join(os.homedir(), '.claude', 'pipeline-state', 'locks');
}

// EPERM means the process exists but belongs to someone else: alive. Only ESRCH proves it is gone, and any other
// surprise also counts as alive because wrongly reclaiming a live lock is the one unforgivable mistake.
export function isPidAlive(pid, kill = process.kill.bind(process)) {
  try {
    kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code !== 'ESRCH';
  }
}

function lockPathFor(dir, name) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    throw new Error(`invalid lock name ${JSON.stringify(name)}: use only letters, digits, ".", "_" and "-"`);
  }
  return path.join(dir, `${name}.lock`);
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Returns the owner record, or null when owner.json is missing, unparseable or does not identify a process.
// Any other read error (EACCES, EIO...) is rethrown: only "missing/unparseable" may ever make a lock reclaimable.
function readOwner(lockPath) {
  let text;
  try {
    text = readFileSync(path.join(lockPath, 'owner.json'), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
    throw err;
  }
  let owner;
  try {
    owner = JSON.parse(text);
  } catch {
    return null;
  }
  const usable =
    owner &&
    typeof owner === 'object' &&
    Number.isInteger(owner.pid) &&
    owner.pid > 0 && // kill(0) / kill(-n) would signal process groups
    typeof owner.host === 'string' &&
    owner.host !== '' &&
    typeof owner.runId === 'string' &&
    owner.runId !== '';
  return usable ? owner : null;
}

const incompleteOwner = (name) => ({ name, runId: null, pid: null, host: null, startedAt: null, incomplete: true });
const nameOf = (lockPath) => path.basename(lockPath).replace(/\.lock$/, '');

// One look at a lock: absent | held (owner) | stale (owner, reason). Never mutates anything.
function assess(lockPath, { now, host, isAlive }) {
  let st;
  try {
    st = statSync(lockPath);
  } catch (err) {
    if (err.code === 'ENOENT') return { state: 'absent' };
    throw err;
  }
  const owner = readOwner(lockPath);
  if (owner) {
    if (owner.host !== host) return { state: 'held', owner };
    if (isAlive(owner.pid)) return { state: 'held', owner };
    return { state: 'stale', owner, reason: 'owner process is dead' };
  }
  const placeholder = incompleteOwner(nameOf(lockPath));
  if (now - st.mtimeMs > INCOMPLETE_STALE_MS) return { state: 'stale', owner: placeholder, reason: 'never completed' };
  return { state: 'held', owner: placeholder };
}

// Atomically take a directory out of the way by renaming it; null if it is already gone.
function moveAside(p) {
  const target = `${p}.stale-${randomBytes(6).toString('hex')}`;
  for (let i = 0; ; i++) {
    try {
      renameSync(p, target);
      return target;
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      if (!RETRY_CODES.has(err.code) || i >= 7) throw err;
      sleepSync(25);
    }
  }
}

function removeQuietly(p) {
  try {
    rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  } catch {
    /* it is already out of the way; leftover bytes are harmless */
  }
}

function tryMkdir(p) {
  try {
    mkdirSync(p);
    return true;
  } catch (err) {
    if (err.code === 'EEXIST') return false;
    throw err;
  }
}

// Remove a lock that assess() judged stale. Two reclaimers must not both do this: the slower one would rename the
// faster one's brand-new live lock away. So reclaiming is serialized by a short-lived guard directory, and staleness
// is judged again while holding it. Returns 'busy' (another reclaimer is working) or 'retry' (look again / mkdir).
function reclaim(lockPath, ctx) {
  const guard = `${lockPath}.reclaim`;
  if (!tryMkdir(guard)) {
    let age = 0;
    try {
      age = ctx.now - statSync(guard).mtimeMs;
    } catch {
      return 'retry'; // guard vanished meanwhile
    }
    if (age <= GUARD_STALE_MS) return 'busy';
    const moved = moveAside(guard);
    if (moved) removeQuietly(moved);
    return 'retry';
  }
  let moved = null;
  try {
    if (assess(lockPath, ctx).state === 'stale') moved = moveAside(lockPath);
  } finally {
    try {
      rmdirSync(guard);
    } catch {
      /* best effort; an abandoned guard is cleared after GUARD_STALE_MS */
    }
  }
  if (moved) removeQuietly(moved);
  return 'retry';
}

// Publish owner.json atomically (tmp file + rename) so nobody ever reads a half-written owner.
function writeOwner(lockPath, owner) {
  const tmp = path.join(lockPath, `owner.json.${randomBytes(4).toString('hex')}.tmp`);
  try {
    writeFileSync(tmp, `${JSON.stringify(owner, null, 2)}\n`, { flag: 'wx' });
    renameSync(tmp, path.join(lockPath, 'owner.json'));
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* never created */
    }
    try {
      rmdirSync(lockPath); // only succeeds while empty: never remove a lock that has an owner
    } catch {
      /* not ours to remove */
    }
    throw err;
  }
}

export function tryAcquire(
  name,
  { dir = defaultLockDir(), runId, now = Date.now(), pid = process.pid, host = os.hostname(), isAlive = isPidAlive } = {},
) {
  const lockPath = lockPathFor(dir, name);
  mkdirSync(dir, { recursive: true });
  const ctx = { now, host, isAlive };
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (tryMkdir(lockPath)) {
      const owner = {
        name,
        runId: runId ?? `${pid}-${randomUUID()}`,
        pid,
        host,
        startedAt: new Date(now).toISOString(),
      };
      writeOwner(lockPath, owner);
      return { acquired: true, lock: { ...owner, dir, path: lockPath } };
    }
    const seen = assess(lockPath, ctx);
    if (seen.state === 'absent') continue; // released between our mkdir and this look
    if (seen.state === 'held') return { acquired: false, owner: seen.owner };
    if (reclaim(lockPath, ctx) === 'busy') return { acquired: false, owner: seen.owner };
  }
  return { acquired: false, owner: assess(lockPath, ctx).owner ?? null };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Poll until the lock is ours. Resolves with the lock; rejects with LockTimeoutError once waitMs has elapsed.
// onWait(owner, waitedMs) fires after each failed attempt that will be retried.
export async function acquire(name, { waitMs = 30 * 60e3, pollMs = 1000, onWait, ...rest } = {}) {
  const runId = rest.runId ?? `${rest.pid ?? process.pid}-${randomUUID()}`;
  const started = performance.now();
  for (;;) {
    const result = tryAcquire(name, { ...rest, runId });
    if (result.acquired) return result.lock;
    const waited = performance.now() - started;
    if (waited >= waitMs) throw new LockTimeoutError(name, result.owner, Math.round(waited));
    onWait?.(result.owner, Math.round(waited));
    await sleep(Math.min(pollMs, waitMs - waited));
  }
}

// true when this call released the lock; false when it is gone or now belongs to another run (left untouched).
export function release(lock) {
  const lockPath = lockPathFor(lock.dir, lock.name);
  const owner = readOwner(lockPath);
  if (!owner || owner.runId !== lock.runId) return false;
  const moved = moveAside(lockPath);
  if (moved === null) return false;
  removeQuietly(moved);
  return true;
}

export async function withLock(name, fn, opts) {
  const lock = await acquire(name, opts);
  let fnFailed = false;
  try {
    return await fn(lock);
  } catch (err) {
    fnFailed = true;
    throw err;
  } finally {
    try {
      release(lock);
    } catch (err) {
      if (!fnFailed) throw err; // never let a release failure hide the error that actually mattered
    }
  }
}

// The current owner, or null when there is no lock. A lock directory without a usable owner.json (being created,
// or abandoned) is reported as { incomplete: true, ... } so that "no lock" always means "free".
export function inspect(name, { dir = defaultLockDir() } = {}) {
  const lockPath = lockPathFor(dir, name);
  try {
    statSync(lockPath);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  return readOwner(lockPath) ?? incompleteOwner(name);
}
