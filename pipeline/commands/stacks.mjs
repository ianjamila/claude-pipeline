// `pipeline stacks`: automatic stop of private local Supabase stacks (and a session's own dev server) once nobody needs them.
// Spec: docs/specs/2026-10-19-stack-stop-design.md. Subcommands: `sweep` (the daily sweep, lib/stacks/sweep.mjs), `session-end`
// (the detached worker the SessionEnd hook starts, lib/stacks/session-end.mjs), `status`, `repair` (moves damaged lines of the
// lease ledger and the decisions log aside), `init` (the proposed machine config; written only with --write and only if absent)
// and `schedule` (one launchd LaunchAgent / cron line that runs `stacks sweep --apply --summary-only`; helpers: lib/schedule.mjs).
// Exit 0 done, 1 a repair or stop that failed, 2 usage / not supported / refused. Windows: every subcommand answers "not
// supported on Windows" (exit 2).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXIT, UsageError, parseCommandArgs } from '../lib/cli.mjs';
import {
  AT_RE, DARWIN_TZ_SOURCES, applyLaunchd, applySchedule, detectTimezone, findOnPath, scheduleLabel, scheduleLine, scheduleMarker, schedulePlist,
  systemCrontab, systemLaunchctl,
} from '../lib/schedule.mjs';
import { pruneLogDir } from '../lib/worktree-prune/run.mjs';
import { loadMachineConfig, loadModes, isPaused } from '../lib/stacks/config.mjs';
import { isAlive as realIsAlive } from '../lib/stacks/identity.mjs';
import { cachedInventory } from '../lib/stacks/inventory.mjs';
import { repairLedger } from '../lib/stacks/ledger.mjs';
import { StacksIsolationError, isolation, stackFiles, stacksRoot } from '../lib/stacks/paths.mjs';
import { readLedgerLocked } from '../lib/stacks/assess.mjs';
import { resolveProbeBins } from '../lib/stacks/evidence.mjs';
import { runSessionEnd } from '../lib/stacks/session-end.mjs';
import { currentLeases, runSweep } from '../lib/stacks/sweep.mjs';

export const meta = {
  summary: 'stop private local Supabase stacks and dev servers once nobody needs them (daily sweep, session-end worker, status, repair, init, schedule).',
  usage: [
    'pipeline stacks sweep [--apply] [--summary-only]   -> {ok, summary, stopped:[...], wouldStop:[...], listed:[...], kept:[...]}',
    'pipeline stacks session-end --owner PID:BIRTH   -> {ok, waited, stacks:[...], dev:[...]}',
    'pipeline stacks status   -> {ok, configured, modes, paused, leases:[...], report}',
    'pipeline stacks repair   -> {ok, moved}',
    'pipeline stacks init [--write]   -> {ok, config, written}',
    'pipeline stacks schedule (--install [--at HH:MM] | --remove | --status)   -> {ok, installed|removed, label, timezone, warning?}',
  ].join('\n'),
};

const SUBS = 'sweep [--apply] [--summary-only] | session-end --owner PID:BIRTH | status | repair | init [--write] | schedule (--install [--at HH:MM] | --remove | --status)';
const OWNER_RE = /^(\d+):(\d+)$/;
const DEFAULT_AT = '09:12';
const SCHEDULE_NAME = 'stacks-sweep';
const SWEEP_ARGS = Object.freeze(['stacks', 'sweep', '--apply', '--summary-only']);
const BIN_PATH = fileURLToPath(new URL('../bin/pipeline.mjs', import.meta.url));

export function parseOwner(text) {
  const m = OWNER_RE.exec(String(text ?? ''));
  if (!m) throw new UsageError('--owner must be PID:BIRTH (birth = epoch seconds)');
  const owner = { pid: Number(m[1]), birth: Number(m[2]) };
  if (!Number.isSafeInteger(owner.pid) || owner.pid < 1 || !Number.isSafeInteger(owner.birth)) throw new UsageError('--owner must be PID:BIRTH (birth = epoch seconds)');
  return owner;
}

// The machine config this Mac needs; `init` prints it and `--write` stores it (only if config.json is absent).
export const proposedConfig = () => ({
  shared: ['e2e-ci', 'DRMed', 'eaglewatch-pipeline'],
  repos: ['~/Claude/eaglewatch', '~/Claude/DRMed'],
  memoryDirs: ['~/claude-memory/home', '~/claude-memory/eaglewatch', '~/claude-memory/drmed'],
  memoryExclude: ['supabase-stack-autostop.md', 'MEMORY-archive.md'],
  devPorts: [3000, 4000, 4017],
});

const refused = (message, error = 'refused') => ({ exitCode: EXIT.USAGE, output: { ok: false, error, message } });

// Where this run keeps its state, or the refusal when a non-default root names no PIPELINE_STACKS_ONLY.
function place(ctx) {
  const env = ctx?.env ?? process.env;
  const home = ctx?.home ?? os.homedir();
  const root = stacksRoot(env, home);
  try {
    isolation(env, root, { home });
  } catch (err) {
    if (err instanceof StacksIsolationError) return { fail: refused(err.message, 'isolation') };
    throw err;
  }
  return { env, home, root, files: stackFiles(root) };
}

const sweepDeps = (ctx) => ({
  ...(ctx?.env ? { env: ctx.env } : {}), ...(ctx?.home ? { home: ctx.home } : {}), ...(ctx?.platform ? { platform: ctx.platform } : {}), ...(ctx?.deps ?? {}),
});

async function sweep(rest, ctx) {
  const { values, positionals } = parseCommandArgs(rest, { apply: { type: 'boolean' }, 'summary-only': { type: 'boolean' } });
  if (positionals.length) throw new UsageError('stacks sweep takes no arguments');
  const result = await runSweep({ apply: Boolean(values.apply), deps: sweepDeps(ctx) });
  const exitCode = result.ok ? EXIT.OK : EXIT.USAGE;
  if (!values['summary-only']) return { exitCode, output: result };
  if (!result.ok) return { exitCode, output: { ok: false, summary: result.message ?? result.error }, compact: true };
  const errors = [...(result.failed ?? []).map((f) => `${f.project}: ${(f.reasons ?? []).join('; ')}`), ...((result.stopped ?? []).filter((s) => s.alert).map((s) => `${s.project}: ${s.alert}`))];
  return { exitCode, output: { ok: result.ok, summary: result.summary, ...(errors.length ? { errors } : {}) }, compact: true };
}

async function sessionEnd(rest, ctx) {
  const { values } = parseCommandArgs(rest, { owner: { type: 'string' } }, { allowPositionals: false });
  const owner = parseOwner(values.owner);
  const result = await runSessionEnd({ owner, deps: sweepDeps(ctx) });
  return { exitCode: EXIT.OK, output: { ok: true, ...result }, compact: true };
}

async function status(rest, ctx) {
  const { positionals } = parseCommandArgs(rest, {});
  if (positionals.length) throw new UsageError('stacks status takes no arguments');
  const p = place(ctx);
  if (p.fail) return p.fail;
  const { env, home, root, files } = p;
  const platform = ctx?.platform ?? process.platform;
  const cfg = loadMachineConfig(files.config, { home });
  const events = await readLedgerLocked({ files, root });
  const bins = resolveProbeBins({ env, home });
  const isAlive = ctx?.isAlive ?? ((o) => realIsAlive(o, { ps: bins.ps, platform }));
  const cached = cachedInventory({ file: files.cache, maxAgeMs: Infinity });
  const leases = events.ok ? currentLeases(events.value, { stacks: cached.inv?.stacks ?? [], isAlive }) : [];
  let report = null;
  try {
    fs.statSync(files.report);
    report = files.report;
  } catch {
    report = null;
  }
  return {
    exitCode: EXIT.OK,
    output: {
      ok: true, configured: cfg.status === 'ok', config: cfg.status, ...(cfg.error ? { configError: cfg.error } : {}), root, modes: loadModes(files.mode), paused: isPaused(files.pause),
      ledger: events.ok ? { ok: true } : { ok: false, reason: events.reason }, leases, report,
    },
  };
}

// Moves the damaged lines of BOTH append-only files aside (the lease ledger, the decisions log), each under its own lock.
async function repair(rest, ctx) {
  const { positionals } = parseCommandArgs(rest, {});
  if (positionals.length) throw new UsageError('stacks repair takes no arguments');
  const p = place(ctx);
  if (p.fail) return p.fail;
  const { root, files } = p;
  const ledger = await repairLedger(files.ledger, files.ledgerBad);
  const actions = await repairLedger(files.actions, path.join(root, 'actions.bad.jsonl'), { lockDir: path.join(files.locks, 'actions') });
  const failed = [['ledger', ledger], ['actions', actions]].filter(([, r]) => !r.ok).map(([name, r]) => `${name}: ${r.reason}`);
  const moved = { ledger: ledger.ok ? ledger.value.moved : null, actions: actions.ok ? actions.value.moved : null };
  if (failed.length) return { exitCode: EXIT.FAILED, output: { ok: false, error: 'repair', message: failed.join('; '), moved } };
  return { exitCode: EXIT.OK, output: { ok: true, moved } };
}

async function init(rest, ctx) {
  const { values, positionals } = parseCommandArgs(rest, { write: { type: 'boolean' } });
  if (positionals.length) throw new UsageError('stacks init takes no arguments');
  const p = place(ctx);
  if (p.fail) return p.fail;
  const config = proposedConfig();
  const output = { ok: true, config, written: false, path: p.files.config };
  if (values.write) {
    try {
      fs.mkdirSync(p.root, { recursive: true, mode: 0o700 });
      fs.writeFileSync(p.files.config, `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      output.written = true;
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
      output.note = `${p.files.config} already exists: left untouched`;
    }
  }
  return { exitCode: EXIT.OK, output };
}

// The tools the job needs that live outside launchd's / cron's own PATH. Missing ones are reported, not fatal: the sweep itself
// fails closed (a stack it cannot assess is listed), and docker / supabase also have fixed install-dir fallbacks.
const JOB_TOOLS = ['git', 'gh', 'docker', 'supabase'];

async function schedule(rest, ctx) {
  const { values, positionals } = parseCommandArgs(rest, { install: { type: 'boolean' }, remove: { type: 'boolean' }, status: { type: 'boolean' }, at: { type: 'string' } });
  if (positionals.length) throw new UsageError('stacks schedule takes no arguments');
  const actions = ['install', 'remove', 'status'].filter((a) => values[a]);
  if (actions.length !== 1) throw new UsageError('stacks schedule needs exactly one of --install, --remove, --status');
  const [action] = actions;
  if (values.at !== undefined && action !== 'install') throw new UsageError('stacks schedule: --at only goes with --install');
  const at = values.at ?? DEFAULT_AT;
  if (!AT_RE.test(at)) throw new UsageError(`--at must be HH:MM (00-23:00-59), got ${JSON.stringify(at)}`);
  const env = ctx?.env ?? process.env;
  // R2-7: the job runs against the DEFAULT state root and carries no PIPELINE_STACKS_* variable, so an isolated shell must not install it.
  if (env.PIPELINE_STACKS_HOME) return refused('schedule works only for the default state root (PIPELINE_STACKS_HOME is set)');
  const platform = ctx?.platform ?? process.platform;
  if (platform !== 'linux' && platform !== 'darwin') return refused('schedule is only supported on Linux (cron) and macOS (launchd)', 'unsupported-platform');
  const darwin = platform === 'darwin';
  const home = ctx?.home ?? os.homedir();
  const label = scheduleLabel(SCHEDULE_NAME);
  const marker = scheduleMarker(SCHEDULE_NAME, 'stacks');
  let line;
  let plist;
  let notFound = [];
  if (action === 'install') {
    const which = ctx?.whichFn ?? ((cmd) => findOnPath(cmd, env.PATH));
    const nodePath = ctx?.nodePath ?? process.execPath;
    const logDir = pruneLogDir(env);
    fs.mkdirSync(logDir, { recursive: true });
    const found = JOB_TOOLS.map((t) => [t, which(t)]);
    notFound = found.filter(([, p]) => !p).map(([t]) => t);
    const args = {
      nodePath, binPath: ctx?.binPath ?? BIN_PATH, root: home, at, args: [...SWEEP_ARGS],
      pathDirs: [...new Set([nodePath, ...found.map(([, p]) => p).filter(Boolean)].map((p) => path.dirname(p)))],
      logFile: path.join(logDir, `cron-${SCHEDULE_NAME}.log`),
    };
    if (darwin) plist = schedulePlist({ ...args, label });
    else line = scheduleLine({ ...args, lockName: SCHEDULE_NAME, kind: 'stacks' });
  }
  let result;
  if (darwin) {
    const plistPath = path.join(home, 'Library', 'LaunchAgents', `${label}.plist`);
    result = applyLaunchd({
      action, plist, plistPath, label, launchctlFn: ctx?.launchctlFn ?? systemLaunchctl,
      tzFn: ctx?.tzFn ?? (() => detectTimezone(DARWIN_TZ_SOURCES)), uid: ctx?.uid ?? process.getuid(),
    });
  } else {
    result = applySchedule({ action, line, marker, crontabFn: ctx?.crontabFn ?? systemCrontab, tzFn: ctx?.tzFn ?? detectTimezone });
  }
  return { exitCode: EXIT.OK, output: { ok: true, label, ...result, ...(notFound.length ? { notFound } : {}) } };
}

export async function run(argv, ctx = {}) {
  const [sub, ...rest] = argv;
  if ((ctx?.platform ?? process.platform) === 'win32') return { exitCode: EXIT.USAGE, output: { ok: false, error: 'not supported on Windows' } };
  if (sub === 'sweep') return sweep(rest, ctx);
  if (sub === 'session-end') return sessionEnd(rest, ctx);
  if (sub === 'status') return status(rest, ctx);
  if (sub === 'repair') return repair(rest, ctx);
  if (sub === 'init') return init(rest, ctx);
  if (sub === 'schedule') return schedule(rest, ctx);
  throw new UsageError(`usage: pipeline stacks (${SUBS})${sub ? `; got ${JSON.stringify(sub)}` : ''}`);
}
