import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs, { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, utimesSync, existsSync, chmodSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  tryAcquire,
  acquire,
  release,
  withLock,
  inspect,
  defaultLockDir,
  isPidAlive,
  LockTimeoutError,
  LockLostError,
  machineId,
  _tuning,
} from '../pipeline/lib/locks.mjs';

// Never create ~/.claude/pipeline-state/machine-id from a test run (scripts/test.mjs sets this too).
process.env.PIPELINE_MACHINE_ID ||= 'test-machine-id';
const FIXTURE = fileURLToPath(new URL('./fixtures/hold-lock.mjs', import.meta.url));
const RACE_FIXTURE = fileURLToPath(new URL('./fixtures/reclaim-race.mjs', import.meta.url));
const HOST = os.hostname();
const DAY = 24 * 60 * 60 * 1000;

const roots = [];
function tmpDir() {
  const d = mkdtempSync(path.join(os.tmpdir(), 'cp-locks-'));
  roots.push(d);
  return d;
}
after(() => {
  for (const d of roots) {
    try {
      chmodSync(d, 0o755);
    } catch {
      /* already gone */
    }
    rmSync(d, { recursive: true, force: true });
  }
});

// A PID that belonged to a process that has definitely exited.
function deadPid() {
  const r = spawnSync(process.execPath, ['-e', '']);
  assert.equal(r.status, 0);
  return r.pid;
}

const ownerRecord = (name, over = {}) => ({
  name,
  runId: 'planted-run',
  pid: process.pid,
  host: HOST,
  startedAt: new Date().toISOString(),
  ...over,
});

// Hand-build a lock directory as some other (possibly dead) process would have left it.
// `owner` may be an object, a raw string (for corrupt files) or undefined (no owner.json).
function plantLock(dir, name, owner, { ageMs = 0 } = {}) {
  const lockPath = path.join(dir, `${name}.lock`);
  mkdirSync(lockPath, { recursive: true });
  if (owner !== undefined) {
    writeFileSync(path.join(lockPath, 'owner.json'), typeof owner === 'string' ? owner : JSON.stringify(owner));
  }
  if (ageMs) {
    // after the writes: creating files bumps the directory mtime
    const t = new Date(Date.now() - ageMs);
    utimesSync(lockPath, t, t);
  }
  return lockPath;
}

const leftovers = (dir) => readdirSync(dir).filter((n) => n.includes('.stale-') || n.endsWith('.reclaim'));

// Child-process helper: collects stdout, lets a test wait for a given line.
function launch(args, script = FIXTURE) {
  const child = spawn(process.execPath, [script, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  let closed = false;
  const listeners = new Set();
  child.stdout.on('data', (d) => {
    out += d;
    listeners.forEach((l) => l());
  });
  child.stderr.on('data', (d) => {
    err += d;
  });
  const exit = new Promise((resolve) =>
    child.on('close', (code) => {
      closed = true;
      listeners.forEach((l) => l());
      resolve(code);
    }),
  );
  function waitFor(re, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const check = () => {
        const m = re.exec(out);
        if (m) {
          listeners.delete(check);
          clearTimeout(timer);
          resolve(m[1] ?? m[0]);
        } else if (closed) {
          listeners.delete(check);
          clearTimeout(timer);
          reject(new Error(`child exited without printing ${re}; stdout=${JSON.stringify(out)} stderr=${err}`));
        }
      };
      const timer = setTimeout(() => {
        listeners.delete(check);
        reject(new Error(`timed out waiting for ${re}; stdout=${JSON.stringify(out)} stderr=${err}`));
      }, timeoutMs);
      listeners.add(check);
      check();
    });
  }
  return { child, pid: child.pid, exit, waitFor, stderr: () => err };
}

// Start `children` processes that all call tryAcquire in the same instant; return how many got the lock.
async function raceOnce({ dir, name, children }) {
  const sync = tmpDir();
  const go = path.join(sync, 'go');
  const rel = path.join(sync, 'release');
  const procs = Array.from({ length: children }, () => launch([dir, name, '30000', '--go', go, '--release', rel]));
  try {
    await Promise.all(procs.map((p) => p.waitFor(/^ready$/m)));
    writeFileSync(go, '');
    const results = await Promise.all(procs.map((p) => p.waitFor(/^(held|busy)$/m)));
    writeFileSync(rel, '');
    await Promise.all(procs.map((p) => p.exit));
    return results.filter((r) => r === 'held').length;
  } finally {
    procs.forEach((p) => p.child.kill());
  }
}

test('defaultLockDir is under the home directory pipeline-state', () => {
  assert.equal(defaultLockDir(), path.join(os.homedir(), '.claude', 'pipeline-state', 'locks'));
});

test('1. acquire -> inspect shows owner -> release -> inspect is null', async () => {
  const dir = tmpDir();
  assert.equal(inspect('db', { dir }), null);
  const lock = await acquire('db', { dir, runId: 'run-1' });
  const owner = inspect('db', { dir });
  assert.equal(owner.name, 'db');
  assert.equal(owner.runId, 'run-1');
  assert.equal(owner.pid, process.pid);
  assert.equal(owner.host, HOST);
  assert.ok(!Number.isNaN(Date.parse(owner.startedAt)));
  assert.equal(release(lock), true);
  assert.equal(inspect('db', { dir }), null);
  assert.deepEqual(readdirSync(dir), [], 'release leaves nothing behind');
});

test('default runId is "<pid>-<uuid>" and distinct per acquisition', () => {
  const dir = tmpDir();
  const a = tryAcquire('a', { dir });
  const b = tryAcquire('b', { dir });
  assert.match(a.lock.runId, new RegExp(`^${process.pid}-[0-9a-f-]{36}$`));
  assert.notEqual(a.lock.runId, b.lock.runId);
});

test('2. second tryAcquire while held -> not acquired, with owner info', () => {
  const dir = tmpDir();
  const first = tryAcquire('db', { dir, runId: 'first' });
  assert.equal(first.acquired, true);
  const second = tryAcquire('db', { dir, runId: 'second' });
  assert.equal(second.acquired, false);
  assert.equal(second.owner.runId, 'first');
  assert.equal(second.owner.pid, process.pid);
  assert.equal(inspect('db', { dir }).runId, 'first', 'the holder is untouched');
});

test('locks with different names do not interfere', () => {
  const dir = tmpDir();
  assert.equal(tryAcquire('supabase-a', { dir }).acquired, true);
  assert.equal(tryAcquire('prod-a', { dir }).acquired, true);
});

test('3. owner PID dead on this host -> next tryAcquire reclaims it', () => {
  const dir = tmpDir();
  const pid = deadPid();
  plantLock(dir, 'db', ownerRecord('db', { pid, runId: 'crashed' }));
  const r = tryAcquire('db', { dir, runId: 'fresh' });
  assert.equal(r.acquired, true);
  assert.equal(inspect('db', { dir }).runId, 'fresh');
  assert.deepEqual(leftovers(dir), [], 'the stale directory is removed');
});

test('4. live owner is NEVER reclaimed, however old', () => {
  const dir = tmpDir();
  const old = new Date(Date.now() - DAY).toISOString();
  plantLock(dir, 'db', ownerRecord('db', { startedAt: old, runId: 'old-but-alive' }), { ageMs: DAY });
  for (const now of [Date.now(), Date.now() + 10 * DAY]) {
    const r = tryAcquire('db', { dir, now });
    assert.equal(r.acquired, false);
    assert.equal(r.owner.runId, 'old-but-alive');
  }
  assert.equal(inspect('db', { dir }).runId, 'old-but-alive');
});

test('isPidAlive: EPERM means alive, only ESRCH means dead', () => {
  const failWith = (code) => () => {
    throw Object.assign(new Error(code), { code });
  };
  assert.equal(isPidAlive(process.pid), true);
  assert.equal(isPidAlive(deadPid()), false);
  assert.equal(isPidAlive(1234, failWith('EPERM')), true);
  assert.equal(isPidAlive(1234, failWith('ESRCH')), false);
  assert.equal(isPidAlive(1234, failWith('EINVAL')), true, 'unknown errors err on the side of alive');
  assert.equal(isPidAlive(1234, () => true), true);
});

test('5. a PID the OS refuses to signal (EPERM) is treated as alive -> not reclaimed', () => {
  const dir = tmpDir();
  plantLock(dir, 'db', ownerRecord('db', { runId: 'other-user' }));
  const kill = (code) => () => {
    throw Object.assign(new Error(code), { code });
  };
  const eperm = tryAcquire('db', { dir, isAlive: (pid) => isPidAlive(pid, kill('EPERM')) });
  assert.equal(eperm.acquired, false);
  assert.equal(inspect('db', { dir }).runId, 'other-user');
  // control: the same lock with ESRCH really is reclaimed, so the EPERM result above is meaningful
  const esrch = tryAcquire('db', { dir, isAlive: (pid) => isPidAlive(pid, kill('ESRCH')) });
  assert.equal(esrch.acquired, true);
});

test('6a. missing owner.json + directory 2 min old -> reclaimed', () => {
  const dir = tmpDir();
  plantLock(dir, 'db', undefined, { ageMs: 2 * 60e3 });
  assert.equal(tryAcquire('db', { dir }).acquired, true);
});

test('6b. missing owner.json + fresh directory -> not reclaimed (creator is mid-write)', () => {
  const dir = tmpDir();
  plantLock(dir, 'db', undefined);
  const r = tryAcquire('db', { dir });
  assert.equal(r.acquired, false);
  assert.equal(r.owner.incomplete, true);
  assert.equal(r.owner.runId, null);
  assert.equal(inspect('db', { dir }).incomplete, true, 'inspect never reports an existing lock as free');
});

test('6c. unparseable owner.json behaves like a missing one (old -> reclaimed, fresh -> kept)', () => {
  const dir = tmpDir();
  plantLock(dir, 'old', '{"pid": 12', { ageMs: 2 * 60e3 });
  plantLock(dir, 'new', '{"pid": 12');
  assert.equal(tryAcquire('old', { dir }).acquired, true);
  assert.equal(tryAcquire('new', { dir }).acquired, false);
});

test('6d. owner.json that parses but has no usable pid/host/runId is "unparseable"', () => {
  const dir = tmpDir();
  // an owner we cannot identify must not be signalled (kill(undefined|0|-1) would hit process groups)
  for (const [i, bad] of [{}, { pid: 0, host: HOST, runId: 'x' }, { pid: -1, host: HOST, runId: 'x' }, { pid: 'abc', host: HOST, runId: 'x' }, []].entries()) {
    plantLock(dir, `bad${i}`, bad);
    assert.equal(tryAcquire(`bad${i}`, { dir }).acquired, false, `fresh bad owner #${i} kept`);
  }
  plantLock(dir, 'oldbad', { pid: 0, host: HOST, runId: 'x' }, { ageMs: 2 * 60e3 });
  assert.equal(tryAcquire('oldbad', { dir }).acquired, true);
});

test('7. lock from a different host is never reclaimed automatically', () => {
  const dir = tmpDir();
  plantLock(dir, 'db', ownerRecord('db', { host: 'some-other-machine', pid: deadPid(), runId: 'remote' }), { ageMs: 3 * DAY });
  const r = tryAcquire('db', { dir, now: Date.now() + 30 * DAY });
  assert.equal(r.acquired, false);
  assert.equal(r.owner.host, 'some-other-machine');
  assert.equal(inspect('db', { dir }).runId, 'remote');
});

test('8. release by a replaced owner is a no-op and leaves the new owner intact', () => {
  const dir = tmpDir();
  const a = tryAcquire('db', { dir, runId: 'A', pid: deadPid() });
  assert.equal(a.acquired, true);
  const b = tryAcquire('db', { dir, runId: 'B' }); // A's owner is dead, so B reclaims
  assert.equal(b.acquired, true);
  assert.equal(release(a.lock), false);
  assert.equal(inspect('db', { dir }).runId, 'B', 'B still holds the lock');
  assert.equal(release(b.lock), true);
  assert.equal(inspect('db', { dir }), null);
});

test('release is idempotent and false when the lock is already gone', () => {
  const dir = tmpDir();
  const { lock } = tryAcquire('db', { dir });
  assert.equal(release(lock), true);
  assert.equal(release(lock), false);
});

test('release leaves a lock alone when its owner.json belongs to another run', () => {
  const dir = tmpDir();
  const mine = tryAcquire('db', { dir, runId: 'mine' }).lock;
  rmSync(path.join(dir, 'db.lock'), { recursive: true });
  plantLock(dir, 'db', ownerRecord('db', { runId: 'theirs' }));
  assert.equal(release(mine), false);
  assert.equal(inspect('db', { dir }).runId, 'theirs');
});

test('9. withLock releases when fn throws, and rethrows the same error', async () => {
  const dir = tmpDir();
  const boom = new Error('boom');
  await assert.rejects(
    withLock('db', async () => {
      assert.equal(inspect('db', { dir }).pid, process.pid, 'held while fn runs');
      throw boom;
    }, { dir }),
    (e) => e === boom,
  );
  assert.equal(inspect('db', { dir }), null);
});

test('withLock returns fn result, passes the lock, and releases', async () => {
  const dir = tmpDir();
  const result = await withLock('db', async (lock) => {
    assert.equal(typeof lock.runId, 'string');
    return 42;
  }, { dir });
  assert.equal(result, 42);
  assert.equal(inspect('db', { dir }), null);
});

test('withLock keeps the callback error when release also fails; surfaces release failure otherwise', {
  skip: process.platform === 'win32' || process.getuid?.() === 0,
}, async () => {
  // Read-only parent AND lock directory: neither the rename nor the unlink fallback can free the lock (EACCES).
  const dir = tmpDir();
  const lockPath = path.join(dir, 'db.lock');
  const lockDown = () => {
    chmodSync(lockPath, 0o555);
    chmodSync(dir, 0o555);
  };
  const unlock = () => {
    chmodSync(dir, 0o755);
    if (existsSync(lockPath)) chmodSync(lockPath, 0o755);
  };
  const saved = { ..._tuning };
  _tuning.waitMs = 1;
  const boom = new Error('boom');
  try {
    await assert.rejects(withLock('db', () => { lockDown(); throw boom; }, { dir }), (e) => e === boom);
    unlock();
    rmSync(lockPath, { recursive: true, force: true });
    await assert.rejects(withLock('db', () => { lockDown(); return 1; }, { dir }), (e) => e.code === 'EACCES');
  } finally {
    Object.assign(_tuning, saved);
    unlock();
  }
});

test('10a. acquire waits for a lock held by another process and gets it after release', { timeout: 60000 }, async () => {
  const dir = tmpDir();
  const holder = launch([dir, 'db', '700']);
  await holder.waitFor(/^held$/m);
  const waits = [];
  const started = performance.now(); // monotonic: the wall clock can step back mid-wait
  const lock = await acquire('db', { dir, waitMs: 5000, pollMs: 50, onWait: (owner) => waits.push(owner) });
  assert.ok(performance.now() - started >= 200, 'it really waited');
  assert.ok(waits.length > 0, 'onWait was called');
  assert.equal(waits[0].pid, holder.pid);
  assert.equal(inspect('db', { dir }).pid, process.pid);
  assert.equal(release(lock), true);
  assert.equal(await holder.exit, 0);
});

test('10b. acquire with a short waitMs throws LockTimeoutError carrying the owner', { timeout: 60000 }, async () => {
  const dir = tmpDir();
  const holder = launch([dir, 'db', '900']);
  await holder.waitFor(/^held$/m);
  const started = performance.now(); // monotonic: the wall clock can step back mid-wait
  await assert.rejects(acquire('db', { dir, waitMs: 300, pollMs: 50 }), (err) => {
    assert.ok(err instanceof LockTimeoutError);
    assert.equal(err.name, 'LockTimeoutError');
    assert.equal(err.lockName, 'db');
    assert.equal(err.owner.pid, holder.pid);
    assert.equal(err.owner.host, HOST);
    assert.match(err.message, /db/);
    return true;
  });
  assert.ok(performance.now() - started >= 250, 'waited roughly waitMs before giving up');
  assert.equal(await holder.exit, 0);
  assert.equal(inspect('db', { dir }), null, 'holder released normally');
});

test('acquire with waitMs 0 tries exactly once', async () => {
  const dir = tmpDir();
  tryAcquire('db', { dir, runId: 'held' });
  await assert.rejects(acquire('db', { dir, waitMs: 0 }), LockTimeoutError);
});

test('11. invalid names throw (sync and async APIs)', async () => {
  const dir = tmpDir();
  for (const bad of ['', 'a/b', '../x', 'a b', 'a\\b', 'x:y', 'x\0y', 'é', undefined, null, 42]) {
    assert.throws(() => tryAcquire(bad, { dir }), /invalid lock name/, `tryAcquire ${JSON.stringify(bad)}`);
    assert.throws(() => inspect(bad, { dir }), /invalid lock name/);
    await assert.rejects(acquire(bad, { dir }), /invalid lock name/);
    await assert.rejects(withLock(bad, () => {}, { dir }), /invalid lock name/);
  }
  assert.deepEqual(readdirSync(dir), [], 'nothing was created');
  for (const ok of ['supabase-eaglewatch', 'prod.proj_1', 'A-b_c.9']) {
    assert.equal(tryAcquire(ok, { dir }).acquired, true, ok);
  }
});

test('12. two processes racing tryAcquire in the same instant: exactly one wins (x10)', { timeout: 120000 }, async () => {
  for (let i = 0; i < 10; i++) {
    const dir = tmpDir();
    assert.equal(await raceOnce({ dir, name: 'db', children: 2 }), 1, `iteration ${i}`);
    assert.equal(inspect('db', { dir }), null, `iteration ${i}: winner released`);
  }
});

test('13. racing reclaimers of one stale lock: exactly one wins, nobody steals the new lock (x10)', { timeout: 120000 }, async () => {
  const pid = deadPid();
  for (let i = 0; i < 10; i++) {
    const dir = tmpDir();
    plantLock(dir, 'db', ownerRecord('db', { pid, runId: 'crashed' }));
    assert.equal(await raceOnce({ dir, name: 'db', children: 4 }), 1, `iteration ${i}`);
    assert.deepEqual(leftovers(dir), [], `iteration ${i}: no litter`);
  }
});

test('a fresh reclaim guard (another process is mid-reclaim) -> not acquired, stale lock left for them', () => {
  const dir = tmpDir();
  plantLock(dir, 'db', ownerRecord('db', { pid: deadPid(), runId: 'crashed' }));
  mkdirSync(path.join(dir, 'db.lock.reclaim'));
  const r = tryAcquire('db', { dir });
  assert.equal(r.acquired, false);
  assert.equal(r.owner.runId, 'crashed');
  assert.equal(inspect('db', { dir }).runId, 'crashed', 'untouched');
});

test('an abandoned reclaim guard (reclaimer crashed) is cleared, then reclaim proceeds', () => {
  const dir = tmpDir();
  plantLock(dir, 'db', ownerRecord('db', { pid: deadPid(), runId: 'crashed' }));
  const guard = path.join(dir, 'db.lock.reclaim');
  mkdirSync(guard);
  const t = new Date(Date.now() - 5 * 60e3);
  utimesSync(guard, t, t);
  const r = tryAcquire('db', { dir, runId: 'fresh' });
  assert.equal(r.acquired, true);
  assert.equal(inspect('db', { dir }).runId, 'fresh');
  assert.deepEqual(leftovers(dir), []);
});

test('re-checks staleness under the guard: a lock that turned live is not stolen', () => {
  const dir = tmpDir();
  const lockPath = plantLock(dir, 'db', ownerRecord('db', { pid: deadPid(), runId: 'crashed' }));
  let calls = 0;
  // First look says dead; by the time the reclaimer holds the guard the owner reads as alive.
  const isAlive = () => ++calls > 1;
  const r = tryAcquire('db', { dir, isAlive });
  assert.equal(r.acquired, false);
  assert.ok(calls >= 2, 'staleness was evaluated again under the guard');
  assert.ok(existsSync(lockPath));
  assert.equal(inspect('db', { dir }).runId, 'crashed');
  assert.deepEqual(leftovers(dir), []);
});

// ---- reclaim races, exclusive publish, Windows retries, lost locks ----

const plantGuard = (dir, name, owner, { ageMs = 0, now = Date.now() } = {}) => {
  const guard = path.join(dir, `${name}.lock.reclaim`);
  mkdirSync(guard);
  if (owner) writeFileSync(path.join(guard, 'owner.json'), JSON.stringify(owner));
  if (ageMs) {
    const t = new Date(now - ageMs);
    utimesSync(guard, t, t);
  }
  return guard;
};
const guardOwner = (over = {}) => ({ pid: process.pid, host: HOST, runId: 'guard-run', createdAt: new Date().toISOString(), ...over });
const staleLock = (dir, name = 'db') => plantLock(dir, name, ownerRecord(name, { pid: deadPid(), runId: 'crashed' }));
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const asideLitter = (dir) => readdirSync(dir).filter((n) => n.includes('.stale-'));
const errWith = (code) => Object.assign(new Error(code), { code });
async function waitForFile(file, ms = 15000) {
  const end = Date.now() + ms;
  while (!existsSync(file)) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${file}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
// Retries in the code under test sleep _tuning.waitMs between attempts; keep tests fast.
function fastRetries(attempts = 40) {
  const saved = { ..._tuning };
  Object.assign(_tuning, { waitMs: 1, attempts });
  return () => Object.assign(_tuning, saved);
}

test('14. the reclaim guard carries its owner identity while held', () => {
  const dir = tmpDir();
  staleLock(dir);
  let seen;
  const r = tryAcquire('db', {
    dir,
    runId: 'fresh',
    hooks: { insideGuard: (guard) => (seen = readJson(path.join(guard, 'owner.json'))) },
  });
  assert.equal(r.acquired, true);
  assert.equal(seen.pid, process.pid);
  assert.equal(seen.host, HOST);
  assert.match(seen.runId, /\S/);
  assert.ok(!Number.isNaN(Date.parse(seen.createdAt)));
  assert.deepEqual(leftovers(dir), [], 'guard released afterwards');
});

test('15. a guard whose owner is alive is NEVER broken, however old', () => {
  const dir = tmpDir();
  staleLock(dir);
  const guard = plantGuard(dir, 'db', guardOwner({ runId: 'busy-reclaimer' }), { ageMs: 10 * 60e3 });
  for (const now of [Date.now(), Date.now() + 10 * DAY]) {
    const r = tryAcquire('db', { dir, now });
    assert.equal(r.acquired, false);
    assert.equal(r.owner.runId, 'crashed');
  }
  assert.equal(readJson(path.join(guard, 'owner.json')).runId, 'busy-reclaimer');
  assert.equal(inspect('db', { dir }).runId, 'crashed');
});

test('15b. a guard whose owner is dead on this host is broken at once, even when fresh', () => {
  const dir = tmpDir();
  staleLock(dir);
  plantGuard(dir, 'db', guardOwner({ pid: deadPid(), runId: 'dead-reclaimer' }));
  assert.equal(tryAcquire('db', { dir, runId: 'fresh' }).acquired, true);
  assert.deepEqual(leftovers(dir), []);
});

test('15c. a guard owned by another host is never broken', () => {
  const dir = tmpDir();
  staleLock(dir);
  const guard = plantGuard(dir, 'db', guardOwner({ host: 'elsewhere', pid: deadPid() }), { ageMs: DAY });
  assert.equal(tryAcquire('db', { dir }).acquired, false);
  assert.ok(existsSync(guard));
});

test('16. guard without an owner: kept at 29 s, broken at 31 s', () => {
  const now = Date.now();
  for (const [ageMs, expected] of [[29e3, false], [31e3, true]]) {
    const dir = tmpDir();
    staleLock(dir);
    const guard = plantGuard(dir, 'db', undefined, { ageMs, now });
    const r = tryAcquire('db', { dir, now });
    assert.equal(r.acquired, expected, `guard aged ${ageMs} ms`);
    if (!expected) assert.ok(existsSync(guard), 'a young guard is left alone');
  }
});

test('17. lock without a usable owner: kept at 59 s, reclaimed at 61 s', () => {
  const now = Date.now();
  for (const [ageMs, expected] of [[59e3, false], [61e3, true]]) {
    const dir = tmpDir();
    const lockPath = plantLock(dir, 'db', undefined);
    const t = new Date(now - ageMs);
    utimesSync(lockPath, t, t);
    assert.equal(tryAcquire('db', { dir, now }).acquired, expected, `lock aged ${ageMs} ms`);
  }
});

test('18. a reclaimer that grabbed a DIFFERENT guard than the one it inspected puts it back and gives up', () => {
  const dir = tmpDir();
  staleLock(dir);
  const guard = plantGuard(dir, 'db', undefined, { ageMs: 120e3 }); // abandoned: breakable
  let swapped = false;
  const r = tryAcquire('db', {
    dir,
    hooks: {
      beforeBreakGuard: (g) => {
        // meanwhile another reclaimer broke that guard and created a fresh one of its own
        fs.renameSync(g, `${g}.gone`);
        mkdirSync(g);
        writeFileSync(path.join(g, 'owner.json'), JSON.stringify(guardOwner({ runId: 'C-guard' })));
        swapped = true;
      },
    },
  });
  assert.ok(swapped);
  assert.equal(r.acquired, false);
  assert.equal(readJson(path.join(guard, 'owner.json')).runId, 'C-guard', 'their live guard was restored');
  assert.equal(inspect('db', { dir }).runId, 'crashed');
  assert.deepEqual(asideLitter(dir), []);
});

test('19. a reclaimer whose guard was taken away does not touch the lock', () => {
  const dir = tmpDir();
  staleLock(dir);
  const r = tryAcquire('db', {
    dir,
    hooks: {
      insideGuard: (g) => {
        fs.renameSync(g, `${g}.gone`);
        mkdirSync(g);
        writeFileSync(path.join(g, 'owner.json'), JSON.stringify(guardOwner({ runId: 'other-guard' })));
      },
    },
  });
  assert.equal(r.acquired, false);
  assert.equal(inspect('db', { dir }).runId, 'crashed', 'the lock was not moved aside');
  assert.equal(readJson(path.join(dir, 'db.lock.reclaim', 'owner.json')).runId, 'other-guard', 'their guard survives our cleanup');
});

test('20. repro: two reclaimers racing over an abandoned guard never produce two holders', { timeout: 60000 }, async () => {
  const dir = tmpDir();
  const gates = tmpDir();
  staleLock(dir);
  plantGuard(dir, 'db', undefined, { ageMs: 120e3 }); // the previous reclaimer crashed inside its critical section
  const gate = (who, kind) => path.join(gates, `${who}.${kind}`);
  // D sees the abandoned guard and stalls just before moving it aside.
  const D = launch([dir, 'D', gates], RACE_FIXTURE);
  await waitForFile(gate('D', 'reached'));
  // C breaks the same abandoned guard, takes a fresh one and stalls inside its critical section.
  const C = launch([dir, 'C', gates], RACE_FIXTURE);
  await waitForFile(gate('C', 'reached'));
  try {
    writeFileSync(gate('D', 'go'), ''); // D resumes: its rename now hits C's live guard
    const d = await D.waitFor(/^D acquired=(true|false)$/m);
    writeFileSync(gate('C', 'go'), ''); // C resumes inside its critical section
    const c = await C.waitFor(/^C acquired=(true|false)$/m);
    assert.deepEqual([d, c], ['false', 'true'], 'exactly one holder');
    assert.equal(inspect('db', { dir }).runId, 'C');
  } finally {
    writeFileSync(path.join(gates, 'done'), '');
  }
  assert.equal(await D.exit, 0);
  assert.equal(await C.exit, 0);
  assert.equal(inspect('db', { dir }), null, 'C released its own lock');
});

test('21. owner.json is published exclusively: a competitor that got there first keeps the lock', () => {
  const dir = tmpDir();
  const r = tryAcquire('db', {
    dir,
    runId: 'me',
    hooks: {
      beforeOwnerPublish: (p) =>
        writeFileSync(path.join(p, 'owner.json'), JSON.stringify(ownerRecord('db', { runId: 'competitor' }))),
    },
  });
  assert.equal(r.acquired, false);
  assert.equal(r.owner.runId, 'competitor');
  assert.equal(inspect('db', { dir }).runId, 'competitor');
  assert.deepEqual(readdirSync(path.join(dir, 'db.lock')), ['owner.json'], 'our tmp file is gone, theirs untouched');
});

test('21b. after publishing, owner.json is re-read; if it is not ours we back off without deleting theirs', (t) => {
  const dir = tmpDir();
  t.mock.method(fs, 'linkSync', () => {
    throw errWith('ENOTSUP'); // filesystem without hard links: rename fallback, which is not exclusive
  });
  const r = tryAcquire('db', {
    dir,
    runId: 'me',
    hooks: {
      afterOwnerPublish: (p) =>
        writeFileSync(path.join(p, 'owner.json'), JSON.stringify(ownerRecord('db', { runId: 'competitor' }))),
    },
  });
  assert.equal(r.acquired, false);
  assert.equal(r.owner.runId, 'competitor');
  assert.equal(inspect('db', { dir }).runId, 'competitor');
});

test('21c. no hard links (ENOTSUP/EPERM/EXDEV/EOPNOTSUPP): falls back to rename, retrying a busy rename', (t) => {
  const restore = fastRetries();
  try {
    for (const code of ['ENOTSUP', 'EPERM', 'EXDEV', 'EOPNOTSUPP']) {
      const dir = tmpDir();
      const realRename = fs.renameSync;
      let busy = 1;
      t.mock.method(fs, 'linkSync', () => {
        throw errWith(code);
      });
      t.mock.method(fs, 'renameSync', (a, b) => {
        if (busy-- > 0) throw errWith('EBUSY');
        return realRename(a, b);
      });
      const r = tryAcquire('db', { dir, runId: `via-${code}` });
      assert.equal(r.acquired, true, code);
      assert.equal(inspect('db', { dir }).runId, `via-${code}`);
      assert.deepEqual(readdirSync(path.join(dir, 'db.lock')), ['owner.json'], 'tmp file consumed');
      t.mock.restoreAll();
    }
  } finally {
    restore();
  }
});

test('22. a failed owner write cleans its tmp file, frees the lock dir and returns not-acquired (no throw)', (t) => {
  const dir = tmpDir();
  t.mock.method(fs, 'linkSync', () => {
    throw errWith('EIO');
  });
  const r = tryAcquire('db', { dir });
  assert.equal(r.acquired, false);
  assert.equal(r.error.code, 'EIO');
  assert.deepEqual(readdirSync(dir), [], 'neither tmp file nor an ownerless lock directory is left behind');
});

test('22b. the lock directory vanishing while we publish just makes us retry', () => {
  const dir = tmpDir();
  let n = 0;
  const r = tryAcquire('db', {
    dir,
    runId: 'me',
    hooks: {
      beforeOwnerPublish: (p) => {
        if (n++ === 0) rmSync(p, { recursive: true }); // e.g. reclaimed by someone while we were stalled
      },
    },
  });
  assert.equal(r.acquired, true);
  assert.equal(inspect('db', { dir }).runId, 'me');
  assert.deepEqual(readdirSync(path.join(dir, 'db.lock')), ['owner.json']);
});

test('23. release retries a directory rename that is refused while busy (EBUSY twice, then ok)', (t) => {
  const restore = fastRetries();
  try {
    const dir = tmpDir();
    const { lock } = tryAcquire('db', { dir });
    const realRename = fs.renameSync;
    let failures = 2;
    const m = t.mock.method(fs, 'renameSync', (a, b) => {
      if (failures-- > 0) throw errWith('EBUSY');
      return realRename(a, b);
    });
    assert.equal(release(lock), true);
    assert.equal(m.mock.callCount(), 3);
    assert.equal(inspect('db', { dir }), null);
  } finally {
    restore();
  }
});

test('23b. reclaim retries a busy rename too', (t) => {
  const restore = fastRetries();
  try {
    const dir = tmpDir();
    staleLock(dir);
    const realRename = fs.renameSync;
    let failures = 3;
    t.mock.method(fs, 'renameSync', (a, b) => {
      if (failures-- > 0) throw errWith('EBUSY');
      return realRename(a, b);
    });
    assert.equal(tryAcquire('db', { dir, runId: 'fresh' }).acquired, true);
    assert.deepEqual(asideLitter(dir), []);
  } finally {
    restore();
  }
});

test('23c. when the rename keeps failing, release unlinks owner.json and removes the directory instead', (t) => {
  const restore = fastRetries(3);
  try {
    const dir = tmpDir();
    const { lock } = tryAcquire('db', { dir });
    const m = t.mock.method(fs, 'renameSync', () => {
      throw errWith('EPERM');
    });
    assert.equal(release(lock), true);
    assert.equal(m.mock.callCount(), 3, 'retried before giving up');
    assert.equal(inspect('db', { dir }), null);
    assert.deepEqual(readdirSync(dir), []);
  } finally {
    restore();
  }
});

test('24. owner.json unreadable for a reason other than "missing" is rethrown, never treated as reclaimable', (t) => {
  const dir = tmpDir();
  const lockPath = plantLock(dir, 'db', ownerRecord('db', { pid: deadPid(), runId: 'crashed' }), { ageMs: DAY });
  const real = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (p, ...rest) => {
    if (String(p).endsWith('owner.json')) throw errWith('EACCES');
    return real(p, ...rest);
  });
  assert.throws(() => tryAcquire('db', { dir }), (e) => e.code === 'EACCES');
  assert.throws(() => inspect('db', { dir }), (e) => e.code === 'EACCES');
  t.mock.restoreAll();
  assert.equal(readJson(path.join(lockPath, 'owner.json')).runId, 'crashed', 'the lock was left alone');
});

test('25. acquire() default runIds are unique across calls', async () => {
  const dir = tmpDir();
  const ids = [];
  for (let i = 0; i < 5; i++) {
    const lock = await acquire('db', { dir });
    ids.push(lock.runId);
    release(lock);
  }
  assert.equal(new Set(ids).size, 5);
  for (const id of ids) assert.match(id, new RegExp(`^${process.pid}-[0-9a-f-]{36}$`));
});

test('26. withLock throws LockLostError when the lock was taken over while fn ran', async () => {
  const dir = tmpDir();
  let finished = false;
  await assert.rejects(
    withLock('db', () => {
      // our process looks dead to the thief, which reclaims the lock mid-fn
      assert.equal(tryAcquire('db', { dir, runId: 'thief' }).acquired, true);
      finished = true;
      return 'untrustworthy result';
    }, { dir, pid: deadPid() }),
    (e) => e instanceof LockLostError && e.name === 'LockLostError' && /db/.test(e.message),
  );
  assert.ok(finished, 'fn ran to completion first');
  assert.equal(inspect('db', { dir }).runId, 'thief', 'the new owner is left intact');
});

test('26b. withLock reports the callback error, not LockLostError, when fn throws after losing the lock', async () => {
  const dir = tmpDir();
  const boom = new Error('boom');
  await assert.rejects(
    withLock('db', () => {
      tryAcquire('db', { dir, runId: 'thief' });
      throw boom;
    }, { dir, pid: deadPid() }),
    (e) => e === boom,
  );
});

test('27. LockTimeoutError names the lock path, the owner and how to clear it by hand', async () => {
  const dir = tmpDir();
  const lockPath = path.join(dir, 'db.lock');
  const held = tryAcquire('db', { dir, runId: 'holder' });
  await assert.rejects(acquire('db', { dir, waitMs: 0 }), (err) => {
    assert.ok(err instanceof LockTimeoutError);
    assert.equal(err.lockPath, lockPath);
    assert.ok(err.message.includes(lockPath));
    assert.ok(err.message.includes(`pid ${process.pid}`));
    assert.ok(err.message.includes(HOST));
    assert.ok(err.message.includes(held.lock.startedAt));
    assert.ok(err.message.includes(`remove ${lockPath} if no pipeline process is running`));
    return true;
  });
});

// ---- machine identity: a renamed host must not strand a dead owner's lock ------------------------------------------------

test('17a. a lock from an OLD hostname but the same machine id, with a dead owner, is reclaimed', () => {
  const dir = tmpDir();
  plantLock(dir, 'db', ownerRecord('db', { host: 'old-name.local', machineId: 'machine-aaaaaaaa', pid: deadPid(), runId: 'renamed' }), { ageMs: 3 * DAY });
  const r = tryAcquire('db', { dir, machineId: 'machine-aaaaaaaa', runId: 'new' });
  assert.equal(r.acquired, true);
  assert.equal(inspect('db', { dir }).runId, 'new');
  assert.equal(inspect('db', { dir }).machineId, 'machine-aaaaaaaa', 'the new owner records the machine id too');
});

test('17b. R12-prime holds across a rename: the same machine id with a LIVE owner pid is never reclaimed', () => {
  const dir = tmpDir();
  plantLock(dir, 'db', ownerRecord('db', { host: 'old-name.local', machineId: 'machine-aaaaaaaa', pid: process.pid, runId: 'alive' }), { ageMs: 3 * DAY });
  const r = tryAcquire('db', { dir, machineId: 'machine-aaaaaaaa', now: Date.now() + 30 * DAY });
  assert.equal(r.acquired, false);
  assert.equal(inspect('db', { dir }).runId, 'alive');
});

test('17c. a different machine id (or none) on a different host is still never reclaimed', () => {
  const dir = tmpDir();
  plantLock(dir, 'a', ownerRecord('a', { host: 'elsewhere', machineId: 'machine-bbbbbbbb', pid: deadPid(), runId: 'other' }), { ageMs: 3 * DAY });
  assert.equal(tryAcquire('a', { dir, machineId: 'machine-aaaaaaaa' }).acquired, false);
  plantLock(dir, 'b', ownerRecord('b', { host: 'elsewhere', pid: deadPid(), runId: 'legacy' }), { ageMs: 3 * DAY });
  assert.equal(tryAcquire('b', { dir, machineId: 'machine-aaaaaaaa' }).acquired, false, 'an old lock without a machine id is judged by hostname only');
  assert.equal(tryAcquire('b', { dir, machineId: null }).acquired, false);
});

test('17d. a reclaim guard from a renamed host with the same machine id and a dead owner is broken', () => {
  const dir = tmpDir();
  staleLock(dir);
  plantGuard(dir, 'db', guardOwner({ host: 'old-name.local', machineId: 'machine-aaaaaaaa', pid: deadPid(), runId: 'dead-reclaimer' }));
  assert.equal(tryAcquire('db', { dir, machineId: 'machine-aaaaaaaa', runId: 'fresh' }).acquired, true);
});

test('17e. machineId(): env override, persisted random id created once, unwritable state dir gives null', () => {
  assert.equal(machineId({ env: { PIPELINE_MACHINE_ID: 'abc12345-xyz' } }), 'abc12345-xyz');
  assert.equal(machineId({ env: { PIPELINE_MACHINE_ID: 'bad id!' } }), null);
  const stateDir = path.join(tmpDir(), 'state');
  const first = machineId({ env: {}, stateDir });
  assert.match(first, /^[0-9a-f-]{36}$/);
  assert.equal(machineId({ env: {}, stateDir }), first, 'stable on the next call');
  assert.equal(readFileSync(path.join(stateDir, 'machine-id'), 'utf8').trim(), first);
  const blocker = path.join(tmpDir(), 'file');
  writeFileSync(blocker, 'x');
  assert.equal(machineId({ env: {}, stateDir: path.join(blocker, 'sub') }), null);
});
