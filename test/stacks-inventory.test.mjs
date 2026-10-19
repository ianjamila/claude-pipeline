// Why: the inventory is what every stack-stop decision starts from, and it must fail closed. A container without a workdir
// label (the live DRMed stack) must become "workdir unknown", a dead daemon is a definite "no stacks" while a timeout or
// garbage is unknown, every docker call is bounded by the caller's deadline, and the docker binary is chosen by the caller
// (resolveDocker), never read from the environment inside inventory.mjs. Docker is always a fake `run`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, chmodSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readInventory, cachedInventory, refreshCache, resolveDocker, DOCKER_DOWN_RE } from '../pipeline/lib/stacks/inventory.mjs';
import { fakeDocker, container } from './fixtures/fake-docker.mjs';

const posixOnly = { skip: process.platform === 'win32' && 'POSIX only' };
const cfg = { status: 'ok', shared: new Set(['drmed', 'e2e-ci']) };
const id = (p) => p;
const readRealpath = (p) => realpathSync(p);
const tmp = (name = 'stacks-inv-') => mkdtempSync(join(tmpdir(), name));
const ports = (...ps) => Object.fromEntries(ps.map((p) => [`${p}/tcp`, [{ HostIp: '0.0.0.0', HostPort: String(p) }]]));

test('DRMed-shaped container without workdir label is kept as workdir unknown', () => {
  const run = fakeDocker({ ps: 'c1\n', inspect: [container({ id: 'c1', name: '/supabase_db_DRMed', project: 'DRMed', workdir: undefined, ports: { '5432/tcp': [{ HostPort: '54322' }] } })] });
  const r = readInventory({ run, cfg, realpath: id });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value.stacks.map((s) => [s.project, s.workdir, s.workdirExists, s.shared, s.folder]), [['DRMed', null, false, true, null]]);
});

test('containers are grouped by project label; ports deduped and sorted; generation from the db container', () => {
  const run = fakeDocker({
    ps: 'a1\na2\nb1\n',
    inspect: [
      container({ id: 'a1', name: '/supabase_kong_sa', project: 'sa', workdir: '/w/sa.stack', ports: ports(54421, 54420), volumes: ['logs'] }),
      container({ id: 'a2', name: '/supabase_db_sa', project: 'sa', workdir: '/w/sa.stack', startedAt: '2026-10-19T02:00:00Z', ports: { ...ports(54422), '5432/tcp': null }, dbVolume: 'supabase_db_sa', volumes: ['cache', 'logs'] }),
      container({ id: 'b1', name: '/supabase_kong_other', project: 'other', workdir: '/w/other.stack', running: false, ports: ports(54522) }),
    ],
  });
  const r = readInventory({ run, cfg, realpath: id });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value.stacks.map((s) => s.project), ['other', 'sa']);
  const sa = r.value.stacks.find((s) => s.project === 'sa');
  assert.deepEqual(sa.ports, [54420, 54421, 54422]);
  assert.deepEqual(sa.generation, { id: 'a2', startedAt: '2026-10-19T02:00:00Z' });
  assert.deepEqual(sa.containers, [
    { id: 'a1', name: 'supabase_kong_sa', running: true, startedAt: '2026-10-19T01:00:00.000000000Z' },
    { id: 'a2', name: 'supabase_db_sa', running: true, startedAt: '2026-10-19T02:00:00Z' },
  ]);
  assert.deepEqual(sa.volumes, ['cache', 'logs', 'supabase_db_sa']);
  assert.equal(sa.dbVolume, 'supabase_db_sa');
  assert.equal(sa.workdir, '/w/sa.stack');
  assert.equal(sa.folder, '/w/sa.stack');
  assert.equal(sa.shared, false);
  const other = r.value.stacks.find((s) => s.project === 'other');
  assert.equal(other.generation, null, 'no db container => no generation');
  assert.equal(other.dbVolume, null);
  assert.equal(other.containers[0].running, false);
});

test('dbVolume is the data-directory mount of the supabase_db container only', () => {
  const noDb = fakeDocker({ ps: 'a\n', inspect: [container({ id: 'a', name: '/supabase_db_p', project: 'p', workdir: '/w/p', volumes: ['x'] })] });
  assert.equal(readInventory({ run: noDb, cfg, realpath: id }).value.stacks[0].dbVolume, null, 'db container without a data mount');
  const elsewhere = fakeDocker({
    ps: 'a\nb\n',
    inspect: [
      container({ id: 'a', name: '/supabase_db_p', project: 'p', workdir: '/w/p' }),
      container({ id: 'b', name: '/supabase_storage_p', project: 'p', workdir: '/w/p', dbVolume: 'not-the-db-volume' }),
    ],
  });
  assert.equal(readInventory({ run: elsewhere, cfg, realpath: id }).value.stacks[0].dbVolume, null, 'another container mounting that path is not the db volume');
  const bind = fakeDocker({ ps: 'a\n', inspect: [container({ id: 'a', name: '/supabase_db_p', project: 'p', workdir: '/w/p', mounts: [{ Type: 'bind', Source: '/x', Destination: '/var/lib/postgresql/data' }] })] });
  assert.equal(readInventory({ run: bind, cfg, realpath: id }).value.stacks[0].dbVolume, null, 'a bind mount has no volume name');
});

test('a workdir path with a space is realpath-ed; a missing workdir keeps the label and reports it absent', () => {
  const base = tmp('stacks inv ');
  const dir = join(base, 'sub detach.stack');
  mkdirSync(dir, { recursive: true });
  const run = fakeDocker({
    ps: 'a\nb\n',
    inspect: [
      container({ id: 'a', name: '/supabase_db_sub', project: 'sub', workdir: dir }),
      container({ id: 'b', name: '/supabase_db_gone', project: 'gone', workdir: join(base, 'nope.stack') }),
    ],
  });
  const r = readInventory({ run, cfg });
  const sub = r.value.stacks.find((s) => s.project === 'sub');
  assert.equal(sub.workdirExists, true);
  assert.equal(sub.workdir, readRealpath(dir));
  assert.ok(sub.workdir.includes(' '));
  const gone = r.value.stacks.find((s) => s.project === 'gone');
  assert.deepEqual([gone.workdir, gone.workdirExists], [join(base, 'nope.stack'), false]);
});

test('a symlinked workdir is resolved to its real path', posixOnly, () => {
  const base = tmp('stacks-inv-link ');
  const real = join(base, 'real dir.stack');
  mkdirSync(real);
  const link = join(base, 'link.stack');
  symlinkSync(real, link);
  const run = fakeDocker({ ps: 'a\n', inspect: [container({ id: 'a', name: '/supabase_db_l', project: 'l', workdir: link })] });
  assert.equal(readInventory({ run, cfg }).value.stacks[0].workdir, readRealpath(real));
});

test('containers of one project that disagree about the workdir => workdir unknown', () => {
  const run = fakeDocker({
    ps: 'a\nb\n',
    inspect: [
      container({ id: 'a', name: '/supabase_db_p', project: 'p', workdir: '/w/one' }),
      container({ id: 'b', name: '/supabase_kong_p', project: 'p', workdir: '/w/two' }),
    ],
  });
  const s = readInventory({ run, cfg, realpath: id }).value.stacks[0];
  assert.deepEqual([s.workdir, s.workdirExists, s.folder], [null, false, null]);
});

test('shared: config ids, -pipeline suffix and a .verify workdir are marked shared (case-insensitive)', () => {
  const run = fakeDocker({
    ps: 'a\nb\nc\nd\n',
    inspect: [
      container({ id: 'a', name: '/supabase_db_E2E-CI', project: 'E2E-CI', workdir: '/w/e' }),
      container({ id: 'b', name: '/supabase_db_ew-pipeline', project: 'ew-pipeline', workdir: '/w/p' }),
      container({ id: 'c', name: '/supabase_db_x', project: 'x', workdir: '/r/wt/.verify/supabase-workdir' }),
      container({ id: 'd', name: '/supabase_db_priv', project: 'priv', workdir: '/w/priv.stack' }),
    ],
  });
  const got = Object.fromEntries(readInventory({ run, cfg, realpath: id }).value.stacks.map((s) => [s.project, s.shared]));
  assert.deepEqual(got, { 'E2E-CI': true, 'ew-pipeline': true, x: true, priv: false });
  // with no usable config the built-in rules still hold
  const bare = Object.fromEntries(readInventory({ run, cfg: { status: 'missing', shared: new Set() }, realpath: id }).value.stacks.map((s) => [s.project, s.shared]));
  assert.deepEqual(bare, { 'E2E-CI': false, 'ew-pipeline': true, x: true, priv: false });
});

test('no supabase containers => ok with no stacks and no inspect call', () => {
  const run = fakeDocker({ ps: '\n' });
  assert.deepEqual(readInventory({ run, cfg }).value, { dockerDown: false, stacks: [] });
  assert.equal(run.calls.length, 1);
});

test('docker daemon down is a definite "no stacks", a timeout is unknown', () => {
  assert.deepEqual(readInventory({ run: () => ({ code: 1, stdout: '', stderr: 'Cannot connect to the Docker daemon at unix:///x. Is the docker daemon running?', timedOut: false }), cfg }).value, { dockerDown: true, stacks: [] });
  assert.equal(readInventory({ run: () => ({ code: 124, stdout: '', stderr: '', timedOut: true }), cfg }).ok, false);
  assert.match('failed to connect to /var/run/docker.sock: connect: connection refused', DOCKER_DOWN_RE);
  assert.match('dial unix /Users/x/.orbstack/run/docker.sock: connect: no such file or directory', DOCKER_DOWN_RE);
  // daemon going away between the two calls is also "down"
  const mid = (cmd, args) => (args[0] === 'ps'
    ? { code: 0, stdout: 'a\n', stderr: '', timedOut: false, signal: null }
    : { code: 1, stdout: '', stderr: 'Cannot connect to the Docker daemon', timedOut: false, signal: null });
  assert.deepEqual(readInventory({ run: mid, cfg }).value, { dockerDown: true, stacks: [] });
});

test('every other failure is unknown: signal, spawn error, bad exit, bad JSON, wrong shape, a throwing run', () => {
  const res = (over) => ({ code: 0, stdout: '', stderr: '', timedOut: false, signal: null, ...over });
  const bad = (psR, inspectR) => readInventory({ run: (c, a) => (a[0] === 'ps' ? psR : inspectR), cfg });
  const good = res({ stdout: 'a\n' });
  assert.equal(bad(res({ code: 1, signal: 'SIGKILL' }), null).ok, false, 'ps killed by a signal');
  assert.equal(bad(res({ code: 1, stderr: 'spawn docker ENOENT' }), null).ok, false, 'docker missing is not "daemon down"');
  assert.equal(bad(res({ code: 2, stderr: 'permission denied' }), null).ok, false);
  assert.equal(bad(good, res({ code: 0, stdout: '{not json' })).ok, false);
  assert.equal(bad(good, res({ code: 0, stdout: '{"a":1}' })).ok, false, 'not an array');
  assert.equal(bad(good, res({ code: 0, stdout: '[null]' })).ok, false, 'not objects');
  assert.equal(bad(good, res({ code: 1, stderr: 'Error: No such object: a' })).ok, false);
  assert.equal(bad(good, res({ code: 0, signal: 'SIGTERM', stdout: '[]' })).ok, false, 'inspect killed');
  assert.equal(bad(good, res({ code: 124, timedOut: true })).ok, false);
  const r = readInventory({ run: () => { throw new Error('boom'); }, cfg });
  assert.equal(r.ok, false);
  assert.match(r.reason, /boom/);
  assert.equal(readInventory({ run: fakeDocker({ ps: 'a\n', inspect: [container({ id: 'a', name: '/n', project: 'p' })] }), cfg: undefined, realpath: () => { throw new Error('rp'); } }).ok, true, 'a throwing realpath only means the workdir is absent');
});

test('the docker binary is the caller\'s, and calls are bounded by the deadline', () => {
  const run = fakeDocker({ ps: 'a\n', inspect: [container({ id: 'a', name: '/supabase_db_p', project: 'p', workdir: '/w/p' })] });
  readInventory({ run, cfg, docker: '/opt/x/docker', realpath: id });
  assert.deepEqual(run.calls.map((c) => c.cmd), ['/opt/x/docker', '/opt/x/docker']);
  assert.deepEqual(run.calls[0].args, ['ps', '--all', '--filter', 'label=com.supabase.cli.project', '--format', '{{.ID}}']);
  assert.deepEqual(run.calls[1].args, ['inspect', 'a']);
  assert.deepEqual(run.calls.map((c) => c.opts.timeoutMs), [10000, 10000], 'no deadline: the 10 s cap');
  const withDeadline = fakeDocker({ ps: 'a\n', inspect: [container({ id: 'a', name: '/supabase_db_p', project: 'p' })] });
  let t = 1000;
  readInventory({ run: withDeadline, cfg, deadlineAt: 1000 + 25000, now: () => t, realpath: id });
  assert.deepEqual(withDeadline.calls.map((c) => c.opts.timeoutMs), [10000, 10000], 'plenty left: capped at 10 s');
  const tight = fakeDocker({ ps: 'a\n', inspect: [container({ id: 'a', name: '/supabase_db_p', project: 'p' })] });
  readInventory({ run: tight, cfg, deadlineAt: 1000 + 3000, now: () => t, realpath: id });
  assert.deepEqual(tight.calls.map((c) => c.opts.timeoutMs), [3000, 3000], 'less than 10 s left: what is left');
});

test('under 500 ms left (before or between calls) => unknown deadline, no further docker call', () => {
  const run = fakeDocker({ ps: 'a\n', inspect: [container({ id: 'a', name: '/n', project: 'p' })] });
  const none = readInventory({ run, cfg, deadlineAt: 1499, now: () => 1000 });
  assert.deepEqual(none, { ok: false, reason: 'deadline' });
  assert.equal(run.calls.length, 0);
  assert.equal(readInventory({ run, cfg, deadlineAt: 1500, now: () => 1000 }).ok, true, '500 ms left is enough');
  // the deadline runs out between ps and inspect
  let t = 0;
  const slow = fakeDocker({ ps: 'a\n', inspect: [container({ id: 'a', name: '/n', project: 'p' })] });
  const clocked = (cmd, args, opts) => { const r = slow(cmd, args, opts); t += 9800; return r; };
  const mid = readInventory({ run: clocked, cfg, deadlineAt: 10000, now: () => t });
  assert.deepEqual(mid, { ok: false, reason: 'deadline' });
  assert.equal(slow.calls.length, 1);
});

test('readInventory reads no environment: the docker binary is only the one it is given', () => {
  const saved = process.env.PIPELINE_DOCKER;
  process.env.PIPELINE_DOCKER = '/should/not/be/used';
  try {
    const run = fakeDocker({ ps: '\n' });
    readInventory({ run, cfg });
    assert.equal(run.calls[0].cmd, 'docker');
  } finally {
    if (saved === undefined) delete process.env.PIPELINE_DOCKER;
    else process.env.PIPELINE_DOCKER = saved;
  }
});

// ---- cache ----
test('cache: fresh within 60 s, stale after, missing or damaged => no inventory; refresh writes writtenAt', () => {
  const file = join(tmp(), 'sub', 'inventory.json');
  assert.deepEqual(cachedInventory({ file, refresh: () => { throw new Error('must not refresh'); } }), { inv: null, fresh: false });
  const value = { dockerDown: false, stacks: [{ project: 'p' }] };
  const r = refreshCache({ file, refresh: () => ({ ok: true, value }), now: 1_000_000 });
  assert.deepEqual(r, { ok: true, value });
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).writtenAt, 1_000_000);
  assert.deepEqual(cachedInventory({ file, now: 1_000_000 + 59_999 }), { inv: value, fresh: true });
  assert.deepEqual(cachedInventory({ file, now: 1_000_000 + 60_000 }), { inv: value, fresh: false }, 'stale is returned, not hidden');
  assert.deepEqual(cachedInventory({ file, maxAgeMs: 5, now: 1_000_010 }), { inv: value, fresh: false });
  assert.deepEqual(cachedInventory({ file, now: 1_000_000 - 1 }), { inv: value, fresh: false }, 'a cache from the future is not trusted');
  writeFileSync(file, '{not json');
  assert.deepEqual(cachedInventory({ file, now: 1 }), { inv: null, fresh: false });
  writeFileSync(file, JSON.stringify({ writtenAt: 'yesterday', inventory: value }));
  assert.deepEqual(cachedInventory({ file, now: 1 }), { inv: null, fresh: false });
  writeFileSync(file, JSON.stringify({ writtenAt: 1, inventory: { stacks: 'nope' } }));
  assert.deepEqual(cachedInventory({ file, now: 1 }), { inv: null, fresh: false });
});

test('cachedInventory never refreshes by itself; refreshCache keeps the old cache when the refresh is unknown', () => {
  const file = join(tmp(), 'inventory.json');
  const value = { dockerDown: false, stacks: [] };
  refreshCache({ file, refresh: () => ({ ok: true, value }), now: 10 });
  const failed = refreshCache({ file, refresh: () => ({ ok: false, reason: 'docker timed out' }), now: 99_999_999 });
  assert.deepEqual(failed, { ok: false, reason: 'docker timed out' });
  assert.deepEqual(cachedInventory({ file, now: 20 }), { inv: value, fresh: true });
  // a cache that cannot be written is not an error for the caller
  const blocked = join(tmp(), 'f');
  writeFileSync(blocked, 'x');
  assert.deepEqual(refreshCache({ file: join(blocked, 'inventory.json'), refresh: () => ({ ok: true, value }), now: 1 }), { ok: true, value });
});

// ---- resolveDocker ----
function isolatedEnv(extra = {}) {
  const stateHome = tmp('stacks-state-');
  return { PIPELINE_STACKS_HOME: stateHome, PIPELINE_STACKS_ONLY: 'x', ...extra };
}

test('resolveDocker: the seam is honoured only for an isolated run in the checkout', posixOnly, () => {
  const home = tmp('stacks-home-');
  const checkout = tmp('stacks-root-');
  const env = isolatedEnv({ PIPELINE_DOCKER: '/fake/docker', PATH: '' });
  assert.equal(resolveDocker({ env, home, root: checkout, platform: 'linux', fallbackDirs: [] }), '/fake/docker');
  // default root supplied explicitly => ignored
  const dflt = { PIPELINE_STACKS_HOME: join(home, '.claude', 'pipeline-state', 'stacks'), PIPELINE_STACKS_ONLY: 'x', PIPELINE_DOCKER: '/fake/docker', PATH: '' };
  assert.equal(resolveDocker({ env: dflt, home, root: checkout, platform: 'linux', fallbackDirs: [] }), 'docker');
  // no ONLY => ignored
  const noOnly = { PIPELINE_STACKS_HOME: env.PIPELINE_STACKS_HOME, PIPELINE_DOCKER: '/fake/docker', PATH: '' };
  assert.equal(resolveDocker({ env: noOnly, home, root: checkout, platform: 'linux', fallbackDirs: [] }), 'docker');
  // installed copy => ignored whatever else is set (custom root and the default root)
  const installed = tmp('stacks-installed-');
  writeFileSync(join(installed, 'INSTALLED.json'), '{}');
  const warns = [];
  assert.equal(resolveDocker({ env, home, root: installed, platform: 'linux', fallbackDirs: [], warn: (m) => warns.push(m) }), 'docker');
  assert.equal(resolveDocker({ env: dflt, home, root: installed, platform: 'linux', fallbackDirs: [], warn: (m) => warns.push(m) }), 'docker');
});

test('resolveDocker: PATH first, then the fallback list (brew, /usr/local, OrbStack), else the bare name', posixOnly, () => {
  const home = tmp('stacks-home-');
  const root = tmp('stacks-root-');
  const exe = (dir) => { mkdirSync(dir, { recursive: true }); const f = join(dir, 'docker'); writeFileSync(f, '#!/bin/sh\n'); chmodSync(f, 0o755); return f; };
  const onPath = exe(join(home, 'bin'));
  const orb = exe(join(home, '.orbstack', 'bin'));
  assert.equal(resolveDocker({ env: { PATH: join(home, 'bin') }, home, root, platform: 'darwin' }), onPath);
  const found = resolveDocker({ env: { PATH: '' }, home, root, platform: 'darwin' });
  // brew / /usr/local installs on this machine would win over OrbStack; either is an existing absolute file
  assert.ok(found === orb || (found.startsWith('/') && existsSync(found)), found);
  assert.equal(resolveDocker({ env: { PATH: '' }, home, root, platform: 'darwin', fallbackDirs: [] }), 'docker');
  assert.equal(resolveDocker({ env: { PATH: '' }, home, root, platform: 'darwin', fallbackDirs: [join(home, '.orbstack', 'bin')] }), orb);
});

test('resolveDocker on Windows searches nothing', () => {
  assert.equal(resolveDocker({ env: { PATH: 'C:\\x' }, home: 'C:\\h', root: tmp(), platform: 'win32' }), 'docker');
});
