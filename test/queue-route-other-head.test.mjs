// cp #232: `P merge` from a worktree whose head differs from a LIVE queue record's head (the record belongs to the worktree that queued H; this one is at K).
// The rule: such a run never ends that record or restores its hold, except where the record's own head says so (merged, closed, PR head moved off rec.head with
// no entry, or a removal that is NOT re-queueable for rec.head); a re-queueable removal is left live for the sweep (`requeue-due`).
// Direct createQueueRoute tests with a stub gh, the real record files and the real hold seam (restoreHoldOnTerminal); the CLI cases live in
// merge-queue-route.test.mjs and owner-go-hold-queue.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULTS } from '../pipeline/lib/config.mjs';
import { beginAttempt, confirmAttempt, noteRemoval, openRecord, queueRecordPath, readQueueRecord, setHold } from '../pipeline/lib/merge-queue.mjs';
import { RESTORE_NOTE } from '../pipeline/lib/hold.mjs';
import { createQueueRoute, restoreHoldOnTerminal } from '../pipeline/lib/queue-route.mjs';
import { sweepRepo } from '../pipeline/lib/queue-sweep.mjs';

const H = 'a'.repeat(40); // the head the record (and the PR on GitHub) is at
const K = 'c'.repeat(40); // this worktree's head
const J = 'd'.repeat(40); // some third head
const MERGE = '9'.repeat(40);
const QC1 = 'b'.repeat(40);
const QC2 = 'e'.repeat(40);
const APPROVAL = { items: 'abc123', areas: null, rulings: null };
const IDENT = { repo: 'acme/widgets', repoId: 42 };
const HOLD = { id: 'LE_hold1', login: 'jamila', at: '2026-11-05T09:00:00Z', holdBlock: 'digest', liftedAt: '2026-11-09T07:59:00Z' };
const PR = 7;

const st = (over = {}) => ({ enabled: true, inQueue: false, state: 'OPEN', head: H, mergeSha: null, entry: null, ...over });
const inQ = (over = {}) => st({ inQueue: true, entry: { id: 'MQE_1', state: 'AWAITING_CHECKS', position: 1, enqueuedAt: '2026-11-09T08:00:00Z', headCommit: null }, ...over });
const evt = (type, at, reason = null, beforeCommit = null) => ({ type, at: `2026-11-09T${at}Z`, reason, actor: 'github-merge-queue', beforeCommit });
const addedAt = (at = '08:00:00') => evt('added', at);
const removedAt = (reason, at = '08:30:00', before = QC1) => evt('removed', at, reason, before);
const FIRST = [addedAt(), removedAt('failed_checks')];
const SECOND = [...FIRST, addedAt('09:00:00'), removedAt('failed_checks', '09:30:00', QC2)];

const script = (list) => {
  let i = 0;
  return () => {
    const item = list[Math.min(i, list.length - 1)];
    i += 1;
    return item;
  };
};

// A stub gh: queue reads are scripts (replaceable between steps), labels live in `m.labels`, every write is recorded in `calls`.
function stub({ states = [st()], events = [[]], labels = [], addFails = false } = {}) {
  const m = {
    calls: [], labels: [...labels], queueReads: 0,
    queueState: () => { m.queueReads += 1; return m.nextState(); },
    queueEvents: () => m.nextEvents(),
    nextState: script(states),
    nextEvents: script(events),
    script(next) { // swap what GitHub shows from now on
      if (next.states) m.nextState = script(next.states);
      if (next.events) m.nextEvents = script(next.events);
    },
    prView: () => ({ state: 'OPEN', labels: m.labels.map((name) => ({ name })), mergeCommit: null }),
    addLabels: (pr, names) => {
      m.calls.push(`add ${names}`);
      if (addFails) throw new Error('HTTP 502');
      for (const n of names) if (!m.labels.includes(n)) m.labels.push(n);
    },
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
const writes = (m) => m.calls.filter((c) => /^(add|dequeue|enqueue)/.test(c));

const repoDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-otherhead-'));
  execFileSync('git', ['init', '-q', dir]);
  return dir;
};
// The record the worktree at H left: a confirmed attempt for H, optionally with a lifted hold and removals already noted.
function recordAt(root, { hold = true, route = 'owner-go' } = {}) {
  openRecord(root, PR, H, APPROVAL, { ...IDENT, route });
  if (hold) setHold(root, PR, HOLD);
  beginAttempt(root, PR, H, APPROVAL, IDENT);
  confirmAttempt(root, PR, 'MQE_1');
}
const refuse = (error, reasons, extra = {}) => ({ exitCode: 1, output: { ok: false, merged: false, error, reasons, message: reasons.join('; '), ...extra } });
const routeFor = (root, gh, head = K, over = {}) => createQueueRoute({
  gh, root, config: { merge: { ...DEFAULTS.merge }, default_branch: 'main' }, pr: PR, head, route: 'owner-go', env: { PIPELINE_QUEUE_POLL_MS: '1', PIPELINE_QUEUE_WAIT_MS: '5000' },
  refuse, approval: APPROVAL, recheck: async () => ({ ok: true }), onTerminal: restoreHoldOnTerminal({ gh, pr: PR }), sleep: async () => {}, ...over,
});
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8' }).trim();
// Two worktrees of one clone (the records live in the shared git dir): `here` is where this run happens (at K), `recorded` is the worktree that queued H.
// `headOf` stands for their HEADs (the route's seam): the recorded one is at H, this one at K, as in the real situation.
function pair() {
  const here = repoDir();
  git(here, 'commit', '-q', '--allow-empty', '-m', 'one');
  const recorded = join(mkdtempSync(join(tmpdir(), 'cp-otherhead-rec-')), 'w1');
  git(here, 'worktree', 'add', '-q', '--detach', recorded);
  return { here, recorded, headOf: (cwd) => (cwd === recorded ? H : K) };
}
const rawRecord = (root) => readFileSync(queueRecordPath(root, PR), 'utf8');
const out = (res) => res.done.output;

// ---- B + C: the watch path ----------------------------------------------------------------------------------------------------------------

test('1. watch from K, the entry at H fails its group: requeue-due, the record stays live, the hold stays on it, the label is NOT re-added', async () => {
  const { here: root, recorded, headOf } = pair();
  recordAt(recorded);
  const gh = stub({ states: [inQ(), st()], events: [FIRST] });
  const route = routeFor(root, gh, K, { headOf });
  const res = await route.enqueueAndWatch({ watchOnly: true });
  assert.equal(res.exitCode, 1);
  assert.equal(res.output.error, 'requeue-due');
  assert.equal(res.output.queued, false);
  assert.equal(res.output.queuedHead, H);
  assert.equal(res.output.recordRoot, recorded);
  assert.equal(res.output.removal.reason, 'failed_checks');
  assert.deepEqual(res.output.removal.failing, ['ci: failure']);
  assert.match(res.output.reasons[0], /its one automatic re-queue is due for aaaaaaaaaaaa/);
  assert.match(res.output.reasons[0], /this worktree is at cccccccccccc, so nothing was re-queued from here/);
  const rec = readQueueRecord(root, PR);
  assert.equal(rec.terminal, null, 'the record is still live');
  assert.equal(rec.removals.length, 1);
  assert.deepEqual({ id: rec.hold.id, owner: rec.hold.owner }, { id: HOLD.id, owner: 'entry' }, 'the hold is still on the record');
  assert.deepEqual(writes(gh), [], 'no label, no dequeue, no enqueue');
});

test('2. watch from K, the removal is NOT re-queueable (a second group failure, or another reason): queue-removed, the record ends removed, the hold is restored once', async () => {
  for (const [why, events, prior] of [['second failure', SECOND, true], ['reason manual', [addedAt(), removedAt('manual')], false]]) {
    const root = repoDir();
    recordAt(root);
    if (prior) {
      noteRemoval(root, PR, { reason: 'failed_checks', beforeCommit: QC1, at: '2026-11-09T08:30:00Z' });
    }
    const gh = stub({ states: [inQ(), st()], events: [events] });
    const res = await routeFor(root, gh).enqueueAndWatch({ watchOnly: true });
    assert.equal(res.exitCode, 1, why);
    assert.equal(res.output.error, 'queue-removed', why);
    assert.match(res.output.reasons[0], /this worktree is at cccccccccccc, the queued head was aaaaaaaaaaaa/, why);
    assert.equal(readQueueRecord(root, PR).terminal, 'removed', why);
    assert.deepEqual(writes(gh), ['add needs-human'], `${why}: the hold is restored once`);
  }
});

// ---- A: the precheck ----------------------------------------------------------------------------------------------------------------------

test('3. precheck from K, the entry at H already left (re-queueable), removal not yet on the record: requeue-due, exactly one removal, never head-moved; 3b the same removal seen again is still one', async () => {
  const { here: root, recorded, headOf } = pair();
  recordAt(recorded);
  const gh = stub({ states: [st()], events: [FIRST] });
  const route = routeFor(root, gh, K, { headOf });
  for (const round of ['first', 'again']) {
    const res = await route.precheck();
    assert.equal(out(res).error, 'requeue-due', round);
    assert.equal(out(res).queuedHead, H, round);
    assert.equal(out(res).recordRoot, recorded, round);
    const rec = readQueueRecord(root, PR);
    assert.equal(rec.terminal, null, round);
    assert.equal(rec.removals.length, 1, `${round}: noteRemoval is once`);
    assert.equal(rec.hold.id, HOLD.id, round);
  }
  assert.deepEqual(writes(gh), []);
});

test('4. precheck from K, a SECOND group failure not yet on the record: queue-removed with the reason, the record ends removed, the hold is restored once (not requeue-due, not head-moved)', async () => {
  const root = repoDir();
  recordAt(root);
  noteRemoval(root, PR, { reason: 'failed_checks', beforeCommit: QC1, at: '2026-11-09T08:30:00Z' });
  const gh = stub({ states: [st()], events: [SECOND] });
  const res = await routeFor(root, gh).precheck();
  assert.equal(out(res).error, 'queue-removed');
  assert.equal(out(res).removal.reason, 'failed_checks');
  assert.equal(out(res).removal.beforeCommit, QC2);
  assert.deepEqual(out(res).removal.failing, ['e2e: timed_out']);
  assert.equal(out(res).holdRestored, true);
  const rec = readQueueRecord(root, PR);
  assert.equal(rec.terminal, 'removed');
  assert.equal(rec.removals.length, 2);
  assert.deepEqual(writes(gh), ['add needs-human']);
});

test('5. precheck from K, the PR merged: reported merged (neutral note), the record ends merged, nothing restored', async () => {
  const root = repoDir();
  recordAt(root);
  const gh = stub({ states: [st({ state: 'MERGED', mergeSha: MERGE })] });
  const res = await routeFor(root, gh).precheck();
  assert.equal(res.done.exitCode, 0);
  assert.equal(out(res).merged, true);
  assert.equal(out(res).mergeSha, MERGE);
  assert.equal(out(res).note, 'already merged through the queue');
  assert.equal(readQueueRecord(root, PR).terminal, 'merged');
  assert.deepEqual(writes(gh), []);
});

test('5b. precheck from K, the PR closed: closed, the record ends closed with the hold restored once', async () => {
  const root = repoDir();
  recordAt(root);
  const gh = stub({ states: [st({ state: 'CLOSED' })] });
  const res = await routeFor(root, gh).precheck();
  assert.equal(out(res).error, 'closed');
  assert.equal(readQueueRecord(root, PR).terminal, 'closed');
  assert.deepEqual(writes(gh), ['add needs-human']);
});

test('5c. precheck from K, the entry at H is still queued: watch, nothing changed', async () => {
  const root = repoDir();
  recordAt(root);
  const before = rawRecord(root);
  const gh = stub({ states: [inQ()] });
  const res = await routeFor(root, gh).precheck();
  assert.deepEqual(res, { watch: true });
  assert.equal(rawRecord(root), before);
});

test('6. precheck from K, GitHub at H, not queued, no removal: head-moved for the caller, the record stays live and untouched, no hold restore', async () => {
  const root = repoDir();
  recordAt(root);
  const before = rawRecord(root);
  const gh = stub({ states: [st()], events: [[addedAt()]] });
  const res = await routeFor(root, gh).precheck();
  assert.equal(res.done.exitCode, 1);
  assert.equal(out(res).error, 'head-moved');
  assert.equal(out(res).queued, false);
  assert.match(out(res).reasons[0], /PR #7 is at aaaaaaaaaaaa, queued by the worktree at .*; this worktree is at cccccccccccc; nothing was queued for it; the queue record is left to `P queue-sweep`/);
  assert.equal(rawRecord(root), before, 'byte-identical');
  assert.deepEqual(writes(gh), []);
});

// ---- 7. the PR head moved off the record's head (GitHub at J) -----------------------------------------------------------------------------

for (const [name, moved] of [['J = K (this worktree)', K], ['J is a third head', J]]) {
  test(`7a. GitHub at ${name} with a LIVE entry: nothing is changed (record byte-identical, no label, no dequeue, no enqueue); refused head-moved naming both approvals`, async () => {
    const root = repoDir();
    recordAt(root);
    const before = rawRecord(root);
    const gh = stub({ states: [inQ({ head: moved })] });
    const res = await routeFor(root, gh).precheck();
    assert.equal(res.done.exitCode, 1);
    assert.equal(res.enqueue, undefined);
    assert.equal(out(res).error, 'head-moved');
    assert.equal(out(res).queued, true);
    assert.match(out(res).reasons[0], new RegExp(`PR #7 is in the merge queue at ${moved.slice(0, 12)}, but the live queue record here is for aaaaaaaaaaaa \\(another approval\\); nothing was changed: \`P queue-sweep\` settles that record, then run \`P merge\` again`));
    assert.equal(rawRecord(root), before, 'byte-identical');
    assert.deepEqual(writes(gh), []);
  });
}

test('7b. GitHub at K, no entry, the record holds a lifted hold: H ends head-moved (label restored once), then the caller enqueues K from a clean slate', async () => {
  const root = repoDir();
  recordAt(root);
  const gh = stub({ states: [st({ head: K })], events: [[]] });
  const res = await routeFor(root, gh).precheck();
  assert.equal(res.done, undefined, 'not refused');
  assert.equal(res.enqueue, true);
  assert.equal(res.requeue, false);
  assert.deepEqual(res.holdFields, { holdRestored: true, holdRestoredNote: RESTORE_NOTE }, 'the caller is told the label went back (R1-F1)');
  assert.deepEqual(writes(gh), ['add needs-human'], 'the hold went back exactly once');
  const old = readQueueRecord(root, PR);
  assert.equal(old.terminal, 'head-moved');
  assert.equal(old.head, H);
  // the caller's flow: a NEW record for K replaces the ended one
  const fresh = openRecord(root, PR, K, APPROVAL, { ...IDENT, route: 'owner-go' });
  assert.equal(fresh.head, K);
  assert.equal(fresh.hold, null);
  assert.equal(fresh.attempts, 0);
  assert.equal(fresh.terminal, null);
});

test('7b\'. the same with NO hold on the record: H ends head-moved, no label call, the caller enqueues', async () => {
  const root = repoDir();
  recordAt(root, { hold: false });
  const gh = stub({ states: [st({ head: K })], events: [[]] });
  const res = await routeFor(root, gh).precheck();
  assert.equal(res.enqueue, true);
  assert.equal(res.holdFields, undefined, 'no label went back: nothing to report');
  assert.deepEqual(writes(gh), []);
  assert.equal(readQueueRecord(root, PR).terminal, 'head-moved');
});

test('7c. GitHub at a third head J, no entry: H ends head-moved (restored once), the caller is refused head-moved', async () => {
  const root = repoDir();
  recordAt(root);
  const gh = stub({ states: [st({ head: J })], events: [[]] });
  const res = await routeFor(root, gh).precheck();
  assert.equal(res.enqueue, undefined);
  assert.equal(out(res).error, 'head-moved');
  assert.equal(out(res).holdRestored, true, 'the refusal says the label went back (R1-F1)');
  assert.equal(out(res).holdRestoredNote, RESTORE_NOTE);
  assert.deepEqual(writes(gh), ['add needs-human'], 'restored once, not twice');
  assert.equal(readQueueRecord(root, PR).terminal, 'head-moved');
});

test('7c\'. the same with NO hold on the record: the head-moved refusal reports no restore', async () => {
  const root = repoDir();
  recordAt(root, { hold: false });
  const gh = stub({ states: [st({ head: J })], events: [[]] });
  const res = await routeFor(root, gh).precheck();
  assert.equal(out(res).error, 'head-moved');
  assert.equal('holdRestored' in out(res), false);
  assert.equal('holdRestoredNote' in out(res), false);
  assert.deepEqual(writes(gh), []);
});

test('7d. GitHub at K, no entry, the restore FAILS: H\'s record stays live (nothing is lost), the caller is refused, nothing is enqueued', async () => {
  const root = repoDir();
  recordAt(root);
  const gh = stub({ states: [st({ head: K })], events: [[]], addFails: true });
  const res = await routeFor(root, gh).precheck();
  assert.equal(res.enqueue, undefined);
  assert.equal(out(res).error, 'head-moved');
  assert.equal(out(res).holdRestoreFailed, true);
  assert.match(out(res).reasons.join(' '), /COULD NOT put needs-human back/);
  const rec = readQueueRecord(root, PR);
  assert.equal(rec.terminal, null);
  assert.equal(rec.head, H);
  assert.equal(rec.hold.id, HOLD.id);
  assert.deepEqual(gh.calls.filter((c) => c.startsWith('enqueue')), []);
});

// ---- 9. the recorded worktree cannot do the re-queue (R1-F2): the removal ends the record now, with the hold restored, instead of waiting for a sweep that cannot help ----

// Both ways into the removal: the watch (resumed from this worktree) and the precheck (the entry already left).
const viaWatch = (route) => route.enqueueAndWatch({ watchOnly: true }).then((res) => ({ out: res.output, exitCode: res.exitCode }));
const viaPrecheck = (route) => route.precheck().then((res) => ({ out: res.done.output, exitCode: res.done.exitCode }));
const ways = [['watch', viaWatch, () => stub({ states: [inQ(), st()], events: [FIRST] })], ['precheck', viaPrecheck, () => stub({ states: [st()], events: [FIRST] })]];

test('9a. the SAME worktree moved from H to K (nothing pushed): queue-removed, the record ends removed, the hold is restored once; never requeue-due', async () => {
  for (const [way, run, makeGh] of ways) {
    const root = repoDir();
    git(root, 'commit', '-q', '--allow-empty', '-m', 'one');
    recordAt(root); // rec.root is this very worktree, whose HEAD is now K
    const gh = makeGh();
    const { out: o, exitCode } = await run(routeFor(root, gh, K, { headOf: () => K }));
    assert.equal(exitCode, 1, way);
    assert.equal(o.error, 'queue-removed', way);
    assert.match(o.reasons[0], /not re-queued: the worktree that queued it is this one, now at cccccccccccc \(it queued aaaaaaaaaaaa\)/, way);
    assert.equal(o.holdRestored, true, way);
    assert.equal(readQueueRecord(root, PR).terminal, 'removed', way);
    assert.deepEqual(writes(gh), ['add needs-human'], `${way}: the hold went back once`);
  }
});

test('9b. the recorded worktree is GONE: queue-removed, the record ends removed, the hold is restored once', async () => {
  for (const [way, run, makeGh] of ways) {
    const { here, recorded, headOf } = pair();
    recordAt(recorded);
    rmSync(recorded, { recursive: true, force: true });
    const gh = makeGh();
    const { out: o, exitCode } = await run(routeFor(here, gh, K, { headOf }));
    assert.equal(exitCode, 1, way);
    assert.equal(o.error, 'queue-removed', way);
    assert.match(o.reasons[0], /not re-queued: the worktree that queued it \(.*w1\) cannot re-queue it: worktree gone/, way);
    assert.equal(readQueueRecord(here, PR).terminal, 'removed', way);
    assert.deepEqual(writes(gh), ['add needs-human'], way);
  }
});

test('9c. the recorded worktree sits at ANOTHER head: queue-removed, the record ends removed, the hold is restored once', async () => {
  for (const [way, run, makeGh] of ways) {
    const { here, recorded } = pair();
    recordAt(recorded);
    const gh = makeGh();
    const { out: o, exitCode } = await run(routeFor(here, gh, K, { headOf: () => J }));
    assert.equal(exitCode, 1, way);
    assert.equal(o.error, 'queue-removed', way);
    assert.match(o.reasons[0], /cannot re-queue it: worktree at another head \(dddddddddddd, approved aaaaaaaaaaaa\)/, way);
    assert.equal(readQueueRecord(here, PR).terminal, 'removed', way);
    assert.deepEqual(writes(gh), ['add needs-human'], way);
  }
});

test('9d. the recorded root is a worktree of ANOTHER repository: queue-removed, the record ends removed, the hold is restored once', async () => {
  const { here, recorded } = pair();
  recordAt(recorded);
  const stranger = repoDir();
  git(stranger, 'commit', '-q', '--allow-empty', '-m', 'x');
  const file = queueRecordPath(here, PR);
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), root: stranger }));
  const gh = stub({ states: [st()], events: [FIRST] });
  const { out: o } = await viaPrecheck(routeFor(here, gh, K, { headOf: () => H }));
  assert.equal(o.error, 'queue-removed');
  assert.match(o.reasons[0], /cannot re-queue it: worktree belongs to another repository/);
  assert.equal(readQueueRecord(here, PR).terminal, 'removed');
  assert.deepEqual(writes(gh), ['add needs-human']);
});

// ---- 8. the hand-off through the real sweep -----------------------------------------------------------------------------------------------

test('8. P merge in W2 (at K) leaves the removal for the sweep; the sweep re-queues H from W1 under the recorded route, approval and hold; a second removal restores the label once', async () => {
  // two worktrees of one clone share the record directory (the git common dir)
  const w1 = repoDir();
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8' }).trim();
  git(w1, 'commit', '-q', '--allow-empty', '-m', 'one');
  const headW1 = git(w1, 'rev-parse', 'HEAD');
  const w2 = join(mkdtempSync(join(tmpdir(), 'cp-otherhead-wt-')), 'w2');
  git(w1, 'worktree', 'add', '-q', '--detach', w2);
  git(w2, 'commit', '-q', '--allow-empty', '-m', 'two');
  const headW2 = git(w2, 'rev-parse', 'HEAD');
  assert.notEqual(headW1, headW2);

  openRecord(w1, PR, headW1, APPROVAL, { ...IDENT, route: 'owner-go' });
  setHold(w1, PR, HOLD);
  beginAttempt(w1, PR, headW1, APPROVAL, IDENT);
  confirmAttempt(w1, PR, 'MQE_1');

  // GitHub: queued at headW1, then the entry fails its group
  const gh = stub({ states: [inQ({ head: headW1 }), st({ head: headW1 })], events: [FIRST] });
  const watched = await routeFor(w2, gh, headW2).enqueueAndWatch({ watchOnly: true });
  assert.equal(watched.output.error, 'requeue-due');
  assert.equal(readQueueRecord(w2, PR).terminal, null);
  assert.deepEqual(writes(gh), []);

  // the sweep: the records are in the common dir; W1 is the recorded worktree and sits at headW1
  const lockDir = mkdtempSync(join(tmpdir(), 'cp-otherhead-locks-'));
  const env = { PIPELINE_LOCK_DIR: lockDir, PIPELINE_QUEUE_CONFIRM_MS: '50', PIPELINE_QUEUE_CONFIRM_POLL_MS: '1' };
  const said = [];
  const rechecks = [];
  gh.enqueue = (n, head) => {
    gh.calls.push(`enqueue ${n} ${head}`);
    gh.script({ states: [inQ({ head: headW1 })], events: [[...FIRST, addedAt('09:00:00')]] });
  };
  gh.script({ states: [st({ head: headW1 })], events: [FIRST] });
  const sweep = () => sweepRepo({
    root: w2, env, notify: (t) => said.push(t), makeGh: () => gh, sleep: async () => {}, loadCfg: async () => ({ ok: true, config: { merge: { ...DEFAULTS.merge }, default_branch: 'main' } }),
    recheckFn: async (args) => { rechecks.push(args); return { ok: true }; },
  });
  const first = await sweep();
  assert.deepEqual(first.errors, []);
  assert.equal(first.settled[0].outcome, 'requeued');
  assert.deepEqual(gh.calls.filter((c) => c.startsWith('enqueue')), [`enqueue ${PR} ${headW1}`], 'the enqueue targets the recorded head, from W1');
  assert.equal(rechecks.length, 1);
  assert.equal(rechecks[0].root, w1, 'rechecked in the recorded worktree');
  assert.equal(rechecks[0].head, headW1);
  assert.deepEqual(rechecks[0].hold, { id: HOLD.id, login: HOLD.login, at: HOLD.at }, 'the RECORDED hold binding');
  const requeued = readQueueRecord(w2, PR);
  assert.equal(requeued.terminal, null);
  assert.equal(requeued.route, 'owner-go');
  assert.deepEqual(requeued.approval, { items: 'abc123', areas: null, rulings: null });
  assert.equal(requeued.attempts, 2);
  assert.equal(requeued.hold.id, HOLD.id);
  assert.deepEqual(gh.labels, [], 'the hold stays lifted');

  // a second removal: the label goes back once and the record ends
  const secondEvents = [...FIRST, addedAt('09:00:00'), removedAt('failed_checks', '09:30:00', QC2)];
  gh.script({ states: [st({ head: headW1 })], events: [secondEvents] });
  const second = await sweep();
  assert.equal(second.settled[0].outcome, 'ended');
  assert.equal(second.settled[0].terminal, 'removed');
  assert.deepEqual(gh.calls.filter((c) => c.startsWith('add')), ['add needs-human']);
  assert.deepEqual(gh.labels, ['needs-human']);
  assert.equal(readQueueRecord(w2, PR).terminal, 'removed');
  assert.equal(said.length, 1);
});
