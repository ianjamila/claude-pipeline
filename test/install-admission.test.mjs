// Why (plan 2026-11-10, PR B1/B6): `install.mjs --require-no-live-reviews` is what the unattended update runs. These tests pin that every defer signal
// alone defers, that a clean machine installs while admission is held (observed from a swap gate) and released after, that a killed parent cannot
// release admission early, that a review starting after the final scan waits for the swap, that --expect-installed is checked under the lock, and that
// the guard hooks fail closed while the swap has their file moved away. Everything runs against scratch dirs and the miniature fixture source; the
// child installer gets a fake HOME + USERPROFILE and a fake `ps` (no Claude Code ancestor). POSIX-only parts skip on win32.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tryAcquire, release } from '../pipeline/lib/locks.mjs';
import { acquireAdmission, openOrRenewLease, releaseAdmission } from '../pipeline/lib/review-lease.mjs';
import { registerRepo } from '../pipeline/lib/queue-sweep.mjs';
import { openRecord } from '../pipeline/lib/merge-queue.mjs';
import { GUARD_FILES_MATCHER, HOOK_LOADER, installLockName, mergeSettings, ourHookGroups, dropSeamsWithoutTestMode } from '../pipeline/lib/installer.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const INSTALL = join(REPO, 'install.mjs');
const FIXTURE = join(REPO, 'test', 'fixtures', 'src-tree');
const POSIX = process.platform !== 'win32';
const MACHINE = 'test-machine-id';
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
process.env.PIPELINE_MACHINE_ID ||= MACHINE;

const made = [];
process.on('exit', () => { for (const d of made) rmSync(d, { recursive: true, force: true }); });
const scratch = (label = 'cp-adm') => {
  const d = realpathSync.native(mkdtempSync(join(tmpdir(), `${label}-`)));
  made.push(d);
  return d;
};

// A `ps` that knows no Claude Code ancestor, first on the child's PATH (the tests may themselves run inside Claude Code).
const FAKE_PS_DIR = (() => {
  if (!POSIX) return null;
  const dir = scratch('cp-adm-ps');
  writeFileSync(join(dir, 'ps'), ['#!/usr/bin/env node', 'const a = process.argv.slice(2);', "console.log(a.includes('args=') ? 'zsh' : '1 zsh');"].join('\n'));
  chmodSync(join(dir, 'ps'), 0o755);
  return dir;
})();

// One scratch machine: an account home (<account>/.claude is the claude-home), a fixture source, the lease folder, the lock folder, a fake user HOME.
function world() {
  const root = scratch();
  const w = {
    root, account: join(root, 'account'), src: join(root, 'src'), leases: join(root, 'leases'), locks: join(root, 'locks'), userHome: join(root, 'uh'), gate: join(root, 'gate'),
  };
  w.home = join(w.account, '.claude');
  for (const d of [w.account, w.locks, w.userHome, w.gate]) mkdirSync(d, { recursive: true });
  cpSync(FIXTURE, w.src, { recursive: true });
  // in-process options for the lease library, pointing at the same folder the child uses
  w.lease = { dir: w.leases, home: w.account, env: { CLAUDECODE: '1' }, ancestorPid: null, waitMs: 150 };
  return w;
}
const ENV_OFF = ['CLAUDECODE', 'CLAUDE_CONFIG_DIR', 'FAKE_PS_TABLE', `PIPELINE_${'ADMIN'}`];
function childEnv(w, extra = {}) {
  const env = {
    ...process.env, HOME: w.userHome, USERPROFILE: w.userHome, PIPELINE_INSTALL_NO_PROBES: '1', PIPELINE_TEST_MODE: '1', PIPELINE_MACHINE_ID: MACHINE,
    PIPELINE_INSTALL_ACCOUNT_HOME: w.account, PIPELINE_REVIEW_LEASE_DIR: w.leases, PIPELINE_LOCK_DIR: w.locks,
  };
  for (const k of ENV_OFF) delete env[k];
  if (FAKE_PS_DIR) env.PATH = `${FAKE_PS_DIR}${delimiter}${env.PATH}`;
  return Object.assign(env, extra);
}
const argsFor = (w, extra = []) => [INSTALL, '--claude-home', w.home, '--source', w.src, '--json', ...extra];
function run(w, extra = [], env = {}) {
  const r = spawnSync(process.execPath, argsFor(w, extra), { encoding: 'utf8', env: childEnv(w, env), timeout: 60_000 });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* not JSON */ }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
}
const installed = (w) => existsSync(join(w.home, 'pipeline', 'INSTALLED.json'));
const manifestOf = (w) => JSON.parse(readFileSync(join(w.home, 'pipeline', 'INSTALLED.json'), 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms = 20_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return; await sleep(25); }
  assert.fail(`timed out waiting for ${what}`);
}
// Admission is free iff it can be taken right now (and is given back at once).
async function admissionFree(w) {
  try { releaseAdmission(await acquireAdmission({ dir: w.leases, home: w.account, waitMs: 0 })); return true; } catch (err) {
    assert.equal(err.code, 'update-in-progress');
    return false;
  }
}
const lockOpts = (w) => ({ dir: w.locks, machineId: MACHINE });

// ---- every defer signal alone defers ------------------------------------------------------------------------------------------------------

function git(cwd, ...args) {
  const nul = process.platform === 'win32' ? 'NUL' : '/dev/null';
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: nul, GIT_CONFIG_SYSTEM: nul } });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}
function repoIn(w, name = 'repo') {
  const dir = join(w.root, name);
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  registerRepo({ root: dir, env: { PIPELINE_LOCK_DIR: w.locks } });
  return dir;
}
const holdLock = (name) => (w, t) => {
  const got = tryAcquire(name, lockOpts(w));
  assert.ok(got.acquired);
  t.after(() => release(got.lock));
};

const SIGNALS = {
  'a live review lease': { kind: 'lease', async arm(w) { await openOrRenewLease({ worktree: join(w.root, 'wt'), repoId: 'acme/app', pr: 7, ...w.lease }); } },
  'an unreadable lease file (counts as live)': { kind: 'lease', arm(w) { mkdirSync(w.leases, { recursive: true }); writeFileSync(join(w.leases, 'broken.json'), '{ not json'); } },
  'a running P job in a worktree of a known repo': {
    kind: 'job',
    arm(w, t) {
      const repo = repoIn(w);
      const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
      t.after(() => sleeper.kill());
      const jobDir = join(repo, '.review', 'jobs', 'j1');
      mkdirSync(jobDir, { recursive: true });
      writeFileSync(join(jobDir, 'meta.json'), JSON.stringify({ name: 'j1', command: 'x', cwd: repo, tag: null, runId: 'r1', startedAt: new Date().toISOString(), runnerPid: sleeper.pid }));
    },
  },
  'a held review state lock': { kind: 'state-lock', arm: holdLock('review-0123456789ab-pr7') },
  'a held merge lock': { kind: 'merge-lock', arm: holdLock('merge-acme__app-pr7') },
  'a held queue lock': { kind: 'queue-lock', arm: holdLock('queue-sweep-acme') },
  'a live merge-queue record': {
    kind: 'queue-record',
    arm(w) { openRecord(repoIn(w), 12, 'c'.repeat(40), {}, { repo: 'acme/app', repoId: 1 }); },
  },
};

for (const [name, signal] of Object.entries(SIGNALS)) {
  test(`defers (exit 3, nothing written, admission released) on ${name}`, async (t) => {
    const w = world();
    await signal.arm(w, t);
    const r = run(w, ['--require-no-live-reviews']);
    assert.equal(r.status, 3, r.stderr + r.stdout);
    assert.equal(r.json.ok, false);
    assert.equal(r.json.deferred, true);
    assert.equal(r.json.reason, 'live');
    assert.ok(r.json.live.some((e) => e.kind === signal.kind), JSON.stringify(r.json.live));
    for (const e of r.json.live) assert.equal(typeof e.detail, 'string');
    assert.equal(installed(w), false, 'no pipeline was installed');
    assert.equal(existsSync(join(w.home, 'settings.json')), false, 'settings.json was not touched');
    assert.equal(await admissionFree(w), true, 'a deferral gives admission back');
  });
}

test('a dead lease does not defer; a clean machine installs, verifies itself and lets go of admission', async () => {
  const w = world();
  mkdirSync(w.leases, { recursive: true });
  // a TTL-only lease renewed 7 hours ago: past the 6 h limit, so dead
  const old = new Date(Date.now() - 7 * 3600_000).toISOString();
  writeFileSync(join(w.leases, 'ttl-gone.json'), JSON.stringify({ version: 1, sessionId: 'ttl-gone', pid: null, pidStart: null, ttlOnly: true, leases: { [join(w.root, 'wt')]: { repoId: 'a/b', pr: 1, generation: 'g', openedAt: old, renewedAt: old } } }));
  const r = run(w, ['--require-no-live-reviews']);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.verify.ok, true, 'the installer verified itself (--check) before letting go');
  assert.deepEqual(r.json.verify.drift, []);
  assert.equal(installed(w), true);
  assert.equal(existsSync(join(w.leases, 'ttl-gone.json')), false, 'the dead lease was swept');
  assert.equal(await admissionFree(w), true);
});

// ---- admission is held through the swap, released after ----------------------------------------------------------------------------------

function startGated(w, extra = ['--require-no-live-reviews']) {
  const child = spawn(process.execPath, argsFor(w, extra), { env: childEnv(w, { PIPELINE_INSTALL_SWAP_GATE: w.gate }), stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  const exited = new Promise((resolve) => child.on('close', (status) => resolve({ status, stdout, stderr })));
  return { child, exited };
}
const open = (w, extra = {}) => openOrRenewLease({ worktree: join(w.root, 'wt'), repoId: 'acme/app', pr: 7, ...w.lease, ...extra });

test('no live work: installs, admission is held at the swap (no lease, no second updater) and released afterwards', async (t) => {
  const w = world();
  const { child, exited } = startGated(w);
  t.after(() => child.kill());
  await until(() => existsSync(join(w.gate, 'reached')), 'the swap gate');
  // at the swap: nothing installed yet, admission held by the installer process, the install lock held too
  assert.equal(installed(w), false);
  assert.equal(await admissionFree(w), false, 'admission is held at the swap');
  await assert.rejects(open(w), (err) => err.code === 'update-in-progress', 'a review cannot open a lease meanwhile');
  const second = run(w, ['--require-no-live-reviews']);
  assert.equal(second.status, 1, 'a second installer is refused by the install lock');
  assert.match(second.stderr, /another install is running/);
  writeFileSync(join(w.gate, 'go'), '');
  const r = await exited;
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const report = JSON.parse(r.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.verify.ok, true);
  assert.equal(installed(w), true);
  assert.equal(manifestOf(w).complete, true);
  assert.equal(await admissionFree(w), true, 'released afterwards');
  assert.equal((await open(w)).ok, true, 'a review is admitted again');
});

test('a review that starts after the final scan waits for admission and is granted only after the swap', async (t) => {
  const w = world();
  const { child, exited } = startGated(w);
  t.after(() => child.kill());
  await until(() => existsSync(join(w.gate, 'reached')), 'the swap gate');
  let grantedAfterSwap = null;
  const late = open(w, { waitMs: 30_000 }).then((granted) => {
    grantedAfterSwap = installed(w) && manifestOf(w).complete === true;
    return granted;
  });
  await sleep(400);
  assert.equal(grantedAfterSwap, null, 'still waiting while the installer is mid-swap');
  writeFileSync(join(w.gate, 'go'), '');
  const r = await exited;
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const granted = await late;
  assert.equal(granted.ok, true);
  assert.equal(grantedAfterSwap, true, 'the install was complete when the lease was granted');
});

test('the updater killed mid-install: the installer child keeps admission to the end and no lease opens meanwhile', { skip: !POSIX }, async (t) => {
  const w = world();
  // the "updater": a parent process that starts the installer and then does nothing
  const parent = join(w.root, 'parent.mjs');
  const pidFile = join(w.root, 'child.pid');
  writeFileSync(parent, [
    "import { spawn } from 'node:child_process';",
    "import { writeFileSync } from 'node:fs';",
    `const c = spawn(process.execPath, ${JSON.stringify(argsFor(w, ['--require-no-live-reviews']))}, { stdio: 'ignore', env: process.env });`,
    `writeFileSync(${JSON.stringify(pidFile)}, String(c.pid));`,
    'setInterval(() => {}, 1000);',
  ].join('\n'));
  const updater = spawn(process.execPath, [parent], { env: childEnv(w, { PIPELINE_INSTALL_SWAP_GATE: w.gate }), stdio: 'ignore' });
  t.after(() => { try { updater.kill('SIGKILL'); } catch { /* gone */ } });
  await until(() => existsSync(join(w.gate, 'reached')) && existsSync(pidFile), 'the swap gate');
  const childPid = Number(readFileSync(pidFile, 'utf8'));
  t.after(() => { try { process.kill(childPid, 'SIGKILL'); } catch { /* gone */ } });
  updater.kill('SIGKILL');
  await new Promise((resolve) => updater.on('close', resolve));
  await sleep(300);
  assert.doesNotThrow(() => process.kill(childPid, 0), 'the installer outlives its parent');
  assert.equal(await admissionFree(w), false, 'admission is still held after the parent died');
  await assert.rejects(open(w), (err) => err.code === 'update-in-progress', 'no lease can be opened');
  assert.equal(installed(w), false, 'still before the swap');
  writeFileSync(join(w.gate, 'go'), '');
  await until(() => { try { process.kill(childPid, 0); return false; } catch { return true; } }, 'the installer to finish');
  assert.equal(installed(w) && manifestOf(w).complete, true, 'the install finished');
  assert.equal(await admissionFree(w), true, 'released only when the installer finished');
});

// ---- refusals ----------------------------------------------------------------------------------------------------------------------------

test('a claude-home that is not <accountHome>/.claude is refused (exit 2) and nothing is written', () => {
  const w = world();
  const elsewhere = join(w.root, 'other', '.claude');
  const r = spawnSync(process.execPath, [INSTALL, '--claude-home', elsewhere, '--source', w.src, '--json', '--require-no-live-reviews'], { encoding: 'utf8', env: childEnv(w) });
  assert.equal(r.status, 2, r.stderr + r.stdout);
  assert.match(r.stderr, /only installs into the account's own claude-home/);
  assert.equal(existsSync(elsewhere), false);
  assert.equal(existsSync(w.leases), false, 'no admission folder was even created');
});

test('the account home is compared by real path: a symlinked alias of it is accepted', { skip: !POSIX }, () => {
  const w = world();
  mkdirSync(w.home, { recursive: true });
  const alias = join(w.root, 'alias');
  symlinkSync(w.home, alias);
  const r = spawnSync(process.execPath, [INSTALL, '--claude-home', alias, '--source', w.src, '--json', '--require-no-live-reviews'], { encoding: 'utf8', env: childEnv(w) });
  assert.equal(r.status, 0, r.stderr + r.stdout);
});

test('the test seams are ignored without PIPELINE_TEST_MODE: the home check then uses the real account home and refuses', () => {
  const w = world();
  const r = run(w, ['--require-no-live-reviews'], { PIPELINE_TEST_MODE: '' });
  assert.equal(r.status, 2, r.stderr + r.stdout);
  assert.equal(installed(w), false);
});

// R1-F2: the unattended installer runs from the download (no INSTALLED.json), so seamValue treats it as a checkout; the lease folder must still not be redirectable
// by a stray environment variable (launchctl setenv, a crontab line) unless this is a test run.
test('the lease-folder seam is honoured only with PIPELINE_TEST_MODE=1: otherwise it is removed from the installer environment, and from process.env', () => {
  const saved = process.env.PIPELINE_REVIEW_LEASE_DIR;
  try {
    process.env.PIPELINE_REVIEW_LEASE_DIR = '/elsewhere';
    const env = { PIPELINE_REVIEW_LEASE_DIR: '/elsewhere', PATH: '/p' };
    dropSeamsWithoutTestMode(env, ['PIPELINE_REVIEW_LEASE_DIR'], false);
    assert.deepEqual(env, { PATH: '/p' });
    assert.equal(process.env.PIPELINE_REVIEW_LEASE_DIR, undefined, 'seamValue falls back to process.env');
    const testRun = { PIPELINE_REVIEW_LEASE_DIR: '/scratch' };
    process.env.PIPELINE_REVIEW_LEASE_DIR = '/scratch';
    dropSeamsWithoutTestMode(testRun, ['PIPELINE_REVIEW_LEASE_DIR'], true);
    assert.deepEqual(testRun, { PIPELINE_REVIEW_LEASE_DIR: '/scratch' });
    assert.equal(process.env.PIPELINE_REVIEW_LEASE_DIR, '/scratch');
  } finally {
    if (saved === undefined) delete process.env.PIPELINE_REVIEW_LEASE_DIR; else process.env.PIPELINE_REVIEW_LEASE_DIR = saved;
  }
});

test('usage: --deadline-ms needs --require-no-live-reviews and a positive number; neither new flag combines with --check or --uninstall', () => {
  const w = world();
  for (const args of [['--deadline-ms', '500'], ['--require-no-live-reviews', '--deadline-ms', '0'], ['--require-no-live-reviews', '--check'], ['--require-no-live-reviews', '--uninstall'], ['--expect-installed', SHA_A, '--check'], ['--expect-installed', 'abc']]) {
    const r = run(w, args);
    assert.equal(r.status, 2, `${args.join(' ')}: ${r.stderr}`);
  }
  assert.equal(installed(w), false);
});

// ---- the deadline -----------------------------------------------------------------------------------------------------------------------

test('a scan that overruns --deadline-ms aborts before swapping: exit 3 reason deadline, nothing installed, admission released', async () => {
  const w = world();
  const r = run(w, ['--require-no-live-reviews', '--deadline-ms', '150'], { PIPELINE_INSTALL_SCAN_DELAY_MS: '600' });
  assert.equal(r.status, 3, r.stderr + r.stdout);
  assert.equal(r.json.deferred, true);
  assert.equal(r.json.reason, 'deadline');
  assert.deepEqual(r.json.live, []);
  assert.equal(installed(w), false);
  assert.equal(await admissionFree(w), true);
});

test('admission held by another updater past the wait: deferred (admission-busy), nothing written', async (t) => {
  const w = world();
  const held = await acquireAdmission({ dir: w.leases, home: w.account, waitMs: 0 });
  t.after(() => releaseAdmission(held));
  const r = run(w, ['--require-no-live-reviews', '--deadline-ms', '500']);
  assert.equal(r.status, 3, r.stderr + r.stdout);
  assert.equal(r.json.reason, 'admission-busy');
  assert.equal(installed(w), false);
});

// ---- --expect-installed (ported from #67, checked under the install lock) --------------------------------------------------------------

// An install of the fixture whose manifest says it came from commit `sha` (the fixture is not a git checkout, so the installer records none).
function installedAs(w, sha) {
  const first = run(w);
  assert.equal(first.status, 0, first.stderr + first.stdout);
  const m = manifestOf(w);
  writeFileSync(join(w.home, 'pipeline', 'INSTALLED.json'), `${JSON.stringify({ ...m, sourceSha: sha }, null, 2)}\n`);
}
const bump = (w) => writeFileSync(join(w.src, 'VERSION'), '10.0.0\n');
const installedVersion = (w) => readFileSync(join(w.home, 'pipeline', 'VERSION'), 'utf8').trim();

test('--expect-installed: a different installed commit means no install (exit 1, expect-installed-mismatch, installed + expected named)', () => {
  const w = world();
  installedAs(w, SHA_A);
  bump(w);
  const r = run(w, ['--expect-installed', SHA_B]);
  assert.equal(r.status, 1, r.stderr + r.stdout);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.error, 'expect-installed-mismatch');
  assert.equal(r.json.installed, SHA_A);
  assert.equal(r.json.expected, SHA_B);
  assert.equal(installedVersion(w), '9.9.9', 'nothing was written');
});

test('--expect-installed: an edited, incomplete or missing install does not match even with the right sha', () => {
  const w = world();
  installedAs(w, SHA_A);
  bump(w);
  const edited = join(w.home, 'skills', 'review', 'SKILL.md');
  const text = readFileSync(edited, 'utf8');
  writeFileSync(edited, `${text}\nmy edit\n`);
  let r = run(w, ['--expect-installed', SHA_A]);
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.json.error, 'expect-installed-mismatch');
  assert.equal(installedVersion(w), '9.9.9');
  writeFileSync(edited, text);
  writeFileSync(join(w.home, 'pipeline', 'INSTALLED.json'), `${JSON.stringify({ ...manifestOf(w), complete: false }, null, 2)}\n`);
  r = run(w, ['--expect-installed', SHA_A]);
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.json.error, 'expect-installed-mismatch');
  rmSync(join(w.home, 'pipeline'), { recursive: true, force: true });
  r = run(w, ['--expect-installed', SHA_A]);
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.json.installed, null, 'nothing installed any more');
  assert.equal(existsSync(join(w.home, 'pipeline')), false);
});

test('--expect-installed: a clean install of exactly that commit proceeds', () => {
  const w = world();
  installedAs(w, SHA_A);
  bump(w);
  const r = run(w, ['--expect-installed', SHA_A]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(installedVersion(w), '10.0.0');
});

test('--expect-installed with --require-no-live-reviews: a mismatch is answered before any scan and admission is never held', async () => {
  const w = world();
  installedAs(w, SHA_A);
  await open(w);
  bump(w);
  const r = run(w, ['--require-no-live-reviews', '--expect-installed', SHA_B]);
  assert.equal(r.status, 1, r.stderr + r.stdout);
  assert.equal(r.json.error, 'expect-installed-mismatch', 'not a deferral, although a lease is live');
  assert.equal(await admissionFree(w), true);
});

// Ported from #67 (install.test.mjs): the plain-text answer, the lock ordering and the unchanged behaviour of an install without the flag.
test('--expect-installed: nothing installed any more is a mismatch in plain text too (stderr names it, nothing is written)', () => {
  const w = world();
  const r = spawnSync(process.execPath, [INSTALL, '--claude-home', w.home, '--source', w.src, '--expect-installed', SHA_A], { encoding: 'utf8', env: childEnv(w), timeout: 60_000 });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /expect-installed-mismatch/);
  assert.equal(existsSync(join(w.home, 'pipeline')), false);
});

test('--expect-installed is checked under the install lock: a busy lock is reported as busy (exit 1), never as a changed install', () => {
  const w = world();
  installedAs(w, SHA_A);
  bump(w);
  const got = tryAcquire(installLockName(w.home), lockOpts(w));
  assert.ok(got.acquired);
  try {
    const r = run(w, ['--expect-installed', SHA_A]);
    assert.equal(r.status, 1, r.stderr + r.stdout);
    assert.match(r.stderr, /another install is running in /);
    assert.doesNotMatch(r.stdout + r.stderr, /expect-installed-mismatch/);
    assert.equal(installedVersion(w), '9.9.9', 'nothing was written');
  } finally {
    release(got.lock);
  }
});

test('without --expect-installed the installer still replaces an edited install, exactly as before the flag existed', () => {
  const w = world();
  installedAs(w, SHA_A);
  bump(w);
  const edited = join(w.home, 'skills', 'review', 'SKILL.md');
  writeFileSync(edited, `${readFileSync(edited, 'utf8')}\nmy edit\n`);
  const r = run(w);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(installedVersion(w), '10.0.0');
  assert.doesNotMatch(readFileSync(edited, 'utf8'), /my edit/);
});

// ---- hooks during the swap (Fable P2-6) ---------------------------------------------------------------------------------------------------

// The handler exactly as settings.json carries it, run the way Claude Code runs it: command + args.
const runHandler = (handler, env = {}) => spawnSync(handler.command === 'node' ? process.execPath : handler.command, handler.args, { encoding: 'utf8', input: '{}', env: { ...process.env, ...env }, timeout: 20_000 });

test('a guard hook started while the swap has its file moved away DENIES (exit 2, fail closed); with the file in place it runs as itself', () => {
  const home = scratch('cp-adm-hooks');
  const settings = mergeSettings({}, { home });
  const guard = settings.hooks.PreToolUse.find((g) => g.matcher === GUARD_FILES_MATCHER).hooks[0];
  assert.equal(guard.args[0], '--input-type=module');
  assert.equal(guard.args[2], HOOK_LOADER, 'the registered guard goes through the fail-closed loader');
  const file = guard.args[3];
  assert.equal(file, join(home, 'pipeline', 'hooks', 'guard-files.mjs'));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, 'process.exit(0);\n');
  assert.equal(runHandler(guard).status, 0, 'with the file in place the hook runs as itself');
  rmSync(file); // what swapIn's window looks like to a hook: the old unit renamed away, the new one not in place yet
  const during = runHandler(guard);
  assert.equal(during.status, 2, during.stderr);
  assert.match(during.stderr, /hook could not be loaded/);
  // the other guard, too
  const gitGuard = ourHookGroups(home)[0].hooks[0];
  assert.equal(runHandler(gitGuard).status, 2);
});

test('the update notice is NOT behind the fail-closed loader: its registration is a plain node call, and a missing file never blocks (exit is not 2)', () => {
  const home = scratch('cp-adm-notice');
  const settings = mergeSettings({}, { home });
  const handler = settings.hooks.SessionStart.flatMap((g) => g.hooks).find((h) => String(h.args).includes('update-notice.mjs'));
  assert.ok(handler, 'registered on SessionStart');
  assert.deepEqual(handler.args, [join(home, 'pipeline', 'hooks', 'update-notice.mjs')], 'no -e, no loader');
  assert.ok(!JSON.stringify(handler).includes('could not be loaded'));
  const during = runHandler(handler); // the file does not exist
  assert.notEqual(during.status, 2, 'a missing notice must never deny a session start');
});
