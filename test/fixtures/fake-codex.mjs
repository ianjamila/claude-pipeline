// A scriptable stand-in for `codex exec`, wired in through PIPELINE_CODEX (`node <this file>`). Real codex receives the
// prompt on stdin and writes its structured answer to the file named by `-o <path>`; this does the same, steered by env:
//   FAKE_CODEX_CAPTURE=<file>  append {argv, stdin} as one JSON line (so a test can assert on the prompt and argv)
//   FAKE_CODEX_EXIT=<n>        exit n (with FAKE_CODEX_STDERR on stderr) without writing any output
//   FAKE_CODEX_TURN_FAILED=<msg>  print Codex's --json failure events on stdout (thread.started, turn.started, turn.failed {error:{message}}):
//                              the only place the pipeline reads a failure reason from (stderr never decides quota)
//   FAKE_CODEX_STDOUT=<file>   print that file's bytes on stdout first (a captured --json stream); FAKE_CODEX_THREAD_ID overrides the id above
//   FAKE_CODEX_CONFIRM_STDOUT=<file> / FAKE_CODEX_CONFIRM_EXIT=<n>  the same two, for the one-line "Reply OK" confirmation run of a refused-model stop
//                              (lib/codex-exec.mjs): that run reads them INSTEAD of FAKE_CODEX_STDOUT / FAKE_CODEX_EXIT when they are set
//   FAKE_CODEX_FAIL_ONCE=<f>   when <f> does not exist yet, create it and fail this run at once (exit 1, the FAKE_CODEX_TURN_FAILED events); later runs behave
//                              normally (FAKE_CODEX_TURN_FAILED is then ignored)
//   FAKE_CODEX_SIGNAL=<sig>    after printing, kill this process with that signal (a run killed from outside)
//   FAKE_CODEX_HANG_ONCE=<f>   hang (until the timeout kills it) when <f> does not exist yet, creating it; later runs behave normally
//   FAKE_CODEX_NO_WRITE=1      exit 0 without writing the output file (a run that "succeeded" but produced nothing)
//   FAKE_CODEX_OUTPUT=<file>   copy that file's bytes to the `-o` path (a findings JSON, or garbage for a malformed run)
//   FAKE_CODEX_DURING=<cmd>    run this shell command (synchronously) before answering: lets a test change the world
//                              while "Codex is thinking"
//   FAKE_CODEX_DURING_OUTPUT=<file>  FAKE_CODEX_OUTPUT for that command (cmd.exe has no `VAR=x cmd` prefix)
//   FAKE_CODEX_HANG=<pidfile>  start a helper (its pid goes to <pidfile>, its pipes are closed) that writes the `-o`
//                              file after 2 s, then never answer: a hung Codex that left a helper behind
import { appendFileSync, existsSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';

const argv = process.argv.slice(2);

let stdin = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) stdin += chunk;

if (process.env.FAKE_CODEX_CAPTURE) {
  appendFileSync(process.env.FAKE_CODEX_CAPTURE, `${JSON.stringify({ argv, stdin })}\n`);
}

if (process.env.FAKE_CODEX_FAIL_ONCE && !existsSync(process.env.FAKE_CODEX_FAIL_ONCE)) {
  writeFileSync(process.env.FAKE_CODEX_FAIL_ONCE, 'failed');
  const id = process.env.FAKE_CODEX_THREAD_ID || '01a1c97d-8cee-7c50-83a7-9994cab1b194';
  for (const e of [{ type: 'thread.started', thread_id: id }, { type: 'turn.started' }, { type: 'turn.failed', error: { message: process.env.FAKE_CODEX_TURN_FAILED ?? '' } }]) writeSync(1, `${JSON.stringify(e)}\n`);
  process.exit(1);
}

if (process.env.FAKE_CODEX_DURING) {
  spawnSync(process.env.FAKE_CODEX_DURING, { shell: true, stdio: 'ignore', env: { ...process.env, FAKE_CODEX_DURING: '', FAKE_CODEX_OUTPUT: process.env.FAKE_CODEX_DURING_OUTPUT || process.env.FAKE_CODEX_OUTPUT } });
}

if (process.env.FAKE_CODEX_HANG_ONCE && !existsSync(process.env.FAKE_CODEX_HANG_ONCE)) {
  writeFileSync(process.env.FAKE_CODEX_HANG_ONCE, 'hung');
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}

if (process.env.FAKE_CODEX_HANG) {
  const out = argv[argv.indexOf('-o') + 1];
  const helper = spawn(process.execPath, ['-e', `setTimeout(() => { const fs = require('fs'); fs.writeFileSync(process.argv[1], fs.readFileSync(process.env.FAKE_CODEX_OUTPUT)); }, 2000)`, out], {
    stdio: 'ignore',
  });
  writeFileSync(process.env.FAKE_CODEX_HANG, String(helper.pid));
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}

const confirmRun = stdin === 'Reply OK';
const stdoutFile = confirmRun && process.env.FAKE_CODEX_CONFIRM_STDOUT ? process.env.FAKE_CODEX_CONFIRM_STDOUT : process.env.FAKE_CODEX_STDOUT;
if (stdoutFile) writeSync(1, readFileSync(stdoutFile));
if (process.env.FAKE_CODEX_TURN_FAILED && !process.env.FAKE_CODEX_FAIL_ONCE) {
  const id = process.env.FAKE_CODEX_THREAD_ID || '01a1c97d-8cee-7c50-83a7-9994cab1b194';
  for (const e of [{ type: 'thread.started', thread_id: id }, { type: 'turn.started' }, { type: 'turn.failed', error: { message: process.env.FAKE_CODEX_TURN_FAILED } }]) writeSync(1, `${JSON.stringify(e)}\n`);
}
if (process.env.FAKE_CODEX_SIGNAL) process.kill(process.pid, process.env.FAKE_CODEX_SIGNAL);

const exit = Number((confirmRun ? process.env.FAKE_CODEX_CONFIRM_EXIT : undefined) ?? process.env.FAKE_CODEX_EXIT ?? 0);
if (exit !== 0) {
  process.stderr.write(process.env.FAKE_CODEX_STDERR ?? '');
  process.exit(exit);
}

if (process.env.FAKE_CODEX_NO_WRITE !== '1') {
  const at = argv.indexOf('-o');
  if (at < 0 || !argv[at + 1]) {
    process.stderr.write('fake-codex: no -o <path> in argv');
    process.exit(98);
  }
  if (!process.env.FAKE_CODEX_OUTPUT) {
    process.stderr.write('fake-codex: FAKE_CODEX_OUTPUT is not set');
    process.exit(98);
  }
  // Write the bytes, never copyFileSync: on Windows a copy keeps the SOURCE's mtime, so a findings file the test
  // wrote before a slow CLI start looked like a stale answer ("codex output file predates this run"). Real Codex
  // writes a new file, so a fresh mtime is what the freshness check expects.
  writeFileSync(argv[at + 1], readFileSync(process.env.FAKE_CODEX_OUTPUT));
}
