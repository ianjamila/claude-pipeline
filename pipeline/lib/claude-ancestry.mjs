// Why: the installer refuses to run inside a Claude Code session so an agent cannot reinstall or remove its own
// guards. CLAUDECODE=1 in the environment is the first signal, but an agent can launch the installer with that
// variable removed (`env -u CLAUDECODE node install.mjs`), so the installer also looks at the process tree: if any
// ancestor process is Claude Code, it refuses. The lookup is injected (tests); when it cannot answer (no `ps`, no
// PowerShell, a process already gone) the walk stops and reports "not found", i.e. the environment check alone decides.
//
// Windows PID reuse (#25): a Windows parent PID is only a number, and it can be recycled by an unrelated process once the real
// parent has exited (POSIX re-parents orphans, so this is Windows only). The win32 lookup therefore also returns `created`
// (CreationDate as epoch ms), and the walk starts from the installer's OWN process. A parent that is NOT Claude Code and was
// created more than REUSE_SKEW_MS after its child cannot be that child's parent: its PID was recycled, the chain above it is
// unrelated, so the walk stops (false). A parent that IS Claude Code always refuses, whatever the times (a recycled PID that
// lands on Claude Code itself refuses too: fail closed, rare; the message tells the user to close Claude Code or retry).
// Missing or non-finite times on either side, equal times and a gap up to the skew continue the walk as before.
//
// Accepted residuals (Fable ruling 11-04: the time rule must not fail closed, that would bring #25 back with no security gain):
//  - Clock rollback: Win32 CreationDate is wall-clock based, so setting the system time back by more than 2 s between a real
//    non-Claude parent's start and its child's start makes that parent look recycled and the walk stops early, missing a Claude
//    Code further up. Windows grants that only to administrators (SeSystemtimePrivilege); NTP steps are far below 2 s.
//  - Detaching: a POSIX double-fork/setsid re-parents to launchd/init, and on Windows a same-user process can set
//    PROC_THREAD_ATTRIBUTE_PARENT_PROCESS, so a process can start the installer with a parent of its choosing.
//  - An unquoted `--claude-home` path with spaces (only a quote-less `ps` line on POSIX shows one) blanks its first word only.
// These need a deliberate act by the agent. The primary control is the PreToolUse guard that blocks command lines naming the
// installer script; this walk is the backstop, and the installer's refusal message points at the same escape hatches.
import { spawnSync } from 'node:child_process';

const MAX_HOPS = 32;
const LOOKUP_TIMEOUT_MS = 3000;
const REUSE_SKEW_MS = 2000;
const CLAUDE_COMM = /^claude(?:\.exe)?$/; // the Claude Code binary; the desktop app is `Claude` and is not matched
const RUNTIME = /^(?:node|nodejs|bun|deno)(?:\.exe)?$/i;
// `node …/@anthropic-ai/claude-code/cli.js`, `bun …/claude-code/cli.js`, `bun run /x/claude`, `node "C:\Program Files\x\claude"`
// (the closing quote after the name is allowed).
const CLAUDE_ARGS = /@anthropic-ai[\\/]claude-code|[\\/]claude-code[\\/](?:cli|bin)[\w.-]*|[\\/]claude(?:\.exe)?(?=["']?(?:\s|$))/;
const INSTALLER_WORD = /(?:^|[\\/])install\.mjs$/;
const HOME_FLAG = '--claude-home';

const basename = (p) => String(p).trim().split(/[\\/]/).pop();

// Quote-aware split of a command line into tokens { text (quotes removed), start, end (span in `s`) }. A double quote opens a
// quoted run anywhere; a single quote only at the start of a token or right after `=` and only when it closes (an apostrophe
// inside a Windows path is just a character). Backslashes are never escapes (Windows paths).
function tokenize(s) {
  const tokens = [];
  let i = 0;
  while (i < s.length) {
    if (/\s/.test(s[i])) { i++; continue; }
    const start = i;
    let text = '';
    let quote = null;
    for (; i < s.length; i++) {
      const c = s[i];
      if (quote) {
        if (c === quote) quote = null; else text += c;
      } else if (c === '"' || (c === "'" && (i === start || s[i - 1] === '=') && s.indexOf("'", i + 1) > 0)) {
        quote = c;
      } else if (/\s/.test(c)) {
        break;
      } else {
        text += c;
      }
    }
    tokens.push({ text, start, end: i });
  }
  return tokens;
}

// The installer takes `--claude-home <dir>` (or `=<dir>`), and a test home is often named `…/claude`. When the command line
// names the installer script as a token, blank ONLY that flag's operand so the path is not mistaken for the Claude binary.
// Judged on tokens: a flag word or script name inside a quoted prompt (`-p "… --claude-home x"`) is part of one longer token,
// so it neither counts nor blanks the token after it. A Claude Code process never carries this flag.
function withoutClaudeHomeOperand(args) {
  const tokens = tokenize(args);
  if (!tokens.some((t) => INSTALLER_WORD.test(t.text))) return args;
  const spans = [];
  tokens.forEach((t, k) => {
    const raw = args.slice(t.start, t.end);
    if (raw === HOME_FLAG) {
      if (tokens[k + 1]) spans.push([tokens[k + 1].start, tokens[k + 1].end]);
    } else if (raw.startsWith(`${HOME_FLAG}=`)) {
      spans.push([t.start + HOME_FLAG.length + 1, t.end]);
    }
  });
  let out = args;
  for (const [from, to] of spans.sort((a, b) => b[0] - a[0])) out = `${out.slice(0, from)}${out.slice(to)}`;
  return out;
}

// info = { comm, args? }: is this process Claude Code?
export function isClaudeCodeProcess(info) {
  if (!info) return false;
  if (CLAUDE_COMM.test(basename(info.comm ?? ''))) return true;
  return RUNTIME.test(basename(info.comm ?? '')) && typeof info.args === 'string' && CLAUDE_ARGS.test(withoutClaudeHomeOperand(info.args));
}

const psOut = (args) => {
  const r = spawnSync('ps', args, { encoding: 'utf8', timeout: LOOKUP_TIMEOUT_MS, windowsHide: true });
  return r.status === 0 && typeof r.stdout === 'string' ? r.stdout.trim() : null;
};

// { ppid, comm, args, created? } for `pid`, or null when it cannot be looked up. `created` (win32 only) is the process start as
// integer epoch ms: DateTimeOffset converts the CIM date inside PowerShell, so no locale or timezone string is parsed here.
export function realLookup(pid, platform = process.platform, spawn = spawnSync) {
  if (platform === 'win32') {
    const script = `Get-CimInstance Win32_Process -Filter 'ProcessId=${Number(pid)}' | Select-Object ParentProcessId,Name,CommandLine,@{n='Created';e={([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds()}} | ConvertTo-Json -Compress`;
    const r = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: LOOKUP_TIMEOUT_MS * 2, windowsHide: true });
    if (r.status !== 0 || !r.stdout) return null;
    try {
      const j = JSON.parse(r.stdout);
      const info = { ppid: Number(j.ParentProcessId), comm: String(j.Name ?? ''), args: String(j.CommandLine ?? '') };
      if (typeof j.Created === 'number' && Number.isFinite(j.Created)) info.created = j.Created;
      return info;
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

const finiteTime = (t) => (typeof t === 'number' && Number.isFinite(t) ? t : undefined);

// True when a process above `startPid` is Claude Code. Cycle- and depth-safe; a failed lookup ends the walk with false. On
// win32 the walk also stops (false) at a non-Claude parent created more than REUSE_SKEW_MS after its child (a recycled PID).
export function hasClaudeCodeAncestor({ startPid = process.ppid, lookup = realLookup, platform = process.platform, maxHops = MAX_HOPS, ownPid = process.pid } = {}) {
  let childCreated;
  if (platform === 'win32') {
    try { childCreated = finiteTime(lookup(ownPid, platform)?.created); } catch { childCreated = undefined; }
  }
  const seen = new Set();
  let pid = startPid;
  for (let hop = 0; hop < maxHops && Number.isInteger(pid) && pid > 1 && !seen.has(pid); hop++) {
    seen.add(pid);
    let info = null;
    try { info = lookup(pid, platform); } catch { info = null; }
    if (!info) return false;
    if (isClaudeCodeProcess(info)) return true;
    const created = finiteTime(info.created);
    if (created !== undefined && childCreated !== undefined && created - childCreated > REUSE_SKEW_MS) return false;
    childCreated = created;
    pid = info.ppid;
  }
  return false;
}
