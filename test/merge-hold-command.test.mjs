// `pipeline merge-hold --pr N [--check | --release --reason <code>]` through the real CLI against a fake hold provider script
// (test/helpers/merge-hold-env.mjs). It never merges and runs only the repo's own three hold commands.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cli, scenario, PR } from './helpers/gate-env.mjs';
import { assertExit } from './helpers/assert-exit.mjs';
import { RELEASE_REASONS } from '../pipeline/lib/merge-hold.mjs';
import { answer, blocker, holdCalls, holdFiles, holdYml, seq } from './helpers/merge-hold-env.mjs';

const world = (opts = {}) => scenario({ yml: holdYml(), baseFiles: holdFiles, report: null, state: null, ...opts });
const hold = (s, args, env = {}) => cli(['merge-hold', '--pr', String(PR), ...args], { dir: s.repo.dir, fake: s.fake, env });

test('merge-hold is a registered command with a usage text that names its three forms', () => {
  const s = world();
  const r = cli(['merge-hold', '--help'], { dir: s.repo.dir, fake: s.fake });
  assertExit(r, 0);
  assert.match(r.json.usage, /merge-hold --pr N --check/);
  assert.match(r.json.usage, /--release --reason <new-commits\|parked\|owner-declined\|handoff-withdrawn>/);
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
  for (const args of [[], ['--check'], ['--release', '--reason', 'parked']]) {
    const r = hold(s, args, { FAKE_HOLD_TAKE_EXIT: '1', FAKE_HOLD_CHECK_EXIT: '1' });
    assertExit(r, 0, r.stdout);
    assert.deepEqual(r.json, { ok: true, configured: false });
  }
  assert.deepEqual(holdCalls(s), []);
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
  bad(['--pr', '12', '--release', '--reason', 'because'], /must be one of new-commits, parked, owner-declined, handoff-withdrawn/);
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
