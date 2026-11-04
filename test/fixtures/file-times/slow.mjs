// Timing fixture for scripts/lib/file-times-preload.mjs (not a test file of the suite; the .test.mjs name filter skips it):
// a 300 ms setup before any test, two top-level tests (200 ms, then 100 ms, the second concurrent) and a 50 ms after-hook.
import { test, after } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

await sleep(300);
test('one', async () => { await sleep(200); });
test('two', { concurrency: true }, async () => { await sleep(100); });
after(async () => { await sleep(50); });
