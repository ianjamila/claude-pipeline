// `P merge` in queue mode (GitHub requires a merge queue on the base): enqueue the approved head, watch it, re-queue once. Through the real
// CLI against a stateful fake gh (test/fixtures/fake-gh-queue.mjs: GitHub's queue as a list of phases between enqueues). The hold half
// of the route (a lifted needs-human label) is covered by owner-go-hold-queue.test.mjs. A repo WITHOUT a queue is covered by the existing
// merge tests, which stay unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeRequest, ownerSays } from './helpers/owner-go.mjs';
import { BASE_SHA, MERGE_SHA, PR, bump, cli, scenario, ymlFor } from './helpers/gate-env.mjs';
import { assertExit } from './helpers/assert-exit.mjs';
import { writeSummaryComment } from '../pipeline/lib/summary-comment.mjs';
import { holdFiles, holdYml, holdCalls } from './helpers/merge-hold-env.mjs';
import { beginAttempt, confirmAttempt, endRecord, noteRemoval, readQueueRecord } from '../pipeline/lib/merge-queue.mjs';
import { preMergeProblems } from '../pipeline/lib/finalgate.mjs';
import { gateFreshSince, recheckGated } from '../pipeline/lib/queue-route.mjs';

const FAKE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-gh-queue.mjs');
const QUEUE_COMMIT = 'b'.repeat(40);
const QUEUE_COMMIT_2 = 'e'.repeat(40);
const STAMP = new Date().toISOString();

// ---- GitHub's side -----------------------------------------------------------------------------------------------------------

const node = (head, over = {}) => ({ id: 'PR_node12', state: 'OPEN', headRefOid: head, isMergeQueueEnabled: true, mergeCommit: null, mergeQueueEntry: null, ...over });
const queuedNode = (head, position = 1) => node(head, { mergeQueueEntry: { id: 'MQE_1', state: 'AWAITING_CHECKS', position, enqueuedAt: STAMP, headCommit: { oid: QUEUE_COMMIT } } });
const mergedNode = (head) => node(head, { state: 'MERGED', mergeCommit: { oid: MERGE_SHA } });
const added = () => ({ __typename: 'AddedToMergeQueueEvent', createdAt: STAMP, actor: { login: 'owner' } });
const removed = (reason, before = QUEUE_COMMIT) => ({ __typename: 'RemovedFromMergeQueueEvent', createdAt: STAMP, reason, actor: { login: 'github-merge-queue' }, beforeCommit: { oid: before } });
const reply = (pr, events = []) => ({ pr, events });
// What GitHub shows at one moment, as a function of the PR head (the test's head is only known once the repo exists).
const Q = (position = 1, events = [added()]) => (h) => reply(queuedNode(h, position), events); // queued
const M = () => (h) => reply(mergedNode(h)); // merged
const OUT = (events) => (h) => reply(node(h), events); // not queued (removed, per the events)

const extraGh = (head, more = []) => [
  { match: '^pr view 12 --json state,labels', stdoutJson: { state: 'OPEN', labels: [] } },
  { match: '^api repos/acme/widgets --jq \\.id$', stdout: '4242\n' },
  { match: `commits/${QUEUE_COMMIT}/check-runs`, stdoutJson: [{ name: 'ci', conclusion: 'failure' }, { name: 'lint', conclusion: 'success' }] },
  { match: `commits/${QUEUE_COMMIT}/statuses`, stdoutJson: [] },
  { match: `commits/${QUEUE_COMMIT_2}/check-runs`, stdoutJson: [{ name: 'e2e', conclusion: 'timed_out' }] },
  { match: `commits/${QUEUE_COMMIT_2}/statuses`, stdoutJson: [] },
  ...more,
];

// A PR with a queue: phase 0 is what GitHub shows before any enqueue (not queued); each enqueue moves to the next phase of `after`.
const stateFile = () => join(mkdtempSync(join(tmpdir(), 'cp-queue-state-')), 'queue.json');
const FAKE_ENQUEUE = [
  "import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';",
  "mkdirSync('.review', { recursive: true });",
  "appendFileSync('.review/merge-calls.log', `${process.argv.slice(2).join(' ')}\\n`);",
  "if (process.env.FAKE_ENQUEUE_FAIL) { process.stderr.write('boom: the queue refused this\\n'); process.exit(1); }",
  "const f = process.env.PIPELINE_FAKE_GH_QUEUE;",
  "const st = JSON.parse(readFileSync(f, 'utf8'));",
  "st.phase += 1; st.idx = 0; st.last = 0;",
  "writeFileSync(f, JSON.stringify(st));",
  '',
].join('\n');

function world({ route = 'gated', command = 'default', hold = false, after = [], gh = {}, enqueueFail, env: extraEnv = {} } = {}) {
  const file = stateFile();
  const timing = { PIPELINE_QUEUE_POLL_MS: '20', PIPELINE_QUEUE_CONFIRM_MS: '400', PIPELINE_QUEUE_CONFIRM_POLL_MS: '20', PIPELINE_QUEUE_WAIT_MS: '2500', ...extraEnv };
  const env = { PIPELINE_GH: `node "${FAKE}"`, PIPELINE_FAKE_GH_QUEUE: file, ...timing };
  const baseYml = hold ? holdYml() : ymlFor();
  let yml = baseYml;
  if (command === 'default') yml = baseYml.replace(/ {2}command: .*\n/, '');
  else if (command !== 'custom') yml = baseYml.replace('node scripts/fake-merge.mjs {pr} {sha}', command);
  const unique = (repo) => { bump(repo); repo.write('.salt', randomUUID()); };
  const owner = route === 'owner-go';
  const s = scenario({
    yml, baseFiles: { 'scripts/fake-enqueue.mjs': FAKE_ENQUEUE, ...(hold ? holdFiles : {}) }, env, change: unique, ...(owner ? { report: null, state: null } : {}),
    gh: { queue: true, ...gh, extra: [...extraGh(), ...(gh.extra ?? [])] },
  });
  const phases = [[OUT([])], ...after].map((p) => p.map((make) => make(s.head)));
  const q = {
    file,
    write: (st) => writeFileSync(file, JSON.stringify(st)),
    read: () => JSON.parse(readFileSync(file, 'utf8')),
    set(patch) { q.write({ ...q.read(), ...patch }); },
    // Replace what GitHub shows from now on (phase 0 = the first of `next`).
    show(...next) { q.set({ phase: 0, idx: 0, last: 0, phases: next.map((p) => p.map((make) => make(s.head))) }); },
  };
  q.write({ phase: 0, idx: 0, last: 0, enqueues: 0, phases, ...(enqueueFail ? { enqueueFail } : {}) });
  const calls = (needle) => s.fake.calls().filter((c) => c.argv.join(' ').includes(needle));
  const enqueueCalls = () => calls('mutation Enqueue');
  const dequeueCalls = () => calls('mutation Dequeue');
  const record = () => readQueueRecord(s.repo.dir, PR);
  const run = (extra = {}) => (owner
    ? cli(['merge', '--pr', String(PR), '--owner-go'], { dir: s.repo.dir, fake: s.fake, env: { ...s.env, ...extra } })
    : s.merge(extra));
  if (!owner) assertExit(s.gate(), 0);
  return { ...s, q, enqueueCalls, dequeueCalls, record, run, owner };
}
const approve = (t, s, head = s.head) => ownerSays(t, 'merge', mergeRequest(PR, head, 'none'));
const lines = (s) => s.fake.lines();
const never = (s, re, why) => assert.ok(!lines(s).some((l) => re.test(l)), why);

// ---- the plan's tests ---------------------------------------------------------------------------------------------------------

test('queue on, behind base, green: enqueued (pinned to the approved head), merged; no update-branch PUT, no hold command', () => {
  const s = world({ command: 'default', hold: true, gh: { behindBy: 2, mergeStateStatus: 'BEHIND' }, after: [[Q(), M()]] });
  const r = s.run();
  assertExit(r, 0);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.merged, true);
  assert.equal(r.json.mergeSha, MERGE_SHA);
  assert.equal(r.json.queue, true);
  assert.equal(r.json.requeued, 0);
  assert.equal(s.enqueueCalls().length, 1);
  assert.ok(s.enqueueCalls()[0].argv.includes(`expectedHeadOid=${s.head}`), 'the enqueue is pinned to the approved head');
  never(s, /-X PUT|update-branch/, 'no catch-up');
  assert.deepEqual(holdCalls(s), [], 'no merge-hold command');
  never(s, /--disable-auto/, 'auto-merge is never touched');
  assert.deepEqual(s.mergeCalls(), [], 'the built-in merge command never ran');
  const rec = s.record();
  assert.equal(rec.attempts, 1);
  assert.equal(rec.terminal, 'merged');
  assert.equal(rec.repoId, 4242);
  assert.equal(rec.head, s.head);
});

test('#229: the record carries the route that opened it (gated / owner-go), for the sweep\'s recheck', (t) => {
  const gated = world({ after: [[Q(), M()]] });
  assertExit(gated.run(), 0);
  assert.equal(gated.record().route, 'gated');
  const ownerGo = world({ route: 'owner-go', command: 'default', after: [[Q(), M()]] });
  approve(t, ownerGo);
  assertExit(ownerGo.run(), 0);
  assert.equal(ownerGo.record().route, 'owner-go');
});

test('queue on, head moved since approval (--owner-go): head-moved, nothing enqueued', (t) => {
  const s = world({ route: 'owner-go' });
  approve(t, s);
  s.q.show([() => reply(node('d'.repeat(40)))]); // GitHub's head is not the one the owner approved
  const r = s.run();
  assertExit(r, 1);
  assert.equal(r.json.error, 'head-moved');
  assert.equal(r.json.merged, false);
  assert.equal(s.enqueueCalls().length, 0);
});

test('removed once (group checks): the same head is re-queued once, then merged; requeued 1', () => {
  const first = [added(), removed('failed_checks')];
  const s = world({ after: [[Q(), OUT(first)], [Q(1, [...first, added()]), M()]] });
  const r = s.run();
  assertExit(r, 0);
  assert.equal(r.json.merged, true);
  assert.equal(r.json.requeued, 1);
  assert.equal(s.enqueueCalls().length, 2);
  assert.deepEqual(s.enqueueCalls().map((c) => c.argv.find((a) => a.startsWith('expectedHeadOid='))), [`expectedHeadOid=${s.head}`, `expectedHeadOid=${s.head}`], 'the SAME head both times');
  const rec = s.record();
  assert.equal(rec.attempts, 2);
  assert.equal(rec.removals.length, 1);
  assert.equal(rec.terminal, 'merged');
  never(s, /--disable-auto/, 'auto-merge is never touched');
});

// #230: a resumed watch from a worktree at another head than the live entry's. While the entry lives it is simply queued; when it leaves, the
// removal belongs on the record (with its reason), not under a "head-moved" that says nothing was queued.
test('resumed watch at another head (--owner-go): the live entry\'s removal is noted on the record, not head-moved; no re-queue from that worktree (#230)', (t) => {
  const OLD = 'd'.repeat(40);
  const setup = (phases) => {
    const s = world({ route: 'owner-go', command: 'default', after: [] });
    approve(t, s);
    const approval = { items: 'none', areas: [], rulings: null };
    beginAttempt(s.repo.dir, PR, OLD, approval, { repo: 'acme/widgets', repoId: 4242 });
    confirmAttempt(s.repo.dir, PR, 'MQE_1');
    s.q.show(...phases);
    return s;
  };
  const entryAtOld = () => reply(queuedNode(OLD), [added()]);

  const removedOut = setup([[entryAtOld, entryAtOld, () => reply(node(OLD), [added(), removed('failed_checks')])]]);
  const r = removedOut.run();
  assertExit(r, 1);
  assert.equal(r.json.error, 'queue-removed');
  assert.equal(r.json.removal.reason, 'failed_checks');
  assert.deepEqual(r.json.removal.failing, ['ci: failure']);
  assert.equal(removedOut.enqueueCalls().length, 0, 'a worktree at another head never re-queues');
  const rec = removedOut.record();
  assert.equal(rec.head, OLD);
  assert.equal(rec.removals.length, 1, 'the removal is on the record');
  assert.equal(rec.terminal, 'removed');
});

test('removed twice: queue-removed naming the failing check; no third enqueue', () => {
  const first = [added(), removed('failed_checks')];
  const second = [...first, added(), removed('failed_checks', QUEUE_COMMIT_2)];
  const s = world({ after: [[Q(), OUT(first)], [Q(1, [...first, added()]), OUT(second)]] });
  const r = s.run();
  assertExit(r, 1);
  assert.equal(r.json.error, 'queue-removed');
  assert.equal(r.json.merged, false);
  assert.equal(r.json.requeued, 1);
  assert.equal(r.json.removal.reason, 'failed_checks');
  assert.equal(r.json.removal.beforeCommit, QUEUE_COMMIT_2);
  assert.deepEqual(r.json.removal.failing, ['e2e: timed_out']);
  assert.match(r.json.reasons[0], /e2e: timed_out/);
  assert.equal(s.enqueueCalls().length, 2);
  assert.equal(s.record().terminal, 'removed');
});

test('removed by hand: queue-removed at once, no re-queue', () => {
  const s = world({ after: [[Q(), OUT([added(), removed('manual')])]] });
  const r = s.run();
  assertExit(r, 1);
  assert.equal(r.json.error, 'queue-removed');
  assert.equal(r.json.requeued, 0);
  assert.equal(r.json.removal.reason, 'manual');
  assert.equal(s.enqueueCalls().length, 1);
  assert.equal(s.record().terminal, 'removed');
});

test('budget runs out: ok, merged false, stillQueued with the position; no disable-auto, no dequeue, the record stays open', () => {
  const s = world({ after: [[Q(3)]], env: { PIPELINE_QUEUE_WAIT_MS: '300' } });
  const r = s.run();
  assertExit(r, 0);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.merged, false);
  assert.equal(r.json.stillQueued, true);
  assert.equal(r.json.queued, true);
  assert.equal(r.json.position, 3);
  never(s, /--disable-auto|auto-merge/, 'auto-merge is never touched');
  assert.equal(s.dequeueCalls().length, 0, 'never dequeues');
  const rec = s.record();
  assert.equal(rec.terminal, null);
  assert.equal(rec.attempts, 1);
});

test('queue unreadable: queue-unreadable, nothing enqueued (both routes)', (t) => {
  for (const route of ['gated', 'owner-go']) {
    const s = world({ route });
    if (route === 'owner-go') approve(t, s);
    s.q.set({ failQueueState: true });
    const r = s.run();
    assertExit(r, 1);
    assert.equal(r.json.error, 'queue-unreadable', route);
    assert.equal(r.json.merged, false);
    assert.equal(s.enqueueCalls().length, 0, route);
    assert.equal(s.dequeueCalls().length, 0, route);
    assert.equal(existsSync(join(s.repo.dir, '.git', 'pipeline', 'merge-queue', `pr-${PR}.json`)), false, 'no record');
  }
});

test('re-run while queued: watches the entry, no second enqueue, attempts stays 1', () => {
  const s = world({ after: [[Q()]], env: { PIPELINE_QUEUE_WAIT_MS: '200' } });
  const first = s.run();
  assertExit(first, 0);
  assert.equal(first.json.stillQueued, true);
  s.q.show([Q(), M()]);
  const r = s.run();
  assertExit(r, 0);
  assert.equal(r.json.merged, true);
  assert.equal(s.enqueueCalls().length, 1, 'one enqueue in total');
  const rec = s.record();
  assert.equal(rec.attempts, 1);
  assert.equal(rec.terminal, 'merged');
});

test('re-run after merged: reports merged, enqueues nothing, needs no record', () => {
  const s = world();
  s.q.show([M()]);
  const r = s.run();
  assertExit(r, 0);
  assert.equal(r.json.merged, true);
  assert.equal(r.json.mergeSha, MERGE_SHA);
  assert.equal(s.enqueueCalls().length, 0);
  assert.equal(s.record(), null);
});

test('the confirm step sees MERGED: success, not enqueue-failed', () => {
  const s = world({ after: [[M()]] });
  const r = s.run();
  assertExit(r, 0);
  assert.equal(r.json.merged, true);
  assert.equal(r.json.requeued, 0);
  assert.equal(s.record().terminal, 'merged');
});

test('crash window: an attempt on the record whose enqueue never reached GitHub is dropped from the count, then the PR is enqueued', () => {
  const s = world({ command: 'default', after: [[Q(), M()]] });
  // (a run that died after writing the attempt, before the mutation)
  beginAttempt(s.repo.dir, PR, s.head, { items: 'none', areas: [], rulings: null }, { repo: 'acme/widgets', repoId: 4242 });
  assert.equal(s.record().attempts, 1);
  const r = s.run();
  assertExit(r, 0);
  assert.equal(r.json.merged, true);
  assert.equal(s.enqueueCalls().length, 1);
  assert.equal(s.record().attempts, 1, 'the lost attempt was not double counted');
});

test('default merge.command is replaced by the pinned enqueue; a custom command runs as written (and must enqueue)', () => {
  const custom = world({ command: 'node scripts/fake-enqueue.mjs {pr} {sha}', after: [[Q(), M()]] });
  const r = custom.run();
  assertExit(r, 0);
  assert.equal(r.json.merged, true);
  assert.deepEqual(custom.mergeCalls(), [`${PR} ${custom.head}`], 'the repo\'s command ran with the approved head');
  assert.equal(custom.enqueueCalls().length, 0, 'the pipeline did not enqueue itself');
  assert.equal(custom.record().attempts, 1);

  const def = world({ command: 'default', after: [[Q(), M()]] });
  assert.doesNotMatch(readFileSync(join(def.repo.dir, '.claude', 'pipeline.yml'), 'utf8'), /^ {2}command:/m, 'the fixture leaves merge.command at the built-in default');
  assertExit(def.run(), 0);
  assert.equal(def.enqueueCalls().length, 1);
  assert.deepEqual(def.mergeCalls(), []);
});
test('enqueue-failed: the repo command exits 1 and nothing is queued; the built-in enqueue refused (stale head): the last output lines are reported, the attempt is not counted', () => {
  const bad = world({ command: 'node scripts/fake-enqueue.mjs {pr} {sha}', after: [], env: { FAKE_ENQUEUE_FAIL: '1' } });
  const r = bad.run();
  assertExit(r, 1);
  assert.equal(r.json.error, 'enqueue-failed');
  assert.equal(r.json.commandExitCode, 1);
  assert.match(r.json.enqueueOutput.join('\n'), /boom: the queue refused this/);
  assert.equal(bad.record().attempts, 0, 'a dropped attempt is not counted');

  const stale = world({ command: 'default', enqueueFail: { 1: 'gh: expected head oid does not match the current head oid' } });
  const r2 = stale.run();
  assertExit(r2, 1);
  assert.equal(r2.json.error, 'enqueue-failed');
  assert.match(r2.json.enqueueOutput.join('\n'), /expected head oid does not match/);
  assert.equal(stale.record().attempts, 0);
  assert.equal(stale.record().terminal, null);
});

test('owner-go: a record for head H enqueues H; a record for an older head is refused as today', (t) => {
  const ok = world({ route: 'owner-go', command: 'default', after: [[Q(), M()]] });
  approve(t, ok);
  const r = ok.run();
  assertExit(r, 0);
  assert.equal(r.json.merged, true);
  assert.equal(r.json.mode, 'owner-go');
  assert.equal(r.json.head, ok.head);
  assert.equal(r.json.queue, true);
  assert.ok(ok.enqueueCalls()[0].argv.includes(`expectedHeadOid=${ok.head}`));
  never(ok, /-X PUT|--disable-auto/, 'no catch-up, no auto-merge');

  const old = world({ route: 'owner-go', command: 'default', after: [[Q(), M()]] });
  approve(t, old, 'a'.repeat(40));
  const refused = old.run();
  assertExit(refused, 1);
  assert.equal(refused.json.error, 'owner-go');
  assert.equal(old.enqueueCalls().length, 0);
});

test('terminal record for head H: P merge again without a newer owner-go is queue-removed; with a newer one it starts a new record and enqueues (F10)', (t) => {
  const ended = (s, terminalAtMs) => {
    const approval = { items: 'none', areas: [], rulings: null };
    beginAttempt(s.repo.dir, PR, s.head, approval, { repo: 'acme/widgets', repoId: 4242, now: () => terminalAtMs - 5000 });
    noteRemoval(s.repo.dir, PR, { reason: 'failed_checks', beforeCommit: QUEUE_COMMIT, at: STAMP });
    noteRemoval(s.repo.dir, PR, { reason: 'failed_checks', beforeCommit: QUEUE_COMMIT_2, at: STAMP });
    endRecord(s.repo.dir, PR, 'removed', { now: () => terminalAtMs });
  };

  const stale = world({ route: 'owner-go', command: 'default', after: [[Q(), M()]] });
  approve(t, stale);
  ended(stale, Date.now() + 3_600_000); // the record ended AFTER the owner's word
  const refused = stale.run();
  assertExit(refused, 1);
  assert.equal(refused.json.error, 'queue-removed');
  assert.match(refused.json.reasons[0], /say "merge" again/);
  assert.equal(refused.json.recordTerminal, 'removed');
  assert.equal(stale.enqueueCalls().length, 0);
  assert.equal(stale.record().terminal, 'removed');

  const fresh = world({ route: 'owner-go', command: 'default', after: [[Q(), M()]] });
  approve(t, fresh);
  ended(fresh, Date.now() - 60_000); // the record ended BEFORE the owner's word
  const r = fresh.run();
  assertExit(r, 0);
  assert.equal(r.json.merged, true);
  assert.equal(fresh.enqueueCalls().length, 1);
  const rec = fresh.record();
  assert.equal(rec.attempts, 1, 'a new record with a new budget');
  assert.equal(rec.removals.length, 0);
  assert.equal(rec.terminal, 'merged');
});

// ---- preMergeProblems, queue variant ----------------------------------------------------------------------------------------------

test('preMergeProblems: queueMode ignores a moved base, a moved head still refuses; without queueMode the base is checked as before', async () => {
  const HEAD = '1'.repeat(40);
  const gh = (head, baseRefOid) => ({
    prView: () => ({ state: 'OPEN', headRefOid: head, labels: [], isDraft: false, baseRefOid, body: '' }),
    listIssues: () => [],
  });
  assert.deepEqual(await preMergeProblems({ gh: gh(HEAD, BASE_SHA), pr: PR, head: HEAD, base: '2'.repeat(40), queueMode: true }), []);
  const moved = await preMergeProblems({ gh: gh('3'.repeat(40), BASE_SHA), pr: PR, head: HEAD, base: '2'.repeat(40), queueMode: true });
  assert.equal(moved.length, 1);
  assert.match(moved[0], /PR head is now/);
  const direct = await preMergeProblems({ gh: gh(HEAD, BASE_SHA), pr: PR, head: HEAD, base: '2'.repeat(40) });
  assert.equal(direct.length, 1);
  assert.match(direct[0], /PR base is now/);
});

// ---- #228: the gated route's fresh decision after a terminal record ------------------------------------------------------------------

// A record for the current head that ended at `terminalAtMs` after two group-check removals.
const endedRecord = (s, terminalAtMs) => {
  const approval = { items: 'none', areas: [], rulings: null };
  beginAttempt(s.repo.dir, PR, s.head, approval, { repo: 'acme/widgets', repoId: 4242, now: () => terminalAtMs - 5000, route: 'gated' });
  noteRemoval(s.repo.dir, PR, { reason: 'failed_checks', beforeCommit: QUEUE_COMMIT, at: STAMP });
  noteRemoval(s.repo.dir, PR, { reason: 'failed_checks', beforeCommit: QUEUE_COMMIT_2, at: STAMP });
  endRecord(s.repo.dir, PR, 'removed', { now: () => terminalAtMs });
};

test('gated route, record for head H ended: a final-gate run that passed BEFORE it ended is refused; one that passed AFTER re-queues H with a new budget (#228)', () => {
  const stale = world({ after: [[Q(), M()]] });
  endedRecord(stale, Date.now() + 3_600_000); // the record ended AFTER the gate on file was written
  const refused = stale.run();
  assertExit(refused, 1);
  assert.equal(refused.json.error, 'queue-removed');
  assert.match(refused.json.reasons[0], /run `P final-gate` again/);
  assert.equal(refused.json.recordTerminal, 'removed');
  assert.equal(stale.enqueueCalls().length, 0);
  assert.equal(stale.record().terminal, 'removed');

  const fresh = world({ after: [[Q(), M()]] });
  endedRecord(fresh, Date.now() - 60_000); // the gate on file was written after the record ended
  const r = fresh.run();
  assertExit(r, 0);
  assert.equal(r.json.merged, true);
  assert.equal(fresh.enqueueCalls().length, 1);
  const rec = fresh.record();
  assert.equal(rec.attempts, 1, 'a new record with a new budget');
  assert.equal(rec.removals.length, 0);
  assert.equal(rec.route, 'gated');
  assert.equal(rec.terminal, 'merged');
});

test('gateFreshSince: a passing gate with no owner items, written after the record ended, is a fresh decision; anything else is not (#228)', () => {
  const since = Date.parse('2026-11-09T10:00:00Z');
  const gate = (over = {}) => ({ ok: true, ownerMerge: 0, at: '2026-11-09T10:00:01Z', ...over });
  assert.equal(gateFreshSince(gate(), since), true);
  assert.equal(gateFreshSince(gate({ ownerMerge: undefined }), since), true);
  assert.equal(gateFreshSince(gate({ at: '2026-11-09T10:00:00Z' }), since), false, 'not newer than the end');
  assert.equal(gateFreshSince(gate({ at: '2026-11-09T09:00:00Z' }), since), false);
  assert.equal(gateFreshSince(gate({ at: 'not a time' }), since), false);
  assert.equal(gateFreshSince(gate({ ok: false }), since), false);
  assert.equal(gateFreshSince(gate({ ownerMerge: 2 }), since), false, 'items for the owner need the owner\'s fresh word, not a gate run');
  assert.equal(gateFreshSince(gate(), Infinity), false, 'an end time that cannot be read never lets a gate through');
  assert.equal(gateFreshSince(null, since), false);
});

// ---- review round 1 ---------------------------------------------------------------------------------------------------------------------

// R1-B1: recheckGated (P merge's own watch and the sweep) refuses whenever the live owner-item digest is not the one the gate was written with,
// whether or not the owner's word is in play: the owner approved (or was shown) THAT set.
test('recheckGated: the live owner-item digest differing from the gate\'s refuses, with the same head and patch (R1-B1)', async () => {
  const gate = { head: 'a'.repeat(40), contentHash: 'h1', ownerItems: 'abc123', ownerMerge: 0 };
  const live = (over = {}) => ({ head: gate.head, contentHash: 'h1', ownerItems: 'abc123', checks: [{ name: 'ci', ok: true }], ...over });
  const ask = (fresh, ownerApproved) => recheckGated({
    root: '/x', config: {}, pr: PR, gh: { repo: () => ({ slug: 'acme/widgets' }) }, env: {}, gate, ownerApproved, ownerMergeReason: 'owner first',
    evaluate: async () => fresh, problemsOf: async () => [],
  });
  assert.deepEqual(await ask(live(), false), { ok: true }, 'the same set re-queues');
  for (const ownerApproved of [false, true]) {
    const r = await ask(live({ ownerItems: 'def456' }), ownerApproved);
    assert.equal(r.ok, false, `ownerApproved ${ownerApproved}`);
    assert.equal(r.error, 'pre-merge');
    assert.match(r.reasons[0], /owner items changed/);
    assert.match(r.reasons[0], /def456/);
  }
});

// R1-F1: a fresh final-gate run revives an ended head only where the owner's word is NOT required. A resumed run (or an unchecked run record,
// or items for the owner) needs a "merge" newer than the record's end, whatever the gate's age.
test('gated route, resumed run, record for head H ended: a final-gate run after the end does not revive the owner\'s OLD "merge"; a newer word does (R1-F1)', (t) => {
  const resumedRecord = {
    v: 1, repo: 'acme/widgets', pr: PR, branch: 'agent/feature', baseRef: 'main', step: 'gate', outcome: null, next: '', detail: '', head: null,
    request: '', tasks: [], verify: null, round: 0, mergeSha: null, inFlight: null, heartbeat: null, agentLogLine: null, cliVersion: null, history: [],
    resumed: { at: '2026-10-12T08:00:00.000Z', host: 'pc-2', head: 'a'.repeat(40) },
  };
  let body = '';
  writeSummaryComment({ viewer: () => 'me', listComments: () => [], upsertComment: (n, m, b) => { body = b; return { id: 77, url: 'u', action: 'created' }; } }, PR, { record: resumedRecord });
  const resumedWorld = () => world({
    after: [[Q(), M()]],
    gh: { comments: [{ id: 77, user: { login: 'me' }, body }], extra: [{ match: '-X PATCH repos/acme/widgets/issues/comments/77', stdoutJson: { id: 77, html_url: 'u' } }] },
  });
  const mergeFlags = (s) => cli(['merge', '--pr', String(PR), '--owner-approved-head', s.head, '--owner-approved-items', 'none'], { dir: s.repo.dir, fake: s.fake, env: s.env });

  const stale = resumedWorld();
  approve(t, stale); // the owner's word (T1) ...
  endedRecord(stale, Date.now()); // ... the record ended (T2) ...
  assertExit(stale.gate(), 0); // ... and the agent re-ran the final gate (T3): passing, no items for the owner
  const refused = mergeFlags(stale);
  assertExit(refused, 1);
  assert.equal(refused.json.error, 'queue-removed');
  assert.match(refused.json.reasons[0], /already left the merge queue/);
  assert.equal(stale.enqueueCalls().length, 0);
  assert.equal(stale.record().terminal, 'removed');

  const fresh = resumedWorld();
  endedRecord(fresh, Date.now() - 1000);
  approve(t, fresh); // a word newer than the record's end
  assertExit(fresh.gate(), 0);
  const r = mergeFlags(fresh);
  assertExit(r, 0);
  assert.equal(r.json.merged, true);
  assert.equal(fresh.enqueueCalls().length, 1);
  assert.equal(fresh.record().attempts, 1, 'a new record with a new budget');
});
