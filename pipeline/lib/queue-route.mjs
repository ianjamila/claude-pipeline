// `P merge` in queue mode (GitHub requires a merge queue on the base): the pipeline enqueues the approved head instead of merging it,
// watches the entry with today's stop conditions, and re-queues the SAME head once after a group-check failure. Both merge routes
// (gated and --owner-go) do their own gating and then hand over to this engine; they never branch on queue state anywhere else.
//   precheck()         reads GitHub first (never enqueues twice, reports a merge that already happened) -> { done } | { watch } | { enqueue }
//   enqueueAndWatch()  begin attempt, enqueue, confirm, watch, re-queue once -> { exitCode, output }
// Nothing here ever disables auto-merge or dequeues for a time-out: `still-queued` leaves the entry exactly as it is.
import { EXIT } from './cli.mjs';
import { DEFAULTS, fill } from './config.mjs';
import { GATE_FILE, GATE_MAX_AGE_MS, evaluateGate, evaluateOwnerGo, preMergeProblems, readReviewJson, waitBlockers } from './finalgate.mjs';
import { classifyMergeCommand, commandTail } from './merge-cleanup.mjs';
import { QueueRecordUnreadable, beginAttempt, confirmAttempt, endRecord, failingChecksOn, mayRequeue, noteRemoval, openRecord, queueRulesOf, queueWaitMs, readQueueRecord, reconcile, restoreHoldLabel, watchQueue } from './merge-queue.mjs';
import { RESTORE_NOTE } from './hold.mjs';
import { envWithGhDir, runShellAsync } from './proc.mjs';
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
export async function recheckGatedRecorded({ root, config, pr, gh, env, head, repo, rec, now = Date.now, ...seams }) {
  const gate = readReviewJson(root, GATE_FILE);
  const stop = (why) => ({ ok: false, error: 'live-check', reasons: [`${why}: run the final gate again`] });
  if (gate === null) return stop('the gate file is gone');
  if (gate.ok !== true || gate.head !== head || gate.pr !== pr) return stop('the gate file is not a passing gate for this PR and head');
  const at = Date.parse(gate.at);
  if (!Number.isFinite(at) || now() - at > GATE_MAX_AGE_MS) return stop('the gate file is too old');
  const ownerApproved = typeof gate.ownerItems === 'string' && approvalGap({ repo, pr, head, items: gate.ownerItems, areas: null, hold: null, rulings: null }) === 'ok';
  return recheckGated({
    root, config, pr, gh, env, gate, ownerApproved, ...seams,
    ownerMergeReason: `the final gate left items for the owner (owner_approval: chat) and no "merge" for this head and item set is on record${rec?.approval?.items ? ` (items ${rec.approval.items})` : ''}: ask the owner again`,
  });
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
  onBeforeAttempt = async () => {}, onTerminal = async () => {}, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now, log = () => {},
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

  // ---- 1. GitHub first ----------------------------------------------------------------------------------------------------------
  async function precheck() {
    let rec;
    let r;
    try {
      rec = readQueueRecord(root, pr);
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
        staleTerminal: () => refusal('queue-removed', [`PR #${pr} at ${head.slice(0, 12)} already left the merge queue (${last?.reason ?? rec.terminal}) and its queue record ended: ${route === 'gated'
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
            // (a watch resumed from a worktree at another head than the queued one follows the record's head and is never re-queued from here: #230)
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
