// `pipeline agent-log queue|publish|stage|close`: the run log (config.agent_log). `queue` parks a line for later (a merged PR cannot
// commit its own "merged" line); `publish` appends the queued lines (plus an optional --line) to the log file on the orphan
// branch `pipeline-agent-log` and pushes that one ref, never touching the caller's checkout or any PR branch; `stage` is the
// deprecated old name (it no longer commits anything); `close` turns the bot-posted production smoke results of merged PRs into
// resolution lines (see lib/agentlog-close.mjs).
import { readFileSync } from 'node:fs';
import { EXIT, UsageError, intOption, parseCommandArgs, requireOption } from '../lib/cli.mjs';
import { Fail, guarded, requireConfig, resolveRepo } from '../lib/cmd-common.mjs';
import { createGitHub } from '../lib/github.mjs';
import { GitError } from '../lib/git.mjs';
import { LockTimeoutError } from '../lib/locks.mjs';
import { inlineOptionValues } from '../lib/finalgate.mjs';
import {
  AGENT_LOG_BRANCH, DEFAULT_OUTCOME, LogTooLargeError, appendToQueue, assertSingleLine, clearWritten, landedLines, logRelPath, originLogLines, publishLines, queuePath, readQueue,
  resolveLogPath, withQueueLock, writeQueue,
} from '../lib/agentlog.mjs';
import { closeLines, parseLog, readScanState, unionLogText, writeScanState } from '../lib/agentlog-close.mjs';
import { loadConfig } from '../lib/config.mjs';

export const meta = {
  summary: 'queue a line for the agent log, publish queued lines to the pipeline-agent-log branch, or close pending prod-smoke lines',
  usage: [
    'pipeline agent-log queue --line "<line>" [--repo DIR]   -> {ok, queued, file}; a line already in the queue is not added again',
    'pipeline agent-log publish [--line "<line>"] [--repo DIR]   -> {ok, branch, commit, pushed, lines, remaining}; queues --line, drops lines the log branch or origin/<default> already has,',
    '  appends the rest to config.agent_log on the orphan branch pipeline-agent-log and pushes ONLY that ref (never forced; a lost race is retried on the new tip);',
    '  the caller\'s HEAD, index, branches and working tree are never touched, nothing is committed to a PR branch. Published entries leave the queue only after',
    '  the push succeeded; exit 3 when the push or the network fails (the lines stay queued for the next run, a note in the summary is enough);',
    '  the log branch is untrusted data: a commit holds ONLY the log file, the file is read only as a regular file under 5 MB (a bigger one: exit 1, error log-too-large, lines stay queued), existing lines are only appended after',
    'pipeline agent-log stage [--pr N] [--line "<line>"] [--repo DIR]   -> DEPRECATED alias of publish (older skills call it): never commits into the worktree or PR branch;',
    '  prints {ok, deprecated: true, committed: null, ...publish\'s fields}',
    'pipeline agent-log close [--queue] [--pr N]... [--all] [--repo DIR]   -> {ok, lines, pending, skipped, unreadable, originReadable, originRefreshed, queued?, scanError?}; for every "prod smoke pending" log line reads the',
    '  bot-authored prod-smoke-result comments on that PR (production.watch: workflow) and prints one resolution line per PR whose newest result',
    '  is not logged yet (never an earlier minute than the newest logged one; the same minute only when the line differs); the log read is the worktree log plus the origin/<default> copy plus the log branch copy; one repo-wide read of the comments since the last successful read on this machine (at least 14 days)',
    '  finds new results on any PR (a hit only triggers reading the whole comment history of that PR), and a PR is read on its own only when it has no',
    '  resolution line, is the newest pending PR, is named by --pr N (repeatable) or --all is given (a resolved PR the scan did not mention is `skipped`,',
    '  costing no call); a dry run unless --queue (queues each line like `queue`, a line already queued is not added again; never commits; only --queue advances the scan window, and only when the origin/<default> copy of the log was readable AND the fetches of origin/<default> and the log branch succeeded, else originReadable / originRefreshed is false and a note goes to stderr); exit 1 when some',
    '  PRs could not be read (`unreadable`; the lines for the others are still produced and queued: still run `publish` and name them in the summary), 3 when GitHub is',
    '  unavailable (skip the close, still publish)',
  ].join('\n'),
};

export { DEFAULT_OUTCOME };

function singleLine(raw) {
  try {
    return assertSingleLine(raw);
  } catch (err) {
    throw new UsageError(err.message);
  }
}

// Drops queued lines that are already published (on the log branch, or in origin/<default>'s copy). Best effort: no config, no origin or an
// unreadable file keeps everything queued. Caller holds the queue lock. Returns how many entries were dropped.
async function dropLanded(root, fetch) {
  try {
    const loaded = await loadConfig(root);
    if (!loaded.ok) return 0;
    const landed = landedLines(root, { logFile: resolveLogPath(root, loaded.config.agent_log), defaultBranch: loaded.config.default_branch, fetch });
    if (!landed) return 0;
    const entries = readQueue(root);
    const keep = entries.filter((e) => !landed.has(e.line));
    if (keep.length !== entries.length) writeQueue(root, keep);
    return entries.length - keep.length;
  } catch {
    return 0;
  }
}

// Appends lines to the queue under its lock and drops the entries already published; returns the queue length.
const queueLines = (root, lines) => withQueueLock(root, async () => {
  for (const line of lines) appendToQueue(root, line);
  await dropLanded(root, false);
  return readQueue(root).length;
});

async function queue(rest, ctx) {
  const { values } = parseCommandArgs(inlineOptionValues(rest, ['--line']), { line: { type: 'string' }, repo: { type: 'string' } }, { allowPositionals: false });
  const line = singleLine(requireOption(values, 'line'));
  const root = resolveRepo(values, ctx);
  const queued = await queueLines(root, [line]);
  return { exitCode: EXIT.OK, output: { ok: true, queued, file: queuePath(root) } };
}

// Queue + publish under the queue lock. `explicit` (or null) is queued first, so a failed push leaves it queued for the next run.
async function publish(rest, ctx, { deprecated = false } = {}) {
  const { values } = parseCommandArgs(inlineOptionValues(rest, ['--line']), { line: { type: 'string' }, repo: { type: 'string' }, ...(deprecated ? { pr: { type: 'string' } } : {}) }, { allowPositionals: false });
  if (deprecated) intOption(values, 'pr', { min: 1 }); // validated, never used: the log no longer depends on a PR
  const explicit = values.line === undefined ? null : singleLine(values.line);
  const root = resolveRepo(values, ctx);
  const { config } = await requireConfig(root);
  let file;
  let logRel;
  try {
    file = resolveLogPath(root, config.agent_log);
    logRel = logRelPath(root, config.agent_log);
  } catch (err) {
    throw new Fail(EXIT.USAGE, { ok: false, error: 'config', message: err.message });
  }
  try {
    return await withQueueLock(root, () => {
      if (explicit !== null) appendToQueue(root, explicit);
      // 1. Lines already published (log branch, or a legacy copy on origin/<default>) are done.
      const landed = landedLines(root, { logFile: file, defaultBranch: config.default_branch, fetch: true });
      let entries = readQueue(root);
      let dropped = 0;
      if (landed) {
        const keep = entries.filter((e) => !landed.has(e.line));
        dropped = entries.length - keep.length;
        if (dropped > 0) writeQueue(root, keep);
        entries = keep;
      }
      const base = { ok: true, branch: AGENT_LOG_BRANCH, ...(deprecated ? { deprecated: true, committed: null } : {}), file: config.agent_log, dropped };
      if (entries.length === 0) return { exitCode: EXIT.OK, output: { ...base, commit: null, pushed: false, lines: [], remaining: 0 } };
      // 2. Publish the rest. Only after the push succeeded do those entries leave the queue.
      let result;
      try {
        result = publishLines({ root, logRel, lines: entries.map((e) => e.line), defaultBranch: config.default_branch });
      } catch (err) {
        if (err instanceof LogTooLargeError) throw new Fail(EXIT.FAILED, { ok: false, error: 'log-too-large', message: `${err.message}; the lines stay queued`, remaining: entries.length });
        if (!(err instanceof GitError)) throw err;
        throw new Fail(EXIT.UNAVAILABLE, { ok: false, error: 'publish-failed', message: `could not publish the agent log (${err.message.slice(0, 300)}); the lines stay queued for the next run`, remaining: entries.length });
      }
      clearWritten(root, entries);
      return { exitCode: EXIT.OK, output: { ...base, commit: result.commit, pushed: result.pushed, lines: result.lines, remaining: readQueue(root).length } };
    });
  } catch (err) {
    if (err instanceof LockTimeoutError) throw new Fail(EXIT.UNAVAILABLE, { ok: false, error: 'locked', message: err.message });
    throw err;
  }
}

async function close(rest, ctx) {
  const { values } = parseCommandArgs(rest, { queue: { type: 'boolean' }, all: { type: 'boolean' }, pr: { type: 'string', multiple: true }, repo: { type: 'string' } }, { allowPositionals: false });
  const prs = (values.pr ?? []).map((raw) => {
    if (!/^[1-9]\d{0,8}$/.test(raw)) throw new UsageError('--pr must be a positive PR number');
    return raw;
  });
  const root = resolveRepo(values, ctx);
  const { config } = await requireConfig(root);
  let file;
  try {
    file = resolveLogPath(root, config.agent_log);
  } catch (err) {
    throw new Fail(EXIT.USAGE, { ok: false, error: 'config', message: err.message });
  }
  let logText = '';
  try {
    logText = readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  // The closer reasons over the UNION of this worktree's log, origin/<default>'s copy and the log branch's copy (fetched best effort): the
  // lines of a run live on the log branch, and a worktree on an older branch lacks the lines other PRs merged since. When origin's copy cannot be read the run still closes what it can,
  // but must not advance the shared scan checkpoint past PRs its own log may lack.
  const origin = originLogLines(root, { logFile: file, defaultBranch: config.default_branch, fetch: true });
  const originOk = origin.lines !== null;
  const originRefreshed = origin.refreshed;
  if (originOk) logText = unionLogText(logText, [...origin.lines].join('\n'));
  if (!originOk) process.stderr.write(`origin/${config.default_branch} agent log unreadable — closing from the worktree log; scan checkpoint not advanced\n`);
  else if (!originRefreshed) process.stderr.write(`could not refresh origin/${config.default_branch} (git fetch failed) — closing from the cached copy; scan checkpoint not advanced\n`);
  const gh = createGitHub({ cwd: root, env: ctx.env });
  const github = {
    mergeSha: (n) => gh.prView(n, ['mergeCommit']).mergeCommit?.oid ?? null,
    listComments: (n) => gh.listComments(n),
    listRepoComments: (since) => gh.listRepoComments(since),
  };
  // Cheap up-front probe so "GitHub is unavailable" (3) is told apart from "this PR could not be read" (1).
  if (parseLog(logText).pending.length > 0 && !gh.authStatus().ok) {
    throw new Fail(EXIT.UNAVAILABLE, { ok: false, error: 'unavailable', message: 'GitHub is unavailable (gh is not authenticated or unreachable)' });
  }
  // The scan window covers the whole gap since the last successful scan on this machine. The state moves only once this scan's
  // results are safely queued (--queue: every append succeeded), the scan was complete and every PR it surfaced was readable and
  // origin's copy of the log was readable; a dry run, a failed scan or a failed append leaves it alone so the next run re-covers the gap. A failing PR outside the scan
  // results (an unresolved one) is re-read every run anyway and does not hold the window back.
  const now = Date.now();
  const { lines, pending, skipped, unreadable, scanError, scanned, scanUnreadable } = await closeLines({
    logText, gh: github, now, prs, all: values.all === true, lastScanAt: readScanState(root, now),
  });
  const incomplete = unreadable.length > 0 || scanError !== null;
  const output = { ok: !incomplete, lines, pending: pending.map(Number), skipped: skipped.map(Number), unreadable: unreadable.map((u) => ({ pr: Number(u.pr), message: u.message })), originReadable: originOk, originRefreshed };
  if (scanError !== null) output.scanError = scanError;
  // Exit 1 only means some PRs could not be read: the lines for the others are still queued.
  if (values.queue) {
    const have = new Set(readQueue(root).map((e) => e.line));
    output.queued = lines.filter((l) => !have.has(l)).length; // a line already queued is not added again
    if (lines.length) await queueLines(root, lines);
    if (scanned && scanUnreadable.length === 0 && originOk && originRefreshed) writeScanState(root, now);
  }
  return { exitCode: incomplete ? EXIT.FAILED : EXIT.OK, output };
}

export const run = guarded(async (argv, ctx) => {
  const [sub, ...rest] = argv;
  if (sub === 'queue') return queue(rest, ctx);
  if (sub === 'publish') return publish(rest, ctx);
  if (sub === 'stage') return publish(rest, ctx, { deprecated: true });
  if (sub === 'close') return close(rest, ctx);
  throw new UsageError('usage: pipeline agent-log (queue --line "<line>" | publish [--line "<line>"] | close [--queue] [--pr N]... [--all])');
});
