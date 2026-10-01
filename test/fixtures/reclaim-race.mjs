// Test helper for the "two reclaimers + abandoned guard" interleaving: a child process that pauses at a chosen point
// inside tryAcquire (through its test-only hooks) until the orchestrating test lets it continue.
// Usage: node reclaim-race.mjs <dir> <D|C> <gateDir>
//   D pauses just before it breaks an abandoned reclaim guard; C pauses inside its reclaim critical section.
//   A gate is a pair of files in <gateDir>: <who>.reached (written by the child) and <who>.go (written by the test).
//   Prints "<who> acquired=<bool>", then (if it got the lock) holds it until <gateDir>/done exists and releases.
import { existsSync, writeFileSync } from 'node:fs';
import { tryAcquire, release } from '../../pipeline/lib/locks.mjs';

const [dir, who, gateDir] = process.argv.slice(2);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const gate = () => () => {
  writeFileSync(`${gateDir}/${who}.reached`, '');
  while (!existsSync(`${gateDir}/${who}.go`)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
};
const hooks = who === 'D' ? { beforeBreakGuard: gate() } : { insideGuard: gate() };

const result = tryAcquire('db', { dir, runId: who, hooks });
console.log(`${who} acquired=${result.acquired}`);
if (result.acquired) {
  while (!existsSync(`${gateDir}/done`)) await sleep(20);
  console.log(`${who} release=${release(result.lock)}`);
}
