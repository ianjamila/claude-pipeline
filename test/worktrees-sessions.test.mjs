// `pipeline worktrees sessions <dir>`: the read-only "is a Claude session open in this folder?" check an agent runs before it
// removes a worktree by hand. Only exit 0 means "nothing open, and the scan could see everything": 1 = a session is open there,
// 2 = usage, 3 = unsure (the scan is unavailable or partial, or a session's working folder cannot be resolved), so a caller
// treats every non-zero as "keep". Real scanner over fake config dirs (only ps is stubbed in-process); the spawned tests run the
// real CLI from a folder that is no repository, with no config and no GitHub.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { errorResult } from '../pipeline/lib/cli.mjs';
import { run, meta } from '../pipeline/commands/worktrees.mjs';
import { psStarts } from '../pipeline/lib/worktree-prune/live-sessions.mjs';
import { addSession, aliveStarts } from './helpers/claude-sessions.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const bin = join(here, '..', 'pipeline', 'bin', 'pipeline.mjs');
const POSIX = process.platform === 'win32' ? 'POSIX only (ps, symlinks, chmod)' : false;
const NOT_ROOT = POSIX || (process.getuid?.() === 0 && 'chmod 000 does not stop root');

const scratch = [];
after(() => scratch.forEach((d) => rmSync(d, { recursive: true, force: true, maxRetries: 3 })));

// <base>/home (with an empty sessions folder, so the scan is available), <base>/wt/app = the folder asked about, <base>/else.
function world({ sessionsFolder = true } = {}) {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'cp-sessions-')));
  scratch.push(base);
  const home = join(base, 'home');
  const wt = join(base, 'wt');
  const elsewhere = join(base, 'else');
  mkdirSync(join(home, '.claude', sessionsFolder ? 'sessions' : 'projects'), { recursive: true });
  mkdirSync(join(wt, 'app'), { recursive: true });
  mkdirSync(elsewhere);
  const sessions = (args, { alive = [], deps = {}, cwd = base, env = {} } = {}) => run(['sessions', ...args], { cwd, env, sessionsDeps: { home, starts: aliveStarts(alive), ...deps } }).catch(errorResult); // a UsageError becomes exit 2, as in the CLI
  return { base, home, wt, elsewhere, sessions };
}

test('sessions: no session in the folder (one elsewhere) -> exit 0, ok, with the folder and an empty open list', { skip: POSIX }, async () => {
  const w = world();
  addSession(w.home, { pid: 11, sid: 'aaaaaaaa-1111', lines: [w.elsewhere] });
  const r = await w.sessions([w.wt], { alive: [11] });
  assert.equal(r.exitCode, 0);
  assert.deepEqual(r.output, { ok: true, dir: w.wt, available: true, caller: null, open: [], unplaced: [], onlySelf: false });
});

test('sessions: a session inside the folder (or below it) -> exit 1 naming id and pid; the folder may be given relative', { skip: POSIX }, async () => {
  const w = world();
  addSession(w.home, { pid: 11, sid: 'aaaaaaaa-1111', lines: [join(w.wt, 'app')] });
  const r = await w.sessions([w.wt], { alive: [11] });
  assert.equal(r.exitCode, 1);
  assert.deepEqual(r.output, { ok: false, dir: w.wt, available: true, caller: null, open: [{ id: 'aaaaaaaa', pid: 11 }], unplaced: [], onlySelf: false });
  const rel = await w.sessions(['wt'], { alive: [11] });
  assert.equal(rel.exitCode, 1, 'resolved against the directory the command runs in');
  assert.equal(rel.output.dir, w.wt);
  const dead = await w.sessions([w.wt], { alive: [] });
  assert.equal(dead.exitCode, 0, 'a session whose process is gone is not open');
});

test('sessions: usage errors -> exit 2 (no folder, two, missing, a file)', { skip: POSIX }, async () => {
  const w = world();
  writeFileSync(join(w.base, 'file.txt'), 'x');
  for (const args of [[], [w.wt, w.elsewhere], [join(w.base, 'missing')], [join(w.base, 'file.txt')]]) {
    const r = await w.sessions(args);
    assert.equal(r.exitCode, 2, JSON.stringify(args));
    assert.equal(r.output.ok, false);
    assert.equal(r.output.error, 'usage');
  }
});

test('sessions: a session that cannot be placed -> exit 3 (unsure); a definite hit alongside it wins with exit 1', { skip: POSIX }, async () => {
  const w = world();
  addSession(w.home, { pid: 12, sid: 'bbbbbbbb-2222', raw: '{ half a record' });
  const unsure = await w.sessions([w.wt]);
  assert.equal(unsure.exitCode, 3);
  assert.equal(unsure.output.ok, false);
  assert.equal(unsure.output.available, true);
  assert.deepEqual(unsure.output.open, []);
  assert.match(unsure.output.unplaced[0], /12\.json.*unreadable/);
  addSession(w.home, { pid: 11, sid: 'aaaaaaaa-1111', lines: [w.wt] });
  const both = await w.sessions([w.wt], { alive: [11] });
  assert.equal(both.exitCode, 1);
  assert.deepEqual(both.output.open, [{ id: 'aaaaaaaa', pid: 11 }]);
  assert.equal(both.output.unplaced.length, 1, 'both are reported');
});

test('sessions: an unavailable scan is never "nothing open" -> exit 3 with the reason (no sessions folder; unsupported platform)', { skip: POSIX }, async () => {
  const none = world({ sessionsFolder: false });
  const r = await none.sessions([none.wt]);
  assert.equal(r.exitCode, 3);
  assert.equal(r.output.ok, false);
  assert.equal(r.output.available, false);
  assert.match(r.output.reason, /no Claude sessions folder/);
  const w = world();
  const unsupported = await w.sessions([w.wt], { deps: { platform: 'win32' } });
  assert.equal(unsupported.exitCode, 3);
  assert.equal(unsupported.output.available, false);
  assert.match(unsupported.output.reason, /not supported on win32/);
});

test('sessions: spelled through a symlink either way (the folder given as a link, or the session logged under one) -> exit 1', { skip: POSIX }, async () => {
  const w = world();
  symlinkSync(w.wt, join(w.base, 'link-to-wt'));
  addSession(w.home, { pid: 11, sid: 'aaaaaaaa-1111', lines: [join(w.wt, 'app')] });
  const asked = await w.sessions([join(w.base, 'link-to-wt')], { alive: [11] });
  assert.equal(asked.exitCode, 1, 'asked about the link, the session logged the real path');
  assert.equal(asked.output.dir, join(w.base, 'link-to-wt'));
  const w2 = world();
  symlinkSync(w2.wt, join(w2.base, 'link-to-wt'));
  addSession(w2.home, { pid: 12, sid: 'bbbbbbbb-2222', lines: [join(w2.base, 'link-to-wt', 'app')] });
  const logged = await w2.sessions([w2.wt], { alive: [12] });
  assert.equal(logged.exitCode, 1, 'asked about the real path, the session logged the link');
});

test('sessions: a working folder reached through an unreadable ancestor (chmod 000) while the folder is reachable by its real path -> exit 3, naming the session', { skip: NOT_ROOT }, async () => {
  const w = world();
  const locked = join(w.base, 'locked');
  mkdirSync(locked);
  symlinkSync(w.wt, join(locked, 'alias'));
  addSession(w.home, { pid: 11, sid: 'aaaaaaaa-1111', lines: [join(locked, 'alias', 'app')] });
  chmodSync(locked, 0o000);
  try {
    const r = await w.sessions([w.wt], { alive: [11] });
    assert.equal(r.exitCode, 3);
    assert.deepEqual(r.output.open, []);
    assert.match(r.output.unplaced[0], /session aaaaaaaa pid 11/);
    assert.ok(r.output.unplaced[0].includes(join(locked, 'alias', 'app')));
  } finally {
    chmodSync(locked, 0o755);
  }
});

test('sessions: a working folder logged through an alias that has since been deleted (target still there) -> exit 3, never "nothing open"', { skip: POSIX }, async () => {
  const w = world();
  symlinkSync(w.wt, join(w.base, 'alias'));
  addSession(w.home, { pid: 11, sid: 'aaaaaaaa-1111', lines: [join(w.base, 'alias', 'app')] });
  rmSync(join(w.base, 'alias'));
  const r = await w.sessions([w.wt], { alive: [11] });
  assert.equal(r.exitCode, 3);
  assert.match(r.output.unplaced[0], /session aaaaaaaa pid 11.*ENOENT/);
});

test('sessions: listed in the usage text', () => {
  assert.match(meta.usage, /pipeline worktrees sessions DIR/);
  assert.match(meta.summary, /sessions/);
  for (const flag of ['--self-ok', '--session-files', '--within', 'caller', 'onlySelf', 'recentSessionFiles']) assert.ok(meta.usage.includes(flag), flag);
});

// The real CLI, run from a folder that is no git repository, with no pipeline.yml and no gh: read-only and self-contained.
function cli(args, { home, cwd, extraEnv = {} }) {
  const env = { ...process.env, HOME: home };
  for (const k of ['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_PID', 'PIPELINE_SESSION_FILES_DIR', 'GH_TOKEN', 'GITHUB_TOKEN', 'GH_HOST']) delete env[k];
  Object.assign(env, extraEnv);
  const r = spawnSync(process.execPath, [bin, 'worktrees', ...args], { cwd, env, encoding: 'utf8' });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* left null */ }
  return { code: r.status, json, stderr: r.stderr };
}

test('sessions (real CLI, outside any repository, no config, no GitHub): 0 with nothing open, 1 with a live session in the folder, 3 without a sessions folder, 2 without a folder', { skip: POSIX }, () => {
  const w = world();
  const nothing = cli(['sessions', w.wt], { home: w.home, cwd: w.base });
  assert.equal(nothing.code, 0, nothing.stderr);
  assert.deepEqual(nothing.json, { ok: true, dir: w.wt, available: true, caller: null, open: [], unplaced: [], onlySelf: false });
  // this very process is a live "session": ps reports its real start time
  const start = psStarts([process.pid]).get(process.pid);
  addSession(w.home, { pid: process.pid, sid: 'cccccccc-3333', procStart: start, lines: [join(w.wt, 'app')] });
  const hit = cli(['sessions', w.wt], { home: w.home, cwd: w.base });
  assert.equal(hit.code, 1, hit.stderr);
  assert.deepEqual(hit.json.open, [{ id: 'cccccccc', pid: process.pid }]);
  const bare = world({ sessionsFolder: false });
  rmSync(join(bare.home, '.claude'), { recursive: true });
  const unavailable = cli(['sessions', bare.wt], { home: bare.home, cwd: bare.base });
  assert.equal(unavailable.code, 3, unavailable.stderr);
  assert.equal(unavailable.json.available, false);
  const usage = cli(['sessions'], { home: w.home, cwd: w.base });
  assert.equal(usage.code, 2);
});

// ---- #245: the caller's own session is not "another" session ------------------------------------------------------------
const ME = 'aaaaaaaa-1111-2222';
const OTHER = 'bbbbbbbb-3333-4444';
// The caller: a process whose env names session `sid` / pid `pid`, run under `pid` (ancestry is injected: shell 900, the session, init).
const asMe = (pid = 11, sid = ME) => ({ env: { CLAUDE_CODE_SESSION_ID: sid, CLAUDE_PID: String(pid) }, deps: { ancestors: () => [900, pid, 1] } });

test("sessions: the caller's own session (env id + CLAUDE_PID, nearest live ancestor) is self: default exit 1, onlySelf, --self-ok exit 0", { skip: POSIX }, async () => {
  const w = world();
  addSession(w.home, { pid: 11, sid: ME, lines: [join(w.wt, 'app')] });
  const me = asMe();
  const plain = await w.sessions([w.wt], { alive: [11], ...me });
  assert.equal(plain.exitCode, 1, 'the default verdict is unchanged');
  assert.deepEqual(plain.output.open, [{ id: 'aaaaaaaa', pid: 11, self: true }]);
  assert.equal(plain.output.caller, 'aaaaaaaa');
  assert.equal(plain.output.onlySelf, true);
  const ok = await w.sessions([w.wt, '--self-ok'], { alive: [11], ...me });
  assert.equal(ok.exitCode, 0);
  assert.equal(ok.output.ok, true);
  assert.equal(ok.output.onlySelf, true);
});

test('sessions: --self-ok with the caller AND another session -> exit 1; self + unplaced -> exit 3; an empty scan -> exit 0', { skip: POSIX }, async () => {
  const w = world();
  addSession(w.home, { pid: 11, sid: ME, lines: [join(w.wt, 'app')] });
  addSession(w.home, { pid: 12, sid: OTHER, lines: [w.wt] });
  const both = await w.sessions([w.wt, '--self-ok'], { alive: [11, 12], ...asMe() });
  assert.equal(both.exitCode, 1);
  assert.equal(both.output.onlySelf, false);
  assert.deepEqual(both.output.open, [{ id: 'aaaaaaaa', pid: 11, self: true }, { id: 'bbbbbbbb', pid: 12 }]);
  const w2 = world();
  addSession(w2.home, { pid: 11, sid: ME, lines: [join(w2.wt, 'app')] });
  addSession(w2.home, { pid: 13, sid: 'cccccccc-5555', raw: '{ half a record' });
  const unsure = await w2.sessions([w2.wt, '--self-ok'], { alive: [11], ...asMe() });
  assert.equal(unsure.exitCode, 3, 'exit 3 keeps priority over a self hit');
  assert.equal(unsure.output.onlySelf, false);
  const w3 = world();
  const empty = await w3.sessions([w3.wt, '--self-ok'], { alive: [] });
  assert.equal(empty.exitCode, 0);
  assert.equal(empty.output.onlySelf, false);
  const w4 = world();
  addSession(w4.home, { pid: 12, sid: OTHER, lines: [w4.wt] });
  addSession(w4.home, { pid: 13, sid: 'cccccccc-5555', raw: '{ half a record' });
  const hitAndUnsure = await w4.sessions([w4.wt, '--self-ok'], { alive: [12] });
  assert.equal(hitAndUnsure.exitCode, 1, 'a definite other session still wins over unsure, as without the flag');
});

test("sessions: two live pids sharing one session id are two entries; only the caller's pid is self, whichever it is", { skip: POSIX }, async () => {
  for (const callerPid of [11, 12]) {
    const w = world();
    addSession(w.home, { pid: 11, sid: ME, lines: [join(w.wt, 'app')] });
    addSession(w.home, { pid: 12, sid: ME, lines: [join(w.wt, 'app')] });
    const r = await w.sessions([w.wt, '--self-ok'], { alive: [11, 12], ...asMe(callerPid) });
    assert.equal(r.exitCode, 1, `caller pid ${callerPid}`);
    assert.equal(r.output.onlySelf, false);
    assert.deepEqual(r.output.open, [11, 12].map((pid) => ({ id: 'aaaaaaaa', pid, ...(pid === callerPid ? { self: true } : {}) })));
  }
});

test("sessions: no self when the env id is missing, malformed or another session's, or CLAUDE_PID disagrees, or the record is no ancestor", { skip: POSIX }, async () => {
  const w = world();
  addSession(w.home, { pid: 11, sid: ME, lines: [join(w.wt, 'app')] });
  const anc = { ancestors: () => [900, 11, 1] };
  const cases = {
    'no env': { env: {}, deps: anc },
    'malformed id': { env: { CLAUDE_CODE_SESSION_ID: '../../etc', CLAUDE_PID: '11' }, deps: anc },
    'foreign id': asMe(11, OTHER),
    'CLAUDE_PID differs': { env: { CLAUDE_CODE_SESSION_ID: ME, CLAUDE_PID: '99' }, deps: anc },
    'CLAUDE_PID not a number': { env: { CLAUDE_CODE_SESSION_ID: ME, CLAUDE_PID: 'x' }, deps: anc },
    'CLAUDE_PID missing': { env: { CLAUDE_CODE_SESSION_ID: ME }, deps: anc },
    'the record is not an ancestor': { env: { CLAUDE_CODE_SESSION_ID: ME, CLAUDE_PID: '11' }, deps: { ancestors: () => [900, 800, 1] } },
    'ancestry unavailable': { env: { CLAUDE_CODE_SESSION_ID: ME, CLAUDE_PID: '11' }, deps: { ancestors: () => null } },
  };
  for (const [name, c] of Object.entries(cases)) {
    const r = await w.sessions([w.wt, '--self-ok'], { alive: [11], ...c });
    assert.equal(r.exitCode, 1, name);
    assert.equal(r.output.caller, null, name);
    assert.equal(r.output.onlySelf, false, name);
    assert.deepEqual(r.output.open, [{ id: 'aaaaaaaa', pid: 11 }], name);
  }
});

test('sessions: a nested child session whose env names the OUTER session is not self (the nearest live ancestor decides)', { skip: POSIX }, async () => {
  const w = world();
  addSession(w.home, { pid: 100, sid: ME, lines: [join(w.wt, 'app')] }); // outer
  addSession(w.home, { pid: 200, sid: OTHER, lines: [w.wt] }); // the child session that runs this command
  const deps = { ancestors: () => [900, 200, 100, 1] };
  const r = await w.sessions([w.wt, '--self-ok'], { alive: [100, 200], env: { CLAUDE_CODE_SESSION_ID: ME, CLAUDE_PID: '100' }, deps });
  assert.equal(r.exitCode, 1);
  assert.equal(r.output.caller, null);
  assert.equal(r.output.onlySelf, false);
  assert.ok(r.output.open.every((e) => e.self === undefined));
  // the child's own env makes the child the caller; the outer session still blocks
  const own = await w.sessions([w.wt, '--self-ok'], { alive: [100, 200], env: { CLAUDE_CODE_SESSION_ID: OTHER, CLAUDE_PID: '200' }, deps });
  assert.equal(own.exitCode, 1);
  assert.equal(own.output.caller, 'bbbbbbbb');
  assert.equal(own.output.onlySelf, false);
});

test('sessions: a stale record (reused pid) is not a live ancestor, so the walk goes on to the real session', { skip: POSIX }, async () => {
  const w = world();
  addSession(w.home, { pid: 11, sid: ME, lines: [join(w.wt, 'app')] });
  addSession(w.home, { pid: 50, sid: OTHER, procStart: 'Mon Jan 1 00:00:00 2024', lines: [w.elsewhere] }); // pid 50 runs now, but started later
  const r = await w.sessions([w.wt, '--self-ok'], { alive: [11, 50], deps: { ancestors: () => [900, 50, 11, 1] }, env: { CLAUDE_CODE_SESSION_ID: ME, CLAUDE_PID: '11' } });
  assert.equal(r.exitCode, 0);
  assert.equal(r.output.caller, 'aaaaaaaa');
});

// ---- #245: --session-files (advisory: the command-centre's per-session files; the live scan stays the gate) --------------
const NOW = Date.parse('2026-11-11T12:00:00Z');
const HOUR = 3.6e6;
// <dir>/<name>.json with the given content; its mtime is NOW - mtimeAgoH.
function sessionFile(dir, name, body, { mtimeAgoH = 0 } = {}) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${name}.json`);
  writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body));
  const t = (NOW - mtimeAgoH * HOUR) / 1000;
  utimesSync(file, t, t);
  return file;
}
const tsAgo = (h) => new Date(NOW - h * HOUR).toISOString();
function filesWorld() {
  const w = world();
  const dir = join(w.base, 'sf');
  mkdirSync(dir);
  const check = (args = [], { deps = {}, ...rest } = {}) => w.sessions([w.wt, '--session-files', dir, ...args], { ...rest, deps: { now: () => NOW, ...deps } });
  return { ...w, dir, check };
}

test("session files: another session's file 2 h old -> exit 1 (listed); 30 h old -> 0; a different cwd is ignored; --within moves the window", { skip: POSIX }, async () => {
  const w = filesWorld();
  sessionFile(w.dir, 'dddddddd-0001', { sessionId: 'dddddddd-0001', cwd: join(w.wt, 'app'), ts: tsAgo(2) });
  sessionFile(w.dir, 'eeeeeeee-0002', { sessionId: 'eeeeeeee-0002', cwd: join(w.wt, 'app'), ts: tsAgo(30) });
  sessionFile(w.dir, 'ffffffff-0003', { sessionId: 'ffffffff-0003', cwd: w.elsewhere, ts: tsAgo(1) });
  const r = await w.check();
  assert.equal(r.exitCode, 1);
  assert.deepEqual(r.output.recentSessionFiles, [{ id: 'dddddddd', ageHours: 2 }]);
  const narrow = await w.check(['--within', '1']);
  assert.equal(narrow.exitCode, 0);
  assert.deepEqual(narrow.output.recentSessionFiles, []);
  const wide = await w.check(['--within', '48']);
  assert.equal(wide.exitCode, 1);
  assert.deepEqual(wide.output.recentSessionFiles.map((f) => f.id), ['dddddddd', 'eeeeeeee']);
  const bare = await w.sessions([w.wt], { deps: { now: () => NOW } });
  assert.equal(bare.output.recentSessionFiles, undefined, 'without the option the field is absent');
});

test('session files: PIPELINE_SESSION_FILES_DIR works like the flag; --within needs a number above 0 and a folder to read', { skip: POSIX }, async () => {
  const w = filesWorld();
  sessionFile(w.dir, 'dddddddd-0001', { cwd: w.wt, ts: tsAgo(2) });
  const r = await w.sessions([w.wt], { env: { PIPELINE_SESSION_FILES_DIR: w.dir }, deps: { now: () => NOW } });
  assert.equal(r.exitCode, 1);
  for (const bad of ['0', '-1', 'abc', '']) {
    const u = await w.check(['--within', bad]);
    assert.equal(u.exitCode, 2, JSON.stringify(bad));
  }
  const lone = await w.sessions([w.wt, '--within', '5']);
  assert.equal(lone.exitCode, 2, '--within without a folder to read');
});

test('session files: the window boundary is inclusive; a future ts is recent', { skip: POSIX }, async () => {
  const w = filesWorld();
  sessionFile(w.dir, 'a1', { cwd: w.wt, ts: tsAgo(24) });
  assert.equal((await w.check()).exitCode, 1, 'exactly 24 h old');
  const w2 = filesWorld();
  sessionFile(w2.dir, 'a1', { cwd: w2.wt, ts: new Date(NOW - 24 * HOUR - 1000).toISOString() });
  assert.equal((await w2.check()).exitCode, 0, 'one second past the window');
  const w3 = filesWorld();
  sessionFile(w3.dir, 'a1', { cwd: w3.wt, ts: new Date(NOW + 3 * 24 * HOUR).toISOString() }, { mtimeAgoH: 100 });
  const r = await w3.check();
  assert.equal(r.exitCode, 1, 'a ts days in the future is not old');
  assert.equal(r.output.recentSessionFiles[0].ageHours, 0);
});

test('session files: a ts without an offset (or not a date) falls back to the mtime; a valid recent ts beats an old mtime', { skip: POSIX }, async () => {
  const w = filesWorld();
  sessionFile(w.dir, 'a1', { cwd: w.wt, ts: '2026-11-11T11:00:00' }, { mtimeAgoH: 30 }); // no Z: unusable, the mtime says 30 h
  sessionFile(w.dir, 'a2', { cwd: w.wt, ts: 'yesterday' }, { mtimeAgoH: 40 });
  assert.equal((await w.check()).exitCode, 0, 'both fall back to an old mtime');
  const w2 = filesWorld();
  sessionFile(w2.dir, 'a1', { cwd: w2.wt, ts: '2026-11-11T11:00:00' }, { mtimeAgoH: 1 });
  const r2 = await w2.check();
  assert.equal(r2.exitCode, 1, 'unusable ts + recent mtime');
  assert.equal(r2.output.recentSessionFiles[0].ageHours, 1);
  const w3 = filesWorld();
  sessionFile(w3.dir, 'a1', { cwd: w3.wt, ts: tsAgo(2) }, { mtimeAgoH: 30 });
  const r3 = await w3.check();
  assert.equal(r3.exitCode, 1, 'a valid ts 2 h old with an mtime 30 h old blocks');
  assert.equal(r3.output.recentSessionFiles[0].ageHours, 2);
  const w4 = filesWorld();
  sessionFile(w4.dir, 'a1', { cwd: w4.wt, ts: new Date(NOW - 2 * HOUR).toISOString().replace('Z', '+00:00') }, { mtimeAgoH: 30 });
  assert.equal((await w4.check()).exitCode, 1, 'an explicit offset is usable');
});

test('session files: unreadable or malformed files are judged by mtime: recent -> unplaced, exit 3; old -> skipped', { skip: POSIX }, async () => {
  const w = filesWorld();
  sessionFile(w.dir, 'half', '{ "cwd": "', { mtimeAgoH: 1 });
  const partial = await w.check();
  assert.equal(partial.exitCode, 3);
  assert.deepEqual(partial.output.unplaced, ['session file half.json: malformed']);
  const w2 = filesWorld();
  sessionFile(w2.dir, 'nocwd', { sessionId: 'x', ts: tsAgo(1) }, { mtimeAgoH: 1 });
  sessionFile(w2.dir, 'arr', '[1,2]', { mtimeAgoH: 1 });
  const missing = await w2.check();
  assert.equal(missing.exitCode, 3);
  assert.equal(missing.output.unplaced.length, 2);
  assert.ok(missing.output.unplaced.every((u) => /malformed$/.test(u)));
  const w3 = filesWorld();
  sessionFile(w3.dir, 'half', '{ "cwd": "', { mtimeAgoH: 30 });
  sessionFile(w3.dir, 'nocwd', { sessionId: 'x' }, { mtimeAgoH: 30 });
  const old = await w3.check();
  assert.equal(old.exitCode, 0, 'old bad files are skipped');
  assert.deepEqual(old.output.unplaced, []);
});

test('session files: a recent file that cannot be read -> unplaced "unreadable", exit 3', { skip: NOT_ROOT }, async () => {
  const w = filesWorld();
  const file = sessionFile(w.dir, 'locked', { cwd: w.wt, ts: tsAgo(1) }, { mtimeAgoH: 1 });
  chmodSync(file, 0o000);
  try {
    const r = await w.check();
    assert.equal(r.exitCode, 3);
    assert.deepEqual(r.output.unplaced, ['session file locked.json: unreadable']);
  } finally {
    chmodSync(file, 0o644);
  }
});

test('session files: a folder that cannot be listed -> exit 3, never "nothing recent"', { skip: POSIX }, async () => {
  const w = world();
  const r = await w.sessions([w.wt, '--session-files', join(w.base, 'nope')], { deps: { now: () => NOW } });
  assert.equal(r.exitCode, 3);
  assert.match(r.output.unplaced[0], /cannot read the session files folder .*nope/);
});

test("session files: the caller's own file is self and never blocks; --self-ok reaches onlySelf; another file, or a file only named like the caller, still blocks", { skip: POSIX }, async () => {
  const w = filesWorld();
  addSession(w.home, { pid: 11, sid: ME, lines: [join(w.wt, 'app')] });
  sessionFile(w.dir, ME, { sessionId: ME, cwd: join(w.wt, 'app'), ts: tsAgo(0.5) });
  const me = asMe();
  const r = await w.check(['--self-ok'], { alive: [11], env: me.env, deps: me.deps });
  assert.equal(r.exitCode, 0);
  assert.equal(r.output.onlySelf, true);
  assert.deepEqual(r.output.recentSessionFiles, [{ id: 'aaaaaaaa', ageHours: 0.5, self: true }]);
  sessionFile(w.dir, OTHER, { sessionId: OTHER, cwd: w.wt, ts: tsAgo(3) });
  const both = await w.check(['--self-ok'], { alive: [11], env: me.env, deps: me.deps });
  assert.equal(both.exitCode, 1);
  assert.equal(both.output.onlySelf, false);
  const w2 = filesWorld();
  sessionFile(w2.dir, ME, { sessionId: OTHER, cwd: w2.wt, ts: tsAgo(1) }); // named like the caller, says it is another session
  const spoof = await w2.check(['--self-ok'], { env: me.env, deps: me.deps });
  assert.equal(spoof.exitCode, 1);
  assert.equal(spoof.output.recentSessionFiles[0].self, undefined);
  const none = await w.check([], { alive: [11], env: {}, deps: { ancestors: () => [900, 11, 1] } });
  assert.equal(none.exitCode, 1);
  assert.ok(none.output.recentSessionFiles.every((f) => f.self === undefined), 'with no caller nothing is self');
});

test('sessions (real CLI): the env id + CLAUDE_PID of the parent process make it the caller; --self-ok exits 0, the plain run 1', { skip: POSIX }, () => {
  const w = world();
  // the CLI's parent is THIS process: it plays the Claude session, with its real start time
  const start = psStarts([process.pid]).get(process.pid);
  addSession(w.home, { pid: process.pid, sid: 'cccccccc-3333', procStart: start, lines: [join(w.wt, 'app')] });
  const extraEnv = { CLAUDE_CODE_SESSION_ID: 'cccccccc-3333', CLAUDE_PID: String(process.pid) };
  const plain = cli(['sessions', w.wt], { home: w.home, cwd: w.base, extraEnv });
  assert.equal(plain.code, 1, plain.stderr);
  assert.deepEqual(plain.json.open, [{ id: 'cccccccc', pid: process.pid, self: true }]);
  assert.equal(plain.json.caller, 'cccccccc');
  assert.equal(plain.json.onlySelf, true);
  const ok = cli(['sessions', w.wt, '--self-ok'], { home: w.home, cwd: w.base, extraEnv });
  assert.equal(ok.code, 0, ok.stderr);
  const foreign = cli(['sessions', w.wt, '--self-ok'], { home: w.home, cwd: w.base, extraEnv: { ...extraEnv, CLAUDE_PID: '1' } });
  assert.equal(foreign.code, 1);
  assert.equal(foreign.json.caller, null);
  const viaEnv = cli(['sessions', w.wt, '--self-ok'], { home: w.home, cwd: w.base, extraEnv: { ...extraEnv, PIPELINE_SESSION_FILES_DIR: join(w.base, 'no-such-folder') } });
  assert.equal(viaEnv.code, 3, 'a session files folder that does not exist');
});
