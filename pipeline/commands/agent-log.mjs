// `pipeline agent-log queue|stage|close`: the run log (config.agent_log). `queue` parks a line for later (a merged PR cannot
// commit its own "merged" line); `stage` writes the queued lines plus this PR's line into the log file of the PR
// worktree and commits it, so the log rides along in the PR being merged; `close` turns the bot-posted production smoke
// results of merged PRs into resolution lines (see lib/agentlog-close.mjs). Pushing is the caller's job.
import { readFileSync } from 'node:fs';
import { EXIT, UsageError, intOption, parseCommandArgs, requireOption } from '../lib/cli.mjs';
import { Fail, guarded, requireConfig, resolveRepo } from '../lib/cmd-common.mjs';
import { createGitHub, guardGh } from '../lib/github.mjs';
import { currentBranch, headSha, isClean } from '../lib/git.mjs';
import { loadState } from '../lib/state.mjs';
import { LockTimeoutError } from '../lib/locks.mjs';
import { inlineOptionValues } from '../lib/finalgate.mjs';
import {
  DEFAULT_OUTCOME, appendToQueue, assertSingleLine, buildAgentLogLine, commitLines, landedLines, queuePath, readQueue, resolveLogPath, withQueueLock,
  writeQueue,
} from '../lib/agentlog.mjs';
import { closeLines, parseLog } from '../lib/agentlog-close.mjs';
import { loadConfig } from '../lib/config.mjs';

export const meta = {
  summary: 'queue a line for the agent log, stage queued lines + this PR\'s line as a commit in the worktree, or close pending prod-smoke lines',
  usage: [
    'pipeline agent-log queue --line "<line>" [--repo DIR]   -> {ok, queued, file}; a line already in the queue (staged in an open PR or not) is not added again',
    'pipeline agent-log stage --pr N [--line "<line>"] [--repo DIR]   -> {ok, committed, lines, file, staged, dropped}; run in the PR worktree;',
    '  staged lines stay queued ("staged in PR N") until origin/<default> contains them, and are re-staged if that PR closes unmerged;',
    '  default line = the PR\'s agent-log line with outcome "merged — prod smoke pending"; exit 2 when the worktree has other uncommitted changes,',
    '  is on the default branch or a detached HEAD, or is not the PR\'s head branch at the PR\'s head commit; exit 3 when GitHub cannot say',
    'pipeline agent-log close [--queue] [--pr N]... [--all] [--repo DIR]   -> {ok, lines, pending, skipped, unreadable, queued?, scanError?}; for every "prod smoke pending" log line reads the',
    '  bot-authored prod-smoke-result comments on that PR (production.watch: workflow) and prints one resolution line per PR whose newest result',
    '  is not logged yet; one repo-wide read of the comments of the last 14 days finds new results on any PR, and a PR is read on its own only when it has no',
    '  resolution line, is the newest pending PR, is named by --pr N (repeatable) or --all is given (a resolved PR the scan did not mention is `skipped`,',
    '  costing no call); a dry run unless --queue (queues each line like `queue`, a line already queued is not added again; never commits); exit 1 when some',
    '  PRs could not be read (`unreadable`; the lines for the others are still produced and queued: still run `stage` and name them in the summary), 3 when GitHub is',
    '  unavailable (skip the close, still stage)',
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

// Drops queued lines that origin/<default> already contains (a staged PR merged). Best effort: no config, no origin or an
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

// Appends lines to the queue under its lock and drops the entries origin/<default> already has; returns the queue length.
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

async function stage(rest, ctx) {
  const { values } = parseCommandArgs(inlineOptionValues(rest, ['--line']), { pr: { type: 'string' }, line: { type: 'string' }, repo: { type: 'string' } }, { allowPositionals: false });
  const pr = intOption(values, 'pr', { required: true, min: 1 });
  const explicit = values.line === undefined ? null : singleLine(values.line);
  const root = resolveRepo(values, ctx);
  const { config } = await requireConfig(root);
  let file;
  try {
    file = resolveLogPath(root, config.agent_log);
  } catch (err) {
    throw new Fail(EXIT.USAGE, { ok: false, error: 'config', message: err.message });
  }
  // Never commit on the default branch or a detached HEAD, and only on the PR's own head: --line must not bypass this,
  // so the PR is always looked up (the title is only fetched when the default line needs it).
  const branch = currentBranch({ cwd: root });
  if (branch === 'HEAD') {
    throw new Fail(EXIT.USAGE, { ok: false, error: 'branch', message: 'HEAD is detached: check out the PR branch before staging the agent log' });
  }
  if ([config.default_branch, 'main', 'master'].includes(branch)) {
    throw new Fail(EXIT.USAGE, { ok: false, error: 'branch', message: `refusing to commit the agent log on the default branch (${branch}): run this in the PR's worktree` });
  }
  const local = headSha({ cwd: root });
  const gh = createGitHub({ cwd: root, env: ctx.env });
  const info = await guardGh(() => gh.prView(pr, ['headRefName', 'headRefOid']));
  if (info?.headRefName !== branch) {
    throw new Fail(EXIT.USAGE, { ok: false, error: 'pr-mismatch', message: `PR #${pr} is for branch ${JSON.stringify(info?.headRefName)}, this worktree is on ${JSON.stringify(branch)}` });
  }
  if (info.headRefOid !== local) {
    throw new Fail(EXIT.USAGE, { ok: false, error: 'pr-mismatch', message: `PR #${pr} head is ${String(info.headRefOid).slice(0, 8)}, this worktree is at ${local.slice(0, 8)}: push or pull first` });
  }
  // Staging commits ONLY the log: anything else uncommitted would be swept into that commit or left in a confusing state.
  if (!isClean({ cwd: root })) {
    throw new Fail(EXIT.USAGE, { ok: false, error: 'dirty', message: 'the worktree has uncommitted changes besides the agent log; commit or stash them first' });
  }

  let line = explicit;
  if (line === null) {
    const title = await guardGh(() => gh.prView(pr, ['title']).title);
    let state = null;
    try {
      state = loadState(root);
    } catch { /* an unreadable state only costs the risk/rounds columns */ }
    line = singleLine(buildAgentLogLine({ state, pr, title, outcome: DEFAULT_OUTCOME }));
  }

  try {
    return await withQueueLock(root, () => {
      // 1. Lines origin/<default> already has are done (a staged PR merged); everything else stays queued.
      const landed = landedLines(root, { logFile: file, defaultBranch: config.default_branch, fetch: true });
      let entries = readQueue(root);
      let dropped = 0;
      if (landed) {
        const keep = entries.filter((e) => !landed.has(e.line));
        dropped = entries.length - keep.length;
        entries = keep;
      }
      // 2. A line staged in ANOTHER pull request is that PR's to carry: re-staging it here would collide when both merge.
      //    Only when that PR was closed without merging is the line set loose again and re-staged.
      const prState = new Map();
      const stateOf = (n) => {
        if (!prState.has(n)) {
          let state = null;
          try { state = String(gh.prView(n, ['state']).state ?? '').toUpperCase() || null; } catch { /* unknown: keep it staged */ }
          prState.set(n, state);
        }
        return prState.get(n);
      };
      const carry = [];
      for (const e of entries) {
        if (e.staged && e.staged.pr !== pr && stateOf(e.staged.pr) === 'CLOSED') delete e.staged;
        if (!e.staged || e.staged.pr === pr) carry.push(e);
      }
      // 3. Write + commit them with this PR's line, then mark them staged here instead of removing them.
      const { sha, fresh } = commitLines({ root, file, lines: [...carry.map((e) => e.line), line], pr });
      const at = new Date().toISOString();
      for (const e of carry) e.staged = { pr, at };
      writeQueue(root, entries);
      return { exitCode: EXIT.OK, output: { ok: true, committed: sha, lines: fresh, file: config.agent_log, staged: carry.length, dropped } };
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
  const { lines, pending, skipped, unreadable, scanError } = await closeLines({ logText, gh: github, prs, all: values.all === true });
  const incomplete = unreadable.length > 0 || scanError !== null;
  const output = { ok: !incomplete, lines, pending: pending.map(Number), skipped: skipped.map(Number), unreadable: unreadable.map((u) => ({ pr: Number(u.pr), message: u.message })) };
  if (scanError !== null) output.scanError = scanError;
  // Exit 1 only means some PRs could not be read: the lines for the others are still queued.
  if (values.queue) {
    const have = new Set(readQueue(root).map((e) => e.line));
    output.queued = lines.filter((l) => !have.has(l)).length; // a line already queued is not added again
    if (lines.length) await queueLines(root, lines);
  }
  return { exitCode: incomplete ? EXIT.FAILED : EXIT.OK, output };
}

export const run = guarded(async (argv, ctx) => {
  const [sub, ...rest] = argv;
  if (sub === 'queue') return queue(rest, ctx);
  if (sub === 'stage') return stage(rest, ctx);
  if (sub === 'close') return close(rest, ctx);
  throw new UsageError('usage: pipeline agent-log (queue --line "<line>" | stage --pr N [--line "<line>"] | close [--queue] [--pr N]... [--all])');
});
