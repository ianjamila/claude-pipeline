// Shared assessment helpers of stack-stop: what is true of ONE stack right now, gathered the same way by the session-end worker
// and (Task 12b) the daily sweep. Two jobs:
//   1. buildCurrent -> the `current` object act.mjs/decide.mjs checkBinding compares against what was assessed
//      ({ workdirExists, workdirReal, labelWorkdirReal, configProject, labelProject, generation, shared, dbVolume }), built from a
//      FRESH inventory plus the workdir's supabase/config.toml and a realpath, never from the earlier assessment;
//   2. gatherEvidence -> the evidence object a verdict takes (decide.mjs sessionEndVerdict / sweepVerdict), with `probes` naming
//      which probes to run, so each caller asks for exactly its verdict's inputs. Every probe answers ok | unknown (fail closed):
//      a probe that is not requested is simply absent from the object (a verdict reads an absent required input as unknown).
//
// The ledger is always read under the ledger lock (name `ledger`), so a line another process is writing right now is never
// mistaken for damage; a damaged ledger makes every lease probe unknown, and with it every verdict `kept` (R2-14).
// Lock order: callers may hold a project lock (reassess runs inside one); the ledger lock is only ever taken after it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquire as realAcquire, release as realRelease } from '../locks.mjs';
import { listWorktrees as realListWorktrees } from '../local-branches.mjs';
import { isInside, samePath } from '../paths.mjs';
import { run as realRun } from '../proc.mjs';
import { pathSpellings } from '../worktree-prune/inspect.mjs';
import { liveSessionsIn, scanLiveSessions as realScanLiveSessions } from '../worktree-prune/live-sessions.mjs';
import { isShared, isPaused, loadKeep, loadMachineConfig } from './config.mjs';
import { checkBinding } from './decide.mjs';
import * as realEvidence from './evidence.mjs';
import { isAlive as realIsAlive } from './identity.mjs';
import { readInventory as realReadInventory } from './inventory.mjs';
import { leasesFor, liveOwners, readLedger } from './ledger.mjs';
import { readProjectId } from './match.mjs';
import { lockDirs, stackFiles } from './paths.mjs';
import { ok, unknown } from './result.mjs';

export const SESSION_END_PROBES = Object.freeze(['paused', 'keep', 'otherLiveLeases', 'connections', 'processRefs', 'cwdProcs', 'openSessions', 'binding']);
export const SWEEP_PROBES = Object.freeze(['paused', 'keep', 'liveLeases', 'consumers', 'prStates', 'cwdProcs', 'openSessions', 'connections', 'processRefs', 'uptimeMs', 'memory', 'transcripts', 'binding']);
export const DEFAULT_DEADLINE_MS = 120_000;
export const TRANSCRIPT_WINDOW_MS = 24 * 3_600_000;

const lower = (s) => String(s ?? '').toLowerCase();
const ownerKey = (o) => `${o?.pid}:${o?.birth}`;
const shortMsg = (err) => String(err?.message ?? err).split('\n')[0].slice(0, 200);

// ---- the ledger, read under its lock ----

// ok(events) | unknown. The lock wait is bounded (waitMs) so a stuck writer cannot hang a worker.
export async function readLedgerLocked({ files, root, acquire = realAcquire, release = realRelease, waitMs = 10_000, pollMs = 20, read = readLedger } = {}) {
  let lock;
  try {
    lock = await acquire('ledger', { dir: lockDirs(root).ledger, waitMs, pollMs });
  } catch (err) {
    return unknown(`ledger lock unavailable: ${shortMsg(err)}`);
  }
  try {
    return read(files.ledger);
  } finally {
    try {
      release(lock);
    } catch {
      /* a lock whose owner is gone is reclaimed by the next taker */
    }
  }
}

// ---- the binding, read now ----

export const findStack = (inventory, project) => (inventory?.stacks ?? []).find((s) => lower(s.project) === lower(project)) ?? null;

// `assessed` = the Stack the verdict was made on; `fresh` = the same project's Stack from an inventory read just now (null when
// its containers are gone). realpath/readFile are injectable. Nothing here throws.
export function buildCurrent(assessed, fresh, { cfg, realpath = fs.realpathSync, readFile = (p) => fs.readFileSync(p, 'utf8') } = {}) {
  let workdirReal = null;
  let workdirExists = false;
  if (typeof assessed?.workdir === 'string' && assessed.workdir !== '') {
    try {
      workdirReal = realpath(assessed.workdir);
      workdirExists = true;
    } catch {
      workdirReal = null;
    }
  }
  let configProject = null;
  if (workdirReal !== null) {
    try {
      configProject = readProjectId(readFile(path.join(workdirReal, 'supabase', 'config.toml')));
    } catch {
      configProject = null;
    }
  }
  // Shared if the inventory says so, the labelled project is shared, or the config.toml in the workdir NOW names a shared project
  // (a symlinked workdir re-pointed at e2e-ci / DRMed / eaglewatch-pipeline). No fresh stack means sharing is unknown => true.
  const shared = fresh
    ? fresh.shared === true || isShared({ project: fresh.project, workdir: fresh.workdir }, cfg) || (configProject !== null && isShared({ project: configProject, workdir: workdirReal }, cfg))
    : true;
  return {
    workdirExists,
    workdirReal,
    labelWorkdirReal: fresh?.workdirExists === true && typeof fresh.workdir === 'string' ? fresh.workdir : null,
    configProject,
    labelProject: fresh?.project ?? null,
    generation: fresh?.generation ?? null,
    shared,
    dbVolume: fresh?.dbVolume ?? null,
  };
}

// ok({ fresh: Stack | null, dockerDown }) | unknown, from a fresh (uncached) inventory.
export function freshStack(project, { run = realRun, cfg, docker = 'docker', deadlineAt, now = Date.now, readInventory = realReadInventory } = {}) {
  const inv = readInventory({ run, cfg, docker, deadlineAt, now });
  if (!inv?.ok) return unknown(`inventory unavailable: ${inv?.reason ?? 'no answer'}`);
  return ok({ fresh: findStack(inv.value, project), dockerDown: inv.value.dockerDown === true });
}

// ---- the feature's own processes ----

// The pids of this feature's detached session-end workers, from <root>/workers/*.json (only the `pid` field is read). A worker's
// own command line / environment names the project it works on, so it must never count as a consumer of that stack (C2/C3/cwd) nor
// as an observed use. A file that records `birth` only counts while that exact process is alive (a reused pid is somebody else's
// and stays visible); a file without `birth` (the hook wrote it first) counts by pid alone. Unreadable or malformed files are a note
// (optional `notes` array), never a failure; no workers folder => empty set. `isAlive({pid, birth})` answers ok(bool) | unknown.
export function ownPids(root, { readDir = (d) => fs.readdirSync(d), readFile = (p) => fs.readFileSync(p, 'utf8'), isAlive = realIsAlive, notes = [] } = {}) {
  const pids = new Set();
  const dir = stackFiles(root).workers;
  let names;
  try {
    names = readDir(dir);
  } catch (err) {
    if (err?.code !== 'ENOENT') notes.push(`workers folder unreadable: ${shortMsg(err)}`);
    return pids;
  }
  for (const name of names) {
    if (!/\.json$/.test(name)) continue;
    let rec;
    try {
      rec = JSON.parse(readFile(path.join(dir, name)));
    } catch (err) {
      notes.push(`worker file ${name} unreadable: ${shortMsg(err)}`);
      continue;
    }
    if (!Number.isInteger(rec?.pid) || rec.pid <= 0) {
      notes.push(`worker file ${name} has no usable pid`);
      continue;
    }
    // Fail closed: a pid is excluded only when its recorded birth still matches. A file with no birth (the worker died before
    // recording it) may by now name an unrelated process that reused the pid, so it stays visible; the current process is
    // excluded separately by pid.
    if (!Number.isFinite(rec.birth)) continue;
    let alive;
    try {
      alive = isAlive({ pid: rec.pid, birth: rec.birth });
    } catch {
      alive = null;
    }
    if (alive?.ok !== true || alive.value !== true) continue; // gone, reused, or unknown: not provably ours, so it stays visible
    pids.add(rec.pid);
  }
  return pids;
}

// ---- evidence ----

// The directories a "live process with cwd inside" check covers: the stack folder plus every consumer worktree that exists.
// A consumer that is `/`, a home directory or has fewer than 3 path segments is dropped (every process is inside it); `notes`
// (optional array) collects what was dropped.
export function cwdDirs(stack, consumers, { home = os.homedir(), platform = process.platform, notes = [] } = {}) {
  const dirs = [];
  if (typeof stack?.workdir === 'string' && stack.workdir !== '') dirs.push(stack.workdir);
  for (const w of consumers ?? []) {
    if (w?.exists === false || typeof w?.path !== 'string' || dirs.includes(w.path)) continue;
    const broad = realEvidence.tooBroadDir(w.path, { home, platform });
    if (broad) {
      notes.push(`consumer directory ${JSON.stringify(w.path)} left out of the cwd check: too broad (${broad})`);
      continue;
    }
    dirs.push(w.path);
  }
  return dirs;
}

// "Is a Claude Code session OPEN in this stack's folder or a consumer worktree?", however long it has sat idle (the blind spot
// cwdProcs has: a session's own process keeps its START folder, only its short-lived Bash shell enters a worktree, and the sweep's
// 24 h transcript window misses a session parked longer). Claude Code lists its open sessions in <config>/sessions/<pid>.json;
// worktree-prune/live-sessions.mjs places each by its transcript's last cwd. Scanned ONCE per call (never cached: the session-end
// worker gathers twice, the second time under the lock, and a session may have opened between).
//   * No owner / pid / session-id exclusion: session-end assesses only after the owner {pid, birth} has exited, and the scanner
//     drops a record whose pid is dead or whose start time no longer matches ps, so the ended owner is already gone; excluding by
//     pid would hide a NEW session that reused it.
//   * Fail closed: a record or transcript that cannot be read, ps failing, or the deadline hitting mid-scan is unknown. Only "this
//     machine has no sessions folder" is an extra signal that is absent (ok([]) with a note), as for worktree prune.
//   * The stack folder only: a session inside a NESTED git worktree under it that is not itself a consumer of the stack works in
//     its own worktree, not in this stack's folder, so it does not count (a session at the folder or in a plain subfolder does;
//     if the worktree list cannot be read, every session inside the folder counts, with a note).
// -> ok([{ id, pid, dir }]) | unknown. `opts`: home, env, platform, deadlineAt, now, scan (scanLiveSessions), starts (its ps seam),
// listWorktrees (root -> [{ path, bare }]).
export function openSessions(stack, consumers, opts = {}) {
  const { home = os.homedir(), env = process.env, platform = process.platform, deadlineAt, now = Date.now, scan = realScanLiveSessions, starts, listWorktrees = realListWorktrees } = opts;
  const notes = [];
  const dirs = cwdDirs(stack, consumers, { home, platform, notes });
  if (dirs.length === 0) return { ok: true, value: [], notes };
  const scanned = scan({ home, env, platform, ...(starts ? { starts } : {}), ...(deadlineAt !== undefined ? { deadlineAt, now } : {}) });
  if (!scanned?.available) {
    notes.push(`open-session records unavailable (${scanned?.reason ?? 'no answer'})`);
    return { ok: true, value: [], notes };
  }
  if (scanned.unplaced?.length) {
    const more = scanned.unplaced.length > 3 ? ` (+${scanned.unplaced.length - 3} more)` : '';
    return unknown(`open Claude sessions could not all be placed: ${scanned.unplaced.slice(0, 3).join('; ')}${more}`);
  }
  const inDir = (session, spellings) => liveSessionsIn({ available: true, sessions: [session], unplaced: [] }, spellings, { platform }).hits.length > 0;
  const workdir = typeof stack?.workdir === 'string' && stack.workdir !== '' ? stack.workdir : null;
  const hits = [];
  for (const dir of dirs) {
    const spellings = pathSpellings(dir);
    let sessions = scanned.sessions;
    if (dir === workdir) {
      const inside = sessions.filter((x) => inDir(x, spellings));
      const atRoot = (x) => spellings.some((sp) => samePath(x.cwd, sp, platform));
      sessions = inside;
      if (inside.some((x) => !atRoot(x))) {
        let nested;
        try {
          nested = listWorktrees(dir)
            .filter((w) => w?.path && !w.bare && spellings.some((sp) => isInside(w.path, sp, platform) && !samePath(w.path, sp, platform)))
            .filter((w) => !(consumers ?? []).some((cw) => typeof cw?.path === 'string' && pathSpellings(cw.path).some((sp) => samePath(sp, w.path, platform))));
        } catch (err) {
          nested = [];
          notes.push(`worktrees of ${dir} could not be listed (${shortMsg(err)}): every open session inside it counts`);
        }
        const own = nested.map((w) => pathSpellings(w.path));
        sessions = inside.filter((x) => !own.some((sp) => inDir(x, sp)));
      }
    }
    for (const h of liveSessionsIn({ available: true, sessions, unplaced: [] }, spellings, { platform }).hits) {
      if (!hits.some((x) => x.id === h.id && x.pid === h.pid)) hits.push({ id: h.id, pid: h.pid, dir });
    }
  }
  return notes.length ? { ok: true, value: hits, notes } : ok(hits);
}

// gatherEvidence(stack, ctx, { probes, excludeOwner, deadlineMs }) -> Promise<{ evidence, current, fresh }>
//   stack         the Stack as assessed (inventory.mjs shape)
//   probes        which of SESSION_END_PROBES / SWEEP_PROBES to run (any subset; 'binding' is the only one needing a fresh inventory)
//   excludeOwner  {pid, birth} whose leases do not count as "other" (the exiting session); also never charged as live
//   ctx           { root, files?, cfg, run, docker, bins: { lsof, ps }, platform, now, kill, home, isAlive, acquire, release,
//                   readInventory, readEvents (async () => ok(events)), evidence (override probe functions), excludePids
//                   (default this process; the registered workers from ownPids() are always added; ownPids: a Set overriding that lookup),
//                   ghFor, listWorktrees, git, fsx, env (config dirs of the open-session scan; default process.env),
//                   scanLiveSessions / liveSessionStarts (test seams of that scan and its ps call) }
//   evidence      { stack, paused?, keep?, otherLiveLeases?, liveLeases?, consumers?, prStates?, cwdProcs?, openSessions?, connections?, processRefs?,
//                   uptimeMs?, memory?, transcripts?, binding? }: `stack` is the FRESH stack when one was read, else the assessed one
//   current       buildCurrent(...) when 'binding' was requested (else null); fresh the fresh Stack (or null)
export async function gatherEvidence(stack, ctx = {}, { probes = SESSION_END_PROBES, excludeOwner = null, deadlineMs = DEFAULT_DEADLINE_MS } = {}) {
  const want = new Set(probes);
  const now = ctx.now ?? Date.now;
  const platform = ctx.platform ?? process.platform;
  const home = ctx.home ?? os.homedir();
  const run = ctx.run ?? realRun;
  const root = ctx.root;
  const files = ctx.files ?? stackFiles(root);
  const cfg = ctx.cfg ?? loadMachineConfig(files.config, { home });
  const bins = ctx.bins ?? { lsof: undefined, ps: undefined };
  const ev = { openSessions, ...realEvidence, ...(ctx.evidence ?? {}) };
  const deadlineAt = now() + deadlineMs;
  const isAliveFn = ctx.isAlive ?? ((o) => realIsAlive(o, { run, ps: bins.ps, kill: ctx.kill, platform, deadlineAt, now }));
  // the probes skip this process, its probe children, and every registered worker of the feature (never a consumer of a stack)
  const excludePids = new Set([...(ctx.excludePids ?? [process.pid]), ...(ctx.ownPids ?? ownPids(root, { isAlive: isAliveFn }))]);
  const probeOpts = { run, ...(bins.lsof ? { lsof: bins.lsof } : {}), ...(bins.ps ? { ps: bins.ps } : {}), ...(ctx.kill ? { kill: ctx.kill } : {}), platform, deadlineAt, now };

  const evidence = {};
  let current = null;
  let fresh = null;
  let probeStack = stack;

  // The fresh stack first: ports and the running state used by the other probes are the ones read now.
  if (want.has('binding')) {
    const f = (ctx.freshStack ?? freshStack)(stack.project, { run, cfg, docker: ctx.docker ?? 'docker', deadlineAt, now, ...(ctx.readInventory ? { readInventory: ctx.readInventory } : {}) });
    if (f.ok) {
      fresh = f.value.fresh;
      current = buildCurrent(stack, fresh, { cfg, ...(ctx.realpath ? { realpath: ctx.realpath } : {}), ...(ctx.readFile ? { readFile: ctx.readFile } : {}) });
      evidence.binding = checkBinding(stack, current);
      if (fresh) probeStack = fresh;
    } else {
      evidence.binding = { ok: false, reasons: [`binding not proved: ${f.reason}`] };
    }
  }
  evidence.stack = probeStack;

  // ledger events, at most once per call
  let events;
  const getEvents = async () => {
    events ??= await (ctx.readEvents ?? (() => readLedgerLocked({ files, root, acquire: ctx.acquire, release: ctx.release })))();
    return events;
  };
  const leaseProbe = async (excluding) => {
    const evs = await getEvents();
    if (!evs.ok) return evs;
    let list;
    try {
      list = leasesFor(evs.value, probeStack);
      if (excluding) list = list.filter((e) => ownerKey(e?.owner) !== ownerKey(excluding));
    } catch (err) {
      return unknown(`lease lookup failed: ${shortMsg(err)}`);
    }
    return liveOwners(list, { isAlive: isAliveFn });
  };

  if (want.has('paused')) evidence.paused = isPaused(files.pause);
  if (want.has('keep')) evidence.keep = loadKeep(files.keep);
  if (want.has('otherLiveLeases')) evidence.otherLiveLeases = await leaseProbe(excludeOwner);
  if (want.has('liveLeases')) evidence.liveLeases = await leaseProbe(null);

  // consumer worktrees: needed by cwdProcs and prStates, so computed once
  let consumers;
  const getConsumers = async () => {
    if (consumers !== undefined) return consumers;
    const evs = await getEvents();
    if (!evs.ok) return (consumers = unknown(`consumers need the ledger: ${evs.reason}`));
    try {
      consumers = ev.consumerWorktrees(probeStack, {
        events: evs.value,
        transcripts: cfg.status === 'ok' && cfg.transcriptDirs.length ? { dirs: cfg.transcriptDirs, sinceMs: now() - TRANSCRIPT_WINDOW_MS } : null,
        repos: cfg.repos ?? [],
        platform,
        home,
        ...(ctx.listWorktrees ? { listWorktrees: ctx.listWorktrees } : {}),
        ...(ctx.fsx ? { fsx: ctx.fsx } : {}),
      });
    } catch (err) {
      consumers = unknown(`consumer worktrees failed: ${shortMsg(err)}`);
    }
    return consumers;
  };
  if (want.has('consumers')) evidence.consumers = await getConsumers();
  if (want.has('prStates')) {
    const c = await getConsumers();
    if (!c.ok) evidence.prStates = unknown(`prStates need the consumer worktrees: ${c.reason}`);
    else {
      try {
        evidence.prStates = ev.prStates(c.value, { platform, ...(ctx.ghFor ? { ghFor: ctx.ghFor } : {}), ...(ctx.git ? { git: ctx.git } : {}) });
      } catch (err) {
        evidence.prStates = unknown(`pr states failed: ${shortMsg(err)}`);
      }
    }
  }
  if (want.has('cwdProcs')) {
    const c = await getConsumers();
    if (!c.ok) evidence.cwdProcs = unknown(`cwdProcs need the consumer worktrees: ${c.reason}`);
    else {
      try {
        const notes = [];
        const found = ev.cwdInside(cwdDirs(probeStack, c.value, { home, platform, notes }), { ...probeOpts, excludePids });
        evidence.cwdProcs = found.ok && notes.length ? { ...found, notes: [...(found.notes ?? []), ...notes] } : found;
      } catch (err) {
        evidence.cwdProcs = unknown(`cwd probe failed: ${shortMsg(err)}`);
      }
    }
  }
  if (want.has('openSessions')) {
    const c = await getConsumers();
    if (!c.ok) evidence.openSessions = unknown(`openSessions need the consumer worktrees: ${c.reason}`);
    else {
      try {
        evidence.openSessions = ev.openSessions(probeStack, c.value, {
          home, env: ctx.env ?? process.env, platform, deadlineAt, now,
          ...(ctx.scanLiveSessions ? { scan: ctx.scanLiveSessions } : {}), ...(ctx.liveSessionStarts ? { starts: ctx.liveSessionStarts } : {}),
          ...(ctx.listWorktrees ? { listWorktrees: ctx.listWorktrees } : {}),
        });
      } catch (err) {
        evidence.openSessions = unknown(`open-session probe failed: ${shortMsg(err)}`);
      }
    }
  }
  const guarded = (fn) => {
    try {
      return fn();
    } catch (err) {
      return unknown(`probe failed: ${shortMsg(err)}`);
    }
  };
  if (want.has('connections')) evidence.connections = guarded(() => ev.connections(probeStack, { ...probeOpts, excludePids }));
  if (want.has('processRefs')) evidence.processRefs = guarded(() => ev.processRefs(probeStack, { ...probeOpts, excludePids }));
  if (want.has('uptimeMs')) {
    const started = Date.parse(probeStack?.generation?.startedAt);
    // sweepVerdict reads uptimeMs as a bare number; a start time that cannot be read leaves it undefined (=> listed)
    evidence.uptimeMs = Number.isFinite(started) ? Math.max(0, now() - started) : undefined;
  }
  if (want.has('memory')) evidence.memory = guarded(() => ev.memoryRefs(probeStack, { dirs: cfg.memoryDirs ?? [], exclude: cfg.memoryExclude ?? [], platform }));
  if (want.has('transcripts')) {
    evidence.transcripts = guarded(() => ev.transcriptRefs(probeStack, { dirs: cfg.transcriptDirs ?? [], sinceMs: now() - TRANSCRIPT_WINDOW_MS, platform }));
  }
  return { evidence, current, fresh };
}

// A compact, line-sized summary of an evidence object for the decisions log (the full probe results can be large).
export function summarizeEvidence(evidence = {}, verdict = null) {
  const count = (r) => {
    if (!r) return null;
    if (!r.ok) return `unknown: ${String(r.reason).slice(0, 120)}`;
    const v = r.value;
    return Array.isArray(v) ? v.length : v instanceof Map || v instanceof Set ? v.size : v;
  };
  const out = {};
  for (const k of ['keep', 'otherLiveLeases', 'liveLeases', 'connections', 'processRefs', 'cwdProcs', 'openSessions', 'consumers', 'prStates', 'memory', 'transcripts']) {
    if (evidence[k] !== undefined) out[k] = k === 'keep' ? (evidence.keep?.ok ? [...evidence.keep.value].includes(lower(evidence.stack?.project)) : count(evidence.keep)) : count(evidence[k]);
  }
  if (evidence.paused !== undefined) out.paused = evidence.paused;
  if (evidence.binding) out.binding = evidence.binding.ok ? 'ok' : evidence.binding.reasons?.slice(0, 3);
  if (verdict?.notes?.length) out.notes = verdict.notes.slice(0, 5);
  return out;
}
