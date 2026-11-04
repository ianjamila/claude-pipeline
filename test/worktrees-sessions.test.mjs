// `pipeline worktrees sessions <dir>`: the read-only "is a Claude session open in this folder?" check an agent runs before it
// removes a worktree by hand. Only exit 0 means "nothing open, and the scan could see everything": 1 = a session is open there,
// 2 = usage, 3 = unsure (the scan is unavailable or partial, or a session's working folder cannot be resolved), so a caller
// treats every non-zero as "keep". Real scanner over fake config dirs (only ps is stubbed in-process); the spawned tests run the
// real CLI from a folder that is no repository, with no config and no GitHub.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
  const sessions = (args, { alive = [], deps = {}, cwd = base } = {}) => run(['sessions', ...args], { cwd, env: {}, sessionsDeps: { home, starts: aliveStarts(alive), ...deps } }).catch(errorResult); // a UsageError becomes exit 2, as in the CLI
  return { base, home, wt, elsewhere, sessions };
}

test('sessions: no session in the folder (one elsewhere) -> exit 0, ok, with the folder and an empty open list', { skip: POSIX }, async () => {
  const w = world();
  addSession(w.home, { pid: 11, sid: 'aaaaaaaa-1111', lines: [w.elsewhere] });
  const r = await w.sessions([w.wt], { alive: [11] });
  assert.equal(r.exitCode, 0);
  assert.deepEqual(r.output, { ok: true, dir: w.wt, available: true, open: [], unplaced: [] });
});

test('sessions: a session inside the folder (or below it) -> exit 1 naming id and pid; the folder may be given relative', { skip: POSIX }, async () => {
  const w = world();
  addSession(w.home, { pid: 11, sid: 'aaaaaaaa-1111', lines: [join(w.wt, 'app')] });
  const r = await w.sessions([w.wt], { alive: [11] });
  assert.equal(r.exitCode, 1);
  assert.deepEqual(r.output, { ok: false, dir: w.wt, available: true, open: [{ id: 'aaaaaaaa', pid: 11 }], unplaced: [] });
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
});

// The real CLI, run from a folder that is no git repository, with no pipeline.yml and no gh: read-only and self-contained.
function cli(args, { home, cwd }) {
  const env = { ...process.env, HOME: home };
  for (const k of ['CLAUDE_CONFIG_DIR', 'GH_TOKEN', 'GITHUB_TOKEN', 'GH_HOST']) delete env[k];
  const r = spawnSync(process.execPath, [bin, 'worktrees', ...args], { cwd, env, encoding: 'utf8' });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* left null */ }
  return { code: r.status, json, stderr: r.stderr };
}

test('sessions (real CLI, outside any repository, no config, no GitHub): 0 with nothing open, 1 with a live session in the folder, 3 without a sessions folder, 2 without a folder', { skip: POSIX }, () => {
  const w = world();
  const nothing = cli(['sessions', w.wt], { home: w.home, cwd: w.base });
  assert.equal(nothing.code, 0, nothing.stderr);
  assert.deepEqual(nothing.json, { ok: true, dir: w.wt, available: true, open: [], unplaced: [] });
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
