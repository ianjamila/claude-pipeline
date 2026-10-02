// claude-pipeline onboarded to itself: its own scripts/verify.mjs must stay the project template (only the STEPS
// block, PROJECT and the library import paths differ), its .claude/pipeline.yml must load and keep every path a
// hard-stop, and the CI job names must be the checks that config requires.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../pipeline/lib/config.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(root, rel), 'utf8');
async function selfConfig() {
  const loaded = await loadConfig(root);
  assert.equal(loaded.ok, true, `pipeline.yml invalid: ${loaded.errors?.join('; ')}`);
  return loaded.config;
}
const BLOCK_START = '// ---- EDIT THIS';
const BLOCK_END = '// ---- end of the project-specific part';

// Everything that is allowed to differ, removed: the header comment up to the first import, the STEPS block, PROJECT,
// and the import prefix (the template imports vendored ./pipeline/lib, this repo imports its own ../pipeline/lib).
function generic(src) {
  const start = src.indexOf(BLOCK_START);
  const end = src.indexOf(BLOCK_END);
  assert.ok(start > 0 && end > start, 'project-specific block markers present');
  return (src.slice(src.indexOf('\nimport '), start) + src.slice(end))
    .replace(/^const PROJECT = .*$/m, 'const PROJECT = <project>;')
    .replaceAll("from '../pipeline/lib/", "from './pipeline/lib/");
}

test("scripts/verify.mjs is the template's generic part, unchanged", () => {
  assert.equal(generic(read('scripts/verify.mjs')), generic(read('pipeline/templates/scripts/verify.mjs')));
});

test('the self pipeline.yml loads, names the project verify.mjs uses, and makes every path a hard-stop', async () => {
  const cfg = await selfConfig();
  assert.equal(cfg.project, 'claude-pipeline');
  assert.match(read('scripts/verify.mjs'), /^const PROJECT = 'claude-pipeline';/m);
  assert.deepEqual(cfg.hard_stops.paths, ['**']);
  assert.equal(cfg.verify.full, 'node scripts/verify.mjs');
  assert.deepEqual(cfg.verify.expected_steps, ['tests']);
  assert.match(cfg.merge.command, /--match-head-commit \{sha\}/);
});

test('CI job names are exactly the required checks', async () => {
  const ci = read('.github/workflows/ci.yml');
  const names = [...ci.matchAll(/^ {4}name: (.+)$/gm)].map((m) => m[1].trim());
  assert.deepEqual(names.sort(), [...(await selfConfig()).ci.required_checks].sort());
  const shells = [...ci.matchAll(/^\s*shell:\s*(\S+)/gm)].map((m) => m[1]);
  assert.deepEqual(shells, ['bash'], 'one workflow-wide default, bash, and no step overrides it');
});
