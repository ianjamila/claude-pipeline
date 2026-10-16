// Mutations for `pipeline worktrees` (spec docs/specs/2026-10-13-worktree-prune-design.md §2, §3, §5): the holding folder,
// where evidence files are parked (with a manifest) before a worktree is removed and expire after 30 days; and the
// quarantine-move removal itself, the only code that removes a worktree.
import { createHash } from 'node:crypto';
import {
  constants as fsConstants, copyFileSync, linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, unlinkSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GitError, git } from '../git.mjs';
import { listWorktrees } from '../local-branches.mjs';
import { LockTimeoutError, withLock } from '../locks.mjs';
import { isInside, samePath } from '../paths.mjs';
import { entriesFor, processesInside, recentFiles, walkTree } from './inspect.mjs';
import { classifyEntries } from './rules.mjs';

const DAY_MS = 86400e3;
const MANIFEST = 'MANIFEST.json';
const safeName = (s) => String(s).replace(/[^A-Za-z0-9._-]/g, '_');

export function holdingRoot(repoSlug, env = process.env) {
  const base = env.PIPELINE_HOLDING_DIR || path.join(os.homedir(), '.local', 'share', 'pipeline', 'holding');
  return path.join(base, safeName(repoSlug));
}

// Move `from` to `to` and NEVER replace an existing `to` (rename would, silently): hard link + unlink, or an exclusive copy
// + unlink across devices. Filesystems without hard links get an existence check + rename (safe under the holding lock).
// -> false when `to` already exists (nothing moved); the caller picks another name.
const NO_LINK_CODES = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS']);
function moveFileExclusive(from, to) {
  try {
    linkSync(from, to);
  } catch (err) {
    if (err?.code === 'EEXIST') return false;
    if (err?.code === 'EXDEV') {
      try {
        copyFileSync(from, to, fsConstants.COPYFILE_EXCL);
      } catch (copyErr) {
        if (copyErr?.code === 'EEXIST') return false;
        throw copyErr;
      }
    } else if (NO_LINK_CODES.has(err?.code)) {
      try {
        lstatSync(to);
        return false;
      } catch (statErr) {
        if (statErr?.code !== 'ENOENT') throw statErr;
      }
      renameSync(from, to);
      return true;
    } else {
      throw err;
    }
  }
  unlinkSync(from);
  return true;
}

class SymlinkInPathError extends Error {}

// `rel` (posix, relative) resolved under `base`; throws unless it lands strictly inside it.
function resolveInside(base, rel, what) {
  const abs = path.resolve(base, ...String(rel).split('/'));
  if (path.isAbsolute(rel) || !isInside(abs, base) || samePath(abs, base)) throw new Error(`refusing to ${what} a path outside the worktree: ${rel}`);
  return abs;
}

// Every component strictly between `base` and `abs` must be a real directory (never a symlink), and the parent's
// realpath must stay inside base's realpath: a directory swapped for a link cannot redirect a move or delete elsewhere.
function assertNoSymlinkBetween(base, abs) {
  const parts = path.relative(base, abs).split(path.sep);
  let cur = base;
  for (const part of parts.slice(0, -1)) {
    cur = path.join(cur, part);
    const st = lstatSync(cur);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new SymlinkInPathError(`symlink in path: ${cur}`);
  }
  if (!isInside(realpathSync(path.dirname(abs)), realpathSync(base))) throw new SymlinkInPathError(`symlink in path: ${abs}`);
}

// mkdir each of `parts` under `base` one level at a time (never `recursive`, which would follow a planted link) and
// refuse any that exists as anything but a real directory.
function ensureRealDirs(base, parts) {
  let cur = base;
  for (const part of parts) {
    cur = path.join(cur, part);
    try {
      mkdirSync(cur);
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
    }
    const st = lstatSync(cur);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new SymlinkInPathError(`symlink in path: ${cur}`);
  }
  return cur;
}

function readManifest(dir) {
  try {
    if (lstatSync(path.join(dir, MANIFEST)).isSymbolicLink()) return null; // only ever a file this module wrote
    const m = JSON.parse(readFileSync(path.join(dir, MANIFEST), 'utf8'));
    return m && Array.isArray(m.items) ? m : null;
  } catch {
    return null;
  }
}

const CORRUPT_PREFIX = `${MANIFEST}.corrupt-`;

// The batch's manifest to append to. One that exists but cannot be read or parsed is renamed aside to the first free
// MANIFEST.json.corrupt-<n> (never overwritten: it may be the only record of where earlier files came from).
function manifestToAppend(dir) {
  const fresh = { version: 1, items: [] };
  const m = readManifest(dir);
  if (m) return m;
  const file = path.join(dir, MANIFEST);
  let st;
  try {
    st = lstatSync(file);
  } catch (err) {
    if (err?.code === 'ENOENT') return fresh;
    throw err;
  }
  if (!st.isFile()) return fresh; // a symlink: the atomic write replaces the link itself, never its target
  for (let n = 1; ; n++) {
    const aside = path.join(dir, `${CORRUPT_PREFIX}${n}`);
    try {
      lstatSync(aside);
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
      renameSync(file, aside);
      return fresh;
    }
  }
}

// Temp file + rename, so a crash never leaves a half-written manifest next to the files it describes.
function writeManifestAtomic(dir, manifest) {
  const tmp = path.join(dir, `${MANIFEST}.tmp-${process.pid}`);
  try {
    unlinkSync(tmp); // a stale (or planted) temp file; unlink never follows a link
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
  writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  renameSync(tmp, path.join(dir, MANIFEST));
}

// Remove directories the move emptied, walking up, but never the worktree root or anything above it.
function pruneEmptyParents(startDir, wtPath) {
  let dir = startDir;
  while (isInside(dir, wtPath) && !samePath(dir, wtPath)) {
    try {
      rmdirSync(dir);
    } catch {
      return; // not empty (or already gone): stop
    }
    dir = path.dirname(dir);
  }
}

function freeName(target) {
  let candidate = target;
  for (let n = 1; ; n++) {
    try {
      lstatSync(candidate);
    } catch (err) {
      if (err?.code === 'ENOENT') return candidate;
      throw err;
    }
    candidate = `${target}.${n}`;
  }
}

// Callers hold the holding folder's lock (withHoldingLock) around this: the name pick, the move and the manifest
// read-modify-write must not interleave with another archiver, and two clones of one repo share one holding folder.
// `rels` are FILES inside the worktree (a symlink, or a symlinked directory on the way, is refused). Each is moved to
// <holdingDir>/<YYYY-MM-DD>/<slug>/<rel>; the manifest in the dated dir is appended to (not replaced) when the same day
// archives again. No directory between holdingDir and the stored file may be a symlink either. `originalRoot` is where
// the files really live when `wtPath` is a temporary location (the quarantine): the manifest's `original` (and so the
// restore command) points there, never at a path that stops existing after the run.
export function archivePaths({ wtPath, originalRoot = wtPath, rels, holdingDir, slug, pr, nowMs, hooks = {} }) {
  const day = new Date(nowMs).toISOString().slice(0, 10);
  const archivedAt = new Date(nowMs).toISOString();
  const sources = rels.map((rel) => {
    const abs = resolveInside(wtPath, rel, 'archive');
    assertNoSymlinkBetween(wtPath, abs);
    if (!lstatSync(abs).isFile()) throw new SymlinkInPathError(`symlink in path: ${abs} is not a regular file`);
    return { rel, abs };
  });
  mkdirSync(holdingDir, { recursive: true });
  const batchDir = ensureRealDirs(holdingDir, [day]);
  ensureRealDirs(batchDir, [safeName(slug)]);
  const manifest = manifestToAppend(batchDir);
  const items = [];
  for (const { rel, abs } of sources) {
    assertNoSymlinkBetween(wtPath, abs); // again, right before the move
    const data = readFileSync(abs);
    const relParts = String(rel).split('/');
    const destDir = ensureRealDirs(batchDir, [safeName(slug), ...relParts.slice(0, -1)]);
    let stored;
    for (;;) { // a name that got taken after the pick (never expected under the holding lock) just means: pick the next one
      stored = freeName(path.join(destDir, relParts[relParts.length - 1]));
      hooks.afterPick?.(stored); // test seam: lets a test run another archiver between the name pick and the move
      if (moveFileExclusive(abs, stored)) break;
    }
    const item = {
      original: path.join(originalRoot, ...relParts), stored, size: data.length, sha256: createHash('sha256').update(data).digest('hex'),
      archivedAt, slug, pr: pr ?? null,
    };
    items.push(item);
    manifest.items.push(item);
    writeManifestAtomic(batchDir, manifest); // after every file: a crash mid-batch still leaves a record of what moved
    pruneEmptyParents(path.dirname(abs), wtPath);
  }
  return { batchDir, items };
}

export const holdingLockName = (holdingDir) => `worktrees-holding-${createHash('sha256').update(path.resolve(holdingDir)).digest('hex').slice(0, 12)}`;

// The lock is keyed by the holding folder (not the git common dir the run lock uses): two clones of one repo have two run
// locks but one holding folder. A lock that cannot be had within lockWaitMs throws LockTimeoutError: callers keep the worktree.
export async function withHoldingLock(holdingDir, fn, { lockDir, lockWaitMs = 30_000, lockPollMs = 50 } = {}) {
  return withLock(holdingLockName(holdingDir), fn, { dir: lockDir || undefined, waitMs: lockWaitMs, pollMs: lockPollMs });
}

export async function archivePathsLocked({ lockDir, lockWaitMs, lockPollMs, ...opts }) {
  return withHoldingLock(opts.holdingDir, () => archivePaths(opts), { lockDir, lockWaitMs, lockPollMs });
}

// Always single-quoted (POSIX sh): a quote inside becomes '\'' and nothing else in the path is special.
const shellQuote = (p) => `'${String(p).replaceAll("'", "'\\''")}'`;

function batchDirs(holdingDir) {
  let names;
  try {
    names = readdirSync(holdingDir).sort();
  } catch {
    return [];
  }
  return names.filter((name) => {
    try {
      return lstatSync(path.join(holdingDir, name)).isDirectory(); // a symlinked or stray file entry is not a batch
    } catch {
      return false;
    }
  });
}

export function listHolding(holdingDir) {
  return batchDirs(holdingDir).map((batch) => {
    const manifest = readManifest(path.join(holdingDir, batch));
    const items = manifest?.items ?? [];
    const stamps = items.map((i) => i?.archivedAt).filter((s) => Number.isFinite(Date.parse(s)));
    stamps.sort((a, b) => Date.parse(a) - Date.parse(b));
    return {
      batch,
      archivedAt: stamps.length ? stamps[stamps.length - 1] : null,
      items: items.length,
      bytes: items.reduce((sum, i) => sum + (Number.isFinite(i?.size) ? i.size : 0), 0),
      restore: items.filter((i) => i?.stored && i?.original)
        .map((i) => `mkdir -p ${shellQuote(path.dirname(i.original))} && mv ${shellQuote(i.stored)} ${shellQuote(i.original)}`),
    };
  });
}

// A batch goes only when every item's archivedAt parses, is not in the future and is older than `days`. Anything unclear is kept.
export function purgeHolding(holdingDir, { nowMs, days = 30 }) {
  const purged = [];
  const kept = [];
  for (const batch of batchDirs(holdingDir)) {
    const dir = path.resolve(holdingDir, batch);
    if (!isInside(dir, holdingDir) || samePath(dir, holdingDir)) {
      kept.push({ batch, reason: 'outside holding folder' });
      continue;
    }
    let asideManifest;
    try {
      asideManifest = readdirSync(dir).find((n) => n.startsWith(CORRUPT_PREFIX));
    } catch {
      kept.push({ batch, reason: 'unreadable batch folder' });
      continue;
    }
    if (asideManifest) {
      kept.push({ batch, reason: `holds an unreadable earlier manifest (${asideManifest})` });
      continue;
    }
    const manifest = readManifest(dir);
    if (!manifest) {
      kept.push({ batch, reason: 'no readable manifest' });
      continue;
    }
    if (manifest.items.length === 0) {
      kept.push({ batch, reason: 'manifest lists no items' });
      continue;
    }
    let reason = null;
    for (const item of manifest.items) {
      const at = typeof item?.archivedAt === 'string' ? Date.parse(item.archivedAt) : NaN;
      if (!Number.isFinite(at)) { reason = 'unparseable archivedAt'; break; }
      if (at > nowMs) { reason = 'archivedAt is in the future'; break; }
      if (nowMs - at <= days * DAY_MS) { reason = `newer than ${days} days`; break; }
    }
    if (reason) {
      kept.push({ batch, reason });
      continue;
    }
    rmSync(dir, { recursive: true });
    purged.push(batch);
  }
  return { purged, kept };
}

export const QUARANTINE_DIR = '.prune-quarantine';
const RUN_ID = /^[A-Za-z0-9_-]+$/; // no dot: restoreLeftovers splits <slug>.<runId> on the LAST dot

// One line: these reasons go into a one-line-per-worktree report, and git's stderr carries hint lines.
const gitMessage = (err) => String(err instanceof GitError ? err.message : err?.message ?? err).replace(/\s*\n\s*/g, ' ').trim();

// Final inspection of the quarantined tree (spec §2 step 3). -> null when it may go, else the reason to keep it.
function reinspect(q, cfg, runStartMs, procOpts) {
  let walk;
  let classified;
  try {
    walk = walkTree(q);
    classified = classifyEntries(entriesFor(q), cfg);
  } catch (err) {
    return { reason: `could not re-inspect during removal: ${gitMessage(err)}` };
  }
  if (classified.blockers.length) return { reason: `write detected during removal (${classified.blockers[0]})` };
  const recent = recentFiles(walk, { sinceMs: runStartMs, ignore: [...cfg.delete, ...cfg.archive] });
  if (recent.length) return { reason: `write detected during removal (${recent[0]})` };
  const procs = processesInside(q, procOpts);
  if (!procs.available || procs.pids.length) return { reason: 'in use during removal' };
  for (const rel of [...classified.del, ...classified.arch]) {
    try {
      const abs = resolveInside(q, rel, 'remove');
      assertNoSymlinkBetween(q, abs);
      if (classified.arch.includes(rel) && lstatSync(abs).isSymbolicLink()) throw new SymlinkInPathError(rel);
    } catch (err) {
      return { reason: `symlink in path (${rel})${err instanceof SymlinkInPathError ? '' : `: ${err.message}`}` };
    }
  }
  return { del: classified.del, arch: classified.arch };
}

// Delete one cache path inside q without following links: unlink a file or link, recurse only into a real directory.
function deleteInside(q, rel) {
  const abs = resolveInside(q, rel, 'delete');
  assertNoSymlinkBetween(q, abs);
  let st;
  try {
    st = lstatSync(abs);
  } catch (err) {
    if (err?.code === 'ENOENT') return;
    throw err;
  }
  if (st.isDirectory() && !st.isSymbolicLink()) rmSync(abs, { recursive: true, force: false });
  else unlinkSync(abs);
  pruneEmptyParents(path.dirname(abs), q); // cache parents the delete emptied, never q itself
}

// spec §2: move the worktree to <worktree_dir>/.prune-quarantine/<slug>.<runId> (its known path stops existing), wait,
// re-inspect there, then archive + delete + `git worktree remove`. Any doubt after the move => move it back and keep it.
// The quarantine sits next to the worktree: candidates are direct children of <root>/<worktree_dir>.
// -> { removed: true, archived: [manifest items], deleted: [rels] } | { removed: false, reason, restored }
export async function removeWorktree({ root, wt, cfg, pr, holdingDir, runId, runStartMs, settleMs = 5000, hooks = {}, procOpts, lockDir, lockWaitMs, lockPollMs }) {
  if (!RUN_ID.test(String(runId))) throw new Error(`removeWorktree: runId must match ${RUN_ID}: ${runId}`);
  if (!Number.isFinite(runStartMs)) throw new Error('removeWorktree: runStartMs must be a number');
  const qDir = path.join(path.dirname(wt.path), QUARANTINE_DIR);
  const q = path.join(qDir, `${wt.slug}.${runId}`);
  try {
    mkdirSync(qDir, { recursive: true });
    if (lstatSync(qDir).isSymbolicLink()) return { removed: false, reason: `move refused: ${qDir} is a symlink`, restored: false };
    git(['worktree', 'move', wt.path, q], { cwd: root });
  } catch (err) {
    return { removed: false, reason: `move refused: ${gitMessage(err)}`, restored: false };
  }

  // `extra` carries what already happened (e.g. `archived`) so a kept worktree's report still says what went to holding.
  const moveBack = (reason, extra = {}) => {
    try {
      git(['worktree', 'move', q, wt.path], { cwd: root });
      return { removed: false, reason, restored: true, ...extra };
    } catch (err) {
      return { removed: false, reason: `${reason}; moving it back failed (${gitMessage(err)}); it is at ${q}`, restored: false, ...extra };
    }
  };

  let verdict;
  try {
    await hooks.afterMove?.(q);
    if (settleMs > 0) await new Promise((r) => setTimeout(r, settleMs));
    verdict = reinspect(q, cfg, runStartMs, procOpts);
  } catch (err) {
    return moveBack(`could not re-inspect during removal: ${gitMessage(err)}`);
  }
  if (verdict.reason) return moveBack(verdict.reason);

  // One file at a time, so a failure part-way still reports exactly what reached holding.
  const archived = [];
  try {
    const nowMs = Date.now();
    if (verdict.arch.length) {
      await withHoldingLock(holdingDir, () => {
        for (const rel of verdict.arch) {
          archived.push(...archivePaths({ wtPath: q, originalRoot: wt.path, rels: [rel], holdingDir, slug: wt.slug, pr, nowMs }).items);
        }
      }, { lockDir, lockWaitMs, lockPollMs });
    }
    for (const rel of verdict.del) deleteInside(q, rel);
  } catch (err) {
    const why = err instanceof SymlinkInPathError ? `symlink in path (${err.message})`
      : err instanceof LockTimeoutError ? `holding folder is busy (lock not obtained): ${gitMessage(err)}`
        : `cleanup failed during removal: ${err.message}`;
    return moveBack(why, { archived });
  }

  // Archive + delete took time, and `git worktree remove` deletes ignored files without --force: look once more. Every
  // archive and delete match was handled above, so anything left at all (evidence or cache included) is a new write.
  try {
    await hooks.beforeRemove?.(q);
    const c = classifyEntries(entriesFor(q), cfg);
    const late = [...c.blockers, ...c.arch, ...c.del];
    if (late.length) return moveBack(`write detected during removal (${late[0]})`, { archived });
    await hooks.beforeGitRemove?.(q);
  } catch (err) {
    return moveBack(`could not re-inspect during removal: ${gitMessage(err)}`, { archived });
  }

  try {
    git(['worktree', 'remove', q], { cwd: root });
  } catch (err) {
    return moveBack(`git refused removal: ${gitMessage(err)}`, { archived });
  }
  return { removed: true, archived, deleted: verdict.del };
}

// A dead run's quarantine goes back to <root>/<worktreeDir>/<slug> before anything else is evaluated (spec §2). Never
// deletes anything; whatever cannot be moved back is reported for the owner.
export function restoreLeftovers(root, worktreeDir) {
  const wtDir = path.join(root, worktreeDir);
  const qDir = path.join(wtDir, QUARANTINE_DIR);
  let names;
  try {
    if (lstatSync(qDir).isSymbolicLink()) return [{ from: qDir, to: null, restored: false, reason: 'quarantine folder is a symlink — inspect by hand' }];
    names = readdirSync(qDir).sort();
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return [];
    throw err;
  }
  if (!names.length) return [];
  const known = listWorktrees(root).map((w) => w.path);
  const isKnown = (p) => {
    const real = (() => { try { return realpathSync(p); } catch { return p; } })();
    return known.some((k) => samePath(k, p) || samePath(k, real));
  };
  return names.map((name) => {
    const from = path.join(qDir, name);
    const dot = name.lastIndexOf('.');
    if (dot <= 0 || dot === name.length - 1) return { from, to: null, restored: false, reason: 'not a <slug>.<runId> name — inspect by hand' };
    const to = path.join(wtDir, name.slice(0, dot));
    try {
      lstatSync(to);
      return { from, to, restored: false, reason: 'original path is taken' };
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
    }
    if (!isKnown(from)) return { from, to, restored: false, reason: 'not a worktree any more — inspect by hand' };
    try {
      git(['worktree', 'move', from, to], { cwd: root });
      return { from, to, restored: true };
    } catch (err) {
      return { from, to, restored: false, reason: `move back refused: ${gitMessage(err)}` };
    }
  });
}
