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
// Cost (Windows): a PowerShell start is 1-3 s, so one lookup per hop made a 4-hop walk ~10 s. On win32 the walk therefore reads the
// WHOLE process table once (processTable: one Get-CimInstance over every process) and answers the own-process lookup and every hop
// from that Map. A pid absent from the snapshot means "cannot be looked up" and ends the walk (null), exactly as a process that is
// already gone does today. The reuse rule above applies unchanged; the snapshot is one point-in-time view, which is if anything
// stricter than lookups made seconds apart. If the snapshot itself fails (or lacks the running process, so it cannot be a correct table) the walk falls back to the per-hop
// realLookup, so it never gives a different answer; the fallback runs AFTER the failed table query, so the worst case is the old
// per-hop cost plus that one query (at most 12 s). A caller-injected `lookup` always wins (tests, the seam): it is used as is and no
// snapshot is taken. POSIX keeps the per-hop `ps`, which costs milliseconds, so there is nothing to batch.
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
// The Claude Code binary; the desktop app is `Claude` and is not matched. A background job's processes rename themselves
// `claude bg-spare` (the job's own session, parent of its shell) and `claude bg-pty-host` (above it): without them a
// background job had no Claude ancestor, so the stack hooks refused its private stacks ("no Claude Code process above
// the hook"). The nearest match wins, so a job is owned by its bg-spare process.
const CLAUDE_COMM = /^claude(?:\.exe)?(?: bg-[a-z]+(?:-[a-z]+)*)?$/;
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

// One Win32_Process JSON row -> { ppid, comm, args, created? }. Shared by realLookup (one row) and processTable (every row) so the two
// cannot drift. `created` is the process start as integer epoch ms: DateTimeOffset converts the CIM date inside PowerShell, so no
// locale or timezone string is parsed here. Throws on a non-object (callers catch).
function winRowInfo(j) {
  const info = { ppid: Number(j.ParentProcessId), comm: String(j.Name ?? ''), args: String(j.CommandLine ?? '') };
  if (typeof j.Created === 'number' && Number.isFinite(j.Created)) info.created = j.Created;
  return info;
}

// The whole Windows process table in ONE PowerShell: Map pid -> { ppid, comm, args, created? }, or null on any failure (not win32, a
// non-zero status, a timeout or other spawn error, empty or malformed output, a payload that is not an array of objects). A row
// without an integer ProcessId is skipped. The script always emits a JSON array (@(...) + -InputObject; PowerShell would otherwise
// unroll a one-element array to a bare object, which is also accepted here). Timeout: twice realLookup's 6 s, because this one start
// also enumerates every process and serialises their command lines (typically 1-3 s on a busy machine); it replaces several
// starts. A failed query is followed by the per-hop fallback, so the worst case is the old per-hop cost plus up to this 12 s.
// maxBuffer 32 MB: a few thousand processes with long command lines is a few MB; an overflow is an error and reads as null (fallback), never a truncated table.
export function processTable(platform = process.platform, spawn = spawnSync) {
  if (platform !== 'win32') return null;
  // An enumeration error must END the process non-zero: under `-Command` the exit code is that of the LAST command (ConvertTo-Json),
  // so a non-terminating Get-CimInstance error (access denied on some processes, a WMI hiccup) would still exit 0 with `[]` or a partial
  // array. `-ErrorAction Stop` makes the error terminating, the `catch { exit 1 }` turns that into an explicit exit code 1 whatever
  // the host's error handling does, and `$ErrorActionPreference='Stop'` covers the remaining cmdlets: a failed query reads as null here.
  const script = `$ErrorActionPreference='Stop'; try { ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process -ErrorAction Stop | Select-Object ProcessId,ParentProcessId,Name,CommandLine,@{n='Created';e={if ($_.CreationDate) { ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() }}}) } catch { exit 1 }`;
  try {
    const r = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: LOOKUP_TIMEOUT_MS * 4, maxBuffer: 32 * 1024 * 1024, windowsHide: true });
    if (!r || r.error || r.status !== 0 || typeof r.stdout !== 'string' || !r.stdout.trim()) return null;
    const parsed = JSON.parse(r.stdout);
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    if (!rows.every((j) => j !== null && typeof j === 'object' && !Array.isArray(j))) return null;
    const table = new Map();
    for (const j of rows) if (Number.isInteger(j.ProcessId)) table.set(j.ProcessId, winRowInfo(j));
    // A real table is never empty: `{}`, `[]` and Windows PowerShell 5.1's `{"value":[...],"Count":N}` wrapper (no ProcessId on the
    // bare object) all end up here with zero rows and must read as a failed snapshot, not as "nobody is running".
    return table.size > 0 ? table : null;
  } catch {
    return null;
  }
}

// { ppid, comm, args, created? } for `pid`, or null when it cannot be looked up. `created` is win32 only (see winRowInfo).
export function realLookup(pid, platform = process.platform, spawn = spawnSync) {
  if (platform === 'win32') {
    const script = `Get-CimInstance Win32_Process -Filter 'ProcessId=${Number(pid)}' | Select-Object ParentProcessId,Name,CommandLine,@{n='Created';e={([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds()}} | ConvertTo-Json -Compress`;
    const r = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: LOOKUP_TIMEOUT_MS * 2, windowsHide: true });
    if (r.status !== 0 || !r.stdout) return null;
    try {
      return winRowInfo(JSON.parse(r.stdout));
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

// The pid of the nearest process above `startPid` that is Claude Code, or null (none found, a failed lookup, a cycle, a long chain, a
// recycled Windows PID). The one walk behind hasClaudeCodeAncestor and the review leases (lib/review-lease.mjs needs the pid to find
// the session's own record). Cycle- and depth-safe; a failed lookup ends the walk with null. On win32 the walk also stops (null) at a
// non-Claude parent created more than REUSE_SKEW_MS after its child (a recycled PID).
export function claudeCodeAncestorPid({ startPid = process.ppid, lookup: injected, platform = process.platform, maxHops = MAX_HOPS, ownPid = process.pid, spawn = spawnSync, table = () => processTable(platform, spawn) } = {}) {
  // `table` (a function returning the pid -> info Map or null) and `spawn` are seams for tests. An injected `lookup` wins over both.
  const perHop = injected ?? ((pid, plat) => realLookup(pid, plat, spawn));
  let lookup = perHop;
  if (injected === undefined && platform === 'win32') {
    let snapshot = null;
    try { snapshot = table(); } catch { snapshot = null; }
    // The running process is in any correct table: a snapshot without ownPid is empty or wrong-shaped, so it is not trusted.
    if (snapshot instanceof Map && snapshot.has(ownPid)) lookup = (pid) => snapshot.get(pid) ?? null;
  }
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
    if (!info) return null;
    if (isClaudeCodeProcess(info)) return pid;
    const created = finiteTime(info.created);
    if (created !== undefined && childCreated !== undefined && created - childCreated > REUSE_SKEW_MS) return null;
    childCreated = created;
    pid = info.ppid;
  }
  return null;
}

// True when a process above `startPid` is Claude Code (claudeCodeAncestorPid has the walk and its stop rules).
export const hasClaudeCodeAncestor = (opts = {}) => claudeCodeAncestorPid(opts) !== null;
