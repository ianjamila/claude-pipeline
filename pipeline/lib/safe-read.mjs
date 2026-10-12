// Why: the SessionStart version hook looks at files inside WHATEVER repo a session starts in, and that repo is hostile
// input. A plain readFileSync follows a symlink to /dev/zero, blocks forever on a FIFO and slurps a multi-gigabyte
// file, and a synchronous read cannot be interrupted by the hook's deadline. This reads a file only when it is a plain
// regular file (never a symlink), opens it without following links and without blocking, re-checks the opened handle,
// and never reads more than the caller's cap. Nothing here throws.
import fs from 'node:fs';
import path from 'node:path';

const FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);

// { status: 'ok', buffer, size, truncated } | { status: 'missing' } | { status: 'unsafe' } (not a regular file, a symlink,
// unreadable) | { status: 'toolarge', size } (only when `rejectLarger`; otherwise the read is cut at maxBytes).
export function readRegularFile(file, maxBytes, { rejectLarger = false } = {}) {
  let st;
  try { st = fs.lstatSync(file); } catch (err) { return { status: err?.code === 'ENOENT' || err?.code === 'ENOTDIR' ? 'missing' : 'unsafe' }; }
  if (st.isSymbolicLink() || !st.isFile()) return { status: 'unsafe' };
  if (rejectLarger && st.size > maxBytes) return { status: 'toolarge', size: st.size };
  let fd;
  try {
    fd = fs.openSync(file, FLAGS);
    const opened = fs.fstatSync(fd); // the path may have been swapped between lstat and open
    if (!opened.isFile()) return { status: 'unsafe' };
    if (rejectLarger && opened.size > maxBytes) return { status: 'toolarge', size: opened.size };
    const buffer = Buffer.alloc(Math.min(maxBytes, Math.max(0, opened.size)));
    let got = 0;
    while (got < buffer.length) {
      const n = fs.readSync(fd, buffer, got, buffer.length - got, got);
      if (n <= 0) break;
      got += n;
    }
    return { status: 'ok', buffer: buffer.subarray(0, got), size: opened.size, truncated: opened.size > maxBytes };
  } catch {
    return { status: 'unsafe' };
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* nothing to do */ } }
  }
}

// Is `target` (after resolving every symlink) inside `root` (also resolved)? false when either cannot be resolved.
export function realpathInside(root, target) {
  try {
    const r = fs.realpathSync.native(root);
    const t = fs.realpathSync.native(target);
    const rel = path.relative(r, t);
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
  } catch { return false; }
}
