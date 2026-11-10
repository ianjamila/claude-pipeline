// A queue-mode merge whose branch was made before the merge queue was switched on (eaglewatch #1735): a custom merge.command runs the BRANCH's own
// script, which may not know the queue. The route reads the switch-on time (the merge_queue ruleset's created_at) and the branch's merge base
// from GitHub and refuses such a branch before anything is queued or run; the default command (gh enqueues, no branch code) is never asked.
// Direct createQueueRoute / sweepRepo tests with a stub gh and a real shell command that leaves a marker file; the CLI cases (dry run,
// update-branch) live in merge-dry-run.test.mjs and update-branch.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULTS } from '../pipeline/lib/config.mjs';
import { beginAttempt, confirmAttempt, noteRemoval, openRecord, queueCatchUpState, readQueueRecord, setHold } from '../pipeline/lib/merge-queue.mjs';
import { createQueueRoute, restoreHoldOnTerminal } from '../pipeline/lib/queue-route.mjs';
import { sweepRepo } from '../pipeline/lib/queue-sweep.mjs';
import { RESTORE_NOTE } from '../pipeline/lib/hold.mjs';

const H = 'a'.repeat(40);
const BASE = '1'.repeat(40);
const QC1 = 'b'.repeat(40);
const PR = 7;
const APPROVAL = { items: 'abc123', areas: null, rulings: null };
const IDENT = { repo: 'acme/widgets', repoId: 42 };
const HOLD = { id: 'LE_hold1', login: 'jamila', at: '2026-11-05T09:00:00Z', holdBlock: 'digest', liftedAt: '2026-11-09T07:59:00Z' };
const SWITCHED_ON = '2026-11-05T10:00:00Z';
const OLD = '2026-10-20T08:00:00Z'; // the merge base: before the switch-on
const NEW = '2026-11-08T08:00:00Z'; // the merge base: after it

const st = (over = {}) => ({ enabled: true, inQueue: false, state: 'OPEN', head: H, mergeSha: null, entry: null, ...over });
const inQ = () => st({ inQueue: true, entry: { id: 'MQE_1', state: 'AWAITING_CHECKS', position: 1, enqueuedAt: '2026-11-09T08:00:00Z', headCommit: null } });
const evt = (type, at, reason = null, beforeCommit = null) => ({ type, at: `2026-11-09T${at}Z`, reason, actor: 'github-merge-queue', beforeCommit });
const FIRST = [evt('added', '08:00:00'), evt('removed', '08:30:00', 'failed_checks', QC1)];

// A stub gh. `base`: what the merge base read answers ({ behindBy, committedAt } | an Error); `rule`: the merge_queue rule among the branch rules
// (null = none); `ruleset`: what the ruleset read answers (an ISO string | an Error).
function stub({ base = { behindBy: 3, committedAt: OLD }, rule = { type: 'merge_queue', ruleset_id: 77, parameters: {} }, ruleset = SWITCHED_ON, states = [st()], events = [[]] } = {}) {
  let s = 0;
  const m = {
    calls: [], labels: [], reads: { mergeBase: 0, ruleset: 0 },
    queueState: () => states[Math.min(s++, states.length - 1)],
    queueEvents: () => events[0],
    mergeBaseOf: (b, h) => {
      m.reads.mergeBase += 1;
      m.calls.push(`mergeBase ${b} ${h.slice(0, 8)}`);
      if (base instanceof Error) throw base;
      return { sha: BASE, ...base };
    },
    branchRules: () => (rule === null ? [{ type: 'pull_request', parameters: {} }] : [rule]),
    ruleset: (id) => {
      m.reads.ruleset += 1;
      if (ruleset instanceof Error) throw ruleset;
      return { id, createdAt: ruleset };
    },
    prView: () => ({ state: 'OPEN', labels: m.labels.map((name) => ({ name })), mergeCommit: null }),
    addLabels: (n, names) => { m.calls.push(`add ${names}`); for (const x of names) if (!m.labels.includes(x)) m.labels.push(x); },
    listIssues: () => [],
    dequeue: (n) => { m.calls.push(`dequeue ${n}`); },
    enqueue: (n, head) => { m.calls.push(`enqueue ${n} ${head.slice(0, 8)}`); },
    checkRunsOf: () => [{ name: 'ci', conclusion: 'failure' }],
    statusesOf: () => [],
    repo: () => ({ slug: 'acme/widgets' }),
    repoId: () => 42,
  };
  return m;
}
const writes = (m) => m.calls.filter((c) => /^(add|dequeue|enqueue)/.test(c));

const repoDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-predates-'));
  execFileSync('git', ['init', '-q', dir]);
  return dir;
};
const refuse = (error, reasons, extra = {}) => ({ exitCode: 1, output: { ok: false, merged: false, error, reasons, message: reasons.join('; '), ...extra } });
// The repo's own merge command: leaves a marker where it ran (cwd = the worktree).
const customConfig = () => ({ merge: { ...DEFAULTS.merge, command: 'node -e "require(\'fs\').writeFileSync(\'ran.marker\', \'{pr} {sha}\')"', wait_minutes: 1 }, default_branch: 'main' });
const defaultConfig = () => ({ merge: { ...DEFAULTS.merge }, default_branch: 'main' });
const ENV = { PIPELINE_QUEUE_POLL_MS: '1', PIPELINE_QUEUE_WAIT_MS: '5000', PIPELINE_QUEUE_CONFIRM_MS: '50', PIPELINE_QUEUE_CONFIRM_POLL_MS: '1' };
const routeFor = (root, gh, config, over = {}) => createQueueRoute({
  gh, root, config, pr: PR, head: H, route: 'owner-go', env: ENV, refuse, approval: APPROVAL, recheck: async () => ({ ok: true }),
  onTerminal: restoreHoldOnTerminal({ gh, pr: PR }), sleep: async () => {}, ...over,
});
const ran = (root) => existsSync(join(root, 'ran.marker'));

// ---- the state itself --------------------------------------------------------------------------------------------------------------

test('queueCatchUpState: predates | current | unknown, with the dates it compared', () => {
  const predates = queueCatchUpState({ gh: stub(), branch: 'main', head: H });
  assert.deepEqual([predates.needed, predates.kind, predates.switchedOn, predates.mergeBaseAt, predates.behindBy], [true, 'predates', SWITCHED_ON, OLD, 3]);
  assert.match(predates.why, /before the merge queue was switched on/);
  const after = queueCatchUpState({ gh: stub({ base: { behindBy: 3, committedAt: NEW } }), branch: 'main', head: H });
  assert.deepEqual([after.needed, after.kind], [false, 'current']);
  const exactly = queueCatchUpState({ gh: stub({ base: { behindBy: 1, committedAt: SWITCHED_ON } }), branch: 'main', head: H });
  assert.equal(exactly.needed, false, 'a merge base made at the very moment of the switch-on is not before it');
});

test('queueCatchUpState: a switch-on time GitHub writes with an offset compares as the instant it is against a Z merge-base date', () => {
  const offset = '2026-11-10T15:27:47.979+08:00'; // = 2026-11-10T07:27:47.979Z
  const before = queueCatchUpState({ gh: stub({ ruleset: offset, base: { behindBy: 2, committedAt: '2026-11-10T07:27:47Z' } }), branch: 'main', head: H });
  assert.deepEqual([before.needed, before.kind, before.switchedOn], [true, 'predates', offset], 'a base a fraction of a second before the instant predates it');
  const after = queueCatchUpState({ gh: stub({ ruleset: offset, base: { behindBy: 2, committedAt: '2026-11-10T07:27:48Z' } }), branch: 'main', head: H });
  assert.deepEqual([after.needed, after.kind], [false, 'current'], 'a base after the instant is current, not read as 08 hours later or earlier');
  const wallClock = queueCatchUpState({ gh: stub({ ruleset: offset, base: { behindBy: 2, committedAt: '2026-11-10T14:00:00Z' } }), branch: 'main', head: H });
  assert.equal(wallClock.kind, 'current', 'the local wall-clock digits (15:27) are not mistaken for UTC');
});

test('queueCatchUpState: a branch that is not behind its base holds all of it: current, and the switch-on time is not even read', () => {
  const gh = stub({ base: { behindBy: 0, committedAt: OLD }, ruleset: new Error('HTTP 500') });
  const r = queueCatchUpState({ gh, branch: 'main', head: H });
  assert.deepEqual([r.needed, r.kind], [false, 'current']);
  assert.equal(gh.reads.ruleset, 0);
});

test('queueCatchUpState: every unreadable piece is unknown (needed), never current', () => {
  for (const [why, over] of [
    ['merge base read fails', { base: new Error('HTTP 502') }],
    ['no merge_queue rule among the rules', { rule: null }],
    ['the rule names no ruleset (a rule from somewhere else)', { rule: { type: 'merge_queue', parameters: {} } }],
    ['the ruleset read fails', { ruleset: new Error('HTTP 404') }],
  ]) {
    const r = queueCatchUpState({ gh: stub(over), branch: 'main', head: H });
    assert.deepEqual([why, r.needed, r.kind], [why, true, 'unknown']);
  }
  assert.equal(queueCatchUpState({ gh: { mergeBaseOf() { throw new Error('x'); } }, branch: 'main', head: H }).kind, 'unknown');
  assert.equal(queueCatchUpState({ gh: {}, branch: 'main', head: H }).kind, 'unknown', 'a client without the reads');
});

// ---- P merge (the route) ----------------------------------------------------------------------------------------------------------

test('1. custom merge command + a branch older than the switch-on: refused (queue-branch-predates-switch), the command never ran, nothing enqueued, no record', async () => {
  const root = repoDir();
  const gh = stub();
  const res = await routeFor(root, gh, customConfig()).enqueueAndWatch();
  assert.equal(res.exitCode, 1);
  assert.equal(res.output.error, 'queue-branch-predates-switch');
  assert.equal(res.output.queued, false);
  assert.equal(res.output.branchState, 'predates');
  assert.match(res.output.reasons[0], /PR #7's branch was made on 2026-10-20, before the merge queue was switched on \(2026-11-05\)/);
  assert.match(res.output.reasons[0], /P update-branch --pr 7/);
  assert.match(res.output.reasons[0], /P review-complete/);
  assert.equal(ran(root), false, 'the branch\'s own merge command never ran');
  assert.deepEqual(writes(gh), []);
  assert.equal(readQueueRecord(root, PR), null, 'no attempt was begun');
});

test('2. custom merge command + a branch made after the switch-on: runs as before', async () => {
  const root = repoDir();
  const gh = stub({ base: { behindBy: 3, committedAt: NEW } });
  const res = await routeFor(root, gh, customConfig()).enqueueAndWatch();
  assert.equal(ran(root), true, 'the command ran');
  assert.notEqual(res.output.error, 'queue-branch-predates-switch');
  assert.notEqual(readQueueRecord(root, PR), null, 'an attempt was begun');
});

test('3. the DEFAULT merge command never checks (gh enqueues; no branch code runs): enqueued as before, no read of the merge base or the ruleset', async () => {
  const root = repoDir();
  const gh = stub({ base: new Error('must not be read'), ruleset: new Error('must not be read') });
  const res = await routeFor(root, gh, defaultConfig()).enqueueAndWatch();
  assert.notEqual(res.output.error, 'queue-branch-predates-switch');
  assert.deepEqual(gh.calls.filter((c) => c.startsWith('enqueue')), [`enqueue ${PR} aaaaaaaa`]);
  assert.deepEqual(gh.reads, { mergeBase: 0, ruleset: 0 });
});

test('4. switch-on time unknown, or the merge base unreadable: refused (fail closed), the command never ran', async () => {
  for (const [why, over] of [
    ['ruleset read fails', { ruleset: new Error('HTTP 502') }],
    ['no ruleset id on the rule', { rule: { type: 'merge_queue', parameters: {} } }],
    ['merge base unreadable', { base: new Error('HTTP 502') }],
  ]) {
    const root = repoDir();
    const gh = stub(over);
    const res = await routeFor(root, gh, customConfig()).enqueueAndWatch();
    assert.equal(res.output.error, 'queue-branch-predates-switch', why);
    assert.equal(res.output.branchState, 'unknown', why);
    assert.match(res.output.reasons[0], /cannot be shown to be newer than the merge queue/, why);
    assert.equal(ran(root), false, why);
    assert.deepEqual(writes(gh), [], why);
  }
});

test('5. a branch that is not behind its base is current even with the switch-on unknown (nothing a catch-up could add): runs', async () => {
  const root = repoDir();
  const gh = stub({ base: { behindBy: 0, committedAt: OLD }, rule: null });
  await routeFor(root, gh, customConfig()).enqueueAndWatch();
  assert.equal(ran(root), true);
});

test('6. the re-queue after a group-check removal asks again: a branch that predates ends the record blocked and puts the hold back, no second attempt', async () => {
  const root = repoDir();
  openRecord(root, PR, H, APPROVAL, { ...IDENT, route: 'owner-go' });
  setHold(root, PR, HOLD);
  beginAttempt(root, PR, H, APPROVAL, IDENT);
  confirmAttempt(root, PR, 'MQE_1');
  const gh = stub({ states: [inQ(), st()], events: [FIRST] });
  const res = await routeFor(root, gh, customConfig()).enqueueAndWatch({ watchOnly: true });
  assert.equal(res.output.error, 'queue-branch-predates-switch');
  assert.equal(res.output.holdRestored, true);
  assert.equal(res.output.holdRestoredNote, RESTORE_NOTE);
  assert.deepEqual(gh.labels, ['needs-human']);
  assert.equal(readQueueRecord(root, PR).terminal, 'blocked');
  assert.equal(readQueueRecord(root, PR).attempts, 1, 'no second attempt');
  assert.equal(ran(root), false);
  assert.deepEqual(writes(gh), ['add needs-human']);
});

test('7. the sweep\'s re-queue of a predating branch fails closed: the record ends, the hold goes back, the command never runs, nothing is enqueued', async () => {
  const root = repoDir();
  execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'one']);
  openRecord(root, PR, H, APPROVAL, { ...IDENT, route: 'owner-go' });
  setHold(root, PR, HOLD);
  beginAttempt(root, PR, H, APPROVAL, IDENT);
  confirmAttempt(root, PR, 'MQE_1');
  const gh = stub({ states: [st()], events: [FIRST] });
  const said = [];
  const lockDir = mkdtempSync(join(tmpdir(), 'cp-predates-locks-'));
  const res = await sweepRepo({
    root, env: { PIPELINE_LOCK_DIR: lockDir, ...ENV }, notify: (t) => said.push(t), makeGh: () => gh, sleep: async () => {}, headOf: () => H,
    loadCfg: async () => ({ ok: true, config: customConfig() }), recheckFn: async () => ({ ok: true }),
  });
  assert.deepEqual(res.errors, []);
  assert.equal(res.settled[0].outcome, 'ended');
  assert.equal(readQueueRecord(root, PR).terminal, 'removed');
  assert.deepEqual(gh.labels, ['needs-human']);
  assert.equal(ran(root), false);
  assert.deepEqual(writes(gh), ['add needs-human']);
  assert.match(said.join('\n'), /queue-branch-predates-switch|merge queue was switched on/);
});

test('8. the sweep re-queue of a branch made after the switch-on still goes through', async () => {
  const root = repoDir();
  execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'one']);
  openRecord(root, PR, H, APPROVAL, { ...IDENT, route: 'owner-go' });
  beginAttempt(root, PR, H, APPROVAL, IDENT);
  confirmAttempt(root, PR, 'MQE_1');
  const gh = stub({ base: { behindBy: 3, committedAt: NEW }, states: [st()], events: [FIRST] });
  await sweepRepo({
    root, env: { PIPELINE_LOCK_DIR: mkdtempSync(join(tmpdir(), 'cp-predates-locks-')), ...ENV }, notify: () => {}, makeGh: () => gh, sleep: async () => {}, headOf: () => H,
    loadCfg: async () => ({ ok: true, config: customConfig() }), recheckFn: async () => ({ ok: true }),
  });
  assert.equal(ran(root), true, 'the command ran for the re-queue');
});
