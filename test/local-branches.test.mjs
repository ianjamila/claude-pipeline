import { test } from 'node:test';
import assert from 'node:assert/strict';
import path, { join } from 'node:path';
import { createTmpRepo } from './helpers/tmprepo.mjs';
import { listWorktrees, parseWorktreePorcelain } from '../pipeline/lib/local-branches.mjs';

// main with one commit, plus branch `agent/x` at `live`; the main checkout stays on main.
function setup() {
  const repo = createTmpRepo();
  repo.write('a.txt', 'one\n');
  const base = repo.commit('base');
  repo.branch('agent/x');
  repo.write('b.txt', 'two\n');
  const live = repo.commit('live head');
  repo.checkout('main');
  return { repo, base, live };
}

const wt = (repo, name, branch, extra = []) => {
  const dir = join(repo.dir, '.worktrees', name);
  repo.git(['worktree', 'add', '-q', dir, ...extra, branch]);
  return dir;
};

test('listWorktrees: main first, branch names without refs/heads, detached has no branch', () => {
  const { repo, live } = setup();
  const dir = wt(repo, 'x', 'agent/x');
  const det = join(repo.dir, '.worktrees', 'det');
  repo.git(['worktree', 'add', '-q', '--detach', det, live]);
  const list = listWorktrees(repo.dir);
  assert.equal(list[0].path, repo.dir);
  assert.equal(list[0].branch, 'main');
  assert.equal(list.find((w) => w.path === dir).branch, 'agent/x');
  assert.equal(list.find((w) => w.path === det).branch, null);
});

// Windows git prints forward-slash paths (`C:/Users/x/repo`); every path leaving the parser is the platform's native form,
// so a comparison against path.join / path.resolve output (and a `git -C <path>` call) agrees. Runs on Linux too: the
// platform is passed in.
test('parseWorktreePorcelain: Windows forward-slash paths become native backslash paths; POSIX stays as printed', () => {
  const win = [
    'worktree C:/Users/me/repo', 'HEAD aaaa', 'branch refs/heads/main', '',
    'worktree C:/Users/me/repo/.worktrees/x', 'HEAD bbbb', 'branch refs/heads/agent/x', '',
    'worktree //server/share/repo/.worktrees/y', 'HEAD cccc', 'detached', '',
  ].join('\n');
  const list = parseWorktreePorcelain(win, 'win32');
  assert.deepEqual(list.map((w) => w.path), ['C:\\Users\\me\\repo', 'C:\\Users\\me\\repo\\.worktrees\\x', '\\\\server\\share\\repo\\.worktrees\\y']);
  assert.equal(list[1].path, path.win32.join('C:\\Users\\me\\repo', '.worktrees', 'x'));
  assert.equal(list[1].branch, 'agent/x');
  assert.equal(list[2].branch, null);
  const posix = parseWorktreePorcelain('worktree /home/me/repo\nHEAD aaaa\nbranch refs/heads/main\n\n', 'linux');
  assert.equal(posix[0].path, '/home/me/repo');
});

test('parseWorktreePorcelain: locked, prunable, detached', () => {
  const out = [
    'worktree /r', 'HEAD aaa', 'branch refs/heads/main', '',
    'worktree /r/.worktrees/a', 'HEAD bbb', 'branch refs/heads/a', 'locked pipeline-keep: ship run 7', '',
    'worktree /r/.worktrees/b', 'HEAD ccc', 'detached', 'locked', '',
    'worktree /r/.worktrees/c', 'HEAD ddd', 'branch refs/heads/c', 'prunable gitdir file points to non-existent location', '',
  ].join('\n');
  const [m, a, b, c] = parseWorktreePorcelain(out, 'linux');
  assert.equal(m.locked, null); assert.equal(m.prunable, false); assert.equal(m.detached, false);
  assert.equal(a.locked, 'pipeline-keep: ship run 7');
  assert.equal(b.locked, ''); assert.equal(b.detached, true); assert.equal(b.branch, null);
  assert.equal(c.prunable, true);
});
