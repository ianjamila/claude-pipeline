#!/usr/bin/env node
// Why: global PreToolUse hook (matcher `Bash`, ~/.claude/settings.json) that stops any agent in any repo from
// pushing to main, force-pushing, admin-merging, editing protection, approving its own work with owner-only
// labels, or closing pause/rollback issues. All judgement lives in lib/git-policy.mjs; this file only wires the
// real branch/label lookups. The policy and proc modules are imported lazily INSIDE the evaluator so a load
// failure lands in runHook's fail-closed path instead of crashing the process (a crash would allow the call).
import { runHook } from './lib/hook-io.mjs';

const LOOKUP_TIMEOUT_MS = 5000;

async function evaluate(input) {
  if (input.tool_name !== 'Bash') return { decision: 'allow', reason: '' };
  const { evaluateGitCommand } = await import('./lib/git-policy.mjs');
  const { run, gh } = await import('../lib/proc.mjs');

  // null (unknown) when HEAD is detached, the directory is not a repository, or git is unavailable
  const currentBranch = (dir, { gitDir } = {}) => {
    const args = ['-C', dir, ...(gitDir ? ['--git-dir', gitDir] : []), 'symbolic-ref', '--short', '-q', 'HEAD'];
    const r = run('git', args, { timeoutMs: LOOKUP_TIMEOUT_MS });
    const branch = r.stdout.trim();
    return r.code === 0 && branch ? branch : null;
  };

  // throws when the lookup fails, so the policy denies instead of guessing
  const issueLabels = (n, repoArgs = [], cwd) => {
    const r = gh(['issue', 'view', String(n), ...repoArgs, '--json', 'labels', '-q', '.labels[].name'], { cwd, timeoutMs: LOOKUP_TIMEOUT_MS });
    if (r.timedOut) throw new Error(`gh issue view ${n} timed out`);
    if (r.code !== 0) throw new Error(`gh issue view ${n} failed (exit ${r.code})${r.stderr ? `: ${r.stderr.trim().slice(0, 200)}` : ''}`);
    return r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  };

  const command = input.tool_input?.command;
  return evaluateGitCommand(typeof command === 'string' ? command : '', {
    cwd: typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd(),
    currentBranch,
    issueLabels,
  });
}

try {
  await runHook(evaluate);
} catch {
  // runHook never rejects; this is the last line of defence against a non-zero exit
}
process.exitCode = 0;
