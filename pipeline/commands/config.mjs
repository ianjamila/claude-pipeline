// Prints the repo's validated .claude/pipeline.yml with defaults filled in, so skills read config through one
// parser (the same one CI runs) instead of re-parsing YAML themselves. Missing or invalid config is exit 2.
import { EXIT, parseCommandArgs } from '../lib/cli.mjs';
import { guarded, requireConfig, resolveRepo } from '../lib/cmd-common.mjs';

export const meta = {
  summary: 'load and validate .claude/pipeline.yml',
  usage: 'pipeline config [--repo DIR]   -> {ok, path, config}; exit 2 when missing or invalid',
};

export const run = guarded(async (argv, ctx) => {
  const { values } = parseCommandArgs(argv, { repo: { type: 'string' } }, { allowPositionals: false });
  const root = resolveRepo(values, ctx);
  const { path, config, warnings = [] } = await requireConfig(root);
  return { exitCode: EXIT.OK, output: { ok: true, path, config, ...(warnings.length ? { warnings } : {}) } };
});
