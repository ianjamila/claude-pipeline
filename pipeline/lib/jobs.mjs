// Detached jobs: Claude Code's Bash tool times out after 10 minutes and subagents cannot rely on
// background notifications, yet full verify, CI/merge waits and Codex reviews take 20-40. So a
// command is started detached (startJob), and callers poll in waits shorter than the limit (waitJob).
// Everything lives in files under <cwd>/<dir>/<name>/ so any process can read a job's state:
//   meta.json   what was started (name, command, cwd, tag, runId, startedAt) and the runner's pid
//   log         the command's stdout + stderr
//   child.json  the command's pid           exit.json   written by job-runner.mjs when it ends
// Each start gets a random runId. Callers pass a tag (the HEAD sha or tree fingerprint the job is
// about) and hand the runId back as expectRunId, so a result that belongs to a replaced run reads as
// 'replaced' instead of being mistaken for the current one.
// The command runs under /bin/sh (cmd.exe on Windows), which has no pipefail: a pipeline reports the
// status of its LAST command, so an earlier stage can fail unseen. Never pass a pipeline whose earlier
// stages matter; the pipeline only runs single scripts.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  mkdirSync, rmSync, writeFileSync, renameSync, readFileSync, statSync, lstatSync, readdirSync,
  openSync, readSync, closeSync,
} from 'node:fs';
import { constants as osConstants } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RUNNER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'job-runner.mjs');
const NAME_RE = /^[A-Za-z0-9._-]+$/;
const TAIL_LINES = 40;
const TAIL_BYTES = 256 * 1024; // read only the end of the log: a verbose job can write gigabytes
// startJob writes meta.json before it knows the runner's pid; for this long that gap is not "lost".
const PID_GRACE_MS = 30_000;
const LOCK_STALE_MS = 60_000; // a <name>.starting lock this old was left by a starter that crashed

function checkName(name) {
  // '.', '..' and trailing dots would escape the jobs dir or collide on Windows (which drops them);
  // '<x>.starting' is the start lock of job <x>, so no job may be called that.
  if (typeof name !== 'string' || !NAME_RE.test(name) || /^\.+$/.test(name) || name.endsWith('.')
    || name.endsWith('.starting')) {
    throw new Error(`invalid job name ${JSON.stringify(name)}: use letters, digits, ".", "_" and "-" (no trailing ".")`);
  }
}

// jobDir is always a direct child of jobsDir (a name has no separator and is not all dots), and jobsDir
// must be cwd or below it, so nothing here can point startJob's delete at a directory outside the project.
function locate(name, { cwd, dir = '.review/jobs' } = {}) {
  checkName(name);
  const base = path.resolve(cwd ?? process.cwd());
  const jobsDir = path.resolve(base, dir);
  const rel = path.relative(base, jobsDir);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error(`job dir must be inside cwd: ${jobsDir} is outside ${base}`);
  }
  return { base, jobsDir, jobDir: path.join(jobsDir, name) };
}

function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value));
  renameSync(tmp, file);
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // exists, just not ours
  }
}

function runnerAlive(meta) {
  if (Number.isInteger(meta.runnerPid)) return isAlive(meta.runnerPid);
  const started = Date.parse(meta.startedAt);
  return Number.isFinite(started) && Date.now() - started < PID_GRACE_MS;
}

function isRunning(jobDir, name) {
  const meta = readJson(path.join(jobDir, 'meta.json'));
  if (!meta || meta.name !== name || readJson(path.join(jobDir, 'exit.json'))) return false;
  return runnerAlive(meta);
}

// mkdir is atomic, so whoever creates <name>.starting is the only starter of that job right now.
function acquireStartLock(lock) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      mkdirSync(lock);
      return;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    let age;
    try {
      age = Date.now() - statSync(lock).mtimeMs;
    } catch {
      continue; // released between our mkdir and our stat: try again
    }
    if (age <= LOCK_STALE_MS) break;
    rmSync(lock, { recursive: true, force: true }); // a crashed starter's leftover
  }
  throw new Error('job already starting');
}

// Only a directory that is demonstrably this job's (its meta.json names it) or an empty leftover may
// be deleted; anything else (e.g. dir '.' with a project folder called like the job) is refused.
function clearOldJobDir(jobDir, name) {
  let st;
  try {
    st = lstatSync(jobDir);
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
  const isDir = st.isDirectory();
  const ours = isDir && readJson(path.join(jobDir, 'meta.json'))?.name === name;
  if (!ours && !(isDir && readdirSync(jobDir).length === 0)) {
    throw new Error(`refusing to replace ${jobDir}: it is not a job directory for "${name}"; remove it by hand if it is stale`);
  }
  rmSync(jobDir, { recursive: true, force: true, maxRetries: 3 }); // a fresh log, never a mix of two runs
}

// policy is required: it is where the safety evaluators plug in, so a forgotten one must not mean
// "allow everything".
export function startJob(name, command, { cwd, dir, policy, env, tag } = {}) {
  if (typeof policy !== 'function') {
    throw new TypeError('startJob requires a policy(command) function; there is no allow-all default');
  }
  const { base, jobsDir, jobDir } = locate(name, { cwd, dir });
  if (typeof command !== 'string' || command === '') throw new TypeError('job command must be a non-empty string');
  if (tag !== undefined && tag !== null && typeof tag !== 'string') throw new TypeError('job tag must be a string');
  const verdict = policy(command);
  if (!verdict?.allow) throw new Error(`job refused: ${verdict?.reason ?? 'refused by policy'}`);
  try {
    if (!statSync(base).isDirectory()) throw new Error('not a directory');
  } catch {
    throw new Error(`job cwd does not exist: ${base}`);
  }

  mkdirSync(jobsDir, { recursive: true });
  const lock = path.join(jobsDir, `${name}.starting`);
  acquireStartLock(lock);
  try {
    if (isRunning(jobDir, name)) throw new Error('job already running');
    clearOldJobDir(jobDir, name);
    mkdirSync(jobDir);
    const runId = randomUUID();
    const meta = { name, command, cwd: base, tag: tag ?? null, runId, startedAt: new Date().toISOString(), runnerPid: null };
    writeJsonAtomic(path.join(jobDir, 'meta.json'), meta);

    const child = spawn(process.execPath, [RUNNER, jobDir, command], {
      cwd: base,
      env: env ? { ...process.env, ...env } : process.env,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.on('error', () => {}); // a failed spawn is reported through child.pid below, not as a crash
    if (!child.pid) {
      rmSync(jobDir, { recursive: true, force: true });
      throw new Error('could not start the job runner');
    }
    child.unref();
    writeJsonAtomic(path.join(jobDir, 'meta.json'), { ...meta, runnerPid: child.pid });
    return { name, jobDir, pid: child.pid, runId, tag: meta.tag };
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

// Last TAIL_LINES lines of the log, '' when there is none yet.
function tailOf(jobDir) {
  let fd;
  try {
    fd = openSync(path.join(jobDir, 'log'), 'r');
    const size = statSync(path.join(jobDir, 'log')).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    let got = 0;
    while (got < buf.length) {
      const n = readSync(fd, buf, got, buf.length - got, start + got);
      if (n === 0) break;
      got += n;
    }
    const lines = buf.subarray(0, got).toString('utf8').split(/\r?\n/);
    if (lines[lines.length - 1] === '') lines.pop(); // the final newline
    if (start > 0 && lines.length > 1) lines.shift(); // we began mid-line
    return lines.slice(-TAIL_LINES).join('\n');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function exitCodeOf({ code, signal }) {
  if (Number.isInteger(code)) return code;
  const num = osConstants.signals[signal];
  return num ? 128 + num : 1; // killed by a signal: report it the way a shell does
}

function snapshot(jobDir, expectRunId) {
  const meta = readJson(path.join(jobDir, 'meta.json'));
  if (!meta) return { state: 'missing' };
  if (expectRunId !== undefined && meta.runId !== expectRunId) return { state: 'replaced' };
  const identity = {
    name: meta.name ?? null, command: meta.command ?? null, cwd: meta.cwd ?? null,
    tag: meta.tag ?? null, runId: meta.runId ?? null,
  };
  const startedMs = Date.parse(meta.startedAt);
  let exit = readJson(path.join(jobDir, 'exit.json'));
  if (!exit && !runnerAlive(meta)) {
    exit = readJson(path.join(jobDir, 'exit.json')); // it may have finished between the two reads
    if (!exit) return { state: 'lost', ...identity, elapsedMs: Date.now() - startedMs, tail: tailOf(jobDir) };
  }
  if (!exit) return { state: 'running', ...identity, elapsedMs: Date.now() - startedMs, tail: tailOf(jobDir) };
  return {
    state: 'done',
    ...identity,
    exitCode: exitCodeOf(exit),
    ...(exit.signal ? { signal: exit.signal } : {}),
    startedAt: meta.startedAt,
    finishedAt: exit.finishedAt,
    elapsedMs: Date.parse(exit.finishedAt) - startedMs,
    tail: tailOf(jobDir),
  };
}

export function readJob(name, opts = {}) {
  return snapshot(locate(name, opts).jobDir, opts.expectRunId);
}

// Resolves with 'running' when the job is still going at timeoutMs, so callers loop on it; keep
// timeoutMs under the 10-minute tool limit (default 9 minutes). With expectRunId, a job directory that
// now belongs to another run (checked on every poll) resolves as 'replaced'.
export async function waitJob(name, { cwd, dir, timeoutMs = 540_000, pollMs = 1000, expectRunId } = {}) {
  const { jobDir } = locate(name, { cwd, dir });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const s = snapshot(jobDir, expectRunId);
    if (s.state !== 'running') return s;
    const left = deadline - Date.now();
    if (left <= 0) return s;
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, left)));
  }
}
