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
import { canonicalPath, isInside, samePath } from '../paths.mjs';
import { entriesFor, pathSpellings, processesInside, recentFiles, walkTree } from './inspect.mjs';
import { liveSessionsIn, scanLiveSessions } from './live-sessions.mjs';
import { classifyEntries, liveSessionReasons } from './rules.mjs';

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

const isFile = (p) => {
  try {
    return lstatSync(p).isFile();
  } catch {
    return false;
  }
};

// One lstat, one verdict: 'file' (a regular file), 'other' (present, not a regular file), 'absent' (ENOENT), or 'error' (any
// other failure: EACCES, EIO, ...; not known to be gone). A second lstat could fail where the first succeeded.
const statKind = (p) => {
  try {
    return lstatSync(p).isFile() ? 'file' : 'other';
  } catch (err) {
    return err?.code === 'ENOENT' ? 'absent' : 'error';
  }
};

// Is the file at `item.stored` the one the intent promised? (An interrupted cross-device copy leaves a truncated file.)
function storedMatches(item) {
  if (typeof item.stored !== 'string' || !isFile(item.stored)) return false;
  try {
    const data = readFileSync(item.stored);
    return data.length === item.size && createHash('sha256').update(data).digest('hex') === item.sha256;
  } catch {
    return false;
  }
}

// An archive writes its entry as `status: 'pending'` (plus `source`) BEFORE the file moves and drops both fields once the
// move is recorded; an entry without `status` is a finished one, so older manifests read as before. A pending entry that a
// failed write or a crash left behind is settled by looking at the disk: the stored file is there and its size and sha256
// match => the move happened, the entry counts as archived (and is reported as `incomplete`); no stored file (confirmed
// absent: ENOENT) => the move never happened, the intent is dropped; a stored file that does NOT match (a copy cut short) or
// that cannot be inspected at all (the one lstat fails with EACCES, EIO: its parent dir became unreadable, say) => `unverified`: not offered for
// restore, never purged, kept as pending on disk for a check by hand (dropping it would lose the original-path record). Pure: nothing is written.
// -> { items: entries that stand, incomplete: the settled-as-archived ones, unverified: the raw pending entries to check,
//      persist: what a rewritten manifest should hold (items + unverified, in order) }
function settleItems(manifest) {
  const items = [];
  const incomplete = [];
  const unverified = [];
  const persist = [];
  for (const item of manifest.items) {
    if (item?.status !== 'pending') {
      items.push(item);
      persist.push(item);
      continue;
    }
    if (typeof item.stored !== 'string') continue;
    const kind = statKind(item.stored);
    if (kind === 'absent' || kind === 'other') continue; // confirmed gone (ENOENT), or present but not a regular file: as before
    if (kind === 'error' || !storedMatches(item)) {
      unverified.push(item);
      persist.push(item);
      continue;
    }
    const { status: _status, source: _source, ...settled } = item;
    items.push(settled);
    incomplete.push(settled);
    persist.push(settled);
  }
  return { items, incomplete, unverified, persist };
}

const CORRUPT_PREFIX = `${MANIFEST}.corrupt-`;

// The batch's manifest to append to. One that exists but cannot be read or parsed is renamed aside to the first free
// MANIFEST.json.corrupt-<n> (never overwritten: it may be the only record of where earlier files came from).
function manifestToAppend(dir) {
  const fresh = { version: 1, items: [] };
  const m = readManifest(dir);
  if (m) return { ...m, items: settleItems(m).persist }; // the next write persists what an earlier crash left unsettled
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
export function archivePaths({ wtPath, originalRoot = wtPath, rels, holdingDir, slug, pr, nowMs, io = {}, hooks = {} }) {
  const move = io.move ?? moveFileExclusive; // seams for tests: the real file move and manifest write
  const writeManifest = io.writeManifest ?? writeManifestAtomic;
  const unlink = io.unlink ?? unlinkSync;
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
  let unrecovered = null; // a file that is in holding but whose "done" record could not be written, and could not be moved back
  try {
    for (const { rel, abs } of sources) {
      assertNoSymlinkBetween(wtPath, abs); // again, right before the move
      const data = readFileSync(abs);
      const relParts = String(rel).split('/');
      const destDir = ensureRealDirs(batchDir, [safeName(slug), ...relParts.slice(0, -1)]);
      let item;
      for (;;) { // a name that got taken after the pick (never expected under the holding lock) just means: pick the next one
        const stored = freeName(path.join(destDir, relParts[relParts.length - 1]));
        hooks.afterPick?.(stored); // test seam: lets a test run another archiver between the name pick and the move
        item = {
          original: path.join(originalRoot, ...relParts), stored, size: data.length, sha256: createHash('sha256').update(data).digest('hex'),
          archivedAt, slug, pr: pr ?? null,
        };
        // Intent first: from here on the file is recorded wherever the run dies. If this write fails, nothing has moved.
        manifest.items.push({ ...item, status: 'pending', source: abs });
        try {
          writeManifest(batchDir, manifest);
        } catch (err) {
          manifest.items.pop();
          throw err;
        }
        let moved;
        try {
          moved = move(abs, stored);
        } catch (err) {
          // A cross-device copy can fail part-way: remove our copy while the source is intact. The intent is dropped only once
          // the copy is confirmed gone; a copy that stays keeps its pending entry on disk and is reported to the caller.
          if (isFile(abs) && isFile(stored)) {
            try { unlink(stored); } catch { /* confirmed below */ }
          }
          if (isFile(stored)) {
            unrecovered = item;
            throw err;
          }
          manifest.items.pop();
          try { writeManifest(batchDir, manifest); } catch { /* the stale intent is settled on the next read */ }
          throw err;
        }
        if (moved !== false) break;
        // The name was taken (by a file that is not ours): drop the intent; the next pick's intent write replaces it on disk.
        manifest.items.pop();
      }
      manifest.items[manifest.items.length - 1] = item;
      try {
        writeManifest(batchDir, manifest); // mark it done
      } catch (err) {
        try {
          // put it back, so the worktree is whole and nothing sits unrecorded in holding (never over a file that appeared there)
          if (move(item.stored, abs) === false) throw new Error(`${abs} exists`);
          manifest.items.pop();
          try { writeManifest(batchDir, manifest); } catch { /* the intent on disk finds its stored file gone and is ignored */ }
        } catch {
          // Cannot move back: the intent already on disk keeps the file listed and restorable; hand it to the caller too.
          unrecovered = item;
        }
        throw err;
      }
      items.push(item);
      pruneEmptyParents(path.dirname(abs), wtPath);
    }
  } catch (err) {
    if (err && typeof err === 'object') err.archivedItems = unrecovered ? [...items, unrecovered] : items; // what reached holding
    throw err;
  }
  return { batchDir, items };
}

export const holdingLockName = (holdingDir) => `worktrees-holding-${createHash('sha256').update(canonicalPath(holdingDir)).digest('hex').slice(0, 12)}`;

// The lock is keyed by the holding folder (not the git common dir the run lock uses): two clones of one repo have two run
// locks but one holding folder. A lock that cannot be had within lockWaitMs throws LockTimeoutError: callers keep the worktree.
export async function withHoldingLock(holdingDir, fn, { lockDir, lockWaitMs = 30_000, lockPollMs = 50 } = {}) {
  return withLock(holdingLockName(holdingDir), fn, { dir: lockDir || undefined, waitMs: lockWaitMs, pollMs: lockPollMs });
}

// Purge takes the same lock as archiving: it deletes batches and reads manifests the archiver rewrites. No lock in time =>
// nothing is deleted (fail closed) and `skipped` says why.
export async function purgeHoldingLocked(holdingDir, { lockDir, lockWaitMs, lockPollMs, ...opts }) {
  try {
    return await withHoldingLock(holdingDir, () => purgeHolding(holdingDir, opts), { lockDir, lockWaitMs, lockPollMs });
  } catch (err) {
    if (!(err instanceof LockTimeoutError)) throw err;
    return { purged: [], kept: [], skipped: `holding folder is busy (lock not obtained): ${gitMessage(err)}` };
  }
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
    const settled = manifest ? settleItems(manifest) : { items: [], incomplete: [], unverified: [] };
    const items = settled.items;
    const stamps = items.map((i) => i?.archivedAt).filter((s) => Number.isFinite(Date.parse(s)));
    stamps.sort((a, b) => Date.parse(a) - Date.parse(b));
    return {
      batch,
      archivedAt: stamps.length ? stamps[stamps.length - 1] : null,
      ...(settled.incomplete.length ? { incomplete: settled.incomplete.length } : {}), // moves a failed write or a crash left unrecorded
      ...(settled.unverified.length ? { unverified: settled.unverified.length } : {}), // copies that do not match their entry: check by hand
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
    const { items, incomplete, unverified } = settleItems(manifest);
    if (unverified.length) {
      kept.push({ batch, reason: `holds ${unverified.length} unverified move(s) (${path.basename(unverified[0].stored)}) — needs a check by hand` });
      continue;
    }
    if (incomplete.length) {
      kept.push({ batch, reason: `holds ${incomplete.length} incomplete move(s) (${path.basename(incomplete[0].stored)}) — restore or remove by hand` });
      continue;
    }
    if (items.length === 0) {
      kept.push({ batch, reason: 'manifest lists no items' });
      continue;
    }
    let reason = null;
    for (const item of items) {
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
// `live` = { scan, spellings }: a FRESH scan of the open Claude sessions (one may have moved in since the run began),
// matched against the spellings of the path the worktree had BEFORE the move (the quarantine path is only temporary).
function reinspect(q, cfg, runStartMs, procOpts, live) {
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
  const open = liveSessionReasons(liveSessionsIn(live.scan(), [...live.spellings, ...pathSpellings(q)]));
  if (open.length) return { reason: `in use during removal: ${open.join('; ')}` };
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
// `liveScan` -> a scan of the open Claude sessions (live-sessions.mjs); it is called once, after the move and the settle wait.
export async function removeWorktree({ root, wt, cfg, pr, holdingDir, runId, runStartMs, settleMs = 5000, hooks = {}, procOpts, liveScan = scanLiveSessions, lockDir, lockWaitMs, lockPollMs }) {
  if (!RUN_ID.test(String(runId))) throw new Error(`removeWorktree: runId must match ${RUN_ID}: ${runId}`);
  if (!Number.isFinite(runStartMs)) throw new Error('removeWorktree: runStartMs must be a number');
  const qDir = path.join(path.dirname(wt.path), QUARANTINE_DIR);
  const q = path.join(qDir, `${wt.slug}.${runId}`);
  const spellings = pathSpellings(wt.path); // while the worktree is still there to resolve
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
    verdict = reinspect(q, cfg, runStartMs, procOpts, { scan: liveScan, spellings });
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
          archived.push(...archivePaths({ wtPath: q, originalRoot: wt.path, rels: [rel], holdingDir, slug: wt.slug, pr, nowMs, io: hooks.archiveIo }).items);
        }
      }, { lockDir, lockWaitMs, lockPollMs });
    }
    for (const rel of verdict.del) deleteInside(q, rel);
  } catch (err) {
    archived.push(...(err?.archivedItems ?? [])); // a file that could not be moved back is in holding: report it
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
