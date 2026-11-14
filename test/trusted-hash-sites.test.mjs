// #448: the helpers every hash / behind-base site shares measure from the trusted default branch (risk.mjs#trustedDefaultBranch), not from the working-tree config's
// default_branch, which a PR can edit. Real git with a bare origin whose origin/HEAD names main.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { refreshBaseRef } from '../pipeline/lib/review-context.mjs';
import { lazyDiff } from '../pipeline/lib/finalgate.mjs';
import { draftBehindBase } from '../pipeline/commands/review-complete.mjs';
import { createTmpRepo } from './helpers/tmprepo.mjs';
import { addOrigin, breakOrigin } from './helpers/origin.mjs';

function world(t) {
  const repo = createTmpRepo();
  t.after(() => repo.cleanup());
  repo.write('src/a.js', 'one\ntwo\nthree\n');
  const base = repo.commit('base');
  const bare = addOrigin(t, repo);
  repo.branch('feat/x');
  repo.write('src/a.js', 'one\ntwo\nTHREE\n');
  repo.commit('edit');
  return { repo, base, bare };
}

test('lazyDiff falls back to the trusted branch when GitHub names no base', (t) => {
  const { repo, base } = world(t);
  repo.git(['branch', 'evil', 'HEAD']); // the working tree names a branch that holds the PR head: from it the diff would be empty
  const d = lazyDiff(repo.dir, { default_branch: 'evil' })();
  assert.equal(d.ok, true, d.error);
  assert.equal(d.mb, base);
  assert.deepEqual(d.files.map((f) => f.newPath ?? f.path), ['src/a.js']);
});

// A working-tree default_branch that differs from the committed config makes the whole CLI ask for a Fable review before this check runs, so the check is exercised directly.
test('draftBehindBase compares with the trusted branch, not the working-tree default_branch', (t) => {
  const { repo } = world(t);
  repo.git(['branch', 'old', 'HEAD']); // a branch HEAD already contains: measured from it, the draft would not be behind
  repo.checkout('main');
  repo.write('src/from-main.js', 'export const m = 1;\n');
  repo.commit('main moves on');
  repo.git(['push', '-q', 'origin', 'main']);
  repo.git(['fetch', '-q', 'origin']);
  repo.checkout('feat/x');
  const gh = { queueState: () => ({ enabled: false }) };
  const r = draftBehindBase({
    root: repo.dir, config: { default_branch: 'old' }, gh, pr: 7, view: { isDraft: true, mergeable: 'MERGEABLE' }, refresh: { refreshed: true },
  });
  assert.equal(r.refusal?.reason, 'behind-base', JSON.stringify(r));
  assert.equal(r.refusal.base, 'main');
});

test('refreshBaseRef.refreshed is false when the fetch of the trusted branch failed, even though the working-tree branch could be fetched', (t) => {
  const { repo, bare } = world(t);
  repo.git(['push', '-q', 'origin', 'HEAD:refs/heads/evil']); // the working-tree value is fetchable ...
  rmSync(`${bare}/refs/heads/main`, { force: true }); // ... the trusted one (main, per origin/HEAD) is gone from the remote
  const r = refreshBaseRef(repo.dir, { default_branch: 'evil' });
  assert.equal(r.refreshed, false);
  assert.equal(typeof r.reason, 'string');
  assert.equal(r.usesRemoteRef, true, 'the cached refs/remotes/origin/main is what the hash is measured from');
});

test('refreshBaseRef.refreshed is false when the fetch failed (a broken remote URL)', (t) => {
  const { repo } = world(t);
  breakOrigin(repo);
  const r = refreshBaseRef(repo.dir, { default_branch: 'main' });
  assert.equal(r.refreshed, false);
  assert.equal(r.usesRemoteRef, true);
});
