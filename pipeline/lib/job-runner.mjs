// The detached half of the job runner (see jobs.mjs). Claude Code's Bash calls die after 10 minutes,
// so a long command is started through this wrapper instead: it outlives its starter, sends the
// command's stdout+stderr to <jobDir>/log (stdout also, whole, to <jobDir>/stdout, capped at 4 MiB), and leaves
// exit.json behind when the command ends. exit.json is written only AFTER the stdout capture is flushed, so a job
// that reads as done has its complete output, with one exception: a process the command left holding stdout open past the
// drain deadline (DRAIN_GRACE_MS) is cut off from the CAPTURE only, and exit.json says so (drainTimedOut: true). The pipe
// itself is never closed on it: the runner lingers as a drainer and keeps copying that process's lines to the log until the
// pipe closes, so a background process the command left running is never SIGPIPE'd. Usage: node job-runner.mjs <jobDir> <command>
import { spawn } from 'node:child_process';
import { openSync, closeSync, writeSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { STDOUT_CAP_BYTES, STDOUT_FILE } from './job-output.mjs';
import path from 'node:path';

const DRAIN_GRACE_MS = 3000;
const [jobDir, commandArg] = process.argv.slice(2);

// tmp + rename, so a poller never reads half a file.
function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value));
  renameSync(tmp, file);
}

let logFd = null;
let outFd = null;
let outBytes = 0;
let outputTruncated = false;
let outputCaptured = false;
let drainTimedOut = false;
let finished = false;
let child = null;

// Installed before anything else runs, so a signal that arrives while the command is being started is caught and
// handled once main() returns (when child is set), never the default action that kills this runner on the spot: that
// left no exit.json (the job read as lost) and the command running on as an orphan, the moment child.json appeared.
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(sig, () => {
    if (!finished) { if (child) child.kill(sig); return; }
    // Done already, only draining a leftover process's output: a signal ends the drainer.
    closeLog();
    process.exit(0);
  });
}

function note(message) {
  try {
    logFd ??= openSync(path.join(jobDir, 'log'), 'a');
    writeSync(logFd, `job-runner: ${message}\n`);
  } catch { /* nowhere left to report to */ }
}

function closeLog() {
  if (logFd === null) return;
  try { closeSync(logFd); } catch { /* ignore */ }
  logFd = null;
}

// exit.json is written once; whichever of 'exit' / 'error' fires first wins. The stdout pipe is left alone: when it is still open
// (the drain deadline) it keeps feeding the log until it closes; the log is closed then, not here.
function finish(code, signal, { deadline = false } = {}) {
  if (finished) return;
  finished = true;
  drainTimedOut = deadline;
  if (outFd !== null) {
    try { closeSync(outFd); } catch { /* ignore */ }
    outFd = null;
  }
  const capture = outputCaptured ? { outputBytes: outBytes, outputTruncated, ...(drainTimedOut ? { drainTimedOut: true } : {}) } : {};
  writeJsonAtomic(path.join(jobDir, 'exit.json'), { code, signal, finishedAt: new Date().toISOString(), ...capture });
  if (child?.stdout === null || child?.stdout === undefined || child.stdout.destroyed) closeLog();
}

function main() {
  let meta = {};
  try {
    meta = JSON.parse(readFileSync(path.join(jobDir, 'meta.json'), 'utf8'));
  } catch { /* the starter used the same cwd for this process, so the fallback below is equivalent */ }
  const command = commandArg ?? meta.command;

  // stderr goes straight to the log descriptor, opened before the command exists, so a fast-failing command cannot lose a
  // line. stdout comes through a pipe: every chunk is appended to the log AND to the stdout capture (first STDOUT_CAP_BYTES).
  logFd = openSync(path.join(jobDir, 'log'), 'a');
  outFd = openSync(path.join(jobDir, STDOUT_FILE), 'w');
  outputCaptured = true;
  child = spawn(command, {
    shell: true,
    cwd: meta.cwd ?? process.cwd(),
    stdio: ['ignore', 'pipe', logFd],
    windowsHide: true,
  });

  let exited = null;
  let drained = false;
  const settle = (deadline = false) => { if (exited && !finished) finish(exited.code, exited.signal, { deadline }); };
  child.stdout.on('data', (chunk) => {
    try { writeSync(logFd, chunk); } catch { /* the log is a convenience */ }
    const room = STDOUT_CAP_BYTES - outBytes;
    if (chunk.length > room) outputTruncated = true;
    if (room > 0 && outFd !== null) {
      const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
      try { writeSync(outFd, part); outBytes += part.length; } catch { outputTruncated = true; }
    }
  });
  // 'close' fires once the pipe is drained: only then is the capture complete. A grandchild that inherited the pipe can keep it
  // open after the command exits, so after 'exit' the drain is waited for only briefly; at the deadline the capture is closed and
  // flagged drainTimedOut, and the pipe stays open (and keeps being copied to the log) until its last writer is gone.
  child.stdout.on('close', () => { drained = true; settle(); if (finished) closeLog(); });

  child.on('error', (err) => {
    note(`failed to start command: ${err.message}`);
    finish(127, null);
  });
  child.on('exit', (code, signal) => {
    exited = { code, signal };
    if (drained) settle();
    else setTimeout(() => settle(true), DRAIN_GRACE_MS);
  });

  if (child.pid) {
    writeJsonAtomic(path.join(jobDir, 'child.json'), { pid: child.pid, startedAt: new Date().toISOString() });
  }
}

try {
  main();
} catch (err) {
  note(`failed to start command: ${err.message}`);
  try { finish(127, null); } catch { /* the job will read as lost, which is accurate */ }
}
