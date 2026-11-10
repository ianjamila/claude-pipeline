// hooks/lib/repo-moves.mjs: reading the owner's repo-moves file (fail closed) and the one-way, record-predates-the-move name match.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { appendRepoMove, MAX_HOPS, readRepoMoves, REPO_MOVES_DIR_REL, REPO_MOVES_FILE, repoMovesPath, sameRepo } from '../pipeline/hooks/lib/repo-moves.mjs';
import { OWNER_GO_REL } from '../pipeline/hooks/lib/owner-go.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'repo-moves-'));
const MOVE = { from: 'ianjamila/eaglewatch', to: 'eaglewatch-ph/eaglewatch', at: '2026-11-09T06:58:25Z', repoId: 77 };
function homeWith(content) {
  const home = tmp();
  mkdirSync(join(home, ...REPO_MOVES_DIR_REL.split('/')), { recursive: true });
  if (content !== undefined) writeFileSync(repoMovesPath(home), typeof content === 'string' ? content : JSON.stringify(content));
  return home;
}
const file = (...moves) => ({ v: 1, moves });

test('repo-moves: the file sits in the owner-go folder guard-files protects', () => {
  assert.equal(REPO_MOVES_DIR_REL, OWNER_GO_REL);
  assert.equal(repoMovesPath('/h'), join('/h', ...OWNER_GO_REL.split('/'), REPO_MOVES_FILE));
});

test('readRepoMoves: a missing folder or file is no moves and no error', () => {
  assert.deepEqual(readRepoMoves({ home: tmp() }), { moves: [], error: null });
  assert.deepEqual(readRepoMoves({ home: homeWith() }), { moves: [], error: null });
});

test('readRepoMoves: a valid file is read, names lower-cased', () => {
  const r = readRepoMoves({ home: homeWith(file({ ...MOVE, from: 'IanJamila/EagleWatch' })) });
  assert.equal(r.error, null);
  assert.deepEqual(r.moves, [MOVE]);
});

test('readRepoMoves: invalid JSON, a wrong version, or ANY invalid entry voids every move', () => {
  const bad = (why, content) => {
    const r = readRepoMoves({ home: homeWith(content) });
    assert.deepEqual(r.moves, [], why);
    assert.equal(typeof r.error, 'string', why);
  };
  bad('not json', '{"v":1,');
  bad('not an object', 'null');
  bad('wrong version', { v: 2, moves: [MOVE] });
  bad('moves not an array', { v: 1, moves: {} });
  const good = MOVE;
  for (const [why, patch] of [
    ['from not a name', { from: 'nope' }], ['to has a space', { to: 'a b/c' }], ['from missing', { from: undefined }], ['to a number', { to: 5 }],
    ['same name', { to: 'IANJAMILA/Eaglewatch' }], ['at unparseable', { at: 'yesterday' }], ['at missing', { at: undefined }],
    ['repoId zero', { repoId: 0 }], ['repoId negative', { repoId: -1 }], ['repoId a float', { repoId: 1.5 }], ['repoId a string', { repoId: '77' }],
  ]) bad(`one bad entry (${why}) voids the good one too`, file(good, { ...good, ...patch }));
  bad('an entry that is not an object', file(good, 'a/b'));
  bad('an array entry', file(good, []));
});

test('readRepoMoves: a symlinked file, a linked or file folder and an oversize file read as no moves with an error', () => {
  const home = homeWith();
  const target = join(tmp(), 'elsewhere.json');
  writeFileSync(target, JSON.stringify(file(MOVE)));
  symlinkSync(target, repoMovesPath(home));
  const linked = readRepoMoves({ home });
  assert.deepEqual(linked.moves, []);
  assert.equal(typeof linked.error, 'string');
  // a symlinked folder
  const home2 = tmp();
  mkdirSync(join(home2, '.claude', 'pipeline-state'), { recursive: true });
  const real = tmp();
  writeFileSync(join(real, REPO_MOVES_FILE), JSON.stringify(file(MOVE)));
  symlinkSync(real, join(home2, ...OWNER_GO_REL.split('/')));
  const viaFolder = readRepoMoves({ home: home2 });
  assert.deepEqual(viaFolder.moves, []);
  assert.equal(typeof viaFolder.error, 'string');
  // a directory where the file goes
  const home3 = homeWith();
  mkdirSync(repoMovesPath(home3));
  assert.equal(typeof readRepoMoves({ home: home3 }).error, 'string');
  // oversize
  const big = readRepoMoves({ home: homeWith(`${JSON.stringify(file(MOVE))}${' '.repeat(70 * 1024)}`) });
  assert.deepEqual(big.moves, []);
  assert.match(big.error, /larger than/);
});

// ---- sameRepo -----------------------------------------------------------------------------------------------------------------

const A = 'old/app';
const B = 'mid/app';
const C = 'new/app';
const mv = (from, to, at, repoId = 1) => ({ from, to, at, repoId });
const BEFORE = '2026-11-01T00:00:00Z';
const MOVED = '2026-11-05T00:00:00Z';
const AFTER = '2026-11-09T00:00:00Z';
const same = (recorded, recordedAt, current, moves) => sameRepo({ recorded, recordedAt, current, moves });

test('sameRepo: an exact match (case-insensitive) needs no move and no valid time', () => {
  assert.equal(same('Acme/App', 'garbage', 'acme/app', []), true);
  assert.equal(same('acme/app', undefined, 'ACME/APP', undefined), true);
  assert.equal(same('acme/app', BEFORE, 'acme/other', []), false);
  assert.equal(same(null, BEFORE, 'acme/app', []), false);
  assert.equal(same('acme/app', BEFORE, null, []), false);
});

test('sameRepo: a record that predates the move counts for the new name', () => {
  assert.equal(same(A, BEFORE, C, [mv(A, C, MOVED)]), true);
  assert.equal(same('OLD/App', BEFORE, 'NEW/APP', [mv(A, C, MOVED)]), true);
});

test('sameRepo: a record made at or after the move never counts (a new repo created later at the old name)', () => {
  assert.equal(same(A, MOVED, C, [mv(A, C, MOVED)]), false, 'at the same instant');
  assert.equal(same(A, AFTER, C, [mv(A, C, MOVED)]), false);
});

test('sameRepo: one way only (a record naming the new name never counts for the old)', () => {
  assert.equal(same(C, BEFORE, A, [mv(A, C, MOVED)]), false);
  assert.equal(same(C, AFTER, A, [mv(A, C, MOVED)]), false);
});

test('sameRepo: a chain of moves, each hop after the record; a late hop or a gap breaks it', () => {
  const chain = [mv(A, B, MOVED), mv(B, C, AFTER)];
  assert.equal(same(A, BEFORE, C, chain), true);
  assert.equal(same(B, BEFORE, C, chain), true);
  assert.equal(same(A, '2026-11-07T00:00:00Z', C, chain), false, 'the first hop predates the record');
  assert.equal(same(A, BEFORE, C, [mv(A, B, MOVED)]), false, 'no hop to the current name');
  assert.equal(same(A, BEFORE, C, [mv(B, C, AFTER)]), false, 'no hop from the recorded name');
  assert.equal(same(A, BEFORE, C, [mv(A, 'other/app', '2026-11-06T00:00:00Z'), mv(A, B, MOVED), mv(B, C, AFTER)]), true, 'a later departure from the recorded name does not hide the earliest one');
  assert.equal(same(A, BEFORE, C, [mv(A, 'other/app', MOVED), mv(A, B, MOVED), mv(B, C, AFTER)]), false, 'two departures at the same instant are ambiguous (#223): no alias');
});

test('sameRepo: a cycle ends (time only moves forwards) and a chain longer than the hop limit is refused', () => {
  const cycle = [mv(A, B, MOVED), mv(B, A, AFTER), mv(A, 'x/y', '2026-11-10T00:00:00Z')];
  assert.equal(same(A, BEFORE, C, cycle), false);
  assert.equal(same(A, BEFORE, 'x/y', cycle), true);
  const long = (n) => Array.from({ length: n }, (_, i) => mv(`n${i}/app`, `n${i + 1}/app`, new Date(Date.parse(MOVED) + i * 1000).toISOString()));
  assert.equal(same('n0/app', BEFORE, `n${MAX_HOPS}/app`, long(MAX_HOPS)), true);
  assert.equal(same('n0/app', BEFORE, `n${MAX_HOPS + 1}/app`, long(MAX_HOPS + 1)), false);
});

test('sameRepo: a chain never crosses repository identities (every hop carries the first hop\'s repoId)', () => {
  // Codex's repro: an approval for org/a, then org/b -> org/c (repository 2) and org/a -> org/b (repository 1), the later one second.
  const crossed = [mv('org/b', 'org/c', '2026-11-09T10:00:00Z', 2), mv('org/a', 'org/b', '2026-11-09T11:00:00Z', 1)];
  assert.equal(same('org/a', '2026-11-09T09:00:00Z', 'org/c', crossed), false);
  // the same chain with one id is a valid, forwards-in-time chain
  const one = [mv('org/a', 'org/b', '2026-11-09T10:00:00Z', 7), mv('org/b', 'org/c', '2026-11-09T11:00:00Z', 7)];
  assert.equal(same('org/a', '2026-11-09T09:00:00Z', 'org/c', one), true);
  // forwards in time but two ids
  const ids = [mv('org/a', 'org/b', '2026-11-09T10:00:00Z', 7), mv('org/b', 'org/c', '2026-11-09T11:00:00Z', 8)];
  assert.equal(same('org/a', '2026-11-09T09:00:00Z', 'org/c', ids), false);
  // a single hop is unaffected by its id, but a move without an integer id never aliases
  assert.equal(same('org/a', '2026-11-09T09:00:00Z', 'org/b', [mv('org/a', 'org/b', '2026-11-09T10:00:00Z', 7)]), true);
  assert.equal(same('org/a', '2026-11-09T09:00:00Z', 'org/b', [{ from: 'org/a', to: 'org/b', at: '2026-11-09T10:00:00Z' }]), false);
});

test('sameRepo: the chain is bound to the repository that held the recorded name at the record (a reused name is another repository)', () => {
  // Codex's repro: org/a -> org/b (repository 1) at 10:00; later a NEW repository takes org/a and moves org/a -> org/c (repository 2) at 11:00.
  const reused = [mv('org/a', 'org/b', '2026-11-09T10:00:00Z', 1), mv('org/a', 'org/c', '2026-11-09T11:00:00Z', 2)];
  assert.equal(same('org/a', '2026-11-09T09:00:00Z', 'org/c', reused), false, 'the approval was for repository 1, which is now org/b');
  assert.equal(same('org/a', '2026-11-09T09:00:00Z', 'org/b', reused), true);
  // a record made between the two moves belongs to the second repository
  assert.equal(same('org/a', '2026-11-09T10:30:00Z', 'org/c', reused), true);
  assert.equal(same('org/a', '2026-11-09T10:30:00Z', 'org/b', reused), false);
  // two departures at the earliest instant: which repository held the name is unknown, so nothing aliases
  const tie = [mv('org/a', 'org/b', '2026-11-09T10:00:00Z', 1), mv('org/a', 'org/c', '2026-11-09T10:00:00Z', 2)];
  assert.equal(same('org/a', '2026-11-09T09:00:00Z', 'org/b', tie), false);
  assert.equal(same('org/a', '2026-11-09T09:00:00Z', 'org/c', tie), false);
  // a later hop is the earliest same-id departure: a second repository's hop out of the intermediate name does not extend the chain
  const mid = [mv('org/a', 'org/b', '2026-11-09T10:00:00Z', 1), mv('org/b', 'org/c', '2026-11-09T11:00:00Z', 2), mv('org/b', 'org/d', '2026-11-09T12:00:00Z', 1)];
  assert.equal(same('org/a', '2026-11-09T09:00:00Z', 'org/c', mid), false);
  assert.equal(same('org/a', '2026-11-09T09:00:00Z', 'org/d', mid), true);
});

test('sameRepo: a chain never walks backwards in time (each hop strictly later than the one before)', () => {
  const back = [mv('org/b', 'org/c', '2026-11-09T10:00:00Z'), mv('org/a', 'org/b', '2026-11-09T11:00:00Z')];
  assert.equal(same('org/a', '2026-11-09T09:00:00Z', 'org/c', back), false, 'same id, but the second hop predates the first');
  const tie = [mv('org/a', 'org/b', '2026-11-09T10:00:00Z'), mv('org/b', 'org/c', '2026-11-09T10:00:00Z')];
  assert.equal(same('org/a', '2026-11-09T09:00:00Z', 'org/c', tie), false, 'the same instant is not later');
});

test('sameRepo: a chain may return to an earlier name (a -> b -> a -> c is one repository)', () => {
  // R3-B1: a documented return move. The approval for org/a was recorded before every move; it still counts for org/c.
  const ret = [mv('org/a', 'org/b', '2026-11-09T10:00:00Z'), mv('org/b', 'org/a', '2026-11-09T11:00:00Z'), mv('org/a', 'org/c', '2026-11-09T12:00:00Z')];
  assert.equal(same('org/a', '2026-11-09T09:00:00Z', 'org/c', ret), true);
  assert.equal(same('org/a', '2026-11-09T09:00:00Z', 'org/b', ret), true);
  assert.equal(same('org/b', '2026-11-09T09:00:00Z', 'org/c', ret), true);
  // still one way and still bound to the repository: a record made after the return only sees the later hop
  assert.equal(same('org/a', '2026-11-09T11:30:00Z', 'org/b', ret), false);
  assert.equal(same('org/a', '2026-11-09T11:30:00Z', 'org/c', ret), true);
  // a return move alone does not make an unrelated name an alias
  assert.equal(same('org/a', '2026-11-09T09:00:00Z', 'org/z', ret), false);
});

test('sameRepo: an unparseable or missing recordedAt allows an exact match only', () => {
  for (const bad of ['yesterday', '', undefined, null, 5]) assert.equal(same(A, bad, C, [mv(A, C, MOVED)]), false, String(bad));
});

test('sameRepo: two departures from one name at the same earliest instant are ambiguous even with the same repoId (first hop and later hop)', () => {
  // #223: a mistyped --to then the corrected one at the same --at, both for repository 1.
  const first = [mv('org/a', 'org/b', '2026-11-09T10:00:00Z', 1), mv('org/a', 'org/c', '2026-11-09T10:00:00Z', 1)];
  assert.equal(same('org/a', '2026-11-09T09:00:00Z', 'org/b', first), false, 'first hop tie, the old target');
  assert.equal(same('org/a', '2026-11-09T09:00:00Z', 'org/c', first), false, 'first hop tie, the corrected target');
  const later = [mv('org/a', 'org/b', '2026-11-09T10:00:00Z', 1), mv('org/b', 'org/c', '2026-11-09T11:00:00Z', 1), mv('org/b', 'org/d', '2026-11-09T11:00:00Z', 1)];
  assert.equal(same('org/a', '2026-11-09T09:00:00Z', 'org/c', later), false, 'later hop tie, one branch');
  assert.equal(same('org/a', '2026-11-09T09:00:00Z', 'org/d', later), false, 'later hop tie, the other branch');
  assert.equal(same('org/a', '2026-11-09T09:00:00Z', 'org/b', later), true, 'the hop before the tie still aliases');
});

test('appendRepoMove: a second record leaving the same name at the same instant for a different place is refused; an exact duplicate is a no-op', () => {
  const home = homeWith();
  const one = { from: 'org/a', to: 'org/b', at: '2026-11-09T10:00:00Z', repoId: 1 };
  assert.equal(appendRepoMove(one, { home }).added, true);
  const before = readFileSync(repoMovesPath(home), 'utf8');
  const clash = appendRepoMove({ from: 'ORG/a', to: 'org/c', at: '2026-11-09T10:00:00.000Z', repoId: 1 }, { home });
  assert.equal(clash.ok, false);
  assert.match(clash.reason, /cannot leave one name for two places at once/);
  assert.equal(readFileSync(repoMovesPath(home), 'utf8'), before, 'the file is unchanged');
  const dupe = appendRepoMove({ ...one, at: '2026-11-09T10:00:00.000Z' }, { home });
  assert.deepEqual([dupe.ok, dupe.added], [true, false]);
  assert.equal(readFileSync(repoMovesPath(home), 'utf8'), before);
  assert.equal(appendRepoMove({ from: 'org/a', to: 'org/c', at: '2026-11-09T10:00:01Z', repoId: 1 }, { home }).added, true, 'a different instant is a new fact');
});
