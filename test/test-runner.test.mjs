// scripts/test.mjs --shard I/N: the Windows CI job runs the suite in N shards. The assignment is a pure function
// (scripts/lib/shard.mjs) so these tests need no child suite: bins must be disjoint, cover every file, and be the
// same on every call (each CI shard computes its own bin independently).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { shardFiles } from '../scripts/lib/shard.mjs';
import { collectFileTimes, extractTimes, medianWeights, MARK_BEGIN, MARK_END } from '../scripts/lib/file-times.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const runner = join(root, 'scripts', 'test.mjs');
// A nested `node --test` inside a test must not think it is a child of the outer run (it would speak the child protocol).
const nestedEnv = (extra = {}) => {
  const env = { ...process.env, ...extra };
  delete env.NODE_TEST_CONTEXT;
  return env;
};
const preload = join(root, 'scripts', 'lib', 'file-times-preload.mjs');

const sample = () => [
  { name: 'a.test.mjs', size: 900 }, { name: 'b.test.mjs', size: 100 }, { name: 'c.test.mjs', size: 500 },
  { name: 'd.test.mjs', size: 500 }, { name: 'e.test.mjs', size: 40 }, { name: 'f.test.mjs', size: 4000 },
  { name: 'g.test.mjs', size: 4000 }, { name: 'h.test.mjs', size: 7 }, { name: 'i.test.mjs', size: 300 },
  { name: 'j.test.mjs', size: 300 },
];

test('shardFiles: for N in 1..4 the bins are disjoint, cover every file, and are identical across calls', () => {
  const files = sample();
  for (let n = 1; n <= 4; n++) {
    const bins = [];
    for (let i = 1; i <= n; i++) bins.push(shardFiles(files, i, n));
    const all = bins.flat();
    assert.equal(new Set(all).size, all.length, `n=${n}: no file in two bins`);
    assert.deepEqual([...all].sort(), files.map((f) => f.name).sort(), `n=${n}: every file in some bin`);
    for (let i = 1; i <= n; i++) assert.deepEqual(shardFiles(files, i, n), bins[i - 1], `n=${n} i=${i}: stable`);
    for (const bin of bins) assert.ok(bin.length > 0, `n=${n}: no empty bin when files >= n`);
  }
});

test('shardFiles: the input order does not change the assignment (the runner lists files in directory order)', () => {
  const files = sample();
  const shuffled = [...files].reverse();
  for (let i = 1; i <= 3; i++) assert.deepEqual(shardFiles(shuffled, i, 3), shardFiles(files, i, 3));
});

test('shardFiles: longest-first greedy balances the bins by bytes, ties broken by name', () => {
  const files = [
    { name: 'big1', size: 100 }, { name: 'big2', size: 100 }, { name: 'mid', size: 60 },
    { name: 'small1', size: 50 }, { name: 'small2', size: 50 },
  ];
  // 100 -> bin1, 100 -> bin2, 60 -> bin1 (100/100 tie goes to the lowest bin), 50 -> bin2 (100 < 160), 50 -> bin2 (150 < 160)
  assert.deepEqual(shardFiles(files, 1, 2), ['big1', 'mid']);
  assert.deepEqual(shardFiles(files, 2, 2), ['big2', 'small1', 'small2']);
});

test('shardFiles: a bin is returned in sorted name order', () => {
  const bin = shardFiles(sample(), 1, 2);
  assert.deepEqual(bin, [...bin].sort());
});

test('shardFiles: fewer files than shards leaves the extra bins empty, never throws', () => {
  const files = [{ name: 'only.test.mjs', size: 1 }];
  assert.deepEqual(shardFiles(files, 1, 3), ['only.test.mjs']);
  assert.deepEqual(shardFiles(files, 2, 3), []);
  assert.deepEqual(shardFiles(files, 3, 3), []);
});

test('scripts/test.mjs --shard: an invalid spec is exit 2 with a message on stderr, before any test runs', () => {
  for (const spec of ['0/3', '4/3', '1/9', 'x/3', '1/x', '1.5/3', '2', '', '1/0', '-1/3', '1/3/4']) {
    const r = spawnSync(process.execPath, [runner, '--shard', spec, 'test-runner'], { encoding: 'utf8' });
    assert.equal(r.status, 2, `--shard ${JSON.stringify(spec)}: exit ${r.status}, stderr ${r.stderr}`);
    assert.match(r.stderr, /shard/i, spec);
  }
  const missing = spawnSync(process.execPath, [runner, '--shard'], { encoding: 'utf8' });
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /shard/i);
});

// ---- time-weighted shards -------------------------------------------------------------------------------------------

test('shardFiles: a measured weight overrides the size in bytes', () => {
  const files = [{ name: 'a', size: 1000 }, { name: 'b', size: 10 }, { name: 'c', size: 10 }];
  // By bytes a is alone; with b measured as the slow one the bins swap.
  assert.deepEqual(shardFiles(files, 1, 2), ['a']);
  const weights = { a: 5, b: 900, c: 800 };
  assert.deepEqual(shardFiles(files, 1, 2, weights), ['b']);
  assert.deepEqual(shardFiles(files, 2, 2, weights), ['a', 'c']);
});

test('shardFiles: a file with no measured weight is estimated as bytes x the median ms/byte of the measured files', () => {
  // measured: x 10 ms/B, y 30 ms/B, z 20 ms/B -> median 20 ms/B -> u (5 B) weighs 100, v (1 B) weighs 20
  const files = [
    { name: 'x', size: 100 }, { name: 'y', size: 100 }, { name: 'z', size: 100 }, { name: 'u', size: 5 }, { name: 'v', size: 1 },
  ];
  const weights = { x: 1000, y: 3000, z: 2000 };
  // y 3000 -> bin1, z 2000 -> bin2, x 1000 -> bin2, u 100 -> bin2 (3000 vs 3000 ties to the lowest bin: bin1)
  assert.deepEqual(shardFiles(files, 1, 2, weights), ['u', 'y']);
  assert.deepEqual(shardFiles(files, 2, 2, weights), ['v', 'x', 'z']);
  // with NO measured file the estimate is the plain size (the bytes fallback)
  assert.deepEqual(shardFiles(files, 1, 2, {}), shardFiles(files, 1, 2));
  // weights for files that no longer exist, and junk values, are ignored
  assert.deepEqual(shardFiles(files, 1, 2, { gone: 99999, x: -4, y: 'slow', z: NaN }), shardFiles(files, 1, 2));
});

test('shardFiles with weights: bins partition the files, are deterministic and ignore input order', () => {
  const files = sample();
  const weights = { 'a.test.mjs': 700, 'f.test.mjs': 90, 'c.test.mjs': 400, 'j.test.mjs': 1200 };
  for (let n = 1; n <= 4; n++) {
    const seen = [];
    for (let i = 1; i <= n; i++) {
      const bin = shardFiles(files, i, n, weights);
      assert.deepEqual(shardFiles([...files].reverse(), i, n, weights), bin, `n=${n} i=${i}: input order`);
      assert.deepEqual(shardFiles(files, i, n, weights), bin, `n=${n} i=${i}: stable`);
      seen.push(...bin);
    }
    assert.deepEqual([...seen].sort(), files.map((f) => f.name).sort(), `n=${n}: disjoint and complete`);
  }
});

test('the committed scripts/lib/test-weights.json is a plain { file: ms } object', () => {
  const w = JSON.parse(readFileSync(join(root, 'scripts', 'lib', 'test-weights.json'), 'utf8'));
  assert.ok(w && typeof w === 'object' && !Array.isArray(w));
  for (const [k, v] of Object.entries(w)) {
    assert.match(k, /\.test\.mjs$/, k);
    assert.ok(Number.isFinite(v) && v > 0, `${k}: ${v}`);
  }
});

// The span method of the plan (parent clock at the first/last event of data.file) was checked against this fixture and does NOT
// hold: Node replays the events of a later file only after the earlier file finished, so a quick file behind a slow one gets the
// slow one's end time, and a file waiting for a free slot looks started. The preload times the child process itself instead.
test('file-times preload: each file of a two-file run gets its own wall-clock span, covering setup, tests and the after-hook', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-times-'));
  try {
    const out = join(dir, 'times.json');
    const fx = (n) => join(root, 'test', 'fixtures', 'file-times', n);
    const r = spawnSync(process.execPath, ['--test', '--import', pathToFileURL(preload).href, fx('slow.mjs'), fx('quick.mjs')], {
      encoding: 'utf8', env: nestedEnv({ CP_TEST_TIMES: out }),
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const lines = readFileSync(`${out}.jsonl`, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const times = collectFileTimes(lines);
    assert.deepEqual(Object.keys(times).sort(), ['quick.mjs', 'slow.mjs']);
    // 300 setup + 200 + 100 + 50 after-hook = 650 ms of work in slow.mjs; the quick file is not given the slow file's time
    assert.ok(times['slow.mjs'].spanMs >= 600, `slow.mjs span ${times['slow.mjs'].spanMs}`);
    assert.ok(times['quick.mjs'].spanMs >= 140, `quick.mjs span ${times['quick.mjs'].spanMs}`);
    assert.ok(times['quick.mjs'].spanMs < times['slow.mjs'].spanMs, 'two files are two entries, not one overwritten');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('file-times preload does nothing unless CP_TEST_TIMES is set', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-times-'));
  try {
    const env = nestedEnv();
    delete env.CP_TEST_TIMES;
    const r = spawnSync(process.execPath, ['--test', '--import', pathToFileURL(preload).href, join(root, 'test', 'fixtures', 'file-times', 'quick.mjs')], { encoding: 'utf8', env, cwd: dir });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(readdirSync(dir), [], 'no file written');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('collectFileTimes: one entry per file by base name (Windows and POSIX paths), the longest span wins, junk lines are skipped', () => {
  const t = collectFileTimes([
    { file: 'D:\\a\\p\\test\\one.test.mjs', ms: 1234.4 }, { file: '/x/test/two.test.mjs', ms: 90 },
    { file: '/x/test/two.test.mjs', ms: 70 }, { file: '', ms: 5 }, { file: 'bad.mjs', ms: 'x' }, null, { file: 'neg.mjs', ms: -1 },
  ]);
  assert.deepEqual(t, { 'one.test.mjs': { spanMs: 1234 }, 'two.test.mjs': { spanMs: 90 } });
});

test('scripts/test.mjs with CP_TEST_TIMES writes { file: { spanMs } } for the files it ran, then removes its scratch file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-times-'));
  try {
    const out = join(dir, 'times.json');
    const r = spawnSync(process.execPath, [runner, 'glob.test'], { encoding: 'utf8', env: nestedEnv({ CP_TEST_TIMES: out }) });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const t = JSON.parse(readFileSync(out, 'utf8'));
    assert.deepEqual(Object.keys(t), ['glob.test.mjs']);
    assert.ok(t['glob.test.mjs'].spanMs > 0);
    assert.deepEqual(readdirSync(dir), ['times.json'], 'the .jsonl scratch file is gone');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- scripts/shard-weights.mjs -------------------------------------------------------------------------------------------

const logOf = (json, job = 'test (windows 1/3)') => [
  `${job}\tUNKNOWN STEP\t2026-11-04T10:16:42.4516937Z ✔ something (12.5ms)`,
  `${job}\tUNKNOWN STEP\t2026-11-04T10:36:07.0000000Z ${MARK_BEGIN}`,
  `${job}\tUNKNOWN STEP\t2026-11-04T10:36:07.0000001Z ${json}`,
  `${job}\tUNKNOWN STEP\t2026-11-04T10:36:07.0000002Z ${MARK_END}`,
  `${job}\tUNKNOWN STEP\t2026-11-04T10:36:08.1946673Z ℹ pass 2005`,
].join('\r\n');

test('extractTimes: reads the JSON between the marker lines of a Windows job log (CRLF, step prefix and timestamp stripped)', () => {
  const t = extractTimes(logOf(JSON.stringify({ 'a.test.mjs': { spanMs: 1500 }, 'b.test.mjs': { spanMs: 20 } })));
  assert.deepEqual(t, { 'a.test.mjs': { spanMs: 1500 }, 'b.test.mjs': { spanMs: 20 } });
});

test('extractTimes: no markers, an unterminated block or invalid JSON is null, never a throw', () => {
  assert.equal(extractTimes('just a log\nwith lines'), null);
  assert.equal(extractTimes(`2026-11-04T10:36:07Z ${MARK_BEGIN}\n2026-11-04T10:36:08Z {"a":`), null);
  assert.equal(extractTimes(logOf('{not json')), null);
});

test('medianWeights: median ms per file over the runs that measured it, rounded, sorted by name', () => {
  const w = medianWeights([
    { 'b.test.mjs': { spanMs: 100 }, 'a.test.mjs': { spanMs: 10 } },
    { 'b.test.mjs': { spanMs: 300 } },
    { 'b.test.mjs': { spanMs: 200 }, 'a.test.mjs': { spanMs: 31 } },
    { 'junk.test.mjs': { spanMs: 0 }, 'worse.test.mjs': null },
  ]);
  assert.deepEqual(w, { 'a.test.mjs': 21, 'b.test.mjs': 200 });
  assert.deepEqual(Object.keys(w), ['a.test.mjs', 'b.test.mjs']);
});

test('scripts/shard-weights.mjs: no run id, or a non-numeric one, is a usage error (exit 2) and leaves the weights file alone', () => {
  const file = join(root, 'scripts', 'lib', 'test-weights.json');
  const before = readFileSync(file, 'utf8');
  for (const argv of [[], ['abc'], ['123', '--x']]) {
    const r = spawnSync(process.execPath, [join(root, 'scripts', 'shard-weights.mjs'), ...argv], { encoding: 'utf8' });
    assert.equal(r.status, 2, `${JSON.stringify(argv)}: ${r.stderr}`);
    assert.match(r.stderr, /usage/);
  }
  assert.equal(readFileSync(file, 'utf8'), before);
});

// ---- name selection ------------------------------------------------------------------------------------------------
// The quick check lists `cli.test.mjs`: an argument ending in .test.mjs names exactly one file (a substring `cli` would
// also pick every *-cli test), other arguments stay substring filters.

const pool = ['cli.test.mjs', 'ci-wait-cli.test.mjs', 'cli-review.test.mjs', 'config.test.mjs', 'docs-facts.test.mjs'];

test('selectTestFiles: an argument ending in .test.mjs selects exactly that file, not the files that contain it', async () => {
  const { selectTestFiles } = await import('../scripts/lib/select-tests.mjs');
  assert.deepEqual(selectTestFiles(pool, ['cli.test.mjs']), { names: ['cli.test.mjs'], missing: [] });
  assert.deepEqual(selectTestFiles(pool, ['ci-wait-cli.test.mjs']).names, ['ci-wait-cli.test.mjs']);
});

test('selectTestFiles: other arguments keep the substring match, and exact and substring arguments combine', async () => {
  const { selectTestFiles } = await import('../scripts/lib/select-tests.mjs');
  assert.deepEqual(selectTestFiles(pool, ['cli']).names, ['cli.test.mjs', 'ci-wait-cli.test.mjs', 'cli-review.test.mjs']);
  assert.deepEqual(selectTestFiles(pool, ['config', 'cli.test.mjs']).names, ['cli.test.mjs', 'config.test.mjs']);
  assert.deepEqual(selectTestFiles(pool, []).names, pool);
});

test('selectTestFiles: an exact .test.mjs argument that names no file is reported as missing', async () => {
  const { selectTestFiles } = await import('../scripts/lib/select-tests.mjs');
  assert.deepEqual(selectTestFiles(pool, ['config', 'clii.test.mjs']), { names: ['config.test.mjs'], missing: ['clii.test.mjs'] });
  // a .test.mjs argument is never a substring: `ci.test.mjs` does not match ci-wait-cli.test.mjs
  assert.deepEqual(selectTestFiles(pool, ['ci.test.mjs']), { names: [], missing: ['ci.test.mjs'] });
});

test('selectTestFiles: a substring argument that matches no file is reported as missing; a matching one is not', async () => {
  const { selectTestFiles } = await import('../scripts/lib/select-tests.mjs');
  assert.deepEqual(selectTestFiles(pool, ['config', 'no-such-substring']), { names: ['config.test.mjs'], missing: ['no-such-substring'] });
  assert.deepEqual(selectTestFiles(pool, ['config', 'docs']), { names: ['config.test.mjs', 'docs-facts.test.mjs'], missing: [] });
  // both kinds at once, in argument order
  assert.deepEqual(selectTestFiles(pool, ['nope', 'clii.test.mjs']).missing, ['nope', 'clii.test.mjs']);
});

test('scripts/test.mjs: an unknown exact .test.mjs name is exit 2 naming it, even when other arguments match', () => {
  for (const argv of [['no-such-file.test.mjs'], ['test-runner', 'no-such-file.test.mjs']]) {
    const r = spawnSync(process.execPath, [runner, ...argv], { encoding: 'utf8', env: nestedEnv() });
    assert.equal(r.status, 2, `${argv}: exit ${r.status}, stderr ${r.stderr}`);
    assert.match(r.stderr, /no-such-file\.test\.mjs \(exact file name\)/);
    assert.doesNotMatch(r.stdout, /^# tests/m, 'no test ran');
  }
});

test('scripts/test.mjs: a substring that matches nothing is exit 2 naming it, even when other arguments match', () => {
  for (const [argv, label] of [
    [['zzz-no-such-substring'], /zzz-no-such-substring \(substring filter\)/],
    [['config.test.mjs', 'no-such-substring-xyz'], /no-such-substring-xyz \(substring filter\)/],
  ]) {
    const r = spawnSync(process.execPath, [runner, ...argv], { encoding: 'utf8', env: nestedEnv() });
    assert.equal(r.status, 2, `${argv}: exit ${r.status}, stderr ${r.stderr}`);
    assert.match(r.stderr, label);
    assert.doesNotMatch(r.stdout, /^# tests/m, 'no test ran');
  }
});

test('verify --quick lists exact .test.mjs files only, each present in test/ (a renamed file must not quietly drop out)', () => {
  const src = readFileSync(join(root, 'scripts', 'verify.mjs'), 'utf8');
  const quick = /quickCmd: '([^']*)'/.exec(src)?.[1] ?? '';
  const all = quick.split(/\s+/).slice(quick.split(/\s+/).indexOf('scripts/test.mjs') + 1).filter(Boolean);
  assert.ok(all.includes('--related'), 'quick also runs the tests related to the branch changes');
  const args = all.filter((a) => a !== '--related'); // the flag; every other argument is a named file
  assert.ok(args.length > 0, `no arguments after scripts/test.mjs in "${quick}"`);
  for (const a of args) {
    assert.ok(a.endsWith('.test.mjs'), `${a} must be an exact .test.mjs name, not a substring`);
    assert.ok(existsSync(join(root, 'test', a)), `test/${a} does not exist`);
  }
  assert.ok(args.includes('cli.test.mjs'), 'a bare `cli` would also run every *-cli test');
  assert.ok(!args.includes('worktree-prune-config-fallback.test.mjs'), 'the slow prune fallback test is not a quick check');
});
