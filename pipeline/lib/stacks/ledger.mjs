// The lease ledger of stack-stop: one JSON object per line in ledger.jsonl, "this Claude process used this stack". It is the
// only record that a stack is still needed, so it fails closed: a line that cannot be read, or whose `t` is not a valid ISO
// time, is DAMAGE, and a damaged ledger makes readLedger unknown (callers keep every stack until `repair` moves the bad
// lines aside). Events larger than MAX_LINE are refused so one append is always a single small write.
//
// Locking (R2-5, R3-3). Every writer (appendEvent) and repairLedger take the ledger lock (name `ledger`, directory
// lockDirs(root).ledger) around their work, and appenders open the file by path for each append, never a cached
// descriptor, so repair's rename cannot strand a writer on an old inode and no lease is lost between repair's read and its
// rename. Lock order everywhere: project locks (sorted by name) FIRST, then the ledger lock, which is held only for the
// single append or the repair. readLedger takes no lock (a reader that catches an append half-done sees a torn last line =
// damage = keep, never a wrong "free").
//
// appendEvent and repairLedger are async because waiting for the lock is: both answer ok | unknown and never throw.
import fs from 'node:fs';
import path from 'node:path';
import { acquire, release } from '../locks.mjs';
import { lockDirs } from './paths.mjs';
import { ok, unknown } from './result.mjs';

export const MAX_LINE = 4000;
const LOCK_NAME = 'ledger';
const DEFAULT_WAIT_MS = 10000;
const POLL_MS = 20;
const BUSY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']); // Windows: rename over a file someone just had open

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// A valid ISO 8601 date-time with a zone (Z or +hh:mm): the shape toISOString() writes, offsets also accepted. Calendar
// impossibilities (Feb 31, month 13) are invalid.
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/;
export function validIsoTime(t) {
  if (typeof t !== 'string') return false;
  const m = ISO_RE.exec(t);
  if (!m) return false;
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number);
  if (mo < 1 || mo > 12 || h > 23 || mi > 59 || s > 59) return false;
  if (m[7] !== undefined && (Number(m[7]) > 23 || Number(m[8]) > 59)) return false;
  if (d < 1 || d > new Date(Date.UTC(y, mo, 0)).getUTCDate()) return false;
  return !Number.isNaN(Date.parse(t));
}

const lockPathOf = (lockDir) => path.join(lockDir, `${LOCK_NAME}.lock`);
const defaultLockDir = (file) => lockDirs(path.dirname(file)).ledger;

// Waits for the ledger lock: at most until `deadlineAt` (the register hook's single deadline) when given, else waitMs.
// ok(lock) | unknown naming the lock path.
async function takeLock({ lockDir, waitMs = DEFAULT_WAIT_MS, deadlineAt, now = Date.now, pollMs = POLL_MS }) {
  const budget = deadlineAt === undefined || deadlineAt === null ? waitMs : Math.max(0, Math.min(waitMs, deadlineAt - now()));
  try {
    return ok(await acquire(LOCK_NAME, { dir: lockDir, waitMs: budget, pollMs }));
  } catch (err) {
    const where = lockPathOf(lockDir);
    const msg = String(err?.message ?? err);
    return unknown(`ledger lock unavailable: ${msg.includes(where) ? msg : `${msg} (${where})`}`);
  }
}

function dropLock(lock) {
  try {
    release(lock);
  } catch {
    /* the lock is reclaimed once its owner is dead; never hide the real result */
  }
}

// ---- append ----
// ok(undefined) | unknown. Refuses a non-object, an event without a valid ISO `t` (it would damage the ledger) and a line over
// MAX_LINE bytes, all before taking the lock. Opens the file by path, writes one line, fsyncs, closes.
export async function appendEvent(file, event, { lockDir = defaultLockDir(file), waitMs, deadlineAt, now, pollMs } = {}) {
  if (!isObject(event)) return unknown('event is not an object');
  if (!validIsoTime(event.t)) return unknown('event has no valid ISO time t');
  let json;
  try {
    json = JSON.stringify(event);
  } catch (err) {
    return unknown(`event cannot be serialised: ${err.message}`);
  }
  if (Buffer.byteLength(json) > MAX_LINE) return unknown('event too large');
  const locked = await takeLock({ lockDir, waitMs, deadlineAt, now, pollMs });
  if (!locked.ok) return locked;
  let fd;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fd = fs.openSync(file, 'a', 0o600);
    fs.writeSync(fd, `${json}\n`);
    fs.fsyncSync(fd);
    return ok(undefined);
  } catch (err) {
    return unknown(`ledger append failed: ${err.message}`);
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* the data is fsynced; a failed close changes nothing */
      }
    }
    dropLock(locked.value);
  }
}

// ---- read ----
// Splits ledger text into { good: [{ n, event }], bad: [{ n, text, why }] } (n = 1-based line number). A last line without
// a newline is a torn write: bad, even if it happens to parse.
function scan(text) {
  const good = [];
  const bad = [];
  if (text === '') return { good, bad };
  const parts = text.split('\n');
  const torn = parts.pop(); // '' when the text ends with a newline
  parts.forEach((line, i) => {
    const n = i + 1;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return bad.push({ n, text: line, why: 'not JSON' });
    }
    if (!isObject(event)) return bad.push({ n, text: line, why: 'not an object' });
    if (!validIsoTime(event.t)) return bad.push({ n, text: line, why: 'no valid ISO time t' });
    good.push({ n, event });
  });
  if (torn !== '') bad.push({ n: parts.length + 1, text: torn, why: 'torn last line (no newline)' });
  return { good, bad };
}

function readText(file) {
  try {
    return { text: fs.readFileSync(file, 'utf8') };
  } catch (err) {
    return err?.code === 'ENOENT' ? { text: '' } : { fail: unknown(`ledger unreadable: ${err.message}`) };
  }
}

export function readLedger(file) {
  const r = readText(file);
  if (r.fail) return r.fail;
  const { good, bad } = scan(r.text);
  if (bad.length > 0) return unknown(`damaged ledger line ${bad[0].n}: ${bad[0].why}`);
  return ok(good.map((g) => g.event));
}

// ---- queries ----
const sameText = (a, b) => typeof a === 'string' && typeof b === 'string' && a !== '' && a.toLowerCase() === b.toLowerCase();
const sameExact = (a, b) => typeof a === 'string' && typeof b === 'string' && a !== '' && a === b;

// `use` events for this stack: by project id, or by folder / workdir for a stack that is not running when the lease is
// written (its containers, and so its project id, do not exist yet). Over-matching only adds a lease.
export function leasesFor(events, stack) {
  return events.filter(
    (e) => e?.kind === 'use' && (sameText(e.project, stack?.project) || sameExact(e.folder, stack?.folder) || sameExact(e.workdir, stack?.workdir)),
  );
}

const keyOf = (o) => `${o.pid}:${o.birth}`;

// ok(Map<"pid:birth", { owner, events }>) of the owners still alive, in first-seen order. `isAlive(owner)` is the identity
// check (ok(bool) | unknown); any unknown, or an event with no usable owner, makes the whole answer unknown.
export function liveOwners(events, { isAlive }) {
  const groups = new Map();
  for (const e of events) {
    const owner = e?.owner;
    if (!isObject(owner) || !Number.isInteger(owner.pid) || owner.pid <= 0 || !Number.isFinite(owner.birth)) {
      return unknown('lease event has no usable owner { pid, birth }');
    }
    const key = keyOf(owner);
    if (!groups.has(key)) groups.set(key, { owner: { pid: owner.pid, birth: owner.birth }, events: [] });
    groups.get(key).events.push(e);
  }
  const live = new Map();
  for (const [key, group] of groups) {
    let r;
    try {
      r = isAlive(group.owner);
    } catch (err) {
      return unknown(`liveness of ${key} failed: ${err?.message ?? err}`);
    }
    if (!r || r.ok !== true) return unknown(`liveness of ${key} unknown: ${r?.reason ?? 'no answer'}`);
    if (r.value) live.set(key, group);
  }
  return ok(live);
}

// ---- repair ----
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function renameReplacing(from, to) {
  for (let i = 1; ; i++) {
    try {
      return fs.renameSync(from, to);
    } catch (err) {
      if (!BUSY_CODES.has(err.code) || i >= 20) throw err;
      sleepSync(50);
    }
  }
}

function writeSynced(file, text, flag) {
  const fd = fs.openSync(file, flag, 0o600);
  try {
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

// Moves every damaged line to `badFile` and rewrites the rest atomically. ok({ moved }) | unknown (lock unavailable or an
// I/O error; the ledger is then unchanged). Under the ledger lock: read, [afterRead], append the bad lines to badFile and
// fsync, write the good lines to a temp file in the same directory, fsync, rename over the ledger. A crash after the first
// step leaves the bad lines in both files, never in neither. `afterRead` is a test seam fired between read and rename.
export async function repairLedger(file, badFile, { lockDir = defaultLockDir(file), waitMs, deadlineAt, now, pollMs, afterRead } = {}) {
  const locked = await takeLock({ lockDir, waitMs, deadlineAt, now, pollMs });
  if (!locked.ok) return locked;
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    const r = readText(file);
    if (r.fail) return r.fail;
    const { good, bad } = scan(r.text);
    await afterRead?.();
    if (bad.length === 0) return ok({ moved: 0 });
    fs.mkdirSync(path.dirname(badFile), { recursive: true, mode: 0o700 });
    writeSynced(badFile, bad.map((b) => `${b.text}\n`).join(''), 'a');
    writeSynced(tmp, good.map((g) => `${JSON.stringify(g.event)}\n`).join(''), 'w');
    renameReplacing(tmp, file);
    return ok({ moved: bad.length });
  } catch (err) {
    return unknown(`ledger repair failed: ${err.message}`);
  } finally {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* already renamed into place */
    }
    dropLock(locked.value);
  }
}
