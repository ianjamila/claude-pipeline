// Test helper for verify-slot.test.mjs: a "full verify" that ignores SIGTERM for ~300 ms before it exits.
// Usage: node slot-stubborn.mjs <startedFile> <termFile> <doneFile>
//   writes <startedFile> at start; on SIGTERM writes <termFile>, keeps running 300 ms, then writes <doneFile> and exits 0.
import { writeFileSync } from 'node:fs';

const [startedFile, termFile, doneFile] = process.argv.slice(2);
process.on('SIGTERM', () => {
  writeFileSync(termFile, String(Date.now()));
  setTimeout(() => {
    writeFileSync(doneFile, String(Date.now()));
    process.exit(0);
  }, 300);
});
writeFileSync(startedFile, String(process.pid));
setInterval(() => {}, 1000); // stay alive until the signal
