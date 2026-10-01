// Where am I? One place that answers "which repo, which root, which GitHub slug" so every
// command resolves them the same way (worktrees included) and tests can inject answers.
import { join, resolve } from 'node:path';
import { git } from './git.mjs';
import { ghJson } from './proc.mjs';

export function repoRoot(cwd = process.cwd()) {
  return git(['rev-parse', '--show-toplevel'], { cwd }).trim();
}

// The common git dir is shared by all worktrees of a repo: right place for per-repo,
// cross-worktree state such as the agent-log queue.
export function gitCommonDir(cwd = process.cwd()) {
  const out = git(['rev-parse', '--git-common-dir'], { cwd }).trim();
  return resolve(cwd, out);
}

export function pipelineStateDir(cwd = process.cwd()) {
  return join(gitCommonDir(cwd), 'claude-pipeline');
}

// owner/name from GitHub (gh resolves the right remote, including forks and SSH remotes).
export function repoSlug(cwd = process.cwd(), { ghJsonFn = ghJson } = {}) {
  const r = ghJsonFn(['repo', 'view', '--json', 'nameWithOwner,defaultBranchRef'], { cwd });
  const [owner, name] = String(r.nameWithOwner || '').split('/');
  if (!owner || !name) throw new Error(`could not resolve GitHub repo for ${cwd}`);
  return { owner, name, slug: `${owner}/${name}`, defaultBranch: r.defaultBranchRef?.name || 'main' };
}
