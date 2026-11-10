// `P queue-sweep` (lib/queue-sweep.mjs): the renewable observer of queue mode. The unit tests drive sweepRepo with a stub gh and the real record files;
// the schedule tests drive lib/queue-sweep-schedule.mjs with a fake launchctl (mirroring stacks-uninstall.test.mjs), never a real launchd.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULTS } from '../pipeline/lib/config.mjs';
import { mergeLockName } from '../pipeline/lib/hold.mjs';
import { release, tryAcquire } from '../pipeline/lib/locks.mjs';
import {
  beginAttempt, confirmAttempt, openRecord, queueRecordPath, readQueueRecord, setHold,
} from '../pipeline/lib/merge-queue.mjs';
import { run as runQueueSweep } from '../pipeline/commands/queue-sweep.mjs';
import { sweepRepo, bestEffortSweep } from '../pipeline/lib/queue-sweep.mjs';
import {
  QUEUE_SWEEP_LABEL, queueSweepPlistPath, queueSweepSchedule,
} from '../pipeline/lib/queue-sweep-schedule.mjs';

const HEAD = 'a'.repeat(40);
const QC1 = 'b'.repeat(40);
const QC2 = 'e'.repeat(40);
const APPROVAL = { items: 'abc123', areas: null, rulings: null };
const IDENT = { repo: 'acme/widgets', repoId: 42 };
const HOLD = { id: 'LE_hold1', login: 'jamila', at: '2026-11-05T09:00:00Z', holdBlock: 'digest', liftedAt: '2026-11-09T07:59:00Z' };

const repoDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-qsweep-'));
  execFileSync('git', ['init', '-q', dir]);
  return dir;
};
const script = (list) => {
  let i = 0;
  return () => {
    const item = list[Math.min(i, list.length - 1)];
    i += 1;
    return item;
  };
};
const st = (over = {}) => ({ enabled: true, inQueue: false, state: 'OPEN', head: HEAD, mergeSha: null, entry: null, ...over });
const inQ = (position = 1) => st({ inQueue: true, entry: { id: 'MQE_1', state: 'AWAITING_CHECKS', position, enqueuedAt: '2026-11-09T08:00:00Z', headCommit: null } });
const evt = (type, at, reason = null, beforeCommit = null) => ({ type, at: `2026-11-09T${at}Z`, reason, actor: 'github-merge-queue', beforeCommit });
const addedAt = (at = '08:00:00') => evt('added', at);
const removedAt = (reason, at = '08:30:00', before = QC1) => evt('removed', at, reason, before);

// A stub gh: queue reads are scripts, labels live in `m.labels`, every write is recorded in `calls`.
function stub({ states, events = [[]], labels = [] }) {
  const nextState = script(states);
  const nextEvents = script(events);
  const m = {
    calls: [], labels: [...labels],
    queueState: () => nextState(),
    queueEvents: () => nextEvents(),
    prView: () => ({ state: 'OPEN', labels: m.labels.map((name) => ({ name })), mergeCommit: null }),
    addLabels: (pr, names) => { m.calls.push(`add ${names}`); for (const n of names) if (!m.labels.includes(n)) m.labels.push(n); },
    listIssues: () => [],
    dequeue: (n) => { m.calls.push(`dequeue ${n}`); },
    enqueue: (n, head) => { m.calls.push(`enqueue ${n} ${head.slice(0, 8)}`); },
    branchRules: () => [],
    checkRunsOf: (sha) => (sha === QC1 ? [{ name: 'ci', conclusion: 'failure' }] : [{ name: 'e2e', conclusion: 'timed_out' }]),
    statusesOf: () => [],
    repo: () => ({ slug: 'acme/widgets' }),
    repoId: () => 42,
  };
  return m;
}
const config = () => ({ ok: true, config: { merge: { ...DEFAULTS.merge }, default_branch: 'main' } });
const world = () => {
  const lockDir = mkdtempSync(join(tmpdir(), 'cp-qsweep-locks-'));
  const said = [];
  const env = { PIPELINE_LOCK_DIR: lockDir, PIPELINE_QUEUE_CONFIRM_MS: '50', PIPELINE_QUEUE_CONFIRM_POLL_MS: '1' };
  return { lockDir, said, env, notify: (t) => said.push(t) };
};
const sleep = async () => {};
// A record as P merge leaves it after a confirmed enqueue with a lifted hold (the observer then died).
function entryRecord(root, pr = 7) {
  openRecord(root, pr, HEAD, APPROVAL, IDENT);
  setHold(root, pr, HOLD);
  beginAttempt(root, pr, HEAD, APPROVAL, IDENT);
  confirmAttempt(root, pr, 'MQE_1');
}
const sweep = (root, w, gh, over = {}) => sweepRepo({
  root, env: w.env, notify: w.notify, makeGh: () => gh, sleep, loadCfg: async () => config(), headOf: () => HEAD, recheckFn: async () => ({ ok: true }), ...over,
});

test('no live record: no GitHub client is even built (no gh call), nothing is settled', async () => {
  const root = repoDir();
  const w = world();
  const out = await sweepRepo({ root, env: w.env, makeGh: () => { throw new Error('gh must not be touched'); } });
  assert.deepEqual(out, { root, settled: [], skipped: [], errors: [] });
  // an ended record is not live either
  entryRecord(root);
  const rec = JSON.parse(readFileSync(queueRecordPath(root, 7), 'utf8'));
  writeFileSync(queueRecordPath(root, 7), JSON.stringify({ ...rec, terminal: 'merged', terminalAt: new Date().toISOString() }));
  assert.deepEqual((await sweepRepo({ root, env: w.env, makeGh: () => { throw new Error('gh must not be touched'); } })).settled, []);
});

test('the command with no live record anywhere exits 0 at once; `--repo` is remembered, an unknown repo is not a failure', async () => {
  const root = repoDir();
  const home = mkdtempSync(join(tmpdir(), 'cp-qsweep-home-'));
  const env = { PIPELINE_NO_BANNER: '1', PIPELINE_LOCK_DIR: home };
  const r = await runQueueSweep(['--repo', root], { cwd: root, env, home, deps: { makeGh: () => { throw new Error('gh must not be touched'); } } });
  assert.equal(r.exitCode, 0);
  assert.equal(r.output.ok, true);
  assert.equal(r.output.repos[0].settled.length, 0);
  assert.ok(existsSync(join(home, 'queue-sweep-repos.json')), 'the repo is on the list the LaunchAgent reads');
  const all = await runQueueSweep([], { cwd: root, env, home, deps: { makeGh: () => { throw new Error('gh must not be touched'); } } });
  assert.equal(all.exitCode, 0);
  assert.equal(all.output.repos.length, 1, 'no --repo sweeps the remembered repo');
});

test('observer dead after the confirm: a later failed_checks removal is re-queued ONCE by the next sweep; the second removal restores the hold and notifies', async () => {
  const root = repoDir();
  const w = world();
  entryRecord(root);
  const gh = stub({
    states: [st(), inQ(1), st()],
    events: [[addedAt(), removedAt('failed_checks')], [addedAt(), removedAt('failed_checks'), addedAt('09:00:00'), removedAt('failed_checks', '09:30:00', QC2)]],
  });
  const a = await sweep(root, w, gh);
  assert.deepEqual(a.settled.map((s) => s.outcome), ['requeued']);
  assert.deepEqual(gh.calls, [`enqueue 7 ${HEAD.slice(0, 8)}`]);
  const rec = readQueueRecord(root, 7);
  assert.equal(rec.terminal, null);
  assert.equal(rec.attempts, 2);
  assert.equal(rec.removals.length, 1);
  assert.equal(rec.hold.owner, 'entry', 'the lifted hold stays with the entry');
  assert.deepEqual(w.said, [], 'a re-queue is not a terminal outcome: no owner step, no notice');

  const b = await sweep(root, w, gh);
  assert.equal(b.settled[0].outcome, 'ended');
  assert.equal(b.settled[0].terminal, 'removed');
  assert.equal(b.settled[0].hold, 'restored');
  assert.deepEqual(gh.calls, [`enqueue 7 ${HEAD.slice(0, 8)}`, 'add needs-human'], 'no second enqueue');
  assert.equal(readQueueRecord(root, 7).terminal, 'removed');
  assert.equal(w.said.length, 1);
  assert.match(w.said[0], /removed from the merge queue \(reason failed_checks\); failing: e2e: timed_out after one automatic re-queue; needs-human is back/);
});

test('F1: a sweep while a `P merge` holds PR 7\'s lock leaves record 7 untouched and settles record 8', async () => {
  const root = repoDir();
  const w = world();
  entryRecord(root, 7);
  entryRecord(root, 8);
  const gh = stub({ states: [inQ(2)] });
  const lock = tryAcquire(mergeLockName('acme/widgets', 7), { dir: w.lockDir });
  assert.equal(lock.acquired, true);
  try {
    const before = readFileSync(queueRecordPath(root, 7), 'utf8');
    const out = await sweep(root, w, gh);
    assert.deepEqual(out.skipped.map((s) => s.pr), [7]);
    assert.match(out.skipped[0].why, /merge-in-progress/);
    assert.deepEqual(out.settled.map((s) => [s.pr, s.outcome]), [[8, 'queued']]);
    assert.equal(readFileSync(queueRecordPath(root, 7), 'utf8'), before, 'record 7 is byte for byte the same');
    assert.deepEqual(gh.calls, []);
  } finally {
    release(lock.lock);
  }
  assert.deepEqual((await sweep(root, w, stub({ states: [inQ(2)] }))).settled.map((s) => s.pr), [7, 8], 'once the lock is free both are settled');
});

test('F11: a removal that could be re-queued but whose worktree is gone, or at another head, is NOT enqueued: terminal, hold restored, owner told', async () => {
  const events = [[addedAt(), removedAt('failed_checks')]];
  // (a) the worktree directory is gone
  const gone = repoDir();
  const wa = world();
  entryRecord(gone);
  const recFile = queueRecordPath(gone, 7);
  writeFileSync(recFile, JSON.stringify({ ...JSON.parse(readFileSync(recFile, 'utf8')), root: join(gone, 'no-such-worktree') }));
  const gha = stub({ states: [st()], events });
  const a = await sweep(gone, wa, gha);
  assert.equal(a.settled[0].outcome, 'ended');
  assert.equal(a.settled[0].terminal, 'removed');
  assert.equal(a.settled[0].hold, 'restored');
  assert.deepEqual(gha.calls, ['add needs-human'], 'no enqueue');
  assert.match(wa.said[0], /removed from the merge queue \(reason failed_checks\); failing: ci: failure once and was not re-queued: worktree gone — re-run `P merge --pr 7` to re-queue/);

  // (b) the worktree is at another head
  const moved = repoDir();
  const wb = world();
  entryRecord(moved);
  const ghb = stub({ states: [st()], events });
  const b = await sweep(moved, wb, ghb, { headOf: () => 'f'.repeat(40) });
  assert.equal(b.settled[0].terminal, 'removed');
  assert.deepEqual(ghb.calls, ['add needs-human']);
  assert.match(wb.said[0], /worktree at another head/);

  // (c) the live checks no longer pass (owner-go record expired, a blocker, ...): same end, and `blocked` when the blocker is a stop condition
  const stopped = repoDir();
  const wc = world();
  entryRecord(stopped);
  const ghc = stub({ states: [st()], events });
  const c = await sweep(stopped, wc, ghc, { recheckFn: async () => ({ ok: false, error: 'blocked', reasons: ['label needs-human is on the PR'] }) });
  assert.equal(c.settled[0].terminal, 'blocked');
  assert.deepEqual(ghc.calls.filter((x) => x.startsWith('enqueue')), []);
});

test('F11: P final-gate\'s sweep (requeue: false) only settles: a re-queueable removal is left as it is, nothing is enqueued, the hold stays lifted', async () => {
  const root = repoDir();
  const w = world();
  entryRecord(root);
  const gh = stub({ states: [st()], events: [[addedAt(), removedAt('failed_checks')]] });
  const out = await sweep(root, w, gh, { requeue: false });
  assert.equal(out.settled[0].outcome, 'requeue-due');
  assert.deepEqual(gh.calls, []);
  assert.equal(readQueueRecord(root, 7).terminal, null);
  assert.equal(readQueueRecord(root, 7).hold.owner, 'entry');
  assert.deepEqual(w.said, []);
  // the same, through the best-effort wrapper the commands call: never throws, even when GitHub cannot be read
  const res = await bestEffortSweep({ root, requeue: false, env: w.env, home: w.lockDir, notify: w.notify, makeGh: () => { throw new Error('offline'); }, warn: () => {} });
  assert.match(res.repos[0].errors[0], /offline/);
});

test('exceptPr leaves the PR a `P merge` is about to handle alone', async () => {
  const root = repoDir();
  const w = world();
  entryRecord(root, 7);
  entryRecord(root, 8);
  const out = await sweep(root, w, stub({ states: [inQ(1)] }), { exceptPr: 7 });
  assert.deepEqual(out.settled.map((s) => s.pr), [8]);
});

test('three budget exhaustions (three sweeps while the entry waits): queued every time, attempts stays 1, never dequeued, the hold stays lifted', async () => {
  const root = repoDir();
  const w = world();
  entryRecord(root);
  const gh = stub({ states: [inQ(3)] });
  for (let i = 0; i < 3; i += 1) {
    const out = await sweep(root, w, gh);
    assert.equal(out.settled[0].outcome, 'queued');
    assert.equal(out.settled[0].position, 3);
  }
  const rec = readQueueRecord(root, 7);
  assert.equal(rec.attempts, 1);
  assert.equal(rec.terminal, null);
  assert.equal(rec.hold.owner, 'entry');
  assert.deepEqual(gh.calls, [], 'no dequeue, no enqueue, no label');
});

test('a merged entry ends the record, tells the owner and does not restore the label', async () => {
  const root = repoDir();
  const w = world();
  entryRecord(root);
  const out = await sweep(root, w, stub({ states: [st({ state: 'MERGED', mergeSha: 'c'.repeat(40) })] }));
  assert.equal(out.settled[0].outcome, 'merged');
  assert.equal(readQueueRecord(root, 7).terminal, 'merged');
  assert.match(w.said[0], /PR #7 merged through the merge queue/);
});

// ---- the LaunchAgent ---------------------------------------------------------------------------------------------------------------------------------

function launchd(loaded = new Set()) {
  const calls = [];
  const fn = (args) => {
    calls.push(args.join(' '));
    if (args[0] === 'bootstrap') { loaded.add('x'); return { code: 0, stdout: '', stderr: '' }; }
    if (args[0] === 'bootout') { loaded.clear(); return { code: 0, stdout: '', stderr: '' }; }
    if (args[0] === 'print') return loaded.size ? { code: 0, stdout: '', stderr: '' } : { code: 113, stdout: '', stderr: 'Could not find service' };
    return { code: 1, stdout: '', stderr: 'unexpected' };
  };
  return { calls, fn };
}
const machine = () => {
  const userHome = mkdtempSync(join(tmpdir(), 'cp-qsweep-mac-'));
  return { userHome, home: join(userHome, '.claude'), env: { PIPELINE_PRUNE_LOG_DIR: join(userHome, 'logs'), PATH: '' } };
};
const base = (m, over = {}) => ({ home: m.home, env: m.env, userHome: m.userHome, platform: 'darwin', uid: 501, nodePath: '/opt/node/bin/node', which: (c) => `/opt/bin/${c}`, tzFn: () => 'Asia/Manila', ...over });

test('the LaunchAgent: installed with a 10-minute interval and RunAtLoad, then unchanged, reported healthy, and removed', () => {
  const m = machine();
  const l = launchd();
  const first = queueSweepSchedule({ action: 'install', launchctlFn: l.fn, ...base(m) });
  assert.equal(first.applicable, true);
  assert.equal(first.installed, true);
  assert.equal(first.changed, true);
  assert.equal(first.warning, undefined, 'an interval job has no clock time to qualify');
  const plistPath = queueSweepPlistPath(m.userHome);
  assert.equal(first.plist, plistPath);
  const xml = readFileSync(plistPath, 'utf8');
  assert.match(xml, new RegExp(`<key>Label</key>\\s*<string>${QUEUE_SWEEP_LABEL.replace(/\./g, '\\.')}</string>`));
  assert.equal(QUEUE_SWEEP_LABEL, 'com.claude-pipeline.queue-sweep');
  assert.match(xml, /<key>StartInterval<\/key>\s*<integer>600<\/integer>/);
  assert.match(xml, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.ok(!xml.includes('StartCalendarInterval'));
  assert.match(xml, new RegExp(`<string>${join(m.home, 'pipeline', 'bin', 'pipeline.mjs').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</string>\\s*<string>queue-sweep</string>`));
  assert.ok(xml.includes(join(m.userHome, 'logs', 'cron-queue-sweep.log')));
  assert.deepEqual(l.calls.filter((c) => c.startsWith('bootstrap')), [`bootstrap gui/501 ${plistPath}`]);

  assert.equal(queueSweepSchedule({ action: 'install', launchctlFn: l.fn, ...base(m) }).changed, false, 'a second install leaves the file alone');
  const health = queueSweepSchedule({ action: 'status', launchctlFn: l.fn, ...base(m) });
  assert.equal(health.installed, true);
  const removed = queueSweepSchedule({ action: 'remove', launchctlFn: l.fn, ...base(m) });
  assert.equal(removed.removed, true);
  assert.equal(existsSync(plistPath), false);
  assert.equal(queueSweepSchedule({ action: 'status', launchctlFn: l.fn, ...base(m) }).installed, false, 'the health check sees it gone');
  assert.equal(queueSweepSchedule({ action: 'remove', launchctlFn: l.fn, ...base(m) }).removed, false, 'removing twice is harmless');
});

test('the LaunchAgent is machine-wide: a scratch home, an isolated stacks root and another platform never reach launchctl', () => {
  const m = machine();
  const never = () => { throw new Error('launchctl must not be called'); };
  const scratch = queueSweepSchedule({ action: 'install', launchctlFn: never, ...base(m, { home: join(m.userHome, 'elsewhere') }) });
  assert.equal(scratch.applicable, false);
  assert.equal(queueSweepSchedule({ action: 'remove', launchctlFn: never, ...base(m, { env: { ...m.env, PIPELINE_STACKS_HOME: '/tmp/x' } }) }).applicable, false);
  assert.equal(queueSweepSchedule({ action: 'status', launchctlFn: never, ...base(m, { platform: 'linux' }) }).applicable, false);
  assert.equal(existsSync(queueSweepPlistPath(m.userHome)), false);
});

test('a launchctl failure on install is reported as an error, not thrown', () => {
  const m = machine();
  const out = queueSweepSchedule({ action: 'install', launchctlFn: (args) => (args[0] === 'bootstrap' ? { code: 5, stdout: '', stderr: 'denied' } : { code: 113, stdout: '', stderr: '' }), ...base(m) });
  assert.equal(out.applicable, true);
  assert.match(out.error, /cannot load the LaunchAgent: denied/);
});

test('R1-B2: the re-queue is sent but every confirm read fails => unsettled: the record stays pending, the hold is not restored', async () => {
  const root = repoDir();
  const w = world();
  entryRecord(root);
  const gh = stub({ states: [st()], events: [[addedAt(), removedAt('failed_checks')]] });
  const read = gh.queueState;
  let reads = 0;
  gh.queueState = () => { // (the settle's own read works; every read after the enqueue fails)
    reads += 1;
    if (reads > 1) throw new Error('gh: Server Error (HTTP 502)');
    return read();
  };
  const out = await sweep(root, w, gh);
  assert.equal(out.settled[0].outcome, 'unsettled');
  assert.deepEqual(gh.calls, [`enqueue 7 ${HEAD.slice(0, 8)}`], 'the hold label is not put back over an entry that may be live');
  const rec = readQueueRecord(root, 7);
  assert.equal(rec.terminal, null);
  assert.notEqual(rec.pending, null, 'the attempt is still pending: the next sweep reconciles it');
  assert.deepEqual(w.said, []);
});
