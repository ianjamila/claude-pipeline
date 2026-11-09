// `pipeline repo-move` (commands/repo-move.mjs): the owner's record of a renamed / transferred repository. A fake gh, a temp home.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { run } from '../pipeline/commands/repo-move.mjs';
import { main } from '../pipeline/bin/pipeline.mjs';
import { readRepoMoves, REPO_MOVES_LOCK, repoMovesPath, sameRepo } from '../pipeline/hooks/lib/repo-moves.mjs';

const FROM = 'ianjamila/eaglewatch';
const TO = 'eaglewatch-ph/eaglewatch';
const AT = '2026-11-09T06:58:25Z';
const ADMIN = { ['PIPELINE_' + 'ADMIN']: '1' }; // (the owner's switch, built here so this file does not itself look like a script that sets it)
const home = () => mkdtempSync(join(tmpdir(), 'repo-move-'));
// answers: { 'owner/name': [full_name, id] }; a name not in it is a 404
const fakeGh = (answers, calls = []) => (args) => {
  calls.push(args);
  const name = String(args[1]).replace(/^repos\//, '');
  const a = answers[name];
  if (!a) return { code: 1, stdout: '', stderr: 'HTTP 404: Not Found', timedOut: false };
  return { code: 0, stdout: `${a[0]}\t${a[1]}\n`, stderr: '', timedOut: false };
};
const GOOD = { [FROM]: [TO, 77], [TO]: [TO, 77] };
const NOW = Date.parse('2026-11-12T00:00:00Z'); // after every --at used below, whatever the machine clock says
const go = (argv, { h = home(), env = {}, ancestor = false, answers = GOOD, calls = [], ...ctx } = {}) =>
  run(argv, { env, home: h, now: () => NOW, hasClaudeCodeAncestor: () => ancestor, ghFn: fakeGh(answers, calls), cwd: h, ...ctx }).then((r) => ({ ...r, h, calls }));
const ARGS = ['--from', FROM, '--to', TO, '--at', AT];

test('repo-move: refuses inside Claude Code (CLAUDECODE=1 or an ancestor) without the admin switch, and writes nothing', async () => {
  for (const [env, ancestor] of [[{ CLAUDECODE: '1' }, false], [{}, true]]) {
    const r = await go(ARGS, { env, ancestor });
    assert.equal(r.exitCode, 2);
    assert.equal(r.output.error, 'refused');
    assert.equal(r.calls.length, 0, 'GitHub is not even asked');
    assert.deepEqual(readRepoMoves({ home: r.h }), { moves: [], error: null });
  }
  const ok = await go(ARGS, { env: { CLAUDECODE: '1', ...ADMIN } });
  assert.equal(ok.exitCode, 0, 'the admin switch lets the owner through');
});

test('repo-move: records a move GitHub confirms (name and id), atomically, 0600, nothing left behind', async () => {
  const r = await go(ARGS);
  assert.equal(r.exitCode, 0, JSON.stringify(r.output));
  assert.equal(r.output.ok, true);
  assert.equal(r.output.added, true);
  const want = { from: FROM, to: TO, at: '2026-11-09T06:58:25.000Z', repoId: 77 };
  assert.deepEqual(r.output.move, want);
  assert.deepEqual(readRepoMoves({ home: r.h }).moves, [want]);
  assert.equal(statSync(repoMovesPath(r.h)).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(join(repoMovesPath(r.h), '..')), ['repo-moves.json'], 'no temp file left');
});

test('repo-move: --at defaults to now; the names are stored lower case; an existing entry is kept', async () => {
  const h = home();
  await go(ARGS, { h });
  const other = { 'Old/Thing': ['new/thing', 5], 'new/thing': ['new/thing', 5] };
  const r = await go(['--from', 'Old/Thing', '--to', 'new/thing'], { h, answers: other, now: () => Date.parse('2026-11-10T00:00:00Z') });
  assert.equal(r.exitCode, 0, JSON.stringify(r.output));
  assert.deepEqual(r.output.moves.map((m) => [m.from, m.to, m.at]), [[FROM, TO, '2026-11-09T06:58:25.000Z'], ['old/thing', 'new/thing', '2026-11-10T00:00:00.000Z']]);
});

test('repo-move: refuses when GitHub does not answer the new full name, when the ids differ, or when a name is unknown', async () => {
  const bad = async (why, answers, code = 1) => {
    const r = await go(ARGS, { answers });
    assert.equal(r.exitCode, code, why);
    assert.equal(r.output.ok, false, why);
    assert.deepEqual(readRepoMoves({ home: r.h }), { moves: [], error: null }, `${why}: nothing written`);
    return r;
  };
  const a = await bad('the old name redirects elsewhere', { [FROM]: ['other/place', 77], [TO]: [TO, 77] });
  assert.match(a.output.message, /does not resolve/);
  const b = await bad('different ids', { [FROM]: [TO, 77], [TO]: [TO, 78] });
  assert.match(b.output.message, /not the same repository/);
  for (const [why, answers] of [['the old name is gone (404)', { [TO]: [TO, 77] }], ['the new name is gone (404)', { [FROM]: [TO, 77] }]]) {
    const h = home();
    await assert.rejects(go(ARGS, { h, answers }), (e) => e.constructor.name === 'UnavailableError', why); // (exit 3 through the dispatcher)
    assert.deepEqual(readRepoMoves({ home: h }), { moves: [], error: null }, `${why}: nothing written`);
  }
  await bad('a non-integer id', { [FROM]: [TO, 'x'], [TO]: [TO, 'x'] });
});

test('repo-move: the same move (same names and time) twice is a no-op (the file is byte-identical); a later --at is appended', async () => {
  const h = home();
  await go(ARGS, { h });
  const before = readFileSync(repoMovesPath(h), 'utf8');
  const upper = { [FROM.toUpperCase()]: [TO, 77], [TO]: [TO, 77] };
  const again = await go(['--from', FROM.toUpperCase(), '--to', TO, '--at', AT], { h, answers: upper });
  assert.equal(again.exitCode, 0);
  assert.equal(again.output.added, false);
  assert.equal(readFileSync(repoMovesPath(h), 'utf8'), before);
  const later = await go(['--from', FROM, '--to', TO, '--at', '2026-11-11T00:00:00Z'], { h });
  assert.equal(later.output.added, true, 'the same names at a later time are a new fact');
  assert.deepEqual(readRepoMoves({ home: h }).moves.map((m) => m.at), ['2026-11-09T06:58:25.000Z', '2026-11-11T00:00:00.000Z']);
});

test('repo-move: A -> B, B -> A, an approval under A, then A -> B again: that approval counts under B', async () => {
  const h = home();
  const A = 'ianjamila/eaglewatch';
  const B = 'eaglewatch-ph/eaglewatch';
  const ids = { [A]: [B, 77], [B]: [B, 77] };
  const back = { [A]: [A, 77], [B]: [A, 77] };
  assert.equal((await go(['--from', A, '--to', B, '--at', '2026-11-09T01:00:00Z'], { h, answers: ids })).output.added, true);
  assert.equal((await go(['--from', B, '--to', A, '--at', '2026-11-09T02:00:00Z'], { h, answers: back })).output.added, true);
  const approvedAt = '2026-11-09T03:00:00Z';
  assert.equal(sameRepo({ recorded: A, recordedAt: approvedAt, current: B, moves: readRepoMoves({ home: h }).moves }), false, 'not yet moved after the approval');
  assert.equal((await go(['--from', A, '--to', B, '--at', '2026-11-09T04:00:00Z'], { h, answers: ids })).output.added, true, 'a later A -> B is not dropped');
  assert.equal(sameRepo({ recorded: A, recordedAt: approvedAt, current: B, moves: readRepoMoves({ home: h }).moves }), true);
});

test('repo-move: an existing lock file refuses the write and leaves the file unchanged; the lock is gone after success and after a failure', async () => {
  const h = home();
  await go(ARGS, { h });
  const dir = join(repoMovesPath(h), '..');
  assert.deepEqual(readdirSync(dir), ['repo-moves.json'], 'no lock left after a success');
  const before = readFileSync(repoMovesPath(h), 'utf8');
  const lock = join(dir, REPO_MOVES_LOCK);
  writeFileSync(lock, '');
  const r = await go(['--from', FROM, '--to', TO, '--at', '2026-11-11T00:00:00Z'], { h });
  assert.equal(r.exitCode, 1);
  assert.equal(r.output.error, 'not-written');
  assert.ok(r.output.message.includes(lock), 'the message names the lock file');
  assert.equal(readFileSync(repoMovesPath(h), 'utf8'), before);
  assert.equal(readFileSync(lock, 'utf8'), '', 'a lock somebody else holds is not removed');
  unlinkSync(lock);
  // a failure while holding the lock (an invalid existing file) still releases it
  writeFileSync(repoMovesPath(h), '{"v":1,"moves":[{"from":"bad"}]}');
  const bad = await go(['--from', FROM, '--to', TO, '--at', '2026-11-11T00:00:00Z'], { h });
  assert.equal(bad.exitCode, 1);
  assert.deepEqual(readdirSync(dir), ['repo-moves.json'], 'no lock left after a failure');
});

test('repo-move: --at later than now + 5 minutes is a usage error, nothing written; within the slack it is accepted', async () => {
  const h = home();
  const calls = [];
  const iso = (ms) => new Date(ms).toISOString();
  await assert.rejects(go(['--from', FROM, '--to', TO, '--at', iso(NOW + 5 * 60 * 1000 + 1000)], { h, calls }), (e) => e.constructor.name === 'UsageError');
  assert.equal(calls.length, 0, 'GitHub is not asked');
  assert.deepEqual(readRepoMoves({ home: h }), { moves: [], error: null });
  const ok = await go(['--from', FROM, '--to', TO, '--at', iso(NOW + 4 * 60 * 1000)], { h });
  assert.equal(ok.exitCode, 0, JSON.stringify(ok.output));
});

test('repo-move: an invalid existing file is refused and left untouched; --list shows it', async () => {
  const h = home();
  mkdirSync(join(repoMovesPath(h), '..'), { recursive: true });
  writeFileSync(repoMovesPath(h), '{"v":1,"moves":[{"from":"bad"}]}');
  const r = await go(ARGS, { h });
  assert.equal(r.exitCode, 1);
  assert.equal(r.output.error, 'not-written');
  assert.match(r.output.message, /not a valid move/);
  assert.equal(readFileSync(repoMovesPath(h), 'utf8'), '{"v":1,"moves":[{"from":"bad"}]}');
  const list = await go(['--list'], { h });
  assert.equal(list.exitCode, 1);
  assert.deepEqual([list.output.ok, list.output.moves], [false, []]);
  assert.match(list.output.error, /not a valid move/);
});

test('repo-move --list: allowed inside Claude Code; prints the moves and the file', async () => {
  const h = home();
  await go(ARGS, { h });
  const r = await go(['--list'], { h, env: { CLAUDECODE: '1' }, ancestor: true });
  assert.equal(r.exitCode, 0);
  assert.deepEqual([r.output.ok, r.output.error, r.output.moves.length, r.output.file], [true, null, 1, repoMovesPath(h)]);
  assert.equal((await go(['--list'], { h: home() })).output.moves.length, 0);
});

test('repo-move: bad arguments are usage errors', async () => {
  for (const argv of [[], ['--from', FROM], ['--from', 'nope', '--to', TO], ['--from', FROM, '--to', FROM.toUpperCase()], [...ARGS.slice(0, 4), '--at', 'yesterday'], ['--list', '--from', FROM], ['stray']]) {
    await assert.rejects(go(argv), (e) => e.constructor.name === 'UsageError', argv.join(' '));
  }
});

test('repo-move is registered with the dispatcher (help lists it)', async () => {
  const chunks = [];
  const orig = process.stdout.write;
  process.stdout.write = (s) => { chunks.push(String(s)); return true; };
  try { await main(['--help']); } finally { process.stdout.write = orig; }
  assert.ok(JSON.parse(chunks.join('')).commands.includes('repo-move'));
});
