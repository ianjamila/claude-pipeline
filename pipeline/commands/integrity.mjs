// Test-integrity check for a branch diff: fails when the branch weakens tests (deletes, skips, loosens coverage,
// edits assertions) instead of fixing code. Only the owner's `test-change-approved` label overrides it. Needs the
// config for the project's test globs. Exit 1 = violations and no override.
import { EXIT, parseCommandArgs, requireOption } from '../lib/cli.mjs';
import { guarded, parseLabels, requireConfig, resolveRepo } from '../lib/cmd-common.mjs';
import { diffFiles } from '../lib/git.mjs';
import { checkIntegrity } from '../lib/integrity.mjs';

export const meta = {
  summary: 'check that a branch diff does not weaken tests (exit 1 unless test-change-approved)',
  usage: 'pipeline integrity --base REF --head REF [--labels a,b] [--repo DIR]   -> {ok, overridden, violations, base, head}; exit 1 when not ok',
};

export const run = guarded(async (argv, ctx) => {
  const { values } = parseCommandArgs(argv, {
    repo: { type: 'string' }, base: { type: 'string' }, head: { type: 'string' }, labels: { type: 'string' },
  }, { allowPositionals: false });
  const base = requireOption(values, 'base');
  const head = requireOption(values, 'head');
  const labels = parseLabels(values.labels);
  const root = resolveRepo(values, ctx);
  const { config } = await requireConfig(root);

  const files = diffFiles(base, head, { cwd: root });
  const result = checkIntegrity({ files, config, labels });
  return { exitCode: result.ok ? EXIT.OK : EXIT.FAILED, output: { ...result, base, head } };
});
