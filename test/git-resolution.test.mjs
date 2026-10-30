// resolutionReviewBase / ensureReviewBase / mergeTreeDetailed (pipeline/lib/git.mjs) and the line logic in
// pipeline/lib/resolution.mjs, against real temp repos. Kept apart from git.test.mjs, which takes minutes to run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  git, mergeBase, mergeTree, mergeTreeDetailed, effectiveReviewBase, resolutionReviewBase, ensureReviewBase, reviewPatch, revParse, ReviewBaseUnavailable,
} from '../pipeline/lib/git.mjs';
import { splitLines, interleave, parseConflictBlocks, checkSelection, makeBudget, sameMarkerShape, SearchCap, MAX_BLOCKS } from '../pipeline/lib/resolution.mjs';
import { run } from '../pipeline/lib/proc.mjs';
import { createTmpRepo } from './helpers/tmprepo.mjs';

const T = (...lines) => lines.map((l) => `${l}\n`).join('');

// main holds `base`; feat is branched from it and holds `ours` (the last reviewed head, `from`); main then gets `theirs`.
// Each of ours / theirs is { path: content | null (delete) }. The repo is left on feat.
function conflictRepo({ base, ours, theirs }) {
  const repo = createTmpRepo();
  for (const [p, c] of Object.entries(base)) repo.write(p, c);
  repo.commit('base');
  repo.branch('feat');
  for (const [p, c] of Object.entries(ours)) (c === null ? repo.rm(p) : repo.write(p, c));
  const from = repo.commit('reviewed');
  repo.checkout('main');
  for (const [p, c] of Object.entries(theirs)) (c === null ? repo.rm(p) : repo.write(p, c));
  const tip = repo.commit('main moves on');
  repo.checkout('feat');
  return { repo, from, tip, o: { cwd: repo.dir } };
}

// Merges main into the current branch (a conflict is expected and left), then writes `resolved` and commits the merge.
function resolveMerge(repo, resolved = {}, { expectConflict = true } = {}) {
  let conflicted = false;
  try { repo.git(['merge', '--no-ff', '-q', '-m', 'merge main', 'main']); } catch { conflicted = true; }
  assert.equal(conflicted, expectConflict, 'merge conflict state');
  for (const [p, c] of Object.entries(resolved)) (c === null ? repo.rm(p) : repo.write(p, c));
  return repo.commit('merge main, resolved');
}

const decide = ({ repo, from, o }, head, baseRef = 'main') => (
  resolutionReviewBase({ from, forkPoint: mergeBase('main', head, o), head, baseRef }, o)
);
const isOk = (r) => assert.ok(!r.ineligible && r.base, `expected eligible, got ${JSON.stringify(r)}`);
const isNo = (r, code) => assert.ok(typeof r.ineligible === 'string' && r.ineligible.startsWith(code), `expected ${code}, got ${JSON.stringify(r)}`);

// One file, one block: ours and theirs (line text) replace the middle line.
const oneBlock = (ours, theirs, resolved, path = 'f.txt') => {
  const around = (mid) => T('top') + mid + T('bottom');
  const s = conflictRepo({ base: { [path]: T('top', 'x', 'bottom') }, ours: { [path]: around(ours) }, theirs: { [path]: around(theirs) } });
  const head = resolveMerge(s.repo, { [path]: resolved });
  return { s, head, r: decide(s, head) };
};

// ---------- mergeTreeDetailed ----------

test('mergeTreeDetailed: a content conflict lists its three stages and the literal CONFLICT (contents) type', () => {
  const s = conflictRepo({ base: { 'a b.txt': T('x') }, ours: { 'a b.txt': T('o') }, theirs: { 'a b.txt': T('t') } });
  const full = (rev) => revParse(rev, s.o);
  const d = mergeTreeDetailed(s.from, full('main'), s.o);
  assert.equal(d.clean, false);
  assert.equal(d.conflicts.length, 1);
  const [c] = d.conflicts;
  assert.equal(c.path, 'a b.txt');
  assert.deepEqual(Object.keys(c.stages), ['1', '2', '3']);
  assert.ok(c.types.includes('CONFLICT (contents)'), `git's literal changed: ${JSON.stringify(c.types)}`);
  assert.equal(git(['cat-file', 'blob', c.stages[2].oid], s.o), T('o'));
  assert.equal(git(['cat-file', 'blob', c.stages[3].oid], s.o), T('t'));
  assert.match(git(['cat-file', 'blob', `${d.tree}:a b.txt`], s.o), /^<{7} /m);
});

test('mergeTreeDetailed: several files, paths with spaces and newlines, a clean merge, and the old mergeTree keeps working', () => {
  // Windows file names cannot contain a newline; the -z parsing of one is covered on the other platforms.
  const names = ['dir/one.txt', 'sp ace.txt', ...(process.platform === 'win32' ? [] : ['new\nline.txt'])];
  const files = (v) => Object.fromEntries(names.map((n) => [n, T(v)]));
  const s = conflictRepo({ base: files('x'), ours: files('o'), theirs: files('t') });
  const d = mergeTreeDetailed(s.from, 'main', s.o);
  assert.deepEqual(d.conflicts.map((c) => c.path).sort(), [...names].sort());
  assert.ok(d.conflicts.every((c) => c.types.includes('CONFLICT (contents)')));
  assert.equal(mergeTree(s.from, 'main', s.o).clean, false);
  assert.equal(mergeTree(s.from, 'main', s.o).tree, d.tree);

  const clean = conflictRepo({ base: { 'a.txt': T('x') }, ours: { 'b.txt': T('y') }, theirs: { 'c.txt': T('z') } });
  const dc = mergeTreeDetailed(clean.from, 'main', clean.o);
  assert.equal(dc.clean, true);
  assert.deepEqual(dc.conflicts, []);
  assert.equal(dc.tree, mergeTree(clean.from, 'main', clean.o).tree);
});

test('mergeTreeDetailed: modify/delete, rename/delete and binary conflicts carry their own types', () => {
  const md = conflictRepo({ base: { 'f.txt': T('x') }, ours: { 'f.txt': null }, theirs: { 'f.txt': T('t') } });
  const dmd = mergeTreeDetailed(md.from, 'main', md.o);
  assert.ok(dmd.messages.some((m) => m.type === 'CONFLICT (modify/delete)'), JSON.stringify(dmd.messages));

  const body = Array.from({ length: 20 }, (_, i) => `line ${i}`);
  const rd = conflictRepo({ base: { 'old.txt': T(...body) }, ours: { 'old.txt': null, 'new.txt': T(...body) }, theirs: { 'old.txt': null } });
  const drd = mergeTreeDetailed(rd.from, 'main', rd.o);
  assert.ok(drd.messages.some((m) => /^CONFLICT \(rename\//.test(m.type)), JSON.stringify(drd.messages));

  const bin = conflictRepo({ base: { 'b.dat': Buffer.from('a\0x\n') }, ours: { 'b.dat': Buffer.from('a\0o\n') }, theirs: { 'b.dat': Buffer.from('a\0t\n') } });
  const dbin = mergeTreeDetailed(bin.from, 'main', bin.o);
  assert.ok(dbin.messages.some((m) => m.type === 'CONFLICT (binary)' || /Cannot merge binary files/.test(m.text)), JSON.stringify(dbin.messages));
});

test('mergeTree (and so the synthetic base of effectiveReviewBase) runs with the forced merge config', () => {
  const s = conflictRepo({ base: { 'a.txt': T('x') }, ours: { 'b.txt': T('y') }, theirs: { 'c.txt': T('z') } });
  const calls = [];
  const spy = { ...s.o, run: (cmd, args, opts) => { calls.push(args); return run(cmd, args, opts); } };
  const got = effectiveReviewBase({ from: s.from, forkPoint: revParse('main', s.o) }, spy);
  assert.equal(got.kind, 'synthetic');
  const mt = calls.filter((a) => a.includes('merge-tree'));
  assert.equal(mt.length, 1);
  const cfg = mt[0].filter((a, i) => mt[0][i - 1] === '-c');
  assert.ok(cfg.includes('merge.conflictStyle=merge') && cfg.includes('merge.renormalize=false'), JSON.stringify(cfg));
});

// ---------- resolutionReviewBase: eligible ----------

test('resolutionReviewBase: the #1574 shape (ours deleted an import, theirs added one next to it, the resolution keeps theirs\' new line) is eligible', () => {
  const base = T('import a', 'import b', 'code');
  const s = conflictRepo({ base: { 'src/x.js': base }, ours: { 'src/x.js': T('import a', 'code') }, theirs: { 'src/x.js': T('import a', 'import b', 'import c', 'code') } });
  const head = resolveMerge(s.repo, { 'src/x.js': T('import a', 'import c', 'code') });
  const r = decide(s, head);
  isOk(r);
  assert.deepEqual(r.conflicted, ['src/x.js']);
  assert.equal(r.conflictedCount, 1);
  assert.deepEqual(r.blocks, [{ path: 'src/x.js', block: 1, droppedTheirs: 1 }]);
  assert.equal(git(['cat-file', '-t', r.base], s.o).trim(), 'tree');
  // The diff from the base to head is the resolution and nothing else: marker lines out, the dropped import out.
  assert.deepEqual(git(['diff', '--name-only', r.base, head], s.o).trim().split('\n'), ['src/x.js']);
  const patch = reviewPatch(r.base, head, s.o).patch;
  assert.match(patch, /^-<{7} /m);
  assert.match(patch, /^-import b$/m);
  assert.doesNotMatch(patch, /^\+(?!\+\+ )/m); // no added line: nothing was typed
});

const ours2 = T('o1', 'o2');
const theirs2 = T('t1', 't2');
for (const [name, resolved, dropped] of [
  ['keeps all of ours', T('top', 'o1', 'o2', 'bottom'), 2],
  ['keeps all of theirs', T('top', 't1', 't2', 'bottom'), 0],
  ['keeps parts of both, interleaved', T('top', 'o1', 't2', 'bottom'), 1],
  ['keeps parts of both in the other order', T('top', 't1', 'o1', 'bottom'), 1],
  ['resolves to nothing', T('top', 'bottom'), 2],
]) {
  test(`resolutionReviewBase: a block that ${name} is eligible`, () => {
    const { r } = oneBlock(ours2, theirs2, resolved);
    isOk(r);
    assert.deepEqual(r.blocks.map((b) => b.droppedTheirs), [dropped]);
  });
}

test('resolutionReviewBase: ours [a,b], theirs [b,a], resolution [b,a,b] is eligible (a greedy matcher would refuse it)', () => {
  const { r } = oneBlock(T('a', 'b'), T('b', 'a'), T('top', 'b', 'a', 'b', 'bottom'));
  isOk(r);
  assert.deepEqual(r.blocks.map((b) => b.droppedTheirs), [1]); // b from theirs, a and b from ours
});

test('resolutionReviewBase: a line that is "=======" inside a side is settled by reconstruction; keeping it is a marker line', () => {
  const ours = T('title', '=======', 'body');
  const okRes = oneBlock(ours, T('z'), T('top', 'body', 'bottom'));
  isOk(okRes.r);
  const kept = oneBlock(ours, T('z'), T('top', 'title', '=======', 'body', 'bottom'));
  isNo(kept.r, 'marker-line');
});

test('resolutionReviewBase: an outside line equal to a side line does not confuse the placement', () => {
  const s = conflictRepo({
    base: { 'f.txt': T('top', 'x', 'k') },
    ours: { 'f.txt': T('top', 'k', 'k') },
    theirs: { 'f.txt': T('top', 'z', 'k') },
  });
  const head = resolveMerge(s.repo, { 'f.txt': T('top', 'k', 'k') });
  isOk(decide(s, head));
});

test('resolutionReviewBase: CRLF files are eligible when the resolution keeps the CRLF line endings, not when an editor turned them into LF', () => {
  const crlf = (...lines) => lines.map((l) => `${l}\r\n`).join('');
  const mk = (resolved) => {
    const s = conflictRepo({ base: { 'f.txt': crlf('top', 'x', 'bottom') }, ours: { 'f.txt': crlf('top', 'o', 'bottom') }, theirs: { 'f.txt': crlf('top', 't', 'bottom') } });
    return decide(s, resolveMerge(s.repo, { 'f.txt': resolved }));
  };
  isOk(mk(crlf('top', 'o', 'bottom')));
  isNo(mk(T('top', 'o', 'bottom')), 'outside-edit');
});

test('resolutionReviewBase: a side whose file has no final newline (either side) is handled', () => {
  const noEol = (ours, theirs, resolved) => {
    const s = conflictRepo({ base: { 'f.txt': 'x' }, ours: { 'f.txt': ours }, theirs: { 'f.txt': theirs } });
    return decide(s, resolveMerge(s.repo, { 'f.txt': resolved }));
  };
  isOk(noEol('o', 't\n', 'o'));
  isOk(noEol('o', 't\n', 't\n'));
  isOk(noEol('o\n', 't', 't'));
  isOk(noEol('o\n', 't', 'o\n'));
  isNo(noEol('o', 't\n', 'o\n'), 'not-selection'); // a newline the editor added is text nobody reviewed
});

test('resolutionReviewBase: a later CLEAN merge of main after the conflict merge keeps the round eligible', () => {
  const s = conflictRepo({ base: { 'f.txt': T('top', 'x', 'bottom'), 'g.txt': T('g') }, ours: { 'f.txt': T('top', 'o', 'bottom') }, theirs: { 'f.txt': T('top', 't', 'bottom') } });
  resolveMerge(s.repo, { 'f.txt': T('top', 'o', 'bottom') });
  s.repo.checkout('main');
  s.repo.write('g.txt', T('g2'));
  s.repo.commit('main moves again');
  s.repo.checkout('feat');
  s.repo.git(['merge', '--no-ff', '-q', '-m', 'merge main again', 'main']);
  isOk(decide(s, revParse('HEAD', s.o)));
});

// ---------- resolutionReviewBase: 2a history ----------

test('resolutionReviewBase: ineligible when a non-merge commit sits before or after the resolving merge, or the merge is not of the default branch', () => {
  const mk = () => conflictRepo({ base: { 'f.txt': T('top', 'x', 'bottom') }, ours: { 'f.txt': T('top', 'o', 'bottom') }, theirs: { 'f.txt': T('top', 't', 'bottom') } });
  const before = mk();
  before.repo.write('fix.txt', T('a fix for an accepted item'));
  before.repo.commit('fix');
  isNo(decide(before, resolveMerge(before.repo, { 'f.txt': T('top', 'o', 'bottom') })), 'history-nonmerge');

  const after = mk();
  resolveMerge(after.repo, { 'f.txt': T('top', 'o', 'bottom') });
  after.repo.write('fix.txt', T('fix'));
  isNo(decide(after, after.repo.commit('fix after')), 'history-nonmerge');

  const foreign = mk();
  foreign.repo.git(['branch', 'other', mergeBase('main', 'HEAD', foreign.o)]);
  foreign.repo.checkout('other');
  foreign.repo.write('other.txt', T('other'));
  foreign.repo.commit('other work');
  foreign.repo.checkout('feat');
  foreign.repo.git(['merge', '--no-ff', '-q', '-m', 'merge other', 'other']);
  isNo(decide(foreign, resolveMerge(foreign.repo, { 'f.txt': T('top', 'o', 'bottom') })), 'history-foreign-merge');
});

test('resolutionReviewBase: ineligible when the last reviewed head is not on the first-parent chain of head', () => {
  const s = conflictRepo({ base: { 'f.txt': T('top', 'x', 'bottom') }, ours: { 'f.txt': T('top', 'o1', 'bottom') }, theirs: { 'f.txt': T('top', 't', 'bottom') } });
  const earlier = s.from;
  s.repo.write('g.txt', T('second reviewed commit'));
  const from = s.repo.commit('reviewed again');
  s.repo.git(['checkout', '-q', '-b', 'alt', earlier]);
  const head = resolveMerge(s.repo, { 'f.txt': T('top', 'o1', 'bottom') });
  isNo(decide({ ...s, from }, head), 'history-not-first-parent');
});

test('resolutionReviewBase: an octopus merge is ineligible', () => {
  const s = conflictRepo({ base: { 'f.txt': T('x') }, ours: { 'f.txt': T('o') }, theirs: { 'g.txt': T('g') } });
  s.repo.git(['branch', 'other2', mergeBase('main', 'HEAD', s.o)]);
  s.repo.checkout('other2');
  s.repo.write('h.txt', T('h'));
  s.repo.commit('h');
  s.repo.checkout('feat');
  s.repo.git(['merge', '-q', '-m', 'octopus', 'main', 'other2']);
  isNo(decide(s, revParse('HEAD', s.o)), 'history-octopus');
});

// ---------- resolutionReviewBase: 2b conflict kinds ----------

test('resolutionReviewBase: modify/delete, rename/delete, add/add and binary conflicts are ineligible', () => {
  const md = conflictRepo({ base: { 'f.txt': T('x') }, ours: { 'f.txt': null }, theirs: { 'f.txt': T('t') } });
  isNo(decide(md, resolveMerge(md.repo, { 'f.txt': T('t') })), 'conflict-type');

  const body = Array.from({ length: 20 }, (_, i) => `line ${i}`);
  const rd = conflictRepo({ base: { 'old.txt': T(...body) }, ours: { 'old.txt': null, 'new.txt': T(...body) }, theirs: { 'old.txt': null } });
  isNo(decide(rd, resolveMerge(rd.repo, { 'new.txt': T(...body) })), 'conflict-type');

  const aa = conflictRepo({ base: { 'k.txt': T('k') }, ours: { 'n.txt': T('o') }, theirs: { 'n.txt': T('t') } });
  isNo(decide(aa, resolveMerge(aa.repo, { 'n.txt': T('o') })), 'conflict-stages');

  const bin = conflictRepo({ base: { 'b.dat': Buffer.from('a\0x\n') }, ours: { 'b.dat': Buffer.from('a\0o\n') }, theirs: { 'b.dat': Buffer.from('a\0t\n') } });
  isNo(decide(bin, resolveMerge(bin.repo, { 'b.dat': Buffer.from('a\0o\n') })), 'conflict-binary');
});

test('resolutionReviewBase: a symlink conflict, and a resolution that chmods the file, are ineligible', () => {
  const sl = createTmpRepo();
  symlinkSync('x-target', join(sl.dir, 'l'));
  sl.commit('base');
  sl.branch('feat');
  rmSync(join(sl.dir, 'l'));
  symlinkSync('o-target', join(sl.dir, 'l'));
  const from = sl.commit('reviewed');
  sl.checkout('main');
  rmSync(join(sl.dir, 'l'));
  symlinkSync('t-target', join(sl.dir, 'l'));
  sl.commit('main moves');
  sl.checkout('feat');
  try { sl.git(['merge', '--no-ff', '-q', '-m', 'merge main', 'main']); } catch { /* conflict */ }
  rmSync(join(sl.dir, 'l'));
  symlinkSync('o-target', join(sl.dir, 'l'));
  const head = sl.commit('resolved');
  const r = decide({ repo: sl, from, o: { cwd: sl.dir } }, head);
  assert.ok(r.ineligible && /^conflict-/.test(r.ineligible), JSON.stringify(r));

  const s = conflictRepo({ base: { 'f.txt': T('top', 'x', 'bottom') }, ours: { 'f.txt': T('top', 'o', 'bottom') }, theirs: { 'f.txt': T('top', 't', 'bottom') } });
  try { s.repo.git(['merge', '--no-ff', '-q', '-m', 'merge main', 'main']); } catch { /* conflict */ }
  s.repo.write('f.txt', T('top', 'o', 'bottom'));
  s.repo.git(['add', 'f.txt']);
  s.repo.git(['update-index', '--chmod=+x', 'f.txt']);
  s.repo.git(['commit', '-q', '-m', 'resolved and chmod']);
  isNo(decide(s, revParse('HEAD', s.o)), 'conflict-mode');
});

for (const [attr, code] of [['-merge', /^(attributes|conflict-binary)/], ['merge=binary', /^(attributes|conflict-binary)/], ['merge=union', /^(attributes|not-conflicted)/], ['conflict-marker-size=9', /^attributes/]]) {
  test(`resolutionReviewBase: a ${attr} attribute on the conflicted path is ineligible`, () => {
    const s = conflictRepo({ base: { 'f.txt': T('top', 'x', 'bottom') }, ours: { 'f.txt': T('top', 'o', 'bottom') }, theirs: { 'f.txt': T('top', 't', 'bottom') } });
    const head = resolveMerge(s.repo, { 'f.txt': T('top', 'o', 'bottom') });
    mkdirSync(join(s.repo.dir, '.git', 'info'), { recursive: true });
    appendFileSync(join(s.repo.dir, '.git', 'info', 'attributes'), `f.txt ${attr}\n`);
    const r = decide(s, head);
    assert.ok(typeof r.ineligible === 'string' && code.test(r.ineligible), JSON.stringify(r));
  });
}

// ---------- resolutionReviewBase: 2c / 2d ----------

test('resolutionReviewBase: a changed file that is not conflicted, or a conflicted file left with its markers, is ineligible', () => {
  const two = () => conflictRepo({
    base: { 'a.txt': T('top', 'x', 'bottom'), 'b.txt': T('top', 'x', 'bottom') },
    ours: { 'a.txt': T('top', 'o', 'bottom'), 'b.txt': T('top', 'o', 'bottom') },
    theirs: { 'a.txt': T('top', 't', 'bottom'), 'b.txt': T('top', 't', 'bottom') },
  });
  const extra = two();
  isNo(decide(extra, resolveMerge(extra.repo, { 'a.txt': T('top', 'o', 'bottom'), 'b.txt': T('top', 'o', 'bottom'), 'c.txt': T('new file') })), 'extra-files');

  const across = two();
  isNo(decide(across, resolveMerge(across.repo, { 'a.txt': T('top', 'o', 'bottom') })), 'marker-line'); // b.txt keeps the merge's own markers
  const both = two();
  isOk(decide(both, resolveMerge(both.repo, { 'a.txt': T('top', 'o', 'bottom'), 'b.txt': T('top', 't', 'bottom') })));
});

test('resolutionReviewBase: each 2d violation is ineligible (outside edit, partial file, kept marker, new text, base text, dropped / duplicated outside line)', () => {
  const gapLines = ['mid1', 'mid2', 'mid3', 'mid4', 'mid5', 'mid6', 'mid7', 'mid8'];
  const twoBlocks = (resolved) => {
    const gap = ['mid1', 'mid2', 'mid3', 'mid4', 'mid5', 'mid6', 'mid7', 'mid8'];
    const base = T('top', 'x1', ...gap, 'x2', 'bottom');
    const s = conflictRepo({
      base: { 'f.txt': base },
      ours: { 'f.txt': T('top', 'o1', ...gap, 'o2', 'bottom') },
      theirs: { 'f.txt': T('top', 't1', ...gap, 't2', 'bottom') },
    });
    return decide(s, resolveMerge(s.repo, { 'f.txt': resolved }));
  };
  const good = T('top', 'o1', ...gapLines, 't2', 'bottom');
  isOk(twoBlocks(good));
  isNo(twoBlocks(good.replace('mid2', 'MID2')), 'outside-edit');
  isNo(twoBlocks(good.replace('mid2\n', '')), 'outside-edit');
  isNo(twoBlocks(good.replace('mid2\n', 'mid2\nmid2\n')), 'outside-edit');
  isNo(twoBlocks(good.replace('top\n', '')), 'outside-edit');
  isNo(twoBlocks(good.replace('t2', 'typed by the resolver')), 'not-selection');
  isNo(twoBlocks(good.replace('t2', 'x2')), 'not-selection'); // a line of the base section is not selectable
  // One block left with its markers.
  isNo(twoBlocks(T('top', 'o1', ...gapLines, '<<<<<<< a', 'o2', '=======', 't2', '>>>>>>> b', 'bottom')), 'marker-line');
  isNo(twoBlocks(good.replace('t2', '=======')), 'marker-line');
});

test('resolutionReviewBase: a resolution that types a new line next to the sides\' lines is ineligible; one that only deletes is not', () => {
  isNo(oneBlock(T('o1'), T('t1'), T('top', 'o1', 'plus one more', 'bottom')).r, 'not-selection');
  isOk(oneBlock(T('o1', 'o2'), T('t1'), T('top', 'o2', 'bottom')).r);
});

test('resolutionReviewBase: M1 conflict merge then M2 clean merge that carries a fix typed inside the block is ineligible; without the fix it is eligible', () => {
  const mk = (typedFix) => {
    const s = conflictRepo({
      base: { 'f.txt': T('top', 'x', 'bottom'), 'g.txt': T('g') },
      ours: { 'f.txt': T('top', 'o', 'bottom') },
      theirs: { 'f.txt': T('top', 't', 'bottom') },
    });
    resolveMerge(s.repo, { 'f.txt': T('top', 'o', 'bottom') });
    s.repo.checkout('main');
    s.repo.write('g.txt', T('g2'));
    s.repo.commit('main moves again');
    s.repo.checkout('feat');
    s.repo.git(['merge', '--no-ff', '--no-commit', 'main']);
    if (typedFix) s.repo.write('f.txt', T('top', 'o', 'a fix an accepted item asked for', 'bottom'));
    return decide(s, s.repo.commit('merge main again'));
  };
  isNo(mk(true), 'not-selection');
  isOk(mk(false));
});

// A conflicted file that ALSO holds clean hunks git auto-merged from one side each (the #1574 shape): a changes line 4 on both
// sides (the conflict), main alone changes line 15, the PR alone changes line 25.
const cleanHunks = (l4, l15, l25) => T(...Array.from({ length: 30 }, (_, i) => (i === 3 ? l4 : i === 14 ? l15 : i === 24 ? l25 : `line${i + 1}`)));
const withCleanHunks = (resolved4) => {
  const s = conflictRepo({
    base: { 'f.txt': cleanHunks('x', 'line15', 'line25') },
    ours: { 'f.txt': cleanHunks('o4', 'line15', 'pr25') },
    theirs: { 'f.txt': cleanHunks('t4', 'main15', 'line25') },
  });
  const head = resolveMerge(s.repo, { 'f.txt': cleanHunks(resolved4, 'main15', 'pr25') });
  return decide(s, head);
};

test('resolutionReviewBase: clean hunks auto-merged elsewhere in a conflicted file (from main and from the PR) keep a selection eligible', () => {
  const r = withCleanHunks('o4');
  isOk(r);
  assert.deepEqual(r.blocks, [{ path: 'f.txt', block: 1, droppedTheirs: 1 }]);
  isOk(withCleanHunks('t4'));
});

test('resolutionReviewBase: with clean hunks elsewhere, a typed line inside the block is still not-selection', () => {
  isNo(withCleanHunks('typed by hand'), 'not-selection');
});

test('resolutionReviewBase: a "=======" content line inside a side, next to clean hunks elsewhere, still parses (kept = marker-line)', () => {
  const lines = (l4a, l4b, l15, l25) => T('top', 'l2', 'l3', ...l4a, ...l4b, 'l5', 'l6', 'l7', 'l8', 'l9', 'l10', 'l11', 'l12', 'l13', 'l14', l15, 'l16', 'l17', 'l18', 'l19', 'l20', 'l21', 'l22', 'l23', 'l24', l25, 'bottom');
  const s = conflictRepo({
    base: { 'f.txt': lines(['x'], [], 'l15', 'l25') },
    ours: { 'f.txt': lines(['o', '=======', 'o2'], [], 'l15', 'pr25') },
    theirs: { 'f.txt': lines(['t'], [], 'main15', 'l25') },
  });
  const head = resolveMerge(s.repo, { 'f.txt': lines(['o', 'o2'], [], 'main15', 'pr25') });
  isOk(decide(s, head));
  const kept = conflictRepo({
    base: { 'f.txt': lines(['x'], [], 'l15', 'l25') },
    ours: { 'f.txt': lines(['o', '=======', 'o2'], [], 'l15', 'pr25') },
    theirs: { 'f.txt': lines(['t'], [], 'main15', 'l25') },
  });
  isNo(decide(kept, resolveMerge(kept.repo, { 'f.txt': lines(['o', '=======', 'o2'], [], 'main15', 'pr25') })), 'marker-line');
});

test('resolutionReviewBase: a merge-file that disagrees with the marker blob, or does not run, is ineligible merge-file-mismatch', () => {
  const s = conflictRepo({ base: { 'f.txt': T('top', 'x', 'bottom') }, ours: { 'f.txt': T('top', 'o', 'bottom') }, theirs: { 'f.txt': T('top', 't', 'bottom') } });
  const head = resolveMerge(s.repo, { 'f.txt': T('top', 'o', 'bottom') });
  const tamper = (fn) => ({ ...s, o: { ...s.o, run: (cmd, args, opts) => { const r = run(cmd, args, opts); return args.includes('merge-file') ? fn(r, args) : r; } } });
  isOk(decide(tamper((r) => r), head));
  isNo(decide(tamper((r, args) => (args.includes('--ours') || args.includes('--theirs') ? r : { ...r, stdout: r.stdout.replace('top', 'tip') })), head), 'merge-file-mismatch');
  isNo(decide(tamper((r) => ({ ...r, code: 200 })), head), 'merge-file-mismatch');
  isNo(decide(tamper((r) => ({ ...r, stderr: 'fatal: boom' })), head), 'merge-file-mismatch');
});

test('resolutionReviewBase: the step budget turns into ineligible, never a throw', () => {
  const s = conflictRepo({ base: { 'f.txt': T('top', 'x', 'bottom') }, ours: { 'f.txt': T('top', 'o', 'bottom') }, theirs: { 'f.txt': T('top', 't', 'bottom') } });
  const head = resolveMerge(s.repo, { 'f.txt': T('top', 'o', 'bottom') });
  isNo(decide({ ...s, o: { ...s.o, resolutionSearchBudget: 2 } }, head), 'search-cap');
});

// n conflict blocks, five unchanged lines apart (closer ones are merged into one block by git). Line i*5 is changed on both sides.
const manyLines = (name, n) => Array.from({ length: n * 5 }, (_, i) => (i % 5 === 0 ? `${name}${i}` : `keep${i}`));
const manyText = (name, n) => manyLines(name, n).join('\n') + '\n';

test('resolutionReviewBase: the totals are over every block (a drop in block 55 of 60 shows), not over a prefix', () => {
  const s = conflictRepo({ base: { 'f.txt': manyText('base', 60) }, ours: { 'f.txt': manyText('ours', 60) }, theirs: { 'f.txt': manyText('theirs', 60) } });
  const resolved = manyLines('theirs', 60);
  resolved[54 * 5] = 'ours270'; // keeps ours in block 55, so one line of theirs is dropped
  const head = resolveMerge(s.repo, { 'f.txt': resolved.join('\n') + '\n' });
  const r = decide(s, head);
  isOk(r);
  assert.deepEqual([r.blockCount, r.blocksWithDrops, r.droppedTheirsTotal], [60, 1, 1]);
  assert.deepEqual(r.blocks.filter((b) => b.droppedTheirs > 0), [{ path: 'f.txt', block: 55, droppedTheirs: 1 }]);
});

test('resolutionReviewBase: more than MAX_BLOCKS conflict blocks in a file is ineligible too-many-blocks, never a stack overflow', () => {
  const n = MAX_BLOCKS + 200;
  const s = conflictRepo({ base: { 'f.txt': manyText('base', n) }, ours: { 'f.txt': manyText('ours', n) }, theirs: { 'f.txt': manyText('theirs', n) } });
  const head = resolveMerge(s.repo, { 'f.txt': manyText('theirs', n) });
  isNo(decide(s, head), 'too-many-blocks');
});

test('resolutionReviewBase: more than MAX_BLOCKS conflict blocks in all (spread over files) is ineligible too-many-blocks', () => {
  const per = 300;
  const files = (name) => Object.fromEntries([1, 2, 3, 4].map((k) => [`f${k}.txt`, manyText(name, per)]));
  const s = conflictRepo({ base: { ...files('base') }, ours: { ...files('ours') }, theirs: { ...files('theirs') } });
  const head = resolveMerge(s.repo, files('theirs'));
  isNo(decide(s, head), 'too-many-blocks');
});

test('resolutionReviewBase: a RangeError from the block check is ineligible, not a crash', () => {
  // Cannot be provoked from a real repo any more (the block cap), so reach for the last line of defence directly: a head whose
  // blob read throws a RangeError is what an overflow looks like to the caller.
  const s = conflictRepo({ base: { 'f.txt': T('top', 'x', 'bottom') }, ours: { 'f.txt': T('top', 'o', 'bottom') }, theirs: { 'f.txt': T('top', 't', 'bottom') } });
  const head = resolveMerge(s.repo, { 'f.txt': T('top', 'o', 'bottom') });
  const o = { ...s.o, get resolutionSearchBudget() { throw new RangeError('Maximum call stack size exceeded'); } };
  isNo(decide({ ...s, o }, head), 'too-many-blocks');
});

test('resolutionReviewBase: a git error (unknown commit) is ineligible, not a throw', () => {
  const s = conflictRepo({ base: { 'f.txt': T('top', 'x', 'bottom') }, ours: { 'f.txt': T('top', 'o', 'bottom') }, theirs: { 'f.txt': T('top', 't', 'bottom') } });
  const r = resolutionReviewBase({ from: s.from, forkPoint: s.tip, head: 'f'.repeat(40), baseRef: 'main' }, s.o);
  isNo(r, 'git-error');
});

test('resolutionReviewBase: the user\'s merge.conflictStyle does not change the marker tree', () => {
  const s = conflictRepo({ base: { 'f.txt': T('top', 'x', 'bottom') }, ours: { 'f.txt': T('top', 'o', 'bottom') }, theirs: { 'f.txt': T('top', 't', 'bottom') } });
  const head = resolveMerge(s.repo, { 'f.txt': T('top', 'o', 'bottom') });
  const plain = decide(s, head);
  isOk(plain);
  s.repo.git(['config', 'merge.conflictStyle', 'zdiff3']);
  s.repo.git(['config', 'merge.renormalize', 'true']);
  assert.deepEqual(decide(s, head), plain);
});

// ---------- the line logic ----------

test('splitLines keeps terminators, a missing final one, and does not split on U+2028', () => {
  assert.deepEqual(splitLines('a\r\nb\n c'), ['a\r\n', 'b\n', ' c']);
  assert.deepEqual(splitLines(''), []);
  assert.deepEqual(splitLines('a\n'), ['a\n']);
});

test('interleave: subsequence interleavings, order preserved, dropped count is the most lines of theirs that can be dropped', () => {
  const l = (...x) => x.map((s) => `${s}\n`);
  assert.deepEqual(interleave(l('b', 'a', 'b'), l('a', 'b'), l('b', 'a')), { ok: true, droppedTheirs: 1 });
  assert.equal(interleave(l('b', 'a'), l('a', 'b'), l('c')).ok, false);
  assert.equal(interleave(l('x'), l('a'), l('b')).ok, false);
  assert.deepEqual(interleave([], l('a'), l('b', 'c')), { ok: true, droppedTheirs: 2 });
  assert.deepEqual(interleave(l('a'), l('a'), l('a')), { ok: true, droppedTheirs: 1 });
});

test('sameMarkerShape: equal except the label text on the open / close marker lines', () => {
  const l = (...x) => x.map((s) => `${s}\n`);
  const m = l('top', '<<<<<<< 1111', 'o', '=======', 't', '>>>>>>> 2222', 'bottom');
  assert.equal(sameMarkerShape(m, l('top', '<<<<<<< ours', 'o', '=======', 't', '>>>>>>> theirs', 'bottom')), true);
  assert.equal(sameMarkerShape(m, m), true);
  assert.equal(sameMarkerShape(m, l('top', '<<<<<<< ours', 'o', '=======', 'T', '>>>>>>> theirs', 'bottom')), false); // content differs
  assert.equal(sameMarkerShape(m, l('top', '<<<<<<< ours', 'o', '=======', 't', 'bottom')), false); // length differs
  assert.equal(sameMarkerShape(m, l('top', '>>>>>>> ours', 'o', '=======', 't', '<<<<<<< theirs', 'bottom')), false); // other marker kind
  assert.equal(sameMarkerShape(m, l('top', '<<<<<<<', 'o', '=======', 't', '>>>>>>> theirs', 'bottom')), false); // not a marker line with a label
  assert.equal(sameMarkerShape(l('<<<<<<< a'), ['<<<<<<< a\r\n']), false); // line ending differs
  assert.equal(sameMarkerShape(['<<<<<<< a\r\n'], ['<<<<<<< b\r\n']), true);
  assert.equal(sameMarkerShape(['plain\n'], ['plain']), false);
});

test('checkSelection / interleave: the budget is charged per line of work, so a block of ~20k lines is a verdict or a SearchCap within seconds', () => {
  const l = (x) => `${x}\n`;
  const n = 20_000;
  const run1 = (fn) => {
    const t0 = Date.now();
    let out;
    try { out = fn(); } catch (err) { if (!(err instanceof SearchCap)) throw err; out = 'cap'; }
    assert.ok(Date.now() - t0 < 10_000, `took ${Date.now() - t0} ms`);
    return out;
  };
  const same = Array.from({ length: n }, () => l('s'));
  const uniq = (name) => Array.from({ length: n }, (_, i) => l(`${name}${i}`));
  // identical lines everywhere: many placements, long position lists
  assert.equal(run1(() => interleave(same, same, same)), 'cap');
  assert.equal(run1(() => interleave(Array.from({ length: 5 * n }, () => l('s')), Array.from({ length: 6 * n }, () => l('s')), [l('s'), l('s'), l('s')])), 'cap');
  // a long outside that matches for thousands of candidate ends before it fails
  const O = [...Array.from({ length: 5000 }, () => l('mid')), l('x')];
  const mids = same.map(() => l('mid'));
  const parsed = { outsides: [[l('top')], O, [l('bottom')]], blocks: [{ ours: mids, theirs: mids }, { ours: [l('z')], theirs: [l('y')] }] };
  assert.equal(run1(() => checkSelection(parsed, [l('top'), ...mids, ...mids, l('bottom')])), 'cap');
  // a block that is just big and unique is still decided (eligible), well inside the default budget
  const ours = uniq('o');
  const big = { outsides: [[l('top')], [l('bottom')]], blocks: [{ ours, theirs: uniq('t') }] };
  assert.deepEqual(run1(() => checkSelection(big, [l('top'), ...ours, l('bottom')])), { ok: true, droppedTheirs: [n] });
});

test('checkSelection: a candidate end costs steps for the lines it compares and copies, and a marker scan is not repeated per end', () => {
  const l = (x) => `${x}\n`;
  let spent = 0;
  const counting = (k = 1) => { spent += k; };
  const O = [...Array.from({ length: 2000 }, () => l('mid')), l('x')];
  const mids = Array.from({ length: 3000 }, () => l('mid'));
  const parsed = { outsides: [[l('top')], O, [l('bottom')]], blocks: [{ ours: mids, theirs: mids }, { ours: [l('z')], theirs: [l('y')] }] };
  checkSelection(parsed, [l('top'), ...mids, ...mids, l('bottom')], counting);
  assert.ok(spent > 2000 * 1000, `only ${spent} steps charged for millions of line comparisons`);
});

test('parseConflictBlocks: 5000 blocks is "too-many-blocks" at once (no recursion, no throw); the limit itself still parses', () => {
  const l = (...x) => x.map((s) => `${s}\n`);
  const build = (n) => {
    const marker = []; const s2 = []; const s3 = [];
    for (let i = 0; i < n; i++) {
      marker.push(...l('<<<<<<< a', `o${i}`, '=======', `t${i}`, '>>>>>>> b', 'sep'));
      s2.push(...l(`o${i}`, 'sep'));
      s3.push(...l(`t${i}`, 'sep'));
    }
    return [marker, s2, s3];
  };
  assert.deepEqual(parseConflictBlocks(...build(5000)), { reason: 'too-many-blocks' });
  assert.equal(parseConflictBlocks(...build(MAX_BLOCKS)).blocks.length, MAX_BLOCKS);
});

test('parseConflictBlocks: no markers is zero blocks (a conflicted file without a block is ineligible upstream); a stage mismatch is no parse', () => {
  const l = (...x) => x.map((s) => `${s}\n`);
  const same = l('a', 'b');
  assert.deepEqual(parseConflictBlocks(same, same, same).blocks, []);
  assert.deepEqual(parseConflictBlocks(l('a', 'q'), same, same), { reason: 'no-parse' });
  const marker = l('top', '<<<<<<< aaa', 'o', '=======', 't', '>>>>>>> bbb', 'bottom');
  const p = parseConflictBlocks(marker, l('top', 'o', 'bottom'), l('top', 't', 'bottom'));
  assert.deepEqual(p.blocks, [{ ours: l('o'), theirs: l('t') }]);
  assert.deepEqual(p.outsides, [l('top'), l('bottom')]);
  assert.equal(checkSelection(p, l('top', 't', 'bottom')).ok, true);
  assert.equal(checkSelection(p, l('top', 'q', 'bottom')).ok, false);
  assert.throws(() => makeBudget(1)(2), /budget/);
});

// ---------- reviewPatch ----------

test('reviewPatch: a textconv attribute does not blank the patch', () => {
  const repo = createTmpRepo();
  repo.write('f.txt', T('one'));
  const a = repo.commit('one');
  repo.write('f.txt', T('two'));
  const b = repo.commit('two');
  mkdirSync(join(repo.dir, '.git', 'info'), { recursive: true });
  writeFileSync(join(repo.dir, '.git', 'info', 'attributes'), 'f.txt diff=blank\n');
  repo.git(['config', 'diff.blank.textconv', 'echo same #']);
  assert.match(reviewPatch(a, b, { cwd: repo.dir }).patch, /^\+two$/m);
});

// ---------- ensureReviewBase ----------

// A clone has the commits but not the trial-merge trees, which were never reachable from a ref.
function cloneOf(repo) {
  const dir = mkdtempSync(join(tmpdir(), 'cp-clone-'));
  const r = run('git', ['clone', '-q', '--no-local', repo.dir, join(dir, 'c')], { cwd: dir });
  assert.equal(r.code, 0, r.stderr);
  return { dir: join(dir, 'c'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
const roundOf = (s, r, head) => ({
  reviewBase: r.base, reviewBaseKind: 'resolution', fromHead: s.from, forkPoint: mergeBase('main', head, s.o), conflicted: r.conflicted,
});

test('ensureReviewBase: an existing base is returned untouched; a missing resolution base is rebuilt on a fresh clone with the same id', () => {
  const s = conflictRepo({ base: { 'f.txt': T('top', 'x', 'bottom') }, ours: { 'f.txt': T('top', 'o', 'bottom') }, theirs: { 'f.txt': T('top', 't', 'bottom') } });
  const head = resolveMerge(s.repo, { 'f.txt': T('top', 'o', 'bottom') });
  const r = decide(s, head);
  isOk(r);
  const round = roundOf(s, r, head);
  assert.equal(ensureReviewBase(round, s.o), r.base);
  const clone = cloneOf(s.repo);
  try {
    const co = { cwd: clone.dir };
    assert.notEqual(run('git', ['cat-file', '-e', r.base], { cwd: clone.dir }).code, 0, 'the clone must lack the marker tree');
    assert.equal(ensureReviewBase(round, co), r.base);
    assert.equal(run('git', ['cat-file', '-e', r.base], { cwd: clone.dir }).code, 0);
    // A clone whose user config says zdiff3 / renormalize rebuilds the same tree (forced config).
    const clone2 = cloneOf(s.repo);
    try {
      run('git', ['config', 'merge.conflictStyle', 'zdiff3'], { cwd: clone2.dir });
      run('git', ['config', 'merge.renormalize', 'true'], { cwd: clone2.dir });
      assert.equal(ensureReviewBase(round, { cwd: clone2.dir }), r.base);
    } finally { clone2.cleanup(); }
  } finally { clone.cleanup(); }
});

test('ensureReviewBase: a rebuild that gives another tree id is review-base-unavailable (never a silent fallback)', () => {
  const s = conflictRepo({ base: { 'f.txt': T('top', 'x', 'bottom') }, ours: { 'f.txt': T('top', 'o', 'bottom') }, theirs: { 'f.txt': T('top', 't', 'bottom') } });
  const head = resolveMerge(s.repo, { 'f.txt': T('top', 'o', 'bottom') });
  const r = decide(s, head);
  const round = { ...roundOf(s, r, head), reviewBase: 'a'.repeat(40) };
  assert.throws(() => ensureReviewBase(round, s.o), (e) => e instanceof ReviewBaseUnavailable && e.code === 'review-base-unavailable' && /conflictStyle|attributes/.test(e.message));
});

test('ensureReviewBase: an attribute on a conflicted path in this clone makes the rebuild unavailable', () => {
  const s = conflictRepo({ base: { 'f.txt': T('top', 'x', 'bottom') }, ours: { 'f.txt': T('top', 'o', 'bottom') }, theirs: { 'f.txt': T('top', 't', 'bottom') } });
  const head = resolveMerge(s.repo, { 'f.txt': T('top', 'o', 'bottom') });
  const r = decide(s, head);
  const clone = cloneOf(s.repo);
  try {
    mkdirSync(join(clone.dir, '.git', 'info'), { recursive: true });
    writeFileSync(join(clone.dir, '.git', 'info', 'attributes'), 'f.txt merge=union\n');
    assert.throws(() => ensureReviewBase(roundOf(s, r, head), { cwd: clone.dir }), (e) => e.code === 'review-base-unavailable' && /merge=union/.test(e.message));
  } finally { clone.cleanup(); }
});

test('ensureReviewBase: a missing synthetic base is rebuilt (same id); other kinds are returned as they are', () => {
  const s = conflictRepo({ base: { 'a.txt': T('x') }, ours: { 'b.txt': T('y') }, theirs: { 'c.txt': T('z') } });
  const synthetic = mergeTree(s.from, 'main', s.o);
  assert.equal(synthetic.clean, true);
  const round = { reviewBase: synthetic.tree, reviewBaseKind: 'synthetic', fromHead: s.from, forkPoint: revParse('main', s.o) };
  const clone = cloneOf(s.repo);
  try {
    assert.equal(ensureReviewBase(round, { cwd: clone.dir }), synthetic.tree);
    assert.throws(() => ensureReviewBase({ ...round, reviewBase: 'b'.repeat(40) }, { cwd: clone.dir }), (e) => e.code === 'review-base-unavailable');
  } finally { clone.cleanup(); }
  assert.equal(ensureReviewBase({ reviewBase: 'c'.repeat(40), reviewBaseKind: 'whole-pr', fromHead: s.from }, s.o), 'c'.repeat(40));
  assert.equal(ensureReviewBase({ fromHead: s.from }, s.o), s.from);
});
