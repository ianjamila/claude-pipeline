// Why: the installer refuses to run inside a Claude Code session so an agent cannot reinstall or remove its own
// guards. CLAUDECODE=1 in the environment is the first signal, but an agent can launch the installer with that
// variable removed (`env -u CLAUDECODE node install.mjs`), so the installer also looks at the process tree: if any
// ancestor process is Claude Code, it refuses. The lookup is injected (tests); when it cannot answer (no `ps`, no
// PowerShell, a process already gone) the walk stops and reports "not found", i.e. the environment check alone decides.
import { spawnSync } from 'node:child_process';

const MAX_HOPS = 32;
const LOOKUP_TIMEOUT_MS = 3000;
const CLAUDE_COMM = /^claude(?:\.exe)?$/; // the Claude Code binary; the desktop app is `Claude` and is not matched
const RUNTIME = /^(?:node|nodejs|bun|deno)(?:\.exe)?$/i;
// `node …/@anthropic-ai/claude-code/cli.js`, `bun …/claude-code/cli.js`
const CLAUDE_ARGS = /@anthropic-ai[\\/]claude-code|[\\/]claude-code[\\/](?:cli|bin)[\w.-]*|[\\/]claude(?:\.exe)?(?=\s|$)/;

const basename = (p) => String(p).trim().split(/[\\/]/).pop();

// info = { comm, args? }: is this process Claude Code?
export function isClaudeCodeProcess(info) {
  if (!info) return false;
  if (CLAUDE_COMM.test(basename(info.comm ?? ''))) return true;
  return RUNTIME.test(basename(info.comm ?? '')) && typeof info.args === 'string' && CLAUDE_ARGS.test(info.args);
}

const psOut = (args) => {
  const r = spawnSync('ps', args, { encoding: 'utf8', timeout: LOOKUP_TIMEOUT_MS, windowsHide: true });
  return r.status === 0 && typeof r.stdout === 'string' ? r.stdout.trim() : null;
};

// { ppid, comm, args } for `pid`, or null when it cannot be looked up.
export function realLookup(pid, platform = process.platform) {
  if (platform === 'win32') {
    const script = `Get-CimInstance Win32_Process -Filter 'ProcessId=${Number(pid)}' | Select-Object ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress`;
    const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: LOOKUP_TIMEOUT_MS * 2, windowsHide: true });
    if (r.status !== 0 || !r.stdout) return null;
    try {
      const j = JSON.parse(r.stdout);
      return { ppid: Number(j.ParentProcessId), comm: String(j.Name ?? ''), args: String(j.CommandLine ?? '') };
    } catch {
      return null;
    }
  }
  const line = psOut(['-o', 'ppid=,comm=', '-p', String(pid)]);
  const m = line === null ? null : /^(\d+)\s+(.+)$/.exec(line);
  if (!m) return null;
  const info = { ppid: Number(m[1]), comm: m[2].trim() };
  if (RUNTIME.test(basename(info.comm))) info.args = psOut(['-o', 'args=', '-p', String(pid)]) ?? '';
  return info;
}

// True when a process above `startPid` is Claude Code. Cycle- and depth-safe; a failed lookup ends the walk with false.
export function hasClaudeCodeAncestor({ startPid = process.ppid, lookup = realLookup, platform = process.platform, maxHops = MAX_HOPS } = {}) {
  const seen = new Set();
  let pid = startPid;
  for (let hop = 0; hop < maxHops && Number.isInteger(pid) && pid > 1 && !seen.has(pid); hop++) {
    seen.add(pid);
    let info = null;
    try { info = lookup(pid, platform); } catch { info = null; }
    if (!info) return false;
    if (isClaudeCodeProcess(info)) return true;
    pid = info.ppid;
  }
  return false;
}
