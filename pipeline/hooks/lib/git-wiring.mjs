// Why: the git policy (git-policy.mjs) is pure and asks its caller for three real-world answers: which branch HEAD is
// on, where a bare `git push` would go, and which labels an issue carries. The guard-git hook and `pipeline job start`
// must ask them the same way, or a command the hook denies could slip through the job runner (or the reverse), so the
// lookups live here once. Every lookup fails toward "unknown" (null / throw), which the policy turns into a denial.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { run, gh } from '../../lib/proc.mjs';
import { parseYaml } from '../../lib/yaml.mjs';
import { approvedPr } from './owner-go.mjs';

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

// #58: what the git policy asks before a direct merge (`gh pr merge`, the repo's merge command, auto-merge through the API):
// the repo's owner_approval mode and merge command (its .claude/pipeline.yml, found from the command's directory up to the
// repository root), and whether the owner said "merge" for that PR in THIS session (lib/owner-go.mjs). A pipeline.yml that
// exists but cannot be read or parsed throws: the policy then treats the repo as owner_approval: chat (fail closed).
export function ownerGoWiring(session, { readText = (p) => readFileSync(p, 'utf8'), exists = existsSync } = {}) {
  const configOf = (dir) => {
    let d = path.resolve(dir);
    for (;;) {
      const yml = path.join(d, '.claude', 'pipeline.yml');
      if (exists(yml)) return parseYaml(readText(yml)) ?? {};
      if (exists(path.join(d, '.git'))) return null;
      const up = path.dirname(d);
      if (up === d) return null;
      d = up;
    }
  };
  return {
    mode: (dir) => {
      const c = configOf(dir);
      if (c === null) return 'none';
      return c.owner_approval === 'chat' ? 'chat' : 'label';
    },
    // the words of the repo's merge command before its {pr} placeholder (null: none, or it does not start with literal words)
    mergePrefix: (dir) => {
      const cmd = configOf(dir)?.merge?.command;
      if (typeof cmd !== 'string') return null;
      const at = cmd.indexOf('{pr}');
      const words = (at < 0 ? '' : cmd.slice(0, at)).trim().split(/\s+/).filter(Boolean);
      return words.length && words.every((w) => /^[A-Za-z0-9_@%+=:,./-]+$/.test(w)) ? words : null;
    },
    approvedPr: (pr) => approvedPr({ pr, session }),
  };
}
