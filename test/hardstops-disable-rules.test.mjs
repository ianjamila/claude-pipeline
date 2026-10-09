import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, DISABLEABLE_HARD_STOP_RULES, validateConfig } from '../pipeline/lib/config.mjs';
import { cfg, file, pkg, rulesOf, classify } from './helpers/hardstops.mjs';

// hard_stops.disable_rules switches off built-in rule families whose trigger is a word or a version number (an HR/payroll
// app mentions payroll everywhere). Everything else — migrations, destructive SQL, auth, secrets, pipeline files — must
// stay on whatever the config says.

const off = (rules, extra = {}) => ({ ...cfg(extra), hard_stops: { ...cfg(extra).hard_stops, disable_rules: rules } });
const minimal = () => ({ version: 1, project: 'p', verify: { full: 'f', quick: 'q' } });

test('the switchable list is exactly R5-major-dep and R6-sensitive', () => {
  assert.deepEqual([...DISABLEABLE_HARD_STOP_RULES], ['R5-major-dep', 'R6-sensitive']);
  assert.ok(Object.isFrozen(DISABLEABLE_HARD_STOP_RULES));
});

test('defaults: nothing disabled', () => {
  assert.deepEqual(DEFAULTS.hard_stops.disable_rules, []);
  const r = validateConfig(minimal());
  assert.equal(r.ok, true, r.errors?.join('; '));
  assert.deepEqual(r.config.hard_stops.disable_rules, []);
});

test('R6-sensitive: a payroll path and a payroll word fire by default and not when disabled', () => {
  const files = [
    file('lib/payroll/compute.ts'),
    file('lib/a.ts', { added: ['const salary = base * rate;'] }),
  ];
  assert.deepEqual(rulesOf(classify({ files, config: cfg() })), ['R6-sensitive']); // positive control
  assert.deepEqual(rulesOf(classify({ files, config: off(['R6-sensitive']) })), []);
});

test('R5-major-dep: a major bump fires by default and not when disabled', () => {
  const o = { files: [], basePkg: pkg({ next: '15.5.15' }), headPkg: pkg({ next: '16.0.0' }) };
  assert.deepEqual(rulesOf(classify({ ...o, config: cfg() })), ['R5-major-dep']);
  assert.deepEqual(rulesOf(classify({ ...o, config: off(['R5-major-dep']) })), []);
});

test('disabling one rule leaves the others on the same file', () => {
  const files = [
    file('lib/payroll/env.ts', { added: ['const k = process.env.NEW_PAYROLL_SECRET;'] }),
    file('.github/workflows/payroll.yml'),
  ];
  const hits = classify({ files, config: off(['R6-sensitive']) });
  assert.deepEqual(rulesOf(hits), ['R3-secrets', 'R4-pipeline']);
});

test('disabling R6 does not hide a destructive payroll migration or a project path', () => {
  const mig = 'supabase/migrations/20261009000000_payroll.sql';
  const hits = classify({
    files: [file(mig, { status: 'A', added: ['DROP TABLE payroll_runs;'] }), file('lib/dtr-actions.ts')],
    sqlStatements: [{ file: mig, text: 'DROP TABLE payroll_runs;' }],
    config: off(['R6-sensitive'], { paths: ['lib/dtr-actions.ts'] }),
  });
  assert.deepEqual(rulesOf(hits), ['P-path', 'R1-destructive']);
});

test('the scanner refuses a rule outside the switchable list (fail closed, even without validateConfig)', () => {
  for (const rule of ['R1-destructive', 'R2-auth', 'R3-secrets', 'R4-pipeline', 'R0-unscannable', 'r6-sensitive', 'P-path']) {
    assert.throws(
      () => classify({ files: [file('lib/a.ts')], config: off([rule]) }),
      /cannot be disabled/,
      rule,
    );
  }
});

test('config validation accepts the switchable rules and rejects everything else', () => {
  const ok = validateConfig({ ...minimal(), hard_stops: { disable_rules: ['R6-sensitive', 'R5-major-dep'] } });
  assert.equal(ok.ok, true, ok.errors?.join('; '));
  assert.deepEqual(ok.config.hard_stops.disable_rules, ['R6-sensitive', 'R5-major-dep']);

  const cases = [
    [['R1-destructive'], 'hard_stops.disable_rules[0]'],
    [['R6-sensitive', 'R4-pipeline'], 'hard_stops.disable_rules[1]'],
    [['r6-sensitive'], 'cannot be disabled'],
    [[1], 'cannot be disabled'],
    ['R6-sensitive', 'hard_stops.disable_rules must be an array'],
  ];
  for (const [val, expected] of cases) {
    const r = validateConfig({ ...minimal(), hard_stops: { disable_rules: val } });
    assert.equal(r.ok, false, JSON.stringify(val));
    assert.ok(r.errors.some((e) => e.includes(expected)), `${JSON.stringify(val)}: ${r.errors.join('; ')}`);
  }
});
