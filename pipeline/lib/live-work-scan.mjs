// Why (plan 2026-11-10, PR B1 "Admission"): what the unattended installer (`install.mjs --require-no-live-reviews`) scans, while it holds the
// admission lock, before it swaps the pipeline's own files. One question: is any review work in flight on this machine? Every signal that says
// yes is returned as an entry { kind, repo?, pr?, worktree?, sessionId?, detail }; an empty list means nothing is live.
//   lease          a live (or unreadable) review lease                                  (lib/review-lease.mjs; unreadable counts as live)
//   job            a `P job` still running (or being started) in a worktree of a known repo
//   state-lock     a held per-repo-and-PR review state lock                              (`review-*` in the lock directory)
//   merge-lock     a held `P merge` lock, or a merge command that outlived its run        (`merge-*` and `<name>.child.json`)
//   queue-lock     a held `queue-*` lock (reserved: the queue sweep takes the merge lock per record today, so this stays empty)
//   queue-record   a merge-queue record whose work is not over                           (lib/merge-queue.mjs liveRecords)
//   scan-error     something could not be read: counts as live (fail closed), the detail says what
// The repos are the ones the machine knows (queue-sweep.mjs knownRepos: the stacks config plus every repo a merge told the registry about);
// their worktrees come from `git worktree list`, plus the root. This is a read-only look: it takes no lock and changes nothing.
// The caller passes `deadlineAt` (epoch ms): a scan that runs past it throws ScanDeadline so the installer can stop before swapping anything.
import fs from 'node:fs';
import path from 'node:path';
import { git } from './git.mjs';
import { readMergeChild } from './hold.mjs';
import { readJob } from './jobs.mjs';
import { defaultLockDir, peek } from './locks.mjs';
import { liveRecords } from './merge-queue.mjs';
import { knownRepos } from './queue-sweep.mjs';
import { blocking, scanLeases } from './review-lease.mjs';

export class ScanDeadline extends Error {
  constructor() {
    super('the live-work scan did not finish before its deadline');
    this.name = 'ScanDeadline';
  }
}

const STARTING_FRESH_MS = 60_000; // jobs.mjs LOCK_STALE_MS: a `<name>.starting` younger than this is a job being started
const LOCK_PREFIXES = [['review-', 'state-lock'], ['merge-', 'merge-lock'], ['queue-', 'queue-lock']];
const msg = (err) => String(err?.message ?? err).split('\n')[0].slice(0, 200);

// `git worktree list --porcelain` -> the worktree paths (the root is among them); the root alone when git cannot say.
function worktreesOf(root) {
  try {
    const out = git(['worktree', 'list', '--porcelain'], { cwd: root });
    const found = out.split('\n').filter((l) => l.startsWith('worktree ')).map((l) => path.resolve(l.slice('worktree '.length).trim()));
    return found.length > 0 ? found : [root];
  } catch {
    return [root];
  }
}

function jobsIn(worktree) {
  const dir = path.join(worktree, '.review', 'jobs');
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const name of names) {
    if (name.endsWith('.starting')) {
      try { if (Date.now() - fs.statSync(path.join(dir, name)).mtimeMs <= STARTING_FRESH_MS) out.push(`job ${name.slice(0, -'.starting'.length)} is being started`); } catch { /* gone */ }
      continue;
    }
    try { if (readJob(name, { cwd: worktree }).state === 'running') out.push(`job ${name} is running`); } catch { /* not a job folder */ }
  }
  return out;
}

const ownerText = (owner) => (owner?.incomplete ? 'an unfinished lock' : owner?.pid ? `pid ${owner.pid} on ${owner.host}, since ${owner.startedAt}` : 'an unknown holder');

function locksIn(dir, live) {
  let names;
  try { names = fs.readdirSync(dir); } catch (err) {
    if (err?.code !== 'ENOENT') live.push({ kind: 'scan-error', detail: `cannot list the lock directory ${dir}: ${msg(err)}` });
    return;
  }
  for (const file of names.sort()) {
    const m = /^(.+)\.lock$/.exec(file);
    const kind = m ? LOCK_PREFIXES.find(([prefix]) => m[1].startsWith(prefix))?.[1] : null;
    if (kind) {
      let seen;
      try { seen = peek(m[1], { dir }); } catch (err) { live.push({ kind: 'scan-error', detail: `cannot read the lock ${file}: ${msg(err)}` }); continue; }
      if (seen.state === 'held') live.push({ kind, detail: `${m[1]} is held by ${ownerText(seen.owner)}` });
      continue;
    }
    const child = /^(merge-.+)\.child\.json$/.exec(file);
    if (child) {
      const rec = readMergeChild(path.join(dir, file));
      if (rec.state === 'live') live.push({ kind: 'merge-lock', detail: `the merge command recorded in ${file} is still running (process group ${rec.pid})` });
      else if (rec.state === 'unreadable') live.push({ kind: 'merge-lock', detail: `the merge command record ${file} is unreadable (${rec.why}), treated as running` });
    }
  }
}

// -> [entry]. Options (all optional): env, home (for knownRepos), lockDir, deadlineAt, repos (an explicit list instead of knownRepos), leaseOpts (review-lease options).
export function scanLiveWork({ env: baseEnv = process.env, home, lockDir, deadlineAt = Infinity, repos, leaseOpts = {} } = {}) {
  // `lockDir` wins over PIPELINE_LOCK_DIR for everything kept in the lock folder (the held locks and the registry of known repos).
  const env = lockDir ? { ...baseEnv, PIPELINE_LOCK_DIR: lockDir } : baseEnv;
  const live = [];
  const tick = () => { if (Date.now() > deadlineAt) throw new ScanDeadline(); };

  tick();
  try {
    for (const e of blocking(scanLeases({ env, ...leaseOpts }))) {
      live.push({ kind: 'lease', ...(e.repoId !== undefined ? { repo: String(e.repoId) } : {}), ...(e.pr !== undefined ? { pr: e.pr } : {}), ...(e.worktree ? { worktree: e.worktree } : {}), sessionId: e.sessionId, detail: e.why });
    }
  } catch (err) {
    live.push({ kind: 'scan-error', detail: `cannot scan the review leases: ${msg(err)}` });
  }

  tick();
  locksIn(env.PIPELINE_LOCK_DIR || defaultLockDir(), live);

  let roots;
  try { roots = repos ?? knownRepos({ ...(home ? { home } : {}), env }); } catch (err) {
    roots = [];
    live.push({ kind: 'scan-error', detail: `cannot list the known repositories: ${msg(err)}` });
  }
  for (const root of roots) {
    tick();
    const seen = new Set();
    for (const wt of [root, ...worktreesOf(root)]) {
      if (seen.has(wt)) continue;
      seen.add(wt);
      for (const detail of jobsIn(wt)) live.push({ kind: 'job', repo: root, worktree: wt, detail });
    }
    tick();
    try {
      const unreadable = [];
      for (const rec of liveRecords(root, { onError: (err) => unreadable.push(msg(err)) })) {
        live.push({ kind: 'queue-record', repo: rec.repo ?? root, pr: rec.pr, worktree: root, detail: `merge-queue record for #${rec.pr} is not finished` });
      }
      for (const why of unreadable) live.push({ kind: 'queue-record', repo: root, detail: `a merge-queue record is unreadable (${why}), treated as live` });
    } catch (err) {
      live.push({ kind: 'scan-error', repo: root, detail: `cannot read the merge-queue records: ${msg(err)}` });
    }
  }
  tick();
  return live;
}
