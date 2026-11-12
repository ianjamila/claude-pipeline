// Review leases and the admission lock (plan 2026-11-10, PR B1): how an unattended `pipeline update` knows that a review is in flight and
// how a review command learns an update is swapping the pipeline. This module only stores, judges and locks; wiring it into the review
// commands, the stop ritual and the installer is done by their own modules.
//
// LEASES. A lease says "a Claude Code session (or a command in a plain terminal) is working on this worktree's review". They live in
// <accountHome>/.claude/pipeline-state/owner-go/review-leases/, inside the folder the frozen guard protects (an agent cannot delete or forge
// one; the pipeline CLI, which it runs but cannot steer, writes them). The folder is created through owner-go's realDirChain: every level a
// real directory, never a symlink. accountHome() is the passwd home, never $HOME. One file per holder, <sessionId>.json:
//   { version: 1, sessionId, pid, pidStart, ttlOnly?, leases: { <worktree>: { repoId, pr | branch, generation, openedAt, renewedAt, command?, jobOnly? } } }
// (`command` = the leased command that last renewed it, ^[a-z][a-z0-9-]*$, <= 32; every version).
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
// A lease whose session is gone, or that is past the TTL, is still live while a detached `P job` runs in its worktree (jobLive: <worktree>/.review/jobs/*, jobs.mjs).
// LEASED COMMANDS INSIDE A JOB (review round 1, R1-F1). codex-review, ci-wait, merge-hold --wait and merge run as `P job start NAME -- pipeline <cmd>`: no Claude
// ancestor, CLAUDECODE=1. `job start` (which runs in the session) puts holderHandoff() into the job's env (HOLDER_ENV = JSON { sessionId, pid, pidStart }); the
// job's command trusts it only when verifiedSession() agrees (that pid still runs, same ps start, its record still names that sessionId). Then its lease is the
// SESSION's, and the session's summary / ended closes it. Closing while a job still runs keeps the lease as `jobOnly: true` (live only while a job runs there,
// dead the moment it ends, whatever the session or the TTL); a job's own renewals keep it job-scoped, a command of the session itself clears the flag.
// The handed identity is only a public fact (any same-user process can read the three values), so a job holder can only STRENGTHEN: it renews, opens a jobOnly
// lease where the session has none, or reopens / closes one that is already jobOnly; it never reopens, re-aims, clears or closes a normal lease (R2-F1).
// A handed identity that does not check out (forged, the session gone or cleared) falls back to the TTL-only holder.
// CLAUDECODE=1 (or a Claude ancestor) but the session cannot be looked up (no record, no ps, Windows) -> a TTL-ONLY lease: pid and pidStart null,
// live for 6 h after the last renewal. Its holder id is `ttl-<hash of the worktree>`: stable across commands (each is a fresh process) and bounded
// in number; the cost is that two unidentifiable sessions on the same worktree share one lease.
//
// PROCESS HOLDERS (plan 2026-11-12, #249). A plain terminal (no Claude ancestor, no CLAUDECODE) is a PROCESS holder: resolveHolder gives it
// { kind: 'process', sessionId: 'proc-<pid>-<8 random hex>', pid, pidStart | null }, one id per process (memoised), so the close finds the file the open wrote and a reused
// pid never shares one. It goes through admission like any other holder. Its file is VERSION 2 so that every older reader fails closed by construction (they require
// version 1: the file is "unreadable" = live, and their sweeper never touches it): { version: 2, holder: 'process', sessionId, pid, pidStart, host, machineId, leases }.
// A process lease is judged by evidence, never by age (no TTL): dead only when ps lists no such pid, or the pid runs with another start (reused), or kill(pid, 0) says
// ESRCH (the second source needs no ps); live when ps shows the pid with the recorded start; anything else is UNCERTAIN (ps unavailable, our own pid missing from ps's
// answer = the canary, no start time recorded, a holder from another host / machine id): live with `unchecked: true` and a `hint` ("delete <file> if no pipeline
// command is running in a terminal"). An uncertain lease blocks and is never swept; unchecked entries are what live-work-scan turns into a scan-error. An unreadable
// proc- / job- file is reported the same way. Only PIPELINE code that loads files from the install needs this protection: a child that outlives a killed command
// (a Codex run, a verify step) loads nothing from the install and its result is already orphaned, so it is deliberately not tracked; every child that does load the
// install is a pipeline CLI process that takes its own lease, and detached `P job` runs are covered by the job rule.
// `kind: 'none'` exists only as an injected test seam (opts.processHolder === false); production never returns it, so { skipped: 'no-session' } is a seam answer.
// JOB-SCOPED LEASES OF A PROCESS. Closing a lease while a detached job still runs in the worktree must keep it. A process holder's file would then outlive its pid, so
// closeLease MOVES the lease into ONE shared file per worktree, job-<16 hex of the canonical worktree>.json ({ version: 2, holder: 'job', host, machineId, leases },
// jobOnly leases only, no pid), under that file's own per-file lock, and removes its own proc file. jobOnly leases and job files are judged by the job rule ONLY, first:
// live while a job runs there, dead the moment none does. closeLeaseSync (the exit / signal handler's close) takes no lock on its own file and moves only if it can
// take the job file's lock within a short spin; otherwise it keeps its own proc file, the lease marked jobOnly. sweepDeadLeases({ only: ['proc-', 'job-'] }) lets a
// command clean up dead terminal leases without judging session files.
// UNREADABLE JOBS FOLDER (#259). liveJobIn answers true | false | { unreadable: <code> } (ENOENT / ENOTDIR = no jobs); a jobLive that throws counts as { unreadable: 'error' }.
// The lease then stays live with a distinct reason and `unchecked: true`; closeLease keeps it job-scoped and returns `jobRunning: 'unknown'`.
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
// starts (pids -> Map<pid, start> | null; trusted as given, the real ps path adds the own-pid canary), psRun (psStarts' own run seam), sessionRecord (pid -> { sessionId,
// procStart } | null), jobLive (worktree -> true | false | { unreadable }), kill (pid, 0 probe), host / machineId (this machine), processHolder (false: kind none; or
// { sessionId, pid, pidStart } to stand in for this process), only (sweep: id prefixes), jobLockWaitMs (closeLeaseSync).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { accountHome, canonicalPath } from './paths.mjs';
import { LockTimeoutError, acquire, isPidAlive, readMachineId, release, tryAcquire, withLock } from './locks.mjs';
import { seamValue } from './seams.mjs';
import { claudeCodeAncestorPid } from './claude-ancestry.mjs';
import { claudeConfigDirs, psStarts } from './worktree-prune/live-sessions.mjs';
import { jobMayBeRunning } from './jobs.mjs';
import { OWNER_GO_REL, realDirChain } from '../hooks/lib/owner-go.mjs';

export const LEASES_REL = `${OWNER_GO_REL}/review-leases`;
export const LEASE_DIR_ENV = 'PIPELINE_REVIEW_LEASE_DIR';
export const HOLDER_ENV = 'PIPELINE_LEASE_HOLDER';
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
const PROC_ID = /^proc-([1-9][0-9]*)-[0-9a-f]{8}$/;
const JOB_ID = /^job-[0-9a-f]{16}$/;
const COMMAND_RE = /^[a-z][a-z0-9-]*$/;
const COMMAND_MAX = 32;
const JOB_LOCK_WAIT_MS = 500; // closeLeaseSync: how long the exit handler spins for the shared job file's lock before keeping its own file

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

// The session that owns Claude Code process `pid`: ps start time + its own record must exist and agree. `expect` ({ sessionId, pidStart }, from an
// identity handed to a job) must match them too. -> { kind: 'session', sessionId, pid, pidStart } | null.
function verifiedSession(pid, opts, expect) {
  const start = askPs([pid], opts)?.get(pid);
  let rec = null;
  try { rec = (opts.sessionRecord ?? ((p) => readSessionRecord(p, opts)))(pid); } catch { rec = null; }
  if (!start || !rec || !SESSION_ID.test(rec.sessionId ?? '') || (rec.procStart && norm(rec.procStart) !== norm(start))) return null;
  if (expect && (rec.sessionId !== expect.sessionId || norm(start) !== norm(expect.pidStart))) return null;
  return { kind: 'session', sessionId: rec.sessionId, pid, pidStart: norm(start) };
}

// The identity `job start` handed to its job (HOLDER_ENV: JSON { sessionId, pid, pidStart }) -> that, or null when absent or malformed.
function handedIdentity(env) {
  const raw = env?.[HOLDER_ENV];
  if (typeof raw !== 'string' || raw === '' || raw.length > 1024) return null;
  let v;
  try { v = JSON.parse(raw); } catch { return null; }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  if (!isPosInt(v.pid) || typeof v.sessionId !== 'string' || !SESSION_ID.test(v.sessionId) || typeof v.pidStart !== 'string' || v.pidStart === '') return null;
  return { sessionId: v.sessionId, pid: v.pid, pidStart: v.pidStart };
}

// ps for the judge and the holder, ONE source of truth: Map<pid, start> or null when ps cannot answer. The default asks the real ps with OUR OWN pid in
// the query as a canary (R4-5): a ps that rejects `-o lstart=` exits 1 with no output, which psStarts reads as "none of them runs", so an answer that does
// not list our own (running) pid is no answer. An injected `starts` (tests) is trusted as it is; `psRun` is psStarts' own seam.
function askPs(pids, opts) {
  try {
    if (opts.starts) return opts.starts(pids) ?? null;
    const asked = [...new Set([process.pid, ...pids])];
    const answer = psStarts(asked, opts.psRun);
    return answer && answer.has(process.pid) ? answer : null;
  } catch { return null; }
}

// This process's own holder (a plain terminal command): one random id per process, so two commands never share a file even if a pid is reused, and the
// close of a command finds the file its open wrote. pidStart (ps's start time for our own pid) is memoised too, unless ps is injected.
let memo = null; // { pid, sessionId, pidStart?: string | null }
export function _resetProcessHolderForTests() { memo = null; }
function processHolder(opts) {
  if (opts.processHolder === false) return { kind: 'none' }; // test seam; production never passes it
  if (opts.processHolder && typeof opts.processHolder === 'object') return { kind: 'process', ...opts.processHolder };
  if (!memo || memo.pid !== process.pid) memo = { pid: process.pid, sessionId: `proc-${process.pid}-${randomBytes(4).toString('hex')}` };
  let pidStart = memo.pidStart;
  if (pidStart === undefined || opts.starts || opts.psRun) {
    const start = askPs([process.pid], opts)?.get(process.pid);
    pidStart = typeof start === 'string' && start ? norm(start) : null;
    if (!opts.starts && !opts.psRun) memo.pidStart = pidStart;
  }
  return { kind: 'process', sessionId: memo.sessionId, pid: process.pid, pidStart };
}

// Who is asking? -> { kind: 'session', sessionId, pid, pidStart, viaJob? } | { kind: 'ttl', sessionId, pid: null, pidStart: null }
// | { kind: 'process', sessionId: 'proc-<pid>-<8 hex>', pid, pidStart | null } (a plain terminal command; { kind: 'none' } only through the test seam).
// `worktree` only seeds the id of a TTL-only holder. A command inside a detached `P job` has no Claude ancestor but CLAUDECODE=1: when `job start` handed
// it the session's identity (HOLDER_ENV) and that session is still the real one (same ps start, same record: the checks a direct holder gets), it
// is that session's holder (viaJob), so its lease lands in the session's own file and the session's summary / ended closes it. Anything that does
// not check out (forged, stale, the session gone or cleared) is NOT trusted: the TTL-only holder below.
function ancestorOf(opts) {
  let ancestor = null;
  try {
    const given = opts.ancestorPid;
    ancestor = given !== undefined ? (typeof given === 'function' ? given() : given) : claudeCodeAncestorPid(opts.ancestry ?? {});
  } catch { ancestor = null; }
  return isPosInt(ancestor) ? ancestor : null;
}

// Would resolveHolder answer with this process's own holder (a plain terminal)? Cheap for a session (CLAUDECODE=1 decides without asking ps), so the wiring can
// register its exit / signal close BEFORE the lease file is written (a signal between the write and the registration would leave the file behind).
export function isProcessHolderCase(opts = {}) {
  if ((opts.env ?? process.env).CLAUDECODE === '1') return false;
  return ancestorOf(opts) === null;
}

export function resolveHolder({ worktree, ...opts } = {}) {
  const env = opts.env ?? process.env;
  const ancestor = ancestorOf(opts);
  if (ancestor === null && env.CLAUDECODE !== '1') return processHolder(opts);
  if (ancestor !== null) {
    const direct = verifiedSession(ancestor, opts);
    if (direct) return direct;
  } else {
    const handed = handedIdentity(env);
    const viaJob = handed && verifiedSession(handed.pid, opts, handed);
    if (viaJob) return { ...viaJob, viaJob: true };
  }
  const seed = canonicalPath(String(worktree ?? ''));
  return { kind: 'ttl', sessionId: `ttl-${createHash('sha256').update(seed).digest('hex').slice(0, 16)}`, pid: null, pidStart: null };
}

// The env `job start` gives its job so a leased command run inside it (codex-review, ci-wait, merge-hold --wait, merge) joins the SESSION's lease:
// { [HOLDER_ENV]: JSON } for a verified session holder (a direct one, or one already handed down), {} otherwise (a plain terminal; a TTL-only holder is
// derived the same way inside the job, so there is nothing to hand over).
export function holderHandoff({ worktree, ...opts } = {}) {
  let holder;
  try { holder = resolveHolder({ worktree, ...opts }); } catch { return {}; }
  if (holder.kind !== 'session') return {};
  return { [HOLDER_ENV]: JSON.stringify({ sessionId: holder.sessionId, pid: holder.pid, pidStart: holder.pidStart }) };
}

// ---- reading and writing one holder's file ----------------------------------------------------------------------------------------------
const fileOf = (dir, sessionId) => path.join(dir, `${sessionId}.json`);
const isTerminalId = (id) => PROC_ID.test(id) || JOB_ID.test(id);
const jobIdOf = (key) => `job-${createHash('sha256').update(key).digest('hex').slice(0, 16)}`;
const deleteHint = (file) => `delete ${file} if no pipeline command is running in a terminal`;
const validCommand = (c) => typeof c === 'string' && c.length <= COMMAND_MAX && COMMAND_RE.test(c);
const hostOf = (opts) => opts.host ?? os.hostname();
const machineOf = (opts) => (opts.machineId !== undefined ? opts.machineId : readMachineId({ stateDir: stateDirOf(opts) })) ?? null;

function validLease(l) {
  return l && typeof l === 'object' && !Array.isArray(l)
    && typeof l.repoId === 'string' && l.repoId !== ''
    && typeof l.generation === 'string' && l.generation !== ''
    && Number.isFinite(Date.parse(l.openedAt)) && Number.isFinite(Date.parse(l.renewedAt))
    && (l.pr === undefined || isPosInt(l.pr)) && (l.branch === undefined || (typeof l.branch === 'string' && l.branch !== ''))
    && (l.pr !== undefined || l.branch !== undefined)
    && (l.jobOnly === undefined || l.jobOnly === true)
    && (l.command === undefined || validCommand(l.command));
}

// -> { ok: true, rec } | { ok: false, absent: true } | { ok: false, why }. Anything but a plain regular file with a valid body is `why`.
// Version 1 (session / TTL-only holders) as always. Version 2 only as a process file (proc-<pid>-<8 hex>, holder 'process', the pid of its name) or the shared job
// file of a worktree (job-<16 hex>, holder 'job', job-scoped leases only, no pid); a job file's rec is returned with sessionId = its name and pid / pidStart null.
// Every reader before version 2 rejects it at `rec.version !== 1`: unreadable = live, and its sweeper never touches an unreadable file.
function readHolder(dir, sessionId) {
  const file = fileOf(dir, sessionId);
  let st;
  try { st = fs.lstatSync(file); } catch (err) { return err?.code === 'ENOENT' ? { ok: false, absent: true } : { ok: false, why: `cannot stat (${err?.code ?? err?.message})` }; }
  if (!st.isFile()) return { ok: false, why: 'not a regular file (a symlink or a directory)' };
  if (st.size > FILE_MAX_BYTES) return { ok: false, why: `larger than ${FILE_MAX_BYTES} bytes` };
  let rec;
  try { rec = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) { return { ok: false, why: err instanceof SyntaxError ? 'not JSON' : `cannot read (${err?.code ?? err?.message})` }; }
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return { ok: false, why: 'unexpected shape (version / sessionId)' };
  const proc = PROC_ID.exec(sessionId);
  const job = JOB_ID.test(sessionId);
  const hostOk = typeof rec.host === 'string' && rec.host !== '' && (rec.machineId === null || typeof rec.machineId === 'string');
  if (rec.version === 1) {
    if (rec.sessionId !== sessionId) return { ok: false, why: 'unexpected shape (version / sessionId)' };
    if (!(rec.pid === null || isPosInt(rec.pid)) || !(rec.pidStart === null || typeof rec.pidStart === 'string')) return { ok: false, why: 'bad pid / pidStart' };
  } else if (rec.version === 2 && proc) {
    if (rec.holder !== 'process' || rec.sessionId !== sessionId) return { ok: false, why: 'unexpected shape (version / holder / sessionId)' };
    if (rec.pid !== Number(proc[1]) || !isPosInt(rec.pid) || !(rec.pidStart === null || typeof rec.pidStart === 'string') || !hostOk) return { ok: false, why: 'bad pid / pidStart / host' };
  } else if (rec.version === 2 && job) {
    if (rec.holder !== 'job' || rec.sessionId !== undefined || rec.pid !== undefined || rec.pidStart !== undefined) return { ok: false, why: 'unexpected shape (version / holder)' };
    if (!hostOk) return { ok: false, why: 'bad host / machineId' };
  } else return { ok: false, why: 'unexpected shape (version / sessionId)' };
  if (!rec.leases || typeof rec.leases !== 'object' || Array.isArray(rec.leases)) return { ok: false, why: 'no leases object' };
  for (const [wt, l] of Object.entries(rec.leases)) {
    if (!path.isAbsolute(wt) || !validLease(l) || (job && l.jobOnly !== true)) return { ok: false, why: `malformed lease for ${JSON.stringify(wt)}` };
  }
  return { ok: true, rec: job ? { ...rec, sessionId, pid: null, pidStart: null } : rec };
}

// The record to store for `holder` (a process holder: a version-2 process file; anyone else: the version-1 file, as before).
function recordFor(holder, leases, opts) {
  if (holder.kind === 'process') return { version: 2, holder: 'process', sessionId: holder.sessionId, pid: holder.pid, pidStart: holder.pidStart ?? null, host: hostOf(opts), machineId: machineOf(opts), leases };
  return { version: 1, sessionId: holder.sessionId, pid: holder.pid, pidStart: holder.pidStart, ...(holder.kind === 'ttl' ? { ttlOnly: true } : {}), leases };
}

// A job file carries neither a pid nor a session id on disk (its name says which worktree it is for).
const toDisk = (rec) => {
  if (rec.holder !== 'job') return rec;
  const out = { ...rec };
  delete out.sessionId;
  delete out.pid;
  delete out.pidStart;
  return out;
};

// Atomic: a temp file in the same folder, then rename over the target (rename replaces a symlink at the target rather than following it).
// Windows refuses a rename while another process has the file open: retry briefly.
function writeHolder(dir, rec) {
  const file = fileOf(dir, rec.sessionId);
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(toDisk(rec), null, 2)}\n`, { flag: 'wx', mode: 0o600 });
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
// -> true | false | { unreadable: <code> }. Only "no such folder" (ENOENT) or "a parent is not a folder" (ENOTDIR: a job needs .review/jobs/<name>/, which cannot exist under
// a file) means no jobs; an unreadable folder (EACCES, EIO ...) may hide a running job, so it fails closed and carries its code (live-work-scan does the same).
export function liveJobIn(worktree) {
  let names;
  try { names = fs.readdirSync(path.join(worktree, '.review', 'jobs')); } catch (err) {
    return err?.code === 'ENOENT' || err?.code === 'ENOTDIR' ? false : { unreadable: err?.code ?? 'error' };
  }
  for (const name of names) {
    try { if (jobMayBeRunning(name, { cwd: worktree }).running) return true; } catch { /* not a job name */ }
  }
  return false;
}

// A jobLive answer in one shape: true | false | { unreadable }. A THROWING jobLive is not "no job": it is { unreadable: 'error' } (fail closed).
function jobStateOf(jobLive, worktree) {
  try {
    const r = jobLive(worktree);
    if (r === true) return true;
    if (r && typeof r === 'object' && r.unreadable !== undefined) return { unreadable: String(r.unreadable || 'error') };
    return false;
  } catch { return { unreadable: 'error' }; }
}

// One shared view of the machine for a scan: ps answers (asked once for every holder pid) and session records, both memoised.
function makeJudge(opts) {
  const now = nowOf(opts);
  const ttlMs = opts.ttlMs ?? LEASE_TTL_MS;
  const jobLive = opts.jobLive ?? liveJobIn;
  const dir = leasesDir(opts);
  const records = new Map();
  let starts;
  let localMachine;
  const recordOf = (pid) => {
    if (!records.has(pid)) {
      let rec = null;
      try { rec = (opts.sessionRecord ?? ((p) => readSessionRecord(p, opts)))(pid); } catch { rec = null; }
      records.set(pid, rec);
    }
    return records.get(pid);
  };
  const prime = (pids) => {
    if (starts !== undefined || pids.length === 0) return;
    starts = askPs([...new Set(pids)], opts);
  };
  // Same host name, or the same machine id (a renamed machine): the holder's pid can be asked about here (locks.mjs isLocalOwner).
  const sameMachine = (rec) => {
    if (rec.host === hostOf(opts)) return true;
    if (localMachine === undefined) localMachine = machineOf(opts);
    return Boolean(localMachine) && rec.machineId === localMachine;
  };
  // A terminal process's lease (R4-2, R4-5). Evidence of death is positive only: ps lists no such pid, or the pid runs with another start (reused), or kill(pid, 0) says
  // ESRCH. A process that ps shows running with the recorded start is live at ANY age (no TTL). Everything else is UNCERTAIN: live and `unchecked`, never dead by age.
  const processVerdict = (rec, lease) => {
    const label = `terminal process ${rec.pid}`;
    const what = `pipeline ${lease.command ?? '(unknown command)'}`;
    const uncertain = (why) => ({ live: true, unchecked: true, why: `cannot confirm that ${label} (${what}) has ended: ${why}`, hint: deleteHint(fileOf(dir, rec.sessionId)) });
    if (!sameMachine(rec)) return uncertain(`it was started on ${rec.host}, which is not this machine, so its pid cannot be checked here`);
    prime([rec.pid]);
    if (starts) {
      const start = starts.get(rec.pid);
      if (!start) return { live: false, why: `${label} is gone` };
      if (rec.pidStart && norm(start) !== norm(rec.pidStart)) return { live: false, why: `pid ${rec.pid} was reused (it started "${norm(start)}", the lease says "${norm(rec.pidStart)}")` };
      if (rec.pidStart) return { live: true, why: `${label} running ${what} since ${lease.openedAt}` };
    }
    if (!isPidAlive(rec.pid, opts.kill ?? process.kill.bind(process))) return { live: false, why: `${label} no longer exists` };
    return uncertain(starts ? 'no start time was recorded for it, so pid reuse cannot be ruled out' : 'ps unavailable');
  };
  return {
    prime,
    // -> { live, why, unchecked?, hint? } for one lease of the holder `rec`.
    lease(rec, worktree, lease) {
      const ageMs = Math.max(0, now - Date.parse(lease.renewedAt)); // a clock set back counts as just renewed
      const minutes = Math.round(ageMs / 60000);
      let holder;
      // jobOnly leases and the shared job file go to the job rule ONLY, first (R4-4): no process rule, no TTL, applies to every holder kind.
      // The job check below runs for EVERY dead verdict, the TTL one included: a job that outlives the limit is still a review in flight.
      if (rec.holder === 'job') holder = { live: false, why: 'job-scoped lease; live only while a detached job runs in the worktree' };
      else if (lease.jobOnly === true) holder = { live: false, why: 'closed by its session; live only while a detached job runs in the worktree' };
      else if (rec.holder === 'process') holder = processVerdict(rec, lease);
      else if (ageMs > ttlMs) holder = { live: false, why: `idle ${(ageMs / 3600000).toFixed(1)} h (limit ${ttlMs / 3600000} h)` };
      else if (rec.pid === null) holder = { live: true, why: `no session record, TTL-only: renewed ${minutes} min ago` };
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
        const job = jobStateOf(jobLive, worktree);
        if (job === true) return { live: true, why: `${holder.why}; a detached job is still running in the worktree` };
        if (job !== false) return { live: true, unchecked: true, why: `${holder.why}; the jobs folder ${path.join(worktree, '.review', 'jobs')} cannot be read (${job.unreadable}), treated as a running job` };
      }
      return holder;
    },
  };
}

const entryOf = (rec, worktree, lease, verdict) => ({
  sessionId: rec.sessionId, worktree, repoId: lease.repoId, ...(lease.pr !== undefined ? { pr: lease.pr } : {}),
  ...(lease.branch !== undefined ? { branch: lease.branch } : {}), generation: lease.generation, openedAt: lease.openedAt, renewedAt: lease.renewedAt, why: verdict.why,
  holder: rec.holder ?? (rec.ttlOnly ? 'ttl' : 'session'), ...(rec.holder === 'process' ? { pid: rec.pid } : {}),
  ...(lease.command !== undefined ? { command: lease.command } : {}),
  ...(verdict.unchecked ? { unchecked: true } : {}), ...(verdict.hint !== undefined ? { hint: verdict.hint } : {}),
});

function listHolders(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch (err) { if (err?.code === 'ENOENT') return []; throw err; }
  return names.map((n) => FILE_RE.exec(n)?.[1]).filter(Boolean).sort();
}

// What is live? -> { live: [entry], dead: [entry], unreadable: [{ sessionId, file, why, unchecked?, hint? }] }; entry = { sessionId, worktree, repoId, pr?, branch?,
// generation, openedAt, renewedAt, why, holder: 'session' | 'ttl' | 'process' | 'job', pid? (process), command?, unchecked?, hint? }. An unreadable file COUNTS AS LIVE:
// use blocking(scan) to get both. An unreadable proc- / job- file is `unchecked` with the delete hint (it cannot be a session's). Reads only; sweepDeadLeases removes.
export function scanLeases(opts = {}) {
  const dir = leasesDir(opts);
  const out = { live: [], dead: [], unreadable: [] };
  const holders = listHolders(dir).map((sessionId) => ({ sessionId, read: readHolder(dir, sessionId) }));
  const judge = makeJudge(opts);
  judge.prime(holders.flatMap((h) => (h.read.ok && h.read.rec.pid !== null && Object.keys(h.read.rec.leases).length ? [h.read.rec.pid] : [])));
  for (const { sessionId, read } of holders) {
    if (read.absent) continue; // removed since the listing
    if (!read.ok) {
      const file = fileOf(dir, sessionId);
      out.unreadable.push({ sessionId, file, why: read.why, ...(isTerminalId(sessionId) ? { unchecked: true, hint: deleteHint(file) } : {}) });
      continue;
    }
    for (const [worktree, lease] of Object.entries(read.rec.leases)) {
      const verdict = judge.lease(read.rec, worktree, lease);
      (verdict.live ? out.live : out.dead).push(entryOf(read.rec, worktree, lease, verdict));
    }
  }
  return out;
}

// Everything that must hold off an update: live leases plus unreadable files (as entries with worktree null).
export const blocking = (scan) => [
  ...scan.live,
  ...scan.unreadable.map((u) => ({ sessionId: u.sessionId, worktree: null, why: `unreadable lease file (${u.why})`, ...(u.unchecked ? { unchecked: true, hint: u.hint } : {}) })),
];

// Remove dead leases (a holder file with none left is deleted; a file with live leases keeps them). Also removes stale temp files. Never touches an
// unreadable file. Takes only the per-file lock, NOT admission: the installer calls it while holding admission. Each file is re-judged under its lock.
// `only` (['proc-', 'job-']): sweep just the holders whose id starts with one of these (a terminal command's own cleanup must not judge session files).
// -> { removed: [entry], skipped: [{ sessionId, why }] }.
export async function sweepDeadLeases(opts = {}) {
  const dir = leasesDir(opts);
  const removed = [];
  const skipped = [];
  if (!fs.existsSync(dir)) return { removed, skipped };
  const now = nowOf(opts);
  const wanted = (id) => !Array.isArray(opts.only) || opts.only.some((p) => id.startsWith(p));
  try {
    for (const n of fs.readdirSync(dir)) {
      if (!n.endsWith('.tmp') || !wanted(n)) continue;
      try { if (now - fs.lstatSync(path.join(dir, n)).mtimeMs > TMP_STALE_MS) fs.rmSync(path.join(dir, n), { force: true }); } catch { /* next scan */ }
    }
  } catch { /* the folder vanished */ }
  const first = scanLeases(opts);
  const holders = new Set(first.dead.map((e) => e.sessionId).filter(wanted));
  for (const sessionId of listHolders(dir).filter(wanted)) {
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
// Pass `pr` and/or `branch` (at least one) plus `repoId`; `command` (the leased command's name, ^[a-z][a-z0-9-]*$, <= 32) is recorded on the lease (the last command that
// renewed it). Rules for an existing lease on the worktree:
//   same repo, and the PR matches or one side has none  -> renewed (generation kept); a first-known `pr` turns a branch lease into a PR lease (action 'migrated');
//   another PR, another branch (no PR on either side), or another repo -> a new generation (action 'reopened': the worktree moved on to other work).
// Takes admission briefly (code 'update-in-progress' when an update holds it past waitMs), then the per-file lock (code 'review-lease-busy').
// A holder handed down to a job (viaJob; its identity is a public fact any same-user process can present) may only STRENGTHEN: renew a lease, or open a
// jobOnly one where the session has none, or reopen one that is already jobOnly. Over a normal lease it only renews: it never reopens it (another PR / repo /
// branch is left alone, action 'unchanged'; the worktree stays covered by the session's lease) and never rewrites its PR or branch.
// -> { skipped: 'no-session' } | { ok: true, action: 'opened' | 'renewed' | 'migrated' | 'reopened' | 'unchanged', generation, sessionId, ttlOnly }.
export async function openOrRenewLease({ worktree, repoId, pr, branch, command, ...opts } = {}) {
  if (typeof worktree !== 'string' || !worktree) throw codeError('review-lease-args', 'openOrRenewLease needs a worktree path');
  if (typeof repoId !== 'string' || !repoId) throw codeError('review-lease-args', 'openOrRenewLease needs a repoId');
  if (pr !== undefined && pr !== null && !isPosInt(pr)) throw codeError('review-lease-args', `pr must be a positive integer (got ${JSON.stringify(pr)})`);
  if (command !== undefined && command !== null && !validCommand(command)) throw codeError('review-lease-args', `command must match ${COMMAND_RE} and be at most ${COMMAND_MAX} characters (got ${JSON.stringify(command)})`);
  const commandName = command ?? undefined;
  const prNum = pr ?? undefined;
  const branchName = typeof branch === 'string' && branch ? branch : undefined;
  if (prNum === undefined && branchName === undefined) throw codeError('review-lease-args', 'openOrRenewLease needs a pr or a branch');
  const key = canon(worktree);
  const holder = resolveHolder({ worktree: key, ...opts });
  if (holder.kind === 'none') return { skipped: 'no-session' };
  const dir = ensureDir(opts);
  return withAdmission(() => withFileLock(holder.sessionId, dir, opts, () => {
    const now = nowOf(opts); // stamped once admission is held: a command that waited for an update must not carry a time from before the swap
    const read = readHolder(dir, holder.sessionId);
    if (!read.ok && !read.absent && /not a regular file/.test(read.why)) throw codeError('review-lease-unwritable', `${fileOf(dir, holder.sessionId)} is ${read.why}: refusing to write it`);
    // A handed (job) identity may only strengthen: it never replaces a file the scan counts as live with a job-scoped lease (closeLease's rule).
    if (!read.ok && !read.absent && holder.viaJob) return { ok: true, action: 'unchanged', sessionId: holder.sessionId, ttlOnly: false };
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
    if (holder.viaJob && cur && cur.jobOnly !== true) {
      // Never reopen, re-aim or clear a normal lease from a job: renewal is all it may do (the session's own next command does the rest).
      leases[key] = { ...cur, renewedAt: iso(now), ...(commandName !== undefined ? { command: commandName } : {}) };
      writeHolder(dir, recordFor(holder, leases, opts));
      return { ok: true, action: action === 'renewed' || action === 'migrated' ? 'renewed' : 'unchanged', generation: cur.generation, sessionId: holder.sessionId, ttlOnly: false };
    }
    if (action === 'opened' || action === 'reopened') {
      // A lease a job's command opens (the session had closed its own) lives only while a job runs: the job must not leave a lease behind.
      lease = {
        repoId, ...(prNum !== undefined ? { pr: prNum } : { branch: branchName }), generation: randomUUID(), openedAt: iso(now), renewedAt: iso(now),
        ...(commandName !== undefined ? { command: commandName } : {}), ...(holder.viaJob ? { jobOnly: true } : {}),
      };
    } else {
      lease = { ...cur, renewedAt: iso(now) };
      if (commandName !== undefined) lease.command = commandName;
      if (!holder.viaJob) delete lease.jobOnly; // a command of the session itself: it is working on this worktree again
      if (prNum !== undefined) { lease.pr = prNum; delete lease.branch; }
    }
    leases[key] = lease;
    writeHolder(dir, recordFor(holder, leases, opts));
    return { ok: true, action, generation: lease.generation, sessionId: holder.sessionId, ttlOnly: holder.kind === 'ttl' };
  }), opts);
}

// ---- close -------------------------------------------------------------------------------------------------------------------------------
// Shared by closeLease and closeLeaseSync; runs inside the holder's file lock (or, for the sync close, without one). -> { done: result } | { read, cur }.
function closeRead(dir, holder, key, generation) {
  const read = readHolder(dir, holder.sessionId);
  if (!read.ok) {
    if (read.absent) return { done: { closed: false, why: 'absent' } };
    if (/not a regular file/.test(read.why)) throw codeError('review-lease-unwritable', `${fileOf(dir, holder.sessionId)} is ${read.why}: refusing to touch it`);
    if (holder.viaJob) return { done: { closed: false, why: 'not-job-scoped' } };
    removeHolder(dir, holder.sessionId); // our own corrupt file: nothing in it can be trusted to keep
    return { done: { closed: true, sessionId: holder.sessionId } };
  }
  const cur = read.rec.leases[key];
  if (!cur) return { done: { closed: false, why: 'absent' } };
  if (generation !== undefined && cur.generation !== generation) return { done: { closed: false, why: 'stale-generation' } };
  if (holder.viaJob && cur.jobOnly !== true) return { done: { closed: false, why: 'not-job-scoped' } };
  return { read, cur };
}

function dropOwnLease(dir, holder, read, key) {
  const leases = { ...read.rec.leases };
  delete leases[key];
  if (Object.keys(leases).length === 0) removeHolder(dir, holder.sessionId);
  else writeHolder(dir, { ...read.rec, leases });
}

// A detached job (or a jobs folder that cannot be read) keeps the lease covered after its command ended: it stays in the holder's own file, job-scoped.
function keepOwnLeaseJobOnly(dir, holder, read, key, cur) {
  if (cur.jobOnly === true) return;
  writeHolder(dir, { ...read.rec, leases: { ...read.rec.leases, [key]: { ...cur, jobOnly: true } } });
}

// A process holder's job-scoped lease moves to the worktree's ONE shared job file (version 2, holder 'job', job rule only), so any number of terminal commands
// leave a single file behind. Runs under that file's lock. A lease already there stays (newer renewedAt wins); an unreadable job file is replaced: it can only have
// held job-scoped leases of this very worktree, which this lease now covers. -> the job file's id.
function mergeIntoJobFile(dir, key, cur, opts) {
  const id = jobIdOf(key);
  const read = readHolder(dir, id);
  if (!read.ok && !read.absent && /not a regular file/.test(read.why)) throw codeError('review-lease-unwritable', `${fileOf(dir, id)} is ${read.why}: refusing to write it`);
  const leases = read.ok ? { ...read.rec.leases } : {};
  const have = leases[key];
  leases[key] = have ? { ...have, renewedAt: Date.parse(have.renewedAt) >= Date.parse(cur.renewedAt) ? have.renewedAt : cur.renewedAt } : { ...cur, jobOnly: true };
  writeHolder(dir, { version: 2, holder: 'job', sessionId: id, pid: null, pidStart: null, host: hostOf(opts), machineId: machineOf(opts), leases });
  return id;
}

// Close this session's lease on `worktree`. With `generation`, only that generation closes: a stale one (the lease was reopened since) is ignored.
// Does not take admission. A holder handed down to a job (viaJob) may close only a lease that is already jobOnly: a normal lease (or a corrupt file) is left
// as it is (why 'not-job-scoped'); the session's own summary / ended closes those.
// A job still running in the worktree (or a jobs folder that cannot be read: treated as running, `jobRunning: 'unknown'`) keeps the lease job-scoped. A process
// holder's job-scoped lease MOVES into the worktree's shared job file (under that file's lock; if that lock stays busy it keeps its own file, jobOnly).
// -> { skipped: 'no-session' } | { closed: true, sessionId, jobRunning?: true | 'unknown' } | { closed: false, why: 'absent' | 'stale-generation' | 'not-job-scoped' }.
export async function closeLease({ worktree, generation, ...opts } = {}) {
  if (typeof worktree !== 'string' || !worktree) throw codeError('review-lease-args', 'closeLease needs a worktree path');
  const key = canon(worktree);
  const holder = resolveHolder({ worktree: key, ...opts });
  if (holder.kind === 'none') return { skipped: 'no-session' };
  const probe = leasesDir(opts);
  if (!fs.existsSync(probe)) return { closed: false, why: 'absent' };
  const dir = ensureDir(opts);
  return withFileLock(holder.sessionId, dir, opts, async () => {
    const step = closeRead(dir, holder, key, generation);
    if (step.done) return step.done;
    const { read, cur } = step;
    const state = jobStateOf(opts.jobLive ?? liveJobIn, key);
    if (state === false) {
      dropOwnLease(dir, holder, read, key);
      return { closed: true, sessionId: holder.sessionId };
    }
    const jobRunning = state === true ? true : 'unknown';
    if (holder.kind === 'process') {
      try {
        await withFileLock(jobIdOf(key), dir, opts, () => mergeIntoJobFile(dir, key, cur, opts));
        dropOwnLease(dir, holder, read, key);
        return { closed: true, sessionId: holder.sessionId, jobRunning };
      } catch (err) {
        if (err?.code !== 'review-lease-busy') throw err; // the job file stays busy: fall through and keep our own file, job-scoped
      }
    }
    keepOwnLeaseJobOnly(dir, holder, read, key, cur);
    return { closed: true, sessionId: holder.sessionId, jobRunning };
  });
}

// closeLease for the exit / signal handler of a terminal command: synchronous (an `exit` listener cannot await), so it takes NO lock on its own file: that file belongs to
// this process alone (the id is random per process); the only other writer is the installer's sweep, which re-judges under its lock and cannot drop a lease whose pid
// still runs. A job-scoped lease still moves to the shared job file, but only if that file's lock can be taken within a short synchronous spin (`jobLockWaitMs`, default
// 500 ms); otherwise the handler does NOT write the job file unlocked: it keeps its own proc file with the lease marked jobOnly, which the judge reads by the job rule
// only (it dies with the job, and the next sweep removes it). Process holders only: { skipped: 'not-process' } for anyone else, { skipped: 'no-session' } for none.
export function closeLeaseSync({ worktree, generation, ...opts } = {}) {
  if (typeof worktree !== 'string' || !worktree) throw codeError('review-lease-args', 'closeLeaseSync needs a worktree path');
  const key = canon(worktree);
  const holder = resolveHolder({ worktree: key, ...opts });
  if (holder.kind === 'none') return { skipped: 'no-session' };
  if (holder.kind !== 'process') return { skipped: 'not-process' };
  if (!fs.existsSync(leasesDir(opts))) return { closed: false, why: 'absent' };
  const dir = ensureDir(opts);
  const step = closeRead(dir, holder, key, generation);
  if (step.done) return step.done;
  const { read, cur } = step;
  const state = jobStateOf(opts.jobLive ?? liveJobIn, key);
  if (state === false) {
    dropOwnLease(dir, holder, read, key);
    return { closed: true, sessionId: holder.sessionId };
  }
  const jobRunning = state === true ? true : 'unknown';
  const lock = takeLockSync(`lease-${jobIdOf(key)}`, dir, opts);
  if (lock) {
    try {
      mergeIntoJobFile(dir, key, cur, opts);
      dropOwnLease(dir, holder, read, key);
    } finally {
      try { release(lock); } catch { /* the lock folder is stale-reclaimed by the next taker */ }
    }
    return { closed: true, sessionId: holder.sessionId, jobRunning };
  }
  keepOwnLeaseJobOnly(dir, holder, read, key, cur);
  return { closed: true, sessionId: holder.sessionId, jobRunning };
}

// tryAcquire in a short synchronous spin -> the lock, or null when it stayed busy (or could not be tried) for opts.jobLockWaitMs.
function takeLockSync(name, dir, opts) {
  const waitMs = opts.jobLockWaitMs ?? JOB_LOCK_WAIT_MS;
  const machineId = machineOf(opts) ?? undefined;
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const r = tryAcquire(name, { dir, ...(machineId ? { machineId } : {}) });
      if (r.acquired) return r.lock;
    } catch { return null; }
    if (Date.now() >= deadline) return null;
    sleepSync(10);
  }
}
