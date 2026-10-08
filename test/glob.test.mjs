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
  assert.throws(() => globToRegExp(42), { name: 'TypeError', message: 'glob must be a string, got number' });
  assert.throws(() => matchGlob(undefined, 'a'), { name: 'TypeError', message: 'path must be a string, got undefined' });
  assert.throws(() => matchGlob('a', null), { name: 'TypeError', message: 'glob must be a string, got object' });
  assert.throws(() => matchAny('a', undefined), { name: 'TypeError', message: 'globs must be an array' });
  assert.throws(() => matchAny('a', 'a/**'), { name: 'TypeError', message: 'globs must be an array' });
  assert.throws(() => matchAny('a', ['ok', 7]), { name: 'TypeError', message: 'glob must be a string, got number' });
  assert.throws(() => matchAny(7, ['ok']), { name: 'TypeError', message: 'path must be a string, got number' });
});

test('globs are normalised like paths: backslashes, leading ./ and /, trailing / means the directory', () => {
  const target = 'lib/payroll/x.ts';
  for (const glob of ['./lib/**', '/lib/**', 'lib/payroll/', 'lib\\payroll\\**', '.\\lib\\payroll\\', './/lib/payroll/', '/./lib/payroll/**', 'lib/payroll\\']) {
    assert.equal(matchGlob(target, glob), true, glob);
  }
  assert.equal(matchGlob('lib/payroll.ts', 'lib/payroll/'), false, 'dir/ must not match a sibling file with the dir name as prefix');
  assert.equal(matchGlob('lib/payroll', 'lib/payroll/'), false, 'dir/ matches what is inside the directory, not a file named dir');
  assert.equal(matchGlob('lib/payroll/a/b/c', 'lib/payroll/'), true);
  assert.equal(matchGlob('x/lib/payroll/a', 'lib/payroll/'), false, 'a leading-slash-free dir glob is still anchored at the repo root');
  assert.equal(matchGlob('a\\b', 'a\\b'), true, 'backslash in both path and glob is a separator in both');
  assert.equal(matchGlob('lib/a.ts', '.\\lib\\*.ts'), true);
  assert.equal(matchGlob('.github/x', './.github/**'), true, 'only the ./ prefix goes, the dot of a dotdir stays');
  assert.equal(matchGlob('src/a/b.ts', '{src,lib}/a/**'), true);
  assert.equal(matchGlob('lib/a/b.ts', '{src,lib}/a/'), true, 'trailing / applies to every brace alternative');
});

test('globToRegExp normalises globs before caching: equivalent spellings compile to the same pattern', () => {
  assert.equal(globToRegExp('./lib/').source, globToRegExp('lib/**').source);
  assert.equal(globToRegExp('lib\\x').source, globToRegExp('lib/x').source);
});

test('matchAny normalises globs on both positive and negated entries', () => {
  assert.equal(matchAny('lib/payroll/x.ts', ['./lib/**', '!/lib/payroll/']), false);
  assert.equal(matchAny('lib/other/x.ts', ['./lib/**', '!/lib/payroll/']), true);
  assert.equal(matchAny('lib/payroll/x.ts', ['**', '!lib\\payroll\\**', 'lib/payroll/x.ts']), true);
});

test('nocase option: off by default, on matches regardless of case', () => {
  assert.equal(matchGlob('Lib/X.TS', 'lib/**'), false);
  assert.equal(matchGlob('Lib/X.TS', 'lib/**', {}), false);
  assert.equal(matchGlob('Lib/X.TS', 'lib/**', { nocase: false }), false);
  assert.equal(matchGlob('Lib/X.TS', 'lib/**', { nocase: true }), true);
  assert.equal(matchGlob('lib/x.ts', 'LIB/**', { nocase: true }), true);
  assert.equal(matchGlob('A/Middleware.TS', '**/middleware.{ts,js}', { nocase: true }), true);
  assert.equal(matchGlob('.ENV.local', '**/.env.*', { nocase: true }), true);
  assert.equal(matchGlob('docs/AXB.md', 'docs/a.b.md', { nocase: true }), false, 'nocase must not loosen the escaping');
  assert.equal(matchGlob('docs/A/b', 'docs/a?b', { nocase: true }), false, '? still never crosses /');
});

test('nocase: globToRegExp flags and cache are keyed per option', () => {
  const sensitive = globToRegExp('a/**');
  const folded = globToRegExp('a/**', { nocase: true });
  assert.notEqual(sensitive, folded);
  assert.equal(sensitive.ignoreCase, false);
  assert.equal(folded.ignoreCase, true);
  assert.equal(globToRegExp('a/**', { nocase: true }), folded);
  assert.equal(globToRegExp('a/**', { nocase: false }), sensitive);
  assert.equal(globToRegExp('a/**', {}), sensitive);
  assert.equal(sensitive.test('A/x'), false);
  assert.equal(folded.test('A/x'), true);
});

test('nocase: matchAny applies it to every entry, negations included', () => {
  assert.equal(matchAny('LIB/X.ts', ['lib/**'], { nocase: true }), true);
  assert.equal(matchAny('LIB/X.ts', ['lib/**']), false);
  assert.equal(matchAny('LIB/X.ts', ['**', '!lib/**'], { nocase: true }), false);
  assert.equal(matchAny('LIB/X.ts', ['**', '!lib/**']), true);
  assert.equal(matchAny('LIB/X.ts', ['**', '!lib/**'], { nocase: false }), true);
});

test('a filename containing a newline is an ordinary name: ?, * and ** all cross it (the s flag)', () => {
  assert.equal(matchGlob('dir/we\nird.ts', 'dir/**'), true);
  assert.equal(matchGlob('dir/we\nird.ts', '**/*.ts'), true);
  assert.equal(matchGlob('dir/we\nird.ts', 'dir/*.ts'), true);
  assert.equal(matchGlob('a\nb', 'a?b'), true);
  assert.equal(matchGlob('a\nb', 'a*b'), true);
  assert.equal(matchGlob('x\ny/z', '**'), true);
  assert.equal(matchGlob('x\ny/z', 'x?y/z'), true);
  assert.equal(matchGlob('x\n/y', 'x\n/*'), true, 'a literal newline in the glob matches itself');
});

test('complexity cap: more than 16 wildcard tokens throws "glob too complex"', () => {
  const sixteen = Array.from({ length: 16 }, () => 'a*').join('');
  const seventeen = `${sixteen}?`;
  assert.doesNotThrow(() => globToRegExp(sixteen));
  assert.throws(() => globToRegExp(seventeen), { name: 'Error', message: 'glob too complex' });
  assert.throws(() => matchGlob('a', seventeen), { message: 'glob too complex' });
  assert.throws(() => matchAny('a', ['ok', seventeen]), { message: 'glob too complex' });
  assert.throws(() => globToRegExp('??????????????????'), { message: 'glob too complex' });
  assert.throws(() => globToRegExp(Array.from({ length: 9 }, () => '**/').join('') + Array.from({ length: 9 }, () => 'a*').join('')), {
    message: 'glob too complex',
  });
});

test('complexity cap: a run of stars is ONE wildcard token, and collapses to a single *', () => {
  assert.doesNotThrow(() => globToRegExp(Array.from({ length: 16 }, () => 'a**********').join('')));
  assert.equal(globToRegExp('a****b').source, globToRegExp('a*b').source);
  assert.equal(globToRegExp('a**b').source, globToRegExp('a*b').source);
  assert.equal(matchGlob('axxb', 'a****b'), true);
  assert.equal(matchGlob('a/b', 'a****b'), false);
  assert.equal(globToRegExp('a/**/**/b').source, globToRegExp('a/**/b').source, 'repeated whole-segment ** collapse');
  assert.equal(globToRegExp('a/**/**').source, globToRegExp('a/**').source);
  assert.equal(matchGlob('a/b', 'a/**/**/b'), true);
  assert.equal(matchGlob('a/x/y/b', 'a/**/**/b'), true);
});

test('complexity cap: brace expansion above 256 alternatives throws, 256 is allowed', () => {
  assert.doesNotThrow(() => globToRegExp('{a,b}'.repeat(8)));
  assert.throws(() => globToRegExp('{a,b}'.repeat(9)), { name: 'Error', message: 'glob too complex' });
  const wide = Array.from({ length: 257 }, (_, i) => `n${i}`).join(',');
  assert.throws(() => globToRegExp(`{${wide}}`), { message: 'glob too complex' });
  const wideOk = Array.from({ length: 256 }, (_, i) => `n${i}`).join(',');
  assert.equal(matchGlob('n255', `{${wideOk}}`), true);
  assert.throws(() => globToRegExp('{a,b}{c,d}{e,f}{g,h}{i,j}{k,l}{m,n}{o,p}{q,r}'), { message: 'glob too complex' });
  assert.throws(() => globToRegExp('{{a,b},{c,d}}'.repeat(5)), { message: 'glob too complex' });
});

// CPU time (user + system), not wall clock: under machine load a wall-clock budget flakes, while CPU time stays put. The
// failure being pinned is exponential (seconds to hours), so a 250 ms CPU budget still catches it.
const BUDGET_MS = 250;
function timed(fn) {
  const t0 = process.cpuUsage();
  const value = fn();
  const d = process.cpuUsage(t0);
  return { value, ms: (d.user + d.system) / 1000 };
}

test('star chains do not backtrack catastrophically against a long path', () => {
  const noB = 'a'.repeat(400);
  for (const glob of ['*a*a*a*a*b', '*a*a*a*a*a*a*a*a*b', '*a*?a*?a*a*b', 'a*a*a*a*a*a*a*b*']) {
    const miss = timed(() => matchGlob(noB, glob));
    assert.equal(miss.value, false, glob);
    assert.ok(miss.ms < BUDGET_MS, `${glob} took ${miss.ms.toFixed(1)}ms`);
  }
  const hit = timed(() => matchGlob(`${noB}b`, '*a*a*a*a*b'));
  assert.equal(hit.value, true);
  assert.ok(hit.ms < BUDGET_MS, `took ${hit.ms.toFixed(1)}ms`);
  const last = timed(() => matchGlob('a'.repeat(400) + 'bb', '*a*a*a*a*b'));
  assert.equal(last.value, true, 'the FINAL star-run must be able to take the last b, not the first');
  assert.ok(last.ms < BUDGET_MS);
});

test('** chains do not backtrack catastrophically against a deep path', () => {
  const deep = 'a/'.repeat(200) + 'c';
  for (const glob of ['**/a/**/a/**/a/**/b', '**/a/**/a/**/a/**/a/**/a/**/a/**/b', 'a/**/a/**/a/**/*b', '**/*a/**/*a/**/*a/**/b']) {
    const r = timed(() => matchGlob(deep, glob));
    assert.equal(r.value, false, glob);
    assert.ok(r.ms < BUDGET_MS, `${glob} took ${r.ms.toFixed(1)}ms`);
  }
  const hit = timed(() => matchGlob('a/'.repeat(200) + 'b', '**/a/**/a/**/a/**/b'));
  assert.equal(hit.value, true);
  assert.ok(hit.ms < BUDGET_MS);
});

// ---- Differential test against an independent matcher --------------------------------------------
// refMatch walks the glob character by character with memoised recursion and shares no code with
// the regex translation, so it catches any wrong shortcut taken to keep the regexes linear.
function refMatch(glob, path) {
  const memo = new Map();
  const m = (g, p) => {
    const key = g * 1000 + p;
    if (memo.has(key)) return memo.get(key);
    let r;
    if (g === glob.length) r = p === path.length;
    else if (glob[g] === '*') {
      let h = g;
      while (glob[h] === '*') h++;
      const segStart = g === 0 || glob[g - 1] === '/';
      const segEnd = h === glob.length || glob[h] === '/';
      if (h - g >= 2 && segStart && segEnd) {
        if (h === glob.length) r = true;
        else {
          r = m(h + 1, p);
          for (let q = p + 1; !r && q <= path.length; q++) if (path[q - 1] === '/') r = m(h + 1, q);
        }
      } else {
        r = false;
        for (let q = p; q <= path.length; q++) {
          if (m(h, q)) { r = true; break; }
          if (q === path.length || path[q] === '/') break;
        }
      }
    } else if (glob[g] === '?') r = p < path.length && path[p] !== '/' && m(g + 1, p + 1);
    else r = p < path.length && path[p] === glob[g] && m(g + 1, p + 1);
    memo.set(key, r);
    return r;
  };
  return m(0, 0);
}

function rng(seed) {
  let x = seed >>> 0;
  return () => {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    return x / 2 ** 32;
  };
}

test('differential: regex matcher agrees with an independent reference on random globs and paths', () => {
  const rand = rng(20261001);
  const pick = (xs) => xs[Math.floor(rand() * xs.length)];
  const globTokens = ['a', 'a', 'b', 'b', '/', '/', '*', '*', '**', '**/', '/**', '?', 'ab', '.'];
  const pathChars = ['a', 'a', 'b', 'b', '/', '.'];
  let checked = 0;
  let matches = 0;
  for (let gi = 0; gi < 4000; gi++) {
    let glob = '';
    const n = 1 + Math.floor(rand() * 7);
    for (let i = 0; i < n; i++) glob += pick(globTokens);
    if (glob.startsWith('/') || glob.startsWith('./') || glob.endsWith('/')) continue;
    if ((glob.match(/\*+|\?/g) ?? []).length > 16) continue;
    const re = globToRegExp(glob);
    for (let pi = 0; pi < 120; pi++) {
      let path = '';
      const len = Math.floor(rand() * 9);
      for (let i = 0; i < len; i++) path += pick(pathChars);
      if (path.startsWith('./')) continue;
      const expected = refMatch(glob, path);
      assert.equal(re.test(path), expected, `glob ${JSON.stringify(glob)} path ${JSON.stringify(path)}`);
      checked++;
      if (expected) matches++;
    }
  }
  assert.ok(checked > 100000, `only ${checked} pairs checked`);
  assert.ok(matches > 5000, `only ${matches} matching pairs, the generator is too sparse to prove anything`);
});

test('differential: star-chain and ** shapes that exercise the linear-time rewrite', () => {
  const rand = rng(77);
  const pick = (xs) => xs[Math.floor(rand() * xs.length)];
  const shapes = ['*a', '*b', '*ab', '*a?', '*?b', '*a/', '*b/', '**/', '**/a/', '**/*a', '**/*a/', '/**/b/', '/**/*b', 'a', 'b', '/', '?'];
  let matches = 0;
  for (let gi = 0; gi < 3000; gi++) {
    let glob = '';
    const n = 2 + Math.floor(rand() * 5);
    for (let i = 0; i < n; i++) glob += pick(shapes);
    if (glob.startsWith('/') || glob.endsWith('/')) continue;
    const re = globToRegExp(glob);
    for (let pi = 0; pi < 100; pi++) {
      let path = '';
      const len = Math.floor(rand() * 12);
      for (let i = 0; i < len; i++) path += pick(['a', 'a', 'b', 'b', '/', 'a', 'b']);
      const expected = refMatch(glob, path);
      assert.equal(re.test(path), expected, `glob ${JSON.stringify(glob)} path ${JSON.stringify(path)}`);
      if (expected) matches++;
    }
  }
  assert.ok(matches > 3000, `only ${matches} matching pairs`);
});
