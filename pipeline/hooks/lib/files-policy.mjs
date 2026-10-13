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
import { SQL_UNKNOWN_VAR } from './sql-clients.mjs';
import os from 'node:os';
import path from 'node:path';
import { toPosix, expandHome, isInside, samePath } from '../../lib/paths.mjs';
import { simpleCommands, runsAfter, commandName, scriptFileOf, scriptFeedsOf, startupFilesOf, startupVarsOf, pathValuesOf, isEqualsWord, shebangShell, declAttrs, applyTransform, sqlShellEscapes, sourcePathSearch, splicesOptions, spliceText } from './shell-parse.mjs';
import { flattenProgram, newWriteFrame, exportRecords, writtenTo, writtenNamesIn, writeSignature, unmodelledBefore, sedArgsUnsafe, sedWriteTargets, sedInPlaceArg, awkArgsPure, sortArgsPure, flowStart, inFlow } from './line-writes.mjs';
import { scriptCandidates, execLineOf, defaultReadDir, defaultReadHead, isShellHead, newEvalBudget, checkDeadline, countScript, substitute, GuardLimit, execLinesOf, paramReadings, assigningDefaults, spliceLines } from './script-candidates.mjs';

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
  // (the whole tree below ~/.claude, not just the protected entries and the directories that hold them: a `..` from projects/ climbs back to them)
  const treeRoots = unique([...withWindowsAliases([`${base}/.claude`], homePosix, platform), realResolve(`${base}/.claude`, api)]);
  const ci = caseInsensitive(platform);
  let rootIds = null;
  return {
    platform, homeNative, homePosix, cwd, api, roots, lexRoots, ancestors, lexAncestors, ci,
    user: opts.user ?? posix.basename(homePosix),
    selfZero: opts._selfZero ?? null, selfBash: opts._selfBash ?? null, selfAbs: opts._selfAbs === true, selfZsh: opts._selfZsh === true, // the judged script file's own path (its $0 unless it was sourced; BASH_SOURCE[0])
    parentFsChanged: opts._fsChanged === true, // (the calling line ran something before this script that may have changed which paths exist)
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
    bashState: opts._bashState, // the BASH rewrite record of the whole evaluation (see evaluateBashForFilesUnchecked)
    hit: (p) => { const q = unFirm(p); return roots.some((r) => isInside(q, r, platform)); },
    hitAncestor: (p) => { const q = unFirm(p); return ancestors.some((a) => samePath(q, a, platform)); },
    hitTree: (p) => { const q = unFirm(p); return treeRoots.some((r) => isInside(q, r, platform)); },
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

// A program word with its unmatched `${` openers made literal (a JS template split at a space: `${o?.pid`, which the shell model cannot end); a balanced `${…}` keeps its readings
function balancedOpeners(w) {
  const open = [];
  for (let i = 0; i < w.length; i++) {
    if (w[i] === '$' && w[i + 1] === '{') { open.push(i); i++; } else if (w[i] === '}') open.pop();
  }
  let out = w;
  for (const i of open.reverse()) out = out.slice(0, i) + out.slice(i + 1);
  return out;
}
function makeMatchers(ctx) {
  const rootRes = rootRegexes(ctx);
  const ancRes = ancestorRegexes(ctx);
  const suffix = suffixRegexes(ctx.ci);
  const ancestors = rootsAndAncestors(ctx);

  // Is a protected file named in `text`? By absolute path (in any of its spellings), by a tail with an unknown
  // prefix, or by a relative tail that lands in a protected root from one of `dirs`.
  // (program: the text of a program in another language, where most `${…}` are no shell defaults (JS template literals overflow the readings of the whole text):
  // then each whitespace-free word is read on its own, as a path cannot span a space; a word whose readings overflow is still a hit)
  const rawHit = (text, dirs, program = false) => {
    if (!text) return false;
    // Why: `${V:-~/.claude}/settings.json` is the protected file whenever V is unset or empty, so every reading of a default / alternative word is judged
    const rs = paramReadings(String(text));
    if (rs.over) {
      if (!program) return true;
      for (const w of String(text).split(/\s+/)) {
        if (!w.includes('${')) continue;
        const wr = paramReadings(balancedOpeners(w));
        if (wr.over || wr.some((r) => rawHitOne(r, dirs))) return true;
      }
      return rawHitOne(text, dirs);
    }
    return rawHitOne(text, dirs) || rs.some((r) => rawHitOne(r, dirs));
  };
  const rawHitOne = (text, dirs) => {
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
  const pathHit = (tok, dirs, withAncestors = true, plausible = null) => {
    let parts = [tok];
    if (tok.startsWith('-')) {
      const eq = tok.indexOf('=');
      parts = eq > 0 ? [tok.slice(eq + 1)] : [];
    } else if (/^[A-Za-z_]+=./.test(tok)) parts = [tok, tok.slice(tok.indexOf('=') + 1)]; // (`of=settings.json`)
    for (const part of parts) {
      if (!part) continue;
      const rs = paramReadings(part);
      if (rs.over) return true;
      // Why: a target built by a command substitution (`"$(echo ~/.claude)"/settings.json`) is only known at run time: when its own text names a protected thing it is refused
      if (/\$\(|`/.test(part) && SENSITIVE_WORDS.test(part)) return true;
      for (const reading of rs) {
        const e = expandRefs(reading, ctx);
        const bases = isAbs(e) ? [''] : dirs;
        for (const d of bases) {
          const full = isAbs(e) ? posix.normalize(e) : posix.join(d, e);
          if (/[*?[]/.test(full) ? globHit(full) : (ctx.hit(full) || (withAncestors && ctx.hitAncestor(full))) && (!plausible || plausible(full, e)) ) return true;
        }
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
// Why: a cd into `app/(group)/[id]` (Next.js route directories; the parser has lost the quotes) names a place only the file system can pin down. Each segment is read both ways, as the literal name
// (quoted) and as a shell pattern (`*` `?` `[..]`, a zsh `(a|b)` group), against the real directory listing, in the WIDEST reading any shell option set could give (case-insensitive: nocaseglob; dot names
// matched: dotglob / globdots; `.` and `..` too), so the answer does not depend on options the line may set. The cd is known only when that reading leads to exactly one existing directory that is
// neither protected nor above a protected one; none or several -> unknown (nullglob / failglob make a failed match a cd home or nowhere). null = a pattern this does not model (nested / unbalanced
// groups, POSIX classes, zsh qualifiers / extended patterns, a brace list, `**`): the caller keeps the directory unknown.
const MAX_GLOB_ENTRIES = 4000;
const MAX_GLOB_FANOUT = 64;
function segmentPattern(seg, ci) {
  const bracket = (s, i) => {
    let j = i + 1;
    let neg = false;
    if (s[j] === '!' || s[j] === '^') { neg = true; j++; }
    const from = j;
    if (s[j] === ']') j++;
    while (j < s.length && s[j] !== ']') j++;
    if (j >= s.length) return null; // (unclosed: the shell reads a literal `[`, not modelled)
    const body = s.slice(from, j);
    if (/\[[:.=]/.test(body)) return null; // (POSIX classes / collating symbols)
    return { re: `[${neg ? '^' : ''}${body.replace(/[\\\]^]/g, '\\$&')}]`, end: j };
  };
  const translate = (s, inGroup) => {
    let re = '';
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '*') re += '[^/]*';
      else if (c === '?') re += '[^/]';
      else if (c === '[') { const b = bracket(s, i); if (!b) return null; re += b.re; i = b.end; } else if (c === '(' || c === ')') return null; // (a group is cut out by the caller; nesting / strays are not modelled)
      else if (c === '|' && inGroup) return null;
      else re += c.replace(/[.+^${}()|\\/]/g, '\\$&');
    }
    return re;
  };
  // (only one level of group: `(a|b)`; every alternative must itself be dot-free at its start)
  let out = '';
  let rest = seg;
  while (rest) {
    const o = rest.indexOf('(');
    const cl = rest.indexOf(')');
    if (o < 0 && cl < 0) { const t = translate(rest, false); if (t === null) return null; out += t; break; }
    if (o < 0 || cl < o) return null;
    const pre = translate(rest.slice(0, o), false);
    if (pre === null || /[@?*+!]$/.test(rest.slice(0, o)) || (o > 0 && cl === rest.length - 1)) return null; // (`@(..)` / `*(..)` extended patterns; a trailing `(...)` after a name is a zsh glob qualifier)
    const alts = rest.slice(o + 1, cl).split('|').map((a) => (a.includes('(') ? null : translate(a, true)));
    if (alts.some((a) => a === null)) return null;
    out += `${pre}(?:${alts.join('|')})`;
    rest = rest.slice(cl + 1);
  }
  try { return new RegExp(`^${out}$`, ci ? 'i' : ''); } catch { return null; }
}
// -> an array of the existing directories `full` (absolute, normalised) leads to, or null when its pattern is not modelled
function resolveGlobDir(full, ctx, wide) {
  const isDir = (p) => Array.isArray(ctx.readDir(p));
  let cur = ['/'];
  for (const seg of full.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { cur = unique(cur.map((p) => posix.dirname(p))); continue; }
    const next = new Set();
    if (!/[*?[(]/.test(seg)) {
      for (const p of cur) if (isDir(posix.join(p, seg))) next.add(posix.join(p, seg));
    } else {
      const re = segmentPattern(seg, wide);
      if (re === null) return null;
      for (const p of cur) {
        if (isDir(posix.join(p, seg))) next.add(posix.join(p, seg)); // (quoted: the literal name)
        const names = ctx.readDir(p);
        if (!Array.isArray(names)) continue;
        if (names.length > MAX_GLOB_ENTRIES) return null;
        // (wide: dot names and `.` / `..` match too, as under dotglob; narrow: a leading dot is matched only by a literal dot)
        for (const n of wide ? [...names, '.', '..'] : names) {
          if (!wide && n.startsWith('.') && !seg.startsWith('.')) continue;
          const child = n === '.' ? p : n === '..' ? posix.dirname(p) : posix.join(p, n);
          if (re.test(n) && isDir(child)) next.add(child);
        }
      }
    }
    cur = [...next];
    if (cur.length > MAX_GLOB_FANOUT) return null;
  }
  return cur;
}
// The one directory a glob-looking cd target `e` names from any of `bases` (null: none, several, or not modelled).
// Could a command before `upto` change which paths exist (create, remove, rename, link: anything not read-only, a write redirect, a sourced file, a startup file)?
function mayChangeListing(cmds, upto, ctx) {
  return cmds.slice(0, upto).some((c) => (c.redirects ?? []).some((r) => WRITE_OPS.has(r.op)) || Object.keys(c.env ?? {}).some((k) => /^(?:BASH_ENV|ENV|ZDOTDIR)$/.test(k))
    || (c.argv.length > 0 && !CD_CMDS.has(baseOf(c.argv[0])) && !VAR_COMMANDS.has(baseOf(c.argv[0])) && (!isReadOnly(c, ctx) || ['source', '.', 'eval'].includes(baseOf(c.argv[0])))));
}
function resolveGlobCd(e, bases, ctx, cmds, idx) {
  if (/[{`$]|\*\*|[<>^#]|~/.test(e)) return null;
  // (the listing is the one NOW: a command before the cd that may create, remove, rename or link a path, a write redirect, a sourced file or a startup file makes it unknown)
  // (also what the calling line wrote before this script: a record or an unmodelled command in an enclosing frame)
  if (unmodelledBefore(ctx.frames) || JSON.parse(writeSignature(ctx.frames)).some(([opaque, recs]) => opaque || recs.length > 0)) return null;
  if (ctx.parentFsChanged || mayChangeListing(cmds, idx, ctx)) return null;
  const found = new Set();
  for (const b of isAbs(e) ? [''] : bases) {
    if (!isAbs(e) && /[*?[(]/.test(b)) continue;
    const full = isAbs(e) ? posix.normalize(e) : posix.join(b, e);
    // (known only when the widest reading (nocaseglob, dotglob) and the narrowest (default options) lead to the same single directory: a narrow zero match under an inherited nullglob is a cd home)
    const wide = resolveGlobDir(full, ctx, true);
    const narrow = resolveGlobDir(full, ctx, false);
    if (wide === null || narrow === null || wide.length !== 1 || narrow.length !== 1 || wide[0] !== narrow[0]) return null;
    found.add(wide[0]);
  }
  if (found.size !== 1) return null;
  const [dir] = [...found];
  // (the cwd is the real location: a link into a protected directory is that directory; `..` after it is the real parent. A protected directory, or one above: the directory stays unknown)
  const real = realResolve(dir, ctx.api);
  return ctx.hit(dir) || ctx.hitAncestor(dir) || ctx.hit(real) || ctx.hitAncestor(real) ? null : real;
}
// (one rerun of a line per assumed directory, counted across the evaluation: past the allowance the line is refused rather than slow)
const MAX_CD_RERUNS = 200;
const MAKES_DIRS = new Set(['mkdir', 'cp', 'mv', 'tar', 'bsdtar', 'gtar', 'unzip', 'git', 'rsync', 'ditto', 'install', 'ln', 'curl', 'wget']);
const MAX_BELOW_ROOT_DIRS = 64; // (subdirectories of the protected roots a rerun may add for a `..` write)
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
    // (a program text next to -f -- gawk -e / --source / -E / --exec -- is inline code too; so is an include / load of a library)
    if (/^(?:awk|gawk|mawk|nawk)$/.test(baseOf(w))) return !rest.some((a) => /^(?:-f|--file)/.test(a)) || rest.some((a) => /^(?:-[eEil]|--(?:source|exec|include|load))/.test(a));
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
// Why: a cd whose target a command computes is not always unknown. Modelled (an absolute directory, never a protected one unless the script / repo really is there; null = not one of these):
// the directory of the judged script file itself (`$(dirname "$0")`, `${0%/*}`, `$(dirname "${BASH_SOURCE[0]}")`, each also in `$(cd ... && pwd)`), the repo root a `.git` walk finds
// (`$(git rev-parse --show-toplevel)`, only for the first cd of the line), a fresh temp directory (`$(mktemp -d)`, `$TMPDIR`), `$(pwd)` / `$PWD`. `$0` of a sourced file is its parent's, so it is not modelled.
const SELF_DIR = String.raw`\$\(\s*dirname\s+(?:--\s+)?"?\$(?:\{?(0|BASH_SOURCE(?:\[0\])?)\}?)"?\s*\)`;
const SELF_RES = [new RegExp(`^(?:${SELF_DIR}|\\$\\{(0|BASH_SOURCE(?:\\[0\\])?)%/\\*\\})(/[\\w./-]*)?$`), new RegExp(`^\\$\\(\\s*cd\\s+"?(?:${SELF_DIR})"?\\s*(?:&&|;)\\s*pwd(?:\\s+-[LP])?\\s*\\)(/[\\w./-]*)?$`)];
// A script word built from the judged script's own directory (`"$(dirname "$0")/helper"`, `"$(cd "$(dirname "$0")" && pwd)/helper"`, `"${0%/*}/helper"`): the same model
// as a cd to that directory, with the same refusals (null when the word is not one of these, or the model cannot vouch for it)
function selfPathWord(t, cmds, idx, ctx) {
  return SELF_RES.some((re) => re.test(t)) ? modelledCd(t, cmds, idx, ctx) : null;
}
function modelledCd(t, cmds, idx, ctx) {
  if (/(?:^|\/)\.\.(?:\/|$)/.test(t)) return null; // (a suffix that climbs is not modelled)
  const sub = (x) => x ?? '';
  const earlierMove = cmds.slice(0, idx).some((c) => c.depth === 0 && c.argv.length && (CD_CMDS.has(baseOf(c.argv[0])) || ['source', '.'].includes(baseOf(c.argv[0]))));
  const touched = (names) => ctx.unknownAll || names.some((n) => Object.hasOwn(ctx.vars, n) || ctx.unknownVars.has(n) || ctx.pickUnknown.has(n) || ctx.srcChanged.has(n)
    || cmds.some((c) => Object.hasOwn(c.env ?? {}, n) || c.argv.some((a) => a === n || a.startsWith(`${n}=`) || a.startsWith(`${n}+=`) || a.startsWith(`${n}[`))));
  for (const [ri, re] of SELF_RES.entries()) {
    const m = re.exec(t);
    if (!m) continue;
    const which = ri === 0 ? (m[1] ?? m[2]) : m[1];
    const self = which === '0' ? ctx.selfZero : ctx.selfBash;
    if (!self || which === undefined) return null;
    // ($0 is the word the script was started with: a relative one is read from the cwd at that moment, which an earlier cd in the script has moved)
    if (!ctx.selfAbs && earlierMove) return null;
    // (something earlier in the script may have changed $0: BASH_ARGV0 / `0=` assigned, or code run by source / . / eval)
    if (touched(['BASH_ARGV0']) || cmds.some((c) => Object.hasOwn(c.env ?? {}, '0') || c.argv.some((a) => /^0\+?=/.test(a))) || cmds.slice(0, idx).some((c) => ['source', '.', 'eval'].includes(baseOf(c.argv[0] ?? '')))) return null;
    // (a relative $0 gives a relative dirname (`scripts/run` -> `scripts`), which `cd` looks up along CDPATH first: the line's, the environment's, one a source may have set)
    if (!ctx.selfAbs && ((ctx.env?.CDPATH ?? '') !== '' || touched(CDPATH_NAMES))) return null;
    return posix.normalize(posix.join(posix.dirname(self), sub(m[m.length - 1])));
  }
  let m = /^\$\(\s*git\s+rev-parse\s+--show-toplevel\s*\)(\/[\w./-]*)?$/.exec(t);
  if (m) {
    // Why: the root is where a `.git` is found walking up from the directory the line starts in: only before any cd / source, with nothing on the line able to redirect git (PATH, GIT_*, HOME, XDG_CONFIG_HOME), and no core.worktree in the repo config
    if (earlierMove || cmds.slice(0, idx).some((c) => (baseOf(c.argv[0] ?? '') === 'git' && c.argv[1] !== 'rev-parse') || /\.git\b|gitconfig/i.test(c.raw ?? '') || Object.keys(c.env ?? {}).some((k) => /^GIT_CONFIG_(?:KEY|VALUE)_/.test(k)))
      || touched(['GIT_CONFIG_PARAMETERS', 'PATH', 'HOME', 'XDG_CONFIG_HOME', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_CONFIG', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_COUNT', 'GIT_COMMON_DIR', 'GIT_CEILING_DIRECTORIES'])) return null;
    for (let d = ctx.cwd, n = 0; n < 64; n++) {
      const dotgit = posix.join(d, '.git');
      if (ctx.api.existsSync(dotgit)) {
        const text = ctx.readText(dotgit);
        let gitdir = dotgit; // (a directory)
        if (typeof text === 'string') {
          const g = /^gitdir:\s*(.+?)\s*$/m.exec(text);
          if (!g) return null;
          gitdir = posix.resolve(d, toPosix(g[1]));
        }
        const configs = [posix.join(gitdir, 'config')];
        const common = typeof text === 'string' ? ctx.readText(posix.join(gitdir, 'commondir')) : null;
        if (typeof common === 'string' && common.trim()) configs.push(posix.join(posix.resolve(gitdir, toPosix(common.trim())), 'config'));
        // (a worktree key anywhere, or an include of another file, anywhere in the repo's, the user's or the XDG config: the root may be elsewhere)
        const xdg = ctx.env.XDG_CONFIG_HOME && isAbs(toPosix(ctx.env.XDG_CONFIG_HOME)) ? toPosix(ctx.env.XDG_CONFIG_HOME) : posix.join(ctx.homePosix, '.config');
        const users = [posix.join(ctx.homePosix, '.gitconfig'), posix.join(xdg, 'git/config')];
        // (the per-worktree file `config.worktree` is read when extensions.worktreeConfig is on: its core.worktree moves the root too)
        const texts = [...configs, posix.join(gitdir, 'config.worktree')].filter((q, qi) => qi < configs.length || ctx.api.existsSync(q)).map((q) => ctx.readText(q));
        for (const q of users) if (ctx.api.existsSync(q)) texts.push(ctx.readText(q));
        if (texts.some((x) => typeof x !== 'string') || texts.some((x) => /worktree/i.test(x) || /^\s*\[\s*include/mi.test(x))) return null;
        return posix.normalize(posix.join(d, sub(m[1])));
      }
      const up = posix.dirname(d);
      if (up === d) break;
      d = up;
    }
    return null;
  }
  m = /^(?:\$\(\s*mktemp\b([^()`]*)\)|`\s*mktemp\b([^()`]*)`)(\/[\w./-]*)?$/.exec(t);
  if (m) {
    // Why: `mktemp -d` makes a directory in $TMPDIR (or /tmp); a template WITHOUT -t is relative to the cwd, -p / --tmpdir names a directory
    const args = (m[1] ?? m[2] ?? '').trim().split(/\s+/).filter(Boolean);
    const flags = args.filter((a) => a.startsWith('-'));
    const hasT = flags.some((a) => /^-[A-Za-z]*t/.test(a));
    if (flags.some((a) => /^-[A-Za-z]*p|^--tmpdir/.test(a)) || args.some((a) => /[\/~$`\\]/.test(a)) || (args.some((a) => !a.startsWith('-')) && !hasT) || touched(['TMPDIR'])) return null;
    if (ctx.env.TMPDIR && (ctx.hit(ctx.env.TMPDIR) || ctx.hitAncestor(ctx.env.TMPDIR))) return null;
    // (the directory is modelled as a leaf of an unknown place: a `..` write on the line may climb out of it to anywhere, so then the cd stays unknown)
    const UP = /(?:^|[\\/])\.\.(?:[\\/]|$)/;
    if (cmds.some((c) => (c.redirects ?? []).some((q) => UP.test(q.target ?? '')) || c.argv.slice(1).some((a) => UP.test(a)))) return null;
    return posix.join('/tmp/.mktemp', sub(m[3]));
  }
  m = /^\$\{?TMPDIR\}?(\/[\w./-]*)?$/.exec(t); // (no default: \`\${TMPDIR:-x}\` and an unset or empty TMPDIR are unknown)
  if (m && !touched(['TMPDIR'])) {
    const v = ctx.env.TMPDIR;
    if (typeof v === 'string' && v !== '' && isAbs(toPosix(v)) && !/[$`*?[{]/.test(v)) return posix.normalize(posix.join(toPosix(v), sub(m[1])));
    return null;
  }
  m = /^(?:\$\(\s*pwd(?:\s+-[LP])?\s*\)|\$PWD|\$\{PWD\})(\/[\w./-]*)?$/.exec(t);
  if (m && !earlierMove && !touched(['PWD', 'OLDPWD'])) return posix.normalize(posix.join(ctx.cwd, sub(m[1])));
  return null;
}
// Why: these write into the directory they run in without naming a file (an archive extracts there, curl -O / wget save there, git rewrites the work tree): in a rerun that assumes a protected directory they count as writes.
const GIT_QUIET = new Set(['status', 'log', 'diff', 'show', 'add', 'commit', 'branch', 'fetch', 'rev-parse', 'rev-list', 'remote', 'ls-files', 'grep', 'blame', 'describe', 'tag', 'push', 'shortlog', 'ls-tree', 'cat-file', 'merge-base', 'symbolic-ref', 'for-each-ref', 'name-rev', 'config', 'version', 'help']);
// Why: a zsh script finds its own directory with `${0:A:h}` (symlinks resolved), `${0:a:h}`, `${0:h}`, repeated `:h`, or `${${(%):-%x}:A:h}` / `%N`, then `HERE=...; source "$HERE/lib.sh"` or `DIR="${HERE:h}"`.
// For a file run as a zsh script these are its own directory, as `${0%/*}` is for bash (same conditions as modelledCd); the words are rewritten to that directory before anything reads
// them, so a sourced sibling can be followed. Positive only: bash reads `${0:A:h}` as a substring, a function body has its own $0 in zsh, and a $0 that may have changed stays a run-time value.
const ZSH_SELF_RE = /\$\{(?:0|\$\{\(%\):-%[xN]\})((?::[Aah])+)\}/g;
const ZSH_VAR_RE = /\$\{([A-Za-z_]\w*)((?::[aht])+)\}/g;
const PLAIN_ABS = /^\/[\w@%+=,./-]*$/;
function functionRanges(raw) { // [start, end] of every brace-group function body; null when a definition has another shape (a subshell body, a call that looks like one)
  const ranges = [];
  const re = /(?:\bfunction\b\s*(?:[\w.:@+-]+\s*)?(?:\(\s*\)\s*)?|(?:[\w.:@+-]+\s*)?\(\s*\)\s*)/g; // (named, `function name`, anonymous `() { }` / `function { }`)
  for (let m; (m = re.exec(raw)); ) {
    const start = m.index + m[0].length;
    if (raw[start] !== '{') return null;
    let depth = 0;
    let i = start;
    for (; i < raw.length; i++) { if (raw[i] === '{') depth++; else if (raw[i] === '}' && --depth === 0) break; }
    ranges.push([start, i]);
  }
  return ranges;
}
// Why: a name is believed only when every command of the script is one that never binds a shell name (an allowlist: zsh has many binders -- read, mapfile, getopts, print -v, printf -v, zparseopts,
// strftime -s, zstyle, sysread, zstat -A, vared, unset, let, declare ... -- and a function or an alias may call any of them), and nothing else rebinds it (`${N:=x}`, `N[1]=`, a loop variable, (( ))).
// A program run by path is another process. source / . are followed by absorbSourced, which knows what the file sets.
const NAME_SAFE = new Set(['cd', 'pushd', 'popd', 'echo', 'cat', 'ls', 'cp', 'mv', 'rm', 'mkdir', 'rmdir', 'touch', 'test', '[', '[[', 'true', 'false', ':', 'exit', 'node', 'npm', 'npx', 'git', 'grep', 'egrep', 'rg', 'sed', 'awk',
  'head', 'tail', 'sleep', 'kill', 'pkill', 'pgrep', 'lsof', 'curl', 'open', 'launchctl', 'id', 'du', 'find', 'tr', 'cut', 'wc', 'sort', 'uniq', 'tee', 'chmod', 'date', 'basename', 'dirname', 'pwd', 'jq', 'python3', 'xargs', 'source', '.']);
const noBindFlag = (c) => !c.argv.slice(1).some((a) => /^-[A-Za-z]*v/.test(a));
function onlyNonBinders(cmds) {
  return cmds.every((c) => {
    if (!c.argv.length) return true; // (plain assignments)
    const n = baseOf(c.argv[0]);
    if (n === 'print' || n === 'printf') return noBindFlag(c);
    return NAME_SAFE.has(n) || c.argv[0].includes('/');
  });
}
function mayRebind(name, cmds, raw) {
  const re = (s) => new RegExp(s.replaceAll('NAME', name));
  // (a `${...}` that mentions the name and assigns -- `${N:=x}`, `${N::=x}`, `${(flags)N=x}`, `${N+=}`)
  if (re('\\$\\{[^}]*\\bNAME\\b[^}]*=|\\$\\{!?NAME\\[|\\bNAME\\[[^\\]]*\\]\\+?=|\\b(?:for|select|foreach)\\s+NAME\\b|\\(\\([^)]*\\bNAME\\b|\\{NAME\\}\\s*(?:[<>]|&>)|\\bNAME\\+=').test(raw)) return true; // (`${N:=x}`, `N[1]=`, a loop variable, arithmetic)
  return !onlyNonBinders(cmds);
}
function modelZshSelfDirs(cmds, raw, ctx) {
  if (!ctx.selfZero || !ctx.selfZsh || !/:[Aaht][:}]/.test(raw)) return;
  if (raw.includes('::=') || /\$\{[^}]*(?:\b0\b|BASH_ARGV0)[^}]*=/.test(raw)) return; // (an expansion that assigns $0: not modelled at all)
  const ranges = functionRanges(raw);
  if (ranges === null || [...raw.matchAll(ZSH_SELF_RE)].some((m) => ranges.some(([a, b]) => m.index >= a && m.index <= b))) return;
  if (cmds.some((c) => Object.hasOwn(c.env ?? {}, '0') || Object.hasOwn(c.env ?? {}, 'BASH_ARGV0') || c.argv.some((a) => /^(?:0|BASH_ARGV0)\+?=|^BASH_ARGV0$/.test(a)))) return;
  const counts = new Map();
  for (const c of cmds) {
    for (const k of Object.keys(c.env ?? {})) counts.set(k, (counts.get(k) ?? 0) + 1);
    for (const a of c.argv) { const m = /^([A-Za-z_]\w*)\+?=/.exec(a); if (m) counts.set(m[1], (counts.get(m[1]) ?? 0) + 2); }
  }
  const from = flowStart(cmds);
  const known = new Map(); // names set once, unconditionally, to a plain absolute path
  const mods = (p, steps) => {
    let cur = p;
    for (const s of steps) cur = s === 'A' ? realResolve(cur, ctx.api) : s === 'a' ? posix.normalize(cur) : s === 't' ? posix.basename(cur) : posix.dirname(cur);
    return PLAIN_ABS.test(cur) ? cur : null;
  };
  for (const [i, c] of cmds.entries()) {
    // (a relative $0 is read from the cwd at that moment, which an earlier cd has moved; code run by source / . / eval may have assigned $0)
    const before = cmds.slice(0, i);
    const stable = (ctx.selfAbs || !before.some((x) => CD_CMDS.has(baseOf(x.argv[0] ?? '')))) && !before.some((x) => ['source', '.', 'eval'].includes(baseOf(x.argv[0] ?? ''))) && onlyNonBinders(before); // (setopt / emulate / set -o, functions and the like may change what $0 is)
    const runsCode = before.some((x) => ['source', '.', 'eval', 'exec'].includes(baseOf(x.argv[0] ?? '')));
    const fix = (w) => String(w)
      .replace(ZSH_SELF_RE, (m, ms) => {
        const steps = ms.slice(1).split(':');
        return stable && (ctx.selfAbs || steps[0] !== 'h') ? mods(posix.normalize(ctx.selfZero), steps) ?? m : m;
      })
      .replace(ZSH_VAR_RE, (m, name, ms) => (known.has(name) && !runsCode ? mods(known.get(name), ms.slice(1).split(':')) ?? m : m));
    c.argv = c.argv.map(fix);
    // (a name that something on the script may rebind keeps its text: HERE="${0:A:h}" is not believed after `read HERE`)
    if (c.env) c.env = Object.fromEntries(Object.entries(c.env).map(([k, v]) => { const f = fix(v); return [k, f !== String(v) && mayRebind(k, cmds, raw) ? v : f]; }));
    if (c.redirects) for (const r of c.redirects) if (typeof r.target === 'string') r.target = fix(r.target);
    const sure = !(inFlow(from, i) || c.depth > 0 || c.sep === '&&' || c.sep === '||' || c.sep === '|' || cmds[i + 1]?.sep === '|' || cmds[i + 1]?.sep === '&');
    if (!c.argv.length && sure) for (const [k, v] of Object.entries(c.env ?? {})) if (counts.get(k) === 1 && PLAIN_ABS.test(v) && !mayRebind(k, cmds, raw)) known.set(k, v);
  }
}

function impliesCwdWrite(c) {
  const name = baseOf(c.argv[0] ?? '');
  const args = c.argv.slice(1);
  if (['tar', 'bsdtar', 'gtar', 'unzip', '7z', '7za', '7zz', 'cpio', 'bsdcpio', 'pax', 'ar', 'jar', 'unrar', 'unar', 'unxz', 'unzstd', 'bunzip2', 'gunzip', 'patch', 'ditto', 'wget', 'svn', 'hg'].includes(name)) return true;
  if (['gzip', 'xz', 'bzip2', 'zstd', 'lz4'].includes(name)) return true; // (compress or decompress, in place)
  const relOperand = args.some((a) => !a.startsWith('-') && !/^(?:\/|~)/.test(a.replace(/^\w+=/, '')));
  if (['touch', 'mkdir', 'tee', 'truncate', 'rm', 'rmdir', 'mkfifo', 'mknod', 'chmod', 'chown', 'dd'].includes(name)) return relOperand;
  if (['sed', 'gsed'].includes(name) && args.some((a) => inPlaceFlag(a))) return relOperand;
  if (['perl', 'ruby'].includes(name) && args.some((a) => /^-[A-Za-z]*i/.test(a))) return relOperand; // (in-place edit)
  if (name === 'find') return args.some((a) => FIND_UNSAFE.test(a)); // (-delete, -exec, -fprint ...: a write in the directory it runs in)
  if (name === 'curl') return args.some((a) => /^-[A-Za-z]*[OoJ]/.test(a) || /^--(?:output|remote-name|remote-header-name)/.test(a));
  if (name === 'git') {
    let i = 0;
    while (i < args.length && args[i].startsWith('-')) i += ['-c', '-C', '--git-dir', '--work-tree', '--namespace'].includes(args[i]) ? 2 : 1;
    return !GIT_QUIET.has(args[i] ?? '');
  }
  return false;
}
const FIND_UNSAFE = /^-(?:delete|exec|execdir|ok|okdir|fprint0?|fprintf|fls)$/;
const SHELL_NAMES = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'csh', 'tcsh', 'pwsh', 'powershell', 'cmd']);
// For these only the destination (last word, or -t DIR) can change a protected file; reading one into /tmp is fine.
const DEST_ONLY = new Set(['cp', 'rsync', 'install']);
const MOVERS = new Set(['mv', 'ln', 'ditto']); // any named protected path counts, and so does DEST/basename(SRC)
// (zsh's lowercase `cdpath` array is tied to CDPATH: setting either sets both)
const CDPATH_NAMES = ['CDPATH', 'cdpath'];
const NOT_WRITERS = new Set(['cd', 'pushd', 'popd', 'export', 'declare', 'typeset', 'local', 'readonly', 'unset', 'set', 'shift', 'read', 'wait', 'true', 'false', ':', 'exit', 'return', 'test', '[', '[[', 'source', '.']);
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
    // (`set -- ev.sh`: the positional parameters, so `bash $1` is that file)
    if (baseOf(c.argv[0] ?? '') === 'set' && !c.argv.some((a) => /^[-+][A-Za-z]*A/.test(a))) { const w = setPositionals(c.argv); if (w) for (let i = 1; i <= 9; i++) set(String(i), i <= w.length ? w[i - 1] : ''); }
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
  const addDir = (e, globAt = -1) => {
    for (const d of [...dirs]) {
      // (a cd target with glob-looking parts that leads to exactly one existing directory is that directory)
      const nd = (globAt >= 0 && /[*?[(]/.test(e) ? resolveGlobCd(e, [d], ctx, cmds, globAt) : null) ?? (isAbs(e) ? posix.normalize(e) : posix.join(d, e));
      if (!dirs.includes(nd) && dirs.length < 32) dirs.push(nd);
      // Why: `cd -P link/..`, `set -P`, zsh chaselinks: a `..` after a symlink goes to the target's parent, not the link's: that reading is a directory the line may be in too
      if (/(?:^|\/)\.\.(?:\/|$)/.test(e) && !/[*?[(]/.test(e)) {
        let cur = isAbs(e) ? '/' : d;
        for (const seg of e.split('/')) {
          if (seg === '' || seg === '.') continue;
          cur = seg === '..' ? posix.dirname(realResolve(cur, ctx.api)) : posix.join(cur, seg);
        }
        if (!dirs.includes(cur) && dirs.length < 32) dirs.push(cur);
      }
    }
  };
  for (const [ci, c] of cmds.entries()) {
    // commands that run relative to another directory: git -C DIR, tar -C DIR, unzip -d DIR, make -C DIR, cp -t DIR
    for (const b of baseDirsOf(c.argv)) addDir(expandRefs(b, ctx));
    const cdName = baseOf(c.argv[0] ?? '');
    if (!CD_CMDS.has(cdName)) continue;
    if (readsOnlyInSubshell(c, cmds, ctx)) continue; // (`d=$(cd "$(dirname "$0")" && pwd)`: nothing runs in that directory but reads, and the cd ends with the subshell)
    let t = c.argv.slice(1).find((a) => !a.startsWith('-') && a !== '/d');
    if (!t && (cdName === 'cd' || cdName === 'pushd')) t = '~'; // a bare `cd` goes home
    if (c.raw.includes('\\')) {
      const m = /^\s*(?:cd|pushd|set-location|sl)\s+(?:\/d\s+)?["']?([^"';&|\n]+)/i.exec(c.raw);
      if (m) t = m[1].trim();
    }
    if (!t) continue;
    const mc = modelledCd(t, cmds, ci, ctx);
    addDir(mc !== null ? mc : expandRefs(t, ctx), mc === null ? ci : -1);
  }
  return dirs;
}

// Why: a cd inside a subshell (`d=$(cd "$D" && pwd)`, `(cd "$D"; ls)`) is lost when the subshell ends (shell-parse tags each command with the subshells it runs in: `grp`).
// When every command in that subshell (nested ones included) only reads and writes nothing, the directory it went to is never written in, wherever it is.
// (a command the parser could not tag, or a copy that lost the tag, counts as outside every subshell: its cd stays judged)
const SUBSHELL_READS = new Set(['pwd', 'dirname', 'basename', 'true', 'false', ':', 'exit', 'return']);
const onlyReads = (c, ctx) => (c.argv.length === 0 || SUBSHELL_READS.has(baseOf(c.argv[0])) || isReadOnly(c, ctx))
  && !(c.redirects ?? []).some((r) => WRITE_OPS.has(r.op) && !FD_DUP.test(r.target ?? '') && r.target !== '/dev/null');
const insideOf = (cd) => { const g = cd.grp ?? []; return (c) => (c.grp ?? []).length >= g.length && g.every((id, k) => c.grp[k] === id); };
function readsOnlyInSubshell(cd, cmds, ctx) {
  if (!(cd.grp ?? []).length) return false;
  const inside = insideOf(cd);
  return cmds.every((c) => !inside(c) || onlyReads(c, ctx));
}

// Why: a cd moves what runs after it, not what ran before: `sdd-workspace` ends with `cd -- "$dir" && pwd`. When every command that may run after it (see
// runsAfter in shell-parse.mjs: later ones in its subshell or script, and trap actions) only reads, the directory it went to is never written in. Only for a script
// file run in a process of its own (ctx.selfZero): after the line or a sourced file, the next command (or Bash call) goes on in that directory.
function nothingWritesAfterCd(ci, cmds, ctx) {
  const after = runsAfter(cmds, ci);
  return after !== null && after.every((c) => onlyReads(c, ctx));
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
        } catch {
          if (opts._writesOnly === true) continue; // (a rerun that only assumes the directory: an unreadable package.json there says nothing about the real one)
          return `${n} run ${script} runs in a claude-pipeline checkout whose package.json cannot be read, so it cannot be shown not to run the installer`;
        }
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
    const r = evaluateBashForFiles(text, { ...opts, cwd: dir, _depth: (opts._depth ?? 0) + 1, _startup: ctx.startup, ...(sf.runsAsScript && sf.freshBash ? { _bashState: undefined } : {}), ...(sf.runsAsScript ? { _selfBash: abs, _selfZero: abs, _selfAbs: isAbs(expandRefs(String(sf.file), ctx)), _selfZsh: sf.kind === 'exec' ? posix.basename(SHEBANG_PROGRAM.exec(text.split('\n', 1)[0])?.[1] ?? '') === 'zsh' : sf.runShell === 'zsh' } : {}) });
    return r.decision === 'deny' ? deny(`the script ${sf.file} would run: ${r.reason}`) : null;
  }
  // program text in another language: the admin switch, the hook switch, or a write next to a protected path
  if (variantsOf(text).some((t) => setsAdmin(t, ctx.platform) || hasDisableAll(t))) return deny(`the program ${sf.file} sets PIPELINE_ADMIN or mentions disableAllHooks; only the owner may switch the pipeline guard off`);
  const m = makeMatchers(ctx);
  if (text.length <= MAX_SCRIPT_BYTES && m.rawHit(text, [dir], true) && WRITE_HINT.test(text)) return deny(`the program ${sf.file} refers to a protected pipeline file and writes (${PROTECTED_MSG})`);
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
  // the prose-masked line: a protected path, or (strictly) the bare words once quotes and escapes are stripped. Why: a protected script (the pipeline CLI run after a
  // command whose writes are unknown, as the ship skill's `pipeline.mjs job start … -- node pipeline.mjs codex-review`) is not judged on its content, and the line names a
  // protected file only by naming it: its own word is left out, any other protected name or switch still counts
  // (only where an interpreter runs it, or it is the command word: handed to another program as an argument it still counts)
  const esc = String(sf.file).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const own = new RegExp(`(^|[\\s;&|(])((?:node|nodejs|bash|sh|zsh|dash|deno|bun|tsx|python3?|ruby|perl|php)\\s+)?${esc}(?=$|[\\s;&|)])`, 'g');
  const rest = ctx.hit(abs) ? scanRaw.replace(own, (m, lead, interp) => (interp || !/\s/.test(lead) ? `${lead}${interp ?? ''} ` : m)) : scanRaw;
  if (w.unknown && (makeMatchers(ctx).rawHit(rest, [dir]) || SENSITIVE_WORDS.test(rest.replace(/['"`\\]/g, '')))) {
    return deny(`the script ${sf.file} may have been written by an earlier command on the line (its content is only known at run time) and the line refers to a protected pipeline file or switch, so what it runs cannot be checked; write the file out literally`);
  }
  return null;
}

// Why: `bash ${A:--c ./ev.sh}`: a default word in an option position of a shell or interpreter is read again as each reading of it (see spliceLines); the line each makes is judged like a literal one
function judgeSplices(c, dirs, ctx, opts) {
  const r = spliceLines(spliceText(c));
  if (r.over) return deny('a default or alternative word (${X:-w}) in this command may be an option, and its readings cannot be worked out exactly (a quote, backslash, backtick or $( ) near it, or too many), so what the command runs cannot be checked; write the options literally');
  for (const line of r.lines) {
    if ((opts._depth ?? 0) >= 4) return deny('a default word in an option position is nested too deeply to check');
    for (const d of dirs) {
      const v = evaluateBashForFiles(line, { ...opts, cwd: d, _assigned: ctx.assigned, _depth: (opts._depth ?? 0) + 1, _startup: ctx.startup, _vars: { ...ctx.vars }, _keptVars: { ...(ctx.keptVars ?? {}) } });
      if (v.decision === 'deny') return deny(`a default word in this command may be an option; read as \`${line}\` it would run: ${v.reason}`);
    }
  }
  return null;
}

// A word before the script expands at run time (`X=+n; bash $X w.sh`, `bash $(..) w.sh`, `source $X`, `bash *.sh`), so which
// word the shell runs is unknown. Judge every word that could be it (see script-candidates.mjs) like a named script. A
// word that is still unknown (`$UNSET`) cannot be judged: the textual rules still apply, and the line is denied when it
// names a protected pipeline file.
// The one file a word made only of names the line set names: no run-time part, glob or space, not an option (null otherwise)
function lineVarWord(w, ctx) {
  if (ctx.unknownAll || ctx.vars.IFS) return null;
  const e0 = expandRefs(w, ctx);
  const names = [...w.matchAll(/\$\{?(\w+)/g)].map((x) => x[1]);
  return names.length && e0 && !/[\s$`*?[{~(]|^-/.test(e0) && names.every((n) => Object.hasOwn(ctx.vars, n) && !ctx.unknownVars.has(n) && !ctx.pickUnknown.has(n) && !ctx.srcChanged.has(n) && !ctx.srcTouched.has(n)) ? e0 : null;
}
// The word the command at idx is given, only to tell that it is no option (a login shell reads other startup files). ctx.vars cannot say (it holds the line's LAST value of each
// name, a prefix `X=v cmd` included), so every value a name may have WHEN that command runs is tried: each value the line assigns it (before or after, in a branch or a subshell:
// a superset of the one it has then) and the environment's value or nothing. Each reading must be a word with no space, glob character, $ or leading - / + (a value built from
// other names keeps its $). Null when a sourced file may have set a name, a name is bound another way (export / typeset / read / let / (( )) / printf -v / unset …: the name
// stands as a word of its own outside its assignments), or the word holds more than plain $NAME / ${NAME} references (a zsh modifier `$S:t` or subscript `$S[1]` changes it).
function lineVarWordAt(w, ctx, cmds, raw) {
  if (!/^(?:[^$`\\]|\$\w+(?![\w:[])|\$\{\w+\})+$/.test(w)) return null;
  const values = (n) => {
    if (ctx.unknownVars.has(n) || ctx.pickUnknown.has(n) || ctx.srcChanged.has(n) || ctx.srcTouched.has(n)) return null;
    const vs = [];
    for (const c of cmds) if (Object.hasOwn(c.env ?? {}, n)) vs.push(String(c.env[n]).replace(/^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/, ctx.homePosix ?? ''));
    if ((String(raw).match(new RegExp(`(?<![\\w$])(?<!\\$\\{)${n}(?!\\w)`, 'g')) ?? []).length !== vs.length) return null;
    return [...vs, typeof ctx.env?.[n] === 'string' ? ctx.env[n] : ''];
  };
  const names = [...new Set([...w.matchAll(/\$\{?(\w+)/g)].map((x) => x[1]))];
  if (!names.length) return null;
  let readings = [w];
  for (const n of names) {
    const vs = values(n);
    if (!vs) return null;
    readings = readings.flatMap((r) => vs.map((v) => r.replace(new RegExp(`\\$\\{${n}\\}|\\$${n}(?!\\w)`, 'g'), () => v)));
    if (readings.length > 16) return null;
  }
  return readings.every((r) => r && !/[\s*?[\]{}$`\\]|^[-+]/.test(r)) ? readings[0] : null;
}
function judgeCandidateScripts(sf, dirs, ctx, opts, scanRaw) {
  const joinPath = (d, r) => (isAbs(r) ? posix.normalize(r) : posix.join(d, r));
  const lines = execLinesOf(sf, (w) => expandRefs(w, ctx), ctx.assigned);
  if (lines.over) return deny('too many readings of the program word (a default or assigned word) to judge, so what it runs cannot be checked; write the command out');
  for (const line of lines) {
    if ((opts._depth ?? 0) >= 4) return deny('the command line held in a variable is nested too deeply to check');
    // run in every directory the command may be in, with the line's variables
    for (const d of dirs) {
      const r = evaluateBashForFiles(line, { ...opts, cwd: d, _assigned: ctx.assigned, _depth: (opts._depth ?? 0) + 1, _startup: ctx.startup, _vars: { ...ctx.vars }, _keptVars: { ...(ctx.keptVars ?? {}) } });
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
  let c = scriptCandidates(sf, { expand: (w) => expandRefs(w, ctx), dirs, joinPath, readDir, ifs: ctx.vars.IFS, assigned: ctx.assigned });
  // a backslash in a word is a file name character off Windows, but expandRefs reads it as a separator: expand (and glob) that reading too
  if (!c.over && !sf.unresolvable && sf.words.some((w) => mayHoldBackslash(w, ctx))) {
    const k = scriptCandidates(sf, { expand: (w) => expandKeepingBackslash(w, ctx), dirs, joinPath, readDir, ifs: ctx.vars.IFS, assigned: ctx.assigned });
    c = { files: [...new Set([...c.files, ...k.files])], dynamic: c.dynamic || k.dynamic, over: k.over };
  }
  if (c.over) return deny('too many words, a glob matching too many files, or glob syntax that cannot be resolved could be the script this command runs, so it cannot be checked; name the script file');
  // a variable the line set to a run-time value (`NVM_DIR=$(cmd)`) picks the script: which one is unknown
  // (the unknown line a SQL client may run is not a variable: it is dynamic, refused by the rule below when protected text is around)
  if (sf.words?.some((w) => [...w.matchAll(/\$\{?(\w+)/g)].some((m) => m[1] !== SQL_UNKNOWN_VAR && (ctx.unknownVars.has(m[1]) || ctx.pickUnknown.has(m[1]) || (ctx.unknownAll && !Object.hasOwn(ctx.vars, m[1])))))) return deny('the script is picked by a variable whose value is known only at run time (set to a run-time value, with a width or integer attribute, or by a sourced file that cannot be followed), so it cannot be checked; name the script file');
  if (c.dynamic && makeMatchers(ctx).rawHit(scanRaw, dirs)) return deny('which word is the script this command runs is only known at run time ($VAR / $(...) / a glob) and the line refers to a protected pipeline file; name the file and write the options literally');
  // Why: `bash $S/review-package ...` with S set on the line runs its first operand: a word made only of names the line set, with no run-time part, glob or space, not an option
  const first = sf.firstOperandRuns && sf.words?.length ? sf.ownPath ?? lineVarWord(sf.words[0], ctx) : null;
  for (const file of sf.ownPath && !c.files.includes(sf.ownPath) ? [...c.files, sf.ownPath] : c.files) {
    const v = judgeScriptFile({ kind: sf.kind, family: sf.family, file, candidate: true, ...(file === first ? { runsAsScript: true, freshBash: sf.freshBash } : {}) }, dirs, ctx, opts);
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
const LINE_BINDERS = new Set(['read', 'mapfile', 'readarray', 'getopts', 'printf', 'select', 'wait']);
const HOME_NAMES = new Set(['HOME', 'USER', 'LOGNAME', 'USERPROFILE', 'USERNAME']);

// What the text of a file run in the current shell leaves behind: { vars: Map(name -> text | null), cds: [word], all }. A name is null (unknown) when it is set
// where it may not run, more than once, from a command's output, or by a builtin that binds it at run time; `all`: the file can set any name (eval, a nested
// source, a parse cut short, a command named at run time), so no name is known any more. Only the first-level assignments are followed, not functions called later.
// the names a text defines as functions (`function f`, `f()`) or aliases
function definedNames(text) {
  const names = new Set([...text.matchAll(/(?:^|[\n;&|({])\s*function\s+([^\s(){;'"$`]+)/g), ...text.matchAll(/(?:^|[\n;&|({])\s*([^\s(){;'"$`=]+)\s*\(\s*\)/g)].map((m) => m[1]));
  for (const a of text.matchAll(/\balias\s+([^;&|\n]*)/g)) for (const m of a[1].matchAll(/(?:^|\s)([^\s=]+)=/g)) names.add(m[1]);
  return names;
}
// Why: the names a binder command sets: those it is given (an option may carry its name, `printf -vF`, `wait -pF`), the ones it binds without being given them, and a nameref's target.
// weird: a word that is not a plain name (`read "$1"`, `unset $n`): any name may be bound.
function bindsOf(name, argv) {
  const names = new Set(name === 'getopts' ? ['OPTARG', 'OPTIND'] : name === 'mapfile' || name === 'readarray' ? ['MAPFILE'] : name === 'read' || name === 'select' ? ['REPLY'] : []);
  let weird = false;
  for (const a of argv.slice(1)) {
    const m = /^[A-Za-z_]\w*/.exec(a);
    if (m) names.add(m[0]);
    else if (/^-[A-Za-z]+/.test(a)) for (let i = 1; i < a.length; i++) { const n = /^[A-Za-z_]\w*/.exec(a.slice(i)); if (n) names.add(n[0]); }
    else if (/[$`*?[{\\'"(~]/.test(a)) weird = true;
  }
  return { names, weird };
}
// `set -- a b` / `set a b`: the words that become the positional parameters (null: `set` with only options)
function setPositionals(argv) {
  const a = argv.slice(1);
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--') return a.slice(i + 1);
    if (/^[-+]o$/.test(a[i])) { i++; continue; }
    if (/^[-+]/.test(a[i])) continue;
    return a.slice(i);
  }
  return null;
}
function sourcedEffects(text, ctx) {
  const out = { vars: new Map(), cds: [], all: false, unknownCd: false };
  const cmds = simpleCommands(text, { bashState: ctx.bashState, expired: () => ctx.budget.now() > ctx.budget.deadline });
  if (cmds.truncated || cmds.dynamic) out.all = true;
  const from = flowStart(cmds);
  const seen = new Map();
  const local = Object.create(null);
  // (a function the file defines is vetted through its own body, whose commands are in the list; the definition itself shows up as a command named like the function)
  const fns = definedNames(text);
  const set = (k, v, sure) => {
    if (HOME_NAMES.has(k)) { if (k === 'HOME') out.home = true; return; } // (HOME is never believed, but a file that sets it moves `cd` / `~`)
    const n = (seen.get(k) ?? 0) + 1;
    seen.set(k, n);
    const val = sure && n === 1 && typeof v === 'string' ? substVars(v, local, ctx.budget) : null;
    if (val === null || /[$`]/.test(val)) { out.vars.set(k, null); delete local[k]; } else { out.vars.set(k, val); local[k] = val; }
  };
  for (const [i, c] of cmds.entries()) {
    const sure = !(inFlow(from, i) || c.depth > 0 || c.sep === '&&' || c.sep === '||' || c.sep === '|' || cmds[i + 1]?.sep === '|' || cmds[i + 1]?.sep === '&');
    if (!c.argv.length) { for (const [k, v] of Object.entries(c.env ?? {})) set(k, v, sure); continue; }
    const name = baseOf(c.argv[0]);
    // Why: a function or alias the LINE defines may stand behind a name that looks harmless (`ls() { read F; }`), and a nameref (`declare -n r=F`) binds F through another name
    if (ctx.lineDefs?.has(name) || (['declare', 'typeset', 'local'].includes(name) && c.argv.slice(1).some((a) => /^[-+][A-Za-z]*n/.test(a)))) { out.all = true; continue; }
    if (VAR_COMMANDS.has(name)) {
      const d = declAttrs(c.argv);
      for (const [k, v] of d.assigns) set(k, v, sure && !d.unknown && !d.transform && name !== 'local');
      for (const k of d.bare) if (d.unknown || d.transform) set(k, null, false);
    } else if (CD_CMDS.has(name)) {
      // (a target that stays a run-time value, a pattern or a brace list, `cd -`, popd, several operands: the directory is unknown from here on, not a literal; with CDPATH set -- the
      // line's, the hook's environment's, one this file set earlier or may have changed -- a relative name is searched along it)
      const t = c.argv.slice(1).find((a) => !a.startsWith('-') && a !== '/d');
      const v = t === undefined ? t : substVars(t, local, ctx.budget);
      const cdpath = (ctx.env?.CDPATH ?? '') !== '' || CDPATH_NAMES.some((n) => (ctx.vars[n] ?? '') !== '' || out.vars.has(n) || ctx.pickUnknown.has(n) || ctx.srcChanged.has(n) || (c.env?.[n] ?? '') !== '' || cmds.some((x) => x.argv.some((a) => a.startsWith(`${n}[`))));
      if (cdUnknownShape(c.argv) || (v !== undefined && /[`$*?[{]/.test(v)) || (cdpath && v !== undefined && !isAbs(toPosix(v)) && !/^(?:\.\.?(?:[\\/]|$)|~)/.test(v))) out.unknownCd = true;
      else out.cds.push(t ?? '~');
      set('PWD', null, false); set('OLDPWD', null, false); // (cd rebinds both)
    }
    else if (BINDERS.has(name)) {
      // (a name that is not a plain word -- `read "$1"`, `unset $n`, `getopts ab "$v"` -- may be any)
      // (and the names they bind without being given them)
      const b = bindsOf(name, c.argv);
      for (const k of b.names) set(k, null, false);
      if (b.weird) out.all = true;
    }
    // (the positional parameters: `set -- ev.sh` then `bash $1`)
    else if (name === 'set' && !c.argv.slice(1).some((a) => /^[-+][A-Za-z]*A/.test(a)) && setPositionals(c.argv) !== null) {
      const w = setPositionals(c.argv);
      for (let i = 1; i <= 9; i++) set(String(i), i <= w.length ? w[i - 1] : '', sure);
    }
    // (an allowlist, as for the script-directory names: a command outside it -- a zsh binder, a function the file defines, anything unknown -- may bind any name)
    else if (RUNS_CODE.has(name) || /[$`]/.test(c.argv[0]) || !(fns.has(name) || onlyNonBinders([c]) || (name === 'set' && !c.argv.slice(1).some((a) => /^[-+][A-Za-z]*A/.test(a))))) out.all = true;
  }
  // (no command of their own: an expansion that assigns, `(( N = 1 ))`, a named descriptor `{N}>file`)
  const bind = (names) => { for (const k of names) set(k, null, false); };
  for (const m of text.matchAll(/\$\{([^}]*)\}/g)) if (m[1].includes('=')) bind(m[1].match(/[A-Za-z_]\w*/g) ?? []);
  for (const m of text.matchAll(/\(\(([^)]*)\)\)/g)) if (/(?<![=!<>])=(?!=)/.test(m[1])) bind(m[1].match(/[A-Za-z_]\w*/g) ?? []);
  for (const m of text.matchAll(/\{([A-Za-z_]\w*)\}\s*(?:[<>]|&>)/g)) bind([m[1]]);
  return out;
}

// The texts of the files a sourced or startup record names (a candidate word is resolved like a script word). unknown: a file that cannot be read, is not
// one exact name, or is written by this line (so its text is only known at run time).
function sourcedTexts(rec, dirs, ctx) {
  const texts = [];
  let unknown = !!(rec.joined || rec.unresolvable);
  const consider = (abs) => {
    // Why: a file the line writes earlier (`echo D=/tmp > rc; . ./rc`) is what those writes put there, not what is on disk now; a write may also fail or be skipped, so the disk text stays a case too
    const w = writtenTo(ctx.frames, abs, { exists: (x) => ctx.api.existsSync(x), readText: ctx.readText, ignoreUnmodelled: false });
    if (w) {
      if (w.unknown || w.pieces || w.authored || w.files.length || w.scans.length || w.programs.length) unknown = true;
      texts.push(...w.texts, ...w.joined);
    }
    const t = ctx.readText(abs);
    if (typeof t === 'string') { texts.push(t); return; }
    if (ctx.api.existsSync(abs)) { if (!ctx.readDir(abs)) unknown = true; return; }
    if (w) { if (!w.texts.length && !w.joined.length) unknown = true; }
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
    const c = scriptCandidates(rec, { expand: (w) => expandRefs(w, ctx), dirs, joinPath, readDir, ifs: ctx.vars.IFS, assigned: ctx.assigned });
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
  const poison = () => { ctx.unknownAll = true; ctx.sourcedCdUnknown = true; for (const k of Object.keys(ctx.vars)) { ctx.pickUnknown.add(k); ctx.srcChanged.add(k); } };
  if (unknown) poison();
  const merged = new Map();
  const effs = [];
  for (const t of texts) {
    const eff = sourcedEffects(t, ctx);
    if (eff.all) poison();
    if (eff.home) ctx.homeSourced = true; // (a bare `cd` / `cd ~` / `~/x` then goes elsewhere)
    if (eff.unknownCd) ctx.sourcedCdUnknown = true; // (a cd the file does into a directory only known at run time: the line's directory is unknown from here)
    effs.push(eff);
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
  // Why: one of several files runs (a glob, a written file and the one on disk): a name that not every one sets keeps its old value in the others, so it is not definite
  if (effs.length > 1) for (const k of merged.keys()) if (!effs.every((e) => e.vars.has(k))) merged.set(k, null);
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
// Why: see evaluateGitCommand: the first (outermost) call owns the BASH rewrite record; a text that binds BASH after another was rewritten makes the verdict stale, so the line is judged again with the rewrite off.
function evaluateBashForFilesUnchecked(command, opts = {}) {
  if (!opts._bashState) {
    const state = { bound: false, rewrote: false };
    const budget = opts._budget ?? newEvalBudget(opts.now);
    const first = evaluateBashForFilesUnchecked(command, { ...opts, _budget: budget, _bashState: state });
    if (first.decision === 'deny' || !(state.bound && state.rewrote)) return first;
    // (the second pass spends what the first left, so every cap still ends in a denial; only the startup-file memo starts empty)
    return evaluateBashForFilesUnchecked(command, { ...opts, _budget: { ...budget, startupOk: new Set() }, _bashState: { bound: true, rewrote: false } });
  }
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
  ctx.lineDefs = definedNames(typeof command === 'string' ? command : '');
  ctx.assigned = assigningDefaults(typeof command === 'string' ? command : ''); // (and those of the line this text was made from: `: ${X:=w}; G=bash; $G $X`)
  for (const [n, ws] of opts._assigned ?? []) ctx.assigned.set(n, [...(ctx.assigned.get(n) ?? []), ...ws]);
  opts = { ...opts, _selfZero: null, _selfBash: null, _selfAbs: false, _selfZsh: false }; // (only the script file judged right now has a $0; text it runs or reads has none)
  if (ctx.admin) return allow();
  const raw = typeof command === 'string' ? command : '';
  if (!raw.trim()) return allow();
  // the words a `${X:=w}` on the line (or the line this text came from) may have assigned: a later $X may be any of them
  ctx.assigned = new Map([...(opts._assigned ?? [])].map(([n, ws]) => [n, [...ws]]));
  for (const [n, ws] of assigningDefaults(raw)) ctx.assigned.set(n, [...new Set([...(ctx.assigned.get(n) ?? []), ...ws])]);
  if (raw.length > MAX_LINE_CHARS) {
    // too long to scan in the time budget: judged by what it mentions once quotes and escapes are removed
    return SENSITIVE_WORDS.test(raw.replace(/['"`\\]/g, '')) ? deny('the command line is too long to check and mentions a protected pipeline file or switch; split it into simpler commands') : allow();
  }

  // 1 and 2: the admin switch and the hook switch, however the words are quoted or escaped
  const flat = raw.replace(/['"`]\s*\+\s*['"`]/g, '').replace(/['"`\\]/g, ''); // 'PIPELINE_'+'ADMIN' reads as one word
  if (variantsOf(raw).some((t) => setsAdmin(t, ctx.platform) || setsAdmin(t.replace(/['"`]\s*\+\s*['"`]/g, '').replace(/['"`\\]/g, ''), ctx.platform))) return deny('the command sets PIPELINE_ADMIN; only the owner may set it, when launching Claude Code (naming it, e.g. in grep or prose, is fine)');
  if (hasDisableAll(raw) || hasDisableAll(flat)) return deny('the command mentions disableAllHooks, which would switch the pipeline hooks off');

  const cmds = simpleCommands(raw, { env: opts.env ?? process.env, bashState: opts._bashState, expired: () => opts._budget.now() > opts._budget.deadline }); // a scan that outlasts the deadline gives up: truncated, so denied
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
  modelZshSelfDirs(cmds, raw, ctx);
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
  const snaps = []; // per command: the names a sourced file may have changed / set at run time as that command runs (the checks after the loop would otherwise see the end state)
  // Is the directory the line works in only known at run time? (a `cd` into an unset / substituted / maybe-changed name, `cd -`, `popd`; or the frame was started in one)
  const unknownCwd = () => {
    if (assumedCwd) return false; // (a rerun that already assumes a directory: the unknown cd is what it stands for)
    if (opts._unknownCwd === true || ctx.sourcedCdUnknown) return true;
    const KNOWN = new Set(['HOME', 'USER', 'LOGNAME']);
    const closures = new Map();
    // (the state when the cd ran, or by the end of the line: a later plain assignment does not clean an earlier cd)
    const stateAt = (ci) => {
      const sn = snaps[ci];
      const base = unique([...ctx.srcChanged, ...(sn?.changed ?? [])]).sort();
      const live = base.length > 0 || ctx.unknownAll;
      const key = base.join('\u0000');
      if (!closures.has(key)) closures.set(key, live ? taintClosure(base, cmds, {}, newName, true) : new Set());
      const tainted = closures.get(key);
      const unk = (n) => ctx.unknownVars.has(n) || sn?.unknownV.has(n);
      return {
        unknownName: (n) => tainted.has(n) || newName(n) || unk(n) || ctx.pickUnknown.has(n) || (!KNOWN.has(n) && !Object.hasOwn(ctx.vars, n)),
        moved: (n) => tainted.has(n) || base.includes(n) || ctx.pickUnknown.has(n) || unk(n),
      };
    };
    const moved = (n) => stateAt(-1).moved(n) || Object.keys(snaps).some((ci) => stateAt(Number(ci)).moved(n));
    // Why: HOME is never believed from the line (the guard reads `~` as the real home), so a line that sets it, or a source that may, leaves `cd` / `cd ~` / `cd ~/x` without a known target
    const homeMoved = ctx.unknownAll || ctx.homeSourced === true || moved('HOME') || cmds.some((c) => Object.hasOwn(c.env ?? {}, 'HOME') || c.argv.some((a) => /^HOME(?:=|\[|$)/.test(a)));
    // Why: with CDPATH set a relative `cd sub` goes to the first CDPATH entry that has `sub` (the line's, the environment's, one a source may have set)
    const cdpathSet = (startupEnv.CDPATH ?? '') !== '' || CDPATH_NAMES.some((n) => (Object.hasOwn(ctx.vars, n) && ctx.vars[n] !== '') || moved(n) || cmds.some((c) => (c.env?.[n] ?? '') !== '' || c.argv.some((a) => a.startsWith(`${n}[`))));
    return cmds.some((c, ci) => {
      const cn = baseOf(c.argv[0] ?? '');
      if (!CD_CMDS.has(cn)) return false;
      if (readsOnlyInSubshell(c, cmds, ctx) || (ctx.selfZero && nothingWritesAfterCd(ci, cmds, ctx))) return false; // (a cd the line or a sourced file ends with: the next command goes on there)
      const { unknownName } = stateAt(ci);
      if (cdUnknownShape(c.argv)) return true;
      const t = c.argv.slice(1).find((a) => !a.startsWith('-') && a !== '/d');
      if (t !== undefined && modelledCd(t, cmds, ci, ctx) !== null) return false;
      if (t === undefined || /^~(?:\/|$)|^\$\{?HOME\b/.test(t)) { if (homeMoved) return true; if (t === undefined) return false; } // (a bare cd goes home)
      const e = expandRefs(t, ctx);
      if (/[*?[{(]/.test(e) && resolveGlobCd(e, dirs, ctx, cmds, ci) === null) return true; // (a glob or a brace list can spell ~/.claude: `cd ~/.cl*`)
      if (/[`$]/.test(e) || /\$\{!/.test(t) || /[`]|\$\(/.test(t)) return true;
      if (cdpathSet && !isAbs(e) && !/^\.\.?(?:\/|$)/.test(e)) return true;
      return [...t.matchAll(/\$\{?(\w+)/g)].some((x) => unknownName(x[1]));
    });
  };
  const withLineVars = (o, c = null) => ({ ...o, _unknownCwd: unknownCwd(), _vars: { ...ctx.vars }, _keptVars: { ...(ctx.keptVars ?? {}) }, _unknown: new Set([...ctx.unknownVars, ...ctx.pickUnknown]), _unknownW: new Set(ctx.unknownVars), _srcChanged: taintClosure(ctx.srcChanged, cmds, c?.env ?? {}, newName, ctx.srcChanged.size > 0 || ctx.unknownAll), _unknownAll: ctx.unknownAll, _assigned: ctx.assigned });

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
      const seed = { ...opts, _ignoreUnmodelled: true, _depth: 0, _assigned: ctx.assigned, _vars: { ...ctx.vars }, _keptVars: { ...(ctx.keptVars ?? {}) }, _unknown: new Set(unknown) };
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
  // Why: after a cd into a directory only known at run time a relative script may be in the directories the line knows OR in any protected one (or above one): each is looked in
  // Why: a binder on the line (`read F`, `mapfile`, `getopts`, `printf -v F`, a nameref's target) gives its names a run-time value: a script they pick is refused, and a writer that uses a name the line had
  // given a value is refused, whatever the line assigned before. Applied as the command is reached (a name the line gave a value is also in unknownVars, which the per-command snapshots carry, so a loop binder reaches the commands above it and a later plain assignment does not clean an earlier use).
  const markBound = (c) => {
    if (!c.argv.length) return;
    const cn = baseOf(c.argv[0]);
    const names = [];
    if (LINE_BINDERS.has(cn) && (cn !== 'printf' || c.argv.some((a) => /^-v/.test(a)))) names.push(...bindsOf(cn, c.argv).names);
    if (['declare', 'typeset', 'local'].includes(cn) && c.argv.slice(1).some((a) => /^-[A-Za-z]*n/.test(a))) for (const a of c.argv.slice(1)) { const t = /^[A-Za-z_]\w*=([A-Za-z_]\w*)/.exec(a); if (t) { names.push(t[1]); ctx.declared?.unknown.add(t[1]); } }
    for (const k of names) { ctx.pickUnknown.add(k); if (Object.hasOwn(ctx.vars, k)) ctx.unknownVars.add(k); }
  };
  const sdirsNow = () => (unknownCwd() ? unique([...dirs, ...assumedCwds(ctx)]) : dirs); // (a sourced file may make the directory unknown part-way through the line)
  if ((opts._depth ?? 0) < 4) {
    for (const [idx, c] of cmds.entries()) {
      frame.i = idx;
      if (ctx.srcChanged.size || ctx.unknownVars.size) snaps[idx] = { changed: new Set(ctx.srcChanged), unknownV: new Set(ctx.unknownVars) }; // (what is true when this command runs: a later plain assignment must not clean it)
      opts._fsChanged = ctx.parentFsChanged || mayChangeListing(cmds, idx, ctx); // (a script or -c text this command runs sees the listing after the earlier commands)
      if (!c.argv.length && (ctx.unknownVars.size || ctx.pickUnknown.size || ctx.srcTouched.size) && c.sep !== '&&' && c.sep !== '||' && c.depth === 0 && !inFlow(flowStart(cmds), idx)) {
        for (const k of Object.keys(c.env ?? {})) if ((ctx.unknownVars.has(k) || ctx.pickUnknown.has(k) || ctx.srcTouched.has(k)) && !/[$`]/.test(c.env[k]) && !ctx.declared?.unknown.has(k)) { ctx.unknownVars.delete(k); ctx.pickUnknown.delete(k); ctx.srcChanged.delete(k); ctx.vars[k] = applyTransform(expandRefs(c.env[k], ctx), ctx.declared?.transform.get(k) ?? null); }
      }
      markBound(c);
      if (splicesOptions(c.argv)) { const v = judgeSplices(c, sdirsNow(), ctx, withLineVars(opts, c)); if (v) return v; }
      const sf0 = scriptFileOf(c.argv, c.raw, raw);
      // Why: superpowers' task-brief runs `"${BASH:-bash}" "$(cd "$(dirname "$0")" && pwd)/sdd-workspace"`, and is run as `S=…/scripts; bash $S/task-brief`. The operand right
      // after the shell, built from the judged script's own directory or only from names the line set, is no option in either reading (its value, or the word as written when
      // quotes kept it literal), so the shell is no login shell reading ~/.bash_profile: the startup files are those of `bash FILE`. The own-directory path is also judged as a
      // candidate (the word's other readings still are). A value with a space or a glob character would split or match: unchanged.
      const ownWord = sf0?.ambiguous && sf0.kind === 'shell' && !sf0.joined && c.argv[1] === sf0.words?.[0] && !['source', '.', 'eval'].includes(baseOf(c.argv[0] ?? '')) && !/^[-+]/.test(c.argv[1])
        ? { self: selfPathWord(sf0.words[0], cmds, idx, ctx), line: lineVarWordAt(sf0.words[0], ctx, cmds, raw) } : null;
      const plain = (p) => p !== null && !/[\s*?[\]{}~$`\\]|^[-+]/.test(p);
      const own = ownWord && (plain(ownWord.self) ? ownWord.self : plain(ownWord.line) ? ownWord.line : null);
      const cs = own ? { ...c, argv: c.argv.map((w, i) => (i === 1 ? own : w)) } : c;
      const sf = sf0;
      if (own && ownWord.self === own) sf.ownPath = own;
      const withPath = (rec) => { if (sourcePathSearch(rec, c.argv, cmds)) { rec.ambiguous = true; rec.words ??= [rec.file]; rec.pathSearch = true; } if (rec.words?.some(isEqualsWord) || rec.pathSearch) rec.pathValues = pathValuesOf(c, cmds, { env: startupEnv, inherited: inheritedStartup }); return rec; }; // (zsh `=tool`: the PATH directories to look in)
      if (sf) withPath(sf);
      // a shell runs its startup files (BASH_ENV, ENV, ZDOTDIR/.zshenv ...) BEFORE the script it was given, so they are judged first, in the
      // order the shell reads them: judged like `bash FILE`
      // Why: a startup file runs in the CHILD shell, so what it sets is the script's, not the rest of this line's: the effects are taken back once the child is judged (only `source` / `.` change this shell)
      let undo = null;
      const sts = startupFilesOf(cs, cmds, { env: startupEnv, inherited: inheritedStartup, exec: sf?.kind === 'exec' });
      // Why: bash sets BASH to its own path when it starts, whatever its parent exported (zsh and dash keep the parent's): in a script run by plain bash, only the script
      // and what it sources can bind BASH, not words elsewhere on this line (`grep "export type X\|..."` once made `"${BASH:-bash}"` in superpowers' task-brief unknown).
      // Such a script keeps a BASH record of its own (the same two passes as a whole line), unless that bash reads a startup file first (BASH_ENV, a login shell:
      // it may bind BASH) or the line may change which program `bash` is (PATH).
      const pathMoved = Object.hasOwn(ctx.vars, 'PATH') || ctx.unknownAll || ctx.srcChanged.has('PATH') || cmds.some((x) => Object.hasOwn(x.env ?? {}, 'PATH') || x.argv.some((a) => /^PATH(?:\+?=|\[)/.test(a)));
      if (sf && sts.length === 0 && !pathMoved && /^(?:bash|\/(?:usr\/(?:local\/)?)?bin\/bash|\/opt\/homebrew\/bin\/bash)$/.test(cs.argv[0] ?? '')) sf.freshBash = true;
      for (const st of sts) {
        const v = judgeStartupFile(st);
        if (v) return v;
        if (!st.implicit) { undo ??= snapshotShell(ctx); absorbSourced(st, dirs, ctx); } // (the shell that runs the script read it first: its cds and variables are the script's)
      }
      if (sf) {
        // (a program run by path is judged with the command that runs it: its shebang may name a shell, which reads startup files of its own)
        const outer = ctx.execCmd;
        ctx.execCmd = sf.kind === 'exec' ? { c: cs, cmds, env: startupEnv, inherited: inheritedStartup } : null;
        // (only a file the command runs as a script has a $0 and BASH_SOURCE of its own path: not a sourced one, a fed one, a glob / candidate record or a -c text; a variable-named first operand is marked for the candidate judgment)
        const runsFile = (sf.kind === 'shell' || sf.kind === 'exec') && !sf.candidate && !sf.joined && !['source', '.', 'eval'].includes(baseOf(cs.argv[0] ?? '')) && !cs.argv.some((w) => /^-[A-Za-z]*[cs]$/.test(w));
        if (runsFile) { if (sf.ambiguous) sf.firstOperandRuns = true; else { sf.runsAsScript = true; if (cs.argv[1] === sf.file) sf.runShell = baseOf(cs.argv[0]); } } // (runShell: the shell word of a plain `zsh file`; a program run by path takes its shebang's)
        const sfj = sf;
        let v;
        try {
          v = judgeScriptFile(sfj, sdirsNow(), ctx, withLineVars(opts, c), scanRaw);
        } finally {
          ctx.execCmd = outer;
        }
        if (v) return v;
        if (sf.kind === 'shell' && ['source', '.'].includes(baseOf(c.argv[0] ?? ''))) absorbSourced(sf, dirs, ctx); // (a sourced file runs in this shell: what it sets is the line's from here)
      }
      // script text that reaches a shell without being named (`bash < f.sh`, `cat f.sh | bash`, `eval "$(cat f.sh)"`): its files are judged like `bash f.sh`
      for (const fd of scriptFeedsOf(c, raw, (w) => expandRefs(w, ctx))) {
        withPath(fd);
        const v = judgeScriptFile(fd, sdirsNow(), ctx, withLineVars(opts, c), scanRaw);
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
  const insideRoot = opts._writesOnly !== true && dirs.some((d) => ctx.hit(d) || ctx.hitAncestor(d)); // cwd or a `cd` target is a protected dir (or its parent): relative words and bare commands reach it
  const protectedInRaw = m.rawHit(scanRaw, dirs);

  // a path built from a name whose value is only known at run time (typeset -L4 D=...) may be anywhere: a writer or a redirection that uses it is refused
  if (ctx.unknownVars.size || snaps.some((x) => x?.unknownV.size)) {
    for (const [ci, c] of cmds.entries()) {
      const refs = (w) => [...String(w).matchAll(/\$\{?(\w+)/g)].some((x) => ctx.unknownVars.has(x[1]) || snaps[ci]?.unknownV.has(x[1]));
      if ((c.redirects ?? []).some((r) => WRITE_OPS.has(r.op) && refs(r.target ?? '')) || (c.argv.length && !['export', 'declare', 'typeset', 'local', 'readonly'].includes(baseOf(c.argv[0])) && !isReadOnly(c, ctx) && (c.argv.some(refs) || Object.values(c.env ?? {}).some(refs)))) {
        return deny('the command writes through a variable whose value is only known at run time (a width or integer attribute), so the file it reaches cannot be checked; write the path out');
      }
    }
  }

  // Why: a name an unfollowable sourced file may have changed (`D=/tmp; source $X; echo x > $D/settings.json`) may hold ~/.claude by now: a write target that uses it
  // is unknown, so a redirection or a writer that names it is refused, whatever the rest of the path (names are the line's own choice, none is exempt). Not write targets: the
  // operand of a command that runs a script (`source $X`, `bash $F`), a reader, `cd`, a declaration, and an element of a path-list variable's value (`PATH=$D:$PATH`).
  if (ctx.srcChanged.size || ctx.unknownAll || snaps.some((x) => x?.changed.size)) {
    const taints = new Map();
    const taintFor = (ci) => { // (the names changed when the command ran, or by the end of the line: a later `D=/tmp` does not clean an earlier write; a later source covers a loop)
      const base = unique([...ctx.srcChanged, ...(snaps[ci]?.changed ?? [])]).sort();
      const key = base.join('\u0000');
      if (!taints.has(key)) taints.set(key, taintClosure(base, cmds, {}, newName, true));
      return taints.get(key);
    };
    const PATH_LISTS = new Set(['PATH', 'CDPATH', 'MANPATH', 'INFOPATH', 'LD_LIBRARY_PATH', 'DYLD_LIBRARY_PATH', 'NODE_PATH', 'PYTHONPATH']); // (search lists only: go writes under GOPATH)
    for (const [ci, c] of cmds.entries()) {
      const taint = taintFor(ci);
      const maybeChanged = (n) => taint.has(n) || newName(n);
      const changed = (w) => /\$\{!/.test(String(w)) || [...String(w).matchAll(/\$\{?(\w+)/g)].some((x) => maybeChanged(x[1])); // (`${!X}` names a variable by the value of X)
      const taintedEnv = (w) => [...String(w).matchAll(/\$\{?(\w+)/g)].some((x) => taint.has(x[1])); // (a prefix value: only a name known to be changed; an unset one is judged in the child that gets it, `BASH_ENV=$Q bash x.sh` stays allowed)
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
    // (a script or fed file named relative to the unknown directory is judged where it may be: step 7 looks in the protected directories too; inline code is judged by its own text)
    // Why: the directory may be BELOW a protected root (`cd $X` into ~/.claude/pipeline/hooks), where `echo x > ../guard.mjs` lands inside the root. With k = the `..` segments of the
    // relative write targets plus those of the `cd` steps, the line is also rerun with the cwd in each existing subdirectory of each protected root down to depth k (writes only).
    const ups = (w) => (typeof w === 'string' ? braceExpand(expandRefs(w, ctx), ctx).split(/\s+/).map((x) => (x && !isAbs(toPosix(x)) && !/^~(?:\/|$)/.test(x) ? toPosix(x).split('/').filter((s) => s === '..').length : 0)) : [0]);
    let cdUps = 0;
    let writeUps = 0;
    for (const c of cmds) {
      for (const r of c.redirects ?? []) {
        if (!WRITE_OPS.has(r.op)) continue;
        writeUps = Math.max(writeUps, ...ups(r.target));
        // (a relative target that still holds a run-time part may climb as far as it likes)
        const e = expandRefs(r.target ?? '', ctx);
        if (/[`$]/.test(e) && !isAbs(toPosix(e)) && !/^~(?:\/|$)/.test(e) && !FD_DUP.test(e)) return deny('the command redirects output to a relative path with a part only known at run time after a cd into a directory known only at run time, so the file it reaches cannot be checked; write the path out');
      }
      if (!c.argv.length) continue;
      if (CD_CMDS.has(baseOf(c.argv[0]))) cdUps += Math.max(0, ...c.argv.slice(1).flatMap(ups));
      else if (!isReadOnly(c, ctx)) writeUps = Math.max(writeUps, ...c.argv.slice(1).flatMap((w) => ups(w.replace(/^-{0,2}[\w-]+=/, ''))));
    }
    const depth = writeUps > 0 || cdUps > 0 ? writeUps + cdUps : 0;
    const below = [];
    if (depth > 0) {
      let level = ctx.lexRoots.filter((r) => Array.isArray(ctx.readDir(r)));
      for (let n = 0; n < depth && level.length; n++) {
        const next = [];
        for (const d of level) {
          for (const name of ctx.readDir(d) ?? []) {
            const sub = posix.join(d, name);
            if (!Array.isArray(ctx.readDir(sub))) continue;
            if (below.length >= MAX_BELOW_ROOT_DIRS) return deny('the command writes through a relative path with `..` after a cd into a directory known only at run time, and the protected directories hold too many subdirectories to check it in each; write the directory out');
            below.push(sub);
            next.push(sub);
          }
        }
        level = next;
      }
      // (the listing ran out before depth k: a command on the line may make the directories a deeper cwd would need)
      if (!level.length && cmds.some((c) => c.argv.length > 0 && MAKES_DIRS.has(baseOf(c.argv[0])))) return deny('the command writes through a relative path with `..` after a cd into a directory known only at run time, and the line may create directories below a protected one, so it cannot be checked; write the directory out');
    }
    const at = ctx.frames.indexOf(frame);
    for (const d of unique([...assumedCwds(ctx), ...below])) {
      countCdRun(ctx.budget);
      const r = evaluateBashForFiles(command, { ...opts, cwd: d, _assumedCwd: true, _writesOnly: true, _unknownCwd: false, _frames: ctx.frames.slice(0, at).map((f) => ({ ...f, recs: [...f.recs] })) });
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
      if (/[`$]/.test(e) && dirs.some((d) => ctx.hit(d) || ctx.hitAncestor(d) || ctx.hitTree(d))) return deny(`the command redirects output to ${target}, a name only known at run time, inside a protected pipeline directory, so the file it reaches cannot be checked; write the path out (${PROTECTED_MSG})`);
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
  // Why: in a rerun that assumes the directory (after a cd only known at run time) every relative word resolves inside the assumed protected directory (`npm`, `test`), so a word counts only when it can name
  // a protected file: one that exists there, a new name in a directory that exists there (it has a `/`), or the name of a protected file or directory itself
  const leaves = new Set(ctx.lexRoots.map((q) => posix.basename(q)));
  const plausible = opts._writesOnly === true ? (full, e) => ctx.api.existsSync(full) || (e.includes('/') && ctx.api.existsSync(posix.dirname(full))) || leaves.has(posix.basename(full)) || /^\.{1,2}\/?$|\/$/.test(e) : null;
  const tokenHit = (t) => m.rawHit(t, dirs) || m.pathHit(t, dirs, true, plausible);
  const tokenHitAll = (t) => m.rawHit(t, dirs) || m.pathHit(t, dirs, true);
  // does the command name a protected file anywhere (source or destination)?
  const names = (c) => insideRoot
    || m.rawHit(rawOfCmd(c), dirs) || winAncestor(c)
    || Object.values(c.env).some((v) => m.rawHit(v, dirs))
    || (!tooMany && opts._writesOnly !== true && wordsOf(c).some(tokenHit)); // (a rerun that only assumes a directory judges writes: a bare word that resolves into it names nothing)
  // does it WRITE one? cp / rsync / install only write their destination
  const mentions = (c) => {
    const name = baseOf(c.argv[0] ?? '');
    if (insideRoot) return true;
    // (inline interpreter code that writes can build any name there)
    if (opts._writesOnly === true && (impliesCwdWrite(c) || (runsInlineCode(c, ctx) && WRITE_HINT.test(c.raw ?? c.argv.join(' '))))) return true;
    // (a destination word is never filtered: a writer may create a protected name that does not exist yet)
    if (DEST_ONLY.has(name)) return destsOf(wordsOf(c), name).some(tokenHitAll);
    return names(c) || (MOVERS.has(name) && destsOf(wordsOf(c), name).some(tokenHitAll));
  };
  const mentioning = cmds.filter(mentions);
  // Why: below ~/.claude (projects/, skills/other) nothing is protected by name, yet a destination built at run time (`cp x "$V"`, `tee $(echo ../settings.json)`) can climb back to a protected file:
  // refused for every command that is not read-only (FP: a command with a run-time word, run from inside ~/.claude/**)
  if (!insideRoot && opts._writesOnly !== true && dirs.some((d) => ctx.hitTree(d))) {
    const w = cmds.find((c) => c.argv.length && !NOT_WRITERS.has(baseOf(c.argv[0])) && !isReadOnly(c, ctx) && c.argv.slice(1).some((a) => /[`$]/.test(expandRefs(a, ctx))));
    if (w) return deny(`${baseOf(w.argv[0])} is given a name only known at run time inside the protected pipeline tree, so the file it reaches cannot be checked; write the path out (${PROTECTED_MSG})`);
  }
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
