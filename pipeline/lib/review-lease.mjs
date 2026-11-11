// Review leases and the admission lock (plan 2026-11-10, PR B1): how an unattended `pipeline update` knows that a review is in flight and
// how a review command learns an update is swapping the pipeline. This module only stores, judges and locks; wiring it into the review
// commands, the stop ritual and the installer is done by their own modules.
//
// LEASES. A lease says "a Claude Code session is working on this worktree's review". They live in
// <accountHome>/.claude/pipeline-state/owner-go/review-leases/, inside the folder the frozen guard protects (an agent cannot delete or forge
// one; the pipeline CLI, which it runs but cannot steer, writes them). The folder is created through owner-go's realDirChain: every level a
// real directory, never a symlink. accountHome() is the passwd home, never $HOME. One file per holder, <sessionId>.json:
//   { version: 1, sessionId, pid, pidStart, ttlOnly?, leases: { <worktree>: { repoId, pr | branch, generation, openedAt, renewedAt } } }
// A session edits only its own file, under a per-file lock (`lease-<sessionId>`), so two sessions on one PR hold two leases and one closing
// never removes the other. Writes are atomic (temp file + rename). Every open gets a new `generation`; closing may name it, so a late
// `ended` run cannot close a lease that was resumed since. A branch lease becomes a PR lease on the first call that knows the PR (same generation).
//
// HOLDER IDENTITY (Fable P2-5). The nearest Claude Code ancestor's pid (claude-ancestry.mjs) -> that session's own record
// <config>/sessions/<pid>.json (worktree-prune/live-sessions.mjs, every ~/.claude* config dir, so both accounts) -> sessionId; its start time
// is what `ps` reports for the pid (and must agree with the record's procStart). A lease is LIVE only while: its pid is running AND started when
// the lease says (pid reuse) AND the session record for that pid still carries the lease's sessionId (a `/clear` keeps the pid but changes the id
// -> dead) AND renewedAt is within LEASE_TTL_MS (6 h: an idle terminal stops blocking updates). A long Fable pass with no pipeline command in
// between stays covered because the session is alive and the TTL is long. Things that cannot be placed fail toward "live", never toward "dead":
//   - an unreadable or malformed lease file counts as LIVE (listed in `unreadable`; blocking() merges it with `live`);
//   - ps cannot be asked, or the session record is missing/unmatched while the pid runs: live until the TTL.
// A lease whose session is gone is still live while a detached `P job` runs in its worktree (jobLive: <worktree>/.review/jobs/*, jobs.mjs).
// CLAUDECODE=1 (or a Claude ancestor) but the session cannot be looked up (no record, no ps, Windows) -> a TTL-ONLY lease: pid and pidStart null,
// live for 6 h after the last renewal. Its holder id is `ttl-<hash of the worktree>`: stable across commands (each is a fresh process) and bounded
// in number; the cost is that two unidentifiable sessions on the same worktree share one lease. A plain terminal (no Claude ancestor, no CLAUDECODE)
// writes nothing: open/renew/close return { skipped: 'no-session' }.
//
// ADMISSION. A separate lock, `admission`, in the SAME protected folder, resolved from accountHome() only (never PIPELINE_LOCK_DIR, never
// CLAUDE_CONFIG_DIR: the two accounts share one). The installer holds it across the scan and the swap (acquireAdmission/releaseAdmission);
// opening or renewing a lease takes it briefly (withAdmission, bounded wait, then code 'update-in-progress'). Closing a lease never takes it:
// ending a review must not fail because an update is running, and a stale lease only makes the scan defer.
//   LOCK ORDER: installer lock -> admission -> (per-file lease lock); a review command: admission (brief, released) -> per-PR state lock -> model-floor.
//   Nothing the installer runs while it holds admission may open a lease (that would wait on itself).
//
// Tests: PIPELINE_REVIEW_LEASE_DIR redirects the folder; like PIPELINE_MODEL_FLOOR_DIR it is honoured ONLY by a repo checkout (an installed copy
// ignores it with one stderr warning) and is deliberately not in the guard's seam list. Every function takes the same injectable options:
// dir, home, env, root, warn (folder), now (epoch ms), ancestorPid (number | null | () => number | null), ancestry (claudeCodeAncestorPid opts),
// starts (pids -> Map<pid, start> | null), sessionRecord (pid -> { sessionId, procStart } | null), jobLive (worktree -> boolean).
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { accountHome, canonicalPath } from './paths.mjs';
import { LockTimeoutError, acquire, readMachineId, release, withLock } from './locks.mjs';
import { seamValue } from './seams.mjs';
import { claudeCodeAncestorPid } from './claude-ancestry.mjs';
import { claudeConfigDirs, psStarts } from './worktree-prune/live-sessions.mjs';
import { readJob } from './jobs.mjs';
import { OWNER_GO_REL, realDirChain } from '../hooks/lib/owner-go.mjs';

export const LEASES_REL = `${OWNER_GO_REL}/review-leases`;
export const LEASE_DIR_ENV = 'PIPELINE_REVIEW_LEASE_DIR';
export const ADMISSION_LOCK = 'admission';
export const LEASE_TTL_MS = 6 * 60 * 60 * 1000;
export const ADMISSION_WAIT_MS = 20_000;
export const FILE_LOCK_WAIT_MS = 5_000;
export const UPDATE_IN_PROGRESS = 'pipeline update in progress, retry in a minute';
const FILE_MAX_BYTES = 256 * 1024;
const TMP_STALE_MS = 10 * 60 * 1000;
const FILE_RE = /^([A-Za-z0-9][A-Za-z0-9_-]*)\.json$/;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const BUSY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

const codeError = (code, message, extra) => Object.assign(new Error(message), { code }, extra);
const norm = (s) => String(s ?? '').trim().replace(/\s+/g, ' ');
const iso = (ms) => new Date(ms).toISOString();
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const isPosInt = (n) => Number.isSafeInteger(n) && n > 0;
const stateDirOf = (opts) => path.join(opts.home ?? accountHome(), '.claude', 'pipeline-state');
const nowOf = (opts) => (Number.isFinite(opts.now) ? opts.now : Date.now());

// ---- where the leases live ---------------------------------------------------------------------------------------------------------------
// `dir` (injected, in-process tests) wins; else $PIPELINE_REVIEW_LEASE_DIR (checkout only); else the account's folder (`home` injectable).
export function leasesDir({ dir, home, env, root, warn } = {}) {
  if (dir) return path.resolve(dir);
  const seamOpts = {};
  if (root !== undefined) seamOpts.root = root;
  if (warn !== undefined) seamOpts.warn = warn;
  const override = seamValue(LEASE_DIR_ENV, env, seamOpts);
  if (override) return path.resolve(override);
  return path.join(home ?? accountHome(), ...LEASES_REL.split('/'));
}

// Create the folder through owner-go's real-directory chain (the same rule as model-floor): from <home>/.claude down for the account's folder,
// only from its own name for an injected or overridden one. Throws 'review-lease-unwritable' when a level is missing, not a directory, or a symlink.
function ensureDir(opts) {
  const dir = leasesDir(opts);
  const standard = !opts.dir && dir === path.join(opts.home ?? accountHome(), ...LEASES_REL.split('/'));
  let ok;
  if (standard) ok = fs.existsSync(opts.home ?? accountHome()) && realDirChain(opts.home ?? accountHome(), LEASES_REL);
  else {
    try { fs.mkdirSync(path.dirname(dir), { recursive: true }); } catch { /* realDirChain reports it */ }
    ok = realDirChain(path.dirname(dir), path.basename(dir));
  }
  if (!ok) throw codeError('review-lease-unwritable', `cannot create the review lease folder ${dir}: a level of it is missing, not a directory, or a symlink`);
  return dir;
}

// ---- admission ---------------------------------------------------------------------------------------------------------------------------
// Takes the machine-wide admission lock, waiting up to waitMs, then throws code 'update-in-progress' (message `busyMessage`). Returns the lock handle
// for releaseAdmission. The installer holds it across scan + swap + its own verification.
export async function acquireAdmission({ waitMs = ADMISSION_WAIT_MS, pollMs = 100, busyMessage = UPDATE_IN_PROGRESS, ...opts } = {}) {
  const dir = ensureDir(opts);
  try {
    return await acquire(ADMISSION_LOCK, { dir, waitMs, pollMs, machineId: readMachineId({ stateDir: stateDirOf(opts) }) });
  } catch (err) {
    if (err instanceof LockTimeoutError) throw codeError('update-in-progress', busyMessage, { cause: err });
    throw err;
  }
}

// true when this call released the lock (false: it is gone or no longer ours).
export const releaseAdmission = (lock) => release(lock);

// fn(lock) runs holding admission; released afterwards whatever fn does. For review commands: keep fn short.
export async function withAdmission(fn, opts = {}) {
  const lock = await acquireAdmission(opts);
  try {
    return await fn(lock);
  } finally {
    try { release(lock); } catch { /* a release failure must not hide fn's own outcome */ }
  }
}

async function withFileLock(sessionId, dir, opts, fn) {
  const waitMs = opts.fileWaitMs ?? FILE_LOCK_WAIT_MS;
  try {
    return await withLock(`lease-${sessionId}`, () => fn(), { dir, waitMs, pollMs: 25, machineId: readMachineId({ stateDir: stateDirOf(opts) }) });
  } catch (err) {
    if (err instanceof LockTimeoutError) throw codeError('review-lease-busy', `the review lease file for ${sessionId} is busy (waited ${waitMs} ms): ${err.message.replace(/ To clear it by hand.*$/, '')}`, { cause: err });
    throw err;
  }
}

// ---- holder identity ---------------------------------------------------------------------------------------------------------------------
// <config>/sessions/<pid>.json in any ~/.claude* config dir (both accounts) or $CLAUDE_CONFIG_DIR -> { sessionId, procStart | null } or null.
export function readSessionRecord(pid, { home, env = process.env } = {}) {
  let configs;
  try { configs = claudeConfigDirs(home ?? accountHome(), env); } catch { return null; }
  for (const config of configs) {
    let rec;
    try { rec = JSON.parse(fs.readFileSync(path.join(config, 'sessions', `${pid}.json`), 'utf8')); } catch { continue; }
    if (rec && rec.pid === pid && typeof rec.sessionId === 'string' && SESSION_ID.test(rec.sessionId)) {
      return { sessionId: rec.sessionId, procStart: typeof rec.procStart === 'string' && rec.procStart ? norm(rec.procStart) : null };
    }
  }
  return null;
}

// Who is asking? -> { kind: 'session', sessionId, pid, pidStart } | { kind: 'ttl', sessionId, pid: null, pidStart: null } | { kind: 'none' }.
// `worktree` only seeds the id of a TTL-only holder.
export function resolveHolder({ worktree, ...opts } = {}) {
  const env = opts.env ?? process.env;
  let ancestor = null;
  try {
    const given = opts.ancestorPid;
    ancestor = given !== undefined ? (typeof given === 'function' ? given() : given) : claudeCodeAncestorPid(opts.ancestry ?? {});
  } catch { ancestor = null; }
  if (!isPosInt(ancestor)) ancestor = null;
  if (ancestor === null && env.CLAUDECODE !== '1') return { kind: 'none' };
  if (ancestor !== null) {
    let start;
    try { start = (opts.starts ?? psStarts)([ancestor])?.get(ancestor); } catch { start = undefined; }
    let rec = null;
    try { rec = (opts.sessionRecord ?? ((p) => readSessionRecord(p, opts)))(ancestor); } catch { rec = null; }
    if (start && rec && SESSION_ID.test(rec.sessionId ?? '') && (!rec.procStart || norm(rec.procStart) === norm(start))) {
      return { kind: 'session', sessionId: rec.sessionId, pid: ancestor, pidStart: norm(start) };
    }
  }
  const seed = canonicalPath(String(worktree ?? ''));
  return { kind: 'ttl', sessionId: `ttl-${createHash('sha256').update(seed).digest('hex').slice(0, 16)}`, pid: null, pidStart: null };
}

// ---- reading and writing one holder's file ----------------------------------------------------------------------------------------------
const fileOf = (dir, sessionId) => path.join(dir, `${sessionId}.json`);

function validLease(l) {
  return l && typeof l === 'object' && !Array.isArray(l)
    && typeof l.repoId === 'string' && l.repoId !== ''
    && typeof l.generation === 'string' && l.generation !== ''
    && Number.isFinite(Date.parse(l.openedAt)) && Number.isFinite(Date.parse(l.renewedAt))
    && (l.pr === undefined || isPosInt(l.pr)) && (l.branch === undefined || (typeof l.branch === 'string' && l.branch !== ''))
    && (l.pr !== undefined || l.branch !== undefined);
}

// -> { ok: true, rec } | { ok: false, absent: true } | { ok: false, why }. Anything but a plain regular file with a valid body is `why`.
function readHolder(dir, sessionId) {
  const file = fileOf(dir, sessionId);
  let st;
  try { st = fs.lstatSync(file); } catch (err) { return err?.code === 'ENOENT' ? { ok: false, absent: true } : { ok: false, why: `cannot stat (${err?.code ?? err?.message})` }; }
  if (!st.isFile()) return { ok: false, why: 'not a regular file (a symlink or a directory)' };
  if (st.size > FILE_MAX_BYTES) return { ok: false, why: `larger than ${FILE_MAX_BYTES} bytes` };
  let rec;
  try { rec = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) { return { ok: false, why: err instanceof SyntaxError ? 'not JSON' : `cannot read (${err?.code ?? err?.message})` }; }
  if (!rec || typeof rec !== 'object' || rec.version !== 1 || rec.sessionId !== sessionId) return { ok: false, why: 'unexpected shape (version / sessionId)' };
  if (!(rec.pid === null || isPosInt(rec.pid)) || !(rec.pidStart === null || typeof rec.pidStart === 'string')) return { ok: false, why: 'bad pid / pidStart' };
  if (!rec.leases || typeof rec.leases !== 'object' || Array.isArray(rec.leases)) return { ok: false, why: 'no leases object' };
  for (const [wt, l] of Object.entries(rec.leases)) if (!path.isAbsolute(wt) || !validLease(l)) return { ok: false, why: `malformed lease for ${JSON.stringify(wt)}` };
  return { ok: true, rec };
}

// Atomic: a temp file in the same folder, then rename over the target (rename replaces a symlink at the target rather than following it).
// Windows refuses a rename while another process has the file open: retry briefly.
function writeHolder(dir, rec) {
  const file = fileOf(dir, rec.sessionId);
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(rec, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  for (let attempt = 0; ; attempt++) {
    try { fs.renameSync(tmp, file); return; } catch (err) {
      if (attempt < 40 && BUSY_CODES.has(err?.code)) { sleepSync(25); continue; }
      try { fs.rmSync(tmp, { force: true }); } catch { /* leave it: sweep removes stale temp files */ }
      throw err;
    }
  }
}

const removeHolder = (dir, sessionId) => fs.rmSync(fileOf(dir, sessionId), { force: true });

// ---- judging -----------------------------------------------------------------------------------------------------------------------------
// The default jobLive: a detached `P job` still running in the worktree (jobs.mjs keeps its record under <worktree>/.review/jobs/<name>/).
export function liveJobIn(worktree) {
  let names;
  try { names = fs.readdirSync(path.join(worktree, '.review', 'jobs')); } catch { return false; }
  for (const name of names) {
    try { if (readJob(name, { cwd: worktree }).state === 'running') return true; } catch { /* not a job folder */ }
  }
  return false;
}

// One shared view of the machine for a scan: ps answers (asked once for every holder pid) and session records, both memoised.
function makeJudge(opts) {
  const now = nowOf(opts);
  const ttlMs = opts.ttlMs ?? LEASE_TTL_MS;
  const jobLive = opts.jobLive ?? liveJobIn;
  const records = new Map();
  let starts;
  const recordOf = (pid) => {
    if (!records.has(pid)) {
      let rec = null;
      try { rec = (opts.sessionRecord ?? ((p) => readSessionRecord(p, opts)))(pid); } catch { rec = null; }
      records.set(pid, rec);
    }
    return records.get(pid);
  };
  return {
    prime(pids) {
      if (starts !== undefined || pids.length === 0) return;
      try { starts = (opts.starts ?? psStarts)([...new Set(pids)]) ?? null; } catch { starts = null; }
    },
    // -> { live, why } for one lease of the holder `rec`.
    lease(rec, worktree, lease) {
      const ageMs = Math.max(0, now - Date.parse(lease.renewedAt)); // a clock set back counts as just renewed
      const minutes = Math.round(ageMs / 60000);
      if (ageMs > ttlMs) return { live: false, why: `idle ${(ageMs / 3600000).toFixed(1)} h (limit ${ttlMs / 3600000} h)` };
      let holder;
      if (rec.pid === null) holder = { live: true, why: `no session record, TTL-only: renewed ${minutes} min ago` };
      else if (starts === null || starts === undefined) holder = { live: true, why: `ps unavailable, treated as live: renewed ${minutes} min ago` };
      else {
        const start = starts.get(rec.pid);
        const cur = recordOf(rec.pid);
        if (!start) holder = { live: false, why: `session process ${rec.pid} is gone` };
        else if (norm(start) !== norm(rec.pidStart)) holder = { live: false, why: `pid ${rec.pid} was reused (it started "${norm(start)}", the lease says "${norm(rec.pidStart)}")` };
        else if (!cur) holder = { live: true, why: `session ${rec.sessionId} running (its record is missing, treated as live): renewed ${minutes} min ago` };
        else if (cur.procStart && norm(cur.procStart) !== norm(start)) holder = { live: true, why: `session record for pid ${rec.pid} does not match the process, treated as live: renewed ${minutes} min ago` };
        else if (cur.sessionId !== rec.sessionId) holder = { live: false, why: `pid ${rec.pid} now runs session ${cur.sessionId} (a /clear or resume changed the id)` };
        else holder = { live: true, why: `session ${rec.sessionId} running: renewed ${minutes} min ago` };
      }
      if (!holder.live) {
        let job = false;
        try { job = jobLive(worktree) === true; } catch { job = false; }
        if (job) return { live: true, why: `${holder.why}; a detached job is still running in the worktree` };
      }
      return holder;
    },
  };
}

const entryOf = (rec, worktree, lease, verdict) => ({
  sessionId: rec.sessionId, worktree, repoId: lease.repoId, ...(lease.pr !== undefined ? { pr: lease.pr } : {}),
  ...(lease.branch !== undefined ? { branch: lease.branch } : {}), generation: lease.generation, renewedAt: lease.renewedAt, why: verdict.why,
});

function listHolders(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch (err) { if (err?.code === 'ENOENT') return []; throw err; }
  return names.map((n) => FILE_RE.exec(n)?.[1]).filter(Boolean).sort();
}

// What is live? -> { live: [entry], dead: [entry], unreadable: [{ sessionId, file, why }] }; entry = { sessionId, worktree, repoId, pr?, branch?,
// generation, renewedAt, why }. An unreadable file COUNTS AS LIVE: use blocking(scan) to get both. Reads only; sweepDeadLeases removes.
export function scanLeases(opts = {}) {
  const dir = leasesDir(opts);
  const out = { live: [], dead: [], unreadable: [] };
  const holders = listHolders(dir).map((sessionId) => ({ sessionId, read: readHolder(dir, sessionId) }));
  const judge = makeJudge(opts);
  judge.prime(holders.flatMap((h) => (h.read.ok && h.read.rec.pid !== null && Object.keys(h.read.rec.leases).length ? [h.read.rec.pid] : [])));
  for (const { sessionId, read } of holders) {
    if (read.absent) continue; // removed since the listing
    if (!read.ok) { out.unreadable.push({ sessionId, file: fileOf(dir, sessionId), why: read.why }); continue; }
    for (const [worktree, lease] of Object.entries(read.rec.leases)) {
      const verdict = judge.lease(read.rec, worktree, lease);
      (verdict.live ? out.live : out.dead).push(entryOf(read.rec, worktree, lease, verdict));
    }
  }
  return out;
}

// Everything that must hold off an update: live leases plus unreadable files (as entries with worktree null).
export const blocking = (scan) => [...scan.live, ...scan.unreadable.map((u) => ({ sessionId: u.sessionId, worktree: null, why: `unreadable lease file (${u.why})` }))];

// Remove dead leases (a holder file with none left is deleted; a file with live leases keeps them). Also removes stale temp files. Never touches an
// unreadable file. Takes only the per-file lock, NOT admission: the installer calls it while holding admission. Each file is re-judged under its lock.
// -> { removed: [entry], skipped: [{ sessionId, why }] }.
export async function sweepDeadLeases(opts = {}) {
  const dir = leasesDir(opts);
  const removed = [];
  const skipped = [];
  if (!fs.existsSync(dir)) return { removed, skipped };
  const now = nowOf(opts);
  try {
    for (const n of fs.readdirSync(dir)) {
      if (!n.endsWith('.tmp')) continue;
      try { if (now - fs.lstatSync(path.join(dir, n)).mtimeMs > TMP_STALE_MS) fs.rmSync(path.join(dir, n), { force: true }); } catch { /* next scan */ }
    }
  } catch { /* the folder vanished */ }
  const first = scanLeases(opts);
  const holders = new Set(first.dead.map((e) => e.sessionId));
  for (const sessionId of listHolders(dir)) {
    const read = readHolder(dir, sessionId);
    if (read.ok && Object.keys(read.rec.leases).length === 0) holders.add(sessionId);
  }
  for (const sessionId of [...holders].sort()) {
    try {
      await withFileLock(sessionId, dir, { ...opts, fileWaitMs: opts.fileWaitMs ?? 1000 }, () => {
        const read = readHolder(dir, sessionId);
        if (!read.ok) return; // gone, or unreadable now: leave it
        const judge = makeJudge(opts);
        if (read.rec.pid !== null) judge.prime([read.rec.pid]);
        const keep = {};
        for (const [worktree, lease] of Object.entries(read.rec.leases)) {
          const verdict = judge.lease(read.rec, worktree, lease);
          if (verdict.live) keep[worktree] = lease; else removed.push(entryOf(read.rec, worktree, lease, verdict));
        }
        if (Object.keys(keep).length === 0) removeHolder(dir, sessionId);
        else if (Object.keys(keep).length !== Object.keys(read.rec.leases).length) writeHolder(dir, { ...read.rec, leases: keep });
      });
    } catch (err) {
      if (err?.code === 'review-lease-busy') skipped.push({ sessionId, why: 'its file is locked by a running command' });
      else throw err;
    }
  }
  return { removed, skipped };
}

// ---- open / renew / close ----------------------------------------------------------------------------------------------------------------
const canon = (worktree) => canonicalPath(worktree);

// Open this session's lease on `worktree`, or renew it (renew opens when absent, so a review begun on an older install gets one at its next command).
// Pass `pr` and/or `branch` (at least one) plus `repoId`. Rules for an existing lease on the worktree:
//   same repo, and the PR matches or one side has none  -> renewed (generation kept); a first-known `pr` turns a branch lease into a PR lease (action 'migrated');
//   another PR, another branch (no PR on either side), or another repo -> a new generation (action 'reopened': the worktree moved on to other work).
// Takes admission briefly (code 'update-in-progress' when an update holds it past waitMs), then the per-file lock (code 'review-lease-busy').
// -> { skipped: 'no-session' } | { ok: true, action: 'opened' | 'renewed' | 'migrated' | 'reopened', generation, sessionId, ttlOnly }.
export async function openOrRenewLease({ worktree, repoId, pr, branch, ...opts } = {}) {
  if (typeof worktree !== 'string' || !worktree) throw codeError('review-lease-args', 'openOrRenewLease needs a worktree path');
  if (typeof repoId !== 'string' || !repoId) throw codeError('review-lease-args', 'openOrRenewLease needs a repoId');
  if (pr !== undefined && pr !== null && !isPosInt(pr)) throw codeError('review-lease-args', `pr must be a positive integer (got ${JSON.stringify(pr)})`);
  const prNum = pr ?? undefined;
  const branchName = typeof branch === 'string' && branch ? branch : undefined;
  if (prNum === undefined && branchName === undefined) throw codeError('review-lease-args', 'openOrRenewLease needs a pr or a branch');
  const key = canon(worktree);
  const holder = resolveHolder({ worktree: key, ...opts });
  if (holder.kind === 'none') return { skipped: 'no-session' };
  const dir = ensureDir(opts);
  const now = nowOf(opts);
  return withAdmission(() => withFileLock(holder.sessionId, dir, opts, () => {
    const read = readHolder(dir, holder.sessionId);
    if (!read.ok && !read.absent && /not a regular file/.test(read.why)) throw codeError('review-lease-unwritable', `${fileOf(dir, holder.sessionId)} is ${read.why}: refusing to write it`);
    const leases = read.ok ? { ...read.rec.leases } : {}; // a corrupt file of OUR OWN session id has nothing worth keeping
    const cur = leases[key];
    let action;
    let lease;
    if (!cur) {
      action = 'opened';
    } else if (cur.repoId !== repoId) {
      action = 'reopened';
    } else if (cur.pr !== undefined && prNum !== undefined && cur.pr !== prNum) {
      action = 'reopened';
    } else if (cur.pr === undefined && prNum === undefined && cur.branch !== undefined && branchName !== undefined && cur.branch !== branchName) {
      action = 'reopened';
    } else {
      action = cur.pr === undefined && prNum !== undefined ? 'migrated' : 'renewed';
    }
    if (action === 'opened' || action === 'reopened') {
      lease = { repoId, ...(prNum !== undefined ? { pr: prNum } : { branch: branchName }), generation: randomUUID(), openedAt: iso(now), renewedAt: iso(now) };
    } else {
      lease = { ...cur, renewedAt: iso(now) };
      if (prNum !== undefined) { lease.pr = prNum; delete lease.branch; }
    }
    leases[key] = lease;
    writeHolder(dir, { version: 1, sessionId: holder.sessionId, pid: holder.pid, pidStart: holder.pidStart, ...(holder.kind === 'ttl' ? { ttlOnly: true } : {}), leases });
    return { ok: true, action, generation: lease.generation, sessionId: holder.sessionId, ttlOnly: holder.kind === 'ttl' };
  }), opts);
}

// Close this session's lease on `worktree`. With `generation`, only that generation closes: a stale one (the lease was reopened since) is ignored.
// Does not take admission. -> { skipped: 'no-session' } | { closed: true, sessionId } | { closed: false, why: 'absent' | 'stale-generation' }.
export async function closeLease({ worktree, generation, ...opts } = {}) {
  if (typeof worktree !== 'string' || !worktree) throw codeError('review-lease-args', 'closeLease needs a worktree path');
  const key = canon(worktree);
  const holder = resolveHolder({ worktree: key, ...opts });
  if (holder.kind === 'none') return { skipped: 'no-session' };
  const probe = leasesDir(opts);
  if (!fs.existsSync(probe)) return { closed: false, why: 'absent' };
  const dir = ensureDir(opts);
  return withFileLock(holder.sessionId, dir, opts, () => {
    const read = readHolder(dir, holder.sessionId);
    if (!read.ok) {
      if (read.absent) return { closed: false, why: 'absent' };
      if (/not a regular file/.test(read.why)) throw codeError('review-lease-unwritable', `${fileOf(dir, holder.sessionId)} is ${read.why}: refusing to touch it`);
      removeHolder(dir, holder.sessionId); // our own corrupt file: nothing in it can be trusted to keep
      return { closed: true, sessionId: holder.sessionId };
    }
    const cur = read.rec.leases[key];
    if (!cur) return { closed: false, why: 'absent' };
    if (generation !== undefined && cur.generation !== generation) return { closed: false, why: 'stale-generation' };
    const leases = { ...read.rec.leases };
    delete leases[key];
    if (Object.keys(leases).length === 0) removeHolder(dir, holder.sessionId);
    else writeHolder(dir, { ...read.rec, leases });
    return { closed: true, sessionId: holder.sessionId };
  });
}
