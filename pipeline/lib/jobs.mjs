// Detached jobs: Claude Code's Bash tool times out after 10 minutes and subagents cannot rely on
// background notifications, yet full verify, CI/merge waits and Codex reviews take 20-40. So a
// command is started detached (startJob), and callers poll in waits shorter than the limit (waitJob).
// Everything lives in files under <cwd>/<dir>/<name>/ so any process can read a job's state:
//   meta.json   what was started, and the runner's pid
//   log         the command's stdout + stderr
//   child.json  the command's pid           exit.json   written by job-runner.mjs when it ends
import { spawn } from 'node:child_process';
import {
  mkdirSync, rmSync, writeFileSync, renameSync, readFileSync, statSync, openSync, readSync, closeSync,
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

function checkName(name) {
  // '.', '..' and trailing dots would escape the jobs dir or collide on Windows (which drops them).
  if (typeof name !== 'string' || !NAME_RE.test(name) || /^\.+$/.test(name) || name.endsWith('.')) {
    throw new Error(`invalid job name ${JSON.stringify(name)}: use letters, digits, ".", "_" and "-" (no trailing ".")`);
  }
}

function locate(name, { cwd, dir = '.review/jobs' } = {}) {
  checkName(name);
  const base = path.resolve(cwd ?? process.cwd());
  return { base, jobDir: path.resolve(base, dir, name) };
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

function isRunning(jobDir) {
  const meta = readJson(path.join(jobDir, 'meta.json'));
  if (!meta || readJson(path.join(jobDir, 'exit.json'))) return false;
  return runnerAlive(meta);
}

export function startJob(name, command, { cwd, dir = '.review/jobs', policy = () => ({ allow: true }), env } = {}) {
  const { base, jobDir } = locate(name, { cwd, dir });
  const verdict = policy(command);
  if (!verdict?.allow) throw new Error(`job refused: ${verdict?.reason ?? 'refused by policy'}`);
  try {
    if (!statSync(base).isDirectory()) throw new Error('not a directory');
  } catch {
    throw new Error(`job cwd does not exist: ${base}`);
  }
  if (isRunning(jobDir)) throw new Error('job already running');

  rmSync(jobDir, { recursive: true, force: true, maxRetries: 3 }); // a fresh log, never a mix of two runs
  mkdirSync(jobDir, { recursive: true });
  const meta = { name, command, cwd: base, startedAt: new Date().toISOString(), runnerPid: null };
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
  return { name, jobDir, pid: child.pid };
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

function snapshot(jobDir) {
  const meta = readJson(path.join(jobDir, 'meta.json'));
  if (!meta) return { state: 'missing' };
  const startedMs = Date.parse(meta.startedAt);
  let exit = readJson(path.join(jobDir, 'exit.json'));
  if (!exit && !runnerAlive(meta)) {
    exit = readJson(path.join(jobDir, 'exit.json')); // it may have finished between the two reads
    if (!exit) return { state: 'lost', elapsedMs: Date.now() - startedMs, tail: tailOf(jobDir) };
  }
  if (!exit) return { state: 'running', elapsedMs: Date.now() - startedMs, tail: tailOf(jobDir) };
  return {
    state: 'done',
    exitCode: exitCodeOf(exit),
    ...(exit.signal ? { signal: exit.signal } : {}),
    startedAt: meta.startedAt,
    finishedAt: exit.finishedAt,
    elapsedMs: Date.parse(exit.finishedAt) - startedMs,
    tail: tailOf(jobDir),
  };
}

export function readJob(name, opts = {}) {
  return snapshot(locate(name, opts).jobDir);
}

// Resolves with 'running' when the job is still going at timeoutMs, so callers loop on it; keep
// timeoutMs under the 10-minute tool limit (default 9 minutes).
export async function waitJob(name, { cwd, dir, timeoutMs = 540_000, pollMs = 1000 } = {}) {
  const { jobDir } = locate(name, { cwd, dir });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const s = snapshot(jobDir);
    if (s.state !== 'running') return s;
    const left = deadline - Date.now();
    if (left <= 0) return s;
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, left)));
  }
}
