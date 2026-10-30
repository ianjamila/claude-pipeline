// `pipeline smoke --target preview|production --url URL [--expect-text T] [--sha SHA]`: runs the project's configured
// smoke command against a deployment and records the result in .review/<target>-smoke.json. Nothing in the pipeline reads
// that record back (the final gate and merge do not); it is for whoever ran the smoke. --sha is what the deployment was
// built from, not a guess.
import { EXIT, UsageError, parseCommandArgs, requireOption } from '../lib/cli.mjs';
import { fill } from '../lib/config.mjs';
import { Fail, guarded, requireConfig, resolveRepo } from '../lib/cmd-common.mjs';
import { envWithGhDir, runShellAsync } from '../lib/proc.mjs';
import { inlineOptionValues, tailLines, writeReviewJson } from '../lib/cmd-io.mjs';

export const meta = {
  summary: 'run the configured preview/production smoke command and record the result',
  usage: 'pipeline smoke --target preview|production --url URL [--expect-text T] [--sha SHA] [--repo DIR]   -> {ok, target, url, sha, exitCode, tail, at}; exit 0 passed, 1 failed, 2 not configured/usage',
};

export const SMOKE_TIMEOUT_MS = 5 * 60_000;
const TARGETS = ['preview', 'production'];
// The URL is substituted into a shell command line, so only characters that are inert in a shell are accepted.
const SAFE_URL = /^https?:\/\/[A-Za-z0-9._~:/?#@%+=,-]+$/;

export const run = guarded(async (argv, ctx) => {
  const { values } = parseCommandArgs(inlineOptionValues(argv, ['--expect-text']), {
    target: { type: 'string' }, url: { type: 'string' }, 'expect-text': { type: 'string' }, sha: { type: 'string' }, repo: { type: 'string' },
  }, { allowPositionals: false });
  const target = requireOption(values, 'target');
  if (!TARGETS.includes(target)) throw new UsageError(`--target must be one of ${TARGETS.join('|')}`);
  const url = requireOption(values, 'url');
  if (!SAFE_URL.test(url)) throw new UsageError('--url must be an http(s) URL without shell metacharacters (quotes, spaces, & ; | $ ` < > ( ) \\)');
  const root = resolveRepo(values, ctx);
  const { config } = await requireConfig(root);

  const section = config[target];
  if (!section || typeof section.smoke !== 'string' || section.smoke.trim() === '') {
    throw new Fail(EXIT.USAGE, { ok: false, error: 'not-configured', message: `config.${target}.smoke is not configured` });
  }
  const command = fill(section.smoke, { url }, { strict: true });

  const r = await runShellAsync(command, {
    cwd: root,
    env: envWithGhDir({ ...(ctx.env ?? {}), PIPELINE_SMOKE_EXPECT_TEXT: values['expect-text'] }),
    timeoutMs: SMOKE_TIMEOUT_MS,
  });
  const result = {
    ok: r.code === 0 && !r.timedOut,
    target,
    url,
    sha: values.sha ?? null,
    exitCode: r.code,
    tail: tailLines(`${r.stdout}${r.stderr ? `\n${r.stderr}` : ''}`, 30),
    at: new Date().toISOString(),
  };
  if (r.timedOut) result.timedOut = true;
  writeReviewJson(root, `${target}-smoke.json`, result);
  return { exitCode: result.ok ? EXIT.OK : EXIT.FAILED, output: result };
});
