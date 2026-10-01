// Lists the PRs parked as `awaiting-review` (built and verified, Codex was unavailable) so a session
// can pick the cross-model reviews back up once Codex is reachable again.
import { EXIT, UsageError, parseCommandArgs } from '../lib/cli.mjs';
import { createGitHub, commandCwd, guardGh } from '../lib/github.mjs';

export const meta = {
  summary: 'list open PRs waiting for a cross-model review',
  usage: 'pipeline resume list [--repo DIR]',
};

export async function run(argv, ctx) {
  const { values, positionals } = parseCommandArgs(argv, { repo: { type: 'string' } });
  if (positionals.length !== 1 || positionals[0] !== 'list') throw new UsageError('usage: pipeline resume list [--repo DIR]');
  const gh = createGitHub({ cwd: commandCwd(values, ctx), env: ctx.env });
  return guardGh(() => {
    const prs = gh.listPrs({ label: 'awaiting-review' }).map(({ number, title, headRefName, url }) => ({ number, title, headRefName, url }));
    return { exitCode: EXIT.OK, output: { ok: true, prs } };
  });
}
