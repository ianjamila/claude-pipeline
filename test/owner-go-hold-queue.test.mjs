// `P merge --owner-go` in queue mode: the QUEUE ENTRY owns a needs-human hold the owner's "merge" lifted (plan Task 3, hold ownership: the three-state
// machine session -> pending -> entry, settleRecord, the F3 orphan path, the F7 guard wait). The CLI tests run the real command against
// test/fixtures/fake-gh-queue.mjs (GitHub's merge queue) with test/fixtures/fake-gh-hold.mjs behind it (labels, timeline, comments); the unit tests
// drive lib/merge-queue.mjs and withHoldLifted with a stub gh. The queue route without a hold is covered by merge-queue-route.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ownerSays } from './helpers/owner-go.mjs';
import { bump, cli, scenario, ymlFor, MERGE_SHA, PR } from './helpers/gate-env.mjs';
import { assertExit } from './helpers/assert-exit.mjs';
import { readyLine } from '../pipeline/hooks/lib/owner-go.mjs';
import { renderEvent } from '../pipeline/lib/run-events.mjs';
import { withHoldLifted } from '../pipeline/lib/hold.mjs';
import {
  beginAttempt, clearSessionHold, confirmAttempt, endRecord, holdOnSignal, liveRecords, noteRemoval, openRecord, readQueueRecord, recordOwnsHold, recordedHold, recoverQueuedLift,
  settleGuardStatuses, settleRecord, setHold,
} from '../pipeline/lib/merge-queue.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE_QUEUE = join(HERE, 'fixtures', 'fake-gh-queue.mjs');
const FAKE_HOLD = join(HERE, 'fixtures', 'fake-gh-hold.mjs');
const QC1 = 'b'.repeat(40);
const QC2 = 'e'.repeat(40);
const STAMP = new Date().toISOString();
const HOLD = { id: 'LE_hold1', login: 'jamila', at: '2026-11-05T09:00:00Z' };
const ev = (event, name, node_id, login, created_at) => ({ event, id: 1, node_id, created_at, actor: { login }, label: { name } });
const HOLD_EVENT = ev('labeled', 'needs-human', HOLD.id, HOLD.login, HOLD.at);

// ---- GitHub's queue, as in merge-queue-route.test.mjs ----------------------------------------------------------------------------------------
const node = (head, over = {}) => ({ id: 'PR_node12', state: 'OPEN', headRefOid: head, isMergeQueueEnabled: true, mergeCommit: null, mergeQueueEntry: null, ...over });
const queuedNode = (head, position = 1) => node(head, { mergeQueueEntry: { id: 'MQE_1', state: 'AWAITING_CHECKS', position, enqueuedAt: STAMP, headCommit: { oid: QC1 } } });
const added = () => ({ __typename: 'AddedToMergeQueueEvent', createdAt: STAMP, actor: { login: 'owner' } });
const removedEv = (reason, before = QC1) => ({ __typename: 'RemovedFromMergeQueueEvent', createdAt: STAMP, reason, actor: { login: 'github-merge-queue' }, beforeCommit: { oid: before } });
const reply = (pr, events = []) => ({ pr, events });
const Q = (position = 1, events = [added()]) => (h) => reply(queuedNode(h, position), events);
const M = () => (h) => reply(node(h, { state: 'MERGED', mergeCommit: { oid: MERGE_SHA } }));
const OUT = (events) => (h) => reply(node(h), events);

const stateFile = () => join(mkdtempSync(join(tmpdir(), 'cp-queue-hold-')), 'queue.json');
const goYml = () => ymlFor().replace(/ {2}command: .*\n/, '');
const yml = () => `${goYml()}hard_stops:\n  paths: ['src/**']\nowner_approval: chat\n`;
const unique = (repo) => { bump(repo); repo.write('.salt', randomUUID()); };

// A PR held by needs-human with a merge queue on the base: the queue fake answers the GraphQL queue calls, the hold fake everything else.
function world({ after = [], state = {}, gh = {}, env = {}, liftedChecks } = {}) {
  const qfile = stateFile();
  const timing = { PIPELINE_HOLD_RETRY_MS: '1', PIPELINE_QUEUE_POLL_MS: '20', PIPELINE_QUEUE_CONFIRM_MS: '400', PIPELINE_QUEUE_CONFIRM_POLL_MS: '20', PIPELINE_QUEUE_WAIT_MS: '300', PIPELINE_MERGE_POLL_MS: '20', ...env };
  const s = scenario({
    yml: yml(), report: null, state: null, change: unique,
    gh: {
      mergeStateStatus: 'CLEAN', labels: ['needs-human'], queue: true, ...gh,
      extra: [
        { match: '^pr view 12 --json state,labels', stdoutJson: { state: 'OPEN', labels: [] } },
        { match: '^api repos/acme/widgets --jq \\.id$', stdout: '4242\n' },
        { match: `commits/${QC1}/check-runs`, stdoutJson: [{ name: 'ci', conclusion: 'failure' }] },
        { match: `commits/${QC1}/statuses`, stdoutJson: [] },
        { match: `commits/${QC2}/check-runs`, stdoutJson: [{ name: 'e2e', conclusion: 'timed_out' }] },
        { match: `commits/${QC2}/statuses`, stdoutJson: [] },
        ...(gh.extra ?? []),
      ],
    },
    env,
  });
  Object.assign(s.env, timing);
  const hfile = join(s.fake.dir, 'hold-state.json');
  writeFileSync(hfile, JSON.stringify({ labels: ['needs-human'], timeline: [HOLD_EVENT], comments: [], clock: 100, seq: 0, hooks: [], overrides: { timeline: {} }, fail: {}, ...state }));
  Object.assign(s.fake.env, { PIPELINE_GH: `node "${FAKE_QUEUE}"`, PIPELINE_FAKE_GH_QUEUE: qfile, PIPELINE_FAKE_GH_FALLBACK: FAKE_HOLD, PIPELINE_FAKE_GH_STATE: hfile });
  const phases = [[OUT([])], ...after].map((p) => p.map((make) => make(s.head)));
  const q = {
    read: () => JSON.parse(readFileSync(qfile, 'utf8')),
    write: (st) => writeFileSync(qfile, JSON.stringify(st)),
    set(patch) { q.write({ ...q.read(), ...patch }); },
    show(...next) { q.set({ phase: 0, idx: 0, last: 0, phases: next.map((p) => p.map((make) => make(s.head))) }); },
  };
  q.write({ phase: 0, idx: 0, last: 0, enqueues: 0, phases, ...(liftedChecks ? { liftedChecks } : {}) });
  s.q = q;
  s.st = () => JSON.parse(readFileSync(hfile, 'utf8'));
  s.patch = (fn) => { const cur = s.st(); fn(cur); writeFileSync(hfile, JSON.stringify(cur)); };
  s.go = () => cli(['merge', '--pr', String(PR), '--owner-go'], { dir: s.repo.dir, fake: s.fake, env: s.env });
  s.gated = () => cli(['merge', '--pr', String(PR)], { dir: s.repo.dir, fake: s.fake, env: s.env });
  s.dry = () => cli(['merge', '--pr', String(PR), '--dry-run', '--owner-go'], { dir: s.repo.dir, fake: s.fake, env: s.env });
  s.lines = () => s.fake.lines();
  s.enqueues = () => s.fake.calls().filter((c) => c.argv.join(' ').includes('mutation Enqueue'));
  s.dequeues = () => s.fake.calls().filter((c) => c.argv.join(' ').includes('mutation Dequeue'));
  s.readds = () => s.lines().filter((l) => /^pr edit 12 --add-label needs-human$/.test(l));
  s.rec = () => readQueueRecord(s.repo.dir, PR);
  return s;
}

const replyOf = (step) => ['Protected areas and the hold are listed above.', step.areas, step.hold, step.line, step.ready ?? readyLine([PR])].filter(Boolean).join('\n');
const approve = (t, s) => {
  const d = s.dry();
  assertExit(d, 0, `${d.stderr}${d.stdout}`);
  ownerSays(t, 'merge', replyOf(d.json.ownerStep));
  return d.json.ownerStep;
};
const never = (s, re, why) => assert.ok(!s.lines().some((l) => re.test(l)), why);

// ---- CLI: the entry owns the lifted hold -----------------------------------------------------------------------------------------------------

test('hold lift + stillQueued: the label is NOT restored; the record owns the lift (owner entry, full binding); no dequeue, no disable-auto', (t) => {
  const s = world({ after: [[Q(2)]] });
  approve(t, s);
  const r = s.go();
  assertExit(r, 0, `${r.stderr}${r.stdout}`);
  assert.equal(r.json.merged, false);
  assert.equal(r.json.stillQueued, true);
  assert.equal(r.json.queue, true);
  assert.equal(r.json.holdLifted, HOLD.id);
  assert.equal(r.json.holdRecordOwned, true);
  assert.deepEqual(s.st().labels, [], 'needs-human stays lifted while the entry waits');
  assert.deepEqual(s.readds(), []);
  assert.equal(s.dequeues().length, 0);
  never(s, /--disable-auto/, 'auto-merge is never touched');
  const rec = s.rec();
  assert.equal(rec.terminal, null);
  assert.equal(rec.hold.owner, 'entry');
  assert.deepEqual({ id: rec.hold.id, login: rec.hold.login, at: rec.hold.at }, HOLD);
  assert.match(rec.hold.holdBlock, /^[0-9a-f]{64}$/);
  assert.deepEqual(recordedHold(rec), HOLD);
});

test('hold lift + merged: the label stays off, holdLifted reported, record merged', (t) => {
  const s = world({ after: [[Q(), M()]] });
  approve(t, s);
  const r = s.go();
  assertExit(r, 0, `${r.stderr}${r.stdout}`);
  assert.equal(r.json.merged, true);
  assert.equal(r.json.holdLifted, HOLD.id);
  assert.deepEqual(s.readds(), []);
  assert.equal(s.rec().terminal, 'merged');
});

test('hold lift + final removal: the label is restored once and the record ends', (t) => {
  const s = world({ after: [[Q(), OUT([added(), removedEv('manual')])]] });
  approve(t, s);
  const r = s.go();
  assertExit(r, 1, `${r.stderr}${r.stdout}`);
  assert.equal(r.json.error, 'queue-removed');
  assert.equal(r.json.holdRestored, true);
  assert.match(JSON.stringify(r.json), /the owner must say \\"merge\\" again/);
  assert.deepEqual(s.st().labels, ['needs-human']);
  assert.equal(s.readds().length, 1, 'restored exactly once');
  assert.equal(s.rec().terminal, 'removed');
});

test('hold lift + the first failed_checks removal: the hold stays lifted and the SAME head is re-queued once; the label is restored only after the second removal', (t) => {
  const first = [added(), removedEv('failed_checks')];
  const second = [...first, added(), removedEv('failed_checks', QC2)];
  const s = world({ after: [[Q(), OUT(first)], [Q(1, [...first, added()]), OUT(second)]] });
  approve(t, s);
  const r = s.go();
  assertExit(r, 1, `${r.stderr}${r.stdout}`);
  assert.equal(r.json.error, 'queue-removed');
  assert.equal(r.json.requeued, 1);
  assert.equal(s.enqueues().length, 2);
  assert.equal(r.json.holdRestored, true);
  assert.equal(s.readds().length, 1, 'restored once, after the final removal only');
  const lines = s.lines();
  assert.ok(lines.findIndex((l) => /mutation Enqueue/.test(l)) < lines.findIndex((l) => /--add-label needs-human/.test(l)));
});

test('enqueue-failed after a lift: nothing was queued, so the hold goes back as today and the record no longer carries it', (t) => {
  const s = world({ after: [], gh: {} });
  s.q.set({ enqueueFail: { 1: 'gh: expected head oid does not match the current head oid' } });
  approve(t, s);
  const r = s.go();
  assertExit(r, 1, `${r.stderr}${r.stdout}`);
  assert.equal(r.json.error, 'enqueue-failed');
  assert.equal(r.json.holdRestored, true);
  assert.deepEqual(s.st().labels, ['needs-human']);
  assert.equal(s.rec().hold, null, 'a hold the process put back itself is not left on the record');
  assert.equal(s.rec().attempts, 0);
});

// ---- CLI: a restart ------------------------------------------------------------------------------------------------------------------------

test('restart after the first failed_checks removal with a lifted hold: re-queued once under the RECORDED hold binding; the label is NOT restored', (t) => {
  const first = [added(), removedEv('failed_checks')];
  const s = world({ after: [[Q()]] });
  approve(t, s);
  assertExit(s.go(), 0); // run 1: queued, the observer's budget ends (stillQueued); the record owns the lift
  assert.equal(s.rec().hold.owner, 'entry');
  s.q.show([OUT(first)], [Q(1, [...first, added()]), M()]); // the entry fails its group, then the re-queue merges
  const r = s.go(); // run 2: a new process; the label is off, so the live hold reads "none"; the recorded binding is what the owner approved
  assertExit(r, 0, `${r.stderr}${r.stdout}`);
  assert.equal(r.json.merged, true);
  assert.equal(r.json.requeued, 1);
  assert.equal(r.json.holdLifted, HOLD.id);
  assert.equal(s.enqueues().length, 2);
  assert.deepEqual(s.enqueues().map((c) => c.argv.find((a) => a.startsWith('expectedHeadOid='))), [`expectedHeadOid=${s.head}`, `expectedHeadOid=${s.head}`]);
  assert.deepEqual(s.st().labels, [], 'never restored');
  assert.deepEqual(s.readds(), []);
  never(s, /--disable-auto/, 'auto-merge is never touched');
  const rec = s.rec();
  assert.equal(rec.terminal, 'merged');
  assert.equal(rec.removals.length, 1);
  assert.equal(rec.attempts, 2);
});

test('restart after the second removal: the label is restored once and the record is terminal', (t) => {
  const second = [added(), removedEv('failed_checks'), added(), removedEv('failed_checks', QC2)];
  const s = world({ after: [[Q()]] });
  approve(t, s);
  assertExit(s.go(), 0);
  noteRemoval(s.repo.dir, PR, { reason: 'failed_checks', beforeCommit: QC1, at: '2026-11-09T08:00:00Z' }); // (the first removal, seen by a watcher that has since died)
  s.q.show([OUT(second)]);
  const r = s.go();
  assertExit(r, 1, `${r.stderr}${r.stdout}`);
  assert.equal(r.json.error, 'hold-recovery');
  assert.equal(r.json.holdRestored, true);
  assert.match(r.json.reasons[0], /e2e: timed_out/);
  assert.deepEqual(s.st().labels, ['needs-human']);
  assert.equal(s.readds().length, 1);
  assert.equal(s.enqueues().length, 1, 'nothing enqueued again');
  assert.equal(s.rec().terminal, 'removed');
  never(s, /--disable-auto/, 'auto-merge is never touched');
});

test('orphan recovery: record with a lift, the entry gone, a removal that is not re-queueable, not merged: the label is restored (and again nothing the second time)', (t) => {
  const s = world({ after: [[Q()]] });
  approve(t, s);
  assertExit(s.go(), 0);
  s.q.show([OUT([added(), removedEv('manual')])]);
  const r = s.go();
  assertExit(r, 1);
  assert.equal(r.json.error, 'hold-recovery');
  assert.equal(r.json.holdRestored, true);
  assert.deepEqual(s.st().labels, ['needs-human']);
  assert.equal(s.rec().terminal, 'removed');
  assert.equal(s.readds().length, 1);
  assert.equal(s.enqueues().length, 1);
});

test('re-queue while a NEW needs-human label is on: blocked, no enqueue, nothing restored on top, the record ends', (t) => {
  const first = [added(), removedEv('failed_checks')];
  const s = world({ after: [[Q()]] });
  approve(t, s);
  assertExit(s.go(), 0);
  s.q.show([OUT(first)], [Q(1, [...first, added()]), M()]);
  s.patch((st) => { st.labels = ['needs-human']; st.timeline.push(ev('labeled', 'needs-human', 'LE_new', 'someone', '2026-11-05T11:00:00Z')); });
  const r = s.go();
  assertExit(r, 1, `${r.stderr}${r.stdout}`);
  assert.equal(r.json.error, 'blocked');
  assert.match(r.json.reasons[0], /new needs-human hold \(LE_new\)/);
  assert.equal(s.enqueues().length, 1, 'not re-queued');
  assert.deepEqual(s.readds(), [], 'the new hold is not touched');
  assert.equal(s.rec().terminal, 'blocked');
});

test('a stop condition while the entry owns the hold: dequeued, the label restored once, the record ends (the next run reconciles)', (t) => {
  const s = world({ after: [[Q()]] });
  approve(t, s);
  assertExit(s.go(), 0);
  // An open pause issue appears. Queue reads in order: the mode read, settle's reconcile, the watch's reconcile (all still queued), then the confirm after the dequeue (gone).
  s.q.show([Q(), Q(), Q(), OUT([added(), removedEv('manual')])]);
  s.fake.setScript(JSON.parse(readFileSync(s.fake.env.PIPELINE_FAKE_GH_SCRIPT, 'utf8')).map((e) => (e.match === '^issue list --label pipeline-pause' ? { ...e, stdoutJson: [{ number: 9 }] } : e)));
  const r = s.go();
  assertExit(r, 1, `${r.stderr}${r.stdout}`);
  assert.equal(r.json.error, 'hold-recovery');
  assert.equal(s.dequeues().length, 1);
  assert.equal(r.json.holdRestored, true);
  assert.deepEqual(s.st().labels, ['needs-human']);
  assert.equal(s.rec().terminal, 'blocked');
});

// ---- CLI: F3, no record ---------------------------------------------------------------------------------------------------------------------------

// A lift comment of a run on ANOTHER clone: the label is off, the lift comment names the head, the hold and its binding; no record exists here.
const liftComment = (head) => ({ id: 9, body: renderEvent('hold-lifted', 'pr12-x', 'hold LE_hold1 lifted', { repo: 'acme/widgets', pr: PR, head, items: 'none', hold: HOLD.id, login: HOLD.login, at: HOLD.at }), user: { login: 'me' }, created_at: '2026-11-05T09:30:00Z', updated_at: '2026-11-05T09:30:00Z' });
const orphanState = (head) => ({ labels: [], comments: [liftComment(head)], timeline: [HOLD_EVENT, ev('unlabeled', 'needs-human', 'UE_1', 'me', '2026-11-05T09:31:00Z')] });

test('orphan recovery with NO record and a live entry at the lift head: a record is written (owner entry), no disable-auto, no restore; refused queued-elsewhere (both routes)', () => {
  for (const route of ['go', 'gated']) {
    const s = world({ after: [] });
    s.patch((st) => Object.assign(st, orphanState(s.head)));
    s.q.show([Q(3)]);
    assert.equal(s.rec(), null);
    const r = s[route]();
    assertExit(r, 1, `${r.stderr}${r.stdout}`);
    assert.equal(r.json.error, 'queued-elsewhere', route);
    assert.equal(r.json.queued, true);
    never(s, /--disable-auto|auto-merge/, `${route}: auto-merge is never touched`);
    assert.deepEqual(s.readds(), [], `${route}: nothing restored`);
    assert.equal(s.enqueues().length, 0);
    assert.equal(s.dequeues().length, 0);
    const rec = s.rec();
    assert.equal(rec.terminal, null);
    assert.equal(rec.head, s.head);
    assert.equal(rec.hold.owner, 'entry');
    assert.deepEqual({ id: rec.hold.id, login: rec.hold.login, at: rec.hold.at }, HOLD);
    assert.deepEqual(rec.entryIds, ['MQE_1']);
  }
});

test('orphan recovery with NO record and the PR not queued: today\'s path (auto-merge disarmed, the label put back)', () => {
  const s = world({ after: [] });
  s.patch((st) => Object.assign(st, orphanState(s.head)));
  const r = s.go();
  assertExit(r, 1, `${r.stderr}${r.stdout}`);
  assert.equal(r.json.error, 'hold-recovery');
  assert.equal(r.json.holdRestored, true);
  assert.ok(s.lines().some((l) => /--disable-auto/.test(l)), 'not queued: auto-merge is disarmed first, as before');
  assert.deepEqual(s.st().labels, ['needs-human']);
});

// #232: a live record for ANOTHER head (OLD: the worktree that queued it) while this checkout is at s.head. The CLI reads GitHub in this order: the mode read, orphan
// recovery (settleRecord for the record's head), then the route's precheck.
const OLD = 'd'.repeat(40);
const liveRecordAtOld = (s) => {
  const approval = { items: 'none', areas: [], rulings: null };
  openRecord(s.repo.dir, PR, OLD, approval, { repo: 'acme/widgets', repoId: 4242, route: 'owner-go' });
  setHold(s.repo.dir, PR, HOLD);
  beginAttempt(s.repo.dir, PR, OLD, approval, { repo: 'acme/widgets', repoId: 4242 });
  confirmAttempt(s.repo.dir, PR, 'MQE_1');
};
const entryAtOld = () => reply(queuedNode(OLD), [added()]);

test('#232 GitHub shows the record\'s head during orphan recovery and a live entry at THIS head at the precheck: nothing is changed, refused head-moved naming both approvals', () => {
  const s = world({ after: [] });
  s.patch((st) => Object.assign(st, orphanState(OLD)));
  liveRecordAtOld(s);
  const before = JSON.stringify(s.rec());
  s.q.show([entryAtOld, entryAtOld, Q(2)]); // mode read, recovery: the entry at OLD; the precheck: the PR now has an entry at this head
  const r = s.go();
  assertExit(r, 1, `${r.stderr}${r.stdout}`);
  assert.equal(r.json.error, 'head-moved');
  assert.equal(r.json.queued, true);
  assert.deepEqual(r.json.reasons, [`PR #${PR} is in the merge queue at ${s.head.slice(0, 12)}, but the live queue record here is for ${OLD.slice(0, 12)} (another approval); nothing was changed: \`P queue-sweep\` settles that record, then run \`P merge\` again`]);
  assert.equal(JSON.stringify(s.rec()), before, 'H\'s record is untouched');
  assert.deepEqual(s.readds(), []);
  assert.deepEqual(s.st().labels, []);
  assert.equal(s.enqueues().length, 0);
  assert.equal(s.dequeues().length, 0);
  never(s, /--disable-auto|auto-merge/, 'auto-merge is never touched');
});

// #238: the same discharge, then GitHub blips on the first read of the PR (the owner-go flow's live scan): exit 3 (unavailable), and the owner still hears the label went back.
test('#238 the precheck puts needs-human back, then a GitHub read of the PR throws: the unavailable output (exit 3) still carries holdRestored + holdRestoredNote', () => {
  const s = world({ after: [] });
  s.patch((st) => Object.assign(st, orphanState(OLD)));
  liveRecordAtOld(s);
  s.q.show([entryAtOld, entryAtOld, (h) => reply(node(h), [])]);
  const wrapper = join(mkdtempSync(join(tmpdir(), 'cp-blip-')), 'gh.mjs');
  writeFileSync(wrapper, [
    "import { spawnSync } from 'node:child_process';",
    "import { existsSync, readFileSync } from 'node:fs';",
    "const log = process.env.PIPELINE_FAKE_GH_LOG;",
    "const restored = existsSync(log) && readFileSync(log, 'utf8').includes('--add-label');",
    "const argv = process.argv.slice(2);",
    "if (restored && argv.join(' ').startsWith('pr view 12')) { process.stderr.write('gh: Server Error (HTTP 502)'); process.exit(1); }",
    "const r = spawnSync(process.execPath, [process.env.WRAPPED_FAKE, ...argv], { stdio: 'inherit' });",
    "process.exit(r.status ?? 1);",
  ].join('\n'));
  Object.assign(s.fake.env, { PIPELINE_GH: `node "${wrapper}"`, WRAPPED_FAKE: FAKE_QUEUE });
  const r = s.go();
  assertExit(r, 3, `${r.stderr}${r.stdout}`);
  assert.equal(r.json.error, 'unavailable');
  assert.equal(r.json.holdRestored, true, r.stdout);
  assert.match(r.json.holdRestoredNote, /owner must say "merge" again/);
  assert.equal(s.rec().terminal, 'head-moved', 'the old record was discharged by the precheck');
  assert.deepEqual(s.st().labels, ['needs-human']);
  assert.equal(s.enqueues().length, 0);
});

test('#232 GitHub shows the record\'s head during orphan recovery and this head with NO entry at the precheck: the record is discharged first (label back once), the new hold is not lifted blindly', () => {
  const s = world({ after: [] });
  s.patch((st) => Object.assign(st, orphanState(OLD)));
  liveRecordAtOld(s);
  s.q.show([entryAtOld, entryAtOld, (h) => reply(node(h), [])]); // mode read, recovery: queued at OLD; the precheck: the PR is at this head and not queued
  const r = s.go();
  assertExit(r, 1, `${r.stderr}${r.stdout}`);
  assert.equal(r.json.error, 'owner-go', 'the caller\'s flow runs from a clean slate and fails closed on the restored label (a hold the dry run never showed)');
  assert.match(r.json.reasons[0], /no owner "merge" is recorded/);
  assert.equal(r.json.holdRestored, true, 'the refusal still tells the owner the label went back, though it comes from the caller\'s own gate (R1-F1)');
  assert.match(r.json.holdRestoredNote, /owner must say "merge" again/);
  assert.equal(s.rec().head, OLD);
  assert.equal(s.rec().terminal, 'head-moved', 'the old record is over');
  assert.equal(s.readds().length, 1, 'its hold went back exactly once');
  assert.deepEqual(s.st().labels, ['needs-human']);
  assert.equal(s.enqueues().length, 0, 'the restored label is a hold the owner never saw: nothing is enqueued');
  never(s, /--disable-auto|auto-merge/, 'auto-merge is never touched');
});

test('#232 GitHub is already at this head with no entry during orphan recovery: the existing early refusal (the record\'s hold goes back, hold-recovery)', () => {
  const s = world({ after: [] });
  s.patch((st) => Object.assign(st, orphanState(OLD)));
  liveRecordAtOld(s);
  s.q.show([(h) => reply(node(h), [])]); // every read: at this head, not queued
  const r = s.go();
  assertExit(r, 1, `${r.stderr}${r.stdout}`);
  assert.equal(r.json.error, 'hold-recovery');
  assert.equal(r.json.holdRestored, true);
  assert.equal(s.rec().terminal, 'head-moved');
  assert.equal(s.readds().length, 1);
  assert.equal(s.enqueues().length, 0);
});

test('orphan recovery with NO record and an unreadable queue: refused, nothing disarmed, nothing restored', () => {
  const s = world({ after: [] });
  s.patch((st) => Object.assign(st, orphanState(s.head)));
  // (the mode read comes first and works; the F3 read fails)
  s.q.set({ failQueueStateFrom: 2 });
  const r = s.go();
  assertExit(r, 1, `${r.stderr}${r.stdout}`);
  assert.ok(['hold-recovery', 'queue-unreadable'].includes(r.json.error), r.stdout);
  never(s, /--disable-auto/, 'nothing disarmed');
  assert.deepEqual(s.readds(), []);
});

// ---- CLI: F7, the guards re-run after the lift ------------------------------------------------------------------------------------------

const ROWS = (state) => [{ name: 'ci', state: 'SUCCESS', bucket: 'pass' }, ...['Test integrity', 'Hard-stop scan', 'Cross-model review'].map((name) => ({ name, state, bucket: state === 'PENDING' ? 'pending' : state === 'SUCCESS' ? 'pass' : 'fail' }))];

test('hold lift: the guards re-post pending, so the enqueue waits until they settle; red after the wait is refused and the hold is put back', (t) => {
  const s = world({ after: [[Q(), M()]], liftedChecks: [ROWS('PENDING'), ROWS('PENDING'), ROWS('FAILURE')], env: { PIPELINE_MERGE_WAIT_MS: '5000' } });
  approve(t, s);
  const r = s.go();
  assertExit(r, 1, `${r.stderr}${r.stdout}`);
  assert.equal(r.json.error, 'pre-merge');
  assert.match(r.json.reasons[0], /guard check\(s\) not passing after the hold lift re-ran them: Test integrity=fail/);
  assert.equal(s.enqueues().length, 0, 'nothing enqueued');
  assert.equal(r.json.holdRestored, true);
  assert.deepEqual(s.st().labels, ['needs-human']);
  assert.equal(s.rec(), null, 'no record: the enqueue never started');
  assert.equal(s.q.read().liftedChecksIdx, 3, 'it polled until the statuses left pending');
});

test('hold lift: guards still pending when the merge wait ends => refused, the hold put back', (t) => {
  const s = world({ after: [[Q(), M()]], liftedChecks: [ROWS('PENDING')], env: { PIPELINE_MERGE_WAIT_MS: '200' } });
  approve(t, s);
  const r = s.go();
  assertExit(r, 1, `${r.stderr}${r.stdout}`);
  assert.equal(r.json.error, 'pre-merge');
  assert.match(r.json.reasons[0], /guard check\(s\) still pending: Test integrity, Hard-stop scan, Cross-model review after 0 s/);
  assert.equal(s.enqueues().length, 0);
  assert.deepEqual(s.st().labels, ['needs-human']);
});

test('hold lift: pending first, then settled (no guard row is left to doubt): the enqueue follows the wait', (t) => {
  const s = world({ after: [[Q(), M()]], liftedChecks: [ROWS('PENDING'), ROWS('PENDING'), [{ name: 'ci', state: 'SUCCESS', bucket: 'pass' }]], env: { PIPELINE_MERGE_WAIT_MS: '5000' } });
  approve(t, s);
  const r = s.go();
  assertExit(r, 0, `${r.stderr}${r.stdout}`);
  assert.equal(r.json.merged, true);
  const lines = s.lines();
  const lastChecks = lines.map((l, i) => (/^pr checks 12 .*json name,state,bucket/.test(l) && !/--required/.test(l) ? i : -1)).filter((i) => i >= 0).at(-1);
  assert.ok(lastChecks < lines.findIndex((l) => /mutation Enqueue/.test(l)), 'the last guard read came before the enqueue');
  assert.equal(s.q.read().liftedChecksIdx, 3);
});

// ---- unit: lib/merge-queue.mjs ----------------------------------------------------------------------------------------------------------------

const HEAD = 'a'.repeat(40);
const APPROVAL = { items: 'abc123', areas: null, rulings: null };
const IDENT = { repo: 'acme/widgets', repoId: 42 };
const repoDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-mqhold-'));
  execFileSync('git', ['init', '-q', dir]);
  return dir;
};
const script = (list) => {
  let i = 0;
  return () => {
    const item = list[Math.min(i, list.length - 1)];
    i += 1;
    if (item instanceof Error) throw item;
    return item;
  };
};
const st = (over = {}) => ({ enabled: true, inQueue: false, state: 'OPEN', head: HEAD, mergeSha: null, entry: null, ...over });
const inQ = (position = 1) => st({ inQueue: true, entry: { id: 'MQE_1', state: 'AWAITING_CHECKS', position, enqueuedAt: '2026-11-09T08:00:00Z', headCommit: null } });
const evt = (type, at, reason = null, beforeCommit = null) => ({ type, at: `2026-11-09T${at}Z`, reason, actor: 'github-merge-queue', beforeCommit });
const addedAt = (at = '08:00:00') => evt('added', at);
const removedAt = (reason, at = '08:30:00', before = QC1) => evt('removed', at, reason, before);
const clock = () => { const c = { t: Date.parse('2026-11-09T09:00:00Z') }; c.now = () => c.t; c.sleep = async (ms) => { c.t += ms; }; return c; };
// A stub gh: queue reads are scripts, labels live in `m.labels`; calls are recorded.
function stub({ states, events = [[]], labels = [], prState = 'OPEN', addFails = false, issues = {} }) {
  const nextState = script(states);
  const nextEvents = script(events);
  const m = {
    calls: [], labels: [...labels], prState,
    queueState: () => nextState(),
    queueEvents: () => nextEvents(),
    prView: () => ({ state: m.prState, labels: m.labels.map((name) => ({ name })), mergeCommit: null }),
    addLabels: (pr, names) => { m.calls.push(`add ${names}`); if (addFails) throw new Error('boom 502'); for (const n of names) if (!m.labels.includes(n)) m.labels.push(n); },
    listIssues: ({ label }) => issues[label] ?? [],
    dequeue: (n) => { m.calls.push(`dequeue ${n}`); },
    checkRunsOf: () => [{ name: 'ci', conclusion: 'failure' }],
    statusesOf: () => [],
    repo: () => ({ slug: 'acme/widgets' }),
    repoId: () => 42,
  };
  return m;
}
const HOLD_BINDING = { id: HOLD.id, login: HOLD.login, at: HOLD.at, holdBlock: 'digest', liftedAt: '2026-11-09T07:59:00Z' };
// A record the way P merge leaves it after a confirmed enqueue with a lifted hold.
function entryRecord(root, pr = 7) {
  openRecord(root, pr, HEAD, APPROVAL, IDENT);
  setHold(root, pr, HOLD_BINDING);
  beginAttempt(root, pr, HEAD, APPROVAL, IDENT);
  confirmAttempt(root, pr, 'MQE_1');
}

test('settleRecord: merged => the record ends merged and the label is NOT restored', async () => {
  const root = repoDir();
  entryRecord(root);
  const gh = stub({ states: [st({ state: 'MERGED', mergeSha: 'c'.repeat(40) })] });
  const said = [];
  const out = await settleRecord({ gh, root, pr: 7, notify: (x) => said.push(x) });
  assert.equal(out.outcome, 'merged');
  assert.equal(out.mergeSha, 'c'.repeat(40));
  assert.equal(readQueueRecord(root, 7).terminal, 'merged');
  assert.deepEqual(gh.calls, []);
  assert.match(said[0], /merged through the merge queue/);
  assert.equal((await settleRecord({ gh, root, pr: 7 })).outcome, 'none', 'a second settle has nothing to do');
});

test('settleRecord: still queued => nothing changes, hold stays lifted; a pending attempt is adopted (owner entry)', async () => {
  const root = repoDir();
  openRecord(root, 7, HEAD, APPROVAL, IDENT);
  setHold(root, 7, HOLD_BINDING);
  beginAttempt(root, 7, HEAD, APPROVAL, IDENT); // the process died between the mutation and the confirm
  assert.equal(readQueueRecord(root, 7).hold.owner, 'pending');
  const gh = stub({ states: [inQ(2)] });
  const out = await settleRecord({ gh, root, pr: 7 });
  assert.equal(out.outcome, 'queued');
  assert.equal(out.position, 2);
  const rec = readQueueRecord(root, 7);
  assert.equal(rec.hold.owner, 'entry');
  assert.equal(rec.pending, null);
  assert.deepEqual(rec.entryIds, ['MQE_1']);
  assert.deepEqual(gh.calls, []);
});

test('settleRecord: a re-queueable removal is left alone without a requeue function (requeue-due) and handed to it with one; a requeue that refuses ends it and restores the label', async () => {
  const mk = () => { const root = repoDir(); entryRecord(root); return root; };
  const events = [[addedAt(), removedAt('failed_checks')]];
  const due = mk();
  const gh1 = stub({ states: [st()], events });
  const a = await settleRecord({ gh: gh1, root: due, pr: 7 });
  assert.equal(a.outcome, 'requeue-due');
  assert.equal(readQueueRecord(due, 7).terminal, null);
  assert.equal(readQueueRecord(due, 7).hold.owner, 'entry', 'the hold stays lifted');
  assert.deepEqual(gh1.calls, []);

  const ok = mk();
  const seen = [];
  const b = await settleRecord({ gh: stub({ states: [st()], events }), root: ok, pr: 7, requeue: async (x) => { seen.push(x.removal.reason); return { ok: true }; } });
  assert.equal(b.outcome, 'requeued');
  assert.deepEqual(seen, ['failed_checks']);
  assert.equal(readQueueRecord(ok, 7).terminal, null);

  const no = mk();
  const gh3 = stub({ states: [st()], events });
  const said = [];
  const c = await settleRecord({ gh: gh3, root: no, pr: 7, notify: (x) => said.push(x), requeue: async () => ({ ok: false, reasons: ['the worktree is gone'] }) });
  assert.equal(c.outcome, 'ended');
  assert.equal(c.terminal, 'removed');
  assert.equal(c.hold, 'restored');
  assert.deepEqual(gh3.calls, ['add needs-human']);
  assert.equal(readQueueRecord(no, 7).terminal, 'removed');
  assert.match(said[0], /removed from the merge queue \(reason failed_checks\); failing: ci: failure once and was not re-queued: the worktree is gone/);
});

test('settleRecord: a removal that is not re-queueable (manual, or the second failed_checks) restores the label once, idempotently', async () => {
  for (const events of [[[addedAt(), removedAt('manual')]], [[addedAt(), removedAt('failed_checks'), addedAt('08:40:00'), removedAt('failed_checks', '08:50:00', QC2)]]]) {
    const root = repoDir();
    entryRecord(root);
    if (events[0].length > 2) noteRemoval(root, 7, { reason: 'failed_checks', beforeCommit: QC1, at: '2026-11-09T08:30:00Z' });
    const gh = stub({ states: [st()], events });
    const out = await settleRecord({ gh, root, pr: 7 });
    assert.equal(out.outcome, 'ended');
    assert.equal(out.hold, 'restored');
    assert.deepEqual(gh.calls, ['add needs-human']);
    assert.equal(readQueueRecord(root, 7).terminal, 'removed');
  }
  // The label is on already (a NEW hold): nothing is added on top of it.
  const root = repoDir();
  entryRecord(root);
  const gh = stub({ states: [st()], events: [[addedAt(), removedAt('manual')]], labels: ['needs-human'] });
  const out = await settleRecord({ gh, root, pr: 7 });
  assert.equal(out.outcome, 'ended');
  assert.equal(out.hold, 'already-on');
  assert.deepEqual(gh.calls, []);
});

test('settleRecord: a restore that fails keeps the record open (the next settle retries); closed and head-moved are terminal too', async () => {
  const root = repoDir();
  entryRecord(root);
  const bad = stub({ states: [st()], events: [[addedAt(), removedAt('manual')]], addFails: true });
  const out = await settleRecord({ gh: bad, root, pr: 7 });
  assert.equal(out.outcome, 'restore-failed');
  assert.match(out.why, /boom 502/);
  assert.equal(readQueueRecord(root, 7).terminal, null);
  const good = stub({ states: [st()], events: [[addedAt(), removedAt('manual')]] });
  assert.equal((await settleRecord({ gh: good, root, pr: 7 })).outcome, 'ended');
  assert.equal(readQueueRecord(root, 7).terminal, 'removed');

  for (const [state, terminal] of [[st({ state: 'CLOSED' }), 'closed'], [st({ head: 'f'.repeat(40) }), 'head-moved']]) {
    const r = repoDir();
    entryRecord(r);
    const gh = stub({ states: [state] });
    const o = await settleRecord({ gh, root: r, pr: 7 });
    assert.equal(o.terminal, terminal);
    assert.deepEqual(gh.calls, ['add needs-human']);
  }
});

test('settleRecord: an unreadable queue changes nothing (unsettled); an attempt that never reached GitHub restores the hold; an empty record is dropped', async () => {
  const root = repoDir();
  entryRecord(root);
  const gh = stub({ states: [new Error('HTTP 502')] });
  const out = await settleRecord({ gh, root, pr: 7 });
  assert.equal(out.outcome, 'unsettled');
  assert.equal(readQueueRecord(root, 7).terminal, null);
  assert.deepEqual(gh.calls, []);

  const never = repoDir(); // lifted, enqueue started, never landed
  openRecord(never, 8, HEAD, APPROVAL, IDENT);
  setHold(never, 8, HOLD_BINDING);
  beginAttempt(never, 8, HEAD, APPROVAL, IDENT);
  const gh2 = stub({ states: [st()], events: [[]] });
  const o2 = await settleRecord({ gh: gh2, root: never, pr: 8 });
  assert.equal(o2.outcome, 'ended');
  assert.equal(o2.hold, 'restored');
  assert.deepEqual(gh2.calls, ['add needs-human']);
  assert.equal(readQueueRecord(never, 8).attempts, 0, 'the attempt was dropped, not counted');

  const idle = repoDir(); // enqueue-failed with no hold: nothing to settle, nothing left behind
  openRecord(idle, 9, HEAD, APPROVAL, IDENT);
  const o3 = await settleRecord({ gh: stub({ states: [st()], events: [[]] }), root: idle, pr: 9 });
  assert.equal(o3.outcome, 'idle');
  assert.equal(readQueueRecord(idle, 9), null);
  assert.deepEqual(liveRecords(idle), []);
});

test('settleRecord: a live stop condition dequeues the entry (confirmed) and the owned hold goes back', async () => {
  const root = repoDir();
  entryRecord(root);
  const gh = stub({ states: [inQ(), inQ(), st()], events: [[addedAt(), removedAt('manual', '08:20:00', null)]], issues: { 'pipeline-pause': [{ number: 9 }] } });
  const c = clock();
  const out = await settleRecord({ gh, root, pr: 7, now: c.now, sleep: c.sleep });
  assert.equal(out.outcome, 'ended');
  assert.equal(out.terminal, 'blocked');
  assert.deepEqual(gh.calls, ['dequeue 7', 'add needs-human']);
  assert.equal(readQueueRecord(root, 7).terminal, 'blocked');
});

test('recordedHold / recordOwnsHold / clearSessionHold', () => {
  const root = repoDir();
  openRecord(root, 7, HEAD, APPROVAL, IDENT);
  assert.equal(recordedHold(readQueueRecord(root, 7)), null);
  assert.equal(recordOwnsHold(root, 7), false);
  setHold(root, 7, HOLD_BINDING);
  assert.equal(recordOwnsHold(root, 7), false, 'session: the process\'s own');
  beginAttempt(root, 7, HEAD, APPROVAL, IDENT);
  assert.equal(recordOwnsHold(root, 7), true, 'pending: the record\'s');
  clearSessionHold(root, 7);
  assert.notEqual(readQueueRecord(root, 7).hold, null, 'only a session hold is cleared');
  confirmAttempt(root, 7, 'MQE_1');
  assert.equal(recordOwnsHold(root, 7), true);
  assert.equal(recordOwnsHold(root, 99), false, 'no record');
  const r2 = repoDir();
  openRecord(r2, 7, HEAD, APPROVAL, IDENT);
  setHold(r2, 7, HOLD_BINDING);
  clearSessionHold(r2, 7);
  assert.equal(readQueueRecord(r2, 7).hold, null);
  endRecord(r2, 7, 'removed');
  assert.equal(recordOwnsHold(r2, 7), false, 'a terminal record owns nothing');
});

// ---- unit: signals while the record owns (or may own) the lift ------------------------------------------------------------------------------------

// A gh for withHoldLifted plus the queue reads: the pieces hold.mjs uses and a scripted queue.
function liftGh({ states, events = [[]], labels = ['needs-human'] }) {
  const m = stub({ states, events, labels });
  const timeline = [{ event: 'labeled', id: 1, node_id: HOLD.id, created_at: HOLD.at, actor: { login: HOLD.login }, label: { name: 'needs-human' } }];
  const comments = [];
  return Object.assign(m, {
    timelineOf: () => timeline,
    prView: () => ({ state: m.prState, headRefOid: HEAD, labels: m.labels.map((name) => ({ name })), mergeCommit: null }),
    addLabels: (pr, names) => { m.calls.push(`add ${names}`); for (const n of names) if (!m.labels.includes(n)) { m.labels.push(n); timeline.push({ event: 'labeled', id: 2, node_id: `LE_re${timeline.length}`, created_at: '2026-11-05T10:30:00Z', actor: { login: 'me' }, label: { name: n } }); } },
    deleteLabel: (pr, name) => { m.calls.push(`delete ${name}`); m.labels = m.labels.filter((l) => l !== name); timeline.push({ event: 'unlabeled', id: 3, node_id: 'UE_own', created_at: '2026-11-05T10:00:00Z', actor: { login: 'me' }, label: { name } }); },
    createComment: (pr, body) => { const id = 100 + comments.length; comments.push({ id, body }); timeline.push({ event: 'commented', id, node_id: `IC_${id}`, created_at: '2026-11-05T10:00:01Z', actor: { login: 'me' }, body }); return { id }; },
    listComments: () => comments,
    viewer: () => 'me',
  });
}
const refuseFn = (error, reasons, extra = {}) => ({ exitCode: 1, output: { ok: false, error, reasons, ...extra } });
const lift = (gh, root, over = {}) => withHoldLifted({
  gh, pr: 7, hold: HOLD, head: HEAD, items: 'none', repo: 'acme/widgets', env: { PIPELINE_HOLD_RETRY_MS: '1' }, proc: new EventEmitter(), refuse: refuseFn, check: async () => [],
  kill: () => {}, disableAuto: () => { gh.calls.push('disable-auto'); }, exit: () => {},
  queue: { onSignal: () => holdOnSignal({ gh, root, pr: 7, sleepSync: () => {}, retryMs: 1, budgetMs: 5 }), owns: () => recordOwnsHold(root, 7), restored: () => clearSessionHold(root, 7) },
  merge: async () => ({ exitCode: 0, output: { ok: true, merged: true } }),
  ...over,
});
const labelsAfterLift = (gh) => gh.labels;

test('withHoldLifted (queue): a signal AFTER the confirm restores nothing and never disarms auto-merge or dequeues', async () => {
  const root = repoDir();
  const gh = liftGh({ states: [inQ()] });
  const proc = new EventEmitter();
  await lift(gh, root, {
    proc,
    merge: async () => {
      openRecord(root, 7, HEAD, APPROVAL, IDENT);
      setHold(root, 7, HOLD_BINDING);
      beginAttempt(root, 7, HEAD, APPROVAL, IDENT);
      confirmAttempt(root, 7, 'MQE_1');
      proc.emit('SIGTERM');
      return { exitCode: 0, output: { ok: true, merged: false, stillQueued: true } };
    },
  });
  assert.ok(!gh.calls.some((c) => /^(add|disable-auto|dequeue)/.test(c)), gh.calls.join(' | '));
  assert.deepEqual(labelsAfterLift(gh), [], 'the label stays off');
  assert.equal(readQueueRecord(root, 7).hold.owner, 'entry');
});

test('withHoldLifted (queue): a signal in the PENDING window, GitHub already queued it: no restore, owner becomes entry', async () => {
  const root = repoDir();
  const gh = liftGh({ states: [inQ()] });
  const proc = new EventEmitter();
  await lift(gh, root, {
    proc,
    merge: async () => {
      openRecord(root, 7, HEAD, APPROVAL, IDENT);
      setHold(root, 7, HOLD_BINDING);
      beginAttempt(root, 7, HEAD, APPROVAL, IDENT); // the mutation may or may not have landed
      proc.emit('SIGTERM');
      return { exitCode: 1, output: { ok: false, merged: false, error: 'queue-unreadable', reasons: ['x'] } };
    },
  });
  assert.ok(!gh.calls.some((c) => /^(add|disable-auto|dequeue)/.test(c)), gh.calls.join(' | '));
  const rec = readQueueRecord(root, 7);
  assert.equal(rec.hold.owner, 'entry');
  assert.deepEqual(rec.entryIds, ['MQE_1']);
});

test('withHoldLifted (queue): a signal in the pending window with an UNREADABLE queue: no restore, the record stays pending', async () => {
  const root = repoDir();
  const gh = liftGh({ states: [new Error('HTTP 502')] });
  const proc = new EventEmitter();
  const r = await lift(gh, root, {
    proc,
    merge: async () => {
      openRecord(root, 7, HEAD, APPROVAL, IDENT);
      setHold(root, 7, HOLD_BINDING);
      beginAttempt(root, 7, HEAD, APPROVAL, IDENT);
      proc.emit('SIGTERM');
      return { exitCode: 1, output: { ok: false, merged: false, error: 'queue-unreadable', reasons: ['x'] } };
    },
  });
  assert.ok(!gh.calls.some((c) => /^(add|disable-auto|dequeue)/.test(c)), gh.calls.join(' | '));
  const rec = readQueueRecord(root, 7);
  assert.equal(rec.hold.owner, 'pending');
  assert.equal(rec.pending.head, HEAD);
  assert.equal(r.output.holdRecordOwned, true, 'the unknown outcome is the record\'s: reported, not restored');
});

test('withHoldLifted (queue): a signal in the pending window when GitHub confirms nothing was queued: the label goes back, the attempt is dropped, no auto-merge call', async () => {
  const root = repoDir();
  const gh = liftGh({ states: [st()], events: [[]] });
  const proc = new EventEmitter();
  await lift(gh, root, {
    proc,
    merge: async () => {
      openRecord(root, 7, HEAD, APPROVAL, IDENT);
      setHold(root, 7, HOLD_BINDING);
      beginAttempt(root, 7, HEAD, APPROVAL, IDENT);
      proc.emit('SIGTERM');
      return { exitCode: 1, output: { ok: false, merged: false, error: 'enqueue-failed', reasons: ['x'] } };
    },
  });
  assert.deepEqual(gh.calls.filter((c) => /^(add|disable-auto|dequeue)/.test(c)), ['add needs-human'], 'restored once, with no disable-auto');
  const rec = readQueueRecord(root, 7);
  assert.equal(rec.attempts, 0);
  assert.equal(rec.hold, null);
});

test('withHoldLifted (queue): a signal in the SESSION window (no enqueue yet) restores like today, but without touching auto-merge', async () => {
  const root = repoDir();
  const gh = liftGh({ states: [st()] });
  const proc = new EventEmitter();
  await lift(gh, root, {
    proc,
    merge: async () => {
      openRecord(root, 7, HEAD, APPROVAL, IDENT);
      setHold(root, 7, HOLD_BINDING);
      proc.emit('SIGINT');
      return { exitCode: 1, output: { ok: false, merged: false, error: 'pre-merge', reasons: ['x'] } };
    },
  });
  assert.deepEqual(gh.calls.filter((c) => /^(add|disable-auto|dequeue)/.test(c)), ['add needs-human']);
});

test('withHoldLifted (queue): an exception while the record owns the lift leaves the label off and still throws', async () => {
  const root = repoDir();
  const gh = liftGh({ states: [inQ()] });
  await assert.rejects(lift(gh, root, {
    merge: async () => {
      openRecord(root, 7, HEAD, APPROVAL, IDENT);
      setHold(root, 7, HOLD_BINDING);
      beginAttempt(root, 7, HEAD, APPROVAL, IDENT);
      confirmAttempt(root, 7, 'MQE_1');
      throw new Error('kaboom');
    },
  }), (err) => /kaboom/.test(err.message) && err.holdRecordOwned === true);
  assert.ok(!gh.calls.some((c) => /^add/.test(c)));
});

test('withHoldLifted (queue): a refusal before any enqueue (no record) restores as today', async () => {
  const root = repoDir();
  const gh = liftGh({ states: [st()] });
  const r = await lift(gh, root, { merge: async () => refuseFn('pre-merge', ['guards pending']) });
  assert.equal(r.output.holdRestored, true);
  assert.deepEqual(gh.labels, ['needs-human']);
});

test('holdOnSignal: no record / session => restore; entry => keep; an unreadable record => keep', () => {
  const root = repoDir();
  const gh = stub({ states: [st()] });
  assert.deepEqual(holdOnSignal({ gh, root, pr: 7 }), { restore: true });
  openRecord(root, 7, HEAD, APPROVAL, IDENT);
  assert.deepEqual(holdOnSignal({ gh, root, pr: 7 }), { restore: true }, 'a record without a hold: as today');
  setHold(root, 7, HOLD_BINDING);
  assert.equal(holdOnSignal({ gh, root, pr: 7 }).restore, true);
  beginAttempt(root, 7, HEAD, APPROVAL, IDENT);
  confirmAttempt(root, 7, 'MQE_1');
  assert.deepEqual(holdOnSignal({ gh, root, pr: 7 }), { restore: false });
  writeFileSync(join(root, '.git', 'pipeline', 'merge-queue', 'pr-7.json'), '{not json');
  assert.deepEqual(holdOnSignal({ gh, root, pr: 7 }), { restore: false });
});

// ---- unit: F3 and F7 ----------------------------------------------------------------------------------------------------------------------------

test('recoverQueuedLift: a live record that is gone from the queue unmerged is settled (label back, refuse); merged / still queued / re-queue due let the run go on', async () => {
  const orphan = { hold: HOLD.id };
  const mk = (states, events) => { const root = repoDir(); entryRecord(root); return { root, gh: stub({ states, events }) }; };
  const a = mk([st({ state: 'MERGED', mergeSha: 'c'.repeat(40) })]);
  assert.deepEqual(await recoverQueuedLift({ ...a, pr: 7, orphan, lift: { head: HEAD } }), { action: 'proceed' });
  const b = mk([inQ()]);
  assert.deepEqual(await recoverQueuedLift({ ...b, pr: 7, orphan, lift: { head: HEAD } }), { action: 'proceed' });
  const c = mk([st()], [[addedAt(), removedAt('failed_checks')]]);
  assert.deepEqual(await recoverQueuedLift({ ...c, pr: 7, orphan, lift: { head: HEAD } }), { action: 'proceed' });
  assert.deepEqual(c.gh.calls, []);
  const d = mk([st()], [[addedAt(), removedAt('manual')]]);
  const out = await recoverQueuedLift({ ...d, pr: 7, orphan, lift: { head: HEAD } });
  assert.equal(out.action, 'refuse');
  assert.equal(out.error, 'hold-recovery');
  assert.equal(out.extra.holdRestored, true);
  assert.deepEqual(d.gh.calls, ['add needs-human']);
  const e = mk([new Error('HTTP 502')]);
  const unread = await recoverQueuedLift({ ...e, pr: 7, orphan, lift: { head: HEAD } });
  assert.equal(unread.action, 'refuse');
  assert.match(unread.reasons[0], /nothing was changed, and auto-merge was not touched/);
});

test('recoverQueuedLift: no record, and the lift comment names no usable head => refused (the queue cannot be checked), nothing touched', async () => {
  const root = repoDir();
  const gh = stub({ states: [st()] });
  const out = await recoverQueuedLift({ gh, root, pr: 7, orphan: { hold: HOLD.id }, lift: {} });
  assert.equal(out.action, 'refuse');
  assert.deepEqual(gh.calls, []);
});

test('settleGuardStatuses: waits out pending, then green with provenance => []; red, forged, unreadable and a timeout => reasons', async () => {
  const rows = (...buckets) => buckets.map((bucket, i) => ({ name: ['Test integrity', 'Hard-stop scan', 'Cross-model review'][i], bucket }));
  const run = async (seq, over = {}) => {
    const c = clock();
    let i = 0;
    const gh = { checks: () => { const x = seq[Math.min(i, seq.length - 1)]; i += 1; if (x instanceof Error) throw x; return x; } };
    return { out: await settleGuardStatuses({ gh, pr: 7, head: HEAD, waitMs: 60_000, pollMs: 10_000, now: c.now, sleep: c.sleep, provenance: () => [], ...over }), polls: () => i };
  };
  const ok = await run([rows('pending', 'pass', 'pending'), rows('pending', 'pass', 'pass'), rows('pass', 'pass', 'pass')]);
  assert.deepEqual(ok.out, []);
  assert.equal(ok.polls(), 3);
  assert.deepEqual((await run([[{ name: 'ci', bucket: 'pass' }]])).out, [], 'no guard rows: nothing to wait for');
  const red = await run([rows('pending', 'pending', 'pending'), rows('pass', 'fail', 'pass')]);
  assert.match(red.out[0], /not passing after the hold lift re-ran them: Hard-stop scan=fail/);
  const forged = await run([rows('pass', 'pass', 'pass')], { provenance: ({ names }) => [`${names[0]} (posted by someone)`] });
  assert.match(forged.out[0], /not posted by the pipeline-guards workflow: Test integrity \(posted by someone\)/);
  const stuck = await run([rows('pending', 'pass', 'pass')], { waitMs: 25_000 });
  assert.match(stuck.out[0], /still pending: Test integrity after 25 s/);
  const broken = await run([new Error('HTTP 502')], { waitMs: 15_000 });
  assert.match(broken.out[0], /could not read the checks \(HTTP 502\) after 15 s/);
});

test('R1-B3 a resumed --owner-go watch: the first failed_checks removal is re-queued once under the RECORDED hold binding (no placeholder refusal, no ReferenceError)', (t) => {
  const first = [added(), removedEv('failed_checks')];
  const s = world({ after: [[Q()]] });
  approve(t, s);
  assertExit(s.go(), 0); // run 1: queued, stillQueued; the record owns the lift
  s.q.show([Q(), Q(), Q(), OUT(first)], [Q(1, [...first, added()]), M()]); // (reads: queue mode, orphan recovery, precheck, then the watch) run 2 finds the entry queued, then sees it fail its group; the re-queue merges
  const r = s.go();
  assertExit(r, 0, `${r.stderr}${r.stdout}`);
  assert.equal(r.json.merged, true);
  assert.equal(r.json.requeued, 1);
  assert.equal(s.enqueues().length, 2);
  assert.deepEqual(s.readds(), [], 'the lifted hold is not put back');
  assert.equal(s.rec().terminal, 'merged');
  assert.equal(s.rec().attempts, 2);
});

// ---- #237: the PR head moved H -> J while a live entry sits at J -------------------------------------------------------------------------
// H's approval never covered J, so nothing here dequeues or re-queues on H's authority: H's record is replaced (one atomic write, so a crash leaves H's or J's, never
// neither) by an orphan record for J that the sweep keeps settling, as recoverQueuedLift's does, until J's departure is confirmed.
const J = 'f'.repeat(40);
const entryAtJ = (position = 1) => st({ head: J, inQueue: true, entry: { id: 'MQE_J', state: 'AWAITING_CHECKS', position, enqueuedAt: '2026-11-10T08:00:00Z', headCommit: null } });
const jGone = () => st({ head: J });
const movedWorld = (over = {}) => {
  const root = repoDir();
  entryRecord(root); // H's record: a lifted hold owned by the entry
  return { root, gh: stub({ states: [entryAtJ()], ...over }) };
};

test('#237 settleRecord: head moved with a live entry at J: the hold goes back, H\'s record is replaced by a live orphan record for J, and nothing is dequeued or enqueued', async () => {
  const { root, gh } = movedWorld();
  const out = await settleRecord({ gh, root, pr: 7 });
  assert.equal(out.outcome, 'ended');
  assert.equal(out.terminal, 'head-moved');
  assert.equal(out.hold, 'restored');
  assert.deepEqual(gh.labels, ['needs-human']);
  assert.deepEqual(gh.calls, ['add needs-human'], 'no dequeue');
  const rec = readQueueRecord(root, 7);
  assert.equal(rec.terminal, null, 'J is tracked');
  assert.equal(rec.head, J);
  assert.deepEqual(rec.entryIds, ['MQE_J']);
  assert.equal(rec.hold, null, 'H\'s hold is not carried over: the label on the PR is the hold now');
  assert.equal(rec.approval.items, null, 'H\'s approval does not cover J');
  assert.equal(rec.adopted.from, HEAD);
  assert.deepEqual(liveRecords(root).map((r) => [r.pr, r.head]), [[7, J]]);
});

test('#237 the orphan record for J is settled by the sweep: a stop condition dequeues J; a failed dequeue or an unreadable confirmation leaves it live; once J is gone it ends removed', async () => {
  const { root, gh } = movedWorld({ states: [entryAtJ()] });
  await settleRecord({ gh, root, pr: 7 }); // adopt J (the label goes back)
  const sweep = (g) => settleRecord({ gh: g, root, pr: 7, sleep: async () => {}, pollMs: 1 });
  // a failed dequeue
  let failing = true;
  const g1 = { ...gh, queueState: () => entryAtJ(), queueEvents: () => [addedAt()], dequeue: (n) => { gh.calls.push(`dequeue ${n}`); if (failing) throw new Error('boom 502'); } };
  const a = await sweep(g1);
  assert.equal(a.outcome, 'unsettled', JSON.stringify(a));
  assert.equal(readQueueRecord(root, 7).terminal, null, 'still tracked after a failed dequeue');
  // the dequeue goes out (reads 1-2: the settle and the watch poll) but the confirmation cannot be read
  failing = false;
  let reads = 0;
  const g2 = { ...g1, queueState: () => { reads += 1; if (reads > 2) throw new Error("HTTP 502"); return entryAtJ(); } };
  const b = await sweep(g2);
  assert.equal(b.outcome, 'unsettled', JSON.stringify(b));
  assert.equal(readQueueRecord(root, 7).terminal, null, 'still tracked while the confirmation is unreadable');
  // J is gone (the dequeue took)
  let n = 0;
  const g3 = { ...g1, queueState: () => (n++ === 0 ? entryAtJ() : jGone()), queueEvents: () => [addedAt(), evt('removed', '09:00:00', 'manual', QC1)] };
  const c = await sweep(g3);
  assert.equal(c.outcome, 'ended', JSON.stringify(c));
  assert.equal(c.terminal, 'removed', 'J left (the dequeue took): reported as removed');
  assert.equal(readQueueRecord(root, 7).terminal, 'removed');
  assert.equal(gh.calls.filter((x) => x.startsWith('add')).length, 1, 'the label was put back once, at the adoption');
});

test('#237 the orphan record for J that merges under the restored veto is reported merged; one removed for failed checks is never re-queued (no approval of J)', async () => {
  const merged = movedWorld();
  await settleRecord({ gh: merged.gh, root: merged.root, pr: 7 });
  const m = await settleRecord({ gh: stub({ states: [st({ head: J, state: 'MERGED', mergeSha: 'c'.repeat(40) })] }), root: merged.root, pr: 7 });
  assert.equal(m.outcome, 'merged');
  assert.equal(readQueueRecord(merged.root, 7).terminal, 'merged');

  const removed = movedWorld();
  await settleRecord({ gh: removed.gh, root: removed.root, pr: 7 });
  let asked = 0;
  const out = await settleRecord({
    gh: stub({ states: [jGone()], events: [[addedAt(), removedAt('failed_checks')]] }), root: removed.root, pr: 7,
    requeue: async () => { asked += 1; return { ok: true }; },
  });
  assert.equal(asked, 0, 'J is never re-queued');
  assert.equal(out.outcome, 'ended');
  assert.equal(out.terminal, 'removed');
});

test('#237 an interruption between putting the label back and replacing the record leaves H\'s record live: the next sweep finishes it (label already on)', async () => {
  const { root, gh } = movedWorld();
  const dying = ({ gh: g, pr }) => { g.addLabels(pr, ['needs-human']); throw new Error('killed'); };
  await assert.rejects(settleRecord({ gh, root, pr: 7, restore: dying }), /killed/);
  const mid = readQueueRecord(root, 7);
  assert.equal(mid.terminal, null);
  assert.equal(mid.head, HEAD, 'still H\'s record: nothing was lost');
  const out = await settleRecord({ gh: stub({ states: [entryAtJ()], labels: ['needs-human'] }), root, pr: 7 });
  assert.equal(out.outcome, 'ended');
  assert.equal(out.hold, 'already-on');
  const rec = readQueueRecord(root, 7);
  assert.deepEqual([rec.terminal, rec.head], [null, J]);
});

test('#237 a head that moved with NO entry at J still just ends H\'s record (head-moved), as before', async () => {
  const { root, gh } = movedWorld({ states: [jGone()] });
  const out = await settleRecord({ gh, root, pr: 7 });
  assert.equal(out.outcome, 'ended');
  assert.equal(readQueueRecord(root, 7).terminal, 'head-moved');
  assert.deepEqual(liveRecords(root), []);
});

test('#237 a head that moved whose entry cannot be read afterwards: nothing is ended or restored (the record stays live for the next sweep)', async () => {
  const root = repoDir();
  entryRecord(root);
  let reads = 0;
  const gh = stub({ states: [entryAtJ()] });
  gh.queueState = () => { reads += 1; if (reads > 1) throw new Error('HTTP 502'); return entryAtJ(); };
  const out = await settleRecord({ gh, root, pr: 7 });
  assert.equal(out.outcome, 'unsettled');
  assert.equal(readQueueRecord(root, 7).head, HEAD);
  assert.equal(readQueueRecord(root, 7).terminal, null);
  assert.deepEqual(gh.calls, []);
});
