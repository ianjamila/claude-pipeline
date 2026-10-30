// `pipeline worktrees`: remove finished worktrees safely (prune), protect one with a keep-lock (keep / unkeep), and look
// at or purge the holding folder where removed worktrees' evidence waits 30 days (holding). Spec:
// docs/specs/2026-10-13-worktree-prune-design.md. One `worktrees.mode` setting governs every mutation: `report` (the
// default) and `off` change nothing, `--dry-run` never changes anything; keep-locks only protect, so they work in every
// mode. The prune flow lives in lib/worktree-prune/run.mjs. Exit 0 completed (skips are normal), 2 usage / repo / config,
// 3 GitHub unavailable. `schedule` adds, removes or reports one nightly cron line that runs `prune --summary-only` (Linux, cron) or one launchd LaunchAgent (macOS).
// `--notify` is an accepted no-op: schedules installed before notifications were removed still pass it.
import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXIT, UsageError, errorResult, parseCommandArgs } from '../lib/cli.mjs';
import { Fail, guarded } from '../lib/cmd-common.mjs';
import { git } from '../lib/git.mjs';
import { listWorktrees } from '../lib/local-branches.mjs';
import { samePath } from '../lib/paths.mjs';
import {
  AT_RE, DARWIN_TZ_SOURCES, applyLaunchd, applySchedule, detectTimezone, findOnPath, scheduleLabel, scheduleLine, scheduleMarker, schedulePlist,
  systemCrontab, systemLaunchctl,
} from '../lib/schedule.mjs';
import { holdingRoot, listHolding, purgeHoldingLocked } from '../lib/worktree-prune/act.mjs';
import { KEEP_PREFIX, lockNameFor, modeAllows } from '../lib/worktree-prune/rules.mjs';
import { loadRepo, prune, pruneLogDir, summaryOnly } from '../lib/worktree-prune/run.mjs';

export const meta = {
  summary: 'remove finished worktrees (prune), keep one with a lock (keep / unkeep), list or purge the holding folder',
  usage: [
    'pipeline worktrees prune [--repo DIR] [--dry-run] [--notify] [--summary-only]   (--notify: accepted, does nothing; old schedules pass it)   -> {ok, mode, removed:[...], wouldRemove:[...], kept:[...], hiddenProcesses, restored:[...], outside:[...], holding:{batches, purged}, summary, log} | --summary-only: one line {ok, summary, errors?}',
    'pipeline worktrees keep NAME [--reason TEXT] [--repo DIR]   -> {ok, slug, locked}',
    'pipeline worktrees unkeep NAME [--run ID] [--repo DIR]   -> {ok, slug, unlocked}',
    'pipeline worktrees holding [--purge] [--repo DIR]   -> {ok, batches:[...], purged:[...]}',
    'pipeline worktrees schedule (--install [--at HH:MM] | --remove | --status) [--repo DIR]   -> {ok, installed, line, timezone, warning?} | {ok, removed} | {ok, installed, line}   (macOS: a launchd LaunchAgent; adds plist, changed, loaded, note)',
  ].join('\n'),
};

export { KEEP_PREFIX };
export { applyLaunchd, applySchedule, detectTimezone, findOnPath, scheduleLabel, scheduleLine, scheduleMarker, schedulePlist } from '../lib/schedule.mjs';
const SUBS = 'prune [--dry-run] [--notify] [--summary-only] | keep NAME [--reason TEXT] | unkeep NAME [--run ID] | holding [--purge] | schedule (--install [--at HH:MM] | --remove | --status)';

// NAME is a direct child of <root>/<worktree_dir>: no separators, no dot-names (the quarantine), no control characters.
function findWorktree(repo, positionals, sub) {
  if (positionals.length !== 1) throw new UsageError(`worktrees ${sub} takes exactly one NAME`);
  const [name] = positionals;
  if (!/^[^/\\.\x00-\x1f][^/\\\x00-\x1f]*$/.test(name)) throw new UsageError(`not a worktree name: ${JSON.stringify(name)}`);
  const target = path.join(repo.root, repo.worktreeDir, name);
  const entry = listWorktrees(repo.root).find((e) => samePath(e.path, target));
  if (!entry) throw new Fail(EXIT.USAGE, { ok: false, error: 'no-such-worktree', message: `no worktree at ${target}` });
  return { name, entry };
}

// "pipeline-keep: ship run 7" -> "7"; null when the reason names no ship run.
const shipRunOf = (reason) => /ship run ([A-Za-z0-9_-]+)/.exec(reason)?.[1] ?? null;

async function keep(rest, ctx) {
  const { values, positionals } = parseCommandArgs(rest, { repo: { type: 'string' }, reason: { type: 'string' } });
  const text = values.reason?.trim() || 'kept by hand';
  if (/[\x00-\x1f]/.test(text)) throw new UsageError('--reason must be one line');
  const repo = await loadRepo(values, ctx);
  const { name, entry } = findWorktree(repo, positionals, 'keep');
  if (!modeAllows(repo.w.mode, 'keep-lock')) return { exitCode: EXIT.OK, output: { ok: true, slug: name, locked: false, reason: 'keep locks are disabled' } };
  if (entry.locked !== null && !entry.locked.startsWith(KEEP_PREFIX)) {
    return { exitCode: EXIT.OK, output: { ok: true, slug: name, locked: false, reason: 'already locked by someone else' } };
  }
  const reason = `${KEEP_PREFIX} ${text}`;
  // A keep lock owned by a ship run is that run's to release: never overwrite it by hand or hand it to another run.
  const owner = entry.locked !== null ? shipRunOf(entry.locked) : null;
  if (owner !== null && shipRunOf(reason) !== owner) {
    return { exitCode: EXIT.OK, output: { ok: true, slug: name, locked: false, reason: `kept by another run (ship run ${owner})` } };
  }
  if (entry.locked !== null) git(['worktree', 'unlock', entry.path], { cwd: repo.root }); // refresh our own reason
  git(['worktree', 'lock', '--reason', reason, entry.path], { cwd: repo.root });
  return { exitCode: EXIT.OK, output: { ok: true, slug: name, locked: true, reason } };
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Releases only a pipeline-keep lock, and with --run only the one carrying "ship run <ID>" (spec §2 "Locks").
async function unkeep(rest, ctx) {
  const { values, positionals } = parseCommandArgs(rest, { repo: { type: 'string' }, run: { type: 'string' } });
  if (values.run !== undefined && values.run.trim() === '') throw new UsageError('--run must not be empty');
  const repo = await loadRepo(values, ctx);
  const { name, entry } = findWorktree(repo, positionals, 'unkeep');
  const no = (reason) => ({ exitCode: EXIT.OK, output: { ok: true, slug: name, unlocked: false, reason } });
  if (entry.locked === null) return no('not locked');
  if (!entry.locked.startsWith(KEEP_PREFIX)) return no(`locked by someone else (${entry.locked || 'no reason given'})`);
  if (values.run !== undefined && !new RegExp(`ship run ${escapeRe(values.run.trim())}(?![A-Za-z0-9_-])`).test(entry.locked)) {
    return no(`the keep lock belongs to another run (${entry.locked})`);
  }
  git(['worktree', 'unlock', entry.path], { cwd: repo.root });
  return { exitCode: EXIT.OK, output: { ok: true, slug: name, unlocked: true } };
}

async function holding(rest, ctx) {
  const { values, positionals } = parseCommandArgs(rest, { repo: { type: 'string' }, purge: { type: 'boolean' } });
  if (positionals.length) throw new UsageError('worktrees holding takes no NAME');
  const env = ctx?.env ?? process.env;
  const repo = await loadRepo(values, ctx);
  const dir = holdingRoot(repo.slug, env);
  const output = { ok: true, dir, batches: [], purged: [] };
  if (values.purge) {
    if (modeAllows(repo.w.mode, 'purge')) {
      const r = await purgeHoldingLocked(dir, { nowMs: Date.now(), lockDir: env.PIPELINE_LOCK_DIR || undefined });
      output.purged = r.purged;
      output.keptBatches = r.kept;
      if (r.skipped) output.purgeSkipped = r.skipped;
    } else output.note = 'purge needs mode: on';
  }
  output.batches = listHolding(dir);
  return { exitCode: EXIT.OK, output };
}

// ---- schedule: one cron line per repository, found again by the marker comment at its end (helpers: lib/schedule.mjs) ---

const DEFAULT_AT = '02:30';

const BIN_PATH = fileURLToPath(new URL('../bin/pipeline.mjs', import.meta.url));

// git and gh must be found on PATH at install time (the job's own PATH is minimal); null when both are found.
function missingTool(which, why) {
  for (const cmd of ['git', 'gh']) {
    if (!which(cmd)) return { exitCode: EXIT.USAGE, output: { ok: false, error: 'tool-missing', message: `cannot install the schedule: ${cmd} was not found on PATH (${why}, so the job needs to know where it is)` } };
  }
  return null;
}

async function schedule(rest, ctx) {
  const { values, positionals } = parseCommandArgs(rest, {
    repo: { type: 'string' }, install: { type: 'boolean' }, remove: { type: 'boolean' }, status: { type: 'boolean' }, at: { type: 'string' },
  });
  if (positionals.length) throw new UsageError('worktrees schedule takes no NAME');
  const actions = ['install', 'remove', 'status'].filter((a) => values[a]);
  if (actions.length !== 1) throw new UsageError('worktrees schedule needs exactly one of --install, --remove, --status');
  const [action] = actions;
  if (values.at !== undefined && action !== 'install') throw new UsageError('worktrees schedule: --at only goes with --install');
  const at = values.at ?? DEFAULT_AT;
  if (!AT_RE.test(at)) throw new UsageError(`--at must be HH:MM (00-23:00-59), got ${JSON.stringify(at)}`);
  const platform = ctx?.platform ?? process.platform;
  if (platform !== 'linux' && platform !== 'darwin') {
    return { exitCode: EXIT.USAGE, output: { ok: false, error: 'unsupported-platform', message: 'schedule is only supported on Linux (cron) and macOS (launchd)' } };
  }
  const darwin = platform === 'darwin';
  const repo = await loadRepo(values, ctx);
  const lockName = lockNameFor(repo.commonDir);
  const marker = scheduleMarker(lockName);
  const label = scheduleLabel(lockName);
  let line;
  let plist;
  if (action === 'install') {
    const which = ctx?.whichFn ?? ((cmd) => findOnPath(cmd, (ctx?.env ?? process.env).PATH));
    const nodePath = ctx?.nodePath ?? process.execPath;
    const missing = missingTool(which, darwin ? "launchd's own PATH is minimal" : "cron's own PATH is only /usr/bin:/bin");
    if (missing) return missing;
    const logDir = pruneLogDir(ctx?.env ?? process.env);
    mkdirSync(logDir, { recursive: true });
    const args = {
      nodePath, binPath: ctx?.binPath ?? BIN_PATH, root: repo.root, at,
      pathDirs: [...new Set([nodePath, which('git'), which('gh')].map((p) => path.dirname(p)))],
      logFile: path.join(logDir, `cron-${lockName}.log`),
    };
    if (darwin) plist = schedulePlist({ ...args, label });
    else line = scheduleLine({ ...args, lockName });
  }
  let result;
  if (darwin) {
    const plistPath = path.join(ctx?.home ?? os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
    result = applyLaunchd({
      action, plist, plistPath, label, launchctlFn: ctx?.launchctlFn ?? systemLaunchctl,
      tzFn: ctx?.tzFn ?? (() => detectTimezone(DARWIN_TZ_SOURCES)), uid: ctx?.uid ?? process.getuid(),
    });
  } else {
    result = applySchedule({ action, line, marker, crontabFn: ctx?.crontabFn ?? systemCrontab, tzFn: ctx?.tzFn ?? detectTimezone });
  }
  return { exitCode: EXIT.OK, output: { ok: true, ...result } };
}

export const run = guarded(async (argv, ctx) => {
  const [sub, ...rest] = argv;
  if (sub === 'prune') {
    const { values, positionals } = parseCommandArgs(rest, {
      repo: { type: 'string' }, 'dry-run': { type: 'boolean' }, notify: { type: 'boolean' }, 'summary-only': { type: 'boolean' },
    });
    if (positionals.length) throw new UsageError('worktrees prune takes no NAME');
    if (!values['summary-only']) return prune(values, ctx);
    let result;
    try {
      result = await guarded(prune)(values, ctx);
    } catch (err) {
      result = errorResult(err); // GitHub unavailable (exit 3) and the like: one compact line too
    }
    return summaryOnly(result);
  }
  if (sub === 'keep') return keep(rest, ctx);
  if (sub === 'unkeep') return unkeep(rest, ctx);
  if (sub === 'holding') return holding(rest, ctx);
  if (sub === 'schedule') return schedule(rest, ctx);
  throw new UsageError(`usage: pipeline worktrees (${SUBS})`);
});
