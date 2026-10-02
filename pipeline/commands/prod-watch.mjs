// `pipeline prod-watch`: after a merge, confirm the Production deployment of THAT commit is live and passes the read-only
// production smoke; if not, roll production back (only while the failing deployment still serves it), verify, open an
// issue and a revert PR. All the decisions live in lib/prodwatch.mjs; this file wires the real GitHub, Vercel, git,
// smoke command and lock into it. Exit 0 merged (or no production configured), 1 any other outcome, 3 deployment not
// observed or GitHub unavailable.
import { EXIT, UsageError, intOption, parseCommandArgs } from '../lib/cli.mjs';
import { guarded, requireConfig, resolveRepo } from '../lib/cmd-common.mjs';
import { findDeployment } from '../lib/deploy.mjs';
import { createGitHub, guardGh } from '../lib/github.mjs';
import { withLock } from '../lib/locks.mjs';
import { GhError, gh as ghRun } from '../lib/proc.mjs';
import { createGitOps, createSmoke, exitCodeFor, resolveMergeSha, runProdWatch } from '../lib/prodwatch.mjs';
import { inspectAlias, linkedProjectDir, rollback } from '../lib/vercel.mjs';

export const meta = {
  summary: 'verify the production deployment of a merge; roll back safely, open an issue and a revert PR if it fails',
  usage: 'pipeline prod-watch (--sha MERGE_SHA [--pr N] | --pr N) [--expect-text T] [--retry-wait SEC=60] [--repo DIR]   -> {ok, outcome: merged|deploy-failed|deploy-not-observed|not-live|superseded|recovered|rollback-failed|changed-during-recovery|rollback-skipped|no-production, ...}\n  with only --pr N (merge printed mergeSha:null) the merge commit is read from the merged PR (up to 6 looks); exit 1 {error:not-merged} when the PR is not MERGED, exit 3 {error:merge-sha-unresolved} when GitHub never names it',
};

const LOCK_WAIT_MS = 10 * 60_000;
const CALL_TIMEOUT_MS = 60_000;

// `gh pr create` (body on stdin, so no text is ever shell-quoted). The new PR's number comes from the URL it prints.
function prCreator({ cwd, env }) {
  return ({ title, body, head, base, labels = [] }) => {
    const args = ['pr', 'create', '--head', head, '--base', base, '--title', title, '--body-file', '-', ...labels.flatMap((l) => ['--label', l])];
    const r = ghRun(args, { cwd, env, input: body, timeoutMs: CALL_TIMEOUT_MS });
    if (r.code !== 0 || r.timedOut) throw new GhError({ code: r.code, stderr: r.stderr, args, timedOut: r.timedOut });
    const url = r.stdout.split(/\s+/).find((t) => /^https?:\/\//.test(t)) ?? null;
    const m = /\/pull\/(\d+)/.exec(url ?? '');
    return { number: m ? Number(m[1]) : null, url };
  };
}

export const run = guarded(async (argv, ctx) => {
  const { values, positionals } = parseCommandArgs(argv, {
    sha: { type: 'string' },
    pr: { type: 'string' },
    'expect-text': { type: 'string' },
    'retry-wait': { type: 'string' },
    repo: { type: 'string' },
  });
  if (positionals.length) throw new UsageError(`unexpected argument: ${positionals[0]}`);
  const pr = intOption(values, 'pr', { min: 1 });
  let sha = values.sha?.toLowerCase() ?? null;
  if (sha === null && pr === undefined) throw new UsageError('missing --sha MERGE_SHA (or --pr N, to read the merge commit from the merged PR)');
  // The deployments API matches the stored SHA exactly; an abbreviation would only wait out the whole timeout.
  if (sha !== null && !/^[0-9a-f]{40}$/.test(sha)) throw new UsageError('--sha must be the full 40-character commit SHA');
  const retryWait = intOption(values, 'retry-wait', { min: 0 }) ?? 60;
  const expectText = values['expect-text'] || null;

  const root = resolveRepo(values, ctx);
  const { config } = await requireConfig(root);
  if (!config.production) return { exitCode: EXIT.OK, output: { ok: true, outcome: 'no-production', mergeSha: sha } };

  const env = ctx.env;
  const gh = createGitHub({ cwd: root, env });
  const vercelDir = linkedProjectDir(root);
  const deps = {
    findDeployment: (args) => findDeployment({ gh, ...args }),
    smoke: createSmoke({ production: config.production, cwd: root, env }),
    inspectAlias: (domain) => inspectAlias(domain, { cwd: vercelDir, env }),
    rollback: (target) => rollback(target, { cwd: vercelDir, env }),
    github: {
      issueCreate: (issue) => gh.issueCreate(issue),
      issueComment: (n, body) => gh.api('POST', `repos/${gh.repo().slug}/issues/${Number(n)}/comments`, { body }),
      prCreate: prCreator({ cwd: root, env }),
      prView: (n, fields) => gh.prView(n, fields),
      deployments: (q) => gh.deployments(q),
      deploymentStatuses: (id) => gh.deploymentStatuses(id),
    },
    git: createGitOps({ root }),
    lock: (name, fn) => withLock(name, fn, { waitMs: LOCK_WAIT_MS }),
    note: (msg) => process.stderr.write(`prod-watch: ${msg}\n`),
  };

  return guardGh(async () => {
    if (sha === null) {
      // `merge` printed mergeSha:null: the PR is MERGED but GitHub had not named the merge commit yet. Look again here.
      const found = await resolveMergeSha({ prView: (fields) => gh.prView(pr, fields), pauseMs: Math.min(retryWait * 1000, 5000) });
      if (found.state !== 'merged') {
        const unresolved = found.state === 'unresolved';
        return {
          exitCode: unresolved ? EXIT.UNAVAILABLE : EXIT.FAILED,
          output: {
            ok: false, error: unresolved ? 'merge-sha-unresolved' : 'not-merged', pr,
            reason: unresolved ? `PR #${pr} is MERGED but GitHub did not name its merge commit: find the SHA by hand and pass --sha` : `PR #${pr} is ${found.prState}, not MERGED`,
          },
        };
      }
      sha = found.sha;
    }
    const output = await runProdWatch({ config, sha, pr, expectText, root, retryWaitMs: retryWait * 1000 }, deps);
    return { exitCode: exitCodeFor(output.outcome), output };
  });
});
