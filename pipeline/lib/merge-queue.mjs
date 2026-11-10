// Merge queue ("queue mode"): when GitHub says a PR's base requires a merge queue, the pipeline enqueues the approved head and GitHub
// merges it after testing it on top of the base. Queue mode is never configured: it is read live from GitHub on every call, so turning
// the queue off restores the direct-merge path by itself, and an unreadable queue refuses (never falls back to a direct merge).
// This file holds the live detection and the pure helpers, the durable per-PR record, reconciliation with GitHub and the watcher.
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readRepoMoves, sameRepo } from '../hooks/lib/repo-moves.mjs';
import { PROVENANCE_CHECKS } from './config.mjs';
import { forgedGuards, labelNames, readMergeSha, validLabels, waitBlockers } from './finalgate.mjs';
import { HOLD_LABEL, RESTORE_NOTE } from './hold.mjs';
import { gitCommonDir } from './repo.mjs';
import { holdDigest } from '../hooks/lib/owner-go.mjs';

// The queue state could not be read. Callers refuse (final-gate / owner-go: a failing check; merge: `queue-unreadable`).
export class QueueUnreadable extends Error {
  constructor(message, { cause } = {}) {
    super(message);
    this.name = 'QueueUnreadable';
    if (cause !== undefined) this.cause = cause;
  }
}

// Is `pr` in queue mode right now? One GraphQL read. -> { queue: boolean, state } where `state` is gh.queueState's answer
// (so a caller that needs the entry does not read twice). Any failure, including a gh without the queue reads, throws
// QueueUnreadable: "cannot tell" must never look like "no queue".
export function queueModeFor({ gh, pr }) {
  let state;
  try {
    if (typeof gh?.queueState !== 'function') throw new Error('this GitHub client cannot read the merge queue');
    state = gh.queueState(pr);
  } catch (err) {
    throw new QueueUnreadable(`could not read the merge queue state of PR #${pr}: ${String(err?.message ?? err).split('\n')[0]}`, { cause: err });
  }
  return { queue: state.enabled === true, state };
}

// ---- the queue's own settings ------------------------------------------------------------------------------------------------------

const numberOrNull = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// The merge_queue rule among the branch rules (gh.branchRules): what bounds how long an entry can take. None => null (no queue rule).
// An unknown number is null; queueWaitMs then falls back to its default rather than guessing a short wait.
export function queueRulesOf(rules) {
  const rule = Array.isArray(rules) ? rules.find((r) => r?.type === 'merge_queue') : undefined;
  if (!rule) return null;
  const p = rule.parameters ?? {};
  return {
    minWaitMinutes: numberOrNull(p.min_entries_to_merge_wait_minutes),
    timeoutMinutes: numberOrNull(p.check_response_timeout_minutes),
    maxBuild: numberOrNull(p.max_entries_to_build),
    mergeMethod: typeof p.merge_method === 'string' ? p.merge_method : null,
  };
}

const MINUTE = 60_000;
const DEFAULT_QUEUE_WAIT_MIN = 120;
const MAX_QUEUE_WAIT_MIN = 360;

// How long to watch one entry before reporting "still queued": the fill wait, up to three check timeouts (a re-built group or two)
// and 30 minutes of slack, capped at 6 h. Unknown settings => 2 h.
export function queueWaitMs(q) {
  if (!q || q.minWaitMinutes === null || q.minWaitMinutes === undefined || q.timeoutMinutes === null || q.timeoutMinutes === undefined) return DEFAULT_QUEUE_WAIT_MIN * MINUTE;
  return Math.min(MAX_QUEUE_WAIT_MIN, q.minWaitMinutes + 3 * q.timeoutMinutes + 30) * MINUTE;
}

// ---- removal reasons (Phase 0 D4, GitHub's own strings) ---------------------------------------------------------------------------------

export const REASON_GROUP_CHECKS = 'failed_checks'; // the group's checks failed; seen twice in a row for the same head
export const REASON_MANUAL = 'manual'; // somebody dequeued it (the owner, or this pipeline's confirmed dequeue)
export const REASON_MERGED = 'merged'; // also emitted on EVERY successful merge: read as merged, never as a removal
// Only a group-check failure is retried on its own. Any other or unknown reason (a timeout was never observed) needs the owner.
export const REQUEUE_REASONS = Object.freeze(new Set([REASON_GROUP_CHECKS]));

// ---- the record ---------------------------------------------------------------------------------------------------------------------
// One JSON file per queued PR under the repo's common git dir, shared by every worktree of the clone. It is the pipeline's memory across
// restarts: how many attempts were spent, which entries existed, who owns a lifted needs-human hold. Callers hold the PR's merge lock
// while they change it, so a plain read-modify-write is enough; the write itself is atomic (a reader sees the old file or the whole new one).

const TERMINALS = new Set(['merged', 'removed', 'blocked', 'closed', 'head-moved']);
const HOLD_OWNERS = new Set(['session', 'pending', 'entry']);
export const ROUTES = new Set(['owner-go', 'gated']);

export class QueueRecordUnreadable extends Error {
  constructor(message) {
    super(message);
    this.name = 'QueueRecordUnreadable';
  }
}

export const queueRecordDir = (root) => join(gitCommonDir(root), 'pipeline', 'merge-queue');
export const queueRecordPath = (root, pr) => join(queueRecordDir(root), `pr-${Number(pr)}.json`);

const isoOf = (now) => new Date(now()).toISOString();

function checkRecord(rec, file) {
  const bad = (why) => new QueueRecordUnreadable(`${file}: ${why}`);
  if (rec === null || typeof rec !== 'object' || Array.isArray(rec)) throw bad('not a record');
  if (!Number.isInteger(rec.pr) || rec.pr <= 0) throw bad('no PR number');
  if (typeof rec.head !== 'string') throw bad('no head');
  if (!Number.isInteger(rec.attempts) || rec.attempts < 0) throw bad('attempts is not a count');
  if (!Array.isArray(rec.entryIds) || !Array.isArray(rec.removals)) throw bad('entryIds / removals are not lists');
  if (rec.pending !== null && (typeof rec.pending !== 'object' || typeof rec.pending?.head !== 'string')) throw bad('pending is malformed');
  if (rec.terminal !== null && !TERMINALS.has(rec.terminal)) throw bad(`unknown terminal ${JSON.stringify(rec.terminal)}`);
  if (rec.hold !== null && (typeof rec.hold !== 'object' || !HOLD_OWNERS.has(rec.hold?.owner))) throw bad('hold is malformed');
  return rec;
}

// null when there is no record; a malformed record throws (fail closed: a hold may hang on it).
export function readQueueRecord(root, pr) {
  const file = queueRecordPath(root, pr);
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw new QueueRecordUnreadable(`${file}: ${err?.code ?? err?.message}`);
  }
  let rec;
  try {
    rec = JSON.parse(text);
  } catch {
    throw new QueueRecordUnreadable(`${file}: not valid JSON`);
  }
  return checkRecord(rec, file);
}

function writeRecord(root, rec) {
  const file = queueRecordPath(root, rec.pr);
  mkdirSync(queueRecordDir(root), { recursive: true });
  const tmp = `${file}.${process.pid}-${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(rec, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    renameSync(tmp, file);
  } catch (err) {
    try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw err;
  }
  return rec;
}

function mutate(root, pr, fn) {
  const rec = readQueueRecord(root, pr);
  if (rec === null) throw new QueueRecordUnreadable(`no merge-queue record for PR #${pr}`);
  return writeRecord(root, fn(rec) ?? rec);
}

// The records whose work is not over (terminal === null), read from the directory only: no GitHub call, so a sweep with nothing to do is
// free. With `filter` ({ repo, repoId, moves }) only the records that belong to that repository (recordIsFor). An unreadable file is
// skipped and reported to `onError`; one bad record must not stop the sweep from settling the others.
export function liveRecords(root, { repo, repoId, moves, onError } = {}) {
  let names;
  try {
    names = readdirSync(queueRecordDir(root));
  } catch (err) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }
  const out = [];
  for (const name of names) {
    const m = /^pr-([1-9][0-9]*)\.json$/.exec(name);
    if (!m) continue;
    let rec;
    try {
      rec = readQueueRecord(root, Number(m[1]));
    } catch (err) {
      if (typeof onError === 'function') onError(err);
      continue;
    }
    if (rec === null || rec.terminal !== null) continue;
    if (repo !== undefined && !recordIsFor(rec, { repo, repoId, moves })) continue;
    out.push(rec);
  }
  return out.sort((a, b) => a.pr - b.pr);
}

// Does `rec` belong to the repository `{ repo, repoId }` is now? The numeric repository id decides when both sides have one (a rename or
// transfer keeps it; a different repository that took the old name has another). Otherwise the owner's recorded repo moves (#221's
// sameRepo) may link the name written then to the name now. `moves` is read lazily, only when the ids cannot decide.
export function recordIsFor(rec, { repo, repoId = null, moves } = {}) {
  if (Number.isInteger(rec?.repoId) && Number.isInteger(repoId)) return rec.repoId === repoId;
  return sameRepo({ recorded: rec?.repo, recordedAt: rec?.createdAt, current: repo, moves: moves ?? readRepoMoves().moves });
}

// Starts a record for `head`, or returns the live one for that head. A different head, or a record that already ended, starts over
// (a fresh owner "merge" is a fresh budget). Nothing is queued yet: `attempts` stays 0 until beginAttempt.
// `route` ('owner-go' | 'gated') is the merge route that opened the record: the sweep re-checks a re-queue with that route's own recheck (#229).
// A record without one (written before this field) is read as owner-go by the sweep, which fails closed.
// `approval.ownerRequired`: the first enqueue stood on the owner's word (gated route: a resumed run, an unchecked run record, items for the owner); the sweep re-queues
// such a record only while that word is still on record (R1-F2). The field is only written when true; a record without it (written before, or for an enqueue that needed no word) keeps the sweep's earlier behaviour.
export function openRecord(root, pr, head, approval, { repo = null, repoId = null, now = Date.now, route = null } = {}) {
  const old = readQueueRecord(root, pr);
  if (old !== null && old.terminal === null && old.head === head) return old;
  return writeRecord(root, {
    pr: Number(pr), repo, repoId, root, head,
    approval: { items: approval?.items ?? null, areas: approval?.areas ?? null, rulings: approval?.rulings ?? null, ...(approval?.ownerRequired === true ? { ownerRequired: true } : {}) },
    route: ROUTES.has(route) ? route : null, createdAt: isoOf(now), attempts: 0, pending: null, entryIds: [], removals: [], hold: null, terminal: null, terminalAt: null,
  });
}

// How many `added` events GitHub's timeline of the PR already shows: the anchor reconcile uses to tell this attempt's events from older ones
// by timeline order, never by comparing this machine's clock with GitHub's (#227). null when the timeline cannot be read (or no `gh` was given).
function addedEventsSeen(gh, pr) {
  try {
    if (typeof gh?.queueEvents !== 'function') return null;
    const events = gh.queueEvents(pr);
    return Array.isArray(events) ? events.filter((e) => e?.type === 'added').length : null;
  } catch {
    return null;
  }
}

// Written BEFORE the enqueue mutation, so a crash between the mutation and the confirm still counts the attempt. With `opts.gh` the pending
// attempt carries `addedSeen` (the anchor above); without it (an unreadable timeline) reconcile falls back to the wall-clock reading.
export function beginAttempt(root, pr, head, approval, opts = {}) {
  const now = opts.now ?? Date.now;
  openRecord(root, pr, head, approval, opts);
  const addedSeen = addedEventsSeen(opts.gh, pr);
  return mutate(root, pr, (rec) => {
    rec.attempts += 1;
    rec.pending = { head, at: isoOf(now), ...(addedSeen === null ? {} : { addedSeen }) };
    if (rec.hold) rec.hold.owner = 'pending';
  });
}

// GitHub accepted the enqueue: the entry exists. From here only a terminal end may restore a lifted hold.
export function confirmAttempt(root, pr, entryId) {
  return mutate(root, pr, (rec) => {
    rec.pending = null;
    if (typeof entryId === 'string' && !rec.entryIds.includes(entryId)) rec.entryIds.push(entryId);
    if (rec.hold) rec.hold.owner = 'entry';
  });
}

// Records a removal once. The same removal read again (a restarted job, the sweep) is one removal: the key is its time + queue commit.
export function noteRemoval(root, pr, removal) {
  return mutate(root, pr, (rec) => {
    const entryId = removal.entryId ?? rec.entryIds[rec.entryIds.length - 1] ?? null;
    const item = { entryId, reason: removal.reason ?? null, beforeCommit: removal.beforeCommit ?? null, at: removal.at ?? null };
    const key = (r) => (r.at ? `${r.at}|${r.beforeCommit}|${r.reason}` : `${r.entryId}|${r.beforeCommit}|${r.reason}`);
    if (!rec.removals.some((r) => key(r) === key(item))) rec.removals.push(item);
  });
}

// The lifted needs-human hold, with the FULL binding the owner's approval names ({ id, login, at } + the Hold-block digest), so a later
// re-queue can prove the original approval covers it after the label is gone. null clears it. A new hold starts as `session`.
export function setHold(root, pr, hold) {
  return mutate(root, pr, (rec) => {
    rec.hold = hold === null ? null : { liftedAt: null, ...hold, owner: HOLD_OWNERS.has(hold.owner) ? hold.owner : 'session' };
  });
}

export function endRecord(root, pr, terminal, { now = Date.now } = {}) {
  if (!TERMINALS.has(terminal)) throw new TypeError(`unknown terminal ${JSON.stringify(terminal)}`);
  return mutate(root, pr, (rec) => {
    rec.terminal = terminal;
    rec.terminalAt = isoOf(now);
    rec.pending = null;
  });
}

// One automatic re-queue per head, and only after a CONFIRMED group-check failure: exactly one such removal on the record. The count
// is of removals, not attempts, so an enqueue that never landed (dropped by reconcile) spends nothing.
export function mayRequeue(rec, head, reason) {
  return rec != null && rec.head === head && REQUEUE_REASONS.has(reason) && rec.removals.filter((r) => r.reason === REASON_GROUP_CHECKS).length === 1;
}

// ---- reconcile ---------------------------------------------------------------------------------------------------------------------

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FULL_SHA = /^[0-9a-f]{40}$/;
// Only for a pending attempt written before the `addedSeen` anchor existed (or one whose timeline could not be read when it began): its events
// are attributed by time, allowing for the clock difference with GitHub. Any newer attempt is attributed by timeline order alone (#227).
const LEGACY_CLOCK_SLACK_MS = 60_000;

// Where does GitHub say the PR is, compared with what the record expects?
//   merged / queued / removed / not-queued / head-moved / closed
// A removal counts only when it comes after the LAST `added` event, by timeline order (timestamps tie). A removal with reason `merged`
// (GitHub emits one on every successful merge) reads as merged. A `pending` attempt that GitHub shows as not queued never happened: it is
// dropped from the count (the enqueue failed, or died before it landed). Changes the record in that one case only.
export async function reconcile({ gh, root, pr, head, sleep = defaultSleep, pollMs = 2000, log = () => {} }) {
  const r = reconcileNow({ gh, root, pr, head, log });
  if (r.kind !== 'merged' || r.lookup === undefined) return r;
  return { kind: 'merged', mergeSha: await readMergeSha({ gh, pr, first: r.lookup.first, sleep, pollMs }) };
}

// Is the latest `added` event (index `lastAdded`, -1 = none) the pending attempt's enqueue? With the anchor: an `added` event came after the
// ones the timeline showed when the attempt began. Without it (back-compat): the event is not older than the attempt, within the legacy slack.
function attemptOwns(pending, events, lastAdded) {
  if (Number.isInteger(pending.addedSeen)) return events.filter((e) => e.type === 'added').length > pending.addedSeen;
  return Date.parse(events[lastAdded]?.at) >= Date.parse(pending.at) - LEGACY_CLOCK_SLACK_MS;
}

// reconcile's decision without any waiting, so a signal handler (which cannot await) can use it too. A merged answer whose merge commit
// is not known yet carries `lookup` (what reconcile then reads again); all else is final.
export function reconcileNow({ gh, root, pr, head, log = () => {} }) {
  const state = gh.queueState(pr);
  if (state.state === 'MERGED') return { kind: 'merged', lookup: { first: state.mergeSha } };
  if (state.state === 'CLOSED') return { kind: 'closed' };
  const rec = root === undefined ? null : readQueueRecord(root, pr);
  if (state.head !== head) {
    // A live entry at the head the record tracks is still queued, whichever commit this worktree is at now: ending the record would put the hold
    // back over a live entry. Only a PR that is not queued (or is queued at some other head) has moved.
    if (state.entry && rec !== null && rec.terminal === null && rec.head === state.head) return { kind: 'queued', entry: state.entry };
    return { kind: 'head-moved', head: state.head };
  }
  if (state.entry) return { kind: 'queued', entry: state.entry };
  const events = gh.queueEvents(pr);
  const lastAdded = events.map((e) => e.type).lastIndexOf('added');
  const after = lastAdded === -1 ? [] : events.slice(lastAdded + 1);
  const mergedAt = after.find((e) => e.type === 'merged' || (e.type === 'removed' && e.reason === REASON_MERGED));
  const ours = rec?.pending ? attemptOwns(rec.pending, events, lastAdded) : true;
  if (mergedAt && ours) {
    return mergedAt.beforeCommit && FULL_SHA.test(mergedAt.beforeCommit) ? { kind: 'merged', mergeSha: mergedAt.beforeCommit } : { kind: 'merged', lookup: { first: null } };
  }
  const removal = [...after].reverse().find((e) => e.type === 'removed');
  if (removal && ours) {
    return { kind: 'removed', removal: { entryId: rec?.entryIds[rec.entryIds.length - 1] ?? null, reason: removal.reason, beforeCommit: removal.beforeCommit, actor: removal.actor, at: removal.at } };
  }
  if (rec?.pending) {
    mutate(root, pr, (r) => {
      r.attempts = Math.max(0, r.attempts - 1);
      r.pending = null;
      if (r.hold?.owner === 'pending') r.hold.owner = 'session'; // no enqueue is in flight any more
    });
    log(`PR #${pr}: the enqueue at ${head.slice(0, 8)} never reached GitHub's queue; the attempt is not counted`);
  }
  return { kind: 'not-queued' };
}

// ---- watchQueue --------------------------------------------------------------------------------------------------------------------

const CONFIRM_TRIES = 6; // after a dequeue: look this many times (pollMs apart, at most 5 s) for the entry to be gone

// Watches one queued entry until it ends or `budgetMs` runs out. Each poll = reconcile + `blockers(view)`; the default blockers is
// waitBlockers(gh, { base: null }) — today's stop conditions (needs-human / pipeline-blocked / awaiting-review labels, open pause or
// rollback issues). NEVER exemptHold: once the entry exists the lifted label is off, so a needs-human on the PR now is a NEW hold.
// A blocker => gh.dequeue, then confirm the entry left (a merge in that race is reported as merged, with a warning). A poll that throws
// is simply retried on the next tick. Running out of budget is `still-queued` and touches nothing: no dequeue, no hold restore.
// Ends the record only where nothing else is owed: merged, or blocked when no lifted label is left to restore. A removal is noted on the
// record (once); what to do about it (re-queue, restore) stays with the caller.
// The head compared with GitHub's is the LIVE record's head when there is one, else `head` (#230): a watch resumed from a worktree at another commit
// than the one queued still sees the entry's removal or its confirmed dequeue and notes it on the record, instead of ending as `head-moved`. Nothing
// is ever re-queued from the other head: mayRequeue compares the record's head with the caller's.
export async function watchQueue({ gh, root, pr, head, budgetMs, pollMs = 90_000, blockers = null, now = Date.now, sleep = defaultSleep, log = () => {} }) {
  const check = blockers ?? waitBlockers(gh, { base: null });
  const deadline = now() + budgetMs;
  const watched = () => {
    const rec = root === undefined ? null : readQueueRecord(root, pr);
    return rec !== null && rec.terminal === null ? rec.head : head;
  };
  let position = null;
  for (;;) {
    let outcome = null;
    try {
      outcome = await pollOnce();
    } catch (err) {
      log(`PR #${pr}: queue poll failed, retrying (${String(err?.message ?? err).split('\n')[0]})`);
    }
    if (outcome) return finish(outcome);
    const left = deadline - now();
    if (left <= 0) return { state: 'still-queued', position };
    await sleep(Math.min(pollMs, left));
  }

  // -> null (keep watching) or a result for finish()
  async function pollOnce() {
    const r = await reconcile({ gh, root, pr, head: watched(), sleep, pollMs: Math.min(pollMs, 2000), log });
    if (r.kind === 'merged') return { state: 'merged', mergeSha: r.mergeSha };
    if (r.kind === 'closed') return { state: 'closed' };
    if (r.kind === 'head-moved') return { state: 'head-moved' };
    if (r.kind === 'removed') return { state: 'removed', removal: r.removal };
    if (r.kind === 'not-queued') return null; // not visible (yet): keep looking until the budget ends
    position = r.entry.position;
    const view = gh.prView(pr, ['state', 'labels', ...(check.fields ?? [])]);
    const problems = await check(view);
    if (problems.length === 0) return null;
    return dequeueAndConfirm(problems, view);
  }

  async function dequeueAndConfirm(problems, view) {
    try {
      gh.dequeue(pr);
    } catch (err) {
      log(`PR #${pr}: dequeue failed (${String(err?.message ?? err).split('\n')[0]}); checking whether it left anyway`);
    }
    for (let i = 0; i < CONFIRM_TRIES; i += 1) {
      let r;
      try {
        r = await reconcile({ gh, root, pr, head: watched(), sleep, pollMs: Math.min(pollMs, 2000), log });
      } catch {
        r = { kind: 'queued' }; // cannot tell: treat as still there and look again
      }
      if (r.kind === 'merged') return { state: 'merged', mergeSha: r.mergeSha, warning: 'the PR merged while it was being dequeued for a stop condition' };
      if (r.kind === 'closed') return { state: 'closed' };
      if (r.kind === 'head-moved') return { state: 'head-moved' };
      if (r.kind !== 'queued') return { state: 'blocked', problems, dequeued: true, view };
      await sleep(Math.min(pollMs, 5000));
    }
    return { state: 'blocked', problems, dequeued: false, view };
  }

  function finish(out) {
    const rec = root === undefined ? null : readQueueRecord(root, pr);
    if (out.state === 'merged') {
      if (rec) endRecord(root, pr, 'merged');
      return out;
    }
    if (out.state === 'removed') {
      if (rec) noteRemoval(root, pr, out.removal);
      return out;
    }
    if (out.state === 'blocked') {
      const { view, ...result } = out;
      // The record ends here only when the dequeue is CONFIRMED (else the entry may be live and the sweep must find the record again) and no lifted
      // needs-human label is owed back: none was lifted, or it is on the PR again (a new hold).
      const labelOn = labelNames(view?.labels).some((n) => n.toLowerCase() === 'needs-human');
      if (out.dequeued === true && rec && rec.terminal === null && (rec.hold === null || labelOn)) endRecord(root, pr, 'blocked');
      return result;
    }
    return out;
  }
}

// ---- the needs-human hold the entry owns ---------------------------------------------------------------------------------------------
// In queue mode the owner's "merge" lifts a needs-human hold and the QUEUE ENTRY (through the record), not the `P merge` process, owns it from
// the confirmed enqueue on: it stays lifted while the PR waits, and goes back once, at an unmerged terminal end. settleRecord is the ONE function
// that decides this, for the next `P merge` (recoverOrphanedLift), `P queue-sweep` and `P final-gate`'s best-effort sweep.

const msgOf = (err) => String(err?.message ?? err).split('\n')[0].slice(0, 200);
const FAILING_CONCLUSIONS = ['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure', 'stale'];

// What failed on the queue commit a removal ended: failed check runs and failed commit statuses (a status context counts once, newest first).
export function failingChecksOn(gh, sha) {
  if (typeof sha !== 'string' || sha === '') return [];
  const out = [];
  try {
    for (const c of gh.checkRunsOf(sha)) {
      if (FAILING_CONCLUSIONS.includes(c?.conclusion)) out.push(`${c.name}: ${c.conclusion}`);
    }
    const seen = new Set();
    for (const s of gh.statusesOf(sha)) {
      if (seen.has(s?.context)) continue;
      seen.add(s?.context);
      if (['failure', 'error'].includes(s?.state)) out.push(`${s.context}: ${s.state}`);
    }
  } catch (err) {
    out.push(`could not read the checks of ${sha.slice(0, 12)} (${msgOf(err)})`);
  }
  return [...new Set(out)];
}

// The hold as a later re-queue must present it to the owner-go approval check ({ id, login, at }); null when the record owns none.
export const recordedHold = (rec) => (rec?.hold ? { id: rec.hold.id, login: rec.hold.login, at: rec.hold.at } : null);

// A record with nothing in it (no attempt, no entry, no hold) is dropped: there is nothing left to settle and a leftover "ended" one would
// make the next plain `P merge` of the same head ask for a fresh owner word (Fable F10).
export function removeRecord(root, pr) {
  rmSync(queueRecordPath(root, pr), { force: true });
}

// Puts needs-human back, once. -> { status: 'restored' | 'already-on' | 'merged' | 'failed', why? }. A label that is ON already is a NEW hold
// (the owner's lifted one is gone for good) and is left alone; a merged PR gets nothing.
export function restoreHoldLabel({ gh, pr }) {
  let view = null;
  try {
    view = gh.prView(pr, ['state', 'labels']);
  } catch { /* unreadable: try the add; it is idempotent on GitHub's side */ }
  if (view?.state === 'MERGED') return { status: 'merged' };
  if (view && validLabels(view.labels) && labelNames(view.labels).some((n) => n.toLowerCase() === HOLD_LABEL)) return { status: 'already-on' };
  try {
    gh.addLabels(pr, [HOLD_LABEL]);
    return { status: 'restored' };
  } catch (err) {
    return { status: 'failed', why: msgOf(err) };
  }
}

// Decides what happens to ONE live record, now. Under the PR's merge lock (callers take it). One reconcile with GitHub, then:
//   merged       -> record ends merged; the lifted label stays off.
//   queued       -> the entry is adopted (pending / session -> entry); a live stop condition (needs-human, pipeline-blocked, pause / rollback
//                   issue) dequeues with a confirmed look (watchQueue); otherwise nothing changes.
//   removed      -> noted once. A group-check removal with a re-queue left: no `requeue` given => { outcome: 'requeue-due' } and NOTHING changes
//                   (the hold stays lifted); `requeue` given => it runs (the caller's recheck + enqueue) and { outcome: 'requeued' } when it took.
//                   Anything else is terminal: the owned hold goes back and the record ends.
//   closed / head-moved / an attempt that never reached GitHub -> terminal as well.
//   unreadable   -> { outcome: 'unsettled' }: nothing restored, nothing ended (fail closed).
// Options: `requeue({ rec, removal })` -> { ok: true } | { ok: false, kind?: 'blocked', reasons } (4b: only from a live worktree; final-gate never passes it);
// `notify(text)` is called once per terminal outcome; `blockers` is the stop-condition check (default: today's waitBlockers).
// Returns { outcome, rec, ... }: outcome is one of none | idle | merged | queued | requeue-due | requeued | ended | restore-failed | unsettled.
export async function settleRecord({ gh, root, pr, now = Date.now, sleep = defaultSleep, pollMs = 2000, log = () => {}, requeue = null, notify = null, blockers = null, restore = restoreHoldLabel }) {
  let rec = readQueueRecord(root, pr);
  if (rec === null || rec.terminal !== null) return { outcome: 'none', rec };
  const say = (text) => {
    try { notify?.(text); } catch { /* a notification failure must not undo a settled record */ }
  };

  // An unmerged end: the owned hold goes back (not when a label is on already = a new hold), then the record ends. A restore that fails
  // keeps the record open, so the next settle tries again.
  const finish = (kind, message, extra = {}) => {
    const cur = readQueueRecord(root, pr);
    let hold = 'none';
    if (cur.terminal === null && cur.hold !== null) {
      const res = restore({ gh, pr });
      if (res.status === 'failed') return { outcome: 'restore-failed', terminal: kind, why: res.why, rec: cur, ...extra };
      if (res.status === 'merged') {
        endRecord(root, pr, 'merged', { now });
        return { outcome: 'merged', mergeSha: null, rec: readQueueRecord(root, pr) };
      }
      hold = res.status;
    }
    if (cur.terminal === null) endRecord(root, pr, kind, { now });
    const text = `PR #${pr} ${message}${hold === 'restored' ? `; needs-human is back on it (${RESTORE_NOTE})` : ''}`;
    say(text);
    return { outcome: 'ended', terminal: kind, hold, message: text, rec: readQueueRecord(root, pr), ...extra };
  };
  const mergedOut = (mergeSha, warning) => {
    endRecord(root, pr, 'merged', { now });
    say(`PR #${pr} merged through the merge queue`);
    return { outcome: 'merged', mergeSha: mergeSha ?? null, ...(warning ? { warning } : {}), rec: readQueueRecord(root, pr) };
  };

  const gone = async (removal) => {
    rec = readQueueRecord(root, pr);
    const last = removal ?? rec.removals[rec.removals.length - 1] ?? null;
    if (last !== null) {
      const failing = failingChecksOn(gh, last.beforeCommit);
      const what = `was removed from the merge queue (reason ${last.reason ?? 'unknown'})${failing.length > 0 ? `; failing: ${failing.join(', ')}` : ''}`;
      if (mayRequeue(rec, rec.head, last.reason)) {
        if (typeof requeue !== 'function') return { outcome: 'requeue-due', removal: last, rec };
        const out = await requeue({ rec, removal: last });
        if (out?.ok) return { outcome: 'requeued', removal: last, rec: readQueueRecord(root, pr) };
        // The enqueue went out but GitHub could not be read to confirm it: the entry may be live, so nothing is restored or ended.
        if (out?.unsettled) return { outcome: 'unsettled', removal: last, rec: readQueueRecord(root, pr), why: (out.reasons ?? ['the re-queue could not be confirmed']).join('; ') };
        return finish(out?.kind === 'blocked' ? 'blocked' : 'removed', `${what} once and was not re-queued: ${(out?.reasons ?? ['the re-queue was not allowed']).join('; ')}`, { removal: last, failing });
      }
      return finish('removed', `${what}${rec.removals.length > 1 ? ' after one automatic re-queue' : ''}`, { removal: last, failing });
    }
    if (rec.attempts === 0 && rec.entryIds.length === 0) {
      if (rec.hold !== null) return finish('removed', 'never reached the merge queue');
      removeRecord(root, pr);
      return { outcome: 'idle', rec: null };
    }
    return { outcome: 'unsettled', rec, why: 'GitHub shows no queue entry and no removal for an attempt the record counts' };
  };

  const fromWatch = async (w) => {
    if (w.state === 'merged') return mergedOut(w.mergeSha, w.warning);
    if (w.state === 'closed') return finish('closed', 'was closed without merging');
    if (w.state === 'head-moved') return finish('head-moved', `head moved off the approved ${rec.head.slice(0, 12)}`);
    if (w.state === 'removed') return gone(w.removal);
    if (w.state === 'blocked') {
      if (w.dequeued === false) return { outcome: 'unsettled', rec: readQueueRecord(root, pr), why: `a stop condition appeared (${(w.problems ?? []).join('; ')}) but the dequeue is not confirmed` };
      return finish('blocked', `was dequeued: ${(w.problems ?? []).join('; ')}`, { problems: w.problems ?? [] });
    }
    return { outcome: 'queued', rec: readQueueRecord(root, pr), position: w.position ?? null };
  };

  let r;
  try {
    r = await reconcile({ gh, root, pr, head: rec.head, sleep, pollMs, log });
  } catch (err) {
    return { outcome: 'unsettled', rec, why: `could not read the merge queue (${msgOf(err)})` };
  }
  rec = readQueueRecord(root, pr);
  switch (r.kind) {
    case 'merged': return mergedOut(r.mergeSha, r.mergeSha ? undefined : 'GitHub did not report the merge commit');
    case 'closed': return finish('closed', 'was closed without merging');
    case 'head-moved': return finish('head-moved', `head moved off the approved ${rec.head.slice(0, 12)}`);
    case 'removed':
      noteRemoval(root, pr, r.removal);
      return gone(r.removal);
    case 'not-queued': return gone(null);
    default: break;
  }
  // queued: adopt the entry, then look at the stop conditions.
  if (rec.pending !== null || rec.hold?.owner === 'session' || rec.hold?.owner === 'pending' || !rec.entryIds.includes(r.entry.id)) confirmAttempt(root, pr, r.entry.id);
  const check = blockers ?? waitBlockers(gh, { base: null });
  let problems;
  try {
    problems = await check(gh.prView(pr, ['state', 'labels', ...(check.fields ?? [])]));
  } catch (err) {
    return { outcome: 'queued', rec: readQueueRecord(root, pr), position: r.entry.position ?? null, note: `the stop conditions could not be read (${msgOf(err)})` };
  }
  if (problems.length === 0) return { outcome: 'queued', rec: readQueueRecord(root, pr), position: r.entry.position ?? null };
  return fromWatch(await watchQueue({ gh, root, pr, head: rec.head, budgetMs: 0, pollMs, blockers: check, now, sleep, log }));
}

// A signal reached `P merge` while a lifted hold is on the record: may this process put the label back? Synchronous (a signal handler cannot
// wait). -> { restore: boolean, done?: () => void }. No record or hold, or `session` (no enqueue started): yes, as today. `entry`: no, the
// entry owns it. `pending` (the enqueue may or may not have landed): ONE bounded look (<= budgetMs): queued at the head => owner 'entry', no
// restore; confirmed not queued => restore (`done` then drops the unused hold); unreadable, out of time, or any other answer => nothing is
// restored and the record stays as it is, for the next `P merge` / the sweep.
export function holdOnSignal({ gh, root, pr, budgetMs = 10_000, retryMs = 1500, now = Date.now, sleepSync = defaultSleepSync }) {
  let rec;
  try {
    rec = readQueueRecord(root, pr);
  } catch {
    return { restore: false };
  }
  const dropHold = () => { try { clearSessionHold(root, pr); } catch { /* the sweep ends an idle record */ } };
  if (rec === null || rec.terminal !== null || rec.hold === null) return { restore: true };
  if (rec.hold.owner === 'session') return { restore: true, done: dropHold };
  if (rec.hold.owner === 'entry') return { restore: false };
  const deadline = now() + budgetMs;
  for (;;) {
    try {
      const r = reconcileNow({ gh, root, pr, head: rec.pending?.head ?? rec.head });
      if (r.kind === 'queued') {
        confirmAttempt(root, pr, r.entry.id);
        return { restore: false };
      }
      if (r.kind === 'not-queued') {
        const cur = readQueueRecord(root, pr);
        // reconcileNow dropped the pending attempt (nothing was queued). A record that still shows an attempt had an older entry: leave it to the sweep.
        return cur.attempts === 0 && cur.entryIds.length === 0 ? { restore: true, done: dropHold } : { restore: false };
      }
      return { restore: false }; // merged / removed / closed / head moved: the sweep settles it
    } catch { /* unreadable: look again while there is time */ }
    if (deadline - now() <= retryMs) return { restore: false };
    sleepSync(retryMs);
  }
}

function defaultSleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// The process put a lifted hold back itself, so the record no longer carries it (only a `session` hold: an `entry` / `pending` one is the record's).
export function clearSessionHold(root, pr) {
  const rec = readQueueRecord(root, pr);
  if (rec !== null && rec.terminal === null && rec.hold !== null && rec.hold.owner === 'session') setHold(root, pr, null);
}

// Does the record (not a running process) own a lifted hold right now? True for an `entry` or `pending` owner; `session` (no enqueue
// started) is the process's own to restore.
export function recordOwnsHold(root, pr) {
  const rec = readQueueRecord(root, pr);
  return rec !== null && rec.terminal === null && rec.hold !== null && rec.hold.owner !== 'session';
}

// ---- no record (Fable F3) ---------------------------------------------------------------------------------------------------------
// `recoverOrphanedLift` found a lift comment, the label gone and the PR open. In queue mode the answer comes from GitHub BEFORE anything is
// disabled or restored: -> { action: 'proceed' | 'refuse' | 'today', ... }.
//   proceed : this clone's record owns it and the run may go on (watch it, re-queue it, or report the merge).
//   refuse  : { error, reasons, extra } (an unmerged end whose hold is back, a restore that failed, an entry elsewhere, a queue that cannot be read).
//   today   : nothing is queued: the caller's own recovery (disarm auto-merge, put the label back) applies.
// A live entry at the lift comment's head with no usable record here (another clone, machine, or a pruned dir): a record is written from the
// comment (owner 'entry'), nothing is restored, auto-merge is never disabled, and the run is refused `queued-elsewhere` (the sweep owns it now).
export async function recoverQueuedLift({ gh, root, pr, orphan, lift, now = Date.now, sleep = defaultSleep, pollMs = 2000, log = () => {}, notify = null }) {
  const unreadable = (what, err) => ({ action: 'refuse', error: 'hold-recovery', reasons: [`#${pr}: ${what} (${msgOf(err)}): nothing was changed, and auto-merge was not touched`], extra: { queue: true, queued: null } });
  let rec;
  try {
    rec = readQueueRecord(root, pr);
  } catch (err) {
    return unreadable('the merge-queue record could not be read', err);
  }
  if (rec !== null && rec.terminal === null && rec.hold !== null) {
    let out;
    try {
      out = await settleRecord({ gh, root, pr, now, sleep, pollMs, log, notify });
    } catch (err) {
      return unreadable('the merge-queue record could not be settled', err);
    }
    switch (out.outcome) {
      case 'merged': case 'queued': case 'requeue-due': case 'requeued': return { action: 'proceed' };
      case 'ended':
        return { action: 'refuse', error: 'hold-recovery', reasons: [`#${pr}: an earlier \`P merge --owner-go\` lifted needs-human hold ${orphan.hold} and queued the PR; ${out.message}. Nothing was merged`], extra: { queue: true, queued: false, holdRestored: out.hold === 'restored', ...(out.hold === 'restored' ? { holdRestoredNote: RESTORE_NOTE } : {}) } };
      case 'restore-failed':
        return { action: 'refuse', error: 'hold-restore', reasons: [`COULD NOT put needs-human back on PR #${pr} (${out.why}): an earlier --owner-go run lifted hold ${orphan.hold} and the PR left the merge queue unmerged. Add the label by hand; nothing was merged`], extra: { queue: true, holdRestored: false, holdRestoreFailed: true } };
      default: return unreadable('the merge queue state could not be settled', out.why ?? out.outcome);
    }
  }
  const head = lift?.head;
  if (typeof head !== 'string' || !FULL_SHA.test(head)) return unreadable('the lift comment names no head, so the merge queue cannot be checked', 'no head');
  let r;
  try {
    r = await reconcile({ gh, root, pr, head, sleep, pollMs, log });
  } catch (err) {
    return unreadable('the merge queue state could not be read', err);
  }
  if (r.kind === 'merged') return { action: 'proceed' };
  if (r.kind !== 'queued') return { action: 'today' };
  try {
    const repo = gh.repo().slug;
    const repoId = typeof gh.repoId === 'function' ? gh.repoId() : null;
    openRecord(root, pr, head, { items: lift.items ?? null, areas: null, rulings: null }, { repo, repoId, now, route: 'owner-go' });
    setHold(root, pr, { id: orphan.hold, login: lift.login ?? null, at: lift.at ?? null, holdBlock: lift.login && lift.at ? holdDigest({ id: orphan.hold, login: lift.login, at: lift.at }) : null, liftedAt: isoOf(now) });
    beginAttempt(root, pr, head, { items: lift.items ?? null, areas: null, rulings: null }, { repo, repoId, now, gh });
    confirmAttempt(root, pr, r.entry.id);
  } catch (err) {
    return unreadable('the merge-queue record could not be written', err);
  }
  return { action: 'refuse', error: 'queued-elsewhere', reasons: [`PR #${pr} is already in the merge queue at ${head.slice(0, 12)}: an earlier \`P merge --owner-go\` (another checkout or machine) lifted needs-human hold ${orphan.hold} and queued it. A record is kept here now and \`P queue-sweep\` settles it (merge, or put the label back if it leaves unmerged); nothing was changed and auto-merge was not touched`], extra: { queue: true, queued: true } };
}

// ---- F7: the guards re-run after a hold lift ----------------------------------------------------------------------------------------
// Removing needs-human fires `pull_request_target: unlabeled`, so pipeline-guards.yml posts the three guard statuses as `pending` again. Enqueueing
// then would make the queue poster read `pending` and spend the one re-queue. Waits (up to `waitMs`) until none of them is pending, then they must
// be green with the same provenance as before. -> [] when settled green, else the reasons to refuse (the caller puts the hold back).
export async function settleGuardStatuses({ gh, pr, head, waitMs, pollMs, now = Date.now, sleep = defaultSleep, provenance = forgedGuards }) {
  const deadline = now() + waitMs;
  let why = 'the checks were not read';
  for (;;) {
    let rows = null;
    try {
      rows = gh.checks(pr);
      if (!Array.isArray(rows)) throw new Error('the checks reply is not a list');
    } catch (err) {
      why = `could not read the checks (${msgOf(err)})`;
      rows = null;
    }
    if (rows !== null) {
      const guards = rows.filter((r) => PROVENANCE_CHECKS.includes(r?.name));
      const pending = guards.filter((r) => r.bucket === 'pending');
      if (pending.length === 0) {
        const bad = guards.filter((r) => r.bucket !== 'pass');
        if (bad.length > 0) return [`guard check(s) not passing after the hold lift re-ran them: ${bad.map((r) => `${r.name}=${r.bucket ?? r.state}`).join(', ')}`];
        const forged = guards.length > 0 ? provenance({ gh, pr, head, names: guards.map((r) => r.name) }) : [];
        return forged.length > 0 ? [`guard status not posted by the pipeline-guards workflow: ${forged.join('; ')}`] : [];
      }
      why = `guard check(s) still pending: ${pending.map((r) => r.name).join(', ')}`;
    }
    const left = deadline - now();
    if (left <= 0) return [`${why} after ${Math.round(waitMs / 1000)} s: lifting the hold re-runs the guards; run again once they have finished`];
    await sleep(Math.min(pollMs, left));
  }
}
