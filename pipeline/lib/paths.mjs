// Path helpers that behave the same on macOS, Linux and Windows. Everything is compared in POSIX
// form (forward slashes, ".." resolved) so a Windows path can be checked without touching the disk.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function toPosix(p) {
  return String(p).replace(/\\/g, '/');
}

// Home references the pipeline config may contain. Each must end at a separator or the end of the
// string, so "$HOMEDIR/x" is not mistaken for "$HOME".
const HOME_PREFIXES = [
  /^~(?=$|[\\/])/,
  /^\$HOME(?=$|[\\/])/,
  /^\$\{HOME\}/,
  /^%USERPROFILE%/i,
  /^\$env:USERPROFILE(?=$|[\\/])/i,
];

export function expandHome(p, home = os.homedir()) {
  for (const re of HOME_PREFIXES) {
    if (re.test(p)) return home + p.replace(re, '');
  }
  return p;
}

// (a drive letter makes a path absolute on Windows only: on macOS / Linux `D:/x` is a relative path, a directory named `D:`)
const isAbsolutePosix = (s, platform = process.platform) => s.startsWith('/') || (platform === 'win32' && /^[A-Za-z]:\//.test(s));

// Normalised POSIX form: absolute, ".." resolved, no trailing slash (except a bare root), and
// lower-cased on case-insensitive platforms (unless `fold` is false: the spelling to ask the disk about).
function normalise(p, platform, fold = true) {
  let s = toPosix(p);
  if (!isAbsolutePosix(s, platform)) s = `${toPosix(process.cwd())}/${s}`;
  const unc = /^\/\/[^/]/.test(s); // keep a UNC prefix; posix.normalize would collapse "//" to "/"
  // (on Windows `..` stops at the drive root and at the share root of a UNC path)
  if (platform === 'win32' && (DRIVE.test(s) || UNC.test(s))) s = drivePosix.normalize(s);
  else { s = path.posix.normalize(s); if (unc) s = `/${s}`; }
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  return fold && (platform === 'win32' || platform === 'darwin') ? s.toLowerCase() : s;
}

// What the disk says about a place: its identity (device + inode, bigint), 'missing' (ENOENT), or null (cannot tell: a permission error, or a file
// system that reports no inode - then the caller keeps to the spelling).
function identityOf(p) {
  try {
    const st = fs.statSync(p, { bigint: true });
    return st.ino === 0n ? null : `${st.dev}:${st.ino}`;
  } catch (err) {
    return err?.code === 'ENOENT' ? 'missing' : null;
  }
}

// Whether two paths name the same place. On macOS and Windows the spelling is folded to lower case, which is right on the default case-insensitive volumes
// and wrong on a case-sensitive one (/repo/work and /repo/WORK are two folders there). So when `platform` is the running one and the disk can answer
// for both, the disk decides: both there -> the same device + inode; exactly one there -> different (a case-insensitive volume would have found both).
// Otherwise (nothing there yet, a platform other than the running one, an unreadable stat) the folded spelling decides, as before.
export function samePath(a, b, platform = process.platform) {
  if (platform === process.platform) {
    const x = identityOf(normalise(a, platform, false));
    const y = identityOf(normalise(b, platform, false));
    if (x !== null && y !== null && !(x === 'missing' && y === 'missing')) return x === y;
  }
  return normalise(a, platform) === normalise(b, platform);
}

// True when child is parent itself or somewhere below it. Compares whole segments, so "/a/bc" is
// not inside "/a/b".
export function isInside(child, parent, platform = process.platform) {
  const c = normalise(child, platform);
  const p = normalise(parent, platform).replace(/\/$/, '');
  return c === p || c.startsWith(`${p}/`);
}

// UTC, no colons: safe in Windows filenames and sorts chronologically.
export function safeTimestamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

// The real location of `p`: symlinks resolved on the deepest ancestor that exists, the not-yet-created rest appended.
// A claude-home reached through an alias (a symlinked ~/.claude, a second mount point) must name the same lock.
export function canonicalPath(p) {
  let cur = path.resolve(p);
  const rest = [];
  for (;;) {
    try { return path.join(fs.realpathSync.native(cur), ...rest); } catch { /* not there yet: try the parent */ }
    const parent = path.dirname(cur);
    if (parent === cur) return path.resolve(p);
    rest.unshift(path.basename(cur));
    cur = parent;
  }
}

// node:path.posix for paths in the guards' POSIX form (toPosix), where a Windows drive path stays `D:/dir/file`. The plain posix functions do not know `D:/` is absolute: posix.resolve('D:/a', 'b') puts the
// process directory in front, and posix.dirname('D:/a') is 'D:', then '.', so a walk upward leaves the drive. Here a drive is a root: resolve clamps `..` at it, dirname stops at `D:/`.
const posix = path.posix;
const DRIVE = /^([A-Za-z]:)(\/.*)?$/;
const UNC = /^(\/\/[^/]+\/[^/]+)(\/.*)?$/; // //server/share/x: the share is the root
const rooted = (s) => s.startsWith('/') || DRIVE.test(s);
const split = (s) => { const m = DRIVE.exec(s) ?? UNC.exec(s); return m ? [m[1], m[2] ?? '/'] : ['', s]; };
// Is this path module one of Windows' (native win32, or the POSIX form with drives)? Only there is `D:` a drive.
export const isWinModule = (m) => m === drivePosix || m === path.win32;
export const drivePosix = {
  ...posix,
  isAbsolute: (s) => rooted(String(s)),
  resolve(...parts) {
    let out = '';
    for (let i = parts.length - 1; i >= 0 && !rooted(out); i--) {
      const s = String(parts[i] ?? '');
      if (s !== '') out = out === '' ? s : `${s}/${out}`;
    }
    if (!rooted(out)) out = `${toPosix(process.cwd())}/${out}`;
    const [drive, rest] = split(out);
    return `${drive}${posix.resolve('/', rest)}`;
  },
  dirname(s) {
    const [drive, rest] = split(String(s));
    return drive ? `${drive}${posix.dirname(rest)}` : posix.dirname(s);
  },
  // (normalize and join: a drive or a share is a root that `..` does not leave, and the `//` of a UNC path stays)
  normalize(s) {
    const [drive, rest] = split(String(s));
    if (!drive) return posix.normalize(s);
    const r = posix.resolve('/', rest);
    return `${drive}${r !== '/' && rest.endsWith('/') ? `${r}/` : r}`;
  },
  join(...parts) {
    const j = parts.map(String).filter((x) => x !== '').join('/');
    return j === '' ? '.' : drivePosix.normalize(j);
  },
  relative(a, b) {
    const [da, ra] = split(this.resolve(a));
    const [db, rb] = split(this.resolve(b));
    return da.toLowerCase() === db.toLowerCase() ? posix.relative(ra, rb) : `${db}${rb}`;
  },
};

// ---- Claude Code session transcripts (#128) --------------------------------------------------------------------------------------
// ONE shared LEAF shape (TRANSCRIPT_LEAF: projects/<project>/…/<session>.jsonl), TWO root rules, for the two sides of the owner-go check. The guard (hooks/lib/files-policy.mjs) write-protects
// <config dir>/projects/<project>/<session>.jsonl (and subagents/ below it) and the folders that hold them, and the use-time check
// (hooks/lib/owner-go.mjs promptProvenance) takes a prompt's provenance only from a file of that shape under a root the guard protects: a transcript the guard does not protect
// is not evidence. The GUARD's root rule is the superset: a transcript under any `.claude*` folder (the stacks' default transcriptDirs) or $CLAUDE_CONFIG_DIR, whatever its name (TRANSCRIPT_FILE_SRC, transcriptRes);
// the USE-TIME rule is narrower (Codex #145 P1, isTranscriptFile): only a folder directly under the account's home with the HOME_CONFIG_DIR_RE shape, the one root a tool cannot create or replace.
// $CLAUDE_CONFIG_DIR is NOT a use-time root: the check runs in the agent's shell, where the variable is the agent's own word.
const TRANSCRIPT_LEAF = String.raw`projects/(?:[^/]+/)+[^/]+\.jsonl$`;
// the folders that hold them: projects/ itself, and BELOW it each project and every folder in it but its memory/ (names without a dot: a session is a
// uuid, subagents/ …). A project folder is named as Claude Code names it, the working directory with every non-alphanumeric turned into "-": it starts
// with "-" (POSIX) or "C--" (a drive), so a folder of any other name is no session's. (A file in one is still a transcript: TRANSCRIPT_LEAF.)
// THE project-folder name shape (exported: owner-go.mjs legacyTranscriptOf accepts a derived transcript only in a folder of this name, the one folder name below projects/ the guard protects).
const TRANSCRIPT_PROJECT_SRC = String.raw`(?:-|[A-Za-z]--)[^/]*`;
export const TRANSCRIPT_PROJECT_RE = new RegExp(`^${TRANSCRIPT_PROJECT_SRC}$`);
const TRANSCRIPT_BELOW = String.raw`projects/${TRANSCRIPT_PROJECT_SRC}(?:/(?!memory(?:/|$))[^/.]+(?:/[^/.]+)*)?/*$`;
const TRANSCRIPT_TOP = String.raw`projects/*$`;
const ANY_CLAUDE_DIR = String.raw`(?:^|/)\.claude[^/]*/`;
// A config dir directly under the home: `.claude` plus a suffix with no further dot (~/.claude, ~/.claude-eaglewatch; not ~/.claude.json, a file, and not ~/.claude.forged). THE shape the guard
// protects as a home-level folder (transcriptRes `homeDirs` below and the files-policy glob rule use this one definition): a tool cannot create or replace such a name, so what lies inside
// it is the guard's own. A name outside the shape is unguarded (`ln -s /tmp/x ~/.claude.forged` goes through), so nothing found there is evidence.
export const HOME_CONFIG_DIR_SRC = String.raw`\.claude[^/.]*`;
export const HOME_CONFIG_DIR_RE = new RegExp(`^${HOME_CONFIG_DIR_SRC}$`);
export const TRANSCRIPT_FILE_SRC = ANY_CLAUDE_DIR + TRANSCRIPT_LEAF;
const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// The absolute POSIX form of $CLAUDE_CONFIG_DIR (home references expanded), or null when it is unset or not absolute.
export function configDirOf(env, home = os.homedir()) {
  const v = env?.CLAUDE_CONFIG_DIR;
  if (typeof v !== 'string' || v.trim() === '') return null;
  const p = toPosix(expandHome(v.trim(), toPosix(home))).replace(/\/+$/, '');
  return p.startsWith('/') || /^[A-Za-z]:\//.test(p) ? p : null;
}
// The patterns for files (`files`), for the folders (`dirs`: a word that IS one is a protected reference) and for the folders a command may be run
// in (`below`: the SAME list since R8-B1, one array under both names: `projects/` itself holds the session folders, so `cd projects && tar -xf x` fills
// them; notes live in projects/<proj>/memory/, which stays open): the `.claude*` shape, plus each of `configDirs`
// (absolute POSIX paths; null/'' are skipped). R2-B1: a config dir is itself a folder that holds them (the way ~/.claude is an ancestor of its
// protected entries): `rsync -a x/ <dir>/`, `tar -xf x -C <dir>` and a shell sitting in it fill projects/ without naming it, so the dir is in `dirs` and `below`.
// (The folders ABOVE a config dir are not: the same gap as for the pipeline files, not closed here.)
// `homes` (absolute POSIX paths): a name directly under one that starts with .claude and has no further dot (the folders claudeConfigDirs scans: ~/.claude,
// ~/.claude-eaglewatch; not ~/.claude.json, a file) is such a config dir too, without being named by $CLAUDE_CONFIG_DIR. A .claude/ inside a repo is not.
export function transcriptRes(configDirs = [], ci = false, homes = []) {
  const flags = ci ? 'i' : '';
  const dirs = [...new Set(configDirs.filter(Boolean))];
  const homeDirs = [...new Set(homes.filter(Boolean))].map((h) => `^${reEscape(h.replace(/\/+$/, ''))}/${HOME_CONFIG_DIR_SRC}/*$`);
  const roots = dirs.map((d) => `^${reEscape(d)}/`);
  const self = dirs.map((d) => `^${reEscape(d)}/*$`);
  const folders = [ANY_CLAUDE_DIR + TRANSCRIPT_TOP, ANY_CLAUDE_DIR + TRANSCRIPT_BELOW, ...self, ...homeDirs, ...roots.flatMap((r) => [r + TRANSCRIPT_TOP, r + TRANSCRIPT_BELOW])].map((x) => new RegExp(x, flags));
  return {
    files: [TRANSCRIPT_FILE_SRC, ...roots.map((r) => r + TRANSCRIPT_LEAF)].map((s) => new RegExp(s, flags)),
    dirs: folders,
    below: folders,
  };
}
// The config dirs whose projects/ folder a DERIVED lookup (owner-go.mjs legacyTranscriptOf: find a transcript by its session) may trust, for `home`: the folders directly
// under it with the HOME_CONFIG_DIR_RE shape that exist, and nothing else. The environment is NOT consulted (R1-F1): the callers run in the agent's shell, where
// CLAUDE_CONFIG_DIR=<a folder the agent wrote> is the agent's own word and no guard reads that prefix. (isTranscriptFile / promptProvenance ignore the variable too, for a recorded path as for a derived one.)
// The caller still tests each file it finds with isTranscriptFile and checks its real path stays inside the folder's. `home` defaults to the account's home (accountHome), never $HOME.
export function transcriptConfigDirs({ home = accountHome() } = {}) {
  let named = [];
  try { named = fs.readdirSync(home).filter((n) => HOME_CONFIG_DIR_RE.test(n)).sort(); } catch { /* an unreadable home has none */ }
  return named.map((n) => path.join(home, n)).filter((d) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } });
}
// The account's home from the OS user database, NOT $HOME (the agent can set that to a folder it writes): the home the owner-go checks trust (owner-go.mjs re-exports it).
export function accountHome() {
  try {
    const h = os.userInfo().homedir;
    if (typeof h === 'string' && h) return h;
  } catch { /* no passwd entry: fall back */ }
  return os.homedir();
}
// Is this path (any slash flavour) a transcript FILE the guard protects, as the USE-TIME check (owner-go evidence)? Codex #145 P1: it used to mean "under any .claude* folder anywhere"
// (TRANSCRIPT_FILE_SRC, which transcriptRes keeps for the guard, a belt over every spelling), but the guard protects a config ROOT only when it is $CLAUDE_CONFIG_DIR (files-policy.mjs) or a
// folder directly under the home with the HOME_CONFIG_DIR_RE shape; a folder-level cp/tar/rsync into /tmp/.claude-x or ~/.claude.personal is not refused, so a forged transcript there was taken as
// the owner's words. Fix round: $CLAUDE_CONFIG_DIR is no root HERE either, because the process that asks (`P merge` in the agent's shell) takes it from the agent: `CLAUDE_CONFIG_DIR=/tmp/.claude-x P merge`
// would make an unprotected folder evidence. So one root: <home>/<HOME_CONFIG_DIR_RE>/projects/… (the home as given AND real-resolved, the two spellings the guard adds), same leaf shape, no `..` in the path.
// `home` defaults to the account's home (accountHome), never $HOME; the unit tests pass a temp one. (The guard itself builds its home from os.homedir(): where $HOME differs from the passwd home it
// protects the $HOME one, so a genuine transcript under the passwd home is refused here: fail closed, accepted.) Case-insensitive where the file system is (darwin, win32).
export function isTranscriptFile(file, { platform = process.platform, home = accountHome() } = {}) {
  const p = toPosix(file);
  // a `..` names another place than the one it is written under, and no root pattern below would see it: never evidence (the recorded paths are absolute and clean)
  if (p.split('/').includes('..')) return false;
  const homePosix = toPosix(home).replace(/\/+$/, '');
  // the home as given AND as the file system resolves it, the two spellings the guard protects (files-policy.mjs: transcriptRes(…, unique([home, realResolve(home)])))
  let real = null;
  try { real = toPosix(fs.realpathSync.native(home)).replace(/\/+$/, ''); } catch { /* a home that is not on this file system has only its given spelling */ }
  const roots = [...new Set([homePosix, real].filter(Boolean))].map((h) => `^${reEscape(h)}/${HOME_CONFIG_DIR_SRC}/`);
  const flags = platform === 'win32' || platform === 'darwin' ? 'i' : '';
  return roots.some((r) => new RegExp(r + TRANSCRIPT_LEAF, flags).test(p));
}
