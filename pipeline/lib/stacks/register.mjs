// The register flow of stack-stop: before every tool call, record that this Claude process is using a private Supabase
// stack (a "lease" in the ledger), or fail closed. Spec section 1; plan Task 5 with Revisions 2 and 3.
//
// Cost model. The hook runs before EVERY Bash/file tool call, so an unrelated call must cost one small cache read: no
// docker, no ps, no git, and never the ledger (it can hold months of lines). Registration reads only the inventory cache and
// the last 64 KB of actions.jsonl (the "was this stack just stopped?" check). Dev-server patterns are recorded first, before
// any stack filtering (a dev record is best-effort: its failure is logged and the flow continues, R2-3).
//
// One deadline (R2-2): deadlineAt = now + deadlineMs bounds every blocking step (docker, each ps lookup, the git call, the
// project lock wait and the ledger lock wait). When anything fails after the prefilter matched, the call exits 2 with the
// reason (a timed-out PreToolUse hook does NOT block, so the internal deadline is what makes the hook fail closed); while
// the pause file exists the failure is only logged and the call is allowed.
//
// Lock order (R3-3): one project lock at a time (targets sorted by lock name), the ledger lock only inside appendEvent.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquire as realAcquire, release as realRelease } from '../locks.mjs';
import { run as realRun } from '../proc.mjs';
import { isInside } from '../paths.mjs';
import { isPaused, isShared, loadMachineConfig } from './config.mjs';
import { findClaudeOwner } from './identity.mjs';
import { cachedInventory, readInventory, refreshCache, resolveDocker } from './inventory.mjs';
import { appendEvent as realAppendEvent } from './ledger.mjs';
import { devTargets, isStartCommand, prefilter, stackTargets } from './match.mjs';
import { isolation, lockDirs, projectAllowed, projectLockName, stackFiles, stacksRoot, stacksSeam } from './paths.mjs';
import { ok, unknown } from './result.mjs';

export const DEFAULT_DEADLINE_MS = 20000;
const TAIL_BYTES = 64 * 1024;
const GIT_CAP_MS = 3000;
const LOCK_POLL_MS = 25;
const DEADLINE_SLACK_MS = 25;
const RESTART_FLAGS = '-x studio,imgproxy,edge-runtime,logflare,vector';

// ---- seams, wiring ----

// The two probe binaries and the deadline for this process. The test seams reach the code only through stacksSeam: an
// installed copy ignores them, and the checkout honours them only for an isolated run (custom root + PIPELINE_STACKS_ONLY).
export function resolveSeams({ env = process.env, home = os.homedir(), root, platform = process.platform, warn } = {}) {
  const opts = { home, ...(root ? { root } : {}), ...(warn ? { warn } : {}) };
  const ps = stacksSeam('PIPELINE_PS', env, opts);
  const dl = Number(stacksSeam('PIPELINE_STACKS_DEADLINE_MS', env, opts));
  let docker;
  return {
    // resolved on first use: looking for the binary stats PATH directories, which an unrelated tool call must not pay for
    get docker() {
      return (docker ??= resolveDocker({ env, home, platform, ...(root ? { root } : {}), ...(warn ? { warn } : {}) }));
    },
    ps: ps !== undefined && String(ps).trim() !== '' ? String(ps).trim() : undefined,
    deadlineMs: Number.isFinite(dl) && dl > 0 ? dl : DEFAULT_DEADLINE_MS,
  };
}

// The last `bytes` of `file` as complete lines (a partial first line is dropped). ok([]) when the file does not exist.
export function readTailLines(file, bytes = TAIL_BYTES) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
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
    return ok(text.split('\n').filter((l) => l.trim() !== ''));
  } catch (err) {
    return err?.code === 'ENOENT' ? ok([]) : unknown(`actions log unreadable: ${err?.message ?? err}`);
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

// The newest actions.jsonl record that names `project` (case-insensitive), from the last 64 KB only. ok(null) when none.
function latestAction(file, project, readTail) {
  const tail = readTail(file, TAIL_BYTES);
  if (!tail.ok) return tail;
  const want = String(project ?? '').toLowerCase();
  for (let i = tail.value.length - 1; i >= 0; i--) {
    let rec;
    try {
      rec = JSON.parse(tail.value[i]);
    } catch {
      continue; // a damaged line in a decisions log is not a lease; skip it
    }
    if (rec && typeof rec === 'object' && String(rec.project ?? '').toLowerCase() === want && want !== '') return ok(rec);
  }
  return ok(null);
}

function appendLog(file, line) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.appendFileSync(file, `${line}\n`, { mode: 0o600 });
  } catch {
    /* the log is best effort */
  }
}

// ---- the flow ----

const oneLine = (s) => String(s).replace(/\s+/g, ' ').trim();

export async function register(input, deps = {}) {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const events = [];
  if (platform === 'win32') return { exit: 0, events };

  const now = deps.now ?? Date.now;
  const home = deps.home ?? os.homedir();
  const run = deps.run ?? realRun;
  const root = deps.root ?? stacksRoot(env, home);
  const files = deps.files ?? stackFiles(root);
  const dirs = lockDirs(root);
  const seams = deps.seams ?? resolveSeams({ env, home, root: deps.pipelineRoot, platform });
  const deadlineMs = deps.deadlineMs ?? seams.deadlineMs;
  const deadlineAt = now() + deadlineMs;
  const remaining = () => Math.max(0, deadlineAt - now());
  const acquire = deps.acquire ?? realAcquire;
  const release = deps.release ?? realRelease;
  const append = deps.appendEvent ?? realAppendEvent;
  const readTail = deps.readTail ?? readTailLines;
  const logLine = deps.log ?? ((line) => appendLog(files.log, line));
  const log = (msg) => {
    try {
      logLine(`${new Date(now()).toISOString()} register ${oneLine(msg)}`);
    } catch {
      /* best effort */
    }
  };

  const tool = typeof input?.tool_name === 'string' ? input.tool_name : '';
  const toolInput = input?.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  const cwd = typeof input?.cwd === 'string' && input.cwd !== '' ? input.cwd : process.cwd();
  const command = tool === 'Bash' && typeof toolInput.command === 'string' ? toolInput.command : '';

  let cfgValue;
  const getCfg = () => (cfgValue ??= deps.cfg ?? loadMachineConfig(files.config, { home }));

  let isoValue;
  const getIso = () => {
    if (isoValue === undefined) {
      try {
        isoValue = { ok: true, iso: deps.iso ?? isolation(env, root, { home }) };
      } catch (err) {
        isoValue = { ok: false, reason: err?.message ?? String(err) };
      }
    }
    return isoValue;
  };

  // A failure after the prefilter matched: exit 2 with the reason, or log and let the call go when paused or when this machine has no
  // usable config (the feature is inert there: installing the hooks must not change what an ordinary Bash call does).
  const fail = (reason, { stack, lockPath } = {}) => {
    let why = oneLine(reason);
    if (now() >= deadlineAt - DEADLINE_SLACK_MS) why = `deadline of ${deadlineMs} ms exceeded: ${why}`;
    const paused = isPaused(files.pause);
    const unconfigured = !paused && getCfg().status !== 'ok';
    log(`${paused ? 'paused, allowing' : unconfigured ? 'not configured, allowing' : 'blocking'}: could not register use of stack ${stack ?? '(unknown)'} (${why})`);
    if (paused || unconfigured) return { exit: 0, events };
    let message = `autostop could not register use of stack ${stack ?? '(unknown)'} (${why}) — retry; pause with: touch ${files.pause}`;
    if (lockPath && !why.includes(lockPath)) message += ` (lock: ${lockPath})`;
    return { exit: 2, message, events };
  };

  // Owner and worktree are computed at most once per call and shared by the dev and the stack part.
  let ownerValue;
  const getOwner = () => {
    ownerValue ??= (deps.owner ?? ((o) => findClaudeOwner({ run, platform, ps: seams.ps, deadlineAt: o.deadlineAt, now })))({ deadlineAt });
    return ownerValue;
  };
  let worktreeValue;
  const getWorktree = () => {
    if (worktreeValue !== undefined) return worktreeValue;
    if (deps.worktree) return (worktreeValue = deps.worktree(cwd, { deadlineAt }));
    const posix = cwd.replace(/\\/g, '/');
    const inWorktrees = posix.split('/').includes('.worktrees');
    const inRepo = !inWorktrees && getCfg().repos.some((r) => isInside(cwd, r, platform));
    if (!inWorktrees && !inRepo) return (worktreeValue = ok('none'));
    const budget = Math.min(GIT_CAP_MS, remaining());
    if (budget < 1) return (worktreeValue = unknown('deadline'));
    let r;
    try {
      r = run('git', ['rev-parse', '--show-toplevel'], { cwd, timeoutMs: budget });
    } catch (err) {
      return (worktreeValue = unknown(`git could not run: ${err?.message ?? err}`));
    }
    if (r.timedOut) return (worktreeValue = unknown('git timed out'));
    if (r.signal) return (worktreeValue = unknown(`git ended by signal ${r.signal}`));
    const top = String(r.stdout ?? '').trim();
    if (r.code === 0 && top !== '') return (worktreeValue = ok(top));
    // git ran and said "not a repository": the cwd is in no worktree. Any other failure is unknown.
    return (worktreeValue = r.code === 128 && /not a git repository/i.test(String(r.stderr ?? '')) ? ok('none') : unknown(`git rev-parse exit ${r.code}: ${oneLine(r.stderr ?? '')}`));
  };

  const baseEvent = (kind, t, owner, worktree) => ({
    t,
    kind,
    session_id: input?.session_id ?? null,
    ...(input?.agent_id ? { agent_id: input.agent_id } : {}),
    ...(input?.tool_use_id ? { tool_use_id: input.tool_use_id } : {}),
    owner: { pid: owner.pid, birth: owner.birth },
    cwd,
    worktree,
    tool,
  });

  // ---- 1. dev servers first: best effort, never a safety gate ----
  const devs = devTargets(command);
  if (devs.length > 0) {
    try {
      const iso = getIso();
      const owner = getOwner();
      const wt = getWorktree();
      if (!iso.ok) log(`dev record skipped: ${iso.reason}`);
      else if (!owner.ok) log(`dev record skipped: owner unknown (${owner.reason})`);
      else if (!wt.ok) log(`dev record skipped: worktree unknown (${wt.reason})`);
      else {
        for (const { port } of devs) {
          const t = new Date(now()).toISOString();
          const event = { ...baseEvent('dev', t, owner.value, wt.value), port, tPre: t };
          const r = await append(files.ledger, event, { lockDir: dirs.ledger, deadlineAt, now });
          if (r?.ok) events.push(event);
          else log(`dev record for port ${port} failed: ${r?.reason ?? 'no answer'}`);
        }
      }
    } catch (err) {
      log(`dev record failed: ${err?.message ?? err}`);
    }
  }

  // ---- 2. stack prefilter: cache only, no docker, no ledger ----
  let cache;
  try {
    cache = (deps.inventory ?? (() => defaultCache(files.cache, now)))();
  } catch {
    cache = { inv: null, fresh: false };
  }
  if (!prefilter({ tool, input: toolInput, inventory: cache?.inv, platform })) return { exit: 0, events };

  // ---- 3. inventory: the cache when fresh and usable, else one refresh (a "docker down" cache is never trusted) ----
  const iso = getIso();
  if (!iso.ok) return fail(iso.reason);
  let inv = cache?.inv ?? null;
  let snapshotAt = Number.isFinite(cache?.at) ? cache.at : null;
  if (!(inv && cache.fresh && !inv.dockerDown)) {
    const refreshed = await (deps.refreshInventory ?? defaultRefresh({ files, run, now, getCfg, seams }))({ deadlineAt });
    if (!refreshed?.ok) return fail(`inventory unavailable: ${refreshed?.reason ?? 'no answer'}`);
    inv = refreshed.value;
    snapshotAt = now();
  }
  if (inv.dockerDown) {
    log('docker daemon is not running; no stack can be running, nothing to register');
    return { exit: 0, events };
  }
  if (snapshotAt === null) snapshotAt = now();

  // ---- 4. targets: drop shared stacks and anything outside an isolated run's allow list ----
  const cfg = getCfg();
  const raw = stackTargets({ tool, input: toolInput, cwd, inventory: inv, platform, home, ...(deps.fsx ?? {}) });
  const targets = raw.filter((t) => !isShared({ project: t.project, workdir: t.workdir }, cfg) && (iso.iso.only === null || (t.project && projectAllowed(t.project, iso.iso))));
  if (targets.length === 0) return { exit: 0, events };
  const label = targets.map((t) => t.project ?? t.folder ?? '(unnamed)').join(', ');

  // ---- 5. owner (the Claude Code process above the hook) and worktree ----
  const owner = getOwner();
  if (!owner.ok) return fail(`owner not found: ${owner.reason}`, { stack: label });
  const wt = getWorktree();
  if (!wt.ok) return fail(`worktree lookup failed: ${wt.reason}`, { stack: label });

  // ---- 6. per target: project lock, just-stopped check, append ----
  const named = targets.map((t) => ({ t, lock: projectLockName(t.project ?? t.folder ?? 'unnamed') })).sort((a, b) => (a.lock < b.lock ? -1 : a.lock > b.lock ? 1 : 0));
  const start = tool === 'Bash' && isStartCommand(command);
  for (const { t, lock } of named) {
    const stack = t.project ?? t.folder ?? '(unnamed)';
    const lockPath = path.join(dirs.project, `${lock}.lock`);
    let held;
    try {
      held = await acquire(lock, { dir: dirs.project, waitMs: remaining(), pollMs: LOCK_POLL_MS });
    } catch (err) {
      return fail(`project lock unavailable: ${oneLine(err?.message ?? err)}`, { stack, lockPath: err?.lockPath ?? lockPath });
    }
    try {
      let stopped = false;
      if (t.project) {
        const last = latestAction(files.actions, t.project, readTail);
        if (!last.ok) return fail(last.reason, { stack });
        const at = Date.parse(last.value?.t);
        stopped = last.value?.action === 'stopped' && Number.isFinite(at) && at > snapshotAt;
      }
      if (stopped && tool === 'Bash' && !start) {
        const where = t.workdir ?? t.folder ?? stack;
        log(`blocked: ${stack} was just stopped automatically`);
        return {
          exit: 2,
          message: `stack ${stack} was just stopped automatically (data kept). Run \`supabase start ${RESTART_FLAGS} --workdir ${where}\`, then retry.`,
          events,
        };
      }
      const event = { ...baseEvent('use', new Date(now()).toISOString(), owner.value, wt.value) };
      if (t.project) event.project = t.project;
      if (t.workdir) event.workdir = t.workdir;
      if (t.folder) event.folder = t.folder;
      event.via = t.via;
      const r = await append(files.ledger, event, { lockDir: dirs.ledger, deadlineAt, now });
      if (!r?.ok) return fail(r?.reason ?? 'ledger append failed', { stack });
      events.push(event);
      // A restart of a just-stopped stack: the cached inventory still says "stopped", so drop it; the next call refreshes.
      if (stopped && start) (deps.invalidateCache ?? (() => dropCache(files.cache)))();
    } finally {
      try {
        release(held);
      } catch {
        /* a lock whose owner is gone is reclaimed by the next taker */
      }
    }
  }
  return { exit: 0, events };
}

function defaultCache(file, now) {
  const c = cachedInventory({ file, now: now() });
  let at = null;
  if (c.inv) {
    try {
      at = fs.statSync(file).mtimeMs;
    } catch {
      at = null;
    }
  }
  return { ...c, at };
}

// A refresh the hook can bound: readInventory on the injected run, written to the 60 s cache when ok.
function defaultRefresh({ files, run, now, getCfg, seams }) {
  return async ({ deadlineAt }) => refreshCache({ file: files.cache, now: now(), refresh: () => readInventory({ run, cfg: getCfg(), docker: seams.docker, deadlineAt, now }) });
}

function dropCache(file) {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    /* the cache is only a speed-up */
  }
}
