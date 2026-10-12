import { test } from 'node:test';
import assert from 'node:assert/strict';
import path, { join } from 'node:path';
import { createTmpRepo } from './helpers/tmprepo.mjs';
import { listWorktrees, localBranchState, orphanWorktrees, parseWorktreePorcelain } from '../pipeline/lib/local-branches.mjs';

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

test('localBranchState: no local ref at all => none', () => {
  const { repo, live } = setup();
  const s = localBranchState(repo.dir, 'agent/nope', live);
  assert.equal(s.state, 'none');
  assert.equal(s.localRef, null);
  assert.deepEqual(s.worktrees, []);
});

test('localBranchState: a local ref without any worktree is still found (equal)', () => {
  const { repo, live } = setup();
  const s = localBranchState(repo.dir, 'agent/x', live);
  assert.equal(s.state, 'equal');
  assert.equal(s.localRef, live);
  assert.deepEqual(s.worktrees, []);
  assert.equal(s.unpushed, 0);
  assert.equal(s.dirty, 0);
});

test('localBranchState: local commits beyond the live head => ahead n; behind; diverged', () => {
  const { repo, base, live } = setup();
  const dir = wt(repo, 'x', 'agent/x');
  repo.git(['-C', dir, 'commit', '-q', '--allow-empty', '-m', 'local 1']);
  repo.git(['-C', dir, 'commit', '-q', '--allow-empty', '-m', 'local 2']);
  const ahead = localBranchState(repo.dir, 'agent/x', live);
  assert.equal(ahead.state, 'ahead');
  assert.equal(ahead.unpushed, 2);
  assert.equal(ahead.worktrees.length, 1);
  assert.equal(ahead.worktrees[0].path, dir);

  // the live head moved on past the local ref: local is behind
  repo.git(['branch', 'ref-live', live]);
  repo.git(['-C', dir, 'reset', '-q', '--hard', base]);
  const behind = localBranchState(repo.dir, 'agent/x', live);
  assert.equal(behind.state, 'behind');
  assert.equal(behind.unpushed, 0);

  // local has its own commit on top of base while the live head has another: diverged
  repo.git(['-C', dir, 'commit', '-q', '--allow-empty', '-m', 'mine']);
  const diverged = localBranchState(repo.dir, 'agent/x', live);
  assert.equal(diverged.state, 'diverged');
  assert.equal(diverged.unpushed, 1);
});

test('localBranchState: dirty entries are counted over the worktree; a live head object we lack => unknown', () => {
  const { repo, live } = setup();
  const dir = wt(repo, 'x', 'agent/x');
  repo.write('.worktrees/x/untracked.txt', 'u\n');
  repo.write('.worktrees/x/a.txt', 'changed\n');
  const s = localBranchState(repo.dir, 'agent/x', live);
  assert.equal(s.state, 'equal');
  assert.equal(s.dirty, 2);
  assert.equal(s.worktrees[0].dirty, 2);
  const unknown = localBranchState(repo.dir, 'agent/x', 'f'.repeat(40));
  assert.equal(unknown.state, 'unknown');
  assert.equal(unknown.dirty, 2);
  void dir;
});

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

test('orphanWorktrees: only worktrees under the container whose branch has no open PR', () => {
  const { repo } = setup();
  repo.git(['branch', 'agent/y']);
  repo.git(['branch', 'agent/z']);
  const x = wt(repo, 'x', 'agent/x');
  const y = wt(repo, 'y', 'agent/y');
  const elsewhere = join(repo.dir, '..', `elsewhere-${Date.now()}`);
  repo.git(['worktree', 'add', '-q', elsewhere, 'agent/z']);
  try {
    const out = orphanWorktrees(repo.dir, ['agent/x']);
    assert.deepEqual(out.map((w) => w.path), [y]);
    assert.equal(out[0].branch, 'agent/y');
    assert.equal(out[0].dirty, 0);
    assert.deepEqual(orphanWorktrees(repo.dir, ['agent/x', 'agent/y']), []);
    assert.deepEqual(orphanWorktrees(repo.dir, [], '.worktrees').map((w) => w.path).sort(), [x, y].sort());
    // run from inside a worktree: the container is still the main worktree's
    assert.deepEqual(orphanWorktrees(x, ['agent/x']).map((w) => w.path), [y]);
  } finally {
    repo.git(['worktree', 'remove', '--force', elsewhere]);
  }
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
