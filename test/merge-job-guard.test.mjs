// merge-carry C11: while a live `P merge --owner-go` job owns a checkout, the git guard refuses branch / index / worktree
// mutating git commands there (and only there), and `pipeline job start` gets the same answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { evaluateGitCommand } from '../pipeline/hooks/lib/git-policy.mjs';
import { realGitWiring } from '../pipeline/hooks/lib/git-wiring.mjs';
import { guardVerdict } from '../pipeline/lib/command-guard.mjs';

const fwd = (p) => p.replace(/\\/g, '/'); // forward slashes in command text: backslashes are shell escapes
const fakeRepo = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mj-guard-')));
  mkdirSync(join(root, '.git')); // the lookup only needs the checkout root marker, not a real repository
  mkdirSync(join(root, 'src'));
  return root;
};
const mark = (root, pid, pr = 12) => {
  mkdirSync(join(root, '.review'), { recursive: true });
  writeFileSync(join(root, '.review', 'merge-job.json'), JSON.stringify({ pr, pid, branch: 'agent/x', expectedHead: 'a'.repeat(40), startedAt: '2026-11-06T10:00:00.000Z' }));
};
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid;
const wiring = realGitWiring();
const decide = (command, cwd) => evaluateGitCommand(command, { cwd, ...wiring });

test('a live job blocks mutating git in its checkout: cwd, -C and cd', () => {
  const root = fakeRepo();
  const other = fakeRepo();
  mark(root, process.pid, 12);
  for (const [command, cwd] of [
    ['git checkout other', root],
    ['git switch -c y', root],
    ['git reset --hard', root],
    [`git -C ${fwd(root)} reset --hard`, other],
    [`cd ${fwd(root)} && git commit -m x`, other],
    ['git commit -am x', join(root, 'src')], // a subfolder is still the same checkout
    ['git merge main', root],
    ['git rebase main', root],
    ['git cherry-pick abc', root],
    ['git revert HEAD', root],
    ['git stash', root],
    ['git stash pop', root],
    ['git pull', root],
    ['git restore a.txt', root],
    ['git am x.patch', root],
    [`git worktree remove ${fwd(root)}`, other],
    [`git -C ${fwd(other)} worktree remove ${fwd(root)}`, other],
    [`git worktree move ${fwd(root)} ${fwd(root)}-2`, other],
    ['git worktree remove .', root],
  ]) {
    const v = decide(command, cwd);
    assert.equal(v.decision, 'deny', command);
    assert.match(v.reason, /P merge --owner-go.*job \(pid \d+, PR #12\) owns this checkout until it ends.*wait for it or stop it/s, command);
  }
});

test('read-only git, P commands and other checkouts are not affected', () => {
  const root = fakeRepo();
  const other = fakeRepo();
  mark(root, process.pid);
  for (const command of ['git status', 'git log --oneline', 'git diff', 'git fetch origin', 'git show HEAD', 'git rev-parse HEAD', 'git stash list', 'git branch --show-current', 'git worktree list', 'git worktree add ../x -b agent/y', 'P review status', 'node pipeline/bin/pipeline.mjs review status']) {
    assert.equal(decide(command, root).decision, 'allow', command);
  }
  assert.equal(decide('git checkout x', other).decision, 'allow'); // another checkout
  assert.equal(decide(`git -C ${fwd(other)} reset --hard`, root).decision, 'allow');
  assert.equal(decide(`git worktree remove ${fwd(other)}`, root).decision, 'allow'); // removing a different checkout
});

test('a dead pid, a garbled marker or no marker blocks nothing', () => {
  const root = fakeRepo();
  assert.equal(decide('git checkout x', root).decision, 'allow'); // no marker
  mark(root, deadPid());
  assert.equal(decide('git checkout x', root).decision, 'allow'); // stale
  writeFileSync(join(root, '.review', 'merge-job.json'), '{ nope');
  assert.equal(decide('git checkout x', root).decision, 'allow'); // garbled
  writeFileSync(join(root, '.review', 'merge-job.json'), JSON.stringify({ pid: process.pid }));
  assert.equal(decide('git checkout x', root).decision, 'allow'); // wrong shape
});

test('a git alias to a blocked verb is blocked too', () => {
  const root = fakeRepo();
  mark(root, process.pid);
  assert.equal(decide('git -c alias.co=checkout co x', root).decision, 'deny');
});

test('job start consults the same policy', () => {
  const root = fakeRepo();
  mark(root, process.pid, 31);
  const blocked = guardVerdict('git checkout x', { cwd: root, env: process.env });
  assert.equal(blocked.allow, false);
  assert.match(blocked.reason, /job \(pid \d+, PR #31\)/);
  assert.equal(guardVerdict('git status', { cwd: root, env: process.env }).allow, true);
});
