// Why: `pipeline update` makes two kinds of scratch directory - the private git config/hooks directory and the download
// the installer is then run from - and a hook or config planted in either is code run as the owner. os.tmpdir() cannot
// hold them: on Windows TEMP can carry an inheritable ACL that grants another account write access, and on POSIX an
// unsafe temp parent lets a directory be renamed away and replaced by one (or a symlink) the attacker controls, after
// we checked it. So the scratch space lives under the Claude home instead, in a root this module creates and validates:
//
//   <home>/pipeline-state/tmp/
//
// Why that spot: install.mjs and `--check` only ever read skills/, agents/ and pipeline/ under the home (the manifest's
// units; scanExtraInstalledFiles walks only those), so nothing here is scanned as an "extra" file, rotated as a backup
// or swapped by an install; backups/ is not used because install.mjs rmdir()s it when it believes it created it and the
// installer keeps its own .locks/.staging there. pipeline-state/ is the directory the pipeline already owns for its
// machine id and locks.
//
// Everything here FAILS CLOSED: it throws (callers report "git unavailable" / "could not create a private directory"
// and never fall back to os.tmpdir() or the caller's configuration) unless the root and each directory made in it are
// real directories (lstat - a symlink or junction is refused, never followed) and, on POSIX, owned by this user with no
// group/other access (mode & 0o077 === 0). A symlink, a non-directory or a foreign owner is REFUSED, never repaired:
// someone else has been here. A loose MODE on a directory we own is tightened (a cp/rsync/backup restore of the home
// drops modes; the owner check already proved nobody else holds it) and re-checked. The parent, pipeline-state/, is
// shared with the lock and machine-id code that creates it with the default umask, so a parent WE own only has
// group/other write stripped.
// Residual risks, deliberately not handled: (1) Windows - the home is under the user profile, which is owner-only
// by default, and no icacls is run to prove it (the symlink/junction and real-directory checks still apply);
// (2) the home itself (and so ~/.claude being a symlink into a dotfiles repo, which is allowed) is trusted as given.
import fs from 'node:fs';
import path from 'node:path';

export const TMP_ROOT_REL = path.join('pipeline-state', 'tmp');
// Leftovers older than this, with one of our prefixes, owned by this user, are removed whenever the root is opened.
// Our two kinds of directory: the git config/hooks one (upstream.mjs ISO_DIR_PREFIX) and the download (update.mjs).
export const SWEEP_PREFIXES = ['claude-pipeline-git-', 'claude-pipeline-update-'];
export const STALE_MS = 24 * 60 * 60 * 1000;

const posix = () => process.platform !== 'win32';
const uid = () => (typeof process.getuid === 'function' ? process.getuid() : null);

// Remove a directory tree, tolerating Windows' brief file locks. Never throws.
export function removeTree(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ }
}

// Throws unless `dir` is a real directory (never a symlink) - and, on POSIX, ours alone when `strict`, or merely ours
// when not. `repair` tightens a loose mode on a directory we own (see above) instead of refusing it; without it a
// loose mode is refused. Returns the lstat. `what` names the directory in the error.
function assertOwnDir(dir, { strict, what, repair = false }) {
  const st = fs.lstatSync(dir);
  if (st.isSymbolicLink()) throw new Error(`${what} ${dir} is a symbolic link`);
  if (!st.isDirectory()) throw new Error(`${what} ${dir} is not a directory`);
  if (posix() && uid() !== null) {
    if (st.uid !== uid()) throw new Error(`${what} ${dir} is owned by another user`);
    if (strict && (st.mode & 0o077) !== 0) {
      if (!repair) throw new Error(`${what} ${dir} is accessible to other users (mode ${(st.mode & 0o777).toString(8)})`);
      fs.chmodSync(dir, 0o700);
      return assertOwnDir(dir, { strict, what });
    }
  }
  return st;
}

// Public: the check isoPaths() applies to a directory made here. Throws when `dir` is not a private real directory.
export const assertPrivateDir = (dir, what = 'private directory') => assertOwnDir(dir, { strict: true, what });

// Opens (creating it if need be) the trusted root for `home` and returns its path. Throws, naming the problem, when
// the root cannot be established as above.
export function privateTmpRoot(home) {
  if (typeof home !== 'string' || home === '') throw new TypeError('a private temp directory needs the Claude home');
  // The home must already exist (a read-only `--check` or a session hook must not create ~/.claude); statSync, because
  // the home itself may legitimately be a symlink to a real directory. Everything BELOW it is lstat-checked.
  if (!fs.statSync(home).isDirectory()) throw new Error(`the Claude home ${home} is not a directory`);
  const state = path.join(home, path.dirname(TMP_ROOT_REL));
  const root = path.join(home, TMP_ROOT_REL);
  fs.mkdirSync(state, { recursive: true });
  const st = assertOwnDir(state, { strict: false, what: 'state directory' });
  if (posix() && (st.mode & 0o022) !== 0) fs.chmodSync(state, st.mode & ~0o022 & 0o7777);
  try {
    fs.mkdirSync(root, { mode: 0o700 });
  } catch (err) {
    if (err?.code !== 'EEXIST') throw err;
  }
  assertOwnDir(root, { strict: true, what: 'temp root', repair: true });
  sweepStale(root);
  return root;
}

// A fresh directory (mkdtemp: atomic, 0700) named `<prefix>XXXXXX` inside the trusted root for `home`. The caller
// removes it (removeTree). Throws when the root or the new directory fails validation.
export function makePrivateTmpDir(home, prefix) {
  const root = privateTmpRoot(home);
  const dir = fs.mkdtempSync(path.join(root, prefix));
  try {
    if (posix()) fs.chmodSync(dir, 0o700);
    assertPrivateDir(dir, 'scratch directory');
  } catch (err) {
    removeTree(dir);
    throw err;
  }
  return dir;
}

// Removes what an interrupted run left behind: entries of `root` that are real directories we own, whose name starts with
// one of our prefixes and that are older than STALE_MS. lstat only - a symlink (or anything else) is left alone, and
// removeTree never follows one. Never throws; a sweep that cannot finish is not worth failing an update for.
export function sweepStale(root, { now = Date.now(), prefixes = SWEEP_PREFIXES } = {}) {
  try {
    for (const name of fs.readdirSync(root)) {
      if (!prefixes.some((p) => name.startsWith(p))) continue;
      const full = path.join(root, name);
      try {
        const st = fs.lstatSync(full);
        if (!st.isDirectory() || st.isSymbolicLink()) continue;
        if (posix() && uid() !== null && st.uid !== uid()) continue;
        if (now - st.mtimeMs > STALE_MS) removeTree(full);
      } catch { /* gone, or unreadable: leave it */ }
    }
  } catch { /* unreadable root: nothing to sweep */ }
}
