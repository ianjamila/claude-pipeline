// Merge queue ("queue mode"): the GraphQL reads and writes in github.mjs, and the pure helpers in merge-queue.mjs.
// The gh calls run against the scripted fake gh (the queue is only read live, never from config).
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { GhError } from '../pipeline/lib/proc.mjs';
import { createGitHub } from '../pipeline/lib/github.mjs';
import { QueueUnreadable, queueModeFor, queueRulesOf, queueWaitMs, beginAttempt, confirmAttempt, endRecord, liveRecords, mayRequeue, noteRemoval, openRecord, readQueueRecord, reconcile, recordIsFor, setHold, watchQueue, queueRecordPath, REASON_GROUP_CHECKS, REASON_MANUAL, REASON_MERGED, REQUEUE_REASONS } from '../pipeline/lib/merge-queue.mjs';
import { createFakeGh, REPO_VIEW } from './helpers/fakegh-env.mjs';

const REPO = { match: '^repo view', stdoutJson: REPO_VIEW };
const HEAD = 'a'.repeat(40);
const QUEUE_COMMIT = 'b'.repeat(40);
const MERGE_SHA = 'c'.repeat(40);
const mk = (entries) => {
  const fake = createFakeGh([REPO, ...entries]);
  return { fake, gh: createGitHub({ cwd: process.cwd(), env: fake.env }) };
};
const prData = (pr) => ({ stdoutJson: { data: { repository: { pullRequest: pr } } } });
const queued = {
  id: 'PR_node1', state: 'OPEN', headRefOid: HEAD, isMergeQueueEnabled: true, mergeCommit: null,
  mergeQueueEntry: { id: 'MQE_1', state: 'AWAITING_CHECKS', position: 2, enqueuedAt: '2026-11-09T08:00:00Z', headCommit: { oid: QUEUE_COMMIT } },
};

// ---- queueModeFor ------------------------------------------------------------------------------------------------------------------

test('queueModeFor: enabled => queue; disabled => direct; a throw => QueueUnreadable (never "direct")', () => {
  const state = { enabled: true, inQueue: false, state: 'OPEN', head: HEAD, mergeSha: null, entry: null };
  assert.deepEqual(queueModeFor({ gh: { queueState: () => state }, pr: 5 }), { queue: true, state });
  assert.deepEqual(queueModeFor({ gh: { queueState: () => ({ ...state, enabled: false }) }, pr: 5 }).queue, false);
  const boom = new GhError({ code: 1, stderr: 'rate limited', args: ['api', 'graphql'] });
  assert.throws(() => queueModeFor({ gh: { queueState: () => { throw boom; } }, pr: 5 }), (err) => err instanceof QueueUnreadable && /rate limited/.test(err.message) && err.cause === boom);
  assert.throws(() => queueModeFor({ gh: {}, pr: 5 }), QueueUnreadable);
});

// ---- queueRulesOf ------------------------------------------------------------------------------------------------------------------

test('queueRulesOf reads the merge_queue rule; none => null', () => {
  const rule = { type: 'merge_queue', parameters: { check_response_timeout_minutes: 60, grouping_strategy: 'ALLGREEN', max_entries_to_build: 5, max_entries_to_merge: 5, merge_method: 'SQUASH', min_entries_to_merge: 1, min_entries_to_merge_wait_minutes: 5 } };
  assert.deepEqual(queueRulesOf([{ type: 'pull_request', parameters: {} }, rule]), { minWaitMinutes: 5, timeoutMinutes: 60, maxBuild: 5, mergeMethod: 'SQUASH' });
  assert.equal(queueRulesOf([{ type: 'pull_request', parameters: {} }]), null);
  assert.equal(queueRulesOf([]), null);
  assert.equal(queueRulesOf(null), null);
  assert.equal(queueRulesOf(undefined), null);
  // A rule without parameters is still a queue; the unknown numbers are null (queueWaitMs then uses its default).
  assert.deepEqual(queueRulesOf([{ type: 'merge_queue' }]), { minWaitMinutes: null, timeoutMinutes: null, maxBuild: null, mergeMethod: null });
});

// ---- queueWaitMs -------------------------------------------------------------------------------------------------------------------

test('queueWaitMs', () => {
  assert.equal(queueWaitMs({ minWaitMinutes: 5, timeoutMinutes: 60 }), 215 * 60_000);
  assert.equal(queueWaitMs({ minWaitMinutes: 30, timeoutMinutes: 120 }), 360 * 60_000);
  assert.equal(queueWaitMs(null), 120 * 60_000);
  assert.equal(queueWaitMs({ minWaitMinutes: null, timeoutMinutes: null }), 120 * 60_000);
});

// ---- gh.queueState -----------------------------------------------------------------------------------------------------------------

test('gh.queueState: one query; a queued PR carries its entry, a merged one its merge commit', () => {
  const { fake, gh } = mk([{ match: 'QueueState', ...prData(queued) }]);
  assert.deepEqual(gh.queueState(5), {
    enabled: true, inQueue: true, state: 'OPEN', head: HEAD, mergeSha: null,
    entry: { id: 'MQE_1', state: 'AWAITING_CHECKS', position: 2, enqueuedAt: '2026-11-09T08:00:00Z', headCommit: QUEUE_COMMIT },
  });
  assert.equal(fake.lines().filter((l) => l.startsWith('api graphql')).length, 1, 'one GraphQL query');
  const argv = fake.calls().find((c) => c.argv[0] === 'api').argv;
  assert.ok(argv.includes('number=5') && argv.includes('owner=acme') && argv.includes('name=widgets'), argv.join(' '));
  assert.ok(argv.includes('-F'), 'the number goes as a number (-F), the names as strings (-f)');

  const merged = mk([{ match: 'QueueState', ...prData({ id: 'PR_node1', state: 'MERGED', headRefOid: HEAD, isMergeQueueEnabled: true, mergeCommit: { oid: MERGE_SHA }, mergeQueueEntry: null }) }]);
  assert.deepEqual(merged.gh.queueState(5), { enabled: true, inQueue: false, state: 'MERGED', head: HEAD, mergeSha: MERGE_SHA, entry: null });
  const waiting = mk([{ match: 'QueueState', ...prData({ ...queued, mergeQueueEntry: { ...queued.mergeQueueEntry, state: 'QUEUED', headCommit: null } }) }]);
  assert.equal(waiting.gh.queueState(5).entry.headCommit, null);
});

test('gh.queueState: a missing pull request, a malformed reply or a gh failure throws (never "queue off")', () => {
  assert.throws(() => mk([{ match: 'QueueState', ...prData(null) }]).gh.queueState(5), GhError);
  assert.throws(() => mk([{ match: 'QueueState', ...prData({ ...queued, isMergeQueueEnabled: undefined }) }]).gh.queueState(5), GhError);
  assert.throws(() => mk([{ match: 'QueueState', ...prData({ ...queued, state: 'WEIRD' }) }]).gh.queueState(5), GhError);
  assert.throws(() => mk([{ match: 'QueueState', ...prData({ ...queued, mergeQueueEntry: { id: 'x' } }) }]).gh.queueState(5), GhError);
  assert.throws(() => mk([{ match: 'QueueState', code: 1, stderr: 'HTTP 502' }]).gh.queueState(5), GhError);
  assert.throws(() => mk([{ match: 'QueueState', stdoutJson: { errors: [{ message: 'RATE_LIMITED' }] } }]).gh.queueState(5), /RATE_LIMITED/);
});

// ---- gh.queueEvents ----------------------------------------------------------------------------------------------------------------

test('gh.queueEvents: added / removed / merged in timeline order, removals carry reason, actor and beforeCommit', () => {
  const nodes = [
    { __typename: 'AddedToMergeQueueEvent', createdAt: '2026-11-09T08:00:00Z', actor: { login: 'owner' } },
    { __typename: 'RemovedFromMergeQueueEvent', createdAt: '2026-11-09T08:10:00Z', reason: 'failed_checks', actor: { login: 'github-merge-queue' }, beforeCommit: { oid: QUEUE_COMMIT } },
    { __typename: 'AddedToMergeQueueEvent', createdAt: '2026-11-09T08:11:00Z', actor: { login: 'owner' } },
    { __typename: 'RemovedFromMergeQueueEvent', createdAt: '2026-11-09T08:20:00Z', reason: 'manual', actor: null, beforeCommit: null },
    { __typename: 'MergedEvent', createdAt: '2026-11-09T08:30:00Z', actor: { login: 'owner' } },
  ];
  const { fake, gh } = mk([{ match: 'QueueEvents', ...prData({ timelineItems: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } }) }]);
  assert.deepEqual(gh.queueEvents(5), [
    { type: 'added', at: '2026-11-09T08:00:00Z', reason: null, actor: 'owner', beforeCommit: null },
    { type: 'removed', at: '2026-11-09T08:10:00Z', reason: 'failed_checks', actor: 'github-merge-queue', beforeCommit: QUEUE_COMMIT },
    { type: 'added', at: '2026-11-09T08:11:00Z', reason: null, actor: 'owner', beforeCommit: null },
    { type: 'removed', at: '2026-11-09T08:20:00Z', reason: 'manual', actor: null, beforeCommit: null },
    { type: 'merged', at: '2026-11-09T08:30:00Z', reason: null, actor: 'owner', beforeCommit: null },
  ]);
  const query = fake.calls().find((c) => c.argv[0] === 'api').argv.find((a) => a.startsWith('query='));
  assert.match(query, /itemTypes:\s*\[ADDED_TO_MERGE_QUEUE_EVENT,\s*REMOVED_FROM_MERGE_QUEUE_EVENT,\s*MERGED_EVENT\]/);
});

test('gh.queueEvents: follows pages in order; an unknown event or a cursor that does not advance throws', () => {
  const page = (nodes, next) => prData({ timelineItems: { nodes, pageInfo: { hasNextPage: next !== null, endCursor: next } } });
  const added = { __typename: 'AddedToMergeQueueEvent', createdAt: '2026-11-09T08:00:00Z', actor: { login: 'owner' } };
  const merged = { __typename: 'MergedEvent', createdAt: '2026-11-09T08:30:00Z', actor: { login: 'owner' } };
  // The fake matches on argv: the second page is asked for with after=CUR1.
  const two = mk([{ match: 'after=CUR1', ...page([merged], null) }, { match: 'QueueEvents', ...page([added], 'CUR1') }]);
  assert.deepEqual(two.gh.queueEvents(5).map((e) => e.type), ['added', 'merged']);
  assert.throws(() => mk([{ match: 'QueueEvents', ...page([added], 'CUR1') }]).gh.queueEvents(5), /did not advance/);
  assert.throws(() => mk([{ match: 'QueueEvents', ...page([{ __typename: 'ClosedEvent', createdAt: 'x' }], null) }]).gh.queueEvents(5), GhError);
});

// ---- enqueue / dequeue -------------------------------------------------------------------------------------------------------------

test('gh.prNodeId reads the PR node id', () => {
  const { gh } = mk([{ match: 'PrNodeId', ...prData({ id: 'PR_node1' }) }]);
  assert.equal(gh.prNodeId(5), 'PR_node1');
  assert.throws(() => mk([{ match: 'PrNodeId', ...prData(null) }]).gh.prNodeId(5), GhError);
});

test('gh.enqueue sends expectedHeadOid; gh.dequeue names the PR node id', () => {
  const { fake, gh } = mk([
    { match: 'PrNodeId', ...prData({ id: 'PR_node1' }) },
    { match: 'enqueuePullRequest', stdoutJson: { data: { enqueuePullRequest: { mergeQueueEntry: { id: 'MQE_1', state: 'QUEUED', position: 3 } } } } },
    { match: 'dequeuePullRequest', stdoutJson: { data: { dequeuePullRequest: { mergeQueueEntry: { id: 'MQE_1' } } } } },
  ]);
  assert.deepEqual(gh.enqueue(5, HEAD), { id: 'MQE_1', state: 'QUEUED', position: 3 });
  const enq = fake.calls().find((c) => c.argv.join(' ').includes('enqueuePullRequest')).argv;
  assert.ok(enq.includes(`expectedHeadOid=${HEAD}`), enq.join(' '));
  assert.ok(enq.includes('pullRequestId=PR_node1'), enq.join(' '));
  assert.equal(gh.dequeue(5), undefined);
  const deq = fake.calls().find((c) => c.argv.join(' ').includes('dequeuePullRequest')).argv;
  assert.ok(deq.includes('id=PR_node1'), deq.join(' '));
});

test('gh.enqueue: a stale head or a reply without an entry throws; a bad sha is refused before any call', () => {
  const stale = mk([{ match: 'PrNodeId', ...prData({ id: 'PR_node1' }) }, { match: 'enqueuePullRequest', stdoutJson: { errors: [{ message: 'Head sha: expected head oid does not match the current head oid' }] } }]);
  assert.throws(() => stale.gh.enqueue(5, HEAD), /expected head oid/);
  const empty = mk([{ match: 'PrNodeId', ...prData({ id: 'PR_node1' }) }, { match: 'enqueuePullRequest', stdoutJson: { data: { enqueuePullRequest: { mergeQueueEntry: null } } } }]);
  assert.throws(() => empty.gh.enqueue(5, HEAD), GhError);
  const none = mk([]);
  assert.throws(() => none.gh.enqueue(5, 'abc'), TypeError);
  assert.deepEqual(none.fake.calls(), [], 'no gh call for a malformed sha');
});

// ---- the queue record, reconcile and the watcher (Task 2) -----------------------------------------------------------------------------
// These use a plain stub in place of the GitHub client: each read is a script (an Error in it is thrown; the last item repeats).

const repoDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-mqrec-'));
  execFileSync('git', ['init', '-q', dir]);
  return dir;
};
const APPROVAL = { items: 'abc123', areas: 'none', rulings: 'none' };
const IDENT = { repo: 'acme/widgets', repoId: 42 };
const script = (list) => {
  let i = 0;
  return () => {
    const item = list[Math.min(i, list.length - 1)];
    i += 1;
    if (item instanceof Error) throw item;
    return typeof item === 'function' ? item() : item;
  };
};
const st = (over = {}) => ({ enabled: true, inQueue: false, state: 'OPEN', head: HEAD, mergeSha: null, entry: null, ...over });
const inQ = (position = 2) => st({ inQueue: true, entry: { id: 'MQE_1', state: 'AWAITING_CHECKS', position, enqueuedAt: '2026-11-09T08:00:00Z', headCommit: null } });
const merged = st({ state: 'MERGED', mergeSha: MERGE_SHA });
const ev = (type, at, reason = null, beforeCommit = null) => ({ type, at: `2026-11-09T${at}Z`, reason, actor: type === 'removed' ? 'github-merge-queue' : 'owner', beforeCommit });
const added = (at = '08:00:00') => ev('added', at);
const removed = (reason, at = '08:30:00', before = QUEUE_COMMIT) => ev('removed', at, reason, before);
const clock = () => {
  const c = { t: Date.parse('2026-11-09T09:00:00Z'), slept: [] };
  c.now = () => c.t;
  c.sleep = async (ms) => { c.slept.push(ms); c.t += ms; };
  return c;
};
// states / events / views / issues are scripts; `calls` records the mutating calls.
// `issues`: label -> script of issue lists (any other label: none).
const stubGh = ({ states, events = [[]], views, issues = {}, dequeueThrows = false }) => {
  const calls = [];
  const nextState = script(states);
  const nextEvents = script(events);
  const nextView = script(views ?? [{ state: 'OPEN', labels: [], mergeCommit: null }]);
  const nextIssues = Object.fromEntries(Object.entries(issues).map(([k, v]) => [k, script(v)]));
  return {
    calls,
    queueState: () => nextState(),
    queueEvents: () => nextEvents(),
    prView: () => nextView(),
    listIssues: ({ label }) => (nextIssues[label] ? nextIssues[label]() : []),
    dequeue(n) { calls.push(`dequeue ${n}`); if (dequeueThrows) throw new Error('boom'); },
  };
};
const noBlockers = async () => [];

test('beginAttempt before enqueue: a crash after enqueue still counts the attempt', () => {
  const root = repoDir();
  const rec = beginAttempt(root, 7, HEAD, APPROVAL, IDENT);
  assert.equal(rec.attempts, 1);
  assert.deepEqual(Object.keys(rec.pending).sort(), ['at', 'head']);
  assert.equal(rec.pending.head, HEAD);
  // The process "dies" here. A new process reads the same record from disk: the attempt is counted, nothing is lost.
  const again = readQueueRecord(root, 7);
  assert.equal(again.attempts, 1);
  assert.equal(again.pending.head, HEAD);
  assert.deepEqual({ repo: again.repo, repoId: again.repoId, approval: again.approval, terminal: again.terminal, removals: again.removals, entryIds: again.entryIds }, { ...IDENT, approval: APPROVAL, terminal: null, removals: [], entryIds: [] });
  assert.ok(existsSync(queueRecordPath(root, 7)));
  assert.match(queueRecordPath(root, 7), /pipeline[\\/]merge-queue[\\/]pr-7\.json$/);
  assert.deepEqual(readdirSync(join(queueRecordPath(root, 7), '..')), ['pr-7.json'], 'atomic write leaves no temp file behind');
  assert.deepEqual(liveRecords(root).map((r) => r.pr), [7]);
  confirmAttempt(root, 7, 'MQE_1');
  const confirmed = readQueueRecord(root, 7);
  assert.equal(confirmed.pending, null);
  assert.deepEqual(confirmed.entryIds, ['MQE_1']);
  assert.equal(readQueueRecord(root, 8), null);
  assert.deepEqual(liveRecords(repoDir()), []);
});

test('record: hold owner goes session -> pending -> entry; a different head or a terminal record starts over', () => {
  const root = repoDir();
  openRecord(root, 7, HEAD, APPROVAL, IDENT);
  setHold(root, 7, { id: 11, login: 'owner', at: '2026-11-09T07:00:00Z', holdBlock: 'digest', liftedAt: '2026-11-09T08:00:00Z' });
  assert.equal(readQueueRecord(root, 7).hold.owner, 'session');
  beginAttempt(root, 7, HEAD, APPROVAL, IDENT);
  assert.equal(readQueueRecord(root, 7).hold.owner, 'pending');
  confirmAttempt(root, 7, 'MQE_1');
  assert.equal(readQueueRecord(root, 7).hold.owner, 'entry');
  assert.equal(readQueueRecord(root, 7).hold.holdBlock, 'digest');
  setHold(root, 7, null);
  assert.equal(readQueueRecord(root, 7).hold, null);
  endRecord(root, 7, 'removed', { now: () => Date.parse('2026-11-09T10:00:00Z') });
  const ended = readQueueRecord(root, 7);
  assert.equal(ended.terminal, 'removed');
  assert.equal(ended.terminalAt, '2026-11-09T10:00:00.000Z');
  assert.deepEqual(liveRecords(root), []);
  // A terminal record for the same head: a new attempt starts a fresh record and a fresh budget.
  noteRemoval(root, 7, { entryId: 'MQE_1', reason: REASON_GROUP_CHECKS, beforeCommit: QUEUE_COMMIT, at: '2026-11-09T08:30:00Z' });
  const fresh = beginAttempt(root, 7, HEAD, APPROVAL, IDENT);
  assert.equal(fresh.terminal, null);
  assert.equal(fresh.attempts, 1);
  assert.deepEqual(fresh.removals, []);
  // Another head resets too.
  const other = beginAttempt(root, 7, 'd'.repeat(40), APPROVAL, IDENT);
  assert.equal(other.head, 'd'.repeat(40));
  assert.equal(other.attempts, 1);
});

test('reconcile: in queue at the approved head => queued (no new attempt)', async () => {
  const root = repoDir();
  beginAttempt(root, 7, HEAD, APPROVAL, IDENT);
  const gh = stubGh({ states: [inQ(3)] });
  const r = await reconcile({ gh, root, pr: 7, head: HEAD });
  assert.equal(r.kind, 'queued');
  assert.equal(r.entry.position, 3);
  assert.equal(readQueueRecord(root, 7).attempts, 1);
});

test('reconcile: MERGED => merged with sha (a late merge commit is looked up again)', async () => {
  const root = repoDir();
  const r = await reconcile({ gh: stubGh({ states: [merged] }), root, pr: 7, head: HEAD });
  assert.deepEqual(r, { kind: 'merged', mergeSha: MERGE_SHA });
  const late = stubGh({ states: [st({ state: 'MERGED', mergeSha: null })], views: [{ state: 'MERGED', mergeCommit: { oid: MERGE_SHA } }] });
  const c = clock();
  assert.deepEqual(await reconcile({ gh: late, root, pr: 7, head: HEAD, sleep: c.sleep, pollMs: 10 }), { kind: 'merged', mergeSha: MERGE_SHA });
});

test('reconcile: closed, and a head that is not the approved one => head-moved / closed', async () => {
  const root = repoDir();
  assert.deepEqual(await reconcile({ gh: stubGh({ states: [st({ state: 'CLOSED' })] }), root, pr: 7, head: HEAD }), { kind: 'closed' });
  const other = 'd'.repeat(40);
  assert.deepEqual(await reconcile({ gh: stubGh({ states: [st({ head: other })] }), root, pr: 7, head: HEAD }), { kind: 'head-moved', head: other });
  assert.deepEqual(await reconcile({ gh: stubGh({ states: [inQ()].map((s) => ({ ...s, head: other })) }), root, pr: 7, head: HEAD }), { kind: 'head-moved', head: other });
});

test('reconcile: removal before our latest added event is ignored; one after it counts (timeline order, not timestamps)', async () => {
  const root = repoDir();
  beginAttempt(root, 7, HEAD, APPROVAL, IDENT);
  confirmAttempt(root, 7, 'MQE_1');
  // Same timestamp on every event: only the order decides.
  const same = (type, reason = null) => ({ type, at: '2026-11-09T08:00:00Z', reason, actor: 'x', beforeCommit: type === 'removed' ? QUEUE_COMMIT : null });
  const ignored = stubGh({ states: [st()], events: [[same('added'), same('removed', REASON_GROUP_CHECKS), same('added')]] });
  assert.deepEqual(await reconcile({ gh: ignored, root, pr: 7, head: HEAD }), { kind: 'not-queued' });
  const counts = stubGh({ states: [st()], events: [[same('added'), same('removed', REASON_GROUP_CHECKS)]] });
  const r = await reconcile({ gh: counts, root, pr: 7, head: HEAD });
  assert.equal(r.kind, 'removed');
  assert.equal(r.removal.reason, REASON_GROUP_CHECKS);
  assert.equal(r.removal.beforeCommit, QUEUE_COMMIT);
});

test('reconcile: a removal with reason merged (the PR not yet shown as merged) reads as merged', async () => {
  const root = repoDir();
  const gh = stubGh({ states: [st()], events: [[added(), removed(REASON_MERGED, '08:40:00', MERGE_SHA)]] });
  assert.deepEqual(await reconcile({ gh, root, pr: 7, head: HEAD }), { kind: 'merged', mergeSha: MERGE_SHA });
  const viaEvent = stubGh({ states: [st()], events: [[added(), ev('merged', '08:40:00')]], views: [{ state: 'OPEN', mergeCommit: { oid: MERGE_SHA } }] });
  assert.equal((await reconcile({ gh: viaEvent, root, pr: 7, head: HEAD })).kind, 'merged');
});

test('pending attempt reconciled not-queued => attempt dropped; a later failed_checks still re-queues once', async () => {
  const root = repoDir();
  beginAttempt(root, 7, HEAD, APPROVAL, IDENT);
  const logged = [];
  // The enqueue never landed: no entry, and the only event is an OLD removal from before this attempt.
  const gh = stubGh({ states: [st()], events: [[ev('added', '06:00:00'), removed(REASON_GROUP_CHECKS, '06:30:00')]] });
  assert.deepEqual(await reconcile({ gh, root, pr: 7, head: HEAD, log: (m) => logged.push(m) }), { kind: 'not-queued' });
  const dropped = readQueueRecord(root, 7);
  assert.equal(dropped.attempts, 0);
  assert.equal(dropped.pending, null);
  assert.equal(logged.length, 1);
  // The retry: enqueue lands, then the group fails once.
  beginAttempt(root, 7, HEAD, APPROVAL, IDENT);
  confirmAttempt(root, 7, 'MQE_2');
  noteRemoval(root, 7, { entryId: 'MQE_2', reason: REASON_GROUP_CHECKS, beforeCommit: QUEUE_COMMIT, at: '2026-11-09T09:30:00Z' });
  assert.equal(mayRequeue(readQueueRecord(root, 7), HEAD, REASON_GROUP_CHECKS), true);
});

test('mayRequeue: once per head, across restarts (record on disk); a repeated note of the same removal is one', () => {
  const root = repoDir();
  beginAttempt(root, 7, HEAD, APPROVAL, IDENT);
  confirmAttempt(root, 7, 'MQE_1');
  const first = { entryId: 'MQE_1', reason: REASON_GROUP_CHECKS, beforeCommit: QUEUE_COMMIT, at: '2026-11-09T08:30:00Z' };
  noteRemoval(root, 7, first);
  noteRemoval(root, 7, first);
  assert.equal(readQueueRecord(root, 7).removals.length, 1, 'the same removal noted twice counts once');
  assert.equal(mayRequeue(readQueueRecord(root, 7), HEAD, REASON_GROUP_CHECKS), true);
  assert.equal(mayRequeue(readQueueRecord(root, 7), 'd'.repeat(40), REASON_GROUP_CHECKS), false, 'another head is another approval');
  beginAttempt(root, 7, HEAD, APPROVAL, IDENT);
  confirmAttempt(root, 7, 'MQE_2');
  assert.equal(readQueueRecord(root, 7).attempts, 2);
  assert.equal(mayRequeue(readQueueRecord(root, 7), HEAD, REASON_GROUP_CHECKS), true, 'still one confirmed removal: the re-queue itself does not spend it');
  noteRemoval(root, 7, { entryId: 'MQE_2', reason: REASON_GROUP_CHECKS, beforeCommit: 'e'.repeat(40), at: '2026-11-09T09:30:00Z' });
  assert.equal(mayRequeue(readQueueRecord(root, 7), HEAD, REASON_GROUP_CHECKS), false, 'a second confirmed removal ends the budget');
});

test('manual removal never re-queues; unknown reasons never re-queue', () => {
  const root = repoDir();
  beginAttempt(root, 7, HEAD, APPROVAL, IDENT);
  noteRemoval(root, 7, { entryId: 'MQE_1', reason: REASON_MANUAL, beforeCommit: null, at: '2026-11-09T08:30:00Z' });
  const rec = readQueueRecord(root, 7);
  assert.equal(mayRequeue(rec, HEAD, REASON_MANUAL), false);
  assert.equal(mayRequeue(rec, HEAD, 'timeout'), false);
  assert.equal(mayRequeue(rec, HEAD, null), false);
  assert.equal(mayRequeue(null, HEAD, REASON_GROUP_CHECKS), false);
  assert.deepEqual([...REQUEUE_REASONS], [REASON_GROUP_CHECKS]);
  assert.deepEqual([REASON_GROUP_CHECKS, REASON_MANUAL, REASON_MERGED], ['failed_checks', 'manual', 'merged']);
});

test('record written under the old repo name matches after a move (sameRepo / repoId)', () => {
  const root = repoDir();
  const rec = beginAttempt(root, 7, HEAD, APPROVAL, { repo: 'acme/old-name', repoId: 42 });
  const move = { from: 'acme/old-name', to: 'acme/widgets', at: new Date(Date.parse(rec.createdAt) + 60_000).toISOString(), repoId: 42 };
  assert.equal(recordIsFor(rec, { repo: 'acme/widgets', repoId: 42, moves: [move] }), true, 'same repository id');
  assert.equal(recordIsFor(rec, { repo: 'acme/widgets', repoId: 42 }), true, 'the numeric id alone is enough');
  assert.equal(recordIsFor(rec, { repo: 'acme/widgets', repoId: 43, moves: [move] }), false, 'another repository that took the name');
  assert.equal(recordIsFor(rec, { repo: 'ACME/Old-Name', repoId: null }), true, 'same name, case-insensitive');
  assert.equal(recordIsFor({ ...rec, repoId: null }, { repo: 'acme/widgets', repoId: null, moves: [move] }), true, 'no ids: the recorded move links the names');
  assert.equal(recordIsFor({ ...rec, repoId: null }, { repo: 'acme/widgets', repoId: null, moves: [] }), false, 'no ids, no move: not the same');
  assert.deepEqual(liveRecords(root, { repo: 'acme/widgets', repoId: 42 }).map((r) => r.pr), [7]);
  assert.deepEqual(liveRecords(root, { repo: 'acme/other', repoId: 99 }), []);
});

// ---- watchQueue --------------------------------------------------------------------------------------------------------------------

test('watchQueue: inQ, inQ, MERGED => merged (record ends merged)', async () => {
  const root = repoDir();
  beginAttempt(root, 7, HEAD, APPROVAL, IDENT);
  confirmAttempt(root, 7, 'MQE_1');
  const c = clock();
  const gh = stubGh({ states: [inQ(2), inQ(1), merged] });
  const r = await watchQueue({ gh, root, pr: 7, head: HEAD, budgetMs: 3_600_000, pollMs: 90_000, blockers: noBlockers, now: c.now, sleep: c.sleep });
  assert.deepEqual(r, { state: 'merged', mergeSha: MERGE_SHA });
  assert.deepEqual(c.slept, [90_000, 90_000]);
  assert.equal(readQueueRecord(root, 7).terminal, 'merged');
});

test('watchQueue: removed for failed_checks => removed with the removal, noted once on disk', async () => {
  const root = repoDir();
  beginAttempt(root, 7, HEAD, APPROVAL, IDENT);
  confirmAttempt(root, 7, 'MQE_1');
  const c = clock();
  const gh = stubGh({ states: [inQ(), st()], events: [[added(), removed(REASON_GROUP_CHECKS)]] });
  const r = await watchQueue({ gh, root, pr: 7, head: HEAD, budgetMs: 3_600_000, blockers: noBlockers, now: c.now, sleep: c.sleep });
  assert.equal(r.state, 'removed');
  assert.equal(r.removal.reason, REASON_GROUP_CHECKS);
  assert.equal(readQueueRecord(root, 7).removals.length, 1);
  assert.equal(readQueueRecord(root, 7).terminal, null, 'the caller decides: re-queue or end');
  assert.equal(gh.calls.length, 0, 'a removal is never answered with a dequeue');
});

test('watchQueue: needs-human added while queued => dequeue called, blocked', async () => {
  const c = clock();
  const root = repoDir();
  const gh = stubGh({
    states: [inQ(), inQ(), st()], // the 3rd read is the confirm after the dequeue
    events: [[added(), removed(REASON_MANUAL, '08:20:00', null)]],
    views: [{ state: 'OPEN', labels: [], mergeCommit: null }, { state: 'OPEN', labels: [{ name: 'needs-human' }], mergeCommit: null }],
  });
  // No `blockers` given: the default is the real waitBlockers(gh, { base: null }) rule.
  const r = await watchQueue({ gh, root, pr: 7, head: HEAD, budgetMs: 3_600_000, now: c.now, sleep: c.sleep });
  assert.equal(r.state, 'blocked');
  assert.equal(r.dequeued, true);
  assert.match(r.problems.join(' '), /needs-human/);
  assert.deepEqual(gh.calls, ['dequeue 7']);
});

test('watchQueue: pause issue opened while queued => dequeue called, blocked', async () => {
  const c = clock();
  const root = repoDir();
  const gh = stubGh({
    states: [inQ(), inQ(), st()],
    events: [[added(), removed(REASON_MANUAL, '08:20:00', null)]],
    issues: { 'pipeline-pause': [[], [{ number: 9 }]] },
  });
  const r = await watchQueue({ gh, root, pr: 7, head: HEAD, budgetMs: 3_600_000, now: c.now, sleep: c.sleep });
  assert.equal(r.state, 'blocked');
  assert.match(r.problems.join(' '), /pipeline-pause issue #9/);
  assert.deepEqual(gh.calls, ['dequeue 7']);
});

test('watchQueue: dequeue races a merge => merged + warning', async () => {
  const c = clock();
  const root = repoDir();
  beginAttempt(root, 7, HEAD, APPROVAL, IDENT);
  confirmAttempt(root, 7, 'MQE_1');
  const gh = stubGh({ states: [inQ(), merged] });
  const r = await watchQueue({ gh, root, pr: 7, head: HEAD, budgetMs: 3_600_000, blockers: async () => ['blocking label(s): needs-human'], now: c.now, sleep: c.sleep });
  assert.equal(r.state, 'merged');
  assert.equal(r.mergeSha, MERGE_SHA);
  assert.match(r.warning, /merged/);
  assert.deepEqual(gh.calls, ['dequeue 7']);
  assert.equal(readQueueRecord(root, 7).terminal, 'merged');
});

test('watchQueue: a dequeue that does not take effect => blocked, dequeued false', async () => {
  const c = clock();
  const root = repoDir();
  const gh = stubGh({ states: [inQ()], dequeueThrows: true });
  const r = await watchQueue({ gh, root, pr: 7, head: HEAD, budgetMs: 3_600_000, blockers: async () => ['open pipeline-pause issue #9'], now: c.now, sleep: c.sleep });
  assert.equal(r.state, 'blocked');
  assert.equal(r.dequeued, false);
});

test('watchQueue: thrown poll retried; budget => still-queued, no dequeue', async () => {
  const c = clock();
  const root = repoDir();
  beginAttempt(root, 7, HEAD, APPROVAL, IDENT);
  confirmAttempt(root, 7, 'MQE_1');
  const gh = stubGh({ states: [new Error('rate limited'), inQ(4)] });
  const r = await watchQueue({ gh, root, pr: 7, head: HEAD, budgetMs: 360_000, pollMs: 90_000, blockers: noBlockers, now: c.now, sleep: c.sleep });
  assert.deepEqual(r, { state: 'still-queued', position: 4 });
  assert.deepEqual(gh.calls, [], 'budget expiry never dequeues');
  assert.equal(readQueueRecord(root, 7).terminal, null);
  assert.ok(c.t - Date.parse('2026-11-09T09:00:00Z') <= 360_000, 'never sleeps past the budget');
});

test('watchQueue: head-moved and closed end the watch without touching the queue', async () => {
  const c = clock();
  const root = repoDir();
  const other = 'd'.repeat(40);
  assert.deepEqual(await watchQueue({ gh: stubGh({ states: [st({ head: other })] }), root, pr: 7, head: HEAD, budgetMs: 1000, blockers: noBlockers, now: c.now, sleep: c.sleep }), { state: 'head-moved' });
  const gh = stubGh({ states: [st({ state: 'CLOSED' })] });
  assert.deepEqual(await watchQueue({ gh, root, pr: 7, head: HEAD, budgetMs: 1000, blockers: noBlockers, now: c.now, sleep: c.sleep }), { state: 'closed' });
  assert.deepEqual(gh.calls, []);
});

test('watchQueue: hold lifted, needs-human re-added while queued => dequeue, blocked, label left as set, record terminal', async () => {
  const c = clock();
  const root = repoDir();
  openRecord(root, 7, HEAD, APPROVAL, IDENT);
  setHold(root, 7, { id: 11, login: 'owner', at: '2026-11-09T07:00:00Z', holdBlock: 'digest', liftedAt: '2026-11-09T08:00:00Z' });
  beginAttempt(root, 7, HEAD, APPROVAL, IDENT);
  confirmAttempt(root, 7, 'MQE_1');
  // The lifted label is off; a needs-human on the PR NOW is a new hold, so it blocks (no exemption after the lift).
  const gh = stubGh({
    states: [inQ(), st()],
    events: [[added(), removed(REASON_MANUAL, '08:20:00', null)]],
    views: [{ state: 'OPEN', labels: [{ name: 'needs-human' }], mergeCommit: null }],
  });
  const r = await watchQueue({ gh, root, pr: 7, head: HEAD, budgetMs: 3_600_000, now: c.now, sleep: c.sleep });
  assert.equal(r.state, 'blocked');
  assert.deepEqual(gh.calls, ['dequeue 7'], 'no label call exists on the stub: nothing re-added or restored');
  assert.equal(readQueueRecord(root, 7).terminal, 'blocked');
});

test('watchQueue: blocked with a lifted hold and the label OFF leaves the record live for the hold restore', async () => {
  const c = clock();
  const root = repoDir();
  openRecord(root, 7, HEAD, APPROVAL, IDENT);
  setHold(root, 7, { id: 11, login: 'owner', at: '2026-11-09T07:00:00Z', holdBlock: 'digest', liftedAt: '2026-11-09T08:00:00Z' });
  beginAttempt(root, 7, HEAD, APPROVAL, IDENT);
  confirmAttempt(root, 7, 'MQE_1');
  const gh = stubGh({ states: [inQ(), st()], events: [[added(), removed(REASON_MANUAL, '08:20:00', null)]], issues: { 'pipeline-pause': [[{ number: 9 }]] } });
  const r = await watchQueue({ gh, root, pr: 7, head: HEAD, budgetMs: 3_600_000, now: c.now, sleep: c.sleep });
  assert.equal(r.state, 'blocked');
  const rec = readQueueRecord(root, 7);
  assert.equal(rec.terminal, null, 'the label has not been restored yet: settleRecord / the caller still owns that');
  assert.equal(rec.hold.owner, 'entry');
});

// ---- round-1 review fixes ----------------------------------------------------------------------------------------------------------

test('R1-B1 watchQueue: a stop condition whose dequeue is NOT confirmed leaves the record live (the next sweep retries), even with no hold', async () => {
  const c = clock();
  const root = repoDir();
  beginAttempt(root, 7, HEAD, APPROVAL, IDENT);
  confirmAttempt(root, 7, 'MQE_1');
  const gh = stubGh({ states: [inQ()], dequeueThrows: true });
  const r = await watchQueue({ gh, root, pr: 7, head: HEAD, budgetMs: 3_600_000, blockers: async () => ['open pipeline-pause issue #9'], now: c.now, sleep: c.sleep });
  assert.equal(r.state, 'blocked');
  assert.equal(r.dequeued, false);
  assert.equal(readQueueRecord(root, 7).terminal, null, 'the entry may still be live: settleRecord / final-gate must still find the record');
  assert.equal(liveRecords(root).length, 1);
  // the next settle retries the dequeue and, once confirmed, ends the record
  const again = await watchQueue({ gh: stubGh({ states: [inQ(), st()], events: [[added(), removed(REASON_MANUAL, '08:20:00', null)]] }), root, pr: 7, head: HEAD, budgetMs: 3_600_000, blockers: async () => ['open pipeline-pause issue #9'], now: c.now, sleep: c.sleep });
  assert.equal(again.dequeued, true);
  assert.equal(readQueueRecord(root, 7).terminal, 'blocked');
});

test('R1-F1 reconcile: queued at the recorded head while the local worktree is elsewhere => queued (a live entry is never head-moved)', async () => {
  const root = repoDir();
  const other = 'd'.repeat(40);
  beginAttempt(root, 7, HEAD, APPROVAL, IDENT);
  confirmAttempt(root, 7, 'MQE_1');
  const r = await reconcile({ gh: stubGh({ states: [inQ(3)] }), root, pr: 7, head: other });
  assert.equal(r.kind, 'queued');
  assert.equal(r.entry.position, 3);
  // not queued, or queued at some head the record does not know: still head-moved
  assert.deepEqual(await reconcile({ gh: stubGh({ states: [st()] }), root, pr: 7, head: other }), { kind: 'head-moved', head: HEAD });
  assert.deepEqual(await reconcile({ gh: stubGh({ states: [{ ...inQ(), head: 'f'.repeat(40) }] }), root, pr: 7, head: other }), { kind: 'head-moved', head: 'f'.repeat(40) });
});
