// Reports how risky a branch is (level, reasons, hard-stop hits, light-lane eligibility). It is a report, not a
// gate: it exits 0 whenever it could compute an answer, and the skill decides what each level means. The diff is
// taken from the merge-base, so commits that landed on base after the fork are never counted as this branch's.
import { EXIT, parseCommandArgs, requireOption } from '../lib/cli.mjs';
import { guarded, requireConfig, resolveRepo } from '../lib/cmd-common.mjs';
import { diffFiles, mergeBase } from '../lib/git.mjs';
import { collectHardStops } from '../lib/hardstops.mjs';
import { assessRisk, isLightLane } from '../lib/risk.mjs';

export const meta = {
  summary: 'assess the risk level of a branch diff',
  usage: 'pipeline risk --base REF --head REF [--repo DIR]   -> {ok, level, reasons, lightLane, changedLines, fileCount, hardStops, base, head, mergeBase}',
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
  const files = diffFiles(base, head, o);
  const hits = await collectHardStops({ base, head, cwd: root, config });
  const { level, reasons, changedLines, fileCount } = assessRisk({ files, hits, config });
  const lightLane = isLightLane({ level, changedLines, hits, config });
  return {
    exitCode: EXIT.OK,
    output: {
      ok: true, level, reasons, lightLane, changedLines, fileCount, hardStops: hits, base, head, mergeBase: mergeBase(base, head, o),
    },
  };
});
