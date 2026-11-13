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
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

// Comments are dropped first (a `//` or `/*` only counts at a line start or after whitespace, so URLs and globs in strings survive).
function importSpecifiers(src) {
  const code = src.replace(/(^|\s)\/\*[\s\S]*?\*\//g, '$1 ').replace(/(^|\s)\/\/[^\n]*/g, '$1');
  return [...[...code.matchAll(STATIC_IMPORT_RE)].map((m) => m[1]), ...[...code.matchAll(DYNAMIC_IMPORT_RE)].map((m) => m[1])];
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

test('repo config: the import walker follows a dynamic import with a literal path and ignores a computed one or a commented one', () => {
  const src = "const m = await import('./dyn.mjs');\nconst n = import(\"../up.mjs\").then((x) => x);\nawait import(name);\nawait import(`./tpl-${x}.mjs`);\n// await import('./nope.mjs');\n";
  assert.deepEqual(importSpecifiers(src), ['./dyn.mjs', '../up.mjs']);
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
  assert.ok(closure.length > 5, `suspiciously small import closure: ${closure.join(', ')}`);
  const uncovered = closure.filter((f) => !matchAny(f, list, { nocase: true }));
  assert.deepEqual(uncovered, [], `imported by pipeline/lib/risk.mjs but not in risk.high_risk_paths: ${uncovered.join(', ')}`);
});
