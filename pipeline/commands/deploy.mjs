// `pipeline deploy url`: waits for GitHub to report the deployment of one commit and prints its URL.
// Exit 0 deployed, 1 the deployment failed, 3 nothing finished in time (never read as success).
import { EXIT, UsageError, parseCommandArgs, intOption, requireOption } from '../lib/cli.mjs';
import { createGitHub, commandCwd, guardGh } from '../lib/github.mjs';
import { findDeployment } from '../lib/deploy.mjs';

export const meta = {
  summary: 'wait for a commit\'s deployment and print its URL',
  usage: 'pipeline deploy url --sha SHA --environment ENV [--timeout SEC=900] [--poll SEC=15] [--repo DIR]',
};

export async function run(argv, ctx) {
  const { values, positionals } = parseCommandArgs(argv, {
    sha: { type: 'string' },
    environment: { type: 'string' },
    timeout: { type: 'string' },
    poll: { type: 'string' },
    repo: { type: 'string' },
  });
  if (positionals.length !== 1 || positionals[0] !== 'url') throw new UsageError(`usage: ${meta.usage}`);
  const sha = requireOption(values, 'sha');
  const environment = requireOption(values, 'environment');
  // The API matches the stored SHA exactly; an abbreviation would just wait out the whole timeout.
  if (!/^[0-9a-f]{40}$/i.test(sha)) throw new UsageError('--sha must be the full 40-character commit SHA');
  const timeout = intOption(values, 'timeout', { min: 0 }) ?? 900;
  const poll = intOption(values, 'poll', { min: 1 }) ?? 15;
  const gh = createGitHub({ cwd: commandCwd(values, ctx), env: ctx.env });

  return guardGh(async () => {
    const r = await findDeployment({ gh, sha, environment, timeoutMs: timeout * 1000, pollMs: poll * 1000 });
    if (r.state === 'success') return { exitCode: EXIT.OK, output: { ok: true, url: r.url, id: r.id, sha: r.sha, environment } };
    if (r.state === 'failure') return { exitCode: EXIT.FAILED, output: { ok: false, state: 'failure', id: r.id, url: r.url, environment } };
    return { exitCode: EXIT.UNAVAILABLE, output: { ok: false, state: 'timeout', message: `no successful ${environment} deployment for ${sha} within ${timeout}s`, environment } };
  });
}
