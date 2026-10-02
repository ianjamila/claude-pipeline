// Every external process the pipeline starts goes through here, so Windows quirks live in one place:
// npm/codex/vercel/npx are .cmd shims that spawn cannot run directly, and cmd.exe needs its own quoting.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_BUFFER = 64 * 1024 * 1024;

// cmd.exe quoting, ported from cross-spawn (MIT, Copyright (c) 2018 Made With MOXY Lda):
// lib/util/escape.js (escapeCommand, escapeArgument) and lib/parse.js (the `cmd /d /s /c "..."`
// command line). The backslash rules come from https://qntm.org/cmd.
// One deliberate difference: cross-spawn 7.0.x does the backslash step with a lookahead regex that
// only touches the LAST backslash of a run, so `a\\"b` and trailing `\\` come out under-escaped.
// Here the same rules (n backslashes before " -> 2n+1; n trailing -> 2n) are applied run by run,
// which is correct for any run length and linear time. Output is identical for runs of one.
const META_CHARS = /([()\][%!^"`<>&|;, *?])/g;

export function escapeCommand(cmd) {
  return cmd.replace(META_CHARS, '^$1');
}

function escapeBackslashes(arg) {
  let out = '';
  let run = 0;
  for (const ch of arg) {
    if (ch === '\\') { run++; continue; }
    out += '\\'.repeat(ch === '"' ? run * 2 + 1 : run) + ch;
    run = 0;
  }
  return out + '\\'.repeat(run * 2); // trailing backslashes sit before the closing quote we add
}

// doubleEscapeMetaChars: batch files (.cmd/.bat) re-parse their arguments, so escape twice.
export function escapeArgument(arg, doubleEscapeMetaChars = false) {
  let out = `"${escapeBackslashes(String(arg))}"`;
  out = out.replace(META_CHARS, '^$1');
  if (doubleEscapeMetaChars) out = out.replace(META_CHARS, '^$1');
  return out;
}

// Args as they appear on a cmd.exe line that launches a batch file.
export function quoteForCmd(args) {
  return args.map((a) => escapeArgument(a, true)).join(' ');
}

// Windows: `where` (like cmd.exe itself) searches the current directory first, so run it from the
// temp dir; otherwise a planted git.exe / npm.cmd in the repo being worked on would win.
function whereLookup(cmd, cwd) {
  const r = spawnSync('where', [cmd], { cwd, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) return null;
  return r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

// Finds the real file for a bare command name. `where` lists extensionless shims first, so pick the
// first hit that is actually executable. Only hits are cached: a miss may be fixed by installing the
// tool mid-run. `where` is injectable for tests.
export function createResolver(where = whereLookup) {
  const cache = new Map();
  return (cmd) => {
    if (/[\\/]/.test(cmd)) return cmd;
    if (cache.has(cmd)) return cache.get(cmd);
    const hits = where(cmd, os.tmpdir());
    if (!hits || hits.length === 0) return null;
    const found = hits.find((h) => /\.(exe|com|cmd|bat)$/i.test(h)) ?? hits[0];
    cache.set(cmd, found);
    return found;
  };
}

const resolveOnWindows = createResolver();

// Absolute path to cmd.exe: a bare "cmd.exe" would be searched for in the working directory first.
export function cmdExe(env = process.env) {
  return env.ComSpec || 'C:\\Windows\\System32\\cmd.exe';
}

// cmd.exe truncates its command line at 8191 characters and ends it at a newline.
const CMD_LINE_LIMIT = 8191;

// Pure planner (so the Windows branch is testable anywhere): what to actually hand to spawnSync.
// The .cmd line is wrapped in one extra pair of quotes because `cmd /s` strips the outermost pair.
// Callers must pass long or multi-line input through stdin or a file, never as an argument.
export function planSpawn(cmd, args, { platform = process.platform, resolve = resolveOnWindows, env = process.env } = {}) {
  if (platform !== 'win32') return { file: cmd, args, windowsVerbatimArguments: false };
  const resolved = resolve(cmd) ?? cmd;
  if (/\.(cmd|bat)$/i.test(resolved)) {
    if (args.some((a) => /[\r\n]/.test(String(a)))) {
      throw new Error(`cannot pass an argument containing a newline to ${resolved} via cmd.exe; pass it through stdin or a file`);
    }
    const line = [escapeCommand(path.win32.normalize(resolved)), ...args.map((a) => escapeArgument(a, true))].join(' ');
    const file = cmdExe(env);
    const wrapped = `"${line}"`;
    const total = file.length + ' /d /s /c '.length + wrapped.length;
    if (total > CMD_LINE_LIMIT) {
      throw new Error(`command line for ${resolved} is ${total} characters; cmd.exe allows ${CMD_LINE_LIMIT}. Pass long input through stdin or a file`);
    }
    return { file, args: ['/d', '/s', '/c', wrapped], windowsVerbatimArguments: true };
  }
  return { file: resolved, args, windowsVerbatimArguments: false };
}

// A command that was killed for running too long must never look successful: whatever status the
// child reported (a SIGTERM handler can exit 0), a timeout is a non-zero code.
const TIMEOUT_EXIT_CODE = 124;

// Exported for tests.
export function toResult(r) {
  const timedOut = r.error?.code === 'ETIMEDOUT';
  let stderr = r.stderr ?? '';
  if (r.error && !timedOut && !stderr) stderr = r.error.message; // e.g. ENOENT: surface why nothing ran
  // `signal` is how a caller tells "killed" from a plain `exit 1`: a signalled child has no exit status, so `code`
  // falls back to 1 and stderr is empty, which is exactly what git's "no match" answer looks like.
  const code = timedOut ? (r.status || TIMEOUT_EXIT_CODE) : (r.status ?? 1);
  return { code, stdout: r.stdout ?? '', stderr, timedOut, signal: r.signal ?? null };
}

function baseOptions({ cwd, env, timeoutMs } = {}) {
  return {
    cwd,
    env: env ? { ...process.env, ...env } : undefined,
    timeout: timeoutMs,
    killSignal: 'SIGKILL', // SIGTERM can be trapped; a timeout has to stick
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: MAX_BUFFER,
  };
}

export function run(cmd, args = [], { cwd, env, input, timeoutMs } = {}) {
  const plan = planSpawn(cmd, args);
  const r = spawnSync(plan.file, plan.args, {
    ...baseOptions({ cwd, env, timeoutMs }),
    input,
    windowsVerbatimArguments: plan.windowsVerbatimArguments,
  });
  return toResult(r);
}

// For project-configured command lines (e.g. `npm run merge -- 12`): POSIX sh, or cmd.exe on Windows.
// Sync, so on timeout it only kills the direct shell: a grandchild that keeps the output pipes open
// can leave this call waiting. Use runShellAsync for anything that may spawn long-lived children.
// cmd.exe reports an unknown command as exit 1 plus this (English) message where POSIX shells exit 127. Shell runs map it
// to 127 so "could not run" never reads as "ran and failed" (triage would take a missing runner as a failing test).
const CMD_NOT_FOUND = /is not recognized as an internal or external command/;
export function shellResult(r, platform = process.platform) {
  return platform === 'win32' && r.code === 1 && CMD_NOT_FOUND.test(r.stderr) ? { ...r, code: 127 } : r;
}

export function runShell(command, { cwd, env, input, timeoutMs } = {}) {
  return shellResult(toResult(spawnSync(command, { ...baseOptions({ cwd, env, timeoutMs }), input, shell: true })));
}

// Kill a process and everything it started: POSIX signals the process group (the child is spawned
// detached, so it leads its own group); Windows asks taskkill to walk the tree.
function killTree(pid) {
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { cwd: os.tmpdir(), windowsHide: true });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
}

// Shared by runShellAsync and runAsync: a spawn whose timeout takes the whole process tree down, so no orphan keeps
// working (or holding the pipes) after the caller has moved on. Resolves; never rejects.
function spawnAsync(file, args, extra, { cwd, env, input, timeoutMs } = {}) {
  return new Promise((resolve) => {
    const child = spawn(file, args, {
      cwd,
      env: env ? { ...process.env, ...env } : undefined,
      ...extra,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let timer;
    let grace;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      resolve({ code: timedOut ? (code || TIMEOUT_EXIT_CODE) : (code ?? 1), stdout, stderr, timedOut });
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.stdin.on('error', () => {}); // EPIPE when the command exits without reading its input
    child.on('error', (err) => {
      if (!stderr) stderr = err.message;
      finish(1);
    });
    child.on('close', (code) => finish(code));
    child.stdin.end(input);
    if (timeoutMs) {
      timer = setTimeout(() => {
        timedOut = true;
        killTree(child.pid);
        // Safety net: if something still holds the pipes open, give up on them rather than hang.
        grace = setTimeout(() => {
          child.stdout.destroy();
          child.stderr.destroy();
          finish(null);
        }, 2000);
      }, timeoutMs);
    }
  });
}

// Async runShell whose timeout takes the whole process tree down. Resolves; never rejects.
export function runShellAsync(command, opts = {}) {
  return spawnAsync(command, [], { shell: true }, opts).then((r) => shellResult(r));
}

// Async `run` (no shell, Windows shims handled like `run`) with the same tree-killing timeout as runShellAsync. A
// command that cannot be started resolves with a non-zero code and the spawn error ("spawn <cmd> ENOENT") on stderr.
export function runAsync(cmd, args = [], opts = {}) {
  let plan;
  try {
    plan = planSpawn(cmd, args);
  } catch (err) {
    return Promise.resolve({ code: 1, stdout: '', stderr: err.message, timedOut: false });
  }
  return spawnAsync(plan.file, plan.args, { windowsVerbatimArguments: plan.windowsVerbatimArguments }, opts);
}

// Minimal quote-aware splitter for the PIPELINE_GH / PIPELINE_CODEX override strings.
// Single quotes are literal; backslash escapes outside single quotes. Inside double quotes only
// `\"` and `\\` are escapes, so a quoted Windows path keeps its backslashes. On Windows an unquoted
// backslash is always literal (paths), except before a double quote.
export function splitCommand(str, platform = process.platform) {
  const out = [];
  let cur = '';
  let inToken = false;
  let quote = null;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    const next = str[i + 1];
    if (quote === "'") {
      if (ch === "'") quote = null;
      else cur += ch;
    } else if (ch === '\\') {
      if (quote === '"') {
        if (next === '"' || next === '\\') { cur += next; i++; } else cur += ch;
      } else if (platform === 'win32' && next !== '"') {
        cur += ch;
        inToken = true;
      } else if (next !== undefined) {
        cur += next;
        i++;
        inToken = true;
      }
    } else if (quote === '"') {
      if (ch === '"') quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      inToken = true;
    } else if (/\s/.test(ch)) {
      if (inToken) { out.push(cur); cur = ''; inToken = false; }
    } else {
      cur += ch;
      inToken = true;
    }
  }
  if (quote) throw new Error(`splitCommand: unterminated ${quote} quote in: ${str}`);
  if (inToken) out.push(cur);
  return out;
}

// ---- test seams are for the repo checkout only --------------------------------------------------------------------
// PIPELINE_GH / PIPELINE_CODEX / PIPELINE_VERCEL swap the tool the gate trusts for a script, and PIPELINE_TEST_MODE relaxes
// the arbiter's model proof. They exist so the test suite can run the real CLI against fakes; a production install must
// never honour them (an environment variable set by anything that can launch the CLI would otherwise decide what the
// gate sees). An installed copy is recognised by the INSTALLED.json manifest the installer writes into the pipeline root
// (the directory holding bin/); the repo checkout has none. When installed, a seam is ignored with one warning on stderr.
export const PIPELINE_ROOT = fileURLToPath(new URL('..', import.meta.url));
export const SEAM_VARS = ['PIPELINE_GH', 'PIPELINE_CODEX', 'PIPELINE_VERCEL', 'PIPELINE_TEST_MODE'];
export const isInstalledCopy = (root = PIPELINE_ROOT) => existsSync(path.join(root, 'INSTALLED.json'));

const warned = new Set();
// The value of a test seam variable (call env first, then process.env), or undefined when unset or not honoured.
// `root` and `warn` are injectable for tests.
export function seamValue(name, env, { root = PIPELINE_ROOT, warn = (m) => process.stderr.write(m) } = {}) {
  const raw = env?.[name] ?? process.env[name];
  if (raw === undefined || raw === '') return undefined;
  if (!isInstalledCopy(root)) return raw;
  if (!warned.has(name)) {
    warned.add(name);
    warn(`pipeline: ignoring ${name}: test seams are not honoured by an installed copy\n`);
  }
  return undefined;
}

// A seam that is a switch: only the exact value `1` turns it on.
export const seamFlag = (name, env, opts) => seamValue(name, env, opts) === '1';

// Look the override up in the call's env first, then process.env (only when the seam is honoured).
export function overrideCommand(name, fallback, env, opts) {
  const raw = SEAM_VARS.includes(name) ? seamValue(name, env, opts) : (env?.[name] ?? process.env[name]);
  if (!raw || !raw.trim()) return { cmd: fallback, prefixArgs: [] };
  const [cmd, ...prefixArgs] = splitCommand(raw);
  return { cmd, prefixArgs };
}

export class GhError extends Error {
  constructor({ code, stderr, args, timedOut = false }) {
    super(`gh ${args.join(' ')} ${timedOut ? 'timed out' : 'failed'} (exit ${code})${stderr ? `: ${stderr.trim()}` : ''}`);
    this.name = 'GhError';
    this.code = code;
    this.stderr = stderr;
    this.args = args;
    this.timedOut = timedOut;
  }
}

export function gh(args, opts = {}) {
  const { cmd, prefixArgs } = overrideCommand('PIPELINE_GH', 'gh', opts.env);
  return run(cmd, [...prefixArgs, ...args], opts);
}

export function ghJson(args, opts = {}) {
  const r = gh(args, opts);
  if (r.code !== 0 || r.timedOut) throw new GhError({ code: r.code, stderr: r.stderr, args, timedOut: r.timedOut });
  try {
    return JSON.parse(r.stdout);
  } catch {
    throw new GhError({ code: r.code, stderr: `could not parse JSON from stdout: ${r.stdout.slice(0, 200)}`, args });
  }
}

export function codexCommand(env) {
  return overrideCommand('PIPELINE_CODEX', 'codex', env);
}
