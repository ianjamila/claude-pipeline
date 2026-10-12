// `pipeline merge --pr N`: the ONLY sanctioned agent merge path. It trusts nothing it did not just re-read: the gate
// file only names the head and patch that were approved (and must still match, and be fresh); everything else is
// re-proved LIVE, by running the whole final gate again immediately before the merge command, because a gate file is
// just JSON on disk and anyone can write one. Only then does it run the project's merge command with the approved head
// SHA (so a head that moved can never merge). It then waits for GitHub to say MERGED, re-checking the blockers on every
// poll; anything else ends with auto-merge disabled, because an unattended queued merge could land later on a base nobody
// verified against.
import { EXIT, parseCommandArgs, intOption } from '../lib/cli.mjs';
import { fill } from '../lib/config.mjs';
import { guarded, requireConfig, resolveRepo } from '../lib/cmd-common.mjs';
import { createGitHub, guardGh } from '../lib/github.mjs';
import { headSha } from '../lib/git.mjs';
import { currentProduction } from '../lib/deploy.mjs';
import { runShellAsync } from '../lib/proc.mjs';
import { postEvent } from '../lib/run-events.mjs';
import { createRunRecorder, inFlightSince } from '../lib/run-progress.mjs';
import { bringUpToDate, updateTiming } from '../lib/updatebranch.mjs';
import {
  GATE_FILE, PR_FIELDS, abandonMerge, evaluateGate, gateRefusals, localContentHash, mergeTiming, preMergeProblems, readReviewJson,
  tailLines, waitBlockers, waitForMerge, writeReviewJson,
} from '../lib/finalgate.mjs';

export const meta = {
  summary: 'merge the PR if (and only if) the final gate passes again, live; waits for MERGED',
  usage: 'pipeline merge --pr N [--repo DIR]   -> {ok, merged, mergeSha, prodBefore, warning?, warnings?} ; exit 0 merged (mergeSha:null + warning when GitHub cannot name the merge commit), 1 not merged / refused (error: gate|behind-base|live-check|pre-merge; behind-base = the base moved: the branch was updated (or the update failed, see outcome), re-verify and run final-gate again), 3 GitHub unavailable or no known-good production deployment. While it runs the run record of the PR shows inFlight {kind: merge} and step merge; a prod-before event comment (the known-good deployment) is posted before the merge command, and when that post fails nothing is merged (error pre-merge); warnings lists a run record write that failed (never fatal)',
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
    // 1. The gate file must name this head and this patch, in this repo, and be fresh. It is only a binding: it proves nothing by itself.
    const gate = readReviewJson(root, GATE_FILE);
    const head = headSha({ cwd: root });
    let hash = '';
    try {
      hash = localContentHash(root, config);
    } catch { /* gateRefusals reports the mismatch */ }
    const refusals = gateRefusals({
      gate, pr, head, prHead: gh.prView(pr, [...PR_FIELDS]).headRefOid, hash, repo: gh.repo().slug, previewConfigured: config.preview !== null,
    });
    if (refusals.length > 0) return refuse('gate', refusals);

    // 1b. Main may have moved since the gate ran: the gate, and the CI it waited on, then judged a tree that is NOT the one that
    // would land. Bring the branch up to date on GitHub (one update; expected_head_sha = the approved head), then refuse: the new
    // head needs its own verify + gate, so nothing merges on this attempt. Up to date already => carry on.
    const synced = await bringUpToDate({ gh, pr, expectHead: gate.head, maxCycles: 1, waitChecks: false, ...updateTiming(ctx.env) });
    if (!synced.ok) {
      return refuse('behind-base', [synced.message ?? `could not bring the branch up to date (${synced.outcome})`], { outcome: synced.outcome, updated: synced.updated, head: synced.head ?? null });
    }
    if (synced.updated) {
      return refuse('behind-base', [`the base moved: the branch was updated to ${synced.head}; pull it, re-verify and run final-gate on that head`], { outcome: 'updated', updated: true, head: synced.head });
    }

    // 2. The known-good production deployment: it is what a rollback restores, so without it nothing may merge.
    // Read now, written only once the live gate has passed (a refused attempt must not overwrite an earlier merge's record).
    let prodBefore = null;
    if (config.production) {
      const found = await currentProduction({ gh, environment: config.production.environment });
      if (!found) {
        return {
          exitCode: EXIT.UNAVAILABLE,
          output: {
            ok: false, merged: false, error: 'production-unknown',
            reason: `known-good production deployment not found in ${config.production.environment}: a rollback would have no target, so nothing is merged`,
          },
        };
      }
      prodBefore = found;
    }

    // 3. The live gate, immediately before the merge: every check re-evaluated against GitHub and the worktree as they are NOW.
    const fresh = await evaluateGate({ root, config, pr, gh, env: ctx.env });
    const failed = fresh.checks.filter((c) => !c.ok);
    if (failed.length > 0) return refuse('live-check', failed.map((c) => `${c.name}: ${c.detail}`));
    if (fresh.head !== gate.head || fresh.contentHash !== gate.contentHash) {
      return refuse('live-check', ['the live gate is for a different head or patch than final-gate.json approved']);
    }

    if (prodBefore) {
      writeReviewJson(root, 'prod-before.json', {
        environment: config.production.environment, id: prodBefore.id, sha: prodBefore.sha, url: prodBefore.url, at: new Date().toISOString(),
      });
    }

    // 3a. From here a merge may happen: show it in the run record (inFlight, cleared on EVERY exit below), and leave the
    // known-good deployment as an append-only event (3c below), so a rollback target outlives a rewritten record.
    // The record is display, the checks are the safety: a failed write is a warning, never a refusal.
    const recorder = createRunRecorder({ gh, pr });
    recorder.update({
      step: 'merge', outcome: null, head: gate.head,
      inFlight: inFlightSince(recorder, 'merge', 2 * config.merge.wait_minutes + 15),
    }, { initialStep: 'merge' });
    const attempt = async () => {
      // 3b. The live gate ran slow probes after it read the PR: look at GitHub once more, right before the merge command.
      const late = await preMergeProblems({ gh, pr, head: gate.head });
      if (late.length > 0) return refuse('pre-merge', late);

      // 3c. Fail CLOSED: the prod-before event is the only copy of the rollback target that survives this machine (prod-watch
      // refuses to roll back when it cannot record its intent, too). Posted after the last look, so a refused merge leaves none.
      if (prodBefore) {
        try {
          postEvent(gh, pr, 'prod-before', `pr${pr}-${gate.head.slice(0, 12)}`,
            `Production before merging #${pr}: ${config.production.environment} deployment ${prodBefore.id} at ${String(prodBefore.sha).slice(0, 12)} is the rollback target.`, {
              repo: gh.repo().slug, environment: config.production.environment, pr, headBeforeMerge: gate.head,
              deployment: { id: prodBefore.id, sha: prodBefore.sha, url: prodBefore.url },
            });
        } catch (err) {
          const reason = 'could not record the rollback target on the PR (prod-before event)';
          return refuse('pre-merge', [reason], { reason, detail: String(err?.message ?? err).slice(0, 200) });
        }
      }

      // 4. Merge with the approved head (fill is strict: a missing {sha} throws instead of merging whatever head exists).
      const { waitMs, pollMs } = mergeTiming(config, ctx.env ?? process.env);
      const command = fill(config.merge.command, { pr: String(pr), sha: gate.head }, { strict: true });
      const ran = await runShellAsync(command, { cwd: root, env: ctx.env, timeoutMs: (config.merge.wait_minutes + 5) * 60_000 });
      const commandOutput = tailLines(`${ran.stdout}${ran.stderr ? `\n${ran.stderr}` : ''}`, 30);

      // MERGED is MERGED: a merge commit GitHub cannot name yet is a warning, not a refusal (exit 1 means "nothing merged", and
      // the caller must go on to prod-watch, which resolves the SHA itself).
      const merged = (mergeSha, extra = {}) => ({
        exitCode: EXIT.OK,
        output: mergeSha
          ? { ok: true, merged: true, mergeSha, prodBefore, ...extra }
          : {
            ok: true, merged: true, mergeSha: null, prodBefore,
            warning: 'the PR is MERGED but GitHub did not report its merge commit after re-reading: resolve the merge SHA (prod-watch does) before anything depends on it',
            ...extra,
          },
      });

      // 5. Wait for MERGED, re-checking the blockers on every poll. If the command failed it may still have merged (a
      // branch-delete error after a merge exits non-zero), so look once before calling it a failure.
      const outcome = await waitForMerge({ gh, pr, waitMs: ran.code === 0 ? waitMs : 0, pollMs, blockers: waitBlockers(gh) });
      if (outcome.state === 'merged') {
        return merged(outcome.mergeSha, ran.code === 0 ? {} : { commandExitCode: ran.code, note: 'the merge command exited non-zero but the PR is MERGED' });
      }

      // Not merged: disarm auto-merge, then look again (it may have fired a moment before the disable).
      const abandoned = await abandonMerge({ gh, pr, cwd: root, env: ctx.env, pollMs });
      if (abandoned.merged) return merged(abandoned.mergeSha, { note: 'the PR merged while auto-merge was being disabled', autoMergeDisabled: abandoned.autoMergeDisabled });

      const { autoMergeDisabled } = abandoned;
      const failure = { merged: false, autoMergeDisabled, commandExitCode: ran.code, commandOutput, prodBefore };
      if (ran.code !== 0) {
        return { exitCode: EXIT.FAILED, output: { ok: false, reason: `merge command failed (exit ${ran.code}${ran.timedOut ? ', timed out' : ''}) and the PR is not merged`, ...failure } };
      }
      const base = {
        timeout: 'not merged in time',
        closed: 'the PR was closed without merging',
        error: `could not read the PR state while waiting (${outcome.error})`,
        blocked: `a blocker appeared while waiting: ${(outcome.problems ?? []).join('; ')}`,
      }[outcome.state];
      const tail = autoMergeDisabled ? 'auto-merge disabled' : 'could not confirm auto-merge is disabled: check the PR by hand';
      return { exitCode: EXIT.FAILED, output: { ok: false, reason: `${base} — ${tail}`, ...failure } };
    };

    let result;
    try {
      result = await attempt();
    } finally {
      const out = result?.output;
      recorder.update(out?.merged === true
        ? { step: 'prod-watch', mergeSha: out.mergeSha ?? null, inFlight: null }
        : { step: 'gate', inFlight: null });
    }
    if (recorder.warnings.length > 0) result.output.warnings = recorder.warnings;
    return result;
  });
});
