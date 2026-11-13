// The repo's own .claude/pipeline.yml: it must validate, and its risk settings must stay what the rating tests and the plan assume.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseYaml } from '../pipeline/lib/yaml.mjs';
import { validateConfig } from '../pipeline/lib/config.mjs';
import { matchAny } from '../pipeline/lib/glob.mjs';

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

// Static relative imports of a source file: `import ... from './x.mjs'`, `export ... from '../x.mjs'`, bare `import './x.mjs'`, also over several lines.
// A statement must start a line, so a commented-out import is not followed. Bare specifiers (node:fs, packages) are ignored.
const IMPORT_RE = /(?:^|\n)[ \t]*(?:import|export)\s+(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/g;

function importClosure(startRel) {
  const seen = new Set();
  const queue = [startRel];
  while (queue.length) {
    const rel = queue.pop();
    if (seen.has(rel)) continue;
    const abs = path.join(root, rel);
    assert.ok(fs.existsSync(abs), `${rel} is imported but does not exist`);
    seen.add(rel);
    for (const m of fs.readFileSync(abs, 'utf8').matchAll(IMPORT_RE)) {
      if (!m[1].startsWith('./') && !m[1].startsWith('../')) continue;
      queue.push(path.relative(root, path.resolve(path.dirname(abs), m[1])).split(path.sep).join('/'));
    }
  }
  return [...seen].sort();
}

test('repo config: the import walker finds multi-line, export-from and bare imports and skips bare specifiers and comments', () => {
  const src = "import a from './a.mjs';\nimport {\n  b,\n  c,\n} from '../b.mjs';\nexport { d } from './d.mjs';\nimport './e.mjs';\nimport fs from 'node:fs';\n// import x from './nope.mjs';\nexport const s = './f.mjs';\n";
  const found = [...src.matchAll(IMPORT_RE)].map((m) => m[1]);
  assert.deepEqual(found, ['./a.mjs', '../b.mjs', './d.mjs', './e.mjs', 'node:fs']);
});

test('repo config: every file the risk rating imports (transitively) is covered by risk.high_risk_paths', () => {
  const list = raw.risk.high_risk_paths;
  const closure = importClosure('pipeline/lib/risk.mjs');
  assert.ok(closure.length > 5, `suspiciously small import closure: ${closure.join(', ')}`);
  const uncovered = closure.filter((f) => !matchAny(f, list, { nocase: true }));
  assert.deepEqual(uncovered, [], `imported by pipeline/lib/risk.mjs but not in risk.high_risk_paths: ${uncovered.join(', ')}`);
});
