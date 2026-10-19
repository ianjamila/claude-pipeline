// Test helper for verify-slot.test.mjs: the "full verify" a slot wrapper runs.
// Usage: node slot-child.mjs <startedFile> <releaseFile> <exitCode>
//   writes <startedFile>, then waits until <releaseFile> exists (polling every 10 ms) and exits with <exitCode>.
//   SIGTERM writes <startedFile>.sigterm and exits 42 at once, so a test can see that the wrapper forwarded the signal.
import { existsSync, writeFileSync } from 'node:fs';

const [startedFile, releaseFile, exitCode = '0'] = process.argv.slice(2);
process.on('SIGTERM', () => {
  writeFileSync(`${startedFile}.sigterm`, '');
  process.exit(42);
});
writeFileSync(startedFile, String(process.pid));
const timer = setInterval(() => {
  if (existsSync(releaseFile)) {
    clearInterval(timer);
    process.exit(Number(exitCode));
  }
}, 10);
