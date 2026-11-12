// Process and job holders for review leases (plan 2026-11-12 terminal leases, step 1, library half; revision 4 items R4-2 .. R4-5).
// A pipeline command typed in a plain terminal (no Claude ancestor, no CLAUDECODE) now holds a lease of its own, in a version-2 file
// proc-<pid>-<8 hex>.json; a job-scoped lease it must leave behind moves into one shared job-<hash>.json. Everything about the machine is injected
// (ps answers, the pid probe, running jobs), so these tests are deterministic and never read the real process table, except the
// resolveHolder cases that exercise the real memoised holder of THIS process through an injected ps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as L from '../pipeline/lib/review-lease.mjs';
import * as OLD from './fixtures/review-lease-4ab8df4.mjs';
import { canonicalPath } from '../pipeline/lib/paths.mjs';

const { blocking, closeLease, holderHandoff, openOrRenewLease, resolveHolder, scanLeases, sweepDeadLeases, liveJobIn } = L;

process.env.PIPELINE_MACHINE_ID ||= 'test-machine-id';
const HOUR = 3600_000;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 10, 12, 8, 0, 0);
const START = 'Thu Nov 12 07:00:00 2026';
const START_B = 'Thu Nov 12 07:30:00 2026';
const tmp = (t) => {
  const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cp-lease-proc-')));
  t.after(() => { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 3 }); } catch { /* ignore */ } });
  return d;
};
const esrch = () => Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });

function world(t) {
  const root = tmp(t);
  const w = {
    root, dir: path.join(root, 'review-leases'), home: path.join(root, 'home'), now: T0,
    procs: new Map(), alive: new Set(), jobs: new Set(),
    wt: (name) => { const d = path.join(root, name); fs.mkdirSync(d, { recursive: true }); return d; },
    opts(extra = {}) {
      return {
        dir: w.dir, home: w.home, env: {}, ancestorPid: null, now: w.now,
        starts: (pids) => new Map(pids.filter((p) => w.procs.has(p)).map((p) => [p, w.procs.get(p)])),
        kill: (pid) => { if (!w.alive.has(pid)) throw esrch(); },
        jobLive: (wt) => w.jobs.has(wt), ...extra,
      };
    },
    // A fake terminal process: running, with a start time; returns the injected holder.
    proc(pid, hex = '0123abcd', start = START) {
      w.procs.set(pid, start);
      w.alive.add(pid);
      return { sessionId: `proc-${pid}-${hex}`, pid, pidStart: start };
    },
    as(holder, extra = {}) { return w.opts({ processHolder: holder, ...extra }); },
    scan(extra = {}) { return scanLeases(w.opts(extra)); },
  };
  fs.mkdirSync(w.home, { recursive: true });
  return w;
}
const open = (w, holder, wt, extra = {}) => openOrRenewLease({ worktree: wt, repoId: 'acme/app', pr: 7, command: 'codex-review', ...extra, ...w.as(holder, extra.opts) });
const files = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort() : []);
const readJson = (dir, id) => JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf8'));
const jobIdOf = (wt) => `job-${createHash('sha256').update(canonicalPath(wt)).digest('hex').slice(0, 16)}`;
const putFile = (dir, id, body) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, `${id}.json`), typeof body === 'string' ? body : JSON.stringify(body)); };
const LEASE = { repoId: 'acme/app', pr: 7, generation: 'g1', openedAt: new Date(T0).toISOString(), renewedAt: new Date(T0).toISOString(), command: 'codex-review' };
const procBody = (pid = 4242, hex = '0123abcd', wt = '/work/a', extra = {}) => ({
  version: 2, holder: 'process', sessionId: `proc-${pid}-${hex}`, pid, pidStart: START, host: os.hostname(), machineId: 'test-machine-id', leases: { [wt]: { ...LEASE } }, ...extra,
});
const jobBody = (wt = '/work/a', extra = {}) => ({ version: 2, holder: 'job', host: os.hostname(), machineId: 'test-machine-id', leases: { [wt]: { ...LEASE, jobOnly: true } }, ...extra });

// ---- resolveHolder -----------------------------------------------------------------------------------------------------------------------

test('resolveHolder: a plain process (no Claude ancestor, no CLAUDECODE) is a process holder with a start time from ps, memoised per process', (t) => {
  L._resetProcessHolderForTests?.();
  t.after(() => L._resetProcessHolderForTests?.());
  const w = world(t);
  w.procs.set(process.pid, START);
  const h = resolveHolder({ worktree: w.root, ...w.opts() });
  assert.deepEqual({ ...h, sessionId: undefined }, { kind: 'process', sessionId: undefined, pid: process.pid, pidStart: START });
  assert.match(h.sessionId, new RegExp(`^proc-${process.pid}-[0-9a-f]{8}$`));
  assert.equal(resolveHolder({ worktree: path.join(w.root, 'other'), ...w.opts() }).sessionId, h.sessionId, 'one id per process, whatever the worktree');
  assert.deepEqual(holderHandoff({ worktree: w.root, ...w.opts() }), {}, 'a job started from a terminal derives its own process holder');
  for (const env of [{}, { CLAUDECODE: '0' }]) assert.equal(resolveHolder({ worktree: w.root, ...w.opts({ env }) }).kind, 'process');
  assert.equal(resolveHolder({ worktree: w.root, ...w.opts({ env: { CLAUDECODE: '1' } }) }).kind, 'ttl', 'CLAUDECODE=1 keeps the TTL-only holder');
});

test('resolveHolder: no pidStart when ps is unavailable, answers without our own pid (canary), or is asked through a real-shaped run', (t) => {
  L._resetProcessHolderForTests?.();
  t.after(() => L._resetProcessHolderForTests?.());
  const w = world(t);
  assert.equal(resolveHolder({ worktree: w.root, ...w.opts({ starts: () => null }) }).pidStart, null, 'ps unavailable');
  assert.equal(resolveHolder({ worktree: w.root, ...w.opts() }).pidStart, null, 'the answer lacks our own pid');
  // The real psStarts path: `ps -o pid=,lstart=` rejected by a ps that exits 1 with no output reads as "none run" -> the canary makes it unavailable.
  const rejecting = { starts: undefined, psRun: () => ({ status: 1, signal: null, error: null, stdout: '' }) };
  assert.equal(resolveHolder({ worktree: w.root, ...w.opts(rejecting) }).pidStart, null);
  const listing = { starts: undefined, psRun: () => ({ status: 0, signal: null, error: null, stdout: `  ${process.pid} Thu Nov 12 07:00:00 2026\n` }) };
  assert.equal(resolveHolder({ worktree: w.root, ...w.opts(listing) }).pidStart, START);
});

test('resolveHolder: the injectable seam processHolder:false still gives kind none', (t) => {
  const w = world(t);
  assert.deepEqual(resolveHolder({ worktree: w.root, ...w.opts({ processHolder: false }) }), { kind: 'none' });
  const h = resolveHolder({ worktree: w.root, ...w.as(w.proc(77)) });
  assert.deepEqual(h, { kind: 'process', sessionId: 'proc-77-0123abcd', pid: 77, pidStart: START });
});

// ---- version-2 files ---------------------------------------------------------------------------------------------------------------------

test('open writes a version-2 process file with host, machine id, command; a renew keeps the generation and updates the command', async (t) => {
  const w = world(t);
  const p = w.proc(4242);
  const wt = w.wt('a');
  const r = await open(w, p, wt);
  assert.equal(r.action, 'opened');
  assert.equal(r.sessionId, p.sessionId);
  assert.deepEqual(files(w.dir), ['proc-4242-0123abcd.json']);
  const rec = readJson(w.dir, p.sessionId);
  assert.deepEqual({ ...rec, leases: undefined }, { version: 2, holder: 'process', sessionId: p.sessionId, pid: 4242, pidStart: START, host: os.hostname(), machineId: 'test-machine-id', leases: undefined });
  assert.equal(rec.leases[canonicalPath(wt)].command, 'codex-review');
  assert.equal((await open(w, p, wt, { command: 'merge' })).action, 'renewed');
  assert.equal(readJson(w.dir, p.sessionId).leases[canonicalPath(wt)].command, 'merge');
  await assert.rejects(open(w, p, wt, { command: 'Bad Command' }), { code: 'review-lease-args' });
  await assert.rejects(open(w, p, wt, { command: 'a'.repeat(33) }), { code: 'review-lease-args' });
});

test('a session lease records command too, and a v1 file with a command still reads', async (t) => {
  const w = world(t);
  const opts = w.opts({ env: { CLAUDECODE: '1' }, ancestorPid: 500, sessionRecord: () => ({ sessionId: 'sess-one', procStart: START }) });
  w.procs.set(500, START);
  await openOrRenewLease({ worktree: w.wt('a'), repoId: 'acme/app', pr: 7, command: 'ci-wait', ...opts });
  const rec = readJson(w.dir, 'sess-one');
  assert.equal(rec.version, 1);
  assert.equal(Object.values(rec.leases)[0].command, 'ci-wait');
  assert.equal(w.scan().live[0].command, 'ci-wait');
});

test('readHolder accepts v2 only with the exact shapes and id prefixes; everything else is unreadable (live), command syntax enforced for every version', (t) => {
  const w = world(t);
  const bad = {
    'proc-4242-0123abcd': procBody(4242, '0123abcd', '/work/a', { holder: 'session' }),
    'proc-4243-0123abcd': procBody(4242, '0123abcd', '/work/a'), // id names pid 4243, body says 4242
    'proc-4244-0123abcd': procBody(4244, '0123abcd', '/work/a', { host: undefined }),
    'proc-4245-0123abcd': procBody(4245, '0123abcd', '/work/a', { pid: 'x' }),
    'proc-4246-0123abcd': { ...procBody(4246, '0123abcd'), leases: { '/work/a': { ...LEASE, command: 'Bad Cmd' } } },
    'proc-4247-0123abcd': { ...procBody(4247, '0123abcd'), version: 3 },
    'proc-4248-zzzzzzzz': procBody(4248, 'zzzzzzzz'),
    'job-0123456789abcdef': jobBody('/work/a', { holder: 'process' }),
    'job-0123456789abcde0': { ...jobBody(), leases: { '/work/a': { ...LEASE } } }, // a job file holds job-scoped leases only
    'job-0123456789abcde1': jobBody('/work/a', { pid: 5 }),
    'job-short': jobBody(),
    'sess-v2': { version: 2, holder: 'session', sessionId: 'sess-v2', pid: null, pidStart: null, leases: {} },
    'sess-v1c': { version: 1, sessionId: 'sess-v1c', pid: null, pidStart: null, leases: { '/work/a': { ...LEASE, command: 'x'.repeat(40) } } },
  };
  for (const [id, body] of Object.entries(bad)) putFile(w.dir, id, body);
  putFile(w.dir, 'proc-4249-0123abcd', procBody(4249));
  putFile(w.dir, 'job-0123456789abcde2', jobBody());
  putFile(w.dir, 'sess-ok', { version: 1, sessionId: 'sess-ok', pid: null, pidStart: null, ttlOnly: true, leases: { '/work/a': { ...LEASE } } });
  const scan = w.scan();
  assert.deepEqual(scan.unreadable.map((u) => u.sessionId).sort(), Object.keys(bad).sort());
  assert.ok(scan.live.some((e) => e.sessionId === 'sess-ok'));
  assert.ok(scan.live.some((e) => e.sessionId === 'job-0123456789abcde2') || scan.dead.some((e) => e.sessionId === 'job-0123456789abcde2'), 'a good job file is read');
  assert.ok([...scan.live, ...scan.dead].some((e) => e.sessionId === 'proc-4249-0123abcd'), 'a good process file is read');
});

// ---- the judge ---------------------------------------------------------------------------------------------------------------------------

test('judge: a process whose pid runs with the recorded start is LIVE at any age and with the clock set days forward', async (t) => {
  const w = world(t);
  const p = w.proc(4242);
  await open(w, p, w.wt('a'));
  for (const skew of [0, 7 * DAY, 400 * DAY]) {
    const scan = w.scan({ now: T0 + skew });
    assert.equal(scan.live.length, 1, `skew ${skew}`);
    const e = scan.live[0];
    assert.match(e.why, /^terminal process 4242 running pipeline codex-review since 2026-11-12T08:00:00/);
    assert.equal(e.unchecked, undefined);
    assert.deepEqual({ holder: e.holder, pid: e.pid, command: e.command }, { holder: 'process', pid: 4242, command: 'codex-review' });
  }
  assert.deepEqual((await sweepDeadLeases(w.opts({ now: T0 + 30 * DAY }))).removed, []);
  assert.equal(files(w.dir).length, 1);
});

test('judge: dead when ps shows the pid gone, or running with another start (reused); dead leases are swept', async (t) => {
  const w = world(t);
  const gone = w.proc(4242);
  const reused = w.proc(4243, '1111aaaa');
  await open(w, gone, w.wt('a'));
  await open(w, reused, w.wt('b'));
  w.procs.delete(4242);
  w.procs.set(4243, START_B);
  const scan = w.scan();
  assert.equal(scan.live.length, 0);
  assert.equal(scan.dead.length, 2);
  assert.match(scan.dead.find((e) => e.pid === 4242).why, /terminal process 4242 is gone/);
  assert.match(scan.dead.find((e) => e.pid === 4243).why, /pid 4243 was reused/);
  const swept = await sweepDeadLeases(w.opts());
  assert.equal(swept.removed.length, 2);
  assert.deepEqual(files(w.dir), []);
});

test('judge: ESRCH from kill(pid, 0) is dead even with ps stubbed away; alive-by-kill with no usable start is UNCERTAIN, never dead by age, never swept', async (t) => {
  const w = world(t);
  const p = w.proc(4242);
  await open(w, p, w.wt('a'));
  const noPs = { starts: () => null };
  // Alive by kill, ps unavailable: uncertain.
  const scan = w.scan(noPs);
  assert.equal(scan.dead.length, 0);
  const e = scan.live[0];
  assert.equal(e.unchecked, true);
  assert.match(e.why, /cannot confirm that terminal process 4242 \(pipeline codex-review\) has ended: ps unavailable/);
  assert.equal(e.hint, `delete ${path.join(w.dir, `${p.sessionId}.json`)} if no pipeline command is running in a terminal`);
  assert.deepEqual(blocking(scan).map((b) => [b.unchecked, b.hint, b.command, b.holder, b.pid]), [[true, e.hint, 'codex-review', 'process', 4242]]);
  // Not swept at any age.
  const swept = await sweepDeadLeases(w.opts({ ...noPs, now: T0 + 90 * DAY }));
  assert.deepEqual(swept.removed, []);
  assert.equal(files(w.dir).length, 1);
  // The pid is gone: ESRCH is enough, no ps needed.
  w.alive.delete(4242);
  assert.equal(w.scan(noPs).dead.length, 1);
  assert.match(w.scan(noPs).dead[0].why, /no longer exists/);
  assert.equal((await sweepDeadLeases(w.opts(noPs))).removed.length, 1);
  assert.deepEqual(files(w.dir), []);
});

test('judge: ps answers but the lease has no recorded start (pidStart null) -> uncertain while the pid runs, dead once it is gone', async (t) => {
  const w = world(t);
  const p = { ...w.proc(4242), pidStart: null };
  await open(w, p, w.wt('a'));
  assert.equal(readJson(w.dir, p.sessionId).pidStart, null);
  const e = w.scan().live[0];
  assert.equal(e.unchecked, true);
  assert.match(e.why, /no start time was recorded/);
  w.procs.delete(4242);
  assert.equal(w.scan().dead.length, 1, 'ps says the pid is gone');
});

test('judge: a process holder from another host / machine is uncertain (never judged by local ps), whatever its pid does here', (t) => {
  const w = world(t);
  w.proc(4242);
  putFile(w.dir, 'proc-4242-0123abcd', procBody(4242, '0123abcd', '/work/a', { host: 'other-box', machineId: 'other-machine-id' }));
  const e = w.scan().live[0];
  assert.equal(e.unchecked, true);
  assert.match(e.why, /other-box/);
  assert.match(e.hint, /^delete .*proc-4242-0123abcd\.json if no pipeline command is running in a terminal$/);
  // The same machine id under another hostname is the same machine.
  putFile(w.dir, 'proc-4242-0123abcd', procBody(4242, '0123abcd', '/work/a', { host: 'renamed-box', machineId: 'test-machine-id' }));
  assert.equal(w.scan().live[0].unchecked, undefined);
});

test('judge: jobOnly and job-holder leases go to the job rule ONLY, first (a running process does not keep them)', async (t) => {
  const w = world(t);
  const wt = w.wt('a');
  w.proc(4242);
  const wtKey = canonicalPath(wt);
  putFile(w.dir, 'proc-4242-0123abcd', procBody(4242, '0123abcd', wtKey, { leases: { [wtKey]: { ...LEASE, jobOnly: true } } }));
  putFile(w.dir, jobIdOf(wt), jobBody(wtKey));
  let scan = w.scan();
  assert.equal(scan.live.length, 0, 'no job runs: both dead although pid 4242 runs');
  assert.equal(scan.dead.length, 2);
  w.jobs.add(wt);
  scan = w.scan();
  assert.equal(scan.live.length, 2);
  assert.equal(scan.live.every((e) => /detached job is still running/.test(e.why)), true);
  w.jobs.delete(wt);
  const swept = await sweepDeadLeases(w.opts());
  assert.equal(swept.removed.length, 2);
  assert.deepEqual(files(w.dir), []);
});

// ---- closing -----------------------------------------------------------------------------------------------------------------------------

test('close with no job removes the process file; a stale generation is ignored', async (t) => {
  const w = world(t);
  const p = w.proc(4242);
  const wt = w.wt('a');
  const { generation } = await open(w, p, wt);
  assert.deepEqual(await closeLease({ worktree: wt, generation: 'other', ...w.as(p) }), { closed: false, why: 'stale-generation' });
  assert.deepEqual(await closeLease({ worktree: wt, generation, ...w.as(p) }), { closed: true, sessionId: p.sessionId });
  assert.deepEqual(files(w.dir), []);
  assert.deepEqual(await closeLease({ worktree: wt, ...w.as(p) }), { closed: false, why: 'absent' });
});

test('close while a job runs MOVES the lease into the shared job-<hash> file; two terminal commands leave one file', async (t) => {
  const w = world(t);
  const wt = w.wt('a');
  const p1 = w.proc(4242);
  const p2 = w.proc(4243, '2222bbbb');
  const g1 = (await open(w, p1, wt)).generation;
  const g2 = (await open(w, p2, wt, { command: 'merge' })).generation;
  assert.deepEqual(files(w.dir), ['proc-4242-0123abcd.json', 'proc-4243-2222bbbb.json']);
  w.jobs.add(wt);
  const c1 = await closeLease({ worktree: wt, generation: g1, ...w.as(p1) });
  assert.equal(c1.closed, true);
  assert.equal(c1.jobRunning, true);
  const c2 = await closeLease({ worktree: wt, generation: g2, ...w.as(p2) });
  assert.equal(c2.jobRunning, true);
  assert.deepEqual(files(w.dir), [`${jobIdOf(wt)}.json`], 'both proc files are gone, one job file remains');
  const rec = readJson(w.dir, jobIdOf(wt));
  assert.deepEqual({ version: rec.version, holder: rec.holder, host: rec.host, machineId: rec.machineId, pid: rec.pid, sessionId: rec.sessionId }, { version: 2, holder: 'job', host: os.hostname(), machineId: 'test-machine-id', pid: undefined, sessionId: undefined });
  assert.equal(Object.keys(rec.leases).length, 1);
  assert.equal(rec.leases[canonicalPath(wt)].jobOnly, true);
  assert.equal(w.scan().live.length, 1);
  assert.equal(w.scan().live[0].holder, 'job');
  w.jobs.clear();
  assert.equal((await sweepDeadLeases(w.opts())).removed.length, 1);
  assert.deepEqual(files(w.dir), []);
});

test('closeLeaseSync: removes the file without a lock; keeps a job-scoped lease by moving it; ignores a stale generation', async (t) => {
  const w = world(t);
  assert.equal(typeof L.closeLeaseSync, 'function');
  const wt = w.wt('a');
  const p = w.proc(4242);
  const { generation } = await open(w, p, wt);
  assert.deepEqual(L.closeLeaseSync({ worktree: wt, generation: 'nope', ...w.as(p) }), { closed: false, why: 'stale-generation' });
  assert.deepEqual(L.closeLeaseSync({ worktree: wt, generation, ...w.as(p) }), { closed: true, sessionId: p.sessionId });
  assert.deepEqual(files(w.dir), []);
  assert.deepEqual(L.closeLeaseSync({ worktree: wt, ...w.as(p) }), { closed: false, why: 'absent' });
  // Job running: moved into the job file.
  const g2 = (await open(w, p, wt)).generation;
  w.jobs.add(wt);
  const r = L.closeLeaseSync({ worktree: wt, generation: g2, ...w.as(p) });
  assert.equal(r.closed, true);
  assert.equal(r.jobRunning, true);
  assert.deepEqual(files(w.dir), [`${jobIdOf(wt)}.json`]);
  assert.equal(readJson(w.dir, jobIdOf(wt)).holder, 'job');
});

test('closeLeaseSync: when the job file cannot be locked it keeps its own proc file with the lease marked jobOnly (judged by the job rule only)', async (t) => {
  const w = world(t);
  const wt = w.wt('a');
  const p = w.proc(4242);
  const g = (await open(w, p, wt)).generation;
  w.jobs.add(wt);
  // Hold the job file's lock the way another closer would.
  const { tryAcquire, release } = await import('../pipeline/lib/locks.mjs');
  const held = tryAcquire(`lease-${jobIdOf(wt)}`, { dir: w.dir, machineId: 'test-machine-id' });
  assert.equal(held.acquired, true);
  try {
    const r = L.closeLeaseSync({ worktree: wt, generation: g, ...w.as(p), jobLockWaitMs: 50 });
    assert.equal(r.closed, true);
    assert.equal(r.jobRunning, true);
  } finally { release(held.lock); }
  assert.ok(files(w.dir).includes(`${p.sessionId}.json`));
  assert.equal(readJson(w.dir, p.sessionId).leases[canonicalPath(wt)].jobOnly, true);
  w.jobs.clear();
  assert.equal((await sweepDeadLeases(w.opts())).removed.length, 1);
  assert.deepEqual(files(w.dir), []);
});

test('sweepDeadLeases({ only }) touches proc-/job- files only', async (t) => {
  const w = world(t);
  const p = w.proc(4242);
  await open(w, p, w.wt('a'));
  putFile(w.dir, 'sess-dead', { version: 1, sessionId: 'sess-dead', pid: null, pidStart: null, ttlOnly: true, leases: { '/work/x': { ...LEASE, renewedAt: new Date(T0 - 30 * DAY).toISOString() } } });
  w.alive.delete(4242);
  w.procs.delete(4242);
  const swept = await sweepDeadLeases(w.opts({ only: ['proc-', 'job-'] }));
  assert.deepEqual(swept.removed.map((e) => e.sessionId), [p.sessionId]);
  assert.deepEqual(files(w.dir), ['sess-dead.json']);
  assert.equal((await sweepDeadLeases(w.opts())).removed.length, 1);
});

// ---- #259: an unreadable jobs folder -----------------------------------------------------------------------------------------------------

test('liveJobIn: true | false | { unreadable: code }; ENOENT / ENOTDIR are "no jobs"', (t) => {
  const root = tmp(t);
  assert.equal(liveJobIn(path.join(root, 'nothing-here')), false, 'ENOENT');
  fs.mkdirSync(path.join(root, 'plain'));
  fs.writeFileSync(path.join(root, 'plain', '.review'), 'a file, not a folder');
  assert.equal(liveJobIn(path.join(root, 'plain')), false, 'ENOTDIR');
  fs.mkdirSync(path.join(root, 'empty', '.review', 'jobs'), { recursive: true });
  assert.equal(liveJobIn(path.join(root, 'empty')), false);
  if (process.platform === 'win32' || (process.getuid && process.getuid() === 0)) return;
  const jobs = path.join(root, 'locked', '.review', 'jobs');
  fs.mkdirSync(jobs, { recursive: true });
  fs.chmodSync(jobs, 0o000);
  // restore in the body, not in t.after: on Node 20 tmp(t)'s cleanup can run first and remove the folder
  try { assert.deepEqual(liveJobIn(path.join(root, 'locked')), { unreadable: 'EACCES' }); } finally { fs.chmodSync(jobs, 0o700); }
});

test('an unreadable jobs folder keeps a dead lease live, unchecked, with a distinct reason; close says jobRunning unknown; the sweep keeps it', async (t) => {
  const w = world(t);
  const wt = w.wt('a');
  const p = w.proc(4242);
  const g = (await open(w, p, wt)).generation;
  w.procs.delete(4242); // the process is gone, so only the job rule can keep it
  const unreadable = { jobLive: () => ({ unreadable: 'EACCES' }) };
  const e = w.scan(unreadable).live[0];
  assert.equal(e.unchecked, true);
  assert.match(e.why, /; the jobs folder .*jobs cannot be read \(EACCES\), treated as a running job$/);
  assert.deepEqual((await sweepDeadLeases(w.opts(unreadable))).removed, []);
  // Throwing jobLive counts as unreadable ('error'), not as "no job".
  const thrown = w.scan({ jobLive: () => { throw new Error('boom'); } }).live[0];
  assert.equal(thrown.unchecked, true);
  assert.match(thrown.why, /cannot be read \(error\), treated as a running job/);
  // Close with the unreadable folder: kept (moved to the job file), reported unknown.
  w.procs.set(4242, START);
  const c = await closeLease({ worktree: wt, generation: g, ...w.as(p, unreadable) });
  assert.deepEqual({ closed: c.closed, jobRunning: c.jobRunning }, { closed: true, jobRunning: 'unknown' });
  assert.deepEqual(files(w.dir), [`${jobIdOf(wt)}.json`]);
  assert.equal(w.scan(unreadable).live[0].unchecked, true);
  assert.equal(w.scan().live.length, 0, 'once the folder reads clean and no job runs, the lease is dead');
});

test('a session close with an unreadable jobs folder keeps the lease jobOnly and says unknown', async (t) => {
  const w = world(t);
  w.procs.set(500, START);
  const sess = w.opts({ env: { CLAUDECODE: '1' }, ancestorPid: 500, sessionRecord: () => ({ sessionId: 'sess-one', procStart: START }), jobLive: () => ({ unreadable: 'EIO' }) });
  const wt = w.wt('a');
  const { generation } = await openOrRenewLease({ worktree: wt, repoId: 'acme/app', pr: 7, ...sess });
  const c = await closeLease({ worktree: wt, generation, ...sess });
  assert.equal(c.jobRunning, 'unknown');
  assert.equal(readJson(w.dir, 'sess-one').leases[canonicalPath(wt)].jobOnly, true);
});

// ---- unreadable process / job files ------------------------------------------------------------------------------------------------------

test('an unreadable proc-/job- file is listed with the delete hint and an unchecked marker; other unreadable files are not marked', (t) => {
  const w = world(t);
  putFile(w.dir, 'proc-4242-0123abcd', '{ not json');
  putFile(w.dir, 'job-0123456789abcdef', '{}');
  putFile(w.dir, 'sess-odd', '[]');
  const scan = w.scan();
  const by = Object.fromEntries(scan.unreadable.map((u) => [u.sessionId, u]));
  for (const id of ['proc-4242-0123abcd', 'job-0123456789abcdef']) {
    assert.equal(by[id].unchecked, true);
    assert.equal(by[id].hint, `delete ${path.join(w.dir, `${id}.json`)} if no pipeline command is running in a terminal`);
  }
  assert.equal(by['sess-odd'].unchecked, undefined);
  assert.equal(by['sess-odd'].hint, undefined);
  const b = blocking(scan);
  assert.equal(b.length, 3);
  assert.equal(b.find((x) => x.sessionId === 'proc-4242-0123abcd').unchecked, true);
});

// ---- older readers fail closed -----------------------------------------------------------------------------------------------------------

test('the judge + sweeper of 4ab8df4 read a version-2 process or job file as unreadable (live) and never touch it', async (t) => {
  const w = world(t);
  const p = w.proc(4242);
  const wt = w.wt('a');
  await open(w, p, wt);
  w.jobs.add(wt);
  const p2 = w.proc(4243, '3333cccc');
  await open(w, p2, wt);
  await closeLease({ worktree: wt, ...w.as(p2) }); // moves into the job file
  assert.deepEqual(files(w.dir), [`${jobIdOf(wt)}.json`, p.sessionId + '.json'].sort());
  const before = Object.fromEntries(files(w.dir).map((n) => [n, fs.readFileSync(path.join(w.dir, n), 'utf8')]));
  w.jobs.clear();
  w.alive.clear();
  w.procs.clear(); // everything is dead to a new reader
  const oldOpts = { dir: w.dir, home: w.home, env: {}, now: T0 + 30 * DAY, starts: () => new Map(), jobLive: () => false };
  const scan = OLD.scanLeases(oldOpts);
  assert.deepEqual(scan.unreadable.map((u) => u.sessionId).sort(), Object.keys(before).map((n) => n.replace(/\.json$/, '')).sort());
  assert.equal(OLD.blocking(scan).length, 2, 'unreadable counts as live to the old scan');
  const swept = await OLD.sweepDeadLeases(oldOpts);
  assert.deepEqual(swept.removed, []);
  for (const [n, body] of Object.entries(before)) assert.equal(fs.readFileSync(path.join(w.dir, n), 'utf8'), body, `${n} untouched`);
});
