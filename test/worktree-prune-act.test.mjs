import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, symlinkSync, utimesSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createTmpRepo } from './helpers/tmprepo.mjs';
import { tryAcquire, release } from '../pipeline/lib/locks.mjs';
import { archivePaths, archivePathsLocked, holdingLockName, listHolding, purgeHolding, holdingRoot, removeWorktree, restoreLeftovers, QUARANTINE_DIR } from '../pipeline/lib/worktree-prune/act.mjs';

// Same fixture as test/worktree-prune-inspect.test.mjs: a repo with an origin, an ignore list and a .worktrees dir.
function world() {
  const repo = createTmpRepo();
  repo.write('a.txt', 'a\n'); repo.write('.gitignore', 'node_modules/\n.review/\n*.log\n.env*\nnotes.txt\n'); repo.commit('init');
  const origin = mkdtempSync(join(tmpdir(), 'origin-'));
  repo.git(['init', '--bare', '-q', origin]);
  repo.git(['remote', 'add', 'origin', origin]);
  repo.git(['push', '-q', 'origin', 'main']);
  mkdirSync(join(repo.dir, '.worktrees'));
  const add = (slug, branch) => { repo.git(['worktree', 'add', '-q', '-b', branch, join('.worktrees', slug), 'main']); return join(repo.dir, '.worktrees', slug); };
  return { repo, origin, add };
}
const noProcs = () => ({ platform: 'linux', procRoot: mkdtempSync(join(tmpdir(), 'p-')) });
const quarantineOf = (repo) => join(repo.dir, '.worktrees', QUARANTINE_DIR);

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
  assert.equal(l.length, 1); assert.equal(l[0].items, 2); assert.match(l[0].restore[0], /^mkdir -p '.*' && mv '.*' '.*'$/);
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

test('archive: an unparseable same-day manifest is set aside (first free .corrupt-<n>), never overwritten; purge keeps that batch', () => {
  const wt = mkdtempSync(join(tmpdir(), 'wt-')); const h = mkdtempSync(join(tmpdir(), 'hold-'));
  const batch = join(h, '2026-10-13'); mkdirSync(batch);
  writeFileSync(join(batch, 'MANIFEST.json'), '{nope');
  writeFileSync(join(wt, 'a.txt'), 'a'); writeFileSync(join(wt, 'b.txt'), 'b');
  archivePaths({ wtPath: wt, rels: ['a.txt'], holdingDir: h, slug: 's1', pr: 1, nowMs: T });
  assert.equal(readFileSync(join(batch, 'MANIFEST.json.corrupt-1'), 'utf8'), '{nope');
  assert.deepEqual(JSON.parse(readFileSync(join(batch, 'MANIFEST.json'), 'utf8')).items.map((i) => i.slug), ['s1']);
  writeFileSync(join(batch, 'MANIFEST.json'), '{"items": "not a list"}');
  archivePaths({ wtPath: wt, rels: ['b.txt'], holdingDir: h, slug: 's2', pr: 2, nowMs: T });
  assert.equal(readFileSync(join(batch, 'MANIFEST.json.corrupt-1'), 'utf8'), '{nope');
  assert.equal(readFileSync(join(batch, 'MANIFEST.json.corrupt-2'), 'utf8'), '{"items": "not a list"}');
  assert.deepEqual(JSON.parse(readFileSync(join(batch, 'MANIFEST.json'), 'utf8')).items.map((i) => i.slug), ['s2']);
  const r = purgeHolding(h, { nowMs: T + 90 * day });
  assert.deepEqual(r.purged, []);
  assert.match(r.kept.find((k) => k.batch === '2026-10-13').reason, /MANIFEST\.json\.corrupt-1/);
});

test('list: restore commands quote paths with spaces; an unreadable manifest still lists', () => {
  const wt = mkdtempSync(join(tmpdir(), 'wt dir-')); const h = mkdtempSync(join(tmpdir(), 'hold-'));
  writeFileSync(join(wt, 'my file.txt'), 'abc');
  archivePaths({ wtPath: wt, rels: ['my file.txt'], holdingDir: h, slug: 's', pr: 4, nowMs: T });
  mkdirSync(join(h, 'broken')); writeFileSync(join(h, 'broken', 'MANIFEST.json'), '{nope');
  const l = listHolding(h);
  const good = l.find((b) => b.batch === '2026-10-13');
  assert.equal(good.bytes, 3); assert.equal(good.archivedAt, '2026-10-13T00:00:00.000Z');
  assert.match(good.restore[0], /^mkdir -p '.* dir-[^']*' && mv '.*my file\.txt' '.* dir-.*my file\.txt'$/);
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

test('archive: a symlinked directory on the way to the file is refused and the outside file survives', { skip: process.platform === 'win32' && 'symlinks need privileges on Windows CI' }, () => {
  const wt = mkdtempSync(join(tmpdir(), 'wt-')); const h = mkdtempSync(join(tmpdir(), 'hold-'));
  const outside = mkdtempSync(join(tmpdir(), 'outside-')); writeFileSync(join(outside, 'x'), 'precious');
  symlinkSync(outside, join(wt, '.review'));
  assert.throws(() => archivePaths({ wtPath: wt, rels: ['.review/x'], holdingDir: h, slug: 's', pr: 1, nowMs: T }), /symlink in path/);
  assert.equal(readFileSync(join(outside, 'x'), 'utf8'), 'precious');
  assert.deepEqual(readdirSync(h), [], 'nothing was written to holding');
});

test('archive: a symlinked file, or a symlinked batch/slug dir on the holding side, is refused', { skip: process.platform === 'win32' && 'symlinks need privileges on Windows CI' }, () => {
  const wt = mkdtempSync(join(tmpdir(), 'wt-')); const h = mkdtempSync(join(tmpdir(), 'hold-'));
  const outside = mkdtempSync(join(tmpdir(), 'outside-')); writeFileSync(join(outside, 'secret'), 's');
  symlinkSync(join(outside, 'secret'), join(wt, 'x.log'));
  assert.throws(() => archivePaths({ wtPath: wt, rels: ['x.log'], holdingDir: h, slug: 's', pr: 1, nowMs: T }), /symlink in path/);
  writeFileSync(join(wt, 'y.log'), 'y');
  const elsewhere = mkdtempSync(join(tmpdir(), 'elsewhere-'));
  symlinkSync(elsewhere, join(h, '2026-10-13'));
  assert.throws(() => archivePaths({ wtPath: wt, rels: ['y.log'], holdingDir: h, slug: 's', pr: 1, nowMs: T }), /symlink in path/);
  assert.deepEqual(readdirSync(elsewhere), []);
  const h2 = mkdtempSync(join(tmpdir(), 'hold-'));
  mkdirSync(join(h2, '2026-10-13')); symlinkSync(elsewhere, join(h2, '2026-10-13', 's'));
  assert.throws(() => archivePaths({ wtPath: wt, rels: ['y.log'], holdingDir: h2, slug: 's', pr: 1, nowMs: T }), /symlink in path/);
  assert.deepEqual(readdirSync(elsewhere), []);
  assert.equal(readFileSync(join(wt, 'y.log'), 'utf8'), 'y', 'a refused archive leaves the file where it was');
});

test('removeWorktree: eligible tree is archived, cleaned and removed; branch kept', async () => {
  const { repo, add } = world();
  const wt = add('agent-x', 'agent/x');
  mkdirSync(join(wt, 'node_modules', 'p', 'empty'), { recursive: true }); writeFileSync(join(wt, 'node_modules', 'i.js'), '');
  writeFileSync(join(wt, 'node_modules', 'p', 'j.js'), '');
  mkdirSync(join(wt, '.review')); writeFileSync(join(wt, '.review', 's.json'), '{}');
  const h = mkdtempSync(join(tmpdir(), 'hold-'));
  // runStartMs in the future: the files above were written "before the run" even if the clock has not ticked since
  const r = await removeWorktree({ root: repo.dir, wt: { slug: 'agent-x', path: wt }, cfg: { delete: ['node_modules/'], archive: ['.review/'] }, pr: 9, holdingDir: h, runId: 'r1', runStartMs: Date.now() + 5000, settleMs: 0, procOpts: noProcs() });
  assert.equal(r.removed, true);
  assert.deepEqual(r.deleted.sort(), ['node_modules/i.js', 'node_modules/p/j.js']);
  assert.equal(r.archived.length, 1);
  assert.equal(existsSync(wt), false);
  assert.deepEqual(readdirSync(quarantineOf(repo)), [], 'nothing left in quarantine');
  assert.match(repo.git(['branch', '--list', 'agent/x']), /agent\/x/);
  assert.doesNotMatch(repo.git(['worktree', 'list', '--porcelain']), /agent-x/);
  assert.equal(listHolding(h)[0].items, 1);
});

test('removeWorktree: a real run start (runStartMs = now) lets a clean tree with old files go', async () => {
  const { repo, add } = world();
  const wt = add('agent-x', 'agent/x');
  mkdirSync(join(wt, 'node_modules')); writeFileSync(join(wt, 'node_modules', 'i.js'), '');
  const old = new Date(Date.now() - 86400e3);
  for (const f of ['a.txt', '.gitignore', join('node_modules', 'i.js')]) utimesSync(join(wt, f), old, old);
  const r = await removeWorktree({ root: repo.dir, wt: { slug: 'agent-x', path: wt }, cfg: { delete: ['node_modules/'], archive: [] }, pr: 9, holdingDir: mkdtempSync(join(tmpdir(), 'h-')), runId: 'r1b', runStartMs: Date.now(), settleMs: 0, procOpts: noProcs() });
  assert.equal(r.removed, true, r.reason);
  assert.equal(existsSync(wt), false);
});

for (const [label, file, content] of [['untracked', 'new.ts', 'draft'], ['ignored', '.env.local', 'SECRET=1']]) {
  test(`removeWorktree: an ${label} file written after archive/delete, just before remove => moved back, archive reported`, async () => {
    const { repo, add } = world();
    const wt = add('agent-x', 'agent/x');
    mkdirSync(join(wt, '.review')); writeFileSync(join(wt, '.review', 's.json'), '{}');
    const r = await removeWorktree({ root: repo.dir, wt: { slug: 'agent-x', path: wt }, cfg: { delete: [], archive: ['.review/'] }, pr: 9, holdingDir: mkdtempSync(join(tmpdir(), 'h-')), runId: 'rb', runStartMs: Date.now() + 5000, settleMs: 0,
      procOpts: noProcs(), hooks: { beforeRemove: (q) => writeFileSync(join(q, file), content) } });
    assert.deepEqual([r.removed, r.restored], [false, true]);
    assert.equal(r.reason, `write detected during removal (${file})`);
    assert.equal(readFileSync(join(wt, file), 'utf8'), content);
    assert.equal(r.archived.length, 1, 'the report still says what went to holding');
  });
}

test('removeWorktree: an evidence file written just before remove => moved back with it intact (never deleted unarchived)', async () => {
  const { repo, add } = world();
  const wt = add('agent-x', 'agent/x');
  mkdirSync(join(wt, '.review')); writeFileSync(join(wt, '.review', 's.json'), '{}');
  const r = await removeWorktree({ root: repo.dir, wt: { slug: 'agent-x', path: wt }, cfg: { delete: [], archive: ['.review/'] }, pr: 9, holdingDir: mkdtempSync(join(tmpdir(), 'h-')), runId: 'rl', runStartMs: Date.now() + 5000, settleMs: 0,
    procOpts: noProcs(), hooks: { beforeRemove: (q) => { mkdirSync(join(q, '.review'), { recursive: true }); writeFileSync(join(q, '.review', 'late.json'), '{"late":1}'); } } });
  assert.deepEqual([r.removed, r.restored], [false, true]);
  assert.equal(r.reason, 'write detected during removal (.review/late.json)');
  assert.equal(readFileSync(join(wt, '.review', 'late.json'), 'utf8'), '{"late":1}');
});

test('removeWorktree: the manifest records each file at its original worktree path, not in the quarantine', async () => {
  const { repo, add } = world();
  const wt = add('agent-x', 'agent/x');
  mkdirSync(join(wt, '.review')); writeFileSync(join(wt, '.review', 's.json'), '{"s":1}');
  const h = mkdtempSync(join(tmpdir(), 'hold-'));
  const r = await removeWorktree({ root: repo.dir, wt: { slug: 'agent-x', path: wt }, cfg: { delete: [], archive: ['.review/'] }, pr: 9, holdingDir: h, runId: 'ro', runStartMs: Date.now() + 5000, settleMs: 0, procOpts: noProcs() });
  assert.equal(r.removed, true, r.reason);
  assert.equal(r.archived[0].original, join(wt, '.review', 's.json'));
  assert.doesNotMatch(r.archived[0].original, /\.prune-quarantine/);
  const [batch] = listHolding(h);
  assert.equal(batch.restore[0], `mkdir -p '${join(wt, '.review')}' && mv '${r.archived[0].stored}' '${join(wt, '.review', 's.json')}'`);
});

test('removeWorktree: git refusing the remove => moved back intact (restored), archive reported', async () => {
  const { repo, add } = world();
  const wt = add('agent-x', 'agent/x');
  mkdirSync(join(wt, '.review')); writeFileSync(join(wt, '.review', 's.json'), '{}');
  const r = await removeWorktree({ root: repo.dir, wt: { slug: 'agent-x', path: wt }, cfg: { delete: [], archive: ['.review/'] }, pr: 9, holdingDir: mkdtempSync(join(tmpdir(), 'h-')), runId: 'rg', runStartMs: Date.now() + 5000, settleMs: 0,
    procOpts: noProcs(), hooks: { beforeGitRemove: (q) => writeFileSync(join(q, 'late.ts'), 'late') } }); // after the last look: only git sees it
  assert.deepEqual([r.removed, r.restored], [false, true]);
  assert.match(r.reason, /^git refused removal: /);
  assert.equal(readFileSync(join(wt, 'late.ts'), 'utf8'), 'late');
  assert.equal(r.archived.length, 1);
});

test('removeWorktree: git refusing the remove AND the move back => left in quarantine, reason says where', async () => {
  const { repo, add } = world();
  const wt = add('agent-x', 'agent/x');
  let q;
  const r = await removeWorktree({ root: repo.dir, wt: { slug: 'agent-x', path: wt }, cfg: { delete: [], archive: [] }, pr: 9, holdingDir: mkdtempSync(join(tmpdir(), 'h-')), runId: 'rl', runStartMs: Date.now() + 5000, settleMs: 0,
    procOpts: noProcs(), hooks: { beforeGitRemove: (p) => { q = p; repo.git(['worktree', 'lock', '--reason', 'owner', p]); } } }); // a lock blocks remove and move
  assert.deepEqual([r.removed, r.restored], [false, false]);
  assert.match(r.reason, /^git refused removal: .*; it is at /);
  assert.ok(r.reason.endsWith(`it is at ${q}`));
  assert.equal(existsSync(join(q, 'a.txt')), true);
  assert.deepEqual(r.archived, []);
});

test('removeWorktree: a file written after the move => moved back intact, kept', async () => {
  const { repo, add } = world();
  const wt = add('agent-x', 'agent/x');
  const r = await removeWorktree({ root: repo.dir, wt: { slug: 'agent-x', path: wt }, cfg: { delete: [], archive: [] }, pr: 9, holdingDir: mkdtempSync(join(tmpdir(), 'h-')), runId: 'r2', runStartMs: Date.now(), settleMs: 0,
    procOpts: noProcs(),
    hooks: { afterMove: (q) => writeFileSync(join(q, '.env.local'), 'SECRET=1') } });
  assert.deepEqual([r.removed, r.restored], [false, true]);
  assert.match(r.reason, /write detected during removal \(\.env\.local\)/);
  assert.equal(readFileSync(join(wt, '.env.local'), 'utf8'), 'SECRET=1');
  assert.match(repo.git(['worktree', 'list', '--porcelain']), /agent-x\n/);
});

test('removeWorktree: a recent write that matches no pattern (but is not a blocker kind) still moves it back', async () => {
  const { repo, add } = world();
  const wt = add('agent-x', 'agent/x');
  mkdirSync(join(wt, 'node_modules'));
  const r = await removeWorktree({ root: repo.dir, wt: { slug: 'agent-x', path: wt }, cfg: { delete: ['node_modules/'], archive: ['*.log'] }, pr: 9, holdingDir: mkdtempSync(join(tmpdir(), 'h-')), runId: 'r2b', runStartMs: Date.now() + 5000, settleMs: 0,
    procOpts: noProcs(),
    // same content, so git status may see no change; the mtime (pinned after runStartMs, no clock-granularity race) does
    hooks: { afterMove: (q) => { writeFileSync(join(q, 'a.txt'), 'a\n'); const later = new Date(Date.now() + 60e3); utimesSync(join(q, 'a.txt'), later, later); } } });
  assert.deepEqual([r.removed, r.restored], [false, true]);
  assert.match(r.reason, /write detected during removal \(a\.txt\)/);
  assert.equal(existsSync(wt), true);
});

test('removeWorktree: an absolute-path write after the move fails loudly (ENOENT)', async () => {
  const { repo, add } = world();
  const wt = add('agent-x', 'agent/x');
  let err;
  await removeWorktree({ root: repo.dir, wt: { slug: 'agent-x', path: wt }, cfg: { delete: [], archive: [] }, pr: 9, holdingDir: mkdtempSync(join(tmpdir(), 'h-')), runId: 'r3', runStartMs: Date.now(), settleMs: 0,
    procOpts: noProcs(),
    hooks: { afterMove: () => { try { writeFileSync(join(wt, 'HANDOFF.md'), 'x'); } catch (e) { err = e; } } } });
  assert.equal(err?.code, 'ENOENT');
});

test('removeWorktree: a git refusal to move changes nothing', async () => {
  const { repo, add } = world();
  const wt = add('agent-x', 'agent/x');
  repo.git(['worktree', 'lock', '--reason', 'owner', wt]);
  const r = await removeWorktree({ root: repo.dir, wt: { slug: 'agent-x', path: wt }, cfg: { delete: [], archive: [] }, pr: 9, holdingDir: mkdtempSync(join(tmpdir(), 'h-')), runId: 'r4', runStartMs: Date.now() + 5000, settleMs: 0, procOpts: noProcs() });
  assert.deepEqual([r.removed, r.restored], [false, false]);
  assert.match(r.reason, /^move refused: /);
  assert.equal(existsSync(join(wt, 'a.txt')), true);
});

test('removeWorktree: process inspection unavailable => moved back, kept', async () => {
  const { repo, add } = world();
  const wt = add('agent-x', 'agent/x');
  const r = await removeWorktree({ root: repo.dir, wt: { slug: 'agent-x', path: wt }, cfg: { delete: [], archive: [] }, pr: 9, holdingDir: mkdtempSync(join(tmpdir(), 'h-')), runId: 'r5', runStartMs: Date.now() + 5000, settleMs: 0, procOpts: { platform: 'win32' } });
  assert.deepEqual([r.removed, r.restored, r.reason], [false, true, 'in use during removal']);
  assert.equal(existsSync(join(wt, 'a.txt')), true);
});

test('removeWorktree: a process whose cwd is inside the quarantine => moved back, kept', { skip: process.platform === 'win32' && 'symlinks need privileges on Windows CI' }, async () => {
  const { repo, add } = world();
  const wt = add('agent-x', 'agent/x');
  const proc = mkdtempSync(join(tmpdir(), 'proc-'));
  const r = await removeWorktree({ root: repo.dir, wt: { slug: 'agent-x', path: wt }, cfg: { delete: [], archive: [] }, pr: 9, holdingDir: mkdtempSync(join(tmpdir(), 'h-')), runId: 'r6', runStartMs: Date.now() + 5000, settleMs: 0,
    procOpts: { platform: 'linux', procRoot: proc },
    hooks: { afterMove: (q) => { mkdirSync(join(proc, '4242', 'fd'), { recursive: true }); symlinkSync(q, join(proc, '4242', 'cwd')); } } });
  assert.deepEqual([r.removed, r.restored, r.reason], [false, true, 'in use during removal']);
  assert.equal(existsSync(join(wt, 'a.txt')), true);
});

test('removeWorktree: an archive-matched symlink is a blocker (symlink in path); nothing outside is touched', { skip: process.platform === 'win32' && 'symlinks need privileges on Windows CI' }, async () => {
  const { repo, add } = world();
  const wt = add('agent-x', 'agent/x');
  const outside = mkdtempSync(join(tmpdir(), 'outside-')); writeFileSync(join(outside, 'secret'), 'keep me');
  symlinkSync(join(outside, 'secret'), join(wt, 'x.log'));
  const h = mkdtempSync(join(tmpdir(), 'h-'));
  const r = await removeWorktree({ root: repo.dir, wt: { slug: 'agent-x', path: wt }, cfg: { delete: [], archive: ['*.log'] }, pr: 9, holdingDir: h, runId: 'r7', runStartMs: Date.now() + 5000, settleMs: 0, procOpts: noProcs() });
  assert.deepEqual([r.removed, r.restored], [false, true]);
  assert.match(r.reason, /^symlink in path \(x\.log\)/);
  assert.equal(readFileSync(join(outside, 'secret'), 'utf8'), 'keep me');
  assert.deepEqual(readdirSync(h), []);
});

test('removeWorktree: a runId with a dot is refused before anything moves', async () => {
  const { repo, add } = world();
  const wt = add('agent-x', 'agent/x');
  await assert.rejects(removeWorktree({ root: repo.dir, wt: { slug: 'agent-x', path: wt }, cfg: { delete: [], archive: [] }, pr: 9, holdingDir: mkdtempSync(join(tmpdir(), 'h-')), runId: 'a.b', runStartMs: Date.now(), settleMs: 0, procOpts: noProcs() }), /runId/);
  assert.equal(existsSync(wt), true);
});

test('restoreLeftovers: a quarantine left by a killed run goes back to its original path', () => {
  const { repo, add } = world();
  const wt = add('agent-x', 'agent/x');
  const q = join(quarantineOf(repo), 'agent-x.dead');
  mkdirSync(quarantineOf(repo));
  repo.git(['worktree', 'move', wt, q]);
  const r = restoreLeftovers(repo.dir, '.worktrees');
  assert.deepEqual(r.map((x) => x.restored), [true]);
  assert.deepEqual([r[0].from, r[0].to], [q, wt]);
  assert.equal(existsSync(wt), true);
});

test('restoreLeftovers: dotted slug splits on the last dot; taken target and plain dirs are reported, not touched', () => {
  const { repo, add } = world();
  const dotted = add('ops.v2', 'ops/v2');
  const taken = add('agent-y', 'agent/y');
  mkdirSync(quarantineOf(repo));
  repo.git(['worktree', 'move', dotted, join(quarantineOf(repo), 'ops.v2.run1')]);
  repo.git(['worktree', 'add', '-q', '-b', 'agent/y2', join(quarantineOf(repo), 'agent-y.run2'), 'main']); // its slug's path is occupied
  mkdirSync(join(quarantineOf(repo), 'gone.run3')); writeFileSync(join(quarantineOf(repo), 'gone.run3', 'left.txt'), 'l');
  mkdirSync(join(quarantineOf(repo), 'nodot'));
  const r = Object.fromEntries(restoreLeftovers(repo.dir, '.worktrees').map((x) => [x.from.slice(x.from.lastIndexOf(QUARANTINE_DIR) + QUARANTINE_DIR.length + 1), x]));
  assert.equal(r['ops.v2.run1'].restored, true);
  assert.equal(existsSync(join(dotted, 'a.txt')), true);
  assert.deepEqual([r['agent-y.run2'].restored, r['agent-y.run2'].reason], [false, 'original path is taken']);
  assert.equal(existsSync(join(taken, 'a.txt')), true);
  assert.deepEqual([r['gone.run3'].restored, r['gone.run3'].reason], [false, 'not a worktree any more — inspect by hand']);
  assert.equal(existsSync(join(quarantineOf(repo), 'gone.run3', 'left.txt')), true);
  assert.equal(r.nodot.restored, false);
  assert.deepEqual(restoreLeftovers(mkdtempSync(join(tmpdir(), 'empty-')), '.worktrees'), [], 'no quarantine dir => nothing to do');
});

// --- #63: two clones of one repo share one holding folder under different run locks ---------------------------------
const childScript = join(dirname(fileURLToPath(import.meta.url)), 'helpers', 'prune-archive-child.mjs');
const runChild = (args) => {
  const p = spawn(process.execPath, [childScript, JSON.stringify(args)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  p.stderr.on('data', (d) => { err += d; });
  const done = new Promise((resolve) => p.on('exit', (code) => resolve({ code, err })));
  return { done, exited: () => p.exitCode !== null };
};
const waitFor = async (cond, ms = 10_000) => {
  const until = Date.now() + ms;
  while (!cond() && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
  assert.ok(cond(), 'timed out waiting');
};

test('archive: two clones archiving the same name into one holding folder at once keep both archives and both manifest entries', async () => {
  const h = mkdtempSync(join(tmpdir(), 'hold-')); const lockDir = mkdtempSync(join(tmpdir(), 'locks-')); const sync = mkdtempSync(join(tmpdir(), 'sync-'));
  const mk = (content) => { const wt = mkdtempSync(join(tmpdir(), 'wt-')); mkdirSync(join(wt, '.review')); writeFileSync(join(wt, '.review', 'state.json'), content); return wt; };
  const common = { rels: ['.review/state.json'], holdingDir: h, slug: 'agent-x', nowMs: T, lockDir, lockWaitMs: 20_000 };
  const a = runChild({ ...common, wtPath: mk('from-A'), readyFile: join(sync, 'ready'), goFile: join(sync, 'go') });
  await waitFor(() => existsSync(join(sync, 'ready'))); // A has picked its name and not yet moved the file
  const b = runChild({ ...common, wtPath: mk('from-B') });
  await waitFor(() => b.exited(), 1500).catch(() => {}); // unlocked, B finishes at once; locked, B must wait for A
  writeFileSync(join(sync, 'go'), 'go');
  const [ra, rb] = await Promise.all([a.done, b.done]);
  assert.equal(ra.code, 0, ra.err); assert.equal(rb.code, 0, rb.err);
  const l = listHolding(h);
  assert.equal(l.length, 1); assert.equal(l[0].items, 2, 'both manifest entries survive');
  const m = JSON.parse(readFileSync(join(h, l[0].batch, 'MANIFEST.json'), 'utf8'));
  assert.deepEqual(m.items.map((i) => readFileSync(i.stored, 'utf8')).sort(), ['from-A', 'from-B']);
  assert.equal(new Set(m.items.map((i) => i.stored)).size, 2);
});

test('archive: a destination that appears after the name was picked is never overwritten', () => {
  const wt = mkdtempSync(join(tmpdir(), 'wt-')); const h = mkdtempSync(join(tmpdir(), 'hold-'));
  writeFileSync(join(wt, 'a.txt'), 'new');
  const r = archivePaths({
    wtPath: wt, rels: ['a.txt'], holdingDir: h, slug: 's', pr: 1, nowMs: T,
    hooks: { afterPick: (stored) => writeFileSync(stored, 'someone else got here first') },
  });
  const first = r.items[0].stored.replace(/\.\d+$/, '');
  assert.equal(readFileSync(first, 'utf8'), 'someone else got here first');
  assert.notEqual(r.items[0].stored, first);
  assert.equal(readFileSync(r.items[0].stored, 'utf8'), 'new');
});

test('removeWorktree: the holding folder lock cannot be had in time => nothing archived, moved back intact, kept with a reason', async () => {
  const { repo, add } = world(); const wt = add('agent-x', 'agent/x');
  mkdirSync(join(wt, '.review')); writeFileSync(join(wt, '.review', 'state.json'), '{"keep":1}');
  const h = mkdtempSync(join(tmpdir(), 'h-')); const lockDir = mkdtempSync(join(tmpdir(), 'locks-'));
  const held = tryAcquire(holdingLockName(h), { dir: lockDir });
  assert.ok(held.acquired);
  try {
    const r = await removeWorktree({ root: repo.dir, wt: { slug: 'agent-x', path: wt }, cfg: { delete: [], archive: ['.review/'] }, pr: 9, holdingDir: h, lockDir, lockWaitMs: 150, runId: 'rlock', runStartMs: Date.now() + 5000, settleMs: 0, procOpts: noProcs() });
    assert.equal(r.removed, false);
    assert.equal(r.restored, true);
    assert.match(r.reason, /holding folder.*lock/i);
    assert.equal(readFileSync(join(wt, '.review', 'state.json'), 'utf8'), '{"keep":1}');
    assert.deepEqual(listHolding(h), []);
  } finally {
    release(held.lock);
  }
});

test('removeWorktree: the holding folder lock is released afterwards (a second removal into the same folder works)', async () => {
  const { repo, add } = world(); const h = mkdtempSync(join(tmpdir(), 'h-')); const lockDir = mkdtempSync(join(tmpdir(), 'locks-'));
  for (const [i, slug] of ['agent-x', 'agent-y'].entries()) {
    const wt = add(slug, `agent/${slug}`);
    mkdirSync(join(wt, '.review')); writeFileSync(join(wt, '.review', 'state.json'), `{"n":${i}}`);
    const r = await removeWorktree({ root: repo.dir, wt: { slug, path: wt }, cfg: { delete: [], archive: ['.review/'] }, pr: 9, holdingDir: h, lockDir, lockWaitMs: 2000, runId: `rr${i}`, runStartMs: Date.now() + 5000, settleMs: 0, procOpts: noProcs() });
    assert.equal(r.removed, true, r.reason);
  }
  assert.equal(listHolding(h)[0].items, 2);
});
