// Fact gathering for `pipeline worktrees` (spec docs/specs/2026-10-13-worktree-prune-design.md §4): which worktrees are
// candidates, what is inside them, whether their commits are in the merged PR, and every "someone is using this" signal.
// Reads only (git status / fetch of a temporary ref / fs / /proc); the decisions live in rules.mjs and the mutations in act.mjs.
import { closeSync, lstatSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GitError, NETWORK_TIMEOUT_MS, git, isAncestor, revParse } from '../git.mjs';
import { listWorktrees } from '../local-branches.mjs';
import { expandHome, isInside, samePath } from '../paths.mjs';
import { gitCommonDir, repoRoot } from '../repo.mjs';
import { isProtectedName, matchesPattern } from './rules.mjs';

// Errors that mean "that entry is not readable / not there (any more)": other users' processes, a process that exited.
const SKIPPABLE = new Set(['EACCES', 'EPERM', 'ENOENT', 'ENOTDIR', 'ESRCH']);
function tolerant(fn, fallback) {
  try {
    return fn();
  } catch (err) {
    if (SKIPPABLE.has(err?.code)) return fallback;
    throw err;
  }
}

// The same answer from the main checkout and from inside any linked worktree: `root` is the first worktree git lists.
export function resolveCanonicalRoot(dir) {
  const top = repoRoot(dir);
  const commonDir = realpathSync(gitCommonDir(top));
  const root = listWorktrees(top)[0].path;
  return { root, commonDir };
}

// Direct children of <root>/<worktreeDir> only. Dot-named children (the quarantine dir, dotfiles) are ignored silently;
// every other worktree that is not a candidate is reported with the reason it was skipped.
export function listCandidates(root, { worktreeDir, protect }) {
  const wtDir = path.join(root, worktreeDir);
  const candidates = [];
  const skipped = [];
  for (const entry of listWorktrees(root).slice(1)) {
    if (!samePath(path.dirname(entry.path), wtDir)) continue;
    const slug = path.basename(entry.path);
    if (slug.startsWith('.')) continue;
    const skip = (reason) => skipped.push({ slug, path: entry.path, reason });
    if (isProtectedName(slug, protect)) skip('protected');
    else if (entry.prunable) skip('prunable (directory missing)');
    else if (entry.detached || !entry.branch) skip('detached HEAD');
    else if (entry.locked !== null) skip(`locked (${entry.locked || 'no reason given'})`);
    else candidates.push({ slug, path: entry.path, branch: entry.branch, head: entry.head, locked: null });
  }
  return { candidates, skipped };
}

// -> [{ path (posix, relative; a trailing "/" marks an ignored/untracked directory), kind: ignored|untracked|tracked-change }]
export function statusEntries(wtPath) {
  const out = git(['status', '--porcelain=v1', '--ignored', '--untracked-files=all', '-z'], { cwd: wtPath });
  const fields = out.split('\0');
  const entries = [];
  for (let i = 0; i < fields.length; i += 1) {
    const f = fields[i];
    if (f.length < 4) continue;
    const xy = f.slice(0, 2);
    const kind = xy === '!!' ? 'ignored' : xy === '??' ? 'untracked' : 'tracked-change';
    entries.push({ path: f.slice(3), kind });
    if (/[RC]/.test(xy)) i += 1; // a rename/copy carries its source path as the next field
  }
  return entries;
}

// Every entry under the worktree, symlinks not followed, the top-level `.git` file skipped. Posix relative paths.
export function walkTree(wtPath) {
  const out = [];
  const stack = [''];
  while (stack.length) {
    const rel = stack.pop();
    const dir = rel ? path.join(wtPath, ...rel.split('/')) : wtPath;
    for (const d of tolerant(() => readdirSync(dir, { withFileTypes: true }), [])) {
      if (!rel && d.name === '.git') continue;
      const childRel = rel ? `${rel}/${d.name}` : d.name;
      const st = tolerant(() => lstatSync(path.join(dir, d.name)), null);
      if (!st) continue;
      const isSymlink = st.isSymbolicLink();
      const isDir = st.isDirectory();
      out.push({ path: childRel, isSymlink, isDir, mtimeMs: st.mtimeMs });
      if (isDir) stack.push(childRel);
    }
  }
  return out;
}

// Status entries with every directory marker replaced by the files under it (same kind), plus `isSymlink` from the walk.
export function entriesFor(wtPath) {
  const walk = walkTree(wtPath);
  const byPath = new Map(walk.map((w) => [w.path, w]));
  const entries = [];
  for (const e of statusEntries(wtPath)) {
    if (!e.path.endsWith('/')) {
      entries.push({ path: e.path, kind: e.kind, isSymlink: byPath.get(e.path)?.isSymlink ?? false });
      continue;
    }
    for (const w of walk) {
      if (!w.isDir && w.path.startsWith(e.path)) entries.push({ path: w.path, kind: e.kind, isSymlink: w.isSymlink });
    }
  }
  return entries;
}

// Is every commit of the worktree's HEAD already in the PR's final head? Fetches refs/pull/<n>/head into a temporary ref
// (always deleted afterwards) and checks it is the head GitHub reported before trusting it.
export function checkAncestry(root, { head, pr }) {
  const n = pr.number;
  const ref = `refs/pipeline-prune/pr-${n}`;
  try {
    try {
      git(['fetch', '--no-tags', '-q', 'origin', `+refs/pull/${n}/head:${ref}`], { cwd: root, timeoutMs: NETWORK_TIMEOUT_MS });
    } catch (err) {
      if (!(err instanceof GitError)) throw err;
      return { ok: false, reason: `could not fetch PR #${n}: ${err.message}` };
    }
    const fetched = revParse(ref, { cwd: root });
    if (fetched !== pr.headRefOid) {
      return { ok: false, reason: `fetched PR #${n} head does not match GitHub (${fetched.slice(0, 7)} ≠ ${String(pr.headRefOid).slice(0, 7)})` };
    }
    if (!isAncestor(head, pr.headRefOid, { cwd: root })) return { ok: false, reason: `has commits that are not in PR #${n}` };
    return { ok: true };
  } catch (err) {
    if (!(err instanceof GitError)) throw err;
    return { ok: false, reason: `could not check PR #${n} ancestry: ${err.message}` };
  } finally {
    try {
      git(['update-ref', '-d', ref], { cwd: root });
    } catch { /* nothing to delete, or the repo is unreadable: the next run's check reports it */ }
  }
}

// Linux only: processes whose cwd or any open fd lies inside `dir`. Elsewhere the answer is "unavailable" (callers keep).
export function processesInside(dir, { procRoot = '/proc', platform = process.platform } = {}) {
  if (platform !== 'linux') return { available: false, pids: [] };
  let names;
  try {
    names = readdirSync(procRoot);
  } catch {
    return { available: false, pids: [] };
  }
  const inside = (p) => p !== null && isInside(p, dir);
  const pids = [];
  for (const name of names.filter((n) => /^\d+$/.test(n))) {
    const proc = path.join(procRoot, name);
    const links = [tolerant(() => readlinkSync(path.join(proc, 'cwd')), null)];
    for (const fd of tolerant(() => readdirSync(path.join(proc, 'fd')), [])) {
      links.push(tolerant(() => readlinkSync(path.join(proc, 'fd', fd)), null));
    }
    if (links.some(inside)) pids.push(Number(name));
  }
  return { available: true, pids: pids.sort((a, b) => a - b) };
}

// *.jsonl files two levels down: <dir>/<project>/*.jsonl and <dir>/<project>/<session>/subagents/*.jsonl.
function transcriptFiles(dir) {
  const files = [];
  const listDir = (d) => tolerant(() => readdirSync(d, { withFileTypes: true }), []);
  for (const project of listDir(dir).filter((e) => e.isDirectory())) {
    const pdir = path.join(dir, project.name);
    for (const e of listDir(pdir)) {
      if (e.isFile() && e.name.endsWith('.jsonl')) files.push(path.join(pdir, e.name));
      else if (e.isDirectory()) {
        const sub = path.join(pdir, e.name, 'subagents');
        for (const s of listDir(sub)) if (s.isFile() && s.name.endsWith('.jsonl')) files.push(path.join(sub, s.name));
      }
    }
  }
  return files;
}

// 1 MiB chunks; the last (longest needle - 1) bytes of each chunk are prepended to the next so a needle cannot hide on a seam.
function fileContainsAny(file, needles) {
  const keep = Math.max(...needles.map((n) => n.length)) - 1;
  const fd = openSync(file, 'r');
  try {
    const chunk = Buffer.alloc(1 << 20);
    let tail = Buffer.alloc(0);
    for (;;) {
      const n = readSync(fd, chunk, 0, chunk.length, null);
      if (n === 0) return false;
      const buf = Buffer.concat([tail, chunk.subarray(0, n)]);
      if (needles.some((needle) => buf.includes(needle))) return true;
      tail = buf.subarray(Math.max(0, buf.length - keep));
    }
  } finally {
    closeSync(fd);
  }
}

// Paths of Claude transcripts (*.jsonl) modified at or after sinceMs that mention any needle.
export function transcriptMentions(needles, { dirs, sinceMs }) {
  const wanted = needles.filter(Boolean).map((n) => Buffer.from(n));
  if (!wanted.length) return [];
  const hits = [];
  for (const dir of dirs) {
    for (const file of transcriptFiles(dir)) {
      const st = tolerant(() => lstatSync(file), null);
      if (st && st.mtimeMs >= sinceMs && tolerant(() => fileContainsAny(file, wanted), false)) hits.push(file);
    }
  }
  return hits;
}

// $CLAUDE_CONFIG_DIR/projects plus every <home>/.claude*/projects that exists, de-duplicated by realpath.
export function defaultTranscriptDirs(home = os.homedir(), env = process.env) {
  const named = tolerant(() => readdirSync(home), []).filter((n) => /^\.claude/.test(n)).sort();
  const wanted = [env.CLAUDE_CONFIG_DIR && path.join(env.CLAUDE_CONFIG_DIR, 'projects'), ...named.map((n) => path.join(home, n, 'projects'))];
  const seen = new Set();
  const dirs = [];
  for (const dir of wanted.filter(Boolean)) {
    const real = tolerant(() => realpathSync(dir), null);
    if (real === null || seen.has(real)) continue;
    seen.add(real);
    dirs.push(dir);
  }
  return dirs;
}

// Memory notes (*.md, the dir itself and one level of subdirs; never MEMORY-archive.md or an archive/ dir) with a line that
// names the slug or branch AND says the work is live (BUILDING / ledger home / keep).
export function memoryMentions({ slug, branch }, { dirs }) {
  const names = [slug, branch].filter(Boolean);
  const live = /BUILDING|ledger home|\bkeep\b/i;
  const hits = [];
  const listDir = (d) => tolerant(() => readdirSync(d, { withFileTypes: true }), []);
  const scan = (file) => {
    const text = tolerant(() => readFileSync(file, 'utf8'), '');
    if (text.split(/\r?\n/).some((line) => live.test(line) && names.some((n) => line.includes(n)))) hits.push(file);
  };
  for (const raw of dirs) {
    const dir = expandHome(raw);
    for (const e of listDir(dir)) {
      if (e.isFile() && e.name.endsWith('.md') && e.name !== 'MEMORY-archive.md') scan(path.join(dir, e.name));
      else if (e.isDirectory() && e.name !== 'archive') {
        for (const f of listDir(path.join(dir, e.name))) {
          if (f.isFile() && f.name.endsWith('.md') && f.name !== 'MEMORY-archive.md') scan(path.join(dir, e.name, f.name));
        }
      }
    }
  }
  return hits;
}

// Files (not directories) changed at or after sinceMs that match no `ignore` pattern: the delete + archive lists.
export function recentFiles(walk, { sinceMs, ignore }) {
  return walk
    .filter((w) => !w.isDir && w.mtimeMs >= sinceMs && !ignore.some((p) => matchesPattern(w.path, p)))
    .map((w) => w.path);
}
