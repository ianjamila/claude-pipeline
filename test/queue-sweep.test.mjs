// `P queue-sweep` (lib/queue-sweep.mjs): the renewable observer of queue mode. The unit tests drive sweepRepo with a stub gh and the real record files;
// the schedule tests drive lib/queue-sweep-schedule.mjs with a fake launchctl (mirroring stacks-uninstall.test.mjs), never a real launchd.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
import { recheckGatedRecorded } from '../pipeline/lib/queue-route.mjs';
import { CANONICAL_CHECKS } from '../pipeline/lib/finalgate.mjs';
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

// #229: the sweep judges a re-queue the way the route that opened the record judged the first enqueue.
test('#229: a gated-route record is re-checked with the gated recheck, an owner-go (or route-less, older) record with the owner-go one', async () => {
  const events = [[addedAt(), removedAt('failed_checks')]];
  const fail = async () => ({ ok: false, error: 'owner-go', reasons: ['the owner\'s "merge" for this head and scan is no longer on record'] });
  const seen = [];
  const gatedPasses = async (args) => { seen.push(args.rec?.route ?? null); return { ok: true }; };
  const fresh = (route) => {
    const root = repoDir();
    openRecord(root, 7, HEAD, APPROVAL, { ...IDENT, ...(route ? { route } : {}) });
    setHold(root, 7, HOLD);
    beginAttempt(root, 7, HEAD, APPROVAL, IDENT);
    confirmAttempt(root, 7, 'MQE_1');
    return root;
  };

  const gated = fresh('gated');
  assert.equal(readQueueRecord(gated, 7).route, 'gated');
  const gg = stub({ states: [st(), inQ(1)], events });
  const a = await sweep(gated, world(), gg, { recheckFn: fail, recheckGatedFn: gatedPasses });
  assert.deepEqual(a.settled.map((s) => s.outcome), ['requeued'], 'the one automatic retry is delivered on the gated route');
  assert.deepEqual(gg.calls, [`enqueue 7 ${HEAD.slice(0, 8)}`]);
  assert.deepEqual(seen, ['gated']);

  for (const route of ['owner-go', null]) {
    const root = fresh(route);
    assert.equal(readQueueRecord(root, 7).route ?? null, route);
    const gh = stub({ states: [st()], events });
    const out = await sweep(root, world(), gh, { recheckFn: fail, recheckGatedFn: async () => { throw new Error('the gated recheck must not judge this record'); } });
    assert.equal(out.settled[0].terminal, 'removed', String(route));
    assert.deepEqual(gh.calls, ['add needs-human'], `${route}: no enqueue, fails closed`);
  }

  // A gated record whose gated recheck refuses ends like any refused re-queue.
  const refused = fresh('gated');
  const gr = stub({ states: [st()], events });
  const r = await sweep(refused, world(), gr, { recheckGatedFn: async () => ({ ok: false, error: 'blocked', reasons: ['label needs-human is on the PR'] }) });
  assert.equal(r.settled[0].terminal, 'blocked');
  assert.deepEqual(gr.calls.filter((x) => x.startsWith('enqueue')), []);
});

test('#229: the sweep\'s gated recheck needs a passing, recent gate file for the recorded head, then runs the same live checks as P merge', async () => {
  const gateAt = (over = {}) => ({
    ok: true, repo: 'acme/widgets', pr: 7, head: HEAD, contentHash: 'hash1', ownerItems: 'none', at: new Date().toISOString(),
    checks: CANONICAL_CHECKS.map((name) => ({ name, ok: true, detail: '' })), ...over,
  });
  const worktree = (gate) => {
    const dir = mkdtempSync(join(tmpdir(), 'cp-qsweep-gate-'));
    if (gate !== undefined) {
      mkdirSync(join(dir, '.review'));
      writeFileSync(join(dir, '.review', 'final-gate.json'), JSON.stringify(gate));
    }
    return dir;
  };
  const live = (over = {}) => ({ head: HEAD, contentHash: 'hash1', ownerItems: 'none', checks: [{ name: 'ci', ok: true }], ...over });
  const ask = (dir, { fresh = live(), problems = [], rec = { approval: APPROVAL }, now } = {}) => {
    const calls = [];
    return recheckGatedRecorded({
      root: dir, config: {}, pr: 7, gh: { ...stub({ states: [st()] }), prView: () => ({ state: 'OPEN', headRefOid: HEAD, labels: [] }) }, env: {}, head: HEAD, repo: 'acme/widgets', rec, localHash: () => 'hash1', ...(now ? { now } : {}),
      evaluate: async (args) => { calls.push(args.queueMode); return fresh; }, problemsOf: async () => problems,
    }).then((out) => ({ out, calls }));
  };

  const ok = await ask(worktree(gateAt()));
  assert.deepEqual(ok.out, { ok: true });
  assert.deepEqual(ok.calls, [true], 'the live gate is evaluated in queue mode');
  for (const [why, dir, re] of [
    ['no gate file', worktree(), /gate file is gone/],
    ['a failing gate', worktree(gateAt({ ok: false })), /not a passing gate/],
    ['a gate of another head', worktree(gateAt({ head: 'c'.repeat(40) })), /not a passing gate/],
    ['a gate of another PR', worktree(gateAt({ pr: 8 })), /not a passing gate/],
    ['a gate older than a gate may be', worktree(gateAt({ at: new Date(Date.now() - 25 * 3_600_000).toISOString() })), /too old/],
  ]) {
    const r = await ask(dir);
    assert.equal(r.out.ok, false, why);
    assert.match(r.out.reasons[0], re, why);
    assert.deepEqual(r.calls, [], `${why}: nothing is evaluated`);
  }
  const patch = await ask(worktree(gateAt()), { fresh: live({ contentHash: 'other' }) });
  assert.equal(patch.out.error, 'live-check');
  const failing = await ask(worktree(gateAt()), { fresh: live({ checks: [{ name: 'ci', ok: false, detail: 'red' }] }) });
  assert.match(failing.out.reasons[0], /ci: red/);
  const blocked = await ask(worktree(gateAt()), { problems: ['label needs-human is on the PR'] });
  assert.deepEqual([blocked.out.ok, blocked.out.error], [false, 'blocked']);
  // The gate left items for the owner and no "merge" for them is on record: not re-queued.
  const items = await ask(worktree(gateAt({ ownerItems: 'zz9-no-such-owner-record' })), { fresh: live({ ownerMerge: 1, ownerItems: 'zz9-no-such-owner-record' }) });
  assert.equal(items.out.error, 'pre-merge');
  assert.match(items.out.reasons[0], /no "merge" for this head and item set is on record/);
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

// R1-F2: a gated record whose first enqueue stood on the owner's word (a resumed run, an unchecked run record: the gate itself shows no owner items)
// is re-queued by the unattended sweep only while that word is still on record.
test('R1-F2: the sweep\'s gated recheck refuses a record whose enqueue needed the owner\'s word when that word is no longer on record', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-qsweep-gate-'));
  mkdirSync(join(dir, '.review'));
  // (ownerMerge 0 in the file and live: nothing but the record says the owner's word mattered; the item set has no "merge" on record)
  writeFileSync(join(dir, '.review', 'final-gate.json'), JSON.stringify({
    ok: true, repo: 'acme/widgets', pr: 7, head: HEAD, contentHash: 'hash1', ownerItems: 'zz9-no-such-owner-record', at: new Date().toISOString(),
    checks: CANONICAL_CHECKS.map((name) => ({ name, ok: true, detail: '' })),
  }));
  const ask = (rec) => recheckGatedRecorded({
    root: dir, config: {}, pr: 7, gh: { ...stub({ states: [st()] }), prView: () => ({ state: 'OPEN', headRefOid: HEAD, labels: [] }) }, env: {}, head: HEAD, repo: 'acme/widgets', rec, localHash: () => 'hash1',
    evaluate: async () => ({ head: HEAD, contentHash: 'hash1', ownerItems: 'zz9-no-such-owner-record', checks: [{ name: 'ci', ok: true }] }), problemsOf: async () => [],
  });
  const required = await ask({ approval: { ...APPROVAL, ownerRequired: true } });
  assert.equal(required.ok, false);
  assert.equal(required.error, 'pre-merge');
  assert.match(required.reasons[0], /owner's "merge" for this head is no longer on record/);
  // records written before the field (or for an enqueue that needed no word) keep today's behaviour
  assert.deepEqual(await ask({ approval: APPROVAL }), { ok: true });
  assert.deepEqual(await ask({ approval: { ...APPROVAL, ownerRequired: false } }), { ok: true });
});

// R1-F3: the sweep binds the gate file exactly as P merge does (gateRefusals): repo, canonical check list, PR head, patch hash, age, and a future date.
test('R1-F3: the sweep\'s gated recheck refuses what gateRefusals refuses: a future-dated gate, another repo, a short check list, a moved PR head, another patch', async () => {
  const complete = (over = {}) => ({
    ok: true, repo: 'acme/widgets', pr: 7, head: HEAD, contentHash: 'hash1', ownerItems: 'none', at: new Date().toISOString(),
    checks: CANONICAL_CHECKS.map((name) => ({ name, ok: true, detail: '' })), ...over,
  });
  const ask = async (gate, { prHead = HEAD, hash = 'hash1' } = {}) => {
    const dir = mkdtempSync(join(tmpdir(), 'cp-qsweep-gate-'));
    mkdirSync(join(dir, '.review'));
    writeFileSync(join(dir, '.review', 'final-gate.json'), JSON.stringify(gate));
    const calls = [];
    const gh = { ...stub({ states: [st()] }), prView: () => ({ state: 'OPEN', headRefOid: prHead, labels: [] }) };
    const out = await recheckGatedRecorded({
      root: dir, config: {}, pr: 7, gh, env: {}, head: HEAD, repo: 'acme/widgets', rec: { approval: APPROVAL }, localHash: () => hash,
      evaluate: async () => { calls.push('evaluate'); return { head: HEAD, contentHash: 'hash1', ownerItems: 'none', checks: [{ name: 'ci', ok: true }] }; }, problemsOf: async () => [],
    });
    return { out, calls };
  };
  assert.deepEqual((await ask(complete())).out, { ok: true });
  for (const [why, gate, opts, re] of [
    ['a gate dated in the future (it would never age out)', complete({ at: new Date(Date.now() + 3_600_000).toISOString() }), {}, /dated in the future/],
    ['a gate of another repo', complete({ repo: 'other/widgets' }), {}, /not acme\/widgets/],
    ['a gate with a short check list', complete({ checks: [{ name: 'ci', ok: true }] }), {}, /missing canonical check/],
    ['a gate for a PR head that has moved', complete(), { prHead: 'c'.repeat(40) }, /PR head is/],
    ['a gate for another patch', complete(), { hash: 'other' }, /content hash differs/],
  ]) {
    const r = await ask(gate, opts);
    assert.equal(r.out.ok, false, why);
    assert.equal(r.out.error, 'live-check', why);
    assert.match(r.out.reasons.join('\n'), re, why);
    assert.deepEqual(r.calls, [], `${why}: nothing is evaluated`);
  }
});

// ---- review round 2 ---------------------------------------------------------------------------------------------------------------------

// R2-F2: a PR read that fails (a GitHub blip) is not a refusal: a refusal ends the record and spends the owner's word, so the error propagates and the sweep leaves the record live for the next pass.
test('R2-F2: the sweep\'s gated recheck lets a failed PR read propagate instead of refusing for good', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-qsweep-gate-'));
  mkdirSync(join(dir, '.review'));
  writeFileSync(join(dir, '.review', 'final-gate.json'), JSON.stringify({
    ok: true, repo: 'acme/widgets', pr: 7, head: HEAD, contentHash: 'hash1', ownerItems: 'none', at: new Date().toISOString(),
    checks: CANONICAL_CHECKS.map((name) => ({ name, ok: true, detail: '' })),
  }));
  const gh = { ...stub({ states: [st()] }), prView: () => { throw new Error('gh: Server Error (HTTP 502)'); } };
  await assert.rejects(
    recheckGatedRecorded({ root: dir, config: {}, pr: 7, gh, env: {}, head: HEAD, repo: 'acme/widgets', rec: { approval: APPROVAL }, localHash: () => 'hash1', evaluate: async () => { throw new Error('not reached'); }, problemsOf: async () => [] }),
    /HTTP 502/,
  );
});

// R3-F3: the throw must leave the record LIVE (not ended, no hold restored, no label, no notice) so the next sweep retries it; wrapping the re-queue in a catch would spend the owner's word on a blip.
test('R3-F3: a gated recheck that throws leaves the record live and unspent (outcome error); the next sweep with a passing recheck re-queues', async () => {
  const root = repoDir();
  const w = world();
  openRecord(root, 7, HEAD, APPROVAL, { ...IDENT, route: 'gated' });
  setHold(root, 7, HOLD);
  beginAttempt(root, 7, HEAD, APPROVAL, IDENT);
  confirmAttempt(root, 7, 'MQE_1');
  const events = [[addedAt(), removedAt('failed_checks')]];

  const blip = stub({ states: [st()], events });
  const first = await sweep(root, w, blip, { recheckGatedFn: async () => { throw new Error('gh: Server Error (HTTP 502)'); } });
  assert.deepEqual(first.settled.map((s) => s.outcome), ['error']);
  assert.equal(readQueueRecord(root, 7).terminal, null, 'the record is still live');
  assert.deepEqual(blip.calls, [], 'no enqueue, no label');
  assert.deepEqual(w.said, [], 'no notice');

  const ok = stub({ states: [st(), inQ(1)], events });
  const second = await sweep(root, w, ok, { recheckGatedFn: async () => ({ ok: true }) });
  assert.deepEqual(second.settled.map((s) => s.outcome), ['requeued']);
  assert.deepEqual(ok.calls, [`enqueue 7 ${HEAD.slice(0, 8)}`]);
  assert.equal(readQueueRecord(root, 7).terminal, null);
});
