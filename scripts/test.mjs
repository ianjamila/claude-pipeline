// Cross-version test runner: Node 20 has no --test globbing and cmd.exe does not expand globs,
// so list the test files ourselves and hand them to node --test.
//   node scripts/test.mjs [--shard I/N] [--related] [--list] [name-substring | exact-file.test.mjs ...]
// A name ending in .test.mjs selects exactly that file (no substring match); any other name is a substring filter
// (scripts/lib/select-tests.mjs). A name of either kind that matches no file exits 2, so a rename cannot quietly shrink a check.
// --related ADDS the test files related to what the branch changed (scripts/lib/related-tests.mjs: changed test files, tests that
// import or mention a changed file, directly or through the modules they use) to the named ones, best first, while their
// estimated time fits CP_QUICK_RELATED_BUDGET_MS (default 90000; 0 = none; `all` = no cap; changed test files always run).
// Names stay strict (exact .test.mjs, exit 2 when missing); related files are never "missing". It prints one summary line
// first (kept in .verify/logs/tests.log) and falls back to just the named files, saying why, when git cannot tell.
// CP_RELATED_CHANGED (test-only): a newline-separated list of repo-relative paths used INSTEAD OF git's changed files.
// --list prints the files that would run (and the summary) and exits 0 without running them.
// --shard I/N runs bin I of N (balanced by measured time, scripts/lib/test-weights.json, bytes for unmeasured files;
// scripts/lib/shard.mjs); the Windows CI job uses 3 shards.
// CP_TEST_TIMES=<path> also records each file's wall-clock time into <path> as { file: { spanMs } }
// (scripts/lib/file-times-preload.mjs); CI prints it so scripts/shard-weights.mjs can refresh the weights.
import { readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MAX_SHARDS, parseShard, shardFiles, weigh } from './lib/shard.mjs';
import { changedFiles, describeSelection, describeSelectionDetail, parseBudget, relatedTests } from './lib/related-tests.mjs';
import { selectTestFiles } from './lib/select-tests.mjs';
import { collectFileTimes } from './lib/file-times.mjs';
import { realRegistryFile, registryChange, snapshotRegistry } from './lib/registry-snapshot.mjs';

const libDir = join(dirname(fileURLToPath(import.meta.url)), 'lib');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const testDir = join(root, 'test');
const args = process.argv.slice(2);
let shard = null;
let related = false;
let listOnly = false;
const only = [];
for (let k = 0; k < args.length; k++) {
  if (args[k] === '--related') { related = true; continue; }
  if (args[k] === '--list') { listOnly = true; continue; }
  if (args[k] !== '--shard') { only.push(args[k]); continue; }
  shard = parseShard(args[++k]);
  if (!shard) {
    console.error(`--shard needs I/N with whole numbers, 1 <= I <= N <= ${MAX_SHARDS} (got ${JSON.stringify(args[k] ?? null)})`);
    process.exit(2);
  }
}
function loadWeights() {
  try { return JSON.parse(readFileSync(join(libDir, 'test-weights.json'), 'utf8')); } catch { return {}; } // no weights: bytes
}

// The named files plus the related ones (see the header). Never throws and never exits non-zero: when the related set cannot
// be computed the named files run alone and the summary line says why.
function addRelated(named, allTests) {
  const { budgetMs, error: budgetError } = parseBudget(process.env.CP_QUICK_RELATED_BUDGET_MS);
  if (budgetError) console.log(budgetError);
  if (budgetMs === 0) {
    console.log('related tests: off (CP_QUICK_RELATED_BUDGET_MS=0); running only the named files');
    return named;
  }
  try {
    const git = (a) => {
      const r = spawnSync('git', a, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      return { ok: r.status === 0, stdout: r.stdout ?? '' };
    };
    const injected = process.env.CP_RELATED_CHANGED;
    const changed = injected === undefined
      ? changedFiles(git)
      : { files: injected.split('\n').map((l) => l.trim()).filter(Boolean), basis: 'CP_RELATED_CHANGED' };
    const listed = git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
    if (changed.error || !listed.ok) {
      console.log(`related tests: not computed (${changed.error ?? 'git ls-files failed'}); running only the named files`);
      return named;
    }
    const sizes = allTests.map((name) => ({ name, size: statSync(join(testDir, name)).size }));
    const read = (p) => { try { return readFileSync(join(root, p), 'utf8'); } catch { return null; } };
    const result = relatedTests({
      tests: allTests, testDir: 'test', changed: changed.files, files: listed.stdout.split('\0').filter(Boolean), read,
      weights: weigh(sizes, loadWeights()), budgetMs, exclude: named,
    });
    console.log(describeSelection({ ...result, changedCount: changed.files.length, basis: changed.basis, budgetMs }));
    for (const l of describeSelectionDetail(result)) console.log(l);
    const extra = new Set(result.selected.map((s) => s.name));
    return allTests.filter((f) => named.includes(f) || extra.has(f));
  } catch (e) {
    console.log(`related tests: not computed (${e?.message ?? e}); running only the named files`);
    return named;
  }
}

const selected = selectTestFiles(readdirSync(testDir), only);
if (selected.missing.length > 0) {
  const describe = (o) => (o.endsWith('.test.mjs') ? `${o} (exact file name)` : `${o} (substring filter)`);
  console.error(`no test file in test/ matches: ${selected.missing.map(describe).join(', ')}`);
  process.exit(2);
}
let names = selected.names;
if (related) names = addRelated(names, readdirSync(testDir).filter((f) => f.endsWith('.test.mjs')));
if (shard) {
  names = shardFiles(names.map((name) => ({ name, size: statSync(join(testDir, name)).size })), shard.i, shard.n, loadWeights());
}
const files = names.map((f) => join(testDir, f));
if (listOnly) {
  console.log(names.join('\n'));
  process.exit(0);
}
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
// The suite must not touch the account's real Fable floor registry (tests use a scratch PIPELINE_MODEL_FLOOR_DIR): compare before and after.
const registryBefore = snapshotRegistry();
const r = spawnSync(process.execPath, [...nodeArgs, '--test', ...files], { stdio: 'inherit', env });
const registryProblem = registryChange(registryBefore, snapshotRegistry(), realRegistryFile());
if (registryProblem) console.error(`FAIL: ${registryProblem}`);
if (timesOut) {
  let lines = [];
  try { lines = readFileSync(`${timesOut}.jsonl`, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { /* none recorded */ }
  writeFileSync(timesOut, JSON.stringify(collectFileTimes(lines)));
  rmSync(`${timesOut}.jsonl`, { force: true });
}
process.exit(registryProblem ? 1 : (r.status ?? 1));
