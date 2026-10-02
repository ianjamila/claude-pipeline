// `pipeline merge --pr N`: the ONLY sanctioned agent merge path. It trusts nothing it did not just re-read: the gate
// file must vouch for this exact head and patch and be fresh, the live PR must still be clean, and only then does it
// run the project's merge command with the approved head SHA (so a head that moved can never merge). It then waits
// for GitHub to say MERGED; anything else ends with auto-merge disabled, because an unattended queued merge could
// land later on a base nobody verified against.
import { EXIT, parseCommandArgs, intOption } from '../lib/cli.mjs';
import { fill } from '../lib/config.mjs';
import { guarded, requireConfig, resolveRepo } from '../lib/cmd-common.mjs';
import { createGitHub, guardGh } from '../lib/github.mjs';
import { headSha } from '../lib/git.mjs';
import { runPreflight } from '../lib/preflight.mjs';
import { currentProduction } from '../lib/deploy.mjs';
import { runShellAsync } from '../lib/proc.mjs';
import {
  GATE_FILE, PR_FIELDS, blockingLabelsOf, disableAutoMerge, gateRefusals, localContentHash, mergeTiming,
  readReviewJson, tailLines, waitForMerge, writeReviewJson,
} from '../lib/finalgate.mjs';

export const meta = {
  summary: 'merge the PR if (and only if) the fresh final gate still holds; waits for MERGED',
  usage: 'pipeline merge --pr N [--repo DIR]   -> {ok, merged, mergeSha, prodBefore} ; exit 0 merged, 1 not merged / refused (run final-gate again), 3 GitHub unavailable',
};

const refuse = (error, reasons, extra = {}) => ({
  exitCode: EXIT.FAILED,
  output: { ok: false, merged: false, error, reasons, message: error === 'gate' ? 'run final-gate again' : reasons.join('; '), ...extra },
});

export const run = guarded(async (argv, ctx) => {
  const { values } = parseCommandArgs(argv, { pr: { type: 'string' }, repo: { type: 'string' } }, { allowPositionals: false });
  const pr = intOption(values, 'pr', { required: true, min: 1 });
  const root = resolveRepo(values, ctx);
  const { config } = await requireConfig(root);
  const gh = createGitHub({ cwd: root, env: ctx.env });

  return guardGh(async () => {
    // 1. The gate file must vouch for this head, this patch, right now.
    const gate = readReviewJson(root, GATE_FILE);
    const head = headSha({ cwd: root });
    const live = () => gh.prView(pr, [...PR_FIELDS]);
    let hash = '';
    try {
      hash = localContentHash(root, config);
    } catch { /* gateRefusals reports the mismatch */ }
    const refusals = gateRefusals({ gate, pr, head, prHead: live().headRefOid, hash });
    if (refusals.length > 0) return refuse('gate', refusals);
    if (typeof gate.repo === 'string' && gate.repo !== gh.repo().slug) return refuse('gate', [`the gate is for ${gate.repo}, not ${gh.repo().slug}`]);

    // 2. Live re-check, right before the merge: nothing may have appeared since the gate ran.
    const problems = [];
    const preflight = await runPreflight({ cwd: root, env: ctx.env, gh });
    if (!preflight.canMerge) problems.push(`preflight: ${preflight.reasons.join('; ') || 'the pipeline may not merge'}`);
    const now = live();
    if (now.state !== 'OPEN') problems.push(`PR state is ${now.state}`);
    if (now.isDraft !== false) problems.push('PR is a draft');
    if (now.headRefOid !== gate.head) problems.push(`PR head moved to ${String(now.headRefOid).slice(0, 8)} since the gate`);
    const blocking = blockingLabelsOf(now.labels);
    if (blocking.length > 0) problems.push(`blocking label(s): ${blocking.join(', ')}`);
    if (problems.length > 0) return refuse('live-check', problems);

    // 3. The known-good production deployment, recorded BEFORE the merge: it is what a rollback restores.
    let prodBefore = null;
    if (config.production) {
      const found = await currentProduction({ gh, environment: config.production.environment });
      prodBefore = found ?? null;
      writeReviewJson(root, 'prod-before.json', {
        environment: config.production.environment,
        id: found?.id ?? null,
        sha: found?.sha ?? null,
        url: found?.url ?? null,
        at: new Date().toISOString(),
      });
    }

    // 4. Merge with the approved head (fill is strict: a missing {sha} throws instead of merging whatever head exists).
    const { waitMs, pollMs } = mergeTiming(config, ctx.env ?? process.env);
    const command = fill(config.merge.command, { pr: String(pr), sha: gate.head }, { strict: true });
    const ran = await runShellAsync(command, { cwd: root, env: ctx.env, timeoutMs: (config.merge.wait_minutes + 5) * 60_000 });
    const commandOutput = tailLines(`${ran.stdout}${ran.stderr ? `\n${ran.stderr}` : ''}`, 30);

    // 5. Wait for MERGED. If the command failed it may still have merged (a branch-delete error after a merge exits
    // non-zero), so look once before calling it a failure.
    const outcome = await waitForMerge({ gh, pr, waitMs: ran.code === 0 ? waitMs : 0, pollMs });
    if (outcome.state === 'merged') {
      const note = ran.code === 0 ? {} : { commandExitCode: ran.code, note: 'the merge command exited non-zero but the PR is MERGED' };
      return { exitCode: EXIT.OK, output: { ok: true, merged: true, mergeSha: outcome.mergeSha, prodBefore, ...note } };
    }

    const autoMergeDisabled = disableAutoMerge({ pr, cwd: root, env: ctx.env });
    const failure = { merged: false, autoMergeDisabled, commandExitCode: ran.code, commandOutput, prodBefore };
    if (ran.code !== 0) {
      return { exitCode: EXIT.FAILED, output: { ok: false, reason: `merge command failed (exit ${ran.code}${ran.timedOut ? ', timed out' : ''}) and the PR is not merged`, ...failure } };
    }
    const base = {
      timeout: 'not merged in time',
      closed: 'the PR was closed without merging',
      error: `could not read the PR state while waiting (${outcome.error})`,
    }[outcome.state];
    const tail = autoMergeDisabled ? 'auto-merge disabled' : 'could not confirm auto-merge is disabled: check the PR by hand';
    return { exitCode: EXIT.FAILED, output: { ok: false, reason: `${base} — ${tail}`, ...failure } };
  });
});
