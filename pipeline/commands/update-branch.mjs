// `pipeline update-branch --pr N`: bring the PR branch up to date with its base on GitHub BEFORE the final gate, wait for
// the new head's required checks, and report the head the gate must now judge. Never force-pushes; a conflict or a head that
// moved is an outcome for a human or a re-read, not something to retry (see lib/updatebranch.mjs).
import { EXIT, parseCommandArgs, intOption } from '../lib/cli.mjs';
import { guarded, requireConfig, resolveRepo } from '../lib/cmd-common.mjs';
import { createGitHub, guardGh } from '../lib/github.mjs';
import { headSha } from '../lib/git.mjs';
import { createRunRecorder, inFlightSince } from '../lib/run-progress.mjs';
import { MAX_UPDATE_CYCLES, bringUpToDate, updateTiming } from '../lib/updatebranch.mjs';
import { holdBeforeUpdate, recordSuccessor, releaseHold, unreleasedWarning } from '../lib/merge-hold.mjs';

export const meta = {
  summary: 'bring the PR branch up to date with its base on GitHub (update-branch with expected_head_sha), return the new head (checks are not waited for by default)',
  usage: 'pipeline update-branch --pr N [--expect-head SHA] [--max-cycles N=3] [--wait-checks] [--repo DIR]   -> {ok, outcome, updated, cycles, base, startHead, head, localHead, pullNeeded, successors, hold?, holdRelease?, message?, warnings?}; outcome up-to-date (exit 0; when updated: git pull --ff-only, then re-verify and run the gate on `head`; checks are NOT waited for unless --wait-checks) | rebase-needed | head-moved | cycle-cap | head-timeout | not-open | queued-behind | hold-unreadable | (with --wait-checks) checks-failed | checks-timeout (exit 1; rebase-needed = the update conflicts, needs-human), 3 GitHub unavailable. For a repo with the merge.hold_* keys the repo\'s read-only hold check runs before every update: queued-behind {verdict: hold:queued-behind, blockedBy:[PR numbers], holds, doNotUpdate:true, reason} = another PR\'s active hold is ahead (nothing is updated; do NOT retry: wait, or the owner merges the PR ahead), hold-unreadable = the check could not be read (retry later); both exit 1, and updated/cycles say what was done before. For such a repo the hold of this PR is TAKEN right before the first update (after the check shows nothing ahead; the check runs once more after the take), so the catch-up CI round cannot be invalidated by another session\'s merge; `hold` {taken, tookThisCall, mayHold, take: {confirmed, code, lines} | null} says what happened (a take that is not confirmed carries on without a hold: the hold is cooperative). A refusal after this call\'s take carries holdTaken. queued-behind after the take = another older hold won the race: the younger hold is KEPT (wait with `merge-hold --check --wait`, then update again). Auto-release, only for a hold THIS call may have written (hold.mayHold = the take ran, whatever its answer: exit 1 means refused OR not confirmed, and the provider can add the label before it fails to confirm; releasing a label that was never written is a harmless no-op): checks-failed (--wait-checks) releases reason ci-failed, rebase-needed releases update-conflict, a hold-unreadable re-check releases hold-unreadable only when the take was NOT confirmed (a confirmed hold is real, only the check could not be read: it is KEPT and the refusal carries holdTaken: true; retry later or release it by hand); output holdRelease {reason, confirmed, code, lines} and a warnings line when the release was not confirmed (repeat it with `merge-hold --release`). Every other outcome keeps the hold. successors lists every accepted update as {from, to, baseSha} (the pipeline\'s own heads; each is also written to the git common dir so `merge-hold --release --reason new-commits` keeps the hold on it). While it runs the run record of the PR shows inFlight {kind: update-branch}; warnings lists a record write that failed or a successor record that could not be written (never fatal)',
};

export const run = guarded(async (argv, ctx) => {
  const { values } = parseCommandArgs(argv, {
    pr: { type: 'string' }, 'expect-head': { type: 'string' }, 'max-cycles': { type: 'string' }, 'wait-checks': { type: 'boolean' }, repo: { type: 'string' },
  }, { allowPositionals: false });
  const pr = intOption(values, 'pr', { required: true, min: 1 });
  const maxCycles = intOption(values, 'max-cycles', { min: 1, max: 10 }) ?? MAX_UPDATE_CYCLES;
  const root = resolveRepo(values, ctx);
  const { config } = await requireConfig(root);
  const localHead = headSha({ cwd: root });
  // The head the caller has verified: the worktree's own HEAD unless it names another. GitHub is asked to update only that head.
  const expectHead = values['expect-head'] ?? localHead;
  const gh = createGitHub({ cwd: root, env: ctx.env });

  return guardGh(async () => {
    // The run record shows the update as in flight (30 min cap), and it is cleared on every exit, a throw included.
    // The record is display: a failed write is a warning in the output, never a failure of the update.
    const recorder = createRunRecorder({ gh, pr });
    recorder.update({ inFlight: inFlightSince(recorder, 'update-branch', 30) }, { initialStep: 'gate' });
    let r;
    // A repo with a merge hold: the hold is looked at before EVERY update PUT (one ahead of this PR, or an unreadable check, ends it) and
    // taken before the first one, so the catch-up CI round cannot be invalidated by another session's merge (lib/merge-hold.mjs).
    const { beforeUpdate, info } = holdBeforeUpdate({ config, pr, root, env: ctx.env });
    try {
      // Every accepted update is written down at once as this worktree's own successor head, hold or no hold: a record is cheap and
      // lets a later hold config keep its turn. A write error is a warning (bringUpToDate lists it), never a failure.
      r = await bringUpToDate({
        gh, pr, expectHead, maxCycles, waitChecks: values['wait-checks'] === true, beforeUpdate, onSuccessor: (s) => recordSuccessor(root, pr, s), ...updateTiming(ctx.env),
      });
    } finally {
      recorder.update({ inFlight: null });
    }
    const warnings = [...recorder.warnings, ...(r.successorWarnings ?? [])];
    // Only a hold THIS call may have written (info.mayHold = the take ran: exit 1 is "refused OR not confirmed" and may follow a written label, and releasing a label that was never written is a harmless no-op) is given back on its own. A failed catch-up the session must now fix by hand (the updated head's
    // required checks failed; the update conflicts) or a hold check that could not be read after an UNCONFIRMED take (the label may be written) releases it; a queued-behind race loss keeps the younger hold (the caller waits for its turn); every other outcome keeps it.
    // A hold-unreadable re-check after a CONFIRMED take keeps the (real) hold: only the check failed to read, a release would give away the turn.
    const releaseReason = info?.mayHold ? ({ 'checks-failed': 'ci-failed', 'rebase-needed': 'update-conflict', ...(info.taken ? {} : { 'hold-unreadable': 'hold-unreadable' }) })[r.outcome] : undefined;
    let holdRelease;
    if (releaseReason !== undefined) {
      const rel = await releaseHold({ config, pr, reason: releaseReason, root, env: ctx.env });
      holdRelease = { reason: releaseReason, confirmed: rel.confirmed === true, code: rel.code ?? null, lines: rel.lines ?? [] };
      if (!holdRelease.confirmed) warnings.push(unreleasedWarning({ pr, reason: releaseReason, code: holdRelease.code, takeConfirmed: info.taken, again: true }));
    }
    const { successorWarnings, ...result } = r;
    const head = r.head ?? null;
    return {
      exitCode: r.ok ? EXIT.OK : EXIT.FAILED,
      output: {
        ...result, head, localHead, pullNeeded: head !== null && head !== localHead,
        ...(info ? { hold: info } : {}), ...(holdRelease ? { holdRelease } : {}), ...(warnings.length > 0 ? { warnings } : {}),
      },
    };
  });
});
