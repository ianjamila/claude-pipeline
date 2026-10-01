import { test } from 'node:test';
import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { createTmpRepo } from './helpers/tmprepo.mjs';
import { repoRoot, gitCommonDir, pipelineStateDir, repoSlug } from '../pipeline/lib/repo.mjs';

test('repoRoot and gitCommonDir resolve for a repo and its worktree', () => {
  const r = createTmpRepo();
  try {
    r.write('a.txt', 'a\n'); r.commit('init');
    assert.equal(realpathSync(repoRoot(r.dir)), realpathSync(r.dir));
    const wt = join(r.dir, '..', `${r.dir.split(/[\\/]/).pop()}-wt`);
    r.git(['worktree', 'add', '-q', '-b', 'side', wt]);
    assert.equal(realpathSync(gitCommonDir(wt)), realpathSync(join(r.dir, '.git')));
    assert.equal(pipelineStateDir(wt), join(gitCommonDir(wt), 'claude-pipeline'));
    r.git(['worktree', 'remove', '--force', wt]);
  } finally { r.cleanup(); }
});

test('repoSlug parses nameWithOwner and default branch', () => {
  const s = repoSlug('.', { ghJsonFn: () => ({ nameWithOwner: 'o/r', defaultBranchRef: { name: 'trunk' } }) });
  assert.deepEqual(s, { owner: 'o', name: 'r', slug: 'o/r', defaultBranch: 'trunk' });
  assert.throws(() => repoSlug('.', { ghJsonFn: () => ({}) }), /could not resolve/);
});
