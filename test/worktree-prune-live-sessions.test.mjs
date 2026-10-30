// `pipeline worktrees prune` and an OPEN Claude Code session (claude-pipeline #115): a session parked in a worktree for days
// holds nothing lsof can see and wrote its transcript long ago, yet the worktree must stay. live-sessions.mjs reads
// <config>/sessions/<pid>.json (alive pid + matching start time) and places each session by its transcript's LAST cwd. Fake
// config dirs under a temp dir throughout; the ps answer is injected, except in the tests that ask the real ps about this
// very process. The prune flow around it (kept reason, re-check before removal) is in test/worktrees-cli.test.mjs.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTmpRepo } from './helpers/tmprepo.mjs';
import { pathSpellings } from '../pipeline/lib/worktree-prune/inspect.mjs';
import { claudeConfigDirs, lastCwd, liveSessionsIn, psStarts, scanLiveSessions } from '../pipeline/lib/worktree-prune/live-sessions.mjs';
import { removeWorktree } from '../pipeline/lib/worktree-prune/act.mjs';
import { inUseReasons, liveSessionReasons } from '../pipeline/lib/worktree-prune/rules.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const WIN = process.platform === 'win32';
const ROOT = process.getuid?.() === 0;
const START = 'Thu Oct 29 08:54:42 2026';

const scratch = [];
after(() => scratch.forEach((d) => rmSync(d, { recursive: true, force: true, maxRetries: 3 })));

// A fake machine: <home>/.claude/{sessions,projects}, and a worktree <base>/repo/.worktrees/wt-a (with app/ inside it).
function world() {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'cp-live-')));
  scratch.push(base);
  const home = join(base, 'home');
  const wt = join(base, 'repo', '.worktrees', 'wt-a');
  mkdirSync(home);
  mkdirSync(join(wt, 'app'), { recursive: true });
  const elsewhere = join(base, 'elsewhere');
  mkdirSync(elsewhere);
  // A session record, and (when `lines` is given) its transcript under projects/<start cwd, non-alphanumerics -> "-">/.
  // `lines`: a cwd string, null (a line with no cwd), or an object written as it is.
  const addSession = ({ config = '.claude', pid, sid, cwd = home, procStart = START, lines, ageHours = 0, raw }) => {
    const cfg = join(home, config);
    mkdirSync(join(cfg, 'sessions'), { recursive: true });
    writeFileSync(join(cfg, 'sessions', `${pid}.json`), raw ?? JSON.stringify({ pid, sessionId: sid, cwd, procStart, version: '0.0.0' }));
    if (!lines) return undefined;
    const dir = join(cfg, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${sid}.jsonl`);
    const rows = lines.map((l) => JSON.stringify(l === null ? { type: 'summary' } : typeof l === 'string' ? { type: 'user', cwd: l } : l));
    writeFileSync(file, `${rows.join('\n')}\n`);
    if (ageHours) {
      const t = (Date.now() - ageHours * 3.6e6) / 1000;
      utimesSync(file, t, t);
    }
    return file;
  };
  const scan = (alive = [], extra = {}) => scanLiveSessions({
    home, env: {}, platform: 'linux', starts: (pids) => new Map(pids.filter((p) => alive.includes(p)).map((p) => [p, START])), ...extra,
  });
  const inWt = (alive, extra) => liveSessionsIn(scan(alive, extra), pathSpellings(wt));
  return { base, home, wt, elsewhere, addSession, scan, inWt };
}

test('a session parked 48 h is placed by its last transcript cwd, not its start folder: the worktree is in use', () => {
  const w = world();
  w.addSession({ pid: 11, sid: 'aaaaaaaa-1111', lines: [w.home, w.wt, join(w.wt, 'app'), null], ageHours: 48 });
  const r = w.inWt([11]);
  assert.deepEqual(r, { hits: [{ id: 'aaaaaaaa', pid: 11 }], unplaced: [] });
  assert.deepEqual(w.scan([11]).sessions.map((s) => s.cwd), [join(w.wt, 'app')]);
  assert.deepEqual(liveSessionReasons(r), ['a Claude session is open there now (aaaaaaaa pid 11)']);
});

test('a session whose last cwd is outside the worktree does not keep it, even if an earlier cwd was inside', () => {
  const w = world();
  w.addSession({ pid: 11, sid: 'aaaaaaaa-1111', lines: [w.wt, w.elsewhere], ageHours: 48 });
  assert.deepEqual(w.inWt([11]), { hits: [], unplaced: [] });
});

test('a sibling folder whose name starts like the worktree is not inside it', () => {
  const w = world();
  w.addSession({ pid: 11, sid: 'aaaaaaaa-1111', lines: [`${w.wt}-old`] });
  assert.deepEqual(w.inWt([11]).hits, []);
});

test('a last cwd that is a symlink alias of the worktree (or a symlink into it) keeps it', { skip: WIN && 'symlinks need privileges on Windows CI' }, () => {
  const w = world();
  // the worktree really lives under <base>/projects, a session started under the alias <base>/Claude logs the alias
  const real = join(w.base, 'projects', 'repo', '.worktrees', 'wt-b');
  mkdirSync(join(real, 'app'), { recursive: true });
  symlinkSync(join(w.base, 'projects'), join(w.base, 'Claude'));
  const spellings = pathSpellings(real);
  w.addSession({ pid: 11, sid: 'aaaaaaaa-1111', lines: [join(w.base, 'Claude', 'repo', '.worktrees', 'wt-b', 'app')] });
  assert.deepEqual(liveSessionsIn(w.scan([11]), spellings).hits.map((h) => h.pid), [11], 'alias through a symlinked ancestor');
  symlinkSync(join(real, 'app'), join(w.base, 'shortcut'));
  w.addSession({ pid: 12, sid: 'bbbbbbbb-2222', lines: [join(w.base, 'shortcut')] });
  assert.deepEqual(liveSessionsIn(w.scan([12]), spellings).hits.map((h) => h.pid), [12], 'a cwd that is itself a link into the worktree');
});

test('dead pids are ignored; a reused pid (start time differs) is ignored; the live one is found', () => {
  const w = world();
  w.addSession({ pid: 11, sid: 'aaaaaaaa-1111', lines: [w.wt] }); // dead
  w.addSession({ pid: 12, sid: 'bbbbbbbb-2222', lines: [w.wt] }); // pid now belongs to another process
  w.addSession({ pid: 13, sid: 'cccccccc-3333', lines: [w.wt] }); // alive, same start
  const starts = () => new Map([[12, 'Mon Oct 26 01:00:00 2026'], [13, START]]);
  const scan = scanLiveSessions({ home: w.home, env: {}, platform: 'linux', starts });
  assert.deepEqual(scan.sessions.map((s) => s.id), ['cccccccc']);
  assert.deepEqual(scan.unplaced, []);
});

test('a lone running pid with another start time is a reused pid, not a reason to keep everything', () => {
  const w = world();
  w.addSession({ pid: 12, sid: 'bbbbbbbb-2222', lines: [w.wt] });
  const scan = scanLiveSessions({ home: w.home, env: {}, platform: 'linux', starts: () => new Map([[12, 'Mon Oct 26 01:00:00 2026']]) });
  assert.deepEqual(scan, { available: true, sessions: [], unplaced: [] });
});

test('fails closed: two or more running pids that ALL disagree with their procStart mean the format changed', () => {
  const w = world();
  w.addSession({ pid: 11, sid: 'aaaaaaaa-1111', lines: [w.elsewhere] });
  w.addSession({ pid: 12, sid: 'bbbbbbbb-2222', lines: [w.elsewhere] });
  const scan = scanLiveSessions({ home: w.home, env: {}, platform: 'linux', starts: () => new Map([[11, 'Mon Oct 26 01:00:00 2026'], [12, 'Mon Oct 26 02:00:00 2026']]) });
  assert.deepEqual(scan.sessions, []);
  assert.match(scan.unplaced[0], /no session's procStart matches ps .*format changed/);
  const r = liveSessionsIn(scan, pathSpellings(w.wt));
  assert.match(liveSessionReasons(r)[0], /^an open Claude session could not be placed: no session's procStart matches ps/);
});

test('fails closed: a running pid whose procStart is not in the shape ps prints (a lone session would look like a reused pid)', () => {
  const w = world();
  w.addSession({ pid: 11, sid: 'aaaaaaaa-1111', lines: [w.elsewhere], procStart: '1790000000' });
  const scan = w.scan([11]);
  assert.deepEqual(scan.sessions, []);
  assert.match(scan.unplaced[0], /open session aaaaaaaa pid 11: procStart is in an unrecognised format/);
});

test('fails closed: ps failing (null) or printing nonsense', () => {
  const w = world();
  w.addSession({ pid: 11, sid: 'aaaaaaaa-1111', lines: [w.elsewhere] });
  assert.match(w.scan([], { starts: () => null }).unplaced[0], /^ps failed/);
  assert.match(w.scan([], { starts: () => { throw new Error('boom'); } }).unplaced[0], /scanning Claude sessions failed: boom/);
});

test('no transcript yet: the record start folder is where the session is', () => {
  const w = world();
  w.addSession({ pid: 11, sid: 'aaaaaaaa-1111', cwd: w.wt }); // no lines -> no transcript
  assert.deepEqual(w.inWt([11]).hits.map((h) => h.pid), [11]);
  w.addSession({ pid: 12, sid: 'bbbbbbbb-2222', cwd: w.elsewhere });
  assert.deepEqual(w.inWt([12]).hits, []);
});

test('a transcript without any cwd line falls back to the start folder; a session with no usable folder at all is unplaced', () => {
  const w = world();
  w.addSession({ pid: 11, sid: 'aaaaaaaa-1111', cwd: w.wt, lines: [null, { type: 'user', cwd: 7 }] });
  assert.deepEqual(w.inWt([11]).hits.map((h) => h.pid), [11]);
  w.addSession({ pid: 12, sid: 'bbbbbbbb-2222', cwd: 'not-absolute' });
  const scan = w.scan([12]);
  assert.match(scan.unplaced[0], /open session bbbbbbbb pid 12: working folder unknown/);
});

test('fails closed: an unreadable transcript is "could not be placed" (kept for every worktree)', { skip: (WIN && 'chmod 000 is not enforced on Windows') || (ROOT && 'root reads any file') }, () => {
  const w = world();
  const file = w.addSession({ pid: 11, sid: 'aaaaaaaa-1111', lines: [w.elsewhere] });
  chmodSync(file, 0);
  try {
    const r = w.inWt([11]);
    assert.deepEqual(r.hits, []);
    assert.match(r.unplaced[0], /open session aaaaaaaa pid 11: transcript unreadable \(EACCES\)/);
    assert.match(liveSessionReasons(r)[0], /^an open Claude session could not be placed: open session aaaaaaaa pid 11: transcript unreadable/);
  } finally {
    chmodSync(file, 0o644);
  }
});

test('fails closed: an unparseable <pid>.json (or one without a usable pid/sessionId) is unplaced; one that vanished meanwhile is not', { skip: WIN && 'symlinks need privileges on Windows CI' }, () => {
  const w = world();
  w.addSession({ pid: 11, sid: 'aaaaaaaa-1111', lines: [w.elsewhere] });
  w.addSession({ pid: 21, raw: '{ this is not json' });
  w.addSession({ pid: 22, raw: JSON.stringify({ pid: 22, sessionId: '../../etc/passwd' }) });
  w.addSession({ pid: 23, raw: JSON.stringify({ sessionId: 'dddddddd-4444' }) });
  // listed by readdir, gone when read: a dangling link is the ENOENT race
  symlinkSync(join(w.base, 'nowhere.json'), join(w.home, '.claude', 'sessions', '77.json'));
  const scan = w.scan([11]);
  assert.equal(scan.unplaced.length, 3, JSON.stringify(scan.unplaced));
  assert.match(scan.unplaced.join('\n'), /21\.json is unreadable \(not JSON\)/);
  assert.match(scan.unplaced.join('\n'), /22\.json has no usable pid \/ sessionId/);
  assert.match(scan.unplaced.join('\n'), /23\.json has no usable pid \/ sessionId/);
  assert.equal(scan.unplaced.some((u) => u.includes('77.json')), false, 'the vanished record is ignored');
  assert.deepEqual(scan.sessions.map((s) => s.pid), [11], 'the healthy session is still found');
});

test('only the vanished-record race: nothing unplaced, the other sessions are read', { skip: WIN && 'symlinks need privileges on Windows CI' }, () => {
  const w = world();
  w.addSession({ pid: 11, sid: 'aaaaaaaa-1111', lines: [w.wt] });
  symlinkSync(join(w.base, 'nowhere.json'), join(w.home, '.claude', 'sessions', '77.json'));
  assert.deepEqual(w.scan([11]).unplaced, []);
  assert.equal(w.inWt([11]).hits.length, 1);
});

test('two accounts listing the same session count it once (CLAUDE_CONFIG_DIR naming one of them changes nothing)', () => {
  const w = world();
  w.addSession({ pid: 11, sid: 'aaaaaaaa-1111', lines: [w.wt] });
  // the second account lists the same session; it shares projects/ with the first (here: its own copy of the transcript)
  mkdirSync(join(w.home, '.claude-two', 'sessions'), { recursive: true });
  copyFileSync(join(w.home, '.claude', 'sessions', '11.json'), join(w.home, '.claude-two', 'sessions', '11.json'));
  const scan = w.scan([11], { env: { CLAUDE_CONFIG_DIR: join(w.home, '.claude') } });
  assert.equal(scan.sessions.length, 1);
  assert.deepEqual(claudeConfigDirs(w.home, { CLAUDE_CONFIG_DIR: join(w.home, '.claude') }).map((d) => basename(d)), ['.claude', '.claude-two'], 'de-duplicated by realpath');
});

test('the second account is read too: a session only it lists is found', () => {
  const w = world();
  w.addSession({ config: '.claude-two', pid: 31, sid: 'ffffffff-6666', lines: [w.wt] });
  w.addSession({ pid: 11, sid: 'aaaaaaaa-1111', lines: [w.elsewhere] });
  assert.deepEqual(w.inWt([11, 31]).hits, [{ id: 'ffffffff', pid: 31 }]);
});

test('no sessions folder anywhere: the signal is unavailable and says nothing about any worktree', () => {
  const w = world();
  mkdirSync(join(w.home, '.claude', 'projects'), { recursive: true });
  let asked = false;
  const scan = scanLiveSessions({ home: w.home, env: {}, platform: 'linux', starts: () => { asked = true; return new Map(); } });
  assert.deepEqual(scan, { available: false, reason: 'no Claude sessions folder found' });
  assert.equal(asked, false, 'ps is not asked when there is nothing to check');
  assert.deepEqual(liveSessionsIn(scan, pathSpellings(w.wt)), { hits: [], unplaced: [] });
  assert.deepEqual(liveSessionReasons(liveSessionsIn(scan, pathSpellings(w.wt))), []);
});

test('an existing but empty sessions folder is available with no sessions', () => {
  const w = world();
  mkdirSync(join(w.home, '.claude', 'sessions'), { recursive: true });
  assert.deepEqual(w.scan(), { available: true, sessions: [], unplaced: [] });
});

test('Windows (and any platform without ps): unavailable even when a sessions folder exists, and ps is not run', () => {
  const w = world();
  w.addSession({ pid: 11, sid: 'aaaaaaaa-1111', lines: [w.wt] });
  let asked = false;
  for (const platform of ['win32', 'freebsd']) {
    const scan = scanLiveSessions({ home: w.home, env: {}, platform, starts: () => { asked = true; return new Map([[11, START]]); } });
    assert.deepEqual(scan, { available: false, reason: `not supported on ${platform}` });
  }
  assert.equal(asked, false);
});

test('a captured real record shape (every id, pid, path and version replaced): the pinned fields are read as the format delivers them', () => {
  const fixture = JSON.parse(readFileSync(join(here, 'fixtures', 'live-sessions', 'session-record.json'), 'utf8'));
  // the format contract: these four fields, in these types, are all this module reads
  assert.equal(Number.isSafeInteger(fixture.pid), true);
  assert.equal(typeof fixture.sessionId, 'string');
  assert.equal(typeof fixture.cwd, 'string');
  assert.match(fixture.procStart, /^[A-Za-z]{3} [A-Za-z]{3} \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/);
  const w = world();
  const cfg = join(w.home, '.claude');
  mkdirSync(join(cfg, 'sessions'), { recursive: true });
  writeFileSync(join(cfg, 'sessions', `${fixture.pid}.json`), `${JSON.stringify({ ...fixture, cwd: w.home })}\n`);
  mkdirSync(join(cfg, 'projects', w.home.replace(/[^a-zA-Z0-9]/g, '-')), { recursive: true });
  writeFileSync(join(cfg, 'projects', w.home.replace(/[^a-zA-Z0-9]/g, '-'), `${fixture.sessionId}.jsonl`), `${JSON.stringify({ type: 'user', cwd: join(w.wt, 'app') })}\n`);
  const scan = scanLiveSessions({ home: w.home, env: {}, platform: 'linux', starts: () => new Map([[fixture.pid, fixture.procStart]]) });
  assert.deepEqual(scan, { available: true, sessions: [{ id: '00000000', pid: 4242, cwd: join(w.wt, 'app') }], unplaced: [] });
});

// ---- the transcript reader ----

const cwdLine = (cwd) => `${JSON.stringify({ type: 'user', cwd })}\n`;
const fileIn = (w, name, text) => {
  const f = join(w.base, name);
  writeFileSync(f, text);
  return f;
};

test('lastCwd: the LAST line that has a cwd wins; a line without one, with a non-string one, or half-written is skipped', () => {
  const w = world();
  const f = fileIn(w, 't.jsonl', `${cwdLine('/a')}${cwdLine('/b')}${JSON.stringify({ type: 'summary' })}\n${JSON.stringify({ cwd: 5 })}\n{"cwd": "/half-writt`);
  assert.equal(lastCwd(f), '/b');
  assert.equal(lastCwd(fileIn(w, 'none.jsonl', `${JSON.stringify({ type: 'summary' })}\n`)), null);
  assert.equal(lastCwd(fileIn(w, 'empty.jsonl', '')), null);
});

test('lastCwd: a last cwd more than 1 MB before the end is found (growing window), whether the tail is many lines or one huge line', () => {
  const w = world();
  const filler = `${JSON.stringify({ type: 'assistant', text: 'x'.repeat(20 << 10) })}\n`;
  const many = fileIn(w, 'many.jsonl', `${cwdLine('/first')}${cwdLine('/the/last')}${filler.repeat(200)}`); // ~4 MB after the last cwd
  assert.equal(lastCwd(many), '/the/last');
  const one = fileIn(w, 'one.jsonl', `${cwdLine('/first')}${cwdLine('/the/last')}`);
  appendFileSync(one, `${JSON.stringify({ type: 'summary', text: 'y'.repeat(3 << 20) })}\n`);
  assert.equal(lastCwd(one), '/the/last');
  const cafe = fileIn(w, 'cafe.jsonl', `${cwdLine('/first')}${cwdLine('/Users/café/wt')}${filler.repeat(120)}`); // multi-byte path, window cut mid-file
  assert.equal(lastCwd(cafe), '/Users/café/wt');
});

test('lastCwd: an unreadable file throws (the caller reports "transcript unreadable")', { skip: (WIN && 'chmod 000 is not enforced on Windows') || (ROOT && 'root reads any file') }, () => {
  const w = world();
  const f = fileIn(w, 'locked.jsonl', cwdLine('/a'));
  chmodSync(f, 0);
  try {
    assert.throws(() => lastCwd(f), (e) => e.code === 'EACCES');
  } finally {
    chmodSync(f, 0o644);
  }
});

// ---- ps ----

test('psStarts: exit 1 with nothing printed = none running; procps exit 1 WITH rows = those that run; garbage and failures = null', () => {
  const rows = ' 4242 Thu Oct 29 08:54:42 2026   \n   17 Mon Oct  5 01:02:03 2026\n';
  const ok = (status, stdout) => psStarts([4242, 17, 9], () => ({ status, stdout }));
  assert.deepEqual([...ok(0, rows)], [[4242, 'Thu Oct 29 08:54:42 2026'], [17, 'Mon Oct 5 01:02:03 2026']]);
  assert.deepEqual([...ok(1, rows)].length, 2);
  assert.deepEqual([...ok(1, '')], []);
  assert.equal(ok(0, ''), null);
  assert.equal(ok(2, rows), null);
  assert.equal(ok(0, 'ps: some error\n'), null);
  assert.equal(psStarts([1], () => ({ status: null, signal: 'SIGKILL', stdout: '' })), null);
  assert.equal(psStarts([1], () => ({ status: null, error: new Error('spawn ps ENOENT'), stdout: '' })), null);
  assert.deepEqual([...psStarts([], () => { throw new Error('not asked'); })], []);
  let args;
  psStarts([4, 5], (a) => { args = a; return { status: 1, stdout: '' }; });
  assert.deepEqual(args, ['-o', 'pid=,lstart=', '-p', '4,5']);
});

// The real ps, asked about this very test process. procStart is UTC; the machine's own zone is set to something else for the
// duration, so a scan that forgot to give ps TZ=UTC would see a local time and call this live session a reused pid.
test('the real ps: this process is alive, its UTC start time matches procStart, and it is placed by its transcript', { skip: WIN && 'no ps on Windows' }, () => {
  const lstart = spawnSync('ps', ['-o', 'lstart=', '-p', String(process.pid)], { encoding: 'utf8', env: { PATH: '/bin:/usr/bin', LC_ALL: 'C', TZ: 'UTC' } });
  assert.equal(lstart.status, 0, lstart.stderr);
  const procStart = lstart.stdout.trim();
  assert.match(procStart, /^[A-Za-z]{3} [A-Za-z]{3} +\d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/);
  const w = world();
  w.addSession({ pid: process.pid, sid: 'eeeeeeee-5555', procStart, lines: [w.home, w.wt], ageHours: 48 });
  const gone = spawnSync(process.execPath, ['-e', '0']).pid; // exited and reaped: not running
  w.addSession({ pid: gone, sid: 'dddddddd-4444', procStart, lines: [w.wt] });
  const zone = process.env.TZ;
  process.env.TZ = 'Asia/Manila';
  try {
    const scan = scanLiveSessions({ home: w.home, env: {}, platform: process.platform });
    assert.deepEqual(scan.unplaced, []);
    assert.deepEqual(scan.sessions, [{ id: 'eeeeeeee', pid: process.pid, cwd: w.wt }]);
    assert.deepEqual(liveSessionsIn(scan, pathSpellings(w.wt)).hits, [{ id: 'eeeeeeee', pid: process.pid }]);
  } finally {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  }
  // and a start time that differs by a second is a reused pid
  const other = world();
  other.addSession({ pid: process.pid, sid: 'eeeeeeee-5555', procStart: procStart.replace(/:(\d\d) (\d{4})$/, (_, s, y) => `:${String((Number(s) + 7) % 60).padStart(2, '0')} ${y}`), lines: [other.wt] });
  assert.deepEqual(scanLiveSessions({ home: other.home, env: {}, platform: process.platform }), { available: true, sessions: [], unplaced: [] });
});

// ---- rules ----

test('inUseReasons: an open session in the worktree, and one that could not be placed, are reasons; absent or empty is none', () => {
  const base = { locked: null, processes: { available: true, pids: [] }, transcripts: [], memoryNotes: [], recentFiles: [] };
  assert.deepEqual(inUseReasons(base), [], 'a caller that does not pass the signal is unchanged');
  assert.deepEqual(inUseReasons({ ...base, liveSessions: { hits: [], unplaced: [] } }), []);
  assert.deepEqual(inUseReasons({ ...base, liveSessions: { hits: [{ id: 'abcd1234', pid: 7 }, { id: 'ef012345', pid: 9 }], unplaced: [] } }),
    ['a Claude session is open there now (abcd1234 pid 7, ef012345 pid 9)']);
  assert.deepEqual(inUseReasons({ ...base, liveSessions: { hits: [], unplaced: ['ps failed', 'second'] } }),
    ['an open Claude session could not be placed: ps failed (+1 more)']);
});

// ---- removal: the fresh scan right before anything is deleted ----

function repoWithWorktree() {
  const repo = createTmpRepo();
  repo.write('a.txt', 'a\n');
  repo.write('.gitignore', 'node_modules/\n');
  repo.commit('init');
  mkdirSync(join(repo.dir, '.worktrees'));
  repo.git(['worktree', 'add', '-q', '-b', 'agent/x', join('.worktrees', 'agent-x'), 'main']);
  return { repo, wt: join(repo.dir, '.worktrees', 'agent-x') };
}
const noProcs = () => ({ platform: 'linux', procRoot: mkdtempSync(join(tmpdir(), 'p-')) });
const removal = (repo, wt, extra) => removeWorktree({
  root: repo.dir, wt: { slug: 'agent-x', path: wt }, cfg: { delete: [], archive: [] }, pr: 9, holdingDir: mkdtempSync(join(tmpdir(), 'h-')),
  runId: 'live1', runStartMs: Date.now() + 5000, settleMs: 0, procOpts: noProcs(), ...extra,
});
const openAt = (cwd) => () => ({ available: true, sessions: [{ id: 'abcd1234', pid: 5, cwd }], unplaced: [] });

test('removeWorktree: a session open in the worktree appeared after the evaluation -> moved back, kept, nothing deleted', async () => {
  const { repo, wt } = repoWithWorktree();
  let scans = 0;
  const r = await removal(repo, wt, { liveScan: () => { scans += 1; return openAt(wt)(); } });
  assert.deepEqual([r.removed, r.restored], [false, true]);
  assert.equal(r.reason, 'in use during removal: a Claude session is open there now (abcd1234 pid 5)');
  assert.equal(scans, 1, 'one fresh scan per removal');
  assert.equal(readFileSync(join(wt, 'a.txt'), 'utf8'), 'a\n');
});

test('removeWorktree: the session is matched against where the worktree WAS (the quarantine path is gone from its log), cwd below it counts', async () => {
  const { repo, wt } = repoWithWorktree();
  mkdirSync(join(wt, 'sub'));
  const r = await removal(repo, wt, { liveScan: openAt(join(wt, 'sub')) });
  assert.deepEqual([r.removed, r.restored], [false, true]);
  assert.match(r.reason, /^in use during removal: a Claude session is open there now/);
});

test('removeWorktree: a session logged under a symlink alias of the worktree path is matched even though the worktree has moved', { skip: WIN && 'symlinks need privileges on Windows CI' }, async () => {
  const { repo, wt } = repoWithWorktree();
  // like ~/Claude -> ~/projects: a link in an ancestor directory of the real path (here the temp dir), <alias>/.worktrees/agent-x
  const alias = join(dirname(repo.dir), `cp-alias-${process.pid}-${Date.now()}`);
  symlinkSync(repo.dir, alias);
  scratch.push(alias); // (removing a link removes the link only)
  const r = await removal(repo, wt, { liveScan: openAt(join(alias, '.worktrees', 'agent-x')) });
  assert.deepEqual([r.removed, r.restored], [false, true], r.reason);
  assert.match(r.reason, /a Claude session is open there now/);
});

test('removeWorktree: an open session that could not be placed keeps it; a scan that throws keeps it; "unavailable" and sessions elsewhere do not', async () => {
  let t = repoWithWorktree();
  let r = await removal(t.repo, t.wt, { liveScan: () => ({ available: true, sessions: [], unplaced: ['ps failed'] }) });
  assert.deepEqual([r.removed, r.restored], [false, true]);
  assert.equal(r.reason, 'in use during removal: an open Claude session could not be placed: ps failed');
  t = repoWithWorktree();
  r = await removal(t.repo, t.wt, { liveScan: () => { throw new Error('scan exploded'); } });
  assert.deepEqual([r.removed, r.restored], [false, true]);
  assert.match(r.reason, /^could not re-inspect during removal: scan exploded/);
  t = repoWithWorktree();
  r = await removal(t.repo, t.wt, { liveScan: () => ({ available: false, reason: 'test' }) });
  assert.equal(r.removed, true, 'an unavailable signal falls back to the other checks');
  t = repoWithWorktree();
  r = await removal(t.repo, t.wt, { liveScan: openAt(t.repo.dir) });
  assert.equal(r.removed, true, 'a session in the main checkout is not in the worktree');
});

test('removeWorktree: without a liveScan option it scans this machine for real (never skipped by default)', async () => {
  const { repo, wt } = repoWithWorktree();
  const home = process.env.HOME;
  const profile = process.env.USERPROFILE;
  const cfgDir = process.env.CLAUDE_CONFIG_DIR;
  const fake = mkdtempSync(join(tmpdir(), 'cp-fakehome-'));
  scratch.push(fake);
  mkdirSync(join(fake, '.claude', 'sessions'), { recursive: true });
  writeFileSync(join(fake, '.claude', 'sessions', '31.json'), '{ not json'); // unparseable record -> "could not be placed"
  process.env.HOME = fake;
  process.env.USERPROFILE = fake;
  delete process.env.CLAUDE_CONFIG_DIR;
  try {
    const r = await removeWorktree({
      root: repo.dir, wt: { slug: 'agent-x', path: wt }, cfg: { delete: [], archive: [] }, pr: 9, holdingDir: mkdtempSync(join(tmpdir(), 'h-')),
      runId: 'live2', runStartMs: Date.now() + 5000, settleMs: 0, procOpts: noProcs(),
    });
    if (WIN) assert.equal(r.removed, true, 'Windows: the signal is unavailable');
    else assert.match(r.reason, /^in use during removal: an open Claude session could not be placed: session record .*31\.json is unreadable/);
  } finally {
    process.env.HOME = home;
    if (profile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = profile;
    if (cfgDir !== undefined) process.env.CLAUDE_CONFIG_DIR = cfgDir;
    if (home === undefined) delete process.env.HOME;
  }
});
