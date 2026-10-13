// Mutations for `pipeline worktrees` (spec docs/specs/2026-10-13-worktree-prune-design.md §3, §5). This part: the holding
// folder, where evidence files are parked (with a manifest) before a worktree is removed, and where they expire after 30 days.
import { createHash } from 'node:crypto';
import {
  copyFileSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, unlinkSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isInside, samePath } from '../paths.mjs';

const DAY_MS = 86400e3;
const MANIFEST = 'MANIFEST.json';
const safeName = (s) => String(s).replace(/[^A-Za-z0-9._-]/g, '_');

export function holdingRoot(repoSlug, env = process.env) {
  const base = env.PIPELINE_HOLDING_DIR || path.join(os.homedir(), '.local', 'share', 'pipeline', 'holding');
  return path.join(base, safeName(repoSlug));
}

// rename, or copy + unlink when the holding folder is on another device.
function moveFile(from, to) {
  try {
    renameSync(from, to);
  } catch (err) {
    if (err?.code !== 'EXDEV') throw err;
    copyFileSync(from, to);
    unlinkSync(from);
  }
}

function readManifest(dir) {
  try {
    const m = JSON.parse(readFileSync(path.join(dir, MANIFEST), 'utf8'));
    return m && Array.isArray(m.items) ? m : null;
  } catch {
    return null;
  }
}

// Temp file + rename, so a crash never leaves a half-written manifest next to the files it describes.
function writeManifestAtomic(dir, manifest) {
  const tmp = path.join(dir, `${MANIFEST}.tmp-${process.pid}`);
  writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`);
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

// `rels` are FILES inside the worktree. Each is moved to <holdingDir>/<YYYY-MM-DD>/<slug>/<rel>; the manifest in the
// dated dir is appended to (not replaced) when the same day archives again.
export function archivePaths({ wtPath, rels, holdingDir, slug, pr, nowMs }) {
  const batchDir = path.join(holdingDir, new Date(nowMs).toISOString().slice(0, 10));
  const archivedAt = new Date(nowMs).toISOString();
  const sources = rels.map((rel) => {
    const abs = path.resolve(wtPath, ...String(rel).split('/'));
    if (path.isAbsolute(rel) || !isInside(abs, wtPath) || samePath(abs, wtPath)) {
      throw new Error(`refusing to archive a path outside the worktree: ${rel}`);
    }
    return { rel, abs };
  });
  mkdirSync(batchDir, { recursive: true });
  const manifest = readManifest(batchDir) ?? { version: 1, items: [] };
  const items = [];
  for (const { rel, abs } of sources) {
    const data = readFileSync(abs);
    const stored = freeName(path.join(batchDir, safeName(slug), ...String(rel).split('/')));
    mkdirSync(path.dirname(stored), { recursive: true });
    moveFile(abs, stored);
    const item = {
      original: abs, stored, size: data.length, sha256: createHash('sha256').update(data).digest('hex'),
      archivedAt, slug, pr: pr ?? null,
    };
    items.push(item);
    manifest.items.push(item);
    writeManifestAtomic(batchDir, manifest); // after every file: a crash mid-batch still leaves a record of what moved
    pruneEmptyParents(path.dirname(abs), wtPath);
  }
  return { batchDir, items };
}

const shellQuote = (p) => (/[^A-Za-z0-9_\-./:\\]/.test(p) ? `'${p.replaceAll("'", "'\\''")}'` : p);

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
      restore: items.filter((i) => i?.stored && i?.original).map((i) => `mv ${shellQuote(i.stored)} ${shellQuote(i.original)}`),
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
