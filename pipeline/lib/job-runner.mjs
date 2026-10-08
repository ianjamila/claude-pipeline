// The detached half of the job runner (see jobs.mjs). Claude Code's Bash calls die after 10 minutes,
// so a long command is started through this wrapper instead: it outlives its starter, sends the
// command's stdout+stderr straight to <jobDir>/log, and leaves exit.json behind when the command
// ends. Usage: node job-runner.mjs <jobDir> <command>
import { spawn } from 'node:child_process';
import { openSync, closeSync, writeSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';

const [jobDir, commandArg] = process.argv.slice(2);

// tmp + rename, so a poller never reads half a file.
function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value));
  renameSync(tmp, file);
}

let logFd = null;
let finished = false;
let child = null;

// Installed before anything else runs, so a signal that arrives while the command is being started is caught and
// handled once main() returns (when child is set), never the default action that kills this runner on the spot: that
// left no exit.json (the job read as lost) and the command running on as an orphan, the moment child.json appeared.
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(sig, () => { if (!finished && child) child.kill(sig); });
}

function note(message) {
  try {
    logFd ??= openSync(path.join(jobDir, 'log'), 'a');
    writeSync(logFd, `job-runner: ${message}\n`);
  } catch { /* nowhere left to report to */ }
}

// exit.json is written once; whichever of 'exit' / 'error' fires first wins.
function finish(code, signal) {
  if (finished) return;
  finished = true;
  writeJsonAtomic(path.join(jobDir, 'exit.json'), { code, signal, finishedAt: new Date().toISOString() });
  if (logFd !== null) {
    try { closeSync(logFd); } catch { /* ignore */ }
  }
}

function main() {
  let meta = {};
  try {
    meta = JSON.parse(readFileSync(path.join(jobDir, 'meta.json'), 'utf8'));
  } catch { /* the starter used the same cwd for this process, so the fallback below is equivalent */ }
  const command = commandArg ?? meta.command;

  // Both streams share one O_APPEND descriptor, opened before the command exists, so the output is
  // interleaved in order and a fast-failing command cannot lose a line.
  logFd = openSync(path.join(jobDir, 'log'), 'a');
  child = spawn(command, {
    shell: true,
    cwd: meta.cwd ?? process.cwd(),
    stdio: ['ignore', logFd, logFd],
    windowsHide: true,
  });

  child.on('error', (err) => {
    note(`failed to start command: ${err.message}`);
    finish(127, null);
  });
  child.on('exit', (code, signal) => finish(code, signal));

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
