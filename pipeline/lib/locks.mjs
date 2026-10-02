// Machine-wide named locks. Several Claude sessions (one per git worktree) share one machine, and two things must
// never overlap: resetting/testing the dedicated local database, and production recovery (rolling back a deploy).
// A lock is a directory made with mkdirSync (atomic: EEXIST means held) holding owner.json, published exclusively
// (hard link, so the first writer wins). A crashed holder is reclaimed only when that is provably safe: its PID is
// dead on this host, or the lock was never finished (no usable owner.json for 60 s). A live PID is never reclaimed
// however old; another machine's lock is never reclaimed at all. "This machine" means the same hostname OR the same
// machine id (a random id persisted once under ~/.claude/pipeline-state): macOS hostnames change with the network, and
// a lock left under the old name must not be stuck forever. Reclaiming is serialized by a guard directory that
// has an owner of its own and is judged by the same rules, so no two reclaimers can both believe they hold it.
import fs from 'node:fs'; // default import: calls go through the object so tests can mock.method(fs, ...)
import os from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

const NAME_RE = /^[A-Za-z0-9._-]+$/;
// A lock directory with no usable owner.json this old was abandoned between mkdir and the owner write.
export const INCOMPLETE_STALE_MS = 60_000;
// A guard without a readable owner this old was abandoned by a reclaimer that crashed inside its short section.
export const GUARD_STALE_MS = 30_000;
const MAX_ATTEMPTS = 5;
// Windows refuses to rename/unlink while another process has the file or directory open; retry for a while.
const BUSY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
// Filesystems without hard links: fall back to a (non-exclusive) rename, then rely on the re-read after publishing.
const NO_LINK_CODES = new Set(['EPERM', 'ENOTSUP', 'EXDEV', 'EOPNOTSUPP']);
// Test seam: retry budget for busy renames/unlinks (40 x 50 ms in production).
export const _tuning = { attempts: 40, waitMs: 50 };

export class LockTimeoutError extends Error {
  constructor(lockName, owner, waitedMs, lockPath, lastError) {
    super(
      `timed out after ${waitedMs} ms waiting for lock "${lockName}" at ${lockPath}, held by ${describeOwner(owner)}` +
        (lastError ? ` (last error: ${lastError.message})` : '') +
        `. To clear it by hand: remove ${lockPath} if no pipeline process is running.`,
    );
    this.name = 'LockTimeoutError';
    this.lockName = lockName;
    this.lockPath = lockPath;
    this.owner = owner;
  }
}

// Thrown by withLock when fn finished but the lock had been taken over meanwhile: whatever fn produced was not
// protected, so the caller must not trust it.
export class LockLostError extends Error {
  constructor(lock) {
    super(
      `lock "${lock.name}" (run ${lock.runId}) was taken over by another owner while it was held; ` +
        'results produced under it are not trustworthy',
    );
    this.name = 'LockLostError';
    this.lock = lock;
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

const MACHINE_ID_RE = /^[A-Za-z0-9._-]{8,80}$/;
let cachedMachineId;

// A stable id for this machine, independent of its hostname: PIPELINE_MACHINE_ID if set, else a random id created once
// in ~/.claude/pipeline-state/machine-id (a home directory shared between machines would share it, so keep the state
// dir local). null when it can be neither read nor created: callers then fall back to comparing hostnames only, which is
// the old, stricter behaviour (never a wrong reclaim).
export function machineId({ env = process.env, stateDir = path.join(os.homedir(), '.claude', 'pipeline-state') } = {}) {
  const fromEnv = String(env.PIPELINE_MACHINE_ID ?? '').trim();
  if (fromEnv) return MACHINE_ID_RE.test(fromEnv) ? fromEnv : null;
  if (cachedMachineId !== undefined && stateDir === path.join(os.homedir(), '.claude', 'pipeline-state')) return cachedMachineId;
  const file = path.join(stateDir, 'machine-id');
  let id = null;
  const read = () => {
    try {
      const text = fs.readFileSync(file, 'utf8').trim();
      return MACHINE_ID_RE.test(text) ? text : null;
    } catch {
      return null;
    }
  };
  id = read();
  if (!id) {
    try {
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(file, `${randomUUID()}\n`, { flag: 'wx' });
    } catch {
      /* lost a race (EEXIST) or cannot write: read whatever is there now */
    }
    id = read();
  }
  if (stateDir === path.join(os.homedir(), '.claude', 'pipeline-state')) cachedMachineId = id;
  return id;
}

// Is a lock owner's process on THIS machine (so its PID can be checked)? Same hostname, or same machine id.
const isLocalOwner = (owner, ctx) => owner.host === ctx.host || (Boolean(ctx.machineId) && owner.machineId === ctx.machineId);

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

function retrying(fn) {
  for (let i = 1; ; i++) {
    try {
      return fn();
    } catch (err) {
      if (!BUSY_CODES.has(err.code) || i >= _tuning.attempts) throw err;
      sleepSync(_tuning.waitMs);
    }
  }
}

// Returns the owner record, or null when owner.json is missing, unparseable or does not identify a process.
// Any other read error (EACCES, EIO...) is rethrown: only "missing/unparseable" may ever make a lock reclaimable.
function readOwner(dirPath) {
  let text;
  try {
    text = fs.readFileSync(path.join(dirPath, 'owner.json'), 'utf8');
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
function assess(lockPath, ctx) {
  const { now, isAlive } = ctx;
  let st;
  try {
    st = fs.statSync(lockPath);
  } catch (err) {
    if (err.code === 'ENOENT') return { state: 'absent' };
    throw err;
  }
  const owner = readOwner(lockPath);
  if (owner) {
    if (!isLocalOwner(owner, ctx)) return { state: 'held', owner };
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
  try {
    retrying(() => fs.renameSync(p, target));
    return target;
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

function removeQuietly(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  } catch {
    /* it is already out of the way; leftover bytes are harmless */
  }
}

function tryMkdir(p) {
  try {
    fs.mkdirSync(p);
    return true;
  } catch (err) {
    if (err.code === 'EEXIST') return false;
    throw err;
  }
}

// Publish owner.json for a directory we just created (the lock itself, or a reclaim guard). It is written to a tmp
// file and hard-linked into place, which fails with EEXIST if anyone published first: even a creator that stalled
// past the 60 s staleness window cannot overwrite the owner that reclaimed its directory. After publishing, owner.json
// is re-read and must carry our runId. Returns { ok: true } or { ok: false, existing } (someone else owns it; their
// file is never touched). Other failures clean up the tmp file and an ownerless directory, then throw.
function publishOwner(dirPath, owner, hooks) {
  const ownerPath = path.join(dirPath, 'owner.json');
  const tmp = path.join(dirPath, `owner.json.${randomBytes(4).toString('hex')}.tmp`);
  const removeTmp = () => {
    try {
      retrying(() => fs.unlinkSync(tmp));
    } catch {
      /* never created, or already renamed into place */
    }
  };
  let lostRace = false;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(owner, null, 2)}\n`, { flag: 'wx' });
    hooks.beforeOwnerPublish?.(dirPath);
    try {
      fs.linkSync(tmp, ownerPath);
    } catch (err) {
      if (err.code === 'EEXIST') lostRace = true;
      else if (NO_LINK_CODES.has(err.code)) retrying(() => fs.renameSync(tmp, ownerPath));
      else throw err;
    }
  } catch (err) {
    removeTmp();
    try {
      fs.rmdirSync(dirPath); // only succeeds while empty: never remove a directory that has an owner
    } catch {
      /* not ours to remove */
    }
    throw err;
  }
  removeTmp();
  if (lostRace) return { ok: false, existing: readOwner(dirPath) };
  hooks.afterOwnerPublish?.(dirPath);
  const current = readOwner(dirPath);
  return current?.runId === owner.runId ? { ok: true } : { ok: false, existing: current };
}

// Remove a directory (lock or guard) if, and only if, its owner.json carries `runId`. Rename-then-remove, so the
// path is free the instant the rename lands. If the rename keeps failing (Windows: something holds the directory
// open), free it by unlinking owner.json and removing the then-empty directory instead.
function releaseDir(dirPath, runId) {
  const owner = readOwner(dirPath);
  if (!owner || owner.runId !== runId) return false;
  let moved;
  try {
    moved = moveAside(dirPath);
  } catch (err) {
    if (!BUSY_CODES.has(err.code)) throw err;
    try {
      retrying(() => fs.unlinkSync(path.join(dirPath, 'owner.json')));
    } catch (unlinkErr) {
      if (unlinkErr.code === 'ENOENT') return false;
      throw err;
    }
    try {
      retrying(() => fs.rmdirSync(dirPath));
    } catch {
      /* an empty leftover directory is reclaimed as "never completed" */
    }
    return true;
  }
  if (moved === null) return false;
  removeQuietly(moved);
  return true;
}

// Break a reclaim guard that someone else holds, but only when it is provably abandoned: its owner is dead on this
// host, or it has no readable owner and is older than GUARD_STALE_MS. A guard owned by a live process (or another
// host) is never broken, however old. The check and the rename are separate steps, so after renaming we confirm we
// moved the very directory we inspected (same inode, same owner); if another reclaimer replaced it in between we
// put it back and give up for now. Returns 'busy' (do not proceed) or 'retry' (guard is gone; look again).
function breakGuard(guard, ctx) {
  let seen;
  try {
    seen = fs.statSync(guard, { bigint: true });
  } catch (err) {
    if (err.code === 'ENOENT') return 'retry';
    throw err;
  }
  const owner = readOwner(guard);
  if (owner) {
    if (!isLocalOwner(owner, ctx) || ctx.isAlive(owner.pid)) return 'busy';
  } else if (ctx.now - Number(seen.mtimeMs) <= GUARD_STALE_MS) {
    return 'busy';
  }
  ctx.hooks.beforeBreakGuard?.(guard);
  const moved = moveAside(guard);
  if (moved === null) return 'retry';
  let sameDir = false;
  try {
    const after = fs.statSync(moved, { bigint: true });
    sameDir = after.ino === seen.ino && (readOwner(moved)?.runId ?? null) === (owner?.runId ?? null);
  } catch {
    /* vanished: treat as not what we inspected */
  }
  if (!sameDir) {
    try {
      retrying(() => fs.renameSync(moved, guard)); // best effort; EEXIST means someone re-created the guard
    } catch {
      /* theirs stays aside; they notice the loss before touching the lock */
    }
    return 'busy';
  }
  removeQuietly(moved);
  return 'retry';
}

// Remove a lock that assess() judged stale. Two reclaimers must not both do this: the slower one would rename the
// faster one's brand-new live lock away. So reclaiming is serialized by a guard directory, staleness is judged again
// while holding it, and the guard is confirmed to still be ours right before the lock is moved.
// Returns 'busy' (another reclaimer is active: report not acquired) or 'retry' (look at the lock again).
function reclaim(lockPath, ctx) {
  const guard = `${lockPath}.reclaim`;
  if (!tryMkdir(guard)) return breakGuard(guard, ctx);
  const me = {
    pid: process.pid,
    host: ctx.host,
    ...(ctx.machineId ? { machineId: ctx.machineId } : {}),
    runId: `${process.pid}-${randomUUID()}`,
    createdAt: new Date(ctx.now).toISOString(),
  };
  let moved = null;
  try {
    if (!publishOwner(guard, me, ctx.hooks).ok) return 'busy';
    if (assess(lockPath, ctx).state === 'stale') {
      ctx.hooks.insideGuard?.(guard, lockPath);
      if (readOwner(guard)?.runId === me.runId) moved = moveAside(lockPath);
    }
  } finally {
    releaseDir(guard, me.runId);
  }
  if (moved) removeQuietly(moved);
  return 'retry';
}

// `hooks` ({ beforeBreakGuard, insideGuard, beforeOwnerPublish, afterOwnerPublish }) are test-only seams that let a
// test interleave another actor at a precise point; production callers never pass them.
// Returns { acquired: true, lock } or { acquired: false, owner[, error] }. `error` is set when we could not write
// our owner file (the lock directory is cleaned up so it cannot block anyone).
export function tryAcquire(
  name,
  {
    dir = defaultLockDir(),
    runId,
    now = Date.now(),
    pid = process.pid,
    host = os.hostname(),
    machineId: machine = machineId(),
    isAlive = isPidAlive,
    hooks = {},
  } = {},
) {
  const lockPath = lockPathFor(dir, name);
  fs.mkdirSync(dir, { recursive: true });
  const ctx = { now, host, machineId: machine, isAlive, hooks };
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (tryMkdir(lockPath)) {
      const owner = {
        name,
        runId: runId ?? `${pid}-${randomUUID()}`,
        pid,
        host,
        ...(machine ? { machineId: machine } : {}),
        startedAt: new Date(now).toISOString(),
      };
      let published;
      try {
        published = publishOwner(lockPath, owner, hooks);
      } catch (error) {
        if (error.code === 'ENOENT') continue; // our directory was taken away before we published: start over
        return { acquired: false, owner: null, error };
      }
      if (!published.ok) return { acquired: false, owner: published.existing ?? assess(lockPath, ctx).owner ?? null };
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
    if (waited >= waitMs) {
      throw new LockTimeoutError(name, result.owner, Math.round(waited), lockPathFor(rest.dir ?? defaultLockDir(), name), result.error);
    }
    onWait?.(result.owner, Math.round(waited));
    await sleep(Math.min(pollMs, waitMs - waited));
  }
}

// true when this call released the lock; false when it is gone or now belongs to another run (left untouched).
export function release(lock) {
  return releaseDir(lockPathFor(lock.dir, lock.name), lock.runId);
}

export async function withLock(name, fn, opts) {
  const lock = await acquire(name, opts);
  let result;
  try {
    result = await fn(lock);
  } catch (err) {
    try {
      release(lock);
    } catch {
      /* never let a release failure hide the error that actually mattered */
    }
    throw err;
  }
  if (!release(lock)) throw new LockLostError(lock);
  return result;
}

// The current owner, or null when there is no lock. A lock directory without a usable owner.json (being created,
// or abandoned) is reported as { incomplete: true, ... } so that "no lock" always means "free".
export function inspect(name, { dir = defaultLockDir() } = {}) {
  const lockPath = lockPathFor(dir, name);
  try {
    fs.statSync(lockPath);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  return readOwner(lockPath) ?? incompleteOwner(name);
}
