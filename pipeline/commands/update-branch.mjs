// `pipeline update-branch --pr N`: bring the PR branch up to date with its base on GitHub BEFORE the final gate, wait for
// the new head's required checks, and report the head the gate must now judge. Never force-pushes; a conflict or a head that
// moved is an outcome for a human or a re-read, not something to retry (see lib/updatebranch.mjs).
import { EXIT, parseCommandArgs, intOption } from '../lib/cli.mjs';
import { guarded, requireConfig, resolveRepo } from '../lib/cmd-common.mjs';
import { createGitHub, guardGh } from '../lib/github.mjs';
import { headSha } from '../lib/git.mjs';
import { MAX_UPDATE_CYCLES, bringUpToDate, updateTiming } from '../lib/updatebranch.mjs';

export const meta = {
  summary: 'bring the PR branch up to date with its base on GitHub (update-branch with expected_head_sha), wait for the new head\'s required checks',
  usage: 'pipeline update-branch --pr N [--expect-head SHA] [--max-cycles N=3] [--repo DIR]   -> {ok, outcome, updated, cycles, base, startHead, head, localHead, pullNeeded, message?}; outcome up-to-date (exit 0; when updated: git pull --ff-only, then re-verify and run the gate on `head`) | rebase-needed | head-moved | cycle-cap | checks-failed | checks-timeout | head-timeout | not-open (exit 1; rebase-needed = the update conflicts, needs-human), 3 GitHub unavailable',
};

export const run = guarded(async (argv, ctx) => {
  const { values } = parseCommandArgs(argv, {
    pr: { type: 'string' }, 'expect-head': { type: 'string' }, 'max-cycles': { type: 'string' }, repo: { type: 'string' },
  }, { allowPositionals: false });
  const pr = intOption(values, 'pr', { required: true, min: 1 });
  const maxCycles = intOption(values, 'max-cycles', { min: 1, max: 10 }) ?? MAX_UPDATE_CYCLES;
  const root = resolveRepo(values, ctx);
  await requireConfig(root);
  const localHead = headSha({ cwd: root });
  // The head the caller has verified: the worktree's own HEAD unless it names another. GitHub is asked to update only that head.
  const expectHead = values['expect-head'] ?? localHead;
  const gh = createGitHub({ cwd: root, env: ctx.env });

  return guardGh(async () => {
    const r = await bringUpToDate({ gh, pr, expectHead, maxCycles, waitChecks: true, ...updateTiming(ctx.env) });
    const head = r.head ?? null;
    return {
      exitCode: r.ok ? EXIT.OK : EXIT.FAILED,
      output: { ...r, head, localHead, pullNeeded: head !== null && head !== localHead },
    };
  });
});
