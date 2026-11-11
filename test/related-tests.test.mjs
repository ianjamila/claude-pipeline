// scripts/lib/related-tests.mjs (which tests `node scripts/test.mjs --related` adds to the quick check) on a fixture import
// graph, and scripts/test.mjs --related --list end to end with an injected changed-file list.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_BUDGET_MS, changedFiles, describeSelection, describeSelectionDetail, importSpecs, mentionsPath, parseBudget, relatedTests, toPosix } from '../scripts/lib/related-tests.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// A fixture repo: sources by repo-relative path.
const SRC = {
  'lib/leaf.mjs': 'export const x = 1;\n',
  'lib/mid.mjs': "import { x } from './leaf.mjs';\nexport const y = x;\n",
  'lib/top.mjs': "export * from './mid.mjs';\n",
  'lib/dyn.mjs': "export const load = () => import('./leaf');\n", // extensionless, dynamic
  'lib/cycle-a.mjs': "import './cycle-b.mjs';\n",
  'lib/cycle-b.mjs': "import './cycle-a.mjs';\nimport './cycle-leaf.mjs';\n",
  'lib/cycle-leaf.mjs': 'export {};\n',
  'lib/lonely.mjs': 'export {};\n',
  'bin/tool.mjs': "import { y } from '../lib/mid.mjs';\nconsole.log(y);\n",
  'docs/guide.md': '# guide\n',
  'test/helpers/h.mjs': "import '../../lib/leaf.mjs';\n",
  'test/direct.test.mjs': "import { x } from '../lib/leaf.mjs';\n",
  'test/transitive.test.mjs': "import { y } from '../lib/top.mjs';\n",
  'test/via-helper.test.mjs': "import './helpers/h.mjs';\n",
  'test/via-dynamic.test.mjs': "import { load } from '../lib/dyn.mjs';\n",
  'test/cycle.test.mjs': "import '../lib/cycle-a.mjs';\n",
  'test/spawns-bin.test.mjs': "const bin = join(root, 'bin', 'tool.mjs');\n",
  'test/reads-doc.test.mjs': "readFileSync(join(root, 'docs/guide.md'));\n",
  'test/reads-doc-parts.test.mjs': "readFileSync(join(root, 'docs', 'guide.md'));\n",
  'test/unrelated.test.mjs': "import { z } from '../lib/lonely.mjs';\n",
  'test/mentions-test.test.mjs': "writeFileSync(dir, 'test/direct.test.mjs');\n",
};
const files = Object.keys(SRC);
const tests = files.filter((f) => f.startsWith('test/') && f.endsWith('.test.mjs')).map((f) => f.slice(5)).sort();
const read = (p) => SRC[p] ?? null;
const run = (changed, extra = {}) => relatedTests({
  tests, changed, files, read, weights: new Map(tests.map((t) => [t, 100])), budgetMs: Infinity, ...extra,
});
const names = (r) => r.selected.map((s) => s.name);
const tierOf = (r, n) => r.selected.find((s) => s.name === n)?.tier;

test('importSpecs: static, re-export, side-effect and dynamic relative imports; bare and absolute specifiers are ignored', () => {
  const src = "import a from './a.mjs';\nimport { b } from \"../b\";\nexport * from './c.mjs';\nimport './d.mjs';\nconst e = await import('./e.mjs');\nimport fs from 'node:fs';\nimport x from 'pkg/y';\n";
  assert.deepEqual(importSpecs(src).sort(), ['../b', './a.mjs', './c.mjs', './d.mjs', './e.mjs']);
});

test('mentionsPath: the whole path, or its segments as consecutive string arguments; not a longer name', () => {
  assert.ok(mentionsPath("read('docs/cli.md')", 'docs/cli.md'));
  assert.ok(mentionsPath("join(root, 'docs', 'cli.md')", 'docs/cli.md'));
  assert.ok(mentionsPath('join(root, "pipeline/bin", "pipeline.mjs")', 'pipeline/bin/pipeline.mjs'));
  assert.ok(mentionsPath('`${root}/docs/cli.md`', 'docs/cli.md'));
  assert.ok(mentionsPath("a\\docs\\cli.md", 'docs/cli.md'));
  assert.ok(!mentionsPath("read('docs/cli.mdx')", 'docs/cli.md'));
  assert.ok(!mentionsPath("read('mydocs/cli.md')", 'docs/cli.md'));
  assert.ok(!mentionsPath("read('docs/cli.md.bak')", 'docs/cli.md'));
  assert.ok(!mentionsPath("join(root, 'docs'); cli.md", 'docs/cli.md'));
});

test('toPosix: backslashes and leading ./ are normalised', () => {
  assert.equal(toPosix('lib\\sub\\a.mjs'), 'lib/sub/a.mjs');
  assert.equal(toPosix('./lib/a.mjs'), 'lib/a.mjs');
});

test('relatedTests: a direct importer is tier 1; a test further away is tier 2; an unrelated test is not selected', () => {
  const r = run(['lib/leaf.mjs']);
  assert.equal(tierOf(r, 'direct.test.mjs'), 1);
  assert.equal(tierOf(r, 'transitive.test.mjs'), 2); // top -> mid -> leaf
  assert.equal(tierOf(r, 'via-dynamic.test.mjs'), 2); // dyn -> leaf, extensionless dynamic import
  assert.equal(tierOf(r, 'via-helper.test.mjs'), 2); // helper -> leaf
  assert.equal(tierOf(r, 'spawns-bin.test.mjs'), 2); // mentions bin/tool.mjs -> mid -> leaf
  assert.equal(tierOf(r, 'cycle.test.mjs'), undefined);
  assert.ok(!names(r).includes('unrelated.test.mjs'));
  assert.deepEqual(r.skipped, []);
});

test('relatedTests: Windows-style (backslash) paths and imports resolve like posix ones', () => {
  assert.equal(tierOf(run(['lib\\leaf.mjs']), 'direct.test.mjs'), 1);
  assert.equal(tierOf(run(['.\\lib\\mid.mjs']), 'transitive.test.mjs'), 2);
});

test('relatedTests: a changed test file is tier 0 and runs whatever the budget', () => {
  const r = run(['test/unrelated.test.mjs'], { budgetMs: 1 });
  assert.deepEqual(names(r), ['unrelated.test.mjs']);
  assert.equal(tierOf(r, 'unrelated.test.mjs'), 0);
});

test('relatedTests: a path mention (whole path or join segments) makes a test related; a changed bin entry reaches its tests', () => {
  assert.deepEqual(names(run(['bin/tool.mjs'])), ['spawns-bin.test.mjs']);
  assert.deepEqual(names(run(['docs/guide.md'])).sort(), ['reads-doc-parts.test.mjs', 'reads-doc.test.mjs']);
  assert.equal(tierOf(run(['docs/guide.md']), 'reads-doc.test.mjs'), 1);
});

test('relatedTests: a mention of another test file is not followed, but a changed test that is mentioned still counts', () => {
  assert.ok(!names(run(['lib/leaf.mjs'])).includes('mentions-test.test.mjs'));
  assert.deepEqual(names(run(['test/direct.test.mjs'])).sort(), ['direct.test.mjs', 'mentions-test.test.mjs']);
});

test('relatedTests: import cycles terminate and still find a change inside the cycle', () => {
  const r = run(['lib/cycle-leaf.mjs']);
  assert.equal(tierOf(r, 'cycle.test.mjs'), 2);
  assert.deepEqual(names(run(['lib/cycle-a.mjs'])), ['cycle.test.mjs']);
});

test('relatedTests: a changed root file (README.md) is followed only from tests that name it, ranks after strong relations, and never through a module (#281)', () => {
  const src = {
    'README.md': '# readme\n',
    'lib/leaf.mjs': 'export const x = 1;\n',
    'lib/policy.mjs': "export const PROTECTED = ['README.md', 'docs/'];\n", // a module that merely contains the name
    'test/imports-policy.test.mjs': "import { PROTECTED } from '../lib/policy.mjs';\n",
    'test/fixture-readme.test.mjs': "writeFileSync(join(dir, 'README.md'), 'x');\n",
    'test/imports-leaf.test.mjs': "import { x } from '../lib/leaf.mjs';\n",
  };
  const fx = Object.keys(src);
  const fxTests = fx.filter((f) => f.endsWith('.test.mjs')).map((f) => f.slice(5)).sort();
  const go = (changed, budgetMs = Infinity) => relatedTests({
    tests: fxTests, changed, files: fx, read: (p) => src[p] ?? null, weights: new Map(fxTests.map((t) => [t, 100])), budgetMs,
  });
  const onlyReadme = go(['README.md']);
  assert.deepEqual(names(onlyReadme), ['fixture-readme.test.mjs'], 'a module containing the name does not make its importers related');
  assert.equal(onlyReadme.selected[0].weak, true);
  // README plus a real source change, room for one test: the importer of the changed module wins over the README mention.
  const both = go(['README.md', 'lib/leaf.mjs'], 100);
  assert.deepEqual(names(both), ['imports-leaf.test.mjs']);
  assert.deepEqual(both.skipped.map((s) => s.name), ['fixture-readme.test.mjs']);
  // A path with a directory stays a strong mention (docs/guide.md in the main fixture).
  assert.equal(run(['docs/guide.md']).selected.every((s) => s.weak === false), true);
});

test('relatedTests: a deleted file counts by path (importers and mentioners are related)', () => {
  const gone = files.filter((f) => f !== 'lib/leaf.mjs' && f !== 'docs/guide.md');
  const r = relatedTests({ tests, changed: ['lib/leaf.mjs', 'docs/guide.md'], files: gone, read, weights: new Map(), budgetMs: Infinity });
  assert.equal(tierOf(r, 'direct.test.mjs'), 1);
  assert.equal(tierOf(r, 'reads-doc.test.mjs'), 1);
});

test('relatedTests: budget ranks changed, then direct, then transitive, lightest first; an over-budget file is skipped and lighter ones still fit', () => {
  const weights = new Map(tests.map((t) => [t, 100]));
  weights.set('direct.test.mjs', 500);
  weights.set('via-helper.test.mjs', 300);
  weights.set('transitive.test.mjs', 50);
  weights.set('via-dynamic.test.mjs', 60);
  weights.set('spawns-bin.test.mjs', 70);
  const all = run(['lib/leaf.mjs'], { weights });
  assert.deepEqual(names(all).slice(0, 1), ['direct.test.mjs'], 'tier 1 first');
  // budget 480: direct (500) does not fit; then by distance (2: dynamic 60, helper 300; 3: transitive 50, bin 70).
  const r = run(['lib/leaf.mjs'], { weights, budgetMs: 480 });
  assert.deepEqual(r.skipped.map((s) => s.name), ['direct.test.mjs']);
  assert.deepEqual(names(r), ['via-dynamic.test.mjs', 'via-helper.test.mjs', 'transitive.test.mjs', 'spawns-bin.test.mjs']);
  assert.equal(r.estimatedMs, 480);
  // a changed test file counts against the budget but is never skipped.
  const c = run(['lib/leaf.mjs', 'test/unrelated.test.mjs'], { weights: new Map([['unrelated.test.mjs', 1000]]), budgetMs: 10 });
  assert.deepEqual(names(c), ['unrelated.test.mjs']);
});

test('relatedTests: the fixed list (exclude) is never re-selected, and the budget is a total, not per file', () => {
  const r = run(['lib/leaf.mjs'], { exclude: ['direct.test.mjs'] });
  assert.ok(!names(r).includes('direct.test.mjs'));
  const small = run(['lib/leaf.mjs'], { budgetMs: 250 });
  assert.equal(names(small).length, 2);
  assert.equal(small.estimatedMs, 200);
});

test('parseBudget: unset is the default, "all" lifts the cap, 0 turns related tests off, junk reports an error and uses the default', () => {
  assert.deepEqual(parseBudget(undefined), { budgetMs: DEFAULT_BUDGET_MS });
  assert.deepEqual(parseBudget('  '), { budgetMs: DEFAULT_BUDGET_MS });
  assert.deepEqual(parseBudget('all'), { budgetMs: Infinity });
  assert.deepEqual(parseBudget('0'), { budgetMs: 0 });
  assert.deepEqual(parseBudget('45000'), { budgetMs: 45000 });
  const bad = parseBudget('-5');
  assert.equal(bad.budgetMs, DEFAULT_BUDGET_MS);
  assert.match(bad.error, /not a number of ms/);
});

test('describeSelection: counts, the skipped names (truncated) and the changed-file count on one line', () => {
  const sel = (name, tier) => ({ name, tier, distance: tier, ms: 1 });
  const line = describeSelection({
    selected: [sel('a.test.mjs', 0), sel('b.test.mjs', 1), sel('c.test.mjs', 2)],
    skipped: ['s1', 's2', 's3'].map((n) => sel(`${n}.test.mjs`, 2)),
    changedCount: 7, basis: 'basis text', budgetMs: 90000, estimatedMs: 188232.4, listMax: 2,
  });
  assert.equal(line.includes('\n'), false);
  assert.match(line, /3 selected \(1 changed, 1 direct, 1 transitive\), 3 skipped over budget \(s1\.test\.mjs, s2\.test\.mjs, \+1 more\); 7 changed files \(basis text\); estimated 188232 of budget 90000 ms$/);
  const uncapped = describeSelection({ selected: [], skipped: [], changedCount: 0, basis: 'b', budgetMs: Infinity, estimatedMs: 5 });
  assert.match(uncapped, /; estimated 5 ms, no budget cap$/);
});

test('describeSelectionDetail: every selected file with its tier and every skipped file, in full, no line ending in a bare test name', () => {
  const sel = (name, tier) => ({ name, tier, distance: tier, ms: 1 });
  const skipped = Array.from({ length: 10 }, (_, i) => sel(`s${i}.test.mjs`, 2));
  const lines = describeSelectionDetail({ selected: [sel('a.test.mjs', 0), sel('b.test.mjs', 1), sel('c.test.mjs', 2)], skipped });
  assert.equal(lines.length, 2);
  assert.equal(lines[0], 'related selected (3): a.test.mjs [changed], b.test.mjs [direct], c.test.mjs [transitive] (end)');
  assert.match(lines[1], /^related skipped over budget \(10\): s0\.test\.mjs, .*, s9\.test\.mjs \(end\)$/);
  assert.ok(lines.every((l) => !l.endsWith('.test.mjs')));
  assert.deepEqual(describeSelectionDetail({ selected: [], skipped: [] }), []);
});

// ---- changedFiles (git injected) ------------------------------------------------------------------------------------
const fakeGit = (table) => (args) => {
  const key = args.join(' ');
  const hit = Object.entries(table).find(([k]) => key.startsWith(k));
  return hit ? hit[1] : { ok: false, stdout: '' };
};

test('changedFiles: branch commits since the merge base, staged/unstaged, and untracked files, deleted ones by path, deduplicated', () => {
  const r = changedFiles(fakeGit({
    'rev-parse': { ok: true, stdout: 'abc\n' },
    'merge-base HEAD origin/main': { ok: true, stdout: 'f85b7f34656343e9f2d64932fa7cb87c2d43bebc\n' },
    'diff --name-only --no-renames -z f85b7f34656343e9f2d64932fa7cb87c2d43bebc..HEAD': { ok: true, stdout: 'a.mjs\0gone.mjs\0' },
    'diff --name-only --no-renames -z HEAD': { ok: true, stdout: 'a.mjs\0dir\\b.mjs\0' },
    'ls-files': { ok: true, stdout: 'new file.mjs\0' },
  }));
  assert.deepEqual(r.files, ['a.mjs', 'gone.mjs', 'dir/b.mjs', 'new file.mjs']);
  assert.match(r.basis, /merge base f85b7f3 with origin\/main/);
});

test('changedFiles: no origin/main means working-tree changes only, and says so', () => {
  const r = changedFiles(fakeGit({
    'rev-parse': { ok: true, stdout: 'abc\n' },
    'diff --name-only --no-renames -z HEAD': { ok: true, stdout: 'a.mjs\0' },
    'ls-files': { ok: true, stdout: '' },
  }));
  assert.deepEqual(r.files, ['a.mjs']);
  assert.match(r.basis, /no origin\/main: working-tree changes only/);
});

test('changedFiles: a failing git (or a throwing one) is an { error }, never an exception', () => {
  assert.ok(changedFiles(() => ({ ok: false, stdout: '' })).error);
  assert.ok(changedFiles(() => { throw new Error('boom'); }).error);
  const half = changedFiles(fakeGit({ 'rev-parse': { ok: true, stdout: 'abc\n' }, 'diff': { ok: false, stdout: '' } }));
  assert.ok(half.error);
});

// ---- scripts/test.mjs --related --list ------------------------------------------------------------------------------
const cli = (args, env = {}) => spawnSync(process.execPath, [join(root, 'scripts', 'test.mjs'), ...args], {
  cwd: root, encoding: 'utf8', env: { ...process.env, CP_QUICK_RELATED_BUDGET_MS: '', ...env },
});
const listed = (r) => r.stdout.split('\n').filter((l) => l.endsWith('.test.mjs'));

test('test.mjs --related --list: the named files plus the tests that import the injected changed file, with a summary line first', () => {
  const r = cli(['--related', '--list', 'config.test.mjs'], { CP_RELATED_CHANGED: 'pipeline/lib/glob.mjs\n' });
  assert.equal(r.status, 0, r.stderr);
  const out = listed(r);
  assert.ok(out.includes('config.test.mjs'));
  assert.ok(out.includes('glob.test.mjs'), 'glob.test.mjs imports pipeline/lib/glob.mjs');
  assert.match(r.stdout.split('\n')[0], /^related tests: \d+ selected \(0 changed, \d+ direct, \d+ transitive\), \d+ skipped over budget.*; 1 changed files \(CP_RELATED_CHANGED\); estimated \d+ of budget 90000 ms$/);
  assert.match(r.stdout, /^related selected \(\d+\): .*glob\.test\.mjs \[direct\].* \(end\)$/m);
});

test('test.mjs --related --list: a changed test file runs even with a tiny budget; the budget only limits the others', () => {
  const r = cli(['--related', '--list', 'config.test.mjs'], { CP_RELATED_CHANGED: 'test/glob.test.mjs\npipeline/lib/config.mjs', CP_QUICK_RELATED_BUDGET_MS: '1' });
  assert.equal(r.status, 0, r.stderr);
  const out = listed(r);
  assert.ok(out.includes('glob.test.mjs'));
  assert.ok(out.includes('config.test.mjs'));
  assert.ok(out.length <= 3, out.join(' '));
  assert.match(r.stdout, /skipped over budget/);
});

test('test.mjs --related --list: CP_QUICK_RELATED_BUDGET_MS=0 runs only the named files; "all" lifts the cap', () => {
  const off = cli(['--related', '--list', 'config.test.mjs'], { CP_RELATED_CHANGED: 'pipeline/lib/config.mjs', CP_QUICK_RELATED_BUDGET_MS: '0' });
  assert.deepEqual(listed(off), ['config.test.mjs']);
  assert.match(off.stdout, /related tests: off/);
  const all = cli(['--related', '--list', 'config.test.mjs'], { CP_RELATED_CHANGED: 'pipeline/lib/config.mjs', CP_QUICK_RELATED_BUDGET_MS: 'all' });
  assert.ok(listed(all).length > 20);
  assert.match(all.stdout, /0 skipped over budget; 1 changed files \(CP_RELATED_CHANGED\); estimated \d+ ms, no budget cap/);
});

test('test.mjs --related: named files keep the exact-name rule and exit 2 when missing; related files are never "missing"', () => {
  const r = cli(['--related', '--list', 'nope.test.mjs'], { CP_RELATED_CHANGED: 'pipeline/lib/glob.mjs' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no test file in test\/ matches: nope\.test\.mjs/);
});

test('test.mjs --related --list: when git cannot tell, it says why and lists just the named files (exit 0)', () => {
  const r = cli(['--related', '--list', 'config.test.mjs'], { GIT_DIR: join(root, 'no-such-git-dir') });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(listed(r), ['config.test.mjs']);
  assert.match(r.stdout, /related tests: not computed \(.+\); running only the named files/);
});

test('test.mjs --related --list: nothing changed means just the named files, and the summary still prints', () => {
  const r = cli(['--related', '--list', 'config.test.mjs'], { CP_RELATED_CHANGED: '\n' });
  assert.deepEqual(listed(r), ['config.test.mjs']);
  assert.match(r.stdout, /related tests: 0 selected \(0 changed, 0 direct, 0 transitive\), 0 skipped over budget; 0 changed files/);
});

test('test.mjs without --related is unchanged: --list names exactly the named files', () => {
  const r = cli(['--list', 'config.test.mjs', 'glob.test.mjs'], { CP_RELATED_CHANGED: 'pipeline/lib/config.mjs' });
  assert.deepEqual(listed(r), ['config.test.mjs', 'glob.test.mjs']);
  assert.ok(!r.stdout.includes('related tests'));
});
