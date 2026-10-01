import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync, utimesSync, existsSync, chmodSync } from 'node:fs';
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
} from '../pipeline/lib/locks.mjs';

const FIXTURE = fileURLToPath(new URL('./fixtures/hold-lock.mjs', import.meta.url));
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
function launch(args) {
  const child = spawn(process.execPath, [FIXTURE, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
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
  // A read-only lock directory makes the release rename fail (EACCES) on POSIX.
  const dir = tmpDir();
  const boom = new Error('boom');
  try {
    await assert.rejects(withLock('db', () => { chmodSync(dir, 0o555); throw boom; }, { dir }), (e) => e === boom);
    chmodSync(dir, 0o755);
    rmSync(path.join(dir, 'db.lock'), { recursive: true, force: true });
    await assert.rejects(withLock('db', () => { chmodSync(dir, 0o555); return 1; }, { dir }), (e) => e.code === 'EACCES');
  } finally {
    chmodSync(dir, 0o755);
  }
});

test('10a. acquire waits for a lock held by another process and gets it after release', { timeout: 60000 }, async () => {
  const dir = tmpDir();
  const holder = launch([dir, 'db', '700']);
  await holder.waitFor(/^held$/m);
  const waits = [];
  const started = Date.now();
  const lock = await acquire('db', { dir, waitMs: 5000, pollMs: 50, onWait: (owner) => waits.push(owner) });
  assert.ok(Date.now() - started >= 200, 'it really waited');
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
  const started = Date.now();
  await assert.rejects(acquire('db', { dir, waitMs: 300, pollMs: 50 }), (err) => {
    assert.ok(err instanceof LockTimeoutError);
    assert.equal(err.name, 'LockTimeoutError');
    assert.equal(err.lockName, 'db');
    assert.equal(err.owner.pid, holder.pid);
    assert.equal(err.owner.host, HOST);
    assert.match(err.message, /db/);
    return true;
  });
  assert.ok(Date.now() - started >= 250, 'waited roughly waitMs before giving up');
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
