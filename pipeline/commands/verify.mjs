// `pipeline verify <sub>`: the deterministic parts of how the ship skill runs verify. The skill never builds these command
// lines by hand. Subcommands: plan-after-fix (which verify commands to run after a round's accepted fixes) and slot (limit how
// many full verifies run at once on one machine, opt-in through verify.max_parallel_full).
//
// Why `slot --run` WRAPS the run instead of the plan's `slot --acquire` / `--release` pair: locks.mjs reclaims a lock whose
// owner PID is dead, and a short-lived `--acquire` process dies right after taking the slot, so its slot would be reclaimed at
// once and the limit would hold nothing. The wrapper stays alive (its PID is the lock owner) for exactly as long as the child
// runs; a wrapper killed hard frees its slot through the same dead-owner reclaim.
//
// `slot --run` runs ONLY the repo's configured `verify.full` (plus a validated `--only <steps>`), never a command of the
// caller's: the git and file guards judge the commands a session runs (and unwrap `job start NAME -- CMD`), so a wrapper that
// took an arbitrary command would be an exec that walks past them. Any extra argument, or anything after `--`, is a usage error.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { EXIT, intOption, parseCommandArgs, UsageError } from '../lib/cli.mjs';
import { Fail, guarded, requireConfig, resolveRepo } from '../lib/cmd-common.mjs';
import { git, headSha, isAncestor, revParse } from '../lib/git.mjs';
import { matchGlob } from '../lib/glob.mjs';
import { defaultLockDir, INCOMPLETE_STALE_MS, inspect, isPidAlive, machineId, release, tryAcquire } from '../lib/locks.mjs';
import { SAFE_STEP } from '../lib/config.mjs';
import { loadState } from '../lib/state.mjs';

export const meta = {
  summary: 'plan the verify commands for the ship loop (plan-after-fix); limit parallel full verifies (slot)',
  usage: [
    'pipeline verify plan-after-fix --round R [--repo DIR]   -> {ok, mode, commands, matchedSteps, base, head, files}',
    '  verify.after_fix full (default): commands = [verify.full]. quick: commands = [verify.quick] plus, when the fixes since round R\'s',
    '  reviewed head (renames count on both sides) touch a path in verify.after_fix_steps_by_path, verify.full --only <those steps>;',
    '  run them in order, either red = fix cycle. exit 1 {ok:false, error} when round R has no recorded review state (fail closed)',
    '  verify.max_parallel_full set: the full commands above come back as `node ~/.claude/pipeline/bin/pipeline.mjs verify slot --run [--only STEPS]`',
    'pipeline verify slot --run [--only STEP,STEP...] [--repo DIR]   wait for a free slot, run the repo\'s verify.full (with --only STEPS appended; npm gets "--" first),',
    '  inherited stdio, free the slot when it ends; exit code = verify.full\'s. It runs nothing else: any other argument, or "--", is a usage error (exit 2).',
    '  Slots are machine-wide (all repos); the limit is verify.max_parallel_full of the repo it runs in; unset = it runs at once. Waiters go in arrival order.',
    '  One stderr line before verify.full starts: {"slot":{index,of,waitedSeconds,loadWaitSeconds,warnings}}. With verify.max_load it then waits (5-30 s jitter between',
    '  checks, at most verify.max_load_wait_minutes) while the 1-minute load average is above it, and proceeds with a warning when the time is up.',
    '  SIGINT/SIGTERM/SIGHUP go to the running verify. STEPS: letters, digits and . _ : - only, no repeats, each in verify.expected_steps when that is set.',
    'pipeline verify slot --status   -> {ok, lockDir, holders[{index,pid,host,startedAt,alive}], waiters[{seq,pid,host,alive}]}   (read only; the whole machine)',
  ].join('\n'),
};

// `--only` takes a comma list (template scripts/verify.mjs). npm swallows flags that come before `--`, so an
// `npm run ...` command gets one inserted unless it already forwards its arguments.
export function withOnly(command, steps) {
  const only = `--only ${steps.join(',')}`;
  const trimmed = command.trim();
  const forwards = /\s--(\s|$)/.test(trimmed);
  return /^npm\s+run(\s|$)/.test(trimmed) && !forwards ? `${trimmed} -- ${only}` : `${trimmed} ${only}`;
}

// Paths of `git diff -M --name-status -z from..to`, a rename counted on BOTH sides (moving a file out of a mapped
// directory is as relevant as moving one in). In first-seen order, no repeats.
export function changedPaths(from, to, o) {
  const out = git(['diff', '-M', '--name-status', '-z', '--no-color', '--no-ext-diff', `${from}..${to}`], o);
  const parts = out.split('\0');
  const paths = new Set();
  for (let i = 0; i < parts.length; ) {
    const status = parts[i];
    if (status === '') { i += 1; continue; }
    const two = status[0] === 'R' || status[0] === 'C';
    const names = parts.slice(i + 1, i + (two ? 3 : 2));
    if (names.length !== (two ? 2 : 1) || names.some((n) => n === undefined || n === '')) throw new Fail(EXIT.USAGE, { ok: false, error: 'git', message: `unexpected diff entry near ${JSON.stringify(status)}` });
    for (const n of names) paths.add(n);
    i += 1 + names.length;
  }
  return [...paths];
}

async function planAfterFix(argv, ctx) {
  const { values } = parseCommandArgs(argv, { repo: { type: 'string' }, round: { type: 'string' } }, { allowPositionals: false });
  const round = intOption(values, 'round', { required: true, min: 1 });
  const root = resolveRepo(values, ctx);
  const { config } = await requireConfig(root);
  const { full, quick, after_fix: mode, after_fix_steps_by_path: byPath = {}, max_parallel_full: slots } = config.verify;
  // Every full run (a --only run too: it executes the database steps) takes a slot when the repo limits parallel full verifies.
  const fullRun = (steps = []) => (slots !== undefined ? slotRunCommand(steps) : steps.length > 0 ? withOnly(full, steps) : full);
  const o = { cwd: root };
  const head = headSha(o);

  if (mode !== 'quick') {
    return { exitCode: EXIT.OK, output: { ok: true, mode: 'full', commands: [fullRun()], matchedSteps: [], base: null, head, files: [] } };
  }

  // The head round R was reviewed at: the fixes to verify are everything committed after it. No record, no plan
  // ("quick only" would silently skip the database steps a fix may need).
  let state;
  try {
    state = loadState(root);
  } catch (err) {
    throw new Fail(EXIT.FAILED, { ok: false, error: 'state', message: err.message });
  }
  const found = state?.rounds?.find((r) => r.n === round);
  if (!found || typeof found.toHead !== 'string' || found.toHead === '') {
    throw new Fail(EXIT.FAILED, { ok: false, error: 'no-round-state', message: `no review state for round ${round} (.review/state.json): cannot tell which commits the fixes are; run the full verify (${fullRun()})` });
  }
  const base = revParse(found.toHead, o);
  if (!isAncestor(base, head, o)) {
    throw new Fail(EXIT.FAILED, { ok: false, error: 'base-not-ancestor', message: `round ${round}'s reviewed head ${base} is not an ancestor of HEAD ${head} (history was rewritten); run the full verify (${fullRun()})` });
  }

  const files = changedPaths(base, head, o);
  const matchedSteps = [];
  for (const [glob, steps] of Object.entries(byPath)) {
    if (!files.some((f) => matchGlob(f, glob))) continue;
    for (const s of steps) if (!matchedSteps.includes(s)) matchedSteps.push(s);
  }
  const commands = [quick, ...(matchedSteps.length > 0 ? [fullRun(matchedSteps)] : [])];
  return { exitCode: EXIT.OK, output: { ok: true, mode: 'quick', commands, matchedSteps, base, head, files } };
}

// ---------------------------------------------------------------------------------------------------------------------
// slot: at most `verify.max_parallel_full` full verifies at once on this machine (all repos), in arrival order.
//   slots   = the machine locks `verify-full-slot-<i>` (i < n) in the lock directory; the owner is the wrapper process.
//   tickets = files `verify-full-queue/<seq>-<pid>-<rand>.ticket` (written whole, then renamed into place, so a reader never
//             sees half a ticket). A waiter may try the slots only when no LIVE older ticket exists; a ticket whose owner is
//             dead on this host (the same rule as locks.mjs) is skipped and removed. The ticket is dropped once a slot is held.
const SLOT_PREFIX = 'verify-full-slot-';
const QUEUE_DIR = 'verify-full-queue';
const TICKET_RE = /^(\d{10})-(\d+)-([0-9a-f]+)\.ticket$/;
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];
const DEFAULT_POLL_MS = 1000; // keep <= 2000: a queue should notice a freed slot quickly
export const defaultJitterMs = () => 5000 + Math.random() * 25000;
const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// What plan-after-fix prints for a full verify that must take a slot. Step names are shell-safe (config validation), so no quoting.
export const SLOT_RUN = 'node ~/.claude/pipeline/bin/pipeline.mjs verify slot --run';
export const slotRunCommand = (steps = []) => (steps.length > 0 ? `${SLOT_RUN} --only ${steps.join(',')}` : SLOT_RUN);

const ticketOrder = (a, b) => a.seq - b.seq || a.pid - b.pid || (a.rand < b.rand ? -1 : a.rand > b.rand ? 1 : 0);

// Is the process behind a lock/ticket owner provably gone? Only for an owner on THIS machine (same host name or machine id).
function ownerGone(owner, env) {
  const local = owner.host === env.host || (Boolean(env.machine) && owner.machineId === env.machine);
  return local && !env.isAlive(owner.pid);
}

// Every well-formed ticket, oldest first, with `alive` judged. Unreadable tickets are live for INCOMPLETE_STALE_MS, then dead.
function readTickets(queueDir, env) {
  let names;
  try {
    names = fs.readdirSync(queueDir);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const out = [];
  for (const name of names) {
    const m = TICKET_RE.exec(name);
    if (!m) continue;
    const file = path.join(queueDir, name);
    let owner = null;
    try {
      owner = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') continue; // dropped meanwhile
    }
    const usable = owner && Number.isInteger(owner.pid) && owner.pid > 0 && typeof owner.host === 'string';
    let alive = true;
    if (usable) alive = !ownerGone(owner, env);
    else {
      try {
        alive = Date.now() - fs.statSync(file).mtimeMs <= INCOMPLETE_STALE_MS;
      } catch {
        continue;
      }
    }
    out.push({ name, file, seq: Number(m[1]), pid: Number(m[2]), rand: m[3], host: usable ? owner.host : null, alive });
  }
  return out.sort(ticketOrder);
}

function takeTicket(queueDir, env) {
  fs.mkdirSync(queueDir, { recursive: true });
  const seq = readTickets(queueDir, env).reduce((max, t) => Math.max(max, t.seq), 0) + 1;
  const rand = randomBytes(4).toString('hex');
  const name = `${String(seq).padStart(10, '0')}-${env.pid}-${rand}.ticket`;
  const tmp = path.join(queueDir, `.tmp-${env.pid}-${rand}`);
  fs.writeFileSync(tmp, JSON.stringify({ pid: env.pid, host: env.host, ...(env.machine ? { machineId: env.machine } : {}), createdAt: new Date().toISOString() }));
  fs.renameSync(tmp, path.join(queueDir, name));
  return { name, file: path.join(queueDir, name), seq, pid: env.pid, rand };
}

const dropQuietly = (file) => fs.rmSync(file, { force: true });

// One pass for the ticket holder: true when nobody live is ahead (dead tickets ahead are removed on the way).
function atFront(queueDir, mine, env) {
  let front = true;
  for (const t of readTickets(queueDir, env)) {
    if (ticketOrder(t, mine) >= 0) continue;
    if (t.alive) front = false;
    else dropQuietly(t.file);
  }
  return front;
}

function tryTakeSlot(n, env) {
  for (let i = 0; i < n; i++) {
    const r = tryAcquire(`${SLOT_PREFIX}${i}`, { dir: env.lockDir, pid: env.pid, host: env.host, machineId: env.machine, isAlive: env.isAlive });
    if (r.acquired) return { index: i, lock: r.lock };
  }
  return null;
}

const signalExit = (sig) => 128 + (os.constants.signals[sig] ?? 0);

function exitCodeOf(code, signal) {
  if (Number.isInteger(code)) return code;
  return signal ? signalExit(signal) : 1;
}

/**
 * Run `command` (a shell line) once a slot is free; resolves with the exit code the wrapper should exit with.
 * Everything time- or machine-dependent is injectable for tests (now, sleep, jitterMs, loadavg, platform, isAlive, spawnFn, proc).
 * n === undefined: no limit, the command runs at once (and no load check).
 */
export async function runWithSlot({
  command,
  cwd,
  n,
  maxLoad,
  maxLoadWaitMinutes = 10,
  lockDir = defaultLockDir(),
  pollMs = DEFAULT_POLL_MS,
  jitterMs = defaultJitterMs,
  sleep = realSleep,
  now = Date.now,
  loadavg = os.loadavg,
  platform = process.platform,
  isAlive = isPidAlive,
  pid = process.pid,
  host = os.hostname(),
  machine = machineId(),
  stderr = process.stderr,
  spawnFn = spawn,
  proc = process,
  env: childEnv = process.env,
}) {
  const env = { lockDir, pid, host, machine, isAlive };
  const queueDir = path.join(lockDir, QUEUE_DIR);
  const warnings = [];
  let received = null; // first termination signal seen
  let child = null;
  const handlers = SIGNALS.map((sig) => [sig, () => { received ??= sig; if (child) child.kill(sig); }]);
  for (const [sig, fn] of handlers) proc.on(sig, fn);

  let ticket = null;
  let held = null;
  const started = now();
  let waitedMs = 0;
  let loadWaitedMs = 0;
  try {
    if (n !== undefined) {
      ticket = takeTicket(queueDir, env);
      for (;;) {
        if (received) return signalExit(received);
        if (atFront(queueDir, ticket, env)) {
          held = tryTakeSlot(n, env);
          if (held) break;
        }
        await sleep(pollMs);
      }
      dropQuietly(ticket.file);
      ticket = null;
      waitedMs = now() - started;

      if (maxLoad !== undefined) {
        if (platform === 'win32') {
          warnings.push('load check skipped: the load average is not available on Windows');
        } else {
          const loadStarted = now();
          const limitMs = maxLoadWaitMinutes * 60_000;
          while (loadavg()[0] > maxLoad) {
            if (received) return signalExit(received);
            if (now() - loadStarted >= limitMs) {
              warnings.push(`load ${loadavg()[0].toFixed(1)} still above verify.max_load ${maxLoad} after ${maxLoadWaitMinutes} min: running anyway`);
              break;
            }
            await sleep(jitterMs());
          }
          loadWaitedMs = now() - loadStarted;
        }
      }
    }
    if (received) return signalExit(received);

    const slot = { index: held ? held.index : null, of: n ?? null, waitedSeconds: Math.round(waitedMs / 1000), loadWaitSeconds: Math.round(loadWaitedMs / 1000), warnings };
    stderr.write(`${JSON.stringify({ slot })}\n`);

    return await new Promise((resolve) => {
      try {
        child = spawnFn(command, { shell: true, cwd, env: childEnv, stdio: 'inherit' });
      } catch (err) {
        stderr.write(`verify slot: could not start the command: ${err.message}\n`);
        resolve(127);
        return;
      }
      child.on('error', (err) => {
        stderr.write(`verify slot: could not run the command: ${err.message}\n`);
        resolve(127);
      });
      child.on('close', (code, signal) => resolve(exitCodeOf(code, signal)));
      if (received) child.kill(received); // a signal landed between the last check and the spawn
    });
  } finally {
    for (const [sig, fn] of handlers) proc.off(sig, fn);
    if (ticket) dropQuietly(ticket.file);
    if (held) {
      try {
        release(held.lock);
      } catch {
        /* a dead owner is reclaimed by the next taker */
      }
    }
  }
}

// Read only: who holds a slot and who waits, for the whole machine.
export function slotStatus({ lockDir = defaultLockDir(), isAlive = isPidAlive, host = os.hostname(), machine = machineId() } = {}) {
  const env = { lockDir, host, machine, isAlive };
  let names = [];
  try {
    names = fs.readdirSync(lockDir);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const holders = [];
  for (const file of names) {
    const m = /^verify-full-slot-(\d+)\.lock$/.exec(file);
    if (!m) continue;
    const owner = inspect(`${SLOT_PREFIX}${m[1]}`, { dir: lockDir });
    if (!owner) continue;
    holders.push({ index: Number(m[1]), pid: owner.pid, host: owner.host, startedAt: owner.startedAt, alive: owner.incomplete ? true : !ownerGone(owner, env) });
  }
  holders.sort((a, b) => a.index - b.index);
  const waiters = readTickets(path.join(lockDir, QUEUE_DIR), env).map((t) => ({ seq: t.seq, pid: t.pid, host: t.host, alive: t.alive }));
  return { ok: true, lockDir, holders, waiters };
}

// The flags of `slot --run` that become part of the verify.full command line, each with its own validation. A new flag
// (a later feature) is one more entry: { parse(value, config) -> the argument text appended to verify.full }.
const RUN_FLAGS = {
  only: {
    option: { type: 'string' },
    parse(raw, verify) {
      const steps = raw.split(',');
      if (steps.some((n) => !SAFE_STEP.test(n))) throw new UsageError('verify slot --only: step names may only use letters, digits and . _ : - (comma separated)');
      if (new Set(steps).size !== steps.length) throw new UsageError('verify slot --only: a step is listed twice');
      const unknown = Array.isArray(verify.expected_steps) ? steps.filter((n) => !verify.expected_steps.includes(n)) : [];
      if (unknown.length > 0) throw new UsageError(`verify slot --only: not in verify.expected_steps: ${unknown.join(', ')}`);
      return { steps };
    },
  },
};

// The one command `slot --run` may start: verify.full from the config, plus the validated flags. Exported for tests.
export function slotRunLine(verify, flags) {
  const steps = flags.only !== undefined ? RUN_FLAGS.only.parse(flags.only, verify).steps : [];
  return steps.length > 0 ? withOnly(verify.full, steps) : verify.full;
}

// Test seams (environment): PIPELINE_LOCK_DIR moves the machine lock directory, PIPELINE_SLOT_POLL_MS the queue poll interval.
async function slotCommand(rest, ctx) {
  // No "--" and no positional argument: nothing the caller types is ever run (see the header).
  if (rest.includes('--')) throw new UsageError('verify slot takes no command: it runs verify.full from the config (pipeline verify slot --run [--only STEPS])');
  const options = { run: { type: 'boolean' }, status: { type: 'boolean' }, repo: { type: 'string' }, ...Object.fromEntries(Object.entries(RUN_FLAGS).map(([k, f]) => [k, f.option])) };
  const { values, positionals } = parseCommandArgs(rest, options);
  if (positionals.length > 0) throw new UsageError(`verify slot takes no command (got ${JSON.stringify(positionals[0])}): it runs verify.full from the config`);
  if (Boolean(values.run) === Boolean(values.status)) throw new UsageError('verify slot needs exactly one of --run or --status');
  const env = ctx?.env ?? process.env;
  const lockDir = env.PIPELINE_LOCK_DIR || defaultLockDir();
  const flags = Object.fromEntries(Object.keys(RUN_FLAGS).filter((k) => values[k] !== undefined).map((k) => [k, values[k]]));

  if (values.status) {
    if (Object.keys(flags).length > 0 || values.repo !== undefined) throw new UsageError('verify slot --status takes no other option');
    return { exitCode: EXIT.OK, output: slotStatus({ lockDir }) };
  }

  const root = resolveRepo(values, ctx);
  const { config } = await requireConfig(root);
  const { max_parallel_full: n, max_load: maxLoad, max_load_wait_minutes: maxLoadWaitMinutes } = config.verify;
  const command = slotRunLine(config.verify, flags); // validates every flag before anything is spawned
  const poll = Number(env.PIPELINE_SLOT_POLL_MS);
  const code = await runWithSlot({ command, cwd: root, n, maxLoad, maxLoadWaitMinutes, lockDir, env, ...(poll > 0 ? { pollMs: poll } : {}) });
  // The verify's own output owns stdout, so no JSON result is printed: leave with its exit code directly.
  process.exit(code);
}

export const run = guarded(async (argv, ctx) => {
  const [sub, ...rest] = argv;
  if (sub === 'plan-after-fix') return planAfterFix(rest, ctx);
  if (sub === 'slot') return slotCommand(rest, ctx);
  throw new UsageError('usage: pipeline verify (plan-after-fix --round R [--repo DIR] | slot --run [--only STEPS] [--repo DIR] | slot --status)');
});
