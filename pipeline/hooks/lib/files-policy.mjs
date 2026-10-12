// Why: the owner's rule is that agents must not edit their own rules. This is the pure decision logic of the
// global guard-files hook: it denies file tools, MCP tools and Bash commands that would change the installed
// pipeline files (skills, agents, ~/.claude/pipeline, ~/.claude/settings.json), delete or overwrite the dirs
// that hold them (~/.claude, ~/.claude/skills, ~/.claude/agents), switch hooks off (`disableAllHooks`) or set
// the admin switch (`PIPELINE_ADMIN`). Only a Claude Code process launched with PIPELINE_ADMIN=1 bypasses it.
// Bash is judged on text, so the checks lean towards denying (`rm ~/.claude/pipeline`, `cp x ~/.claude/pipeline`); echo/printf are
// read-only (their redirects are still judged) and the value of a message flag (git -m, gh --body, a test runner's -t) is prose; the hook
// stops accidents and casual circumvention, not an adversary who builds the path out of pieces at run time.
//
// RESIDUALS (known, documented, not closed): names that only exist at run time defeat a text scan.
//  - `export $(echo PIPELINE_ADMIN)=1`, a name assembled by a command substitution (a plain `N=PIPELINE_ADMIN; export $N=1` IS caught).
//  - printf-assembled keys such as `printf '{"disable%sHooks":true}' All > .claude/settings.local.json` (and settings.local.json
//    is not a protected file in any case).
//  - an installer whose name is built at run time (`$(echo install).sh`, a glob such as `ins*.mjs`); quote-split spellings (`ins""tall.mjs`) ARE caught.
// Backstop for installer runs: the installer itself refuses to run inside a Claude Code process (CLAUDECODE set, or a Claude Code
// ancestor process); commands that unset or override CLAUDECODE are denied here.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { toPosix, expandHome, isInside, samePath } from '../../lib/paths.mjs';
import { simpleCommands, commandName, scriptFileOf, scriptFeedsOf, startupFilesOf, startupVarsOf, pathValuesOf, isEqualsWord, shebangShell, declAttrs, applyTransform, sqlShellEscapes } from './shell-parse.mjs';
import { flattenProgram, newWriteFrame, exportRecords, writtenTo, writtenNamesIn, writeSignature, unmodelledBefore, sedArgsUnsafe, sedWriteTargets, sedInPlaceArg, awkArgsPure, sortArgsPure, flowStart, inFlow } from './line-writes.mjs';
import { scriptCandidates, execLineOf, defaultReadDir, defaultReadHead, isShellHead, newEvalBudget, checkDeadline, countScript, substitute, GuardLimit } from './script-candidates.mjs';

const posix = path.posix;
const MAX_SCRIPT_BYTES = 1_000_000;
const MAX_LINE_CHARS = 200_000; // a longer command line is not parsed (the hook has a 15 s budget)
// What an unparsed or truncated line is judged by: any word that names a protected file, a switch or an installer.
const SENSITIVE_WORDS = /\.claude|PIPELINE_ADMIN|disableAllHooks|CLAUDECODE|install\.|\bprotect\b/i;

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

// Why: a name assigned from a changed name is changed too (`X=$D; echo x > $X/s`, `E=$D bash w.sh`): the assignments of the line (a bare `NAME=value`, a declaration's
// `NAME=value`) and `extra` (the prefix values of the command a child frame is started by) taint the name they set, until nothing new is added.
// Fail closed once a source could not be followed (`active`): a nameref (`declare -n R=D`) and the targets of `read` / `printf -v` / `mapfile` / `readarray` are changed whatever their
// input. (An `eval` text that mentions a changed name is refused where it stands, as a writer.)
function taintClosure(base, cmds, extra = {}, isNew = () => false, active = false) {
  const set = new Set(base);
  const refs = (v) => [...String(v).matchAll(/\$\{?(\w+)/g)].some((x) => set.has(x[1]) || isNew(x[1]));
  const sets = [];
  const always = (n) => { if (/^[A-Za-z_]\w*$/.test(n)) set.add(n); };
  for (const c of cmds) {
    const cn = commandName(c.argv[0] ?? '');
    if (!c.argv.length) sets.push(...Object.entries(c.env ?? {}));
    else if (['export', 'declare', 'typeset', 'local', 'readonly'].includes(cn)) {
      const nameref = c.argv.slice(1).some((a) => /^-[A-Za-z]*n/.test(a));
      for (const a of c.argv.slice(1)) {
        const m = /^([A-Za-z_]\w*)=([\s\S]*)$/.exec(a);
        if (m) sets.push([m[1], m[2]]);
        if (active && nameref && !a.startsWith('-')) always(a.split('=')[0]);
      }
    } else if (active && cn === 'read') for (const a of c.argv.slice(1)) always(a);
    else if (active && (cn === 'mapfile' || cn === 'readarray')) { always('MAPFILE'); for (const a of c.argv.slice(1)) always(a); }
    else if (active && cn === 'printf') { const i = c.argv.indexOf('-v'); if (i > 0) always(c.argv[i + 1] ?? ''); }
  }
  sets.push(...Object.entries(extra));
  for (let grew = true; grew;) { grew = false; for (const [k, v] of sets) if (!set.has(k) && refs(v)) { set.add(k); grew = true; } }
  return set;
}

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
    // (existsSync answers false for anything it cannot stat; one that throws is a broken lookup and is not read as "missing")
    if (api.existsSync(cur)) {
      // realpath fails only where the OS refuses the access too (a symlink loop, EACCES, a too-long name): the lexical path is judged
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

// macOS spells every path on the boot volume a second way: /System/Volumes/Data/Users/u == /Users/u (a firmlink, not a
// symlink, so realpath keeps the prefix).
const FIRMLINK = /\/System\/Volumes\/Data(?=\/|$)/gi;

function realStatId(p) {
  try {
    const st = fs.statSync(p);
    return st.ino ? `${st.dev}:${st.ino}` : null; // an fs that reports no inode (ino 0) cannot be compared
  } catch {
    return null;
  }
}

function defaultReadText(file) {
  try {
    const st = fs.statSync(file);
    return st.isFile() && st.size <= MAX_SCRIPT_BYTES ? fs.readFileSync(file, 'utf8') : null;
  } catch {
    return null;
  }
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
    // dev:ino of a path (null when missing); a caller that fakes the filesystem gets no inode comparison
    statId: opts.statId ?? (opts.existsSync || platform === 'win32' ? () => null : realStatId),
  };
  const darwin = platform === 'darwin';
  const unFirm = (p) => (darwin ? p.replace(FIRMLINK, '') : p);
  const base = homePosix === '/' ? '' : homePosix;
  const lexRoots = protectedRoots(homePosix);
  const lexAncestors = ANCESTOR_REL.map((r) => `${base}/${r}`);
  const roots = unique([...withWindowsAliases(lexRoots, homePosix, platform), ...lexRoots.map((r) => realResolve(r, api))]);
  const ancestors = unique([...withWindowsAliases(lexAncestors, homePosix, platform), ...lexAncestors.map((r) => realResolve(r, api))]);
  const ci = caseInsensitive(platform);
  let rootIds = null;
  return {
    platform, homeNative, homePosix, cwd, api, roots, lexRoots, ancestors, lexAncestors, ci,
    user: opts.user ?? posix.basename(homePosix),
    vars: {}, // same-line shell assignments (D=$HOME/.claude), filled in once the line is parsed
    dynamic: false, // set when a scan had to be skipped for size; callers fail closed
    readText: opts.readText ?? defaultReadText,
    readHead: opts.readHead ?? defaultReadHead, // the first bytes of a file readText refused (over the cap)
    ignoreUnmodelled: opts._ignoreUnmodelled === true, // inside a real-home startup file's judgment: see judgeStartupFile
    frames: opts._frames ?? [], // the files each command list being evaluated writes (see line-writes.mjs), outermost first
    budget: opts._budget ?? newEvalBudget(opts.now), // script reads, deadline and expansion allowance of this evaluation (shared with nested calls)
    readDir: opts.readDir ?? defaultReadDir,
    admin: (opts.env ?? process.env).PIPELINE_ADMIN === '1',
    env: opts.env ?? process.env,
    hit: (p) => { const q = unFirm(p); return roots.some((r) => isInside(q, r, platform)); },
    hitAncestor: (p) => { const q = unFirm(p); return ancestors.some((a) => samePath(q, a, platform)); },
    unFirm,
    // Is `p`, or the nearest existing directory above it, the very same file or directory (same device and inode) as a
    // protected root? Catches hard links and any other spelling of the path that realpath does not unify.
    hitInode: (p) => {
      if (rootIds === null) rootIds = new Set(roots.map((r) => api.statId(r)).filter(Boolean));
      if (rootIds.size === 0) return false;
      let cur = p;
      for (let i = 0; i < 64; i++) {
        const id = api.statId(cur);
        if (id !== null && rootIds.has(id)) return true;
        const parent = posix.dirname(cur);
        if (parent === cur) return false;
        cur = parent;
      }
      return false;
    },
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
  s = ctx.unFirm(posix.normalize(s));
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
    if (candidates.some((c) => ctx.hit(c) || ctx.hitAncestor(c) || ctx.hitInode(c))) return deny(`${t} is a protected pipeline file or the directory that holds it (${PROTECTED_MSG})`);
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

export const evaluateFileTool = failClosed(evaluateFileToolUnchecked);
function evaluateFileToolUnchecked(input, opts = {}) {
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
    if (candidates.some((c) => ctx.hit(c) || ctx.hitInode(c))) return deny(`${t} is a protected pipeline file (${PROTECTED_MSG})`);
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

// A private-use character the text does not contain, to mark a spot while rewriting it. A fixed one could be a character of a
// file name (`a<U+E000>b.sh`) and would rewrite that name into another. A text holding all 6,400 of them is not judged: no
// command needs that, and a longer mark could be formed across the joins of the rewrite (or grow without bound).
class UnverifiableText extends Error {}
function freeMark(text) {
  for (let c = 0xe000; c <= 0xf8ff; c++) {
    const m = String.fromCharCode(c);
    if (!text.includes(m)) return m;
  }
  throw new UnverifiableText('the command holds every private-use Unicode character, so it cannot be checked; remove them');
}
// Why: a hook that throws or times out is allowed by Claude Code, so the entry points answer deny for text they cannot
// normalise, for a limit hit (script budget, deadline, expansion: GuardLimit) and for ANY other exception (a readText that
// throws, a stack overflow), naming the cause.
// (a declaration: the entry points above are built from it when the module loads)
function failClosed(fn) {
  return (...args) => {
    try { return fn(...args); } catch (e) {
      if (e instanceof UnverifiableText || e instanceof GuardLimit) return deny(e.message);
      return deny(`internal error while checking this command (${e instanceof Error ? e.message : String(e)}), so it cannot be verified`);
    }
  };
}

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

function expandHomeRefs(text, home) {
  const mark = freeMark(text + home);
  return text
    .replace(HOME_RE, (_m, glue) => home + mark + (glue ? (glue.includes('+') ? '' : '/') : ''))
    .replace(TILDE_RE, (_m, pre) => `${pre}${home}${mark}`)
    .replace(new RegExp(`${mark}['"\`)}\\]]*`, 'g'), '');
}

// expandRefs reading every backslash as part of the file name (off Windows it is one), not as a path separator: the word's
// own backslashes and those a variable brings in (`D='x\a'; bash "$D.sh"` runs x\a.sh)
function expandKeepingBackslash(w, ctx) {
  const bs = freeMark([w, ctx.homePosix ?? '', ctx.user ?? '', ...Object.values(ctx.keptVars ?? {})].join('')); // every text expandRefs may put in
  const vars = Object.fromEntries(Object.entries(ctx.keptVars ?? {}).map(([k, v]) => [k, String(v).replace(/\\/g, bs)]));
  return expandRefs(w.replace(/\\/g, bs), { ...ctx, vars }).split(bs).join('\\');
}
// Could this word expand to a name holding a backslash? (its own, or one in any variable assigned on the line)
const mayHoldBackslash = (w, ctx) => w.includes('\\') || Object.values(ctx.keptVars ?? {}).some((v) => String(v).includes('\\'));

// $NAME / ${NAME} for variables assigned earlier on the same line (D=$HOME/.claude; echo x > $D/settings.json).
// Values are stored already expanded, and a value used in many words multiplies: the produced text is capped (substitute).
function substVars(text, vars, budget) {
  let t = text;
  for (let pass = 0; pass < 4 && t.includes('$'); pass++) {
    const next = substitute(budget, t, /\$\{(\w+)\}|\$(\w+)/g, (m, a, b) => (Object.hasOwn(vars, a ?? b) ? vars[a ?? b] : m));
    if (next === t) break;
    t = next;
  }
  return t;
}

// Slash-normalised copy of `text` with the user name, same-line variables and every home spelling replaced.
function expandRefs(text, ctx) {
  const t = toPosix(text).replace(USER_RE, ctx.user);
  return ctx.unFirm(expandHomeRefs(substVars(t, ctx.vars, ctx.budget), ctx.homePosix));
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

// One path segment of a glob as a regexp (`*` and `?` stay inside the segment).
function segmentRe(seg, ci) {
  const re = globToRe(seg.replace(/\*\*/g, '*'), ci);
  return re;
}

// Could glob `g` (an absolute, normalised path with wildcards) match `root` or something inside it? Segment by segment:
// the first root.length segments of the glob must match the root's, and anything may follow. `**` matches any depth.
function globReaches(g, root, ci) {
  const gs = g.split('/');
  const rs = root.split('/');
  for (let i = 0; i < rs.length; i++) {
    if (i >= gs.length) return false; // shorter than the root: it can only match a directory above it (checked separately)
    if (gs[i] === '**') return true;
    if (gs[i] === rs[i]) continue;
    if (!/[*?[]/.test(gs[i])) { if (ci ? gs[i].toLowerCase() !== rs[i].toLowerCase() : true) return false; continue; }
    const re = segmentRe(gs[i], ci);
    if (!re || !re.test(rs[i])) return false;
  }
  return true;
}

function globToRe(g, ci) {
  // anyBracket: every bracket expression stands for any one character
  const build = (anyBracket) => {
    let re = '';
    for (let i = 0; i < g.length; i++) {
      const c = g[i];
      if (c === '*') {
        if (g[i + 1] === '*') { re += '.*'; i++; } else re += '[^/]*';
      } else if (c === '?') re += '[^/]';
      else if (c === '[') {
        const j = g.indexOf(']', i + 2);
        if (j < 0) re += '\\[';
        else { re += anyBracket ? '[^/]' : `[${g.slice(i + 1, j).replace(/^!/, '^').replace(/\\/g, '\\\\')}]`; i = j; }
      } else re += escapeRe(c);
    }
    return new RegExp(`^${re}$`, ci ? 'i' : '');
  };
  // JS may refuse a bracket the shell accepts (`[\w-.]`, an out-of-order range): a bracket always matches exactly one character, so reading
  // every bracket as "any one character" is a superset of what the shell matches, and the word still has to line up with a protected path
  try { return build(false); } catch { /* retry below */ }
  try { return build(true); } catch { return null; }
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
    // a glob that can match a protected root or anything inside one (~/.claude/skills/*/SKILL.md, ~/.c*/pipeline/x) ...
    if (ctx.roots.some((r) => globReaches(g, r, ctx.ci))) return true;
    // ... or a directory that holds them (~/.cla*, ~/.claude/*)
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

const READ_ONLY = new Set(['echo', 'printf', 'cat', 'head', 'tail', 'less', 'more', 'ls', 'stat', 'wc', 'grep', 'rg', 'diff', 'cmp', 'shasum', 'sha256sum', 'sha1sum', 'md5', 'md5sum', 'file', 'readlink', 'realpath', 'test', '[', 'cut', 'du', 'hexdump', 'bat']);
const PS_READ_ONLY = new Set(['get-content', 'get-childitem', 'gc', 'gci']);
const GIT_READ_ONLY = new Set(['log', 'show', 'diff', 'status', 'ls-files', 'blame']);
const CD_CMDS = new Set(['cd', 'pushd', 'popd', 'set-location', 'sl']);
// Why: the directories an unknown `cd` may land in that matter: each protected directory (a file cannot be a cwd), each directory above one, and the home's parents.
function assumedCwds(ctx) {
  const dirs = [...ctx.lexRoots.filter((r) => !/\.\w+$/.test(posix.basename(r))), ...ctx.lexAncestors];
  for (let d = ctx.homePosix, n = 0; n < 16; n++) {
    dirs.push(d);
    const up = posix.dirname(d);
    if (up === d || up === '.') break;
    d = up;
  }
  return unique(dirs);
}
// (one rerun of a line per assumed directory, counted across the evaluation: past the allowance the line is refused rather than slow)
const MAX_CD_RERUNS = 200;
function countCdRun(budget) {
  checkDeadline(budget);
  budget.cdRuns = (budget.cdRuns ?? 0) + 1;
  if (budget.cdRuns > MAX_CD_RERUNS) throw new GuardLimit('too many commands run after a cd into a directory known only at run time (each is checked in every protected directory), so they cannot be verified. Write the directory out.');
}
// Does the command run interpreter code that is not a file (`node -e`, `python3 -c`, `perl -e`, a program on stdin, an awk program that is not read-only; every interpreter run that is not `interp FILE`)? It can build any file name at run time.
const INLINE_RUNNERS = /^(?:node|nodejs|deno|bun|tsx|ts-node|python\d*(?:\.\d+)*|ruby|perl|php|lua|Rscript|awk|gawk|mawk|nawk)$/;
const BENIGN_INTERP_OPTS = /^(?:--no-warnings|--trace-warnings|--enable-source-maps|--harmony|-B|-u|-O|-OO|-v|-w|-T|-t|-s)$/;
function runsInlineCode(c, ctx) {
  if (!c.argv.length || isReadOnly(c, ctx)) return false;
  return c.argv.some((w, i) => {
    if (!INLINE_RUNNERS.test(baseOf(w))) return false;
    const rest = c.argv.slice(i + 1);
    if (/^(?:awk|gawk|mawk|nawk)$/.test(baseOf(w))) return !rest.some((a) => /^(?:-f|--file)/.test(a));
    if (baseOf(w) === 'deno' && rest[0] === 'eval') return true;
    // (fail closed: any word that is a code option, attached or not (`-e'..'`, `-cprint(1)`, `--eval`), no file operand, or an option we do not know before the first operand
    // (it may take a value, so what follows is not known to be the file: `node -r x.js -e ..`, `perl -I lib -e ..`, `python3 -W ignore -c ..`))
    if (rest.some((a) => /^--(?:eval|print|exec)(?:=|$)/.test(a) || /^-[A-Za-z]*[ecEprR]/.test(a))) return true;
    const file = rest.findIndex((a) => !a.startsWith('-') || a === '-');
    return file < 0 || rest[file] === '-' || rest.slice(0, file).some((a) => !BENIGN_INTERP_OPTS.test(a));
  });
}
// Why: a cd whose target cannot be named from its words: `cd -` (OLDPWD), `popd`, a bare `pushd`, `pushd +1`, several operands (a brace list the parser split; zsh `cd old new`),
// `~-` / `~+` / `~name` (OLDPWD, PWD, another user's home).
function cdUnknownShape(argv) {
  const cn = baseOf(argv[0] ?? '');
  const args = argv.slice(1);
  if (cn === 'popd' || args.includes('-')) return true;
  const t = args.find((a) => !a.startsWith('-') && a !== '/d');
  if (cn === 'pushd' && (t === undefined || args.some((a) => /^[+-]\d+$/.test(a)))) return true;
  if (cn === 'cd' && args.filter((x) => !x.startsWith('-')).length > 1) return true;
  return t !== undefined && /^~(?:[-+]|[A-Za-z_])/.test(t);
}
const FIND_UNSAFE = /^-(?:delete|exec|execdir|ok|okdir|fprint0?|fprintf|fls)$/;
const SHELL_NAMES = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'csh', 'tcsh', 'pwsh', 'powershell', 'cmd']);
// For these only the destination (last word, or -t DIR) can change a protected file; reading one into /tmp is fine.
const DEST_ONLY = new Set(['cp', 'rsync', 'install']);
const MOVERS = new Set(['mv', 'ln', 'ditto']); // any named protected path counts, and so does DEST/basename(SRC)
const WRITE_OPS = new Set(['>', '>>', '>|', '>&', '&>', '&>>', '<>']);
const FD_DUP = /^&(?:\d+|-)$/; // (the only redirect targets that are descriptors)
// xargs is unwrapped by the parser, so its name only survives in the raw text.
const FAN_OUT_RE = /(?:^|[\s;&|(`])(?:xargs|parallel)(?=\s|$)/;

const shellQuote = (w) => (/^[\w@%+=:,./~-]+$/.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`);

// `-i`, `-i.bak`, `-pi`, `-ni`, `--in-place`
const inPlaceFlag = sedInPlaceArg;
const positional = (args) => args.filter((a) => !a.startsWith('-') && !/^\d+$/.test(a));

// A sed script with a `w FILE` / `W FILE` command or flag, or an `e` command or flag, writes or runs something.
// (a space after w / W / e is not needed: GNU sed takes `wfile`; the program may be attached to an option: -e'...', --expression=...; -f FILE is a script we do not read)
function sedReadOnly(args) {
  return !args.some((a) => a.startsWith('-') && inPlaceFlag(a)) && !sedArgsUnsafe(args);
}

function awkReadOnly(args, env) {
  return awkArgsPure(args, env); // (one reading of awk's options, shared with line-writes)
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
  if (name === 'awk' || name === 'gawk' || name === 'mawk' || name === 'nawk') return awkReadOnly(args, cmd.env);
  if (name === 'sort') return sortArgsPure(args); // (one reading of sort's options, --out= included)
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
// Also fills ctx.keptVars: the same values with every backslash kept as a file name character (toPosix reads it as a
// separator), for the off-Windows reading of a script name (`D='x\a'; bash "$D.sh"` runs x\a.sh).
function collectVars(cmds, ctx) {
  const vars = {};
  const kept = {};
  const SKIP = new Set(['HOME', 'USER', 'LOGNAME', 'USERPROFILE', 'USERNAME']); // these always mean the real ones
  const bs = freeMark([ctx.homePosix ?? '', ctx.user ?? '', ...cmds.flatMap((c) => [...Object.values(c.env ?? {}), ...(c.argv ?? [])])].join(''));
  // Why: `declare -l D` / `-u` change the case of what D is given (also of the value it already holds); width and integer attributes (-L -R -Z -i -n) change it in
  // ways not worked out: such a name keeps the text as written, but is listed in ctx.unknownVars (a script or a writer it picks is refused)
  const attrs = new Map();
  const unknown = new Set();
  const set = (k, v) => {
    if (SKIP.has(k)) return;
    const t = attrs.get(k) ?? null;
    vars[k] = applyTransform(expandHomeRefs(substVars(toPosix(String(v)).replace(USER_RE, ctx.user), vars, ctx.budget), ctx.homePosix), t);
    kept[k] = applyTransform(expandHomeRefs(substVars(toPosix(String(v).replace(/\\/g, bs)).replace(USER_RE, ctx.user), kept, ctx.budget), ctx.homePosix).split(bs).join('\\'), t);
  };
  for (const c of cmds) {
    for (const [k, v] of Object.entries(c.env ?? {})) set(k, v);
    if (['export', 'declare', 'typeset', 'local', 'readonly'].includes(baseOf(c.argv[0] ?? ''))) {
      const d = declAttrs(c.argv);
      for (const k of d.bare) {
        if (d.transform) { attrs.set(k, d.transform); if (Object.hasOwn(vars, k)) { vars[k] = applyTransform(vars[k], d.transform); kept[k] = applyTransform(kept[k], d.transform); } }
        if (d.unknown) unknown.add(k);
      }
      for (const [k, v] of d.assigns) {
        if (d.transform) attrs.set(k, d.transform);
        if (d.unknown) unknown.add(k);
        set(k, v);
      }
    }
  }
  ctx.keptVars = kept;
  ctx.unknownVars = unknown;
  ctx.declared = { transform: attrs, unknown: new Set(unknown) }; // (attributes stay with the name: a later plain assignment does not clear them)
  return vars;
}

// Directories the command line may be operating in: the hook's cwd plus every `cd` target (chained ones too).
function collectDirs(cmds, ctx) {
  const dirs = [ctx.cwd];
  const addDir = (e) => {
    for (const d of [...dirs]) {
      const nd = isAbs(e) ? posix.normalize(e) : posix.join(d, e);
      if (!dirs.includes(nd) && dirs.length < 32) dirs.push(nd);
    }
  };
  for (const c of cmds) {
    // commands that run relative to another directory: git -C DIR, tar -C DIR, unzip -d DIR, make -C DIR, cp -t DIR
    for (const b of baseDirsOf(c.argv)) addDir(expandRefs(b, ctx));
    const cdName = baseOf(c.argv[0] ?? '');
    if (!CD_CMDS.has(cdName)) continue;
    let t = c.argv.slice(1).find((a) => !a.startsWith('-') && a !== '/d');
    if (!t && (cdName === 'cd' || cdName === 'pushd')) t = '~'; // a bare `cd` goes home
    if (c.raw.includes('\\')) {
      const m = /^\s*(?:cd|pushd|set-location|sl)\s+(?:\/d\s+)?["']?([^"';&|\n]+)/i.exec(c.raw);
      if (m) t = m[1].trim();
    }
    if (!t) continue;
    addDir(expandRefs(t, ctx));
  }
  return dirs;
}

// The directory words of commands whose other arguments are read relative to them.
function baseDirsOf(argv) {
  const name = baseOf(argv[0] ?? '');
  const args = argv.slice(1);
  const out = [];
  const flagValue = (short, long) => {
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '--') break;
      if (a === `-${short}` || a === `--${long}`) { if (args[i + 1] !== undefined) out.push(args[i + 1]); i++; }
      else if (a.startsWith(`--${long}=`)) out.push(a.slice(long.length + 3));
      else if (!a.startsWith('--') && a.startsWith(`-${short}`) && a.length > 2) out.push(a.slice(a[2] === '=' ? 3 : 2));
    }
  };
  if (name === 'git') {
    for (let i = 0; i < args.length && args[i].startsWith('-'); i++) {
      if (args[i] === '-C' && args[i + 1] !== undefined) { out.push(args[i + 1]); i++; } else if (args[i] === '-c' || args[i] === '--git-dir' || args[i] === '--work-tree') i++;
    }
  } else if (name === 'tar' || name === 'bsdtar' || name === 'gtar') flagValue('C', 'directory');
  else if (name === 'unzip') flagValue('d', 'directory');
  else if (name === 'make' || name === 'gmake') flagValue('C', 'directory');
  else if (name === 'cp' || name === 'mv' || name === 'install' || name === 'ln') flagValue('t', 'target-directory');
  else if (name === 'rsync') { const pos = args.filter((a) => !a.startsWith('-')); if (pos.length >= 2) out.push(pos[pos.length - 1]); }
  return out;
}

// ---- prose flags -------------------------------------------------------------------------------------

// A commit message, PR body or test name that quotes a protected path is prose, not a reference. Only for the tools
// that take such flags: `-t` is a message-ish pattern for a test runner but a directory for cp / mv / install / tar.
const PROSE_FLAGS = {
  git: { short: 'm', long: ['message', 'grep'] },
  gh: { short: 'bt', long: ['body', 'title', 'notes', 'message', 'description'] },
};
const TEST_RUNNERS = new Set(['vitest', 'jest', 'mocha', 'pytest', 'ava', 'tap', 'playwright', 'cypress', 'npm', 'pnpm', 'yarn', 'bun', 'node', 'deno']);
const TEST_FLAGS = { short: 't', long: ['grep', 'testNamePattern', 'test-name-pattern', 'title'] };

// The words of `argv` that are the value of a prose flag: { values: [text], drop: Set(index of words to ignore) }.
function proseWords(argv) {
  const name = baseOf(argv[0] ?? '');
  const spec = PROSE_FLAGS[name] ?? (TEST_RUNNERS.has(name) ? TEST_FLAGS : null);
  const out = { values: [], drop: new Set() };
  if (!spec) return out;
  const isShort = (a) => a.length >= 2 && a[0] === '-' && a[1] !== '-' && spec.short.includes(a[1]);
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { if (spec === TEST_FLAGS) continue; break; } // after `--` a test runner still takes its own flags; for git it is paths
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const flag = a.slice(2, eq < 0 ? undefined : eq);
      if (!spec.long.includes(flag)) continue;
      if (eq >= 0) { out.values.push(a.slice(eq + 1)); out.drop.add(i); } else if (argv[i + 1] !== undefined) { out.values.push(argv[i + 1]); out.drop.add(i + 1); i++; }
    } else if (isShort(a)) {
      // -m TEXT, -mTEXT, and a cluster ending in the flag (-am TEXT)
      const k = [...a.slice(1)].findIndex((ch) => spec.short.includes(ch));
      const rest = a.slice(k + 2);
      if (rest) { out.values.push(rest.replace(/^=/, '')); out.drop.add(i); } else if (argv[i + 1] !== undefined) { out.values.push(argv[i + 1]); out.drop.add(i + 1); i++; }
    } else if (/^-[A-Za-z]+$/.test(a) && name === 'git') {
      // a cluster like -am: the message flag is its last letter
      if (a.endsWith('m') && argv[i + 1] !== undefined) { out.values.push(argv[i + 1]); out.drop.add(i + 1); i++; }
    }
  }
  return out;
}

const maskProse = (text, values) => values.reduce((t, v) => (v.length >= 2 ? t.split(v).join(' ') : t), String(text));

// ---- Bash: rule 3 and 4 helpers ------------------------------------------------------------------

const PIPELINE_BIN_NAMES = new Set(['pipeline.mjs', 'pipeline']);

// ---- installers: found by text ---------------------------------------------------------------------
// Any command whose text names install.mjs / install.sh / install.ps1 as a word is denied when the directory it runs in,
// or the path it names, is inside a claude-pipeline checkout (a dir holding pipeline/hooks/guard-files.mjs), unless every
// command naming it only reads it. This also catches `cat install.sh | bash` and `node -e "import('./install.mjs')"`.
const INSTALLER_WORD = /(?:^|[\s/\\'"(])install\.(?:mjs|sh|ps1)\b/;
const INSTALLER_PATH = /((?:[^\s'"=;&|()]*\/)?)install\.(?:mjs|sh|ps1)\b/g;
const INSTALLER_FILE = /^(?:\.\/)?(?:.*\/)?install\.(?:mjs|sh|ps1)$/;
const NAMING_SAFE = new Set(['cat', 'head', 'tail', 'less', 'more', 'bat', 'grep', 'rg', 'wc', 'file', 'stat', 'ls', 'diff', 'cmp', 'shellcheck', 'shasum', 'sha256sum', 'sha1sum', 'md5sum', 'md5', 'chmod']);
const GIT_NAMING_SAFE = new Set(['log', 'diff', 'show', 'status', 'add', 'blame', 'ls-files']);
const STDIN_RUNNERS = new Set(['node', 'nodejs', 'deno', 'bun', 'sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'csh', 'tcsh', 'pwsh', 'powershell', 'cmd', 'python', 'python3', 'ruby', 'perl', 'php', 'source', '.', 'eval']);

function checkoutRootOf(dir, ctx) {
  let d = dir;
  for (let i = 0; i < 64; i++) {
    if (ctx.api.existsSync(posix.join(d, 'pipeline/hooks/guard-files.mjs'))) return d;
    const p = posix.dirname(d);
    if (p === d) return null;
    d = p;
  }
  return null;
}

// `node install.mjs --check` (or `./install.sh --check`) exactly, or a command that only reads the file.
function installerNamingIsSafe(c) {
  // backslashes are lost from argv (C:\\x\\install.mjs), so a Windows-style command is read from its raw words
  const a = c.raw.includes('\\') ? c.raw.trim().split(/\s+/).map((w) => w.replace(/^["']|["']$/g, '')) : c.argv;
  if (!a.length) return true;
  const name = baseOf(a[0]);
  const isInst = (w) => typeof w === 'string' && INSTALLER_FILE.test(toPosix(w));
  if ((a.length === 2 && isInst(a[0]) && a[1] === '--check') || (a.length === 3 && (name === 'node' || name === 'nodejs') && isInst(a[1]) && a[2] === '--check')) return true;
  if (name === 'git') return gitReadOnly(a.slice(1)) || (() => { const x = a.slice(1).find((w) => !w.startsWith('-')); return GIT_NAMING_SAFE.has(x); })();
  return NAMING_SAFE.has(name);
}

function scriptsReferenceInstaller(name, scripts, depth, seen) {
  for (const n of [name, `pre${name}`, `post${name}`]) {
    const body = scripts?.[n];
    if (typeof body !== 'string' || seen.has(n)) continue;
    seen.add(n);
    if (INSTALLER_WORD.test(` ${toPosix(body)}`)) return true;
    if (depth < 4) for (const m of body.matchAll(/\b(?:npm|pnpm|yarn)\s+(?:run|run-script)\s+(?:-\S+\s+)*([\w:.-]+)/g)) if (scriptsReferenceInstaller(m[1], scripts, depth + 1, seen)) return true;
  }
  return false;
}

// `ins""tall.mjs`, `'install'.mjs`, `inst\all.sh`: the shell reads them all as install.mjs, so look at the unquoted spelling too.
const namesInstaller = (t) => INSTALLER_WORD.test(` ${t}`) || INSTALLER_WORD.test(` ${t.replace(/['"`\\]/g, '')}`);

function findInstaller(cmds, raw, dirs, ctx, opts) {
  const text = expandRefs(raw, ctx);
  const msg = (what) => `${what} installs the pipeline into ~/.claude; only the owner may run it, from a terminal or with PIPELINE_ADMIN=1 (node install.mjs --check and reading the file are allowed)`;

  // npm run <script> where the script body runs the installer
  const roots = dirs.map((d) => checkoutRootOf(d, ctx)).filter(Boolean);
  if (roots.length) {
    for (const c of cmds) {
      const n = baseOf(c.argv[0] ?? '');
      if (!['npm', 'pnpm', 'yarn'].includes(n)) continue;
      const k = c.argv.findIndex((w, i) => i > 0 && !w.startsWith('-'));
      if (k < 0 || !['run', 'run-script'].includes(c.argv[k])) continue;
      const script = c.argv.slice(k + 1).find((w) => !w.startsWith('-'));
      if (!script) continue;
      for (const r of unique(roots)) {
        let scripts;
        countScript(ctx.budget); // a file read like any other, so it is counted
        try {
          const read = opts.readFile ?? ((p) => fs.readFileSync(p, 'utf8'));
          scripts = JSON.parse(read(posix.join(r, 'package.json'))).scripts ?? {};
        } catch { return `${n} run ${script} runs in a claude-pipeline checkout whose package.json cannot be read, so it cannot be shown not to run the installer`; }
        if (scriptsReferenceInstaller(script, scripts, 0, new Set())) return msg(`${n} run ${script}, whose script runs the installer, which`);
      }
    }
  }

  if (!namesInstaller(text) && !namesInstaller(raw)) return null;
  // is the cwd (or a cd target) inside a checkout, or does a named installer path resolve into one?
  let inCheckout = roots.length > 0;
  if (!inCheckout) {
    for (const m of (` ${text.replace(/['"`\\]/g, '')}`).matchAll(INSTALLER_PATH)) {
      const p = m[1] ?? '';
      const bases = isAbs(p) ? [''] : dirs;
      for (const d of bases) if (checkoutRootOf(isAbs(p) ? posix.normalize(p || '/') : posix.join(d, p || '.'), ctx)) inCheckout = true;
    }
  }
  if (!inCheckout) return null;
  if (cmds.truncated || cmds.dynamic) return msg('a command line too complex to check that names the installer, which');
  const naming = cmds.filter((c) => namesInstaller(expandRefs(c.raw, ctx)) || namesInstaller(c.raw));
  const unsafe = naming.find((c) => !installerNamingIsSafe(c));
  if (unsafe) return msg(`${unsafe.argv.length ? baseOf(unsafe.argv[0]) : 'a command'} naming the installer`);
  if (!naming.length) return msg('a command naming the installer'); // inside a heredoc or program text the parser cut up
  // something that reads the script from a pipe: cat install.sh | bash
  const feeder = cmds.find((c) => c.argv.length && !naming.includes(c) && ((STDIN_RUNNERS.has(baseOf(c.argv[0])) && !c.argv.slice(1).some((w) => !w.startsWith('-'))) || FAN_OUT_RE.test(c.raw)));
  if (feeder) return msg(`piping the installer into ${baseOf(feeder.argv[0])}, which`);
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

// ---- script files ------------------------------------------------------------------------------------

const SHEBANG_PROGRAM = /^#!\s*(?:\S*\/)?(?:env\s+(?:-\S+\s+)*)?(\S+)/;
const INTERP_PROGRAM = /^(?:node|nodejs|deno|bun|tsx|ts-node|python[\d.]*|ruby|perl|php)$/;
// Program text that names a protected path next to something that writes, moves or deletes.
const WRITE_HINT = /write|append|unlink|\brm\b|rmSync|rmdir|rename|copy|\bcp\b|\bmv\b|\bln\b|mkdir|truncate|symlink|chmod|open\s*\(|>>?\s*['"\w$~/.]|\btee\b|shutil|os\.remove|move|dump|save|replace|\bsed\b|install/i;

// `bash f.sh`, `source f`, `./f`, `node f.mjs`, `python f.py`: the file is read (up to 1 MB) and judged like the same text
// typed on the line. A shell script that exists but cannot be read is denied; a missing file runs nothing; a
// program run by path, an interpreter file that cannot be read, a node_modules package and the pipeline's own
// installed files are not judged (the installed CLI legitimately names its own settings).
function judgeScriptFile(sf, dirs, ctx, opts, scanRaw = '', keepBackslash = false) {
  if (sf.kind === 'sqllines') return judgeSqlLines(sf, dirs, ctx, opts);
  if (sf.joined) return judgeJoinedScripts(sf, dirs, ctx, opts);
  if (sf.ambiguous) return judgeCandidateScripts(sf, dirs, ctx, opts, scanRaw);
  // expandRefs turns \ into / (Windows paths), but off Windows a backslash is part of the file name: judge that reading too
  if (!keepBackslash && mayHoldBackslash(sf.file, ctx)) {
    const v = judgeScriptFile(sf, dirs, ctx, opts, scanRaw, true);
    if (v) return v;
  }
  // a candidate is a final path (a glob match, or a word already expanded): the shell never expands it a second time
  const e = sf.candidate ? (keepBackslash ? sf.file : toPosix(sf.file)) : keepBackslash ? expandKeepingBackslash(sf.file, ctx) : expandRefs(sf.file, ctx);
  if (!sf.candidate && /[$`]/.test(e)) {
    // named at run time: the textual rules on the whole line still apply. Quoting is lost (`'x$y.sh'` reads as `x$y.sh`), so the word as written is judged too if it is a file
    return keepBackslash ? null : judgeScriptFile({ kind: sf.kind, family: sf.family, file: sf.file, candidate: true }, dirs, ctx, opts);
  }
  // every directory the command may run in (the cwd and each `cd` target) that holds the file: any of them may be the one that runs
  const seen = new Set();
  for (const d of isAbs(e) ? [''] : dirs) {
    const abs = isAbs(e) ? posix.normalize(e) : posix.join(d, e);
    if (seen.has(abs)) continue;
    seen.add(abs);
    // a script the line itself wrote (or may have written) before this command is judged on every content it may hold, as well as on the file as it is now
    if (!sf.noWrites) {
      const w = writtenTo(ctx.frames, abs, { exists: (x) => ctx.api.existsSync(x), readText: ctx.readText, ignoreUnmodelled: sf.startup === true || ctx.ignoreUnmodelled });
      if (w) {
        if (w.viaUnmodelled) ctx.budget.unmodelledSeen = (ctx.budget.unmodelledSeen ?? 0) + 1;
        const r = judgeWrittenScript(w, sf, abs, d || ctx.cwd, ctx, opts, scanRaw);
        if (r) return r;
      }
    }
    if (!ctx.api.existsSync(abs)) continue;
    const v = judgeFoundScript(sf, abs, d || ctx.cwd, ctx, opts);
    if (v) return v;
  }
  return null;
}

// Several files that feed ONE shell (`cat a b | bash`): the shell reads their texts one after the other, so they are judged joined, in the order
// the command names them, repeats included (a protected name split across them is one name). `scan`: the text a rewriting command prints from
// them (in an order we do not know): refused when the joined text refers to a protected file or switch, read in either order. Run in every
// directory the command may be in; a file that is missing there prints nothing, and the pipeline's own installed files are not judged (as above).
function judgeJoinedScripts(sf, dirs, ctx, opts) {
  const readings = [false];
  if (sf.joined.some((w) => mayHoldBackslash(w, ctx))) readings.push(true); // a backslash is a file name character off Windows: judge that reading too
  const seen = new Set();
  for (const keepBackslash of readings) {
    const names = sf.joined.map((w) => {
      const e = keepBackslash ? expandKeepingBackslash(w, ctx) : expandRefs(w, ctx);
      return /[$`]/.test(e) ? toPosix(w) : e; // named at run time: the word as written (the textual rules on the whole line still apply)
    });
    for (const d of dirs) {
      const abss = names.map((e) => (isAbs(e) ? posix.normalize(e) : posix.join(d, e)));
      const key = abss.join('\u0000');
      if (seen.has(key)) continue;
      seen.add(key);
      const texts = [];
      for (const abs of abss) {
        if (!ctx.api.existsSync(abs)) continue;
        if (ctx.hit(abs) || ctx.hit(realResolve(abs, ctx.api)) || /\/node_modules\//.test(abs)) continue;
        checkDeadline(ctx.budget);
        const text = ctx.readText(abs);
        if (typeof text !== 'string') {
          if (sf.kind === 'shell') return deny(`cannot read the script ${abs} (missing permission, a directory or larger than 1 MB), so what it runs cannot be verified`);
          const head = ctx.readHead(abs);
          if (typeof head === 'string') return deny(`${abs} is too large to verify (over 1 MB), so what it feeds a shell cannot be known`);
          continue;
        }
        countScript(ctx.budget);
        texts.push(text);
      }
      if (!texts.length) continue;
      if (sf.kind === 'scan') {
        const m = makeMatchers(ctx);
        for (const t of [texts.join(''), [...texts].reverse().join('')]) {
          if (variantsOf(t).some((v) => setsAdmin(v, ctx.platform) || hasDisableAll(v)) || SENSITIVE_WORDS.test(t) || m.rawHit(t, [d || ctx.cwd])) {
            return deny(`${sf.file} are read by a command that feeds a shell, and refer to a protected pipeline file or switch, so what the shell runs cannot be verified (${PROTECTED_MSG})`);
          }
        }
        continue;
      }
      // Why: the fed text of an interpreter (`cat a b | node`) is one program, judged as program text like a single `node f.mjs`
      if (sf.kind === 'interp') {
        const r = judgeScriptText(texts.join(''), sf, abss.join(' '), d || ctx.cwd, ctx, opts);
        if (r) return r;
        continue;
      }
      // (a database client reads the files as ONE stream: the escapes are read from the joined text)
      const joinedText = sf.kind === 'sql' ? sqlShellEscapes(texts.join(''), { family: sf.family, sources: abss }).join('\n') : texts.join('');
      if (!joinedText) continue;
      const r = evaluateBashForFiles(joinedText, { ...opts, cwd: d || ctx.cwd, _depth: (opts._depth ?? 0) + 1, _startup: ctx.startup });
      if (r.decision === 'deny') return deny(`the scripts ${sf.file} would run: ${r.reason}`);
    }
  }
  return null;
}

// Shell lines a database client's options or SQL text run (`-c '\! cmd'`, `-o '|cmd'`, a write): judged like a script of those lines.
function judgeSqlLines(sf, dirs, ctx, opts) {
  if (!sf.lines.length) return null;
  // (every directory the command may run in: a relative write target lands in any of them)
  for (const d of new Set(dirs.length ? dirs : [""])) {
    const r = evaluateBashForFiles(sf.lines.join("\n"), { ...opts, cwd: d || ctx.cwd, _depth: (opts._depth ?? 0) + 1, _startup: ctx.startup });
    if (r.decision === "deny") return deny(`the SQL client's input would run: ${r.reason}`);
  }
  return null;
}

// One existing script file (`abs`, found in directory `dir`).
function judgeFoundScript(sf, abs, dir, ctx, opts) {
  if (ctx.hit(abs) || ctx.hit(realResolve(abs, ctx.api)) || /\/node_modules\//.test(abs)) return null;
  checkDeadline(ctx.budget);
  const text = ctx.readText(abs);
  if (typeof text !== 'string') {
    if (sf.candidate && ctx.readDir(abs)) return null; // a shell cannot run a directory
    if (sf.kind === 'shell') return deny(`cannot read the script ${sf.file} (missing permission, a directory or larger than 1 MB), so what it runs cannot be verified`);
    // over the read cap: a program run by path is peeked at (a shell script is refused, a binary or an interpreter file is not
    // ours to judge); text a rewriting command computes from a file we cannot read cannot be scanned
    if (sf.kind === 'exec' || sf.kind === 'scan' || sf.kind === 'sql') {
      const head = ctx.readHead(abs);
      if (typeof head === 'string' && (sf.kind === 'scan' || sf.kind === 'sql' || isShellHead(head))) return deny(`${sf.file} is too large to verify (over 1 MB), so what it runs (or feeds a shell) cannot be known`);
    }
    return null;
  }
  return judgeScriptText(text, sf, abs, dir, ctx, opts);
}

// The text of a script file (as read, or as the line writes it), judged by what kind of file it is.
function judgeScriptText(text, sf, abs, dir, ctx, opts) {
  countScript(ctx.budget); // every script read and judged counts, named or candidate: the work multiplies with each level
  if (sf.kind === 'scan') {
    // text a command rewrites on its way to a shell (sed, awk, base64 ...) is computed at run time: a file that names a protected file or switch is refused
    if (variantsOf(text).some((t) => setsAdmin(t, ctx.platform) || hasDisableAll(t)) || SENSITIVE_WORDS.test(text) || makeMatchers(ctx).rawHit(text, [dir])) {
      return deny(`${sf.file} is read by a command that feeds a shell, and refers to a protected pipeline file or switch, so what the shell runs cannot be verified (${PROTECTED_MSG})`);
    }
    return null;
  }
  // Why: psql / mysql / sqlite3 run only the shell escapes in their input (\! , \g |cmd, .shell ...): those lines are judged like a script
  if (sf.kind === 'sql') {
    const esc = sqlShellEscapes(text, { family: sf.family, sources: [abs] }).join('\n');
    if (!esc) return null;
    const r = evaluateBashForFiles(esc, { ...opts, cwd: dir, _depth: (opts._depth ?? 0) + 1, _startup: ctx.startup });
    return r.decision === 'deny' ? deny(`the input ${sf.file} would run: ${r.reason}`) : null;
  }
  let kind = sf.kind;
  if (kind === 'exec') {
    if (text.slice(0, 4096).includes('\u0000')) return null; // a binary
    kind = INTERP_PROGRAM.test((SHEBANG_PROGRAM.exec(text)?.[1] ?? '').split('/').pop()) ? 'interp' : 'shell';
    // Why: the kernel starts the shebang's shell, which reads the startup files its options ask for (`#!/bin/bash -l`, `#!/bin/zsh`): judged like `bash -l f` / `zsh f`
    const sh = kind === 'shell' && ctx.execCmd ? shebangShell(text) : null;
    if (sh) {
      const { c, cmds, env, inherited } = ctx.execCmd;
      for (const st of startupFilesOf({ ...c, argv: [...sh, abs] }, cmds, { env, inherited })) {
        const v = ctx.judgeStartupFile(st);
        if (v) return v;
      }
    }
  }
  if (kind === 'shell') {
    const r = evaluateBashForFiles(text, { ...opts, cwd: dir, _depth: (opts._depth ?? 0) + 1, _startup: ctx.startup });
    return r.decision === 'deny' ? deny(`the script ${sf.file} would run: ${r.reason}`) : null;
  }
  // program text in another language: the admin switch, the hook switch, or a write next to a protected path
  if (variantsOf(text).some((t) => setsAdmin(t, ctx.platform) || hasDisableAll(t))) return deny(`the program ${sf.file} sets PIPELINE_ADMIN or mentions disableAllHooks; only the owner may switch the pipeline guard off`);
  const m = makeMatchers(ctx);
  if (text.length <= MAX_SCRIPT_BYTES && m.rawHit(text, [dir]) && WRITE_HINT.test(text)) return deny(`the program ${sf.file} refers to a protected pipeline file and writes (${PROTECTED_MSG})`);
  return null;
}

// Why: an earlier command on the line wrote (or may have written) the script about to be judged (cp f.sh n.sh; bash n.sh): judge each content it may
// hold. Static text and the files copied / catted into it are judged like the script; a file a rewriting command computes it from is scanned;
// content that only exists at run time (curl -o, a program's output, a missing script after a command we do not model) is judged like a
// script named at run time: refused when the line refers to a protected pipeline file or switch.
function judgeWrittenScript(w, sf, abs, dir, ctx, opts, scanRaw) {
  // a source or a text judged clean once here is not judged again for the next script it may reach (a write whose target is only known at run time reaches every
  // script on the line, and the scripts it was copied from are the same files each time)
  const done = (ctx.budget.writtenOk ??= new Set());
  const once = (key, judge) => {
    const k = `${sf.kind}\u0000${dir}\u0000${opts._depth ?? 0}\u0000${key}`;
    if (done.has(k)) return null;
    const r = judge();
    if (!r) done.add(k);
    return r;
  };
  for (const text of w.texts) {
    for (const v of new Set([text, substVars(text, ctx.vars, ctx.budget)])) {
      const r = once(`T${v}`, () => judgeScriptText(v, sf, abs, dir, ctx, opts));
      if (r) return r;
    }
  }
  for (const [list, kind] of [[w.files, sf.kind], [w.scans, 'scan']]) {
    for (const file of list) {
      const r = once(`F${kind}\u0000${file}`, () => judgeScriptFile({ kind, file, candidate: true, noWrites: true }, [dir], ctx, opts, scanRaw));
      if (r) return r;
    }
  }
  // the whole text several writes build together (appends, cat A B): no piece holds what the file runs
  for (const text of w.joined) {
    for (const v of new Set([text, substVars(text, ctx.vars, ctx.budget)])) {
      const r = once(`T${v}`, () => judgeScriptText(v, sf, abs, dir, ctx, opts));
      if (r) return r;
    }
  }
  if (w.pieces) return deny(`the script ${sf.file} is built from pieces at run time (several writes on the line put its text together, and one of them cannot be read), so what it runs cannot be checked; write the file out in one piece`);
  if (w.authored) return deny(`the script ${sf.file} is written by this line with text that cannot be worked out exactly (a printf / echo conversion or escape), so what it runs cannot be checked; write the file out in plain text`);
  // an inline program that writes the script: judged by its own text (string concatenation joined)
  for (const prog of w.programs) {
    const m = makeMatchers(ctx);
    for (const v of flattenProgram(prog)) {
      if (setsAdmin(v, ctx.platform) || hasDisableAll(v) || m.rawHit(v, [dir])) return deny(`the script ${sf.file} is written by an inline program that refers to a protected pipeline file or switch, so what it runs cannot be checked; write the file out literally`);
    }
  }
  // the prose-masked line: a protected path, or (strictly) the bare words once quotes and escapes are stripped
  if (w.unknown && (makeMatchers(ctx).rawHit(scanRaw, [dir]) || SENSITIVE_WORDS.test(scanRaw.replace(/['"`\\]/g, '')))) {
    return deny(`the script ${sf.file} may have been written by an earlier command on the line (its content is only known at run time) and the line refers to a protected pipeline file or switch, so what it runs cannot be checked; write the file out literally`);
  }
  return null;
}

// A word before the script expands at run time (`X=+n; bash $X w.sh`, `bash $(..) w.sh`, `source $X`, `bash *.sh`), so which
// word the shell runs is unknown. Judge every word that could be it (see script-candidates.mjs) like a named script. A
// word that is still unknown (`$UNSET`) cannot be judged: the textual rules still apply, and the line is denied when it
// names a protected pipeline file.
function judgeCandidateScripts(sf, dirs, ctx, opts, scanRaw) {
  const joinPath = (d, r) => (isAbs(r) ? posix.normalize(r) : posix.join(d, r));
  const line = execLineOf(sf, (w) => expandRefs(w, ctx));
  if (line !== null) {
    if ((opts._depth ?? 0) >= 4) return deny('the command line held in a variable is nested too deeply to check');
    // run in every directory the command may be in, with the line's variables
    for (const d of dirs) {
      const r = evaluateBashForFiles(line, { ...opts, cwd: d, _depth: (opts._depth ?? 0) + 1, _startup: ctx.startup, _vars: { ...ctx.vars }, _keptVars: { ...(ctx.keptVars ?? {}) } });
      if (r.decision === 'deny') return deny(`the command line ${sf.words[0]} expands to would run: ${r.reason}`);
    }
  }
  // a file the line writes before this command is among the names a glob matches (cp f.sh n.sh; bash n*.sh)
  const readDir = (d) => {
    const r = ctx.readDir(d);
    if (!Array.isArray(r)) return r;
    const extra = writtenNamesIn(ctx.frames, d);
    return extra.length ? [...r, ...extra] : r;
  };
  let c = scriptCandidates(sf, { expand: (w) => expandRefs(w, ctx), dirs, joinPath, readDir, ifs: ctx.vars.IFS });
  // a backslash in a word is a file name character off Windows, but expandRefs reads it as a separator: expand (and glob) that reading too
  if (!c.over && !sf.unresolvable && sf.words.some((w) => mayHoldBackslash(w, ctx))) {
    const k = scriptCandidates(sf, { expand: (w) => expandKeepingBackslash(w, ctx), dirs, joinPath, readDir, ifs: ctx.vars.IFS });
    c = { files: [...new Set([...c.files, ...k.files])], dynamic: c.dynamic || k.dynamic, over: k.over };
  }
  if (c.over) return deny('too many words, a glob matching too many files, or glob syntax that cannot be resolved could be the script this command runs, so it cannot be checked; name the script file');
  // a variable the line set to a run-time value (`NVM_DIR=$(cmd)`) picks the script: which one is unknown
  if (sf.words?.some((w) => [...w.matchAll(/\$\{?(\w+)/g)].some((m) => ctx.unknownVars.has(m[1]) || ctx.pickUnknown.has(m[1]) || (ctx.unknownAll && !Object.hasOwn(ctx.vars, m[1]))))) return deny('the script is picked by a variable whose value is known only at run time (set to a run-time value, with a width or integer attribute, or by a sourced file that cannot be followed), so it cannot be checked; name the script file');
  if (c.dynamic && makeMatchers(ctx).rawHit(scanRaw, dirs)) return deny('which word is the script this command runs is only known at run time ($VAR / $(...) / a glob) and the line refers to a protected pipeline file; name the file and write the options literally');
  for (const file of c.files) {
    const v = judgeScriptFile({ kind: sf.kind, family: sf.family, file, candidate: true }, dirs, ctx, opts);
    if (v) return v;
  }
  return null;
}

// ---- environment: CLAUDECODE and the test seams ---------------------------------------------------------

const ASSIGNERS = new Set(['export', 'declare', 'typeset', 'readonly', 'set', 'setx', 'setenv']);
const PS_ENV_CHANGERS = /^(?:remove-item|ri|rm|del|erase|set-item|si|clear-item|ci|new-item|ni|set-content|sc|remove-variable)$/;
const CLAUDECODE_UNSET = [
  /(?:^|[\s;&|(])env\s+(?:-\S+\s+)*?(?:-[A-Za-z]*u\s*|--unset[=\s]\s*)CLAUDECODE\b/i,
  /(?:^|[\s;&|(])env\s+(?:-\S+\s+)*?(?:-[A-Za-z]*i[A-Za-z]*|--ignore-environment|-)(?=\s|$)/,
  /\bunset\b[^;&|\n]*\bCLAUDECODE\b/i,
  /\bSetEnvironmentVariable\s*\(\s*CLAUDECODE\b/i,
  /\b(?:Remove-Item|ri|Remove-Variable)\b[^;&|\n]*\benv:\\?CLAUDECODE\b/i,
  /delete\s+process\.env\.CLAUDECODE\b|process\.env\.CLAUDECODE\s*=(?!=)|environ\.pop\(\s*CLAUDECODE\b|del\s+os\.environ\[\s*CLAUDECODE\s*\]|\bputenv\(\s*CLAUDECODE\b|ENV\.delete\(\s*CLAUDECODE\b/i,
];

// The installer's backstop is CLAUDECODE=1 (and a Claude Code ancestor process); a command that unsets or overrides it
// first would defeat the backstop, so it is refused outright.
function changesClaudeCode(cmds, scanRaw) {
  for (const c of cmds) {
    if (Object.keys(c.env ?? {}).some((k) => k.toUpperCase() === 'CLAUDECODE')) return true;
    const name = baseOf(c.argv[0] ?? '');
    if ((ASSIGNERS.has(name) || name === 'unset') && c.argv.slice(1).some((a) => /^CLAUDECODE(?:=|$)/i.test(a))) return true;
    if (PS_ENV_CHANGERS.test(name) && c.argv.some((a) => /^env:\\?CLAUDECODE$/i.test(a))) return true;
  }
  const flat = scanRaw.replace(/['"`\\]/g, '');
  return CLAUDECODE_UNSET.some((re) => re.test(flat));
}

// Test seams that swap the real gh / codex / vercel for a fake, or lift the model pins: handing one to the pipeline CLI
// would let a fake satisfy the merge gate. (The installed CLI also ignores them; this is the hook side.)
const SEAM_VARS = /^PIPELINE_(?:GH|CODEX|VERCEL|TEST_MODE|UPDATE_REMOTE)$/i;
const RUNTIMES = new Set(['node', 'nodejs', 'bun', 'deno', 'npx', 'tsx']);

function setsSeamForPipeline(cmds) {
  const seam = cmds.some((c) => Object.keys(c.env ?? {}).some((k) => SEAM_VARS.test(k))
    || (ASSIGNERS.has(baseOf(c.argv[0] ?? '')) && c.argv.slice(1).some((a) => SEAM_VARS.test(a.split('=')[0]))));
  if (!seam) return false;
  return cmds.some((c) => {
    const name = baseOf(c.argv[0] ?? '');
    return PIPELINE_BIN_NAMES.has(name) || (RUNTIMES.has(name) && c.argv.slice(1, 8).some((a) => PIPELINE_BIN_NAMES.has(baseOf(a))));
  });
}

// `ln -s ~ /tmp/h`: a second name for home (or a protected root, or a directory above one) lets later commands reach
// the protected files through a path that names none of them. Judged by what is LINKED TO, never by the link name.
function linkTargets(argv) {
  const pos = [];
  let dirMode = false;
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { pos.push(...argv.slice(i + 1)); break; }
    if (a === '-t' || a === '--target-directory') { dirMode = true; i++; continue; }
    if (a.startsWith('--target-directory=') || (/^-t./.test(a) && !a.startsWith('--'))) { dirMode = true; continue; }
    if (a.length > 1 && a.startsWith('-')) continue;
    pos.push(a);
  }
  return dirMode || pos.length < 2 ? pos : pos.slice(0, -1);
}

function linkReachesProtected(cmds, dirs, ctx) {
  for (const c of cmds) {
    if (baseOf(c.argv[0] ?? '') !== 'ln') continue;
    for (const t of linkTargets(c.argv)) {
      const e = expandRefs(t, ctx);
      if (/[*?[]/.test(e)) continue; // a glob target is judged by the glob rules
      for (const d of isAbs(e) ? [''] : dirs) {
        const full = posix.normalize(isAbs(e) ? e : posix.join(d, e));
        for (const p of unique([full, realResolve(full, ctx.api)])) {
          if (ctx.hit(p) || ctx.hitAncestor(p) || ctx.roots.some((r) => isInside(r, p, ctx.platform))) return t;
        }
      }
    }
  }
  return null;
}

// ---- files a shell reads in its own process (sourced files, BASH_ENV / ENV) ------------------------------------

const VAR_COMMANDS = new Set(['export', 'declare', 'typeset', 'local', 'readonly']);
// builtins that bind a name without a NAME=value word
const BINDERS = new Set(['read', 'mapfile', 'readarray', 'getopts', 'unset', 'let', 'printf', 'select', 'for', 'shift', 'wait', 'coproc']);
const RUNS_CODE = new Set(['eval', 'source', '.', 'exec', 'trap', 'alias', 'unalias', 'enable', 'builtin', 'command', 'setopt', 'unsetopt', 'shopt', 'emulate', 'zmodload', 'autoload']);
const HOME_NAMES = new Set(['HOME', 'USER', 'LOGNAME', 'USERPROFILE', 'USERNAME']);

// What the text of a file run in the current shell leaves behind: { vars: Map(name -> text | null), cds: [word], all }. A name is null (unknown) when it is set
// where it may not run, more than once, from a command's output, or by a builtin that binds it at run time; `all`: the file can set any name (eval, a nested
// source, a parse cut short, a command named at run time), so no name is known any more. Only the first-level assignments are followed, not functions called later.
function sourcedEffects(text, ctx) {
  const out = { vars: new Map(), cds: [], all: false, unknownCd: false };
  const cmds = simpleCommands(text, { expired: () => ctx.budget.now() > ctx.budget.deadline });
  if (cmds.truncated || cmds.dynamic) out.all = true;
  const from = flowStart(cmds);
  const seen = new Map();
  const local = Object.create(null);
  const set = (k, v, sure) => {
    if (HOME_NAMES.has(k)) return;
    const n = (seen.get(k) ?? 0) + 1;
    seen.set(k, n);
    const val = sure && n === 1 && typeof v === 'string' ? substVars(v, local, ctx.budget) : null;
    if (val === null || /[$`]/.test(val)) { out.vars.set(k, null); delete local[k]; } else { out.vars.set(k, val); local[k] = val; }
  };
  for (const [i, c] of cmds.entries()) {
    const sure = !(inFlow(from, i) || c.depth > 0 || c.sep === '&&' || c.sep === '||' || c.sep === '|' || cmds[i + 1]?.sep === '|' || cmds[i + 1]?.sep === '&');
    if (!c.argv.length) { for (const [k, v] of Object.entries(c.env ?? {})) set(k, v, sure); continue; }
    const name = baseOf(c.argv[0]);
    if (VAR_COMMANDS.has(name)) {
      const d = declAttrs(c.argv);
      for (const [k, v] of d.assigns) set(k, v, sure && !d.unknown && !d.transform && name !== 'local');
      for (const k of d.bare) if (d.unknown || d.transform) set(k, null, false);
    } else if (CD_CMDS.has(name)) {
      // (a target that stays a run-time value, a pattern or a brace list, `cd -`, popd, several operands: the directory is unknown from here on, not a literal; with CDPATH set -- the
      // line's, the hook's environment's, one this file set earlier or may have changed -- a relative name is searched along it)
      const t = c.argv.slice(1).find((a) => !a.startsWith('-') && a !== '/d');
      const v = t === undefined ? t : substVars(t, local, ctx.budget);
      const cdpath = (ctx.env?.CDPATH ?? '') !== '' || (ctx.vars.CDPATH ?? '') !== '' || out.vars.has('CDPATH') || ctx.pickUnknown.has('CDPATH') || ctx.srcChanged.has('CDPATH') || (c.env?.CDPATH ?? '') !== '';
      if (cdUnknownShape(c.argv) || (v !== undefined && /[`$*?[{]/.test(v)) || (cdpath && v !== undefined && !isAbs(toPosix(v)) && !/^(?:\.\.?(?:[\\/]|$)|~)/.test(v))) out.unknownCd = true;
      else out.cds.push(t ?? '~');
    }
    else if (BINDERS.has(name)) for (const a of c.argv.slice(1)) { const m = /^[A-Za-z_]\w*/.exec(a); if (m) set(m[0], null, false); }
    else if (RUNS_CODE.has(name) || /[$`]/.test(c.argv[0])) out.all = true;
  }
  return out;
}

// The texts of the files a sourced or startup record names (a candidate word is resolved like a script word). unknown: a file that cannot be read, is not
// one exact name, or is written by this line (so its text is only known at run time).
function sourcedTexts(rec, dirs, ctx) {
  const texts = [];
  let unknown = !!(rec.joined || rec.unresolvable);
  const consider = (abs) => {
    const t = ctx.readText(abs);
    if (typeof t === 'string') { texts.push(t); return; }
    if (ctx.api.existsSync(abs)) { if (!ctx.readDir(abs)) unknown = true; return; }
    if (writtenTo(ctx.frames, abs, { exists: (x) => ctx.api.existsSync(x), readText: ctx.readText, ignoreUnmodelled: false })) unknown = true;
  };
  if (unknown) return { texts, unknown };
  const joinPath = (d, r) => (isAbs(r) ? posix.normalize(r) : posix.join(d, r));
  if (rec.ambiguous) {
    const readDir = (d) => {
      const r = ctx.readDir(d);
      if (!Array.isArray(r)) return r;
      const extra = writtenNamesIn(ctx.frames, d);
      return extra.length ? [...r, ...extra] : r;
    };
    const c = scriptCandidates(rec, { expand: (w) => expandRefs(w, ctx), dirs, joinPath, readDir, ifs: ctx.vars.IFS });
    if (c.over || c.dynamic) unknown = true;
    for (const file of c.files) for (const abs of new Set(isAbs(toPosix(file)) ? [posix.normalize(toPosix(file))] : dirs.map((d) => posix.join(d, toPosix(file))))) consider(abs); // (candidates are words: relative ones are looked up in every directory)
    return { texts, unknown };
  }
  const e = rec.candidate ? toPosix(rec.file) : expandRefs(rec.file, ctx);
  if (/[$`]/.test(e)) return { texts, unknown: true };
  for (const abs of new Set(isAbs(e) ? [posix.normalize(e)] : dirs.map((d) => posix.join(d, e)))) consider(abs);
  return { texts, unknown };
}

// Why: a sourced file (and BASH_ENV / ENV, which the shell reads before the script it runs) assigns variables and cds in the shell that goes on: what it sets is
// what the rest of the line sees. Known values are recorded; one that cannot be worked out is unknown (a script it picks is refused), and a file that cannot
// be followed at all makes every name unknown from here on. Its cds join the directories the line may be in.
function absorbSourced(rec, dirs, ctx) {
  const { texts, unknown } = sourcedTexts(rec, dirs, ctx);
  // (a file that can set any name: every name the line has set so far may have been changed, and any other may be set; a script they pick is refused. The values
  // stay for the paths a writer builds, which is what they were before the file ran)
  const poison = () => { ctx.unknownAll = true; for (const k of Object.keys(ctx.vars)) { ctx.pickUnknown.add(k); ctx.srcChanged.add(k); } };
  if (unknown) poison();
  const merged = new Map();
  for (const t of texts) {
    const eff = sourcedEffects(t, ctx);
    if (eff.all) poison();
    if (eff.unknownCd) ctx.sourcedCdUnknown = true; // (a cd the file does into a directory only known at run time: the line's directory is unknown from here)
    for (const [k, v] of eff.vars) merged.set(k, merged.has(k) && merged.get(k) !== v ? null : v); // (the file may be one of several: a name they set differently is unknown)
    for (const t2 of eff.cds) {
      const e = expandRefs(t2, ctx);
      for (const d of [...dirs]) {
        const nd = isAbs(e) ? posix.normalize(e) : posix.join(d, e);
        if (dirs.includes(nd)) continue;
        if (dirs.length < 32) dirs.push(nd); else ctx.dynamic = true;
      }
    }
  }
  for (const [k, v] of merged) {
    ctx.srcTouched.add(k);
    if (v === null) { delete ctx.vars[k]; delete ctx.keptVars?.[k]; ctx.pickUnknown.add(k); ctx.srcChanged.add(k); continue; }
    ctx.pickUnknown.delete(k);
    ctx.srcChanged.delete(k);
    ctx.vars[k] = expandHomeRefs(substVars(toPosix(v).replace(USER_RE, ctx.user), ctx.vars, ctx.budget), ctx.homePosix);
    if (ctx.keptVars) ctx.keptVars[k] = ctx.vars[k];
  }
}

// The names a startup file sets, saved so they can be taken back after the child it started is judged. (Only what could make the rest of the line LESS strict is taken back: the
// directories it cd'd into and the "may be anything" marks stay, as extra cases to judge.)
function snapshotShell(ctx) {
  const saved = { vars: { ...ctx.vars }, kept: ctx.keptVars ? { ...ctx.keptVars } : null, pick: new Set(ctx.pickUnknown), changed: new Set(ctx.srcChanged), touched: new Set(ctx.srcTouched) };
  return () => {
    ctx.vars = saved.vars; if (saved.kept) ctx.keptVars = saved.kept;
    ctx.pickUnknown = saved.pick; ctx.srcChanged = saved.changed; ctx.srcTouched = saved.touched;
  };
}

// ---- Bash --------------------------------------------------------------------------------------------

export const evaluateBashForFiles = failClosed(evaluateBashForFilesUnchecked);
function evaluateBashForFilesUnchecked(command, opts = {}) {
  if (!opts._frames) opts = { ...opts, _frames: [] }; // the writes of this line and of the scripts it runs (shared with nested calls, popped on the way out)
  const depth = opts._frames.length;
  try {
    return evaluateBashForFilesFrame(command, opts);
  } finally {
    // what the list wrote is still true for the commands after the one that ran it
    const done = opts._frames[depth];
    const caller = depth > 0 ? opts._frames[depth - 1] : null;
    if (caller && done) caller.recs.push(...exportRecords(done, caller.i, caller.recs));
    opts._frames.length = depth;
  }
}
function evaluateBashForFilesFrame(command, opts) {
  if (!opts._budget) opts = { ...opts, _budget: newEvalBudget(opts.now) }; // one budget for this evaluation and every script it reads
  const assumedCwd = opts._assumedCwd === true; // (a rerun of the line with the cwd assumed to be a protected directory; what it runs is judged normally)
  if (assumedCwd) opts = { ...opts, _assumedCwd: false };
  checkDeadline(opts._budget);
  const ctx = makeCtx(opts);
  if (ctx.admin) return allow();
  const raw = typeof command === 'string' ? command : '';
  if (!raw.trim()) return allow();
  if (raw.length > MAX_LINE_CHARS) {
    // too long to scan in the time budget: judged by what it mentions once quotes and escapes are removed
    return SENSITIVE_WORDS.test(raw.replace(/['"`\\]/g, '')) ? deny('the command line is too long to check and mentions a protected pipeline file or switch; split it into simpler commands') : allow();
  }

  // 1 and 2: the admin switch and the hook switch, however the words are quoted or escaped
  const flat = raw.replace(/['"`]\s*\+\s*['"`]/g, '').replace(/['"`\\]/g, ''); // 'PIPELINE_'+'ADMIN' reads as one word
  if (variantsOf(raw).some((t) => setsAdmin(t, ctx.platform) || setsAdmin(t.replace(/['"`]\s*\+\s*['"`]/g, '').replace(/['"`\\]/g, ''), ctx.platform))) return deny('the command sets PIPELINE_ADMIN; only the owner may set it, when launching Claude Code (naming it, e.g. in grep or prose, is fine)');
  if (hasDisableAll(raw) || hasDisableAll(flat)) return deny('the command mentions disableAllHooks, which would switch the pipeline hooks off');

  const cmds = simpleCommands(raw, { expired: () => opts._budget.now() > opts._budget.deadline }); // a scan that outlasts the deadline gives up: truncated, so denied
  // Truncated means part of the line was never looked at, so nothing on it can be called harmless (500 `true;` then
  // `e''cho x > ~/.cl""aude/settings.json` must not slip through on a text match).
  if (cmds.truncated) return deny('the command line is too complex to check (the parser gave up); split it into simpler commands');
  // prose flags: what a commit message, PR body or test name says is not a reference (the values come out of every scan)
  const prose = new Map(cmds.map((c) => [c, proseWords(c.argv)]));
  const proseValues = [...prose.values()].flatMap((p) => p.values);
  const scanRaw = proseValues.length ? maskProse(raw, proseValues) : raw;
  const rawOfCmd = (c) => maskProse(c.raw, prose.get(c).values);
  const wordsOf = (c) => { const d = prose.get(c).drop; return d.size ? c.argv.filter((_, i) => !d.has(i)) : c.argv; };
  for (const c of cmds) {
    const words = [c.argv.join(' '), ...Object.entries(c.env).map(([k, v]) => `${k}=${v}`)].join(' ');
    if (setsAdmin(words, ctx.platform)) return deny('the command sets PIPELINE_ADMIN; only the owner may set it, when launching Claude Code');
    if (hasDisableAll(words)) return deny('the command mentions disableAllHooks, which would switch the pipeline hooks off');
  }
  if (changesClaudeCode(cmds, scanRaw)) return deny('the command unsets or overrides CLAUDECODE, the marker the installer uses to refuse to run inside Claude Code; only the owner may change it, from a terminal');
  if (setsSeamForPipeline(cmds)) return deny('the command sets a pipeline test seam (PIPELINE_GH, PIPELINE_CODEX, PIPELINE_VERCEL, PIPELINE_TEST_MODE, PIPELINE_UPDATE_REMOTE) for the pipeline CLI; a fake gh/codex/vercel could satisfy the merge gate, and a foreign update remote would install foreign code, so only the owner does that, from a terminal');
  ctx.vars = collectVars(cmds, ctx);
  if (opts._vars) { ctx.vars = { ...opts._vars, ...ctx.vars }; ctx.keptVars = { ...(opts._keptVars ?? {}), ...ctx.keptVars }; } // variables the line set before the shell that runs this file started
  for (const k of opts._unknownW ?? []) ctx.unknownVars.add(k);
  ctx.pickUnknown = new Set(opts._unknown ?? []); // (a name the line gave a run-time value: only a script it picks is refused; the writer rule is for the names above)
  ctx.srcTouched = new Set(); // names a sourced file set on this line (a later plain assignment of one is the value again)
  ctx.unknownAll = opts._unknownAll === true;
  ctx.srcChanged = new Set(opts._srcChanged ?? []); // names an unfollowable sourced file may have changed (a write target that uses one is refused)
  // a name held in a variable (N=PIPELINE_ADMIN; env $N=1 claude)
  if (Object.keys(ctx.vars).length && setsAdmin(substVars(flat, ctx.vars, ctx.budget), ctx.platform)) return deny('the command sets PIPELINE_ADMIN through a variable; only the owner may set it, when launching Claude Code');
  const dirs = collectDirs(cmds, ctx);
  const frame = newWriteFrame(cmds, {
    text: raw,
    expand: (w) => {
      if (/^~[^/\\]/.test(w)) return null; // Why: ~+ / ~- / ~user are not the home directory (expandRefs would read `~+/n.sh` as /home/u+/n.sh): the place is only known at run time
      const e = expandRefs(w, ctx);
      return /[$`*?[{]/.test(e) || (e.startsWith('~') && !isAbs(e)) ? null : e;
    },
    locate: (e, idx) => (isAbs(e) ? [posix.normalize(e)] : dirs.map((d) => posix.join(d, e))),
    isAbs, p: posix, ci: ctx.ci,
    real: (q) => realResolve(q, ctx.api),
    readText: (q) => ctx.readText(q), // (an awk program file is read to see what it writes)
    tick: () => checkDeadline(ctx.budget),
  });
  ctx.frames.push(frame);
  // BASH_ENV / ENV / ZDOTDIR / HOME values this line (and the scripts that run it) assign: shells started by the scripts it runs see them
  const startupEnv = opts.env ?? process.env;
  const inheritedStartup = (n) => opts._startup?.[n] ?? [];
  ctx.startup = startupVarsOf(cmds, { env: startupEnv, inherited: inheritedStartup });

  // 3 and 4: installers and `protect --apply`
  const installer = findInstaller(cmds, raw, dirs, ctx, opts);
  if (installer) return deny(installer);
  if (findProtectApply(cmds, raw)) return deny('pipeline protect --apply changes branch protection and the global hooks; only the owner may run it, from a terminal or with PIPELINE_ADMIN=1');

  // 6: the job runner executes its inner command on the agent's behalf
  if ((opts._depth ?? 0) < 4) {
    for (const c of cmds) {
      const inner = jobInner(c);
      if (!inner) continue;
      const r = evaluateBashForFiles(inner, { ...opts, _depth: (opts._depth ?? 0) + 1, _startup: ctx.startup });
      if (r.decision === 'deny') return deny(`job start would run: ${r.reason}`);
    }
  }

  // 8: links to home, to a protected root or to a directory above one
  const linked = linkReachesProtected(cmds, dirs, ctx);
  if (linked) return deny(`ln links to ${linked}, which is (or holds) protected pipeline files; a link would let later commands reach them under another name (${PROTECTED_MSG})`);

  // The variables this line assigns (its commands' prefixes included) are in the environment of the shells it starts: the startup files and
  // scripts they run are judged with them (a name like `. "$F"` in the file is then the file F names, not an unknown).
  // (every name of the line is seeded, exported or not, and wherever it was set: stricter than the shell, which only passes exported ones on; kept on purpose,
  // a missed name would hide the script a variable picks. The replay found no false block from it.)
  // (a name the line never set, after a source nothing could follow: it may have come from that file)
  const newName = (n) => ctx.unknownAll && !Object.hasOwn(ctx.vars, n);
  // Is the directory the line works in only known at run time? (a `cd` into an unset / substituted / maybe-changed name, `cd -`, `popd`; or the frame was started in one)
  const unknownCwd = () => {
    if (assumedCwd) return false; // (a rerun that already assumes a directory: the unknown cd is what it stands for)
    if (opts._unknownCwd === true || ctx.sourcedCdUnknown) return true;
    const live = ctx.srcChanged.size > 0 || ctx.unknownAll;
    const tainted = live ? taintClosure(ctx.srcChanged, cmds, {}, newName, true) : new Set();
    const KNOWN = new Set(['HOME', 'USER', 'LOGNAME']);
    const unknownName = (n) => tainted.has(n) || newName(n) || ctx.unknownVars.has(n) || ctx.pickUnknown.has(n) || (!KNOWN.has(n) && !Object.hasOwn(ctx.vars, n));
    const moved = (n) => tainted.has(n) || ctx.srcChanged.has(n) || ctx.pickUnknown.has(n) || ctx.unknownVars.has(n);
    // Why: HOME is never believed from the line (the guard reads `~` as the real home), so a line that sets it, or a source that may, leaves `cd` / `cd ~` / `cd ~/x` without a known target
    const homeMoved = ctx.unknownAll || moved('HOME') || cmds.some((c) => Object.hasOwn(c.env ?? {}, 'HOME') || c.argv.some((a) => /^HOME(?:=|\[|$)/.test(a)));
    // Why: with CDPATH set a relative `cd sub` goes to the first CDPATH entry that has `sub` (the line's, the environment's, one a source may have set)
    const cdpathSet = (startupEnv.CDPATH ?? '') !== '' || (Object.hasOwn(ctx.vars, 'CDPATH') && ctx.vars.CDPATH !== '') || moved('CDPATH') || cmds.some((c) => (c.env?.CDPATH ?? '') !== '');
    return cmds.some((c) => {
      const cn = baseOf(c.argv[0] ?? '');
      if (!CD_CMDS.has(cn)) return false;
      if (cdUnknownShape(c.argv)) return true;
      const t = c.argv.slice(1).find((a) => !a.startsWith('-') && a !== '/d');
      if (t === undefined || /^~(?:\/|$)|^\$\{?HOME\b/.test(t)) { if (homeMoved) return true; if (t === undefined) return false; } // (a bare cd goes home)
      const e = expandRefs(t, ctx);
      if (/[*?[{]/.test(e)) return true; // (a glob or a brace list can spell ~/.claude: `cd ~/.cl*`)
      if (/[`$(]/.test(e) || /\$\{!/.test(t) || /[`]|\$\(/.test(t)) return true;
      if (cdpathSet && !isAbs(e) && !/^\.\.?(?:\/|$)/.test(e)) return true;
      return [...t.matchAll(/\$\{?(\w+)/g)].some((x) => unknownName(x[1]));
    });
  };
  const withLineVars = (o, c = null) => ({ ...o, _unknownCwd: unknownCwd(), _vars: { ...ctx.vars }, _keptVars: { ...(ctx.keptVars ?? {}) }, _unknown: new Set([...ctx.unknownVars, ...ctx.pickUnknown]), _unknownW: new Set(ctx.unknownVars), _srcChanged: taintClosure(ctx.srcChanged, cmds, c?.env ?? {}, newName, ctx.srcChanged.size > 0 || ctx.unknownAll), _unknownAll: ctx.unknownAll });

  // A startup file is judged once per evaluation. It is marked first: a startup file that starts shells itself would be judged again and
  // again otherwise (a denial ends the whole evaluation, so marking before the verdict is safe).
  const judgeStartupFile = (st) => {
    // the real home's file is judged on its own, once per evaluation, from the directory the shell starts in: its verdict depends on neither the
    // line's text nor its directories, only on the variables the line has set (seeded below; one whose value is unknown refuses a script it picks)
    if (st.implicit) {
      const unknown = Object.keys(ctx.vars).filter((k) => /[$`]/.test(ctx.vars[k])).sort();
      const key = `${st.file}\u0000${JSON.stringify([ctx.vars, ctx.keptVars ?? {}, unknown, dirs, writeSignature(ctx.frames)])}`;
      const memo = (ctx.budget.implicitStartup ??= new Map());
      // a verdict that leaned on "a missing script may have been created by a command we do not model" is reused only while that is as true as it was
      const flag = unmodelledBefore(ctx.frames);
      const known = memo.get(key);
      if (known && (!known.sens || known.flag === flag)) return known.v;
      const seen0 = ctx.budget.unmodelledSeen ?? 0;
      memo.set(key, { v: null, sens: false, flag });
      const seed = { ...opts, _ignoreUnmodelled: true, _depth: 0, _vars: { ...ctx.vars }, _keptVars: { ...(ctx.keptVars ?? {}) }, _unknown: new Set(unknown) };
      let v = null;
      const abs = expandRefs(st.file, ctx);
      const text = isAbs(abs) ? ctx.readText(abs) : null;
      // the line may have written the file itself (echo ... > ~/.zshenv; zsh -c :)
      const w = isAbs(abs) ? writtenTo(ctx.frames, abs, { exists: (x) => ctx.api.existsSync(x), readText: ctx.readText, ignoreUnmodelled: true }) : null;
      if (w) v = judgeWrittenScript(w, { kind: 'shell', file: st.file, startup: true }, abs, ctx.cwd, ctx, seed, scanRaw); // (the line's text decides the run-time rule, not the startup file's)
      if (v) { /* denied above */ } else if (typeof text === 'string') {
        // the shell starts in the directory the command runs in (the cwd or any `cd` target): the file's relative names resolve there
        countScript(ctx.budget);
        for (const d of dirs) {
          const r = evaluateBashForFiles(text, { ...seed, cwd: d });
          if (r.decision === 'deny') { v = deny(`the script ${st.file} would run: ${r.reason}`); break; }
        }
      } else v = judgeScriptFile({ kind: 'shell', file: st.file }, dirs, ctx, seed, '');
      memo.set(key, { v, sens: (ctx.budget.unmodelledSeen ?? 0) !== seen0, flag });
      return v;
    }
    // reused only for the same file, directories and nesting depth, never for a run-time name (its verdict depends on the line's text)
    // (the shell sees the variables the line gave it, its own prefix included: `F=f.sh BASH_ENV=rc bash -c :` where rc sources "$F")
    if (st.ambiguous) return judgeScriptFile(st, dirs, ctx, withLineVars(opts), scanRaw);
    const key = `${dirs.join('\u0000')}\u0000${opts._depth ?? 0}\u0000${st.file}\u0000${JSON.stringify([ctx.vars, ctx.keptVars ?? {}])}\u0000${unmodelledBefore(ctx.frames)}\u0000${writeSignature(ctx.frames)}`;
    if (ctx.budget.startupOk.has(key)) return null;
    ctx.budget.startupOk.add(key);
    return judgeScriptFile(st, dirs, ctx, withLineVars(opts), scanRaw);
  };

  ctx.judgeStartupFile = judgeStartupFile;

  // 7: a script file (bash f.sh, source f, ./f, node f.mjs) runs whatever is in it
  if ((opts._depth ?? 0) < 4) {
    for (const [idx, c] of cmds.entries()) {
      frame.i = idx;
      if (!c.argv.length && (ctx.unknownVars.size || ctx.pickUnknown.size || ctx.srcTouched.size) && c.sep !== '&&' && c.sep !== '||' && c.depth === 0 && !inFlow(flowStart(cmds), idx)) {
        for (const k of Object.keys(c.env ?? {})) if ((ctx.unknownVars.has(k) || ctx.pickUnknown.has(k) || ctx.srcTouched.has(k)) && !/[$`]/.test(c.env[k]) && !ctx.declared?.unknown.has(k)) { ctx.unknownVars.delete(k); ctx.pickUnknown.delete(k); ctx.srcChanged.delete(k); ctx.vars[k] = applyTransform(expandRefs(c.env[k], ctx), ctx.declared?.transform.get(k) ?? null); }
      }
      const sf = scriptFileOf(c.argv, c.raw, raw);
      const withPath = (rec) => { if (rec.words?.some(isEqualsWord)) rec.pathValues = pathValuesOf(c, cmds, { env: startupEnv, inherited: inheritedStartup }); return rec; }; // (zsh `=tool`: the PATH directories to look in)
      if (sf) withPath(sf);
      // a shell runs its startup files (BASH_ENV, ENV, ZDOTDIR/.zshenv ...) BEFORE the script it was given, so they are judged first, in the
      // order the shell reads them: judged like `bash FILE`
      // Why: a startup file runs in the CHILD shell, so what it sets is the script's, not the rest of this line's: the effects are taken back once the child is judged (only `source` / `.` change this shell)
      let undo = null;
      for (const st of startupFilesOf(c, cmds, { env: startupEnv, inherited: inheritedStartup, exec: sf?.kind === 'exec' })) {
        const v = judgeStartupFile(st);
        if (v) return v;
        if (!st.implicit) { undo ??= snapshotShell(ctx); absorbSourced(st, dirs, ctx); } // (the shell that runs the script read it first: its cds and variables are the script's)
      }
      if (sf) {
        // (a program run by path is judged with the command that runs it: its shebang may name a shell, which reads startup files of its own)
        const outer = ctx.execCmd;
        ctx.execCmd = sf.kind === 'exec' ? { c, cmds, env: startupEnv, inherited: inheritedStartup } : null;
        let v;
        try {
          v = judgeScriptFile(sf, dirs, ctx, withLineVars(opts, c), scanRaw);
        } finally {
          ctx.execCmd = outer;
        }
        if (v) return v;
        if (sf.kind === 'shell' && ['source', '.'].includes(baseOf(c.argv[0] ?? ''))) absorbSourced(sf, dirs, ctx); // (a sourced file runs in this shell: what it sets is the line's from here)
      }
      // script text that reaches a shell without being named (`bash < f.sh`, `cat f.sh | bash`, `eval "$(cat f.sh)"`): its files are judged like `bash f.sh`
      for (const fd of scriptFeedsOf(c, raw, (w) => expandRefs(w, ctx))) {
        withPath(fd);
        const v = judgeScriptFile(fd, dirs, ctx, withLineVars(opts, c), scanRaw);
        if (v) return v;
      }
      undo?.();
    }
  } else {
    // at the depth limit nothing is followed any further: a named script, a fed file or a startup file the line names is refused; the
    // implicit one (the real home's, which no word names) is judged here, once per evaluation like at the top level
    for (const c of cmds) {
      if (scriptFileOf(c.argv) || scriptFeedsOf(c).length) return deny('scripts run scripts too deeply to check');
      for (const st of startupFilesOf(c, cmds, { env: startupEnv, inherited: inheritedStartup })) {
        if (!st.implicit) return deny('scripts run scripts too deeply to check');
        const v = judgeStartupFile(st);
        if (v) return v;
      }
    }
  }

  // 5: protected-path references must be read-only
  const m = makeMatchers(ctx);
  const totalWords = cmds.reduce((n, c) => n + c.argv.length, 0);
  const tooMany = totalWords > 5000; // per-token scans are skipped; the raw-text scans still run
  if (tooMany) ctx.dynamic = true;
  const insideRoot = dirs.some((d) => ctx.hit(d) || ctx.hitAncestor(d)); // cwd or a `cd` target is a protected dir (or its parent): relative words and bare commands reach it
  const protectedInRaw = m.rawHit(scanRaw, dirs);

  // a path built from a name whose value is only known at run time (typeset -L4 D=...) may be anywhere: a writer or a redirection that uses it is refused
  if (ctx.unknownVars.size) {
    const refs = (w) => [...String(w).matchAll(/\$\{?(\w+)/g)].some((x) => ctx.unknownVars.has(x[1]));
    for (const c of cmds) {
      if ((c.redirects ?? []).some((r) => WRITE_OPS.has(r.op) && refs(r.target ?? '')) || (c.argv.length && !['export', 'declare', 'typeset', 'local', 'readonly'].includes(baseOf(c.argv[0])) && !isReadOnly(c, ctx) && (c.argv.some(refs) || Object.values(c.env ?? {}).some(refs)))) {
        return deny('the command writes through a variable whose value is only known at run time (a width or integer attribute), so the file it reaches cannot be checked; write the path out');
      }
    }
  }

  // Why: a name an unfollowable sourced file may have changed (`D=/tmp; source $X; echo x > $D/settings.json`) may hold ~/.claude by now: a write target that uses it
  // is unknown, so a redirection or a writer that names it is refused, whatever the rest of the path (names are the line's own choice, none is exempt). Not write targets: the
  // operand of a command that runs a script (`source $X`, `bash $F`), a reader, `cd`, a declaration, and an element of a path-list variable's value (`PATH=$D:$PATH`).
  if (ctx.srcChanged.size || ctx.unknownAll) {
    const taint = taintClosure(ctx.srcChanged, cmds, {}, newName, true);
    const maybeChanged = (n) => taint.has(n) || newName(n);
    const changed = (w) => /\$\{!/.test(String(w)) || [...String(w).matchAll(/\$\{?(\w+)/g)].some((x) => maybeChanged(x[1])); // (`${!X}` names a variable by the value of X)
    const taintedEnv = (w) => [...String(w).matchAll(/\$\{?(\w+)/g)].some((x) => taint.has(x[1])); // (a prefix value: only a name known to be changed; an unset one is judged in the child that gets it, `BASH_ENV=$Q bash x.sh` stays allowed)
    const PATH_LISTS = new Set(['PATH', 'CDPATH', 'MANPATH', 'INFOPATH', 'LD_LIBRARY_PATH', 'DYLD_LIBRARY_PATH', 'NODE_PATH', 'PYTHONPATH']); // (search lists only: go writes under GOPATH)
    for (const c of cmds) {
      const name = baseOf(c.argv[0] ?? '');
      const writes = c.argv.length > 0 && !isReadOnly(c, ctx) && !['export', 'declare', 'typeset', 'local', 'readonly', ...CD_CMDS].includes(name);
      // (only the script a shell / interpreter / source runs is exempt: every other word of it can be a write target, `node w.mjs $D/x`, `bash -c 'echo x > $D/x'`)
      const script = scriptFileOf(c.argv)?.file;
      const operands = script === undefined ? c.argv : c.argv.filter((w, i) => w !== script || c.argv.indexOf(w) !== i);
      if ((c.redirects ?? []).some((r) => WRITE_OPS.has(r.op) && changed(r.target ?? '')) || (writes && (operands.some(changed) || Object.entries(c.env ?? {}).some(([k, v]) => !PATH_LISTS.has(k) && taintedEnv(v))))) {
        return deny('the command writes through a variable that a sourced file may have changed, so the file it reaches cannot be checked; write the path out');
      }
    }
  }

  // Why: after a `cd` into a directory only known at run time (`cd $UNSET`, `cd $(cmd)`, `cd -`, `cd $D` with D maybe-changed, a cd in a sourced file) the line works in a directory nobody
  // can name, so the rest of it is judged by the ordinary write checks as if the cwd were each protected directory and each directory above one (every writer model applies, none is listed
  // by name); inline interpreter code is refused (it can build any name at run time). Child frames inherit the flag and judge their own text the same way.
  // (FP: any relative write, or a command that is not read-only, after such a cd; an absolute path outside the protected set and reads stay allowed.)
  if (unknownCwd()) {
    const inline = cmds.find((c) => runsInlineCode(c, ctx));
    if (inline) return deny('the command runs interpreter code after a cd into a directory known only at run time; the code can build the name of any file there, so it cannot be checked; write the directory out');
    // (a script named relative to the unknown directory is a file nobody can read: its commands are not judged)
    // (only `~` and `~/x` are the home: `~+/x`, `~-/x` and `~user/x` name a directory of the unknown one or of another user)
    const relative = (w) => typeof w === 'string' && (/^~[^/]/.test(w) || (!/^~(?:\/|$)/.test(w) && !isAbs(toPosix(expandRefs(w, ctx)))));
    const rel = cmds.find((c) => { const sf = scriptFileOf(c.argv, c.raw, raw); return sf && (sf.kind === 'exec' ? relative(sf.file) : sf.ambiguous || relative(sf.file)); });
    if (rel) return deny('the script is named relative to a directory known only at run time, so its commands cannot be judged; use its absolute path');
    const at = ctx.frames.indexOf(frame);
    for (const d of assumedCwds(ctx)) {
      countCdRun(ctx.budget);
      const r = evaluateBashForFiles(command, { ...opts, cwd: d, _assumedCwd: true, _unknownCwd: false, _frames: ctx.frames.slice(0, at).map((f) => ({ ...f, recs: [...f.recs] })) });
      if (r.decision === 'deny') return deny(`after a cd into a directory known only at run time, ${r.reason} (judged as if the directory were ${d})`);
    }
  }

  // Output redirections write wherever they point, whatever the command: resolve every target (against the cwd and
  // every cd target, with ~ and variables expanded) and deny on a protected one. A symlink already pointing into
  // a protected root counts too.
  for (const c of cmds) {
    for (const r of c.redirects ?? []) {
      if (!WRITE_OPS.has(r.op) || typeof r.target !== 'string' || !r.target || FD_DUP.test(r.target) || r.target === '/dev/null') continue;
      // (a brace list is several targets: `> settings.{json,x}`; only `&N` / `&-` duplicate a descriptor, any other `&NAME` is the file NAME as well)
      for (const target of [r.target, ...(r.target.startsWith('&') ? [r.target.slice(1)] : []), ...braceExpand(expandRefs(r.target, ctx), ctx).split(/\s+/).filter((x) => x && x !== r.target)]) {
      const e = expandRefs(target, ctx);
      // Why: a target built at run time (`echo settings.json`, an unset name) inside a protected directory can be any file there
      if (/[`$]/.test(e) && dirs.some((d) => ctx.hit(d) || ctx.hitAncestor(d))) return deny(`the command redirects output to ${target}, a name only known at run time, inside a protected pipeline directory, so the file it reaches cannot be checked; write the path out (${PROTECTED_MSG})`);
      const abs = isAbs(e) ? [posix.normalize(e)] : dirs.map((d) => posix.join(d, e));
      const viaLink = abs.some((p) => !/[*?[]/.test(p) && (ctx.hit(realResolve(p, ctx.api)) || ctx.hitInode(p)));
      if (m.rawHit(target, dirs) || m.pathHit(target, dirs, true) || viaLink) return deny(`the command redirects output to ${target}, which is a protected pipeline file or the directory that holds it (${PROTECTED_MSG})`);
      }
    }
  }

  // sed's `w FILE` (and the w flag of s) writes a file too, whatever the program word looks like
  for (const c of cmds) {
    if (!['sed', 'gsed'].includes(baseOf(c.argv[0] ?? ''))) continue;
    for (const target of sedWriteTargets(c.argv.slice(1))) {
      const e = expandRefs(target, ctx);
      const abs = isAbs(e) ? [posix.normalize(e)] : dirs.map((d) => posix.join(d, e));
      const viaLink = abs.some((p) => !/[*?[]/.test(p) && (ctx.hit(realResolve(p, ctx.api)) || ctx.hitInode(p)));
      if (m.rawHit(target, dirs) || m.pathHit(target, dirs, true) || viaLink) return deny(`sed writes to ${target}, which is a protected pipeline file or the directory that holds it (${PROTECTED_MSG})`);
    }
  }

  // A scan that was cut short (parse caps, dynamic commands, sizes) cannot prove a command harmless: fail closed
  // when the raw text names a protected file at all.
  if ((cmds.dynamic || ctx.dynamic) && protectedInRaw) return deny('the command line is too complex or too dynamic to check and refers to a protected pipeline file');

  const winAncestor = (c) => c.raw.includes('\\') && m.ancestorRaw(rawOfCmd(c));
  const tokenHit = (t) => m.rawHit(t, dirs) || m.pathHit(t, dirs, true);
  // does the command name a protected file anywhere (source or destination)?
  const names = (c) => insideRoot
    || m.rawHit(rawOfCmd(c), dirs) || winAncestor(c)
    || Object.values(c.env).some((v) => m.rawHit(v, dirs))
    || (!tooMany && wordsOf(c).some(tokenHit));
  // does it WRITE one? cp / rsync / install only write their destination
  const mentions = (c) => {
    const name = baseOf(c.argv[0] ?? '');
    if (insideRoot) return true;
    if (DEST_ONLY.has(name)) return destsOf(wordsOf(c), name).some(tokenHit);
    return names(c) || (MOVERS.has(name) && destsOf(wordsOf(c), name).some(tokenHit));
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
