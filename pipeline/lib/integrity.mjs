// Test-integrity checker: fails a PR that weakens tests instead of fixing code. An agent with a failing test
// is tempted to delete, skip or loosen it, so CI runs this on every PR diff and only the human-applied label
// `test-change-approved` overrides it. Pure: takes parsed diff files (diff.mjs shape) + config, runs no git.
// Four rules, reported in this order: test-deleted, skip-or-only-added, coverage-lowered, assertions-edited.
// Violation `line` is the NEW-file line for added lines and the OLD-file line for removed lines; it is omitted
// when a whole file is the offender. Heuristics are deliberately blunt: a false positive costs one label click,
// a miss ships a green suite that proves nothing.
import { matchAny } from './glob.mjs';

export const OVERRIDE_LABEL = 'test-change-approved';

// Focused/skipped/pending test markers in JS/TS (jest, vitest, mocha, jasmine, playwright), pytest, unittest, Go.
const SKIP_RE = /\b(?:it|test|describe|suite|context|specify)\.(?:skip|only|todo|fixme|failing)\s*\(|\b(?:xit|xtest|xdescribe|xcontext|fit|fdescribe|fcontext)\s*\(|\btest\.describe\.(?:skip|only|fixme)\s*\(|@pytest\.mark\.(?:skip|skipif|xfail)|\bpytest\.skip\s*\(|\bunittest\.skip|\bt\.Skip(?:Now|f)?\s*\(/;
// pgTAP in `.sql` test files; todo_start/todo_skip turn failures into passes just like todo().
const SQL_SKIP_RE = /\b(?:skip|todo(?:_start|_skip)?)\s*\(/i;
const SQL_FILE = ['**/*.sql'];

// Assertion-looking lines (jest/vitest/chai/node:assert/tape/ava/pgTAP/unittest), plus plain python `assert x`
// and Go `t.Errorf`-style failures, which the stacks this runs on use instead of a library call.
const ASSERT_RE = /\bexpect\s*\(|\bassert\w*\s*[.(]|\.should\b|\bt\.(?:is|ok|equal|deepEqual|throws|notOk)\b|\b(?:ok|is|isnt|results_eq|set_eq|throws_ok|lives_ok|has_table|policies_are)\s*\(|\bself\.assert\w+\s*\(|^\s*assert\s+\S|\bt\.(?:Error|Errorf|Fatal|Fatalf|Fail|FailNow)\b/;
const NEW_TEST_RE = /\b(?:it|test|specify)(?:\.each\s*\([^)]*\))?\s*\(\s*['"`]|\bdef test_\w+|\bfunc Test\w+|\bSELECT\s+(?:ok|is|results_eq|throws_ok|lives_ok|policies_are)\b/i;
const COMMENT_LINE = /^\s*(?:\/\/|#|--|\*|\/\*)/;

// Config files that hold coverage gates. vite.config / pytest.ini / tox.ini / nested package.json are added to the
// documented list because vitest, pytest-cov and monorepo workspaces keep thresholds there too.
const COVERAGE_GLOBS = [
  '**/{vitest,jest}.config.*', '**/vitest.workspace.*', '**/vite.config.*', '**/package.json', '**/.nycrc*',
  '**/codecov.y*ml', '**/pyproject.toml', '**/setup.cfg', '**/.coveragerc', '**/pytest.ini', '**/tox.ini',
];
const THRESHOLD_KEYS = ['lines', 'branches', 'functions', 'statements', 'threshold', 'fail_under', '--cov-fail-under', 'target'];
// `key<sep>N`: sep is `:` `=` or whitespace, the key may be quoted (JSON) and N may be a decimal, quoted or `%`-suffixed.
// `-` and word characters may not touch the key, so `max-lines` / `thresholds` are not `lines` / `threshold`.
const THRESHOLD_RE = new RegExp(`(?<![\\w-])(${THRESHOLD_KEYS.join('|')})(?![\\w-])["']?(?:\\s*[:=]\\s*|\\s+)["']?(-?\\d+(?:\\.\\d+)?)`, 'g');
// Whole gates: a removed line mentioning one of these with no added line mentioning it is a gate being deleted.
const THRESHOLD_BLOCKS = ['thresholds', 'coverageThreshold', 'fail_under', 'fail-under'];
// Comments in coverage configs. Not `--`: `--cov-fail-under=90` on an addopts continuation line is real config.
const CONFIG_COMMENT = /^\s*(?:\/\/|#|;|\/\*|\*(?:\s|$))/;

const MAX_EXCERPT = 120;

function testGlobs(config) {
  const globs = config?.integrity?.test_globs;
  if (!Array.isArray(globs)) throw new TypeError('config.integrity.test_globs must be an array of globs');
  return globs;
}

export function isTestFile(path, config) {
  return typeof path === 'string' && matchAny(path, testGlobs(config));
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

function testDeleted(files, isTest) {
  const out = [];
  for (const f of files) {
    if (f.status === 'D' && isTest(f.path)) {
      out.push(violation('test-deleted', f.path, undefined, 'deleted test file'));
    } else if (f.status === 'R' && isTest(f.oldPath) && !isTest(f.newPath)) {
      out.push(violation('test-deleted', f.oldPath, undefined, `renamed to ${f.newPath}, which is not a test file`));
    }
  }
  return out;
}

function skipOrOnlyAdded(files, isTest) {
  const out = [];
  for (const f of files) {
    if (f.status === 'D' || !isTest(f.path)) continue;
    const sql = matchAny(f.path, SQL_FILE);
    for (const l of f.added) {
      if (SKIP_RE.test(l.text) || (sql && SQL_SKIP_RE.test(l.text))) out.push(violation('skip-or-only-added', f.path, l.line, l.text));
    }
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
    if (![f.oldPath, f.newPath].some((p) => typeof p === 'string' && matchAny(p, COVERAGE_GLOBS))) continue;
    const removed = f.removed.filter((l) => !CONFIG_COMMENT.test(l.text));
    const added = f.added.filter((l) => !CONFIG_COMMENT.test(l.text));
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

function assertionsEdited(files, isTest) {
  const live = files.filter((f) => f.status !== 'D' && isTest(f.path));
  const hasNewTest = live.some((f) => f.added.some((l) => !COMMENT_LINE.test(l.text) && NEW_TEST_RE.test(l.text)));
  if (hasNewTest) return [];
  const out = [];
  for (const f of files) {
    const edited = f.status === 'M' ? isTest(f.path) : f.status === 'R' && isTest(f.oldPath) && isTest(f.newPath);
    if (!edited) continue;
    for (const l of f.removed) {
      if (!COMMENT_LINE.test(l.text) && ASSERT_RE.test(l.text)) out.push(violation('assertions-edited', f.path, l.line, l.text));
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
    ...testDeleted(files, isTest),
    ...skipOrOnlyAdded(files, isTest),
    ...coverageLowered(files),
    ...assertionsEdited(files, isTest),
  ];
  const overridden = [...(labels ?? [])].includes(OVERRIDE_LABEL);
  return { ok: overridden || violations.length === 0, overridden, violations };
}
