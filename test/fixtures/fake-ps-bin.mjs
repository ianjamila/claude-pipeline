#!/usr/bin/env node
// A runnable stand-in for `ps -o <field> -p <pid>` (the only form stack-stop's identity code uses), driven by the JSON file
// named in FAKE_PS_SCENARIO:
//   procs: { "<pid>": { ppid, comm, args?, lstart } }   lstart in the C locale, e.g. "Mon Oct 19 02:47:17 2026"
//   sleepMs: N   sleep N ms before answering (a hung ps)
//   log: <file>  append one line per call (argv + the TZ / LC_ALL it was given)
// An unknown pid answers like ps does for a dead process: nothing on stdout or stderr, exit 1.
import fs from 'node:fs';

const scenario = JSON.parse(fs.readFileSync(process.env.FAKE_PS_SCENARIO, 'utf8'));
const args = process.argv.slice(2);
if (scenario.log) fs.appendFileSync(scenario.log, `${JSON.stringify({ args, TZ: process.env.TZ ?? null, LC_ALL: process.env.LC_ALL ?? null })}\n`);
if (scenario.sleepMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, scenario.sleepMs);
const field = args[args.indexOf('-o') + 1];
const proc = (scenario.procs ?? {})[args[args.indexOf('-p') + 1]];
if (!proc) process.exit(1);
if (field === 'ppid=,comm=') process.stdout.write(`${proc.ppid} ${proc.comm}\n`);
else if (field === 'args=') process.stdout.write(`${proc.args ?? proc.comm}\n`);
else if (field === 'lstart=') process.stdout.write(`${proc.lstart}\n`);
else {
  process.stderr.write(`fake ps: unexpected ${args.join(' ')}\n`);
  process.exit(2);
}
