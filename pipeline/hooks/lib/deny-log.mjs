// Why: the false-block rate of the guards (how often a harmless command is denied) could only be measured by scraping
// transcripts. logDeny appends one line per deny to <home>/.claude/pipeline-state/guard-log.jsonl: when, which session, which
// hook, a short reason slug and a hash of the command, so `pipeline guard-log` can count denies per day.
// Privacy: the command text and the reason text are NEVER stored (a command can hold a secret); the hash only lets two
// identical denies be told apart from two different ones.
// Location: NOT under ~/.claude/pipeline/. The installer counts any extra file there as tampering
// (scanExtraInstalledFiles in lib/installer.mjs), so a log written there would mark every install `.modified`.
// pipeline-state/ is where the other runtime state (locks, notify state) already lives.
// Never throws and never changes a verdict: it is called while a deny is being returned, and a failure here must not
// turn it into a crash (a crashing hook counts as "allowed"). PIPELINE_GUARD_LOG=0 turns it off.
// Safety: the hooks emit the deny BEFORE they log (a slow or failed log cannot cost the verdict), and the log is only
// ever written as a regular file: the folder must be a real directory (not a symlink), the file is opened with
// O_NOFOLLOW (a symlink at the path is refused, so an agent cannot point the hook at a protected file and have it
// appended to) and O_NONBLOCK (a FIFO at the path fails at once instead of hanging the hook), and an open handle that
// is not a regular file is closed unwritten.
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, renameSync, writeSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const MAX_LOG_BYTES = 5 * 1024 * 1024;

// Ordered: the first pattern that matches the deny text names it; anything else is 'other'.
const REASON_CODES = [
  ['var', /is assigned more than once|was assigned more than once|may be reassigned by the file/],
  ['dir', /cannot tell which directory/],
  ['runtime-cmd', /the command that runs is only known at run time/],
  ['runtime-script', /which word is the script this command runs is only known at run time/],
  ['pieces', /built from pieces/],
  ['words', /too many words|too many candidates|glob/],
  ['inline-string', /was given a string that contains a guarded command/],
  ['force', /force/i],
  ['plugin-cache', /plugin/],
  ['protected', /protected pipeline file|refers to a protected|PIPELINE_ADMIN/],
  ['script-blocked', /would run a blocked command|would run:/],
  ['budget', /too complex|too long|time budget|deadline/],
  ['internal', /internal error/],
  ['main', /\bmain\b|\bmaster\b/],
];

export function reasonCode(reason) {
  const text = String(reason ?? '');
  for (const [code, re] of REASON_CODES) if (re.test(text)) return code;
  return 'other';
}

// O_NOFOLLOW and O_NONBLOCK do not exist on Windows (undefined there); the lstat checks still apply
const OPEN_FLAGS = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

// Opens the log for appending, or returns -1 when the path is anything but a regular file (or absent).
function openRegular(file) {
  try {
    if (!lstatSync(file).isFile()) return -1; // symlink, FIFO, socket, device, directory
  } catch (err) {
    if (err?.code !== 'ENOENT') return -1;
  }
  const fd = openSync(file, OPEN_FLAGS, 0o600);
  try {
    if (fstatSync(fd).isFile()) return fd;
  } catch { /* fall through */ }
  closeSync(fd);
  return -1;
}

export const guardLogFile = (home = os.homedir()) => path.join(home, '.claude', 'pipeline-state', 'guard-log.jsonl');

// Returns true when a line was written, false when logging is off or anything failed.
export function logDeny({ hook, reason, command, session, home = os.homedir(), now = Date.now, maxBytes = MAX_LOG_BYTES, env = process.env } = {}) {
  try {
    if (env.PIPELINE_GUARD_LOG === '0') return false;
    const file = guardLogFile(home);
    const dir = path.dirname(file);
    mkdirSync(dir, { recursive: true });
    if (!lstatSync(dir).isDirectory()) return false; // a symlinked folder would move the log somewhere else
    let fd = openRegular(file);
    if (fd < 0) return false;
    if (fstatSync(fd).size > maxBytes) {
      closeSync(fd);
      renameSync(file, file.replace(/\.jsonl$/, '.1.jsonl')); // replaces an older .1 (a symlink there is replaced, not followed)
      fd = openRegular(file);
      if (fd < 0) return false;
    }
    const line = JSON.stringify({
      ts: new Date(now()).toISOString(),
      session: typeof session === 'string' && session !== '' ? session : null,
      hook: hook === 'files' ? 'files' : 'git',
      reason_code: reasonCode(reason),
      cmd_hash: createHash('sha256').update(String(command ?? '')).digest('hex').slice(0, 16),
    });
    try {
      writeSync(fd, `${line}\n`);
    } finally {
      closeSync(fd);
    }
    return true;
  } catch {
    return false;
  }
}
