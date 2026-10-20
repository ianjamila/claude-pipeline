#!/usr/bin/env node
// A runnable stand-in for the two `lsof` forms the dev-server binder uses, driven by the JSON file named in FAKE_LSOF_SCENARIO:
//   listeners: { "<port>": [pid, ...] }   `lsof -nP -w -iTCP:<port> -sTCP:LISTEN -F pn`
//   cwds: { "<pid>": "<dir>" }            `lsof -nP -w -a -p <pid> -d cwd -Fn`
//   sleepMs: N     sleep N ms before answering (a hung lsof)
//   log: <file>    append one line per call (argv)
// Nothing found answers like lsof does: nothing on stdout or stderr, exit 1.
import fs from 'node:fs';

const scenario = JSON.parse(fs.readFileSync(process.env.FAKE_LSOF_SCENARIO, 'utf8'));
const args = process.argv.slice(2);
if (scenario.log) fs.appendFileSync(scenario.log, `${JSON.stringify(args)}\n`);
if (scenario.sleepMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, scenario.sleepMs);
const inet = args.find((a) => a.startsWith('-iTCP:'));
if (inet) {
  const pids = (scenario.listeners ?? {})[inet.slice('-iTCP:'.length)] ?? [];
  if (pids.length === 0) process.exit(1);
  process.stdout.write(pids.map((p) => `p${p}\nn*:${inet.slice('-iTCP:'.length)}\n`).join(''));
  process.exit(0);
}
const pid = args[args.indexOf('-p') + 1];
const cwd = (scenario.cwds ?? {})[pid];
if (cwd === undefined) process.exit(1);
process.stdout.write(`p${pid}\nfcwd\nn${cwd}\n`);
