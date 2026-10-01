// Why: the owner's rule is that agents must not edit their own rules. This is the pure decision logic of the
// global guard-files hook: it denies file tools and Bash commands that would change the installed pipeline
// files (skills, agents, ~/.claude/pipeline, ~/.claude/settings.json), switch hooks off (`disableAllHooks`) or
// write the admin switch (`PIPELINE_ADMIN`) into a script. Only a Claude Code process that was launched with
// PIPELINE_ADMIN=1 bypasses it. Bash is judged on text, so every check is deliberately over-eager (a harmless
// `echo ~/.claude/pipeline` is denied) rather than under-eager; the hook stops accidents and casual
// circumvention, not an adversary who builds the path at run time.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { toPosix, expandHome, isInside, samePath } from '../../lib/paths.mjs';
import { simpleCommands } from './shell-parse.mjs';

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

const DEVICE_PREFIX = /^\/\/[?.]\/(?=[A-Za-z]:\/)/; // \\?\C:\ and \\.\C:\ forms

const isAbs = (s) => s.startsWith('/') || /^[A-Za-z]:\//.test(s);
const caseInsensitive = (platform) => platform === 'win32' || platform === 'darwin';
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const unique = (a) => [...new Set(a)];
const baseOf = (w) => String(w).split(/[\\/]/).pop().toLowerCase().replace(/\.(exe|cmd|bat|com)$/, '');
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
function rootAliases(home, platform) {
  const roots = protectedRoots(home);
  if (platform !== 'win32') return roots;
  const m = /^([A-Za-z]):(\/.*)?$/.exec(posixHome(home));
  if (!m) return roots;
  const d = m[1].toLowerCase();
  const extra = [];
  for (const r of roots) {
    const rest = r.slice(2);
    extra.push(`/${d}${rest}`, `/mnt/${d}${rest}`, `/cygdrive/${d}${rest}`);
  }
  return [...roots, ...extra];
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
  const lexRoots = protectedRoots(homePosix);
  const realRoots = lexRoots.map((r) => realResolve(r, api));
  const roots = unique([...rootAliases(homePosix, platform), ...realRoots]);
  const ci = caseInsensitive(platform);
  return {
    platform, homeNative, homePosix, cwd, api, roots, lexRoots, ci,
    admin: opts.env?.PIPELINE_ADMIN === '1',
    hit: (p) => roots.some((r) => isInside(p, r, platform)),
  };
}

// ---- content rules (file tools and Bash share them) -----------------------------------------------

function unescapeJs(s) {
  return s.replace(/\\u\{([0-9a-fA-F]+)\}|\\u([0-9a-fA-F]{4})|\\x([0-9a-fA-F]{2})/g, (m, a, b, c) => {
    try { return String.fromCodePoint(parseInt(a || b || c, 16)); } catch { return m; }
  });
}

// PIPELINE_ADMIN is case-sensitive on POSIX; Windows environment variable names are not.
const hasAdminToken = (text, platform) => (platform === 'win32' ? /PIPELINE_ADMIN/i : /PIPELINE_ADMIN/).test(text);
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

export function evaluateFileTool(input, opts = {}) {
  const ctx = makeCtx({ ...opts, cwd: input?.cwd });
  if (ctx.admin) return allow();
  const ti = input?.tool_input ?? {};
  const texts = writtenTexts(ti).flatMap(variantsOf);

  const target = typeof ti.file_path === 'string' && ti.file_path ? ti.file_path : (typeof ti.notebook_path === 'string' ? ti.notebook_path : '');
  if (target) {
    const lexical = lexicalTarget(target, ctx);
    const candidates = unique([lexical, realResolve(lexical, ctx.api)]);
    for (const c of candidates) {
      if (ctx.hit(c)) return deny(`${target} is a protected pipeline file (skills, agents, ~/.claude/pipeline and ~/.claude/settings.json can only be changed by the owner with PIPELINE_ADMIN=1)`);
    }
    if (texts.some(hasDisableAll)) {
      for (const c of candidates) {
        const parent = posix.basename(posix.dirname(c));
        const inClaudeDir = ctx.ci ? parent.toLowerCase() === '.claude' : parent === '.claude';
        if (inClaudeDir && SETTINGS_RE.test(posix.basename(c))) return deny(`writing disableAllHooks into ${target} would switch the pipeline hooks off`);
      }
    }
  }
  if (texts.some((t) => hasAdminToken(t, ctx.platform))) {
    return deny('writing PIPELINE_ADMIN into a file could build a script that switches the guard off; admin mode is for the owner to set when launching Claude Code');
  }
  return allow();
}

// ---- Bash: text normalisation ---------------------------------------------------------------------

// Every way the home directory is spelled in a shell line or a one-liner script. A trailing `+ '` or `, '`
// (string concatenation / path.join) is swallowed so `process.env.HOME+'/.claude/x'` reads as one path.
const HOME_RE = new RegExp(
  '(?:'
  + [
    'process\\.env\\.(?:HOME|USERPROFILE)\\b',
    'process\\.env\\[\\s*[\'"](?:HOME|USERPROFILE)[\'"]\\s*\\]',
    '\\bos\\.homedir\\(\\s*\\)',
    '\\bhomedir\\(\\s*\\)',
    '\\bPath\\.home\\(\\s*\\)',
    'os\\.environ(?:\\.get\\(|\\[)\\s*[\'"](?:HOME|USERPROFILE)[\'"]\\s*[)\\]]',
    'os\\.path\\.expanduser\\(\\s*[\'"]~[\'"]\\s*\\)',
    '\\$env:(?:USERPROFILE|HOME)\\b',
    '%USERPROFILE%',
    '%HOMEDRIVE%%HOMEPATH%',
    '\\$\\{(?:HOME|USERPROFILE)\\}',
    '\\$(?:HOME|USERPROFILE)(?![A-Za-z0-9_])',
  ].join('|')
  + ')(\\s*[+,]\\s*[\'"`])?',
  'gi',
);
const TILDE_RE = /(^|[\s'"`=:(,[{;|&<>+])~(?=\/|$|[\s'"`)\]};|&<>,+])/g;

function expandHomeRefs(text, home) {
  return text
    .replace(HOME_RE, (_m, glue) => home + (glue ? (glue.includes('+') ? '' : '/') : ''))
    .replace(TILDE_RE, (_m, pre) => pre + home);
}

// Expands the first `{a,b}` groups of each word so `~/.claude/{pipeline,settings.json}` shows both paths.
function braceExpand(s) {
  if (s.length > 50_000 || !s.includes('{') || !s.includes(',')) return s;
  let cur = s;
  for (let round = 0; round < 4; round++) {
    let changed = false;
    cur = cur.replace(/(\S*?)\{([^{}\s]*,[^{}\s]*)\}(\S*)/g, (_m, pre, body, post) => {
      changed = true;
      return body.split(',').map((x) => pre + x + post).join(' ');
    });
    if (!changed || cur.length > 200_000) break;
  }
  return cur;
}

// Slash-normalised, home-expanded copies of `text` (several readings of string glue) to look for protected paths in.
function refVariants(text, ctx) {
  const v0 = expandHomeRefs(toPosix(text), ctx.homePosix);
  const v1 = v0.replace(/['"`]\s*\+\s*['"`]/g, '').replace(/['"`]\s*,\s*['"`]/g, '/');
  return unique([v0, v1, braceExpand(v0)]);
}

// A root counts only on a path-segment boundary: `/ship` must not match `/shipping`. The preceding-character
// test lets `-C/path` (a flag with an attached value) through but not `/mnt/home/u/...`.
function rootRegexes(ctx) {
  return ctx.roots.map((r) => new RegExp(`(?:(?<![\\w.~])|(?<=\\s-[A-Za-z]))${escapeRe(r)}(?![\\w.\\-])`, ctx.ci ? 'i' : ''));
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
  const ancestors = rootsAndAncestors(ctx);
  const rawHit = (text) => !!text && refVariants(String(text), ctx).some((v) => rootRes.some((re) => re.test(v)));

  const globHit = (g) => {
    const star = g.search(/[*?[]/);
    const lit = g.slice(0, g.lastIndexOf('/', star) + 1) || '/';
    if (ctx.hit(lit)) return true;
    const re = globToRe(g, ctx.ci);
    return !!re && ancestors.some((a) => re.test(a));
  };

  // A word that, resolved against any directory the command line has been in, lands inside a protected root.
  // Catches what the textual scan cannot: `..` segments and relative paths after `cd`.
  const pathHit = (tok, dirs) => {
    let parts = [tok];
    if (tok.startsWith('-')) {
      const eq = tok.indexOf('=');
      parts = eq > 0 ? [tok.slice(eq + 1)] : [];
    }
    for (const part of parts) {
      if (!part) continue;
      const e = expandHomeRefs(toPosix(part), ctx.homePosix);
      const bases = isAbs(e) ? [''] : dirs;
      for (const d of bases) {
        const full = isAbs(e) ? posix.normalize(e) : posix.join(d, e);
        if (/[*?[]/.test(full) ? globHit(full) : ctx.hit(full)) return true;
      }
    }
    return false;
  };
  return { rawHit, pathHit };
}

// ---- Bash: command classification -----------------------------------------------------------------

const READ_ONLY = new Set(['cat', 'head', 'tail', 'less', 'more', 'ls', 'stat', 'wc', 'grep', 'rg', 'diff', 'cmp', 'shasum', 'sha256sum', 'sha1sum', 'md5', 'md5sum', 'file', 'readlink', 'realpath', 'test', '[']);
const PS_READ_ONLY = new Set(['get-content', 'get-childitem', 'gc', 'gci']);
const GIT_READ_ONLY = new Set(['log', 'show', 'diff', 'status', 'ls-files', 'blame']);
const CD_CMDS = new Set(['cd', 'pushd', 'popd', 'set-location', 'sl']);
const FIND_UNSAFE = /^-(?:delete|exec|execdir|ok|okdir|fprint0?|fprintf|fls)$/;
const IN_PLACE = new Set(['sed', 'gsed', 'perl', 'ruby']);
const SHELL_NAMES = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'csh', 'tcsh', 'pwsh', 'powershell', 'cmd']);
// xargs is unwrapped by the parser, so its name only survives in the raw text.
const FAN_OUT_RE = /(?:^|[\s;&|(`])(?:xargs|parallel)(?=\s|$)/;

const shellQuote = (w) => (/^[\w@%+=:,./~-]+$/.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`);

// `-i`, `-i.bak`, `-pi`, `-ni`, `--in-place`
const inPlaceFlag = (a) => /^-[A-Za-z]*i/.test(a) || a === '--in-place' || a.startsWith('--in-place=');

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

// Targets of every unquoted output redirection in `text`; `/dev/null` and fd duplication (2>&1) are harmless.
function redirectTargets(text) {
  const out = [];
  const n = text.length;
  let q = null;
  let i = 0;
  while (i < n) {
    const c = text[i];
    if (q === "'") { if (c === "'") q = null; i++; continue; }
    if (q === '"') {
      if (c === '\\') { i += 2; continue; }
      if (c === '"') q = null;
      i++;
      continue;
    }
    if (c === '\\') { i += 2; continue; }
    if (c === "'" || c === '"') { q = c; i++; continue; }
    if (c !== '>') { i++; continue; }
    let j = i + 1;
    if (text[j] === '>') j++;
    if (text[j] === '|') j++;
    let dup = false;
    if (text[j] === '&') { dup = true; j++; }
    while (text[j] === ' ' || text[j] === '\t') j++;
    if (text[j] === '(') { out.push('('); i = j + 1; continue; }
    let k = j;
    while (k < n && !/[\s;&|)<>]/.test(text[k])) k++;
    const target = text.slice(j, k).replace(/^["']|["']$/g, '');
    if (!((dup && /^(\d+|-)$/.test(target)) || target === '/dev/null')) out.push(target || '?');
    i = Math.max(k, i + 1);
  }
  return out;
}

function isPipelineTool(arg, ctx) {
  if (typeof arg !== 'string') return false;
  const e = expandHomeRefs(toPosix(arg), ctx.homePosix);
  if (!isAbs(e)) return false;
  return samePath(e, `${ctx.homePosix}/.claude/pipeline/bin/pipeline.mjs`, ctx.platform)
    || isInside(e, `${ctx.homePosix}/.claude/pipeline/hooks`, ctx.platform);
}

// A Windows `node C:\...\pipeline.mjs` loses its backslashes in argv, so look at the raw text too.
function pipelineToolInRaw(raw, ctx) {
  const t = expandHomeRefs(toPosix(raw), ctx.homePosix);
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
  if (inner.truncated) return false;
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
  if (isPipelineTool(argv[0], ctx)) return true;
  if (name === 'node') return isPipelineTool(argv[1], ctx) || (cmd.raw.includes('\\') && pipelineToolInRaw(cmd.raw, ctx));
  if (name === 'pwsh' || name === 'powershell') return pwshReadOnly(argv);
  return PS_READ_ONLY.has(name);
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
    const e = expandHomeRefs(toPosix(t), ctx.homePosix);
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
    const e = expandHomeRefs(toPosix(h.p), ctx.homePosix);
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
  const flat = raw.replace(/['"`\\]/g, '');
  if (hasAdminToken(raw, ctx.platform) || hasAdminToken(flat, ctx.platform)) return deny('the command mentions PIPELINE_ADMIN; only the owner may set it, when launching Claude Code');
  if (hasDisableAll(raw) || hasDisableAll(flat)) return deny('the command mentions disableAllHooks, which would switch the pipeline hooks off');

  const cmds = simpleCommands(raw);
  for (const c of cmds) {
    const words = [...c.argv, ...Object.entries(c.env).flatMap(([k, v]) => [k, `${k}=${v}`])].join(' ');
    if (hasAdminToken(words, ctx.platform)) return deny('the command sets PIPELINE_ADMIN; only the owner may set it, when launching Claude Code');
    if (hasDisableAll(words)) return deny('the command mentions disableAllHooks, which would switch the pipeline hooks off');
  }
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
  const insideRoot = dirs.some((d) => ctx.hit(d)); // cwd or a `cd` target is a protected dir: relative words can reach it
  const mentions = (c) => insideRoot
    || m.rawHit(c.raw)
    || Object.values(c.env).some((v) => m.rawHit(v))
    || c.argv.some((t, i) => m.rawHit(t) || ((i > 0 || t.includes('/')) && m.pathHit(t, dirs)));
  const mentioning = cmds.filter(mentions);
  // A reference no command mentions can only live in a comment or in a heredoc body; a body may be a script.
  if (!mentioning.length && !(raw.includes('<<') && m.rawHit(raw))) return allow();

  if (cmds.truncated) return deny('the command line is too complex to check and refers to a protected pipeline file');

  const sources = [raw, ...cmds.map((c) => c.raw)];
  const redirect = unique(sources.flatMap(redirectTargets));
  if (redirect.length) return deny(`the command refers to a protected pipeline file and redirects output to ${redirect[0]}`);
  if (cmds.some((c) => baseOf(c.argv[0] ?? '') === 'tee')) return deny('the command refers to a protected pipeline file and uses tee');
  if (cmds.some((c) => IN_PLACE.has(baseOf(c.argv[0] ?? '')) && c.argv.slice(1).some(inPlaceFlag))) return deny('the command refers to a protected pipeline file and edits files in place');

  // A read-only command can still feed a writer further down the pipe (find ... | xargs rm, ls ... | sh).
  if (cmds.some((c) => FAN_OUT_RE.test(c.raw) || (SHELL_NAMES.has(baseOf(c.argv[0] ?? '')) && !isReadOnly(c, ctx)))) return deny('the command refers to a protected pipeline file and hands work to xargs or a shell, which could modify it');

  const pool = mentioning.length ? mentioning : cmds.filter((c) => c.argv.length);
  const bad = pool.find((c) => !isReadOnly(c, ctx));
  if (bad) {
    const name = bad.argv.length ? baseOf(bad.argv[0]) : '(assignment)';
    return deny(`${name} refers to a protected pipeline file and is not a read-only command (skills, agents, ~/.claude/pipeline and ~/.claude/settings.json can only be changed by the owner with PIPELINE_ADMIN=1)`);
  }
  return allow();
}
