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
// lower-cased on case-insensitive platforms.
function normalise(p, platform) {
  let s = toPosix(p);
  if (!isAbsolutePosix(s, platform)) s = `${toPosix(process.cwd())}/${s}`;
  const unc = /^\/\/[^/]/.test(s); // keep a UNC prefix; posix.normalize would collapse "//" to "/"
  s = platform === 'win32' && /^[A-Za-z]:\//.test(s) ? drivePosix.resolve(s) : path.posix.normalize(s); // (on Windows `..` stops at the drive root)
  if (unc) s = `/${s}`;
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  return platform === 'win32' || platform === 'darwin' ? s.toLowerCase() : s;
}

export function samePath(a, b, platform = process.platform) {
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
const rooted = (s) => s.startsWith('/') || DRIVE.test(s);
const split = (s) => { const m = DRIVE.exec(s); return m ? [m[1], m[2] ?? '/'] : ['', s]; };
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
  relative(a, b) {
    const [da, ra] = split(this.resolve(a));
    const [db, rb] = split(this.resolve(b));
    return da.toLowerCase() === db.toLowerCase() ? posix.relative(ra, rb) : `${db}${rb}`;
  },
};
