// Ignores the polite kill: on SIGTERM it records that it got one (marker file, argv[2]) and exits 0,
// which is exactly what a timed-out command must never be allowed to report. Only SIGKILL stops it
// from sleeping for 30 s without ever running the handler.
import { writeFileSync } from 'node:fs';

process.on('SIGTERM', () => {
  if (process.argv[2]) writeFileSync(process.argv[2], 'got SIGTERM');
  process.exit(0);
});
setTimeout(() => {}, 30000);
