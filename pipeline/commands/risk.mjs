// Reports how risky a branch is (level, reasons, hard-stop hits, light-lane eligibility). It is a report, not a
// gate: it exits 0 whenever it could compute an answer, and the skill decides what each level means. The diff is
// taken from the merge-base, so commits that landed on base after the fork are never counted as this branch's.
import { EXIT, parseCommandArgs, requireOption } from '../lib/cli.mjs';
import { guarded, requireConfig, resolveRepo } from '../lib/cmd-common.mjs';
import { mergeBase } from '../lib/git.mjs';
import { rateBranch } from '../lib/risk.mjs';

export const meta = {
  summary: 'assess the risk level of a branch diff',
  usage: [
    'pipeline risk --base REF --head REF [--repo DIR]   -> {ok, level, reasons, lightLane, changedLines, fileCount, hardStops, sizeOnly, drivers, reviewer, laneReasons, sensitivePaths, note?, base, head, mergeBase}',
    '  the rating uses the working-tree config AND the one committed at the default branch\'s fork point (stricter wins; an unreadable one means reviewer fable)',
    '  sizeOnly: medium for size alone (no hit, no high-risk path); drivers {hardStop, advisory, path, size}; reviewer: who follows Codex (judge|fable); note says why a medium PR has the judge',
  ].join('\n'),
};

export const run = guarded(async (argv, ctx) => {
  const { values } = parseCommandArgs(argv, {
    repo: { type: 'string' }, base: { type: 'string' }, head: { type: 'string' },
  }, { allowPositionals: false });
  const base = requireOption(values, 'base');
  const head = requireOption(values, 'head');
  const root = resolveRepo(values, ctx);
  const { config } = await requireConfig(root);

  const o = { cwd: root };
  const rated = await rateBranch({ root, head, config, base });
  const { level, reasons, changedLines, fileCount, lightLane, hits, drivers, sizeOnly, reviewer, laneReasons, sensitivePaths } = rated;
  return {
    exitCode: EXIT.OK,
    output: {
      ok: true, level, reasons, lightLane, changedLines, fileCount, hardStops: hits, sizeOnly, drivers, reviewer, laneReasons, sensitivePaths,
      ...(rated.note ? { note: rated.note } : {}), ...(rated.baseConfig.ok ? {} : { baseConfigError: rated.baseConfig.reason }),
      base, head, mergeBase: mergeBase(base, head, o),
    },
  };
});
