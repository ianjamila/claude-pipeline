// `pipeline final-gate --pr N`: the evidence contract an agent merge must satisfy (run inside the PR worktree).
// Every check is evaluated and recorded; exit 0 only when all pass. Writes .review/final-gate.json, which
// `pipeline merge` re-validates against the live PR. The previous gate file is deleted FIRST, so a run that dies
// half way (or cannot reach GitHub) leaves no passing evidence behind.
import { EXIT, parseCommandArgs, intOption } from '../lib/cli.mjs';
import { guarded, requireConfig, resolveRepo } from '../lib/cmd-common.mjs';
import { createGitHub, guardGh } from '../lib/github.mjs';
import { GATE_FILE, evaluateGate, removeReviewFile } from '../lib/finalgate.mjs';
import { writeReviewJson } from '../lib/cmd-io.mjs';

export const meta = {
  summary: 'prove this PR head is verified, reviewed, and CI-green; writes .review/final-gate.json',
  usage: 'pipeline final-gate --pr N [--repo DIR]   -> {ok, repo, pr, base, head, tree, contentHash, checks[{name,ok,detail}], failed[], at, proofs?}; exit 0 all checks pass, 1 any fails (pr-open detail starts "behind-base:" when the PR is behind its base: update the branch and re-verify), 3 GitHub unavailable',
};

export const run = guarded(async (argv, ctx) => {
  const { values } = parseCommandArgs(argv, { pr: { type: 'string' }, repo: { type: 'string' } }, { allowPositionals: false });
  const pr = intOption(values, 'pr', { required: true, min: 1 });
  const root = resolveRepo(values, ctx);
  const { config } = await requireConfig(root);
  const gh = createGitHub({ cwd: root, env: ctx.env });

  removeReviewFile(root, GATE_FILE);
  return guardGh(async () => {
    const gate = await evaluateGate({ root, config, pr, gh, env: ctx.env });
    writeReviewJson(root, GATE_FILE, gate);
    return { exitCode: gate.ok ? EXIT.OK : EXIT.FAILED, output: gate };
  });
});
