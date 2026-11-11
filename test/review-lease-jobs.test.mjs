// Review leases and detached `P job`s (plan 2026-11-10 B1; review round 1 items R1-B2 and R1-F1):
//   R1-B2  a lease whose worktree has a live detached job stays live whatever its age (the TTL used to return dead before the job check);
//   R1-F1  a leased command run INSIDE a job (codex-review, ci-wait, merge-hold --wait, merge) has no Claude ancestor but CLAUDECODE=1; `job start`
//          hands the session's identity to the runner (PIPELINE_LEASE_HOLDER), resolveHolder trusts it only after the same session-record + ps checks a
//          direct holder gets, so the job's lease lands in the SESSION's file and summary / ended closes it. A lease closed while a job still runs
//          stays live only until that job ends. A forged or unknown identity falls back to a TTL-only holder.
// Everything about the machine is injected; the job-start wiring test spawns one real detached job. Fake HOME + USERPROFILE.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run as jobCommand } from '../pipeline/commands/job.mjs';
import {
  HOLDER_ENV, LEASE_TTL_MS, blocking, closeLease, holderHandoff, openOrRenewLease, resolveHolder, scanLeases, sweepDeadLeases,
} from '../pipeline/lib/review-lease.mjs';

process.env.PIPELINE_MACHINE_ID ||= 'test-machine-id';
const HOUR = 3600_000;
const T0 = Date.UTC(2026, 10, 11, 12, 0, 0);
const START = 'Wed Nov 11 02:23:52 2026';
const tmp = (t) => {
  const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cp-lease-job-')));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};

function world(t) {
  const root = tmp(t);
  const w = {
    root, dir: path.join(root, 'review-leases'), home: path.join(root, 'home'), now: T0,
    procs: new Map(), records: new Map(), jobs: new Set(),
    wt: (name) => { const d = path.join(root, name); fs.mkdirSync(d, { recursive: true }); return d; },
    // The session itself (a direct command): its Claude ancestor is `pid`.
    as(pid, extra = {}) {
      return {
        dir: w.dir, home: w.home, env: { CLAUDECODE: '1' }, ancestorPid: pid, now: w.now,
        starts: (pids) => new Map(pids.filter((p) => w.procs.has(p)).map((p) => [p, w.procs.get(p)])),
        sessionRecord: (p) => w.records.get(p) ?? null, jobLive: (wt) => w.jobs.has(wt), ...extra,
      };
    },
    // A command running inside a detached job: no Claude ancestor, CLAUDECODE=1, plus whatever identity `job start` handed over.
    inJob(handed, extra = {}) {
      return w.as(null, { env: { CLAUDECODE: '1', ...(handed ?? {}) }, ...extra });
    },
    session(pid, sessionId, start = START) { w.procs.set(pid, start); w.records.set(pid, { sessionId, procStart: start }); },
    scan(extra = {}) { return scanLeases({ ...w.as(null), ...extra }); },
  };
  fs.mkdirSync(w.home, { recursive: true });
  return w;
}
const open = (opts, wt, extra = {}) => openOrRenewLease({ worktree: wt, repoId: 'acme/app', pr: 7, ...extra, ...opts });
const files = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort() : []);

// ---- R1-B2 -------------------------------------------------------------------------------------------------------------------------------

test('R1-B2: a lease idle past the 6 h limit stays live while a detached job runs in its worktree, and is dead (and swept) once the job is gone', async (t) => {
  const w = world(t);
  w.session(500, 'sess-one');
  const wt = w.wt('a');
  await open(w.as(500), wt);
  const late = { now: T0 + 7 * HOUR };
  assert.equal(w.scan(late).live.length, 0, 'no job: the TTL kills it');
  w.jobs.add(wt);
  const live = w.scan(late);
  assert.equal(live.live.length, 1, 'a running job keeps it live regardless of the TTL');
  assert.match(live.live[0].why, /detached job/);
  assert.deepEqual((await sweepDeadLeases({ ...w.as(null), ...late })).removed, [], 'the installer sweep keeps it too');
  assert.deepEqual(files(w.dir), ['sess-one.json']);
  w.jobs.delete(wt);
  assert.equal(w.scan(late).live.length, 0, 'job gone: dead again');
  assert.equal((await sweepDeadLeases({ ...w.as(null), ...late })).removed.length, 1);
  assert.deepEqual(files(w.dir), []);
});

test('R1-B2: a TTL-only lease past the limit is live while a job runs, too', async (t) => {
  const w = world(t);
  const wt = w.wt('a');
  await open(w.as(null), wt); // CLAUDECODE=1, no ancestor: TTL-only
  w.jobs.add(wt);
  assert.equal(w.scan({ now: T0 + LEASE_TTL_MS + HOUR }).live.length, 1);
});

// ---- R1-F1: the identity handed to a job -------------------------------------------------------------------------------------------------

test('R1-F1: holderHandoff hands over a real session identity, and nothing for a plain terminal or an unplaceable session', (t) => {
  const w = world(t);
  w.session(500, 'sess-one');
  const handed = holderHandoff({ worktree: w.wt('a'), ...w.as(500) });
  assert.deepEqual(Object.keys(handed), [HOLDER_ENV]);
  assert.deepEqual(JSON.parse(handed[HOLDER_ENV]), { sessionId: 'sess-one', pid: 500, pidStart: START });
  assert.deepEqual(holderHandoff({ worktree: w.wt('b'), ...w.as(null, { env: {} }) }), {}, 'plain terminal: nothing to hand over');
  assert.deepEqual(holderHandoff({ worktree: w.wt('c'), ...w.as(501) }), {}, 'a ttl-only holder is not handed over (the job derives the same one)');
});

test('R1-F1: a leased command run via a job writes into the SESSION holder file (no ttl- file), and summary/ended closes it', async (t) => {
  const w = world(t);
  w.session(500, 'sess-one');
  const wt = w.wt('a');
  const start = await open(w.as(500), wt); // `job start` is itself a leased command, in the session
  const handed = holderHandoff({ worktree: wt, ...w.as(500) });
  const first = await open(w.inJob(handed), wt); // the job's command (merge, ci-wait ...)
  assert.equal(first.sessionId, 'sess-one');
  assert.equal(first.ttlOnly, false);
  assert.equal(first.generation, start.generation, 'the same lease is renewed');
  assert.deepEqual(files(w.dir), ['sess-one.json'], 'no ttl- holder was created');
  // The job ends; the session runs summary: the lease closes and nothing is live.
  const closed = await closeLease({ worktree: wt, generation: first.generation, ...w.as(500) });
  assert.equal(closed.closed, true);
  assert.deepEqual(files(w.dir), []);
  assert.deepEqual(blocking(w.scan()), []);
});

test('R1-F1: summary while the job still runs keeps the lease live ONLY until the job ends; the job\'s own renewals do not extend it', async (t) => {
  const w = world(t);
  w.session(500, 'sess-one');
  const wt = w.wt('a');
  const lease = await open(w.as(500), wt);
  w.jobs.add(wt);
  const handed = holderHandoff({ worktree: wt, ...w.as(500) });
  const closed = await closeLease({ worktree: wt, generation: lease.generation, ...w.as(500) });
  assert.equal(closed.closed, true);
  assert.equal(closed.jobRunning, true);
  assert.equal(blocking(w.scan()).length, 1, 'the job is still running: still live');
  // the job's command renews while the job runs: stays job-scoped
  w.now = T0 + HOUR;
  await open(w.inJob(handed), wt);
  assert.equal(blocking(w.scan()).length, 1);
  w.jobs.delete(wt);
  assert.deepEqual(blocking(w.scan()), [], 'job over: nothing live although the session is still running');
  assert.match(w.scan().dead[0].why, /closed/);
  assert.equal((await sweepDeadLeases(w.as(null))).removed.length, 1);
  assert.deepEqual(files(w.dir), []);
});

test('R1-F1: a job command that opens a lease after the session closed it (no lease left) is job-scoped; a direct command in the session makes it a normal lease again', async (t) => {
  const w = world(t);
  w.session(500, 'sess-one');
  const wt = w.wt('a');
  const lease = await open(w.as(500), wt);
  await closeLease({ worktree: wt, generation: lease.generation, ...w.as(500) });
  assert.deepEqual(files(w.dir), []);
  const handed = holderHandoff({ worktree: wt, ...w.as(500) });
  w.jobs.add(wt);
  await open(w.inJob(handed), wt);
  assert.equal(blocking(w.scan()).length, 1);
  w.jobs.delete(wt);
  assert.deepEqual(blocking(w.scan()), [], 'dead once the job is gone');
  w.jobs.add(wt);
  await open(w.as(500), wt); // the session works on it again
  w.jobs.delete(wt);
  assert.equal(blocking(w.scan()).length, 1, 'a session command made it a normal lease');
});

test('R1-F1: a forged, stale or unknown handed identity falls back to the TTL-only holder; it is never trusted', async (t) => {
  const w = world(t);
  w.session(500, 'sess-one');
  const wt = w.wt('a');
  const good = { sessionId: 'sess-one', pid: 500, pidStart: START };
  const ttlId = resolveHolder({ worktree: wt, ...w.as(null) }).sessionId;
  assert.match(ttlId, /^ttl-/);
  const bad = {
    'unknown pid': { ...good, pid: 999 },
    'wrong session id (a /clear)': { ...good, sessionId: 'sess-other' },
    'wrong start time (pid reuse)': { ...good, pidStart: 'Wed Nov 11 09:00:00 2026' },
    'not JSON': 'nope',
    'JSON but not an object': '42',
    'bad pid': { ...good, pid: '500; rm -rf' },
    'bad session id': { ...good, sessionId: '../escape' },
    'missing fields': { sessionId: 'sess-one' },
  };
  for (const [what, value] of Object.entries(bad)) {
    const handed = { [HOLDER_ENV]: typeof value === 'string' ? value : JSON.stringify(value) };
    const h = resolveHolder({ worktree: wt, ...w.inJob(handed) });
    assert.equal(h.kind, 'ttl', what);
    assert.equal(h.sessionId, ttlId, what);
  }
  // a session whose record is gone (it exited) cannot be claimed either
  w.records.delete(500);
  assert.equal(resolveHolder({ worktree: wt, ...w.inJob({ [HOLDER_ENV]: JSON.stringify(good) }) }).kind, 'ttl');
  // and a real Claude ancestor always wins over a handed value
  w.session(600, 'sess-two');
  const h = resolveHolder({ worktree: wt, ...w.as(600, { env: { CLAUDECODE: '1', [HOLDER_ENV]: JSON.stringify(good) } }) });
  assert.equal(h.sessionId, 'sess-two');
});

test('R1-F1: a plain terminal (no CLAUDECODE, no ancestor) takes no lease even with a handed value that checks out', (t) => {
  const w = world(t);
  w.session(500, 'sess-one');
  const handed = { [HOLDER_ENV]: JSON.stringify({ sessionId: 'sess-one', pid: 500, pidStart: START }) };
  assert.equal(resolveHolder({ worktree: w.wt('a'), ...w.as(null, { env: handed }) }).kind, 'none');
  assert.equal(resolveHolder({ worktree: w.wt('a'), ...w.as(null, { env: { CLAUDECODE: '1', ...handed } }) }).kind, 'session');
});

// ---- R1-F1: `job start` itself ----------------------------------------------------------------------------------------------------------

test('R1-F1: `job start` run in a session passes the session identity to the job (env PIPELINE_LEASE_HOLDER); a plain terminal passes nothing', async (t) => {
  const repo = tmp(t);
  const git = (...a) => spawnSync('git', a, { cwd: repo, encoding: 'utf8', env: { ...process.env, HOME: repo, USERPROFILE: repo } });
  git('init', '-q');
  git('-c', 'user.email=t@example.test', '-c', 'user.name=t', 'commit', '--allow-empty', '-q', '-m', 'init');
  const w = world(t);
  w.session(500, 'sess-one');
  const script = `require('fs').writeFileSync(process.argv[1], process.env.${HOLDER_ENV} ?? 'unset')`;
  const startJob = async (name, leaseHolderOpts, env) => {
    const res = await jobCommand(['start', name, '--', process.execPath, '-e', script, path.join(repo, `${name}.txt`)], { cwd: repo, env, leaseHolderOpts });
    assert.equal(res.exitCode, 0, JSON.stringify(res.output));
    const deadline = Date.now() + 20_000;
    while (!fs.existsSync(path.join(repo, `${name}.txt`)) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    return fs.readFileSync(path.join(repo, `${name}.txt`), 'utf8');
  };
  const env = { ...process.env, CLAUDECODE: '1', HOME: repo, USERPROFILE: repo };
  delete env[HOLDER_ENV];
  const seen = await startJob('insession', w.as(500), env);
  assert.deepEqual(JSON.parse(seen), { sessionId: 'sess-one', pid: 500, pidStart: START });
  const plain = await startJob('plain', w.as(null, { env: {} }), { ...env, CLAUDECODE: undefined });
  assert.equal(plain, 'unset');
});
