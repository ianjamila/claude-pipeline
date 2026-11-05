// `pipeline merge --pr N`: the ONLY sanctioned agent merge path. It trusts nothing it did not just re-read: the gate
// file only names the head and patch that were approved (and must still match, and be fresh); everything else is
// re-proved LIVE, by running the whole final gate again immediately before the merge command, because a gate file is
// just JSON on disk and anyone can write one. Only then does it run the project's merge command with the approved head
// SHA (so a head that moved can never merge). It then waits for GitHub to say MERGED, re-checking the blockers on every
// poll; anything else ends with auto-merge disabled, because an unattended queued merge could land later on a base nobody
// verified against.
import { EXIT, UsageError, parseCommandArgs, intOption } from '../lib/cli.mjs';
import { fill } from '../lib/config.mjs';
import { guarded, requireConfig, resolveRepo } from '../lib/cmd-common.mjs';
import { createGitHub, guardGh } from '../lib/github.mjs';
import { headSha } from '../lib/git.mjs';
import { envWithGhDir, runShellAsync } from '../lib/proc.mjs';
import { postEvent } from '../lib/run-events.mjs';
import { proofLine } from '../lib/run-record.mjs';
import { readSummaryComment } from '../lib/summary-comment.mjs';
import { createRunRecorder, inFlightSince } from '../lib/run-progress.mjs';
import { bringUpToDate, updateTiming } from '../lib/updatebranch.mjs';
import { loadState } from '../lib/state.mjs';
import { approvalConfigDirHint, approvalGap } from '../hooks/lib/owner-go.mjs';
import {
  GATE_FILE, PR_FIELDS, abandonMerge, evaluateGate, evaluateOwnerGo, gateRefusals, localContentHash, mergeTiming, preMergeProblems, readReviewJson,
  waitBlockers, waitForMerge,
} from '../lib/finalgate.mjs';
import { tailLines } from '../lib/cmd-io.mjs';

export const meta = {
  summary: 'merge the PR if (and only if) the final gate passes again, live; waits for MERGED',
  usage: 'pipeline merge --pr N [--owner-approved-head SHA --owner-approved-items DIGEST | --owner-go] [--repo DIR]   -> {ok, merged, mergeSha, warning?, warnings?} ; pipeline merge --pr N --dry-run [--owner-go] [--repo DIR]   -> {ok, dryRun:true, wouldMerge, blockers:[{kind, detail}], ownerStep} : the verdict without merging or writing anything (see --dry-run below) ; --owner-go (work that never ran the review skill: no final-gate.json) merges the local HEAD when the owner-go hook recorded the owner\'s "merge" for this PR, that head and items none, the PR is open, not a draft, MERGEABLE, not behind its base, without a blocking label, every required check is green on that head and the diff has no hard-stop or test-integrity item (error owner-go / live-check / pre-merge otherwise; output mode owner-go, nothing written); exit 0 merged (mergeSha:null + warning when GitHub cannot name the merge commit), 1 not merged / refused (error: gate|behind-base|live-check|pre-merge; behind-base = the base moved: the branch was updated (or the update failed, see outcome), re-verify and run final-gate again), 3 GitHub unavailable. While it runs the run record of the PR shows inFlight {kind: merge} and step merge; for a repo with verify.deferrable_steps the proofs of the live gate (where each deferrable step was proved: the Mac, or a GitHub run and attempt) are recorded in the run record and in an append-only ci-proof-used event comment before the merge command, and when either write fails nothing is merged (error pre-merge); warnings lists a run record write that failed (never fatal). A run record marked resumed (`P checkpoint --resumed`: a run taken over by ship resume) refuses with error pre-merge unless the owner approved it; so does a run record that cannot be checked (unreadable, invalid or unsupported: it may be a resumed one), and with owner_approval: chat a gate with ownerMerge > 0. Approved = --owner-approved-head names the full gate head, --owner-approved-items the gate\'s ownerItems, AND the owner-go hook recorded the owner\'s \"merge\" for exactly that PR, head and item set (the flags alone refuse); the live gate must still show those ownerItems. --dry-run (an agent previewing the verdict; never run the repo\'s merge command for that) runs the same checks as the real run (gate file, resumed-run guard, ownerMerge, behind base, the live gate, the --owner-go preconditions) and stops before anything that writes or merges: it never updates the branch (behind-ness is read from GitHub: mergeStateStatus BEHIND, or the compare API showing the head lacks the base tip; blocker behind-base; UNKNOWN / DIRTY or a compare error: behind-base-unverified), writes no run record, event, label, comment or file, and changes no git state (no fetch: for a repo with verify.deferrable_steps the base proof settings are read from the GitHub contents API at the PR\'s baseRefOid, which must exist locally, else blocker proof-settings-unverified). It collects every blocker it can find instead of stopping at the first, and names the owner step instead of refusing on it: ownerStep null (a low-risk review: P merges by itself) | {kind: say-merge, line} (the exact "Head … · items … · repo …" line, also for --owner-go) | {kind: owner-runs, command} (ownerMerge > 0 or a protected-area diff: the repo\'s merge.command filled with PR and head, which the owner runs) | {kind: owner-approval-flags} (a resumed or unchecked run record). It grants nothing: the real run re-checks the owner\'s record. Exit 0 wouldMerge (given the owner\'s word where ownerStep says so), 1 blockers, 2 --dry-run with --owner-approved-head / --owner-approved-items, 3 GitHub unavailable',
};

const APPROVAL_FLAGS = "--owner-approved-head <full head> --owner-approved-items <the gate's ownerItems>";
const OWNER_MERGE_REASON = `the final gate left items for the owner (owner_approval: chat): the owner must say "merge" for this exact head and item set (then pass ${APPROVAL_FLAGS})`;

const refuse = (error, reasons, extra = {}) => ({
  exitCode: EXIT.FAILED,
  output: { ok: false, merged: false, error, reasons, message: error === 'gate' ? 'run final-gate again' : reasons.join('; '), ...extra },
});

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
    return guardGh(() => ownerGoMerge({ root, config, pr, gh, ctx }));
  }

  return guardGh(async () => {
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
        const gap = approvalGap({ repo: gh.repo().slug, pr, head: gate.head, items: gate.ownerItems });
        if (gap !== 'ok') approvalProblem = missingApproval(gap, `${gh.repo().slug} #${pr} head ${gate.head.slice(0, 12)} items ${gate.ownerItems}`, `show the request (Owner-merge approval in the review skill: \`Head ${gate.head.slice(0, 12)} · items ${gate.ownerItems} · repo ${gh.repo().slug}\`) and wait for the owner to type "merge"`, { repo: gh.repo().slug, pr, head: gate.head, items: gate.ownerItems });
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
    const synced = await bringUpToDate({ gh, pr, expectHead: gate.head, maxCycles: 1, waitChecks: false, ...updateTiming(ctx.env) });
    if (!synced.ok) {
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
      const ran = await runShellAsync(command, { cwd: root, env: envWithGhDir(ctx.env), timeoutMs: (config.merge.wait_minutes + 5) * 60_000 });
      const commandOutput = tailLines(`${ran.stdout}${ran.stderr ? `\n${ran.stderr}` : ''}`, 30);

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
        return merged(outcome.mergeSha, ran.code === 0 ? {} : { commandExitCode: ran.code, note: 'the merge command exited non-zero but the PR is MERGED' });
      }

      // Not merged: disarm auto-merge, then look again (it may have fired a moment before the disable).
      const abandoned = await abandonMerge({ gh, pr, cwd: root, env: ctx.env, pollMs });
      if (abandoned.merged) return merged(abandoned.mergeSha, { note: 'the PR merged while auto-merge was being disabled', autoMergeDisabled: abandoned.autoMergeDisabled });

      const { autoMergeDisabled } = abandoned;
      const failure = { merged: false, autoMergeDisabled, commandExitCode: ran.code, commandOutput };
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
  });
});

// `P merge --pr N --owner-go` (owner decision 2026-10-28): the merge route for work that never ran the review skill (no
// final-gate.json, no verify report, no review state). It merges only when ALL of these hold, read live:
//   * the owner-go recorder (hooks/lib/owner-go.mjs) holds the owner's "merge" for this PR, this exact head and the item set
//     `none` (the reply ended with `Head <sha12> · items none` and the 🔀 line) — the flag itself approves nothing;
//   * evaluateOwnerGo: open, not a draft, MERGEABLE, not behind its base, at the local HEAD, no blocking label, every
//     required check green on that head (guard statuses and Cross-model review only with their provenance), and no
//     hard-stop or test-integrity item in the diff (the agent writes `items none`: a diff with an owner item is gated);
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

async function ownerGoMerge({ root, config, pr, gh, ctx }) {
  // The owner's record first: it is local, and without it nothing else matters.
  const head = headSha({ cwd: root });
  const repo = gh.repo().slug;
  if (gh.repo().host !== 'github.com') {
    const reason = hostProblem(gh);
    return refuse('owner-go', [reason], { reason, head });
  }
  const gap = approvalGap({ repo, pr, head, items: 'none' });
  if (gap !== 'ok') {
    const reason = missingApproval(gap, `${repo} #${pr} head ${head.slice(0, 12)} items none`, `end the reply with \`Head ${head.slice(0, 12)} · items none · repo ${repo}\` and \`🔀 Ready to merge #${pr} — say "merge"\`, and wait for the owner to type "merge"`, { repo, pr, head, items: 'none' });
    return refuse('owner-go', [reason], { reason, head });
  }
  const live = await evaluateOwnerGo({ root, config, pr, gh, env: ctx.env });
  if (live.head !== head) return refuse('live-check', [`the worktree moved from ${head.slice(0, 12)} to ${String(live.head).slice(0, 12)} while checking`], { head });
  if (!live.ok) return refuse('live-check', live.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`), { head });

  // A.4: the scan was of GitHub's base and head as read by evaluateOwnerGo; the last look re-reads both and refuses if either moved since.
  const late = await preMergeProblems({ gh, pr, head, base: live.baseRefOid });
  if (late.length > 0) return refuse('pre-merge', late, { head });

  const { waitMs, pollMs } = mergeTiming(config, ctx.env ?? process.env);
  const command = fill(config.merge.command, { pr: String(pr), sha: head }, { strict: true });
  const ran = await runShellAsync(command, { cwd: root, env: envWithGhDir(ctx.env), timeoutMs: (config.merge.wait_minutes + 5) * 60_000 });
  const commandOutput = tailLines(`${ran.stdout}${ran.stderr ? `\n${ran.stderr}` : ''}`, 30);
  const merged = (mergeSha, extra = {}) => ({
    exitCode: EXIT.OK,
    output: mergeSha
      ? { ok: true, merged: true, mode: 'owner-go', head, mergeSha, ...extra }
      : { ok: true, merged: true, mode: 'owner-go', head, mergeSha: null, warning: 'the PR is MERGED but GitHub did not report its merge commit after re-reading', ...extra },
  });
  const outcome = await waitForMerge({ gh, pr, waitMs: ran.code === 0 ? waitMs : 0, pollMs, blockers: waitBlockers(gh) });
  if (outcome.state === 'merged') return merged(outcome.mergeSha, ran.code === 0 ? {} : { commandExitCode: ran.code, note: 'the merge command exited non-zero but the PR is MERGED' });
  const abandoned = await abandonMerge({ gh, pr, cwd: root, env: ctx.env, pollMs });
  if (abandoned.merged) return merged(abandoned.mergeSha, { note: 'the PR merged while auto-merge was being disabled', autoMergeDisabled: abandoned.autoMergeDisabled });
  const failure = { merged: false, mode: 'owner-go', head, autoMergeDisabled: abandoned.autoMergeDisabled, commandExitCode: ran.code, commandOutput };
  if (ran.code !== 0) return { exitCode: EXIT.FAILED, output: { ok: false, reason: `merge command failed (exit ${ran.code}${ran.timedOut ? ', timed out' : ''}) and the PR is not merged`, ...failure } };
  const base = {
    timeout: 'not merged in time', closed: 'the PR was closed without merging', error: `could not read the PR state while waiting (${outcome.error})`,
    blocked: `a blocker appeared while waiting: ${(outcome.problems ?? []).join('; ')}`,
  }[outcome.state];
  const tail = abandoned.autoMergeDisabled ? 'auto-merge disabled' : 'could not confirm auto-merge is disabled: check the PR by hand';
  return { exitCode: EXIT.FAILED, output: { ok: false, reason: `${base} — ${tail}`, ...failure } };
}

// `P merge --pr N --dry-run [--owner-go]`: the verdict of a real `P merge` without anything that writes or merges. Same checks, in the same
// spirit, but every independent one is collected (an agent wants the whole list at once) and the owner's step is reported instead of
// refused on. Read-only means: no bringUpToDate (the branch is not touched; behind-ness is read), no run record / inFlight / ci-proof-used
// event, no label or comment, no merge command, no file written, and no shared git state changed (evaluateGate readOnly: no `git fetch`).
// It grants nothing: the owner's recorded "merge" is checked by the real run.
const READABLE_MERGE_STATES = new Set(['CLEAN', 'HAS_HOOKS', 'UNSTABLE', 'BLOCKED']);

// Behind-ness without the update: GitHub's own mergeStateStatus, then the compare API. Never "not behind" by default.
function readBehind(gh, pr) {
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
    if (cmp.behindBy > 0) return [{ kind: 'behind-base', detail: `the PR head lacks ${cmp.behindBy} commit(s) of ${view.baseRefName} (compare API): update the branch (P update-branch), re-verify and run final-gate again` }];
  } catch (err) {
    return [{ kind: 'behind-base-unverified', detail: `could not compare the head with its base (${String(err?.message ?? err).slice(0, 200)})` }];
  }
  return out;
}

async function dryRunMerge({ root, config, pr, gh, ctx, ownerGo }) {
  const blockers = [];
  const add = (kind, detail) => blockers.push({ kind, detail });
  const slug = gh.repo().slug;
  const head = headSha({ cwd: root });
  let gate = null;
  let live;
  let ownerRuns = false;
  let flags = null;

  if (ownerGo) {
    if (gh.repo().host !== 'github.com') add('owner-go', hostProblem(gh));
    live = await evaluateOwnerGo({ root, config, pr, gh, env: ctx.env });
    if (live.head !== head) add('live-check', `the worktree moved from ${head.slice(0, 12)} to ${String(live.head).slice(0, 12)} while checking`);
    for (const c of live.checks.filter((x) => !x.ok)) add('live-check', `${c.name}: ${c.detail}`);
    ownerRuns = live.checks.some((c) => c.name === 'owner-items' && !c.ok);
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
    ownerRuns = Number(live.ownerMerge) > 0 || Number(gate?.ownerMerge) > 0;
  }

  for (const b of readBehind(gh, pr)) add(b.kind, b.detail);
  for (const reason of await preMergeProblems({ gh, pr, head, base: ownerGo ? live.baseRefOid : null })) add('pre-merge', reason);

  let ownerStep = null;
  if (ownerRuns) {
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
    if (!lowRisk) ownerStep = { kind: 'say-merge', line: `Head ${head.slice(0, 12)} · items ${ownerGo ? 'none' : (live.ownerItems ?? 'none')} · repo ${slug}` };
  }

  const wouldMerge = blockers.length === 0;
  return { exitCode: wouldMerge ? EXIT.OK : EXIT.FAILED, output: { ok: wouldMerge, dryRun: true, wouldMerge, mode: ownerGo ? 'owner-go' : 'gate', head, blockers, ownerStep } };
}
