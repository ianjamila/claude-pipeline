// Every external process the pipeline starts goes through here, so Windows quirks live in one place:
// npm/codex/vercel/npx are .cmd shims that spawn cannot run directly, and cmd.exe needs its own quoting.
import { spawnSync } from 'node:child_process';
import path from 'node:path';

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

const whereCache = new Map();

// Windows: find the real file for a bare command name. `where` lists extensionless shims first, so
// pick the first hit that is actually executable.
function resolveOnWindows(cmd) {
  if (/[\\/]/.test(cmd)) return cmd;
  if (whereCache.has(cmd)) return whereCache.get(cmd);
  const r = spawnSync('where', [cmd], { encoding: 'utf8', windowsHide: true });
  let found = null;
  if (r.status === 0) {
    const hits = r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    found = hits.find((h) => /\.(exe|com|cmd|bat)$/i.test(h)) ?? hits[0] ?? null;
  }
  whereCache.set(cmd, found);
  return found;
}

// Pure planner (so the Windows branch is testable anywhere): what to actually hand to spawnSync.
// The .cmd line is wrapped in one extra pair of quotes because `cmd /s` strips the outermost pair.
export function planSpawn(cmd, args, { platform = process.platform, resolve = resolveOnWindows } = {}) {
  if (platform !== 'win32') return { file: cmd, args, windowsVerbatimArguments: false };
  const resolved = resolve(cmd) ?? cmd;
  if (/\.(cmd|bat)$/i.test(resolved)) {
    const line = [escapeCommand(path.win32.normalize(resolved)), ...args.map((a) => escapeArgument(a, true))].join(' ');
    return { file: 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], windowsVerbatimArguments: true };
  }
  return { file: resolved, args, windowsVerbatimArguments: false };
}

function toResult(r) {
  const timedOut = r.error?.code === 'ETIMEDOUT';
  let stderr = r.stderr ?? '';
  if (r.error && !timedOut && !stderr) stderr = r.error.message; // e.g. ENOENT: surface why nothing ran
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr, timedOut };
}

function baseOptions({ cwd, env, timeoutMs } = {}) {
  return {
    cwd,
    env: env ? { ...process.env, ...env } : undefined,
    timeout: timeoutMs,
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
export function runShell(command, { cwd, env, timeoutMs } = {}) {
  return toResult(spawnSync(command, { ...baseOptions({ cwd, env, timeoutMs }), shell: true }));
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

// Look the override up in the call's env first, then process.env.
function overrideCommand(name, fallback, env) {
  const raw = env?.[name] ?? process.env[name];
  if (!raw || !raw.trim()) return { cmd: fallback, prefixArgs: [] };
  const [cmd, ...prefixArgs] = splitCommand(raw);
  return { cmd, prefixArgs };
}

export class GhError extends Error {
  constructor({ code, stderr, args }) {
    super(`gh ${args.join(' ')} failed (exit ${code})${stderr ? `: ${stderr.trim()}` : ''}`);
    this.name = 'GhError';
    this.code = code;
    this.stderr = stderr;
    this.args = args;
  }
}

export function gh(args, opts = {}) {
  const { cmd, prefixArgs } = overrideCommand('PIPELINE_GH', 'gh', opts.env);
  return run(cmd, [...prefixArgs, ...args], opts);
}

export function ghJson(args, opts = {}) {
  const r = gh(args, opts);
  if (r.code !== 0) throw new GhError({ code: r.code, stderr: r.stderr, args });
  try {
    return JSON.parse(r.stdout);
  } catch {
    throw new GhError({ code: r.code, stderr: `could not parse JSON from stdout: ${r.stdout.slice(0, 200)}`, args });
  }
}

export function codexCommand(env) {
  return overrideCommand('PIPELINE_CODEX', 'codex', env);
}
