// Opt-in per-file timing for scripts/test.mjs: `node --test --import <this file> <files>` loads this in every test-file child
// process. When CP_TEST_TIMES is set, the child appends one JSON line { file, ms } to `${CP_TEST_TIMES}.jsonl` as it exits;
// scripts/test.mjs folds those lines into the JSON file (collectFileTimes). ms is the child's whole wall clock from process start
// (module load, setup, every top-level test, hooks, teardown). Why a preload and not a reporter: the parent sees a file's events
// only when Node replays them, in file order, so a quick file queued behind a slow one is stamped with the slow one's end time.
// Without CP_TEST_TIMES this does nothing.
import { appendFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

const out = process.env.CP_TEST_TIMES;
if (out && process.argv[1]) {
  const file = process.argv[1];
  process.on('exit', () => {
    try {
      appendFileSync(`${out}.jsonl`, `${JSON.stringify({ file, ms: performance.now() })}\n`);
    } catch { /* timing is best effort; never fail a test run for it */ }
  });
}
