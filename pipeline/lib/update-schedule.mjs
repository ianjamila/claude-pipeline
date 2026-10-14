// `pipeline update schedule (--install [--every MINUTES] | --remove | --status)`: the recurring job that runs
// `pipeline update --scheduled --json`. Linux/WSL: one crontab line found again by its marker comment (the worktrees
// schedule's own helpers, imported). macOS: one LaunchAgent (lib/launchd.mjs). Anything else: unsupported-platform.
// The job runs the INSTALLED pipeline (~/.claude/pipeline/bin/pipeline.mjs), never the checkout this command ran from, so
// the update that replaces that folder replaces what the job runs next time. `update` does not depend on the working
// directory (gh api / ls-remote with an isolated git, the scratch under the Claude home), so the line needs no `cd`.
// --install arranges for the guard hooks to be replaced unattended, so it refuses inside Claude Code exactly like
// `pipeline update`; --status and --remove (which only take the job away) are allowed anywhere.
import { existsSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EXIT, UsageError, parseCommandArgs } from './cli.mjs';
import { Fail, guarded } from './cmd-common.mjs';
import { run as runProc } from './proc.mjs';
import { applySchedule, detectTimezone, findOnPath } from '../commands/worktrees.mjs';
import { logFile, insideClaudeCode } from './auto-update.mjs';
import * as launchd from './launchd.mjs';

export const CRON_MARKER = '# claude-pipeline auto-update';
export const LAUNCHD_LABEL = 'com.claude-pipeline.auto-update';
export const EVERY_CHOICES = Object.freeze([5, 10, 15, 20, 30, 60]);
export const DEFAULT_EVERY = 15;
const ONCE_AN_HOUR_MINUTE = 17; // `--every 60` fires at a fixed minute past the hour (not the top of it, when everything else runs)

// Divisors of 60 that cron can write as */N; anything else would not fire at even intervals.
export function parseEvery(raw) {
  if (raw === undefined) return DEFAULT_EVERY;
  const n = /^\d+$/.test(String(raw).trim()) ? Number(raw) : NaN;
  if (!EVERY_CHOICES.includes(n)) throw new UsageError(`--every must be one of ${EVERY_CHOICES.join(', ')} (minutes; each divides 60 evenly), got ${JSON.stringify(raw)}`);
  return n;
}

export const cronExpression = (every) => (every === 60 ? `${ONCE_AN_HOUR_MINUTE} * * * *` : `*/${every} * * * *`);

const SAFE_WORD = /^[A-Za-z0-9_\/.@+=,:-]+$/;
const shellQuote = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
const bareOrQuoted = (s) => (SAFE_WORD.test(s) ? s : shellQuote(s));
const CRON_PATH = ['/usr/bin', '/bin'];
const LAUNCHD_PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'];
const searchPathOf = (pathDirs, base) => [...new Set([...pathDirs, ...base])].join(':');

// The crontab line. cron's own PATH is just /usr/bin:/bin, so the job sets PATH to the directories of node, git and gh as found
// at install time (plus those two), and appends all output to logFile. PATH and logFile are always single-quoted; node and the
// script only when they need it. cron turns a bare % into a newline, so each one is escaped; a newline in a path cannot be
// written to a crontab at all.
export function scheduleLine({ nodePath, binPath, every, pathDirs, logFile: log }) {
  if ([nodePath, binPath, log, ...pathDirs].some((p) => /[\r\n]/.test(p))) throw new UsageError('schedule: a path contains a newline, which a crontab line cannot hold');
  const command = `PATH=${shellQuote(searchPathOf(pathDirs, CRON_PATH))} ${bareOrQuoted(nodePath)} ${bareOrQuoted(binPath)} update --scheduled --json >>${shellQuote(log)} 2>&1`;
  return `${cronExpression(every)} ${command.replace(/%/g, '\\%')} ${CRON_MARKER}`;
}

export function schedulePlist({ nodePath, binPath, every, pathDirs, logFile: log }) {
  return launchd.plistText({
    label: LAUNCHD_LABEL,
    programArguments: [nodePath, binPath, 'update', '--scheduled', '--json'],
    searchPath: searchPathOf(pathDirs, LAUNCHD_PATH),
    startInterval: every * 60,
    runAtLoad: true, // a Mac that slept through the interval catches up at wake
    logFile: log,
  });
}

// The installed copy of the CLI (what an update replaces), under the default Claude home.
export const installedBin = (home = os.homedir()) => path.join(home, '.claude', 'pipeline', 'bin', 'pipeline.mjs');

function systemCrontab(op, text) {
  const fail = (what, r) => new Fail(EXIT.USAGE, { ok: false, error: 'crontab', message: `${what}: ${r.stderr.trim() || `exit ${r.code}`}` });
  if (op === 'read') {
    const r = runProc('crontab', ['-l']);
    if (r.code === 0) return r.stdout;
    if (/no crontab/i.test(r.stderr)) return '';
    throw fail('cannot read the crontab', r);
  }
  const r = runProc('crontab', ['-'], { input: text });
  if (r.code !== 0) throw fail('cannot write the crontab', r);
  return undefined;
}

const NOTE = (every) => `runs every ${every} minutes: installs main when this machine is behind it, does nothing when current, and pushes you only on failure (deduped). Check with \`pipeline update schedule --status\`; remove with \`--remove\`.`;

export const runSchedule = guarded(async (rest, ctx = {}) => {
  const env = ctx.env ?? process.env;
  const { values, positionals } = parseCommandArgs(rest, {
    install: { type: 'boolean' }, remove: { type: 'boolean' }, status: { type: 'boolean' }, every: { type: 'string' },
  });
  if (positionals.length) throw new UsageError('update schedule takes no arguments besides --install / --remove / --status [--every MINUTES]');
  const actions = ['install', 'remove', 'status'].filter((a) => values[a]);
  if (actions.length !== 1) throw new UsageError('update schedule needs exactly one of --install, --remove, --status');
  const [action] = actions;
  if (values.every !== undefined && action !== 'install') throw new UsageError('update schedule: --every only goes with --install');
  const every = parseEvery(values.every);

  const platform = ctx.platform ?? process.platform;
  if (platform !== 'linux' && platform !== 'darwin') {
    return { exitCode: EXIT.USAGE, output: { ok: false, error: 'unsupported-platform', message: 'update schedule is only supported on Linux/WSL (cron) and macOS (launchd)' } };
  }

  if (action === 'install') {
    const inside = insideClaudeCode(env, ctx);
    if (inside) {
      const message = `pipeline update schedule --install refuses to run inside a Claude Code session (${inside}): it arranges for the guard hooks to be replaced unattended. Run it in your own terminal; --status and --remove are allowed anywhere.`;
      return { exitCode: EXIT.USAGE, output: { ok: false, error: 'refused', message } };
    }
  }

  const darwin = platform === 'darwin';
  const home = ctx.home ?? os.homedir();
  const launchctl = ctx.launchctlFn ?? launchd.systemLaunchctl;
  const uid = ctx.uid ?? (darwin ? process.getuid() : undefined);
  const plistPath = launchd.agentPlistPath(home, LAUNCHD_LABEL);

  let line;
  let plist;
  if (action === 'install') {
    const binPath = ctx.binPath ?? installedBin(home);
    if (!(ctx.existsFn ?? existsSync)(binPath)) {
      return { exitCode: EXIT.USAGE, output: { ok: false, error: 'not-installed', message: `cannot install the schedule: the pipeline is not installed at ${binPath} (the job runs the installed copy)` } };
    }
    const which = ctx.whichFn ?? ((cmd) => findOnPath(cmd, env.PATH));
    const nodePath = ctx.nodePath ?? process.execPath;
    const tools = {};
    for (const cmd of ['git', 'gh']) {
      tools[cmd] = which(cmd);
      if (!tools[cmd]) {
        return { exitCode: EXIT.USAGE, output: { ok: false, error: 'tool-missing', message: `cannot install the schedule: ${cmd} was not found on PATH (the job's own PATH is minimal, so it needs to know where it is)` } };
      }
    }
    const log = logFile(env);
    (ctx.mkdirFn ?? ((d) => mkdirSync(d, { recursive: true })))(path.dirname(log));
    const args = { nodePath, binPath, every, pathDirs: [...new Set([nodePath, tools.git, tools.gh].map((p) => path.dirname(p)))], logFile: log };
    if (darwin) plist = schedulePlist(args);
    else line = scheduleLine(args);
  }

  let result;
  if (darwin) {
    if (action === 'install') result = { installed: true, line: plistPath, plist: plistPath, ...launchd.install({ plist, plistPath, label: LAUNCHD_LABEL, launchctl, uid }), every, note: NOTE(every) };
    else if (action === 'remove') result = launchd.remove({ plistPath, label: LAUNCHD_LABEL, launchctl, uid });
    else result = launchd.status({ plistPath, label: LAUNCHD_LABEL, launchctl, uid });
  } else {
    const crontab = ctx.crontabFn ?? systemCrontab;
    let wrote = false;
    const crontabFn = (op, text) => { if (op === 'write') wrote = true; return crontab(op, text); };
    result = applySchedule({ action, line, marker: CRON_MARKER, crontabFn, tzFn: ctx.tzFn ?? detectTimezone });
    // applySchedule's time-zone warning is about a fixed HH:MM; an every-N-minutes job has none.
    delete result.warning;
    if (action === 'install') result = { ...result, changed: wrote, every, note: NOTE(every) };
  }
  return { exitCode: EXIT.OK, output: { ok: true, ...result } };
});
