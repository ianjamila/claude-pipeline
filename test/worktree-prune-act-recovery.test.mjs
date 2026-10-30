// cp issue #59 (PR #52 review R4-B1): an evidence file must never be moved to holding without a record that survives a
// failed manifest write or a crash. The manifest entry is written as a `pending` intent BEFORE the move and marked done
// after it; listing and purging reconcile an entry that never got that far.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { archivePaths, listHolding, purgeHolding, removeWorktree as removeWorktreeReal } from '../pipeline/lib/worktree-prune/act.mjs';
import { createTmpRepo } from './helpers/tmprepo.mjs';

const day = 86400e3;
const T = Date.parse('2026-10-13T00:00:00Z');
const BATCH = '2026-10-13';
// removeWorktree scans the open Claude sessions of THIS machine unless told otherwise; these tests never read the real ones.
const removeWorktree = (opts) => removeWorktreeReal({ liveScan: () => ({ available: false, reason: 'test' }), ...opts });

function fixture() {
  const wt = mkdtempSync(join(tmpdir(), 'wt-'));
  const h = mkdtempSync(join(tmpdir(), 'hold-'));
  mkdirSync(join(wt, '.review'));
  writeFileSync(join(wt, '.review', 'state.json'), '{"a":1}');
  return { wt, h, orig: join(wt, '.review', 'state.json') };
}
const run = (f, extra = {}) => archivePaths({ wtPath: f.wt, rels: ['.review/state.json'], holdingDir: f.h, slug: 's', pr: 7, nowMs: T, ...extra });
const readManifest = (h) => JSON.parse(readFileSync(join(h, BATCH, 'MANIFEST.json'), 'utf8'));
// The restore commands of every listed batch.
const restores = (h) => listHolding(h).flatMap((b) => b.restore);

test('a manifest write that fails (a directory sits where the temp file goes): the evidence file is not left unrecorded', () => {
  const f = fixture();
  mkdirSync(join(f.h, BATCH, `MANIFEST.json.tmp-${process.pid}`), { recursive: true }); // unlink of a directory fails: every write fails
  assert.throws(() => run(f));
  const stillThere = existsSync(f.orig);
  const restorable = restores(f.h).some((c) => c.includes(f.orig));
  assert.ok(stillThere || restorable, 'the file is either back where it was or has a restore command');
  assert.equal(stillThere, true, 'the intent could not be written, so nothing was moved');
});

test('the intent is on disk before the move, and marked done afterwards (no status left on a finished entry)', () => {
  const f = fixture();
  let seen = null;
  const io = {
    move: (from, to) => { seen = readManifest(f.h).items.at(-1); assert.equal(existsSync(from), true); return realMove(from, to); },
  };
  const realMove = (from, to) => { mkdirSync(join(to, '..'), { recursive: true }); writeFileSync(to, readFileSync(from)); rmSync(from); };
  const r = run(f, { io });
  assert.equal(seen.status, 'pending');
  assert.equal(seen.original, f.orig);
  assert.equal(seen.stored, r.items[0].stored);
  const done = readManifest(f.h).items.at(-1);
  assert.equal('status' in done, false);
  assert.equal('source' in done, false);
  assert.equal('status' in r.items[0], false);
});

test('the "mark done" write fails after the move: the file is moved back and the intent never restores a ghost', () => {
  const f = fixture();
  let writes = 0;
  // The seam replaces the real write, so it writes for the calls that must succeed.
  const io = {};
  io.writeManifest = (dir, m) => {
    if (++writes === 2) throw Object.assign(new Error('ENOSPC: no space left'), { code: 'ENOSPC' });
    writeFileSync(join(dir, 'MANIFEST.json'), JSON.stringify(m));
  };
  assert.throws(() => run(f, { io }), /ENOSPC/);
  assert.equal(readFileSync(f.orig, 'utf8'), '{"a":1}', 'moved back to where it came from');
  assert.deepEqual(restores(f.h), [], 'nothing left in holding to restore');
});

test('the "mark done" write fails and the move back fails too: the file stays recorded and restorable, and the error carries it', () => {
  const f = fixture();
  let writes = 0;
  let moves = 0;
  const io = {
    writeManifest: (dir, m) => {
      if (++writes >= 2) throw Object.assign(new Error('ENOSPC: no space left'), { code: 'ENOSPC' });
      writeFileSync(join(dir, 'MANIFEST.json'), JSON.stringify(m));
    },
    move: (from, to) => {
      if (++moves === 2) throw new Error('cannot move back');
      mkdirSync(join(to, '..'), { recursive: true }); writeFileSync(to, readFileSync(from)); rmSync(from);
    },
  };
  let caught;
  try { run(f, { io }); } catch (err) { caught = err; }
  assert.match(caught.message, /ENOSPC/);
  assert.equal(caught.archivedItems.length, 1);
  const stored = caught.archivedItems[0].stored;
  assert.equal(existsSync(stored), true);
  assert.equal(existsSync(f.orig), false);
  assert.ok(restores(f.h).some((c) => c.includes(stored) && c.includes(f.orig)), 'listHolding offers a restore command from the pending intent');
  assert.equal(listHolding(f.h)[0].incomplete, 1);
});

test('a move that fails drops its intent and leaves the file in place', () => {
  const f = fixture();
  const io = { move: () => { throw new Error('EIO'); } };
  assert.throws(() => run(f, { io }), /EIO/);
  assert.equal(existsSync(f.orig), true);
  assert.deepEqual(readManifest(f.h).items, []);
});

// ---- recovery after a crash between the move and the "done" write: a pre-seeded pending entry ------------------------

const SHA = createHash('sha256').update('{"a":1}').digest('hex');
function seeded({ destExists, ageDays = 40, content = '{"a":1}' }) {
  const h = mkdtempSync(join(tmpdir(), 'hold-'));
  const dir = join(h, BATCH);
  mkdirSync(join(dir, 's'), { recursive: true });
  const stored = join(dir, 's', 'state.json');
  if (destExists) writeFileSync(stored, content);
  const item = {
    original: '/gone/wt/.review/state.json', stored, size: 7, sha256: SHA, archivedAt: new Date(T - ageDays * day).toISOString(), slug: 's', pr: 7,
    status: 'pending', source: '/gone/q/.review/state.json',
  };
  writeFileSync(join(dir, 'MANIFEST.json'), JSON.stringify({ version: 1, items: [item] }));
  return { h, dir, stored, item };
}

test('list: a pending entry whose destination exists counts as archived and gets a restore command', () => {
  const { h, stored } = seeded({ destExists: true });
  const [b] = listHolding(h);
  assert.equal(b.items, 1);
  assert.equal(b.incomplete, 1);
  assert.match(b.restore[0], new RegExp(stored.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('list: a pending entry whose destination is missing is an abandoned intent: ignored', () => {
  const { h } = seeded({ destExists: false });
  const [b] = listHolding(h);
  assert.equal(b.items, 0);
  assert.deepEqual(b.restore, []);
  assert.equal('incomplete' in b, false);
});

test('purge: a batch holding an incomplete move is refused (and its file survives), even when it is old', () => {
  const { h, stored } = seeded({ destExists: true });
  const r = purgeHolding(h, { nowMs: T });
  assert.deepEqual(r.purged, []);
  assert.match(r.kept[0].reason, /incomplete move/);
  assert.equal(existsSync(stored), true);
});

test('purge: an abandoned intent (destination missing) does not block an otherwise expired batch', () => {
  const { h } = seeded({ destExists: false });
  // An abandoned intent alone leaves no items: the batch is kept as "lists no items", never deleted on a guess.
  const r = purgeHolding(h, { nowMs: T });
  assert.deepEqual(r.purged, []);
});

test('append: the next archive into the batch reconciles the pending entry into a normal one', () => {
  const { h, stored } = seeded({ destExists: true });
  const wt = mkdtempSync(join(tmpdir(), 'wt-'));
  writeFileSync(join(wt, 'x.txt'), 'x');
  archivePaths({ wtPath: wt, rels: ['x.txt'], holdingDir: h, slug: 's', pr: 7, nowMs: T });
  const items = readManifest(h).items;
  assert.equal(items.length, 2);
  assert.equal(items.some((i) => 'status' in i), false);
  assert.equal(items[0].stored, stored);
  assert.equal(listHolding(h)[0].incomplete, undefined);
});

test('old manifests (no status field) list and purge exactly as before', () => {
  const h = mkdtempSync(join(tmpdir(), 'hold-'));
  mkdirSync(join(h, 'old'));
  writeFileSync(join(h, 'old', 'MANIFEST.json'), JSON.stringify({ version: 1, items: [{ original: '/x/f', stored: join(h, 'old', 'f'), size: 1, sha256: '', archivedAt: new Date(T - 40 * day).toISOString(), slug: 's', pr: 1 }] }));
  const [b] = listHolding(h);
  assert.equal(b.items, 1);
  assert.equal('incomplete' in b, false);
  assert.equal(b.restore.length, 1);
  assert.deepEqual(purgeHolding(h, { nowMs: T }).purged, ['old']);
});

test('removeWorktree: a failed "done" write with no way back keeps the worktree, and reports the file that sits in holding', async () => {
  const repo = createTmpRepo();
  repo.write('a.txt', 'a\n'); repo.write('.gitignore', '.review/\n'); repo.commit('init');
  mkdirSync(join(repo.dir, '.worktrees'));
  repo.git(['worktree', 'add', '-q', '-b', 'agent/x', join('.worktrees', 'agent-x'), 'main']);
  const wt = join(repo.dir, '.worktrees', 'agent-x');
  mkdirSync(join(wt, '.review')); writeFileSync(join(wt, '.review', 's.json'), '{}');
  const h = mkdtempSync(join(tmpdir(), 'hold-'));
  let writes = 0;
  let moves = 0;
  const archiveIo = {
    writeManifest: (dir, m) => { if (++writes >= 2) throw new Error('ENOSPC'); writeFileSync(join(dir, 'MANIFEST.json'), JSON.stringify(m)); },
    move: (from, to) => { if (++moves === 2) throw new Error('cannot move back'); mkdirSync(join(to, '..'), { recursive: true }); writeFileSync(to, readFileSync(from)); rmSync(from); },
  };
  const r = await removeWorktree({
    root: repo.dir, wt: { slug: 'agent-x', path: wt }, cfg: { delete: [], archive: ['.review/'] }, pr: 9, holdingDir: h, runId: 'rr',
    runStartMs: Date.now() + 5000, settleMs: 0, procOpts: { platform: 'linux', procRoot: mkdtempSync(join(tmpdir(), 'p-')) }, hooks: { archiveIo },
  });
  assert.equal(r.removed, false);
  assert.match(r.reason, /cleanup failed during removal: ENOSPC/);
  assert.equal(r.archived.length, 1, 'the file in holding is reported');
  assert.ok(restores(h).some((c) => c.includes(r.archived[0].stored)));
});

// ---- R1-B1: a pending entry counts as archived only when the stored file is the file that was meant to be stored ------

for (const [what, content] of [['truncated (size differs)', '{"a"'], ['same size, different bytes', '{"a":2}']]) {
  test(`pending entry with a ${what} stored file: no restore command, purge refuses, append does not mark it done`, () => {
    const { h, dir, stored } = seeded({ destExists: true, content });
    const [b] = listHolding(h);
    assert.deepEqual(b.restore, [], 'no restore command offered for an unverified copy');
    assert.equal(b.unverified, 1);
    assert.equal(b.items, 0);
    assert.equal('incomplete' in b, false);
    const r = purgeHolding(h, { nowMs: T });
    assert.deepEqual(r.purged, []);
    assert.match(r.kept[0].reason, /unverified.*check by hand/);
    assert.equal(existsSync(stored), true);
    const wt = mkdtempSync(join(tmpdir(), 'wt-'));
    writeFileSync(join(wt, 'x.txt'), 'x');
    archivePaths({ wtPath: wt, rels: ['x.txt'], holdingDir: h, slug: 's', pr: 7, nowMs: T });
    const items = JSON.parse(readFileSync(join(dir, 'MANIFEST.json'), 'utf8')).items;
    assert.equal(items.find((i) => i.stored === stored).status, 'pending', 'still pending after the append');
  });
}

test('pending entry with a verified stored file is still restorable', () => {
  const { h } = seeded({ destExists: true });
  const [b] = listHolding(h);
  assert.equal(b.restore.length, 1);
  assert.equal('unverified' in b, false);
});

// ---- R1-B3: a failed move whose copy cannot be removed keeps its intent and is reported -------------------------------

test('a move that fails and leaves a copy that cannot be removed keeps the pending entry and reports the file', () => {
  const f = fixture();
  const io = {
    move: (from, to) => { mkdirSync(join(to, '..'), { recursive: true }); writeFileSync(to, '{"a"'); throw new Error('EIO mid-copy'); },
    unlink: () => { throw new Error('EBUSY'); },
  };
  let caught;
  try { run(f, { io }); } catch (err) { caught = err; }
  assert.match(caught.message, /EIO/);
  assert.equal(caught.archivedItems.length, 1);
  const stored = caught.archivedItems[0].stored;
  assert.equal(existsSync(stored), true);
  assert.equal(existsSync(f.orig), true, 'the source is intact');
  const entry = readManifest(f.h).items.find((i) => i.stored === stored);
  assert.equal(entry.status, 'pending', 'the intent is kept');
  assert.equal(listHolding(f.h)[0].unverified, 1, 'and the unverified copy is surfaced');
});

test('a move that fails and whose copy is removed drops the intent (nothing reported)', () => {
  const f = fixture();
  const io = { move: (from, to) => { mkdirSync(join(to, '..'), { recursive: true }); writeFileSync(to, '{"a"'); throw new Error('EIO'); } };
  let caught;
  try { run(f, { io }); } catch (err) { caught = err; }
  assert.deepEqual(caught.archivedItems, []);
  assert.deepEqual(readManifest(f.h).items, []);
});

// ---- R5-B1: only a stored path that is CONFIRMED absent (ENOENT) lets the intent go ---------------------------------------

test('a pending entry whose stored file cannot be inspected (parent dir unreadable) is unverified: listed so, kept on append, blocks purge', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, () => {
  const { h, dir, stored, item } = seeded({ destExists: true });
  const locked = join(dir, 's');
  const wt = mkdtempSync(join(tmpdir(), 'wt-'));
  writeFileSync(join(wt, 'x.txt'), 'x');
  let b, purged;
  chmodSync(locked, 0o000); // lstat of `stored` now fails with EACCES, not ENOENT
  try {
    [b] = listHolding(h);
    archivePaths({ wtPath: wt, rels: ['x.txt'], holdingDir: h, slug: 't', pr: 7, nowMs: T }); // a different slug: the locked dir is not written to
    purged = purgeHolding(h, { nowMs: T });
  } finally {
    chmodSync(locked, 0o755);
  }
  assert.equal(b.unverified, 1, 'reported as unverified, not dropped');
  assert.deepEqual(b.restore, [], 'not offered for restore');
  const kept = readManifest(h).items.find((i) => i.stored === stored);
  assert.ok(kept, 'the pending entry survives the append');
  assert.equal(kept.status, 'pending');
  assert.equal(kept.original, item.original);
  assert.deepEqual(purged.purged, []);
  assert.match(purged.kept[0].reason, /unverified/);
  assert.equal(readFileSync(stored, 'utf8'), '{"a":1}');
});
