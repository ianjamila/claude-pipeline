// In-process tests for review leases and the admission lock (lib/review-lease.mjs, plan 2026-11-10 B1/B6). Everything about the machine is
// injected (the Claude ancestor pid, ps start times, session records, running jobs), so the tests are deterministic and never read the process
// table or the account's own folders. Only the symlink cases are POSIX-only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeCodeAncestorPid, hasClaudeCodeAncestor } from '../pipeline/lib/claude-ancestry.mjs';
import { OWNER_GO_REL, ownerGoDir } from '../pipeline/hooks/lib/owner-go.mjs';
import {
  ADMISSION_LOCK, LEASES_REL, LEASE_DIR_ENV, LEASE_TTL_MS, UPDATE_IN_PROGRESS, acquireAdmission, blocking, closeLease, leasesDir, openOrRenewLease,
  readSessionRecord, releaseAdmission, resolveHolder, scanLeases, sweepDeadLeases, withAdmission,
} from '../pipeline/lib/review-lease.mjs';

process.env.PIPELINE_MACHINE_ID ||= 'test-machine-id';
const HOUR = 3600_000;
const T0 = Date.UTC(2026, 10, 11, 12, 0, 0);
const START_A = 'Wed Nov 11 02:23:52 2026';
const START_B = 'Wed Nov 11 03:10:00 2026';
const tmp = (t) => {
  const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cp-lease-')));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};

// A fake machine: `procs` pid -> start time (ps), `records` pid -> session record, `jobs` worktrees with a running detached job.
function world(t) {
  const root = tmp(t);
  const w = {
    root, dir: path.join(root, 'review-leases'), home: path.join(root, 'home'), now: T0,
    procs: new Map(), records: new Map(), jobs: new Set(),
    wt: (name) => { const d = path.join(root, name); fs.mkdirSync(d, { recursive: true }); return d; },
    // Opening/renewing as the session that runs under Claude Code pid `pid`.
    as(pid, extra = {}) {
      return {
        dir: w.dir, home: w.home, env: { CLAUDECODE: '1' }, ancestorPid: pid, now: w.now,
        starts: (pids) => new Map(pids.filter((p) => w.procs.has(p)).map((p) => [p, w.procs.get(p)])),
        sessionRecord: (p) => w.records.get(p) ?? null, jobLive: (wt) => w.jobs.has(wt), ...extra,
      };
    },
    session(pid, sessionId, start = START_A) { w.procs.set(pid, start); w.records.set(pid, { sessionId, procStart: start }); },
    scan(extra = {}) { return scanLeases({ ...w.as(null), ...extra }); },
  };
  fs.mkdirSync(w.home, { recursive: true });
  return w;
}
const open = (w, pid, wt, extra = {}) => openOrRenewLease({ worktree: wt, repoId: 'acme/app', pr: 7, ...extra, ...w.as(pid, extra.opts) });
const files = (dir) => fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort();
const readFile = (dir, id) => JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf8'));

// ---- the ancestry walk -------------------------------------------------------------------------------------------------------------------

test('claudeCodeAncestorPid returns the nearest Claude Code ancestor (null when none); hasClaudeCodeAncestor is exactly "not null"', () => {
  const rows = {
    900: { ppid: 800, comm: 'node', args: 'node install.mjs' }, 800: { ppid: 700, comm: '/bin/zsh' }, 700: { ppid: 650, comm: 'claude bg-spare' },
    650: { ppid: 600, comm: 'sh' }, 600: { ppid: 500, comm: '/Users/u/.local/bin/claude' }, 500: { ppid: 1, comm: 'login' },
  };
  const lookup = (pid) => rows[pid] ?? null;
  assert.equal(claudeCodeAncestorPid({ startPid: 900, lookup }), 700, 'the nearest match wins');
  assert.equal(claudeCodeAncestorPid({ startPid: 650, lookup }), 600);
  assert.equal(claudeCodeAncestorPid({ startPid: 500, lookup }), null);
  assert.equal(claudeCodeAncestorPid({ startPid: 900, lookup: () => null }), null);
  assert.equal(claudeCodeAncestorPid({ startPid: 30, lookup: (p) => ({ 30: { ppid: 20, comm: 'a' }, 20: { ppid: 30, comm: 'b' } })[p] ?? null }), null, 'a cycle ends the walk');
  for (const startPid of [900, 650, 500]) assert.equal(hasClaudeCodeAncestor({ startPid, lookup }), claudeCodeAncestorPid({ startPid, lookup }) !== null);
});

// ---- where it lives ----------------------------------------------------------------------------------------------------------------------

test('the lease folder sits inside the guard-protected owner-go namespace, under the account home (never $HOME)', (t) => {
  const home = tmp(t);
  const dir = leasesDir({ home, env: {} });
  assert.equal(LEASES_REL, `${OWNER_GO_REL}/review-leases`);
  assert.equal(dir, path.join(home, '.claude', 'pipeline-state', 'owner-go', 'review-leases'));
  const rel = path.relative(ownerGoDir(home), dir);
  assert.ok(rel && !rel.startsWith('..') && !path.isAbsolute(rel), `inside the owner-go folder (${rel})`);
  assert.ok(`${dir}${path.sep}`.startsWith(`${ownerGoDir(home)}${path.sep}`));
});

test('PIPELINE_REVIEW_LEASE_DIR is honoured by a repo checkout only; an installed copy ignores it with a warning', (t) => {
  const scratch = path.join(tmp(t), 'leases');
  const checkout = tmp(t);
  const installed = tmp(t);
  fs.writeFileSync(path.join(installed, 'INSTALLED.json'), '{}');
  const env = { [LEASE_DIR_ENV]: scratch };
  assert.equal(leasesDir({ env, root: checkout, home: '/nowhere' }), scratch);
  const warnings = [];
  const ignored = leasesDir({ env, root: installed, home: '/nowhere', warn: (m) => warnings.push(m) });
  assert.equal(ignored, path.join('/nowhere', '.claude', 'pipeline-state', 'owner-go', 'review-leases'));
  assert.equal(warnings.length, 1);
  assert.equal(leasesDir({ dir: scratch, env: {}, home: '/nowhere' }), scratch, 'an injected dir wins');
});

// ---- holder identity ---------------------------------------------------------------------------------------------------------------------

test('resolveHolder: a session via its record, TTL-only when the lookup fails, nothing for a plain terminal', (t) => {
  const w = world(t);
  w.session(500, 'sess-one');
  assert.deepEqual(resolveHolder({ worktree: w.root, ...w.as(500) }), { kind: 'session', sessionId: 'sess-one', pid: 500, pidStart: START_A });
  // CLAUDECODE=1 with an ancestor whose record is missing, ps that cannot answer, a record whose start disagrees with ps: TTL-only.
  const ttl = (extra) => resolveHolder({ worktree: w.root, ...w.as(500, extra) });
  for (const extra of [{ sessionRecord: () => null }, { starts: () => null }, { starts: () => new Map() }, { sessionRecord: () => ({ sessionId: 'sess-one', procStart: START_B }) }]) {
    const h = ttl(extra);
    assert.equal(h.kind, 'ttl');
    assert.equal(h.pid, null);
    assert.match(h.sessionId, /^ttl-[0-9a-f]{16}$/);
  }
  assert.equal(ttl({ sessionRecord: () => null }).sessionId, ttl({ starts: () => null }).sessionId, 'stable for one worktree');
  assert.notEqual(resolveHolder({ worktree: path.join(w.root, 'a'), ...w.as(null) }).sessionId, resolveHolder({ worktree: path.join(w.root, 'b'), ...w.as(null) }).sessionId);
  // No Claude ancestor but CLAUDECODE=1 (a detached job): TTL-only. Neither: no lease.
  assert.equal(resolveHolder({ worktree: w.root, ...w.as(null) }).kind, 'ttl');
  assert.deepEqual(resolveHolder({ worktree: w.root, ...w.as(null, { env: {} }) }), { kind: 'none' });
  assert.deepEqual(resolveHolder({ worktree: w.root, ...w.as(null, { env: { CLAUDECODE: '0' } }) }), { kind: 'none' });
});

test('readSessionRecord reads <config>/sessions/<pid>.json from every ~/.claude* folder (both accounts)', (t) => {
  const home = tmp(t);
  for (const [cfg, pid, id] of [['.claude', 111, 'acct-a-session'], ['.claude-eaglewatch', 222, 'acct-b-session']]) {
    fs.mkdirSync(path.join(home, cfg, 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(home, cfg, 'sessions', `${pid}.json`), JSON.stringify({ pid, sessionId: id, procStart: START_A }));
  }
  assert.deepEqual(readSessionRecord(111, { home, env: {} }), { sessionId: 'acct-a-session', procStart: START_A });
  assert.deepEqual(readSessionRecord(222, { home, env: {} }), { sessionId: 'acct-b-session', procStart: START_A });
  assert.equal(readSessionRecord(333, { home, env: {} }), null);
  fs.writeFileSync(path.join(home, '.claude', 'sessions', '444.json'), JSON.stringify({ pid: 999, sessionId: 'wrong-pid' }));
  assert.equal(readSessionRecord(444, { home, env: {} }), null, 'a record that names another pid is not this pid\'s');
});

// ---- open / renew / close ----------------------------------------------------------------------------------------------------------------

test('open, renew and close one lease; the file has the documented shape', async (t) => {
  const w = world(t);
  w.session(500, 'sess-one');
  const wt = w.wt('wt1');
  const a = await open(w, 500, wt);
  assert.equal(a.action, 'opened');
  assert.equal(a.ttlOnly, false);
  const rec = readFile(w.dir, 'sess-one');
  assert.deepEqual({ ...rec, leases: undefined }, { version: 1, sessionId: 'sess-one', pid: 500, pidStart: START_A, leases: undefined });
  const lease = rec.leases[wt];
  assert.deepEqual(Object.keys(lease).sort(), ['generation', 'openedAt', 'pr', 'renewedAt', 'repoId']);
  assert.equal(lease.generation, a.generation);
  assert.equal(lease.renewedAt, new Date(T0).toISOString());

  w.now = T0 + 20 * 60_000;
  const b = await open(w, 500, wt);
  assert.equal(b.action, 'renewed');
  assert.equal(b.generation, a.generation, 'renew keeps the generation');
  const renewed = readFile(w.dir, 'sess-one').leases[wt];
  assert.equal(renewed.openedAt, new Date(T0).toISOString());
  assert.equal(renewed.renewedAt, new Date(w.now).toISOString());
  assert.deepEqual(w.scan({ now: w.now }).live.map((e) => [e.sessionId, e.worktree, e.pr]), [['sess-one', wt, 7]]);

  assert.deepEqual(await closeLease({ worktree: wt, generation: a.generation, ...w.as(500) }), { closed: true, sessionId: 'sess-one' });
  assert.deepEqual(files(w.dir), [], 'the last lease removes the holder file');
  assert.deepEqual(await closeLease({ worktree: wt, ...w.as(500) }), { closed: false, why: 'absent' });
  assert.deepEqual(w.scan().live, []);
});

test('renew opens a lease when none exists (a review begun on an older install)', async (t) => {
  const w = world(t);
  w.session(500, 'sess-one');
  assert.equal((await open(w, 500, w.wt('wt1'))).action, 'opened');
});

test('two sessions on one PR hold two leases; closing one keeps the other', async (t) => {
  const w = world(t);
  w.session(500, 'sess-one');
  w.session(600, 'sess-two');
  const wt = w.wt('shared');
  const a = await open(w, 500, wt);
  const b = await open(w, 600, wt);
  assert.notEqual(a.generation, b.generation);
  assert.deepEqual(files(w.dir), ['sess-one.json', 'sess-two.json']);
  assert.equal(w.scan().live.length, 2);
  await closeLease({ worktree: wt, ...w.as(500) });
  const left = w.scan();
  assert.deepEqual(left.live.map((e) => e.sessionId), ['sess-two']);
  assert.deepEqual(files(w.dir), ['sess-two.json']);
});

test('a session edits only its own file: several worktrees, one holder; closing one worktree keeps the others', async (t) => {
  const w = world(t);
  w.session(500, 'sess-one');
  const [x, y] = [w.wt('x'), w.wt('y')];
  await open(w, 500, x);
  await open(w, 500, y, { pr: 8 });
  assert.deepEqual(Object.keys(readFile(w.dir, 'sess-one').leases).sort(), [x, y].sort());
  await closeLease({ worktree: x, ...w.as(500) });
  assert.deepEqual(Object.keys(readFile(w.dir, 'sess-one').leases), [y]);
});

test('closing with a stale generation is ignored (an old `ended` run cannot close a resumed lease)', async (t) => {
  const w = world(t);
  w.session(500, 'sess-one');
  const wt = w.wt('wt');
  const first = await open(w, 500, wt);
  await open(w, 500, wt, { pr: 9 }); // the worktree moved on to another PR: a new generation
  const second = readFile(w.dir, 'sess-one').leases[wt].generation;
  assert.notEqual(second, first.generation);
  assert.deepEqual(await closeLease({ worktree: wt, generation: first.generation, ...w.as(500) }), { closed: false, why: 'stale-generation' });
  assert.equal(readFile(w.dir, 'sess-one').leases[wt].generation, second, 'the lease is untouched');
  assert.equal((await closeLease({ worktree: wt, generation: second, ...w.as(500) })).closed, true);
});

test('a branch lease becomes a PR lease on the first call that knows the PR, keeping its generation; a new open gets a new one', async (t) => {
  const w = world(t);
  w.session(500, 'sess-one');
  const wt = w.wt('wt');
  const a = await open(w, 500, wt, { pr: undefined, branch: 'agent/feature' });
  assert.equal(a.action, 'opened');
  assert.deepEqual(Object.keys(readFile(w.dir, 'sess-one').leases[wt]).sort(), ['branch', 'generation', 'openedAt', 'renewedAt', 'repoId']);
  const again = await open(w, 500, wt, { pr: undefined, branch: 'agent/feature' });
  assert.equal(again.action, 'renewed');
  const m = await open(w, 500, wt, { pr: 42, branch: 'agent/feature' });
  assert.equal(m.action, 'migrated');
  assert.equal(m.generation, a.generation, 'same generation');
  const lease = readFile(w.dir, 'sess-one').leases[wt];
  assert.equal(lease.pr, 42);
  assert.equal(lease.branch, undefined);
  // A later call that only knows the branch renews the PR lease; another PR or another repo reopens.
  assert.equal((await open(w, 500, wt, { pr: undefined, branch: 'agent/feature' })).generation, a.generation);
  const other = await open(w, 500, wt, { pr: 43 });
  assert.equal(other.action, 'reopened');
  assert.notEqual(other.generation, a.generation);
  const moved = await open(w, 500, wt, { pr: 43, repoId: 'acme/other' });
  assert.equal(moved.action, 'reopened');
  assert.notEqual(moved.generation, other.generation);
});

test('bad arguments are refused with a coded error and write nothing', async (t) => {
  const w = world(t);
  w.session(500, 'sess-one');
  const wt = w.wt('wt');
  for (const args of [{ worktree: '' }, { worktree: wt, repoId: '' }, { worktree: wt, repoId: 'a/b' }, { worktree: wt, repoId: 'a/b', pr: -1 }, { worktree: wt, repoId: 'a/b', pr: 1.5 }]) {
    await assert.rejects(openOrRenewLease({ ...args, ...w.as(500) }), (e) => e.code === 'review-lease-args', JSON.stringify(args));
  }
  assert.equal(fs.existsSync(w.dir), false);
});

test('parallel opens by one session on different worktrees all land (the per-file lock serialises them)', async (t) => {
  const w = world(t);
  w.session(500, 'sess-one');
  const wts = Array.from({ length: 6 }, (_, i) => w.wt(`p${i}`));
  await Promise.all(wts.map((wt, i) => open(w, 500, wt, { pr: i + 1 })));
  assert.deepEqual(Object.keys(readFile(w.dir, 'sess-one').leases).sort(), wts.slice().sort());
  assert.deepEqual(fs.readdirSync(w.dir).filter((n) => n.endsWith('.tmp') || n.endsWith('.lock')), [], 'no temp file or lock left behind');
});

// ---- liveness ----------------------------------------------------------------------------------------------------------------------------

test('a dead pid is dead, and sweepDeadLeases removes its file but keeps a live holder\'s', async (t) => {
  const w = world(t);
  w.session(500, 'sess-live');
  w.session(600, 'sess-dead');
  await open(w, 500, w.wt('a'));
  await open(w, 600, w.wt('b'));
  w.procs.delete(600);
  const scan = w.scan();
  assert.deepEqual(scan.live.map((e) => e.sessionId), ['sess-live']);
  assert.deepEqual(scan.dead.map((e) => e.sessionId), ['sess-dead']);
  assert.match(scan.dead[0].why, /gone/);
  const r = await sweepDeadLeases(w.as(null));
  assert.deepEqual(r.removed.map((e) => e.sessionId), ['sess-dead']);
  assert.deepEqual(files(w.dir), ['sess-live.json']);
});

test('PID reuse: the same pid with a different start time is dead', async (t) => {
  const w = world(t);
  w.session(500, 'sess-one');
  await open(w, 500, w.wt('a'));
  w.procs.set(500, START_B); // the pid now belongs to another process
  w.records.set(500, { sessionId: 'sess-one', procStart: START_B }); // even a record that still says the old id cannot revive it
  const scan = w.scan();
  assert.equal(scan.live.length, 0);
  assert.match(scan.dead[0].why, /reused/);
});

test('/clear: the same pid and start time with a new session id is dead', async (t) => {
  const w = world(t);
  w.session(500, 'sess-old');
  await open(w, 500, w.wt('a'));
  w.records.set(500, { sessionId: 'sess-new', procStart: START_A });
  const scan = w.scan();
  assert.equal(scan.live.length, 0);
  assert.match(scan.dead[0].why, /sess-new/);
  // The cleared session then opens its own lease; the old holder file is swept.
  await open(w, 500, w.wt('a'));
  assert.deepEqual(files(w.dir), ['sess-new.json', 'sess-old.json']);
  await sweepDeadLeases(w.as(null));
  assert.deepEqual(files(w.dir), ['sess-new.json']);
});

test('idle longer than 6 h is dead; a long gap with no commands (3 h) is still live', async (t) => {
  const w = world(t);
  w.session(500, 'sess-one');
  await open(w, 500, w.wt('a'));
  assert.equal(LEASE_TTL_MS, 6 * HOUR);
  assert.equal(w.scan({ now: T0 + 40 * 60_000 }).live.length, 1, 'a 40 minute Fable pass');
  assert.equal(w.scan({ now: T0 + 3 * HOUR }).live.length, 1);
  assert.equal(w.scan({ now: T0 + 6 * HOUR }).live.length, 1, 'exactly the limit is still live');
  const stale = w.scan({ now: T0 + 6 * HOUR + 1000 });
  assert.equal(stale.live.length, 0);
  assert.match(stale.dead[0].why, /idle/);
  // Renewing resets the clock.
  w.now = T0 + 5 * HOUR;
  await open(w, 500, w.wt('a'));
  assert.equal(w.scan({ now: T0 + 10 * HOUR }).live.length, 1);
});

test('a clock set back counts as just renewed (never dead)', async (t) => {
  const w = world(t);
  w.session(500, 'sess-one');
  await open(w, 500, w.wt('a'));
  assert.equal(w.scan({ now: T0 - 5 * HOUR }).live.length, 1);
});

test('an unreadable lease file counts as live, never dead, and is never swept', async (t) => {
  const w = world(t);
  fs.mkdirSync(w.dir, { recursive: true });
  const bad = {
    'junk': '{ not json', 'wrong-id': JSON.stringify({ version: 1, sessionId: 'other', pid: 1, pidStart: 'x', leases: {} }),
    'no-leases': JSON.stringify({ version: 1, sessionId: 'no-leases', pid: 1, pidStart: 'x' }),
    'bad-lease': JSON.stringify({ version: 1, sessionId: 'bad-lease', pid: 1, pidStart: 'x', leases: { [w.root]: { repoId: 'a/b' } } }),
    'future': JSON.stringify({ version: 2, sessionId: 'future', pid: 1, pidStart: 'x', leases: {} }),
  };
  for (const [id, body] of Object.entries(bad)) fs.writeFileSync(path.join(w.dir, `${id}.json`), body);
  const scan = w.scan({ now: T0 + 100 * HOUR });
  assert.deepEqual(scan.unreadable.map((u) => u.sessionId).sort(), Object.keys(bad).sort());
  assert.deepEqual(scan.dead, []);
  assert.equal(blocking(scan).length, Object.keys(bad).length, 'blocking() counts every unreadable file');
  const r = await sweepDeadLeases(w.as(null, { now: T0 + 100 * HOUR }));
  assert.deepEqual(r.removed, []);
  assert.deepEqual(files(w.dir).sort(), Object.keys(bad).map((n) => `${n}.json`).sort(), 'nothing was removed');
});

test('a lease file that is a symlink is unreadable (live), POSIX only', { skip: process.platform === 'win32' }, async (t) => {
  const w = world(t);
  fs.mkdirSync(w.dir, { recursive: true });
  const target = path.join(w.root, 'elsewhere.json');
  fs.writeFileSync(target, JSON.stringify({ version: 1, sessionId: 'sym', pid: null, pidStart: null, leases: {} }));
  fs.symlinkSync(target, path.join(w.dir, 'sym.json'));
  const scan = w.scan();
  assert.equal(scan.unreadable.length, 1);
  assert.match(scan.unreadable[0].why, /not a regular file/);
  // Our own session id behind a symlink: open refuses to write through it.
  w.session(500, 'sym');
  await assert.rejects(open(w, 500, w.wt('a')), (e) => e.code === 'review-lease-unwritable');
  assert.equal(fs.readFileSync(target, 'utf8').includes('"leases":{}'), true, 'the link target was not rewritten');
});

test('ps that cannot answer, or a missing session record for a running pid, keeps the lease live until the TTL', async (t) => {
  const w = world(t);
  w.session(500, 'sess-one');
  await open(w, 500, w.wt('a'));
  const noPs = w.scan({ starts: () => null });
  assert.equal(noPs.live.length, 1);
  assert.match(noPs.live[0].why, /ps unavailable/);
  assert.equal(w.scan({ starts: () => null, now: T0 + 7 * HOUR }).live.length, 0, 'but not past the TTL');
  w.records.delete(500);
  const noRecord = w.scan();
  assert.equal(noRecord.live.length, 1);
  assert.match(noRecord.live[0].why, /record is missing/);
});

test('a TTL-only lease (CLAUDECODE=1, session lookup fails) is live for 6 h after its last renewal, then dead', async (t) => {
  const w = world(t);
  const wt = w.wt('a');
  const r = await open(w, 500, wt, { opts: { sessionRecord: () => null } });
  assert.equal(r.ttlOnly, true);
  assert.match(r.sessionId, /^ttl-/);
  const rec = readFile(w.dir, r.sessionId);
  assert.equal(rec.pid, null);
  assert.equal(rec.pidStart, null);
  assert.equal(rec.ttlOnly, true);
  assert.equal(w.scan({ now: T0 + 5 * HOUR }).live.length, 1);
  assert.equal(w.scan({ now: T0 + 7 * HOUR }).live.length, 0);
  assert.equal((await sweepDeadLeases(w.as(null, { now: T0 + 7 * HOUR }))).removed.length, 1);
  assert.deepEqual(files(w.dir), []);
  // Without any Claude ancestor (a detached job with CLAUDECODE=1) it is TTL-only too, and closes by the same stable id.
  const job = await openOrRenewLease({ worktree: wt, repoId: 'acme/app', pr: 7, ...w.as(null) });
  assert.equal(job.ttlOnly, true);
  assert.equal((await closeLease({ worktree: wt, ...w.as(null) })).closed, true);
});

test('a session whose process is gone stays live while a detached job runs in its worktree (and is not swept)', async (t) => {
  const w = world(t);
  w.session(500, 'sess-one');
  const wt = w.wt('a');
  await open(w, 500, wt);
  w.procs.delete(500);
  assert.equal(w.scan().live.length, 0);
  w.jobs.add(wt);
  const scan = w.scan();
  assert.equal(scan.live.length, 1);
  assert.match(scan.live[0].why, /detached job/);
  assert.deepEqual((await sweepDeadLeases(w.as(null))).removed, []);
  assert.equal(w.scan({ now: T0 + 7 * HOUR }).live.length, 1, 'a running job keeps it live past the TTL too (R1-B2)');
  w.jobs.delete(wt);
  assert.equal(w.scan({ now: T0 + 7 * HOUR }).live.length, 0, 'once the job is gone the TTL applies');
});

test('sweep prunes only the dead leases of a holder that has live ones, and re-judges under the lock', async (t) => {
  const w = world(t);
  w.session(500, 'sess-one');
  const [x, y] = [w.wt('x'), w.wt('y')];
  await open(w, 500, x);
  w.now = T0 + 5 * HOUR;
  await open(w, 500, y, { pr: 8 });
  const r = await sweepDeadLeases(w.as(null, { now: T0 + 7 * HOUR }));
  assert.deepEqual(r.removed.map((e) => e.worktree), [x]);
  assert.deepEqual(Object.keys(readFile(w.dir, 'sess-one').leases), [y]);
});

test('sweep removes stale temp files and an empty holder file', async (t) => {
  const w = world(t);
  fs.mkdirSync(w.dir, { recursive: true });
  const tmpFile = path.join(w.dir, 'x.json.1.abcd.tmp');
  fs.writeFileSync(tmpFile, '{');
  fs.utimesSync(tmpFile, new Date(T0 - HOUR), new Date(T0 - HOUR));
  fs.writeFileSync(path.join(w.dir, 'empty.json'), JSON.stringify({ version: 1, sessionId: 'empty', pid: null, pidStart: null, leases: {} }));
  await sweepDeadLeases(w.as(null));
  assert.deepEqual(fs.readdirSync(w.dir), []);
});

test('a plain terminal (no Claude ancestor, no CLAUDECODE) writes no lease and creates no folder', async (t) => {
  const w = world(t);
  const wt = w.wt('a');
  const plain = w.as(null, { env: {} });
  assert.deepEqual(await openOrRenewLease({ worktree: wt, repoId: 'acme/app', pr: 7, ...plain }), { skipped: 'no-session' });
  assert.deepEqual(await closeLease({ worktree: wt, ...plain }), { skipped: 'no-session' });
  assert.equal(fs.existsSync(w.dir), false);
  assert.equal(fs.existsSync(path.join(w.home, '.claude')), false);
});

// ---- admission ---------------------------------------------------------------------------------------------------------------------------

test('admission held: open waits, then errors with the coded message and writes nothing; once released it proceeds', async (t) => {
  const w = world(t);
  w.session(500, 'sess-one');
  const lock = await acquireAdmission({ dir: w.dir, home: w.home });
  t.after(() => { try { releaseAdmission(lock); } catch { /* already released */ } });
  assert.equal(lock.name, ADMISSION_LOCK);
  const t0 = Date.now();
  await assert.rejects(open(w, 500, w.wt('a'), { opts: { waitMs: 250 } }), (e) => {
    assert.equal(e.code, 'update-in-progress');
    assert.equal(e.message, UPDATE_IN_PROGRESS);
    assert.equal(e.message, 'pipeline update in progress, retry in a minute');
    return true;
  });
  assert.ok(Date.now() - t0 >= 200, 'it waited before giving up');
  assert.deepEqual(files(w.dir), []);
  // A wait that outlasts the installer succeeds right after the release.
  setTimeout(() => releaseAdmission(lock), 150);
  const r = await open(w, 500, w.wt('a'), { opts: { waitMs: 5000 } });
  assert.equal(r.action, 'opened');
});

test('closing a lease does not wait for admission (ending a review never fails because an update is running)', async (t) => {
  const w = world(t);
  w.session(500, 'sess-one');
  const wt = w.wt('a');
  await open(w, 500, wt);
  const lock = await acquireAdmission({ dir: w.dir, home: w.home });
  t.after(() => releaseAdmission(lock));
  assert.equal((await closeLease({ worktree: wt, ...w.as(500) })).closed, true);
});

test('withAdmission runs fn holding the lock, releases it on success and on error; a held lock gives the coded error', async (t) => {
  const w = world(t);
  const o = { dir: w.dir, home: w.home, waitMs: 150 };
  assert.equal(await withAdmission(async () => {
    await assert.rejects(withAdmission(() => 'nested', o), (e) => e.code === 'update-in-progress');
    return 'ok';
  }, o), 'ok');
  await assert.rejects(withAdmission(() => { throw new Error('boom'); }, o), /boom/);
  assert.equal(await withAdmission(() => 'free again', o), 'free again');
});

test('two accounts (different CLAUDE_CONFIG_DIR, PIPELINE_LOCK_DIR) share ONE admission lock, because it lives under the account home', async (t) => {
  const home = path.join(tmp(t), 'home');
  fs.mkdirSync(home, { recursive: true });
  const a = { home, env: { CLAUDE_CONFIG_DIR: path.join(home, '.claude'), PIPELINE_LOCK_DIR: path.join(home, 'locks-a') }, waitMs: 150 };
  const b = { home, env: { CLAUDE_CONFIG_DIR: path.join(home, '.claude-eaglewatch'), PIPELINE_LOCK_DIR: path.join(home, 'locks-b') }, waitMs: 150 };
  const lock = await acquireAdmission(a);
  t.after(() => releaseAdmission(lock));
  assert.equal(lock.path, path.join(home, '.claude', 'pipeline-state', 'owner-go', 'review-leases', 'admission.lock'));
  await assert.rejects(acquireAdmission(b), (e) => e.code === 'update-in-progress');
  assert.equal(fs.existsSync(path.join(home, 'locks-a')) || fs.existsSync(path.join(home, 'locks-b')), false, 'PIPELINE_LOCK_DIR is never used');
});

test('the folder is created through the real-directory chain; a symlinked level is refused (POSIX only)', { skip: process.platform === 'win32' }, async (t) => {
  for (const level of ['pipeline-state', 'owner-go', 'review-leases']) {
    const root = tmp(t);
    const home = path.join(root, 'home');
    const elsewhere = path.join(root, 'elsewhere');
    fs.mkdirSync(elsewhere, { recursive: true });
    const parts = ['.claude', 'pipeline-state', 'owner-go', 'review-leases'];
    const at = parts.indexOf(level);
    fs.mkdirSync(path.join(home, ...parts.slice(0, at)), { recursive: true });
    fs.symlinkSync(elsewhere, path.join(home, ...parts.slice(0, at + 1)));
    const world1 = { home, env: { CLAUDECODE: '1' }, ancestorPid: 500, now: T0, starts: () => new Map([[500, START_A]]), sessionRecord: () => ({ sessionId: 'sess-one', procStart: START_A }), jobLive: () => false };
    await assert.rejects(openOrRenewLease({ worktree: root, repoId: 'a/b', pr: 1, ...world1 }), (e) => e.code === 'review-lease-unwritable', level);
    await assert.rejects(acquireAdmission({ home, waitMs: 50 }), (e) => e.code === 'review-lease-unwritable', `admission, ${level}`);
    assert.deepEqual(fs.readdirSync(elsewhere), [], `nothing written through the ${level} link`);
  }
});

test('on the account home the folder and the holder file are created with real directories', async (t) => {
  const w = world(t);
  w.session(500, 'sess-one');
  const wt = w.wt('a');
  const o = w.as(500);
  delete o.dir; // the standard location under the injected home
  await openOrRenewLease({ worktree: wt, repoId: 'a/b', pr: 3, ...o });
  const dir = path.join(w.home, '.claude', 'pipeline-state', 'owner-go', 'review-leases');
  for (const p of [path.join(w.home, '.claude'), path.join(w.home, '.claude', 'pipeline-state'), path.join(w.home, '.claude', 'pipeline-state', 'owner-go'), dir]) {
    assert.equal(fs.lstatSync(p).isDirectory(), true, p);
  }
  assert.deepEqual(files(dir), ['sess-one.json']);
  assert.equal(scanLeases({ ...o }).live.length, 1);
});
