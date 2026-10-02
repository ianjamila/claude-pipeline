// Facts the docs state about the installer hooks and the Vercel rollback, pinned to the code that makes them true.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GUARD_FILES_MATCHER, GUARD_GIT_MATCHER } from '../pipeline/lib/installer.mjs';
import { rollback } from '../pipeline/lib/vercel.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(root, rel), 'utf8');
const ROLLBACK = 'vercel rollback <known-good> --yes --timeout 3m';

test('installer hook matchers are what the docs say', () => {
  assert.equal(GUARD_GIT_MATCHER, 'Bash|PowerShell');
  assert.equal(GUARD_FILES_MATCHER, 'Edit|Write|MultiEdit|NotebookEdit|Bash|PowerShell|mcp__.*');
  const spec = read('docs/specs/2026-10-01-claude-pipeline-design.md');
  assert.ok(spec.includes(`**guard-git** (matcher \`${GUARD_GIT_MATCHER}\`)`));
  assert.ok(spec.includes(`**guard-files** (matcher \`${GUARD_FILES_MATCHER}\`)`));
});

test('the Vercel rollback the docs describe is the command prod-watch runs', () => {
  const calls = [];
  const out = rollback('dpl_abc', { cwd: '/x', env: { PIPELINE_VERCEL: undefined }, runFn: (cmd, args) => { calls.push(args); return { code: 0, stdout: '', stderr: '' }; } });
  assert.equal(out.ok, true);
  assert.deepEqual(calls[0].slice(-5), ['rollback', 'dpl_abc', '--yes', '--timeout', '3m']);
  for (const doc of ['pipeline/templates/pipeline.yml', 'skills/pipeline-setup/reference/stack-recipes.md', 'skills/ship/SKILL.md']) {
    const text = read(doc).replace(/\s*\n#?\s*/g, ' ');
    assert.ok(text.includes(ROLLBACK), `${doc} must state \`${ROLLBACK}\``);
    assert.ok(!text.includes('{deployment}'), `${doc} still has the old {deployment} placeholder`);
  }
});
