// `P merge` in queue mode (GitHub requires a merge queue on the base): the pipeline enqueues the approved head instead of merging it,
// watches the entry with today's stop conditions, and re-queues the SAME head once after a group-check failure. Both merge routes
// (gated and --owner-go) do their own gating and then hand over to this engine; they never branch on queue state anywhere else.
//   precheck()         reads GitHub first (never enqueues twice, reports a merge that already happened) -> { done } | { watch } | { enqueue }
//                      (a result after a live record of another head was discharged may carry holdFields: the hold fields that discharge produced)
//   enqueueAndWatch()  begin attempt, enqueue, confirm, watch, re-queue once -> { exitCode, output }
// Nothing here ever disables auto-merge or dequeues for a time-out: `still-queued` leaves the entry exactly as it is.
import { statSync } from 'node:fs';
import path from 'node:path';
import { EXIT } from './cli.mjs';
import { DEFAULTS, fill } from './config.mjs';
import { GATE_FILE, GATE_MAX_AGE_MS, PR_FIELDS, evaluateGate, evaluateOwnerGo, gateRefusals, localContentHash, preMergeProblems, readReviewJson, waitBlockers } from './finalgate.mjs';
import { classifyMergeCommand, commandTail } from './merge-cleanup.mjs';
import { QueueRecordUnreadable, beginAttempt, confirmAttempt, endRecord, failingChecksOn, mayRequeue, noteRemoval, openRecord, queueRulesOf, queueWaitMs, readQueueRecord, reconcile, restoreHoldLabel, watchQueue } from './merge-queue.mjs';
import { RESTORE_NOTE } from './hold.mjs';
import { headSha } from './git.mjs';
import { envWithGhDir, runShellAsync } from './proc.mjs';
import { canonicalPath, samePath } from './paths.mjs';
import { gitCommonDir } from './repo.mjs';
import { approvalGap } from '../hooks/lib/owner-go.mjs';

const CONFIRM_MS = 60_000; // GitHub shows the entry within this long of an accepted enqueue, or the enqueue failed
const OUTPUT_LINES = 20;

// Test switches (they can only shorten a wait, like PIPELINE_MERGE_WAIT_MS): PIPELINE_QUEUE_POLL_MS (watch poll; production 90 s, the shared
// GitHub API budget), PIPELINE_QUEUE_CONFIRM_MS / PIPELINE_QUEUE_CONFIRM_POLL_MS, PIPELINE_QUEUE_WAIT_MS (the watch budget).
export function queueTiming(env = {}) {
  const num = (key, min) => {
    const n = Number(env[key]);
    return env[key] !== undefined && env[key] !== '' && Number.isInteger(n) && n >= min ? n : null;
  };
  return {
    pollMs: num('PIPELINE_QUEUE_POLL_MS', 1) ?? 90_000,
    confirmMs: Math.min(num('PIPELINE_QUEUE_CONFIRM_MS', 0) ?? CONFIRM_MS, CONFIRM_MS),
    confirmPollMs: num('PIPELINE_QUEUE_CONFIRM_POLL_MS', 1) ?? 5000,
    waitCapMs: num('PIPELINE_QUEUE_WAIT_MS', 0),
  };
}

// The built-in merge command fails on a queue branch (gh refuses --delete-branch there, Phase 0 D1), so only THAT exact text is replaced
// by the pinned enqueue; a repo's own command is run as written and must enqueue itself.
export const isDefaultMergeCommand = (config) => config?.merge?.command === DEFAULTS.merge.command;

// approvalGap, counting only a "merge" the owner recorded AFTER `since` (epoch ms): the same head is re-queued after its record ended
// only on a fresh word (Fable F10). Uses readRecords' maxAgeMs, so the owner-go library itself is not touched.
export function approvalGapSince(q, since, gap = approvalGap) {
  if (since === undefined) return gap(q);
  const age = Date.now() - since - 1;
  if (age <= 0) return 'none';
  return gap({ ...q, maxAgeMs: age });
}

// The gated route's fresh decision after a record of the same head ended (#228, mirroring approvalGapSince for the owner-go route): the gate file
// (rewritten by every `P final-gate` run: the old file is removed first and the new one carries its own `at`) is a passing gate written after the
// record ended, and it left no items for the owner. Items for the owner need the owner's fresh word instead (approvalGapSince). The caller has
// already checked the gate against the PR, head, patch and age (gateRefusals); `since` is the record's end (Infinity when it cannot be read).
export function gateFreshSince(gate, since) {
  if (gate === null || typeof gate !== 'object' || gate.ok !== true || Number(gate.ownerMerge) > 0) return false;
  const at = Date.parse(gate.at);
  return Number.isFinite(at) && Number.isFinite(since) && at > since;
}

// Before a re-queue on the --owner-go route: the live scan again, the owner's approval for what it found, and the blockers. Shared by `P merge` (its own watch)
// and the queue sweep (an unattended re-queue), so both judge a re-queue exactly as the first enqueue was judged. `hold` = the lifted hold binding the record owns.
export async function recheckOwnerGo({ root, config, pr, gh, env, head, repo, hold }) {
  const again = await evaluateOwnerGo({ root, config, pr, gh, env, queueMode: true });
  if (again.head !== head) return { ok: false, error: 'live-check', reasons: ['the worktree moved while the PR was queued'] };
  if (!again.ok) return { ok: false, error: 'live-check', reasons: again.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`) };
  const gap = approvalGap({ repo, pr, head, items: again.ownerItems, areas: again.areas, hold: hold ?? undefined, rulings: again.rulingsBlockDigest });
  if (gap !== 'ok') return { ok: false, error: 'owner-go', reasons: ['the owner\'s "merge" for this head and scan is no longer on record (it is valid for 24 hours): ask again'] };
  const problems = await preMergeProblems({ gh, pr, head, queueMode: true });
  return problems.length > 0 ? { ok: false, error: 'blocked', reasons: problems } : { ok: true };
}

// Before a re-queue on the GATED route: the live gate again for the SAME head and patch the final gate approved, the owner's word where the gate left items
// for the owner, and the blockers. `P merge` (its own watch) calls it with the gate it holds; the queue sweep through recheckGatedRecorded below.
// `evaluate` / `problemsOf` are test seams.
export async function recheckGated({ root, config, pr, gh, env, gate, ownerApproved, ownerMergeReason, evaluate = evaluateGate, problemsOf = preMergeProblems }) {
  const fresh = await evaluate({ root, config, pr, gh, env, queueMode: true });
  const failed = fresh.checks.filter((c) => !c.ok);
  if (failed.length > 0) return { ok: false, error: 'live-check', reasons: failed.map((c) => `${c.name}: ${c.detail}`) };
  if (fresh.head !== gate.head || fresh.contentHash !== gate.contentHash) return { ok: false, error: 'live-check', reasons: ['the live gate is for a different head or patch than final-gate.json approved'] };
  // (an item added, dismissed or swapped since the gate ran, same head and patch: the owner was never shown that set. Unconditional, so it binds the sweep and P merge's own watch alike; R1-B1)
  if (fresh.ownerItems !== gate.ownerItems) return { ok: false, error: 'pre-merge', reasons: [`the owner items changed since the final gate (now ${fresh.ownerItems}, gate ${gate.ownerItems}): run the final gate again${ownerApproved ? ' and show them to the owner' : ''}`] };
  if (Number(fresh.ownerMerge) > 0 && !ownerApproved) return { ok: false, error: 'pre-merge', reasons: [ownerMergeReason] };
  if (ownerApproved && approvalGap({ repo: gh.repo().slug, pr, head: gate.head, items: gate.ownerItems, areas: null, hold: null, rulings: null }) !== 'ok') {
    return { ok: false, error: 'pre-merge', reasons: ['the owner\'s "merge" for this head is no longer on record (it is valid for 24 hours): ask again'] };
  }
  const problems = await problemsOf({ gh, pr, head: gate.head, queueMode: true });
  return problems.length > 0 ? { ok: false, error: 'blocked', reasons: problems } : { ok: true };
}

// The sweep's gated recheck (#229): no `P merge` process holds the gate, so it is read from the recorded worktree. It must still be a passing gate
// for the recorded head and not older than a gate may be; otherwise nothing is re-queued (the owner re-runs the final gate and `P merge`).
// The owner's word counts when the gate named owner items and a "merge" for exactly this head and item set is on record.
// The file is then bound exactly as `P merge` binds it (gateRefusals: repo, canonical check list, PR head, patch hash, age, a future date), so the two cannot drift (R1-F3).
// `localHash` is a test seam.
export async function recheckGatedRecorded({ root, config, pr, gh, env, head, repo, rec, now = Date.now, localHash = localContentHash, ...seams }) {
  const gate = readReviewJson(root, GATE_FILE);
  const stop = (why) => ({ ok: false, error: 'live-check', reasons: [`${why}: run the final gate again`] });
  if (gate === null) return stop('the gate file is gone');
  if (gate.ok !== true || gate.head !== head || gate.pr !== pr) return stop('the gate file is not a passing gate for this PR and head');
  const at = Date.parse(gate.at);
  if (!Number.isFinite(at) || now() - at > GATE_MAX_AGE_MS) return stop('the gate file is too old');
  // (a failed read throws, as evaluateGate's does a call later: the sweep leaves the record live for the next pass. A refusal would end it and spend the owner's word on a GitHub blip: R2-F2)
  const prHead = gh.prView(pr, [...PR_FIELDS]).headRefOid;
  let hash = '';
  try {
    hash = localHash(root, config);
  } catch { /* gateRefusals reports the mismatch */ }
  const refusals = gateRefusals({ gate, pr, head, prHead, hash, repo, now: now() });
  if (refusals.length > 0) return { ok: false, error: 'live-check', reasons: refusals.map((why) => `${why}: run the final gate again`) };
  const ownerApproved = typeof gate.ownerItems === 'string' && approvalGap({ repo, pr, head, items: gate.ownerItems, areas: null, hold: null, rulings: null }) === 'ok';
  // The first enqueue stood on the owner's word even though the gate itself shows no owner items (a resumed run, an unchecked run record): the word must still be on record.
  // (`ownerRequired` is absent on records written before the field, which keep the earlier behaviour: the word counts only where the live gate has owner items.)
  if (rec?.approval?.ownerRequired === true && !ownerApproved) {
    return { ok: false, error: 'pre-merge', reasons: ['the owner\'s "merge" for this head is no longer on record (it is valid for 24 hours; the enqueue stood on it): ask the owner again'] };
  }
  return recheckGated({
    root, config, pr, gh, env, gate, ownerApproved, ...seams,
    ownerMergeReason: `the final gate left items for the owner (owner_approval: chat) and no "merge" for this head and item set is on record${rec?.approval?.items ? ` (items ${rec.approval.items})` : ''}: ask the owner again`,
  });
}

export const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };
// canonicalPath (realpath.native), not JS realpathSync: only the native one expands a Windows 8.3 short name (RUNNER~1), so a temp folder and `git rev-parse` spell the same place alike.
export const canon = (p) => canonicalPath(p);
// Two folders are the same place when their canonical spellings agree (samePath: slash-normalised, case-insensitive where the file system is).
const samePlace = (a, b) => samePath(canon(a), canon(b));

// Why the worktree a live record was opened in cannot do that record's one re-queue, or null when it can: gone, no longer at the recorded head, or not a worktree of
// `root`'s repository. One judgement for the sweep's re-queue (makeRequeue) and for a `P merge` at another head (requeueElsewhere), so the two cannot disagree (R1-F2).
export function recordedWorktreeProblem({ rec, root, headOf = (cwd) => headSha({ cwd }) }) {
  if (typeof rec.root !== 'string' || !isDir(rec.root)) return 'worktree gone';
  let current;
  try {
    current = headOf(rec.root);
  } catch {
    return 'worktree gone';
  }
  if (current !== rec.head) return `worktree at another head (${String(current).slice(0, 12)}, approved ${rec.head.slice(0, 12)})`;
  try {
    if (!samePlace(gitCommonDir(rec.root), gitCommonDir(root))) return 'worktree belongs to another repository';
  } catch {
    return 'worktree gone';
  }
  return null;
}

// The onTerminal seam that puts a lifted needs-human hold back (once) at an unmerged end; a failed restore keeps the record open for the next settle.
export const restoreHoldOnTerminal = ({ gh, pr }) => async ({ rec }) => {
  if (!rec || rec.terminal !== null || rec.hold === null) return {};
  const res = restoreHoldLabel({ gh, pr });
  if (res.status === 'failed') return { keepOpen: true, fields: { holdRestored: false, holdRestoreFailed: true, holdRestoreNote: `COULD NOT put needs-human back on PR #${pr} (${res.why}): add the label by hand` } };
  return res.status === 'restored' ? { fields: { holdRestored: true, holdRestoredNote: RESTORE_NOTE } } : {};
};

const lastLines = (text, n = OUTPUT_LINES) => String(text ?? '').split('\n').map((l) => l.trimEnd()).filter(Boolean).slice(-n);
const firstLine = (err) => String(err?.message ?? err).split('\n')[0];

// (failingChecksOn lives in merge-queue.mjs, next to settleRecord, which reports the same thing; re-exported for the callers of this file)
export { failingChecksOn };

// Everything the engine needs from the route that calls it:
//   gh, root, config, pr, head (the approved full sha), route ('gated' | 'owner-go': stored on the record; the sweep re-checks with that route's recheck),
//   env, refuse (merge.mjs's), track (the merge lock's child tracker),
//   approval { items, areas, rulings } (stored on the record), extra (fields every output carries: mode, head, ...),
//   recheck(): the route's live checks + owner approval + blockers for the SAME head, run before a re-queue -> { ok: true } | { ok: false, error, reasons },
//   onBeforeAttempt({ rec }) / onTerminal({ kind, rec }): the two SEAMS for the needs-human hold (no-ops by default; merge.mjs wires them). onBeforeAttempt writes the
//   lifted hold to the record before every attempt; onTerminal runs at an unmerged end (removed / blocked / closed / head-moved) BEFORE the record ends and may return
//   { fields, keepOpen }: `fields` join the refusal (holdRestored ...), `keepOpen` leaves the record live (the label could not be put back: the next settle retries).
export function createQueueRoute({
  gh, root, config, pr, head, route = null, env = process.env, refuse, track = { started() {}, ended() {} }, approval, extra = {}, recheck,
  onBeforeAttempt = async () => {}, onTerminal = async () => {}, headOf, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now, log = () => {},
}) {
  const timing = queueTiming(env);
  const repo = gh.repo().slug;
  const repoId = typeof gh.repoId === 'function' ? gh.repoId() : null;
  const opts = { repo, repoId, now, gh, route }; // (gh: beginAttempt anchors the pending attempt to GitHub's timeline)
  let requeued = 0;
  let rules = null;
  try {
    rules = queueRulesOf(gh.branchRules(config.default_branch));
  } catch { /* unreadable: queueWaitMs falls back to its default */ }
  const budgetMs = Math.min(queueWaitMs(rules), timing.waitCapMs ?? Infinity);

  const fields = (over = {}) => ({ queue: true, ...extra, requeued, ...over });
  const refusal = (error, reasons, over = {}) => refuse(error, reasons, fields({ queued: false, ...over }));
  const unreadable = (what, err) => refusal('queue-unreadable', [`${what}: ${firstLine(err)}`], { queued: null });
  const mergedOut = (mergeSha, over = {}) => ({
    exitCode: EXIT.OK,
    output: mergeSha
      ? { ok: true, merged: true, ...fields({ queued: true, mergeSha }), ...over }
      : { ok: true, merged: true, ...fields({ queued: true, mergeSha: null }), warning: 'the PR is MERGED but GitHub did not report its merge commit after re-reading', ...over },
  });
  const liveRecord = () => {
    const rec = readQueueRecord(root, pr);
    return rec !== null && rec.terminal === null ? rec : null;
  };
  // An unmerged end: the hold seam first (it puts a lifted label back), then the record ends if it still is open and the seam did not keep it.
  // -> the fields the seam adds to the refusal.
  const terminal = async (kind) => {
    const out = (await onTerminal({ kind, rec: readQueueRecord(root, pr) })) ?? {};
    if (out.keepOpen !== true && liveRecord() !== null) endRecord(root, pr, kind, { now });
    return out.fields ?? {};
  };

  const removedRefusal = async (removal, why) => {
    const failing = failingChecksOn(gh, removal?.beforeCommit);
    const holdFields = await terminal('removed');
    const reason = removal?.reason ?? 'unknown';
    return refusal('queue-removed', [`PR #${pr} was removed from the merge queue (reason ${reason})${requeued > 0 ? ' after one automatic re-queue' : ''}${failing.length > 0 ? `; failing: ${failing.join(', ')}` : ''}${why ? `; ${why}` : ''}`], {
      removal: { reason: removal?.reason ?? null, beforeCommit: removal?.beforeCommit ?? null, actor: removal?.actor ?? null, at: removal?.at ?? null, failing }, ...holdFields,
    });
  };
  const unmergedEnd = async (kind) => {
    const holdFields = await terminal(kind);
    return refusal(kind, [kind === 'closed' ? `PR #${pr} was closed without merging` : `PR #${pr}'s head moved off the approved ${head.slice(0, 12)}: nothing was queued or merged for it`], { queued: false, ...holdFields });
  };

  // A removal whose one automatic re-queue belongs to ANOTHER worktree (the record's head is not this worktree's): nothing is ended, restored, enqueued or dequeued.
  // The record stays live, and `P queue-sweep` re-queues it from the worktree that queued it (makeRequeue needs rec.root at rec.head) (#232).
  // Only where that worktree CAN do it: this very worktree (it moved from H to K), a worktree that is gone, at another head or of another repository would make the
  // sweep end the record anyway, so the removal ends it now (removed, hold restored, the reason says why) instead of leaving the hold lifted for nothing (R1-F2).
  const requeueElsewhere = async (removal) => {
    const rec = readQueueRecord(root, pr);
    const thisOne = typeof rec.root === 'string' && samePlace(rec.root, root);
    const elsewhere = thisOne ? null : recordedWorktreeProblem({ rec, root, headOf });
    const why = thisOne
      ? `the worktree that queued it is this one, now at ${head.slice(0, 12)} (it queued ${rec.head.slice(0, 12)})`
      : elsewhere !== null ? `the worktree that queued it (${rec.root}) cannot re-queue it: ${elsewhere}` : null;
    if (why !== null) return removedRefusal(removal, `not re-queued: ${why}`);
    const failing = failingChecksOn(gh, removal?.beforeCommit);
    return refusal('requeue-due', [`PR #${pr} was removed from the merge queue (reason ${removal?.reason ?? 'unknown'}${failing.length > 0 ? `; failing: ${failing.join(', ')}` : ''}); its one automatic re-queue is due for ${rec.head.slice(0, 12)}, the head the worktree at ${rec.root} queued: \`P queue-sweep\` re-queues it from there (or run \`P merge --pr ${pr}\` in that worktree); this worktree is at ${head.slice(0, 12)}, so nothing was re-queued from here`], {
      removal: { reason: removal?.reason ?? null, beforeCommit: removal?.beforeCommit ?? null, actor: removal?.actor ?? null, at: removal?.at ?? null, failing }, queuedHead: rec.head, recordRoot: rec.root,
    });
  };

  // ---- 1. GitHub first ----------------------------------------------------------------------------------------------------------
  // A LIVE record for another head than this worktree's belongs to another approval (the worktree that queued it): GitHub is read for ITS head, and this run
  // ends that record only where the record's own head says so (merged, closed, a removal that is not re-queueable, the PR head off it with no entry left).
  // -> the same shapes as precheck. (#232)
  async function followLiveRecord(rec) {
    const tag = rec.head.slice(0, 12);
    let r;
    try {
      r = await reconcile({ gh, root, pr, head: rec.head, sleep, pollMs: Math.min(timing.pollMs, 2000), log });
      switch (r.kind) {
        case 'merged':
          // (reconcile answers MERGED before it compares heads: the note never says which head merged)
          if (liveRecord() !== null) endRecord(root, pr, 'merged', { now });
          return { done: mergedOut(r.mergeSha, { note: 'already merged through the queue' }) };
        case 'queued': return { watch: true };
        case 'closed': return { done: await unmergedEnd('closed') };
        case 'removed': {
          const noted = noteRemoval(root, pr, r.removal); // (judged on the record AFTER the removal is on it, never the copy read before)
          if (mayRequeue(noted ?? readQueueRecord(root, pr), rec.head, r.removal.reason)) return { done: await requeueElsewhere(r.removal) };
          return { done: await removedRefusal(r.removal) };
        }
        case 'head-moved': return await movedOffRecord(rec, r.head);
        default: // not-queued: the record's decision (settleRecord's gone(null)) is the sweep's
          return { done: refusal('head-moved', [`PR #${pr} is at ${tag}, queued by the worktree at ${rec.root}; this worktree is at ${head.slice(0, 12)}; nothing was queued for it; the queue record is left to \`P queue-sweep\``], { queued: false }) };
      }
    } catch (err) {
      if (err instanceof QueueRecordUnreadable) return { done: unreadable('the merge-queue record could not be used', err) };
      return { done: unreadable(`could not read the merge queue state of PR #${pr}`, err) };
    }
  }

  // GitHub's PR head is `jHead`, not the live record's. A live entry there (any head) is not this record's to end: nothing changes, the caller is refused.
  // No entry: the record's approval was for its head only and its entry cannot exist any more, so it is discharged first exactly as the sweep would (the owned hold
  // goes back once; a failed restore keeps it open), and only then is the caller's head judged from a clean slate.
  async function movedOffRecord(rec, jHead) {
    const tag = rec.head.slice(0, 12);
    const cur = gh.queueState(pr);
    if (cur.state !== 'OPEN' || cur.head !== jHead) {
      return { done: refusal('head-moved', [`PR #${pr} changed while it was being read (it is now ${cur.state === 'OPEN' ? `at ${String(cur.head).slice(0, 12)}` : cur.state.toLowerCase()}); nothing was changed: run \`P merge\` again`], { queued: null }) };
    }
    if (cur.entry) {
      return { done: refusal('head-moved', [`PR #${pr} is in the merge queue at ${jHead.slice(0, 12)}, but the live queue record here is for ${tag} (another approval); nothing was changed: \`P queue-sweep\` settles that record, then run \`P merge\` again`], { queued: true }) };
    }
    const holdFields = await terminal('head-moved');
    if (liveRecord() !== null) {
      return { done: refusal('head-moved', [`PR #${pr}'s head is ${jHead.slice(0, 12)}, off the ${tag} the live queue record here is for; that record could not be closed${holdFields.holdRestoreNote ? ` (${holdFields.holdRestoreNote})` : ''}, so nothing was queued for this worktree`], { queued: false, ...holdFields }) };
    }
    // The discharge put a label back (or failed to): the owner has to be told, whatever the caller's own head turns out to be (R1-F1). A refusal carries the fields
    // itself; an { enqueue } / { watch } result carries them as `holdFields`, which the caller attaches to every refusal it makes after the precheck.
    const next = await precheck();
    if (Object.keys(holdFields).length === 0) return next;
    if (next.done) return next.done.output?.ok === false ? { done: { ...next.done, output: { ...holdFields, ...next.done.output } } } : next;
    return { ...next, holdFields };
  }

  async function precheck() {
    let rec;
    let r;
    try {
      rec = readQueueRecord(root, pr);
    } catch (err) {
      return { done: unreadable('the merge-queue record could not be read', err) };
    }
    if (rec !== null && rec.terminal === null && rec.head !== head) return followLiveRecord(rec);
    try {
      r = await reconcile({ gh, root, pr, head, sleep, pollMs: Math.min(timing.pollMs, 2000), log });
    } catch (err) {
      return { done: unreadable(err instanceof QueueRecordUnreadable ? 'the merge-queue record could not be read' : `could not read the merge queue state of PR #${pr}`, err) };
    }
    if (r.kind === 'merged') {
      if (rec !== null && rec.terminal === null) endRecord(root, pr, 'merged', { now });
      return { done: mergedOut(r.mergeSha, { note: 'already merged through the queue' }) };
    }
    if (r.kind === 'closed' || r.kind === 'head-moved') return { done: await unmergedEnd(r.kind) };
    if (r.kind === 'queued') return { watch: true };

    // removed | not-queued. A record that already ended for this very head needs a fresh owner "merge" (checked by the route with `since`).
    if (rec !== null && rec.terminal !== null && rec.terminal !== 'merged' && rec.head === head) {
      const since = Date.parse(rec.terminalAt);
      const last = rec.removals[rec.removals.length - 1] ?? null;
      return {
        enqueue: true,
        since: Number.isFinite(since) ? since : Infinity,
        // `wordWhy`: why only the owner's fresh "merge" re-queues it (a resumed run, a run record that cannot be checked, items for the owner); a final-gate run alone cannot (R2-F3)
        staleTerminal: (wordWhy = null) => refusal('queue-removed', [`PR #${pr} at ${head.slice(0, 12)} already left the merge queue (${last?.reason ?? rec.terminal}) and its queue record ended: ${wordWhy
          ? `${wordWhy}, so the owner must say "merge" again for this exact head (a new final-gate run alone does not re-queue it; a fresh word re-queues it with a new one-retry budget)`
          : route === 'gated'
          ? 'run `P final-gate` again for this exact head (a gate that passes after the record ended re-queues it with a new one-retry budget; where the gate left items for the owner, the owner must say "merge" again)'
          : 'the owner must say "merge" again for this exact head (a fresh word re-queues it with a new one-retry budget)'}`], {
          removal: last, recordTerminal: rec.terminal,
        }),
      };
    }
    if (r.kind === 'removed' && rec !== null && rec.head === head) {
      noteRemoval(root, pr, r.removal);
      if (!mayRequeue(readQueueRecord(root, pr), head, r.removal.reason)) return { done: await removedRefusal(r.removal) };
      return { enqueue: true, requeue: true };
    }
    return { enqueue: true, requeue: rec !== null && rec.head === head && rec.removals.length > 0 };
  }

  // ---- 2. enqueue --------------------------------------------------------------------------------------------------------------
  async function sendEnqueue() {
    if (isDefaultMergeCommand(config)) {
      try {
        gh.enqueue(pr, head);
        return { ok: true, lines: [] };
      } catch (err) {
        return { ok: false, lines: lastLines(err?.message ?? err) };
      }
    }
    const command = fill(config.merge.command, { pr: String(pr), sha: head }, { strict: true });
    const ran = await runShellAsync(command, { cwd: root, env: envWithGhDir(env), timeoutMs: (config.merge.wait_minutes + 5) * 60_000, onStart: track.started });
    track.ended();
    return { ok: ran.code === 0, ran, lines: lastLines(commandTail(ran)) };
  }

  // Did GitHub take it? A good exit gets the full window; a failed one a single look (the command may have queued it before it failed).
  async function confirm(sent) {
    const deadline = now() + (sent.ok ? timing.confirmMs : 0);
    let readError = null;
    for (;;) {
      try {
        const r = await reconcile({ gh, root, pr, head, sleep, pollMs: Math.min(timing.pollMs, 2000), log });
        readError = null;
        if (r.kind === 'queued') {
          confirmAttempt(root, pr, r.entry.id);
          return { ok: true };
        }
        if (r.kind === 'merged') {
          if (liveRecord() !== null) endRecord(root, pr, 'merged', { now });
          return { done: mergedOut(r.mergeSha, sent.ran ? classifyMergeCommand(sent.ran) : {}) };
        }
        if (r.kind === 'closed' || r.kind === 'head-moved') return { done: await unmergedEnd(r.kind) };
        if (r.kind === 'removed') return { ok: true }; // queued and already out again: the watch reads that removal
      } catch (err) {
        readError = err;
      }
      const left = deadline - now();
      if (left <= 0) break;
      await sleep(Math.min(timing.confirmPollMs, left));
    }
    if (readError !== null) return { done: unreadable(`could not confirm the enqueue of PR #${pr} (it may have landed: run P merge again, it reconciles first)`, readError) };
    const ranNote = sent.ran ? ` (the merge command exited ${sent.ran.code}${sent.ran.timedOut ? ', timed out' : ''})` : '';
    return { done: refusal('enqueue-failed', [`GitHub's merge queue does not show PR #${pr} at ${head.slice(0, 12)} after the enqueue${ranNote}`], { enqueueOutput: sent.lines, ...(sent.ran ? { commandExitCode: sent.ran.code } : {}) }) };
  }

  // ---- 3. the whole route after the gating -----------------------------------------------------------------------------------------
  // { watchOnly } (an entry already exists): never begins an attempt. { requeue } (a removal is already on the record) starts at the re-queue.
  async function enqueueAndWatch({ watchOnly = false, requeue = false } = {}) {
    if (requeue) requeued = 1;
    let enqueueNow = !watchOnly;
    try {
      for (;;) {
        if (enqueueNow) {
          openRecord(root, pr, head, approval, opts);
          // SEAM (hold): the record exists, no attempt yet. This is where a lifted needs-human hold is written to it (setHold, owner 'session'),
          // so a signal or a crash between the lift and the enqueue is still known to the record.
          await onBeforeAttempt({ rec: readQueueRecord(root, pr) });
          beginAttempt(root, pr, head, approval, opts);
          const confirmed = await confirm(await sendEnqueue());
          if (confirmed.done) return confirmed.done;
        }
        enqueueNow = true;
        const w = await watchQueue({ gh, root, pr, head, budgetMs, pollMs: timing.pollMs, blockers: waitBlockers(gh, { base: null }), now, sleep, log });
        switch (w.state) {
          case 'merged': return mergedOut(w.mergeSha, w.warning ? { warning: w.warning } : {});
          case 'still-queued':
            // Not a failure and never a stop: the entry stays queued, so no dequeue, no disable-auto, no hold restore (a later P merge reconciles).
            return { exitCode: EXIT.OK, output: { ok: true, merged: false, ...fields({ queued: true, stillQueued: true, ...(w.position === null || w.position === undefined ? {} : { position: w.position }) }) } };
          case 'blocked':
            return refuse('blocked', w.problems ?? [], fields({ queued: w.dequeued === false, dequeued: w.dequeued === true, ...(w.dequeued === false ? {} : await terminal('blocked')) }));
          case 'closed': return await unmergedEnd('closed');
          case 'head-moved': return await unmergedEnd('head-moved');
          case 'removed': {
            // (watchQueue already noted the removal on the record)
            const rec = readQueueRecord(root, pr);
            if (requeued === 0 && mayRequeue(rec, head, w.removal.reason)) {
              const again = await recheck();
              if (!again.ok) {
                const removed = await removedRefusal(w.removal, `not re-queued: ${again.reasons.join('; ')}`);
                return again.error === 'blocked' ? refuse('blocked', again.reasons, fields({ queued: false, removal: removed.output.removal })) : removed;
              }
              requeued = 1;
              continue;
            }
            // (a watch resumed from a worktree at another head than the queued one follows the record's head and is never re-queued from here: #230. A removal that
            // WOULD be re-queued for the record's head is left live for the sweep, which re-queues it from the worktree that queued it: #232)
            if (rec !== null && rec.terminal === null && rec.head !== head && mayRequeue(rec, rec.head, w.removal.reason)) return await requeueElsewhere(w.removal);
            return await removedRefusal(w.removal, rec !== null && rec.head !== head ? `not re-queued: this worktree is at ${head.slice(0, 12)}, the queued head was ${rec.head.slice(0, 12)}` : undefined);
          }
          default: return refusal('queue-unreadable', [`unexpected queue watch result ${JSON.stringify(w.state)}`], { queued: null });
        }
      }
    } catch (err) {
      if (err instanceof QueueRecordUnreadable) return unreadable('the merge-queue record could not be used', err);
      throw err;
    }
  }

  // The sweep's re-queue: one more attempt for the recorded head, confirmed with GitHub, no watching (the next sweep reads the entry).
  // -> { ok: true } | { done } (a refusal or a merge the confirm found).
  async function reenqueue() {
    requeued = 1;
    openRecord(root, pr, head, approval, opts);
    beginAttempt(root, pr, head, approval, opts);
    return confirm(await sendEnqueue());
  }

  return { precheck, enqueueAndWatch, reenqueue, budgetMs, budgetMinutes: Math.ceil(budgetMs / 60_000) };
}
