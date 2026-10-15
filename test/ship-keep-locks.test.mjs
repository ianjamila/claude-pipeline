// A ship run that keep-locks a worktree (`P worktrees keep X --reason "ship run X"`) must also release it
// (`P worktrees unkeep X --run X`) somewhere in the skill, or prune keeps that worktree forever. Placeholder ids
// (`<worktree dir name>`) are skipped: the resume step names whichever worktree it entered, released by Step 7.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const skill = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'ship', 'SKILL.md'), 'utf8');

test('every concrete ship-run keep lock in the ship skill has a matching unkeep --run', () => {
  const keeps = [...skill.matchAll(/P worktrees keep (\S+) --reason "ship run ([^"]+)"/g)].map((m) => ({ name: m[1], run: m[2] }));
  const unkeeps = new Set([...skill.matchAll(/P worktrees unkeep (\S+) --run ([^\s`]+)/g)].map((m) => `${m[1]} ${m[2]}`));
  const concrete = keeps.filter((k) => !k.name.startsWith('<'));
  assert.ok(concrete.some((k) => k.name === 'agent-<slug>-prod'), 'the observe-prod worktree is keep-locked');
  for (const k of concrete) {
    assert.equal(k.run, k.name, `keep ${k.name}: the run id is the worktree name`);
    assert.ok(unkeeps.has(`${k.name} ${k.run}`), `keep ${k.name} has no matching \`P worktrees unkeep ${k.name} --run ${k.run}\``);
  }
});
