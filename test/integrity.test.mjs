import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkIntegrity, isTestFile, isDocFile } from '../pipeline/lib/integrity.mjs';
import { DEFAULTS } from '../pipeline/lib/config.mjs';

// `files` are built inline in the shape parseUnifiedDiff returns, so these tests never run git.
const config = { integrity: { test_globs: DEFAULTS.integrity.test_globs } };
const numbered = (texts, start = 1) => texts.map((text, i) => ({ line: start + i, text }));
const entry = (over) => ({ oldPath: null, newPath: null, path: null, status: 'M', similarity: null, binary: false, added: [], removed: [], ...over });
const modified = (path, { added = [], removed = [], addedAt = 1, removedAt = 1 } = {}) =>
  entry({ oldPath: path, newPath: path, path, added: numbered(added, addedAt), removed: numbered(removed, removedAt) });
const binary = (status, path) =>
  entry({ oldPath: status === 'A' ? null : path, newPath: status === 'D' ? null : path, path, status, binary: true });
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

test('11. weakening an assertion in an existing test (toBe -> toBeDefined on the same subject) is assertions-edited', () => {
  const r = check([modified('lib/a.test.ts', { removed: ['  expect(x).toBe(1);'], added: ['  expect(x).toBeDefined();'], removedAt: 7, addedAt: 7 })]);
  assert.equal(r.ok, false);
  assert.deepEqual(r.violations, [
    { rule: 'assertions-edited', file: 'lib/a.test.ts', line: 7, excerpt: 'expect(x).toBe(1); [weaker matcher: toBeDefined]' },
  ]);
  // Same strength (a new expected value) is allowed by the per-file count: a value edit cannot be told from a legit update.
  assert.deepEqual(check([modified('lib/a.test.ts', { removed: ['  expect(x).toBe(1);'], added: ['  expect(x).toBe(2);'] })]), CLEAN);
});

test('12. the same assertion edit plus an added it(...) test case in that file is ok', () => {
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

test('17. removing a whole it(...) block with no new tests is assertions-edited and test-cases-removed', () => {
  const r = check([modified('lib/a.test.ts', { removed: ["it('adds', () => {", '  expect(a).toBe(b);', '});'], removedAt: 20 })]);
  assert.deepEqual(r.violations, [
    { rule: 'assertions-edited', file: 'lib/a.test.ts', line: 21, excerpt: 'expect(a).toBe(b); [net -1 assertions]' },
    { rule: 'test-cases-removed', file: 'lib/a.test.ts', line: 20, excerpt: "it('adds', () => { [net -1 test cases]" },
  ]);
  // Same when the whole block sits on one line.
  assert.deepEqual(rules(check([modified('lib/a.test.ts', { removed: ["it('adds', () => { expect(a).toBe(b); });"] })])), ['assertions-edited', 'test-cases-removed']);
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

test('default test globs cover go, python, ruby and cypress layouts', () => {
  for (const p of ['pkg/a_test.go', 'a_test.go', 'src/test_a.py', 'test_a.py', 'src/a_test.py', 'conftest.py', 'api/conftest.py', 'models/a_spec.rb', 'spec/models/a.rb', 'cypress/e2e/a.ts', 'src/login.cy.ts', 'login.cy.js']) {
    assert.equal(isTestFile(p, config), true, p);
  }
  for (const p of ['src/latest.py', 'src/contest.py', 'src/a_test_helper.go', 'lib/spec_helper.rb', 'src/cypress.ts', 'docs/specs/a.md']) assert.equal(isTestFile(p, config), false, p);
  for (const g of ['**/*_test.go', '**/test_*.py', '**/*_test.py', '**/conftest.py', '**/*_spec.rb', 'spec/**', 'cypress/**', '**/*.cy.*']) {
    assert.ok(DEFAULTS.integrity.test_globs.includes(g), g);
  }
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

test('each skip/only/focus marker form is caught, and look-alikes are not', () => {
  const bad = [
    "it.only('x', () => {})", "test.todo('x')", "describe.skip('x', () => {})", "suite.only('x', fn)", "context.skip('x', fn)",
    "it.failing('x', fn)", "xtest('x', fn)", "xdescribe('x', fn)", "fit('x', fn)", "fdescribe('x', fn)", "test.describe.skip('x', fn)",
    "test.describe.only('x', fn)", "  test.skip ('x', fn)", '@pytest.mark.skipif(sys.platform == "win32")', '@pytest.mark.xfail', 'pytest.skip("later")',
    '@unittest.skip("later")', 't.Skip("later")', 't.Skipf("later %d", n)', 't.SkipNow()',
    "fcontext('x', fn)", "xcontext('x', fn)", 'const run = ci ? it : it.skip;', "describe.skipIf(!process.env.DB)('x', fn)",
    "it.runIf(cond)('x', fn)", "it.concurrent.skip('x', fn)", "test.describe.parallel.only('x', fn)", "it['skip']('x', fn)", "test['only']('x', fn)",
    'this.skip();', 't.skip();', "pending('later');", "it('x', { skip: true }, fn)", "test.fail('x', fn)", "test.fails('x', fn)",
    'raise unittest.SkipTest("x")', 'raise SkipTest', 'self.skipTest("x")',
  ];
  for (const text of bad) assert.deepEqual(rules(check([modified('lib/a.test.ts', { added: [text] })])), ['skip-or-only-added'], text);
  const fine = [
    "it('skips the header row', () => {})", "describe('only admins', () => {})", 'const skipper = 1;', 'const fitted = 1;', "it('x', { retry: 2 }, fn)",
    "it.each([1, 2])('adds %i', fn)", 'expect(list.skip).toBe(2);', 'const skipRows = 2;', 'const opts = { skip: false };', 'const pendingCount = 1;',
    'await getPending(1);', "test.use({ locale: 'fr' });", "it.concurrent('x', fn)", "describe.each([1])('x', fn)", 'await skipRows(2);',
  ];
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

test('an excerpt cut inside an emoji does not leave a lone surrogate', () => {
  const line = "xit('" + 'x'.repeat(111) + '\u{1F600}'.repeat(5) + "', fn);";
  const { excerpt } = check([modified('lib/a.test.ts', { added: [line] })]).violations[0];
  assert.ok(excerpt.length <= 120);
  assert.doesNotMatch(excerpt, /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/);
});

test('rename between test files WITH net removed assertions is assertions-edited', () => {
  const r = check([renamed('lib/a.test.ts', 'lib/b.test.ts', { removed: ['expect(a).toBe(1);'] })]);
  assert.deepEqual(r.violations, [{ rule: 'assertions-edited', file: 'lib/b.test.ts', line: 1, excerpt: 'expect(a).toBe(1); [net -1 assertions]' }]);
  assert.deepEqual(check([renamed('lib/a.test.ts', 'lib/b.test.ts', { removed: ['expect(a).toBe(1);'], added: ['expect(a).toBe(2);'] })]), CLEAN);
});

test('a new test case elsewhere in the diff does NOT excuse removed assertions or removed test cases', () => {
  const edit = modified('lib/a.test.ts', { removed: ["it('a', () => {", 'expect(a).toBe(1);', '});'] });
  for (const extra of [
    created('lib/b.test.ts', ["test('new', () => {})"]),
    created('tests/test_z.py', ['def test_z():']),
    created('tests/z_test.go', ['func TestZ(t *testing.T) {']),
    created('supabase/tests/z.test.sql', ["SELECT results_eq('a', 'b');"]),
    modified('lib/c.test.ts', { added: ["it('empty', () => {})"] }),
  ]) {
    assert.deepEqual(rules(check([edit, extra])), ['assertions-edited', 'test-cases-removed'], extra.path);
  }
});

test('net per file: more assertions removed than added is flagged, an empty test in the same file does not help', () => {
  const removed = ['expect(a).toBe(1);', 'expect(b).toBe(2);'];
  const r = check([modified('lib/a.test.ts', { removed, added: ['expect(a).toBe(1);'], removedAt: 3 })]);
  assert.deepEqual(r.violations, [{ rule: 'assertions-edited', file: 'lib/a.test.ts', line: 3, excerpt: 'expect(a).toBe(1); [net -1 assertions]' }]);
  const padded = check([modified('lib/a.test.ts', { removed, added: ['expect(a).toBe(1);', "it('noop', () => {});"] })]);
  assert.deepEqual(rules(padded), ['assertions-edited']);
  // Equal counts (reordered, re-valued, reflowed) are fine, and so is adding more.
  assert.deepEqual(check([modified('lib/a.test.ts', { removed, added: ['expect(b).toBe(3);', 'expect(a).toBe(1);'] })]), CLEAN);
  assert.deepEqual(check([modified('lib/a.test.ts', { removed, added: ['expect(a).toBe(1);', 'expect(b).toBe(2);', 'expect(c).toBe(3);'] })]), CLEAN);
});

test('net per file: more test cases removed than added is test-cases-removed, renaming one is not', () => {
  const r = check([modified('lib/a.test.ts', { removed: ["it('a', () => {", "it('b', () => {"], added: ["test('c', () => {"], removedAt: 4 })]);
  assert.deepEqual(r.violations, [{ rule: 'test-cases-removed', file: 'lib/a.test.ts', line: 4, excerpt: "it('a', () => { [net -1 test cases]" }]);
  assert.deepEqual(check([modified('lib/a.test.ts', { removed: ["it('a', () => {"], added: ["it('a renamed', () => {"] })]), CLEAN);
  assert.deepEqual(rules(check([modified('tests/test_a.py', { removed: ['def test_a():'] })])), ['test-cases-removed']);
});

test('test-case lines recognised when removed: test.each, go func Test, pgTAP', () => {
  const cases = [
    ['lib/a.test.ts', "test.each([1, 2])('adds %i', (n) => {"], ['lib/a.test.ts', "specify('x', () => {"], ['tests/z_test.go', 'func TestZ(t *testing.T) {'],
    ['tests/test_a.py', 'def test_a(self):'], ['lib/a.test.ts', 'it(`templated`, () => {'],
  ];
  for (const [path, text] of cases) assert.deepEqual(rules(check([modified(path, { removed: [text] })])), ['test-cases-removed'], text);
});

test('net per file: added comments count as neither assertions nor test cases', () => {
  for (const c of ['// expect(a).toBe(1);', '# assert a == 1', '-- SELECT is(a, 1);', ' * expect(a).toBe(1)']) {
    assert.deepEqual(rules(check([modified('lib/a.test.ts', { removed: ['expect(a).toBe(1);'], added: [c] })])), ['assertions-edited'], c);
  }
  assert.deepEqual(rules(check([modified('lib/a.test.ts', { removed: ["it('a', () => {"], added: ["// it('a', () => {"] })])), ['test-cases-removed']);
  // A skipped test is not a test case either.
  assert.deepEqual(rules(check([modified('lib/a.test.ts', { removed: ["it('a', () => {"], added: ["it.skip('a', () => {"] })])), ['skip-or-only-added', 'test-cases-removed']);
});

test('weaker matcher on the same subject is flagged for every strong -> weak pair', () => {
  const pairs = [
    ['expect(a).toBe(1);', 'expect(a).toBeDefined();', 'toBeDefined'],
    ['expect(a).toEqual({ x: 1 });', 'expect(a).toBeTruthy();', 'toBeTruthy'],
    ['expect(a).toStrictEqual([1]);', "expect(a).toBeTypeOf('object');", 'toBeTypeOf'],
    ['expect(s).toMatch(/abc/);', 'expect(s).toBeTruthy();', 'toBeTruthy'],
    ["expect(fn).toThrow('boom');", 'expect(fn).not.toThrow();', 'not.toThrow'],
    ['expect(spy).toHaveBeenCalledWith(1);', 'expect(spy).toHaveBeenCalled();', 'toHaveBeenCalled'],
    ['expect(a).toBe(1);', 'expect(a).not.toBe(2);', 'not.toBe'],
    ['await expect(load(1, "x)")).resolves.toBe(3);', 'await expect( load(1, "x)") ).resolves.toBeDefined();', 'toBeDefined'],
  ];
  for (const [from, to, name] of pairs) {
    const r = check([modified('lib/a.test.ts', { removed: [from], added: [to], removedAt: 9 })]);
    assert.deepEqual(r.violations, [{ rule: 'assertions-edited', file: 'lib/a.test.ts', line: 9, excerpt: `${from} [weaker matcher: ${name}]` }], from);
  }
});

test('weaker matcher: same subject matches across internal whitespace, and a net-flagged file is reported once', () => {
  const r = check([modified('lib/a.test.ts', { removed: ['expect(a +  b).toBe(1);'], added: ['expect(a + b).toBeDefined();'] })]);
  assert.deepEqual(rules(r), ['assertions-edited']);
  const net = check([modified('lib/a.test.ts', { removed: ['expect(a).toBe(1);', 'expect(b).toBe(2);'], added: ['expect(a).toBeDefined();'] })]);
  assert.deepEqual(net.violations.map((v) => v.excerpt), ['expect(a).toBe(1); [net -1 assertions]']);
});

test('weaker matcher heuristic stays quiet when the subject differs, the strong assertion is kept, or the change is not a weakening', () => {
  const quiet = [
    [['expect(a).toBe(1);'], ['expect(b).toBeDefined();']], // different subject
    [['expect(a).toBe(1);'], ['expect(a).toBe(1);', 'expect(a).toBeDefined();']], // strong kept
    [['expect(a).toBeDefined();'], ['expect(a).toBe(1);']], // strengthened
    [['expect(a).not.toBe(1);'], ['expect(a).toBeDefined();']], // the removed one was not a strong assertion
    [['expect(a).toBe(1);'], ['expect(a).toEqual(1);']], // strong -> strong
    [['expect(a).toBe(1);'], ['expect(a).toHaveLength(1);']], // not in the table
  ];
  for (const [removed, added] of quiet) assert.deepEqual(check([modified('lib/a.test.ts', { removed, added })]), CLEAN, removed[0]);
});

test('binary-test-file: a large binary diffFiles skipped is judged like any binary diff: its deletion is only test-deleted, its addition or edit is flagged', () => {
  const skipped = (e) => ({ ...e, skippedLargeBinary: true });
  assert.deepEqual(rules(check([skipped(binary('D', 'tests/fixtures/old.xlsx'))])), ['test-deleted']);
  for (const status of ['A', 'M']) assert.deepEqual(rules(check([skipped(binary(status, 'tests/fixtures/new.xlsx'))])), ['binary-test-file'], status);
});

test('binary-test-file: a binary diff in a test-glob file is flagged unless its extension is a known asset type', () => {
  for (const [status, path] of [['M', 'lib/a.test.ts'], ['A', 'e2e/data.xlsx'], ['M', 'tests/fixtures/report.pdf'], ['A', 'supabase/tests/x.test.sql']]) {
    const r = check([binary(status, path)]);
    assert.deepEqual(rules(r), ['binary-test-file'], path);
    assert.equal(r.violations[0].file, path);
    assert.equal(r.violations[0].line, undefined);
    assert.match(r.violations[0].excerpt, /binary/);
  }
  for (const path of ['e2e/a.png', 'e2e/A.PNG', 'tests/a.jpg', 'tests/a.jpeg', 'tests/a.gif', 'tests/a.webp', 'tests/a.svg', 'tests/a.ico', 'e2e/__snapshots__/a.snap', 'tests/a.bin', 'tests/a.zip', 'tests/a.gz', 'tests/a.wasm']) {
    assert.deepEqual(check([binary('M', path)]), CLEAN, path);
  }
  assert.deepEqual(check([binary('M', 'lib/logo.xlsx')]), CLEAN); // not a test file
  assert.deepEqual(rules(check([binary('D', 'tests/data.xlsx')])), ['test-deleted']); // a deletion is test-deleted, nothing to inspect
});

test('test-neutered: wrappers that stop tests from running are flagged only in test files', () => {
  for (const text of ['if (false) {', '  if ( 0 ) {', 'process.exit(0);', '  process.exit( 0 )', 'sys.exit(0)', '    sys.exit( 0 )']) {
    const r = check([modified('lib/a.test.ts', { added: [text], addedAt: 5 })]);
    assert.deepEqual(r.violations, [{ rule: 'test-neutered', file: 'lib/a.test.ts', line: 5, excerpt: text.trim() }], text);
  }
  for (const text of ['if (falsey) {', 'if (0 < n) {', 'process.exit(1);', 'sys.exit(1)', 'process.exitCode = 0;', 'if (!ready) return;']) {
    assert.deepEqual(check([modified('lib/a.test.ts', { added: [text] })]), CLEAN, text);
  }
  assert.deepEqual(check([modified('lib/a.ts', { added: ['process.exit(0);', 'if (false) {'] })]), CLEAN);
});

test('renames: a test file renamed so it stops running as a test is test-deleted', () => {
  const flagged = [
    ['lib/a.test.ts', 'lib/a.test.ts.disabled'], ['lib/a.test.ts', 'lib/a.test.md'], ['lib/a.test.ts', 'lib/a.test.TSX'],
    ['test/a.test.ts', 'test/a.ts'], ['e2e/a.spec.ts', 'e2e/a.ts'], ['tests/a_test.go', 'tests/a.go'],
    ['tests/test_a.py', 'tests/test_a.py.bak'], ['src/__tests__/a.ts', 'src/__tests__/a.ts.off'], ['tests/a.ts', 'test/a.ts'],
  ];
  for (const [from, to] of flagged) {
    const r = check([renamed(from, to)]);
    assert.deepEqual(rules(r), ['test-deleted'], `${from} -> ${to}`);
    assert.equal(r.violations[0].file, from);
  }
  const fine = [
    ['lib/a.test.ts', 'lib/sub/a.test.ts'], ['lib/a.test.ts', 'test/a.test.ts'], ['lib/a.test.ts', 'lib/a.spec.ts'],
    ['src/__tests__/a.ts', 'src/__tests__/sub/a.ts'], ['e2e/a.spec.ts', 'e2e/smoke/a.spec.ts'], ['tests/test_a.py', 'tests/test_b.py'], ['lib/a.test.TS', 'lib/a.test.ts'],
  ];
  for (const [from, to] of fine) assert.deepEqual(check([renamed(from, to)]), CLEAN, `${from} -> ${to}`);
});

test('runner-config-changed: touching what tests are collected, ignored or enforced needs the label', () => {
  const lines = [
    ['vitest.config.ts', "    include: ['src/**/*.test.ts'],"], ['vitest.config.mts', "    exclude: ['e2e/**'],"],
    ['jest.config.js', "  testMatch: ['**/*.test.js'],"], ['jest.config.js', '  testRegex: "x",'],
    ['jest.config.ts', "  testPathIgnorePatterns: ['/old/'],"], ['jest.config.ts', "  collectCoverageFrom: ['src/**'],"],
    ['playwright.config.ts', '  forbidOnly: false,'], ['vitest.config.ts', '    passWithNoTests: true,'], ['playwright.config.ts', "  testIgnore: '**/slow/**',"],
    ['cypress.config.ts', "  excludeSpecPattern: ['a'],"], ['vitest.workspace.ts', "  'coverage.enabled'"],
    ['package.json', '    "test": "vitest run --passWithNoTests",'], ['packages/web/package.json', '    "test": "echo ok",'],
    ['pytest.ini', 'testpaths = tests'], ['pyproject.toml', 'addopts = "--ignore=tests/slow"'],
    ['setup.cfg', 'testpaths = tests'], ['tox.ini', 'commands = pytest --ignore=tests/x'],
    ['.nycrc.json', '  "exclude": ["a"],'], ['.nycrc', 'check-coverage: false'], ['.coveragerc', 'check-coverage = no'],
    ['codecov.yml', '  enabled: false'], ['codecov.yaml', '  "enabled": false'],
  ];
  for (const [path, text] of lines) {
    const added = check([modified(path, { added: [text], addedAt: 8 })]);
    assert.deepEqual(added.violations, [{ rule: 'runner-config-changed', file: path, line: 8, excerpt: `${text.trim()} [added]` }], `+ ${path}`);
    const removed = check([modified(path, { removed: [text], removedAt: 8 })]);
    assert.deepEqual(removed.violations, [{ rule: 'runner-config-changed', file: path, line: 8, excerpt: `${text.trim()} [removed]` }], `- ${path}`);
  }
  // A change reports both sides, removed lines first.
  const both = check([modified('vitest.config.ts', { removed: ["include: ['a'],"], added: ["include: ['b'],"] })]);
  assert.deepEqual(both.violations.map((v) => v.excerpt), ["include: ['a'], [removed]", "include: ['b'], [added]"]);
});

test('runner-config-changed: unrelated lines, comments, other files and look-alike words are not flagged', () => {
  assert.deepEqual(check([modified('vitest.config.ts', { added: ['    globals: true,', '  // include: tests only'], removed: ['    /* exclude: x */'] })]), CLEAN);
  assert.deepEqual(check([modified('package.json', { added: ['    "version": "1.2.4",', '    "description": "includes things, excluded none",'] })]), CLEAN);
  assert.deepEqual(check([modified('lib/config.ts', { added: ["include: ['a'],", '"test": 1'] })]), CLEAN);
  assert.deepEqual(check([modified('jest.config.js', { added: ['  coverageDirectory: "cov",', '  testTimeout: 10000,', '  myexclude: 1,', '  superforbidOnly: 1,'] })]), CLEAN);
});

test('every assertion form is recognised when removed (jest, chai, tape, pgTAP, unittest, node:assert, go, python)', () => {
  const only = [
    "cy.get('.x').should('exist')", 't.is(a, 1);', 't.ok(a);', 't.equal(a, 1);', 't.deepEqual(a, b);', 't.throws(fn);', 't.notOk(a);',
    'assert.equal(a, 1);', 'assertEquals(a, 1);', 'assert(a);', 'assertThat(a);', 'self.assertEqual(a, 1)', 'self.assertTrue(a)',
    '    assert result == 5', 'assert (a == 1)', 'SELECT isnt(a, b);', "SELECT set_eq('a', 'b');", "SELECT has_table('t');",
    'ok(a);', 'is(a, 1);', '\tt.Errorf("got %d", got)', '\tt.Fatalf("x")', '\tt.FailNow()', '\tt.Error("x")', '\tt.Fatal("x")', '\tt.Fail()', 'await expect(page).toHaveURL("/")',
  ];
  for (const text of only) assert.deepEqual(rules(check([modified('lib/a.test.ts', { removed: [text] })])), ['assertions-edited'], text);
  // pgTAP assertions that are also test cases trip both net rules.
  for (const text of ['SELECT is(a, 1);', 'SELECT ok(a);', "SELECT results_eq('a', 'b');", "SELECT lives_ok('x');", "SELECT throws_ok('x');", "SELECT policies_are('t', ARRAY[]::name[]);"]) {
    assert.deepEqual(rules(check([modified('supabase/tests/a.test.sql', { removed: [text] })])), ['assertions-edited', 'test-cases-removed'], text);
  }
  for (const text of ["console.log('x');", 'const issue = 1;', 'const okay = okayish(1);', 'this.isolate(a);', 'assertion = 3;']) {
    assert.deepEqual(check([modified('lib/a.test.ts', { removed: [text] })]), CLEAN, text);
  }
});

test('plain python assert and go t.Errorf count as assertions', () => {
  assert.deepEqual(rules(check([modified('tests/test_a.py', { removed: ['    assert result == 5'] })])), ['assertions-edited']);
  assert.deepEqual(rules(check([modified('tests/a_test.go', { removed: ['\tt.Errorf("got %d", got)'] })])), ['assertions-edited']);
  assert.deepEqual(check([modified('tests/test_a.py', { removed: ['    assert result == 5'], added: ['    assert result == 6'] })]), CLEAN);
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

test('coverage: a gate whose value is not a number (fail-under flag or fail_under key) cannot be dropped', () => {
  for (const [path, text] of [['setup.cfg', 'addopts = --cov-fail-under=${MIN}'], ['pyproject.toml', 'fail_under = $MIN']]) {
    const r = check([modified(path, { removed: [text], added: ['addopts = -q'] })]);
    assert.deepEqual(rules(r), ['coverage-lowered'], path);
    assert.match(r.violations[0].excerpt, /\[threshold removed\]$/);
  }
  assert.deepEqual(check([modified('setup.cfg', { removed: ['addopts = --cov-fail-under=${MIN}'], added: ['addopts = --cov-fail-under=${MIN} -q'] })]), CLEAN);
});

test('coverage: removing a thresholds / coverageThreshold line with no number on it is flagged', () => {
  for (const [path, text] of [['vitest.config.ts', '    thresholds: { autoUpdate: true },'], ['jest.config.js', '  coverageThreshold: global,']]) {
    const r = check([modified(path, { removed: [text] })]);
    assert.deepEqual(rules(r), ['coverage-lowered'], path);
    assert.match(r.violations[0].excerpt, /\[threshold removed\]$/);
  }
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

test('rules combine and keep their order: deleted, binary, skip, neutered, coverage, runner, assertions, test cases', () => {
  const r = check([
    modified('lib/z.test.ts', { removed: ["it('a', () => {", 'expect(a).toBe(1);'], added: ["xit('x', fn);", 'process.exit(0);'] }),
    modified('jest.config.js', { removed: ['lines: 80', 'testMatch: [a]'], added: ['lines: 10'] }),
    binary('M', 'e2e/data.xlsx'),
    deleted('lib/gone.test.ts'),
  ]);
  assert.equal(r.ok, false);
  assert.deepEqual(rules(r), [
    'test-deleted', 'binary-test-file', 'skip-or-only-added', 'test-neutered', 'coverage-lowered', 'runner-config-changed', 'assertions-edited', 'test-cases-removed',
  ]);
});

test('an empty file list and an image asset diff are handled', () => {
  assert.deepEqual(check([]), CLEAN);
  assert.deepEqual(check([binary('M', 'e2e/a.png')]), CLEAN);
});

test('isDocFile: documentation extensions, case-insensitive, wherever the file lives', () => {
  for (const p of ['e2e/README.md', 'docs/a.MDX', 'x/__tests__/notes.markdown', 'spec/a.rst', 'a.TXT', 'b.adoc']) assert.equal(isDocFile(p), true, p);
  for (const p of ['src/a.mjs', 'src/a.ts', 'e2e/fixtures/seed.mjs', 'README.md.bak', 'md', undefined, null]) assert.equal(isDocFile(p), false, String(p));
});
