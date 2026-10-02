// Why: guard-git and guard-files must judge the same command text for every tool that can run one. Bash, PowerShell
// and Monitor (the background-command tool) carry it in `tool_input.command`; an MCP tool (a shell/IDE/browser
// server) has no fixed shape, so string values under the keys `command`, `cmd` and `script` are taken, at any depth.
// Pure and tiny on purpose: guard-git.mjs imports it lazily so a load failure lands in the fail-closed path.

export const SHELL_TOOLS = new Set(['Bash', 'PowerShell', 'Monitor']);
const COMMAND_KEYS = new Set(['command', 'cmd', 'script']);
const MAX_DEPTH = 12;
const MAX_VALUES = 2000;

// The command lines `tool` would run, as strings (empty when it runs none).
export function commandTextsOf(tool, input) {
  if (SHELL_TOOLS.has(tool)) return [typeof input?.command === 'string' ? input.command : ''];
  if (typeof tool !== 'string' || !tool.startsWith('mcp__')) return [];
  const out = [];
  let seen = 0;
  const walk = (v, key, depth) => {
    if (seen++ > MAX_VALUES || depth > MAX_DEPTH) return;
    if (typeof v === 'string') { if (COMMAND_KEYS.has(key) && v) out.push(v); return; }
    if (v === null || typeof v !== 'object') return;
    // an array of strings under a command key (`command: ['git','push']`) is one argv: judge it joined
    if (Array.isArray(v) && COMMAND_KEYS.has(key) && v.length && v.every((x) => typeof x === 'string')) { out.push(v.join(' ')); return; }
    for (const [k, x] of Object.entries(v)) walk(x, Array.isArray(v) ? key : k, depth + 1);
  };
  walk(input, '', 0);
  return out;
}
