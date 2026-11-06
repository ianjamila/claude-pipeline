// `pipeline merge --pr N`: the ONLY sanctioned agent merge path. It trusts nothing it did not just re-read: the gate
// file only names the head and patch that were approved (and must still match, and be fresh); everything else is
// re-proved LIVE, by running the whole final gate again immediately before the merge command, because a gate file is
// just JSON on disk and anyone can write one. Only then does it run the project's merge command with the approved head
// SHA (so a head that moved can never merge). It then waits for GitHub to say MERGED, re-checking the blockers on every
// poll; anything else ends with auto-merge disabled, because an unattended queued merge could land later on a base nobody
// verified against.
import { EXIT, UsageError, parseCommandArgs, intOption } from '../lib/cli.mjs';
import { fill } from '../lib/config.mjs';
import { Fail, guarded, requireConfig, resolveRepo } from '../lib/cmd-common.mjs';
import { withReviewLock } from '../lib/review-context.mjs';
import { createGitHub, guardGh } from '../lib/github.mjs';
import { headSha } from '../lib/git.mjs';
import { envWithGhDir, killTree, runShellAsync } from '../lib/proc.mjs';
import { postEvent } from '../lib/run-events.mjs';
import { proofLine } from '../lib/run-record.mjs';
import { readSummaryComment } from '../lib/summary-comment.mjs';
import { createRunRecorder, inFlightSince } from '../lib/run-progress.mjs';
import { bringUpToDate, updateTiming } from '../lib/updatebranch.mjs';
import { loadState } from '../lib/state.mjs';
import { approvalConfigDirHint, approvalGap, areasBlock, holdBlock, readyLine } from '../hooks/lib/owner-go.mjs';
import { findOrphanedLift, holdTiming, mergeInProgress, parkNoteOf, readEligibleHold, recoverOrphanedLift, withHoldLifted, withMergeLock } from '../lib/hold.mjs';
import {
  GATE_FILE, PR_FIELDS, READABLE_MERGE_STATES, abandonMerge, disableAutoMerge, evaluateGate, evaluateOwnerGo, gateRefusals, localContentHash, mergeTiming, ownerGoBaseProblem, preMergeProblems, readReviewJson,
  waitBlockers, waitForMerge,
} from '../lib/finalgate.mjs';
import { classifyMergeCommand, commandTail } from '../lib/merge-cleanup.mjs';
import { checkHolds, holdGate, holdGateFrom, holdsConfigured, queuedBehindFrom, queuedBehindRefusal } from '../lib/merge-hold.mjs';

export const meta = {
  summary: 'merge the PR if (and only if) the final gate passes again, live; waits for MERGED',
  usage: 'pipeline merge --pr N [--owner-approved-head SHA --owner-approved-items DIGEST | --owner-go] [--repo DIR]   -> {ok, merged, mergeSha, warning?, warnings?, holdLifted?, commandExitCode?, localCleanup?, commandOutput?, note?} ; pipeline merge --pr N --dry-run [--owner-go] [--repo DIR]   -> {ok, dryRun:true, wouldMerge, blockers:[{kind, detail}], ownerStep} : the verdict without merging or writing anything (see --dry-run below) ; --owner-go (work that never ran the review skill: no final-gate.json) merges the local HEAD when the PR is open, not a draft, MERGEABLE, not behind its base, without a blocking label, every required check is green on that head, the scan of GitHub\'s own range merge-base(baseRefOid, HEAD)..HEAD passes (check scan-range: base commit present locally, no replace ref / grafts / shallow clone, GitHub\'s pulls/N/files list matches the local diff) and the diff has no blocking hard-stop or test-integrity violation, AND the owner-go hook recorded the owner\'s "merge" for this PR, that head, the LIVE items digest (items none when the diff has no owner item; a diff with chat-mode owner items needs a record for exactly their digest) and, for protected areas, the `Areas <ids>` line shown directly above the Head line (error live-check / owner-go / pre-merge otherwise, naming the lines to show; the last look re-reads baseRefOid and headRefOid and refuses when either moved; output mode owner-go, nothing written); a needs-human hold the request named (Hold line, hold field, lift wording; see docs/cli.md Owner-go) is lifted by that same owner word and put back whenever nothing merged (output holdLifted on a merge; holdRestored + holdRestoredNote, holdKept + holdKeptNote, holdRestoreUnverified + holdRestoreNote or holdRemovedByOther otherwise; error hold | hold-recovery | hold-restore | merge-in-progress; hold-restore carries holdRestoreFailed: true and exit 1; hold-recovery disarms auto-merge first and adds autoMergeDisarmFailed: true when it could not (disable it by hand) or prMerged: true when the PR merged after all; merge-in-progress = another P merge for the same PR runs on this machine (per-PR lock; other machines are not seen), nothing changed); both routes first put right an earlier --owner-go run that lifted a hold and died (hold-recovery; the dry run lists it as blocker hold-lift-orphan, a lift that cannot be verified as hold-lift-unverified, a merge running now as merge-in-progress); when the review skill ran for the PR (a triage or review-complete comment of ours, or a local review state) the check review-complete also needs the review completed for exactly this content, the local state equal to the published one and every dismissal shown (rulings: the block the owner is shown, ownerStep.rulings = `Rulings <digest12>` and its rows, printed directly above the Areas / Hold / Head lines; ownerStep.rulingCount; absent for an ordinary PR); a dismissal Claude made counts as an owner item on the gated route (ownerMerge > 0); both routes run under the review lock of the PR (merge lock first, then review lock) from before the live read until MERGED or until nothing merged and auto-merge is disarmed, so a review writer waits and then fails lock-timeout; a merge that cannot take it refuses lock-timeout with nothing changed (the dry run takes no lock); exit 0 merged (mergeSha:null + warning when GitHub cannot name the merge commit), 1 not merged / refused (error: gate|behind-base|live-check|pre-merge|queued-behind|hold-unreadable; behind-base = the base moved: the branch was updated (or the update failed, see outcome), re-verify and run final-gate again), 3 GitHub unavailable. For a repo with merge.hold_command / hold_release_command / hold_check_command (a cooperative merge lock of its own) the repo\'s read-only hold check runs before anything is updated or merged: on --owner-go right after that recovery (hold-recovery), before the live check and the owner-go approval check; on the gated route after that recovery, the gate-file check (error gate) and the resumed-run / ownerMerge checks read from the gate file (error pre-merge), before the branch is brought up to date and the live gate: another PR\'s active hold that would block this one is error queued-behind {verdict: hold:queued-behind, blockedBy:[PR numbers], holds, doNotUpdate:true, reason} (nothing is updated or merged; do NOT run update-branch; wait, or the owner merges the PR ahead; a fresh "merge" is needed afterwards), an unreadable check is error hold-unreadable (retry later); the check runs again before every branch update, and a merge command whose output says hold:queued-behind is mapped to queued-behind too (cooperative: only a hold-aware merge command catches a hold taken after the check). While it runs the run record of the PR shows inFlight {kind: merge} and step merge; for a repo with verify.deferrable_steps the proofs of the live gate (where each deferrable step was proved: the Mac, or a GitHub run and attempt) are recorded in the run record and in an append-only ci-proof-used event comment before the merge command, and when either write fails nothing is merged (error pre-merge); warnings lists a run record write that failed (never fatal). A run record marked resumed (`P checkpoint --resumed`: a run taken over by ship resume) refuses with error pre-merge unless the owner approved it; so does a run record that cannot be checked (unreadable, invalid or unsupported: it may be a resumed one), and with owner_approval: chat a gate with ownerMerge > 0. Approved = --owner-approved-head names the full gate head, --owner-approved-items the gate\'s ownerItems, AND the owner-go hook recorded the owner\'s \"merge\" for exactly that PR, head and item set (the flags alone refuse); the live gate must still show those ownerItems. Behind its base (--owner-go only, real run and --dry-run; the gated route still updates the branch): refused as behind-base unless the BASE commit\'s .claude/pipeline.yml (never the PR\'s own copy) has merge.behind_base: disjoint AND mergeStateStatus is CLEAN|HAS_HOOKS|UNSTABLE|BLOCKED (never BEHIND / DIRTY / UNKNOWN) AND mergeable is MERGEABLE AND the paths main changed since the merge base (git diff -M, renames as both names, compared NFC and case-folded) share none with the PR\'s paths AND none matches .github/**, .claude/pipeline.yml, scripts/verify*, **/.gitattributes, **/.gitmodules, **/.nvmrc, **/.node-version, **/.tool-versions, the base\'s verify.ci_proof_inputs or its merge.behind_base_stale_paths AND main removed no directory the PR adds into; the output then carries behind {behindBy, mergeBase, baseRefOid, mainFiles, rule: disjoint} (null when up to date), the dry run\'s say-merge ownerStep gains behindNote (show it above the Areas / Head lines) and a compare-API behind whose base tip is not the checked baseRefOid stays a blocker. The owner\'s "merge" stays bound to head + items (+ Areas), not to main\'s commit: the real run re-checks all of this against the base it finds. Every --owner-go merge also pins GitHub\'s baseRefOid while it waits: a base that moved off the evaluated one disables auto-merge and the run exits 1 (not merged). --dry-run (an agent previewing the verdict; never run the repo\'s merge command for that; for a repo with the hold keys it DOES run the repo\'s read-only hold check, reports holds {readable, blockedBy} and names a blocking or unreadable hold as blocker merge-hold, and withdraws every "update the branch" advice from the blockers while a hold is ahead) runs the same checks as the real run (gate file, resumed-run guard, ownerMerge, behind base, the live gate, the --owner-go preconditions) and stops before anything that writes or merges: it never updates the branch (behind-ness is read from GitHub: mergeStateStatus BEHIND, or the compare API showing the head lacks the base tip; blocker behind-base; UNKNOWN / DIRTY or a compare error: behind-base-unverified), writes no run record, event, label, comment or file, and changes no git state (no fetch: for a repo with verify.deferrable_steps the base proof settings are read from the GitHub contents API at the PR\'s baseRefOid, which must exist locally, else blocker proof-settings-unverified). It collects every blocker it can find instead of stopping at the first, and names the owner step instead of refusing on it: ownerStep null (a low-risk review: P merges by itself; or a hardstops / integrity scan that could not run: fix that blocker first, nothing is handed off) | {kind: say-merge, line, areas?, areaIds?, hold?, holdInfo?, ready?, parkNote?} (the exact "Head … · items … · repo …" line; for --owner-go the items are the LIVE scan\'s digest, and for protected areas `areas` is the `Areas <ids>` line to print directly above it; with an eligible needs-human hold (--owner-go, owner_approval: chat, needs-human the only blocking label, a complete readable timeline) `line` carries `· hold <id>`, `hold` is the `Hold <id> by <login> at <ISO>` line to print between Areas and Head, `holdInfo` {id, login, at} the hold as the timeline event shows it (the account is shared: never call it the owner or the agent hold), `ready` the exact 🔀 line ending `and lift its needs-human hold` to close the reply with (without a hold there is no `ready`: print the plain 🔀 line), `parkNote` {label, text, updatedAt} the newest agent-written needs-human park comment as one line prefixed `quoted note: `, only when it was updated at or after the hold event) | {kind: owner-runs, command} (gated route: ownerMerge > 0; --owner-go: a blocking hard-stop / integrity violation, or any owner item under owner_approval: label; the repo\'s merge.command filled with PR and head, which the owner runs) | {kind: owner-approval-flags} (a resumed or unchecked run record); for a repo with the hold keys every non-null ownerStep also carries holdEligible: true only for a say-merge / owner-runs ending whose blockers are none, or only the owner-items check and the hardstops / integrity checks behind it when they are a real verdict (hits / violations; a scan that could not run, "could not evaluate" / "could not diff", leaves ownerStep null) (the hand-off may take the merge hold; any other blocker, a hold ahead or an unreadable hold check makes it false). It grants nothing: the real run re-checks the owner\'s record. Exit 0 wouldMerge (given the owner\'s word where ownerStep says so), 1 blockers, 2 --dry-run with --owner-approved-head / --owner-approved-items, 3 GitHub unavailable',
};

const APPROVAL_FLAGS = "--owner-approved-head <full head> --owner-approved-items <the gate's ownerItems>";
const OWNER_MERGE_REASON = `the final gate left items for the owner (owner_approval: chat): the owner must say "merge" for this exact head and item set (then pass ${APPROVAL_FLAGS})`;

const refuse = (error, reasons, extra = {}) => ({
  exitCode: EXIT.FAILED,
  output: { ok: false, merged: false, error, reasons, message: error === 'gate' ? 'run final-gate again' : reasons.join('; '), ...extra },
});

// A merge-hold refusal (lib/merge-hold.mjs holdGate / queuedBehindRefusal, or a bringUpToDate outcome carrying one) as a merge refusal.
const holdRefuse = (r, extra = {}) => refuse(r.error, [r.reason], {
  ...(r.verdict ? { verdict: r.verdict, blockedBy: r.blockedBy, doNotUpdate: true, ...(r.holds ? { holds: r.holds } : {}) } : {}), ...extra,
});
const HOLD_OUTCOMES = new Set(['queued-behind', 'hold-unreadable']);
// A failed merge command whose full output says the PR is queued behind another's hold (repos with the hold keys only).
const queuedBehindOf = (config, ran) => (holdsConfigured(config) && ran.code !== 0 ? queuedBehindFrom(`${ran.stdout}\n${ran.stderr}`) : null);

export const run = guarded(async (argv, ctx) => {
  const { values } = parseCommandArgs(argv, {
    pr: { type: 'string' }, repo: { type: 'string' }, 'owner-approved-head': { type: 'string' }, 'owner-approved-items': { type: 'string' },
    'owner-go': { type: 'boolean' }, 'dry-run': { type: 'boolean' },
  }, { allowPositionals: false });
  const pr = intOption(values, 'pr', { required: true, min: 1 });
  const root = resolveRepo(values, ctx);
  const { config } = await requireConfig(root);
  const gh = createGitHub({ cwd: root, env: ctx.env });

  if (values['dry-run'] === true) {
    if (values['owner-approved-head'] !== undefined || values['owner-approved-items'] !== undefined) {
      throw new UsageError('--dry-run takes no --owner-approved-head / --owner-approved-items: it grants nothing and only reports the owner step');
    }
    return guardGh(() => dryRunMerge({ root, config, pr, gh, ctx, ownerGo: values['owner-go'] === true }));
  }

  if (values['owner-go'] === true) {
    if (values['owner-approved-head'] !== undefined || values['owner-approved-items'] !== undefined) {
      throw new UsageError('--owner-go takes no --owner-approved-head / --owner-approved-items: it is bound to the local HEAD and the owner-go record');
    }
    // One merge per PR at a time on this machine: recovery below must never run under a live merge (lib/hold.mjs withMergeLock).
    return guardGh(() => withMergeLock({ gh, pr, env: ctx.env ?? process.env, refuse, fn: (track) => underReviewLock({ root, pr, ctx, fn: () => ownerGoMerge({ root, config, pr, gh, ctx, track }) }) }));
  }

  return guardGh(() => withMergeLock({ gh, pr, env: ctx.env ?? process.env, refuse, fn: (track) => underReviewLock({ root, pr, ctx, fn: async () => {
    // 0. A lift comment with no label and no merge (an `--owner-go` run that died after removing needs-human) is put right before anything else.
    const recovered = await recoverOrphanedLift({ gh, pr, refuse, strict: false, env: ctx.env ?? process.env, disableAuto: () => disableAutoMerge({ pr, cwd: root, env: ctx.env }) });
    if (recovered !== null) return recovered;
    // 1. The gate file must name this head and this patch, in this repo, and be fresh. It is only a binding: it proves nothing by itself.
    const gate = readReviewJson(root, GATE_FILE);
    const head = headSha({ cwd: root });
    let hash = '';
    try {
      hash = localContentHash(root, config);
    } catch { /* gateRefusals reports the mismatch */ }
    const refusals = gateRefusals({
      gate, pr, head, prHead: gh.prView(pr, [...PR_FIELDS]).headRefOid, hash, repo: gh.repo().slug,
    });
    if (refusals.length > 0) return refuse('gate', refusals);

    // 1a. A resumed run never merges on its own: the run record (viewer-authored, so not forgeable by a commenter) says whether this
    // run was taken over from an earlier session (an older record from `ship resume` carries the flag); if so the owner's approval of THIS exact head must come in as a flag. Read before
    // anything irreversible. A record that cannot be checked (unreadable comments, an invalid or newer record) fails CLOSED: it
    // may be a resumed one, so it needs the same approval. No record (absent) or a legacy comment is an ordinary run.
    // Why (#58): the flags were the agent's own word. They now only name what the owner approved: the owner-go recorder (a
    // UserPromptSubmit hook that only the owner's typed prompt reaches) must hold a "merge" for exactly this PR, this full head
    // and this owner-item set, as shown to the owner in the reply right before it (Head and 🔀 lines). See hooks/lib/owner-go.mjs.
    let approvalProblem = null;
    if (values['owner-approved-head'] !== undefined) {
      if (values['owner-approved-head'] !== gate.head || !/^[0-9a-f]{40}$/.test(gate.head)) approvalProblem = '--owner-approved-head is not the gate head';
      else if (typeof gate.ownerItems !== 'string') approvalProblem = 'the gate file names no owner-item set (written by an older final-gate): run final-gate again';
      else if (values['owner-approved-items'] !== gate.ownerItems) approvalProblem = `--owner-approved-items is not the gate's owner-item set (${gate.ownerItems})`;
      else if (gh.repo().host !== 'github.com') approvalProblem = hostProblem(gh);
      else {
        const gap = approvalGap({ repo: gh.repo().slug, pr, head: gate.head, items: gate.ownerItems, areas: null, hold: null, rulings: null }); // the gated route binds items only (a Claude dismissal is one of them, E3)
        if (gap !== 'ok') approvalProblem = missingApproval(gap, `${gh.repo().slug} #${pr} head ${gate.head.slice(0, 12)} items ${gate.ownerItems}`, `show the request (Owner-merge approval in the review skill: \`${requestParts({ head: gate.head, items: gate.ownerItems, repo: gh.repo().slug }).line}\`) and wait for the owner to type "merge"`, { repo: gh.repo().slug, pr, head: gate.head, items: gate.ownerItems, areas: null, hold: null, rulings: null });
      }
    }
    const ownerApproved = values['owner-approved-head'] !== undefined && approvalProblem === null;
    const withProblem = (reason) => (approvalProblem ? `${reason} (${approvalProblem})` : reason);
    let unchecked = null;
    let existing = null;
    try {
      existing = readSummaryComment(gh, pr);
      if (existing.status === 'invalid' || existing.status === 'unsupported') unchecked = `the run record is ${existing.status}`;
    } catch (err) {
      unchecked = `the run record could not be read (${String(err?.message ?? err).slice(0, 200)})`;
    }
    if (!ownerApproved) {
      if (existing?.status === 'ok' && existing.record.resumed) {
        const reason = withProblem(`resumed run: the owner must say "merge" for this exact head (then pass ${APPROVAL_FLAGS})`);
        return refuse('pre-merge', [reason], { reason });
      }
      if (unchecked) {
        const reason = withProblem(`${unchecked}, so the resumed-run guard cannot be checked: the owner must say "merge" for this exact head (then pass ${APPROVAL_FLAGS})`);
        return refuse('pre-merge', [reason], { reason });
      }
      // Why (#58): with owner_approval: chat a head the final gate left items for the owner on (ownerMerge > 0: hard-stop paths, test
      // changes) merged with no approval, or with one for an older head, because the flag was only read for resumed runs. Checked here
      // from the gate file (before anything touches GitHub) and again on the live gate below (the file is local and could be edited).
      if (Number(gate.ownerMerge) > 0) return refuse('pre-merge', [withProblem(OWNER_MERGE_REASON)], { reason: withProblem(OWNER_MERGE_REASON) });
    }
    const warnings = [];

    // 1b. Main may have moved since the gate ran: the gate, and the CI it waited on, then judged a tree that is NOT the one that
    // would land. Bring the branch up to date on GitHub (one update; expected_head_sha = the approved head), then refuse: the new
    // head needs its own verify + gate, so nothing merges on this attempt. Up to date already => carry on.
    // With a merge hold configured, a hold ahead of this PR is looked at BEFORE the branch is touched (a stale PR behind an older hold must
    // not be updated: that costs a CI round for nothing), and again before the update PUT itself.
    const heldBefore = await holdGate({ config, pr, root, env: ctx.env });
    if (heldBefore) return holdRefuse(heldBefore);
    const beforeUpdate = holdsConfigured(config) ? () => holdGate({ config, pr, root, env: ctx.env }) : null;
    const synced = await bringUpToDate({ gh, pr, expectHead: gate.head, maxCycles: 1, waitChecks: false, beforeUpdate, ...updateTiming(ctx.env) });
    if (!synced.ok) {
      if (HOLD_OUTCOMES.has(synced.outcome)) return holdRefuse({ ...synced, error: synced.outcome }, { outcome: synced.outcome, updated: synced.updated, cycles: synced.cycles, head: synced.head ?? null });
      return refuse('behind-base', [synced.message ?? `could not bring the branch up to date (${synced.outcome})`], { outcome: synced.outcome, updated: synced.updated, head: synced.head ?? null });
    }
    if (synced.updated) {
      return refuse('behind-base', [`the base moved: the branch was updated to ${synced.head}; pull it, re-verify and run final-gate on that head`], { outcome: 'updated', updated: true, head: synced.head });
    }

    // 2. The live gate, immediately before the merge: every check re-evaluated against GitHub and the worktree as they are NOW.
    const fresh = await evaluateGate({ root, config, pr, gh, env: ctx.env });
    const failed = fresh.checks.filter((c) => !c.ok);
    if (failed.length > 0) return refuse('live-check', failed.map((c) => `${c.name}: ${c.detail}`));
    if (fresh.head !== gate.head || fresh.contentHash !== gate.contentHash) {
      return refuse('live-check', ['the live gate is for a different head or patch than final-gate.json approved']);
    }
    if (Number(fresh.ownerMerge) > 0 && !ownerApproved) return refuse('pre-merge', [withProblem(OWNER_MERGE_REASON)], { reason: withProblem(OWNER_MERGE_REASON) });
    // (an item added or swapped since the owner said "merge", same head: the owner never saw it)
    if (ownerApproved && fresh.ownerItems !== gate.ownerItems) {
      const reason = `the owner items changed since the owner said "merge" (now ${fresh.ownerItems}, approved ${gate.ownerItems}): show them and ask again`;
      return refuse('pre-merge', [reason], { reason });
    }

    // 3. From here a merge may happen: show it in the run record (inFlight, cleared on EVERY exit below).
    // The record is display, the checks are the safety: a failed write is a warning, never a refusal.
    const recorder = createRunRecorder({ gh, pr });
    recorder.update({
      step: 'merge', outcome: null, head: gate.head,
      inFlight: inFlightSince(recorder, 'merge', 2 * config.merge.wait_minutes + 15),
    }, { initialStep: 'merge' });
    const attempt = async () => {
      // 3a. The live gate ran slow probes after it read the PR: look at GitHub once more, right before the merge command.
      const late = await preMergeProblems({ gh, pr, head: gate.head });
      if (late.length > 0) return refuse('pre-merge', late);

      // 3b. Which proof each deferrable verify step stood on (T2: the Mac, or a GitHub run), taken from THIS live evaluation, never the
      // saved gate (gate passed on run A, now run B: B is recorded). Fail CLOSED: the append-only event first, then the run
      // record, and when either cannot be written nothing is merged. A repo without verify.deferrable_steps has no proofs: no calls.
      const proofs = Array.isArray(fresh.proofs) ? fresh.proofs : [];
      if (proofs.length > 0) {
        const refuseProof = (why, detail) => {
          const reason = `could not record the verify proof on the PR (${why})`;
          return refuse('pre-merge', [reason], { reason, ...(detail ? { detail: String(detail).slice(0, 200) } : {}) });
        };
        try {
          postEvent(gh, pr, 'ci-proof-used', `pr${pr}-${gate.head.slice(0, 12)}`,
            `Verify proof used to merge #${pr} at ${gate.head.slice(0, 12)}: ${proofs.map(proofLine).join('; ')}.`, {
              repo: gh.repo().slug, pr, head: gate.head, proofs,
            });
        } catch (err) {
          return refuseProof('ci-proof-used event', err?.message ?? err);
        }
        if (recorder.update({ proofs }) === null) return refuseProof('run record', recorder.warnings.at(-1));
      }

      // 4. Merge with the approved head (fill is strict: a missing {sha} throws instead of merging whatever head exists).
      const { waitMs, pollMs } = mergeTiming(config, ctx.env ?? process.env);
      const command = fill(config.merge.command, { pr: String(pr), sha: gate.head }, { strict: true });
      // The project command (eaglewatch: scripts/merge-pr.mjs) spawns gh itself: give it the dir gh() would have found.
      const ran = await runShellAsync(command, { cwd: root, env: envWithGhDir(ctx.env), timeoutMs: (config.merge.wait_minutes + 5) * 60_000, onStart: track.started });
      track.ended();
      const commandOutput = commandTail(ran);

      // MERGED is MERGED: a merge commit GitHub cannot name yet is a warning, not a refusal (exit 1 means "nothing merged", and
      // the caller resolves the SHA itself).
      const merged = (mergeSha, extra = {}) => ({
        exitCode: EXIT.OK,
        output: mergeSha
          ? { ok: true, merged: true, mergeSha, ...extra }
          : {
            ok: true, merged: true, mergeSha: null,
            warning: 'the PR is MERGED but GitHub did not report its merge commit after re-reading: resolve the merge SHA before anything depends on it',
            ...extra,
          },
      });

      // 5. Wait for MERGED, re-checking the blockers on every poll. If the command failed it may still have merged (a
      // branch-delete error after a merge exits non-zero), so look once before calling it a failure.
      const outcome = await waitForMerge({ gh, pr, waitMs: ran.code === 0 ? waitMs : 0, pollMs, blockers: waitBlockers(gh) });
      if (outcome.state === 'merged') {
        return merged(outcome.mergeSha, classifyMergeCommand(ran));
      }

      // Not merged: disarm auto-merge, then look again (it may have fired a moment before the disable).
      const abandoned = await abandonMerge({ gh, pr, cwd: root, env: ctx.env, pollMs });
      if (abandoned.merged) return merged(abandoned.mergeSha, { note: 'the PR merged while auto-merge was being disabled', autoMergeDisabled: abandoned.autoMergeDisabled });

      const { autoMergeDisabled } = abandoned;
      const failure = { merged: false, autoMergeDisabled, commandExitCode: ran.code, commandOutput };
      const behindHold = queuedBehindOf(config, ran);
      if (behindHold) return holdRefuse(queuedBehindRefusal(behindHold), failure);
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
        ? { step: 'merge', mergeSha: out.mergeSha ?? null, inFlight: null }
        : { step: 'gate', inFlight: null });
    }
    warnings.push(...recorder.warnings);
    if (warnings.length > 0) result.output.warnings = warnings;
    return result;
  } }) }));
});

// `P merge --pr N --owner-go` (owner decision 2026-10-28): the merge route for work that never ran the review skill (no
// final-gate.json, no verify report, no review state). It merges only when ALL of these hold, read live:
//   * evaluateOwnerGo: open, not a draft, MERGEABLE, not behind its base, at the local HEAD, no blocking label, every
//     required check green on that head (guard statuses and Cross-model review only with their provenance), the scan of GitHub's
//     base..head, and no BLOCKING hard-stop, no test-integrity violation (and, under owner_approval: label, no owner item);
//   * the owner-go recorder (hooks/lib/owner-go.mjs) holds the owner's "merge" for this PR, this exact head and the owner items
//     THAT SCAN found (the reply ended with the Head line carrying `items <live digest>` and the 🔀 line; `none` when the diff has
//     none) and, for a diff with protected areas, the Areas line shown right above it — the flag itself approves nothing. The agent
//     writes the request lines, so the digest and the areas are the live scan's, never the record's: a record for `items none` never
//     covers a diff with items, and one for digest X never covers items that now hash to Y;
//   * the last look right before the merge command (preMergeProblems: head, draft, labels, pause / rollback issues).
// It merges with the project's merge command pinned to that head ({sha}: --match-head-commit for gh), never adds a label,
// writes no gate file and records no verify proof, then waits for MERGED like the gated path (auto-merge disabled otherwise).
// Phase 3b: the owner's "merge" names owner/name on github.com; gh may resolve that name on another server (GH_HOST, an ssh host
// alias, a sole logged-in enterprise host), where it is another repository — refused, as the guard does for a direct merge.
// Why no owner "merge" stands for `what` (approvalGap): none was recorded, or one was but the prompt behind it cannot be confirmed as typed by the owner (#128).
// R2-F3: when the likely cause is the environment, not the prompt (the transcript is in a config dir this process does not know), `q` (the approval asked for) lets the reason say so.
const missingApproval = (gap, what, again, q) => (gap === 'provenance'
  ? `a "merge" is recorded for ${what}, but it cannot be confirmed as typed by the owner (its prompt is not in the transcript as the owner's, or came from a notice, another session or a scheduled turn${approvalConfigDirHint(q) ? `; or ${approvalConfigDirHint(q)}` : ''}): ${again}, and ask the owner to type "merge" again`
  : `no owner "merge" is recorded for ${what}: ${again}`);
const hostProblem = (gh) => `gh resolves this repository on ${gh.repo().host ?? 'an unknown host'}, not github.com, and the owner's "merge" names a repository on github.com`;

// The lines the owner is shown for a merge request, rendered in this ONE place: the Rulings block (only when Claude or the arbiter dismissed a BLOCKING / security item; the header and its rows), the Areas line (only when the diff has protected areas), the Hold
// line (only when a needs-human hold is lifted by the merge; `hold` = {id, login, at}) and the Head line (carrying `· hold <id>` for that hold), in that order (Rulings, Areas, Hold, Head).
const requestParts = ({ head, items, repo, areas, hold, rulings = '' }) => ({
  rulings,
  areas: areasBlock(areas),
  hold: holdBlock(hold),
  line: `Head ${head.slice(0, 12)} · items ${items}${hold ? ` · hold ${hold.id}` : ''} · repo ${repo}`,
});
const requestLines = (q) => Object.values(requestParts(q)).filter(Boolean);

// E2 (plan 2026-11-05-claude-rulings): the review lock is held for the WHOLE merge, inside the merge lock (always merge -> review): from before the live read until MERGED, or until nothing merged and
// auto-merge is confirmed disarmed (the hold put back included). Decisions are frozen while a merge is armed: a review writer waits LOCK_WAIT_MS, then fails lock-timeout. Live holders are never reclaimed.
// Taken before the hold is read or lifted, so a lock this merge cannot get is a clean refusal that changed nothing. Locks are not re-entrant: nothing under here may take the review lock again.
async function underReviewLock({ root, pr, ctx, fn }) {
  let entered = false;
  try {
    return await withReviewLock(root, pr, ctx, () => {
      entered = true;
      return fn();
    });
  } catch (err) {
    if (!entered && err instanceof Fail && err.output?.error === 'lock-timeout') {
      return refuse('lock-timeout', [`the review lock for #${pr} is held by another pipeline command: ${err.output.message ?? 'timed out'}; nothing was changed`], { reviewLockBusy: true });
    }
    throw err;
  }
}

async function ownerGoMerge({ root, config, pr, gh, ctx, track }) {
  const head = headSha({ cwd: root });
  const repo = gh.repo().slug;
  if (gh.repo().host !== 'github.com') {
    const reason = hostProblem(gh);
    return refuse('owner-go', [reason], { reason, head });
  }
  // Rev 4 item 4: an earlier run that lifted the hold and died is put right (label back, this run refused) before anything else.
  const recovered = await recoverOrphanedLift({ gh, pr, refuse, env: ctx.env ?? process.env, disableAuto: () => disableAutoMerge({ pr, cwd: root, env: ctx.env }) });
  if (recovered !== null) return recovered;
  // A merge hold ahead of this PR is answered next, before the live check: a stale PR behind an older hold would otherwise fail it
  // with "behind-base ... update the branch", which is exactly what the hold says NOT to do.
  const held = await holdGate({ config, pr, root, env: ctx.env });
  if (held) return holdRefuse(held, { head });
  // The needs-human hold the owner's "merge" may lift (lib/hold.mjs; none = today's flow, the label stays a blocker). Only the labels check and the
  // look BEFORE the lift ignore it (Rev-4 8).
  const { hold } = await readEligibleHold({ gh, pr, config });
  // The live scan first: the owner's record is bound to the owner items and areas IT found (read-only; nothing is written).
  const live = await evaluateOwnerGo({ root, config, pr, gh, env: ctx.env, exemptHold: hold !== null });
  if (live.head !== head) return refuse('live-check', [`the worktree moved from ${head.slice(0, 12)} to ${String(live.head).slice(0, 12)} while checking`], { head });
  if (!live.ok) return refuse('live-check', live.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`), { head });
  // A.4: never merge without the base re-read below, even if scan-range stops requiring a base sha.
  const noBase = ownerGoBaseProblem(live);
  if (noBase !== null) return refuse('live-check', [noBase], { head });
  const asked = { repo, pr, head, items: live.ownerItems, areas: live.areas, hold: hold ?? undefined, rulings: live.rulingsBlockDigest }; // (absent hold = none: a record that names a hold never approves a PR without one)
  const gap = approvalGap(asked);
  if (gap !== 'ok') {
    const lines = requestLines({ head, items: live.ownerItems, repo, areas: live.areas, hold, rulings: live.rulings });
    const reason = missingApproval(gap, `${repo} #${pr} head ${head.slice(0, 12)} items ${live.ownerItems}${live.areas.length > 0 ? ` areas ${live.areas.join(' ')}` : ''}${hold ? ` hold ${hold.id}` : ''}${live.rulingCount > 0 ? ` rulings ${live.rulingsDigest.slice(0, 12)}` : ''}`, `end the reply with ${lines.map((l) => `\`${l}\``).join(' and ')} (from \`P merge --pr ${pr} --dry-run --owner-go\`) and \`${readyLine([pr], { lift: hold !== null })}\`, and wait for the owner to type "merge"`, asked);
    return refuse('owner-go', [reason], { reason, head });
  }

  // A.4: the scan was of GitHub's base and head as read by evaluateOwnerGo; the last look re-reads both and refuses if either moved since.
  const late = await preMergeProblems({ gh, pr, head, base: live.baseRefOid, exemptHold: hold !== null });
  if (late.length > 0) return refuse('pre-merge', late, { head });

  // `running.pid` (hold lift only) is the merge command's process id while it runs: a signal kills that group and disarms auto-merge before the label goes back.
  const mergeAndWait = async (running = {}) => {
    const { waitMs, pollMs } = mergeTiming(config, ctx.env ?? process.env);
    const command = fill(config.merge.command, { pr: String(pr), sha: head }, { strict: true });
    const ran = await runShellAsync(command, { cwd: root, env: envWithGhDir(ctx.env), timeoutMs: (config.merge.wait_minutes + 5) * 60_000, onStart: (pid) => { running.pid = pid; track.started(pid); } });
    running.pid = undefined; // (gone: its pid may be reused)
    track.ended();
    const commandOutput = commandTail(ran);
    const merged = (mergeSha, extra = {}) => ({
      exitCode: EXIT.OK,
      output: mergeSha
        ? { ok: true, merged: true, mode: 'owner-go', head, behind: live.behind ?? null, mergeSha, ...extra }
        : { ok: true, merged: true, mode: 'owner-go', head, behind: live.behind ?? null, mergeSha: null, warning: 'the PR is MERGED but GitHub did not report its merge commit after re-reading', ...extra },
    });
    // Every --owner-go merge (behind or not) waits with GitHub's baseRefOid pinned to the evaluated one: a queued merge (--auto) must not land on a base nobody checked.
    const outcome = await waitForMerge({ gh, pr, waitMs: ran.code === 0 ? waitMs : 0, pollMs, blockers: waitBlockers(gh, { base: live.baseRefOid }) });
    if (outcome.state === 'merged') return merged(outcome.mergeSha, classifyMergeCommand(ran));
    const abandoned = await abandonMerge({ gh, pr, cwd: root, env: ctx.env, pollMs });
    if (abandoned.merged) return merged(abandoned.mergeSha, { note: 'the PR merged while auto-merge was being disabled', autoMergeDisabled: abandoned.autoMergeDisabled });
    const failure = { merged: false, mode: 'owner-go', head, behind: live.behind ?? null, autoMergeDisabled: abandoned.autoMergeDisabled, commandExitCode: ran.code, commandOutput };
    const behindHold = queuedBehindOf(config, ran);
    if (behindHold) return holdRefuse(queuedBehindRefusal(behindHold), failure);
    if (ran.code !== 0) return { exitCode: EXIT.FAILED, output: { ok: false, reason: `merge command failed (exit ${ran.code}${ran.timedOut ? ', timed out' : ''}) and the PR is not merged`, ...failure } };
    const base = {
      timeout: 'not merged in time', closed: 'the PR was closed without merging', error: `could not read the PR state while waiting (${outcome.error})`,
      blocked: `a blocker appeared while waiting: ${(outcome.problems ?? []).join('; ')}`,
    }[outcome.state];
    const tail = abandoned.autoMergeDisabled ? 'auto-merge disabled' : 'could not confirm auto-merge is disabled: check the PR by hand';
    return { exitCode: EXIT.FAILED, output: { ok: false, reason: `${base} — ${tail}`, ...failure } };
  };

  if (hold === null) return mergeAndWait();
  // The hold is lifted on the owner's word just before the merge command and put back whenever nothing merges (lib/hold.mjs withHoldLifted).
  return withHoldLifted({
    gh, pr, hold, head, items: live.ownerItems, repo, env: ctx.env ?? process.env, refuse,
    check: () => preMergeProblems({ gh, pr, head, base: live.baseRefOid }),
    merge: mergeAndWait,
    kill: killTree,
    disableAuto: () => disableAutoMerge({ pr, cwd: root, env: ctx.env }),
  });
}

// `P merge --pr N --dry-run [--owner-go]`: the verdict of a real `P merge` without anything that writes or merges. Same checks, in the same
// spirit, but every independent one is collected (an agent wants the whole list at once) and the owner's step is reported instead of
// refused on. Read-only means: no bringUpToDate (the branch is not touched; behind-ness is read), no run record / inFlight / ci-proof-used
// event, no label or comment, no merge command, no file written, and no shared git state changed (evaluateGate readOnly: no `git fetch`).
// It grants nothing: the owner's recorded "merge" is checked by the real run.
// (READABLE_MERGE_STATES is finalgate's: the real --owner-go merge and this dry run accept exactly the same GitHub states.)

// Behind-ness without the update: GitHub's own mergeStateStatus, then the compare API. Never "not behind" by default.
// `accepted` (--owner-go, merge.behind_base: disjoint): the behind summary the live evaluation accepted. A compare "behind" whose base tip is
// the very baseRefOid that evaluation scanned is then no blocker; any other base tip (main moved in between) still is.
function readBehind(gh, pr, { accepted = null } = {}) {
  const view = gh.prView(pr, [...PR_FIELDS, 'baseRefOid']);
  const state = view?.mergeStateStatus;
  if (state === 'BEHIND') return [{ kind: 'behind-base', detail: 'GitHub reports the PR is BEHIND its base (mergeStateStatus BEHIND): update the branch (P update-branch), re-verify and run final-gate again' }];
  const out = [];
  if (state === 'DIRTY') out.push({ kind: 'conflicts', detail: 'GitHub reports merge conflicts (mergeStateStatus DIRTY)' });
  if (!READABLE_MERGE_STATES.has(state)) {
    out.push({ kind: 'behind-base-unverified', detail: `mergeStateStatus is ${JSON.stringify(state ?? null)}, so whether the PR is behind its base is not known` });
    return out;
  }
  try {
    const cmp = gh.compare(view.baseRefName, view.headRefOid);
    if (cmp.behindBy > 0 && accepted !== null && cmp.baseSha === accepted.baseRefOid) return out;
    if (cmp.behindBy > 0) return [{ kind: 'behind-base', detail: `the PR head lacks ${cmp.behindBy} commit(s) of ${view.baseRefName} (compare API${accepted !== null ? `; its base tip ${String(cmp.baseSha).slice(0, 8)} is not the ${accepted.baseRefOid.slice(0, 8)} that was checked` : ''}): update the branch (P update-branch), re-verify and run final-gate again` }];
  } catch (err) {
    return [{ kind: 'behind-base-unverified', detail: `could not compare the head with its base (${String(err?.message ?? err).slice(0, 200)})` }];
  }
  return out;
}

async function dryRunMerge({ root, config, pr, gh, ctx, ownerGo }) {
  const blockers = [];
  const add = (kind, detail) => { const b = { kind, detail }; blockers.push(b); return b; };
  // The blockers that ARE the owner-runs hand-off (the failed owner-items check and the hardstops / integrity checks that fail it): they do
  // not stop the hand-off from taking the merge hold; any other blocker does (ownerStep.holdEligible).
  const handOffBlockers = new Set();
  const slug = gh.repo().slug;
  const head = headSha({ cwd: root });
  let gate = null;
  let live;
  let ownerRuns = false;
  let flags = null;
  // A hardstops / integrity scan that threw or could not diff (a failed check WITHOUT verdict: true) is no verdict at all: whatever else the
  // live gate says (owner-items fails behind it, or another check's ownerMerge count), nothing is handed to the owner and ownerStep stays null.
  const scanCrashed = (checks) => checks.some((c) => !c.ok && ['hardstops', 'integrity'].includes(c.name) && c.verdict !== true);
  let crashed = false;

  let hold = null; // --owner-go: the eligible needs-human hold the owner's "merge" would lift (lib/hold.mjs)

  // Read-only: a lift comment with no label and no merge (an `--owner-go` run that died) is reported; the real run puts the label back first. A merge running right now
  // (the per-PR lock, this machine) is reported instead and the orphan judgement is skipped: it would be wrong under a live merge. The unverified cases are the real run's
  // refusals: --owner-go refuses when the comments stay unreadable, the gated route tolerates only that.
  let orphan = null;
  let busy = null;
  try {
    busy = mergeInProgress({ gh, pr, env: ctx.env ?? process.env });
  } catch (err) {
    add('merge-in-progress', `the merge lock for #${pr} could not be read (${String(err?.message ?? err).slice(0, 200)})`);
  }
  if (busy !== null) add('merge-in-progress', `${busy.why}: the real run refuses until it ends`);
  else {
    let found = findOrphanedLift({ gh, pr });
    if (ownerGo && found.commentsUnreadable) { // (the real --owner-go run reads the comments once more after one pause)
      await new Promise((resolve) => setTimeout(resolve, holdTiming(ctx.env ?? process.env).pauseMs));
      found = findOrphanedLift({ gh, pr });
    }
    ({ orphan } = found);
    if (found.unverified !== null && (ownerGo || !found.commentsUnreadable)) add('hold-lift-unverified', `could not check whether an earlier --owner-go run left a needs-human hold lifted (${found.unverified}): the real run refuses (hold-recovery)`);
  }
  if (orphan !== null) add('hold-lift-orphan', `an earlier \`P merge --owner-go\` lifted needs-human hold ${orphan.hold} and died before it merged; the real run puts the label back first and refuses (the owner then says "merge" again, for the new hold)`);

  if (ownerGo) {
    if (gh.repo().host !== 'github.com') add('owner-go', hostProblem(gh));
    ({ hold } = await readEligibleHold({ gh, pr, config }));
    live = await evaluateOwnerGo({ root, config, pr, gh, env: ctx.env, exemptHold: hold !== null });
    if (live.head !== head) add('live-check', `the worktree moved from ${head.slice(0, 12)} to ${String(live.head).slice(0, 12)} while checking`);
    const failed = live.checks.filter((x) => !x.ok);
    crashed = scanCrashed(failed);
    // owner-items fails for a verdict (a hardstops / integrity check carrying verdict: true) or for its own label / area reasons; a crashed scan fails it too.
    ownerRuns = !crashed && failed.some((c) => c.name === 'owner-items');
    for (const c of failed) {
      const b = add('live-check', `${c.name}: ${c.detail}`);
      // hardstops / integrity only as a real verdict (c.verdict): a scan that threw ("could not evaluate") or could not diff is no hand-off.
      if (ownerRuns && (c.name === 'owner-items' || (['hardstops', 'integrity'].includes(c.name) && c.verdict === true))) handOffBlockers.add(b);
    }
    const noBase = ownerGoBaseProblem(live);
    if (noBase !== null) add('live-check', noBase);
  } else {
    gate = readReviewJson(root, GATE_FILE);
    let hash = '';
    try {
      hash = localContentHash(root, config);
    } catch { /* gateRefusals reports the mismatch */ }
    const refusals = gateRefusals({ gate, pr, head, prHead: gh.prView(pr, [...PR_FIELDS]).headRefOid, hash, repo: slug });
    if (refusals.length > 0) add('gate', refusals.join('; '));

    // The resumed-run guard, as a real run reads it: a resumed or unchecked record needs the owner's flags.
    try {
      const existing = readSummaryComment(gh, pr);
      if (existing.status === 'invalid' || existing.status === 'unsupported') flags = `the run record is ${existing.status}`;
      else if (existing.status === 'ok' && existing.record.resumed) flags = 'resumed run';
    } catch (err) {
      flags = `the run record could not be read (${String(err?.message ?? err).slice(0, 200)})`;
    }

    live = await evaluateGate({ root, config, pr, gh, env: ctx.env, readOnly: true });
    for (const c of live.checks.filter((x) => !x.ok)) {
      add(/proof-settings-unverified/.test(c.detail) ? 'proof-settings-unverified' : 'live-check', `${c.name}: ${c.detail}`);
    }
    if (gate !== null && (live.head !== gate.head || live.contentHash !== gate.contentHash)) add('live-check', 'the live gate is for a different head or patch than final-gate.json approved');
    // One scan crashing leaves the other check's ownerMerge count standing, so the live checks are asked, not the count alone.
    crashed = scanCrashed(live.checks);
    ownerRuns = !crashed && (Number(live.ownerMerge) > 0 || Number(gate?.ownerMerge) > 0);
  }

  const behind = ownerGo ? (live.behind ?? null) : null;
  for (const b of readBehind(gh, pr, { accepted: behind })) add(b.kind, b.detail);
  for (const reason of await preMergeProblems({ gh, pr, head, base: ownerGo ? live.baseRefOid : null, exemptHold: hold !== null })) add('pre-merge', reason);

  // A repo with the hold keys: its read-only check (the only shell command a dry run runs). A hold ahead, or an answer that cannot be
  // read, is a blocker; a branch that is behind must then NOT be updated, so the update advice above is withdrawn.
  let holds = null;
  if (holdsConfigured(config)) {
    const check = await checkHolds({ config, pr, root, env: ctx.env });
    holds = { readable: check.ok === true, blockedBy: check.ok ? check.blockedBy : [] };
    const held = holdGateFrom(check);
    if (held) {
      add('merge-hold', held.reason);
      if (held.error === 'queued-behind') {
        for (const b of blockers) {
          if (b.kind === 'behind-base') b.detail = 'the PR is behind its base, but do NOT update the branch while another PR\'s merge hold is ahead (see the merge-hold blocker)';
          // The pr-open live check carries the same advice ("behind-base: ...; update the branch from <base> and re-verify before merging").
          else if (b.kind === 'live-check') b.detail = b.detail.replace(/; update the branch from \S+ and re-verify before merging/g, '; do NOT update the branch while another PR\'s merge hold is ahead (see the merge-hold blocker)');
        }
      }
    }
  }

  let ownerStep = null;
  if (crashed) {
    // No owner step: the crashed scan is a blocker to fix first, not a merge to hand over.
  } else if (ownerRuns) {
    try {
      ownerStep = { kind: 'owner-runs', command: fill(config.merge.command, { pr: String(pr), sha: head }, { strict: true }) };
    } catch (err) {
      add('merge-command', String(err?.message ?? err).slice(0, 200));
    }
  } else if (flags !== null) {
    ownerStep = { kind: 'owner-approval-flags', reason: `${flags}: the owner must say "merge" for this exact head (then pass ${APPROVAL_FLAGS})` };
  } else {
    let lowRisk = false;
    try {
      lowRisk = !ownerGo && loadState(root, { cleanup: false })?.risk === 'low';
    } catch { /* an unreadable review state is not a low-risk one */ }
    // --owner-go: the live scan's digest, and for protected areas the Areas line to print right above the Head line (areas: that line, areaIds: the ids).
    if (!lowRisk) {
      const parts = requestParts({ head, items: live.ownerItems ?? 'none', repo: slug, areas: ownerGo ? live.areas : [], hold, rulings: ownerGo ? live.rulings : '' });
      ownerStep = { kind: 'say-merge', line: parts.line };
      // The block the owner must be shown above the Areas / Hold / Head lines (E11): only when something was dismissed, so an ordinary PR's output is unchanged.
      if (ownerGo && live.rulingCount > 0) ownerStep = { ...ownerStep, rulings: parts.rulings, rulingCount: live.rulingCount };
      if (ownerGo && live.areas.length > 0) ownerStep = { ...ownerStep, areas: parts.areas, areaIds: live.areas };
      // The hold the merge would lift (Rev-4 1, 2, 6): from the timeline EVENT (its id, the login that placed it, when) — never described as the owner's or the agent's.
      // `hold` is the block to print right above the Head line, `ready` the 🔀 line to end with; `parkNote` the agent-written park comment, only when it is at least as new as the hold.
      if (hold !== null) {
        const parkNote = parkNoteOf({ gh, pr, hold });
        ownerStep = { ...ownerStep, hold: parts.hold, holdInfo: hold, ready: readyLine([pr], { lift: true }), ...(parkNote ? { parkNote } : {}) };
      }
      // Behind its base but accepted (merge.behind_base: disjoint): the owner is told so in the request, above the Areas / Head lines.
      if (behind !== null) ownerStep = { ...ownerStep, behindNote: `behind ${config.default_branch} by ${behind.behindBy} commit(s); ${config.default_branch}'s ${behind.mainFiles} new file(s) touch none of this PR's files` };
    }
  }

  // For a repo with the hold keys: may this hand-off take the merge hold now? Only a say-merge / owner-runs ending whose blockers are none, or
  // only the ones that make it owner-runs (a hold ahead, an unreadable check or any other blocker disqualifies). The review skill reads this.
  if (holdsConfigured(config) && ownerStep !== null) {
    ownerStep = { ...ownerStep, holdEligible: ['say-merge', 'owner-runs'].includes(ownerStep.kind) && blockers.every((b) => handOffBlockers.has(b)) };
  }

  const wouldMerge = blockers.length === 0;
  return { exitCode: wouldMerge ? EXIT.OK : EXIT.FAILED, output: { ok: wouldMerge, dryRun: true, wouldMerge, mode: ownerGo ? 'owner-go' : 'gate', head, ...(ownerGo ? { behind } : {}), blockers, ownerStep, ...(holds ? { holds } : {}) } };
}
