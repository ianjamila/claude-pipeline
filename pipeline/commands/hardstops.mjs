// Lists the hard-stops a branch diff trips (dropped data, weakened security rules, secrets, edits to the pipeline's
// own rules...). Any BLOCKING hit blocks auto-merge unless the owner applied `human-approved`; the hits are still listed
// when approved, so the owner's approval is visibly an approval OF something. Report-only (advisory) hits, which a
// project opts into per rule, are listed too but never block. Exit 1 = blocked, 0 = clear, advisory-only or approved.
import { EXIT, parseCommandArgs, requireOption } from '../lib/cli.mjs';
import { guarded, parseLabels, requireConfig, resolveRepo } from '../lib/cmd-common.mjs';
import { blockingHits, collectHardStops } from '../lib/hardstops.mjs';

export const meta = {
  summary: 'list hard-stop hits for a branch diff (exit 1 on blocking hits unless human-approved)',
  usage: 'pipeline hardstops --base REF --head REF [--labels a,b] [--repo DIR]   -> {ok, approved, hits, blocking, advisory}; exit 1 when blocking hits and not approved',
};

export const APPROVAL_LABEL = 'human-approved';

export const run = guarded(async (argv, ctx) => {
  const { values } = parseCommandArgs(argv, {
    repo: { type: 'string' }, base: { type: 'string' }, head: { type: 'string' }, labels: { type: 'string' },
  }, { allowPositionals: false });
  const base = requireOption(values, 'base');
  const head = requireOption(values, 'head');
  const labels = parseLabels(values.labels);
  const root = resolveRepo(values, ctx);
  const { config } = await requireConfig(root);

  const hits = await collectHardStops({ base, head, cwd: root, config });
  const approved = labels.includes(APPROVAL_LABEL);
  const blocking = blockingHits(hits);
  const ok = blocking.length === 0 || approved;
  return { exitCode: ok ? EXIT.OK : EXIT.FAILED, output: { ok, approved, hits, blocking, advisory: hits.filter((h) => h.advisory) } };
});
