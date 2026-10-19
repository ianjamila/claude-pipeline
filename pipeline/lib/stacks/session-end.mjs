// Session end for stack-stop: the SessionEnd hook that spawns a detached worker, and the worker itself. Spec section 3; plan
// Task 11 with Revisions 2 and 3.
//
// HOOK (sessionEndHook). `reason: "clear"` or Windows => nothing. Otherwise it finds the Claude process above the hook (its
// {pid, birth} is the owner), spawns `node <pipeline>/bin/pipeline.mjs stacks session-end --owner <pid>:<birth>` detached, with
// stdio on the log and unref()'d, writes workers/<childPid>.json, and returns. SessionEnd cannot block, so the hook always exits
// 0 and finishes in well under 2 s (the owner lookup has its own 1.5 s budget); every failure is only a log line.
//
// WORKER (runSessionEnd). Waits up to 10 min (polling every 2 s) for the owner to be gone, then, in this order:
//   0. gates: config not ok => record `not configured` and do nothing (R2-6); ledger damaged or unreadable => record
//      `ledger damaged` and do nothing, no stack and no dev server is touched (R2-14);
//   1. devSessionEnd: the session's own bound dev servers;
//   2. for each private stack the owner leased: evidence -> sessionEndVerdict; `kept` is recorded; `stop` goes to stopStack, which
//      re-checks everything under the project lock (a fresh inventory, the verdict again, the binding, pause/config/mode) and
//      records the decision before the lock is released, so a session that gets the lock next already sees `stopped`;
//   3. re-probes C1-C3 for every would-stop / stopped project at +30 and +120 min after the decision and records what it sees as
//      `use-observed` records (R2-9: a use is { t, project, pid, birth, command?, check }; a process born before the decision is a
//      MISS). Then the worker file is removed.
//
// WORKER FILE (R3-4). workers/<pid>.json = { pid, birth?, owner, startedAt, phase: waiting | decided | observing, decidedAt, decisions }.
// `birth` is the worker's own process birth, added by the worker once it runs (the hook cannot afford the lookup): with it, ownPids()
// recognises the worker only while that exact process lives. The workers listed here are never consumers of a stack nor observed uses.
// `decidedAt` is set once and never cleared, `decisions` counts the decision records appended; both are written only AFTER those
// records are on disk, so a poller that reads the file late (the worker may already be `observing`) still finds the decision.
// Every update is an atomic rename.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn as realSpawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { acquire as realAcquire, release as realRelease } from '../locks.mjs';
import { run as realRun } from '../proc.mjs';
import { isShared, loadMachineConfig, loadModes } from './config.mjs';
import { sessionEndVerdict } from './decide.mjs';
import { findClaudeOwner, isAlive as realIsAlive, procIdentity as realProcIdentity } from './identity.mjs';
import { readInventory as realReadInventory, resolveDocker } from './inventory.mjs';
import { leasesFor } from './ledger.mjs';
import { isolation, projectAllowed, stackFiles, stacksRoot, stacksSeam } from './paths.mjs';
import { resolveSupabase, stopStack as realStopStack } from './act.mjs';
import { SESSION_END_PROBES, gatherEvidence, ownPids, readLedgerLocked, summarizeEvidence } from './assess.mjs';
import { appendDecision as realAppendDecision, memoryOfProject as realMemoryOfProject } from './outcomes.mjs';
import * as realEvidence from './evidence.mjs';
import { devSessionEnd as realDevSessionEnd } from './dev.mjs';

export const HOOK_BUDGET_MS = 1500;
export const WAIT_MS = 10 * 60_000;
export const POLL_MS = 2000;
export const OBSERVE_AT_MS = Object.freeze([30 * 60_000, 120 * 60_000]);
const OBSERVE_GRACE_MS = 5 * 60_000;
const DECISION_BUDGET_MS = 120_000;

const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
const iso = (ms) => new Date(ms).toISOString();
const ownerKey = (o) => `${o?.pid}:${o?.birth}`;
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function appendLog(file, line) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.appendFileSync(file, `${line}\n`, { mode: 0o600 });
  } catch {
    /* the log is best effort */
  }
}

// ---- worker file ----

export const workerFilePath = (files, pid) => path.join(files.workers, `${pid}.json`);

export function readWorkerFile(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return j && typeof j === 'object' && !Array.isArray(j) ? { ok: true, value: j } : { ok: false, reason: 'worker file is not an object' };
  } catch (err) {
    return { ok: false, reason: `worker file unreadable: ${err?.code ?? err?.message}` };
  }
}

function writeAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(obj)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// Creates the file only if absent (the hook and the worker both may; whoever is first wins and nobody overwrites a later phase).
export function createWorkerFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(content)}\n`, { mode: 0o600 });
  try {
    fs.linkSync(tmp, file);
    return true;
  } catch (err) {
    if (err?.code === 'EEXIST') return false;
    throw err;
  } finally {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* temp file only */
    }
  }
}

function workerFile({ file, pid, owner, now, log }) {
  const initial = { pid, owner: { pid: owner.pid, birth: owner.birth }, startedAt: iso(now()), phase: 'waiting', decidedAt: null, decisions: 0 };
  const guard = (fn) => {
    try {
      return fn();
    } catch (err) {
      log(`worker file: ${oneLine(err?.message ?? err)}`);
      return undefined;
    }
  };
  guard(() => createWorkerFile(file, initial));
  return {
    // Merges a patch into the current file. decidedAt is write-once: it is taken from the file when already set.
    update(patch) {
      guard(() => {
        const cur = readWorkerFile(file);
        const base = cur.ok ? cur.value : initial;
        const next = { ...base, ...patch };
        if (base.decidedAt) next.decidedAt = base.decidedAt;
        writeAtomic(file, next);
      });
    },
    remove() {
      guard(() => fs.rmSync(file, { force: true }));
    },
  };
}

// ---- the hook ----

const pipelineBin = () => path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'pipeline.mjs');

// sessionEndHook(input, deps) -> { exit: 0, spawned, pid?, owner?, why? }. Never throws, never blocks.
export async function sessionEndHook(input, deps = {}) {
  const platform = deps.platform ?? process.platform;
  const out = { exit: 0, spawned: false };
  if (platform === 'win32') return { ...out, why: 'windows' };
  const env = deps.env ?? process.env;
  const home = deps.home ?? os.homedir();
  const now = deps.now ?? Date.now;
  const root = deps.root ?? stacksRoot(env, home);
  const files = deps.files ?? stackFiles(root);
  const logLine = deps.log ?? ((line) => appendLog(files.log, line));
  const log = (msg) => {
    try {
      logLine(`${iso(now())} session-end hook ${oneLine(msg)}`);
    } catch {
      /* best effort */
    }
  };
  let fd;
  try {
    if (input?.reason === 'clear') return { ...out, why: 'clear' };
    const run = deps.run ?? realRun;
    const seamPs = stacksSeam('PIPELINE_PS', env, { home, ...(deps.pipelineRoot ? { root: deps.pipelineRoot } : {}) });
    const ps = seamPs !== undefined && String(seamPs).trim() !== '' ? String(seamPs).trim() : undefined;
    const deadlineAt = now() + (deps.budgetMs ?? HOOK_BUDGET_MS);
    const owner = (deps.findOwner ?? findClaudeOwner)({ run, platform, ps, deadlineAt, now });
    if (!owner?.ok) {
      log(`owner not found (${owner?.reason ?? 'no answer'}): no worker started`);
      return { ...out, why: 'owner unknown' };
    }
    const o = owner.value;
    const args = [deps.pipelineBin ?? pipelineBin(), 'stacks', 'session-end', '--owner', `${o.pid}:${o.birth}`];
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    fd = fs.openSync(files.log, 'a', 0o600);
    const child = (deps.spawn ?? realSpawn)(deps.execPath ?? process.execPath, args, { detached: true, stdio: ['ignore', fd, fd], env, cwd: root, windowsHide: true });
    if (typeof child?.on === 'function') child.on('error', (err) => log(`worker failed to start: ${oneLine(err?.message ?? err)}`));
    child?.unref?.();
    if (!Number.isInteger(child?.pid)) {
      log('worker did not start (no pid)');
      return { ...out, why: 'spawn failed' };
    }
    try {
      createWorkerFile(workerFilePath(files, child.pid), { pid: child.pid, owner: { pid: o.pid, birth: o.birth }, startedAt: iso(now()), phase: 'waiting', decidedAt: null, decisions: 0 });
    } catch (err) {
      log(`worker file not written: ${oneLine(err?.message ?? err)}`);
    }
    return { exit: 0, spawned: true, pid: child.pid, owner: o };
  } catch (err) {
    log(`failed: ${oneLine(err?.message ?? err)}`);
    return { ...out, why: 'error' };
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* the child owns its copy */
      }
    }
  }
}

// ---- outcomes helper (Task 12b reads it) ----

// The `use` objects recorded by workers as `use-observed` records, for outcomeSummary(decisions, uses).
export function observedUses(decisions) {
  return (decisions ?? []).filter((r) => r?.action === 'use-observed' && r.use && typeof r.use === 'object').map((r) => r.use);
}

// ---- the worker ----

export async function runSessionEnd({ owner, deps = {} } = {}) {
  const platform = deps.platform ?? process.platform;
  const result = { status: 'started', waited: 0, dev: [], stacks: [], uses: [], notes: [] };
  if (platform === 'win32') return { ...result, status: 'unsupported', notes: ['not supported on Windows'] };
  const env = deps.env ?? process.env;
  const home = deps.home ?? os.homedir();
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const run = deps.run ?? realRun;
  const root = deps.root ?? stacksRoot(env, home);
  const files = deps.files ?? stackFiles(root);
  const acquire = deps.acquire ?? realAcquire;
  const release = deps.release ?? realRelease;
  const logLine = deps.log ?? ((line) => appendLog(files.log, line));
  const log = (msg) => {
    try {
      logLine(`${iso(now())} session-end ${oneLine(msg)}`);
    } catch {
      /* best effort */
    }
  };
  const note = (msg) => {
    result.notes.push(oneLine(msg));
    log(msg);
  };
  const appendDecision = deps.appendDecision ?? realAppendDecision;
  const stopStack = deps.stopStack ?? realStopStack;
  const ev = { ...realEvidence, ...(deps.evidence ?? {}) };
  const pid = deps.pid ?? process.pid;
  const wf = workerFile({ file: deps.workerFile ?? workerFilePath(files, pid), pid, owner, now, log });

  try {
    return await flow();
  } finally {
    wf.remove();
  }

  async function flow() {
    // ---- 0. gates before anything else ----
    const cfg = deps.cfg ?? loadMachineConfig(files.config, { home });
    if (cfg.status !== 'ok') {
      result.status = 'not configured';
      note(`not configured (${cfg.status}${cfg.error ? `: ${cfg.error}` : ''}): no stack or dev decisions`);
      return result;
    }
    let isoRules;
    try {
      isoRules = deps.iso ?? isolation(env, root, { home });
    } catch (err) {
      result.status = 'isolation refused';
      note(`isolation refused: ${err?.message ?? err}`);
      return result;
    }

    const bins = deps.bins ?? realEvidence.resolveProbeBins({ env, home, ...(deps.pipelineRoot ? { root: deps.pipelineRoot } : {}) });
    const docker = deps.docker ?? resolveDocker({ env, home, platform, ...(deps.pipelineRoot ? { root: deps.pipelineRoot } : {}) });
    const supabaseBin = deps.supabaseBin ?? resolveSupabase({ env, home, platform, ...(deps.pipelineRoot ? { root: deps.pipelineRoot } : {}) });
    // The worker's own birth goes into its file before the long wait (past the not-configured / isolation gates, which probe nothing).
    try {
      const id = (deps.procIdentity ?? ((p) => realProcIdentity(p, { run, platform, ...(bins.ps ? { ps: bins.ps } : {}), ...(deps.probeKill ? { kill: deps.probeKill } : {}), deadlineAt: now() + 3000, now })))(pid);
      if (id?.ok && id.value && Number.isFinite(id.value.birth)) wf.update({ birth: id.value.birth });
    } catch {
      /* without a birth the worker is excluded by pid alone */
    }
    const probeKill = deps.probeKill;
    const isAliveFn = deps.isAlive ?? ((o) => realIsAlive(o, { run, ps: bins.ps, platform, ...(probeKill ? { kill: probeKill } : {}) }));

    // ---- 1. wait for the owner to be gone ----
    const waitStart = now();
    let exited = false;
    let lastUnknown = null;
    for (;;) {
      let a;
      try {
        a = isAliveFn(owner);
      } catch (err) {
        a = { ok: false, reason: oneLine(err?.message ?? err) };
      }
      if (a?.ok && a.value === false) {
        exited = true;
        break;
      }
      lastUnknown = a?.ok ? null : (a?.reason ?? 'no answer');
      if (now() - waitStart >= (deps.waitMs ?? WAIT_MS)) break;
      await sleep(deps.pollMs ?? POLL_MS);
    }
    const ownerExitedAt = now();
    result.waited = ownerExitedAt - waitStart;
    if (!exited) {
      result.status = lastUnknown ? 'owner liveness unknown' : 'session still running';
      note(lastUnknown ? `owner ${ownerKey(owner)} liveness unknown after ${Math.round(result.waited / 1000)} s (${lastUnknown}): decides nothing` : `session still running: owner ${ownerKey(owner)} is alive after ${Math.round(result.waited / 1000)} s; decides nothing`);
      return result;
    }

    // ---- 2. the ledger, under its lock; damage => nothing is stopped on either path ----
    const readEvents = deps.readEvents ?? (() => readLedgerLocked({ files, root, acquire, release }));
    const events = await readEvents();
    if (!events.ok) {
      result.status = /^damaged ledger/.test(events.reason) ? 'ledger damaged' : 'ledger unreadable';
      note(`${/^damaged ledger/.test(events.reason) ? 'ledger damaged' : 'ledger unreadable'} (${events.reason}): no stack and no dev server is stopped; run \`pipeline stacks repair\` once the owner has looked`);
      return result;
    }

    // ---- 3. dev servers first ----
    try {
      result.dev = await (deps.devSessionEnd ?? realDevSessionEnd)(owner, events.value, {
        run, ...(bins.lsof ? { lsof: bins.lsof } : {}), ...(bins.ps ? { ps: bins.ps } : {}), ...(deps.kill ? { kill: deps.kill } : {}), ...(probeKill ? { probeKill } : {}),
        mode: loadModes(files.mode).devServers, sleep, root, home, now, ownerExitedAt, platform, acquire, release,
        log: (row) => log(`dev ${JSON.stringify(row)}`),
      });
    } catch (err) {
      note(`dev servers: ${err?.message ?? err}`);
    }

    // ---- 4. stacks leased by this owner ----
    const ctx = {
      root, files, cfg, run, docker, bins, platform, now, home, acquire, release, isAlive: isAliveFn, evidence: deps.evidence,
      ...(deps.kill ? { kill: deps.kill } : {}), ...(deps.readInventory ? { readInventory: deps.readInventory } : {}),
      ...(deps.readEvents ? { readEvents: deps.readEvents } : {}), ...(deps.freshStack ? { freshStack: deps.freshStack } : {}),
      ...(deps.listWorktrees ? { listWorktrees: deps.listWorktrees } : {}), ...(deps.fsx ? { fsx: deps.fsx } : {}),
      ...(deps.realpath ? { realpath: deps.realpath } : {}), ...(deps.readFile ? { readFile: deps.readFile } : {}),
    };
    const targets = [];
    let decisions = 0;
    const seenUses = new Set();
    const store = async (rec, { decision = true } = {}) => {
      const r = await appendDecision(files.actions, rec);
      if (r?.ok && decision) decisions += 1;
      else note(`decision for ${rec.project} not recorded: ${r?.reason ?? 'no answer'}`);
      return r;
    };

    const inventory = (deps.readInventory ?? realReadInventory)({ run, cfg, docker, deadlineAt: now() + 60_000, now });
    if (!inventory?.ok) {
      note(`inventory unavailable (${inventory?.reason ?? 'no answer'}): no stack decided`);
    } else if (inventory.value.dockerDown) {
      log('docker daemon is not running: no stack to decide');
    } else {
      const mine = events.value.filter((e) => e?.kind === 'use' && ownerKey(e.owner) === ownerKey(owner));
      for (const stack of inventory.value.stacks) {
        if (leasesFor(mine, stack).length === 0) continue;
        if (stack.shared || isShared({ project: stack.project, workdir: stack.workdir }, cfg)) continue;
        if (!projectAllowed(stack.project, isoRules)) continue;
        if (!stack.generation || !stack.containers.some((c) => c.id === stack.generation.id && c.running)) continue; // nothing running to stop
        try {
          await decideStack(stack);
        } catch (err) {
          result.stacks.push({ project: stack.project, action: 'failed', reasons: [`session-end decision failed: ${oneLine(err?.message ?? err)}`] });
          note(`${stack.project}: ${err?.message ?? err}`);
        }
      }
    }
    result.status = 'decided';
    wf.update({ phase: 'decided', decidedAt: iso(now()), decisions });

    // ---- 5. observation at +30 and +120 min ----
    if (targets.length > 0) {
      // Measured from the EARLIEST decision time (each record's own `t`), not from after all decisions: deciding and logging take
      // time, and a +120 min probe taken later than that would fall outside the outcome window and be dropped.
      const decidedAll = targets.map((t) => t.decidedMs).filter(Number.isFinite);
      const baseMs = decidedAll.length ? Math.min(...decidedAll) : now();
      wf.update({ phase: 'observing' });
      for (const offset of deps.observeAtMs ?? OBSERVE_AT_MS) {
        await sleep(Math.max(0, baseMs + offset - now()));
        await observe(offset, baseMs + offset);
      }
    }
    return result;

    async function decideStack(stack) {
      const mode = loadModes(files.mode).sessionEnd;
      let first;
      let verdict;
      try {
        first = await gatherEvidence(stack, ctx, { probes: SESSION_END_PROBES, excludeOwner: owner, deadlineMs: DECISION_BUDGET_MS });
        verdict = sessionEndVerdict(first.evidence);
      } catch (err) {
        verdict = { verdict: 'kept', reasons: [`assessment failed: ${oneLine(err?.message ?? err)}`], notes: [] };
      }
      if (verdict.verdict !== 'stop') {
        await store({ t: iso(now()), source: 'session-end', project: stack.project, generation: stack.generation, mode, action: 'kept', reasons: verdict.reasons, evidence: summarizeEvidence(first?.evidence, verdict) });
        result.stacks.push({ project: stack.project, action: 'kept', reasons: verdict.reasons });
        return;
      }
      let memBytes;
      try {
        const m = (deps.memoryOfProject ?? realMemoryOfProject)(stack.project, { run, docker, deadlineAt: now() + 20_000, now });
        if (m?.ok) memBytes = m.value;
      } catch {
        /* the benefit figure is optional */
      }
      let last = { evidence: first.evidence, verdict };
      let decidedT = null;
      const reassess = async () => {
        const again = await gatherEvidence(stack, ctx, { probes: SESSION_END_PROBES, excludeOwner: owner, deadlineMs: DECISION_BUDGET_MS });
        const v = sessionEndVerdict(again.evidence);
        last = { evidence: again.evidence, verdict: v };
        return { verdict: v.verdict, reasons: v.reasons, current: again.current };
      };
      const r = await stopStack({
        stack, mode, modeKey: 'sessionEnd', reassess, root, run, docker, supabaseBin, acquire, release, now, home,
        ...(deps.lockWaitMs !== undefined ? { lockWaitMs: deps.lockWaitMs } : {}), ...(deps.lockPollMs !== undefined ? { pollMs: deps.lockPollMs } : {}),
        ...(deps.afterLock ? { afterLock: deps.afterLock } : {}), ...(deps.beforeMutate ? { beforeMutate: deps.beforeMutate } : {}),
        ...(deps.realpath ? { realpath: deps.realpath } : {}),
        log: (rec) => {
          decidedT = rec.t;
          const counts = rec.action === 'would-stop' || rec.action === 'stopped';
          return store({
            t: rec.t, source: 'session-end', project: stack.project, generation: rec.generation, mode: rec.mode, action: rec.action, reasons: rec.reasons,
            evidence: summarizeEvidence(last.evidence, last.verdict), ...(counts && memBytes !== undefined ? { memBytes } : {}),
            ...(rec.alert ? { alert: rec.alert } : {}), ...(rec.post ? { post: rec.post } : {}),
          });
        },
      });
      result.stacks.push({ project: stack.project, action: r.action, reasons: r.reasons, ...(r.alert ? { alert: r.alert } : {}) });
      if ((r.action === 'would-stop' || r.action === 'stopped') && decidedT) targets.push({ stack, decidedMs: Date.parse(decidedT), generation: stack.generation });
    }

    // One re-probe of C1-C3 for every would-stop / stopped project. What it sees after the decision is a "use"; the first sighting
    // of each (check, process) is recorded. A probe that cannot run (e.g. no listener on a stopped stack) is a note, not a use.
    async function observe(offset, nominalMs) {
      const seen = seenUses;
      const slotMs = now();
      // A timer fires a little late. A late firing within the grace is stamped with its scheduled time, so the +120 min probe is not
      // pushed past the window by the timer's own overshoot (a much later firing keeps its real time and is judged as it is).
      const stampMs = slotMs > nominalMs && slotMs - nominalMs <= OBSERVE_GRACE_MS ? nominalMs : slotMs;
      const deadlineAt = slotMs + DECISION_BUDGET_MS;
      // never a consumer, never an observed use: this process and every registered worker of the feature (sibling workers included)
      const own = new Set([process.pid, pid, ...ownPids(root, { isAlive: isAliveFn })]);
      const probeOpts = { run, ...(bins.lsof ? { lsof: bins.lsof } : {}), ...(bins.ps ? { ps: bins.ps } : {}), ...(deps.kill ? { kill: deps.kill } : {}), platform, deadlineAt, now, excludePids: own };
      for (const { stack, decidedMs, generation } of targets) {
        const at = iso(stampMs);
        const add = async (check, hit, why) => {
          if (own.has(hit.pid)) return;
          const key = `${check}|${stack.project}|${hit.pid}|${hit.birth}|${hit.port ?? ''}`;
          if (seen.has(key)) return;
          seen.add(key);
          const use = { t: at, project: stack.project, pid: hit.pid ?? null, birth: hit.birth ?? null, check, ...(hit.command ? { command: String(hit.command).slice(0, 200) } : {}) };
          result.uses.push(use);
          await store({ t: at, source: 'session-end', project: stack.project, generation, action: 'use-observed', reasons: [`${check} at +${Math.round(offset / 60000)} min: ${why}`], use }, { decision: false });
        };
        // C1: leases registered after the decision, by anyone
        const evs = await readEvents();
        if (!evs.ok) note(`${stack.project}: C1 re-probe skipped (${evs.reason})`);
        else {
          for (const e of leasesFor(evs.value, stack)) {
            if (!(Date.parse(e.t) > decidedMs)) continue;
            await add('C1', { pid: e.owner?.pid, birth: e.owner?.birth, command: `lease via ${e.via ?? 'unknown'}` }, `lease by pid ${e.owner?.pid}`);
          }
        }
        for (const [check, fn] of [['C2', () => ev.connections(stack, probeOpts)], ['C3', () => ev.processRefs(stack, probeOpts)]]) {
          let r;
          try {
            r = fn();
          } catch (err) {
            r = { ok: false, reason: oneLine(err?.message ?? err) };
          }
          if (!r?.ok) {
            const key = `${check}|${stack.project}|probe`;
            if (!seen.has(key)) {
              seen.add(key);
              note(`${stack.project}: ${check} re-probe unavailable (${r?.reason ?? 'no answer'})`);
            }
            continue;
          }
          for (const hit of r.value) await add(check, hit, hit.pid === null || hit.pid === undefined ? 'a hidden client holds a connection' : `pid ${hit.pid} ${oneLine(hit.command).slice(0, 80)}`);
        }
      }
    }
  }
}
