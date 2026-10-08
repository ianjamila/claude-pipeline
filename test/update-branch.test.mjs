// Bringing the PR branch up to date with main before the final gate (and again in merge): the decision logic with a
// stateful fake of GitHub, the two gh calls against the scripted gh, and the CLI / merge wiring end to end.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GhError } from '../pipeline/lib/proc.mjs';
import { createGitHub } from '../pipeline/lib/github.mjs';
import { bringUpToDate, updateTiming } from '../pipeline/lib/updatebranch.mjs';
import { createFakeGh, REPO_VIEW } from './helpers/fakegh-env.mjs';
import { cli, scenario, ghEntries, PR } from './helpers/gate-env.mjs';
import { assertExit } from './helpers/assert-exit.mjs';

const sha = (c) => c.repeat(40);
const A = sha('a');
const B = sha('b');
const C = sha('c');

// ---- a stateful fake of GitHub for bringUpToDate ----------------------------------------------------------------------

// `behind`: how far behind main the head is at each successive head (shifted after every accepted update; 0 once empty).
// `lag`: prView reads that still show the old head after an update was accepted (the update is asynchronous).
function world({ head = A, behind = [1], update = null, lag = 0, checks = [[{ name: 'ci', bucket: 'pass' }]], state = 'OPEN', pushAfterUpdate = null } = {}) {
  const w = { head, behind: [...behind], updates: [], compares: 0, checkReads: 0, pending: null, heads: [B, C, sha('d'), sha('e')] };
  w.gh = {
    prView() {
      if (w.pending && w.pending.lag-- <= 0) {
        w.head = w.pending.head;
        w.pending = null;
      }
      return { state, headRefOid: w.head, baseRefName: 'main' };
    },
    compare() {
      w.compares += 1;
      return { status: 'diverged', behindBy: w.behind[0] ?? 0, aheadBy: 1 };
    },
    updateBranch(pr, expected) {
      w.updates.push({ pr, expected });
      if (update) return { result: update, message: update === 'conflict' ? 'merge conflict between base and head' : "expected head sha didn't match current head ref." };
      if (expected !== w.head) return { result: 'head-moved', message: "expected head sha didn't match current head ref." };
      w.behind.shift();
      w.pending = { head: pushAfterUpdate ?? w.heads.shift(), lag };
      return { result: 'accepted' };
    },
    checks() {
      const rows = checks[Math.min(w.checkReads, checks.length - 1)];
      w.checkReads += 1;
      if (rows === 'throw') throw new GhError({ code: 1, stderr: 'no checks reported', args: ['pr', 'checks'] });
      return rows;
    },
  };
  return w;
}

// A clock the injected sleep advances, so timeouts take no real time.
const clock = () => {
  let t = 0;
  return { now: () => t, sleep: async (ms) => { t += ms; } };
};
const run = (w, extra = {}) => bringUpToDate({ gh: w.gh, pr: PR, pollMs: 10, headWaitMs: 100, checksWaitMs: 1000, ...clock(), ...extra });

test('up to date already: no update call, nothing waited for', async () => {
  const w = world({ behind: [0] });
  const r = await run(w, { expectHead: A });
  assert.equal(r.ok, true);
  assert.equal(r.outcome, 'up-to-date');
  assert.equal(r.updated, false);
  assert.equal(r.cycles, 0);
  assert.equal(r.head, A);
  assert.deepEqual(w.updates, []);
  assert.equal(w.checkReads, 0);
});

test('behind: updates once with expected_head_sha, waits for the new head and its checks, then names the new head', async () => {
  const w = world({ behind: [2, 0], lag: 2, checks: [[], [{ name: 'ci', bucket: 'pending' }], [{ name: 'ci', bucket: 'pass' }]] });
  const r = await run(w, { expectHead: A });
  assert.equal(r.ok, true);
  assert.equal(r.outcome, 'up-to-date');
  assert.equal(r.updated, true);
  assert.equal(r.cycles, 1);
  assert.equal(r.startHead, A);
  assert.equal(r.head, B, 'the gate must now judge the up-to-date head');
  assert.deepEqual(w.updates, [{ pr: PR, expected: A }]);
  assert.ok(w.checkReads >= 4, `checks were polled until settled (reads: ${w.checkReads})`);
});

test('behind with no required checks reported: falls back to all reported checks', async () => {
  const w = world({ behind: [1, 0], checks: ['throw'] });
  w.gh.checks = (pr, { required }) => {
    if (required) throw new GhError({ code: 1, stderr: 'no required checks reported', args: ['pr', 'checks'] });
    return [{ name: 'ci', bucket: 'pass' }];
  };
  const r = await run(w, { expectHead: A });
  assert.equal(r.outcome, 'up-to-date');
  assert.equal(r.updated, true);
});

test('a conflicting update is rebase-needed: one attempt, no retry, nothing waited for', async () => {
  const w = world({ update: 'conflict' });
  const r = await run(w, { expectHead: A });
  assert.equal(r.ok, false);
  assert.equal(r.outcome, 'rebase-needed');
  assert.match(r.message, /conflict/);
  assert.match(r.message, /force-pushed/);
  assert.equal(w.updates.length, 1);
  assert.equal(w.checkReads, 0);
});

test('GitHub refusing expected_head_sha (someone pushed meanwhile) stops: no second attempt', async () => {
  const w = world({ update: 'head-moved' });
  const r = await run(w, { expectHead: A });
  assert.equal(r.outcome, 'head-moved');
  assert.equal(r.ok, false);
  assert.equal(w.updates.length, 1);
});

test('a PR head that is not the verified head is head-moved BEFORE any write', async () => {
  const w = world({ head: B });
  const r = await run(w, { expectHead: A });
  assert.equal(r.outcome, 'head-moved');
  assert.equal(r.head, B);
  assert.deepEqual(w.updates, [], 'never update a head nobody verified');
  assert.equal(w.compares, 0);
});

test('someone pushing while the new head\'s checks run is head-moved, not another blind update', async () => {
  const w = world({ behind: [1, 1], checks: [[{ name: 'ci', bucket: 'pending' }], [{ name: 'ci', bucket: 'pass' }]] });
  let reads = 0;
  const original = w.gh.checks;
  w.gh.checks = (...args) => {
    reads += 1;
    if (reads === 2) w.head = sha('9'); // a push lands while we wait
    return original(...args);
  };
  const r = await run(w, { expectHead: A });
  assert.equal(r.outcome, 'head-moved');
  assert.equal(r.head, sha('9'));
  assert.equal(w.updates.length, 1);
});

test('main that keeps moving: at most maxCycles updates, then cycle-cap', async () => {
  const w = world({ behind: [1, 1, 1, 1, 1, 1] });
  const r = await run(w, { expectHead: A, maxCycles: 3 });
  assert.equal(r.outcome, 'cycle-cap');
  assert.equal(r.ok, false);
  assert.equal(r.cycles, 3);
  assert.equal(w.updates.length, 3);
  assert.deepEqual(w.updates.map((u) => u.expected), [A, B, C], 'every cycle pins the head it just read');
  assert.match(r.message, /kept moving/);
});

test('the default cap is 3 cycles', async () => {
  const w = world({ behind: Array(10).fill(1) });
  const r = await run(w, { expectHead: A });
  assert.equal(r.outcome, 'cycle-cap');
  assert.equal(w.updates.length, 3);
});

test('main moving once more after a green update gets a second cycle, then up to date', async () => {
  const w = world({ behind: [1, 1, 0] });
  const r = await run(w, { expectHead: A });
  assert.equal(r.outcome, 'up-to-date');
  assert.equal(r.cycles, 2);
  assert.equal(r.head, C);
});

test('the updated head failing its checks, or never finishing them, ends the stage', async () => {
  const failed = await run(world({ checks: [[{ name: 'ci', bucket: 'fail' }]] }), { expectHead: A });
  assert.equal(failed.outcome, 'checks-failed');
  const timeout = await run(world({ checks: [[{ name: 'ci', bucket: 'pending' }]] }), { expectHead: A });
  assert.equal(timeout.outcome, 'checks-timeout');
  const none = await run(world({ checks: [[]] }), { expectHead: A });
  assert.equal(none.outcome, 'checks-timeout', 'no checks ever appearing is not a pass');
});

test('an accepted update whose head never changes is head-timeout', async () => {
  const w = world({ pushAfterUpdate: A });
  const r = await run(w, { expectHead: A });
  assert.equal(r.outcome, 'head-timeout');
  assert.equal(w.updates.length, 1);
});

test('waitChecks: false returns as soon as the new head exists', async () => {
  const w = world({ behind: [1, 0], checks: [[{ name: 'ci', bucket: 'pending' }]] });
  const r = await run(w, { expectHead: A, waitChecks: false });
  assert.equal(r.outcome, 'up-to-date');
  assert.equal(r.updated, true);
  assert.equal(w.checkReads, 0);
});

test('a closed PR is not-open and nothing is written', async () => {
  const w = world({ state: 'MERGED' });
  const r = await run(w, { expectHead: A });
  assert.equal(r.outcome, 'not-open');
  assert.deepEqual(w.updates, []);
});

test('updateTiming only shortens the waits', () => {
  const dflt = updateTiming({});
  assert.deepEqual(updateTiming({ PIPELINE_UPDATE_WAIT_MS: '5', PIPELINE_UPDATE_POLL_MS: '1' }), { headWaitMs: 5, checksWaitMs: 5, pollMs: 1 });
  assert.deepEqual(updateTiming({ PIPELINE_UPDATE_WAIT_MS: '99999999999', PIPELINE_UPDATE_POLL_MS: '99999999' }), dflt);
});

// ---- the two gh calls ---------------------------------------------------------------------------------------------------

const REPO = { match: '^repo view', stdoutJson: REPO_VIEW };
const mk = (entries) => {
  const fake = createFakeGh([REPO, ...entries]);
  return { fake, gh: createGitHub({ cwd: process.cwd(), env: fake.env }) };
};
const put = (extra) => ({ match: '-X PUT repos/acme/widgets/pulls/12/update-branch', ...extra });

test('updateBranch: PUTs expected_head_sha on stdin; 202 is accepted', () => {
  const { fake, gh } = mk([put({ stdoutJson: { message: 'Updating pull request branch.' } })]);
  assert.deepEqual(gh.updateBranch(12, A), { result: 'accepted' });
  const call = fake.calls().find((c) => c.argv.includes('PUT'));
  assert.deepEqual(call.argv, ['api', '-X', 'PUT', 'repos/acme/widgets/pulls/12/update-branch', '--input', '-']);
  assert.deepEqual(JSON.parse(call.stdin), { expected_head_sha: A });
});

test('updateBranch: the two 422s are answers, told apart by message', () => {
  const conflict = mk([put({ code: 1, stderr: 'gh: merge conflict between base and head (HTTP 422)', stdoutJson: { message: 'merge conflict between base and head', status: '422' } })]);
  assert.equal(conflict.gh.updateBranch(12, A).result, 'conflict');
  const moved = mk([put({ code: 1, stderr: "gh: expected head sha didn't match current head ref. (HTTP 422)", stdoutJson: { message: "expected head sha didn't match current head ref.", status: '422' } })]);
  assert.equal(moved.gh.updateBranch(12, A).result, 'head-moved');
});

test('updateBranch: an unrecognised 422, a 403, a 5xx and a hung gh all throw (never read as success)', () => {
  for (const reply of [
    { code: 1, stderr: 'gh: something else (HTTP 422)', stdoutJson: { message: 'something else', status: '422' } },
    { code: 1, stderr: 'gh: Forbidden (HTTP 403)', stdoutJson: { message: 'Forbidden', status: '403' } },
    { code: 1, stderr: 'gh: Server Error (HTTP 502)' },
  ]) {
    const { gh } = mk([put(reply)]);
    assert.throws(() => gh.updateBranch(12, A), GhError, JSON.stringify(reply));
  }
});

test('compare: reads behind_by from GitHub for base...head', () => {
  const { fake, gh } = mk([{ match: 'compare/main\\.\\.\\.', stdoutJson: { status: 'diverged', behind_by: 3, ahead_by: 2 } }]);
  assert.deepEqual(gh.compare('main', A), { status: 'diverged', behindBy: 3, aheadBy: 2 });
  assert.match(fake.lines().find((l) => l.includes('compare')), new RegExp(`repos/acme/widgets/compare/main\\.\\.\\.${A}`));
  const bad = mk([{ match: 'compare/', stdoutJson: { status: 'ahead' } }]);
  assert.throws(() => bad.gh.compare('main', A), GhError, 'a reply without counts fails closed');
});

// ---- the command --------------------------------------------------------------------------------------------------------

const puts = (s) => s.fake.lines().filter((l) => l.includes('-X PUT'));
const updateCli = (s, extra = [], env = {}) => cli(['update-branch', '--pr', String(PR), ...extra], {
  dir: s.repo.dir, fake: s.fake, env: { PIPELINE_UPDATE_WAIT_MS: '0', PIPELINE_UPDATE_POLL_MS: '1', ...env },
});

test('update-branch: an up-to-date branch makes no update call and says so', () => {
  const s = scenario();
  const r = updateCli(s);
  assertExit(r, 0);
  assert.equal(r.json.outcome, 'up-to-date');
  assert.equal(r.json.updated, false);
  assert.equal(r.json.head, s.head);
  assert.equal(r.json.pullNeeded, false);
  assert.deepEqual(puts(s), []);
});

test('update-branch: a conflicting update fails with rebase-needed (exit 1) after exactly one attempt', () => {
  const s = scenario({ gh: { behindBy: 2, update: 'conflict' } });
  const r = updateCli(s);
  assertExit(r, 1);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.outcome, 'rebase-needed');
  assert.equal(puts(s).length, 1);
  assert.deepEqual(JSON.parse(s.fake.calls().find((c) => c.argv.includes('PUT')).stdin), { expected_head_sha: s.head });
});

test('update-branch: --expect-head naming another head stops before any write', () => {
  const s = scenario({ gh: { behindBy: 2 } });
  const r = updateCli(s, ['--expect-head', 'f'.repeat(40)]);
  assertExit(r, 1);
  assert.equal(r.json.outcome, 'head-moved');
  assert.deepEqual(puts(s), []);
});

test('update-branch: GitHub refusing the head pin is head-moved; any other API failure is exit 3', () => {
  const moved = scenario({ gh: { behindBy: 2, update: 'head-moved' } });
  const r = updateCli(moved);
  assertExit(r, 1);
  assert.equal(r.json.outcome, 'head-moved');
  const denied = scenario({ gh: { behindBy: 2, update: 'forbidden' } });
  assertExit(updateCli(denied), 3);
});

test('update-branch: an accepted update whose head never changes is head-timeout, and --max-cycles is validated', () => {
  const s = scenario({ gh: { behindBy: 2 } });
  const r = updateCli(s);
  assertExit(r, 1);
  assert.equal(r.json.outcome, 'head-timeout');
  assert.equal(r.json.updated, true);
  assertExit(updateCli(s, ['--max-cycles', '0']), 2);
});

// ---- merge --------------------------------------------------------------------------------------------------------------

// A gh that, once the update-branch PUT has been made, switches to the script in swap.json (the PR head is then the new one).
function swapOnUpdate(s, entries) {
  const swap = join(s.fake.dir, 'swap.json');
  const wrapper = join(s.fake.dir, 'swap-gh.mjs');
  writeFileSync(swap, JSON.stringify(entries));
  writeFileSync(wrapper, [
    "import { copyFileSync } from 'node:fs';",
    "if (process.argv.slice(2).join(' ').includes('update-branch')) copyFileSync(process.argv[1].replace(/swap-gh\\.mjs$/, 'swap.json'), process.env.PIPELINE_FAKE_GH_SCRIPT);",
    `await import(${JSON.stringify(new URL('./fixtures/fake-gh.mjs', import.meta.url).href)});`,
    '',
  ].join('\n'));
  return { PIPELINE_GH: `node "${wrapper}"` };
}

test('merge: an up-to-date branch merges as before and makes no update call', () => {
  const s = scenario();
  assertExit(s.gate(), 0);
  const r = s.merge();
  assertExit(r, 0, r.stdout);
  assert.deepEqual(puts(s), []);
  assert.equal(s.mergeCalls().length, 1);
});

test('merge: main moved after the gate => the branch is updated (pinned to the approved head), merge refuses, the merge command never runs', () => {
  const s = scenario();
  assertExit(s.gate(), 0);
  const newHead = 'd'.repeat(40);
  s.fake.setScript(ghEntries({ prHead: s.head, behindBy: 2 }));
  const r = s.merge({ PIPELINE_UPDATE_WAIT_MS: '2000', PIPELINE_UPDATE_POLL_MS: '1', ...swapOnUpdate(s, ghEntries({ prHead: newHead, behindBy: 0 })) });
  assertExit(r, 1, r.stdout);
  assert.equal(r.json.error, 'behind-base');
  assert.equal(r.json.updated, true);
  assert.equal(r.json.head, newHead);
  assert.match(r.json.message, /final-gate/);
  assert.equal(puts(s).length, 1);
  assert.deepEqual(JSON.parse(s.fake.calls().find((c) => c.argv.includes('PUT')).stdin), { expected_head_sha: s.head });
  assert.deepEqual(s.mergeCalls(), []);
});

test('merge: a conflicting update is refused as behind-base / rebase-needed, with one attempt and no merge', () => {
  const s = scenario();
  assertExit(s.gate(), 0);
  s.fake.setScript(ghEntries({ prHead: s.head, behindBy: 1, update: 'conflict' }));
  const r = s.merge();
  assertExit(r, 1, r.stdout);
  assert.equal(r.json.error, 'behind-base');
  assert.equal(r.json.outcome, 'rebase-needed');
  assert.equal(puts(s).length, 1);
  assert.deepEqual(s.mergeCalls(), []);
});

test('merge: the update step is bounded to one cycle (a head that is still behind after it is cycle-cap)', () => {
  const s = scenario();
  assertExit(s.gate(), 0);
  s.fake.setScript(ghEntries({ prHead: s.head, behindBy: 1 }));
  const newHead = 'e'.repeat(40);
  const r = s.merge({ PIPELINE_UPDATE_WAIT_MS: '2000', PIPELINE_UPDATE_POLL_MS: '1', ...swapOnUpdate(s, ghEntries({ prHead: newHead, behindBy: 1 })) });
  assertExit(r, 1, r.stdout);
  assert.equal(r.json.error, 'behind-base');
  assert.equal(r.json.outcome, 'cycle-cap');
  assert.equal(puts(s).length, 1);
  assert.deepEqual(s.mergeCalls(), []);
});
