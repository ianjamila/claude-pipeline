// Which private Supabase stacks (and dev-server ports) does one tool call name? The register hook runs this before every
// tool call, so the rules are: (1) over-match, never under-match. A stack named in quoted text, after `true ||`, or in a
// command we cannot even parse still gets a lease; a spurious lease only delays a stop, a missed one lets a stack be
// stopped under a running session. This module never removes a target and never returns a "revoke". The one exception is
// read-only inspection (`readOnlyCommand`; the Read / Grep / Glob file tools): a call made only of those names no stack,
// because looking at a stack is not using it and must not keep it alive or blame a session for it. (2) A parse problem
// (an unterminated quote, a variable we cannot resolve) falls back to a whole-word search of the raw text. (3) `prefilter`
// is the cheap gate that runs on EVERY tool call: string and regex work only, no fs, no subprocess. (4) fs access
// (exists / realpath / readFile) and the platform are injected; paths are compared in POSIX form through
// lib/paths.mjs (samePath / isInside), so a Windows-style path never crashes (nothing here is stoppable on Windows).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { splitCommand } from '../shell-words.mjs';
import { expandHome, isInside, samePath, toPosix } from '../paths.mjs';

export const DEV_RE = /\b(?:next\s+(?:dev|start)|npm\s+(?:run\s+)?(?:dev|start)|npm\s+start)\b/;

const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'Grep', 'Glob', 'NotebookEdit']);
const READ_ONLY_FILE_TOOLS = new Set(['Read', 'Grep', 'Glob']);
const BASH_PREFILTER_RE = /supabase|\.stack\b|psql|docker\s+exec|:\d{4,5}\b|SUPABASE|PG[A-Z]+=/;
const SUPABASE_TOKEN_RE = /(?:^|[\\/])supabase(?:@[^\\/]*)?(?:\.exe|\.cmd)?$/i;
const MAX_NESTING = 2;
const MAX_UP = 40;

const stacksOf = (inventory) => (Array.isArray(inventory) ? inventory : Array.isArray(inventory?.stacks) ? inventory.stacks : []);
const isAbsPosix = (s) => s.startsWith('/') || /^[A-Za-z]:\//.test(s);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---- whole-word search (case-insensitive) ----
// "Whole word" for names that sit in paths and flags: the character before must not continue a name, a path component
// or a dotted/dashed id ([A-Za-z0-9_.-]); the one after must not continue a name ([A-Za-z0-9_-]), so `sa-corrections.stack`
// and `sa-corrections/` match `sa-corrections` but `sa-corrections-notes` does not.
const BEFORE_OK = (ch) => ch === undefined || !/[A-Za-z0-9_.-]/.test(ch);
const AFTER_OK = (ch) => ch === undefined || !/[A-Za-z0-9_-]/.test(ch);

function hasWord(lowerText, name) {
  const needle = String(name ?? '').toLowerCase();
  if (needle === '') return false;
  let from = 0;
  for (;;) {
    const i = lowerText.indexOf(needle, from);
    if (i < 0) return false;
    if (BEFORE_OK(lowerText[i - 1]) && AFTER_OK(lowerText[i + needle.length])) return true;
    from = i + 1;
  }
}

// ---- command parsing ----
// Splits at unquoted && || ; | & newline ( ) and backticks. Never throws; an unterminated quote just runs to the end.
function segmentsOf(command, platform) {
  const out = [];
  let cur = '';
  let quote = null;
  const flush = () => { if (cur.trim() !== '') out.push(cur); cur = ''; };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      cur += ch;
      if (ch === '\\' && quote === '"' && platform !== 'win32' && i + 1 < command.length) cur += command[++i];
      else if (ch === quote) quote = null;
    } else if (ch === '\\' && platform !== 'win32' && i + 1 < command.length) {
      cur += ch + command[++i];
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (ch === '&' || ch === '|' || ch === ';' || ch === '\n' || ch === '\r' || ch === '(' || ch === ')' || ch === '`') {
      flush();
    } else {
      cur += ch;
    }
  }
  flush();
  return out;
}

// Lenient fallback when splitCommand throws: drop every quote character, split on whitespace.
const lenientTokens = (seg) => seg.replace(/["']/g, ' ').split(/\s+/).filter(Boolean);

// Every simple command in `command` (and in the text of nested `bash -c "…"` style arguments, two levels deep) as a token
// list. { tokens, lenient } — lenient marks a segment splitCommand could not parse.
function parseCommand(command, platform, depth = 0) {
  const out = [];
  for (const seg of segmentsOf(String(command), platform)) {
    let tokens;
    let lenient = false;
    try {
      tokens = splitCommand(seg, platform);
    } catch {
      tokens = lenientTokens(seg);
      lenient = true;
    }
    out.push({ tokens, lenient });
    if (depth < MAX_NESTING && !lenient) {
      for (const t of tokens) {
        if (/\s/.test(t) && /supabase|(?:^|\s)cd\s|--workdir/.test(t)) out.push(...parseCommand(t, platform, depth + 1));
      }
    }
  }
  return out;
}

// Leading VAR=value words are not the command.
function commandWords(tokens) {
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
  return tokens.slice(i);
}

// ---- read-only inspection ----
// An inspection is not use: `docker ps`, `ls <folder>`, `grep x <folder>/config.toml` look at a stack without needing it, so a
// command made only of them names no stack. The test is strict, so anything doubtful stays a use (rule 1): every simple
// command must be a cd-like or a listed inspection, the raw text must hold nothing that can run a program inside an argument
// (a `$` expansion, a backtick, `<(`, `>(`), and the only output redirections allowed are to /dev/null or an fd dup.
const NEUTRAL_WORDS = new Set(['cd', 'pushd', 'popd']);
const READ_ONLY_WORDS = new Set(['ls', 'cat', 'head', 'tail', 'grep', 'egrep', 'fgrep', 'wc', 'stat', 'du', 'df', 'jq', 'realpath', 'readlink', 'basename', 'dirname', 'pwd', 'which', 'cut', 'tr', 'diff', 'cmp', 'lsof', 'ps', 'pgrep']);
const FIND_WRITERS = new Set(['-exec', '-execdir', '-ok', '-okdir', '-delete', '-fprint', '-fprint0', '-fprintf', '-fls']);
const DOCKER_READ_SUBS = new Set(['ps', 'inspect', 'logs', 'stats', 'top', 'port', 'images', 'events', 'version', 'info', 'diff']);
const DOCKER_GROUPS = new Set(['container', 'image', 'volume', 'network', 'system']);
const DOCKER_READ_SUBS2 = new Set(['ls', 'list', 'ps', 'inspect', 'logs', 'stats', 'top', 'port', 'diff', 'history', 'df', 'info', 'events']);
// An output redirection that writes nothing a stack could care about: to /dev/null, or an fd dup (`>&2`, `2>&1`).
const SAFE_REDIRECT_RE = /(?:\d*|&)>>?(?:&\d+|\s*\/dev\/null)(?![^\s;&|()])/y;

// The command with its safe redirections blanked out, or null when an unquoted `>` is left (a write to a file).
function withoutSafeRedirects(command, platform) {
  let out = '';
  let quote = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      out += ch;
      if (ch === '\\' && quote === '"' && platform !== 'win32' && i + 1 < command.length) out += command[++i];
      else if (ch === quote) quote = null;
    } else if (ch === '\\' && platform !== 'win32' && i + 1 < command.length) {
      out += ch + command[++i];
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      out += ch;
    } else if (ch === '>' || ((ch === '&' || /\d/.test(ch)) && (i === 0 || /[\s;&|()]/.test(command[i - 1])))) {
      SAFE_REDIRECT_RE.lastIndex = i;
      const m = SAFE_REDIRECT_RE.exec(command);
      if (m) { out += ' '; i += m[0].length - 1; } else if (ch === '>') return null; else out += ch;
    } else {
      out += ch;
    }
  }
  return out;
}

function isInspection(words) {
  const [cmd, ...args] = words;
  if (READ_ONLY_WORDS.has(cmd)) return true;
  // --pre and --hostname-bin each run a program, so an rg that carries either is not an inspection.
  if (cmd === 'rg') return !args.some((a) => a === '--pre' || a.startsWith('--pre=') || a === '--hostname-bin' || a.startsWith('--hostname-bin='));
  if (cmd === 'find') return !args.some((a) => FIND_WRITERS.has(a));
  if (cmd === 'docker') {
    if (DOCKER_READ_SUBS.has(args[0])) return true;
    return DOCKER_GROUPS.has(args[0]) && DOCKER_READ_SUBS2.has(args[1]);
  }
  return false;
}

// True only when EVERY simple command is a cd-like or a read-only inspection and at least one is an inspection. Never throws.
export function readOnlyCommand(command, platform = process.platform) {
  if (typeof command !== 'string' || command === '') return false;
  if (/[$`]|<\(|>\(/.test(command)) return false;
  if (/\\\r?\n/.test(command)) return false; // a line continuation can split `-exec` / `--pre` past the token checks
  const text = withoutSafeRedirects(command, platform);
  if (text === null) return false;
  let inspected = false;
  for (const seg of segmentsOf(text, platform)) {
    let tokens;
    try { tokens = splitCommand(seg, platform); } catch { return false; }
    const words = commandWords(tokens);
    if (words.length === 0) return false;
    if (NEUTRAL_WORDS.has(words[0])) continue;
    if (!isInspection(words)) return false;
    inspected = true;
  }
  return inspected;
}

// ---- paths in POSIX form ----
function resolvePosix(base, p) {
  const s = toPosix(p);
  const joined = isAbsPosix(s) ? s : `${toPosix(base)}/${s}`;
  const norm = path.posix.normalize(joined);
  return norm.length > 1 && norm.endsWith('/') ? norm.slice(0, -1) : norm;
}

const baseName = (p) => path.posix.basename(toPosix(p));
const unresolvable = (s) => /[$`]/.test(s);

function chainFrom(segs, cwd, home) {
  const chain = [cwd];
  let cur = cwd;
  for (const { tokens } of segs) {
    const words = commandWords(tokens);
    if (words[0] !== 'cd' && words[0] !== 'pushd') continue;
    const target = words.slice(1).find((w) => w !== '--' && !/^-[PLe@]+$/.test(w));
    if (target === undefined || target === '-' || unresolvable(target)) continue;
    cur = resolvePosix(cur, expandHome(target, home));
    chain.push(cur);
  }
  return chain;
}

// [cwd, …each cd/pushd target applied in order]. A target we cannot resolve (`cd -`, `cd $X`) is skipped.
export function cwdChain(command, cwd, { platform = process.platform, home = os.homedir() } = {}) {
  const start = typeof cwd === 'string' && cwd !== '' ? cwd : process.cwd();
  if (typeof command !== 'string' || command === '') return [start];
  return chainFrom(parseCommand(command, platform), start, home);
}

// What a hook payload says about the tool call: the tool name, its input object and, for Bash, the command. register() and the
// hook's pre-check (fastpath.mjs) both read the call through this, so they cannot disagree about it.
export function callOf(input) {
  const tool = typeof input?.tool_name === 'string' ? input.tool_name : '';
  const toolInput = input?.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  const command = tool === 'Bash' && typeof toolInput.command === 'string' ? toolInput.command : '';
  return { tool, toolInput, command };
}

// ---- dev servers ----
// One { port } per dev command in the chain (port from -p N, --port N, --port=N, PORT=N; default 3000), duplicates collapsed.
export function devTargets(command) {
  if (typeof command !== 'string') return [];
  const ports = [];
  for (const seg of segmentsOf(command, 'linux')) {
    if (!DEV_RE.test(seg)) continue;
    const m = seg.match(/(?:^|\s)(?:-p|--port)(?:=|\s+)["']?(\d{2,5})\b/) ?? seg.match(/\bPORT=["']?(\d{2,5})\b/);
    const port = m ? Number(m[1]) : 3000;
    if (!ports.includes(port)) ports.push(port);
  }
  return ports.map((port) => ({ port }));
}

// ---- prefilter ----
const fileToolPaths = (input) => [input?.file_path, input?.path, input?.notebook_path].filter((p) => typeof p === 'string' && p !== '');
const segmentsOfPath = (p) => toPosix(p).split('/').filter(Boolean);
const stackLikeSegment = (seg) => /\.stack$/i.test(seg) || seg.toLowerCase() === 'supabase';

// The text of a glob up to its first wildcard: the literal directory prefix.
const globPrefix = (pattern) => {
  const i = pattern.search(/[*?[{]/);
  return i < 0 ? pattern : pattern.slice(0, i);
};

// Cheap gate: could this tool call touch a stack at all? String and regex work only (no fs, no subprocess); a false
// positive costs one inventory lookup, a false negative loses a lease.
export function prefilter({ tool, input, inventory, platform = process.platform } = {}) {
  const stacks = stacksOf(inventory);
  if (tool === 'Bash') {
    const command = input?.command;
    if (typeof command !== 'string' || command === '') return false;
    if (BASH_PREFILTER_RE.test(command)) return true;
    const lower = command.toLowerCase();
    for (const s of stacks) {
      if (hasWord(lower, s?.project) || hasWord(lower, s?.folder)) return true;
      for (const c of s?.containers ?? []) if (hasWord(lower, c?.name)) return true;
    }
    return false;
  }
  if (!FILE_TOOLS.has(tool)) return false;
  const candidates = fileToolPaths(input);
  if (typeof input?.pattern === 'string' && tool === 'Glob') candidates.push(globPrefix(input.pattern));
  for (const p of candidates) {
    if (segmentsOfPath(p).some(stackLikeSegment)) return true;
    if (isAbsPosix(toPosix(p))) {
      for (const s of stacks) if (typeof s?.workdir === 'string' && s.workdir !== '' && isInside(p, s.workdir, platform)) return true;
    }
  }
  return false;
}

// ---- targets ----
export function readProjectId(configToml) {
  if (typeof configToml !== 'string') return null;
  const m = configToml.match(/^[ \t]*project_id[ \t]*=[ \t]*(?:"([^"\n]*)"|'([^'\n]*)')/m);
  const id = m ? (m[1] ?? m[2]) : null;
  return id ? id : null;
}

// ok when the command line contains `supabase … start` in one simple command (not the stop/status of a start-named thing).
export function isStartCommand(command) {
  if (typeof command !== 'string' || command === '') return false;
  for (const { tokens, lenient } of parseCommand(command, process.platform)) {
    const i = tokens.findIndex((t) => SUPABASE_TOKEN_RE.test(t));
    if (i >= 0 && tokens.slice(i + 1).includes('start')) return true;
    if (lenient && /\bsupabase\b[^|;&\n]*\bstart\b/.test(tokens.join(' '))) return true;
  }
  return false;
}

function targetFor(stack, via) {
  const t = { project: stack.project, via };
  if (typeof stack.folder === 'string' && stack.folder !== '') t.folder = stack.folder;
  if (typeof stack.workdir === 'string' && stack.workdir !== '') t.workdir = stack.workdir;
  return t;
}

// Collects targets, one per stack (by project id, else by workdir).
function collector() {
  const byProject = new Set();
  const byWorkdir = [];
  const list = [];
  return {
    list,
    add(t, platform) {
      const key = typeof t.project === 'string' ? t.project.toLowerCase() : null;
      if (key !== null && byProject.has(key)) return;
      if (typeof t.workdir === 'string' && byWorkdir.some((w) => samePath(w, t.workdir, platform))) return;
      if (key !== null) byProject.add(key);
      if (typeof t.workdir === 'string') byWorkdir.push(t.workdir);
      list.push(t);
    },
  };
}

// How a command line or environment names a port: `host:<port>`, `-p <port>`, `--port <port>`, `--port=<port>`, `PGPORT=<port>`
// (the digits must end there: 5442 is not 54422). Shared with the process probe (evidence.mjs).
export const portRefRe = (port) => new RegExp(`(?::|-p\\s*=?\\s*|--port[=\\s]+|pgport=)["']?${port}(?!\\d)`, 'i');

function textMatches(command, stacks) {
  const lower = command.toLowerCase();
  const out = { folder: [], container: [], project: [], port: [] };
  for (const s of stacks) {
    if (hasWord(lower, s?.folder)) out.folder.push(s);
    const project = String(s?.project ?? '');
    const named = (s?.containers ?? []).some((c) => hasWord(lower, c?.name));
    const generic = project !== '' && lower.includes(project.toLowerCase()) && new RegExp(`(?<![A-Za-z0-9_.-])supabase_[a-z0-9]+_${escapeRe(project.toLowerCase())}(?![A-Za-z0-9_-])`).test(lower);
    if (named || generic) out.container.push(s);
    if (hasWord(lower, project)) out.project.push(s);
    for (const port of s?.ports ?? []) {
      if (lower.includes(String(port)) && portRefRe(port).test(lower)) { out.port.push(s); break; }
    }
  }
  return out;
}

function bashTargets({ command, cwd, stacks, exists, realpath, readFile, platform, home }) {
  if (readOnlyCommand(command, platform)) return [];
  const found = collector();
  const segs = parseCommand(command, platform);
  const chain = chainFrom(segs, cwd, home);
  const safeReal = (p) => { try { return realpath(p); } catch { return p; } };
  const safeExists = (p) => { try { return Boolean(exists(p)); } catch { return false; } };
  const configAt = (dir) => {
    const file = `${dir.replace(/\/$/, '')}/supabase/config.toml`;
    if (!safeExists(file)) return null;
    try { return readProjectId(readFile(file)); } catch { return null; }
  };
  const hasConfig = (dir) => safeExists(`${dir.replace(/\/$/, '')}/supabase/config.toml`);
  const stackAt = (dir) => stacks.find((s) => typeof s?.workdir === 'string' && s.workdir !== '' && samePath(s.workdir, dir, platform));

  // --workdir X / --workdir=X, resolved against every directory the command could be running in
  const bare = [];
  for (const { tokens } of segs) {
    let withWorkdir = false;
    tokens.forEach((tok, i) => {
      const value = tok === '--workdir' ? tokens[i + 1] : tok.startsWith('--workdir=') ? tok.slice('--workdir='.length) : undefined;
      if (value === undefined) return;
      withWorkdir = true;
      if (value === '' || unresolvable(value)) return;
      for (const dir of chain) {
        const cand = resolvePosix(dir, expandHome(value, home));
        const real = safeReal(cand);
        const known = stackAt(real) ?? stackAt(cand);
        const cfgReal = hasConfig(real);
        if (!known && !cfgReal) continue;
        const project = known ? known.project : configAt(real);
        const t = { folder: baseName(real), workdir: real, via: 'workdir' };
        if (project) t.project = project;
        found.add(t, platform);
      }
    });
    if (!withWorkdir && tokens.some((t) => SUPABASE_TOKEN_RE.test(t))) bare.push(tokens);
  }

  // bare `supabase <sub>`: the project is whichever supabase/config.toml lies above the directory the command runs in
  if (bare.length > 0) {
    for (const dirStart of chain) {
      let dir = dirStart;
      for (let n = 0; n < MAX_UP; n++) {
        const norm = resolvePosix('/', dir);
        if (hasConfig(norm)) {
          const real = safeReal(norm);
          const known = stackAt(real) ?? stackAt(norm);
          const project = known ? known.project : configAt(real);
          const t = { folder: baseName(real), workdir: real, via: 'config-search' };
          if (project) t.project = project;
          found.add(t, platform);
          break;
        }
        const parent = path.posix.dirname(toPosix(norm));
        if (parent === norm || parent === '.') break;
        dir = parent;
      }
    }
  }

  const text = textMatches(command, stacks);
  for (const via of ['folder', 'container', 'project', 'port']) for (const s of text[via]) found.add(targetFor(s, via), platform);
  return found.list;
}

function fileTargets({ tool, input, cwd, stacks, realpath, platform }) {
  if (READ_ONLY_FILE_TOOLS.has(tool)) return [];
  const found = collector();
  const candidates = fileToolPaths(input);
  if (tool === 'Glob' && typeof input?.pattern === 'string') candidates.push(globPrefix(input.pattern));
  const safeReal = (p) => { try { return realpath(p); } catch { return p; } };
  for (const raw of candidates) {
    const abs = resolvePosix(cwd, raw);
    const forms = [abs, safeReal(abs)];
    const segs = segmentsOfPath(raw).map((s) => s.toLowerCase());
    for (const s of stacks) {
      if (typeof s?.workdir === 'string' && s.workdir !== '' && forms.some((f) => isInside(f, s.workdir, platform))) found.add(targetFor(s, 'path'), platform);
    }
    for (const s of stacks) {
      if (typeof s?.folder === 'string' && s.folder !== '' && segs.includes(s.folder.toLowerCase())) found.add(targetFor(s, 'folder'), platform);
    }
  }
  return found.list;
}

// [{ project?, folder?, workdir?, via }] — the stacks this tool call names. `inventory` is the cached inventory value
// ({ stacks }) or a bare stacks array. via ∈ workdir | folder | project | container | port | config-search | path.
export function stackTargets({ tool, input, cwd, inventory, exists = fs.existsSync, realpath = fs.realpathSync, readFile = (p) => fs.readFileSync(p, 'utf8'), platform = process.platform, home = os.homedir() } = {}) {
  try {
    const stacks = stacksOf(inventory);
    const start = typeof cwd === 'string' && cwd !== '' ? cwd : process.cwd();
    if (tool === 'Bash') {
      const command = input?.command;
      if (typeof command !== 'string' || command === '') return [];
      return bashTargets({ command, cwd: start, stacks, exists, realpath, readFile, platform, home });
    }
    if (FILE_TOOLS.has(tool)) return fileTargets({ tool, input, cwd: start, stacks, realpath, platform });
    return [];
  } catch {
    return rawFallback(tool, input, inventory);
  }
}

// Last resort when the structured match threw: a whole-word search of the raw text, so a parse problem never means fewer
// targets than the inventory names.
function rawFallback(tool, input, inventory) {
  try {
    const text = String(tool === 'Bash' ? input?.command ?? '' : fileToolPaths(input).join(' ')).toLowerCase();
    const found = collector();
    const m = textMatches(text, stacksOf(inventory));
    for (const via of ['folder', 'container', 'project', 'port']) for (const s of m[via]) found.add(targetFor(s, via), 'linux');
    return found.list;
  } catch {
    return [];
  }
}
