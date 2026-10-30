// The worktrees git lists for a repository (`git worktree list --porcelain`), parsed. Read-only.
import path from 'node:path';
import { git } from './git.mjs';

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
