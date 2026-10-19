// Dev servers of stack-stop: bind a session's OWN dev server by process ancestry, stop only that one when the session ends,
// and list every dev listener for the report. Spec section 2 and 3, plan Task 10 with Revisions 2 and 3.
//
// WHAT "OWN" MEANS. A listener is bound to a session's dev record (written by the register hook before the command ran) only
// when ALL of these hold, checked at bind time (the owner cannot be re-walked once it has exited):
//   - the listener's process ancestry, walked through the injected `lookup`, reaches the owning Claude process with the same
//     {pid, birth}. A server started from a terminal, a replacement that appeared after the real launch failed, and a daemon
//     re-parented to init (ppid 1) are not descended from the session: unbound, never killed;
//   - its birth is in [tPre - 2 s, tPost + 60 s] (tPre = hook before the tool, tPost = hook after it);
//   - its cwd is inside the recorded worktree (or the recorded cwd; a root with fewer than 3 path segments, `/` or a home
//     directory, is never a usable root);
//   - no OTHER session's dev record for that port has a window that also contains the birth (ambiguous: unbound);
//   - the same listener is not already bound to another record (one listener binds once).
// Exactly one qualifying listener binds; two or none leave the record unbound.
//
// WHAT STOPS. Only a listener bound to the exiting owner, still alive with the SAME {pid, birth} (a reused pid is a stranger)
// and with its cwd still inside the recorded root, receives exactly ONE SIGTERM, under the dev lock (`dev/<port>`, R3-3), and
// only after fresh gates read right before the signal (R2-6): pause file absent, machine config ok, mode.json `devServers` is
// `apply`. After 10 s the process is looked at again; if it is still there it is reported and left alone: never SIGKILL.
// In `report` mode the row says `would-stop` and nothing is signalled. Every row also records how long the listener was
// alive after the owner exited (`aliveAfterExitMs`), so the owner can see whether this path matters at all.
//
// devRows is report-only: it lists listeners and never signals anything.
//
// FAIL CLOSED. Every probe answers ok | unknown (result.mjs); a failed lsof / ps is never read as "no listener", and an
// unknown anywhere leaves the record unbound / the server alone. The hook (runDevBind) NEVER blocks the tool: it exits 0
// whatever happens, under an internal 8 s deadline that bounds every subprocess and lock wait.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquire as realAcquire, release as realRelease } from '../locks.mjs';
import { run as realRun } from '../proc.mjs';
import { canonicalPath, isInside } from '../paths.mjs';
import { isPaused, loadMachineConfig, loadModes } from './config.mjs';
import { isAlive as realIsAlive, procIdentity } from './identity.mjs';
import { appendEvent as realAppendEvent } from './ledger.mjs';
import { lockDirs, stackFiles, stacksRoot, stacksSeam } from './paths.mjs';
import { ok, unknown } from './result.mjs';

export const DEV_DEADLINE_MS = 8000;
export const MIN_AGE_MS = 3000; // a record younger than this has had no time to listen yet
export const MAX_AGE_MS = 10 * 60 * 1000; // an older unbound record is given up on
export const BIRTH_BEFORE_S = 2;
export const BIRTH_AFTER_S = 60;
export const TERM_WAIT_MS = 10000;
const CALL_CAP_MS = 3000;
const MIN_REMAINING_MS = 300;
const MAX_HOPS = 32;
const LEDGER_TAIL_BYTES = 1024 * 1024;
const LEDGER_LOOKBACK_MS = 25 * 60 * 1000; // covers MAX_AGE_MS plus the windows of other records
const DEFAULT_LSOF = '/usr/sbin/lsof';
const DEFAULT_PS = '/bin/ps';
// A UTF-8 locale keeps non-ASCII paths printable in lsof output.
const LOCALE = { LC_ALL: 'en_US.UTF-8', LANG: 'en_US.UTF-8' };
const defaultKill = (pid, sig) => process.kill(pid, sig);
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
const keyOfOwner = (o) => `${o?.pid}:${o?.birth}`;
const isOwner = (o) => o !== null && typeof o === 'object' && Number.isInteger(o.pid) && o.pid > 0 && Number.isFinite(o.birth);
const toSec = (t) => {
  const ms = typeof t === 'number' ? t : Date.parse(t);
  return Number.isFinite(ms) ? ms / 1000 : null;
};

// ---- probes ----

// The lsof / ps binaries for this process: the PIPELINE_LSOF / PIPELINE_PS test seams (isolated runs in the checkout only,
// see stacksSeam), else the system paths. (Same rule as evidence.mjs; repeated here so the hook does not load evidence.mjs.)
export function resolveDevBins({ env = process.env, home = os.homedir(), root, warn } = {}) {
  const pick = (name, fallback) => {
    const v = stacksSeam(name, env, { root, home, ...(warn ? { warn } : {}) });
    return v !== undefined && String(v).trim() !== '' ? String(v).trim() : fallback;
  };
  return { lsof: pick('PIPELINE_LSOF', DEFAULT_LSOF), ps: pick('PIPELINE_PS', DEFAULT_PS) };
}

// One subprocess bounded by min(3 s, time left). -> { r } | { fail: unknown-result }.
function call(run, bin, args, { deadlineAt, now = Date.now, env } = {}) {
  let timeoutMs = CALL_CAP_MS;
  if (deadlineAt !== undefined && deadlineAt !== null) {
    const remaining = deadlineAt - now();
    if (remaining < MIN_REMAINING_MS) return { fail: unknown('deadline') };
    timeoutMs = Math.min(CALL_CAP_MS, remaining);
  }
  let r;
  try {
    r = run(bin, args, { timeoutMs, ...(env ? { env } : {}) });
  } catch (err) {
    return { fail: unknown(`${path.basename(bin)} could not run: ${oneLine(err?.message ?? err)}`) };
  }
  if (!r || typeof r !== 'object') return { fail: unknown(`${path.basename(bin)} gave no result`) };
  if (r.timedOut) return { fail: unknown(`${path.basename(bin)} timed out`) };
  if (r.signal) return { fail: unknown(`${path.basename(bin)} ended by signal ${r.signal}`) };
  return { r };
}

const silentExit1 = (r) => r.code === 1 && String(r.stdout ?? '').trim() === '' && String(r.stderr ?? '').trim() === '';

// pids of LISTEN sockets on `port`. A clean "exit 1, nothing printed" is lsof's own "nothing found"; a signal, a timeout, a
// spawn error or any other exit is unknown (never "no listener").
function listenerPids(port, { run, lsof, deadlineAt, now }) {
  const c = call(run, lsof, ['-nP', '-w', `-iTCP:${port}`, '-sTCP:LISTEN', '-F', 'pn'], { deadlineAt, now, env: LOCALE });
  if (c.fail) return c.fail;
  const { r } = c;
  if (silentExit1(r)) return ok([]);
  if (r.code !== 0) return unknown(`lsof exit ${r.code}: ${oneLine(r.stderr)}`);
  const pids = [];
  for (const line of String(r.stdout ?? '').split('\n')) {
    if (line[0] === 'p' && /^\d+$/.test(line.slice(1))) {
      const pid = Number(line.slice(1));
      if (!pids.includes(pid)) pids.push(pid);
    }
  }
  return pids.length > 0 ? ok(pids) : unknown('lsof printed no process for the port');
}

// The cwd of one pid: ok(path) | ok(null) when lsof shows nothing for it (gone, or hidden: the caller decides) | unknown.
function cwdOf(pid, { run, lsof, deadlineAt, now }) {
  const c = call(run, lsof, ['-nP', '-w', '-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { deadlineAt, now, env: LOCALE });
  if (c.fail) return c.fail;
  const { r } = c;
  let cwd = null;
  let fd = null;
  for (const line of String(r.stdout ?? '').split('\n')) {
    if (line[0] === 'f') fd = line.slice(1);
    else if (line[0] === 'n' && (fd === 'cwd' || fd === null)) cwd = line.slice(1);
  }
  if (cwd !== null && cwd !== '') return ok(cwd);
  if (r.code === 0 || silentExit1(r)) return ok(null);
  return unknown(`lsof exit ${r.code} for pid ${pid}: ${oneLine(r.stderr)}`);
}

// Every process listening on `port`: ok([{pid, birth, cwd}]) | unknown. A listener that vanishes between the calls (its
// identity or cwd is positively gone) is left out; one that is alive but whose cwd cannot be read makes the answer unknown.
export function listeners(port, { run = realRun, lsof = DEFAULT_LSOF, ps = DEFAULT_PS, kill, platform = process.platform, deadlineAt, now = Date.now } = {}) {
  if (platform === 'win32') return unknown('windows');
  if (!Number.isInteger(port) || port < 1 || port > 65535) return unknown(`bad port ${JSON.stringify(port)}`);
  const pids = listenerPids(port, { run, lsof, deadlineAt, now });
  if (!pids.ok) return pids;
  const out = [];
  for (const pid of pids.value) {
    const id = procIdentity(pid, { run, ps, ...(kill ? { kill } : {}), platform, deadlineAt, now });
    if (!id.ok) return unknown(`identity of listener ${pid}: ${id.reason}`);
    if (id.value === null) continue;
    const cwd = cwdOf(pid, { run, lsof, deadlineAt, now });
    if (!cwd.ok) return cwd;
    if (cwd.value === null) {
      const again = procIdentity(pid, { run, ps, ...(kill ? { kill } : {}), platform, deadlineAt, now });
      if (again.ok && again.value === null) continue;
      return unknown(`listener ${pid} is alive but its cwd is not readable`);
    }
    out.push({ pid, birth: id.value.birth, cwd: cwd.value });
  }
  return ok(out);
}

// A lookup for bindDev built on the injected run: lookup(pid, { withBirth }) -> ok({ ppid, birth? }) | unknown.
// `birth` is only fetched when asked for (the one hop that is the claimed owner).
export function psLookup({ run = realRun, ps = DEFAULT_PS, kill, platform = process.platform, deadlineAt, now = Date.now } = {}) {
  return (pid, { withBirth = false } = {}) => {
    const c = call(run, ps, ['-o', 'ppid=,comm=', '-p', String(pid)], { deadlineAt, now, env: { TZ: 'UTC', LC_ALL: 'C' } });
    if (c.fail) return c.fail;
    const m = /^\s*(\d+)\s+(.+)$/.exec(String(c.r.stdout ?? '').trim());
    if (c.r.code !== 0 || !m) return unknown(`no ps line for pid ${pid}`);
    const info = { ppid: Number(m[1]) };
    if (withBirth) {
      const id = procIdentity(pid, { run, ps, ...(kill ? { kill } : {}), platform, deadlineAt, now });
      if (!id.ok) return id;
      if (id.value === null) return unknown(`pid ${pid} is gone`);
      info.birth = id.value.birth;
    }
    return ok(info);
  };
}

// ---- records ----

// The dev records of `events`, each joined with the tPost of its tool call (a `dev-post` with the same session and
// tool_use_id), and flagged with the listener it is bound to, if any. Oldest first.
export function devRecords(events) {
  const posts = new Map();
  for (const e of events ?? []) if (e?.kind === 'dev-post' && e.tool_use_id) posts.set(`${e.session_id}|${e.tool_use_id}`, e.tPost);
  const binds = devBinds(events);
  const out = [];
  for (const e of events ?? []) {
    if (e?.kind !== 'dev' || !Number.isInteger(e.port) || !isOwner(e.owner)) continue;
    const tPost = e.tool_use_id ? posts.get(`${e.session_id}|${e.tool_use_id}`) : undefined;
    out.push({ ...e, ...(tPost !== undefined ? { tPost } : {}), bound: binds.find((b) => sameRecord(b, e)) ?? null });
  }
  return out.sort((a, b) => (toSec(a.tPre ?? a.t) ?? 0) - (toSec(b.tPre ?? b.t) ?? 0));
}

const devBinds = (events) => (events ?? []).filter((e) => e?.kind === 'dev-bind' && Number.isInteger(e.port) && isOwner(e.owner));
const sameRecord = (bind, rec) => bind.devT === rec.t && bind.port === rec.port && keyOfOwner(bind.owner) === keyOfOwner(rec.owner) && bind.session_id === rec.session_id;

// The time window in which a listener could be this record's server, in epoch seconds. Without a tPost (the tool call has not
// finished or its hook never ran) the window stays open as long as a record can still be bound, which only makes it wider.
function windowOf(rec, { nowSec }) {
  const pre = toSec(rec.tPre ?? rec.t);
  if (pre === null) return null;
  const post = toSec(rec.tPost);
  const end = post !== null ? post : Math.max(nowSec, pre + MAX_AGE_MS / 1000);
  return { from: pre - BIRTH_BEFORE_S, to: end + BIRTH_AFTER_S };
}

// The directories a listener's cwd may be in: the record's worktree and its cwd, minus anything too broad to mean "the project".
function usableRoots(rec, platform = process.platform) {
  const roots = [];
  for (const r of [rec.worktree, rec.cwd]) {
    if (typeof r !== 'string' || r === '' || r === 'none') continue;
    const segs = r.replace(/\\/g, '/').split('/').filter(Boolean);
    if (segs.length < 3) continue; // `/`, `/Users`, a home directory: not a project
    roots.push(r);
  }
  return [...new Set(roots)].map((r) => ({ raw: r, real: safeCanonical(r), platform }));
}
function safeCanonical(p) {
  try {
    return canonicalPath(p);
  } catch {
    return p;
  }
}
function cwdInsideRoots(cwd, roots, platform = process.platform) {
  const real = safeCanonical(cwd);
  return roots.some((r) => isInside(cwd, r.raw, platform) || isInside(real, r.real, platform));
}

// Walks the listener's ancestry through `lookup`. -> { ok:true } | { ok:false, reason, unknown? }
function descendsFrom(listenerPid, owner, lookup) {
  const seen = new Set();
  let pid = listenerPid;
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    if (!Number.isInteger(pid) || pid <= 1) return { ok: false, reason: 'not descended from the session (the chain ends at init: terminal-started or detached)' };
    if (seen.has(pid)) return { ok: false, reason: 'ancestry loops' };
    seen.add(pid);
    let r;
    try {
      r = lookup(pid, { withBirth: pid === owner.pid });
    } catch (err) {
      return { ok: false, unknown: true, reason: `ancestry lookup failed: ${oneLine(err?.message ?? err)}` };
    }
    if (!r || r.ok !== true) return { ok: false, unknown: true, reason: `ancestry unknown at pid ${pid}: ${r?.reason ?? 'no answer'}` };
    const info = r.value;
    if (pid === owner.pid) return info?.birth === owner.birth ? { ok: true } : { ok: false, reason: `pid ${pid} in the chain is not the session (birth differs)` };
    pid = info?.ppid;
  }
  return { ok: false, unknown: true, reason: `ancestry deeper than ${MAX_HOPS} hops` };
}

// bindDev(record, { owner, run, lookup, others, now, ... }) -> { bound: { listenerPid, listenerBirth, cwd } } | { bound: null, reason }
//   record  a dev event (kind 'dev') plus its tPost, as devRecords returns it
//   owner   {pid, birth} of the session's Claude process (the record's own owner)
//   lookup  (pid, { withBirth }) -> ok({ ppid, birth? }) | unknown   (default: psLookup on `run`)
//   others  the ledger events other than this record: other sessions' dev records / dev-posts and the existing dev-bind events
//   now     () -> epoch ms
export function bindDev(record, {
  owner = record?.owner, run = realRun, lookup, others = [], now = Date.now, lsof = DEFAULT_LSOF, ps = DEFAULT_PS, kill,
  platform = process.platform, deadlineAt,
} = {}) {
  const no = (reason) => ({ bound: null, reason });
  if (platform === 'win32') return no('windows');
  if (!isOwner(owner)) return no('owner has no usable pid and birth');
  if (!record || !Number.isInteger(record.port)) return no('record has no port');
  const nowSec = now() / 1000;
  const win = windowOf(record, { nowSec });
  if (!win) return no('record has no valid launch time');
  const roots = usableRoots(record, platform);
  if (roots.length === 0) return no('record has no usable worktree or cwd');

  // One listener binds once: if this very record is already bound, say so; if the listener belongs to another record, refuse.
  const binds = devBinds(others);
  const existing = binds.find((b) => sameRecord(b, record));
  if (existing) return { bound: { listenerPid: existing.listenerPid, listenerBirth: existing.listenerBirth, cwd: existing.cwd ?? null, already: true } };

  const found = listeners(record.port, { run, lsof, ps, kill, platform, deadlineAt, now });
  if (!found.ok) return no(`listeners unknown: ${found.reason}`);
  if (found.value.length === 0) return no(`nothing listens on port ${record.port} yet`);

  const walk = lookup ?? psLookup({ run, ps, kill, platform, deadlineAt, now });
  const otherRecs = devRecords(others).filter((o) => o.port === record.port && keyOfOwner(o.owner) !== keyOfOwner(owner));
  const reasons = [];
  const qualifying = [];
  for (const l of found.value) {
    const tag = `pid ${l.pid}`;
    const anc = descendsFrom(l.pid, owner, walk);
    if (!anc.ok) {
      reasons.push(`${tag}: ${anc.reason}`);
      continue;
    }
    if (l.birth < win.from || l.birth > win.to) {
      reasons.push(`${tag}: born outside the launch window`);
      continue;
    }
    if (!cwdInsideRoots(l.cwd, roots, platform)) {
      reasons.push(`${tag}: cwd ${oneLine(l.cwd)} is outside the recorded worktree`);
      continue;
    }
    const clash = otherRecs.find((o) => {
      const w = windowOf(o, { nowSec });
      return w !== null && l.birth >= w.from && l.birth <= w.to;
    });
    if (clash) {
      reasons.push(`${tag}: another session's dev record for port ${record.port} also covers its birth`);
      continue;
    }
    const taken = binds.find((b) => b.listenerPid === l.pid && b.listenerBirth === l.birth);
    if (taken) {
      reasons.push(`${tag}: already bound to another record`);
      continue;
    }
    qualifying.push(l);
  }
  if (qualifying.length === 1) {
    const [l] = qualifying;
    return { bound: { listenerPid: l.pid, listenerBirth: l.birth, cwd: l.cwd } };
  }
  if (qualifying.length > 1) return no(`ambiguous: ${qualifying.length} listeners on port ${record.port} qualify`);
  return no(reasons.join('; '));
}

// ---- the PostToolUse hook flow ----

function appendLog(file, line) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.appendFileSync(file, `${line}\n`, { mode: 0o600 });
  } catch {
    /* the log is best effort */
  }
}

// Recent ledger events without reading the whole (possibly months-long) file: the last LEDGER_TAIL_BYTES, tolerant of damaged
// lines (binding is best effort; the strict reader is for decisions to STOP). If the tail does not reach back LEDGER_LOOKBACK_MS
// the answer is unknown (some overlapping record might be hidden), so nothing binds on a partial view.
export function readRecentEvents(file, { nowMs = Date.now(), maxBytes = LEDGER_TAIL_BYTES, lookbackMs = LEDGER_LOOKBACK_MS } = {}) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    let got = 0;
    while (got < buf.length) {
      const n = fs.readSync(fd, buf, got, buf.length - got, start + got);
      if (n === 0) break;
      got += n;
    }
    let text = buf.subarray(0, got).toString('utf8');
    if (start > 0) {
      const nl = text.indexOf('\n');
      text = nl < 0 ? '' : text.slice(nl + 1);
    }
    const events = [];
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      try {
        const e = JSON.parse(line);
        if (e && typeof e === 'object' && !Array.isArray(e)) events.push(e);
      } catch {
        /* a damaged or torn line is skipped here; the strict reader reports damage */
      }
    }
    if (start > 0) {
      const oldest = events.length ? Date.parse(events[0].t) : NaN;
      if (!Number.isFinite(oldest) || oldest > nowMs - lookbackMs) return unknown('ledger tail does not reach back far enough');
    }
    return ok(events);
  } catch (err) {
    return err?.code === 'ENOENT' ? ok([]) : unknown(`ledger unreadable: ${oneLine(err?.message ?? err)}`);
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* read-only descriptor */
      }
    }
  }
}

// runDevBind(input, deps) -> { exit: 0, events, unbound? }  (always exit 0; `events` are the lines appended)
//   deps: env, platform, home, root, files, now, run, lookup, deadlineMs, appendEvent, acquire, release, readRecent, log, bins
export async function runDevBind(input, deps = {}) {
  const events = [];
  const result = { exit: 0, events, unbound: [] };
  const platform = deps.platform ?? process.platform;
  if (platform === 'win32') return result;
  if (input?.tool_name !== 'Bash') return result;
  const sessionId = typeof input?.session_id === 'string' && input.session_id !== '' ? input.session_id : null;
  if (!sessionId) return result;

  const env = deps.env ?? process.env;
  const home = deps.home ?? os.homedir();
  const now = deps.now ?? Date.now;
  const root = deps.root ?? stacksRoot(env, home);
  const files = deps.files ?? stackFiles(root);
  const dirs = lockDirs(root);
  const run = deps.run ?? realRun;
  const append = deps.appendEvent ?? realAppendEvent;
  const acquire = deps.acquire ?? realAcquire;
  const release = deps.release ?? realRelease;
  const readRecent = deps.readRecent ?? ((nowMs) => readRecentEvents(files.ledger, { nowMs }));
  const deadlineAt = now() + (deps.deadlineMs ?? DEV_DEADLINE_MS);
  const logLine = deps.log ?? ((line) => appendLog(files.log, line));
  const log = (msg) => {
    try {
      logLine(`${new Date(now()).toISOString()} dev-bind ${oneLine(msg)}`);
    } catch {
      /* best effort */
    }
  };

  try {
    const bins = deps.bins ?? resolveDevBins({ env, home, root: deps.pipelineRoot });
    const ledger = readRecent(now());
    if (!ledger.ok) {
      log(`skipped: ${ledger.reason}`);
      return result;
    }
    let all = ledger.value;

    // 1. this tool call's dev-post, if it launched a dev server (the record came from the PreToolUse hook)
    const toolUseId = typeof input.tool_use_id === 'string' && input.tool_use_id !== '' ? input.tool_use_id : null;
    if (toolUseId) {
      const launched = all.find((e) => e?.kind === 'dev' && e.session_id === sessionId && e.tool_use_id === toolUseId);
      const posted = all.some((e) => e?.kind === 'dev-post' && e.session_id === sessionId && e.tool_use_id === toolUseId);
      if (launched && !posted) {
        const t = new Date(now()).toISOString();
        const post = { t, kind: 'dev-post', session_id: sessionId, tool_use_id: toolUseId, owner: launched.owner, tPost: t };
        const r = await append(files.ledger, post, { lockDir: dirs.ledger, deadlineAt, now });
        if (r?.ok) {
          events.push(post);
          all = [...all, post];
        } else log(`dev-post failed: ${r?.reason ?? 'no answer'}`);
      }
    }

    // 2. this session's unbound dev records, old enough to be listening and young enough to still be tried
    const lookup = deps.lookup ?? psLookup({ run, ps: bins.ps, platform, deadlineAt, now });
    const due = devRecords(all).filter((r) => {
      if (r.session_id !== sessionId || r.bound) return false;
      const age = now() - Date.parse(r.tPre ?? r.t);
      return Number.isFinite(age) && age >= MIN_AGE_MS && age <= MAX_AGE_MS;
    });
    for (const rec of due) {
      if (deadlineAt - now() < MIN_REMAINING_MS) {
        log('deadline reached; remaining records are tried on the next call');
        break;
      }
      const same = (e) => e === rec || (e?.kind === 'dev' && e.t === rec.t && e.port === rec.port && keyOfOwner(e.owner) === keyOfOwner(rec.owner) && e.session_id === rec.session_id);
      const b = bindDev(rec, {
        owner: rec.owner, run, lookup, others: all.filter((e) => !same(e)), now, lsof: bins.lsof, ps: bins.ps, platform, deadlineAt,
      });
      if (!b.bound) {
        result.unbound.push({ port: rec.port, reason: b.reason });
        continue;
      }
      if (b.bound.already) continue;
      // The dev lock serialises the check-and-append for one port, so two hooks racing on the same listener bind it once.
      let held;
      try {
        held = await acquire(String(rec.port), { dir: dirs.dev, waitMs: Math.max(0, deadlineAt - now()), pollMs: 25 });
      } catch (err) {
        log(`dev lock for port ${rec.port} unavailable: ${err?.message ?? err}`);
        continue;
      }
      try {
        const fresh = readRecent(now());
        if (!fresh.ok) {
          log(`re-read failed: ${fresh.reason}`);
          continue;
        }
        if (devBinds(fresh.value).some((x) => x.port === rec.port && x.listenerPid === b.bound.listenerPid && x.listenerBirth === b.bound.listenerBirth)) continue;
        const bind = {
          t: new Date(now()).toISOString(),
          kind: 'dev-bind',
          session_id: sessionId,
          ...(rec.tool_use_id ? { tool_use_id: rec.tool_use_id } : {}),
          owner: { pid: rec.owner.pid, birth: rec.owner.birth },
          port: rec.port,
          devT: rec.t,
          listenerPid: b.bound.listenerPid,
          listenerBirth: b.bound.listenerBirth,
          cwd: b.bound.cwd,
          worktree: rec.worktree ?? 'none',
          recordCwd: rec.cwd ?? null,
        };
        const r = await append(files.ledger, bind, { lockDir: dirs.ledger, deadlineAt, now });
        if (r?.ok) {
          events.push(bind);
          all = [...all, bind];
        } else log(`dev-bind append failed: ${r?.reason ?? 'no answer'}`);
      } finally {
        try {
          release(held);
        } catch {
          /* a lock whose owner is gone is reclaimed by the next taker */
        }
      }
    }
  } catch (err) {
    log(`failed: ${err?.message ?? err}`);
  }
  return result;
}

// ---- session end: stop only the session's own bound dev servers ----

// devSessionEnd(owner, events, deps) -> Promise<rows>
//   owner    {pid, birth} of the exited Claude process
//   events   the ledger events (readLedger value)
//   deps     run, lsof, ps, kill (called ONLY as kill(pid, 'SIGTERM')), probeKill (signal-0 existence probe, default
//            process.kill), mode ('report' | 'apply': the caller's devServers mode), sleep, root (state root, needed for the
//            lock and the gates), home, now, ownerExitedAt (epoch ms; default: when this call starts), platform,
//            acquire, release, lockWaitMs, termWaitMs, beforeMutate (test seam: runs after the re-check, before the gates)
//   row      { port, pid, birth, cwd, action, reasons, alive, aliveAfterExitMs }
//            action: 'would-stop' | 'stopped' | 'term-ignored' | 'already-gone' | 'kept' | 'failed'
export async function devSessionEnd(owner, events, deps = {}) {
  const platform = deps.platform ?? process.platform;
  if (platform === 'win32') return [];
  const {
    run = realRun, lsof = DEFAULT_LSOF, ps = DEFAULT_PS, kill = defaultKill, probeKill = defaultKill, mode = 'report', sleep = defaultSleep,
    root, home = os.homedir(), now = Date.now, acquire = realAcquire, release = realRelease, lockWaitMs = 10000, termWaitMs = TERM_WAIT_MS,
    beforeMutate, log = () => {},
  } = deps;
  const startedAt = now();
  const exitedAt = Number.isFinite(deps.ownerExitedAt) ? deps.ownerExitedAt : startedAt;
  const probe = { run, ps, kill: probeKill, platform };
  const files = root ? stackFiles(root) : null;

  // One bind per listener, however many records or duplicate lines name it.
  const seen = new Set();
  const binds = [];
  for (const b of devBinds(events)) {
    if (keyOfOwner(b.owner) !== keyOfOwner(owner)) continue;
    const k = `${b.port}:${b.listenerPid}:${b.listenerBirth}`;
    if (seen.has(k)) continue;
    seen.add(k);
    binds.push(b);
  }
  if (binds.length === 0) return [];

  const rows = [];
  const row = (b, action, reasons, extra = {}) => {
    const r = { port: b.port, pid: b.listenerPid, birth: b.listenerBirth, cwd: b.cwd ?? null, action, reasons: [...reasons], alive: null, aliveAfterExitMs: null, ...extra };
    rows.push(r);
    try {
      log({ t: new Date(now()).toISOString(), kind: 'dev', ...r });
    } catch {
      /* the decision log is best effort */
    }
    return r;
  };

  // The caller waits for the owner to be gone; re-checking costs one ps and keeps this function safe on its own.
  const ownerState = realIsAlive(owner, probe);
  if (!ownerState.ok || ownerState.value) {
    const why = ownerState.ok ? 'owner is still running' : `owner liveness unknown: ${ownerState.reason}`;
    for (const b of binds) row(b, 'kept', [why]);
    return rows;
  }

  for (const b of binds) {
    const roots = usableRoots({ worktree: b.worktree, cwd: b.recordCwd }, platform);
    // Identity and cwd of the listener now. A reused pid (different birth) is a stranger: never signalled.
    const check = () => {
      const id = procIdentity(b.listenerPid, { run, ps, kill: probeKill, platform });
      if (!id.ok) return { kept: `listener state unknown: ${id.reason}` };
      if (id.value === null) return { gone: true };
      if (id.value.birth !== b.listenerBirth) return { kept: `pid ${b.listenerPid} now belongs to another process (birth differs): not touched`, reused: true };
      const cwd = cwdOf(b.listenerPid, { run, lsof });
      if (!cwd.ok) return { kept: `listener cwd unknown: ${cwd.reason}` };
      if (cwd.value === null) return { kept: 'listener cwd not readable' };
      if (roots.length === 0) return { kept: 'no usable recorded worktree to check the cwd against' };
      if (!cwdInsideRoots(cwd.value, roots, platform)) return { kept: `listener cwd ${oneLine(cwd.value)} left the recorded worktree`, cwd: cwd.value };
      return { alive: true, cwd: cwd.value };
    };

    const first = check();
    if (first.gone) {
      row(b, 'already-gone', ['listener already exited'], { alive: false, aliveAfterExitMs: 0 });
      continue;
    }
    if (first.kept) {
      row(b, 'kept', [first.kept], { alive: first.reused ? false : null });
      continue;
    }
    const aliveAfterExitMs = Math.max(0, now() - exitedAt);
    if (!root || !files) {
      row(b, 'kept', ['no state root'], { alive: true, aliveAfterExitMs, cwd: first.cwd });
      continue;
    }

    let held;
    try {
      held = await acquire(String(b.port), { dir: lockDirs(root).dev, waitMs: lockWaitMs, pollMs: 25 });
    } catch (err) {
      row(b, 'kept', [`dev lock for port ${b.port} busy: skipped (${oneLine(err?.message ?? err)})`], { alive: true, aliveAfterExitMs, cwd: first.cwd });
      continue;
    }
    let signalled = false;
    try {
      // Under the lock: the same listener, again, then the fresh gates, then the one signal.
      const second = check();
      if (second.gone) {
        row(b, 'already-gone', ['listener exited while waiting for the lock'], { alive: false, aliveAfterExitMs });
        continue;
      }
      if (second.kept) {
        row(b, 'kept', [second.kept], { alive: second.reused ? false : null, aliveAfterExitMs });
        continue;
      }
      await beforeMutate?.();
      const blockers = [];
      if (isPaused(files.pause)) blockers.push('paused');
      if (loadMachineConfig(files.config, { home }).status !== 'ok') blockers.push('not configured');
      const fileMode = loadModes(files.mode).devServers;
      if (blockers.length) {
        row(b, 'kept', blockers, { alive: true, aliveAfterExitMs, cwd: second.cwd });
        continue;
      }
      if (mode !== 'apply') {
        row(b, 'would-stop', ['mode report'], { alive: true, aliveAfterExitMs, cwd: second.cwd });
        continue;
      }
      if (fileMode !== 'apply') {
        row(b, 'kept', ['mode report'], { alive: true, aliveAfterExitMs, cwd: second.cwd });
        continue;
      }
      try {
        kill(b.listenerPid, 'SIGTERM'); // the one and only signal, sent once and never followed by SIGKILL
        signalled = true;
      } catch (err) {
        if (err?.code === 'ESRCH') row(b, 'already-gone', ['listener exited before the signal'], { alive: false, aliveAfterExitMs });
        else row(b, 'failed', [`SIGTERM failed: ${err?.code ?? oneLine(err?.message ?? err)}`], { alive: true, aliveAfterExitMs, cwd: second.cwd });
        continue;
      }
    } finally {
      try {
        release(held);
      } catch {
        /* a failed release must not hide the decision; a dead owner's lock is reclaimed */
      }
    }
    if (!signalled) continue;

    await sleep(termWaitMs);
    const after = procIdentity(b.listenerPid, { run, ps, kill: probeKill, platform });
    if (!after.ok) row(b, 'failed', ['SIGTERM sent; state afterwards unknown'], { alive: null, aliveAfterExitMs, cwd: b.cwd ?? null, sigterm: true });
    else if (after.value === null || after.value.birth !== b.listenerBirth) row(b, 'stopped', ['SIGTERM sent; exited'], { alive: false, aliveAfterExitMs, cwd: b.cwd ?? null, sigterm: true });
    else row(b, 'term-ignored', [`still alive ${Math.round(termWaitMs / 1000)} s after SIGTERM; left running (never SIGKILL)`], { alive: true, aliveAfterExitMs, cwd: b.cwd ?? null, sigterm: true });
  }
  return rows;
}

// ---- listing (report only) ----

const worktreeOfCwd = (cwd) => {
  const posix = String(cwd ?? '').replace(/\\/g, '/');
  const m = /^(.*?\/\.worktrees\/[^/]+)(?:\/|$)/.exec(posix);
  return m ? m[1] : null;
};

// devRows({ ports, events, run, isAlive, prStates, ... }) -> [{ port, pid, cwd, worktree, uptimeS, boundOwnerAlive, pr, verdict, reasons }]
//   isAlive(owner) -> ok(bool) | unknown (default: identity.mjs isAlive on `run`)
//   prStates(worktrees: [{ path, exists }]) -> ok(Map<path, { state, headMatches, eligible }>) | unknown (optional)
//   verdict 'owned' (bound to a live session) | 'orphan candidate' (bound, its session is gone) | 'unknown' (not bound to any
//   session, or a probe failed). Never signals anything.
export function devRows({
  ports = [], events = [], run = realRun, lsof = DEFAULT_LSOF, ps = DEFAULT_PS, kill, platform = process.platform, deadlineAt, now = Date.now,
  isAlive = (o) => realIsAlive(o, { run, ps, ...(kill ? { kill } : {}), platform, deadlineAt, now }), prStates,
} = {}) {
  if (platform === 'win32') return [];
  const binds = devBinds(events);
  const rows = [];
  for (const port of ports) {
    const found = listeners(port, { run, lsof, ps, kill, platform, deadlineAt, now });
    if (!found.ok) {
      rows.push({ port, pid: null, cwd: null, worktree: null, uptimeS: null, boundOwnerAlive: null, pr: null, verdict: 'unknown', reasons: [found.reason] });
      continue;
    }
    for (const l of found.value) {
      const bind = binds.find((b) => b.port === port && b.listenerPid === l.pid && b.listenerBirth === l.birth) ?? null;
      let boundOwnerAlive = null;
      const reasons = [];
      if (bind) {
        let a;
        try {
          a = isAlive(bind.owner);
        } catch (err) {
          a = unknown(err?.message ?? err);
        }
        if (a?.ok) boundOwnerAlive = a.value === true;
        else reasons.push(`owner liveness unknown: ${a?.reason ?? 'no answer'}`);
      } else reasons.push('not bound to any session (terminal-started, detached or foreign)');
      const worktree = (bind && typeof bind.worktree === 'string' && bind.worktree !== 'none' ? bind.worktree : null) ?? worktreeOfCwd(l.cwd);
      let pr = null;
      if (worktree && typeof prStates === 'function') {
        try {
          const s = prStates([{ path: worktree, exists: fs.existsSync(worktree) }]);
          if (s?.ok) pr = s.value.get(worktree) ?? null;
          else reasons.push(`worktree PR state unknown: ${s?.reason ?? 'no answer'}`);
        } catch (err) {
          reasons.push(`worktree PR state unknown: ${oneLine(err?.message ?? err)}`);
        }
      }
      const verdict = boundOwnerAlive === true ? 'owned' : boundOwnerAlive === false ? 'orphan candidate' : 'unknown';
      rows.push({ port, pid: l.pid, cwd: l.cwd, worktree, uptimeS: Math.max(0, Math.round(now() / 1000 - l.birth)), boundOwnerAlive, pr, verdict, reasons });
    }
  }
  return rows;
}
