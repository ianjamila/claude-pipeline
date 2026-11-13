// The repo's own .claude/pipeline.yml: it must validate, and its risk settings must stay what the rating tests and the plan assume.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseYaml } from '../pipeline/lib/yaml.mjs';
import { validateConfig } from '../pipeline/lib/config.mjs';

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
  for (const p of ['pipeline/lib/glob.mjs', 'pipeline/lib/git.mjs', 'pipeline/lib/diff.mjs', 'pipeline/lib/doc-paths.mjs', 'pipeline/lib/docs-exempt.mjs', 'install.sh', 'install.ps1']) {
    assert.ok(list.includes(p), p);
  }
});
