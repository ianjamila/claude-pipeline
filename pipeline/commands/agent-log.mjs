// `pipeline agent-log queue|stage`: the run log (config.agent_log). `queue` parks a line for later (a merged PR cannot
// commit its own "merged" line); `stage` writes the queued lines plus this PR's line into the log file of the PR
// worktree and commits it, so the log rides along in the PR being merged. Pushing is the caller's job.
import { EXIT, UsageError, intOption, parseCommandArgs, requireOption } from '../lib/cli.mjs';
import { Fail, guarded, requireConfig, resolveRepo } from '../lib/cmd-common.mjs';
import { createGitHub, guardGh } from '../lib/github.mjs';
import { isClean } from '../lib/git.mjs';
import { loadState } from '../lib/state.mjs';
import { LockTimeoutError } from '../lib/locks.mjs';
import { inlineOptionValues } from '../lib/finalgate.mjs';
import {
  appendToQueue, assertSingleLine, buildAgentLogLine, clearWritten, commitLines, queuePath, readQueue, resolveLogPath, withQueueLock,
} from '../lib/agentlog.mjs';

export const meta = {
  summary: 'queue a line for the agent log, or stage queued lines + this PR\'s line as a commit in the worktree',
  usage: [
    'pipeline agent-log queue --line "<line>" [--repo DIR]   -> {ok, queued, file}',
    'pipeline agent-log stage --pr N [--line "<line>"] [--repo DIR]   -> {ok, committed, lines, file}; run in the PR worktree;',
    '  default line = the PR\'s agent-log line with outcome "merged — prod smoke pending"; exit 2 when the worktree has other uncommitted changes',
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

async function queue(rest, ctx) {
  const { values } = parseCommandArgs(inlineOptionValues(rest, ['--line']), { line: { type: 'string' }, repo: { type: 'string' } }, { allowPositionals: false });
  const line = singleLine(requireOption(values, 'line'));
  const root = resolveRepo(values, ctx);
  const queued = await withQueueLock(root, () => {
    appendToQueue(root, line);
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
  // Staging commits ONLY the log: anything else uncommitted would be swept into that commit or left in a confusing state.
  if (!isClean({ cwd: root })) {
    throw new Fail(EXIT.USAGE, { ok: false, error: 'dirty', message: 'the worktree has uncommitted changes besides the agent log; commit or stash them first' });
  }

  let line = explicit;
  if (line === null) {
    const title = await guardGh(() => createGitHub({ cwd: root, env: ctx.env }).prView(pr, ['title']).title);
    let state = null;
    try {
      state = loadState(root);
    } catch { /* an unreadable state only costs the risk/rounds columns */ }
    line = singleLine(buildAgentLogLine({ state, pr, title, outcome: DEFAULT_OUTCOME }));
  }

  try {
    return await withQueueLock(root, () => {
      const queued = readQueue(root);
      const lines = [...queued.map((e) => e.line), line];
      const { sha, fresh } = commitLines({ root, file, lines, pr });
      clearWritten(root, queued);
      return { exitCode: EXIT.OK, output: { ok: true, committed: sha, lines: fresh, file: config.agent_log } };
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
