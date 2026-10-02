// `pipeline agent-log queue|stage`: the run log (config.agent_log). `queue` parks a line for later (a merged PR cannot
// commit its own "merged" line); `stage` writes the queued lines plus this PR's line into the log file of the PR
// worktree and commits it, so the log rides along in the PR being merged. Pushing is the caller's job.
import { EXIT, UsageError, intOption, parseCommandArgs, requireOption } from '../lib/cli.mjs';
import { Fail, guarded, requireConfig, resolveRepo } from '../lib/cmd-common.mjs';
import { createGitHub, guardGh } from '../lib/github.mjs';
import { currentBranch, headSha, isClean } from '../lib/git.mjs';
import { loadState } from '../lib/state.mjs';
import { LockTimeoutError } from '../lib/locks.mjs';
import { inlineOptionValues } from '../lib/finalgate.mjs';
import {
  appendToQueue, assertSingleLine, buildAgentLogLine, commitLines, landedLines, queuePath, readQueue, resolveLogPath, withQueueLock, writeQueue,
} from '../lib/agentlog.mjs';
import { loadConfig } from '../lib/config.mjs';

export const meta = {
  summary: 'queue a line for the agent log, or stage queued lines + this PR\'s line as a commit in the worktree',
  usage: [
    'pipeline agent-log queue --line "<line>" [--repo DIR]   -> {ok, queued, file}',
    'pipeline agent-log stage --pr N [--line "<line>"] [--repo DIR]   -> {ok, committed, lines, file, staged, dropped}; run in the PR worktree;',
    '  staged lines stay queued ("staged in PR N") until origin/<default> contains them, and are re-staged if that PR closes unmerged;',
    '  default line = the PR\'s agent-log line with outcome "merged — prod smoke pending"; exit 2 when the worktree has other uncommitted changes,',
    '  is on the default branch or a detached HEAD, or is not the PR\'s head branch at the PR\'s head commit; exit 3 when GitHub cannot say',
  ].join('\n'),
};

export const DEFAULT_OUTCOME = 'merged — prod smoke pending';

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

async function queue(rest, ctx) {
  const { values } = parseCommandArgs(inlineOptionValues(rest, ['--line']), { line: { type: 'string' }, repo: { type: 'string' } }, { allowPositionals: false });
  const line = singleLine(requireOption(values, 'line'));
  const root = resolveRepo(values, ctx);
  const queued = await withQueueLock(root, async () => {
    appendToQueue(root, line);
    await dropLanded(root, false);
    return readQueue(root).length;
  });
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

export const run = guarded(async (argv, ctx) => {
  const [sub, ...rest] = argv;
  if (sub === 'queue') return queue(rest, ctx);
  if (sub === 'stage') return stage(rest, ctx);
  throw new UsageError('usage: pipeline agent-log (queue --line "<line>" | stage --pr N [--line "<line>"])');
});
