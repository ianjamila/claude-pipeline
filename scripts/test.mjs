// Cross-version test runner: Node 20 has no --test globbing and cmd.exe does not expand globs,
// so list the test files ourselves and hand them to node --test.
//   node scripts/test.mjs [--shard I/N] [name-substring ...]
// --shard I/N runs bin I of N (sizes balanced by bytes, scripts/lib/shard.mjs); the Windows CI job uses 3 shards.
import { readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MAX_SHARDS, parseShard, shardFiles } from './lib/shard.mjs';

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
  names = shardFiles(names.map((name) => ({ name, size: statSync(join(testDir, name)).size })), shard.i, shard.n);
}
const files = names.map((f) => join(testDir, f));
if (files.length === 0) {
  console.error(shard ? `no test files in shard ${shard.i}/${shard.n}` : 'no test files matched');
  process.exit(2);
}
// A fixed machine id keeps lock tests from creating ~/.claude/pipeline-state/machine-id on the developer's machine.
const env = {
  ...process.env,
  PIPELINE_MACHINE_ID: process.env.PIPELINE_MACHINE_ID || 'test-machine-id',
};
const r = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit', env });
process.exit(r.status ?? 1);
