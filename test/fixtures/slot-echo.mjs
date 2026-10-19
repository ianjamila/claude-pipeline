// Test helper for verify-slot.test.mjs: a "verify.full" that records the arguments it was started with.
// Usage: node slot-echo.mjs <outFile> [more args...]  ->  writes the whole argument list (JSON) to <outFile>, exits 0.
import { writeFileSync } from 'node:fs';

writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(2)));
