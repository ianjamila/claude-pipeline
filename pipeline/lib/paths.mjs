// Path helpers that behave the same on macOS, Linux and Windows. Everything is compared in POSIX
// form (forward slashes, ".." resolved) so a Windows path can be checked without touching the disk.
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

const isAbsolutePosix = (s) => s.startsWith('/') || /^[A-Za-z]:\//.test(s);

// Normalised POSIX form: absolute, ".." resolved, no trailing slash (except a bare root), and
// lower-cased on case-insensitive platforms.
function normalise(p, platform) {
  let s = toPosix(p);
  if (!isAbsolutePosix(s)) s = `${toPosix(process.cwd())}/${s}`;
  const unc = /^\/\/[^/]/.test(s); // keep a UNC prefix; posix.normalize would collapse "//" to "/"
  s = path.posix.normalize(s);
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
