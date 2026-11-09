// Merge queue ("queue mode"): the GraphQL reads and writes in github.mjs, and the pure helpers in merge-queue.mjs.
// The gh calls run against the scripted fake gh (the queue is only read live, never from config).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GhError } from '../pipeline/lib/proc.mjs';
import { createGitHub } from '../pipeline/lib/github.mjs';
import { QueueUnreadable, queueModeFor, queueRulesOf, queueWaitMs } from '../pipeline/lib/merge-queue.mjs';
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
