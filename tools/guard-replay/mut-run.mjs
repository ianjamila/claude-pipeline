// usage: node tools/guard-replay/mut-run.mjs <capMs> <testFile> <namePattern> — runs the matching tests in a child process, killed at capMs.
// A mutation is caught when the run fails OR is killed (a test that hangs for minutes is a failing timing test).
import { spawnSync } from 'node:child_process';
const [cap, file, pattern] = process.argv.slice(2);
const r = spawnSync(process.execPath, ['--test', `--test-name-pattern=${pattern}`, file], { timeout: Number(cap), encoding: 'utf8' });
const tail = `${r.stdout ?? ''}`.split('\n').filter((l) => /^ℹ (pass|fail)|^✖/.test(l)).join('\n');
console.log(r.signal ? `KILLED after ${cap} ms (caught)` : r.status === 0 ? 'PASSED (mutation NOT caught)' : 'FAILED (caught)');
console.log(tail);
