// The daily sweep of stack-stop: `pipeline stacks sweep [--apply] [--summary-only]`. Spec section 4; plan Task 12b with R2-6, R2-7,
// R2-9, R2-13, R2-14.
//
// FLOW (runSweep). One run at a time (run lock `sweep`, waitMs 0: a second run answers "already running"). Then:
//   0. housekeeping: workers/<pid>.json whose pid is provably dead (procIdentity ok(null)) is removed; a live or unknown pid is kept.
//      A dead worker's file in phase `decided` / `observing` means its re-probes never finished: for each decided target the file
//      names, an `observation-lost` marker (not a decision) is appended, so that would-stop reads UNKNOWN, not CLEAN (F2);
//   1. gates: machine config not ok => the report says "not configured", nothing is assessed, ZERO decisions are written; a
//      non-default root without PIPELINE_STACKS_ONLY => refused;
//   2. the lease ledger is read once under its lock. Damaged or unreadable => every stack is LISTED with the reason `ledger damaged`
//      and not one stop is attempted (R2-14); the report carries the repair hint. A damaged decisions log does the same;
//   3. the Docker inventory. For every project: outside the isolation list => not looked at; shared => a `shared` row, never
//      assessed; no running db container => not a candidate; the rest go through gatherEvidence(SWEEP_PROBES) -> sweepVerdict;
//   4. `stop` verdict + `--apply` + mode.json `sweeper: apply` => act.stopStack (which re-checks everything under the project lock
//      and writes the decision itself). Every other case is only RECORDED (`would-stop` / `kept` / `listed`) in actions.jsonl, so
//      `--apply` with mode `report` makes no supabase call at all;
//   5. outcomes: a "use" is a ledger `use` event (owner identity from the event), a `use-observed` record the session-end worker
//      wrote, or a C2/C3 hit this sweep sees within 2 h of an open would-stop of the same project (recorded as `use-observed`
//      so the next sweep still has it); MISS / RESTART / UNKNOWN / CLEAN come from outcomes.outcomeSummary;
//   6. dev servers (devRows over the configured ports; report only, nothing is signalled here), the health of the installed hook
//      files and settings entries, then report.md and weekly-section.md are written (atomic rename).
// Everything that touches the machine is injectable through `deps` (run, clock, fs, probes, locks), so tests never see the real one.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquire as realAcquire, release as realRelease, LockTimeoutError } from '../locks.mjs';
import { run as realRun } from '../proc.mjs';
import { inspectHooks, STACK_REGISTER_MATCHERS } from '../installer.mjs';
import { isShared, isPaused, loadMachineConfig, loadModes } from './config.mjs';
import { sweepVerdict } from './decide.mjs';
import { procIdentity as realProcIdentity, isAlive as realIsAlive } from './identity.mjs';
import { readInventory as realReadInventory, resolveDocker } from './inventory.mjs';
import { leasesFor } from './ledger.mjs';
import { isolation, lockDirs, projectAllowed, stackFiles, stacksRoot } from './paths.mjs';
import { resolveSupabase, stopStack as realStopStack } from './act.mjs';
import { SWEEP_PROBES, gatherEvidence, ownPids, readLedgerLocked, summarizeEvidence } from './assess.mjs';
import {
  WINDOW_MS, appendDecision as realAppendDecision, generationKey, memoryOfProject as realMemoryOfProject, newestStopAt, outcomeSummary, quietCandidates, readDecisions, renderReport,
  renderWeekly, stopRecords,
} from './outcomes.mjs';
import { observedUses } from './session-end.mjs';
import * as realEvidence from './evidence.mjs';
import { devRows as realDevRows } from './dev.mjs';

const DECISION_BUDGET_MS = 120_000;
export const STACK_HOOKS = Object.freeze(['stack-register', 'stack-dev-bind', 'stack-session-end']);

const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
const iso = (ms) => new Date(ms).toISOString();
const lower = (s) => String(s ?? '').toLowerCase();

function appendLog(file, line) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.appendFileSync(file, `${line}\n`, { mode: 0o600 });
  } catch {
    /* the log is best effort */
  }
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// ---------------------------------------------------------------- installed hook health

// -> [{ file, problem }] for each stack hook whose installed file or settings.json entry is missing or differs. `home` is
// injected (tests never read the real one). inspectHooks is given the claude-home (<home>/.claude), the same value the installer
// writes its expected entries from, so an entry is "exact" only if it equals what install writes. stack-register has one entry per
// matcher (STACK_REGISTER_MATCHERS): each must be present.
export function hookHealth({ home = os.homedir(), fsx = fs } = {}) {
  const dir = path.join(home, '.claude', 'pipeline', 'hooks');
  let settings = null;
  let settingsProblem = null;
  try {
    settings = JSON.parse(fsx.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
  } catch (err) {
    settingsProblem = err?.code === 'ENOENT' ? 'settings.json is missing' : `settings.json is unreadable (${err?.code ?? oneLine(err?.message)})`;
  }
  let found = null;
  if (settings) {
    try {
      found = inspectHooks(settings, path.join(home, '.claude'));
    } catch (err) {
      settingsProblem = `settings.json cannot be inspected (${oneLine(err?.message ?? err)})`;
    }
  }
  const out = [];
  for (const name of STACK_HOOKS) {
    const file = path.join(dir, `${name}.mjs`);
    const problems = [];
    let present = false;
    try {
      present = fsx.statSync(file).isFile();
    } catch {
      present = false;
    }
    if (!present) problems.push('hook file missing (not installed)');
    const entries = found?.[name];
    if (!Array.isArray(entries) || entries.length === 0) problems.push(settingsProblem ?? 'no entry in settings.json (not installed)');
    else if (entries.some((e) => e?.exact !== true)) problems.push('settings.json entry differs from what install writes');
    else if (name === 'stack-register') {
      const missing = STACK_REGISTER_MATCHERS.filter((m) => !entries.some((e) => e.matcher === m));
      if (missing.length) problems.push(`no entry in settings.json for matcher ${missing.map((m) => JSON.stringify(m)).join(', ')} (not installed)`);
    }
    if (problems.length) out.push({ file, problem: problems.join('; ') });
  }
  return out;
}

// ---------------------------------------------------------------- housekeeping

// Removes workers/<pid>.json when that pid is provably dead; a live or unknown pid keeps its file. -> { removed, kept, errors, lost }.
// `lost` = [{ name, phase, targets: [{ project, generation, t }] | null }] for each removed file that was `decided` / `observing`
// (a finished worker removes its own file, so one left behind by a dead pid never finished its re-probes); `targets` is the list
// the worker wrote into its file once it had decided, null for a file from before that field existed.
export function cleanWorkers({ files, run = realRun, ps, kill, platform = process.platform, identity = realProcIdentity, fsx = fs } = {}) {
  const res = { removed: [], kept: [], errors: [], lost: [] };
  let names;
  try {
    names = fsx.readdirSync(files.workers);
  } catch (err) {
    if (err?.code !== 'ENOENT') res.errors.push(`cannot read ${files.workers}: ${err?.code ?? oneLine(err?.message)}`);
    return res;
  }
  for (const name of names.sort()) {
    const m = /^(\d+)\.json$/.exec(name);
    if (!m) continue;
    const pid = Number(m[1]);
    let id;
    try {
      id = identity(pid, { run, platform, ...(ps ? { ps } : {}), ...(kill ? { kill } : {}) });
    } catch (err) {
      id = { ok: false, reason: oneLine(err?.message ?? err) };
    }
    if (id?.ok && id.value === null) {
      let body = null;
      try {
        body = JSON.parse(fsx.readFileSync(path.join(files.workers, name), 'utf8'));
      } catch {
        /* an unreadable file names no targets */
      }
      try {
        fsx.rmSync(path.join(files.workers, name), { force: true });
        if (body && (body.phase === 'decided' || body.phase === 'observing')) {
          const targets = Array.isArray(body.targets)
            ? body.targets.filter((t) => t && typeof t.project === 'string' && t.project !== '').map((t) => ({ project: t.project, generation: t.generation ?? null, t: t.t ?? null }))
            : null;
          res.lost.push({ name, phase: body.phase, targets });
        }
        res.removed.push(name);
      } catch (err) {
        res.errors.push(`cannot remove ${name}: ${err?.code ?? oneLine(err?.message)}`);
      }
    } else res.kept.push(name);
  }
  return res;
}

// ---------------------------------------------------------------- leases (status and outcomes)

// Ledger `use` events as outcome "uses": { t, project, pid, birth, check: 'C1', command, sessionId, ledger: true }. The project is the event's own, else the
// inventory stack the event's folder/workdir names; an event that names neither is not attributable and is skipped.
export function ledgerUses(events, stacks = []) {
  const out = [];
  for (const e of events ?? []) {
    if (e?.kind !== 'use' || !e.owner) continue;
    let project = typeof e.project === 'string' && e.project !== '' ? e.project : null;
    if (project === null) project = stacks.find((s) => leasesFor([e], s).length > 0)?.project ?? null;
    if (project === null) continue;
    out.push({ t: e.t, project, pid: e.owner.pid ?? null, birth: Number.isFinite(e.owner.birth) ? e.owner.birth : null, check: 'C1', command: `lease via ${e.via ?? 'unknown'}`, sessionId: e.session_id ?? null, ledger: true });
  }
  return out;
}

// Current leases for `status`: one row per (owner, project) whose owner is alive or whose liveness is unknown.
// -> [{ project, owner: { pid, birth }, alive: true | null, since, last }]
export function currentLeases(events, { stacks = [], isAlive }) {
  const groups = new Map();
  for (const u of ledgerUses(events, stacks)) {
    const key = `${lower(u.project)}|${u.pid}:${u.birth}`;
    const g = groups.get(key);
    if (!g) groups.set(key, { project: u.project, owner: { pid: u.pid, birth: u.birth }, since: u.t, last: u.t });
    else {
      if (Date.parse(u.t) < Date.parse(g.since)) g.since = u.t;
      if (Date.parse(u.t) > Date.parse(g.last)) g.last = u.t;
    }
  }
  const out = [];
  for (const g of groups.values()) {
    let a;
    try {
      a = Number.isInteger(g.owner.pid) && Number.isFinite(g.owner.birth) ? isAlive(g.owner) : { ok: false, reason: 'no identity' };
    } catch (err) {
      a = { ok: false, reason: oneLine(err?.message ?? err) };
    }
    if (a?.ok && a.value === false) continue;
    out.push({ ...g, alive: a?.ok ? true : null });
  }
  return out.sort((x, y) => (x.project < y.project ? -1 : x.project > y.project ? 1 : x.since < y.since ? -1 : 1));
}

// ---------------------------------------------------------------- the sweep

export async function runSweep({ apply = false, deps = {} } = {}) {
  const platform = deps.platform ?? process.platform;
  if (platform === 'win32') return { ok: false, error: 'not supported on Windows' };
  const env = deps.env ?? process.env;
  const home = deps.home ?? os.homedir();
  const now = deps.now ?? Date.now;
  const run = deps.run ?? realRun;
  const root = deps.root ?? stacksRoot(env, home);
  const files = deps.files ?? stackFiles(root);
  const acquire = deps.acquire ?? realAcquire;
  const release = deps.release ?? realRelease;
  const logLine = deps.log ?? ((line) => appendLog(files.log, line));
  const log = (msg) => {
    try {
      logLine(`${iso(now())} sweep ${oneLine(msg)}`);
    } catch {
      /* best effort */
    }
  };
  const notes = [];
  const note = (msg) => {
    notes.push(oneLine(msg));
    log(msg);
  };

  let isoRules;
  try {
    isoRules = deps.iso ?? isolation(env, root, { home });
  } catch (err) {
    return { ok: false, error: 'isolation', message: String(err?.message ?? err) };
  }

  let lock;
  try {
    lock = await acquire('sweep', { dir: lockDirs(root).sweep, waitMs: 0 });
  } catch (err) {
    if (err instanceof LockTimeoutError) return { ok: true, summary: 'already running', stopped: [], wouldStop: [], listed: [], kept: [], shared: [], failed: [] };
    return { ok: false, error: 'lock', message: `cannot take the sweep lock: ${oneLine(err?.message ?? err)}` };
  }
  try {
    return await flow();
  } finally {
    try {
      release(lock);
    } catch {
      /* a lock whose owner is gone is reclaimed by the next taker */
    }
  }

  async function flow() {
    const bins = deps.bins ?? realEvidence.resolveProbeBins({ env, home, ...(deps.pipelineRoot ? { root: deps.pipelineRoot } : {}) });
    const probeKill = deps.probeKill;
    const workers = cleanWorkers({
      files, run, ps: bins.ps, platform, ...(probeKill ? { kill: probeKill } : {}), ...(deps.procIdentity ? { identity: deps.procIdentity } : {}), ...(deps.fsx ? { fsx: deps.fsx } : {}),
    });
    for (const e of workers.errors) note(`workers: ${e}`);
    if (workers.removed.length) log(`removed ${workers.removed.length} worker file(s) of dead processes: ${workers.removed.join(', ')}`);

    const cfg = deps.cfg ?? loadMachineConfig(files.config, { home });
    const modes = loadModes(files.mode);
    const paused = isPaused(files.pause);
    const result = {
      ok: true, summary: '', stopped: [], wouldStop: [], listed: [], kept: [], shared: [], failed: [], dev: [], notes, workers: workers.removed, report: files.report, weekly: files.weekly,
    };
    const hooks = (deps.hookHealth ?? hookHealth)({ home, ...(deps.fsx ? { fsx: deps.fsx } : {}) });
    const appendDecision = deps.appendDecision ?? realAppendDecision;
    const stopStack = deps.stopStack ?? realStopStack;
    const ev = { ...realEvidence, ...(deps.evidence ?? {}) };

    // F2: a worker that died after deciding never finished its re-probes. Marker records, written with the decisions log's append.
    for (const l of workers.lost) {
      if (l.targets === null) {
        log(`worker ${l.name} died in phase ${l.phase}; its file names no targets (older format), so no observation-lost marker can be written`);
        continue;
      }
      for (const t of l.targets) {
        const r = await appendDecision(files.actions, {
          t: iso(now()), source: 'sweep', project: t.project, generation: t.generation, action: 'observation-lost',
          ...(t.t ? { decidedAt: t.t } : {}), // the decision record whose observation was lost (R4-B1)
          reasons: [`session-end worker ${l.name} died in phase ${l.phase} before its re-probes finished${t.t ? ` (decided ${t.t})` : ''}`],
        });
        if (!r?.ok) note(`observation-lost for ${t.project} not recorded: ${r?.reason ?? 'no answer'}`);
      }
    }

    // A born-before C1 lease is a RESTART, not a MISS, only when its owner's own transcript shows nothing but read-only inspection
    // from its birth to the decision (evidence.ownerQuiet). One proof per (owner, decision); no usable config or transcript dirs, or a
    // thrown error, leaves the use a MISS. The verdict rides on the use as use.quiet = { decision, verdict, why }.
    const attachQuietProofs = (decisions, uses, ledgerCoverage) => {
      if (cfg.status !== 'ok' || !cfg.transcriptDirs?.length) return;
      const proofOf = deps.ownerQuiet ?? ev.ownerQuiet;
      const cache = new Map();
      for (const { use, decision } of quietCandidates(decisions, uses, { ledgerCoverage })) {
        const k = `${lower(use.project)}|${use.pid}|${use.birth}|${decision.t}`;
        let q = cache.get(k);
        if (q === undefined) {
          try {
            const r = proofOf({
              sessionId: use.sessionId, birthMs: use.birth * 1000, decidedMs: Date.parse(decision.t), dirs: cfg.transcriptDirs, platform,
              ...(deps.fsx ? { fsx: deps.fsx } : {}),
            });
            q = r?.ok && (r.value?.verdict === 'quiet' || r.value?.verdict === 'active')
              ? { verdict: r.value.verdict, why: oneLine(r.value.why) }
              : { verdict: 'unknown', why: oneLine(r?.reason ?? 'no answer') };
          } catch (err) {
            q = { verdict: 'unknown', why: oneLine(err?.message ?? err) };
          }
          cache.set(k, q);
          if (q.verdict !== 'quiet') note(`${use.project}: owner ${use.pid} of a lease before the ${decision.t} would-stop is ${q.verdict}: ${q.why}`);
        }
        use.quiet = { decision: decision.t, verdict: q.verdict, why: q.why };
      }
    };

    const finish = (summary, extra = {}) => {
      const t = now();
      const d = readDecisions(files.actions);
      const decisions = d.ok ? d.value : [];
      if (!d.ok) note(`decisions log unreadable: ${d.reason}`);
      const uses = [...observedUses(decisions), ...(extra.uses ?? [])];
      const ledgerCoverage = extra.ledgerCoverage ?? { ok: false };
      attachQuietProofs(decisions, uses, ledgerCoverage);
      const sum = outcomeSummary(decisions, uses, t, { ledgerCoverage });
      const rs = {
        now: t, decisions, uses, config: cfg.status, paused, modes, hooks, ledger: extra.ledger ?? { ok: true }, ledgerCoverage,
        listed: result.listed.map((l) => ({ project: l.project, verdict: 'listed', reasons: l.reasons, ...(l.hidden ? { hidden: l.hidden } : {}) })),
        dev: result.dev, reportPath: files.report,
      };
      try {
        writeAtomic(files.report, renderReport(rs));
        writeAtomic(files.weekly, renderWeekly(rs));
      } catch (err) {
        note(`report not written: ${err?.message ?? err}`);
      }
      result.outcomes = { miss: sum.miss, restart: sum.restart, unknown: sum.unknown, clean: sum.clean, pending: sum.pending, gbFreed: sum.gbFreed };
      result.summary = `${summary}; MISS ${sum.miss}${sum.unknown ? ` (+${sum.unknown} unknown)` : ''} RESTART ${sum.restart} CLEAN ${sum.clean}; report ${files.report}`;
      log(result.summary);
      return result;
    };

    if (cfg.status !== 'ok') {
      note(`not configured (${cfg.status}${cfg.error ? `: ${cfg.error}` : ''}): nothing is assessed or stopped`);
      return finish('not configured');
    }

    // ---- the ledger, once, under its lock ----
    const readEvents = deps.readEvents ?? (() => readLedgerLocked({ files, root, acquire, release }));
    const events = await readEvents();
    const decisionsNow = readDecisions(files.actions);
    let blockedReason = null;
    if (!events.ok) blockedReason = `${/^damaged ledger/.test(events.reason) ? 'ledger damaged' : 'ledger unreadable'}: ${events.reason}`;
    else if (!decisionsNow.ok) blockedReason = `decisions log damaged: ${decisionsNow.reason}`;

    // ---- the inventory ----
    const docker = deps.docker ?? resolveDocker({ env, home, platform, ...(deps.pipelineRoot ? { root: deps.pipelineRoot } : {}) });
    const supabaseBin = deps.supabaseBin ?? resolveSupabase({ env, home, platform, ...(deps.pipelineRoot ? { root: deps.pipelineRoot } : {}) });
    const inventory = (deps.readInventory ?? realReadInventory)({ run, cfg, docker, deadlineAt: now() + 60_000, now });
    // What the ledger provably covers: legacy worker observations are dropped only when it was read, never repaired, and starts early enough.
    let repaired = false;
    try {
      repaired = (deps.fsx ?? fs).existsSync(files.ledgerBad);
    } catch {
      repaired = true; // cannot tell: treat as repaired (nothing is dropped)
    }
    const extra = {
      ledgerCoverage: events.ok ? { ok: true, repaired, firstT: events.value?.[0]?.t ?? null } : { ok: false },
      ledger: events.ok ? { ok: true } : { ok: false, reason: events.reason },
      uses: events.ok ? ledgerUses(events.value, inventory?.ok ? inventory.value.stacks : []) : [],
    };
    if (!inventory?.ok) {
      note(`inventory unavailable (${inventory?.reason ?? 'no answer'}): no stack assessed`);
      return finish('inventory unavailable', extra);
    }
    if (inventory.value.dockerDown) {
      log('docker daemon is not running: no stack to assess');
      return finish('docker is not running', extra);
    }

    const isAliveFn = deps.isAlive ?? ((o) => realIsAlive(o, { run, ps: bins.ps, platform, ...(probeKill ? { kill: probeKill } : {}) }));
    const ctx = {
      root, files, cfg, run, docker, bins, platform, now, home, acquire, release, isAlive: isAliveFn, evidence: deps.evidence,
      ...(deps.kill ? { kill: deps.kill } : {}), ...(deps.readInventory ? { readInventory: deps.readInventory } : {}),
      ...(deps.readEvents ? { readEvents: deps.readEvents } : {}),
      ...(deps.freshStack ? { freshStack: deps.freshStack } : {}), ...(deps.listWorktrees ? { listWorktrees: deps.listWorktrees } : {}),
      ...(deps.fsx ? { fsx: deps.fsx } : {}), ...(deps.realpath ? { realpath: deps.realpath } : {}), ...(deps.readFile ? { readFile: deps.readFile } : {}),
      ...(deps.ghFor ? { ghFor: deps.ghFor } : {}), ...(deps.git ? { git: deps.git } : {}),
    };
    const canApply = apply && modes.sweeper === 'apply' && blockedReason === null;
    // Every would-stop / stopped record, not one per generation: a use is charged to the NEWEST record not later than it (a long-lived
    // generation is would-stopped again by every daily sweep). A sighting is "seen" per (process, newest record), so a consumer that
    // is still there when the next record is written is a use of that record too.
    const priorStops = stopRecords(decisionsNow.ok ? decisionsNow.value : []);
    const seenKey = (check, project, pid, birth, target) => `${check}|${lower(project)}|${pid}|${birth}|${generationKey(target)}|${target.t}`;
    const seenUse = new Set();
    for (const rec of decisionsNow.ok ? decisionsNow.value : []) {
      if (rec?.action !== 'use-observed' || !rec.use || typeof rec.use !== 'object') continue;
      const target = newestStopAt(priorStops, rec.use.project, Date.parse(rec.use.t));
      if (target) seenUse.add(seenKey(rec.use.check, rec.use.project, rec.use.pid, rec.use.birth, target));
    }
    const store = async (rec) => {
      const r = await appendDecision(files.actions, rec);
      if (!r?.ok) note(`decision for ${rec.project} not recorded: ${r?.reason ?? 'no answer'}`);
      return r;
    };
    const hiddenOf = (e) => Math.max(0, ...['connections', 'processRefs', 'cwdProcs'].map((k) => (Number.isFinite(e?.[k]?.hidden) ? e[k].hidden : 0)));

    for (const stack of inventory.value.stacks) {
      if (!projectAllowed(stack.project, isoRules)) continue; // outside the isolation list: not looked at
      if (stack.shared || isShared({ project: stack.project, workdir: stack.workdir }, cfg)) {
        result.shared.push({ project: stack.project, reasons: ['shared stack (never assessed, never stopped)'] });
        continue;
      }
      if (!stack.generation || !stack.containers.some((c) => c.id === stack.generation.id && c.running)) continue; // nothing running
      if (blockedReason !== null) {
        result.listed.push({ project: stack.project, reasons: [blockedReason] });
        continue;
      }
      try {
        await assess(stack);
      } catch (err) {
        result.failed.push({ project: stack.project, reasons: [`sweep decision failed: ${oneLine(err?.message ?? err)}`] });
        note(`${stack.project}: ${err?.message ?? err}`);
      }
    }

    // ---- dev servers (report only) ----
    if (cfg.devPorts?.length) {
      try {
        result.dev = await (deps.devRows ?? realDevRows)({
          ports: cfg.devPorts, events: events.ok ? events.value : [], run, ...(bins.lsof ? { lsof: bins.lsof } : {}), ...(bins.ps ? { ps: bins.ps } : {}),
          ...(probeKill ? { kill: probeKill } : {}), platform, deadlineAt: now() + 60_000, now, isAlive: isAliveFn,
          prStates: (wts) => ev.prStates(wts, { platform, ...(deps.ghFor ? { ghFor: deps.ghFor } : {}), ...(deps.git ? { git: deps.git } : {}) }),
        });
      } catch (err) {
        note(`dev servers: ${err?.message ?? err}`);
      }
    }

    const total = result.shared.length + result.kept.length + result.listed.length + result.wouldStop.length + result.stopped.length + result.failed.length;
    const parts = [`${total} stack(s)`, `${result.shared.length} shared`, `${result.kept.length} kept`, `${result.listed.length} listed`, `${result.wouldStop.length} would stop`, `${result.stopped.length} stopped`];
    if (result.failed.length) parts.push(`${result.failed.length} FAILED`);
    if (blockedReason !== null) parts.push(`stopping disabled: ${blockedReason.split(':')[0]}`);
    return finish(parts.join(', '), extra);

    // One stack: evidence, verdict, then either stopStack (apply) or just a record.
    async function assess(stack) {
      let first;
      let verdict;
      try {
        first = await gatherEvidence(stack, { ...ctx, readEvents: async () => events }, { probes: SWEEP_PROBES, deadlineMs: DECISION_BUDGET_MS });
        verdict = sweepVerdict(first.evidence);
      } catch (err) {
        verdict = { verdict: 'listed', reasons: [`assessment failed: ${oneLine(err?.message ?? err)}`], notes: [] };
      }
      const hidden = hiddenOf(first?.evidence);
      await recordUses(stack, first?.evidence);
      const place = (action, reasons, extraRow = {}) => {
        const row = { project: stack.project, reasons, ...(hidden ? { hidden } : {}), ...extraRow };
        if (action === 'stopped') result.stopped.push(row);
        else if (action === 'would-stop') result.wouldStop.push(row);
        else if (action === 'listed') result.listed.push(row);
        else if (action === 'kept' || action === 'already-stopped') result.kept.push(row);
        else result.failed.push({ ...row, action });
      };
      const memory = () => {
        try {
          const m = (deps.memoryOfProject ?? realMemoryOfProject)(stack.project, { run, docker, deadlineAt: now() + 20_000, now });
          return m?.ok ? m.value : undefined;
        } catch {
          return undefined; // the benefit figure is optional
        }
      };

      if (!(verdict.verdict === 'stop' && canApply)) {
        const action = verdict.verdict === 'stop' ? 'would-stop' : verdict.verdict; // 'kept' | 'listed'
        const memBytes = action === 'would-stop' ? memory() : undefined;
        await store({
          t: iso(now()), source: 'sweep', project: stack.project, generation: stack.generation, mode: 'report', action, reasons: verdict.reasons,
          evidence: summarizeEvidence(first?.evidence, verdict), ...(memBytes !== undefined ? { memBytes } : {}),
        });
        place(action, verdict.reasons);
        return;
      }

      // apply: stopStack re-checks everything under the project lock and logs the decision itself
      const memBytes = memory();
      let last = { evidence: first.evidence, verdict };
      const reassess = async () => {
        // no cached events here: the ledger is read again, under its lock, now
        const again = await gatherEvidence(stack, ctx, { probes: SWEEP_PROBES, deadlineMs: DECISION_BUDGET_MS });
        const v = sweepVerdict(again.evidence);
        last = { evidence: again.evidence, verdict: v };
        return { verdict: v.verdict, reasons: v.reasons, current: again.current };
      };
      const r = await stopStack({
        stack, mode: 'apply', modeKey: 'sweeper', reassess, root, run, docker, supabaseBin, acquire, release, now, home,
        ...(deps.lockWaitMs !== undefined ? { lockWaitMs: deps.lockWaitMs } : {}), ...(deps.lockPollMs !== undefined ? { pollMs: deps.lockPollMs } : {}),
        ...(deps.afterLock ? { afterLock: deps.afterLock } : {}), ...(deps.beforeMutate ? { beforeMutate: deps.beforeMutate } : {}),
        ...(deps.realpath ? { realpath: deps.realpath } : {}),
        log: (rec) => {
          const counts = rec.action === 'would-stop' || rec.action === 'stopped';
          return store({
            t: rec.t, source: 'sweep', project: stack.project, generation: rec.generation, mode: rec.mode, action: rec.action, reasons: rec.reasons,
            evidence: summarizeEvidence(last.evidence, last.verdict), ...(counts && memBytes !== undefined ? { memBytes } : {}),
            ...(rec.alert ? { alert: rec.alert } : {}), ...(rec.post ? { post: rec.post } : {}),
          });
        },
      });
      place(r.action === 'skipped-lock' ? 'failed' : r.action, r.reasons, r.alert ? { alert: r.alert } : {});
    }

    // A C2 connection or C3 process reference seen now, within 2 h of an open would-stop of the same project, is a use of that
    // decision (R2-9). It is written as a `use-observed` record so a later sweep still has it. First sighting per (check, process).
    async function recordUses(stack, evidence) {
      if (!evidence) return;
      const t = now();
      const target = newestStopAt(priorStops, stack.project, t); // the window is judged from the NEWEST record of the project
      if (!target || t - Date.parse(target.t) > WINDOW_MS) return;
      const own = new Set([process.pid, ...ownPids(root, { isAlive: isAliveFn })]); // the feature's own workers and this sweep are never a use
      for (const [check, probe] of [['C2', evidence.connections], ['C3', evidence.processRefs]]) {
        if (!probe?.ok || !Array.isArray(probe.value)) continue;
        for (const hit of probe.value) {
          const pid = Number.isInteger(hit?.pid) ? hit.pid : null;
          if (pid !== null && own.has(pid)) continue;
          const birth = Number.isFinite(hit?.birth) ? hit.birth : null;
          const key = seenKey(check, stack.project, pid, birth, target);
          if (seenUse.has(key)) continue;
          seenUse.add(key);
          const use = { t: iso(t), project: stack.project, pid, birth, check, ...(hit?.command ? { command: String(hit.command).slice(0, 200) } : {}) };
          await store({
            t: use.t, source: 'sweep', project: stack.project, generation: target.generation, action: 'use-observed',
            reasons: [`${check} at the daily sweep: ${pid === null ? 'a hidden client holds a connection' : `pid ${pid} ${oneLine(hit?.command).slice(0, 80)}`}`], use,
          });
        }
      }
    }
  }
}
