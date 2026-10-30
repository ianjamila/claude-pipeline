// Shared scheduling helpers: the nightly cron line (Linux) and the launchd LaunchAgent plist (macOS) that run one
// `pipeline` command, plus the crontab / launchctl / time-zone plumbing around them. Used by `worktrees schedule` and the
// stacks sweep. The job's run arguments, marker kind and so on are parameters whose defaults are the worktrees prune job.
import { accessSync, constants, existsSync, mkdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { EXIT, UsageError } from './cli.mjs';
import { Fail } from './cmd-common.mjs';
import { run as runProc } from './proc.mjs';

// What the worktrees job runs after `node <bin>`; every helper below takes `args` and defaults to this. Schedules installed
// before notifications were removed also pass `--notify` (accepted, does nothing); they are found by their marker, not their args.
export const WORKTREES_PRUNE_ARGS = Object.freeze(['worktrees', 'prune', '--summary-only']);

export const AT_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const SAFE_WORD = /^[A-Za-z0-9_\/.@+=,:-]+$/;
const shellQuote = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
const bareOrQuoted = (s) => (SAFE_WORD.test(s) ? s : shellQuote(s));

export const scheduleMarker = (lockName, kind = 'worktrees-prune') => `# claude-pipeline ${kind} ${lockName}`;

const CRON_PATH = ['/usr/bin', '/bin'];

// The crontab line. cron's own PATH is just /usr/bin:/bin, so the job sets PATH to the directories of node, git and gh as
// found at install time (plus those two), and appends all output to logFile so a startup failure leaves a trace. The root,
// PATH and log file are always single-quoted; node and bin only when they need it. cron turns a bare % into a newline,
// so each one is escaped; a newline in a path cannot be written to a crontab at all.
export function scheduleLine({ nodePath, binPath, root, at, lockName, pathDirs, logFile, args = WORKTREES_PRUNE_ARGS, kind }) {
  const m = AT_RE.exec(at ?? '');
  if (!m) throw new UsageError(`--at must be HH:MM (00-23:00-59), got ${JSON.stringify(at)}`);
  if ([nodePath, binPath, root, logFile, ...pathDirs, ...args].some((p) => /[\r\n]/.test(p))) throw new UsageError('schedule: a path contains a newline, which a crontab line cannot hold');
  const searchPath = [...new Set([...pathDirs, ...CRON_PATH])].join(':');
  const command = `cd ${shellQuote(root)} && PATH=${shellQuote(searchPath)} ${bareOrQuoted(nodePath)} ${bareOrQuoted(binPath)} ${args.map(bareOrQuoted).join(' ')} >>${shellQuote(logFile)} 2>&1`;
  return `${m[2]} ${m[1]} * * * ${command.replace(/%/g, '\\%')} ${scheduleMarker(lockName, kind)}`;
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

export function systemCrontab(op, text) {
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
export const REAL_SOURCES = [
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

// ---- macOS: one per-user LaunchAgent per repository. launchd runs a StartCalendarInterval job missed while the Mac slept
// when it wakes, which cron never does. The label is the cron marker's lock name under a reverse-DNS prefix. -------------

export const scheduleLabel = (lockName) => `com.claude-pipeline.${lockName}`;

const xmlEscape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const LAUNCHD_PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin']; // lsof is /usr/sbin/lsof

// The LaunchAgent plist, generated deterministically so an unchanged install leaves the file alone. launchd's own PATH is
// minimal, so the job gets the directories of node, git and gh as found at install time.
export function schedulePlist({ nodePath, binPath, root, at, label, pathDirs, logFile, args = WORKTREES_PRUNE_ARGS }) {
  const m = AT_RE.exec(at ?? '');
  if (!m) throw new UsageError(`--at must be HH:MM (00-23:00-59), got ${JSON.stringify(at)}`);
  const all = [nodePath, binPath, root, logFile, label, ...pathDirs, ...args];
  if (all.some((p) => /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(p))) throw new UsageError('schedule: a path contains a control character, which a plist cannot hold');
  const str = (v, pad) => `${pad}<string>${xmlEscape(v)}</string>`;
  const searchPath = [...new Set([...pathDirs, ...LAUNCHD_PATH])].join(':');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    str(label, '  '),
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...[nodePath, binPath, ...args].map((a) => str(a, '    ')),
    '  </array>',
    '  <key>WorkingDirectory</key>',
    str(root, '  '),
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    '    <key>PATH</key>',
    str(searchPath, '    '),
    '  </dict>',
    '  <key>StartCalendarInterval</key>',
    '  <dict>',
    '    <key>Hour</key>',
    `    <integer>${Number(m[1])}</integer>`,
    '    <key>Minute</key>',
    `    <integer>${Number(m[2])}</integer>`,
    '  </dict>',
    '  <key>StandardOutPath</key>',
    str(logFile, '  '),
    '  <key>StandardErrorPath</key>',
    str(logFile, '  '),
    '  <key>RunAtLoad</key>',
    '  <false/>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

// The Mac's zone is the /etc/localtime link (systemsetup needs root; there is no timedatectl or /etc/timezone).
export const DARWIN_TZ_SOURCES = [REAL_SOURCES[1]];

// launchctl through the same runner as crontab; code/stdout/stderr come back as-is. By absolute path (like /usr/sbin/lsof in
// worktree-prune/inspect.mjs), so a PATH without /bin cannot make it "not found"; lib/proc.mjs turns a spawn failure into a
// non-zero code with stderr "spawn <cmd> ENOENT", which absentJob() below refuses to read as "unloaded".
const LAUNCHCTL = '/bin/launchctl';
export const systemLaunchctl = (args) => runProc(LAUNCHCTL, args);

// `launchctl print` CONFIRMS a job is not loaded only by exit 113 or by saying "Could not find service". Any other non-zero
// (launchctl missing, a permission or domain error) tells nothing about the job, so it is never read as "unloaded".
const absentJob = (r) => r.code === 113 || /could not find service/i.test(`${r.stderr ?? ''}\n${r.stdout ?? ''}`);
const why = (r) => r.stderr?.trim() || `exit ${r.code}`;

// Install / remove / report the LaunchAgent. bootout and the `print` probe may fail for a job that is not loaded, so on install
// their results are only read, never thrown (a failing bootstrap is the launchctl error that stops it, and it fails too when
// the old job is still loaded). Remove cannot take that shortcut: it asks `print` whether the job is really gone and refuses
// to delete the plist, or report success, unless `print` CONFIRMS the job is absent (absentJob). `--status` keeps loaded as
// "print exited 0"; an unexplained print failure adds a `warning` instead of staying silent.
export function applyLaunchd({ action, plist, plistPath, label, launchctlFn, tzFn, uid }) {
  const domain = `gui/${uid}`;
  const target = `${domain}/${label}`;
  const bootout = () => launchctlFn(['bootout', target]);
  if (action === 'status') {
    const exists = existsSync(plistPath);
    const probe = launchctlFn(['print', target]);
    const loaded = probe.code === 0;
    const out = { installed: exists && loaded, line: exists ? plistPath : null, plist: plistPath, loaded };
    if (!loaded && !absentJob(probe)) out.warning = `could not tell whether ${label} is loaded: ${why(probe)}`;
    return out;
  }
  if (action === 'remove') {
    const out = bootout();
    const probe = launchctlFn(['print', target]);
    if (probe.code === 0) {
      throw new Fail(EXIT.USAGE, { ok: false, error: 'launchctl', message: `could not unload ${label}: ${why(out)}` });
    }
    if (!absentJob(probe)) {
      throw new Fail(EXIT.USAGE, { ok: false, error: 'launchctl', message: `could not confirm ${label} is unloaded: ${why(probe)}` });
    }
    const had = existsSync(plistPath);
    if (had) rmSync(plistPath);
    return { removed: had };
  }
  let before = null;
  try { before = readFileSync(plistPath, 'utf8'); } catch { /* no plist yet */ }
  const changed = before !== plist;
  if (changed) {
    mkdirSync(path.dirname(plistPath), { recursive: true });
    writeFileSync(plistPath, plist);
  }
  // Always reload, even when the file is unchanged: that also repairs a job that is not loaded (after a remove by hand).
  bootout();
  const r = launchctlFn(['bootstrap', domain, plistPath]);
  if (r.code !== 0) throw new Fail(EXIT.USAGE, { ok: false, error: 'launchctl', message: `cannot load the LaunchAgent: ${r.stderr.trim() || `exit ${r.code}`}` });
  const timezone = tzFn();
  const when = (() => {
    const m = /<key>Hour<\/key>\s*<integer>(\d+)<\/integer>\s*<key>Minute<\/key>\s*<integer>(\d+)<\/integer>/.exec(plist);
    return m ? `${m[1].padStart(2, '0')}:${m[2].padStart(2, '0')}` : 'the time';
  })();
  const result = { installed: true, line: plistPath, plist: plistPath, changed, timezone, note: 'launchd runs a missed run when the Mac wakes' };
  if (timezone === null) result.warning = `could not tell which time zone launchd runs in — ${when} is local time, not necessarily Asia/Manila`;
  else if (timezone !== 'Asia/Manila') result.warning = `launchd runs in ${timezone}, not Asia/Manila — ${when} is local time in that zone`;
  return result;
}
