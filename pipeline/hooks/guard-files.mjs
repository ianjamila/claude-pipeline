#!/usr/bin/env node
// Why: Claude Code PreToolUse hook (matcher Edit|Write|MultiEdit|NotebookEdit|Bash|PowerShell|Monitor|mcp__.*) that keeps agents from
// editing their own rules: the globally installed pipeline files, the global settings that load the hooks, and
// the hook off-switches. Only a Claude Code process launched with PIPELINE_ADMIN=1 bypasses it. The decision
// logic is in lib/files-policy.mjs; this file only does stdin/stdout and must never crash, because a crashing
// hook counts as "allowed" to Claude Code. It carries its own tiny IO (no hook-io.mjs) so it still runs if
// that helper is missing.
import os from 'node:os';

const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell', 'Monitor']);
// An internal error denies only when the raw input could be about the pipeline's own switches.
const SENSITIVE = /\.claude|PIPELINE_ADMIN|disableAllHooks|install\.|CLAUDECODE|PIPELINE_(?:GH|CODEX|VERCEL|TEST_MODE)/;

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

async function main() {
  let raw = '';
  try {
    raw = await readStdin();
  } catch { /* an unreadable stdin is handled like malformed input below */ }

  try {
    const input = JSON.parse(raw);
    const tool = input && typeof input === 'object' ? input.tool_name : undefined;
    const isShell = SHELL_TOOLS.has(tool);
    if (!isShell && !FILE_TOOLS.has(tool) && !(typeof tool === 'string' && tool.startsWith('mcp__'))) return; // not ours (MCP write tools are judged by evaluateFileTool)
    const { evaluateFileTool, evaluateBashForFiles } = await import('./lib/files-policy.mjs');
    const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
    const opts = { home: os.homedir(), env: process.env, platform: process.platform };
    const verdict = isShell
      ? evaluateBashForFiles(input.tool_input?.command, { ...opts, cwd })
      : evaluateFileTool({ ...input, cwd }, opts);
    if (verdict.decision === 'deny') deny(verdict.reason);
  } catch (err) {
    if (process.env.PIPELINE_ADMIN === '1') return;
    if (SENSITIVE.test(raw)) deny(`internal error (${String(err?.message ?? err).slice(0, 120)}); denied because the request mentions pipeline files or switches`);
  }
}

try {
  await main();
} catch { /* never crash */ }
