// `pipeline preflight`: may the pipeline merge here, right now? Prints the whole report; the exit code
// is the short answer (0 yes, 1 no, 2 the config itself is missing or invalid).
import { EXIT, parseCommandArgs } from '../lib/cli.mjs';
import { commandCwd } from '../lib/github.mjs';
import { runPreflight } from '../lib/preflight.mjs';

export const meta = {
  summary: 'report whether the pipeline may merge (config, gh, protection, pause, Codex)',
  usage: 'pipeline preflight [--repo DIR]   (exit 0 can merge, 1 cannot, 2 config missing/invalid)',
};

export async function run(argv, ctx) {
  const { values } = parseCommandArgs(argv, { repo: { type: 'string' } }, { allowPositionals: false });
  const report = await runPreflight({ cwd: commandCwd(values, ctx), env: ctx.env });
  const exitCode = !report.config.ok ? EXIT.USAGE : report.canMerge ? EXIT.OK : EXIT.FAILED;
  return { exitCode, output: report };
}
