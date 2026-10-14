// The agent log: one line per pipeline run, in a markdown file the project keeps (config.agent_log). The log lives on its
// own orphan branch (`pipeline-agent-log`, like `pipeline-artifacts`), NEVER in a PR branch: a file every PR edits would conflict
// as soon as main moves and every update would be a new head to approve. Lines wait in a queue under the git common dir (shared
// by every worktree of the repo) until `publish` pushes them to that branch. The queue is JSONL, guarded by a named lock so a
// `queue` and a `publish` in two worktrees never lose or duplicate a line.
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { git, GitError, NETWORK_TIMEOUT_MS } from './git.mjs';
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

// The outcome of the line the ship skill logs for a run that merged: the production smoke has not reported yet.
export const DEFAULT_OUTCOME = 'merged — prod smoke pending';

const QUEUE_FILE = 'agent-log-queue.jsonl';
const LOCK_NAME = 'agent-log-queue';
const LOCK_WAIT_MS = 30_000;

export const queuePath = (cwd) => join(pipelineStateDir(cwd), QUEUE_FILE);

// Inside the state dir, and short-lived: the lock is only ever held across a queue read-modify-write (+ one publish).
export const withQueueLock = (cwd, fn) =>
  withLock(LOCK_NAME, fn, { dir: join(pipelineStateDir(cwd), 'locks'), waitMs: LOCK_WAIT_MS });

// Every entry is `{line, at}`. (Older queue files may carry `staged: {pr, at}` from the retired "staged in PR N" flow: it is
// ignored, the entry is plain queued.) A line that is not valid JSON or has no string `line` is dropped rather than trusted.
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
      if (e && typeof e.line === 'string' && e.line !== '') entries.push({ line: e.line, at: e.at ?? null });
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

// Idempotent: a line already in the queue is not added again. Caller holds the queue lock.
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
// not written twice, so re-running `publish` after a half-finished attempt never duplicates history.
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

// ---- the log branch ------------------------------------------------------------------------------

export const AGENT_LOG_BRANCH = 'pipeline-agent-log';
const REMOTE = 'origin';
const ATTEMPTS = 3; // concurrent pipelines push to the same branch; a lost race is retried on top of the new tip
const FALLBACK_IDENT = { GIT_AUTHOR_NAME: 'claude-pipeline', GIT_AUTHOR_EMAIL: 'claude-pipeline@users.noreply.github.com', GIT_COMMITTER_NAME: 'claude-pipeline', GIT_COMMITTER_EMAIL: 'claude-pipeline@users.noreply.github.com' };

// The only ref this module may ever write on the remote. Asserted right before the push, so a refactor that computes the
// destination differently cannot publish to the default branch.
export function assertSafeLogTarget(ref) {
  if (ref !== `refs/heads/${AGENT_LOG_BRANCH}`) throw new Error(`refusing to push the agent log to ${JSON.stringify(ref)}: only refs/heads/${AGENT_LOG_BRANCH} is allowed`);
  return ref;
}

// The log path inside the branch: resolveLogPath's rules (relative, inside the repo), then forward slashes with no empty, `.`,
// `..` or `.git` segment, because the same string becomes a path in a tree object.
export function logRelPath(root, agentLog) {
  const rel = relative(resolve(root), resolveLogPath(root, agentLog)).split('\\').join('/');
  const segments = rel.split('/');
  if (rel === '' || segments.some((s) => s === '' || s === '.' || s === '..' || s.toLowerCase() === '.git')) {
    throw new TypeError(`config.agent_log is not a usable path inside the repo: ${agentLog}`);
  }
  return rel;
}

const isRaceFailure = (err) => err instanceof GitError && /rejected|non-fast-forward|fetch first|stale info|failed to push some refs/i.test(err.stderr ?? '');
const REMOTE_LOG_REF = `refs/remotes/${REMOTE}/${AGENT_LOG_BRANCH}`;

// Refreshes the remote-tracking copy of the log branch. -> { tip, exists, refreshed }: `exists` false means the remote has no such
// branch (a normal state before the first publish); any other failure is a real one and throws.
function fetchLogBranch(root, g) {
  try {
    g(['ls-remote', '--exit-code', '--heads', REMOTE, `refs/heads/${AGENT_LOG_BRANCH}`], root, NETWORK_TIMEOUT_MS);
  } catch (err) {
    if (err instanceof GitError && err.code === 2) return { tip: null, exists: false };
    throw err;
  }
  g(['fetch', '--no-tags', REMOTE, `+refs/heads/${AGENT_LOG_BRANCH}:${REMOTE_LOG_REF}`], root, NETWORK_TIMEOUT_MS);
  return { tip: g(['rev-parse', '--verify', '-q', REMOTE_LOG_REF], root).trim(), exists: true };
}

// The log branch is NOT protected: anyone with push access can rewrite it, so everything read from it is untrusted data. It is only ever
// compared line by line or appended to; it is never executed, put into a command line, or used as a path.
export const MAX_LOG_BYTES = 5 * 1024 * 1024;
export class LogTooLargeError extends Error {
  constructor(ref, size) {
    super(`the agent log at ${ref} is ${size} bytes, over the 5 MB limit: refusing to read it (trim or replace the file on that branch)`);
    this.name = 'LogTooLargeError';
  }
}
const OID_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

// The file `rel` at `ref` as text, or null when there is no REGULAR file there: missing ref or path, a symlink, a submodule, a tree,
// an executable-bit file (anything but mode 100644 as a blob). Over MAX_LOG_BYTES it throws LogTooLargeError before reading the
// content. `run(args)` is the caller's git (cwd already bound).
function readRegularFile(run, ref, rel, { strictRef = false } = {}) {
  try {
    run(['rev-parse', '--verify', '-q', `${ref}^{commit}`]);
  } catch (err) {
    if (err instanceof GitError && err.code === 1 && !strictRef) return null; // strictRef: a missing ref is an error, not "no file"
    throw err;
  }
  const entries = run(['ls-tree', '-z', '-l', ref, '--', rel]).split('\0').filter(Boolean);
  for (const entry of entries) {
    const tab = entry.indexOf('\t');
    if (tab < 0 || entry.slice(tab + 1) !== rel) continue; // exact path only
    const m = /^(\d{6}) (\w+) ([0-9a-f]+) +(\d+|-)$/.exec(entry.slice(0, tab));
    if (!m || m[1] !== '100644' || m[2] !== 'blob' || !OID_RE.test(m[3])) return null;
    if (Number(m[4]) > MAX_LOG_BYTES) throw new LogTooLargeError(ref, m[4]);
    return run(['cat-file', 'blob', m[3]]);
  }
  return null;
}

// A commit on top of `parent` (or a root commit) whose tree contains ONLY `rel`, built fresh from `text`: nothing is carried over
// from the parent's tree (a file someone planted on the branch, say a workflow, never rides into our commit). Built with plumbing in a
// private temp index: the caller's index, HEAD, branches and working tree are never read or written.
function commitFile({ root, g, rel, text, parent, message }) {
  const dir = mkdtempSync(join(tmpdir(), 'cp-agent-log-'));
  try {
    const env = { GIT_INDEX_FILE: join(dir, 'index') };
    const run = (args, extra = {}) => gitIn(g, root, args, { env, ...extra });
    const blob = run(['hash-object', '-w', '--stdin'], { input: text }).trim();
    run(['update-index', '--add', '--cacheinfo', `100644,${blob},${rel}`]);
    const tree = run(['write-tree']).trim();
    let ident = {};
    try {
      g(['var', 'GIT_AUTHOR_IDENT'], root);
      g(['var', 'GIT_COMMITTER_IDENT'], root);
    } catch { ident = FALLBACK_IDENT; } // no user.name / user.email configured (a CI box)
    return gitIn(g, root, ['-c', 'commit.gpgsign=false', 'commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', message], { env: ident }).trim();
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
}

// `g(args, cwd, timeoutMs)` is the publisher's git; this variant also passes env / input through to the injectable gitFn.
function gitIn(g, cwd, args, { env, input } = {}) {
  return g(args, cwd, undefined, { env, input });
}

/**
 * Appends `lines` to the log file (`logRel`) on the orphan branch `pipeline-agent-log` and pushes that one ref.
 * A new branch is seeded from origin/<defaultBranch>'s copy of the file (keeps the history the log had in code), else the
 * header. Lines already in the file are not written twice. A lost push race is retried on top of the new tip (x3). Never forces,
 * never touches the caller's HEAD / index / branches / working tree. `gitFn` is injectable for tests.
 * -> { commit, pushed, lines } (`lines`: the ones actually appended). Throws on a git failure; the caller keeps its lines queued.
 */
export function publishLines({ root, logRel, lines, defaultBranch, gitFn = git }) {
  const g = (args, cwd = root, timeoutMs, extra = {}) => gitFn(args, { cwd, ...(timeoutMs ? { timeoutMs } : {}), ...extra });
  const clean = lines.map(assertSingleLine);
  let lastErr;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      const { tip } = fetchLogBranch(root, g);
      if (tip !== null && !OID_RE.test(tip)) throw new GitError({ args: ['rev-parse'], code: 0, stderr: `unexpected tip id: ${String(tip).slice(0, 80)}` });
      const read = (ref) => readRegularFile((args) => g(args, root), ref, logRel);
      let existing = tip ? read(tip) : null;
      if (existing === null) {
        try {
          g(['fetch', '--no-tags', REMOTE, `+refs/heads/${defaultBranch}:refs/remotes/${REMOTE}/${defaultBranch}`], root, NETWORK_TIMEOUT_MS);
        } catch { /* offline default branch: seed from the cached ref, or the header */ }
        // No regular log file on the branch (a new branch, or something else at that path): start from main's copy, else the header.
        existing = read(`${REMOTE}/${defaultBranch}`);
      }
      const { text, fresh } = appendLines(existing, clean);
      if (fresh.length === 0) return { commit: tip, pushed: false, lines: [] }; // all already in the log: nothing to push
      const commit = commitFile({ root, g, rel: logRel, text, parent: tip, message: `docs: agent log (${fresh.length} line${fresh.length === 1 ? '' : 's'})` });
      const dest = assertSafeLogTarget(`refs/heads/${AGENT_LOG_BRANCH}`);
      g(['push', '--no-verify', REMOTE, `${commit}:${dest}`], root, NETWORK_TIMEOUT_MS);
      return { commit, pushed: true, lines: fresh };
    } catch (err) {
      lastErr = err;
      if (!isRaceFailure(err) || attempt === ATTEMPTS) throw err;
    }
  }
  throw lastErr;
}

// The log lines already published: the log branch's copy UNION origin/<default>'s (a PR opened before this change may still land
// lines there). `lines` is null when the default branch (or its copy of the file) cannot be read, which keeps every queued entry
// queued. `fetch` refreshes both refs first (best effort, bounded): without it a publish we have not fetched yet just keeps the
// line queued a little longer. `refreshed` is true only when every requested fetch succeeded: a readable but possibly STALE
// cached ref has lines and refreshed false, which a caller that moves a shared checkpoint must tell apart from a fresh copy.
// A remote with no log branch yet is not a failed fetch.
export function originLogLines(root, { logFile, defaultBranch, fetch = false }) {
  const o = { cwd: root };
  const g = (args, cwd = root, timeoutMs) => git(args, { cwd, ...(timeoutMs ? { timeoutMs } : {}) });
  let refreshed = false;
  let branchRefreshed = true;
  try {
    if (fetch) {
      try {
        git(['fetch', '--no-tags', REMOTE, `+refs/heads/${defaultBranch}:refs/remotes/${REMOTE}/${defaultBranch}`], { ...o, timeoutMs: NETWORK_TIMEOUT_MS });
        refreshed = true;
      } catch { /* offline, or no origin: judge by the ref we already have */ }
      try {
        fetchLogBranch(root, g);
      } catch { branchRefreshed = false; }
    }
    const rel = relative(root, logFile).split('\\').join('/');
    const run = (args) => git(args, o);
    const text = readRegularFile(run, `${REMOTE}/${defaultBranch}`, rel, { strictRef: true }); // origin/<default> missing = unreadable
    const lines = new Set(text === null ? [] : text.split('\n').map((l) => l.replace(/\r$/, '')));
    const branchText = readRegularFile(run, REMOTE_LOG_REF, rel); // no log branch yet is null; a hostile or oversized file makes the whole read fail closed
    if (branchText !== null) for (const l of branchText.split('\n')) lines.add(l.replace(/\r$/, ''));
    return { lines, refreshed: refreshed && branchRefreshed };
  } catch {
    return { lines: null, refreshed: refreshed && branchRefreshed };
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
