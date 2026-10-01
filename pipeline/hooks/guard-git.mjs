#!/usr/bin/env node
// Why: global PreToolUse hook (matcher `Bash`, ~/.claude/settings.json) that stops any agent in any repo from
// pushing to main, force-pushing, admin-merging, editing protection, approving its own work with owner-only
// labels, or closing pause/rollback issues. All judgement lives in lib/git-policy.mjs; this file only wires the
// real branch/label lookups (lib/git-wiring.mjs, shared with `pipeline job start`). The policy and wiring modules
// are imported lazily INSIDE the evaluator so a load failure lands in runHook's fail-closed path instead of
// crashing the process (a crash would allow the call).
import { runHook } from './lib/hook-io.mjs';

async function evaluate(input) {
  if (input.tool_name !== 'Bash') return { decision: 'allow', reason: '' };
  const { evaluateGitCommand } = await import('./lib/git-policy.mjs');
  const { realGitWiring } = await import('./lib/git-wiring.mjs');

  const command = input.tool_input?.command;
  return evaluateGitCommand(typeof command === 'string' ? command : '', {
    cwd: typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd(),
    ...realGitWiring(),
  });
}

try {
  await runHook(evaluate);
} catch {
  // runHook never rejects; this is the last line of defence against a non-zero exit
}
process.exitCode = 0;
