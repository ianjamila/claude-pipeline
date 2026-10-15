// The `pipeline worktrees prune` run (spec docs/specs/2026-10-13-worktree-prune-design.md §2–§7), composed from rules.mjs
// (decisions), prs.mjs (GitHub), inspect.mjs (facts) and act.mjs (the only mutations). Every mutation asks the mode table
// first, so `off` / `report` / `--dry-run` leave the repo and the holding folder exactly as they were. Also the repo
// context the other `worktrees` subcommands share (canonical root, its config, the origin-derived repo slug).
import { promises as fsp, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EXIT, UnavailableError } from '../cli.mjs';
import { Fail } from '../cmd-common.mjs';
import { loadConfig } from '../config.mjs';
import { GitError, git, showFile } from '../git.mjs';
import { createGitHub, guardGh } from '../github.mjs';
import { listWorktrees } from '../local-branches.mjs';
import { LockTimeoutError, withLock } from '../locks.mjs';
import { notifyEvent, parseRemote } from '../notify.mjs';
import { samePath } from '../paths.mjs';
import { QUARANTINE_DIR, holdingRoot, listHolding, purgeHolding, removeWorktree, restoreLeftovers } from './act.mjs';
import {
  checkAncestry, defaultTranscriptDirs, entriesFor, listCandidates, memoryMentions, processesInside, recentFiles,
  resolveCanonicalRoot, transcriptMentions, walkTree,
} from './inspect.mjs';
import { checkRepoIdentity, fetchBranchPrs } from './prs.mjs';
import { classifyEntries, inUseReasons, lockNameFor, modeAllows, selectLifecycle } from './rules.mjs';

const HOUR_MS = 3600e3;
const LOG_LINES = 30;
const SETTLE_MS = 5000; // spec §2 step 3
const MEASURE_CAP = 20000; // entries walked per outside item before its size is reported as partial
const safeName = (s) => String(s).replace(/[^A-Za-z0-9._-]/g, '_');
const oneLine = (err) => String(err?.message ?? err).replace(/\s*\n\s*/g, ' ').trim().slice(0, 200);

// The configured origin URL (not `remote get-url`, which expands url.<x>.insteadOf): it is what names the repository.
function configuredOrigin(root) {
  try {
    return git(['config', '--get', 'remote.origin.url'], { cwd: root }).trim();
  } catch (err) {
    if (err instanceof GitError) return '';
    throw err;
  }
}

const CONFIG_FILE = '.claude/pipeline.yml';

// The remote default branch's refs worth trying, best first: what origin/HEAD points at, then origin/main, origin/master.
function defaultBranchRefs(root) {
  const refs = [];
  try {
    const head = git(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], { cwd: root }).trim();
    if (head.startsWith('refs/remotes/')) refs.push(head.slice('refs/remotes/'.length));
  } catch (err) {
    if (!(err instanceof GitError)) throw err; // origin/HEAD is simply not set
  }
  for (const r of ['origin/main', 'origin/master']) if (!refs.includes(r)) refs.push(r);
  return refs;
}

// The config committed on the remote default branch, read through git (no checkout): { ref, text } or null. Only the
// canonical root's repository is asked, never a feature worktree's files, so a feature branch cannot change prune behaviour.
function committedConfig(root) {
  for (const ref of defaultBranchRefs(root)) {
    try {
      git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: root });
      const text = showFile(ref, CONFIG_FILE, { cwd: root });
      if (text !== null) return { ref, text };
    } catch (err) {
      if (!(err instanceof GitError)) throw err; // no such ref: try the next one
    }
  }
  return null;
}

// The validated config for the canonical root: its working tree's file first. Only when that file is MISSING (an invalid
// or unreadable one fails as ever) the copy committed on the remote default branch is used, because the main checkout may
// sit on a scratch branch that never had one. -> { loaded, configSource: 'worktree' | 'origin/<branch>' }.
async function loadRepoConfig(root) {
  let missing = false;
  const loaded = await loadConfig(root, {
    readFile: async (file, enc) => {
      try {
        return await fsp.readFile(file, enc);
      } catch (err) {
        if (err?.code === 'ENOENT') missing = true;
        throw err;
      }
    },
  });
  if (loaded.ok) return { loaded, configSource: 'worktree' };
  const fallback = missing ? committedConfig(root) : null;
  if (fallback === null) throw new Fail(EXIT.USAGE, { ok: false, error: 'config', errors: loaded.errors, path: loaded.path });
  const viaGit = await loadConfig(root, { readFile: async () => fallback.text });
  if (!viaGit.ok) throw new Fail(EXIT.USAGE, { ok: false, error: 'config', errors: viaGit.errors, path: `${fallback.ref}:${CONFIG_FILE}` });
  return { loaded: viaGit, configSource: fallback.ref };
}

// Canonical root (the main worktree, whichever checkout --repo names), its config and the repo's identity.
export async function loadRepo(values, ctx) {
  const dir = path.resolve(ctx?.cwd ?? process.cwd(), values.repo ?? '.');
  let canonical;
  try {
    canonical = resolveCanonicalRoot(dir);
  } catch (err) {
    if (err instanceof GitError) throw new Fail(EXIT.USAGE, { ok: false, error: 'repo', message: `not a git repository: ${dir}` });
    throw err;
  }
  const { root, commonDir } = canonical;
  const { loaded: { config }, configSource } = await loadRepoConfig(root);
  const originUrl = configuredOrigin(root);
  return {
    root, commonDir, config, configSource, w: config.worktrees, worktreeDir: config.worktree_dir, originUrl,
    slug: parseRemote(originUrl)?.slug ?? path.basename(root),
    name: config.project || path.basename(root),
  };
}

// One run per repository at a time; a second one answers `busy()` ("already running") instead of waiting.
async function withRunLock(commonDir, env, fn, busy) {
  try {
    return await withLock(lockNameFor(commonDir), fn, { dir: env.PIPELINE_LOCK_DIR || undefined, waitMs: 0 });
  } catch (err) {
    if (err instanceof LockTimeoutError) return busy();
    throw err;
  }
}

// spec §4 rule 7: an index.lock in the common dir (or any worktree's admin dir) means git is busy right now.
function gitBusy(commonDir) {
  const exists = (p) => {
    try {
      lstatSync(p);
      return true;
    } catch {
      return false;
    }
  };
  if (exists(path.join(commonDir, 'index.lock'))) return true;
  let names = [];
  try {
    names = readdirSync(path.join(commonDir, 'worktrees'));
  } catch { /* no linked worktrees */ }
  return names.some((n) => exists(path.join(commonDir, 'worktrees', n, 'index.lock')));
}

// --dry-run: what restoreLeftovers would move back, without moving anything.
function pendingLeftovers(root, worktreeDir) {
  const qDir = path.join(root, worktreeDir, QUARANTINE_DIR);
  let names;
  try {
    names = readdirSync(qDir).sort();
  } catch {
    return [];
  }
  return names.map((name) => {
    const dot = name.lastIndexOf('.');
    const to = dot > 0 ? path.join(root, worktreeDir, name.slice(0, dot)) : null;
    return { from: path.join(qDir, name), to, restored: false, reason: 'dry run: would move back' };
  });
}

function treeBytes(wtPath, walk) {
  let bytes = 0;
  for (const w of walk) {
    if (w.isDir) continue;
    try {
      bytes += lstatSync(path.join(wtPath, ...w.path.split('/'))).size;
    } catch { /* vanished */ }
  }
  return bytes;
}

// spec §4 rules 2–6 for one candidate. -> { ok: true, pr, bytes } | { reason }. The first failing rule is the reason.
// `hiddenProcesses`: processes that could not be inspected (other users'); reported by the run, never a keep reason.
function evaluate(c, { root, gh, w, nowMs, transcriptDirs, procs = processesInside }) {
  const found = fetchBranchPrs(gh, c.branch);
  if (!found.ok) return { reason: found.reason };
  const life = selectLifecycle(found.prs, { nowMs, minMergedHours: w.min_merged_hours });
  if (!life.ok) return { reason: life.reason };
  const pr = life.pr.number;
  const ancestry = checkAncestry(root, { head: c.head, pr: life.pr });
  if (!ancestry.ok) return { reason: ancestry.reason, pr };
  const walk = walkTree(c.path);
  const { blockers } = classifyEntries(entriesFor(c.path), w);
  if (blockers.length) return { reason: `files that exist only here (${blockers.slice(0, 3).join(', ')})`, pr };
  const sinceMs = nowMs - w.min_idle_hours * HOUR_MS;
  const processes = procs(c.path);
  const busy = inUseReasons({
    locked: null,
    processes,
    transcripts: transcriptMentions([c.path], { dirs: transcriptDirs, sinceMs }),
    memoryNotes: memoryMentions({ slug: c.slug, branch: c.branch }, { dirs: w.memory_dirs }),
    recentFiles: recentFiles(walk, { sinceMs, ignore: [...w.delete, ...w.archive] }),
  });
  if (busy.length) return { reason: busy.join('; '), pr, hiddenProcesses: processes.hidden };
  return { ok: true, pr, bytes: treeBytes(c.path, walk), hiddenProcesses: processes.hidden };
}

// Right before removal: the worktree must still be where, what and as unlocked as it was when it was evaluated.
// `list` is a test seam (ctx.pruneDeps.listWorktrees).
function unchangedSince(root, c, list = listWorktrees) {
  const now = list(root).find((e) => samePath(e.path, c.path));
  return Boolean(now) && now.locked === null && now.head === c.head && now.branch === c.branch;
}

function settleMs(env) {
  const n = Number(env.PIPELINE_PRUNE_SETTLE_MS);
  return env.PIPELINE_PRUNE_SETTLE_MS !== undefined && Number.isInteger(n) && n >= 0 ? n : SETTLE_MS;
}

async function evaluateCandidates(repo, { gh, mode, dryRun, env, runId, runStartMs, deps = {} }) {
  const { root, w, worktreeDir } = repo;
  const { candidates, skipped } = listCandidates(root, { worktreeDir, protect: w.protect, nowMs: runStartMs });
  const kept = skipped.map(({ slug, reason }) => ({ slug, reason }));
  const removed = [];
  const wouldRemove = [];
  // Other users' processes that could not be inspected: one /proc scan per worktree sees the same ones, so the run
  // reports the largest count once (a per-worktree copy would only repeat a number that changes from second to second).
  let hiddenProcesses = 0;
  // deps.processesInside is a test seam (ctx.pruneDeps.processesInside), like deps.listWorktrees below.
  const facts = { root, gh, w, nowMs: runStartMs, transcriptDirs: defaultTranscriptDirs(os.homedir(), env), procs: deps.processesInside };
  const holdingDir = holdingRoot(repo.slug, env);
  for (const c of candidates) {
    let v;
    try {
      v = evaluate(c, facts);
    } catch (err) {
      v = { reason: `could not inspect: ${oneLine(err)}` };
    }
    hiddenProcesses = Math.max(hiddenProcesses, v.hiddenProcesses ?? 0);
    if (!v.ok) {
      kept.push({ slug: c.slug, reason: v.reason, ...(v.pr ? { pr: v.pr } : {}) });
      continue;
    }
    const item = { slug: c.slug, branch: c.branch, pr: v.pr, bytes: v.bytes };
    if (!modeAllows(mode, 'remove', { dryRun })) {
      wouldRemove.push(item);
      continue;
    }
    let changed = null;
    try {
      if (!unchangedSince(root, c, deps.listWorktrees)) changed = 'changed during the run';
    } catch (err) {
      changed = `changed during the run (could not re-read: ${oneLine(err)})`; // never abort: earlier removals must be reported
    }
    if (changed) {
      kept.push({ slug: c.slug, reason: changed, pr: v.pr });
      continue;
    }
    let res;
    try {
      res = await removeWorktree({ root, wt: c, cfg: w, pr: v.pr, holdingDir, runId, runStartMs, settleMs: settleMs(env) });
    } catch (err) {
      res = { removed: false, reason: `removal failed: ${oneLine(err)}` };
    }
    const archived = (res.archived ?? []).map((a) => a.stored);
    if (res.removed) removed.push({ ...item, archived, deleted: res.deleted });
    else kept.push({ slug: c.slug, reason: res.reason, pr: v.pr, ...(archived.length ? { archived } : {}) });
  }
  return { removed, wouldRemove, kept, hiddenProcesses };
}

// Size and newest mtime of a path, symlinks never followed, at most MEASURE_CAP entries (then `partial: true`).
function measure(p) {
  let bytes = 0;
  let newestMs = 0;
  let seen = 0;
  const stack = [p];
  while (stack.length && seen < MEASURE_CAP) {
    const cur = stack.pop();
    let st;
    try {
      st = lstatSync(cur);
    } catch {
      continue;
    }
    seen += 1;
    newestMs = Math.max(newestMs, st.mtimeMs);
    if (st.isDirectory()) {
      try {
        for (const n of readdirSync(cur)) stack.push(path.join(cur, n));
      } catch { /* unreadable: counted as itself */ }
    } else bytes += st.size;
  }
  return { path: p, bytes, newestMs: Math.round(newestMs), ...(stack.length ? { partial: true } : {}) };
}

const listDir = (dir) => {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
};

// spec §6: things outside worktrees that only get REPORTED (read-only): container-root scratch and evidence, the
// screenshots folder, and Claude's per-session scratch (/tmp/claude-<uid>/<project>/<session>, POSIX only). Only a Claude
// project dir counts: Claude encodes the absolute project path with "/" -> "-" (-home-u-projects-app), so its name starts
// with "-". Other children (bash-edit-diff/<hash>, Claude Code's own edit-diff temp) are not sessions and are skipped.
export function outsideReport(root, env) {
  const items = [];
  for (const e of listDir(path.join(root, '.claude'))) {
    const p = path.join(root, '.claude', e.name);
    if (e.isFile() && (e.name.includes('brief') || e.name.endsWith('.patch'))) items.push(measure(p));
    else if (e.isDirectory() && e.name.endsWith('-ledgers')) items.push(measure(p));
  }
  for (const e of listDir(root)) {
    if (e.isDirectory() && (e.name === '.review' || e.name === '.verify')) items.push(measure(path.join(root, e.name)));
    else if (e.name === 'screenshots from mac') items.push({ path: path.join(root, e.name), bytes: null, newestMs: null });
  }
  const scratch = env.PIPELINE_SCRATCH_DIR || (typeof process.getuid === 'function' ? `/tmp/claude-${process.getuid()}` : null);
  if (scratch) {
    for (const project of listDir(scratch).filter((e) => e.isDirectory() && e.name.startsWith('-'))) {
      for (const session of listDir(path.join(scratch, project.name)).filter((e) => e.isDirectory())) {
        items.push(measure(path.join(scratch, project.name, session.name)));
      }
    }
  }
  return items;
}

export function formatBytes(n) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return i === 0 ? `${v} B` : `${v.toFixed(1)} ${units[i]}`;
}

// "open PR #2 on this branch" -> "open PR on this branch"; "PR data incomplete: HTTP 502" -> "PR data incomplete".
const reasonGroup = (reason) => String(reason).split(/[:(;]/)[0].replace(/\s*#\d+/g, '').trim() || 'other';

const summaryHead = ({ name, mode, dryRun }) => `worktrees prune (${name}, ${mode} mode${dryRun ? ', dry run' : ''})`;
const restoredPart = (restored) => `restored ${restored.filter((r) => r.restored).length} of ${restored.length} leftover quarantine${restored.length === 1 ? '' : 's'}`;

// spec §7: the one-line report (also the push text and the log line).
export function summaryLine({ name, mode, dryRun, removed, wouldRemove, kept, hiddenProcesses = 0, restored, outside, holding }) {
  const list = (xs) => xs.map((x) => `${x.slug}${x.pr ? ` #${x.pr}` : ''}`).join(', ');
  const total = (xs) => formatBytes(xs.reduce((s, x) => s + (x.bytes ?? 0), 0));
  const parts = [];
  if (removed.length) parts.push(`removed ${removed.length} (${total(removed)}): ${list(removed)}`);
  if (wouldRemove.length || !removed.length) parts.push(`would remove ${wouldRemove.length}${wouldRemove.length ? ` (${total(wouldRemove)}): ${list(wouldRemove)}` : ''}`);
  const groups = new Map();
  for (const k of kept) groups.set(reasonGroup(k.reason), (groups.get(reasonGroup(k.reason)) ?? 0) + 1);
  const grouped = [...groups].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([g, n]) => `${n} ${g}`).join(', ');
  parts.push(`kept ${kept.length}${grouped ? `: ${grouped}` : ''}`);
  if (hiddenProcesses) parts.push(`${hiddenProcesses} process${hiddenProcesses === 1 ? '' : 'es'} could not be inspected (other users)`);
  if (restored.length) parts.push(restoredPart(restored));
  parts.push(`outside worktrees: ${outside.length} item${outside.length === 1 ? '' : 's'} (report only)`);
  parts.push(`holding: ${holding.batches.length} batch${holding.batches.length === 1 ? '' : 'es'}${holding.purged.length ? `, purged ${holding.purged.length}` : ''}`);
  return `${summaryHead({ name, mode, dryRun })}: ${parts.join(' · ')}`;
}

// The one line for a run that evaluated nothing: skipped (already running, git busy) or disabled (off mode).
export function shortSummary({ name, mode, dryRun, skipped, restored = [] }) {
  const what = skipped ? `skipped — ${skipped}` : 'disabled';
  return `${summaryHead({ name, mode, dryRun })}: ${what}${restored.length ? ` · ${restoredPart(restored)}` : ''}`;
}

// <PIPELINE_PRUNE_LOG_DIR or ~/.local/state/pipeline>/prune-<slug>.log, the last LOG_LINES runs. -> the file, or null.
export const pruneLogDir = (env) => env.PIPELINE_PRUNE_LOG_DIR || path.join(os.homedir(), '.local', 'state', 'pipeline');

function appendLog(env, slug, line) {
  const dir = pruneLogDir(env);
  const file = path.join(dir, `prune-${safeName(slug)}.log`);
  mkdirSync(dir, { recursive: true });
  let lines = [];
  try {
    lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
  lines.push(line);
  writeFileSync(file, `${lines.slice(-LOG_LINES).join('\n')}\n`);
  return file;
}

// A run that evaluated nothing still leaves its one log line; a failing log write is an `errors` entry, never a failure.
function finishShort(repo, env, output) {
  output.summary = shortSummary({ name: repo.name, ...output });
  try {
    output.log = appendLog(env, repo.slug, `${new Date().toISOString()} ${output.summary}`);
  } catch (err) {
    output.errors = [{ step: 'log', error: oneLine(err) }];
  }
  return { exitCode: EXIT.OK, output };
}

async function pruneLocked(repo, { mode, dryRun, notify, ctx, env }) {
  const { root, worktreeDir } = repo;
  const runStartMs = Date.now();
  const runId = `${runStartMs.toString(36)}-${process.pid}`;
  const restored = modeAllows(mode, 'restore-leftover', { dryRun }) ? restoreLeftovers(root, worktreeDir) : pendingLeftovers(root, worktreeDir);

  const { removed, wouldRemove, kept, hiddenProcesses } = await guardGh(async () => {
    const gh = createGitHub({ cwd: root, env });
    const identity = checkRepoIdentity(gh, repo.originUrl);
    if (!identity.ok) {
      if (identity.unavailable) throw new UnavailableError(identity.reason);
      throw new Fail(EXIT.USAGE, { ok: false, error: 'repo-mismatch', message: identity.reason });
    }
    return evaluateCandidates(repo, { gh, mode, dryRun, env, runId, runStartMs, deps: ctx?.pruneDeps });
  });

  // Worktrees may already be gone: from here on a failing step becomes an `errors` entry, never a lost report.
  const errors = [];
  const step = async (name, fn, fallback) => {
    try {
      return await fn();
    } catch (err) {
      errors.push({ step: name, error: oneLine(err) });
      return fallback;
    }
  };
  const outside = await step('outside', () => outsideReport(root, env), []);
  const holdingDir = holdingRoot(repo.slug, env);
  const purged = modeAllows(mode, 'purge', { dryRun }) ? await step('purge', () => purgeHolding(holdingDir, { nowMs: Date.now() }).purged, []) : [];
  const holding = { batches: await step('holding', () => listHolding(holdingDir), []), purged };
  const summary = summaryLine({ name: repo.name, mode, dryRun, removed, wouldRemove, kept, hiddenProcesses, restored, outside, holding })
    + (errors.length ? ` · errors: ${errors.map((e) => e.step).join(', ')}` : '');
  const output = { ok: true, mode, dryRun, removed, wouldRemove, kept, hiddenProcesses, restored, outside, holding, summary, errors };

  const log = await step('log', () => appendLog(env, repo.slug, `${new Date().toISOString()} ${summary}`), null);
  if (log) output.log = log;
  if (notify && (removed.length || restored.some((r) => r.restored))) {
    output.notify = await step('notify', () => notifyEvent(
      { event: 'worktrees', pr: null, action: summary, ids: removed.map((r) => r.slug) },
      { cwd: root, env, ...(ctx?.notifyDeps ?? {}) },
    ), undefined);
  }
  return { exitCode: EXIT.OK, output };
}

export async function prune(values, ctx) {
  const env = ctx?.env ?? process.env;
  const repo = await loadRepo(values, ctx);
  const mode = repo.w.mode;
  const dryRun = values['dry-run'] === true;
  // Every completed invocation logs one line: the skips and off mode here, a full run in pruneLocked.
  const result = await withRunLock(repo.commonDir, env, async () => {
    // spec §4 rule 7: git is busy => no evaluation and no move at all, not even restoring a leftover quarantine.
    if (gitBusy(repo.commonDir)) return finishShort(repo, env, { ok: true, mode, dryRun, skipped: 'git operation in progress' });
    // off: no evaluation at all; only a dead run's quarantine is undone (that is allowed in every mode).
    if (!modeAllows(mode, 'evaluate', { dryRun })) {
      return finishShort(repo, env, { ok: true, mode, dryRun, disabled: true, restored: restoreLeftovers(repo.root, repo.worktreeDir) });
    }
    return pruneLocked(repo, { mode, dryRun, notify: values.notify === true, ctx, env });
  }, () => finishShort(repo, env, { ok: true, mode, dryRun, skipped: 'already running' }));
  if (repo.configSource === 'worktree') return result;
  const warning = `the main checkout has no ${CONFIG_FILE}; used the copy committed on ${repo.configSource}`;
  return { ...result, output: { ...result.output, warnings: [warning] } };
}

// --summary-only (the cron line): just `ok` and the one-line `summary`, plus `errors` when a step failed; a run that
// failed before it had a summary keeps its error output as it is. Printed compact (`compact: true`), so the unrotated
// cron log grows by one line per run.
export function summaryOnly({ exitCode, output }) {
  if (output.summary === undefined) return { exitCode, output, compact: true };
  return { exitCode, output: { ok: output.ok, summary: output.summary, ...(output.errors?.length ? { errors: output.errors } : {}), ...(output.warnings?.length ? { warnings: output.warnings } : {}) }, compact: true };
}
