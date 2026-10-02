// Why: the owner's rule is that agents must not edit their own rules. This is the pure decision logic of the
// global guard-files hook: it denies file tools, MCP tools and Bash commands that would change the installed
// pipeline files (skills, agents, ~/.claude/pipeline, ~/.claude/settings.json), delete or overwrite the dirs
// that hold them (~/.claude, ~/.claude/skills, ~/.claude/agents), switch hooks off (`disableAllHooks`) or set
// the admin switch (`PIPELINE_ADMIN`). Only a Claude Code process launched with PIPELINE_ADMIN=1 bypasses it.
// Bash is judged on text, so the checks lean towards denying (`echo ~/.claude/pipeline` is denied); the hook
// stops accidents and casual circumvention, not an adversary who builds the path out of pieces at run time.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { toPosix, expandHome, isInside, samePath } from '../../lib/paths.mjs';
import { simpleCommands, commandName } from './shell-parse.mjs';

const posix = path.posix;

// ---- the protected set ------------------------------------------------------------------------

const PROTECTED_REL = [
  '.claude/skills/ship',
  '.claude/skills/verify',
  '.claude/skills/pipeline-setup',
  '.claude/agents/implementer.md',
  '.claude/agents/verifier.md',
  '.claude/agents/judge.md',
  '.claude/agents/arbiter.md',
  '.claude/pipeline',
  '.claude/settings.json',
];

// The directories that hold them. Writing INTO them is fine (history, projects, CLAUDE.md, other skills), but
// replacing, deleting, moving or running a repo command in them reaches the protected files, so for a
// non-read-only command a word that IS one of these (exactly, not a child) counts as a protected reference.
const ANCESTOR_REL = ['.claude', '.claude/skills', '.claude/agents'];

const DEVICE_PREFIX = /^\/\/[?.]\/(?=[A-Za-z]:\/)/; // \\?\C:\ and \\.\C:\ forms

const isAbs = (s) => s.startsWith('/') || /^[A-Za-z]:\//.test(s);
const caseInsensitive = (platform) => platform === 'win32' || platform === 'darwin';
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const unique = (a) => [...new Set(a)];
const baseOf = commandName;
const deny = (reason) => ({ decision: 'deny', reason });
const allow = () => ({ decision: 'allow', reason: '' });

function posixHome(home) {
  const h = toPosix(home ?? '').replace(DEVICE_PREFIX, '');
  if (!h) return '';
  const n = posix.normalize(h);
  return n.length > 1 && n.endsWith('/') ? n.slice(0, -1) : n;
}

export function protectedRoots(home) {
  const h = posixHome(home);
  const base = h === '/' ? '' : h;
  return PROTECTED_REL.map((r) => `${base}/${r}`);
}

// Git-bash, WSL and Cygwin spell C:\Users\u as /c/Users/u, /mnt/c/Users/u and /cygdrive/c/Users/u.
function withWindowsAliases(paths, home, platform) {
  if (platform !== 'win32') return paths;
  const m = /^([A-Za-z]):(\/.*)?$/.exec(posixHome(home));
  if (!m) return paths;
  const d = m[1].toLowerCase();
  const extra = [];
  for (const r of paths) {
    const rest = r.slice(2);
    extra.push(`/${d}${rest}`, `/mnt/${d}${rest}`, `/cygdrive/${d}${rest}`);
  }
  return [...paths, ...extra];
}

// ---- path resolution (symlinks) -----------------------------------------------------------------

// Real location of `p`: the realpath when it exists, else the realpath of the nearest existing ancestor with
// the missing tail appended. A dangling symlink is followed by hand because existsSync() says false for it, yet
// writing through it creates the file at its target.
function realResolve(p, api, depth = 0) {
  let cur = p;
  const tail = [];
  for (let i = 0; i < 256; i++) {
    let exists = false;
    try { exists = api.existsSync(cur); } catch { /* treated as missing */ }
    if (exists) {
      try { return posix.join(toPosix(api.realpath(cur)).replace(DEVICE_PREFIX, ''), ...tail.slice().reverse()); } catch { return p; }
    }
    if (depth < 8) {
      let link = null;
      try { link = api.readlink(cur); } catch { /* not a symlink */ }
      if (typeof link === 'string' && link) {
        const l = toPosix(link).replace(DEVICE_PREFIX, '');
        const target = isAbs(l) ? l : posix.join(posix.dirname(cur), l);
        return realResolve(posix.join(target, ...tail.slice().reverse()), api, depth + 1);
      }
    }
    let parent = posix.dirname(cur);
    if (/^[A-Za-z]:$/.test(parent)) parent += '/';
    if (parent === cur || parent === '.') return p;
    tail.push(posix.basename(cur));
    cur = parent;
  }
  return p;
}

// lstat with throwIfNoEntry is cheap where readlink would throw for every ordinary missing path. When a caller
// injects its own existsSync the filesystem is virtual, so the real one is not consulted for links at all.
function readLinkIfAny(p) {
  const st = fs.lstatSync(p, { throwIfNoEntry: false });
  return st?.isSymbolicLink() ? fs.readlinkSync(p) : null;
}

function makeCtx(opts) {
  const platform = opts.platform ?? process.platform;
  const homeNative = opts.home || os.homedir();
  const homePosix = posixHome(homeNative);
  let cwd = toPosix(opts.cwd || process.cwd()).replace(DEVICE_PREFIX, '');
  if (!isAbs(cwd)) cwd = posix.join(toPosix(process.cwd()), cwd);
  cwd = posix.normalize(cwd);
  const api = {
    realpath: opts.realpath ?? fs.realpathSync.native,
    existsSync: opts.existsSync ?? fs.existsSync,
    readlink: opts.readlink ?? (opts.existsSync ? () => null : readLinkIfAny),
  };
  const base = homePosix === '/' ? '' : homePosix;
  const lexRoots = protectedRoots(homePosix);
  const lexAncestors = ANCESTOR_REL.map((r) => `${base}/${r}`);
  const roots = unique([...withWindowsAliases(lexRoots, homePosix, platform), ...lexRoots.map((r) => realResolve(r, api))]);
  const ancestors = unique([...withWindowsAliases(lexAncestors, homePosix, platform), ...lexAncestors.map((r) => realResolve(r, api))]);
  const ci = caseInsensitive(platform);
  return {
    platform, homeNative, homePosix, cwd, api, roots, lexRoots, ancestors, lexAncestors, ci,
    user: opts.user ?? posix.basename(homePosix),
    vars: {}, // same-line shell assignments (D=$HOME/.claude), filled in once the line is parsed
    dynamic: false, // set when a scan had to be skipped for size; callers fail closed
    admin: (opts.env ?? process.env).PIPELINE_ADMIN === '1',
    hit: (p) => roots.some((r) => isInside(p, r, platform)),
    hitAncestor: (p) => ancestors.some((a) => samePath(p, a, platform)),
  };
}

// ---- content rules (file tools and Bash share them) -----------------------------------------------

function unescapeJs(s) {
  return s.replace(/\\u\{([0-9a-fA-F]+)\}|\\u([0-9a-fA-F]{4})|\\x([0-9a-fA-F]{2})/g, (m, a, b, c) => {
    try { return String.fromCodePoint(parseInt(a || b || c, 16)); } catch { return m; }
  });
}

// Naming the switch is fine (docs, grep, prose); SETTING it is not: assignment, export, setx, $env:, a JSON/env key.
// A read (`$PIPELINE_ADMIN = 1` inside [ ]) or a comparison (`=== '1'`, `==`, `=~`) is not an assignment.
// PIPELINE_ADMIN is case-sensitive on POSIX; Windows environment variable names are not.
const ADMIN_SET = [
  /(?<!\$)\bPIPELINE_ADMIN\s*=(?![=~])/,
  /\bexport\s+PIPELINE_ADMIN\b/,
  /\$env:PIPELINE_ADMIN\b/i,
  /\bsetx?\s+PIPELINE_ADMIN\b/i,
  /\bsetenv\s+PIPELINE_ADMIN\b/,
  /["']PIPELINE_ADMIN["']\s*[:\],]/,
  /\benv\s+(?:-\S+\s+)*PIPELINE_ADMIN=/,
  /\bPIPELINE_ADMIN\s*:\s*["']?(?:1|true)\b/i,
];
const ADMIN_SET_CI = ADMIN_SET.map((re) => new RegExp(re.source, re.flags.includes('i') ? re.flags : `${re.flags}i`));
const setsAdmin = (text, platform) => (platform === 'win32' ? ADMIN_SET_CI : ADMIN_SET).some((re) => re.test(text));
const hasDisableAll = (text) => text.includes('disableAllHooks');
const variantsOf = (text) => unique([text, unescapeJs(text)]);

// The text a file tool would put on disk.
function writtenTexts(ti) {
  const out = [];
  for (const k of ['content', 'new_string', 'new_source']) if (typeof ti?.[k] === 'string') out.push(ti[k]);
  if (Array.isArray(ti?.edits)) for (const e of ti.edits) if (typeof e?.new_string === 'string') out.push(e.new_string);
  return out;
}

const SETTINGS_RE = /^settings(\.[\w-]+)?\.json$/i;

// ---- file tools -----------------------------------------------------------------------------------

function lexicalTarget(target, ctx) {
  let s = toPosix(expandHome(target, ctx.homeNative)).replace(DEVICE_PREFIX, '');
  if (!isAbs(s)) s = posix.join(ctx.cwd, s);
  s = posix.normalize(s);
  return s.length > 1 && s.endsWith('/') ? s.slice(0, -1) : s;
}

const PROTECTED_MSG = 'skills, agents, ~/.claude/pipeline and ~/.claude/settings.json can only be changed by the owner with PIPELINE_ADMIN=1';

// MCP servers (a filesystem server, any other server's write tools, a browser or IDE that runs code) reach the
// same files without Edit/Write. Their tool_input has no fixed shape, so values are picked out by key name.
const MCP_PATH_KEYS = new Set([
  'path', 'paths', 'file_path', 'filePath', 'notebook_path', 'source', 'destination', 'target', 'dest', 'from', 'to', 'dir', 'directory',
  'filepath', 'file', 'filename', 'file_name', 'uri', 'old_path', 'new_path', 'oldPath', 'newPath', 'src', 'dst', 'sourcePath', 'targetPath',
  'relative_path', 'output_path', 'outputPath',
]);
const MCP_CONTENT_KEYS = new Set(['content', 'contents', 'text', 'newText', 'new_string', 'data', 'body']);
// File content and prose are not scanned for protected references (a Notion page may mention ~/.claude/pipeline).
const MCP_PROSE_KEYS = new Set([...MCP_CONTENT_KEYS, 'message', 'description', 'title', 'comment', 'summary', 'notes', 'markdown', 'html', 'prompt', 'subject', 'caption', 'label']);
// Values of these keys are shell or program text: judged like a Bash command.
const MCP_COMMAND_KEYS = new Set(['command', 'cmd', 'code', 'script', 'source_code', 'shell']);
const MCP_WRITE_VERB = /write|edit|move|rename|create|delete|remove|copy|append|patch|update|set|put|upload|mkdir|chmod|make|download|snapshot|screenshot|export|save|replace|insert|truncate|link|touch|overwrite|modify|apply|store|(?:^|_)(?:rm|cp|mv|del|ln|add)(?:_|$)/i;
// A tool that clearly only looks. Anything else is scanned for protected paths in ANY string value.
const MCP_READ_ONLY = /^(?:read|list|get|search|find|view|query|describe|status|info|directory_tree|tree|stat|exists|show|diff|compare|hash|checksum|count|check|inspect|lookup)/i;

function mcpFields(ti) {
  const paths = [];
  const contents = [];
  const values = []; // [key, string] for every string that is not file content or prose
  const take = (v, key, bucket, depth = 0) => {
    if (typeof v === 'string') bucket.push(v);
    else if (depth < 12 && v && typeof v === 'object') for (const x of Object.values(v).slice(0, 2000)) take(x, key, bucket, depth + 1);
  };
  const walk = (v, key, depth) => {
    if (typeof v === 'string') { values.push([key, v]); return; }
    if (depth > 12 || v === null || typeof v !== 'object') return;
    for (const [k, x] of (Array.isArray(v) ? v.slice(0, 2000).map((e) => [key, e]) : Object.entries(v))) {
      if (MCP_PATH_KEYS.has(k)) { take(x, k, paths); walk(x, k, depth + 1); } else if (MCP_CONTENT_KEYS.has(k)) take(x, k, contents);
      else if (MCP_PROSE_KEYS.has(k)) continue;
      else walk(x, k, depth + 1);
    }
  };
  walk(ti, '', 0);
  return { paths: paths.slice(0, 500), contents, values: values.slice(0, 2000) };
}

function evaluateMcp(tool, ti, input, opts) {
  const last = tool.split('__').pop();
  if ((opts.env ?? process.env).PIPELINE_ADMIN === '1') return allow();
  if (MCP_READ_ONLY.test(last)) return allow();
  const f = mcpFields(ti);
  if (!f.paths.length && !f.values.length) return allow();
  const ctx = makeCtx({ ...opts, cwd: input?.cwd });
  if (ctx.admin) return allow();

  const writeVerb = MCP_WRITE_VERB.test(last);
  const resolve = (t) => {
    const lexical = lexicalTarget(t, ctx);
    return unique([lexical, realResolve(lexical, ctx.api)]);
  };
  // 1. a file write: the path keys name the targets (an exact ancestor dir counts too)
  const targets = writeVerb ? f.paths.map((t) => ({ t, candidates: resolve(t) })) : [];
  for (const { t, candidates } of targets) {
    if (candidates.some((c) => ctx.hit(c) || ctx.hitAncestor(c))) return deny(`${t} is a protected pipeline file or the directory that holds it (${PROTECTED_MSG})`);
  }
  if (targets.length) {
    const texts = f.contents.flatMap(variantsOf);
    if (texts.some(hasDisableAll)) {
      for (const { t, candidates } of targets) {
        for (const c of candidates) {
          const parent = posix.basename(posix.dirname(c));
          if ((ctx.ci ? parent.toLowerCase() === '.claude' : parent === '.claude') && SETTINGS_RE.test(posix.basename(c))) return deny(`writing disableAllHooks into ${t} would switch the pipeline hooks off`);
        }
      }
    }
    if (texts.some((x) => setsAdmin(x, ctx.platform))) return deny('this write sets PIPELINE_ADMIN; only the owner does that, when launching Claude Code');
  }
  // 2. anything else a tool that is not clearly read-only was given: a path anywhere, or code that builds one
  const matchers = makeMatchers(ctx);
  const dirs = [ctx.cwd];
  for (const [key, s] of f.values) {
    if (typeof s !== 'string' || !s) continue;
    if (MCP_COMMAND_KEYS.has(key)) {
      const r = evaluateBashForFiles(s, { ...opts, cwd: input?.cwd });
      if (r.decision === 'deny') return deny(`${tool} would run: ${r.reason}`);
      continue; // the Bash rules are the whole verdict for a command (a read of a protected file is fine)
    }
    const pathLike = s.length <= 1024 && !/\s/.test(s) && (/[\\/]/.test(s) || /^[.~]/.test(s));
    if ((pathLike && matchers.pathHit(s, dirs, false)) || matchers.rawHit(s, dirs)) return deny(`${tool} refers to a protected pipeline file (${PROTECTED_MSG})`);
    if (pathLike && resolve(s).some((c) => ctx.hit(c))) return deny(`${tool} refers to a protected pipeline file (${PROTECTED_MSG})`);
  }
  return allow();
}

export function evaluateFileTool(input, opts = {}) {
  const tool = typeof input?.tool_name === 'string' ? input.tool_name : '';
  const ti = input?.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  if (tool.startsWith('mcp__')) return evaluateMcp(tool, ti, input, opts);

  const ctx = makeCtx({ ...opts, cwd: input?.cwd });
  if (ctx.admin) return allow();
  const target = typeof ti.file_path === 'string' && ti.file_path ? ti.file_path : (typeof ti.notebook_path === 'string' ? ti.notebook_path : '');
  const targets = target ? [target] : [];
  const texts = writtenTexts(ti).flatMap(variantsOf);

  const resolved = targets.map((t) => {
    const lexical = lexicalTarget(t, ctx);
    return { t, candidates: unique([lexical, realResolve(lexical, ctx.api)]) };
  });
  for (const { t, candidates } of resolved) {
    if (candidates.some((c) => ctx.hit(c))) return deny(`${t} is a protected pipeline file (${PROTECTED_MSG})`);
  }
  if (texts.some(hasDisableAll)) {
    for (const { t, candidates } of resolved) {
      for (const c of candidates) {
        const parent = posix.basename(posix.dirname(c));
        const inClaudeDir = ctx.ci ? parent.toLowerCase() === '.claude' : parent === '.claude';
        if (inClaudeDir && SETTINGS_RE.test(posix.basename(c))) return deny(`writing disableAllHooks into ${t} would switch the pipeline hooks off`);
      }
    }
  }
  if (texts.some((x) => setsAdmin(x, ctx.platform))) {
    return deny('this write sets PIPELINE_ADMIN (an assignment, export or env key); a script that sets it could switch the guard off, so only the owner does that, when launching Claude Code');
  }
  return allow();
}

// ---- Bash: text normalisation ---------------------------------------------------------------------

const MARK = '\u0001';

// Every way the home directory is spelled in a shell line or a one-liner script. A trailing `+ '`, `, '` or
// `.joinpath('` (string concatenation / path.join) is swallowed so `process.env.HOME+'/.claude/x'` reads as one path.
const HOME_RE = new RegExp(
  '(?:'
  + [
    'process\\.env\\.(?:HOME|USERPROFILE)\\b',
    'process\\.env\\[\\s*[\'"](?:HOME|USERPROFILE)[\'"]\\s*\\]',
    'require\\(\\s*[\'"](?:node:)?os[\'"]\\s*\\)\\s*\\.\\s*homedir\\(\\s*\\)',
    '(?<![\\w$])(?:os\\s*\\.\\s*)?homedir\\(\\s*\\)',
    '(?:pathlib\\s*\\.\\s*)?\\bPath\\s*\\.\\s*home\\(\\s*\\)',
    '\\bDir\\.home\\b(?:\\(\\s*\\))?',
    'os\\.environ(?:\\.get\\(|\\[)\\s*[\'"](?:HOME|USERPROFILE)[\'"]\\s*[)\\]]',
    'os\\.path\\.expanduser\\(\\s*[\'"]~[\'"]\\s*\\)',
    '\\$env:(?:USERPROFILE|HOME)\\b',
    '%USERPROFILE%',
    '%HOMEDRIVE%%HOMEPATH%',
    '\\$\\{(?:HOME|USERPROFILE)\\}',
    '\\$(?:HOME|USERPROFILE)(?![A-Za-z0-9_])',
    '\\$\\(\\s*(?:eval\\s+)?echo\\s+(?:~|\\$HOME|\\$\\{HOME\\})\\s*\\)',
    '`\\s*(?:eval\\s+)?echo\\s+(?:~|\\$HOME)\\s*`',
  ].join('|')
  + ')(\\s*[+,]\\s*[\'"`]|\\s*\\.\\s*joinpath\\s*\\(\\s*[\'"`]?)?',
  'gi',
);
const TILDE_RE = /(^|[\s'"`=:(,[{;|&<>+])~(?=\/|$|[\s'"`)\]};|&<>,+])/g;
const USER_RE = /\$(?:USER|LOGNAME|USERNAME)(?![A-Za-z0-9_])|\$\{(?:USER|LOGNAME|USERNAME)\}|\$\(\s*(?:whoami|logname|id\s+-un)\s*\)|`\s*(?:whoami|logname|id\s+-un)\s*`|%USERNAME%|\$env:USERNAME\b/gi;
const MARK_STRIP = new RegExp(`${MARK}['"\`)}\\]]*`, 'g');

function expandHomeRefs(text, home) {
  return text
    .replace(HOME_RE, (_m, glue) => home + MARK + (glue ? (glue.includes('+') ? '' : '/') : ''))
    .replace(TILDE_RE, (_m, pre) => `${pre}${home}${MARK}`)
    .replace(MARK_STRIP, '');
}

// $NAME / ${NAME} for variables assigned earlier on the same line (D=$HOME/.claude; echo x > $D/settings.json).
function substVars(text, vars) {
  let t = text;
  for (let pass = 0; pass < 4 && t.includes('$'); pass++) {
    const next = t.replace(/\$\{(\w+)\}|\$(\w+)/g, (m, a, b) => (Object.hasOwn(vars, a ?? b) ? vars[a ?? b] : m));
    if (next === t) break;
    t = next;
  }
  return t;
}

// Slash-normalised copy of `text` with the user name, same-line variables and every home spelling replaced.
function expandRefs(text, ctx) {
  const t = toPosix(text).replace(USER_RE, ctx.user);
  return expandHomeRefs(substVars(t, ctx.vars), ctx.homePosix);
}

// Expands the first `{a,b}` groups of each word so `~/.claude/{pipeline,settings.json}` shows both paths.
// Above 5,000 characters the expansion is skipped and the scan is marked dynamic (callers fail closed).
function braceExpand(s, ctx) {
  if (!s.includes('{') || !s.includes(',')) return s;
  if (s.length > 5000) { ctx.dynamic = true; return s; }
  let cur = s;
  for (let round = 0; round < 4; round++) {
    let changed = false;
    cur = cur.replace(/(\S*?)\{([^{}\s]*,[^{}\s]*)\}(\S*)/g, (_m, pre, body, post) => {
      changed = true;
      return body.split(',').map((x) => pre + x + post).join(' ');
    });
    if (!changed || cur.length > 50_000) break;
  }
  return cur;
}

// Several readings of `text` to look for protected paths in: as is, with string glue squashed ('+', ',' and '/'
// between quotes, quotes next to a slash), and brace-expanded.
function refVariants(text, ctx) {
  const v0 = expandRefs(text, ctx);
  const v1 = v0
    .replace(/['"`]\s*\+\s*['"`]/g, '')
    .replace(/['"`]\s*[,/]\s*['"`]/g, '/')
    .replace(/\s*\/\s*(?=['"`])/g, '/')
    .replace(/\/['"`]+/g, '/')
    .replace(/['"`]+\//g, '/');
  return unique([v0, v1, braceExpand(v0, ctx)]);
}

// A root counts only on a path-segment boundary: `/ship` must not match `/shipping`. The preceding-character
// test lets `-C/path` (a flag with an attached value) through but not `/mnt/home/u/...`.
function rootRegexes(ctx) {
  return ctx.roots.map((r) => new RegExp(`(?:(?<![\\w.~])|(?<=\\s-[A-Za-z]))${escapeRe(r)}(?![\\w.\\-])`, ctx.ci ? 'i' : ''));
}

// An exact ancestor dir (`~/.claude`, `~/.claude/skills`, with or without a trailing slash), not a child of it.
function ancestorRegexes(ctx) {
  return ctx.ancestors.map((a) => new RegExp(`(?:(?<![\\w.~])|(?<=\\s-[A-Za-z]))${escapeRe(a)}/*(?![\\w.\\-/])`, ctx.ci ? 'i' : ''));
}

// The protected files named by their tail (`.claude/settings.json`), whatever lies in front of it.
const SEP = "(?=[ \\t]*[/'\"`,+])[/'\"`,+ \\t]+"; // between pieces of a code-built path: '.claude', 'skills', 'ship'
function suffixBody(sep) {
  const end = '(?![\\w.\\-])';
  return `\\.claude${sep}(?:settings\\.json${end}|pipeline${end}|skills${sep}(?:ship|verify|pipeline-setup)${end}|agents${sep}(?:implementer|verifier|judge|arbiter)\\.md${end})`;
}
// ...preceded by something only known at run time: a variable, a command substitution, a template `${...}`, a call
// result `)`, a `+` or `,` joining pieces, `~user`, `.join(` / `.joinpath(`.
const NONLIT_PREFIX = "(?:[})\\]]|\\$\\w+|~\\w*|[+,][ \\t]*|join(?:path)?\\([ \\t]*)['\"`/]*";
// ...or preceded by a plain relative prefix (`.claude/x`, `../.claude/x`, `sub/.claude/x`), resolved against the directories in play.
const REL_PREFIX = '(?<![\\w$.~/\\\\-])(?:[\\w.\\-]+/+)*';

function suffixRegexes(ci) {
  const flags = ci ? 'i' : '';
  return {
    nonlit: new RegExp(NONLIT_PREFIX + suffixBody(SEP), flags),
    rel: new RegExp(REL_PREFIX + suffixBody('/+'), `g${flags}`),
  };
}

function globToRe(g, ci) {
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') { re += '.*'; i++; } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '[') {
      const j = g.indexOf(']', i + 2);
      if (j < 0) re += '\\[';
      else { re += `[${g.slice(i + 1, j).replace(/^!/, '^').replace(/\\/g, '\\\\')}]`; i = j; }
    } else re += escapeRe(c);
  }
  try { return new RegExp(`^${re}$`, ci ? 'i' : ''); } catch { return null; }
}

// Every protected root plus the directories between it and the home directory, for globs like `~/.claude/*`.
function rootsAndAncestors(ctx) {
  const out = new Set();
  for (const r of ctx.lexRoots) {
    let p = r;
    while (p.length > ctx.homePosix.length && p !== posix.dirname(p)) { out.add(p); p = posix.dirname(p); }
  }
  return [...out];
}

function makeMatchers(ctx) {
  const rootRes = rootRegexes(ctx);
  const ancRes = ancestorRegexes(ctx);
  const suffix = suffixRegexes(ctx.ci);
  const ancestors = rootsAndAncestors(ctx);

  // Is a protected file named in `text`? By absolute path (in any of its spellings), by a tail with an unknown
  // prefix, or by a relative tail that lands in a protected root from one of `dirs`.
  const rawHit = (text, dirs) => {
    if (!text) return false;
    for (const v of refVariants(String(text), ctx)) {
      if (rootRes.some((re) => re.test(v))) return true;
      if (!(ctx.ci ? v.toLowerCase() : v).includes('.claude')) continue;
      if (suffix.nonlit.test(v)) return true;
      if (dirs) {
        suffix.rel.lastIndex = 0;
        for (const mm of v.matchAll(suffix.rel)) for (const d of dirs) if (ctx.hit(posix.join(d, mm[0]))) return true;
      }
    }
    return false;
  };

  // An ancestor dir named exactly in a Windows-style command (backslashes are lost from argv, so read the raw text).
  const ancestorRaw = (text) => !!text && refVariants(String(text), ctx).some((v) => ancRes.some((re) => re.test(v)));

  const globHit = (g) => {
    const star = g.search(/[*?[]/);
    const lit = g.slice(0, g.lastIndexOf('/', star) + 1) || '/';
    if (ctx.hit(lit)) return true;
    const re = globToRe(g, ctx.ci);
    return !!re && ancestors.some((a) => re.test(a));
  };

  // A word that, resolved against any directory the command line has been in, lands inside a protected root (or is
  // exactly an ancestor dir when `withAncestors`). Catches what the textual scan cannot: `..` segments and relative
  // paths after `cd`.
  const pathHit = (tok, dirs, withAncestors = true) => {
    let parts = [tok];
    if (tok.startsWith('-')) {
      const eq = tok.indexOf('=');
      parts = eq > 0 ? [tok.slice(eq + 1)] : [];
    }
    for (const part of parts) {
      if (!part) continue;
      const e = expandRefs(part, ctx);
      const bases = isAbs(e) ? [''] : dirs;
      for (const d of bases) {
        const full = isAbs(e) ? posix.normalize(e) : posix.join(d, e);
        if (/[*?[]/.test(full) ? globHit(full) : (ctx.hit(full) || (withAncestors && ctx.hitAncestor(full)))) return true;
      }
    }
    return false;
  };
  return { rawHit, pathHit, ancestorRaw };
}

// ---- Bash: command classification -----------------------------------------------------------------

const READ_ONLY = new Set(['cat', 'head', 'tail', 'less', 'more', 'ls', 'stat', 'wc', 'grep', 'rg', 'diff', 'cmp', 'shasum', 'sha256sum', 'sha1sum', 'md5', 'md5sum', 'file', 'readlink', 'realpath', 'test', '[', 'cut', 'du', 'hexdump', 'bat']);
const PS_READ_ONLY = new Set(['get-content', 'get-childitem', 'gc', 'gci']);
const GIT_READ_ONLY = new Set(['log', 'show', 'diff', 'status', 'ls-files', 'blame']);
const CD_CMDS = new Set(['cd', 'pushd', 'popd', 'set-location', 'sl']);
const FIND_UNSAFE = /^-(?:delete|exec|execdir|ok|okdir|fprint0?|fprintf|fls)$/;
const SHELL_NAMES = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'csh', 'tcsh', 'pwsh', 'powershell', 'cmd']);
// For these only the destination (last word, or -t DIR) can change a protected file; reading one into /tmp is fine.
const DEST_ONLY = new Set(['cp', 'rsync', 'install']);
const MOVERS = new Set(['mv', 'ln', 'ditto']); // any named protected path counts, and so does DEST/basename(SRC)
const WRITE_OPS = new Set(['>', '>>', '>|', '>&', '&>', '&>>', '<>']);
// xargs is unwrapped by the parser, so its name only survives in the raw text.
const FAN_OUT_RE = /(?:^|[\s;&|(`])(?:xargs|parallel)(?=\s|$)/;

const shellQuote = (w) => (/^[\w@%+=:,./~-]+$/.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`);

// `-i`, `-i.bak`, `-pi`, `-ni`, `--in-place`
const inPlaceFlag = (a) => /^-[A-Za-z]*i/.test(a) || a === '--in-place' || a.startsWith('--in-place=');
const positional = (args) => args.filter((a) => !a.startsWith('-') && !/^\d+$/.test(a));

// A sed script with a `w FILE` / `W FILE` command or flag, or an `e` command or flag, writes or runs something.
const SED_UNSAFE = /(?:^|[;{}\s\d$/])[wWe](?:\s|$)|\/[gpiIm0-9]*[we](?=\s|$|;|\})/;
function sedReadOnly(args) {
  return !args.some((a) => (a.startsWith('-') ? inPlaceFlag(a) || a === '-f' || a === '--file' || a.startsWith('--file=') : SED_UNSAFE.test(a)));
}

function awkReadOnly(args) {
  return !args.some((a) => (a.startsWith('-') ? /^-[A-Za-z]*[ifE]/.test(a) || /^--(?:include|file|exec|load)/.test(a) : /[>|]|\bsystem\s*\(/.test(a)));
}

function gitReadOnly(args) {
  let i = 0;
  while (i < args.length) {
    const a = args[i];
    if (a === '-c' || (a.startsWith('-c') && !a.startsWith('--')) || a.startsWith('--config-env') || a.startsWith('--exec-path')) return false; // config injection (alias.x='!cmd') runs commands
    if (a === '-C' || a === '--git-dir' || a === '--work-tree' || a === '--namespace') { i += 2; continue; }
    if (a.startsWith('-')) { i++; continue; }
    break;
  }
  if (!GIT_READ_ONLY.has(args[i])) return false;
  return !args.slice(i + 1).some((a) => a === '--output' || a.startsWith('--output=') || a === '--ext-diff');
}

function isPipelineTool(arg, ctx) {
  if (typeof arg !== 'string') return false;
  const e = expandRefs(arg, ctx);
  if (!isAbs(e)) return false;
  return samePath(e, `${ctx.homePosix}/.claude/pipeline/bin/pipeline.mjs`, ctx.platform)
    || isInside(e, `${ctx.homePosix}/.claude/pipeline/hooks`, ctx.platform);
}

// A Windows `node C:\...\pipeline.mjs` loses its backslashes in argv, so look at the raw text too.
function pipelineToolInRaw(raw, ctx) {
  const t = expandRefs(raw, ctx);
  const root = escapeRe(`${ctx.homePosix}/.claude/pipeline`);
  return new RegExp(`^\\s*(?:\\S*/)?node(?:\\.exe)?\\s+["']?${root}/(?:bin/pipeline\\.mjs|hooks/[^\\s'"]*)(?:["']?\\s|["']?$)`, ctx.ci ? 'i' : '').test(t);
}

function pwshReadOnly(argv) {
  let text = null;
  for (let i = 1; i < argv.length; i++) {
    const f = argv[i].toLowerCase();
    if (f[0] !== '-' && f[0] !== '/') break;
    const name = f.replace(/^[-/]+/, '');
    if (name && 'command'.startsWith(name)) { text = argv.slice(i + 1).join(' '); break; }
  }
  if (text === null) return false;
  const inner = simpleCommands(text);
  if (inner.truncated || inner.dynamic) return false;
  return inner.every((c) => c.argv.length === 0 || PS_READ_ONLY.has(baseOf(c.argv[0])));
}

function isReadOnly(cmd, ctx) {
  const argv = cmd.argv;
  if (!argv.length) return false;
  const name = baseOf(argv[0]);
  const args = argv.slice(1);
  if (CD_CMDS.has(name)) return true; // its effect (later relative paths) is tracked through the directory list
  if (READ_ONLY.has(name)) return !(name === 'rg' && args.some((a) => a === '--pre' || a.startsWith('--pre=')));
  if (name === 'find') return !args.some((a) => FIND_UNSAFE.test(a));
  if (name === 'git') return gitReadOnly(args);
  if (name === 'jq') return !args.some((a) => /^-[A-Za-z]*i/.test(a) || a === '--in-place');
  if (name === 'sed' || name === 'gsed') return sedReadOnly(args);
  if (name === 'awk' || name === 'gawk' || name === 'mawk' || name === 'nawk') return awkReadOnly(args);
  if (name === 'sort') return !args.some((a) => /^-[A-Za-z]*o/.test(a) || a.startsWith('--output') || a.startsWith('--compress-program'));
  if (name === 'tree') return !args.some((a) => /^-[A-Za-z]*o/.test(a) || a.startsWith('--output'));
  if (name === 'xxd') return !args.includes('-r') && positional(args).length <= 1;
  if (name === 'openssl') return args[0] === 'dgst' && !args.some((a) => a === '-out' || a === '-sign' || a === '-prverify');
  if ((name === 'python' || name === 'python3') && args[0] === '-m' && args[1] === 'json.tool') return positional(args.slice(2)).length <= 1;
  if (isPipelineTool(argv[0], ctx)) return true;
  if (name === 'node') return isPipelineTool(argv[1], ctx) || (cmd.raw.includes('\\') && pipelineToolInRaw(cmd.raw, ctx));
  if (name === 'pwsh' || name === 'powershell') return pwshReadOnly(argv);
  return PS_READ_ONLY.has(name);
}

// The words of cp / rsync / install that name what is written: -t DIR, else the last word (`install -d`: all of them).
// `sources` are the other words; copying SRC into a directory writes DIR/basename(SRC), which matters when that
// lands on a protected path (cp -a /tmp/backup/.claude ~/).
function destsOf(argv, name) {
  const args = argv.slice(1);
  const pos = [];
  let target = null;
  const dirMode = name === 'install' && args.some((a) => a === '-d' || a === '--directory');
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') { pos.push(...args.slice(i + 1)); break; }
    if (a === '-t' || a === '--target-directory') { target = args[++i]; continue; }
    if (a.startsWith('--target-directory=')) { target = a.slice('--target-directory='.length); continue; }
    if (/^-t.+/.test(a) && !a.startsWith('--')) { target = a.slice(2); continue; }
    if (a.length > 1 && a.startsWith('-')) continue;
    pos.push(a);
  }
  let dests;
  let sources;
  if (target) { dests = [target]; sources = pos; } else if (dirMode) { dests = pos; sources = []; } else if (pos.length >= 2) { dests = [pos[pos.length - 1]]; sources = pos.slice(0, -1); } else { dests = []; sources = []; }
  const written = [...dests];
  for (const d of dests) for (const src of sources) {
    const b = posix.basename(toPosix(src).replace(/\/+$/, ''));
    if (b && b !== '.' && b !== '..' && !/[*?[]/.test(b)) written.push(`${d.replace(/\/+$/, '')}/${b}`);
  }
  return written;
}

// $NAME values assigned on the line: `D=x cmd`, a bare `D=x`, `export D=x`, `declare -x D=x`.
function collectVars(cmds, ctx) {
  const vars = {};
  const SKIP = new Set(['HOME', 'USER', 'LOGNAME', 'USERPROFILE', 'USERNAME']); // these always mean the real ones
  const set = (k, v) => { if (!SKIP.has(k)) vars[k] = expandHomeRefs(substVars(toPosix(String(v)).replace(USER_RE, ctx.user), vars), ctx.homePosix); };
  for (const c of cmds) {
    for (const [k, v] of Object.entries(c.env ?? {})) set(k, v);
    if (['export', 'declare', 'typeset', 'local', 'readonly'].includes(baseOf(c.argv[0] ?? ''))) {
      for (const w of c.argv.slice(1)) {
        const m = /^([A-Za-z_]\w*)=([\s\S]*)$/.exec(w);
        if (m) set(m[1], m[2]);
      }
    }
  }
  return vars;
}

// Directories the command line may be operating in: the hook's cwd plus every `cd` target (chained ones too).
function collectDirs(cmds, ctx) {
  const dirs = [ctx.cwd];
  for (const c of cmds) {
    if (!CD_CMDS.has(baseOf(c.argv[0] ?? ''))) continue;
    let t = c.argv.slice(1).find((a) => !a.startsWith('-') && a !== '/d');
    if (c.raw.includes('\\')) {
      const m = /^\s*(?:cd|pushd|set-location|sl)\s+(?:\/d\s+)?["']?([^"';&|\n]+)/i.exec(c.raw);
      if (m) t = m[1].trim();
    }
    if (!t) continue;
    const e = expandRefs(t, ctx);
    for (const d of [...dirs]) {
      const nd = isAbs(e) ? posix.normalize(e) : posix.join(d, e);
      if (!dirs.includes(nd) && dirs.length < 32) dirs.push(nd);
    }
  }
  return dirs;
}

// ---- Bash: rule 3 and 4 helpers ------------------------------------------------------------------

const INSTALLER_NAME = /^install\.(?:mjs|sh|ps1)$/i;
const PIPELINE_BIN_NAMES = new Set(['pipeline.mjs', 'pipeline']);

function rawInstallerHits(text) {
  const t = toPosix(text);
  const re = /(?:^|[\s'"=])((?:[^\s'"=;&|()]*\/)?install\.(?:mjs|sh|ps1))(?=$|[\s'";&|)])/gi;
  const out = [];
  for (const m of t.matchAll(re)) {
    const tail = t.slice(m.index + m[0].length).split(/[;&|\n]/)[0];
    out.push({ p: m[1], after: tail.trim().split(/\s+/).filter(Boolean) });
  }
  return out;
}

// Programs that execute the script they are given. `git add install.sh` or `cat install.mjs` only name the file
// and stay allowed, so the checkout can still be developed with the guard installed.
const RUNNERS = new Set(['node', 'nodejs', 'deno', 'bun', 'tsx', 'ts-node', 'npx', 'sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'csh', 'tcsh', 'pwsh', 'powershell', 'cmd', 'source', '.', 'python', 'python3', 'py', 'ruby', 'perl', 'php']);

function findInstaller(cmds, raw, dirs, ctx) {
  const hits = [];
  for (const c of cmds) {
    const idx = c.argv.findIndex((a) => INSTALLER_NAME.test(posix.basename(toPosix(a))));
    if (idx >= 0) {
      if (idx === 0 || RUNNERS.has(baseOf(c.argv[0]))) hits.push({ p: c.argv[idx], after: c.argv.slice(idx + 1) });
    } else if (c.raw.includes('\\')) {
      const first = toPosix(c.raw.trim().split(/\s+/)[0] ?? '');
      for (const h of rawInstallerHits(c.raw)) if (h.p === first || RUNNERS.has(baseOf(first))) hits.push(h);
    }
  }
  if (cmds.truncated) hits.push(...rawInstallerHits(raw));
  for (const h of hits) {
    const e = expandRefs(h.p, ctx);
    const where = new Set(dirs);
    for (const d of dirs) where.add(posix.dirname(isAbs(e) ? e : posix.join(d, e)));
    const inCheckout = [...where].some((d) => {
      try { return ctx.api.existsSync(posix.join(d, 'pipeline/hooks/guard-files.mjs')); } catch { return false; }
    });
    if (!inCheckout) continue;
    if (h.after.length === 1 && h.after[0] === '--check') continue;
    return `${h.p} installs the pipeline into ~/.claude; only the owner may run it, from a terminal or with PIPELINE_ADMIN=1 (node install.mjs --check is allowed)`;
  }
  return null;
}

const PROTECT_APPLY_RAW = /\bpipeline(?:\.mjs)?["']?\s[^;&|\n]*\bprotect\b[^;&|\n]*--apply\b/i;

function findProtectApply(cmds, raw) {
  for (const c of cmds) {
    const i = c.argv.findIndex((a) => PIPELINE_BIN_NAMES.has(baseOf(a)));
    if (i >= 0) {
      const rest = c.argv.slice(i + 1);
      if (rest.includes('protect') && rest.some((a) => a === '--apply' || a.startsWith('--apply='))) return true;
    } else if (c.raw.includes('\\') && PROTECT_APPLY_RAW.test(toPosix(c.raw))) return true;
  }
  return !!cmds.truncated && PROTECT_APPLY_RAW.test(toPosix(raw));
}

// `pipeline.mjs job start NAME -- <cmd...>` runs <cmd...> for the agent, so judge it as if it were typed directly.
function jobInner(cmd) {
  const a = cmd.argv;
  const i = a.findIndex((w) => PIPELINE_BIN_NAMES.has(baseOf(w)));
  if (i < 0 || a[i + 1] !== 'job' || a[i + 2] !== 'start') return null;
  const d = a.indexOf('--', i + 3);
  const inner = d < 0 ? a.slice(i + 4) : a.slice(d + 1);
  return inner.length ? inner.map(shellQuote).join(' ') : null;
}

// ---- Bash --------------------------------------------------------------------------------------------

export function evaluateBashForFiles(command, opts = {}) {
  const ctx = makeCtx(opts);
  if (ctx.admin) return allow();
  const raw = typeof command === 'string' ? command : '';
  if (!raw.trim()) return allow();

  // 1 and 2: the admin switch and the hook switch, however the words are quoted or escaped
  const flat = raw.replace(/['"`]\s*\+\s*['"`]/g, '').replace(/['"`\\]/g, ''); // 'PIPELINE_'+'ADMIN' reads as one word
  if (variantsOf(raw).some((t) => setsAdmin(t, ctx.platform) || setsAdmin(t.replace(/['"`]\s*\+\s*['"`]/g, '').replace(/['"`\\]/g, ''), ctx.platform))) return deny('the command sets PIPELINE_ADMIN; only the owner may set it, when launching Claude Code (naming it, e.g. in grep or prose, is fine)');
  if (hasDisableAll(raw) || hasDisableAll(flat)) return deny('the command mentions disableAllHooks, which would switch the pipeline hooks off');

  const cmds = simpleCommands(raw);
  for (const c of cmds) {
    const words = [c.argv.join(' '), ...Object.entries(c.env).map(([k, v]) => `${k}=${v}`)].join(' ');
    if (setsAdmin(words, ctx.platform)) return deny('the command sets PIPELINE_ADMIN; only the owner may set it, when launching Claude Code');
    if (hasDisableAll(words)) return deny('the command mentions disableAllHooks, which would switch the pipeline hooks off');
  }
  ctx.vars = collectVars(cmds, ctx);
  // a name held in a variable (N=PIPELINE_ADMIN; env $N=1 claude)
  if (Object.keys(ctx.vars).length && setsAdmin(substVars(flat, ctx.vars), ctx.platform)) return deny('the command sets PIPELINE_ADMIN through a variable; only the owner may set it, when launching Claude Code');
  const dirs = collectDirs(cmds, ctx);

  // 3 and 4: installers and `protect --apply`
  const installer = findInstaller(cmds, raw, dirs, ctx);
  if (installer) return deny(installer);
  if (findProtectApply(cmds, raw)) return deny('pipeline protect --apply changes branch protection and the global hooks; only the owner may run it, from a terminal or with PIPELINE_ADMIN=1');

  // 6: the job runner executes its inner command on the agent's behalf
  if ((opts._depth ?? 0) < 4) {
    for (const c of cmds) {
      const inner = jobInner(c);
      if (!inner) continue;
      const r = evaluateBashForFiles(inner, { ...opts, _depth: (opts._depth ?? 0) + 1 });
      if (r.decision === 'deny') return deny(`job start would run: ${r.reason}`);
    }
  }

  // 5: protected-path references must be read-only
  const m = makeMatchers(ctx);
  const totalWords = cmds.reduce((n, c) => n + c.argv.length, 0);
  const tooMany = totalWords > 5000; // per-token scans are skipped; the raw-text scans still run
  if (tooMany) ctx.dynamic = true;
  const insideRoot = dirs.some((d) => ctx.hit(d) || ctx.hitAncestor(d)); // cwd or a `cd` target is a protected dir (or its parent): relative words and bare commands reach it
  const protectedInRaw = m.rawHit(raw, dirs);

  // Output redirections write wherever they point, whatever the command: resolve every target (against the cwd and
  // every cd target, with ~ and variables expanded) and deny on a protected one. A symlink already pointing into
  // a protected root counts too.
  for (const c of cmds) {
    for (const r of c.redirects ?? []) {
      if (!WRITE_OPS.has(r.op) || typeof r.target !== 'string' || !r.target || r.target.startsWith('&') || r.target === '/dev/null') continue;
      const target = r.target;
      const e = expandRefs(target, ctx);
      const abs = isAbs(e) ? [posix.normalize(e)] : dirs.map((d) => posix.join(d, e));
      const viaLink = abs.some((p) => !/[*?[]/.test(p) && ctx.hit(realResolve(p, ctx.api)));
      if (m.rawHit(target, dirs) || m.pathHit(target, dirs, true) || viaLink) return deny(`the command redirects output to ${target}, which is a protected pipeline file or the directory that holds it (${PROTECTED_MSG})`);
    }
  }

  // A scan that was cut short (parse caps, dynamic commands, sizes) cannot prove a command harmless: fail closed
  // when the raw text names a protected file at all.
  if ((cmds.truncated || cmds.dynamic || ctx.dynamic) && protectedInRaw) return deny('the command line is too complex or too dynamic to check and refers to a protected pipeline file');

  const winAncestor = (c) => c.raw.includes('\\') && m.ancestorRaw(c.raw);
  const tokenHit = (t) => m.rawHit(t, dirs) || m.pathHit(t, dirs, true);
  // does the command name a protected file anywhere (source or destination)?
  const names = (c) => insideRoot
    || m.rawHit(c.raw, dirs) || winAncestor(c)
    || Object.values(c.env).some((v) => m.rawHit(v, dirs))
    || (!tooMany && c.argv.some(tokenHit));
  // does it WRITE one? cp / rsync / install only write their destination
  const mentions = (c) => {
    const name = baseOf(c.argv[0] ?? '');
    if (insideRoot) return true;
    if (DEST_ONLY.has(name)) return destsOf(c.argv, name).some(tokenHit);
    return names(c) || (MOVERS.has(name) && destsOf(c.argv, name).some(tokenHit));
  };
  const mentioning = cmds.filter(mentions);
  // A reference no single command names lives in a heredoc body or in program text the shell parser cut into
  // pieces (a Python or JS one-liner): then every command on the line must be read-only.
  const unaccounted = protectedInRaw && !cmds.some(names);
  if (!mentioning.length && !unaccounted) return allow();

  // A read-only command can still feed a writer further down the pipe (find ... | xargs rm, ls ... | sh).
  if (cmds.some((c) => FAN_OUT_RE.test(c.raw) || (SHELL_NAMES.has(baseOf(c.argv[0] ?? '')) && !isReadOnly(c, ctx)))) return deny('the command refers to a protected pipeline file and hands work to xargs or a shell, which could modify it');

  const pool = unaccounted ? cmds.filter((c) => c.argv.length) : mentioning;
  const bad = pool.find((c) => !isReadOnly(c, ctx));
  if (bad) {
    const name = bad.argv.length ? baseOf(bad.argv[0]) : '(assignment)';
    return deny(`${name} refers to a protected pipeline file (or the directory that holds it) and is not a read-only command (${PROTECTED_MSG})`);
  }
  return allow();
}
