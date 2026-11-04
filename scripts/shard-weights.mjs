// Refreshes scripts/lib/test-weights.json from CI: node scripts/shard-weights.mjs <run-id> [<run-id> ...]
// Each run's Windows shard jobs ("test (windows I/N)") print their per-file times between CP-FILE-TIMES-BEGIN/END marker lines
// (.github/workflows/ci.yml, set up by CP_TEST_TIMES in scripts/test.mjs). This reads those blocks with `gh`, takes the median
// ms per file over the runs and writes the weights file that scripts/test.mjs --shard balances by. Run it from a clone of the
// repo (gh uses its remote); nothing is pushed.
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractTimes, medianWeights } from './lib/file-times.mjs';

const out = join(dirname(fileURLToPath(import.meta.url)), 'lib', 'test-weights.json');
const gh = (args) => {
  const r = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`gh ${args.join(' ')} failed: ${(r.stderr || r.error?.message || '').trim().split('\n')[0]}`);
  return r.stdout;
};

const runs = process.argv.slice(2);
if (runs.length === 0 || runs.some((r) => !/^\d+$/.test(r))) {
  console.error('usage: node scripts/shard-weights.mjs <run-id> [<run-id> ...]');
  process.exit(2);
}
const measured = [];
for (const run of runs) {
  const jobs = JSON.parse(gh(['run', 'view', run, '--json', 'jobs'])).jobs.filter((j) => /^test \(windows \d+\/\d+\)$/.test(j.name));
  const merged = {};
  for (const job of jobs) {
    const times = extractTimes(gh(['run', 'view', run, '--log', '--job', String(job.databaseId)]));
    if (!times) { console.error(`run ${run}: no file times in "${job.name}" (skipped)`); continue; }
    Object.assign(merged, times); // the shards run disjoint files, so one run is the union of its shards
  }
  if (Object.keys(merged).length === 0) { console.error(`run ${run}: no file times at all (skipped)`); continue; }
  console.log(`run ${run}: ${Object.keys(merged).length} files`);
  measured.push(merged);
}
if (measured.length === 0) {
  console.error('nothing measured; the weights file is unchanged');
  process.exit(1);
}
const weights = medianWeights(measured);
writeFileSync(out, `${JSON.stringify(weights, null, 2)}\n`);
console.log(`wrote ${Object.keys(weights).length} weights (median of ${measured.length} run${measured.length === 1 ? '' : 's'}) to ${out}`);
