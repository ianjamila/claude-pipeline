#!/usr/bin/env node
// Why: Claude Code PreToolUse hook (matcher Edit|Write|MultiEdit|NotebookEdit|Bash|PowerShell|Monitor|mcp__.*) that keeps agents from
// editing their own rules: the globally installed pipeline files, the global settings that load the hooks, and
// the hook off-switches. Only a Claude Code process launched with PIPELINE_ADMIN=1 bypasses it. The decision
// logic is in lib/files-policy.mjs; this file only does stdin/stdout and must never crash, because a crashing
// hook counts as "allowed" to Claude Code. It carries its own tiny IO (no hook-io.mjs) so it still runs if
// that helper is missing. Fail closed: once the tool is known to be one of ours, ANY internal error (policy module
// missing, evaluator throws, no verdict) or unreadable input denies with the error in the reason; a tool that is not ours
// returns silently before anything can throw.
import os from 'node:os';

const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell', 'Monitor']);

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function deny(reason) {
  process.stdout.write(`${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `[claude-pipeline guard-files] ${reason}`,
    },
  })}\n`);
}

// resolves once everything written to stdout so far has been handed to the OS (a pipe is asynchronous on macOS: without
// this, a log call that blocked the thread would also hold back the deny already queued)
const stdoutFlushed = () => new Promise((resolve) => { try { process.stdout.write('', () => resolve()); } catch { resolve(); } });

// Why: only shell denies are logged (not Edit/Write). Imported dynamically inside try/catch like the policy, so a missing or
// broken lib/deny-log.mjs can never change the verdict or crash the hook. Called only after the deny is written.
async function recordDeny(input, reason) {
  try {
    await stdoutFlushed();
    const { logDeny } = await import('./lib/deny-log.mjs');
    logDeny({ hook: 'files', reason, command: input.tool_input?.command, session: input.session_id });
  } catch { /* logging only */ }
}

async function main() {
  let raw = '';
  let input;
  try {
    raw = await readStdin();
    input = JSON.parse(raw);
    if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('the input is not a JSON object');
  } catch (err) {
    // no tool name to judge by: unreadable or malformed input is refused (the admin launch still bypasses)
    if (process.env.PIPELINE_ADMIN !== '1') deny(`internal error (${String(err?.message ?? err).slice(0, 120)}); denied because the input could not be read`);
    return;
  }
  const tool = input.tool_name;
  const isShell = SHELL_TOOLS.has(tool);
  const isMcp = typeof tool === 'string' && tool.startsWith('mcp__');
  if (!isShell && !FILE_TOOLS.has(tool) && !isMcp) return; // not ours (MCP write tools are judged by evaluateFileTool)
  try {
    const { evaluateFileTool, evaluateBashForFiles } = await import('./lib/files-policy.mjs');
    const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
    const opts = { home: os.homedir(), env: process.env, platform: process.platform };
    const verdict = isShell
      ? evaluateBashForFiles(input.tool_input?.command, { ...opts, cwd })
      : evaluateFileTool({ ...input, cwd }, opts);
    if (verdict?.decision === 'deny') {
      deny(verdict.reason);
      if (isShell) await recordDeny(input, verdict.reason);
    }
    else if (verdict?.decision !== 'allow') throw new TypeError('the policy returned no decision');
  } catch (err) {
    if (process.env.PIPELINE_ADMIN === '1') return;
    deny(`internal error (${String(err?.message ?? err).slice(0, 120)}); denied because the guard cannot verify this call`);
  }
}

try {
  await main();
} catch { /* never crash */ }
