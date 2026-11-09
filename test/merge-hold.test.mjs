// The merge-hold seam (plan 2026-11-05-merge-hold-queue): its three config keys, the library that runs them and reads their answers
// (with an injected shell, nothing spawned), and bringUpToDate's beforeUpdate callback. The commands that use it are in
// merge-hold-merge.test.mjs and merge-hold-command.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULTS, loadConfig, validateConfig } from '../pipeline/lib/config.mjs';
import {
  HOLD_POLL_MS, HOLD_QUEUED_BEHIND, HOLD_TIMEOUT_MS, RELEASE_REASONS, checkHolds, holdBeforeUpdate, holdGate, holdGateFrom, holdsConfigured, ownSuccessor, queuedBehindFrom, queuedBehindRefusal, quoteReason,
  readSuccessor, recordSuccessor, releaseHold, successorDir, takeHold, unreleasedWarning, waitForTurn,
} from '../pipeline/lib/merge-hold.mjs';
import { quarantineReviewDir } from '../pipeline/lib/review-context.mjs';
import { createTmpRepo } from './helpers/tmprepo.mjs';
import { bringUpToDate } from '../pipeline/lib/updatebranch.mjs';
import { EW_QUEUED_LINE } from './helpers/merge-hold-env.mjs';

const minimal = () => ({ version: 1, project: 'p', verify: { full: 'f', quick: 'q' } });
const has = (r, text) => r.errors.some((e) => e.includes(text));
const HOLD = { hold_command: 'npm run merge-hold -- {pr}', hold_release_command: 'npm run merge-hold -- {pr} --release --reason {reason}', hold_check_command: 'npm run merge-hold -- --status {pr} --json' };
const withMerge = (extra) => validateConfig({ ...minimal(), merge: { ...extra } });

// ---- config ----------------------------------------------------------------------------------------------------------------------

test('config: the three hold keys are accepted together and kept', () => {
  const r = withMerge(HOLD);
  assert.equal(r.ok, true, r.errors.join('; '));
  assert.deepEqual([r.config.merge.hold_command, r.config.merge.hold_release_command, r.config.merge.hold_check_command], [HOLD.hold_command, HOLD.hold_release_command, HOLD.hold_check_command]);
  assert.equal(r.config.merge.command, DEFAULTS.merge.command, 'the other merge keys keep their defaults');
});

test('config: without the keys nothing changes (no default, no error, not configured)', () => {
  const r = validateConfig(minimal());
  assert.equal(r.ok, true);
  assert.deepEqual(Object.keys(r.config.merge).sort(), ['behind_base', 'behind_base_stale_paths', 'command', 'wait_minutes']);
  assert.equal(holdsConfigured(r.config), false);
  assert.equal(holdsConfigured(withMerge(HOLD).config), true);
  assert.equal(withMerge({ wait_minutes: 5 }).ok, true);
});

test('config: a partial set is rejected, whichever key is missing', () => {
  for (const k of Object.keys(HOLD)) {
    const { [k]: _gone, ...rest } = HOLD;
    const r = withMerge(rest);
    assert.equal(r.ok, false, k);
    assert.ok(has(r, 'all three or none') && has(r, `merge.${k}`), `${k}: ${r.errors.join(' | ')}`);
  }
  for (const k of Object.keys(HOLD)) assert.equal(withMerge({ [k]: HOLD[k] }).ok, false, `only ${k}`);
});

test('config: {pr} is required everywhere, {reason} in the release command; {sha} and other placeholders are refused', () => {
  const bad = (patch, text) => {
    const r = withMerge({ ...HOLD, ...patch });
    assert.equal(r.ok, false, JSON.stringify(patch));
    assert.ok(has(r, text), `${JSON.stringify(patch)}: ${r.errors.join(' | ')}`);
  };
  bad({ hold_command: 'npm run merge-hold' }, 'merge.hold_command must contain {pr}');
  bad({ hold_check_command: 'npm run merge-hold -- --status' }, 'merge.hold_check_command must contain {pr}');
  bad({ hold_release_command: 'npm run merge-hold -- {pr} --release' }, 'merge.hold_release_command must contain {reason}');
  bad({ hold_release_command: 'npm run merge-hold -- --release --reason {reason}' }, 'merge.hold_release_command must contain {pr}');
  for (const k of Object.keys(HOLD)) bad({ [k]: `${HOLD[k]} {sha}` }, `merge.${k} must not contain {sha}`);
  bad({ hold_command: 'npm run merge-hold -- {pr} {reason}' }, 'merge.hold_command must not contain {reason}');
  bad({ hold_check_command: 'npm run merge-hold -- {pr} {who}' }, 'merge.hold_check_command must not contain {who}');
  assert.equal(withMerge({ ...HOLD, hold_command: 'echo ${HOME} {pr}' }).ok, true, 'a shell ${VAR} is not a placeholder');
});

test('config: an empty or non-string value is rejected', () => {
  for (const bad of ['', '   ', 5, null, ['x {pr}'], { a: 1 }]) {
    for (const k of Object.keys(HOLD)) {
      const r = withMerge({ ...HOLD, [k]: bad });
      assert.equal(r.ok, false, `${k}=${JSON.stringify(bad)}`);
      assert.ok(has(r, `merge.${k}`), r.errors.join(' | '));
    }
  }
});

test('config: the check command must differ from the take and release commands (a copied writing command would write on every dry run)', () => {
  const same = withMerge({ ...HOLD, hold_check_command: HOLD.hold_command });
  assert.equal(same.ok, false);
  assert.ok(has(same, 'hold_check_command must differ from merge.hold_command'), same.errors.join(' | '));
  const sameRelease = withMerge({ ...HOLD, hold_check_command: `  ${HOLD.hold_release_command}  ` });
  assert.equal(sameRelease.ok, false);
  assert.ok(has(sameRelease, 'hold_check_command must differ from merge.hold_release_command'), sameRelease.errors.join(' | '));
});

test('config: an unknown merge key is still rejected', () => {
  const r = withMerge({ ...HOLD, hold_chek_command: 'x {pr}' });
  assert.equal(r.ok, false);
  assert.ok(has(r, 'unknown key: merge.hold_chek_command'), r.errors.join(' | '));
});

test('config: loadConfig reads the keys from .claude/pipeline.yml', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'cp-hold-cfg-'));
  try {
    mkdirSync(join(dir, '.claude'));
    writeFileSync(join(dir, '.claude', 'pipeline.yml'), `version: 1\nproject: p\nverify:\n  full: f\n  quick: q\nmerge:\n  hold_command: ${HOLD.hold_command}\n  hold_release_command: ${HOLD.hold_release_command}\n  hold_check_command: ${HOLD.hold_check_command}\n`);
    const r = await loadConfig(dir);
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.equal(r.config.merge.hold_check_command, HOLD.hold_check_command);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- library: the check ----------------------------------------------------------------------------------------------------------

const CONFIG = withMerge(HOLD).config;
const PR = 12;
const ran = (stdout, extra = {}) => async () => ({ code: 0, stdout, stderr: '', timedOut: false, ...extra });
const check = (run, pr = PR) => checkHolds({ config: CONFIG, pr, root: '/repo', env: {}, run });
const json = (o) => JSON.stringify(o);

test('checkHolds: not configured -> { configured:false } and nothing is run', async () => {
  let calls = 0;
  const r = await checkHolds({ config: validateConfig(minimal()).config, pr: PR, root: '/repo', env: {}, run: async () => { calls += 1; } });
  assert.deepEqual(r, { configured: false });
  assert.equal(calls, 0);
});

test('checkHolds: a banner followed by a JSON last line parses; the command is filled with the PR, the repo is its cwd, the wait is 5 minutes', async () => {
  const seen = [];
  const out = `merge-hold: reading labels\nretrying after a rate limit\n${json({ pr: PR, blockedBy: [{ number: 1400, title: 'Roster card', since: '2026-11-05T06:05:00.000Z', expires: '2026-11-05T07:35:00.000Z' }, { number: 1401 }] })}\n\n`;
  const r = await check(async (cmd, opts) => { seen.push([cmd, opts]); return { code: 0, stdout: out, stderr: 'warn on stderr\n' }; });
  assert.deepEqual(r, {
    configured: true, ok: true,
    blockedBy: [{ number: 1400, title: 'Roster card', since: '2026-11-05T06:05:00.000Z', expires: '2026-11-05T07:35:00.000Z' }, { number: 1401, title: null, since: null, expires: null }],
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0][0], 'npm run merge-hold -- --status 12 --json');
  assert.equal(seen[0][1].cwd, '/repo');
  assert.equal(seen[0][1].timeoutMs, HOLD_TIMEOUT_MS);
  assert.equal(HOLD_TIMEOUT_MS, 5 * 60_000);
});

test('checkHolds: an empty blockedBy is readable and clear', async () => {
  assert.deepEqual(await check(ran(json({ pr: PR, blockedBy: [] }))), { configured: true, ok: true, blockedBy: [] });
});

test('checkHolds: every unreadable answer is ok:false with a reason (never "no holds")', async () => {
  const cases = {
    'non-zero exit': ran(json({ pr: PR, blockedBy: [] }), { code: 1 }),
    'killed (exit 2)': ran('', { code: 2 }),
    timeout: ran(json({ pr: PR, blockedBy: [] }), { code: 0, timedOut: true }),
    'nothing printed': ran('\n\n'),
    'invalid json': ran('{"pr":12,'),
    'banner only': ran('merge-hold: reading labels'),
    null: ran('null'),
    array: ran('[]'),
    string: ran('"ok"'),
    'pr missing': ran(json({ blockedBy: [] })),
    'pr is another PR': ran(json({ pr: 13, blockedBy: [] })),
    'pr is a string': ran(json({ pr: '12', blockedBy: [] })),
    'blockedBy missing': ran(json({ pr: PR })),
    'blockedBy is an object': ran(json({ pr: PR, blockedBy: {} })),
    'entry is a number': ran(json({ pr: PR, blockedBy: [1400] })),
    'entry is null': ran(json({ pr: PR, blockedBy: [null] })),
    'entry is an array': ran(json({ pr: PR, blockedBy: [[1400]] })),
    'number missing': ran(json({ pr: PR, blockedBy: [{ title: 'x' }] })),
    'number is zero': ran(json({ pr: PR, blockedBy: [{ number: 0 }] })),
    'number is negative': ran(json({ pr: PR, blockedBy: [{ number: -3 }] })),
    'number is a fraction': ran(json({ pr: PR, blockedBy: [{ number: 1.5 }] })),
    'number is a string': ran(json({ pr: PR, blockedBy: [{ number: '1400' }] })),
    'number is unsafe': ran('{"pr":12,"blockedBy":[{"number":9007199254740993}]}'),
    'number is the PR itself': ran(json({ pr: PR, blockedBy: [{ number: PR }] })),
    'one bad entry among good ones': ran(json({ pr: PR, blockedBy: [{ number: 1400 }, { number: 'x' }] })),
    'title is a number': ran(json({ pr: PR, blockedBy: [{ number: 1400, title: 5 }] })),
    'expires is an object': ran(json({ pr: PR, blockedBy: [{ number: 1400, expires: {} }] })),
    'could not start': async () => { throw new Error('spawn ENOENT'); },
  };
  for (const [name, run] of Object.entries(cases)) {
    const r = await check(run);
    assert.equal(r.configured, true, name);
    assert.equal(r.ok, false, name);
    assert.ok(typeof r.why === 'string' && r.why.length > 0, name);
    assert.equal('blockedBy' in r, false, `${name}: an unreadable answer carries no blockers to trust`);
  }
});

test('checkHolds: only the LAST non-empty line counts (an earlier JSON line is a banner, not the answer)', async () => {
  const r = await check(ran(`${json({ pr: PR, blockedBy: [{ number: 1400 }] })}\n${json({ pr: PR, blockedBy: [] })}\n`));
  assert.deepEqual(r, { configured: true, ok: true, blockedBy: [] });
  const bad = await check(ran(`${json({ pr: PR, blockedBy: [] })}\nplease wait\n`));
  assert.equal(bad.ok, false);
});

// ---- library: take, release, gate ------------------------------------------------------------------------------------------------

test('takeHold / releaseHold: not configured is { configured:false } and runs nothing', async () => {
  const cfg = validateConfig(minimal()).config;
  const run = async () => assert.fail('must not run');
  assert.deepEqual(await takeHold({ config: cfg, pr: PR, root: '/r', env: {}, run }), { configured: false });
  assert.deepEqual(await releaseHold({ config: cfg, pr: PR, reason: 'parked', root: '/r', env: {}, run }), { configured: false });
});

test('takeHold: confirmed only on exit 0; reports the exit code and the last 5 lines of its output', async () => {
  const seen = [];
  const out = Array.from({ length: 9 }, (_, i) => `line ${i + 1}`).join('\n');
  const take = (result) => takeHold({ config: CONFIG, pr: PR, root: '/r', env: {}, run: async (cmd) => { seen.push(cmd); return result; } });
  const ok = await take({ code: 0, stdout: `${out}\n`, stderr: 'late stderr\n', timedOut: false });
  assert.deepEqual([ok.configured, ok.confirmed, ok.code], [true, true, 0]);
  assert.deepEqual(ok.lines, ['line 6', 'line 7', 'line 8', 'line 9', 'late stderr']);
  assert.equal(seen[0], 'npm run merge-hold -- 12');
  assert.deepEqual([await take({ code: 1, stdout: 'refused\n', stderr: '' })].map((r) => [r.confirmed, r.code]), [[false, 1]]);
  assert.deepEqual([await take({ code: 2, stdout: '', stderr: 'boom' })].map((r) => [r.confirmed, r.code]), [[false, 2]]);
  const timed = await take({ code: 0, stdout: '', stderr: '', timedOut: true });
  assert.equal(timed.confirmed, false, 'a timeout is never a confirmation, even with exit 0');
});

test('releaseHold: the reason is a fixed sentence, shell-quoted; an unknown code throws before anything runs', async () => {
  const seen = [];
  for (const reason of Object.keys(RELEASE_REASONS)) {
    const r = await releaseHold({ config: CONFIG, pr: PR, reason, root: '/r', env: {}, run: async (cmd) => { seen.push(cmd); return { code: 0, stdout: 'ok', stderr: '' }; } });
    assert.equal(r.confirmed, true);
  }
  assert.equal(seen.length, Object.keys(RELEASE_REASONS).length);
  for (const [i, reason] of Object.keys(RELEASE_REASONS).entries()) {
    assert.equal(seen[i], `npm run merge-hold -- 12 --release --reason ${quoteReason(RELEASE_REASONS[reason])}`);
    assert.match(seen[i], process.platform === 'win32' ? /--reason "[A-Za-z0-9 ,.-]+"$/ : /--reason '[A-Za-z0-9 ,.-]+'$/, 'quoted for this platform, plain words only');
  }
  assert.deepEqual(Object.keys(RELEASE_REASONS), ['new-commits', 'parked', 'owner-declined', 'handoff-withdrawn', 'ci-failed', 'update-conflict', 'queued-behind', 'hold-unreadable']);
  for (const code of ['ci-failed', 'update-conflict', 'queued-behind', 'hold-unreadable']) assert.match(RELEASE_REASONS[code], /^[A-Za-z0-9 ,.]+$/, `${code}: letters, digits, spaces, commas and full stops only`);
  await assert.rejects(releaseHold({ config: CONFIG, pr: PR, reason: 'x; rm -rf /', root: '/r', env: {}, run: async () => assert.fail('must not run') }), /unknown release reason/);
  assert.equal(quoteReason("it's", 'linux'), "'it'\\''s'");
  assert.equal(quoteReason('plain words', 'win32'), '"plain words"');
});

test('holdGate: null when clear or not configured; queued-behind names #A, its title and its expiry in PHT; unreadable is its own refusal', async () => {
  assert.equal(await holdGate({ config: validateConfig(minimal()).config, pr: PR, root: '/r', env: {}, run: async () => assert.fail('no run') }), null);
  assert.equal(await holdGate({ config: CONFIG, pr: PR, root: '/r', env: {}, run: ran(json({ pr: PR, blockedBy: [] })) }), null);

  const held = await holdGate({ config: CONFIG, pr: PR, root: '/r', env: {}, run: ran(json({ pr: PR, blockedBy: [{ number: 1400, title: 'Roster card', since: '2026-11-05T06:05:00.000Z', expires: '2026-11-05T07:35:00.000Z' }, { number: 1450 }] })) });
  assert.equal(held.error, 'queued-behind');
  assert.equal(held.verdict, HOLD_QUEUED_BEHIND);
  assert.deepEqual(held.blockedBy, [1400, 1450]);
  assert.equal(held.doNotUpdate, true);
  assert.equal(held.holds[0].title, 'Roster card');
  assert.match(held.reason, /#1400 "Roster card"/);
  assert.match(held.reason, /15:35 PHT/, '07:35Z is 15:35 in Manila');
  assert.match(held.reason, /#1450 \(hold expiry unknown\)/);
  assert.match(held.reason, /do NOT update this branch/);

  const unreadable = await holdGate({ config: CONFIG, pr: PR, root: '/r', env: {}, run: ran('nope') });
  assert.equal(unreadable.error, 'hold-unreadable');
  assert.match(unreadable.reason, /could not be read/);
  assert.equal('doNotUpdate' in unreadable, false);
  assert.equal(holdGateFrom({ configured: false }), null);
});

// ---- library: reading a merge command's output -----------------------------------------------------------------------------------

test('queuedBehindFrom: EagleWatch\'s exact line (stderr text) names the PR ahead', () => {
  assert.equal(HOLD_QUEUED_BEHIND, 'hold:queued-behind');
  assert.deepEqual(queuedBehindFrom(`${EW_QUEUED_LINE}\n`), { prs: [1400] });
  // the pinned prefix of the producer's format
  assert.ok(EW_QUEUED_LINE.startsWith('hold:queued-behind  queued behind #1400 — do NOT update this branch until #1400 merges'));
});

test('queuedBehindFrom: the line is found after 40 other lines (the display tail is 30)', () => {
  const noise = Array.from({ length: 40 }, (_, i) => `noise ${i}`).join('\n');
  assert.deepEqual(queuedBehindFrom(`${EW_QUEUED_LINE}\n${noise}`), { prs: [1400] });
  assert.deepEqual(queuedBehindFrom(`${noise}\n${EW_QUEUED_LINE}\n${noise}`), { prs: [1400] });
});

test('queuedBehindFrom: two PRs in order, a repeated PR once, a title containing #N is not a PR ahead', () => {
  const two = `${EW_QUEUED_LINE}\n${EW_QUEUED_LINE.replaceAll('1400', '1500')}`;
  assert.deepEqual(queuedBehindFrom(two), { prs: [1400, 1500] });
  assert.deepEqual(queuedBehindFrom(`${EW_QUEUED_LINE}\n${EW_QUEUED_LINE}\n${EW_QUEUED_LINE}`), { prs: [1400] }, '#1400 repeated');
  assert.deepEqual(queuedBehindFrom(EW_QUEUED_LINE.replace('Roster card', 'Fix #5 and #6')), { prs: [1400] });
  assert.deepEqual(queuedBehindFrom('hold:queued-behind queued behind #7 and queued behind #8'), { prs: [7, 8] });
  assert.deepEqual(queuedBehindFrom('hold:queued-behind  PR #9 is ahead'), { prs: [9] }, 'a line without "queued behind" falls back to its first #N');
});

test('queuedBehindFrom: unrelated text gives null; the verdict without a number still counts, with no PRs', () => {
  assert.equal(queuedBehindFrom('merge gate refused: base moved'), null);
  assert.equal(queuedBehindFrom('queued behind #1400 but no verdict word'), null);
  assert.equal(queuedBehindFrom(''), null);
  assert.equal(queuedBehindFrom(undefined), null);
  assert.deepEqual(queuedBehindFrom('hold:queued-behind'), { prs: [] });
  const refusal = queuedBehindRefusal({ prs: [] });
  assert.equal(refusal.doNotUpdate, true);
  assert.match(refusal.reason, /another PR/);
  assert.match(queuedBehindRefusal({ prs: [1400] }).reason, /queued behind #1400/);
});

// ---- bringUpToDate: beforeUpdate ------------------------------------------------------------------------------------------------

const sha = (c) => c.repeat(40);
const A = sha('a');
const B = sha('b');
const BASE = sha('9');
// A tiny GitHub: the head is A, the base moved; each accepted update makes the merge commit [head, base] and the PR is behind again
// while `behind` has entries left.
function world(behind) {
  const w = { head: A, behind: [...behind], puts: [], heads: [B, sha('c'), sha('d')], parents: {}, pending: null };
  w.gh = {
    prView() {
      if (w.pending) { w.head = w.pending; w.pending = null; }
      return { state: 'OPEN', headRefOid: w.head, baseRefName: 'main' };
    },
    compare: () => ({ behindBy: w.behind[0] ?? 0, baseSha: BASE }),
    updateBranch(pr, expected) {
      w.puts.push(expected);
      w.behind.shift();
      const next = w.heads.shift();
      w.parents[next] = [expected, BASE];
      w.pending = next;
      return { result: 'accepted' };
    },
    commitParents: (c) => w.parents[c],
    checks: () => [],
  };
  return w;
}
const timing = { pollMs: 1, headWaitMs: 50, checksWaitMs: 50, now: (() => { let t = 0; return () => t; })(), sleep: async () => {} };
const upToDate = (w, extra) => bringUpToDate({ gh: w.gh, pr: PR, expectHead: A, maxCycles: 3, ...timing, ...extra });
const refusal = (error, extra = {}) => ({ error, reason: `${error} reason`, ...extra });

test('bringUpToDate: without beforeUpdate nothing changes (it updates as before)', async () => {
  const w = world([1, 0]);
  const r = await upToDate(w);
  assert.equal(r.outcome, 'up-to-date');
  assert.equal(r.updated, true);
  assert.deepEqual(w.puts, [A]);
});

test('bringUpToDate: blocked at entry -> zero PUTs, updated:false, the refusal\'s fields on the result', async () => {
  const w = world([2, 1, 0]);
  let calls = 0;
  const r = await upToDate(w, { beforeUpdate: async () => { calls += 1; return refusal('queued-behind', { blockedBy: [1400], doNotUpdate: true, verdict: HOLD_QUEUED_BEHIND }); } });
  assert.equal(r.ok, false);
  assert.equal(r.outcome, 'queued-behind');
  assert.equal(r.updated, false);
  assert.equal(r.cycles, 0);
  assert.equal(r.head, A);
  assert.equal(r.startHead, A);
  assert.deepEqual(r.blockedBy, [1400]);
  assert.equal(r.doNotUpdate, true);
  assert.equal(r.reason, 'queued-behind reason');
  assert.equal(calls, 1);
  assert.deepEqual(w.puts, [], 'not one PUT');
});

test('bringUpToDate: a hold that appears between cycle 1 and cycle 2 -> queued-behind, updated:true, cycles:1, exactly one PUT', async () => {
  const w = world([2, 1, 0]);
  let calls = 0;
  const r = await upToDate(w, { beforeUpdate: () => { calls += 1; return calls === 1 ? null : refusal('queued-behind', { blockedBy: [1400], doNotUpdate: true }); } });
  assert.equal(r.outcome, 'queued-behind');
  assert.equal(r.ok, false);
  assert.equal(r.updated, true);
  assert.equal(r.cycles, 1);
  assert.equal(r.startHead, A);
  assert.equal(r.head, B, 'the head the first update made');
  assert.deepEqual(w.puts, [A], 'exactly one PUT');
  assert.equal(calls, 2, 'asked before each PUT');
});

test('bringUpToDate: an unreadable answer before a later PUT is hold-unreadable; a clear answer every time updates normally and is asked once per PUT', async () => {
  const w = world([2, 1, 0]);
  let calls = 0;
  const r = await upToDate(w, { beforeUpdate: async () => { calls += 1; return calls === 2 ? refusal('hold-unreadable') : null; } });
  assert.equal(r.outcome, 'hold-unreadable');
  assert.equal(r.cycles, 1);
  assert.equal(w.puts.length, 1);

  const w2 = world([2, 1, 0]);
  let asked = 0;
  const done = await upToDate(w2, { beforeUpdate: () => { asked += 1; return null; } });
  assert.equal(done.outcome, 'up-to-date');
  assert.equal(done.cycles, 2);
  assert.equal(asked, 2);
  assert.equal(w2.puts.length, 2);
});

test('bringUpToDate: an up-to-date branch never asks (nothing would be written)', async () => {
  const w = world([0]);
  const r = await upToDate(w, { beforeUpdate: () => assert.fail('no PUT, no question') });
  assert.equal(r.outcome, 'up-to-date');
});

// ---- holdBeforeUpdate: take the hold right before the catch-up PUT -----------------------------------------------------------------------

const CLEAR = json({ pr: PR, blockedBy: [] });
const AHEAD = json({ pr: PR, blockedBy: [{ number: 1400, title: 'Roster card', since: '2026-11-05T06:05:00.000Z', expires: '2026-11-05T07:35:00.000Z' }] });
const taken = (over = {}) => ({ code: 0, stdout: 'hold taken\n', stderr: '', timedOut: false, ...over });
// A shell that tells the check, the take and the release apart by their command text. `checks` is the list of answers to successive
// checks (the last repeats); `log` records the order of everything that ran.
function shell({ checks = [{ stdout: CLEAR }], take = taken() } = {}) {
  const log = [];
  let n = 0;
  const run = async (cmd) => {
    if (cmd.includes('--status')) {
      log.push('check');
      const c = checks[Math.min(n, checks.length - 1)];
      n += 1;
      return { code: 0, stdout: '', stderr: '', timedOut: false, ...c };
    }
    log.push(cmd.includes('--release') ? 'release' : 'take');
    return take;
  };
  return { run, log };
}
const before = (sh) => holdBeforeUpdate({ config: CONFIG, pr: PR, root: '/repo', env: {}, run: sh.run });

test('holdBeforeUpdate: not configured -> no callback and no info', () => {
  assert.deepEqual(holdBeforeUpdate({ config: validateConfig(minimal()).config, pr: PR, root: '/r', env: {}, run: async () => assert.fail('no run') }), { beforeUpdate: null, info: null });
});

test('holdBeforeUpdate: a gate refusal is returned as is and nothing is taken', async () => {
  for (const [name, stdout, error] of [['queued', AHEAD, 'queued-behind'], ['unreadable', 'nope', 'hold-unreadable']]) {
    const sh = shell({ checks: [{ stdout }] });
    const { beforeUpdate, info } = before(sh);
    const r = await beforeUpdate();
    assert.equal(r.error, error, name);
    assert.equal('holdTaken' in r, false, `${name}: nothing was taken, so nothing to report`);
    assert.deepEqual(sh.log, ['check'], name);
    assert.deepEqual(info, { taken: false, tookThisCall: false, mayHold: false, take: null }, name);
  }
});

test('holdBeforeUpdate: clear -> check, take, check again, PUT goes; across 2 cycles the take runs once and every cycle re-checks', async () => {
  const sh = shell();
  const { beforeUpdate, info } = before(sh);
  assert.equal(await beforeUpdate(), null);
  assert.deepEqual(sh.log, ['check', 'take', 'check'], 'the re-check follows the take');
  assert.equal(info.taken, true);
  assert.equal(info.tookThisCall, true);
  assert.deepEqual(info.take, { confirmed: true, code: 0, lines: ['hold taken'] });
  assert.equal(await beforeUpdate(), null);
  assert.deepEqual(sh.log, ['check', 'take', 'check', 'check'], 'cycle 2 only runs the first gate, no second take');
});

// R4-S1 spec change (not a loosening): this test used to assert only the error; a cycle-2 refusal after this call's confirmed take now
// ALSO carries holdTaken true, like the post-take refusal, so the caller can tell a real hold from none.
test('holdBeforeUpdate: cycle 2 refusal after a taken hold is a gate refusal carrying holdTaken (no second take, no re-check)', async () => {
  const sh = shell({ checks: [{ stdout: CLEAR }, { stdout: CLEAR }, { stdout: AHEAD }] });
  const { beforeUpdate } = before(sh);
  assert.equal(await beforeUpdate(), null);
  const r = await beforeUpdate();
  assert.equal(r.error, 'queued-behind');
  assert.equal(r.holdTaken, true);
  assert.deepEqual(sh.log, ['check', 'take', 'check', 'check']);
});

test('holdBeforeUpdate: confirmed take in cycle 1, cycle 2 gate unreadable -> hold-unreadable with holdTaken true (R4-S1)', async () => {
  const sh = shell({ checks: [{ stdout: CLEAR }, { stdout: CLEAR }, { stdout: 'garbage' }] });
  const { beforeUpdate, info } = before(sh);
  assert.equal(await beforeUpdate(), null);
  const r = await beforeUpdate();
  assert.equal(r.error, 'hold-unreadable');
  assert.equal(r.holdTaken, true);
  assert.equal(info.taken, true);
  assert.deepEqual(sh.log, ['check', 'take', 'check', 'check']);
});

test('holdBeforeUpdate: UNconfirmed take (exit 1) in cycle 1, cycle 2 refused -> holdTaken present and false (R4-S1)', async () => {
  const sh = shell({ checks: [{ stdout: CLEAR }, { stdout: CLEAR }, { stdout: AHEAD }], take: taken({ code: 1, stdout: 'refused: draft\n' }) });
  const { beforeUpdate, info } = before(sh);
  assert.equal(await beforeUpdate(), null);
  const r = await beforeUpdate();
  assert.equal(r.error, 'queued-behind');
  assert.equal('holdTaken' in r, true);
  assert.equal(r.holdTaken, false);
  assert.equal(info.mayHold, true);
  assert.deepEqual(sh.log, ['check', 'take', 'check', 'check']);
});

test('holdBeforeUpdate: a take that exits 1 or times out, with a clear re-check, still lets the PUT go (info.taken false, the answer kept)', async () => {
  for (const [name, take, expect] of [
    ['exit 1', taken({ code: 1, stdout: 'refused: draft\n' }), { confirmed: false, code: 1, lines: ['refused: draft'] }],
    ['timeout', taken({ code: 0, stdout: '', timedOut: true }), { confirmed: false, code: 0, lines: [], timedOut: true }],
  ]) {
    const sh = shell({ take });
    const { beforeUpdate, info } = before(sh);
    assert.equal(await beforeUpdate(), null, name);
    assert.deepEqual(sh.log, ['check', 'take', 'check'], name);
    assert.equal(info.taken, false, name);
    assert.equal(info.tookThisCall, true, name);
    assert.deepEqual(info.take, expect, name);
  }
});

test('holdBeforeUpdate: mayHold = the take ran (R2-F1: exit 1 is "refused OR not confirmed", it may follow a written label)', async () => {
  for (const [name, take, expected] of [
    ['exit 0', taken(), true],
    ['exit 1', taken({ code: 1, stdout: 'refused: draft\n' }), true],
    ['exit 1 + timed out', taken({ code: 1, timedOut: true }), true],
    ['exit 0 + timed out', taken({ code: 0, timedOut: true }), true],
    ['exit 2', taken({ code: 2 }), true],
    ['exit 7', taken({ code: 7 }), true],
  ]) {
    const sh = shell({ take });
    const { beforeUpdate, info } = before(sh);
    assert.equal(info.mayHold, false, `${name}: nothing taken yet`);
    assert.equal(await beforeUpdate(), null, name);
    assert.equal(info.mayHold, expected, name);
    assert.equal(info.tookThisCall, true, name);
  }
});

test('holdBeforeUpdate: take ok + re-check blocked -> queued-behind with holdTaken true; take failed + re-check blocked -> holdTaken false', async () => {
  const win = shell({ checks: [{ stdout: CLEAR }, { stdout: AHEAD }] });
  const a = before(win);
  const lost = await a.beforeUpdate();
  assert.equal(lost.error, 'queued-behind');
  assert.deepEqual(lost.blockedBy, [1400]);
  assert.equal(lost.holdTaken, true);
  assert.equal(a.info.taken, true);

  const failed = shell({ checks: [{ stdout: CLEAR }, { stdout: AHEAD }], take: taken({ code: 1 }) });
  const b = before(failed);
  const lost2 = await b.beforeUpdate();
  assert.equal(lost2.error, 'queued-behind');
  assert.equal(lost2.holdTaken, false);
  assert.equal(b.info.tookThisCall, true);
});

test('holdBeforeUpdate: an unreadable re-check -> hold-unreadable with holdTaken (confirmed or not)', async () => {
  // The caller keys on info: a confirmed hold (taken) is kept, any unconfirmed take (exit 1 included, R2-F1) is released (#199).
  for (const [take, expected, mayHold] of [[taken(), true, true], [taken({ code: 1 }), false, true], [taken({ code: 2 }), false, true], [taken({ code: 0, timedOut: true }), false, true]]) {
    const sh = shell({ checks: [{ stdout: CLEAR }, { stdout: 'garbage' }], take });
    const { beforeUpdate, info } = before(sh);
    const r = await beforeUpdate();
    assert.equal(r.error, 'hold-unreadable');
    assert.equal(r.holdTaken, expected);
    assert.equal(info.taken, expected);
    assert.equal(info.mayHold, mayHold);
    assert.equal(info.tookThisCall, true);
  }
});

// ---- the pipeline's own successor heads ----------------------------------------------------------------------------------------------------

const H = (c) => c.repeat(40);
const repoWithCommit = () => {
  const repo = createTmpRepo();
  repo.write('a.txt', 'a');
  repo.commit('init');
  return repo;
};
const triple = { from: H('1'), to: H('2'), baseSha: H('3') };

test('successor record: write/read round trip in a real repo; a linked worktree sees the same record', () => {
  const repo = repoWithCommit();
  recordSuccessor(repo.dir, 12, triple, new Date('2026-11-06T08:00:00.000Z'));
  assert.deepEqual(readSuccessor(repo.dir, 12, triple.to), { ...triple, at: '2026-11-06T08:00:00.000Z' });
  const file = join(successorDir(repo.dir, 12), `${triple.to}.json`);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { version: 1, pr: 12, ...triple, at: '2026-11-06T08:00:00.000Z' });
  assert.ok(file.includes(join('.git', 'pipeline', 'merge-hold', 'pr-12')), file);
  assert.deepEqual(readdirSync(successorDir(repo.dir, 12)), [`${triple.to}.json`], 'no temp file is left behind');

  const wt = `${repo.dir}-wt`;
  repo.git(['worktree', 'add', '-q', '-b', 'other', wt]);
  try {
    assert.deepEqual(readSuccessor(wt, 12, triple.to)?.from, triple.from, "the linked worktree reads the main one's record");
    recordSuccessor(wt, 12, { from: H('4'), to: H('5'), baseSha: H('6') });
    assert.ok(readSuccessor(repo.dir, 12, H('5')), "and the main one reads the worktree's");
  } finally {
    repo.git(['worktree', 'remove', '--force', wt]);
  }
});

test('successor record: two interleaved writers for the same PR both stay readable (one file each, no read-modify-write)', () => {
  const repo = repoWithCommit();
  const one = { from: H('1'), to: H('2'), baseSha: H('3') };
  const two = { from: H('2'), to: H('4'), baseSha: H('5') };
  recordSuccessor(repo.dir, 12, one);
  recordSuccessor(repo.dir, 12, two);
  recordSuccessor(repo.dir, 12, one);
  assert.equal(readSuccessor(repo.dir, 12, one.to).baseSha, one.baseSha);
  assert.equal(readSuccessor(repo.dir, 12, two.to).baseSha, two.baseSha);
  assert.equal(readdirSync(successorDir(repo.dir, 12)).length, 2, 'the same successor twice is one file');
});

test('successor record: invalid input throws before a path is built; corrupt / missing / other-pr / wrong-version / mismatched records read as null', () => {
  const repo = repoWithCommit();
  for (const bad of [{ ...triple, from: 'abc' }, { ...triple, to: '../../x' }, { ...triple, baseSha: H('G') }, { ...triple, to: H('A') }, { ...triple, from: undefined }]) {
    assert.throws(() => recordSuccessor(repo.dir, 12, bad), /40-hex/, JSON.stringify(bad));
  }
  assert.throws(() => recordSuccessor(repo.dir, 0, triple), /not a PR number/);
  assert.throws(() => recordSuccessor(repo.dir, '12; rm', triple), /not a PR number/);
  assert.equal(existsSync(join(repo.dir, '.git', 'pipeline')), false, 'nothing was created for an invalid record');

  recordSuccessor(repo.dir, 12, triple);
  const file = join(successorDir(repo.dir, 12), `${triple.to}.json`);
  const good = JSON.parse(readFileSync(file, 'utf8'));
  assert.ok(readSuccessor(repo.dir, 12, triple.to));
  assert.equal(readSuccessor(repo.dir, 12, H('9')), null, 'head not recorded');
  assert.equal(readSuccessor(repo.dir, 13, triple.to), null, 'other PR (no file)');
  for (const head of ['', 'xyz', H('A'), `../pr-12/${triple.to}`, null, undefined, 5]) assert.equal(readSuccessor(repo.dir, 12, head), null, JSON.stringify(head));
  const put = (v) => writeFileSync(file, typeof v === 'string' ? v : JSON.stringify(v));
  for (const [name, content] of Object.entries({
    corrupt: '{"version":1,',
    'not an object': '[1]',
    'wrong version': { ...good, version: 2 },
    'recorded for another PR': { ...good, pr: 13 },
    'to is another head': { ...good, to: H('7') },
    'from is malformed': { ...good, from: 'nope' },
    'baseSha is missing': { ...good, baseSha: undefined },
  })) {
    put(content);
    assert.equal(readSuccessor(repo.dir, 12, triple.to), null, name);
  }
  assert.equal(readSuccessor('/no/such/dir', 12, triple.to), null, 'not a repo: never throws');
});

test('successor record: a file older than 30 days is pruned on the next write; a recent one and other PRs are kept', () => {
  const repo = repoWithCommit();
  const old = { from: H('1'), to: H('2'), baseSha: H('3') };
  const recent = { from: H('4'), to: H('5'), baseSha: H('6') };
  const now = new Date('2026-11-06T08:00:00.000Z');
  recordSuccessor(repo.dir, 12, old, now);
  recordSuccessor(repo.dir, 12, recent, now);
  recordSuccessor(repo.dir, 13, old, now);
  const age = (pr, to, days) => {
    const t = new Date(now.getTime() - days * 86_400_000);
    utimesSync(join(successorDir(repo.dir, pr), `${to}.json`), t, t);
  };
  age(12, old.to, 31);
  age(12, recent.to, 29);
  age(13, old.to, 40);
  recordSuccessor(repo.dir, 12, { from: H('7'), to: H('8'), baseSha: H('9') }, now);
  assert.equal(readSuccessor(repo.dir, 12, old.to), null, '31 days old: pruned');
  assert.ok(readSuccessor(repo.dir, 12, recent.to), '29 days old: kept');
  assert.ok(readSuccessor(repo.dir, 12, H('8')), 'the new one');
  assert.ok(readSuccessor(repo.dir, 13, old.to), "another PR's directory is not touched");
});

test('successor record (#200): a crashed writer\'s *.tmp older than 1 hour is pruned on the next write; a fresh .tmp and an old-but-under-30-days .json stay', () => {
  const repo = repoWithCommit();
  const now = new Date('2026-11-06T08:00:00.000Z');
  const kept = { from: H('4'), to: H('5'), baseSha: H('6') };
  recordSuccessor(repo.dir, 12, kept, now);
  const dir = successorDir(repo.dir, 12);
  const touch = (name, ageMs) => {
    writeFileSync(join(dir, name), 'x');
    const t = new Date(now.getTime() - ageMs);
    utimesSync(join(dir, name), t, t);
  };
  touch(`${H('a')}.123.abcd1234.tmp`, 2 * 3_600_000); // a crashed write, 2 h old
  touch(`${H('b')}.124.efgh5678.tmp`, 59 * 60_000); // 59 min: could still be a live write
  touch('notes.txt', 90 * 86_400_000); // not ours: never touched
  const aged = new Date(now.getTime() - 10 * 86_400_000);
  utimesSync(join(dir, `${kept.to}.json`), aged, aged); // 10 days: well under the 30-day limit
  recordSuccessor(repo.dir, 12, { from: H('7'), to: H('8'), baseSha: H('9') }, now);
  assert.deepEqual(readdirSync(dir).sort(), [`${H('b')}.124.efgh5678.tmp`, `${H('5')}.json`, `${H('8')}.json`, 'notes.txt'].sort());
});

test('successor record: it survives quarantineReviewDir (state recovery moves the review dir, not the git common dir)', () => {
  const repo = repoWithCommit();
  repo.write('.review/scratch.txt', 'x');
  recordSuccessor(repo.dir, 12, triple);
  quarantineReviewDir(repo.dir);
  assert.equal(existsSync(join(repo.dir, '.review', 'scratch.txt')), false, 'the review dir was quarantined');
  assert.ok(readSuccessor(repo.dir, 12, triple.to), 'the record is still there');
});

test("ownSuccessor: true only when recorded AND the head's parents are exactly [from, baseSha] on GitHub; every failure is false", () => {
  const repo = repoWithCommit();
  recordSuccessor(repo.dir, 12, triple);
  const gh = (parents) => ({ commitParents: (c) => { assert.equal(c, triple.to); return parents; } });
  const own = (g, head = triple.to, pr = 12) => ownSuccessor({ root: repo.dir, pr, head, gh: g });
  assert.equal(own(gh([triple.from, triple.baseSha])), true);
  assert.equal(own(gh([triple.baseSha, triple.from])), false, 'order matters: [head it was made from, base]');
  assert.equal(own(gh([triple.from])), false, 'a single-parent push');
  assert.equal(own(gh([triple.from, H('7')])), false, 'another base');
  assert.equal(own(gh([triple.from, triple.baseSha, H('7')])), false, 'an octopus');
  assert.equal(own(gh(undefined)), false);
  assert.equal(own({ commitParents: () => { throw new Error('gh down'); } }), false, 'gh throws');
  assert.equal(own({ commitParents: () => assert.fail('no record, no gh call') }, H('9')), false, 'head not recorded');
  assert.equal(own({ commitParents: () => assert.fail('no record, no gh call') }, 'nothex'), false, 'non-hex head');
  assert.equal(own(gh([triple.from, triple.baseSha]), triple.to, 13), false, 'another PR');
  assert.equal(ownSuccessor({ root: '/no/such/dir', pr: 12, head: triple.to, gh: gh([triple.from, triple.baseSha]) }), false, 'no repo');
});

// ---- waitForTurn ---------------------------------------------------------------------------------------------------------------------------

const MIN = 60_000;
// A fake clock: sleep advances it, a check may cost `cost` ms. `answers` are the check's answers in turn (the last repeats).
function turn(answers, { maxMs, cost = 0 } = {}) {
  const t = { now: 0, starts: [], slept: [] };
  let i = 0;
  const run = () => waitForTurn({
    maxMs,
    now: () => t.now,
    sleep: async (ms) => { t.slept.push(ms); t.now += ms; },
    check: async () => { t.starts.push(t.now); const a = answers[Math.min(i, answers.length - 1)]; i += 1; t.now += cost; return a; },
  });
  return { t, run };
}
const BLOCKED = { error: 'queued-behind', blockedBy: [1400] };
const UNREAD = { error: 'hold-unreadable', reason: 'x' };

test('waitForTurn: the default poll is 5 minutes; front at once is one poll and no sleep', async () => {
  assert.equal(HOLD_POLL_MS, 5 * MIN);
  const { t, run } = turn([null], { maxMs: 60 * MIN });
  assert.deepEqual(await run(), { outcome: 'front', polls: 1, waitedMs: 0, last: null });
  assert.deepEqual(t.slept, []);
});

test('waitForTurn: front after 2 blocked polls = 3 polls at 0, 5, 10 minutes', async () => {
  const { t, run } = turn([BLOCKED, BLOCKED, null], { maxMs: 60 * MIN });
  const r = await run();
  assert.deepEqual([r.outcome, r.polls, r.waitedMs, r.last], ['front', 3, 10 * MIN, null]);
  assert.deepEqual(t.starts, [0, 5 * MIN, 10 * MIN]);
  assert.deepEqual(t.slept, [5 * MIN, 5 * MIN]);
});

test('waitForTurn: max 6 min -> polls at 0 and 5 only, then timeout (the 10-min poll could not start by the deadline)', async () => {
  const { t, run } = turn([BLOCKED], { maxMs: 6 * MIN });
  const r = await run();
  assert.deepEqual([r.outcome, r.polls, r.waitedMs], ['timeout', 2, 5 * MIN]);
  assert.equal(r.last, BLOCKED);
  assert.deepEqual(t.starts, [0, 5 * MIN]);
});

test('waitForTurn: max 12 min -> polls at 0, 5, 10; max 10 -> the poll AT the deadline still runs; max 4 -> one poll', async () => {
  const twelve = turn([BLOCKED], { maxMs: 12 * MIN });
  const r = await twelve.run();
  assert.deepEqual([r.outcome, r.polls], ['timeout', 3]);
  assert.deepEqual(twelve.t.starts, [0, 5 * MIN, 10 * MIN]);
  const ten = turn([BLOCKED], { maxMs: 10 * MIN });
  assert.equal((await ten.run()).polls, 3);
  const four = turn([BLOCKED], { maxMs: 4 * MIN });
  const r4 = await four.run();
  assert.deepEqual([r4.outcome, r4.polls, r4.waitedMs], ['timeout', 1, 0]);
  assert.deepEqual(four.t.slept, [], 'no sleep when the next poll cannot start in time');
});

test('waitForTurn: a check that takes 2 minutes shifts the next start by 2 minutes (the sleep is pollMs after the check ENDS)', async () => {
  const { t, run } = turn([BLOCKED, BLOCKED, null], { maxMs: 60 * MIN, cost: 2 * MIN });
  const r = await run();
  assert.deepEqual(t.starts, [0, 7 * MIN, 14 * MIN], 'starts are >= 5 min apart');
  assert.deepEqual(t.slept, [5 * MIN, 5 * MIN]);
  assert.equal(r.outcome, 'front');
  assert.equal(r.waitedMs, 16 * MIN, 'the last check ran 2 minutes');
  const tight = turn([BLOCKED], { maxMs: 11 * MIN, cost: 2 * MIN });
  const rt = await tight.run();
  assert.deepEqual(tight.t.starts, [0, 7 * MIN], 'at minute 9 the next start (14) would pass the deadline (11)');
  assert.equal(rt.outcome, 'timeout');
});

test('waitForTurn: two unreadable answers in a row -> unreadable (fail closed); one unreadable then front -> front; unreadable between blocked polls resets', async () => {
  const two = turn([UNREAD, UNREAD], { maxMs: 60 * MIN });
  const r = await two.run();
  assert.deepEqual([r.outcome, r.polls, r.waitedMs], ['unreadable', 2, 5 * MIN]);
  assert.equal(r.last, UNREAD);

  const recovered = turn([UNREAD, null], { maxMs: 60 * MIN });
  assert.equal((await recovered.run()).outcome, 'front');

  const reset = turn([UNREAD, BLOCKED, UNREAD, null], { maxMs: 60 * MIN });
  const rr = await reset.run();
  assert.deepEqual([rr.outcome, rr.polls], ['front', 4], 'never two in a row');

  const lateTimeout = turn([UNREAD], { maxMs: 6 * MIN });
  assert.equal((await lateTimeout.run()).outcome, 'unreadable', 'two in a row at 0 and 5 beats the deadline');
  const once = turn([UNREAD], { maxMs: 4 * MIN });
  assert.equal((await once.run()).outcome, 'timeout', 'one unreadable, no time for a second');
});

test('waitForTurn: a missing or non-finite maxMs is refused (an unbounded wait must be asked for in words)', async () => {
  for (const maxMs of [undefined, NaN, Infinity, -1]) await assert.rejects(waitForTurn({ check: async () => BLOCKED, maxMs, sleep: async () => {} }), /finite maxMs/, String(maxMs));
});

// #188: runShellAsync returns the close event's signal: a killed hold command is code 1 plus `signal`, never the provider's own "no".
test('takeHold / checkHolds: a hold command killed by a signal is reported with its signal (exit 1 alone looks like a refusal)', async () => {
  const killed = async () => ({ code: 1, stdout: 'hold taken\n', stderr: '', timedOut: false, overBuffer: false, signal: 'SIGKILL' });
  const taken = await takeHold({ config: CONFIG, pr: PR, root: '/repo', env: {}, run: killed });
  assert.deepEqual([taken.confirmed, taken.code, taken.signal], [false, 1, 'SIGKILL']);
  const plain = await takeHold({ config: CONFIG, pr: PR, root: '/repo', env: {}, run: async () => ({ code: 1, stdout: '', stderr: 'no', timedOut: false, signal: null }) });
  assert.equal(plain.signal, undefined, 'a plain refusal carries no signal');
  const checked = await check(killed);
  assert.equal(checked.ok, false);
  assert.match(checked.why, /SIGKILL/);
});

// ---- a hold command that could not be STARTED (issue #194) -----------------------------------------------------------------------

test('takeHold / releaseHold: a run that throws (the command could not be started) is code null + notStarted, never a fake exit 1', async () => {
  const run = async () => { throw new Error('spawn /bin/sh ENOENT'); };
  const took = await takeHold({ config: CONFIG, pr: PR, root: '/r', env: {}, run });
  assert.deepEqual([took.configured, took.confirmed, took.code, took.notStarted], [true, false, null, true]);
  assert.match(took.lines.join(' '), /could not be started.*ENOENT/);
  const released = await releaseHold({ config: CONFIG, pr: PR, reason: 'parked', root: '/r', env: {}, run });
  assert.deepEqual([released.confirmed, released.code, released.notStarted], [false, null, true]);
  const real = await takeHold({ config: CONFIG, pr: PR, root: '/r', env: {}, run: async () => ({ code: 1, stdout: '', stderr: 'no' }) });
  assert.equal('notStarted' in real, false, 'a real exit 1 carries no notStarted');
});

test('holdBeforeUpdate: a take that could not be started is passed through on info.take', async () => {
  const run = async (cmd) => {
    if (cmd.includes('--status')) return { code: 0, stdout: `${JSON.stringify({ pr: PR, blockedBy: [] })}\n`, stderr: '' };
    throw new Error('spawn /bin/sh ENOENT');
  };
  const { beforeUpdate, info } = holdBeforeUpdate({ config: CONFIG, pr: PR, root: '/r', env: {}, run });
  await beforeUpdate();
  assert.equal(info.take.notStarted, true);
  assert.equal(info.take.code, null);
  assert.equal(info.take.confirmed, false);
});

test('unreleasedWarning: a release that could not be started says so, never "exit null"', () => {
  for (const takeConfirmed of [true, false]) {
    const w = unreleasedWarning({ pr: PR, reason: 'parked', code: null, notStarted: true, takeConfirmed });
    assert.doesNotMatch(w, /exit null/);
    assert.match(w, /could not be started/);
  }
  assert.doesNotMatch(unreleasedWarning({ pr: PR, reason: 'parked', code: null, takeConfirmed: true }), /exit null/, 'code null alone is enough');
  assert.match(unreleasedWarning({ pr: PR, reason: 'parked', code: 3, takeConfirmed: true }), /exit 3/);
});

test('a hold command that resolves with spawnError (runShellAsync: bad cwd, missing shell) is notStarted for a take and "could not be started" for a check', async () => {
  const spawnFailed = async () => ({ code: 1, spawnError: true, stderr: 'spawn /bin/sh ENOENT', stdout: '', timedOut: false, signal: null });
  const took = await takeHold({ config: CONFIG, pr: PR, root: '/r', env: {}, run: spawnFailed });
  assert.deepEqual([took.configured, took.confirmed, took.code, took.notStarted], [true, false, null, true]);
  assert.match(took.lines.join(' '), /could not be started.*ENOENT/);
  const released = await releaseHold({ config: CONFIG, pr: PR, reason: 'parked', root: '/r', env: {}, run: spawnFailed });
  assert.deepEqual([released.confirmed, released.code, released.notStarted], [false, null, true]);
  const checked = await checkHolds({ config: CONFIG, pr: PR, root: '/r', env: {}, run: spawnFailed });
  assert.equal(checked.ok, false);
  assert.match(checked.why, /could not be started.*ENOENT/);
  assert.doesNotMatch(checked.why, /exited/);
});
