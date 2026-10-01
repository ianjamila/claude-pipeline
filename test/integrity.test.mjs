import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkIntegrity, isTestFile } from '../pipeline/lib/integrity.mjs';
import { DEFAULTS } from '../pipeline/lib/config.mjs';

// `files` are built inline in the shape parseUnifiedDiff returns, so these tests never run git.
const config = { integrity: { test_globs: DEFAULTS.integrity.test_globs } };
const numbered = (texts, start = 1) => texts.map((text, i) => ({ line: start + i, text }));
const entry = (over) => ({ oldPath: null, newPath: null, path: null, status: 'M', similarity: null, binary: false, added: [], removed: [], ...over });
const modified = (path, { added = [], removed = [], addedAt = 1, removedAt = 1 } = {}) =>
  entry({ oldPath: path, newPath: path, path, added: numbered(added, addedAt), removed: numbered(removed, removedAt) });
const created = (path, added) => entry({ newPath: path, path, status: 'A', added: numbered(added) });
const deleted = (path, removed = []) => entry({ oldPath: path, path, status: 'D', removed: numbered(removed) });
const renamed = (oldPath, newPath, { added = [], removed = [] } = {}) =>
  entry({ oldPath, newPath, path: newPath, status: 'R', similarity: 100, added: numbered(added), removed: numbered(removed) });
const check = (files, labels) => checkIntegrity({ files, config, labels });
const rules = (r) => r.violations.map((v) => v.rule);
const CLEAN = { ok: true, overridden: false, violations: [] };

test('1. deleted test file is test-deleted (and its removed assertions are not double-reported)', () => {
  const r = check([deleted('lib/a.test.ts', ["it('x', () => {", '  expect(a).toBe(1);', '});'])]);
  assert.equal(r.ok, false);
  assert.equal(r.overridden, false);
  assert.deepEqual(r.violations, [{ rule: 'test-deleted', file: 'lib/a.test.ts', excerpt: 'deleted test file' }]);
});

test('2. renaming a test file to a non-test path is test-deleted', () => {
  const r = check([renamed('lib/a.test.ts', 'lib/a.ts')]);
  assert.equal(r.ok, false);
  assert.deepEqual(r.violations, [
    { rule: 'test-deleted', file: 'lib/a.test.ts', excerpt: 'renamed to lib/a.ts, which is not a test file' },
  ]);
});

test('3. renaming a test file to another test path with no edits is ok', () => {
  assert.deepEqual(check([renamed('lib/a.test.ts', 'lib/b.test.ts')]), CLEAN);
});

test('4. an added it.skip is skip-or-only-added', () => {
  const r = check([modified('lib/a.test.ts', { added: ["it.skip('x', () => {"], addedAt: 12 })]);
  assert.equal(r.ok, false);
  assert.deepEqual(r.violations, [{ rule: 'skip-or-only-added', file: 'lib/a.test.ts', line: 12, excerpt: "it.skip('x', () => {" }]);
});

test('5. an added describe.only is a violation', () => {
  assert.deepEqual(rules(check([modified('lib/a.test.ts', { added: ["describe.only('suite', () => {"] })])), ['skip-or-only-added']);
});

test('6. an added test.fixme is a violation', () => {
  assert.deepEqual(rules(check([modified('e2e/a.spec.ts', { added: ["  test.fixme('flaky', async () => {"] })])), ['skip-or-only-added']);
});

test('7. an added xit is a violation', () => {
  assert.deepEqual(rules(check([modified('lib/a.test.ts', { added: ["xit('x', () => {});"] })])), ['skip-or-only-added']);
});

test('8. .skip( in a non-test source file is ok', () => {
  assert.deepEqual(check([modified('lib/list.ts', { added: ['const rest = arr.skip(2);'] })]), CLEAN);
});

test('9. lowering a vitest coverage threshold (80 -> 70) is coverage-lowered', () => {
  const r = check([modified('vitest.config.ts', { removed: ['      lines: 80,'], added: ['      lines: 70,'], removedAt: 14, addedAt: 14 })]);
  assert.equal(r.ok, false);
  assert.deepEqual(r.violations, [
    { rule: 'coverage-lowered', file: 'vitest.config.ts', line: 14, excerpt: 'lines: 80, [now lines 70]' },
  ]);
});

test('10. raising a vitest coverage threshold (70 -> 80) is ok', () => {
  assert.deepEqual(check([modified('vitest.config.ts', { removed: ['      lines: 70,'], added: ['      lines: 80,'] })]), CLEAN);
});

test('11. editing an assertion in an existing test with no new test case is assertions-edited', () => {
  const r = check([modified('lib/a.test.ts', { removed: ['  expect(x).toBe(1);'], added: ['  expect(x).toBe(2);'], removedAt: 7, addedAt: 7 })]);
  assert.equal(r.ok, false);
  assert.deepEqual(r.violations, [{ rule: 'assertions-edited', file: 'lib/a.test.ts', line: 7, excerpt: 'expect(x).toBe(1);' }]);
});

test('12. the same assertion edit plus an added it(...) test case is ok', () => {
  const r = check([
    modified('lib/a.test.ts', {
      removed: ['  expect(x).toBe(1);'],
      added: ['  expect(x).toBe(2);', '', "it('handles y', () => {", '  expect(y).toBe(3);', '});'],
    }),
  ]);
  assert.deepEqual(r, CLEAN);
});

test('13. a newly added test file alone is ok', () => {
  assert.deepEqual(check([created('lib/new.test.ts', ["it('works', () => {", '  expect(1).toBe(1);', '});'])]), CLEAN);
});

test('14. a non-test source change alone is ok, even if it drops assertion-looking lines', () => {
  assert.deepEqual(check([modified('lib/a.ts', { removed: ['  assert(x > 0);', '  expect(y);'], added: ['  return x;'] })]), CLEAN);
});

test('15. pgTAP SELECT skip(...) added to a supabase test is a violation', () => {
  const r = check([modified('supabase/tests/rls.test.sql', { added: ["SELECT skip('later');"] })]);
  assert.equal(r.ok, false);
  assert.deepEqual(rules(r), ['skip-or-only-added']);
});

test('16. label test-change-approved makes it ok + overridden but still lists the violations', () => {
  const r = check([deleted('lib/a.test.ts'), modified('lib/b.test.ts', { added: ["it.skip('x', () => {})"] })], ['bug', 'test-change-approved']);
  assert.equal(r.ok, true);
  assert.equal(r.overridden, true);
  assert.deepEqual(rules(r), ['test-deleted', 'skip-or-only-added']);
});

test('17. removing a whole it(...) block with no new tests is assertions-edited', () => {
  const r = check([modified('lib/a.test.ts', { removed: ["it('adds', () => {", '  expect(a).toBe(b);', '});'], removedAt: 20 })]);
  assert.deepEqual(r.violations, [{ rule: 'assertions-edited', file: 'lib/a.test.ts', line: 21, excerpt: 'expect(a).toBe(b);' }]);
  // Same when the whole block sits on one line.
  assert.deepEqual(rules(check([modified('lib/a.test.ts', { removed: ["it('adds', () => { expect(a).toBe(b); });"] })])), ['assertions-edited']);
});

test('18. removing only commented-out assertions is ok', () => {
  assert.deepEqual(check([modified('lib/a.test.ts', { removed: ['  // expect(old).toBe(1);', '  # assert old == 1', '  -- SELECT is(old, 1);', '   * expect(old)'] })]), CLEAN);
});

test('19. pyproject fail_under 90 -> 80 is coverage-lowered', () => {
  const r = check([modified('pyproject.toml', { removed: ['fail_under = 90'], added: ['fail_under = 80'] })]);
  assert.equal(r.ok, false);
  assert.deepEqual(rules(r), ['coverage-lowered']);
  assert.equal(r.violations[0].file, 'pyproject.toml');
});

test('20. removing the coverageThreshold block from jest.config.js with nothing added is coverage-lowered', () => {
  const r = check([
    modified('jest.config.js', { removed: ['  coverageThreshold: {', '    global: { lines: 80 },', '  },'], removedAt: 5 }),
  ]);
  assert.equal(r.ok, false);
  assert.ok(r.violations.length >= 1);
  assert.ok(r.violations.every((v) => v.rule === 'coverage-lowered'));
  assert.ok(r.violations.some((v) => v.line === 5 && v.excerpt.startsWith('coverageThreshold')));
  // The same removal while the key is still present in an added line is not a removal.
  assert.deepEqual(check([modified('jest.config.js', { removed: ['  coverageThreshold: {'], added: ['  coverageThreshold: {'] })]), CLEAN);
});

test('21. @pytest.mark.skip added in tests/test_x.py is a violation', () => {
  const r = check([modified('tests/test_x.py', { added: ['@pytest.mark.skip(reason="later")', 'def test_y():'] })]);
  assert.deepEqual(rules(r), ['skip-or-only-added']);
});

test('22. deleting e2e/smoke/login.spec.ts is test-deleted', () => {
  const r = check([deleted('e2e/smoke/login.spec.ts')]);
  assert.deepEqual(rules(r), ['test-deleted']);
  assert.equal(r.violations[0].file, 'e2e/smoke/login.spec.ts');
});

test('23. custom integrity.test_globs decide what a test file is', () => {
  const custom = { integrity: { test_globs: ['spec/**'] } };
  const run = (files) => checkIntegrity({ files, config: custom });
  assert.equal(isTestFile('spec/a.rb', custom), true);
  assert.equal(isTestFile('lib/a.test.ts', custom), false);
  assert.deepEqual(rules(run([deleted('spec/a.rb')])), ['test-deleted']);
  assert.deepEqual(run([deleted('lib/a.test.ts')]), CLEAN);
});

// ---- beyond the 23 required cases ----

test('isTestFile follows the default globs and tolerates a missing path', () => {
  for (const p of ['a.test.ts', 'src/a.spec.js', 'src/__tests__/a.ts', 'test/helpers.ts', 'pkg/tests/a.py', 'e2e/smoke/a.ts', 'supabase/tests/a.sql']) {
    assert.equal(isTestFile(p, config), true, p);
  }
  for (const p of ['lib/a.ts', 'src/testing-utils.ts', 'docs/latest.md', 'contest/a.ts']) assert.equal(isTestFile(p, config), false, p);
  assert.equal(isTestFile(null, config), false);
  assert.equal(isTestFile(undefined, config), false);
});

test('a bad config or bad inputs throw instead of silently checking nothing', () => {
  assert.throws(() => checkIntegrity({ files: [], config: {} }), TypeError);
  assert.throws(() => checkIntegrity({ files: [], config: { integrity: { test_globs: 'spec/**' } } }), TypeError);
  assert.throws(() => checkIntegrity({ files: 'nope', config }), TypeError);
  assert.throws(() => checkIntegrity({ files: [], config, labels: 'test-change-approved' }), TypeError);
});

test('the override label is exact, accepts a Set, and is true even when there is nothing to override', () => {
  assert.equal(check([deleted('lib/a.test.ts')], ['test-change-approved-x', 'Test-Change']).ok, false);
  assert.equal(checkIntegrity({ files: [deleted('lib/a.test.ts')], config, labels: new Set(['test-change-approved']) }).ok, true);
  assert.deepEqual(check([modified('lib/a.ts', { added: ['x'] })], ['test-change-approved']), { ok: true, overridden: true, violations: [] });
});

test('each skip/only marker form is caught, and look-alikes are not', () => {
  const bad = [
    "it.only('x', () => {})", "test.todo('x')", "describe.skip('x', () => {})", "suite.only('x', fn)", "context.skip('x', fn)",
    "it.failing('x', fn)", "xtest('x', fn)", "xdescribe('x', fn)", "fit('x', fn)", "fdescribe('x', fn)", "test.describe.skip('x', fn)",
    "test.describe.only('x', fn)", "  test.skip ('x', fn)", '@pytest.mark.skipif(sys.platform == "win32")', '@pytest.mark.xfail', 'pytest.skip("later")',
    '@unittest.skip("later")', 't.Skip("later")', 't.Skipf("later %d", n)', 't.SkipNow()',
  ];
  for (const text of bad) assert.deepEqual(rules(check([modified('lib/a.test.ts', { added: [text] })])), ['skip-or-only-added'], text);
  const fine = ["it('skips the header row', () => {})", "describe('only admins', () => {})", 'const skipper = 1;', 'const fitted = 1;', "it('x', { retry: 2 }, fn)"];
  for (const text of fine) assert.deepEqual(check([modified('lib/a.test.ts', { added: [text] })]), CLEAN, text);
});

test('pgTAP skip()/todo() are caught only in sql test files; look-alikes are not', () => {
  for (const text of ["SELECT todo('later', 2);", 'select SKIP(1, $$why$$);', "SELECT todo_start('later');"]) {
    assert.deepEqual(rules(check([modified('supabase/tests/a.test.sql', { added: [text] })])), ['skip-or-only-added'], text);
  }
  assert.deepEqual(check([modified('supabase/tests/a.test.sql', { added: ['SELECT skipped_rows FROM t;', "SELECT has_table('x');"] })]), CLEAN);
  assert.deepEqual(check([modified('db/migrate.sql', { added: ["SELECT skip('x');"] })]), CLEAN);
  // A bare skip( in a JS test is not one of the JS markers.
  assert.deepEqual(check([modified('lib/a.test.ts', { added: ["await skip('x');"] })]), CLEAN);
});

test('an added line is reported with its new-file number and an excerpt trimmed to 120 chars', () => {
  const long = `    xit('${'very long name '.repeat(20)}', () => {});   `;
  const r = check([modified('lib/a.test.ts', { added: [long], addedAt: 40 })]);
  assert.equal(r.violations[0].line, 40);
  assert.ok(r.violations[0].excerpt.length <= 120);
  assert.ok(r.violations[0].excerpt.startsWith("xit('very long name"));
  assert.equal(r.violations[0].excerpt, r.violations[0].excerpt.trim());
});

test('rename between test files WITH removed assertions and no new test is assertions-edited', () => {
  const r = check([renamed('lib/a.test.ts', 'lib/b.test.ts', { removed: ['expect(a).toBe(1);'], added: ['expect(a).toBe(2);'] })]);
  assert.deepEqual(r.violations, [{ rule: 'assertions-edited', file: 'lib/b.test.ts', line: 1, excerpt: 'expect(a).toBe(1);' }]);
});

test('a new test case anywhere in the diff satisfies assertions-edited, including in another test file', () => {
  const edit = modified('lib/a.test.ts', { removed: ['expect(a).toBe(1);'], added: ['expect(a).toBe(2);'] });
  for (const extra of [
    created('lib/b.test.ts', ["test('new', () => {})"]),
    created('tests/test_z.py', ['def test_z():']),
    created('tests/z_test.go', ['func TestZ(t *testing.T) {']),
    created('supabase/tests/z.test.sql', ["SELECT results_eq('a', 'b');"]),
    created('lib/c.test.ts', ["test.each([1, 2])('adds %i', (n) => {})"]),
  ]) {
    assert.deepEqual(check([edit, extra]), CLEAN, extra.path);
  }
});

test('things that look like a new test case but are not do not satisfy assertions-edited', () => {
  const edit = modified('lib/a.test.ts', { removed: ['expect(a).toBe(1);'] });
  for (const extra of [
    modified('lib/b.test.ts', { added: ["// it('commented out', () => {})"] }), // comment
    created('lib/c.test.ts', ['export const fixture = 1;']), // new test file with no test case in it
    modified('lib/d.ts', { added: ["it('not a test file', () => {})"] }), // not a test file
    modified('lib/e.test.ts', { added: ["it.skip('skipped', () => {})"] }), // skipped (also flagged by its own rule)
  ]) {
    assert.ok(rules(check([edit, extra])).includes('assertions-edited'), extra.path);
  }
});

test('plain python assert and go t.Errorf count as assertions', () => {
  assert.deepEqual(rules(check([modified('tests/test_a.py', { removed: ['    assert result == 5'] })])), ['assertions-edited']);
  assert.deepEqual(rules(check([modified('tests/a_test.go', { removed: ['\tt.Errorf("got %d", got)'] })])), ['assertions-edited']);
  assert.deepEqual(check([modified('tests/test_a.py', { removed: ['    assert result == 5'], added: ['def test_new():'] })]), CLEAN);
});

test('coverage: several thresholds on one line are compared key by key', () => {
  const down = check([modified('jest.config.js', { removed: ['  global: { lines: 80, branches: 70 },'], added: ['  global: { lines: 80, branches: 60 },'] })]);
  assert.deepEqual(rules(down), ['coverage-lowered']);
  assert.match(down.violations[0].excerpt, /\[now branches 60\]$/);
  assert.deepEqual(check([modified('jest.config.js', { removed: ['  global: { lines: 80, branches: 70 },'], added: ['  global: { lines: 80, branches: 75 },'] })]), CLEAN);
});

test('coverage: raising two thresholds of the same key is not flagged, lowering one of them is', () => {
  const removed = ['global: { lines: 80 }', 'src/: { lines: 90 }'];
  assert.deepEqual(check([modified('jest.config.js', { removed, added: ['global: { lines: 85 }', 'src/: { lines: 95 }'] })]), CLEAN);
  assert.deepEqual(rules(check([modified('jest.config.js', { removed, added: ['global: { lines: 85 }', 'src/: { lines: 85 }'] })])), ['coverage-lowered']);
});

test('coverage: decimals, quoted JSON keys, percent strings and = / whitespace separators', () => {
  const lowered = [
    ['.coveragerc', 'fail_under = 90.5', 'fail_under = 90'],
    ['package.json', '    "lines": 80,', '    "lines": 79.9,'],
    ['.nycrc.json', '  "branches": "80%"', '  "branches": "70%"'],
    ['pytest.ini', 'addopts = --cov-fail-under 90', 'addopts = --cov-fail-under=85'],
    ['codecov.yml', '      target: 80%', '      target: 70%'],
    ['setup.cfg', 'statements=100', 'statements=95'],
    ['vitest.workspace.ts', "  '--coverage.thresholds.functions=80'", "  '--coverage.thresholds.functions=60'"],
  ];
  for (const [path, from, to] of lowered) {
    assert.deepEqual(rules(check([modified(path, { removed: [from], added: [to] })])), ['coverage-lowered'], path);
  }
  assert.deepEqual(check([modified('package.json', { removed: ['    "lines": 80,'], added: ['    "lines": 80.5,'] })]), CLEAN);
});

test('coverage: dropping a threshold line or flag without a replacement is flagged', () => {
  for (const [path, from] of [['vitest.config.ts', '      branches: 70,'], ['setup.cfg', 'addopts = --cov-fail-under=90'], ['codecov.yaml', '      threshold: 1']]) {
    const r = check([modified(path, { removed: [from], added: ['      // gone'] })]);
    assert.deepEqual(rules(r), ['coverage-lowered'], path);
    assert.match(r.violations[0].excerpt, /\[threshold removed\]$/);
  }
  // Deleting the whole config file takes its thresholds with it.
  assert.deepEqual(rules(check([deleted('jest.config.js', ['module.exports = {', '  coverageThreshold: { global: { lines: 80 } },', '};'])])), ['coverage-lowered']);
});

test('coverage: removing a fail_under / thresholds key with no counterpart is flagged, reshaping it within the file is not', () => {
  assert.deepEqual(rules(check([modified('pyproject.toml', { removed: ['[tool.coverage.report]', 'fail_under = 90'] })])), ['coverage-lowered']);
  assert.deepEqual(check([modified('vitest.config.ts', { removed: ['    thresholds: { lines: 80 },'], added: ['    thresholds: {', '      lines: 80,', '    },'] })]), CLEAN);
});

test('coverage: only coverage config files are examined; commented-out lines are ignored', () => {
  assert.deepEqual(check([modified('lib/config.ts', { removed: ['lines: 80'], added: ['lines: 10'] })]), CLEAN);
  assert.deepEqual(check([modified('jest.config.js', { removed: ['  // lines: 80', '  /* coverageThreshold */', '   * branches: 90'] })]), CLEAN);
  // Nested package.json and the other common homes of coverage config count too.
  for (const path of ['packages/web/package.json', 'apps/api/vite.config.ts', 'tox.ini', 'ci/jest.config.cjs', '.github/codecov.yml']) {
    assert.deepEqual(rules(check([modified(path, { removed: ['lines: 80'], added: ['lines: 70'] })])), ['coverage-lowered'], path);
  }
});

test('coverage: keys that merely contain a threshold key are not thresholds', () => {
  const pairs = [['max-lines: 300', 'max-lines: 200'], ['"linesCovered": 90', '"linesCovered": 80'], ['lines-ignored: 5', 'lines-ignored: 3'], ['thresholds_note: 5', 'thresholds_note: 1']];
  for (const [from, to] of pairs) assert.deepEqual(check([modified('package.json', { removed: [from], added: [to] })]), CLEAN, from);
});

test('coverage: a renamed config file is still examined', () => {
  const r = check([renamed('jest.config.js', 'jest.config.cjs', { removed: ['  lines: 80,'], added: ['  lines: 50,'] })]);
  assert.deepEqual(rules(r), ['coverage-lowered']);
  assert.equal(r.violations[0].file, 'jest.config.cjs');
});

test('rules combine and keep their order: deleted, skip, coverage, assertions', () => {
  const r = check([
    modified('lib/z.test.ts', { removed: ['expect(a).toBe(1);'], added: ["xit('x', fn);"] }),
    modified('jest.config.js', { removed: ['lines: 80'], added: ['lines: 10'] }),
    deleted('lib/gone.test.ts'),
  ]);
  assert.equal(r.ok, false);
  assert.deepEqual(rules(r), ['test-deleted', 'skip-or-only-added', 'coverage-lowered', 'assertions-edited']);
});

test('binary files and an empty file list are handled', () => {
  assert.deepEqual(check([]), CLEAN);
  assert.deepEqual(check([entry({ oldPath: 'e2e/a.png', newPath: 'e2e/a.png', path: 'e2e/a.png', binary: true })]), CLEAN);
});
