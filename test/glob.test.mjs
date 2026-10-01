import { test } from 'node:test';
import assert from 'node:assert/strict';
import { globToRegExp, matchGlob, matchAny } from '../pipeline/lib/glob.mjs';

// [path, glob, expected]
const TABLE = [
  ['a/b/c.ts', 'a/**', true],
  ['a/b/c.ts', '**/*.ts', true],
  ['c.ts', '**/*.ts', true],
  ['a/b.test.ts', '**/*.test.*', true],
  ['.github/workflows/x.yml', '.github/**', true],
  ['lib/sa-payroll/x.ts', 'lib/sa-payroll/**', true],
  ['lib/payroll.ts', 'lib/payroll/**', false],
  ['app/api/cron/sa-payroll-x/route.ts', 'app/api/cron/sa-payroll-*/**', true],
  ['x/middleware.ts', '**/middleware.{ts,js,mjs}', true],
  ['middleware.ts', '**/middleware.{ts,js,mjs}', true],
  ['middleware.tsx', '**/middleware.{ts,js,mjs}', false],
  ['scripts/reseed_x.mjs', 'scripts/reseed_*', true],
  ['scripts/sub/reseed_x.mjs', 'scripts/reseed_*', false],
  ['.env.local', '**/.env.*', true],
  ['.env', '**/.env', true],
  ['a/b', 'a/**/b', true],
  ['a/x/y/b', 'a/**/b', true],
  ['docs/a(1).md', 'docs/a(1).md', true],
  ['docs/a+b.md', 'docs/a+b.md', true],
  ['docs/axb.md', 'docs/a.b.md', false],
  ['.\\lib\\x.ts', 'lib/**', true],
  ['./lib/x.ts', 'lib/**', true],
  ['e2e/smoke/a.spec.ts', 'e2e/**', true],
  ['supabase/tests/x.test.sql', 'supabase/tests/**', true],
  ['a/b', '**', true],
  ['x', '**', true],
];

for (const [path, glob, expected] of TABLE) {
  test(`matchGlob(${JSON.stringify(path)}, ${JSON.stringify(glob)}) -> ${expected}`, () => {
    assert.equal(matchGlob(path, glob), expected);
  });
}

test('globToRegExp returns an anchored RegExp and caches compiled patterns', () => {
  const re = globToRegExp('a/**');
  assert.ok(re instanceof RegExp);
  assert.equal(globToRegExp('a/**'), re);
  assert.equal(re.global, false, 'a global regex would carry lastIndex between calls');
  assert.equal(re.test('a/x'), true);
  assert.equal(re.test('a/x'), true, 'repeat call on the cached regex must give the same answer');
});

test('patterns are anchored at both ends', () => {
  assert.equal(matchGlob('ab', 'a'), false);
  assert.equal(matchGlob('ba', 'a'), false);
  assert.equal(matchGlob('x/a', 'a'), false);
  assert.equal(matchGlob('a/x', 'a'), false);
  assert.equal(matchGlob('a', 'a'), true);
});

test('a glob without a slash matches the whole path, not the basename', () => {
  assert.equal(matchGlob('reseed_x.mjs', 'reseed_*'), true);
  assert.equal(matchGlob('scripts/reseed_x.mjs', 'reseed_*'), false);
  assert.equal(matchGlob('scripts/a.ts', '*.ts'), false);
  assert.equal(matchGlob('a.ts', '*.ts'), true);
});

test('** matches zero or more whole segments', () => {
  assert.equal(matchGlob('a/x', 'a/**'), true);
  assert.equal(matchGlob('a/x/y', 'a/**'), true);
  assert.equal(matchGlob('ab/c', 'a/**'), false, 'a/** must not match a sibling directory prefix');
  assert.equal(matchGlob('a', 'a/**'), false, 'a file named a is not inside directory a');
  assert.equal(matchGlob('a/b', 'a/**/b'), true);
  assert.equal(matchGlob('a/x/y/b', 'a/**/b'), true);
  assert.equal(matchGlob('a/xb', 'a/**/b'), false, 'zero-segment ** must not glue onto the next name');
  assert.equal(matchGlob('ab', 'a/**/b'), false);
  assert.equal(matchGlob('x/a/b', 'a/**/b'), false);
  assert.equal(matchGlob('lib/x/__tests__/y.ts', '**/__tests__/**'), true);
  assert.equal(matchGlob('__tests__/y.ts', '**/__tests__/**'), true);
  assert.equal(matchGlob('src/not__tests__/y.ts', '**/__tests__/**'), false);
});

test('** that is not a whole segment behaves like a single *', () => {
  assert.equal(matchGlob('a/b.ts', '**.ts'), false);
  assert.equal(matchGlob('b.ts', '**.ts'), true);
  assert.equal(matchGlob('a/xb/c', 'a/x**/c'), true);
  assert.equal(matchGlob('a/x/y/c', 'a/x**/c'), false);
});

test('* matches any chars except / and matches leading dots', () => {
  assert.equal(matchGlob('a/.hidden', 'a/*'), true);
  assert.equal(matchGlob('.hidden', '*'), true);
  assert.equal(matchGlob('a/b/c', 'a/*'), false);
  assert.equal(matchGlob('a/b/c', 'a/*/c'), true);
  assert.equal(matchGlob('a/c', 'a/*/c'), false);
});

test('? matches exactly one char except /', () => {
  assert.equal(matchGlob('a/b', 'a?b'), false);
  assert.equal(matchGlob('axb', 'a?b'), true);
  assert.equal(matchGlob('ab', 'a?b'), false);
  assert.equal(matchGlob('axxb', 'a?b'), false);
});

test('{a,b} alternation works inside a segment and across segments', () => {
  assert.equal(matchGlob('src/a.ts', 'src/a.{ts,js}'), true);
  assert.equal(matchGlob('src/a.js', 'src/a.{ts,js}'), true);
  assert.equal(matchGlob('src/a.mjs', 'src/a.{ts,js}'), false);
  assert.equal(matchGlob('lib/x.ts', '{lib,app}/**'), true);
  assert.equal(matchGlob('app/x.ts', '{lib,app}/**'), true);
  assert.equal(matchGlob('docs/x.ts', '{lib,app}/**'), false);
  assert.equal(matchGlob('a/b/c.ts', '{a/b,x}/*.ts'), true);
  assert.equal(matchGlob('a.ts', 'a{,b}.ts'), true, 'empty alternative');
  assert.equal(matchGlob('ab.ts', 'a{,b}.ts'), true);
});

test('alternatives may contain wildcards and **', () => {
  assert.equal(matchGlob('a/x/y/z.ts', 'a/{**/z.ts,q}'), true);
  assert.equal(matchGlob('a/z.ts', 'a/{**/z.ts,q}'), true);
  assert.equal(matchGlob('a/q', 'a/{**/z.ts,q}'), true);
  assert.equal(matchGlob('a/r', 'a/{**/z.ts,q}'), false);
  assert.equal(matchGlob('a/x.test.ts', 'a/{*.test.*,y}'), true);
});

test('** inside a brace alternative is only a globstar when the text around the braces is a segment boundary', () => {
  assert.equal(matchGlob('a/b', 'a{**,x}'), false, 'a{**} is a*, which cannot cross /');
  assert.equal(matchGlob('ab', 'a{**,x}'), true);
  assert.equal(matchGlob('q/b', '{**,x}b'), false);
  assert.equal(matchGlob('qb', '{**,x}b'), true);
  assert.equal(matchGlob('a/q/b', 'a/{**,x}/b'), true);
  assert.equal(matchGlob('a/b', 'a/{**,x}/b'), true);
});

test('braces: nested groups work, a single-item group is an alternation of one, unbalanced braces are literal', () => {
  assert.equal(matchGlob('a.ts', 'a.{t{s,sx},js}'), true);
  assert.equal(matchGlob('a.tsx', 'a.{t{s,sx},js}'), true);
  assert.equal(matchGlob('a.ms', 'a.{t{s,sx},js}'), false);
  assert.equal(matchGlob('a.ts', 'a.{ts}'), true);
  assert.equal(matchGlob('a{b', 'a{b'), true);
  assert.equal(matchGlob('a}b', 'a}b'), true);
  assert.equal(matchGlob('ab', 'a{b'), false);
  assert.equal(matchGlob('a{bc', 'a{b{c,d}'), true, 'an unclosed { before a real group stays literal');
  assert.equal(matchGlob('a{bd', 'a{b{c,d}'), true);
  assert.equal(matchGlob('abc', 'a{b{c,d}'), false);
});

test('a comma outside braces is literal', () => {
  assert.equal(matchGlob('a,b', 'a,b'), true);
  assert.equal(matchGlob('a', 'a,b'), false);
});

test('[ and ] are literal, not character classes', () => {
  assert.equal(matchGlob('app/[id]/page.tsx', 'app/[id]/page.tsx'), true);
  assert.equal(matchGlob('app/i/page.tsx', 'app/[id]/page.tsx'), false);
  assert.equal(matchGlob('app/d/page.tsx', 'app/[id]/page.tsx'), false);
  assert.equal(matchGlob('app/[id]/page.tsx', 'app/**/page.tsx'), true);
});

test('regex metacharacters in the glob are escaped', () => {
  assert.equal(matchGlob('a|b', 'a|b'), true);
  assert.equal(matchGlob('a', 'a|b'), false);
  assert.equal(matchGlob('b', 'a|b'), false);
  assert.equal(matchGlob('a^b$c', 'a^b$c'), true);
  assert.equal(matchGlob('docs/(group)/x.md', 'docs/(group)/x.md'), true);
  assert.equal(matchGlob('docs/group/x.md', 'docs/(group)/x.md'), false);
  assert.equal(matchGlob('a\\b', 'a\\b'), false, 'backslash in the path is normalised to /, so a literal one never matches');
  assert.equal(matchGlob('a.b', 'a.b'), true);
  assert.equal(matchGlob('aab', 'a.b'), false);
  assert.equal(matchGlob('a+', 'a+'), true);
  assert.equal(matchGlob('aa', 'a+'), false);
});

test('path normalisation: backslashes and leading ./', () => {
  assert.equal(matchGlob('lib\\sub\\x.ts', 'lib/sub/*.ts'), true);
  assert.equal(matchGlob('./a.ts', 'a.ts'), true);
  assert.equal(matchGlob('././a.ts', 'a.ts'), true);
  assert.equal(matchGlob('.\\a.ts', 'a.ts'), true);
  assert.equal(matchGlob('.env', '.env'), true, 'a leading dot that is not ./ must be kept');
  assert.equal(matchGlob('.github/x', '.github/**'), true);
  assert.equal(matchGlob('x/./a.ts', 'x/a.ts'), false, 'only a LEADING ./ is stripped');
});

test('dotfiles are not special for * and **', () => {
  assert.equal(matchGlob('.github/workflows/ci.yml', '**/*.yml'), true);
  assert.equal(matchGlob('a/.b/c', 'a/**'), true);
  assert.equal(matchGlob('.env.production', '.env*'), true);
});

test('the spec default test globs classify as expected', () => {
  const testGlobs = ['**/*.test.*', '**/*.spec.*', '**/__tests__/**', '**/test/**', '**/tests/**', 'e2e/**', 'supabase/tests/**'];
  assert.equal(matchAny('lib/a.test.ts', testGlobs), true);
  assert.equal(matchAny('test/glob.test.mjs', testGlobs), true);
  assert.equal(matchAny('packages/x/tests/helper.ts', testGlobs), true);
  assert.equal(matchAny('lib/a.ts', testGlobs), false);
  assert.equal(matchAny('lib/latest/a.ts', testGlobs), false, 'test must be a whole segment');
});

test('matchAny: false for an empty list', () => {
  assert.equal(matchAny('a', []), false);
});

test('matchAny: any positive glob matches', () => {
  assert.equal(matchAny('lib/x.ts', ['docs/**', 'lib/**']), true);
  assert.equal(matchAny('src/x.ts', ['docs/**', 'lib/**']), false);
});

test('matchAny: last matching entry wins, negation un-matches, later positive re-matches', () => {
  assert.equal(matchAny('a/b.ts', ['**', '!a/**']), false);
  assert.equal(matchAny('a/b.ts', ['**', '!a/**', 'a/b.ts']), true);
  assert.equal(matchAny('c.ts', ['**', '!a/**']), true);
});

test('matchAny: a lone negation never matches; a non-matching negation does not undo an earlier match', () => {
  assert.equal(matchAny('a/b.ts', ['!a/**']), false);
  assert.equal(matchAny('a/b.ts', ['a/**', '!docs/**']), true);
  assert.equal(matchAny('a/b.ts', ['!a/**', '!a/b.ts']), false);
});

test('matchAny normalises the path like matchGlob', () => {
  assert.equal(matchAny('.\\a\\b.ts', ['**', '!a/**']), false);
  assert.equal(matchAny('./a/b.ts', ['a/**']), true);
});

test('bad input throws a readable TypeError instead of silently not matching', () => {
  assert.throws(() => globToRegExp(42), TypeError);
  assert.throws(() => matchGlob(undefined, 'a'), TypeError);
  assert.throws(() => matchAny('a', undefined), TypeError);
  assert.throws(() => matchAny('a', ['ok', 7]), TypeError);
});
