// `pipeline worktrees`: remove finished worktrees safely (prune), protect one with a keep-lock (keep / unkeep), and look
// at or purge the holding folder where removed worktrees' evidence waits 30 days (holding). Spec:
// docs/specs/2026-10-13-worktree-prune-design.md. One `worktrees.mode` setting governs every mutation: `report` (the
// default) and `off` change nothing, `--dry-run` never changes anything; keep-locks only protect, so they work in every
// mode. The prune flow lives in lib/worktree-prune/run.mjs. Exit 0 completed (skips are normal), 2 usage / repo / config,
// 3 GitHub unavailable. `schedule` adds, removes or reports one nightly cron line that runs `prune --notify` (Linux only).
import { accessSync, constants, mkdirSync, readFileSync, readlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXIT, UsageError, parseCommandArgs } from '../lib/cli.mjs';
import { Fail, guarded } from '../lib/cmd-common.mjs';
import { git } from '../lib/git.mjs';
import { listWorktrees } from '../lib/local-branches.mjs';
import { samePath } from '../lib/paths.mjs';
import { run as runProc } from '../lib/proc.mjs';
import { holdingRoot, listHolding, purgeHolding } from '../lib/worktree-prune/act.mjs';
import { lockNameFor, modeAllows } from '../lib/worktree-prune/rules.mjs';
import { loadRepo, prune, pruneLogDir } from '../lib/worktree-prune/run.mjs';

export const meta = {
  summary: 'remove finished worktrees (prune), keep one with a lock (keep / unkeep), list or purge the holding folder',
  usage: [
    'pipeline worktrees prune [--repo DIR] [--dry-run] [--notify]   -> {ok, mode, removed:[...], wouldRemove:[...], kept:[...], hiddenProcesses, restored:[...], outside:[...], holding:{batches, purged}}',
    'pipeline worktrees keep NAME [--reason TEXT] [--repo DIR]   -> {ok, slug, locked}',
    'pipeline worktrees unkeep NAME [--run ID] [--repo DIR]   -> {ok, slug, unlocked}',
    'pipeline worktrees holding [--purge] [--repo DIR]   -> {ok, batches:[...], purged:[...]}',
    'pipeline worktrees schedule (--install [--at HH:MM] | --remove | --status) [--repo DIR]   -> {ok, installed, line, timezone, warning?} | {ok, removed} | {ok, installed, line}',
  ].join('\n'),
};

export const KEEP_PREFIX = 'pipeline-keep:';
const SUBS = 'prune [--dry-run] [--notify] | keep NAME [--reason TEXT] | unkeep NAME [--run ID] | holding [--purge] | schedule (--install [--at HH:MM] | --remove | --status)';

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
      const r = purgeHolding(dir, { nowMs: Date.now() });
      output.purged = r.purged;
      output.keptBatches = r.kept;
    } else output.note = 'purge needs mode: on';
  }
  output.batches = listHolding(dir);
  return { exitCode: EXIT.OK, output };
}

// ---- schedule: one cron line per repository, found again by the marker comment at its end ----------------------------

const DEFAULT_AT = '02:30';
const AT_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const SAFE_WORD = /^[A-Za-z0-9_\/.@+=,:-]+$/;
const shellQuote = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
const bareOrQuoted = (s) => (SAFE_WORD.test(s) ? s : shellQuote(s));

export const scheduleMarker = (lockName) => `# claude-pipeline worktrees-prune ${lockName}`;

const CRON_PATH = ['/usr/bin', '/bin'];

// The crontab line. cron's own PATH is just /usr/bin:/bin, so the job sets PATH to the directories of node, git and gh as
// found at install time (plus those two), and appends all output to logFile so a startup failure leaves a trace. The root,
// PATH and log file are always single-quoted; node and bin only when they need it. cron turns a bare % into a newline,
// so each one is escaped; a newline in a path cannot be written to a crontab at all.
export function scheduleLine({ nodePath, binPath, root, at, lockName, pathDirs, logFile }) {
  const m = AT_RE.exec(at ?? '');
  if (!m) throw new UsageError(`--at must be HH:MM (00-23:00-59), got ${JSON.stringify(at)}`);
  if ([nodePath, binPath, root, logFile, ...pathDirs].some((p) => /[\r\n]/.test(p))) throw new UsageError('schedule: a path contains a newline, which a crontab line cannot hold');
  const searchPath = [...new Set([...pathDirs, ...CRON_PATH])].join(':');
  const command = `cd ${shellQuote(root)} && PATH=${shellQuote(searchPath)} ${bareOrQuoted(nodePath)} ${bareOrQuoted(binPath)} worktrees prune --notify >>${shellQuote(logFile)} 2>&1`;
  return `${m[2]} ${m[1]} * * * ${command.replace(/%/g, '\\%')} ${scheduleMarker(lockName)}`;
}

// Install / remove / report the marker line in the crontab that crontabFn('read') returns. Every other line is kept
// byte-for-byte; the crontab is only written when its text changes. crontabFn('write', text) replaces it.
export function applySchedule({ action, line, marker, crontabFn, tzFn }) {
  const text = crontabFn('read');
  const lines = text.split('\n'); // a trailing newline leaves a final '' that join('\n') restores
  const isOurs = (l) => l.trimEnd().endsWith(marker);
  if (action === 'status') {
    const found = lines.find(isOurs);
    return { installed: found !== undefined, line: found?.trimEnd() ?? null };
  }
  if (action === 'remove') {
    const kept = lines.filter((l) => !isOurs(l));
    if (kept.length === lines.length) return { removed: false };
    crontabFn('write', kept.join('\n'));
    return { removed: true };
  }
  let placed = false;
  const next = [];
  for (const l of lines) {
    if (!isOurs(l)) next.push(l);
    else if (!placed) {
      next.push(line);
      placed = true;
    }
  }
  let out;
  if (placed) out = next.join('\n');
  else out = `${text === '' || text.endsWith('\n') ? text : `${text}\n`}${line}\n`;
  if (out !== text) crontabFn('write', out);
  const timezone = tzFn();
  const at = / (\d\d) (\d\d) \* \* \* /.exec(` ${line}`);
  const when = at ? `${at[2]}:${at[1]}` : 'the time';
  const result = { installed: true, line, timezone };
  if (timezone === null) result.warning = `could not tell which time zone cron runs in — ${when} is local to it, not necessarily Asia/Manila`;
  else if (timezone !== 'Asia/Manila') result.warning = `cron runs in ${timezone}, not Asia/Manila — ${when} is local to that zone`;
  return result;
}

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

// The zone cron's times are local to, from the most to the least trustworthy source: timedatectl, the /etc/localtime
// symlink (what cron follows), /etc/timezone (can be stale). Each source returns a string or null/throws when it has no
// answer; null when none answers. The sources are injectable for tests.
const REAL_SOURCES = [
  () => {
    const r = runProc('timedatectl', ['show', '-p', 'Timezone', '--value']);
    return r.code === 0 ? r.stdout : null;
  },
  () => {
    const target = readlinkSync('/etc/localtime');
    const at = target.lastIndexOf('zoneinfo/');
    return at === -1 ? null : target.slice(at + 'zoneinfo/'.length);
  },
  () => readFileSync('/etc/timezone', 'utf8'),
];

export function detectTimezone(sources = REAL_SOURCES) {
  for (const source of sources) {
    try {
      const zone = source()?.trim();
      if (zone) return zone;
    } catch { /* this source has no answer */ }
  }
  return null;
}

// The absolute path of an executable on PATH, or null.
export function findOnPath(cmd, pathEnv = process.env.PATH ?? '') {
  for (const dir of pathEnv.split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, cmd);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch { /* not here */ }
  }
  return null;
}

const BIN_PATH = fileURLToPath(new URL('../bin/pipeline.mjs', import.meta.url));

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
  if ((ctx?.platform ?? process.platform) !== 'linux') {
    return { exitCode: EXIT.USAGE, output: { ok: false, error: 'unsupported-platform', message: 'schedule is only supported on Linux (cron) in this version' } };
  }
  const repo = await loadRepo(values, ctx);
  const lockName = lockNameFor(repo.commonDir);
  const marker = scheduleMarker(lockName);
  let line;
  if (action === 'install') {
    const which = ctx?.whichFn ?? ((cmd) => findOnPath(cmd, (ctx?.env ?? process.env).PATH));
    const nodePath = ctx?.nodePath ?? process.execPath;
    const tools = {};
    for (const cmd of ['git', 'gh']) {
      tools[cmd] = which(cmd);
      if (!tools[cmd]) {
        return { exitCode: EXIT.USAGE, output: { ok: false, error: 'tool-missing', message: `cannot install the schedule: ${cmd} was not found on PATH (cron's own PATH is only /usr/bin:/bin, so the job needs to know where it is)` } };
      }
    }
    const logDir = pruneLogDir(ctx?.env ?? process.env);
    mkdirSync(logDir, { recursive: true });
    line = scheduleLine({
      nodePath, binPath: ctx?.binPath ?? BIN_PATH, root: repo.root, at, lockName,
      pathDirs: [...new Set([nodePath, tools.git, tools.gh].map((p) => path.dirname(p)))],
      logFile: path.join(logDir, `cron-${lockName}.log`),
    });
  }
  const result = applySchedule({ action, line, marker, crontabFn: ctx?.crontabFn ?? systemCrontab, tzFn: ctx?.tzFn ?? detectTimezone });
  return { exitCode: EXIT.OK, output: { ok: true, ...result } };
}

export const run = guarded(async (argv, ctx) => {
  const [sub, ...rest] = argv;
  if (sub === 'prune') {
    const { values, positionals } = parseCommandArgs(rest, { repo: { type: 'string' }, 'dry-run': { type: 'boolean' }, notify: { type: 'boolean' } });
    if (positionals.length) throw new UsageError('worktrees prune takes no NAME');
    return prune(values, ctx);
  }
  if (sub === 'keep') return keep(rest, ctx);
  if (sub === 'unkeep') return unkeep(rest, ctx);
  if (sub === 'holding') return holding(rest, ctx);
  if (sub === 'schedule') return schedule(rest, ctx);
  throw new UsageError(`usage: pipeline worktrees (${SUBS})`);
});
