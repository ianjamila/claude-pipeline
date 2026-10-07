// final-gate, part 2: every way the verify report can be wrong, then hardstops, integrity and review.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { saveState } from '../pipeline/lib/state.mjs';
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
