// The merge-hold seam (plan 2026-11-05-merge-hold-queue): its three config keys, the library that runs them and reads their answers
// (with an injected shell, nothing spawned), and bringUpToDate's beforeUpdate callback. The commands that use it are in
// merge-hold-merge.test.mjs and merge-hold-command.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, loadConfig, validateConfig } from '../pipeline/lib/config.mjs';
import {
  HOLD_QUEUED_BEHIND, HOLD_TIMEOUT_MS, RELEASE_REASONS, checkHolds, holdGate, holdGateFrom, holdsConfigured, queuedBehindFrom, queuedBehindRefusal, quoteReason, releaseHold, takeHold,
} from '../pipeline/lib/merge-hold.mjs';
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
  assert.equal(seen.length, 4);
  for (const [i, reason] of Object.keys(RELEASE_REASONS).entries()) {
    assert.equal(seen[i], `npm run merge-hold -- 12 --release --reason ${quoteReason(RELEASE_REASONS[reason])}`);
    assert.match(seen[i], process.platform === 'win32' ? /--reason "[A-Za-z0-9 ,.-]+"$/ : /--reason '[A-Za-z0-9 ,.-]+'$/, 'quoted for this platform, plain words only');
  }
  assert.deepEqual(Object.keys(RELEASE_REASONS), ['new-commits', 'parked', 'owner-declined', 'handoff-withdrawn']);
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
