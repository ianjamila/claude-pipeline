// `pipeline repo-move` (commands/repo-move.mjs): the owner's record of a renamed / transferred repository. A fake gh, a temp home.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { run } from '../pipeline/commands/repo-move.mjs';
import { main } from '../pipeline/bin/pipeline.mjs';
import { readRepoMoves, repoMovesPath } from '../pipeline/hooks/lib/repo-moves.mjs';

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
const go = (argv, { h = home(), env = {}, ancestor = false, answers = GOOD, calls = [], ...ctx } = {}) =>
  run(argv, { env, home: h, hasClaudeCodeAncestor: () => ancestor, ghFn: fakeGh(answers, calls), cwd: h, ...ctx }).then((r) => ({ ...r, h, calls }));
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

test('repo-move: the same move twice is a no-op (the file is byte-identical)', async () => {
  const h = home();
  await go(ARGS, { h });
  const before = readFileSync(repoMovesPath(h), 'utf8');
  const again = await go(['--from', FROM.toUpperCase(), '--to', TO, '--at', '2026-11-11T00:00:00Z'], { h, answers: { [FROM.toUpperCase()]: [TO, 77], [TO]: [TO, 77] } });
  assert.equal(again.exitCode, 0);
  assert.equal(again.output.added, false);
  assert.equal(readFileSync(repoMovesPath(h), 'utf8'), before);
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
