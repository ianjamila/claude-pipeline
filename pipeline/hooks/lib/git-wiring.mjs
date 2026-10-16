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

// #58: what the git policy asks before a direct merge (`gh pr merge`, the repo's merge command, auto-merge through the API).
// The repo's owner_approval mode and merge commands come from .claude/pipeline.yml at the REPOSITORY ROOT (a copy in a subfolder
// is never read), in every version at hand: the working tree, HEAD and the remote's default branch. Any one of them saying chat
// makes it a chat repo, so a local edit or an uncommitted file cannot switch the check off (a rewritten local ref still can:
// the documented residual). A pipeline.yml that cannot be parsed throws: the policy then treats the repo as chat (fail closed).
// Whether the owner said "merge" comes from the owner-go records of THIS session, for the exact PR and head (lib/owner-go.mjs).
const COMMITTED_REFS = ['HEAD', 'origin/HEAD', 'origin/main', 'origin/master'];
const defaultGitShow = (root, ref) => {
  const r = run('git', ['-C', root, 'show', `${ref}:.claude/pipeline.yml`], { timeoutMs: LOOKUP_TIMEOUT_MS });
  return r.code === 0 ? r.stdout : null;
};
export function ownerGoWiring(session, { readText = (p) => readFileSync(p, 'utf8'), exists = existsSync, gitShow = defaultGitShow } = {}) {
  const rootOf = (dir) => {
    let d = path.resolve(dir);
    for (;;) {
      if (exists(path.join(d, '.git'))) return d;
      const up = path.dirname(d);
      if (up === d) return null;
      d = up;
    }
  };
  const configsOf = (dir) => {
    const root = rootOf(dir);
    if (root === null) return [];
    const texts = [];
    const yml = path.join(root, '.claude', 'pipeline.yml');
    if (exists(yml)) texts.push(readText(yml));
    for (const ref of COMMITTED_REFS) {
      const t = gitShow(root, ref);
      if (typeof t === 'string') texts.push(t);
    }
    return texts.map((t) => parseYaml(t) ?? {});
  };
  return {
    mode: (dir) => {
      const all = configsOf(dir);
      if (all.length === 0) return 'none';
      return all.some((c) => c.owner_approval === 'chat') ? 'chat' : 'label';
    },
    // each distinct merge command as { prefix: the literal words before {pr}, shaFlag: the word before {sha} (null when it pins no head) }
    mergeTemplates: (dir) => {
      const out = [];
      for (const cmd of new Set(configsOf(dir).map((c) => c?.merge?.command).filter((c) => typeof c === 'string'))) {
        const words = cmd.trim().split(/\s+/);
        const at = words.indexOf('{pr}');
        const prefix = at > 0 ? words.slice(0, at) : [];
        if (!prefix.length || !prefix.every((w) => /^[A-Za-z0-9_@%+=:,./-]+$/.test(w))) continue;
        const sa = words.indexOf('{sha}');
        out.push({ prefix, shaFlag: sa > 0 && /^-{1,2}[A-Za-z][A-Za-z0-9-]*$/.test(words[sa - 1]) ? words[sa - 1] : null });
      }
      return out;
    },
    approvedHead: (pr, head) => approvedPr({ pr, head, session }),
  };
}
