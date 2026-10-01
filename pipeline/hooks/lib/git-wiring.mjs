// Why: the git policy (git-policy.mjs) is pure and asks its caller for three real-world answers: which branch HEAD is
// on, where a bare `git push` would go, and which labels an issue carries. The guard-git hook and `pipeline job start`
// must ask them the same way, or a command the hook denies could slip through the job runner (or the reverse), so the
// lookups live here once. Every lookup fails toward "unknown" (null / throw), which the policy turns into a denial.
import { run, gh } from '../../lib/proc.mjs';

const LOOKUP_TIMEOUT_MS = 5000;
const PUSH_LOOKUP_TIMEOUT_MS = 3000;

export function realGitWiring() {
  // null (unknown) when HEAD is detached, the directory is not a repository, or git is unavailable
  const currentBranch = (dir, { gitDir } = {}) => {
    const args = ['-C', dir, ...(gitDir ? ['--git-dir', gitDir] : []), 'symbolic-ref', '--short', '-q', 'HEAD'];
    const r = run('git', args, { timeoutMs: LOOKUP_TIMEOUT_MS });
    const branch = r.stdout.trim();
    return r.code === 0 && branch ? branch : null;
  };

  // Where git would send a bare `git push` (e.g. "origin/main"); null when it cannot say (no upstream, detached, error).
  // With `branch` it answers for that branch instead of HEAD (a branch the command line switches to first).
  const pushDestination = (dir, { gitDir, branch } = {}) => {
    if (branch !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch)) return null; // never feed odd text to rev-parse
    const rev = branch === undefined ? '@{push}' : `${branch}@{push}`;
    const args = ['-C', dir, ...(gitDir ? ['--git-dir', gitDir] : []), 'rev-parse', '--abbrev-ref', '--symbolic-full-name', rev];
    const r = run('git', args, { timeoutMs: PUSH_LOOKUP_TIMEOUT_MS });
    const dest = r.stdout.trim();
    return r.code === 0 && dest ? dest : null;
  };

  // throws when the lookup fails, so the policy denies instead of guessing
  const issueLabels = (n, repoArgs = [], cwd) => {
    const r = gh(['issue', 'view', String(n), ...repoArgs, '--json', 'labels', '-q', '.labels[].name'], { cwd, timeoutMs: LOOKUP_TIMEOUT_MS });
    if (r.timedOut) throw new Error(`gh issue view ${n} timed out`);
    if (r.code !== 0) throw new Error(`gh issue view ${n} failed (exit ${r.code})${r.stderr ? `: ${r.stderr.trim().slice(0, 200)}` : ''}`);
    return r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  };

  return { currentBranch, pushDestination, issueLabels };
}
