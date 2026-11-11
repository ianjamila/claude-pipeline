// A queue-mode merge whose branch does not contain the commit that taught the repo's merge script the merge queue (eaglewatch #1735): a custom
// merge.command runs the BRANCH's own script, which may not know the queue. The base branch names that commit in .claude/merge-queue-aware; the route
// reads it from GitHub, asks GitHub whether the PR head contains it, and refuses a branch that does not (or cannot be shown to) before anything is
// queued or run; the default command (gh enqueues, no branch code) is never asked.
// Direct createQueueRoute / sweepRepo tests with a stub gh and a real shell command that leaves a marker file; the CLI cases (dry run,
// update-branch) live in merge-dry-run.test.mjs and update-branch.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULTS } from '../pipeline/lib/config.mjs';
import { beginAttempt, confirmAttempt, noteRemoval, openRecord, parseQueueAwareMarker, predatesQueueMessage, queueCatchUpState, readQueueRecord, setHold } from '../pipeline/lib/merge-queue.mjs';
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
const QA = 'c'.repeat(40); // the commit the base's .claude/merge-queue-aware names

const st = (over = {}) => ({ enabled: true, inQueue: false, state: 'OPEN', head: H, mergeSha: null, entry: null, ...over });
const inQ = () => st({ inQueue: true, entry: { id: 'MQE_1', state: 'AWAITING_CHECKS', position: 1, enqueuedAt: '2026-11-09T08:00:00Z', headCommit: null } });
const evt = (type, at, reason = null, beforeCommit = null) => ({ type, at: `2026-11-09T${at}Z`, reason, actor: 'github-merge-queue', beforeCommit });
const FIRST = [evt('added', '08:00:00'), evt('removed', '08:30:00', 'failed_checks', QC1)];

// A stub gh. `marker`: the text of .claude/merge-queue-aware on the base ({ found: false } for no file | an Error for a read that throws); `rel`: what comparing
// the marker's commit with the PR head answers (a status string | an Error).
function stub({ marker = `# taught the queue\n${QA}\n`, rel = 'ahead', states = [st()], events = [[]] } = {}) {
  let s = 0;
  const m = {
    calls: [], labels: [], reads: { marker: 0, compare: 0 },
    queueState: () => states[Math.min(s++, states.length - 1)],
    queueEvents: () => events[0],
    fileAt: (path, ref) => {
      m.reads.marker += 1;
      m.calls.push(`fileAt ${path} ${ref}`);
      if (marker instanceof Error) throw marker;
      return marker?.found === false ? marker : { found: true, text: marker };
    },
    compare: (base, head) => {
      m.reads.compare += 1;
      m.calls.push(`compare ${base.slice(0, 8)} ${head.slice(0, 8)}`);
      if (rel instanceof Error) throw rel;
      return { status: rel, behindBy: 0, aheadBy: 1, baseSha: BASE };
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

const NO_FILE = { found: false, why: 'no such file' };
const http = (code) => Object.assign(new Error(`gh: HTTP ${code}`), { stderr: `HTTP ${code}` });

test('queueCatchUpState: the marker is read from the base branch and its commit compared with the PR head: current (ahead | identical), predates (behind | diverged)', () => {
  for (const rel of ['ahead', 'identical']) {
    const gh = stub({ rel });
    const r = queueCatchUpState({ gh, branch: 'main', head: H });
    assert.deepEqual([rel, r.needed, r.kind, r.queueAwareSha, r.unreadable], [rel, false, 'current', QA, false]);
    assert.deepEqual(gh.calls, ['fileAt .claude/merge-queue-aware main', `compare ${QA.slice(0, 8)} ${H.slice(0, 8)}`], 'the base branch is asked, then the ancestry');
  }
  for (const rel of ['behind', 'diverged']) {
    const r = queueCatchUpState({ gh: stub({ rel }), branch: 'main', head: H });
    assert.deepEqual([rel, r.needed, r.kind, r.queueAwareSha, r.unreadable], [rel, true, 'predates', QA, false]);
    assert.match(r.why, /does not contain cccccccccccc, the commit that taught the merge script about the queue/);
  }
});

test('queueCatchUpState: marker comments and blank lines are skipped; the first other line must be a full sha (any case)', () => {
  assert.equal(parseQueueAwareMarker(`\n# note\n   \n${QA.toUpperCase()}  \n# ${'d'.repeat(40)}\n`), QA);
  assert.equal(parseQueueAwareMarker(`\uFEFF${QA}\r\n`), QA);
  for (const bad of ['', '# only a comment\n', 'abc123\n', `${QA}0\n`, `${QA.slice(1)}\n`, `main\n${QA}\n`, `${QA} # taught\n`]) assert.equal(parseQueueAwareMarker(bad), null, JSON.stringify(bad));
});

test('queueCatchUpState: no usable marker is unknown and structural (unreadable false); a read that THREW is unknown and unreadable true; neither is ever current', () => {
  const structural = [
    ['no file on the base', { marker: NO_FILE }],
    ['an empty file', { marker: '' }],
    ['a file with a short sha', { marker: 'abc1234\n' }],
    ['a marker commit GitHub does not know (compare 404)', { rel: http(404) }],
  ];
  for (const [why, over] of structural) {
    const r = queueCatchUpState({ gh: stub(over), branch: 'main', head: H });
    assert.deepEqual([why, r.needed, r.kind, r.unreadable], [why, true, 'unknown', false]);
  }
  const thrown = [
    ['the file read throws', { marker: new Error('HTTP 502') }],
    ['the compare throws', { rel: new Error('HTTP 502') }],
    ['the compare answers a status nobody knows', { rel: 'weird' }],
  ];
  for (const [why, over] of thrown) {
    const r = queueCatchUpState({ gh: stub(over), branch: 'main', head: H });
    assert.deepEqual([why, r.needed, r.kind, r.unreadable], [why, true, 'unknown', true]);
  }
  assert.deepEqual(queueCatchUpState({ gh: {}, branch: 'main', head: H }).kind, 'unknown', 'a client without the reads');
});

test('queueCatchUpState: the marker is read through gh.fileAt, never from the local checkout or the PR branch (the ref asked is the base branch)', () => {
  const gh = stub();
  queueCatchUpState({ gh, branch: 'release/1', head: H });
  assert.equal(gh.calls[0], 'fileAt .claude/merge-queue-aware release/1');
});

// ---- P merge (the route) ----------------------------------------------------------------------------------------------------------

test('1. custom merge command + a branch that does not contain the marker commit: refused (queue-branch-predates-switch), the command never ran, nothing enqueued, no record', async () => {
  const root = repoDir();
  const gh = stub({ rel: 'diverged' });
  const res = await routeFor(root, gh, customConfig()).enqueueAndWatch();
  assert.equal(res.exitCode, 1);
  assert.equal(res.output.error, 'queue-branch-predates-switch');
  assert.equal(res.output.queued, false);
  assert.equal(res.output.branchState, 'predates');
  assert.equal(res.output.queueAwareSha, QA);
  assert.equal('switchedOn' in res.output || 'mergeBaseAt' in res.output, false, 'the time-based fields are gone');
  assert.match(res.output.reasons[0], /PR #7's branch does not contain cccccccccccc, the commit that taught the merge script about the merge queue/);
  assert.match(res.output.reasons[0], /P update-branch --pr 7/);
  assert.match(res.output.reasons[0], /P review-complete/);
  assert.equal(ran(root), false, 'the branch\'s own merge command never ran');
  assert.deepEqual(writes(gh), []);
  assert.equal(readQueueRecord(root, PR), null, 'no attempt was begun');
});

test('2. custom merge command + a branch that contains the marker commit: runs as before', async () => {
  const root = repoDir();
  const gh = stub({ rel: 'ahead' });
  const res = await routeFor(root, gh, customConfig()).enqueueAndWatch();
  assert.equal(ran(root), true, 'the command ran');
  assert.notEqual(res.output.error, 'queue-branch-predates-switch');
  assert.notEqual(readQueueRecord(root, PR), null, 'an attempt was begun');
});

test('3. the DEFAULT merge command never checks (gh enqueues; no branch code runs): enqueued as before, no read of the marker or the ancestry', async () => {
  const root = repoDir();
  const gh = stub({ marker: new Error('must not be read'), rel: new Error('must not be read') });
  const res = await routeFor(root, gh, defaultConfig()).enqueueAndWatch();
  assert.notEqual(res.output.error, 'queue-branch-predates-switch');
  assert.deepEqual(gh.calls.filter((c) => c.startsWith('enqueue')), [`enqueue ${PR} aaaaaaaa`]);
  assert.deepEqual(gh.reads, { marker: 0, compare: 0 });
});

test('4. no usable marker on the base: refused (fail closed), the command never ran', async () => {
  for (const [why, over] of [
    ['the base has no .claude/merge-queue-aware', { marker: NO_FILE }],
    ['the marker is malformed', { marker: 'soon\n' }],
  ]) {
    const root = repoDir();
    const gh = stub(over);
    const res = await routeFor(root, gh, customConfig()).enqueueAndWatch();
    assert.equal(res.output.error, 'queue-branch-predates-switch', why);
    assert.equal(res.output.branchState, 'unknown', why);
    assert.match(res.output.reasons[0], /cannot be shown to contain the commit that taught the merge script about the merge queue/, why);
    assert.match(res.output.reasons[0], /\.claude\/merge-queue-aware/, why);
    assert.doesNotMatch(res.output.reasons[0], /update-branch|Catch the branch up/, `${why}: a catch-up cannot fix the base's marker or a read failure`);
    assert.equal(ran(root), false, why);
    assert.deepEqual(writes(gh), [], why);
  }
});

test('4b. predatesQueueMessage: only a predating branch is sent to P update-branch; a structural unknown says the marker on the base must be added or fixed; an unreadable one says to try again', () => {
  const predates = predatesQueueMessage({ pr: 7, state: { kind: 'predates', queueAwareSha: QA, why: 'x', unreadable: false } });
  assert.match(predates, /P update-branch --pr 7/);
  const structural = predatesQueueMessage({ pr: 7, state: { kind: 'unknown', queueAwareSha: null, why: '.claude/merge-queue-aware is missing on main', unreadable: false } });
  assert.match(structural, /add or fix the marker/);
  assert.doesNotMatch(structural, /update-branch/);
  const blip = predatesQueueMessage({ pr: 7, state: { kind: 'unknown', queueAwareSha: null, why: 'could not be read (HTTP 502)', unreadable: true } });
  assert.match(blip, /try again/);
  assert.doesNotMatch(blip, /update-branch/);
});

test('5. a branch at the base tip gets no shortcut: when the ancestry says it lacks the marker commit it predates (the base itself may lack it)', async () => {
  const root = repoDir();
  const gh = stub({ rel: 'diverged' });
  gh.compare = (base) => { gh.reads.compare += 1; return { status: base === QA ? 'behind' : 'identical', behindBy: 0, aheadBy: 0, baseSha: BASE }; };
  const res = await routeFor(root, gh, customConfig()).enqueueAndWatch();
  assert.equal(res.output.error, 'queue-branch-predates-switch');
  assert.equal(ran(root), false);
});

test('6. the re-queue after a group-check removal asks again: a branch that lacks the marker commit ends the record blocked and puts the hold back, no second attempt', async () => {
  const root = repoDir();
  openRecord(root, PR, H, APPROVAL, { ...IDENT, route: 'owner-go' });
  setHold(root, PR, HOLD);
  beginAttempt(root, PR, H, APPROVAL, IDENT);
  confirmAttempt(root, PR, 'MQE_1');
  const gh = stub({ rel: 'diverged', states: [inQ(), st()], events: [FIRST] });
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
  const gh = stub({ rel: 'diverged', states: [st()], events: [FIRST] });
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
  assert.match(said.join('\n'), /queue-branch-predates-switch|does not contain cccccccccccc/);
});

test('8. the sweep re-queue of a branch that contains the marker commit still goes through', async () => {
  const root = repoDir();
  execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'one']);
  openRecord(root, PR, H, APPROVAL, { ...IDENT, route: 'owner-go' });
  beginAttempt(root, PR, H, APPROVAL, IDENT);
  confirmAttempt(root, PR, 'MQE_1');
  const gh = stub({ rel: 'ahead', states: [st()], events: [FIRST] });
  await sweepRepo({
    root, env: { PIPELINE_LOCK_DIR: mkdtempSync(join(tmpdir(), 'cp-predates-locks-')), ...ENV }, notify: () => {}, makeGh: () => gh, sleep: async () => {}, headOf: () => H,
    loadCfg: async () => ({ ok: true, config: customConfig() }), recheckFn: async () => ({ ok: true }),
  });
  assert.equal(ran(root), true, 'the command ran for the re-queue');
});

// ---- a failed read on a re-queue is a blip, not a verdict (R1-F5) ---------------------------------------------------------------------

test('9. the in-process re-queue whose marker / ancestry read THROWS is queue-unreadable: nothing enqueued, the record stays live, the hold stays lifted', async () => {
  for (const [why, over] of [['the marker read throws', { marker: new Error('HTTP 502') }], ['the ancestry compare throws', { rel: new Error('HTTP 502') }]]) {
    const root = repoDir();
    openRecord(root, PR, H, APPROVAL, { ...IDENT, route: 'owner-go' });
    setHold(root, PR, HOLD);
    beginAttempt(root, PR, H, APPROVAL, IDENT);
    confirmAttempt(root, PR, 'MQE_1');
    const gh = stub({ ...over, states: [inQ(), st()], events: [FIRST] });
    const res = await routeFor(root, gh, customConfig()).enqueueAndWatch({ watchOnly: true });
    assert.equal(res.output.error, 'queue-unreadable', why);
    assert.match(res.output.reasons[0], /HTTP 502/, why);
    assert.equal(readQueueRecord(root, PR).terminal, null, `${why}: the record is kept`);
    assert.equal(readQueueRecord(root, PR).attempts, 1, `${why}: no second attempt`);
    assert.deepEqual(gh.labels, [], `${why}: the hold was not put back`);
    assert.deepEqual(writes(gh), [], why);
    assert.equal(ran(root), false, why);
  }
});

test('10. a re-queue where the base declares NO usable marker (structural, not a blip) still ends the record blocked and puts the hold back', async () => {
  for (const [why, over] of [['no file', { marker: NO_FILE }], ['a malformed marker', { marker: 'soon\n' }], ['a marker commit GitHub does not know', { rel: http(404) }]]) {
    const root = repoDir();
    openRecord(root, PR, H, APPROVAL, { ...IDENT, route: 'owner-go' });
    setHold(root, PR, HOLD);
    beginAttempt(root, PR, H, APPROVAL, IDENT);
    confirmAttempt(root, PR, 'MQE_1');
    const gh = stub({ ...over, states: [inQ(), st()], events: [FIRST] });
    const res = await routeFor(root, gh, customConfig()).enqueueAndWatch({ watchOnly: true });
    assert.equal(res.output.error, 'queue-branch-predates-switch', why);
    assert.equal(res.output.branchState, 'unknown', why);
    assert.equal(readQueueRecord(root, PR).terminal, 'blocked', why);
    assert.deepEqual(gh.labels, ['needs-human'], why);
  }
});

test('11. the sweep\'s re-queue whose read THROWS leaves the record live for the next pass (unsettled): no end, no hold restore, nothing enqueued', async () => {
  for (const [why, over] of [['the marker read throws', { marker: new Error('HTTP 502') }], ['the ancestry compare throws', { rel: new Error('HTTP 502') }]]) {
    const root = repoDir();
    execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'one']);
    openRecord(root, PR, H, APPROVAL, { ...IDENT, route: 'owner-go' });
    setHold(root, PR, HOLD);
    beginAttempt(root, PR, H, APPROVAL, IDENT);
    confirmAttempt(root, PR, 'MQE_1');
    const gh = stub({ ...over, states: [st()], events: [FIRST] });
    const said = [];
    const res = await sweepRepo({
      root, env: { PIPELINE_LOCK_DIR: mkdtempSync(join(tmpdir(), 'cp-predates-locks-')), ...ENV }, notify: (t) => said.push(t), makeGh: () => gh, sleep: async () => {}, headOf: () => H,
      loadCfg: async () => ({ ok: true, config: customConfig() }), recheckFn: async () => ({ ok: true }),
    });
    assert.deepEqual(res.errors, [], why);
    assert.equal(res.settled[0].outcome, 'unsettled', why);
    assert.equal(readQueueRecord(root, PR).terminal, null, `${why}: the record is kept`);
    assert.deepEqual(gh.labels, [], `${why}: no hold restore`);
    assert.deepEqual(writes(gh), [], why);
    assert.equal(ran(root), false, why);
    assert.deepEqual(said, [], `${why}: the owner is not told of an end that did not happen`);
  }
});

test('12. ANY read that throws is queue-unreadable, the first enqueue included (nothing to keep there, but a blip is not a verdict and the answer is not "update the branch")', async () => {
  for (const [why, over] of [['the marker read throws', { marker: new Error('HTTP 502') }], ['the ancestry compare throws', { rel: new Error('HTTP 502') }]]) {
    const root = repoDir();
    const gh = stub(over);
    const res = await routeFor(root, gh, customConfig()).enqueueAndWatch();
    assert.equal(res.output.error, 'queue-unreadable', why);
    assert.match(res.output.reasons[0], /HTTP 502/, why);
    assert.doesNotMatch(res.output.reasons[0], /update-branch/, why);
    assert.equal(ran(root), false, why);
    assert.deepEqual(writes(gh), [], why);
    assert.equal(readQueueRecord(root, PR), null, `${why}: no record was begun`);
  }
});

test('13. a LIVE record without a removal (the retry after enqueue-failed, a crash before the enqueue landed) whose read throws: queue-unreadable, the record and its hold are kept (checkBranch and enqueueAndWatch alike)', async () => {
  for (const [how, go] of [
    ['checkBranch', async (route) => { const pre = await route.precheck(); assert.deepEqual([pre.enqueue, pre.requeue], [true, false], 'a live record with no removals is not a re-queue'); return route.checkBranch(); }],
    ['enqueueAndWatch', (route) => route.enqueueAndWatch()],
  ]) {
    for (const [why, over] of [['the marker read throws', { marker: new Error('HTTP 502') }], ['the ancestry compare throws', { rel: new Error('HTTP 502') }]]) {
      const root = repoDir();
      openRecord(root, PR, H, APPROVAL, { ...IDENT, route: 'owner-go' });
      setHold(root, PR, HOLD);
      const gh = stub(over);
      const res = await go(routeFor(root, gh, customConfig()));
      const label = `${how}, ${why}`;
      assert.equal(res.output.error, 'queue-unreadable', label);
      assert.equal(readQueueRecord(root, PR).terminal, null, `${label}: the record is kept live`);
      assert.equal(readQueueRecord(root, PR).hold?.id, HOLD.id, `${label}: the hold stays recorded`);
      assert.deepEqual(gh.labels, [], `${label}: the hold was not put back`);
      assert.deepEqual(writes(gh), [], label);
      assert.equal(ran(root), false, label);
    }
  }
});
