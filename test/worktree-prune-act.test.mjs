import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { archivePaths, listHolding, purgeHolding, holdingRoot } from '../pipeline/lib/worktree-prune/act.mjs';

const day = 86400e3;
const T = Date.parse('2026-10-13T00:00:00Z');

test('holdingRoot sanitises the slug and honours the env override', () => {
  assert.equal(holdingRoot('acme/widgets', { PIPELINE_HOLDING_DIR: '/h' }), join('/h', 'acme_widgets'));
});

test('archive -> manifest -> list -> collision suffix', () => {
  const wt = mkdtempSync(join(tmpdir(), 'wt-')); const h = mkdtempSync(join(tmpdir(), 'hold-'));
  mkdirSync(join(wt, '.review')); writeFileSync(join(wt, '.review', 'state.json'), '{"a":1}');
  const r = archivePaths({ wtPath: wt, rels: ['.review/state.json'], holdingDir: h, slug: 'agent-x', pr: 9, nowMs: T });
  assert.equal(existsSync(join(wt, '.review', 'state.json')), false);
  const m = JSON.parse(readFileSync(join(r.batchDir, 'MANIFEST.json'), 'utf8'));
  assert.equal(m.items[0].original, join(wt, '.review', 'state.json'));
  assert.equal(m.items[0].archivedAt, '2026-10-13T00:00:00.000Z');
  assert.equal(readFileSync(m.items[0].stored, 'utf8'), '{"a":1}');
  mkdirSync(join(wt, '.review'), { recursive: true }); // archiving removed the emptied .review dir
  writeFileSync(join(wt, '.review', 'state.json'), '{"a":2}');
  const r2 = archivePaths({ wtPath: wt, rels: ['.review/state.json'], holdingDir: h, slug: 'agent-x', pr: 9, nowMs: T });
  assert.notEqual(r2.items[0].stored, m.items[0].stored);
  const l = listHolding(h);
  assert.equal(l.length, 1); assert.equal(l[0].items, 2); assert.match(l[0].restore[0], /^mv /);
});

test('purge: only batches whose every item is > 30 days old; bad/future timestamps keep', () => {
  const h = mkdtempSync(join(tmpdir(), 'hold-'));
  const mk = (name, archivedAt) => { mkdirSync(join(h, name)); writeFileSync(join(h, name, 'MANIFEST.json'), JSON.stringify({ version: 1, items: [{ original: '/x', stored: join(h, name, 'x'), size: 0, sha256: '', archivedAt }] })); };
  mk('2026-09-01', new Date(T - 40 * day).toISOString());
  mk('2026-10-01', new Date(T - 10 * day).toISOString());
  mk('bad', 'not a date');
  mk('future', new Date(T + day).toISOString());
  const r = purgeHolding(h, { nowMs: T });
  assert.deepEqual(r.purged, ['2026-09-01']);
  assert.deepEqual(r.kept.map((k) => k.batch).sort(), ['2026-10-01', 'bad', 'future']);
  assert.equal(existsSync(join(h, '2026-09-01')), false);
});

test('archive: records size + sha256, handles nested rels, prunes emptied dirs but never the worktree root', () => {
  const wt = mkdtempSync(join(tmpdir(), 'wt-')); const h = mkdtempSync(join(tmpdir(), 'hold-'));
  mkdirSync(join(wt, 'a', 'b'), { recursive: true });
  writeFileSync(join(wt, 'a', 'b', 'one.txt'), 'hello'); writeFileSync(join(wt, 'a', 'keep.txt'), 'k');
  const r = archivePaths({ wtPath: wt, rels: ['a/b/one.txt'], holdingDir: h, slug: 's', pr: null, nowMs: T });
  assert.equal(r.items[0].size, 5);
  assert.equal(r.items[0].sha256, '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  assert.equal(r.items[0].slug, 's'); assert.equal(r.items[0].pr, null);
  assert.equal(r.items[0].stored, join(r.batchDir, 's', 'a', 'b', 'one.txt'));
  assert.equal(existsSync(join(wt, 'a', 'b')), false, 'emptied dir removed');
  assert.equal(existsSync(join(wt, 'a', 'keep.txt')), true, 'non-empty parent stays');
  const only = mkdtempSync(join(tmpdir(), 'wt-'));
  writeFileSync(join(only, 'x.txt'), 'x');
  archivePaths({ wtPath: only, rels: ['x.txt'], holdingDir: h, slug: 's2', pr: 1, nowMs: T });
  assert.equal(existsSync(only), true, 'worktree root is never removed');
});

test('archive: a second archive the same day appends to the manifest; a rel escaping the worktree is refused', () => {
  const wt = mkdtempSync(join(tmpdir(), 'wt-')); const h = mkdtempSync(join(tmpdir(), 'hold-'));
  writeFileSync(join(wt, 'a.txt'), 'a'); writeFileSync(join(wt, 'b.txt'), 'b');
  const r1 = archivePaths({ wtPath: wt, rels: ['a.txt'], holdingDir: h, slug: 's1', pr: 1, nowMs: T });
  const r2 = archivePaths({ wtPath: wt, rels: ['b.txt'], holdingDir: h, slug: 's2', pr: 2, nowMs: T + 1000 });
  assert.equal(r1.batchDir, r2.batchDir);
  const m = JSON.parse(readFileSync(join(r1.batchDir, 'MANIFEST.json'), 'utf8'));
  assert.deepEqual(m.items.map((i) => i.slug), ['s1', 's2']);
  assert.deepEqual(readdirSync(r1.batchDir).sort(), ['MANIFEST.json', 's1', 's2'], 'no temp file left behind');
  assert.throws(() => archivePaths({ wtPath: wt, rels: ['../evil.txt'], holdingDir: h, slug: 's3', pr: 3, nowMs: T }), /outside/);
});

test('list: restore commands quote paths with spaces; an unreadable manifest still lists', () => {
  const wt = mkdtempSync(join(tmpdir(), 'wt dir-')); const h = mkdtempSync(join(tmpdir(), 'hold-'));
  writeFileSync(join(wt, 'my file.txt'), 'abc');
  archivePaths({ wtPath: wt, rels: ['my file.txt'], holdingDir: h, slug: 's', pr: 4, nowMs: T });
  mkdirSync(join(h, 'broken')); writeFileSync(join(h, 'broken', 'MANIFEST.json'), '{nope');
  const l = listHolding(h);
  const good = l.find((b) => b.batch === '2026-10-13');
  assert.equal(good.bytes, 3); assert.equal(good.archivedAt, '2026-10-13T00:00:00.000Z');
  assert.match(good.restore[0], /^mv '.*my file\.txt' '.* dir-.*my file\.txt'$/);
  const bad = l.find((b) => b.batch === 'broken');
  assert.equal(bad.items, 0); assert.deepEqual(bad.restore, []);
  assert.deepEqual(listHolding(join(h, 'does-not-exist')), []);
});

test('purge: a batch with a missing or unparseable manifest is kept; one young item keeps the whole batch; nothing outside holdingDir is touched', () => {
  const base = mkdtempSync(join(tmpdir(), 'base-'));
  const h = join(base, 'hold'); mkdirSync(h);
  const outside = join(base, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'precious.txt'), 'p');
  mkdirSync(join(h, 'nomanifest')); writeFileSync(join(h, 'nomanifest', 'f'), 'f');
  mkdirSync(join(h, 'garbled')); writeFileSync(join(h, 'garbled', 'MANIFEST.json'), 'not json');
  mkdirSync(join(h, 'mixed'));
  writeFileSync(join(h, 'mixed', 'MANIFEST.json'), JSON.stringify({ version: 1, items: [
    { original: '/x', stored: join(outside, 'precious.txt'), archivedAt: new Date(T - 90 * day).toISOString() },
    { original: '/y', stored: '/y', archivedAt: new Date(T - 1 * day).toISOString() }] }));
  mkdirSync(join(h, 'old'));
  writeFileSync(join(h, 'old', 'MANIFEST.json'), JSON.stringify({ version: 1, items: [
    { original: '/x', stored: join(outside, 'precious.txt'), archivedAt: new Date(T - 90 * day).toISOString() }] }));
  writeFileSync(join(h, 'stray-file.txt'), 's');
  const r = purgeHolding(h, { nowMs: T });
  assert.deepEqual(r.purged, ['old']);
  assert.equal(r.kept.find((k) => k.batch === 'nomanifest').reason, 'no readable manifest');
  assert.equal(r.kept.find((k) => k.batch === 'garbled').reason, 'no readable manifest');
  assert.ok(r.kept.find((k) => k.batch === 'mixed'));
  assert.equal(readFileSync(join(outside, 'precious.txt'), 'utf8'), 'p');
  assert.equal(existsSync(join(h, 'stray-file.txt')), true);
  assert.deepEqual(purgeHolding(join(base, 'missing'), { nowMs: T }), { purged: [], kept: [] });
});
