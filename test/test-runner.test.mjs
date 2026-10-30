// scripts/test.mjs --shard I/N: the Windows CI job runs the suite in N shards. The assignment is a pure function
// (scripts/lib/shard.mjs) so these tests need no child suite: bins must be disjoint, cover every file, and be the
// same on every call (each CI shard computes its own bin independently).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shardFiles } from '../scripts/lib/shard.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const runner = join(root, 'scripts', 'test.mjs');

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
