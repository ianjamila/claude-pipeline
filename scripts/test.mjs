// Cross-version test runner: Node 20 has no --test globbing and cmd.exe does not expand globs,
// so list the test files ourselves and hand them to node --test.
//   node scripts/test.mjs [--shard I/N] [name-substring ...]
// --shard I/N runs bin I of N (balanced by measured time, scripts/lib/test-weights.json, bytes for unmeasured files;
// scripts/lib/shard.mjs); the Windows CI job uses 3 shards.
// CP_TEST_TIMES=<path> also records each file's wall-clock time into <path> as { file: { spanMs } }
// (scripts/lib/file-times-preload.mjs); CI prints it so scripts/shard-weights.mjs can refresh the weights.
import { readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MAX_SHARDS, parseShard, shardFiles } from './lib/shard.mjs';
import { collectFileTimes } from './lib/file-times.mjs';

const libDir = join(dirname(fileURLToPath(import.meta.url)), 'lib');
const testDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'test');
const args = process.argv.slice(2);
let shard = null;
const only = [];
for (let k = 0; k < args.length; k++) {
  if (args[k] !== '--shard') { only.push(args[k]); continue; }
  shard = parseShard(args[++k]);
  if (!shard) {
    console.error(`--shard needs I/N with whole numbers, 1 <= I <= N <= ${MAX_SHARDS} (got ${JSON.stringify(args[k] ?? null)})`);
    process.exit(2);
  }
}
let names = readdirSync(testDir)
  .filter((f) => f.endsWith('.test.mjs'))
  .filter((f) => only.length === 0 || only.some((o) => f.includes(o)));
if (shard) {
  let weights = {};
  try { weights = JSON.parse(readFileSync(join(libDir, 'test-weights.json'), 'utf8')); } catch { /* no weights: bytes */ }
  names = shardFiles(names.map((name) => ({ name, size: statSync(join(testDir, name)).size })), shard.i, shard.n, weights);
}
const files = names.map((f) => join(testDir, f));
if (files.length === 0) {
  console.error(shard ? `no test files in shard ${shard.i}/${shard.n}` : 'no test files matched');
  process.exit(2);
}
// A fixed machine id keeps lock tests from creating a machine-id file in the developer's own pipeline state folder.
const env = {
  ...process.env,
  PIPELINE_MACHINE_ID: process.env.PIPELINE_MACHINE_ID || 'test-machine-id',
};
const timesOut = process.env.CP_TEST_TIMES;
const nodeArgs = timesOut ? ['--import', pathToFileURL(join(libDir, 'file-times-preload.mjs')).href] : [];
if (timesOut) rmSync(`${timesOut}.jsonl`, { force: true });
const r = spawnSync(process.execPath, [...nodeArgs, '--test', ...files], { stdio: 'inherit', env });
if (timesOut) {
  let lines = [];
  try { lines = readFileSync(`${timesOut}.jsonl`, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { /* none recorded */ }
  writeFileSync(timesOut, JSON.stringify(collectFileTimes(lines)));
  rmSync(`${timesOut}.jsonl`, { force: true });
}
process.exit(r.status ?? 1);
