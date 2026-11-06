// Why: `P merge --owner-go` may update the PR branch on GitHub (main merged in) and then advance the agent's checkout to the new
// head with `git merge --ff-only`, waiting for CI in between. It works in the ORIGINATING checkout, so for its whole life it must
// own that checkout: the marker `.review/merge-job.json` says so (the git guard refuses branch/index/worktree-mutating commands
// there while the marker's pid is alive: hooks/lib/git-policy.mjs), and every advance checks, immediately before and after, that
// nothing else moved the branch or HEAD or dirtied the tree. A moved ref is terminal (the caller reports it); the job never
// runs checkout / reset / stash to "fix" anything. No CLI wiring here: the merge loop calls these functions.
//
// claimCheckout   -> { ok: true, marker } | { ok: false, code: 'detached' | 'dirty' | 'busy' | 'git' | 'write', reason }
// advanceCheckout -> { ok: true, marker } | { ok: false, code: 'checkout-changed' | 'ff-refused' | 'bad-target' | 'write', reason }
// verifyCheckout  -> { ok: true } | { ok: false, code: 'checkout-changed', reason }
// releaseCheckout -> { released: boolean }
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { run } from './proc.mjs';
import { writeJson } from './review-context.mjs';
import { MERGE_JOB_FILE, parseMergeJobMarker } from '../hooks/lib/merge-job-lookup.mjs';
import { isPidAlive } from './locks.mjs';

export const MERGE_JOB_MARKER = MERGE_JOB_FILE;
const GIT_TIMEOUT_MS = 60_000;
const GIT_ENV = { GIT_TERMINAL_PROMPT: '0' };
// paths the pipeline itself writes in a checkout: they do not make it "dirty"
const OWN_DIRS = ['.review', '.verify'];
const MAX_PATHS_LISTED = 5;

const markerFile = (root) => path.join(root, MERGE_JOB_FILE);
const git = (root, args) => run('git', ['-C', root, ...args], { env: GIT_ENV, timeoutMs: GIT_TIMEOUT_MS });
const out = (r) => r.stdout.trim();
const failText = (r) => (r.stderr || r.stdout || `exit ${r.code}`).trim().split(/\r?\n/).slice(0, 3).join(' / ');

function readMarker(root) {
  try { return parseMergeJobMarker(readFileSync(markerFile(root), 'utf8')); } catch { return null; }
}

const isOwnPath = (p) => OWN_DIRS.some((d) => p === d || p.startsWith(`${d}/`));

// Paths git reports as changed, other than the pipeline's own folders. null when git cannot say.
function dirtyPaths(root) {
  const r = git(root, ['status', '--porcelain', '-z']);
  if (r.code !== 0) return null;
  const entries = r.stdout.split('\0').filter((e) => e !== '');
  const paths = [];
  for (let i = 0; i < entries.length; i++) {
    const code = entries[i].slice(0, 2);
    const own = [entries[i].slice(3)];
    if (/[RC]/.test(code)) own.push(entries[++i] ?? ''); // a rename / copy carries its source as the next entry
    if (!own.every(isOwnPath)) paths.push(own[0]);
  }
  return paths;
}

function dirtyProblem(root) {
  const dirty = dirtyPaths(root);
  if (dirty === null) return { code: 'git', reason: 'could not read the checkout status (git status failed)' };
  if (dirty.length === 0) return null;
  const more = dirty.length > MAX_PATHS_LISTED ? ` (+${dirty.length - MAX_PATHS_LISTED} more)` : '';
  return { code: 'dirty', reason: `the checkout has uncommitted changes: ${dirty.slice(0, MAX_PATHS_LISTED).join(', ')}${more}` };
}

export function claimCheckout({ root, pr, pid = process.pid, now = () => new Date() }) {
  const head = git(root, ['symbolic-ref', '-q', 'HEAD']);
  if (head.code !== 0 || out(head) === '') {
    return { ok: false, code: 'detached', reason: 'HEAD is detached (or not a repository): the merge job needs this checkout on a branch' };
  }
  const branch = out(head).replace(/^refs\/heads\//, '');
  const problem = dirtyProblem(root);
  if (problem) return { ok: false, ...problem };
  const existing = readMarker(root);
  if (existing !== null && isPidAlive(existing.pid)) {
    return { ok: false, code: 'busy', reason: `another merge job (pid ${existing.pid}, PR #${existing.pr}) already owns this checkout` };
  }
  const sha = git(root, ['rev-parse', '--verify', 'HEAD']);
  if (sha.code !== 0) return { ok: false, code: 'git', reason: `could not read HEAD: ${failText(sha)}` };
  const marker = { pr, pid, branch, expectedHead: out(sha), startedAt: new Date(now()).toISOString() };
  try {
    mkdirSync(path.dirname(markerFile(root)), { recursive: true });
    writeJson(markerFile(root), marker); // replaces a stale marker (dead pid) in the same rename
  } catch (err) {
    return { ok: false, code: 'write', reason: `could not write ${MERGE_JOB_FILE}: ${err?.code ?? err?.message}` };
  }
  return { ok: true, marker };
}

// Everything that must still hold before the job relies on, or moves, the checkout.
function checkBefore(root, marker) {
  const head = git(root, ['symbolic-ref', '-q', 'HEAD']);
  const current = head.code === 0 ? out(head).replace(/^refs\/heads\//, '') : null;
  if (current !== marker.branch) {
    return { ok: false, code: 'checkout-changed', reason: `HEAD moved: it was on branch ${marker.branch}, now ${current === null ? 'detached' : current}` };
  }
  const sha = git(root, ['rev-parse', '--verify', 'HEAD']);
  if (sha.code !== 0 || out(sha) !== marker.expectedHead) {
    return { ok: false, code: 'checkout-changed', reason: `${marker.branch} moved: it was ${marker.expectedHead}, now ${sha.code === 0 ? out(sha) : 'unreadable'}` };
  }
  const problem = dirtyProblem(root);
  if (problem) {
    return { ok: false, code: 'checkout-changed', reason: problem.code === 'dirty' ? `${problem.reason} (it was clean when the job started)` : problem.reason };
  }
  return { ok: true };
}

export function verifyCheckout({ root, marker }) {
  return checkBefore(root, marker);
}

export function advanceCheckout({ root, marker, to, beforeMerge }) {
  const target = git(root, ['rev-parse', '--verify', '--quiet', `${to}^{commit}`]);
  if (typeof to !== 'string' || to === '' || to.startsWith('-') || target.code !== 0) {
    return { ok: false, code: 'bad-target', reason: `${JSON.stringify(to)} is not a commit this checkout has (fetch first)` };
  }
  const sha = out(target);
  const before = checkBefore(root, marker);
  if (!before.ok) return before;
  if (beforeMerge) beforeMerge();
  const ff = git(root, ['merge', '--ff-only', sha]);
  // what the ref says now, whether or not git reported success
  const head = git(root, ['symbolic-ref', '-q', 'HEAD']);
  const branchNow = head.code === 0 ? out(head).replace(/^refs\/heads\//, '') : null;
  if (branchNow !== marker.branch) {
    return { ok: false, code: 'checkout-changed', reason: `HEAD moved during the advance: it was on branch ${marker.branch}, now ${branchNow === null ? 'detached' : branchNow}` };
  }
  const ref = git(root, ['rev-parse', '--verify', `refs/heads/${marker.branch}`]);
  const refNow = ref.code === 0 ? out(ref) : null;
  if (ff.code !== 0) {
    if (refNow !== marker.expectedHead) {
      return { ok: false, code: 'checkout-changed', reason: `refs/heads/${marker.branch} moved: it was ${marker.expectedHead}, now ${refNow ?? 'unreadable'}` };
    }
    return { ok: false, code: 'ff-refused', reason: `${marker.branch} cannot fast-forward to ${sha} (nothing changed): ${failText(ff)}` };
  }
  if (refNow !== sha) {
    return { ok: false, code: 'checkout-changed', reason: `refs/heads/${marker.branch} moved: it was ${marker.expectedHead} before the advance and should be ${sha}, now ${refNow ?? 'unreadable'}` };
  }
  const next = { ...marker, expectedHead: sha };
  try {
    writeJson(markerFile(root), next);
  } catch (err) {
    return { ok: false, code: 'write', reason: `advanced to ${sha} but could not update ${MERGE_JOB_FILE}: ${err?.code ?? err?.message}` };
  }
  return { ok: true, marker: next };
}

// removes the marker only when it is still the one this job wrote (same pid and start time)
export function releaseCheckout({ root, marker }) {
  const current = readMarker(root);
  if (current === null || current.pid !== marker.pid || current.startedAt !== marker.startedAt) return { released: false };
  try { rmSync(markerFile(root), { force: true }); } catch { return { released: false }; }
  return { released: true };
}
