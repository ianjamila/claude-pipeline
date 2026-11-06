// Why: a `P merge --owner-go` job (lib/merge-job.mjs) owns its checkout while it runs and says so in `.review/merge-job.json`.
// The git guard (git-policy.mjs, through git-wiring.mjs) asks this lookup whether the directory a git command acts on belongs to a
// live job. It is deliberately tiny and dependency-light (the guard runs on every command): no git process, only a walk up to the
// checkout root and one file read. It only ever answers on a VALID marker with a LIVE pid; a missing, unreadable, garbled or
// stale (dead pid) marker is "no job", so a broken file can never lock an agent out of its own checkout.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { isPidAlive } from '../../lib/locks.mjs';

export const MERGE_JOB_FILE = path.join('.review', 'merge-job.json');

// the marker object when it has the shape the job writes, else null
export function parseMergeJobMarker(text) {
  let m;
  try { m = JSON.parse(text); } catch { return null; }
  if (m === null || typeof m !== 'object' || Array.isArray(m)) return null;
  if (!Number.isInteger(m.pid) || m.pid <= 0) return null;
  if (!Number.isInteger(m.pr) || m.pr <= 0) return null;
  if (typeof m.branch !== 'string' || typeof m.expectedHead !== 'string' || typeof m.startedAt !== 'string') return null;
  return m;
}

// the checkout root holding `dir` (a `.git` directory or, in a linked worktree, a `.git` file), or null
export function checkoutRootOf(dir, exists = existsSync) {
  if (typeof dir !== 'string' || dir === '') return null;
  let d = path.resolve(dir);
  try { d = realpathSync.native(d); } catch { /* a directory that does not exist yet: judge the path as written */ }
  for (;;) {
    if (exists(path.join(d, '.git'))) return d;
    const up = path.dirname(d);
    if (up === d) return null;
    d = up;
  }
}

// { ...marker, root } when a live job owns the checkout containing `dir`, else null
export function mergeJobOf(dir, { readText = (p) => readFileSync(p, 'utf8'), isAlive = isPidAlive, exists = existsSync } = {}) {
  try {
    const root = checkoutRootOf(dir, exists);
    if (root === null) return null;
    const marker = parseMergeJobMarker(readText(path.join(root, MERGE_JOB_FILE)));
    return marker !== null && isAlive(marker.pid) ? { ...marker, root } : null;
  } catch {
    return null;
  }
}
