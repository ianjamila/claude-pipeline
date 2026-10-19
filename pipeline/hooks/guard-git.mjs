#!/usr/bin/env node
// Why: global PreToolUse hook (matcher `Bash|PowerShell|Monitor|mcp__.*`, ~/.claude/settings.json) that stops any agent in any repo from
// pushing to main, force-pushing, admin-merging, editing protection, approving its own work with owner-only
// labels, or closing pause/rollback issues. All judgement lives in lib/git-policy.mjs; this file only wires the
// real branch/label lookups (lib/git-wiring.mjs, shared with `pipeline job start`). Every module is imported lazily so a
// load failure lands in a fail-closed path instead of crashing the process (a crash would allow the call): the policy and
// wiring inside the evaluator (runHook denies any internal error, whatever the command), hook-io.mjs itself below.

// Why: the deny log (lib/deny-log.mjs) is a measurement aid. It is imported lazily inside try/catch so a missing or broken
// file, or a failed write, can never change the verdict or crash the hook. It runs only AFTER runHook has written the deny
// (evaluate parks the deny in pendingDeny), so a slow or hanging log cannot hold the verdict back.
let pendingDeny = null;
// resolves once everything written to stdout so far has been handed to the OS (a pipe is asynchronous on macOS: without
// this, a log call that blocked the thread would also hold back the deny already queued)
const stdoutFlushed = () => new Promise((resolve) => { try { process.stdout.write('', () => resolve()); } catch { resolve(); } });
async function recordDeny(input, command, verdict) {
  try {
    const { logDeny } = await import('./lib/deny-log.mjs');
    logDeny({ hook: 'git', reason: verdict.reason, command, session: input.session_id });
  } catch { /* logging only */ }
}

async function evaluate(input) {
  // Bash, PowerShell and Monitor take the same `tool_input.command` text (the shell parser reads all of them); an MCP
  // tool is judged by its command / cmd / script string fields. Everything else is not ours.
  const { commandTextsOf } = await import('./lib/command-fields.mjs');
  const texts = commandTextsOf(input.tool_name, input.tool_input);
  if (texts.length === 0) return { decision: 'allow', reason: '' };
  const { evaluateGitCommand } = await import('./lib/git-policy.mjs');
  const { realGitWiring, ownerGoWiring } = await import('./lib/git-wiring.mjs');

  const opts = {
    cwd: typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd(),
    env: process.env,
    ...realGitWiring(),
    // #58: a direct merge in an owner_approval: chat repo needs the owner's "merge" recorded in THIS session (the hook input names it)
    ownerGo: ownerGoWiring(typeof input.session_id === 'string' ? input.session_id : null),
  };
  for (const text of texts) {
    const verdict = evaluateGitCommand(text, opts);
    if (verdict.decision === 'deny') {
      pendingDeny = { input, text, verdict };
      return verdict;
    }
  }
  return { decision: 'allow', reason: '' };
}

try {
  const { runHook } = await import('./lib/hook-io.mjs');
  const outcome = await runHook(evaluate);
  if (outcome === 'deny' && pendingDeny) {
    // own try: the deny is already out, so nothing here may reach the catch below (it would print a second deny)
    try {
      await stdoutFlushed();
      await recordDeny(pendingDeny.input, pendingDeny.text, pendingDeny.verdict);
    } catch { /* logging only */ }
  }
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
