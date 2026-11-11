// `pipeline update schedule (--install [--every N] | --remove | --status)`: the recurring job that runs `pipeline update --scheduled --json`
// (lib/auto-update.mjs decides what each run does). macOS: the LaunchAgent `com.claude-pipeline.auto-update`, built with lib/schedule.mjs
// schedulePlist({interval}) + applyLaunchd, like the queue sweep's (it runs at load too, so a Mac waking from sleep catches up; launchd never
// overlaps two runs of one job, and the installer takes its own lock). Linux/WSL: one crontab line through the same cron helpers (scheduleLine /
// applySchedule), found again by its marker comment. Native Windows: unsupported-platform.
// The job runs the INSTALLED pipeline (<home>/.claude/pipeline/bin/pipeline.mjs), never the checkout this command ran from, so the update that
// replaces that folder is what the job runs next time.
// --install arranges for the guard hooks to be replaced unattended: owner only, once per machine, so it refuses inside Claude Code exactly like
// `pipeline update`. --status and --remove (which only take the job away) run anywhere.
import { existsSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EXIT, UsageError, parseCommandArgs } from './cli.mjs';
import { guarded } from './cmd-common.mjs';
import { insideClaudeCode } from './owner-only.mjs';
import { canonicalPath, samePath } from './paths.mjs';
import {
  DARWIN_TZ_SOURCES, applyLaunchd, applySchedule, detectTimezone, findOnPath, scheduleLabel, scheduleLine, scheduleMarker, schedulePlist,
  systemCrontab, systemLaunchctl,
} from './schedule.mjs';
import { pruneLogDir } from './worktree-prune/run.mjs';

export const AUTO_UPDATE_NAME = 'auto-update';
export const AUTO_UPDATE_LABEL = scheduleLabel(AUTO_UPDATE_NAME); // com.claude-pipeline.auto-update
export const AUTO_UPDATE_ARGS = Object.freeze(['update', '--scheduled', '--json']);
export const EVERY_CHOICES = Object.freeze([5, 10, 15, 20, 30, 60]);
export const DEFAULT_EVERY = 15;
const ONCE_AN_HOUR_MINUTE = 17; // `--every 60` fires at a fixed minute past the hour (not the top of it, when everything else runs)

// Divisors of 60 that cron writes as */N; anything else would not fire at even intervals.
export function parseEvery(raw) {
  if (raw === undefined) return DEFAULT_EVERY;
  const n = /^\d+$/.test(String(raw).trim()) ? Number(raw) : NaN;
  if (!EVERY_CHOICES.includes(n)) throw new UsageError(`--every must be one of ${EVERY_CHOICES.join(', ')} (minutes; each divides 60 evenly), got ${JSON.stringify(raw)}`);
  return n;
}

export const cronExpression = (every) => (every === 60 ? `${ONCE_AN_HOUR_MINUTE} * * * *` : `*/${every} * * * *`);

const NOTE = (every) => `runs every ${every} minutes: installs main when this machine is behind it and no review is running, does nothing when current, and tells you only when it needs you. Check with \`pipeline update schedule --status\`; remove with \`--remove\`.`;

// Every path built here is for cron or launchd (Linux/macOS), so it is POSIX-joined whatever host runs it.
export const installedBin = (userHome = os.homedir()) => path.posix.join(userHome, '.claude', 'pipeline', 'bin', 'pipeline.mjs');

export const autoUpdatePlistPath = (userHome = os.homedir()) => path.join(userHome, 'Library', 'LaunchAgents', `${AUTO_UPDATE_LABEL}.plist`);

// The one place the job is installed, removed or asked about: launchd on macOS, one marker-found crontab line otherwise. Throws what applyLaunchd /
// applySchedule throw; `wrote` says whether the crontab was rewritten.
function applyJob({ action, darwin, userHome, plist, line, ctx }) {
  if (darwin) {
    const result = applyLaunchd({
      action, plist, plistPath: autoUpdatePlistPath(userHome), label: AUTO_UPDATE_LABEL, launchctlFn: ctx.launchctlFn ?? systemLaunchctl,
      tzFn: ctx.tzFn ?? (() => detectTimezone(DARWIN_TZ_SOURCES)), uid: ctx.uid ?? process.getuid(),
    });
    return { result, wrote: false };
  }
  const crontab = ctx.crontabFn ?? systemCrontab;
  let wrote = false;
  const crontabFn = (op, text) => { if (op === 'write') wrote = true; return crontab(op, text); };
  const marker = scheduleMarker(AUTO_UPDATE_NAME, 'update');
  const result = applySchedule({ action, line, marker, crontabFn, tzFn: ctx.tzFn ?? detectTimezone });
  delete result.warning; // applySchedule's warning is about a fixed HH:MM; an every-N-minutes job has none
  return { result, wrote };
}

const safeSame = (a, b) => { try { return samePath(canonicalPath(a), canonicalPath(b)); } catch { return false; } };

// What the installer's --uninstall does about the job, the same way it removes the queue sweep's: the job belongs to the machine, not to a claude-home,
// so it goes only when this home IS the user's own ~/.claude and no isolated stacks root is set (a scratch home never removes the real job). Native
// Windows has no job. Nothing installed means nothing done (no launchctl call, no crontab write). Never throws: a failure is `error`.
// -> { applicable: false, why } | { applicable: true, removed } | { applicable: true, error }
export function autoUpdateRemove({ home, env = process.env, platform = process.platform, userHome = os.homedir(), uid = process.getuid?.(), launchctlFn = systemLaunchctl, crontabFn = systemCrontab }) {
  if (platform !== 'darwin' && platform !== 'linux') return { applicable: false, why: 'the automatic-update job is only managed on macOS and Linux/WSL' };
  if (env.PIPELINE_STACKS_HOME) return { applicable: false, why: 'an isolated run (PIPELINE_STACKS_HOME is set) never touches the machine schedule' };
  if (!safeSame(home, path.join(userHome, '.claude'))) return { applicable: false, why: `${home} is not the user's own ~/.claude: the machine schedule is left alone` };
  const darwin = platform === 'darwin';
  try {
    if (darwin && !existsSync(autoUpdatePlistPath(userHome))) return { applicable: true, removed: false };
    const { result } = applyJob({ action: 'remove', darwin, userHome, ctx: { launchctlFn, crontabFn, uid } });
    return { applicable: true, removed: result.removed === true };
  } catch (err) {
    return { applicable: true, error: err?.output?.message ?? err?.message ?? String(err) };
  }
}

const fail = (error, message) => ({ exitCode: EXIT.USAGE, output: { ok: false, error, message } });

export const runSchedule = guarded(async (rest, ctx = {}) => {
  const env = ctx.env ?? process.env;
  const { values, positionals } = parseCommandArgs(rest, {
    install: { type: 'boolean' }, remove: { type: 'boolean' }, status: { type: 'boolean' }, every: { type: 'string' },
  });
  if (positionals.length) throw new UsageError('update schedule takes no arguments besides --install / --remove / --status [--every N]');
  const actions = ['install', 'remove', 'status'].filter((a) => values[a]);
  if (actions.length !== 1) throw new UsageError('update schedule needs exactly one of --install, --remove, --status');
  const [action] = actions;
  if (values.every !== undefined && action !== 'install') throw new UsageError('update schedule: --every only goes with --install');
  const every = parseEvery(values.every);

  if (action === 'install') {
    const inside = insideClaudeCode(env, ctx);
    if (inside) {
      return fail('refused', `pipeline update schedule --install refuses to run inside a Claude Code session (${inside}): it arranges for the guard hooks to be replaced unattended. Run it in your own terminal; --status and --remove are allowed anywhere.`);
    }
  }
  const platform = ctx.platform ?? process.platform;
  if (platform !== 'linux' && platform !== 'darwin') return fail('unsupported-platform', 'update schedule is only supported on Linux/WSL (cron) and macOS (launchd)');

  const darwin = platform === 'darwin';
  const userHome = ctx.home ?? os.homedir();
  const label = AUTO_UPDATE_LABEL;
  let line;
  let plist;
  if (action === 'install') {
    const binPath = ctx.binPath ?? installedBin(userHome);
    if (!(ctx.existsFn ?? existsSync)(binPath)) return fail('not-installed', `cannot install the schedule: the pipeline is not installed at ${binPath} (the job runs the installed copy)`);
    const which = ctx.whichFn ?? ((cmd) => findOnPath(cmd, env.PATH));
    const nodePath = ctx.nodePath ?? process.execPath;
    // git and gh must be found at install time: the job's own PATH is minimal.
    for (const cmd of ['git', 'gh']) {
      if (!which(cmd)) return fail('tool-missing', `cannot install the schedule: ${cmd} was not found on PATH (${darwin ? "launchd's own PATH is minimal" : "cron's own PATH is only /usr/bin:/bin"}, so the job needs to know where it is)`);
    }
    const logDir = pruneLogDir(env);
    (ctx.mkdirFn ?? ((d) => mkdirSync(d, { recursive: true })))(logDir);
    const args = {
      nodePath, binPath, root: userHome, args: [...AUTO_UPDATE_ARGS],
      pathDirs: [...new Set([nodePath, which('git'), which('gh')].map((p) => path.dirname(p)))],
      logFile: path.join(logDir, `cron-${AUTO_UPDATE_NAME}.log`),
    };
    if (darwin) plist = schedulePlist({ ...args, label, interval: every * 60 });
    else line = scheduleLine({ ...args, cron: cronExpression(every), lockName: AUTO_UPDATE_NAME, kind: 'update' });
  }

  const applied = applyJob({ action, darwin, userHome, plist, line, ctx });
  const result = action === 'install' ? { ...applied.result, ...(darwin ? {} : { changed: applied.wrote }), every, note: NOTE(every) } : applied.result;
  return { exitCode: EXIT.OK, output: { ok: true, ...result } };
});
