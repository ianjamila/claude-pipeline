// Test helper for verify-slot.test.mjs: a "full verify" that ignores SIGTERM until the test releases it.
// Usage: node slot-stubborn.mjs <startedFile> <termFile> <doneFile> <releaseFile>
//   writes <startedFile> at start; on SIGTERM writes <termFile>, keeps running until <releaseFile> exists (or 60 s pass),
//   then writes <doneFile> and exits 0. A release file, not a fixed delay: under machine load the test's checks between
//   the signal and the exit can take seconds, and a timed exit would finish before them.
import { existsSync, writeFileSync } from 'node:fs';

const [startedFile, termFile, doneFile, releaseFile] = process.argv.slice(2);
process.on('SIGTERM', () => {
  writeFileSync(termFile, String(Date.now()));
  const end = Date.now() + 60_000;
  setInterval(() => {
    if (!existsSync(releaseFile) && Date.now() < end) return;
    writeFileSync(doneFile, String(Date.now()));
    process.exit(0);
  }, 20);
});
writeFileSync(startedFile, String(process.pid));
setInterval(() => {}, 1000); // stay alive until the signal
