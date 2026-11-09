// `pipeline merge-hold --pr N [--check | --release --reason <code>]` through the real CLI against a fake hold provider script
// (test/helpers/merge-hold-env.mjs). It never merges and runs only the repo's own three hold commands.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BASE_SHA, cli, ghEntries, scenario, PR } from './helpers/gate-env.mjs';
import { assertExit } from './helpers/assert-exit.mjs';
import { RELEASE_REASONS, recordSuccessor } from '../pipeline/lib/merge-hold.mjs';
import { answer, blocker, holdCalls, holdFiles, holdYml, seq } from './helpers/merge-hold-env.mjs';

const world = (opts = {}) => scenario({ yml: holdYml(), baseFiles: holdFiles, report: null, state: null, ...opts });
const hold = (s, args, env = {}) => cli(['merge-hold', '--pr', String(PR), ...args], { dir: s.repo.dir, fake: s.fake, env });

test('merge-hold is a registered command with a usage text that names its three forms', () => {
  const s = world();
  const r = cli(['merge-hold', '--help'], { dir: s.repo.dir, fake: s.fake });
  assertExit(r, 0);
  assert.match(r.json.usage, /merge-hold --pr N --check/);
  assert.match(r.json.usage, /--release --reason <new-commits\|parked\|owner-declined\|handoff-withdrawn\|ci-failed\|update-conflict\|queued-behind\|hold-unreadable>/);
  assert.match(r.json.usage, /merge-hold --pr N --check --wait \[--max-minutes M=120\]/);
  assert.match(r.json.usage, /kept:true, why:'own-successor'/);
  const list = cli(['--help'], { dir: s.repo.dir, fake: s.fake });
  assert.ok(list.json.commands.includes('merge-hold'));
  assert.ok(list.json.summaries['merge-hold'].length > 0);
});

test('take: provider exit 0 / 1 / 2 map to confirmed (exit 0) / NOT confirmed (exit 1) / error (exit 2), with the last lines', () => {
  for (const [code, want, confirmed] of [['0', 0, true], ['1', 1, false], ['2', 2, false], ['7', 2, false]]) {
    const s = world();
    const r = hold(s, [], { FAKE_HOLD_TAKE_EXIT: code });
    assertExit(r, want, r.stdout);
    assert.equal(r.json.ok, confirmed, code);
    assert.equal(r.json.configured, true);
    assert.equal(r.json.confirmed, confirmed);
    assert.equal(r.json.code, Number(code));
    assert.deepEqual(r.json.lines, ['hold taken']);
    assert.deepEqual(holdCalls(s), [`take ${PR}`], 'only PR N, only the take command');
  }
});

test('not configured: every form is exit 0 { ok:true, configured:false } and runs nothing', () => {
  const s = scenario({ baseFiles: holdFiles, report: null, state: null });
  for (const args of [[], ['--check'], ['--check', '--wait'], ['--release', '--reason', 'parked'], ['--release', '--reason', 'new-commits']]) {
    const r = hold(s, args, { FAKE_HOLD_TAKE_EXIT: '1', FAKE_HOLD_CHECK_EXIT: '1' });
    assertExit(r, 0, r.stdout);
    assert.deepEqual(r.json, { ok: true, configured: false });
  }
  assert.deepEqual(holdCalls(s), []);
  assert.deepEqual(s.fake.calls(), [], 'not configured: no GitHub read either, not even for new-commits');
});

test('--check: clear -> exit 0; a hold ahead -> exit 1 queued-behind with the details; unreadable -> exit 1 hold-unreadable; read-only', () => {
  const s = world();
  const clear = hold(s, ['--check'], { FAKE_HOLD_CHECK_SEQ: seq(answer(PR, [])) });
  assertExit(clear, 0, clear.stdout);
  assert.deepEqual(clear.json, { ok: true, configured: true, readable: true, blockedBy: [] });

  const held = hold(s, ['--check'], { FAKE_HOLD_CHECK_SEQ: seq(answer(PR, [blocker(1400)])) });
  assertExit(held, 1, held.stdout);
  assert.equal(held.json.ok, false);
  assert.equal(held.json.error, 'queued-behind');
  assert.equal(held.json.readable, true);
  assert.deepEqual(held.json.blockedBy, [1400]);
  assert.equal(held.json.holds[0].expires, '2026-11-05T07:35:00.000Z');
  assert.equal(held.json.doNotUpdate, true);
  assert.match(held.json.reason, /15:35 PHT/);

  const bad = hold(s, ['--check'], { FAKE_HOLD_CHECK_SEQ: seq('nope') });
  assertExit(bad, 1, bad.stdout);
  assert.equal(bad.json.error, 'hold-unreadable');
  assert.equal(bad.json.readable, false);
  assert.deepEqual(bad.json.blockedBy, []);

  assert.deepEqual(holdCalls(s), [`check ${PR}`, `check ${PR}`, `check ${PR}`], 'only the check command ever ran');
});

test('--release with each reason code runs the release command with that code\'s fixed sentence as ONE argument', () => {
  for (const code of Object.keys(RELEASE_REASONS)) {
    const s = world();
    const r = hold(s, ['--release', '--reason', code]);
    assertExit(r, 0, r.stdout);
    assert.deepEqual([r.json.ok, r.json.configured, r.json.confirmed, r.json.code], [true, true, true, 0]);
    assert.deepEqual(holdCalls(s), [`release ${PR} ${RELEASE_REASONS[code]}`]);
  }
  const s = world();
  const refused = hold(s, ['--release', '--reason', 'parked'], { FAKE_HOLD_RELEASE_EXIT: '1' });
  assertExit(refused, 1);
  assert.equal(refused.json.confirmed, false);
});

test('usage errors (exit 2, nothing run): unknown reason code, free text, missing reason, --reason without --release, --check with --release, no --pr', () => {
  const s = world();
  const bad = (args, pattern) => {
    const r = cli(['merge-hold', ...args], { dir: s.repo.dir, fake: s.fake });
    assertExit(r, 2, r.stdout);
    assert.equal(r.json.error, 'usage');
    assert.match(r.json.message, pattern);
  };
  bad(['--pr', '12', '--release', '--reason', 'because'], /must be one of new-commits, parked, owner-declined, handoff-withdrawn, ci-failed, update-conflict, queued-behind, hold-unreadable/);
  bad(['--pr', '12', '--wait'], /--wait belongs to --check/);
  bad(['--pr', '12', '--release', '--reason', 'parked', '--wait'], /--wait belongs to --check/);
  bad(['--pr', '12', '--max-minutes', '10'], /--max-minutes belongs to --check --wait/);
  bad(['--pr', '12', '--check', '--max-minutes', '10'], /--max-minutes belongs to --check --wait/);
  for (const m of ['4', '241', '0', '-5', 'abc', '12.5']) bad(['--pr', '12', '--check', '--wait', `--max-minutes=${m}`], /--max-minutes must be an integer in 5\.\.240/);
  bad(['--pr', '12', '--release', '--reason', 'parked; echo pwned'], /must be one of/);
  bad(['--pr', '12', '--release'], /needs --reason/);
  bad(['--pr', '12', '--reason', 'parked'], /belongs to --release/);
  bad(['--pr', '12', '--check', '--release', '--reason', 'parked'], /cannot be combined/);
  bad(['--pr', '0'], /--pr/);
  bad(['--check'], /missing --pr/);
  bad(['--pr', '12', '--sha', 'abc'], /sha/);
  assert.deepEqual(holdCalls(s), []);
});

test('it never merges: no gh call is made by any form', () => {
  const s = world();
  hold(s, []);
  hold(s, ['--check'], { FAKE_HOLD_CHECK_SEQ: seq(answer(PR, [])) });
  hold(s, ['--release', '--reason', 'owner-declined']);
  assert.deepEqual(s.fake.calls(), []);
  assert.deepEqual(s.mergeCalls(), []);
});

// ---- --release --reason new-commits keeps the hold on the pipeline's own successor head ------------------------------------------------------------

const sha = (c) => c.repeat(40);
const FROM = sha('1');
const OWN = sha('2');
// The fake gh answers `pr view 12 --json headRefOid` with `head` and the parents of each commit named in `parents`; `headFails` = that read errors.
const headScript = (head, parents = {}, headFails = false) => ghEntries({
  prHead: head, commitParents: parents,
  extra: [headFails ? { match: '^pr view 12 --json headRefOid$', code: 1, stderr: 'gh: Server Error (HTTP 502)' } : { match: '^pr view 12 --json headRefOid$', stdoutJson: { headRefOid: head } }],
});
const release = (s, reason = 'new-commits', env = {}) => hold(s, ['--release', '--reason', reason], env);
const released = (s) => holdCalls(s).filter((l) => l.startsWith('release'));

test('new-commits on a head the pipeline recorded as its own successor (parents [from, base] on GitHub): kept, NOTHING is run', () => {
  const s = world();
  recordSuccessor(s.repo.dir, PR, { from: FROM, to: OWN, baseSha: BASE_SHA });
  s.fake.setScript(headScript(OWN, { [OWN]: [FROM, BASE_SHA] }));
  const r = release(s);
  assertExit(r, 0, r.stdout);
  assert.deepEqual(r.json, { ok: true, configured: true, kept: true, why: 'own-successor', head: OWN });
  assert.deepEqual(holdCalls(s), [], 'no release command ran');
});

test('new-commits on a PR-side head releases as before: no record, parents that are not [from, base], a record for another head', () => {
  const cases = {
    'unrecorded head': (s) => s.fake.setScript(headScript(sha('3'), { [sha('3')]: [FROM, BASE_SHA] })),
    'recorded head whose parents GitHub shows differently': (s) => {
      recordSuccessor(s.repo.dir, PR, { from: FROM, to: OWN, baseSha: BASE_SHA });
      s.fake.setScript(headScript(OWN, { [OWN]: [FROM, sha('4')] }));
    },
    'recorded head that gained a third parent / lost one': (s) => {
      recordSuccessor(s.repo.dir, PR, { from: FROM, to: OWN, baseSha: BASE_SHA });
      s.fake.setScript(headScript(OWN, { [OWN]: [FROM] }));
    },
    'record exists for the OLD successor, the head moved on': (s) => {
      recordSuccessor(s.repo.dir, PR, { from: FROM, to: OWN, baseSha: BASE_SHA });
      s.fake.setScript(headScript(sha('5'), { [sha('5')]: [OWN] }));
    },
  };
  for (const [name, arrange] of Object.entries(cases)) {
    const s = world();
    arrange(s);
    const r = release(s);
    assertExit(r, 0, name);
    assert.equal(r.json.confirmed, true, name);
    assert.equal('kept' in r.json, false, name);
    assert.equal(released(s).length, 1, name);
    assert.match(released(s)[0], new RegExp(`^release ${PR} ${RELEASE_REASONS['new-commits'].slice(0, 20)}`), name);
  }
});

test('new-commits when the PR head cannot be read: the release runs (safe direction) and a warning says why', () => {
  const s = world();
  recordSuccessor(s.repo.dir, PR, { from: FROM, to: OWN, baseSha: BASE_SHA });
  s.fake.setScript(headScript(OWN, { [OWN]: [FROM, BASE_SHA] }, true));
  const r = release(s);
  assertExit(r, 0, r.stdout);
  assert.equal(r.json.confirmed, true);
  assert.equal(released(s).length, 1);
  assert.equal(r.json.warnings.length, 1);
  assert.match(r.json.warnings[0], /PR head could not be read/);
});

test('new-commits when the parents cannot be read: the release runs', () => {
  const s = world();
  recordSuccessor(s.repo.dir, PR, { from: FROM, to: OWN, baseSha: BASE_SHA });
  s.fake.setScript(headScript(OWN, {}));
  const r = release(s);
  assertExit(r, 0, r.stdout);
  assert.equal(released(s).length, 1);
});

test('every other reason releases unconditionally and never reads the PR head, even on a recorded successor', () => {
  for (const reason of Object.keys(RELEASE_REASONS).filter((c) => c !== 'new-commits')) {
    const s = world();
    recordSuccessor(s.repo.dir, PR, { from: FROM, to: OWN, baseSha: BASE_SHA });
    s.fake.setScript(headScript(OWN, { [OWN]: [FROM, BASE_SHA] }));
    const r = release(s, reason);
    assertExit(r, 0, reason);
    assert.equal('kept' in r.json, false, reason);
    assert.equal(released(s).length, 1, reason);
    assert.deepEqual(s.fake.calls(), [], `${reason}: no GitHub read`);
  }
});

// ---- --check --wait ---------------------------------------------------------------------------------------------------------------------------

test('--check --wait, nothing ahead at the first poll: exit 0 outcome front after ONE check (a real 5 min poll is covered by the lib tests)', () => {
  for (const extra of [[], ['--max-minutes', '5'], ['--max-minutes', '240']]) {
    const s = world();
    const r = hold(s, ['--check', '--wait', ...extra], { FAKE_HOLD_CHECK_SEQ: seq(answer(PR, [])) });
    assertExit(r, 0, r.stdout);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.configured, true);
    assert.equal(r.json.outcome, 'front');
    assert.equal(r.json.polls, 1);
    assert.deepEqual(r.json.blockedBy, []);
    assert.equal(typeof r.json.waitedMinutes, 'number');
    assert.ok(r.json.waitedMinutes < 1);
    assert.equal('reason' in r.json, false);
    assert.deepEqual(holdCalls(s), [`check ${PR}`]);
  }
});

test('--check --wait, still queued when the next poll could not start by the deadline (--max-minutes 5): exit 1 timeout with blockedBy, holds and the reason; read-only', () => {
  const s = world();
  const r = hold(s, ['--check', '--wait', '--max-minutes', '5'], { FAKE_HOLD_CHECK_SEQ: seq(answer(PR, [blocker(1400)])) });
  assertExit(r, 1, r.stdout);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.outcome, 'timeout');
  assert.equal(r.json.polls, 1);
  assert.deepEqual(r.json.blockedBy, [1400]);
  assert.equal(r.json.holds[0].number, 1400);
  assert.match(r.json.reason, /queued behind #1400/);
  assert.deepEqual(holdCalls(s), [`check ${PR}`], 'only the check ran');
});

test('--check --wait, an unreadable answer that cannot be retried in time: exit 1 (timeout, reason says unreadable), blockedBy empty', () => {
  const s = world();
  const r = hold(s, ['--check', '--wait', '--max-minutes', '5'], { FAKE_HOLD_CHECK_SEQ: seq('nope') });
  assertExit(r, 1, r.stdout);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.outcome, 'timeout');
  assert.deepEqual(r.json.blockedBy, []);
  assert.match(r.json.reason, /could not be read/);
});

// A hold command that could not be started (ENOENT, bad cwd) is the command going wrong (exit 2, notStarted:true), not the provider
// refusing (exit 1) (issue #194). Run in-process so the shell can be replaced.
test('take / release: a command that could not be started is exit 2 with notStarted:true; a real child exit 1 is still exit 1', async () => {
  const { run: holdRun } = await import('../pipeline/commands/merge-hold.mjs');
  const s = world();
  const boom = async () => { throw new Error('spawn /bin/sh ENOENT'); };
  for (const extra of [[], ['--release', '--reason', 'parked']]) {
    const ctx = { cwd: s.repo.dir, env: {}, runHold: boom };
    const r = await holdRun(['--pr', String(PR), '--repo', s.repo.dir, ...extra], ctx);
    assert.equal(r.exitCode, 2, extra.join(' '));
    assert.equal(r.output.ok, false);
    assert.equal(r.output.confirmed, false);
    assert.equal(r.output.code, null);
    assert.equal(r.output.notStarted, true);
    assert.match(r.output.lines.join(' '), /could not be started/);
    const refused = await holdRun(['--pr', String(PR), '--repo', s.repo.dir, ...extra], { cwd: s.repo.dir, env: {}, runHold: async () => ({ code: 1, stdout: 'refused\n', stderr: '' }) });
    assert.equal(refused.exitCode, 1, extra.join(' '));
    assert.equal('notStarted' in refused.output, false);
  }
});
