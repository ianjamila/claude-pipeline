// `pipeline final-gate --pr N`: the evidence contract an agent merge must satisfy (run inside the PR worktree).
// Every check is evaluated and recorded; exit 0 only when all pass. Writes .review/final-gate.json, which
// `pipeline merge` re-validates against the live PR. The previous gate file is deleted FIRST, so a run that dies
// half way (or cannot reach GitHub) leaves no passing evidence behind.
import { EXIT, parseCommandArgs, intOption } from '../lib/cli.mjs';
import { guarded, requireConfig, resolveRepo } from '../lib/cmd-common.mjs';
import { createGitHub, guardGh } from '../lib/github.mjs';
import { newestStopId, readEvents } from '../lib/run-events.mjs';
import { GATE_FILE, evaluateGate, removeReviewFile, writeReviewJson } from '../lib/finalgate.mjs';

export const meta = {
  summary: 'prove this PR head is verified, reviewed, CI-green and smoked; writes .review/final-gate.json',
  usage: 'pipeline final-gate --pr N [--repo DIR]   -> {ok, repo, pr, base, head, tree, contentHash, checks[{name,ok,detail}], failed[], at, proofs?, stop? (owner_approval: chat only: {id} of the newest owner stop, null when the PR never had one: a merge request for a PR with a stop id carries "Stopped #N · stop <id>" above its Head line)}; exit 0 all checks pass, 1 any fails (pr-open detail starts "behind-base:" when the PR is behind its base: update the branch and re-verify), 3 GitHub unavailable',
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
    // Chat mode: the controller must print `Stopped #N · stop <id>` above the Head line of a merge request for a PR that ever had an owner stop (the owner's "merge" is
    // bound to the newest id); printed here so it does not have to look. Not part of the gate file. Label mode prints no `stop` key.
    let output = gate;
    if (config.owner_approval === 'chat') {
      try {
        const id = newestStopId(readEvents(gh, pr));
        output = { ...gate, stop: id === null ? null : { id } };
      } catch (err) {
        output = { ...gate, stop: null, stopError: `could not read owner stops: ${String(err?.message ?? err).slice(0, 120)}` };
      }
    }
    return { exitCode: gate.ok ? EXIT.OK : EXIT.FAILED, output };
  });
});
