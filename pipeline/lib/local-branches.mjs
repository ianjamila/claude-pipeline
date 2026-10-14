// What this machine holds for a PR branch: the local ref and every worktree that has it checked out, compared with the
// PR's live head on GitHub. Read-only (list / rev-parse / status / merge-base); shared by `P inbox` and `P resume plan`.
// Plan: docs/plans/2026-10-12-ship-inbox-resume-plan.md, sections E and F.
import path from 'node:path';
import { GitError, git, isAncestor } from './git.mjs';
import { isInside, samePath } from './paths.mjs';

// Git prints worktree paths with forward slashes on Windows (`C:/Users/me/repo`) while everything else here (path.join,
// path.resolve, the paths a test or a caller builds) is native (`C:\\Users\\me\\repo`). This is the one place a path
// read from git becomes native; POSIX paths pass through unchanged.
const nativePath = (p, platform) => (platform === 'win32' ? path.win32.resolve(p) : p);

// -> [{ path, head, branch|null (detached or bare), bare, locked (reason; '' = no reason; null = unlocked), prunable, detached }],
// main worktree first. `platform` is for tests.
export function parseWorktreePorcelain(out, platform = process.platform) {
  const list = [];
  for (const block of out.split(/\r?\n\r?\n+/)) {
    if (!block.trim()) continue;
    const entry = { path: null, head: null, branch: null, bare: false, locked: null, prunable: false, detached: false };
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('worktree ')) entry.path = nativePath(line.slice('worktree '.length), platform);
      else if (line.startsWith('HEAD ')) entry.head = line.slice('HEAD '.length);
      else if (line.startsWith('branch ')) entry.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
      else if (line === 'bare') entry.bare = true;
      else if (line === 'locked' || line.startsWith('locked ')) entry.locked = line === 'locked' ? '' : line.slice(7);
      else if (line === 'prunable' || line.startsWith('prunable ')) entry.prunable = true;
      else if (line === 'detached') entry.detached = true;
    }
    if (entry.path) list.push(entry);
  }
  return list;
}

export function listWorktrees(root) {
  return parseWorktreePorcelain(git(['worktree', 'list', '--porcelain'], { cwd: root }));
}

// Changed or untracked entries in one worktree (every `git status --porcelain` line is one).
function dirtyCount(dir) {
  try {
    return git(['status', '--porcelain=v1', '-uall'], { cwd: dir }).split('\n').filter(Boolean).length;
  } catch (err) {
    if (err instanceof GitError) return 0; // a worktree directory that was deleted by hand: prunable, nothing to lose there
    throw err;
  }
}

function refSha(root, ref) {
  try {
    return git(['rev-parse', '--verify', '-q', ref], { cwd: root }).trim();
  } catch (err) {
    if (err instanceof GitError) return null;
    throw err;
  }
}

function hasCommit(root, sha) {
  try {
    git(['cat-file', '-e', `${sha}^{commit}`], { cwd: root });
    return true;
  } catch (err) {
    if (err instanceof GitError) return false;
    throw err;
  }
}

// state: none (no local ref) | equal | ahead (local has commits the PR head lacks) | behind (the PR head has commits
// local lacks) | diverged | unknown (the live head object is not in this clone: fetch first).
// unpushed = commits on the local ref that the live head does not have; dirty = changed entries over every worktree
// holding the branch.
export function localBranchState(root, branch, liveHeadSha, { worktrees } = {}) {
  const all = worktrees ?? listWorktrees(root);
  const holding = all.filter((w) => w.branch === branch).map((w) => ({ path: w.path, dirty: dirtyCount(w.path) }));
  const dirty = holding.reduce((n, w) => n + w.dirty, 0);
  const localRef = refSha(root, `refs/heads/${branch}`);
  const base = { worktrees: holding, localRef, unpushed: 0, dirty };
  if (localRef === null) return { ...base, state: 'none' };
  if (localRef === liveHeadSha) return { ...base, state: 'equal' };
  if (!hasCommit(root, liveHeadSha)) return { ...base, state: 'unknown' };
  const o = { cwd: root };
  if (isAncestor(liveHeadSha, localRef, o)) {
    const unpushed = Number(git(['rev-list', '--count', `${liveHeadSha}..${localRef}`], o).trim());
    return { ...base, state: 'ahead', unpushed };
  }
  if (isAncestor(localRef, liveHeadSha, o)) return { ...base, state: 'behind' };
  const unpushed = Number(git(['rev-list', '--count', `${liveHeadSha}..${localRef}`], o).trim());
  return { ...base, state: 'diverged', unpushed };
}

// Worktrees living under `worktreeDir` (relative to the MAIN worktree) whose branch has no open PR. Listed, never touched.
export function orphanWorktrees(root, openBranches, worktreeDir = '.worktrees', { worktrees } = {}) {
  const all = worktrees ?? listWorktrees(root);
  const container = path.resolve(all[0]?.path ?? root, worktreeDir);
  const open = new Set(openBranches);
  return all
    .filter((w) => !w.bare && !samePath(w.path, all[0]?.path ?? root))
    .filter((w) => {
      return isInside(w.path, container) && !samePath(w.path, container);
    })
    .filter((w) => w.branch === null || !open.has(w.branch))
    .map((w) => ({ path: w.path, branch: w.branch, head: w.head, dirty: dirtyCount(w.path) }));
}
