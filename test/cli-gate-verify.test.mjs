// final-gate, part 2: every way the verify report can be wrong, then hardstops, integrity and review.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { addRound, saveState } from '../pipeline/lib/state.mjs';
import { treeFingerprint } from '../pipeline/lib/git.mjs';
import { cli, scenario, ghEntries, reviewState, named, assertOnlyFails, bump, ymlFor, STEPS, PR, AGENT_LOG } from './helpers/gate-env.mjs';
import { assertExit } from './helpers/assert-exit.mjs';

test('final-gate: each way the verify report can be wrong fails verify-report', () => {
  const cases = [
    ['dirty report', (r) => { r.git.dirty = true; }, /dirty tree/],
    ['report head is not HEAD', (r) => { r.git.head = 'e'.repeat(40); }, /report is for/],
    ['partial mode', (r) => { r.mode = 'partial'; }, /not "full"/],
    ['quick mode', (r) => { r.mode = 'quick'; }, /not "full"/],
    ['report.ok false', (r) => { r.ok = false; }, /report\.ok/],
    ['a step missing from steps', (r) => { r.steps.pop(); }, /do not match expectedSteps/],
    ['steps in the wrong order', (r) => { r.steps.reverse(); }, /do not match expectedSteps/],
    ['an extra step', (r) => { r.steps.push({ name: 'extra', status: 'pass' }); }, /do not match expectedSteps/],
    ['no expectedSteps', (r) => { delete r.expectedSteps; }, /no expectedSteps/],
    ['a step that did not pass', (r) => { r.steps[2].status = 'not-run'; }, /lint=not-run/],
    ['a failed step', (r) => { r.steps[3].status = 'fail'; }, /unit=fail/],
    ['report older than the HEAD commit', (r) => { r.finishedAt = '2020-01-01T00:00:00.000Z'; }, /before the HEAD commit/],
    ['no finishedAt', (r) => { delete r.finishedAt; }, /finishedAt/],
    ['no tree recorded', (r) => { delete r.git.tree; }, /tree changed/],
    ['wrong tree', (r) => { r.git.tree = '0'.repeat(64); }, /tree changed/],
  ];
  for (const [label, mutate, detail] of cases) {
    const r = scenario({ report: mutate }).gate();
    assertExit(r, 1, label);
    assert.deepEqual(r.json.failed, ['verify-report'], label);
    assert.match(named(r.json, 'verify-report').detail, detail, label);
  }
});

// ---- final-gate: a verify report for another commit with HEAD's tree ------------------------------

// Amends the PR commit's message only (same tree, new sha) and points the fake PR at the new head. `date`: the amended commit's
// committer date. -> the new head.
function reword(s, { date } = {}) {
  execFileSync('git', ['commit', '--amend', '-q', '-m', 'feature, reworded'], {
    cwd: s.repo.dir, env: { ...process.env, ...(date ? { GIT_COMMITTER_DATE: date } : {}) },
  });
  const head = s.repo.git(['rev-parse', 'HEAD']).trim();
  assert.notEqual(head, s.head, 'the amend made a new commit');
  assert.equal(s.repo.git(['rev-parse', `${head}^{tree}`]).trim(), s.repo.git(['rev-parse', `${s.head}^{tree}`]).trim(), 'same tree');
  s.fake.setScript(ghEntries({ prHead: head }));
  return head;
}

test('final-gate: a verify report for an earlier commit with HEAD\'s tree (an amended message) stands, and the detail says so', () => {
  const s = scenario();
  const head = reword(s);
  const r = s.gate();
  assertExit(r, 0, JSON.stringify(r.json?.checks.filter((c) => !c.ok)));
  assert.equal(r.json.head, head);
  assert.match(named(r.json, 'verify-report').detail, new RegExp(`full verify passed at ${s.head.slice(0, 8)}, the same tree as HEAD ${head.slice(0, 8)} \\(5 steps\\)`));
});

test('final-gate: the same-tree report must be younger than the VERIFIED commit, not than the amended HEAD', () => {
  // HEAD's committer date is an hour ahead of the report; the verified commit is older than the report: still fine.
  const later = scenario();
  reword(later, { date: new Date(Date.now() + 3_600_000).toISOString() });
  const ok = later.gate();
  assertExit(ok, 0, JSON.stringify(ok.json?.checks.filter((c) => !c.ok)));
  // a report that finished before the verified commit was made is refused
  const early = scenario({ report: (rep) => { rep.finishedAt = '2020-01-01T00:00:00.000Z'; } });
  reword(early);
  const r = early.gate();
  assertExit(r, 1);
  assert.deepEqual(r.json.failed, ['verify-report']);
  assert.match(named(r.json, 'verify-report').detail, /report finished before the verified commit was made/);
});

test('final-gate: a report for another commit with a DIFFERENT tree, or for a sha that is not in the repository, is refused', () => {
  const moved = scenario();
  moved.repo.write('src/app.js', 'export const a = 3;\n');
  const head = moved.repo.commit('a real change after verify');
  moved.fake.setScript(ghEntries({ prHead: head }));
  const a = moved.gate();
  assertExit(a, 1);
  assert.match(named(a.json, 'verify-report').detail, new RegExp(`report is for ${moved.head.slice(0, 8)}, HEAD is ${head.slice(0, 8)} \\(its tree is not HEAD's tree\\)`));
  assert.ok(a.json.failed.includes('verify-report'));

  const unknown = scenario({ report: (rep) => { rep.git.head = 'e'.repeat(40); } });
  const b = unknown.gate();
  assertExit(b, 1);
  assert.deepEqual(b.json.failed, ['verify-report']);
  assert.match(named(b.json, 'verify-report').detail, /report is for eeeeeeee, HEAD is [0-9a-f]{8} \(that commit is not in this repository\)/);

  // a value that is no sha at all gets the plain message
  const junk = scenario({ report: (rep) => { rep.git.head = 'not-a-sha'; } });
  const c = junk.gate();
  assertExit(c, 1);
  assert.doesNotMatch(named(c.json, 'verify-report').detail, /\(its tree|\(that commit/);
});

test('final-gate: a same-tree report whose tree fingerprint was taken for HEAD (not for the verified commit) is refused', () => {
  const s = scenario();
  const head = reword(s);
  const asHead = treeFingerprint({ cwd: s.repo.dir });
  assert.notEqual(asHead, treeFingerprint({ cwd: s.repo.dir }, { asHead: s.head }), 'the two fingerprints differ (they hash different heads)');
  const file = join(s.repo.dir, '.verify', 'report.json');
  const report = JSON.parse(readFileSync(file, 'utf8'));
  report.git.tree = asHead;
  writeFileSync(file, JSON.stringify(report));
  const r = s.gate();
  assertExit(r, 1);
  assert.deepEqual(r.json.failed, ['verify-report']);
  assert.match(named(r.json, 'verify-report').detail, /the working tree changed since verify ran/);
  assert.equal(r.json.head, head);
});

test('final-gate: a same-tree report does not cover a working tree that changed since (dirty or untracked file)', () => {
  const s = scenario();
  reword(s);
  s.repo.write('src/untracked.js', 'export const u = 1;\n');
  const r = s.gate();
  assertExit(r, 1);
  assert.match(named(r.json, 'verify-report').detail, /the working tree changed since verify ran/);
});

test('final-gate: verify.expected_steps in the config overrides the report\'s own expectedSteps', () => {
  const configured = (names) => ({ yml: ymlFor().replace('  quick: npm run verify:quick\n', `  quick: npm run verify:quick\n  expected_steps: [${names.join(', ')}]\n`) });
  // exact match, and the report need not even carry expectedSteps
  const pass = scenario({ ...configured(STEPS), report: (r) => { delete r.expectedSteps; } }).gate();
  assertExit(pass, 0, pass.stderr + pass.stdout);
  assert.match(named(pass.json, 'verify-report').detail, /full verify passed/);

  const cases = [
    ['the report dropped a step and shrank its own expectedSteps to match', (r) => { r.steps.pop(); r.expectedSteps.pop(); }],
    ['steps reordered along with the report\'s expectedSteps', (r) => { r.steps.reverse(); r.expectedSteps.reverse(); }],
    ['an extra step the config does not list, mirrored in expectedSteps', (r) => { r.steps.push({ name: 'extra', status: 'pass' }); r.expectedSteps.push('extra'); }],
  ];
  for (const [label, mutate] of cases) {
    const r = scenario({ ...configured(STEPS), report: mutate }).gate();
    assertExit(r, 1, label);
    assert.deepEqual(r.json.failed, ['verify-report'], label);
    assert.match(named(r.json, 'verify-report').detail, /verify\.expected_steps/, label);
  }
  // without the config key the report's own expectedSteps is still what decides (the old behaviour)
  const legacy = scenario({ report: (r) => { r.steps.pop(); r.expectedSteps.pop(); } }).gate();
  assertExit(legacy, 0, legacy.stderr + legacy.stdout);
});

// ---- final-gate: hardstops, integrity -------------------------------------------------------------

test('final-gate: a hard-stop hit fails hardstops, and no label can override it', () => {
  const s = scenario({ change: (r) => { bump(r); r.write('.env', 'SECRET=1\n'); }, gh: { labels: ['human-approved'] } });
  const r = s.gate();
  assertOnlyFails(r, 'hardstops', /hard-stop hit/);
  assert.match(named(r.json, 'hardstops').detail, /\.env/);
});

test('final-gate: a test-integrity violation fails integrity, and test-change-approved is not honoured', () => {
  const s = scenario({ change: (r) => { bump(r); r.rm('test/app.test.js'); }, gh: { labels: ['test-change-approved'] } });
  assertOnlyFails(s.gate(), 'integrity', /test-deleted/);
});

// ---- final-gate: review ---------------------------------------------------------------------------

test('final-gate: missing, stale or unresolved review state fails review', () => {
  assertOnlyFails(scenario({ state: null }).gate(), 'review', /no review state/);
  assertOnlyFails(scenario({ state: 'stale' }).gate(), 'review', /no clean review round covers/);
  assertOnlyFails(scenario({ state: 'pending' }).gate(), 'review', /unresolved/);
});

test('final-gate: code that changed after the review fails review (content hash differs)', () => {
  const s = scenario();
  s.repo.write('src/app.js', 'export const a = 3;\n');
  s.repo.commit('late change');
  // Fresh verify report for the new head, but the review still covers the old patch.
  const head = s.repo.git(['rev-parse', 'HEAD']).trim();
  const report = JSON.parse(readFileSync(join(s.repo.dir, '.verify', 'report.json'), 'utf8'));
  report.git = { ...report.git, head, tree: treeFingerprint({ cwd: s.repo.dir }) };
  report.finishedAt = new Date().toISOString();
  writeFileSync(join(s.repo.dir, '.verify', 'report.json'), JSON.stringify(report));
  s.fake.setScript(ghEntries({ prHead: head }));
  assertOnlyFails(s.gate(), 'review', /no clean review round covers/);
});

test('final-gate: a review state recorded for a different PR fails review', () => {
  const s = scenario();
  const state = reviewState(s.hash);
  state.pr = 99;
  saveState(s.repo.dir, state);
  assertOnlyFails(s.gate(), 'review', /PR #99/);
});

test('final-gate: a corrupt review state fails review instead of crashing the gate', () => {
  const s = scenario();
  writeFileSync(join(s.repo.dir, '.review', 'state.json'), '{not json');
  assertOnlyFails(s.gate(), 'review', /corrupt review state/);
});

test('final-gate: a log-only diff passes review without any review state', () => {
  const s = scenario({ state: null, change: (r) => r.write(AGENT_LOG, '# Agent log\n\n- 2026-10-01 · #1 · x\n') });
  const r = s.gate();
  assertExit(r, 0, JSON.stringify(r.json?.checks.filter((c) => !c.ok)));
  assert.equal(named(r.json, 'review').detail, 'log-only');
});

test('final-gate: a log edit that removes or rewrites a line is not log-only, and neither is log plus code', () => {
  const rewrite = scenario({
    state: null,
    baseFiles: { [AGENT_LOG]: '# Agent log\n- keep\n- drop\n' },
    change: (r) => r.write(AGENT_LOG, '# Agent log\n- keep\n- changed\n'),
  });
  assertOnlyFails(rewrite.gate(), 'review', /no review state/);

  const mixed = scenario({ state: null, change: (r) => { bump(r); r.write(AGENT_LOG, '# Agent log\n- x\n'); } });
  assertOnlyFails(mixed.gate(), 'review', /no review state/);

  const appendOnly = scenario({
    state: null,
    baseFiles: { [AGENT_LOG]: '# Agent log\n- keep\n' },
    change: (r) => r.write(AGENT_LOG, '# Agent log\n- keep\n- new\n'),
  });
  assert.equal(named(appendOnly.gate().json, 'review').detail, 'log-only');
});

test('final-gate: a partial verify report is rejected however it says so (reviewer repro H)', () => {
  const one = (r) => { r.steps = r.steps.slice(0, 1); r.expectedSteps = r.expectedSteps.slice(0, 1); };
  const cases = [
    ['partial: true on a one-step run', (r) => { r.partial = true; one(r); }, /partial/],
    ['partial: true on a complete run', (r) => { r.partial = true; }, /partial/],
    ['partial as a string', (r) => { r.partial = 'false'; }, /partial/],
    ['partial: null', (r) => { r.partial = null; }, /partial/],
    ['partial: 0', (r) => { r.partial = 0; }, /partial/],
    ['mode missing', (r) => { delete r.mode; }, /not "full"/],
    ['mode missing and partial missing', (r) => { delete r.mode; delete r.partial; }, /not "full"/],
  ];
  for (const [label, mutate, detail] of cases) {
    const r = scenario({ report: mutate }).gate();
    assertExit(r, 1, label);
    assert.deepEqual(r.json.failed, ['verify-report'], label);
    assert.match(named(r.json, 'verify-report').detail, detail, label);
  }
});

test('final-gate: a full report passes with partial === false, and with the field absent (the verify template does not write it)', () => {
  assertExit(scenario({ report: (r) => { r.partial = false; } }).gate(), 0);
  assertExit(scenario().gate(), 0);
});

test('final-gate: a review state whose pr is missing, zero, a string or another PR fails review (reviewer finding 8)', () => {
  for (const [label, pr] of [['missing', undefined], ['zero', 0], ['negative', -3], ['a string', '12'], ['a float', 12.5], ['null', null]]) {
    const s = scenario();
    const state = reviewState(s.hash);
    if (pr === undefined) delete state.pr;
    else state.pr = pr;
    saveState(s.repo.dir, state);
    const r = s.gate();
    assertExit(r, 1, label);
    assert.deepEqual(r.json.failed, ['review'], label);
    assert.match(named(r.json, 'review').detail, /review state is for PR|records no valid PR/, label);
  }
});

// ---- final-gate: skipped verify steps -------------------------------------------------------------

// A step the verify runner skipped is accepted only when the owner listed it in verify.skippable_steps and it says why.
const skippable = (names) => ({ yml: ymlFor().replace('  quick: npm run verify:quick\n', `  quick: npm run verify:quick\n  skippable_steps: [${names.join(', ')}]\n`) });
const skipRow = (r, reason = 'no unit dependency changed vs origin/main') => { r.steps[3] = { ...r.steps[3], status: 'skipped', skipReason: reason, exitCode: null }; };
const legacySkipRow = (r, reason = '(skipped - no unit dependency changed)') => { r.steps[3] = { ...r.steps[3], status: 'pass', skipped: true, command: reason }; };

test('final-gate: a skipped step the owner listed in verify.skippable_steps passes, and the detail names it', () => {
  const r = scenario({ ...skippable(['unit']), report: (rep) => skipRow(rep) }).gate();
  assertExit(r, 0, r.stderr + r.stdout);
  assert.match(named(r.json, 'verify-report').detail, /full verify passed at [0-9a-f]{8} \(5 steps: 4 ran, 1 skipped: unit — no unit dependency changed vs origin\/main\)/);
});

test('final-gate: a skipped step that is not listed, or has no reason, fails verify-report', () => {
  const unlisted = scenario({ report: (rep) => skipRow(rep) }).gate();
  assertExit(unlisted, 1, 'unlisted');
  assert.deepEqual(unlisted.json.failed, ['verify-report']);
  assert.match(named(unlisted.json, 'verify-report').detail, /unit was skipped; list it in verify\.skippable_steps/);
  const other = scenario({ ...skippable(['lint']), report: (rep) => skipRow(rep) }).gate();
  assertExit(other, 1, 'a different step is listed');
  assert.match(named(other.json, 'verify-report').detail, /unit was skipped/);
  for (const [label, reason] of [['empty reason', ''], ['blank reason', '   '], ['non-string reason', 5], ['no reason', undefined]]) {
    const r = scenario({ ...skippable(['unit']), report: (rep) => { skipRow(rep, reason); if (reason === undefined) delete rep.steps[3].skipReason; } }).gate();
    assertExit(r, 1, label);
    assert.deepEqual(r.json.failed, ['verify-report'], label);
    assert.match(named(r.json, 'verify-report').detail, /unit was skipped without a reason/, label);
  }
});

test('final-gate: the legacy shape (status pass + skipped:true) is a skip too: listed passes, unlisted fails', () => {
  const listed = scenario({ ...skippable(['unit']), report: (rep) => legacySkipRow(rep) }).gate();
  assertExit(listed, 0, listed.stderr + listed.stdout);
  assert.match(named(listed.json, 'verify-report').detail, /4 ran, 1 skipped: unit — \(skipped - no unit dependency changed\)/);
  const viaCheck = scenario({ ...skippable(['unit']), report: (rep) => { legacySkipRow(rep, 'node scripts/x.mjs'); rep.steps[3].skipCheck = 'deps unchanged'; } }).gate();
  assertExit(viaCheck, 0, viaCheck.stderr + viaCheck.stdout);
  assert.match(named(viaCheck.json, 'verify-report').detail, /skipped: unit — deps unchanged/, 'skipCheck wins over command');
  const unlisted = scenario({ report: (rep) => legacySkipRow(rep) }).gate();
  assertExit(unlisted, 1, 'legacy unlisted');
  assert.deepEqual(unlisted.json.failed, ['verify-report']);
  assert.match(named(unlisted.json, 'verify-report').detail, /unit was skipped; list it in verify\.skippable_steps/);
});

test('final-gate: skipped:true on a step that did not pass, and unknown statuses, still fail', () => {
  const failedSkip = scenario({ ...skippable(['unit']), report: (rep) => { rep.steps[3].status = 'fail'; rep.steps[3].skipped = true; } }).gate();
  assertExit(failedSkip, 1, 'fail + skipped:true');
  assert.match(named(failedSkip.json, 'verify-report').detail, /unit=fail/);
  for (const status of ['skip', 'SKIPPED', 'ok', '', null]) {
    const r = scenario({ ...skippable(['unit']), report: (rep) => { rep.steps[3].status = status; rep.steps[3].skipReason = 'because'; } }).gate();
    assertExit(r, 1, String(status));
    assert.match(named(r.json, 'verify-report').detail, /steps not passing: unit=/, String(status));
  }
});

test('final-gate: a long skip reason is cut to about 80 characters in the detail', () => {
  const r = scenario({ ...skippable(['unit']), report: (rep) => skipRow(rep, 'x'.repeat(300)) }).gate();
  assertExit(r, 0, r.stderr + r.stdout);
  const detail = named(r.json, 'verify-report').detail;
  assert.match(detail, /skipped: unit — x{70,85}…\)/);
  assert.ok(detail.length < 200, detail);
});

// ---- final-gate: owner-ruled review items ---------------------------------------------------------

const ownerItem = (id, over = {}) => ({
  id, bucket: 'BLOCKING', title: 'a finding', fingerprint: `fp-${id}`,
  final: {
    decision: 'FOLLOW-UP', by: 'owner', needsHuman: false, reason: 'filed', ownerQuote: 'file it for later',
    ruledAt: '2026-10-14T01:02:03.000Z', overruled: { decision: 'FOLLOW-UP', by: 'arbiter', needsHuman: true, reason: 'model-proof failed' },
  },
  ...over,
});

test('final-gate: owner-ruled review items (also cached copies in later rounds) pass review but count as ownerMerge with their quotes', () => {
  const s = scenario({ yml: `${ymlFor()}owner_approval: chat\n` });
  let state = reviewState(s.hash);
  state.rounds[0].items = [ownerItem('R1-B1')];
  state = addRound(state, {
    n: 2, fromHead: 'b', toHead: 'c', contentHashAtToHead: s.hash,
    items: [{ ...ownerItem('R2-B1'), final: { ...ownerItem('R1-B1').final, by: 'cache' } }],
  });
  saveState(s.repo.dir, state);
  const r = s.gate();
  assertExit(r, 0, r.stderr + r.stdout);
  const review = named(r.json, 'review');
  assert.equal(review.ok, true);
  assert.equal(review.ownerMerge, 2);
  for (const needle of ['R1-B1', 'R2-B1', 'file it for later']) assert.ok(review.detail.includes(needle), review.detail);
  assert.equal(r.json.ownerMerge, 2, 'the gate total tells the ship skill the owner must say "merge"');
});

test('final-gate: a review with no owner rulings has no ownerMerge, and an unresolved item still fails review even when others are owner-ruled', () => {
  const plain = scenario();
  const r = plain.gate();
  assertExit(r, 0, r.stderr + r.stdout);
  assert.equal(named(r.json, 'review').ownerMerge, undefined);

  const s = scenario({ yml: `${ymlFor()}owner_approval: chat\n` });
  const state = reviewState(s.hash);
  state.rounds[0].items = [ownerItem('R1-B1'), { id: 'R1-B2', bucket: 'BLOCKING', title: 'open', judge: { decision: 'ACCEPT', confidence: 'high', reason: 'x' } }];
  saveState(s.repo.dir, state);
  assertOnlyFails(s.gate(), 'review', /unresolved/);
});
