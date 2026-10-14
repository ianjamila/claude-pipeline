import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGitHub } from '../pipeline/lib/github.mjs';
import { fetchBranchPrs, checkRepoIdentity } from '../pipeline/lib/worktree-prune/prs.mjs';

const ok = (obj) => ({ code: 0, stdout: JSON.stringify(obj), stderr: '', timedOut: false });
const repoView = ok({ nameWithOwner: 'acme/widgets', defaultBranchRef: { name: 'main' } });
const page = (nodes, hasNextPage = false, endCursor = null) => ok({ data: { repository: { pullRequests: { pageInfo: { hasNextPage, endCursor }, nodes } } } });
const node = (o) => ({ number: 5, state: 'MERGED', createdAt: '2026-10-01T00:00:00Z', mergedAt: '2026-10-02T00:00:00Z', headRefName: 'feat/x', headRefOid: 'a'.repeat(40), isCrossRepository: false, headRepository: { nameWithOwner: 'acme/widgets' }, ...o });

function gh(script) {
  const calls = [];
  const ghFn = (args) => { calls.push(args); return script(args, calls.length); };
  return { gh: createGitHub({ cwd: '.', ghFn }), calls };
}

test('fetchBranchPrs: one page, filters by exact branch name', () => {
  const { gh: g, calls } = gh((args) => (args[0] === 'repo' ? repoView : page([node(), node({ number: 6, headRefName: 'feat/x-2' })])));
  const r = fetchBranchPrs(g, 'feat/x');
  assert.equal(r.ok, true);
  assert.deepEqual(r.prs.map((p) => p.number), [5]);
  assert.ok(calls.some((a) => a.join(' ').includes('headRefName')));
  assert.ok(calls.some((a) => a.includes('branch=feat/x')));
});

test('fetchBranchPrs: follows pagination', () => {
  const { gh: g } = gh((args, n) => (args[0] === 'repo' ? repoView : n === 2 ? page([node()], true, 'c1') : page([node({ number: 7, state: 'OPEN', mergedAt: null })])));
  assert.deepEqual(fetchBranchPrs(g, 'feat/x').prs.map((p) => p.number), [5, 7]);
});

test('fetchBranchPrs: any GitHub error => ok:false, never an empty list', () => {
  const { gh: g } = gh((args) => (args[0] === 'repo' ? repoView : { code: 1, stdout: '', stderr: 'API rate limit exceeded', timedOut: false }));
  const r = fetchBranchPrs(g, 'feat/x');
  assert.equal(r.ok, false);
  assert.match(r.reason, /PR data incomplete/);
});

test('fetchBranchPrs: a cursor that does not advance => ok:false', () => {
  const { gh: g } = gh((args) => (args[0] === 'repo' ? repoView : page([node()], true, 'same')));
  assert.equal(fetchBranchPrs(g, 'feat/x').ok, false);
});

test('checkRepoIdentity: gh repo must equal origin', () => {
  const { gh: g } = gh(() => repoView);
  assert.deepEqual(checkRepoIdentity(g, 'git@github.com:acme/widgets.git'), { ok: true, slug: 'acme/widgets' });
  assert.equal(checkRepoIdentity(g, 'https://github.com/acme/widgets').ok, true);
  assert.match(checkRepoIdentity(g, 'https://github.com/other/widgets.git').reason, /does not match origin/);
});
