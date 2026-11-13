// The repo's own .claude/pipeline.yml: it must validate, and its risk settings must stay what the rating tests and the plan assume.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseYaml } from '../pipeline/lib/yaml.mjs';
import { validateConfig } from '../pipeline/lib/config.mjs';
import { matchAny } from '../pipeline/lib/glob.mjs';
import { assessRisk, reviewLane } from '../pipeline/lib/risk.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const raw = parseYaml(fs.readFileSync(path.join(root, '.claude', 'pipeline.yml'), 'utf8'));

test('repo config: .claude/pipeline.yml passes validateConfig', () => {
  const r = validateConfig(raw);
  assert.equal(r.ok, true, r.errors.join('; '));
});

test('repo config: every literal high_risk_paths entry exists on disk', () => {
  const list = raw.risk.high_risk_paths;
  assert.ok(Array.isArray(list) && list.length > 0);
  for (const p of list.filter((x) => !/[*?[{]/.test(x))) {
    assert.ok(fs.existsSync(path.join(root, p)), `${p} is in risk.high_risk_paths but does not exist`);
  }
});

test('repo config: ignore_hard_stop_rules is exactly P-path and R4-config', () => {
  assert.deepEqual(raw.risk.ignore_hard_stop_rules, ['P-path', 'R4-config']);
  assert.deepEqual(validateConfig(raw).config.risk.ignore_hard_stop_rules, ['P-path', 'R4-config']);
});

test('repo config: the rating tests read this same high_risk_paths list (no hand-copied fixture); no duplicates; the helper and wrapper files are in it', () => {
  const src = fs.readFileSync(path.join(root, 'test', 'risk-rate-branch.test.mjs'), 'utf8');
  assert.match(src, /CP_HIGH = parseYaml\(.*\.claude\/pipeline\.yml.*\)\.risk\.high_risk_paths/, 'risk-rate-branch.test.mjs must read the real list, not a copy');
  const list = raw.risk.high_risk_paths;
  assert.equal(new Set(list).size, list.length);
  for (const p of ['pipeline/lib/glob.mjs', 'pipeline/lib/git.mjs', 'pipeline/lib/diff.mjs', 'pipeline/lib/doc-paths.mjs', 'pipeline/lib/docs-exempt.mjs', 'pipeline/lib/yaml.mjs', 'pipeline/vendor/**', 'pipeline/lib/proc.mjs', 'pipeline/lib/paths.mjs', 'pipeline/lib/resolution.mjs', 'pipeline/lib/seams.mjs', 'pipeline/lib/shell-words.mjs', 'install.sh', 'install.ps1']) {
    assert.ok(list.includes(p), p);
  }
});

// Static relative imports of a source file: `import ... from './x.mjs'`, `export ... from '../x.mjs'`, bare `import './x.mjs'`, also over
// several lines (the braces may hold comments with quotes, semicolons or braces), plus dynamic `import('./x.mjs')` with a literal path.
// A statement must start a line, so a commented-out import is not followed. Bare specifiers (node:fs, packages) are ignored.
const STATIC_IMPORT_RE = /(?:^|\n)[ \t]*(?:import|export)\s+(?:(?:[^'";{}]|\{[^}]*\})*?\s*from\s*)?['"]([^'"]+)['"]/g;
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*(?:['"]([^'"]+)['"]|`((?:[^`$\\]|\$(?!\{))+)`)\s*\)/g;

// Comments are dropped in ONE pass that also tracks string literals ('…', "…", `…`), so a `/*` or `//` inside a string, or a `/*` inside a
// `//` comment, never starts a comment, and a block comment ends only at its own `*/`. A '…' or "…" string ends at a newline too, so a quote
// inside a regex literal cannot swallow the rest of the file. Strings are kept (the specifiers are in them).
function stripComments(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') i++;
    } else if (c === '/' && n === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? src.length : end + 2;
      out += ' ';
    } else if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== c && !(c !== '`' && src[j] === '\n')) j += src[j] === '\\' ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j + 1;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

function importSpecifiers(src) {
  const code = stripComments(src);
  return [...[...code.matchAll(STATIC_IMPORT_RE)].map((m) => m[1]), ...[...code.matchAll(DYNAMIC_IMPORT_RE)].map((m) => m[1] ?? m[2])];
}

function importClosure(startRel) {
  const seen = new Set();
  const queue = [startRel];
  while (queue.length) {
    const rel = queue.pop();
    if (seen.has(rel)) continue;
    const abs = path.join(root, rel);
    assert.ok(fs.existsSync(abs), `${rel} is imported but does not exist`);
    seen.add(rel);
    for (const spec of importSpecifiers(fs.readFileSync(abs, 'utf8'))) {
      if (!spec.startsWith('./') && !spec.startsWith('../')) continue;
      queue.push(path.relative(root, path.resolve(path.dirname(abs), spec)).split(path.sep).join('/'));
    }
  }
  return [...seen].sort();
}

test('repo config: the import walker finds multi-line, export-from and bare imports and skips bare specifiers and comments', () => {
  const src = "import a from './a.mjs';\nimport {\n  b,\n  c,\n} from '../b.mjs';\nexport { d } from './d.mjs';\nimport './e.mjs';\nimport fs from 'node:fs';\n// import x from './nope.mjs';\nexport const s = './f.mjs';\n";
  assert.deepEqual(importSpecifiers(src), ['./a.mjs', '../b.mjs', './d.mjs', './e.mjs', 'node:fs']);
});

test('repo config: the import walker follows a dynamic import with a literal path and accepts a backtick one with no interpolation, and ignores an interpolated one or a commented one', () => {
  const src = "const m = await import('./dyn.mjs');\nconst n = import(\"../up.mjs\").then((x) => x);\nawait import(name);\nawait import(`./tpl-${x}.mjs`);\nawait import(`./tick.mjs`);\n// await import('./nope.mjs');\n";
  assert.deepEqual(importSpecifiers(src), ['./dyn.mjs', '../up.mjs', './tick.mjs']);
});

test('repo config: the import walker does not skip a multi-line import whose braces hold a comment with a quote, semicolon or brace', () => {
  const src = [
    "import {",
    "  a, // the owner's pick; see #1",
    "  /* don't drop; \"b\" } */ b,",
    "  c, // a } stray brace",
    "} from './multi.mjs';",
    "import { d } from './after.mjs';",
    "",
  ].join('\n');
  assert.deepEqual(importSpecifiers(src), ['./multi.mjs', './after.mjs']);
});

test('repo config: a `/*` inside a string or a `//` comment does not hide the imports after it (only a real comment is dropped)', () => {
  const inString = "const g = 'a /* b';\nimport { x } from './kept-after-string.mjs';\nconst h = 'src/**/*.mjs';\nexport { y } from './kept-after-glob.mjs';\n";
  assert.deepEqual(importSpecifiers(inString), ['./kept-after-string.mjs', './kept-after-glob.mjs']);
  const inLine = "// see /* the glob\nimport { x } from './kept-after-line.mjs';\n// and src/**/ here\nimport './kept-after-glob.mjs';\n";
  assert.deepEqual(importSpecifiers(inLine), ['./kept-after-line.mjs', './kept-after-glob.mjs']);
  const inTemplate = "const t = `/* ${1}`;\nimport z from './kept-after-template.mjs';\n/* real */ import w from './kept-after-block.mjs';\n";
  assert.deepEqual(importSpecifiers(inTemplate), ['./kept-after-template.mjs', './kept-after-block.mjs']);
  // A real block comment still hides an import it holds, and ends at its own `*/`.
  assert.deepEqual(importSpecifiers("/*\nimport a from './hidden.mjs';\n*/\nimport b from './shown.mjs';\n"), ['./shown.mjs']);
});

test('repo config: the gate and review-proof named set is in risk.high_risk_paths, and a one-line change to any of them rates high', () => {
  const named = [
    'pipeline/lib/transcript.mjs', 'pipeline/lib/ci-proof.mjs', 'pipeline/lib/integrity.mjs', 'pipeline/lib/guard-provenance.mjs',
    'pipeline/lib/state.mjs', 'pipeline/lib/review-publish.mjs', 'pipeline/lib/review-context.mjs', 'pipeline/lib/locks.mjs',
    'pipeline/lib/round-status.mjs', 'pipeline/commands/final-gate.mjs', 'pipeline/commands/triage.mjs', 'pipeline/commands/model-proof.mjs',
    'pipeline/bin/pipeline.mjs',
  ];
  const list = raw.risk.high_risk_paths;
  const { config } = validateConfig(raw);
  for (const p of named) {
    assert.ok(matchAny(p, list, { nocase: true }), `${p} is not matched by risk.high_risk_paths`);
    const files = [{ path: p, added: ['// one line'], removed: [] }];
    const r = assessRisk({ files, hits: [], config });
    assert.equal(r.level, 'high', `${p}: ${r.reasons.join('; ')}`);
    assert.equal(r.drivers.path, true, p);
    assert.equal(reviewLane({ level: r.level, files, config }).reviewer, 'fable', p);
  }
  // Control: a file outside the list with the same one-line change stays low and goes to the judge.
  const other = [{ path: 'pipeline/lib/unlisted-example.mjs', added: ['// one line'], removed: [] }];
  assert.equal(assessRisk({ files: other, hits: [], config }).level, 'low');
});

test('repo config: every file the risk rating imports (transitively) is covered by risk.high_risk_paths', () => {
  const list = raw.risk.high_risk_paths;
  const closure = importClosure('pipeline/lib/risk.mjs');
  // The 14 files the rater reads today (2026-11-13). A walker that silently loses an import drops one of them and fails here; a NEW
  // import only grows the closure and must be covered by the check below.
  const known = [
    'pipeline/lib/risk.mjs', 'pipeline/lib/config.mjs', 'pipeline/lib/diff.mjs', 'pipeline/lib/doc-paths.mjs', 'pipeline/lib/git.mjs',
    'pipeline/lib/glob.mjs', 'pipeline/lib/hardstops.mjs', 'pipeline/lib/paths.mjs', 'pipeline/lib/proc.mjs', 'pipeline/lib/resolution.mjs',
    'pipeline/lib/seams.mjs', 'pipeline/lib/shell-words.mjs', 'pipeline/lib/yaml.mjs', 'pipeline/vendor/js-yaml.mjs',
  ];
  assert.deepEqual(known.filter((f) => !closure.includes(f)), [], `import closure of pipeline/lib/risk.mjs lost a known file: ${closure.join(', ')}`);
  assert.ok(closure.length >= known.length, `suspiciously small import closure: ${closure.join(', ')}`);
  const uncovered = closure.filter((f) => !matchAny(f, list, { nocase: true }));
  assert.deepEqual(uncovered, [], `imported by pipeline/lib/risk.mjs but not in risk.high_risk_paths: ${uncovered.join(', ')}`);
});
