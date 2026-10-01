// Test helper: a separate OS process that takes a machine lock, so locks.test.mjs can prove cross-process behaviour.
// Usage: node hold-lock.mjs <dir> <name> <holdMs> [--go <file>] [--release <file>]
//   prints "held" (acquired) or "busy" (exit code 3), holds for <holdMs> (or until --release <file> exists), releases.
//   --go <file>: print "ready" first, then spin until <file> exists, so several children attempt in the same instant.
import { existsSync } from 'node:fs';
import { tryAcquire, release } from '../../pipeline/lib/locks.mjs';

const [dir, name, holdMs, ...flags] = process.argv.slice(2);
const flag = (f) => {
  const i = flags.indexOf(f);
  return i === -1 ? null : flags[i + 1];
};
const goFile = flag('--go');
const releaseFile = flag('--release');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (goFile) {
  console.log('ready');
  while (!existsSync(goFile)) {
    // busy-wait on purpose: a sleep would let the racing children drift apart by milliseconds
  }
}

const result = tryAcquire(name, { dir });
if (!result.acquired) {
  console.log('busy');
  process.exitCode = 3;
} else {
  console.log('held');
  const until = Date.now() + Number(holdMs);
  while (Date.now() < until && !(releaseFile && existsSync(releaseFile))) await sleep(10);
  release(result.lock);
}
