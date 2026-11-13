// `pipeline redraft --pr N [--reason CODE] [--before-push] [--repo DIR]`: "I am about to push a code fix to this PR; take it out of the hand-off" (plan
// 2026-11-12-redraft-fix-rounds). It releases the PR's own merge hold (repos with merge.hold_* keys) and, for a repo that sets
// ci.draft_while_iterating, turns a READY PR back to draft so the heavy CI workflows (which skip drafts and cancel a running suite on
// `converted_to_draft`) stay quiet during the fix pushes; the review's "mark ready" step then runs CI once on the reviewed head. It never
// pushes, never merges, never moves the head, and refuses (nothing changed) while a merge of the PR is under way.
import { EXIT, UsageError, parseCommandArgs, intOption } from '../lib/cli.mjs';
import { Fail, requireConfig, resolveRepo, guarded } from '../lib/cmd-common.mjs';
import { createGitHub } from '../lib/github.mjs';
import { GhError } from '../lib/proc.mjs';
import { withMergeLock } from '../lib/hold.mjs';
import { disableAutoMerge } from '../lib/finalgate.mjs';
import { QueueRecordUnreadable, QueueUnreadable, queueModeFor, readQueueRecord } from '../lib/merge-queue.mjs';
import { RELEASE_REASONS, holdsConfigured, ownSuccessor, releaseHold, unreleasedWarning } from '../lib/merge-hold.mjs';
import { GitError, currentBranch, headSha, isAncestor } from '../lib/git.mjs';
import { APPROVAL_LABELS } from '../lib/guard-provenance.mjs';

const DEFAULT_REASON = 'redraft';
const REASON_CODES = Object.keys(RELEASE_REASONS);
// A mutation failure that is the network or GitHub being down is "unavailable" (exit 3); anything else the mutation answered is a refusal (convert-failed).
// Matched against gh's STDERR only: the error message also carries the gh arguments (a repo named `network`) and GitHub's own refusals ('Could not resolve to a node').
const UNREACHABLE = /HTTP 5\d\d|timed? ?out|rate limit|could not resolve host|connection|network|EOF|ECONN|ETIMEDOUT/i;
// After a convert error the PR is read again (reconcile): up to RECONCILE_READS times, RECONCILE_PAUSE_MS apart (a definite rejection is read once).
// A hold release that was not confirmed is run once more after HOLD_RETRY_PAUSE_MS. PIPELINE_REDRAFT_PAUSE_MS can only SHORTEN both pauses (tests).
const RECONCILE_READS = 3;
const RECONCILE_PAUSE_MS = 2000;
const HOLD_RETRY_PAUSE_MS = 3000;
const RECONCILE_FIELDS = ['number', 'state', 'isDraft', 'headRefOid', 'autoMergeRequest'];
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pauseOf = (env, ms) => {
  const n = Number(env?.PIPELINE_REDRAFT_PAUSE_MS);
  return Number.isInteger(n) && n >= 0 && n < ms ? n : ms;
};
const armedOf = (view) => view?.autoMergeRequest !== null && view?.autoMergeRequest !== undefined;

export const meta = {
  summary: 'before a fix push to a READY PR: release its merge hold and (ci.draft_while_iterating) turn it back to draft so CI waits for the re-ready',
  usage: `pipeline redraft --pr N [--reason <${REASON_CODES.join('|')}>=redraft] [--before-push] [--repo DIR]   -> {ok, pr, head, wasDraft, draft, changed, outcome?, skipped?, holdRelease?, autoMergeDisabled?, approvalVoided?, beforePushUnchecked?, warnings:[]} (exit 1 and 3 refusals also carry reason / outcome, and stage: read | convert when GitHub could not answer) : run it right BEFORE you push a code fix to a ready PR (a fix, a settle test, an owner-override build, a conflict resolution, a change the owner asked for); never pushes or merges and never moves the head. --before-push (optional): refuse with exit 1, reason nothing-to-push (nothing released or changed), when this checkout's HEAD is the PR head or an ancestor of it (there is nothing new to push: commit first, then run it, then push); a diverged HEAD (rebase, amend) or a descendant proceeds, and when the checked-out branch is not the PR's branch (or the commits cannot be compared) the check is skipped with beforePushUnchecked:true and a warnings line. Do NOT use it for a push that already went out (local HEAD equals the PR head then): run plain \`pipeline redraft --pr N\` right after it. Steps (1-4 run holding this PR's local merge lock, the one \`pipeline merge\` takes, so a merge cannot start in the middle of them): (1) read the PR and its merge-queue state; (2) refuse (exit 1, nothing changed) when the PR is not OPEN (reason not-open) or a merge of it is under way (reason merge-in-progress: a merge-queue entry, armed auto-merge on a READY PR, a running local \`pipeline merge\` or a live local queue record, or the merge lock held by another run: do NOT push, tell the owner); (3) for a repo with the merge.hold_* keys, release the PR\'s own merge hold with --reason (default redraft; the same fixed codes as \`merge-hold --release\`), for a draft PR too (a hold left by an earlier release that was not confirmed would otherwise come back to life at the next ready) except a draft whose head is the pipeline\'s own update-branch successor (the hold is kept); holdRelease {reason, confirmed, attempts, code, lines, notStarted?}: a release that is not confirmed is run once more after 3 s (attempts 2), and one still not confirmed is exit 0 with a warnings line naming the manual release; (4) only when ci.draft_while_iterating is true and the PR is ready, convert it to draft with one GraphQL mutation (outcome converted, changed:true, draft:true); before it, a ready PR with a human-approved / test-change-approved label applied after its last head change gets approvalVoided:true and a warnings line (the approval is per head and will not survive the fix push: re-apply the label after the PR is ready again; only with ci.guard_checks, one timeline read, an unreadable timeline is a warning only); a repo whose CI runs on drafts (draft_while_iterating false) gets skipped:'draft-not-iterating' and no conversion; a PR that is already a draft is changed:false, outcome already-draft, and auto-merge still armed on it (left from before the conversion: GitHub does not allow arming it on a draft) is disabled like the case below. Auto-merge found armed by the mutation (or on the draft) is disabled (autoMergeDisabled) and the output carries a warnings line saying the merge was cancelled (or auto-merge could not be disabled, autoMergeDisabled false: it is still armed, so ask the owner to run \`gh pr merge N --disable-auto\`, confirm it is off, and wait for their word before any push or ready): the PR is a draft, but do NOT push yet, tell the owner: exit 0 with autoMergeDisabled present (true or false) is the machine signal for this, absent in every other success. A mutation whose answer was lost (timeout, output cut off, GitHub unreachable, or a code-0 answer without a pull request) may still have landed, so the PR is read again up to 3 times, 2 s apart, and the \`outcome\` says what was found: reconciled-converted (exit 0, draft with the same head and nothing else going on: push), merge-in-progress (exit 1: a merge-queue entry, or auto-merge armed on a ready PR), head-moved (exit 1: the head changed since step 1), not-open (exit 1), convert-unconfirmed (exit 3 stage convert: still ready after 3 reads and the mutation may yet land: do NOT push, run \`pipeline redraft --pr N\` again), unknown (exit 3 stage convert: the re-read failed: do NOT push, run it again). convert-failed (exit 1, stage convert) is only a proven rejection (GitHub answered with an error or with a PR that is not a draft, and a fresh read shows the PR open, still ready, the head unchanged, no merge-queue entry, no armed auto-merge): the only case where pushing anyway is allowed. Exit 0 done or nothing to do, 1 refused (not-open, merge-in-progress, nothing-to-push, head-moved) or the conversion was rejected (convert-failed; the hold release, if any, has already run and is reported), 2 usage error (unknown --reason), 3 GitHub unavailable (stage read: a read failed or the merge queue state was unreadable, so the merge-in-progress check could not run: do NOT push, retry once, then tell the owner; stage convert: the mutation could not be confirmed, see outcome convert-unconfirmed / unknown: do NOT push). Mark the PR ready again with \`gh pr ready\` once review is complete (review-complete runs first)`,
};

export const run = guarded(async (argv, ctx) => {
  const { values } = parseCommandArgs(argv, { pr: { type: 'string' }, reason: { type: 'string' }, 'before-push': { type: 'boolean' }, repo: { type: 'string' } }, { allowPositionals: false });
  const pr = intOption(values, 'pr', { required: true, min: 1 });
  const reason = values.reason ?? DEFAULT_REASON;
  if (!REASON_CODES.includes(reason)) throw new UsageError(`--reason must be one of ${REASON_CODES.join(', ')}`);
  const beforePush = values['before-push'] === true;
  const root = resolveRepo(values, ctx);
  const { config } = await requireConfig(root);
  const env = ctx.env;
  const gh = createGitHub({ cwd: root, env });
  const unavailable = (message, stage, extra = {}) => new Fail(EXIT.UNAVAILABLE, { ok: false, pr, ...extra, unavailable: true, error: 'unavailable', stage, message });
  const refuse = (why, message, extra = {}) => new Fail(EXIT.FAILED, { ok: false, pr, reason: why, message, ...extra });

  // Steps 1-4 run holding the PR's local merge lock (the one `pipeline merge` and the queue sweep take): without it a merge could start while the hold release
  // (up to five minutes) or the conversion is under way, and redraft would then draft the PR or disarm auto-merge in the middle of that merge. The lock also covers a
  // live merge child of an earlier run, so there is no separate peek. Residual (not closed here): once redraft returns the lock is gone, so for a repo that does not
  // convert to draft (nothing to re-read afterwards) a merge started between redraft and the caller's `git push` is not seen; the caller pushes right after.
  const mergeBusy = (error, reasons, extra = {}) => ({
    exitCode: EXIT.FAILED,
    output: { ok: false, pr, reason: 'merge-in-progress', message: `${reasons.join('; ')}; a merge (or another redraft) of #${pr} may be under way, so do NOT push; tell the owner`, reasons, ...extra },
  });
  return withMergeLock({ gh, pr, env: ctx.env ?? process.env, refuse: mergeBusy, fn: () => redraftLocked({ pr, reason, beforePush, root, config, env, gh, ctx, unavailable, refuse }) }).catch((err) => {
    // gh.repo() (the lock's name) failed before the lock existed: same as an unreadable step-1 read.
    if (err instanceof GhError) throw unavailable(String(err.message).split('\n')[0], 'read');
    throw err;
  });
});

// Auto-merge found armed on the PR (after the conversion, or on a draft): disarm it and say so. Either way the owner's merge is cancelled or still live, so the
// output always carries it (exit stays 0: the PR is a draft). `leftover`: the PR was already a draft when redraft read it, so the arming predates the conversion.
function settleArmed({ pr, root, env, result, warnings, leftover = false }) {
  result.autoMergeDisabled = disableAutoMerge({ pr, cwd: root, env });
  const what = leftover
    ? `auto-merge was still armed on PR #${pr}, which is a draft (a merge started before it went back to draft)`
    : `a merge of PR #${pr} was started while redraft ran (auto-merge was armed)`;
  const draft = leftover ? 'is a draft' : 'is now a draft';
  warnings.push(result.autoMergeDisabled
    ? `${what} and has been cancelled; the PR ${draft}: do NOT push yet, tell the owner their merge was cancelled`
    : `${what} and auto-merge could not be disabled: ask the owner to run \`gh pr merge ${pr} --disable-auto\`, confirm it is off, and wait for their word before any push or ready; the PR ${draft}: do NOT push yet, tell the owner their merge was started and not cancelled`);
}

// Was the mutation's failure an answer from GitHub (a definite rejection) rather than a lost reply? A non-zero gh exit that is not the network or GitHub being down,
// or a GraphQL `errors` body. A timeout, a cut-off output, an unreachable GitHub and the code-0 answer without a pull request are all "the mutation may have landed".
const definiteRejection = (err) => {
  const stderr = String(err.stderr ?? '');
  if (err.timedOut || err.overBuffer) return false;
  if (err.code === 0) return /^GraphQL error:/.test(stderr);
  return !UNREACHABLE.test(stderr);
};

// Reads the PR again after a convert that gave no usable answer and says what is true now. Up to `reads` reads, `pauseMs` apart (a read that fails is retried like
// one that still shows a ready PR). -> { outcome, view?, reasons?, message? } with outcome:
//   reconciled-converted  the PR is a draft with the head of step 1 and no queue entry (view.autoMergeRequest tells whether auto-merge is armed on it)
//   merge-in-progress     a merge-queue entry, or auto-merge armed on a still-ready PR
//   head-moved            the head is not the one redraft read in step 1
//   not-open              closed or merged
//   ready                 still open, ready, unchanged, nothing going on after every read (the mutation may still land, or it was rejected)
//   unknown               no read succeeded
async function reconcile({ gh, pr, headAtRead, sleep, reads, pauseMs }) {
  let last = null;
  let lastError = null;
  for (let i = 0; i < reads; i++) {
    if (i > 0) await sleep(pauseMs);
    let view;
    let queue;
    try {
      view = gh.prView(pr, RECONCILE_FIELDS);
      queue = queueModeFor({ gh, pr });
    } catch (err) {
      if (!(err instanceof GhError || err instanceof QueueUnreadable)) throw err;
      lastError = String(err.message).split('\n')[0];
      continue;
    }
    if (view.state !== 'OPEN') return { outcome: 'not-open', view, message: `PR #${pr} is ${String(view.state).toLowerCase()}, not open` };
    if (queue.state.inQueue) return { outcome: 'merge-in-progress', view, reasons: [`PR #${pr} is in the merge queue (position ${queue.state.entry.position})`] };
    if (view.headRefOid !== headAtRead) return { outcome: 'head-moved', view, message: `the head of PR #${pr} moved from ${String(headAtRead).slice(0, 12)} to ${String(view.headRefOid).slice(0, 12)} while redraft ran` };
    if (view.isDraft === true) return { outcome: 'reconciled-converted', view };
    if (armedOf(view)) return { outcome: 'merge-in-progress', view, reasons: [`auto-merge is armed on PR #${pr}`] };
    last = { outcome: 'ready', view };
  }
  return last ?? { outcome: 'unknown', message: lastError ?? 'the PR could not be read' };
}

// A labeled human-approved / test-change-approved event newer than the last head change: that approval is for the old head. The head changed at the newest
// `head_ref_force_pushed` event or at the committer date of the head commit's `committed` event. -> true | false; throws when the timeline cannot be read.
function approvalVoidedBy(timeline, head) {
  if (!Array.isArray(timeline)) throw new Error('the timeline reply is not a list');
  let headChanged = -Infinity;
  const newest = new Map();
  for (const e of timeline) {
    if (e === null || typeof e !== 'object') continue;
    if (e.event === 'head_ref_force_pushed') headChanged = Math.max(headChanged, Date.parse(e.created_at) || -Infinity);
    else if (e.event === 'committed' && e.sha === head) headChanged = Math.max(headChanged, Date.parse(e.committer?.date ?? e.author?.date) || -Infinity);
    else if ((e.event === 'labeled' || e.event === 'unlabeled') && APPROVAL_LABELS.includes(e.label?.name)) {
      const at = Date.parse(e.created_at);
      if (Number.isFinite(at) && at >= (newest.get(e.label.name)?.at ?? -Infinity)) newest.set(e.label.name, { at, kind: e.event });
    }
  }
  return [...newest.values()].some((x) => x.kind === 'labeled' && x.at > headChanged);
}

async function redraftLocked({ pr, reason, beforePush, root, config, env, gh, ctx, unavailable, refuse }) {
  const sleep = ctx.sleep ?? defaultSleep;
  // 1. Read everything first. Any failure (including an unreadable merge queue) fails closed: exit 3 stage 'read', nothing changed.
  let view;
  let queue;
  let record;
  let recordWhy = null;
  try {
    view = gh.prView(pr, [...RECONCILE_FIELDS, ...(beforePush ? ['headRefName'] : [])]);
    queue = queueModeFor({ gh, pr });
  } catch (err) {
    if (err instanceof GhError || err instanceof QueueUnreadable) throw unavailable(String(err.message).split('\n')[0], 'read');
    throw err;
  }
  try {
    record = readQueueRecord(root, pr);
  } catch (err) {
    if (!(err instanceof QueueRecordUnreadable)) throw err;
    record = null;
    recordWhy = err.message;
  }

  // 2. Refuse, nothing changed. (A running local merge was refused by the lock above.) Armed auto-merge on a DRAFT is no merge in progress: GitHub does not allow
  // arming it on a draft, so it is left from before the conversion (a lost reply, an earlier run) and step 4 disarms it.
  if (view.state !== 'OPEN') throw refuse('not-open', `PR #${pr} is ${String(view.state).toLowerCase()}, not open: nothing was changed. Do NOT push; tell the owner`);
  const wasDraft = view.isDraft === true;
  const underway = [];
  if (queue.state.inQueue) underway.push(`PR #${pr} is in the merge queue (position ${queue.state.entry.position})`);
  if (!wasDraft && armedOf(view)) underway.push(`auto-merge is armed on PR #${pr}`);
  if (record !== null && record.terminal === null) underway.push(`a merge-queue record for #${pr} is still live in this repository`);
  if (recordWhy !== null) underway.push(`the merge-queue record for #${pr} is unreadable (${recordWhy})`);
  if (underway.length > 0) {
    throw refuse('merge-in-progress', `${underway.join('; ')}: the owner's merge is under way, so do NOT push; tell the owner. Nothing was changed`, { reasons: underway });
  }

  const head = view.headRefOid;
  const warnings = [];
  const result = { pr, head, wasDraft };

  // --before-push: refuse only on positive proof that there is nothing new to push (local HEAD is the PR head or an ancestor of it).
  if (beforePush) {
    const unchecked = (why) => {
      result.beforePushUnchecked = true;
      warnings.push(`--before-push could not check for new commits (${why}): continuing without the check`);
    };
    let local = null;
    try {
      const branch = currentBranch({ cwd: root });
      if (branch !== view.headRefName) {
        unchecked(`this checkout is on ${branch === 'HEAD' ? 'a detached HEAD' : `branch ${branch}`}, not the PR's branch ${view.headRefName}`);
      } else {
        local = headSha({ cwd: root });
        if (isAncestor(local, head, { cwd: root })) {
          throw refuse('nothing-to-push', `this checkout's HEAD (${local.slice(0, 12)}) is the head of PR #${pr} or already part of it: there is nothing new to push, so nothing was released or changed. Commit the fix first, then run \`pipeline redraft --pr ${pr} --before-push\`, then push. (A push that already went out needs plain \`pipeline redraft --pr ${pr}\`)`);
        }
      }
    } catch (err) {
      if (err instanceof Fail) throw err;
      if (!(err instanceof GitError)) throw err;
      unchecked(`the commits could not be compared: ${String(err.message).split('\n')[0].slice(0, 160)}`);
    }
  }

  // An approval label is per head: the fix push this redraft precedes voids it. Only for a ready PR about to be converted, only with guard checks; a timeline that cannot be read is a warning only.
  const converting = !wasDraft && config.ci.draft_while_iterating === true;
  if (converting && config.ci.guard_checks === true) {
    try {
      if (approvalVoidedBy(gh.timelineOf(pr), head)) {
        result.approvalVoided = true;
        warnings.push(`an approval label (${APPROVAL_LABELS.join(' / ')}) on this head will not survive the fix push; re-apply the label after the PR is ready again`);
      }
    } catch (err) {
      warnings.push(`the PR timeline could not be read, so an approval label on this head was not checked (${String(err?.message ?? err).split('\n')[0].slice(0, 160)}): any approval is per head and will not survive the fix push`);
    }
  }

  // 3. The merge hold. Before the conversion: if that fails, the PR has still left the merge line (the safe side). A draft whose head is the pipeline's
  // own catch-up successor keeps the hold it took for that catch-up. A release that is not confirmed is run once more after a short pause.
  if (holdsConfigured(config) && !(wasDraft && typeof head === 'string' && ownSuccessor({ root, pr, head, gh }))) {
    let rel = await releaseHold({ config, pr, reason, root, env, run: ctx.runHold });
    let attempts = 1;
    if (rel.configured && rel.confirmed !== true) {
      await sleep(pauseOf(env, HOLD_RETRY_PAUSE_MS));
      rel = await releaseHold({ config, pr, reason, root, env, run: ctx.runHold });
      attempts = 2;
    }
    if (rel.configured) {
      result.holdRelease = { reason, confirmed: rel.confirmed === true, attempts, code: rel.code ?? null, lines: rel.lines ?? [], ...(rel.notStarted ? { notStarted: true } : {}) };
      if (!result.holdRelease.confirmed) {
        warnings.push(unreleasedWarning({ pr, reason, code: result.holdRelease.code, notStarted: result.holdRelease.notStarted === true, takeConfirmed: true, again: attempts > 1 }));
      }
    }
  }

  // 4. The conversion: only for a repo whose CI skips drafts, and only a ready PR.
  if (wasDraft) {
    if (armedOf(view)) settleArmed({ pr, root, env, result, warnings, leftover: true });
    return { exitCode: EXIT.OK, output: { ok: true, ...result, draft: true, changed: false, outcome: 'already-draft', warnings } };
  }
  if (!converting) {
    return { exitCode: EXIT.OK, output: { ok: true, ...result, draft: false, changed: false, skipped: 'draft-not-iterating', warnings } };
  }
  let converted;
  let failure = null;
  try {
    converted = gh.convertToDraft(pr);
    if (converted.isDraft !== true) failure = { definite: true, message: `GitHub did not report PR #${pr} as a draft after the conversion` };
  } catch (err) {
    if (!(err instanceof GhError)) throw err;
    failure = { definite: definiteRejection(err), message: String(err.message).split('\n')[0] };
  }
  if (failure !== null) return afterFailedConvert({ pr, root, env, gh, sleep, head, result, warnings, failure, unavailable });

  // Auto-merge armed between the read and the conversion means a merge of the PR was started while redraft ran, outside this machine's merge lock (the owner's
  // own terminal, another machine, the GitHub UI). A draft cannot merge, but an armed request would fire at the next ready, so disarm it; either way the owner's
  // merge is cancelled, so say so (exit stays 0: the PR is a draft). The same owner action before the step-1 read is the merge-in-progress refusal.
  if (converted.autoMergeArmed) settleArmed({ pr, root, env, result, warnings });

  // 5. Done.
  return { exitCode: EXIT.OK, output: { ok: true, ...result, draft: true, changed: true, outcome: 'converted', warnings } };
}

// The mutation gave no usable answer, or GitHub answered that it did not convert: read the PR again before anything is said about pushing.
async function afterFailedConvert({ pr, root, env, gh, sleep, head, result, warnings, failure, unavailable }) {
  const rec = await reconcile({ gh, pr, headAtRead: head, sleep, reads: failure.definite ? 1 : RECONCILE_READS, pauseMs: pauseOf(env, RECONCILE_PAUSE_MS) });
  const shown = { ok: false, ...result, outcome: rec.outcome, draft: rec.view?.isDraft === true, changed: rec.view?.isDraft === true, warnings };
  switch (rec.outcome) {
    case 'reconciled-converted': {
      // The answer was lost (or wrong) but the PR is a draft with the head of step 1: the conversion landed.
      const ok = { ...result, draft: true, changed: true, outcome: 'reconciled-converted' };
      if (armedOf(rec.view)) settleArmed({ pr, root, env, result: ok, warnings });
      return { exitCode: EXIT.OK, output: { ok: true, ...ok, warnings } };
    }
    case 'not-open':
      throw new Fail(EXIT.FAILED, { ...shown, reason: 'not-open', message: `${rec.message} (seen after the conversion failed): nothing more was changed. Do NOT push; tell the owner` });
    case 'merge-in-progress':
      throw new Fail(EXIT.FAILED, { ...shown, reason: 'merge-in-progress', reasons: rec.reasons, message: `${rec.reasons.join('; ')} (seen after the conversion failed): the owner's merge is under way, so do NOT push; tell the owner` });
    case 'head-moved':
      throw new Fail(EXIT.FAILED, { ...shown, reason: 'head-moved', message: `${rec.message}: do NOT push; find out who moved it, then run \`pipeline redraft --pr ${pr}\` again on the new head` });
    case 'ready':
      if (failure.definite) {
        // The only way to "push anyway": GitHub refused, and a fresh read shows an open, ready PR on the same head with no queue entry and no armed auto-merge.
        throw new Fail(EXIT.FAILED, { ...shown, outcome: 'convert-failed', reason: 'convert-failed', stage: 'convert', message: `PR #${pr} could not be turned back to draft: ${failure.message}` });
      }
      throw unavailable(`${failure.message}; the PR is still ready after ${RECONCILE_READS} reads but the conversion may still land: do NOT push, run \`pipeline redraft --pr ${pr}\` again`, 'convert', { ...result, outcome: 'convert-unconfirmed', draft: false, changed: false, warnings });
    default:
      throw unavailable(`${failure.message}; the PR could not be read again (${rec.message}), so it is not known whether it is a draft: do NOT push, run \`pipeline redraft --pr ${pr}\` again`, 'convert', { ...result, outcome: 'unknown', draft: false, changed: false, warnings });
  }
}
