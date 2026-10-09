#!/usr/bin/env node
// Why: global PreToolUse hook (matcher `Bash|PowerShell|Monitor|mcp__.*`, ~/.claude/settings.json) that stops any agent in any repo from
// pushing to main, force-pushing, admin-merging, editing protection, approving its own work with owner-only
// labels, or closing pause/rollback issues. All judgement lives in lib/git-policy.mjs; this file only wires the
// real branch/label lookups (lib/git-wiring.mjs, shared with `pipeline job start`). Every module is imported lazily so a
// load failure lands in a fail-closed path instead of crashing the process (a crash would allow the call): the policy and
// wiring inside the evaluator (runHook denies any internal error, whatever the command), hook-io.mjs itself below.

async function evaluate(input) {
  // Bash, PowerShell and Monitor take the same `tool_input.command` text (the shell parser reads all of them); an MCP
  // tool is judged by its command / cmd / script string fields. Everything else is not ours.
  const { commandTextsOf } = await import('./lib/command-fields.mjs');
  const texts = commandTextsOf(input.tool_name, input.tool_input);
  if (texts.length === 0) return { decision: 'allow', reason: '' };
  const { evaluateGitCommand } = await import('./lib/git-policy.mjs');
  const { realGitWiring } = await import('./lib/git-wiring.mjs');

  const opts = {
    cwd: typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd(),
    ...realGitWiring(),
  };
  for (const text of texts) {
    const verdict = evaluateGitCommand(text, opts);
    if (verdict.decision === 'deny') return verdict;
  }
  return { decision: 'allow', reason: '' };
}

try {
  const { runHook } = await import('./lib/hook-io.mjs');
  await runHook(evaluate);
} catch (err) {
  // hook-io.mjs is missing or broken (runHook itself never rejects): deny with the same JSON, written by hand
  try {
    process.stdout.write(`${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `[claude-pipeline guard-git] internal error while checking this command (${String(err?.message ?? err).slice(0, 200)}); denied because the guard cannot verify it. Reinstall the pipeline or ask the repository owner.`,
      },
    })}\n`);
  } catch { /* stdout is gone; nothing more can be done */ }
}
process.exitCode = 0;
