// `pipeline redraft --pr N [--reason CODE] [--repo DIR]`: "I am about to push a code fix to this PR; take it out of the hand-off" (plan
// 2026-11-12-redraft-fix-rounds). It releases the PR's own merge hold (repos with merge.hold_* keys) and, for a repo that sets
// ci.draft_while_iterating, turns a READY PR back to draft so the heavy CI workflows (which skip drafts and cancel a running suite on
// `converted_to_draft`) stay quiet during the fix pushes; the review's "mark ready" step then runs CI once on the reviewed head. It never
// pushes, never merges, never moves the head, and refuses (nothing changed) while a merge of the PR is under way.
import { EXIT, UsageError, parseCommandArgs, intOption } from '../lib/cli.mjs';
import { Fail, requireConfig, resolveRepo, guarded } from '../lib/cmd-common.mjs';
import { createGitHub } from '../lib/github.mjs';
import { GhError } from '../lib/proc.mjs';
import { mergeInProgress } from '../lib/hold.mjs';
import { disableAutoMerge } from '../lib/finalgate.mjs';
import { QueueRecordUnreadable, QueueUnreadable, queueModeFor, readQueueRecord } from '../lib/merge-queue.mjs';
import { RELEASE_REASONS, holdsConfigured, ownSuccessor, releaseHold, unreleasedWarning } from '../lib/merge-hold.mjs';

const DEFAULT_REASON = 'redraft';
const REASON_CODES = Object.keys(RELEASE_REASONS);
// A mutation failure that is the network or GitHub being down is "unavailable" (exit 3); anything else the mutation answered is a refusal (convert-failed).
const UNREACHABLE = /HTTP 5\d\d|timed? ?out|rate limit|could not resolve|connection|network|EOF|ECONN|ETIMEDOUT/i;

export const meta = {
  summary: 'before a fix push to a READY PR: release its merge hold and (ci.draft_while_iterating) turn it back to draft so CI waits for the re-ready',
  usage: `pipeline redraft --pr N [--reason <${REASON_CODES.join('|')}>=redraft] [--repo DIR]   -> {ok, pr, head, wasDraft, draft, changed, skipped?, holdRelease?, autoMergeDisabled?, warnings:[]} : run it right BEFORE you push a code fix to a ready PR (a fix, a settle test, an owner-override build, a conflict resolution, a change the owner asked for); never pushes or merges and never moves the head. Steps: (1) read the PR and its merge-queue state; (2) refuse (exit 1, nothing changed) when the PR is not OPEN (reason not-open) or a merge of it is under way (reason merge-in-progress: a merge-queue entry, armed auto-merge, a running local \`pipeline merge\` or a live local queue record: do NOT push, tell the owner); (3) for a repo with the merge.hold_* keys, release the PR\'s own merge hold with --reason (default redraft; the same fixed codes as \`merge-hold --release\`), for a draft PR too (a hold left by an earlier release that was not confirmed would otherwise come back to life at the next ready) except a draft whose head is the pipeline\'s own update-branch successor (the hold is kept); holdRelease {reason, confirmed, code, lines, notStarted?}, and a release that is NOT confirmed is exit 0 with a warnings line naming the manual release; (4) only when ci.draft_while_iterating is true and the PR is ready, convert it to draft with one GraphQL mutation (changed:true, draft:true); a repo whose CI runs on drafts (draft_while_iterating false) gets skipped:'draft-not-iterating' and no conversion, a draft PR changed:false; auto-merge found armed by the mutation is disabled (autoMergeDisabled). Exit 0 done or nothing to do, 1 refused (not-open, merge-in-progress) or the conversion failed (convert-failed; the hold release, if any, has already run and is reported), 2 usage error (unknown --reason), 3 GitHub unavailable (a read failed, the merge queue state was unreadable, or the mutation could not reach GitHub: nothing was changed by that step). Mark the PR ready again with \`gh pr ready\` once review is complete (review-complete runs first)`,
};

export const run = guarded(async (argv, ctx) => {
  const { values } = parseCommandArgs(argv, { pr: { type: 'string' }, reason: { type: 'string' }, repo: { type: 'string' } }, { allowPositionals: false });
  const pr = intOption(values, 'pr', { required: true, min: 1 });
  const reason = values.reason ?? DEFAULT_REASON;
  if (!REASON_CODES.includes(reason)) throw new UsageError(`--reason must be one of ${REASON_CODES.join(', ')}`);
  const root = resolveRepo(values, ctx);
  const { config } = await requireConfig(root);
  const env = ctx.env;
  const gh = createGitHub({ cwd: root, env });
  const unavailable = (message) => new Fail(EXIT.UNAVAILABLE, { ok: false, pr, unavailable: true, error: 'unavailable', message });
  const refuse = (why, message, extra = {}) => new Fail(EXIT.FAILED, { ok: false, pr, reason: why, message, ...extra });

  // 1. Read everything first. Any failure (including an unreadable merge queue) fails closed: exit 3, nothing changed.
  let view;
  let queue;
  let mergeLocal;
  let record;
  let recordWhy = null;
  try {
    view = gh.prView(pr, ['number', 'state', 'isDraft', 'headRefOid', 'autoMergeRequest']);
    queue = queueModeFor({ gh, pr });
    mergeLocal = mergeInProgress({ gh, pr, env });
  } catch (err) {
    if (err instanceof GhError || err instanceof QueueUnreadable) throw unavailable(String(err.message).split('\n')[0]);
    throw err;
  }
  try {
    record = readQueueRecord(root, pr);
  } catch (err) {
    if (!(err instanceof QueueRecordUnreadable)) throw err;
    record = null;
    recordWhy = err.message;
  }

  // 2. Refuse, nothing changed.
  if (view.state !== 'OPEN') throw refuse('not-open', `PR #${pr} is ${String(view.state).toLowerCase()}, not open: nothing was changed`);
  const underway = [];
  if (queue.state.inQueue) underway.push(`PR #${pr} is in the merge queue (position ${queue.state.entry.position})`);
  if (view.autoMergeRequest !== null && view.autoMergeRequest !== undefined) underway.push(`auto-merge is armed on PR #${pr}`);
  if (mergeLocal) underway.push(mergeLocal.why);
  if (record !== null && record.terminal === null) underway.push(`a merge-queue record for #${pr} is still live in this repository`);
  if (recordWhy !== null) underway.push(`the merge-queue record for #${pr} is unreadable (${recordWhy})`);
  if (underway.length > 0) {
    throw refuse('merge-in-progress', `${underway.join('; ')}: the owner's merge is under way, so do NOT push; tell the owner. Nothing was changed`, { reasons: underway });
  }

  const head = view.headRefOid;
  const wasDraft = view.isDraft === true;
  const warnings = [];
  const result = { pr, head, wasDraft };

  // 3. The merge hold. Before the conversion: if that fails, the PR has still left the merge line (the safe side). A draft whose head is the pipeline's
  // own catch-up successor keeps the hold it took for that catch-up.
  if (holdsConfigured(config) && !(wasDraft && typeof head === 'string' && ownSuccessor({ root, pr, head, gh }))) {
    const rel = await releaseHold({ config, pr, reason, root, env, run: ctx.runHold });
    if (rel.configured) {
      result.holdRelease = { reason, confirmed: rel.confirmed === true, code: rel.code ?? null, lines: rel.lines ?? [], ...(rel.notStarted ? { notStarted: true } : {}) };
      if (!result.holdRelease.confirmed) {
        warnings.push(unreleasedWarning({ pr, reason, code: result.holdRelease.code, notStarted: result.holdRelease.notStarted === true, takeConfirmed: true }));
      }
    }
  }

  // 4. The conversion: only for a repo whose CI skips drafts, and only a ready PR.
  if (wasDraft) return { exitCode: EXIT.OK, output: { ok: true, ...result, draft: true, changed: false, warnings } };
  if (config.ci.draft_while_iterating !== true) {
    return { exitCode: EXIT.OK, output: { ok: true, ...result, draft: false, changed: false, skipped: 'draft-not-iterating', warnings } };
  }
  let converted;
  try {
    converted = gh.convertToDraft(pr);
  } catch (err) {
    if (!(err instanceof GhError)) throw err;
    const message = String(err.message).split('\n')[0];
    if (err.timedOut || err.overBuffer || UNREACHABLE.test(err.message)) {
      throw new Fail(EXIT.UNAVAILABLE, { ok: false, ...result, unavailable: true, error: 'unavailable', message, changed: false, warnings });
    }
    throw new Fail(EXIT.FAILED, { ok: false, ...result, reason: 'convert-failed', message: `PR #${pr} could not be turned back to draft: ${message}`, draft: false, changed: false, warnings });
  }
  if (converted.isDraft !== true) {
    throw new Fail(EXIT.FAILED, { ok: false, ...result, reason: 'convert-failed', message: `GitHub did not report PR #${pr} as a draft after the conversion`, draft: false, changed: false, warnings });
  }
  // Auto-merge armed between the read and the conversion: a draft cannot merge, but an armed request would fire at the next ready, so disarm it.
  if (converted.autoMergeArmed) {
    result.autoMergeDisabled = disableAutoMerge({ pr, cwd: root, env });
    if (!result.autoMergeDisabled) warnings.push(`auto-merge was armed on PR #${pr} and could not be disabled: run \`gh pr merge ${pr} --disable-auto\` and check the PR by hand`);
  }

  // 5. Done.
  return { exitCode: EXIT.OK, output: { ok: true, ...result, draft: true, changed: true, warnings } };
});
