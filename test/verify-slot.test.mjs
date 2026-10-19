// `pipeline verify slot`: at most verify.max_parallel_full full verifies at once on one machine. The queueing logic runs in-process
// with an injected clock, sleep, liveness check and fake child processes (step-based: "settle" lets the waiters poll a few times,
// so "has not started" is a fact about their state, not a guess about timing). The CLI contract (exit code, signals, two repos
// sharing one machine) spawns the real CLI against throwaway repos and a throwaway lock directory (PIPELINE_LOCK_DIR);
// the real ~/.claude lock directory is never touched.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tryAcquire } from '../pipeline/lib/locks.mjs';
import { defaultJitterMs, runWithSlot, slotRunLine, slotStatus } from '../pipeline/commands/verify.mjs';
import { createTmpRepo } from './helpers/tmprepo.mjs';

process.env.PIPELINE_MACHINE_ID ||= 'test-machine-id';
const BIN = fileURLToPath(new URL('../pipeline/bin/pipeline.mjs', import.meta.url));
const CHILD = fileURLToPath(new URL('./fixtures/slot-child.mjs', import.meta.url));
const STUBBORN = fileURLToPath(new URL('./fixtures/slot-stubborn.mjs', import.meta.url));
const ECHO = fileURLToPath(new URL('./fixtures/slot-echo.mjs', import.meta.url));
const HOST = os.hostname();
const MACHINE = process.env.PIPELINE_MACHINE_ID;

const roots = [];
const tmp = () => {
  const d = mkdtempSync(path.join(os.tmpdir(), 'cp-slot-'));
  roots.push(d);
  return d;
};
const worlds = [];
// A waiter that can never start (a failing test) must not keep polling after the file is done.
after(() => {
  for (const clock of worlds) clock.stopped = true;
  roots.forEach((d) => rmSync(d, { recursive: true, force: true }));
});

// ---- in-process harness ---------------------------------------------------------------------------------------------------
function world() {
  const lockDir = tmp();
  const alive = new Set();
  const clock = { t: 1_000_000, sleeps: [], stopped: false };
  worlds.push(clock);
  const sleep = (ms) => {
    if (clock.stopped) return Promise.reject(new Error('world stopped'));
    clock.t += ms;
    clock.sleeps.push(ms);
    return new Promise((r) => setImmediate(r));
  };
  const settle = async (ticks = 25) => { for (let i = 0; i < ticks; i++) await new Promise((r) => setImmediate(r)); };
  let nextPid = 5000;

  // Starts one wrapper. `pid` is a made-up live process; its child is a fake that the test closes by hand.
  function launch(opts = {}) {
    const pid = opts.pid ?? nextPid++;
    alive.add(pid);
    const proc = new EventEmitter();
    const lines = [];
    let child = null;
    let onSpawn;
    const spawned = new Promise((r) => { onSpawn = r; });
    const spawnFn = () => {
      child = new EventEmitter();
      child.kill = (sig) => { child.killedWith = sig; setImmediate(() => child.emit('close', null, sig)); };
      onSpawn(child);
      return child;
    };
    const promise = runWithSlot({
      command: 'full-verify', cwd: lockDir, n: 1, lockDir, pollMs: 1000, sleep, now: () => clock.t,
      isAlive: (p) => alive.has(p), pid, host: HOST, machine: MACHINE, spawnFn, proc, stderr: { write: (s) => lines.push(s) },
      loadavg: () => [0, 0, 0], platform: 'linux', ...opts,
    });
    const w = {
      pid, promise, spawned, proc, lines,
      get child() { return child; },
      get started() { return child !== null; },
      slot: () => JSON.parse(lines[0]).slot,
      finish: async (code = 0) => { child.emit('close', code, null); return promise; },
    };
    return w;
  }
  return { lockDir, alive, clock, settle, launch, status: () => slotStatus({ lockDir, isAlive: (p) => alive.has(p), host: HOST, machine: MACHINE }) };
}
const TIMEOUT = { timeout: 15_000 };

test('n slots reached: the next full verify waits, then runs when a holder exits and takes that slot', TIMEOUT, async () => {
  const w = world();
  const a = w.launch({ n: 2 });
  const b = w.launch({ n: 2 });
  await a.spawned;
  await b.spawned;
  assert.deepEqual([a.slot().index, b.slot().index].sort(), [0, 1]);
  assert.equal(a.slot().of, 2);
  assert.equal(a.slot().waitedSeconds, 0);

  const c = w.launch({ n: 2 });
  await w.settle();
  assert.equal(c.started, false, 'both slots are taken');
  const st = w.status();
  assert.equal(st.holders.length, 2);
  assert.deepEqual(st.waiters.map((x) => x.pid), [c.pid]);

  const freed = a.slot().index;
  assert.equal(await a.finish(3), 3);
  await c.spawned;
  assert.equal(c.slot().index, freed, 'c took the slot a released');
  assert.ok(c.slot().waitedSeconds >= 1, 'the wait is reported');
  assert.deepEqual(w.status().waiters, [], 'the ticket is dropped once a slot is held');
  await b.finish();
  await c.finish();
  assert.deepEqual(w.status().holders, [], 'every slot released');
});

test('arrival order: with one slot, the older of two waiters goes first', TIMEOUT, async () => {
  const w = world();
  const a = w.launch();
  await a.spawned;
  const b = w.launch();
  await w.settle(); // b has its ticket and is polling
  const c = w.launch();
  await w.settle();
  assert.deepEqual(w.status().waiters.map((x) => x.pid), [b.pid, c.pid]);

  await a.finish();
  await b.spawned;
  await w.settle();
  assert.equal(c.started, false, 'c waits for b even though a freed the slot while c was polling too');
  await b.finish();
  await c.spawned;
  await c.finish();
});

test('a live older ticket blocks a newer waiter even while a slot is free', TIMEOUT, async () => {
  const w = world();
  const queue = path.join(w.lockDir, 'verify-full-queue');
  const ticket = path.join(queue, '0000000001-7001-aaaaaaaa.ticket');
  w.alive.add(7001);
  mkdirSync(queue, { recursive: true });
  writeFileSync(ticket, JSON.stringify({ pid: 7001, host: HOST }));
  const b = w.launch();
  await w.settle();
  assert.equal(b.started, false, 'a live waiter is ahead');
  rmSync(ticket); // it took its slot elsewhere / gave up
  await b.spawned;
  assert.equal(b.slot().index, 0);
  await b.finish();
});

test('a ticket whose owner is dead is skipped and removed', TIMEOUT, async () => {
  const w = world();
  const a = w.launch();
  await a.spawned;
  const queue = path.join(w.lockDir, 'verify-full-queue');
  const dead = path.join(queue, '0000000002-7002-bbbbbbbb.ticket');
  writeFileSync(dead, JSON.stringify({ pid: 7002, host: HOST })); // 7002 is not in `alive`
  const b = w.launch();
  await w.settle();
  assert.equal(b.started, false, 'the only slot is still held by a');
  await a.finish();
  await b.spawned;
  assert.equal(existsSync(dead), false, 'the dead waiter was removed on the way');
  await b.finish();
});

test('a slot whose holder died is reclaimed (locks.mjs rules)', TIMEOUT, async () => {
  const w = world();
  const ghost = tryAcquire('verify-full-slot-0', { dir: w.lockDir, pid: 7003, host: HOST, machineId: MACHINE, isAlive: () => true });
  assert.equal(ghost.acquired, true);
  const b = w.launch(); // 7003 is not alive for this world
  await b.spawned;
  assert.equal(b.slot().index, 0);
  assert.equal(b.slot().waitedSeconds, 0);
  await b.finish();
});

test('a slot whose holder is alive is never reclaimed', TIMEOUT, async () => {
  const w = world();
  w.alive.add(7004);
  tryAcquire('verify-full-slot-0', { dir: w.lockDir, pid: 7004, host: HOST, machineId: MACHINE, isAlive: () => true });
  const b = w.launch();
  await w.settle();
  assert.equal(b.started, false);
  w.alive.delete(7004); // it dies
  await b.spawned;
  await b.finish();
});

test('a signal while waiting leaves the queue and exits 128+signal without running anything', TIMEOUT, async () => {
  const w = world();
  const a = w.launch();
  await a.spawned;
  const b = w.launch();
  await w.settle();
  assert.equal(w.status().waiters.length, 1);
  b.proc.emit('SIGTERM');
  assert.equal(await b.promise, 128 + os.constants.signals.SIGTERM);
  assert.equal(b.started, false);
  assert.deepEqual(w.status().waiters, [], 'ticket dropped');
  assert.equal(w.status().holders.length, 1, 'a still holds its slot');
  await a.finish();
});

test('a signal while the command runs is forwarded; the slot is freed when it ends; exit code passes through', TIMEOUT, async () => {
  const w = world();
  const a = w.launch();
  await a.spawned;
  a.proc.emit('SIGINT');
  assert.equal(a.child.killedWith, 'SIGINT');
  assert.equal(await a.promise, 128 + os.constants.signals.SIGINT, 'a signal exit is reported like a shell does');
  assert.deepEqual(w.status().holders, []);
  assert.equal(a.proc.listenerCount('SIGINT'), 0, 'handlers removed');
});

test('no limit (n unset): runs at once, no slot, no load check, waitedSeconds 0', TIMEOUT, async () => {
  const w = world();
  const a = w.launch({ n: undefined, maxLoad: 1, loadavg: () => [99, 0, 0] });
  await a.spawned;
  assert.deepEqual(a.slot(), { index: null, of: null, waitedSeconds: 0, loadWaitSeconds: 0, warnings: [] });
  assert.deepEqual(w.status(), { ok: true, lockDir: w.lockDir, holders: [], waiters: [] });
  assert.deepEqual(w.clock.sleeps, []);
  assert.equal(await a.finish(5), 5);
});

test('two repos (two working dirs) share the machine limit', TIMEOUT, async () => {
  const w = world();
  const a = w.launch({ cwd: '/repo/one' });
  await a.spawned;
  const b = w.launch({ cwd: '/repo/two' });
  await w.settle();
  assert.equal(b.started, false);
  await a.finish();
  await b.spawned;
  await b.finish();
});

// ---- load check -----------------------------------------------------------------------------------------------------------
test('load check: below the limit -> starts at once, no jitter wait', TIMEOUT, async () => {
  const w = world();
  const a = w.launch({ maxLoad: 8, loadavg: () => [3, 0, 0], jitterMs: () => assert.fail('no jitter wait expected') });
  await a.spawned;
  assert.equal(a.slot().loadWaitSeconds, 0);
  assert.deepEqual(a.slot().warnings, []);
  await a.finish();
});

test('load check: above, then below -> waits with jitter and re-checks before starting', TIMEOUT, async () => {
  const w = world();
  const seen = [9, 9, 2];
  const a = w.launch({ maxLoad: 8, loadavg: () => [seen.length > 1 ? seen.shift() : seen[0], 0, 0], jitterMs: () => 7000 });
  await a.spawned;
  assert.deepEqual(w.clock.sleeps, [7000, 7000], 'two jitter waits, none of the queue polls (the slot was free)');
  assert.equal(a.slot().loadWaitSeconds, 14);
  assert.equal(a.slot().waitedSeconds, 0);
  assert.deepEqual(a.slot().warnings, []);
  await a.finish();
});

test('load check: still above at the deadline -> proceeds with a warning', TIMEOUT, async () => {
  const w = world();
  const a = w.launch({ maxLoad: 8, maxLoadWaitMinutes: 1, loadavg: () => [20, 0, 0], jitterMs: () => 20_000 });
  await a.spawned;
  assert.equal(a.slot().loadWaitSeconds, 60);
  assert.equal(a.slot().warnings.length, 1);
  assert.match(a.slot().warnings[0], /load 20\.0 still above verify\.max_load 8 after 1 min: running anyway/);
  assert.equal(w.status().holders.length, 1, 'the slot is held while it waits for the load');
  await a.finish();
});

test('load check: the slot is taken BEFORE the load wait (waiters queue on slots, not on load)', TIMEOUT, async () => {
  const w = world();
  const a = w.launch({ maxLoad: 8, loadavg: () => [20, 0, 0], jitterMs: () => 30_000, maxLoadWaitMinutes: 10 });
  const b = w.launch({ maxLoad: 8, loadavg: () => [20, 0, 0], jitterMs: () => 30_000, maxLoadWaitMinutes: 10 });
  await a.spawned;
  assert.equal(a.slot().waitedSeconds, 0);
  assert.equal(b.started, false);
  await a.finish();
  await b.spawned;
  await b.finish();
});

test('load check on Windows is a no-op with a note', TIMEOUT, async () => {
  const w = world();
  const a = w.launch({ maxLoad: 1, platform: 'win32', loadavg: () => [0, 0, 0], jitterMs: () => assert.fail('no wait on Windows') });
  await a.spawned;
  assert.equal(a.slot().loadWaitSeconds, 0);
  assert.equal(a.slot().warnings.length, 1);
  assert.match(a.slot().warnings[0], /Windows/);
  assert.equal(a.slot().index, 0, 'slots still work');
  await a.finish();
});

test('default jitter is 5-30 seconds', () => {
  for (const r of [0, 0.5, 0.999999]) {
    const orig = Math.random;
    Math.random = () => r;
    try {
      const v = defaultJitterMs();
      assert.ok(v >= 5000 && v <= 30_000, String(v));
    } finally {
      Math.random = orig;
    }
  }
});

// ---- the real CLI ---------------------------------------------------------------------------------------------------------
// `slot --run` runs only verify.full from the repo's pipeline.yml; each repo here points verify.full at a fixture script.
const q = (p) => JSON.stringify(p);
function repoWith(slots, { script = CHILD, args = [], extra = '' } = {}) {
  const repo = createTmpRepo();
  const full = [process.execPath, script, ...args].map(q).join(' ');
  repo.write('.claude/pipeline.yml', `version: 1\nproject: demo\nverify:\n  full: ${JSON.stringify(full)}\n  quick: node scripts/verify.mjs --quick\n${slots === undefined ? '' : `  max_parallel_full: ${slots}\n`}${extra}`);
  repo.commit('config');
  return repo;
}
const cliEnv = (lockDir) => ({ ...process.env, PIPELINE_LOCK_DIR: lockDir, PIPELINE_SLOT_POLL_MS: '20', PIPELINE_MACHINE_ID: MACHINE });
const childArgs = (dir, name, exit = 0) => [path.join(dir, `${name}.started`), path.join(dir, 'release'), String(exit)];

function startCli(cwd, lockDir, args = []) {
  const p = spawn(process.execPath, [BIN, 'verify', 'slot', '--run', ...args], { cwd, env: cliEnv(lockDir), stdio: ['ignore', 'pipe', 'pipe'] });
  const out = { stdout: '', stderr: '' };
  p.stdout.on('data', (d) => { out.stdout += d; });
  p.stderr.on('data', (d) => { out.stderr += d; });
  const done = new Promise((resolve) => p.on('close', (code, signal) => resolve({ code, signal, ...out })));
  return { p, out, done };
}
async function until(cond, what, ms = 10_000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
const statusOf = (lockDir) => JSON.parse(spawnSync(process.execPath, [BIN, 'verify', 'slot', '--status'], { env: cliEnv(lockDir), encoding: 'utf8' }).stdout);

test('CLI: runs verify.full from the config; its exit code is the wrapper\'s, stdout stays its own, one stderr line reports the slot', TIMEOUT, async () => {
  const work = tmp();
  writeFileSync(path.join(work, 'release'), '');
  const repo = repoWith(2, { args: childArgs(work, 'a', 7) });
  const lockDir = tmp();
  try {
    const r = await startCli(repo.dir, lockDir).done;
    assert.equal(r.code, 7);
    assert.ok(existsSync(path.join(work, 'a.started')), 'the configured verify.full ran');
    assert.equal(r.stdout, '', 'no JSON result on stdout');
    const line = JSON.parse(r.stderr.trim().split('\n')[0]);
    assert.deepEqual(Object.keys(line), ['slot']);
    assert.equal(line.slot.index, 0);
    assert.equal(line.slot.of, 2);
    assert.equal(line.slot.waitedSeconds, 0);
    assert.deepEqual(line.slot.warnings, []);
    assert.deepEqual(statusOf(lockDir).holders, []);
  } finally {
    repo.cleanup();
  }
});

test('CLI: --only STEPS is appended to verify.full', TIMEOUT, async () => {
  const work = tmp();
  const out = path.join(work, 'argv.json');
  const repo = repoWith(1, { script: ECHO, args: [out], extra: '  expected_steps: [db, unit, db-grants]\n' });
  const lockDir = tmp();
  try {
    const r = await startCli(repo.dir, lockDir, ['--only', 'db,db-grants']).done;
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')), [out, '--only', 'db,db-grants']);
  } finally {
    repo.cleanup();
  }
});

test('slotRunLine: appends --only, with the npm -- forwarding plan-after-fix uses', () => {
  assert.equal(slotRunLine({ full: 'node scripts/verify.mjs' }, {}), 'node scripts/verify.mjs');
  assert.equal(slotRunLine({ full: 'node scripts/verify.mjs' }, { only: 'db,unit' }), 'node scripts/verify.mjs --only db,unit');
  assert.equal(slotRunLine({ full: 'npm run verify' }, { only: 'db' }), 'npm run verify -- --only db');
  assert.equal(slotRunLine({ full: 'npm run verify -- --x' }, { only: 'db' }), 'npm run verify -- --x --only db');
});

test('slotRunLine: --defer appends only steps in verify.deferrable_steps, never with --only', () => {
  const verify = { full: 'node scripts/verify.mjs', deferrable_steps: ['sql-arms'] };
  assert.equal(slotRunLine(verify, { defer: 'sql-arms' }), 'node scripts/verify.mjs --defer sql-arms');
  assert.equal(slotRunLine({ ...verify, full: 'npm run verify' }, { defer: 'sql-arms' }), 'npm run verify -- --defer sql-arms');
  assert.throws(() => slotRunLine(verify, { defer: 'db' }), /not in verify.deferrable_steps: db/);
  assert.throws(() => slotRunLine({ full: 'node scripts/verify.mjs' }, { defer: 'sql-arms' }), /not in verify.deferrable_steps/);
  assert.throws(() => slotRunLine(verify, { defer: 'sql-arms;x' }), /step names may only use/);
  assert.throws(() => slotRunLine(verify, { defer: 'sql-arms,sql-arms' }), /listed twice/);
  assert.throws(() => slotRunLine(verify, { defer: 'sql-arms', only: 'db' }), /not with --only/);
});

test('CLI: anything but verify.full is refused with exit 2 and nothing is spawned', TIMEOUT, async () => {
  const work = tmp();
  const marker = path.join(work, 'argv.json');
  const repo = repoWith(1, { script: ECHO, args: [marker], extra: '  expected_steps: [db, unit]\n' });
  const lockDir = tmp();
  const bad = [
    ['--', 'echo', 'any', 'other', 'command'],
    ['--only', 'db', '--', 'echo', 'x'],
    ['echo', 'positional'],
    ['--only', 'db;touch x'],
    ['--only', 'db,$(id)'],
    ['--only', 'db,,unit'],
    ['--only', ''],
    ['--only', 'db,db'],
    ['--only', 'nope'],
    ['--cmd', 'echo hi'],
    ['--only'],
  ];
  try {
    for (const args of bad) {
      const r = await startCli(repo.dir, lockDir, args).done;
      assert.equal(r.code, 2, `${JSON.stringify(args)}: ${r.stderr}`);
      assert.equal(existsSync(marker), false, `${JSON.stringify(args)} must not run anything`);
    }
    assert.equal(existsSync(path.join(lockDir, 'verify-full-queue')), false, 'refused before any queueing');
  } finally {
    repo.cleanup();
  }
});

test('CLI: no verify.max_parallel_full -> verify.full just runs (no slot)', TIMEOUT, async () => {
  const work = tmp();
  writeFileSync(path.join(work, 'release'), '');
  const repo = repoWith(undefined, { args: childArgs(work, 'a', 0) });
  const lockDir = tmp();
  try {
    const r = await startCli(repo.dir, lockDir).done;
    assert.equal(r.code, 0);
    const line = JSON.parse(r.stderr.trim().split('\n')[0]);
    assert.deepEqual(line.slot, { index: null, of: null, waitedSeconds: 0, loadWaitSeconds: 0, warnings: [] });
    assert.equal(existsSync(path.join(lockDir, 'verify-full-queue')), false, 'no queue directory was even created');
  } finally {
    repo.cleanup();
  }
});

test('CLI: two different repos share the one machine slot; the second runs after the first ends', TIMEOUT, async () => {
  const work = tmp();
  const one = repoWith(1, { args: childArgs(work, 'a') });
  const two = repoWith(1, { args: childArgs(work, 'b') });
  const lockDir = tmp();
  try {
    const a = startCli(one.dir, lockDir);
    await until(() => existsSync(path.join(work, 'a.started')), 'first verify to start');
    const b = startCli(two.dir, lockDir);
    await until(() => statusOf(lockDir).waiters.length === 1, 'second repo to queue');
    assert.equal(existsSync(path.join(work, 'b.started')), false);
    assert.equal(statusOf(lockDir).holders.length, 1);
    writeFileSync(path.join(work, 'release'), '');
    const [ra, rb] = await Promise.all([a.done, b.done]);
    assert.equal(ra.code, 0);
    assert.equal(rb.code, 0);
    assert.ok(existsSync(path.join(work, 'b.started')));
    assert.deepEqual(statusOf(lockDir).holders, []);
  } finally {
    one.cleanup();
    two.cleanup();
  }
});

// Signals and process groups are POSIX; Windows takes the taskkill path, which these assertions do not describe.
const POSIX_ONLY = { ...TIMEOUT, skip: process.platform === 'win32' };

test('CLI: SIGTERM to the wrapper reaches the verify and frees the slot', POSIX_ONLY, async () => {
  const work = tmp();
  const repo = repoWith(1, { args: childArgs(work, 'a') });
  const lockDir = tmp();
  try {
    const a = startCli(repo.dir, lockDir);
    await until(() => existsSync(path.join(work, 'a.started')), 'verify to start');
    assert.equal(statusOf(lockDir).holders.length, 1);
    a.p.kill('SIGTERM');
    const r = await a.done;
    assert.equal(r.code, 42, 'the fixture exits 42 on SIGTERM: the signal was forwarded');
    assert.deepEqual(statusOf(lockDir).holders, []);
    assert.equal(readdirSync(lockDir).some((f) => f.endsWith('.lock')), false);
  } finally {
    writeFileSync(path.join(work, 'release'), ''); // never leave the fixture polling
    repo.cleanup();
  }
});

test('CLI: the slot stays held until the whole verify process tree has exited (compound command, SIGTERM ignored for a while)', POSIX_ONLY, async () => {
  const work = tmp();
  const marker = (n) => path.join(work, n);
  const repo = createTmpRepo();
  const full = `${[process.execPath, STUBBORN, marker('started'), marker('term'), marker('done')].map(q).join(' ')} && true`; // the shell stays the parent
  repo.write('.claude/pipeline.yml', `version: 1\nproject: demo\nverify:\n  full: ${JSON.stringify(full)}\n  quick: node scripts/verify.mjs --quick\n  max_parallel_full: 1\n`);
  repo.commit('config');
  const lockDir = tmp();
  try {
    const a = startCli(repo.dir, lockDir);
    await until(() => existsSync(marker('started')), 'verify to start');
    assert.equal(statusOf(lockDir).holders.length, 1);
    a.p.kill('SIGTERM');
    await until(() => existsSync(marker('term')), 'the signal to reach the verify');
    assert.equal(existsSync(marker('done')), false);
    assert.equal(statusOf(lockDir).holders.length, 1, 'the verify is still running, so the slot is still held');
    const r = await a.done;
    assert.equal(existsSync(marker('done')), true, 'the wrapper waited for the verify to finish');
    assert.equal(r.code, 128 + os.constants.signals.SIGTERM, "the shell's exit status is the wrapper's");
    assert.deepEqual(statusOf(lockDir).holders, []);
  } finally {
    repo.cleanup();
  }
});

test('CLI: usage errors (exit 2): neither/both mode, --status with other options', () => {
  const lockDir = tmp();
  const run = (args) => spawnSync(process.execPath, [BIN, 'verify', 'slot', ...args], { env: cliEnv(lockDir), encoding: 'utf8' });
  assert.equal(run([]).status, 2);
  assert.equal(run(['--run', '--status']).status, 2);
  assert.equal(run(['--status', '--only', 'db']).status, 2);
  assert.equal(run(['--status', '--', 'x']).status, 2);
  const ok = run(['--status']);
  assert.equal(ok.status, 0);
  assert.deepEqual(JSON.parse(ok.stdout), { ok: true, lockDir, holders: [], waiters: [] });
});

// verify.full comes from a pipeline.yml a PR can change, so `slot --run` judges the exact command line with the same guards as
// `job start` before queueing or spawning. The denied samples are built from parts so this file never holds one verbatim.
function guardedRepo(full) {
  const repo = createTmpRepo();
  repo.write('.claude/pipeline.yml', `version: 1\nproject: demo\nverify:\n  full: ${JSON.stringify(full)}\n  quick: node scripts/verify.mjs --quick\n  max_parallel_full: 1\n`);
  repo.commit('config');
  return repo;
}
const parts = (...p) => p.join(' ');
const DENIED = [
  ['git guard', parts('git', 'pu' + 'sh', 'origin', 'ma' + 'in')],
  ['file guard', parts('echo', 'x', '>', '~/.claude/' + 'settings.json')],
];

for (const [kind, full] of DENIED) {
  test(`CLI: a verify.full the ${kind} denies is refused like a job (exit 1, refused JSON), with nothing queued or run`, TIMEOUT, async () => {
    const repo = guardedRepo(full);
    const lockDir = tmp();
    const home = tmp(); // a stand-in HOME, so a guard that failed open could only write here
    const env = { ...cliEnv(lockDir), HOME: home, USERPROFILE: home };
    delete env.PIPELINE_ADMIN;
    try {
      const r = spawnSync(process.execPath, [BIN, 'verify', 'slot', '--run'], { cwd: repo.dir, env, encoding: 'utf8' });
      assert.equal(r.status, 1, r.stdout + r.stderr);
      const out = JSON.parse(r.stdout);
      assert.equal(out.ok, false);
      assert.equal(out.refused, true);
      assert.equal(typeof out.reason, 'string');
      assert.ok(out.reason.length > 0);
      assert.equal(r.stderr.includes('"slot"'), false, 'no slot line: nothing started');
      assert.equal(existsSync(path.join(lockDir, 'verify-full-queue')), false, 'no ticket was taken');
      assert.equal(readdirSync(lockDir).length, 0, 'no slot was taken');
      assert.equal(existsSync(path.join(home, '.claude', 'settings.json')), false, 'nothing ran');
      assert.equal(spawnSync('git', ['-C', repo.dir, 'status', '--porcelain'], { encoding: 'utf8' }).stdout, '', 'the repo is untouched');
    } finally {
      repo.cleanup();
    }
  });
}

test('CLI: an allowed verify.full still runs after the guard check', TIMEOUT, async () => {
  const work = tmp();
  writeFileSync(path.join(work, 'release'), '');
  const repo = repoWith(1, { args: childArgs(work, 'ok', 0) });
  try {
    const r = await startCli(repo.dir, tmp()).done;
    assert.equal(r.code, 0, r.stderr);
    assert.ok(existsSync(path.join(work, 'ok.started')));
  } finally {
    repo.cleanup();
  }
});
