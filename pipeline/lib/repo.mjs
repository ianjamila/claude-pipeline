// Where am I? One place that answers "which repo, which root, which GitHub slug" so every
// command resolves them the same way (worktrees included) and tests can inject answers.
import { join, resolve } from 'node:path';
import { git } from './git.mjs';
import { ghJson } from './proc.mjs';

// resolve(): git prints C:/forward/slashes on Windows; callers join() and compare native paths.
export function repoRoot(cwd = process.cwd()) {
  return resolve(git(['rev-parse', '--show-toplevel'], { cwd }).trim());
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
// host (Phase 3b): the server gh resolved it on, from the repo's url (lower-case; null when gh gives none): GH_HOST, an ssh host
// alias or a sole logged-in enterprise host can point gh at a server other than github.com, where owner/name is another repository.
export function repoSlug(cwd = process.cwd(), { ghJsonFn = ghJson } = {}) {
  const r = ghJsonFn(['repo', 'view', '--json', 'nameWithOwner,defaultBranchRef,url'], { cwd });
  const [owner, name] = String(r.nameWithOwner || '').split('/');
  if (!owner || !name) throw new Error(`could not resolve GitHub repo for ${cwd}`);
  const host = /^https?:\/\/([^/]+)\//i.exec(String(r.url ?? ''))?.[1]?.toLowerCase() ?? null;
  return { owner, name, slug: `${owner}/${name}`, host, defaultBranch: r.defaultBranchRef?.name || 'main' };
}
