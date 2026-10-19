// Test-integrity checker: fails a PR that weakens tests instead of fixing code. An agent with a failing test
// is tempted to delete, skip, neuter or loosen it, so CI runs this on every PR diff and only the human-applied
// label `test-change-approved` overrides it. Pure: takes parsed diff files (diff.mjs shape) + config, runs no git.
// Rules, reported in this order: test-deleted, binary-test-file, skip-or-only-added, test-neutered,
// coverage-lowered, runner-config-changed, assertions-edited, test-cases-removed.
// Assertion and test-case rules are NET PER FILE: a modified test file may not lose more assertion lines (or
// test-case lines) than it gains, so an unrelated empty `it(...)` elsewhere never excuses a deletion.
// Violation `line` is the NEW-file line for added lines and the OLD-file line for removed lines; it is omitted
// when a whole file is the offender. Heuristics are deliberately blunt: a false positive costs one label click,
// a miss ships a green suite that proves nothing.
// Owner-merge mode (`owner_approval: chat`): violations do not fail the check (ok: true); the same violations are also
// returned as `ownerMerge`, which the ship skill puts in front of the owner in chat before it merges.
import { matchAny } from './glob.mjs';

export const OVERRIDE_LABEL = 'test-change-approved';

// Focused/skipped/pending/expected-failure markers (jest, vitest, mocha, jasmine, playwright, node:test, pytest,
// unittest, Go). Deliberately NOT anchored on `(`: `const run = ci ? it : it.skip` disables a test too.
const SKIP_PATTERNS = [
  /\b(?:it|test|describe|suite|context|specify)(?:\.\w+|\[\s*['"]\w+['"]\s*\])*\.(?:skip|only|todo|fixme|failing|fails|skipIf|runIf)\b/,
  /\[\s*['"](?:skip|only)['"]\s*\]/,
  /\b(?:xit|xtest|xdescribe|xcontext|fit|fdescribe|fcontext)\b\s*\(/,
  /\bthis\.skip\s*\(/,
  /\bt\.skip\s*\(/,
  /\bpending\s*\(/,
  /\bskip\s*:\s*true\b/,
  /\btest\.fail\s*\(/,
  /@pytest\.mark\.(?:skip|skipif|xfail)/,
  /\bpytest\.skip\s*\(/,
  /\bunittest\.skip/,
  /\bSkipTest\b/,
  /\.skipTest\s*\(/,
  /\bt\.Skip(?:Now|f)?\s*\(/,
];
// pgTAP in `.sql` test files; todo_start/todo_skip turn failures into passes just like todo().
const SQL_SKIP_RE = /\b(?:skip|todo(?:_start|_skip)?)\s*\(/i;
const SQL_FILE = ['**/*.sql'];
// Wrappers that make a test file exit or branch around its tests without a skip marker.
const NEUTER_PATTERNS = [/\bif\s*\(\s*(?:false|0)\s*\)/, /\bprocess\.exit\s*\(\s*0\s*\)/, /\bsys\.exit\s*\(\s*0\s*\)/];
// Binary assets that legitimately live next to tests; any other binary diff in a test file cannot be inspected.
const BINARY_OK = /\.(?:png|jpe?g|gif|webp|svg|ico|snap|bin|zip|gz|wasm)$/i;

// Assertion-looking lines (jest/vitest/chai/node:assert/tape/ava/pgTAP/unittest), plus plain python `assert x`
// and Go `t.Errorf`-style failures, which the stacks this runs on use instead of a library call.
const ASSERT_RE = /\bexpect\s*\(|\bassert\w*\s*[.(]|\.should\b|\bt\.(?:is|ok|equal|deepEqual|throws|notOk)\b|\b(?:ok|is|isnt|results_eq|set_eq|throws_ok|lives_ok|has_table|policies_are)\s*\(|\bself\.assert\w+\s*\(|^\s*assert\s+\S|\bt\.(?:Error|Errorf|Fatal|Fatalf|Fail|FailNow)\b/;
// A line that opens a test case (also pgTAP `SELECT is(...)`, which is one test each).
const TEST_CASE_RE = /\b(?:it|test|specify)(?:\.each\s*\([^)]*\))?\s*\(\s*['"`]|\bdef test_\w+|\bfunc Test\w+|\bSELECT\s+(?:ok|is|results_eq|throws_ok|lives_ok|policies_are)\b/i;
const COMMENT_LINE = /^\s*(?:\/\/|#|--|\*|\/\*)/;
// Matcher strength for "same subject, weaker matcher" (a heuristic table, not a type checker). A negated matcher
// (`.not.toBe`, `.not.toThrow`) counts as weak: it only excludes one value.
const STRONG_MATCHERS = new Set(['toBe', 'toEqual', 'toStrictEqual', 'toMatch', 'toThrow', 'toHaveBeenCalledWith']);
const WEAK_MATCHERS = new Set(['toBeDefined', 'toBeTruthy', 'toBeTypeOf', 'toHaveBeenCalled']);

// Config files that hold coverage gates. vite.config / pytest.ini / tox.ini / nested package.json are added to the
// documented list because vitest, pytest-cov and monorepo workspaces keep thresholds there too.
const COVERAGE_GLOBS = [
  '**/{vitest,jest}.config.*', '**/vitest.workspace.*', '**/vite.config.*', '**/package.json', '**/.nycrc*',
  '**/codecov.y*ml', '**/pyproject.toml', '**/setup.cfg', '**/.coveragerc', '**/pytest.ini', '**/tox.ini',
];
const THRESHOLD_KEYS = ['lines', 'branches', 'functions', 'statements', 'threshold', 'fail_under', '--cov-fail-under', 'target'];
// `key<sep>N`: sep is `:` `=` or whitespace, the key may be quoted (JSON) and N may be a decimal, quoted or `%`-suffixed.
// `-` and word characters may not precede the key (`max-lines` is not `lines`); the separator that must follow it keeps
// `linesCovered` / `thresholds:` from matching `lines` / `threshold`.
const THRESHOLD_RE = new RegExp(`(?<![\\w-])(${THRESHOLD_KEYS.join('|')})["']?(?:\\s*[:=]\\s*|\\s+)["']?(-?\\d+(?:\\.\\d+)?)`, 'g');
// Whole gates: a removed line mentioning one of these with no added line mentioning it is a gate being deleted.
const THRESHOLD_BLOCKS = ['thresholds', 'coverageThreshold', 'fail_under', 'fail-under'];
// Comments in config files. Not `--`: `--cov-fail-under=90` on an addopts continuation line is real config.
const CONFIG_COMMENT = /^\s*(?:\/\/|#|;|\/\*|\*(?:\s|$))/;

// Runner/collector configs: any added or removed line about what runs, what is ignored or whether coverage is
// enforced changes which tests count, so the owner approves it with the label if intended.
const RUNNER_GLOBS = [
  '**/{vitest,jest,playwright,cypress}.config.*', '**/vitest.workspace.*', '**/package.json', '**/pytest.ini', '**/pyproject.toml',
  '**/setup.cfg', '**/tox.ini', '**/.nycrc*', '**/codecov.y*ml', '**/.coveragerc',
];
const RUNNER_RE = /(?<!\w)(?:(?:include|exclude)(?![a-z])|testMatch|testRegex|testPathIgnorePatterns|testIgnore|forbidOnly|testpaths|--ignore|passWithNoTests|coverage\.enabled|enabled["']?\s*:\s*false|check-coverage|collectCoverageFrom)|"test"\s*:/;

const MAX_EXCERPT = 120;

function testGlobs(config) {
  const globs = config?.integrity?.test_globs;
  if (!Array.isArray(globs)) throw new TypeError('config.integrity.test_globs must be an array of globs');
  return globs;
}

export function isTestFile(path, config) {
  return typeof path === 'string' && matchAny(path, testGlobs(config));
}

// A documentation file is never a test, wherever it lives (e2e/README.md sits under a test glob but documents the suite).
// Used only by `state mark-implemented`; the integrity check keeps treating everything under a test glob as a test file.
const DOC_FILE = /\.(?:md|mdx|markdown|rst|txt|adoc)$/i;
export function isDocFile(path) {
  return typeof path === 'string' && DOC_FILE.test(path);
}

// Trimmed, capped at MAX_EXCERPT chars including the suffix (never splits a surrogate pair).
function excerpt(text, suffix = '') {
  const room = MAX_EXCERPT - suffix.length;
  let body = text.trim();
  if (body.length > room) {
    body = body.slice(0, room - 3);
    const last = body.charCodeAt(body.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) body = body.slice(0, -1);
    body = `${body.trimEnd()}...`;
  }
  return body + suffix;
}

const violation = (rule, file, line, text, suffix) => ({ rule, file, ...(line === undefined ? {} : { line }), excerpt: excerpt(text, suffix) });
const code = (lines) => lines.filter((l) => !COMMENT_LINE.test(l.text));
const configLines = (lines) => lines.filter((l) => !CONFIG_COMMENT.test(l.text));
const anyMatch = (path, globs) => typeof path === 'string' && matchAny(path, globs);

// Final extension, lowercased (`a.test.ts.disabled` -> `.disabled`); '' when the name has none.
function extOf(path) {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot).toLowerCase() : '';
}

// A renamed test must still be picked up by the same kind of glob: a file that matched by NAME (`*.test.*`) must
// still match some name glob (moving it into `test/` as `a.ts` does not count), a directory-only match must keep a
// shared glob.
function sameTestKind(oldPath, newPath, globs) {
  // A lone negated glob never matches, so only positive globs can be a "kind".
  const oldKinds = globs.filter((g) => matchAny(oldPath, [g]));
  const newKinds = globs.filter((g) => matchAny(newPath, [g]));
  const byName = (g) => !g.endsWith('**');
  return oldKinds.some(byName) ? newKinds.some(byName) : oldKinds.some((g) => newKinds.includes(g));
}

function testDeleted(files, isTest, globs) {
  const out = [];
  for (const f of files) {
    if (f.status === 'D' && isTest(f.path)) {
      out.push(violation('test-deleted', f.path, undefined, 'deleted test file'));
    } else if (f.status === 'R' && isTest(f.oldPath)) {
      if (!isTest(f.newPath)) {
        out.push(violation('test-deleted', f.oldPath, undefined, `renamed to ${f.newPath}, which is not a test file`));
      } else if (extOf(f.oldPath) !== extOf(f.newPath) || !sameTestKind(f.oldPath, f.newPath, globs)) {
        out.push(violation('test-deleted', f.oldPath, undefined, `renamed to ${f.newPath}, changing its extension or test-file kind`));
      }
    }
  }
  return out;
}

// Git shows a file as binary when it contains NUL bytes, which hides every line from the other rules.
function binaryTestFiles(files, isTest) {
  return files
    .filter((f) => f.binary && f.status !== 'D' && isTest(f.path) && !BINARY_OK.test(f.path))
    .map((f) => violation('binary-test-file', f.path, undefined, 'binary diff in a test file; its contents cannot be inspected'));
}

function skipOrOnlyAdded(files, isTest) {
  const out = [];
  for (const f of files) {
    if (f.status === 'D' || !isTest(f.path)) continue;
    const sql = matchAny(f.path, SQL_FILE);
    for (const l of f.added) {
      if (SKIP_PATTERNS.some((re) => re.test(l.text)) || (sql && SQL_SKIP_RE.test(l.text))) out.push(violation('skip-or-only-added', f.path, l.line, l.text));
    }
  }
  return out;
}

function testNeutered(files, isTest) {
  const out = [];
  for (const f of files) {
    if (f.status === 'D' || !isTest(f.path)) continue;
    for (const l of f.added) if (NEUTER_PATTERNS.some((re) => re.test(l.text))) out.push(violation('test-neutered', f.path, l.line, l.text));
  }
  return out;
}

function thresholdPairs(lines) {
  const pairs = [];
  for (const l of lines) {
    for (const m of l.text.matchAll(THRESHOLD_RE)) pairs.push({ key: m[1], value: Number(m[2]), src: l });
  }
  return pairs;
}

function coverageLowered(files) {
  const out = [];
  for (const f of files) {
    if (![f.oldPath, f.newPath].some((p) => anyMatch(p, COVERAGE_GLOBS))) continue;
    const removed = configLines(f.removed);
    const added = configLines(f.added);
    const flagged = new Set(); // one violation per removed line, whichever clause finds it first
    const flag = (l, suffix) => {
      if (flagged.has(l.line)) return;
      flagged.add(l.line);
      out.push(violation('coverage-lowered', f.path, l.line, l.text, suffix));
    };

    // Per key, pair removed and added values largest-first: a removed value with no added value at least as large
    // to take its place has been lowered, or (nothing left to pair with) dropped.
    const before = thresholdPairs(removed);
    const after = thresholdPairs(added);
    for (const key of THRESHOLD_KEYS) {
      const rs = before.filter((p) => p.key === key).sort((a, b) => b.value - a.value);
      const as = after.filter((p) => p.key === key).sort((a, b) => b.value - a.value);
      rs.forEach((r, i) => {
        if (i >= as.length) flag(r.src, ' [threshold removed]');
        else if (as[i].value < r.value) flag(r.src, ` [now ${key} ${as[i].value}]`);
      });
    }

    for (const block of THRESHOLD_BLOCKS) {
      if (added.some((l) => l.text.includes(block))) continue;
      for (const l of removed) if (l.text.includes(block)) flag(l, ' [threshold removed]');
    }
  }
  return out;
}

function runnerConfigChanged(files) {
  const out = [];
  for (const f of files) {
    if (![f.oldPath, f.newPath].some((p) => anyMatch(p, RUNNER_GLOBS))) continue;
    for (const [lines, tag] of [[f.removed, ' [removed]'], [f.added, ' [added]']]) {
      for (const l of configLines(lines)) if (RUNNER_RE.test(l.text)) out.push(violation('runner-config-changed', f.path, l.line, l.text, tag));
    }
  }
  return out;
}

// `expect(<subject>).<chain>.<matcher>(` on one line -> { subject, matcher, strong, weak }; null for anything else.
function parseExpect(text) {
  const open = /\bexpect\s*\(/.exec(text);
  if (!open) return null;
  const from = open.index + open[0].length;
  let depth = 1;
  let quote = null;
  let i = from;
  for (; i < text.length && depth > 0; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '(') depth++;
    else if (c === ')') depth--;
  }
  if (depth !== 0) return null;
  const chain = /^(?:\s*\.\s*\w+)+/.exec(text.slice(i));
  if (!chain) return null;
  const parts = chain[0].split('.').map((s) => s.trim()).filter(Boolean);
  const matcher = parts[parts.length - 1];
  const negated = parts.includes('not');
  return {
    subject: text.slice(from, i - 1).replace(/\s+/g, ' ').trim(),
    name: `${negated ? 'not.' : ''}${matcher}`,
    strong: !negated && STRONG_MATCHERS.has(matcher),
    weak: WEAK_MATCHERS.has(matcher) || (negated && STRONG_MATCHERS.has(matcher)),
  };
}

// Same subject lost a strong assertion and gained only a weaker one (toBe(1) -> toBeDefined()).
function weakenedAssertions(removed, added) {
  const out = [];
  const after = added.map((l) => parseExpect(l.text)).filter(Boolean);
  const seen = new Set();
  for (const l of removed) {
    const r = parseExpect(l.text);
    if (!r?.strong || seen.has(r.subject)) continue;
    seen.add(r.subject);
    const lost = removed.filter((x) => { const p = parseExpect(x.text); return p?.strong && p.subject === r.subject; }).length;
    const kept = after.filter((p) => p.strong && p.subject === r.subject).length;
    const weaker = after.find((p) => p.weak && p.subject === r.subject);
    if (weaker && lost > kept) out.push({ line: l, name: weaker.name });
  }
  return out;
}

// Modified test files, and test->test renames (which carry edits when they have removed lines).
function editedTestFiles(files, isTest) {
  return files.filter((f) => (f.status === 'M' ? isTest(f.path) : f.status === 'R' && isTest(f.oldPath) && isTest(f.newPath)));
}

function assertionsEdited(files, isTest) {
  const out = [];
  for (const f of editedTestFiles(files, isTest)) {
    const removed = code(f.removed).filter((l) => ASSERT_RE.test(l.text));
    const added = code(f.added).filter((l) => ASSERT_RE.test(l.text));
    if (removed.length > added.length) {
      out.push(violation('assertions-edited', f.path, removed[0].line, removed[0].text, ` [net -${removed.length - added.length} assertions]`));
      continue;
    }
    for (const w of weakenedAssertions(removed, added)) out.push(violation('assertions-edited', f.path, w.line.line, w.line.text, ` [weaker matcher: ${w.name}]`));
  }
  return out;
}

function testCasesRemoved(files, isTest) {
  const out = [];
  for (const f of editedTestFiles(files, isTest)) {
    const removed = code(f.removed).filter((l) => TEST_CASE_RE.test(l.text));
    const added = code(f.added).filter((l) => TEST_CASE_RE.test(l.text));
    if (removed.length > added.length) {
      out.push(violation('test-cases-removed', f.path, removed[0].line, removed[0].text, ` [net -${removed.length - added.length} test cases]`));
    }
  }
  return out;
}

export function checkIntegrity({ files, config, labels = [] }) {
  if (!Array.isArray(files)) throw new TypeError('files must be an array');
  if (typeof labels === 'string') throw new TypeError('labels must be a list of label names, not a string');
  const globs = testGlobs(config);
  const isTest = (p) => typeof p === 'string' && matchAny(p, globs);

  const violations = [
    ...testDeleted(files, isTest, globs),
    ...binaryTestFiles(files, isTest),
    ...skipOrOnlyAdded(files, isTest),
    ...testNeutered(files, isTest),
    ...coverageLowered(files),
    ...runnerConfigChanged(files),
    ...assertionsEdited(files, isTest),
    ...testCasesRemoved(files, isTest),
  ];
  const overridden = [...(labels ?? [])].includes(OVERRIDE_LABEL);
  if (config?.owner_approval === 'chat') return { ok: true, overridden, violations, ownerMerge: violations };
  return { ok: overridden || violations.length === 0, overridden, violations };
}
