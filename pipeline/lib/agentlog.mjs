// The agent log: one line per pipeline run, in a markdown file the project keeps (config.agent_log). Merged PRs cannot
// commit their own "merged" line (the merge is the last step), so lines wait in a queue under the git common dir
// (shared by every worktree of the repo) and ride along with the NEXT PR that stages the log. The queue is JSONL,
// guarded by a named lock so a `queue` and a `stage` in two worktrees never lose or duplicate a line.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { git, showFile, NETWORK_TIMEOUT_MS } from './git.mjs';
import { pipelineStateDir } from './repo.mjs';
import { withLock } from './locks.mjs';
import { agentLogLine } from './render.mjs';
import { isInside } from './paths.mjs';

// Same text as pipeline/templates/agent-log.md, which `pipeline-setup` copies into new projects.
export const AGENT_LOG_HEADER = [
  '# Agent log',
  '',
  'One line per pipeline run, newest last. Written by the `ship` skill; the PR summary comment is the',
  'full record.',
  '',
].join('\n');

// The outcome of the line `stage` writes for a run that merged: the production smoke has not reported yet.
export const DEFAULT_OUTCOME = 'merged — prod smoke pending';

const QUEUE_FILE = 'agent-log-queue.jsonl';
const LOCK_NAME = 'agent-log-queue';
const LOCK_WAIT_MS = 30_000;

export const queuePath = (cwd) => join(pipelineStateDir(cwd), QUEUE_FILE);

// Inside the state dir, and short-lived: the lock is only ever held across a queue read-modify-write (+ one commit).
export const withQueueLock = (cwd, fn) =>
  withLock(LOCK_NAME, fn, { dir: join(pipelineStateDir(cwd), 'locks'), waitMs: LOCK_WAIT_MS });

// Every entry is `{line, at}` plus, once `stage` committed it into a PR branch, `staged: {pr, at}`: such an entry stays queued
// until the line is seen on origin/<default> (a PR that never merges would otherwise lose it). A line that is not valid
// JSON or has no string `line` is dropped rather than trusted.
export function readQueue(cwd) {
  let text;
  try {
    text = readFileSync(queuePath(cwd), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const entries = [];
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    try {
      const e = JSON.parse(raw);
      if (e && typeof e.line === 'string' && e.line !== '') {
        const entry = { line: e.line, at: e.at ?? null };
        if (Number.isInteger(e.staged?.pr) && e.staged.pr > 0) entry.staged = { pr: e.staged.pr, at: e.staged.at ?? null };
        entries.push(entry);
      }
    } catch { /* a torn or hand-edited line: skip it */ }
  }
  return entries;
}

export function writeQueue(cwd, entries) {
  const file = queuePath(cwd);
  if (entries.length === 0) {
    rmSync(file, { force: true });
    return;
  }
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`);
  renameSync(tmp, file);
}

// One markdown line per entry: a newline inside would let a value forge extra log lines.
export function assertSingleLine(line) {
  if (typeof line !== 'string' || line.trim() === '') throw new TypeError('agent log line must be a non-empty string');
  if (/[\r\n\u2028\u2029]/.test(line)) throw new TypeError('agent log line must be a single line');
  return line.trim();
}

// Idempotent: a line already in the queue (staged in some open PR or not) is not added again. Caller holds the queue lock.
export function appendToQueue(cwd, line, at = new Date().toISOString()) {
  const clean = assertSingleLine(line);
  if (readQueue(cwd).some((e) => e.line === clean)) return clean;
  const file = queuePath(cwd);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify({ line: clean, at })}\n`);
  return clean;
}

// How many rounds had the arbiter consulted. A round counts when it records `arbiter.called`, or when any of its items
// carries an arbiter ruling (the review loop stores the ruling on the item).
export function countArbiterCalls(state) {
  return (state?.rounds ?? []).filter((r) => r?.arbiter?.called === true || (r?.items ?? []).some((i) => i?.arbiter)).length;
}

export function buildAgentLogLine({ state, pr, title, outcome, now = new Date() }) {
  return agentLogLine({
    date: now.toISOString().slice(0, 10),
    pr,
    title,
    risk: state?.risk ?? 'unknown',
    rounds: state?.rounds?.length ?? 0,
    arbiterCalls: countArbiterCalls(state),
    outcome,
  });
}

// The log path from config, which is never validated as a path: refuse absolute paths and anything leaving the repo.
export function resolveLogPath(root, agentLog) {
  if (typeof agentLog !== 'string' || agentLog.trim() === '') throw new TypeError('config.agent_log must be a non-empty path');
  if (isAbsolute(agentLog) || /^[A-Za-z]:/.test(agentLog)) throw new TypeError(`config.agent_log must be relative to the repo: ${agentLog}`);
  const abs = resolve(root, agentLog);
  if (abs === resolve(root) || !isInside(abs, root)) throw new TypeError(`config.agent_log must stay inside the repo: ${agentLog}`);
  return abs;
}

// Header (when the file is new) + the lines not already in the file, oldest first. A line already present verbatim is
// not written twice, so re-running `stage` after a half-finished attempt never duplicates history.
export function appendLines(existing, lines) {
  const have = new Set((existing ?? '').split('\n'));
  const fresh = [];
  for (const l of lines) {
    if (!have.has(l) && !fresh.includes(l)) fresh.push(l);
  }
  let text = existing ?? AGENT_LOG_HEADER;
  if (fresh.length > 0) {
    if (text !== '' && !text.endsWith('\n')) text += '\n';
    text += `${fresh.join('\n')}\n`;
  }
  return { text, fresh };
}

// Stage and commit `lines` into the log file of the worktree at `root`. Caller has checked the tree is clean and holds
// the queue lock. Returns the commit SHA, or null when every line was already in the file. On a failed git step the
// file is put back, so the worktree is as clean as it was found.
export function commitLines({ root, file, lines, pr }) {
  const o = { cwd: root };
  const existed = existsSync(file);
  const before = existed ? readFileSync(file, 'utf8') : null;
  const { text, fresh } = appendLines(before, lines);
  if (fresh.length === 0 && existed) return { sha: null, fresh };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  const rel = relative(root, file).split('\\').join('/');
  try {
    git(['add', '--', rel], o);
    git(['commit', '-q', '-m', `docs: agent log for #${pr}`, '--', rel], o);
  } catch (err) {
    try {
      git(['reset', '-q', '--', rel], o);
    } catch { /* nothing staged */ }
    if (existed) writeFileSync(file, before);
    else rmSync(file, { force: true });
    throw err;
  }
  return { sha: git(['rev-parse', 'HEAD'], o).trim(), fresh };
}

// The log lines already on origin/<default>, and whether the refresh of that ref succeeded. `lines` is null when the default
// branch (or the log file there) cannot be read, which keeps every queued entry queued. `fetch` refreshes origin/<default>
// first (best effort, bounded): without it a merge we have not fetched yet just keeps the line queued a little longer.
// `refreshed` is true only when a requested fetch succeeded: a readable but possibly STALE cached ref has lines and
// refreshed false, which a caller that moves a shared checkpoint must tell apart from a fresh copy.
export function originLogLines(root, { logFile, defaultBranch, fetch = false }) {
  const o = { cwd: root };
  let refreshed = false;
  try {
    if (fetch) {
      try {
        git(['fetch', '--no-tags', 'origin', `+refs/heads/${defaultBranch}:refs/remotes/origin/${defaultBranch}`], { ...o, timeoutMs: NETWORK_TIMEOUT_MS });
        refreshed = true;
      } catch { /* offline, or no origin: judge by the ref we already have */ }
    }
    const rel = relative(root, logFile).split('\\').join('/');
    const text = showFile(`origin/${defaultBranch}`, rel, o);
    return { lines: text === null ? new Set() : new Set(text.split('\n').map((l) => l.replace(/\r$/, ''))), refreshed };
  } catch {
    return { lines: null, refreshed };
  }
}

// The lines alone: null when origin/<default>'s copy cannot be read.
export const landedLines = (root, opts) => originLogLines(root, opts).lines;

// Rewrite the queue without the entries that were just written (matched one-for-one, so an identical line queued
// again meanwhile survives). Entries appended since the read are kept.
export function clearWritten(cwd, written) {
  const remaining = readQueue(cwd);
  for (const w of written) {
    const at = remaining.findIndex((e) => e.line === w.line && e.at === w.at);
    if (at >= 0) remaining.splice(at, 1);
  }
  writeQueue(cwd, remaining);
}
