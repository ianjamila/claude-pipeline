// Merge queue ("queue mode"): when GitHub says a PR's base requires a merge queue, the pipeline enqueues the approved head and GitHub
// merges it after testing it on top of the base. Queue mode is never configured: it is read live from GitHub on every call, so turning
// the queue off restores the direct-merge path by itself, and an unreadable queue refuses (never falls back to a direct merge).
// This file holds the live detection and the pure helpers, the durable per-PR record, reconciliation with GitHub and the watcher.
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readRepoMoves, sameRepo } from '../hooks/lib/repo-moves.mjs';
import { labelNames, readMergeSha, waitBlockers } from './finalgate.mjs';
import { gitCommonDir } from './repo.mjs';

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
export function openRecord(root, pr, head, approval, { repo = null, repoId = null, now = Date.now } = {}) {
  const old = readQueueRecord(root, pr);
  if (old !== null && old.terminal === null && old.head === head) return old;
  return writeRecord(root, {
    pr: Number(pr), repo, repoId, root, head,
    approval: { items: approval?.items ?? null, areas: approval?.areas ?? null, rulings: approval?.rulings ?? null },
    createdAt: isoOf(now), attempts: 0, pending: null, entryIds: [], removals: [], hold: null, terminal: null, terminalAt: null,
  });
}

// Written BEFORE the enqueue mutation, so a crash between the mutation and the confirm still counts the attempt.
export function beginAttempt(root, pr, head, approval, opts = {}) {
  const now = opts.now ?? Date.now;
  openRecord(root, pr, head, approval, opts);
  return mutate(root, pr, (rec) => {
    rec.attempts += 1;
    rec.pending = { head, at: isoOf(now) };
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
// A removal belongs to a PENDING attempt only if its enqueue happened after the attempt began (allowing for clock difference with GitHub).
const CLOCK_SLACK_MS = 60_000;

// Where does GitHub say the PR is, compared with what the record expects?
//   merged / queued / removed / not-queued / head-moved / closed
// A removal counts only when it comes after the LAST `added` event, by timeline order (timestamps tie). A removal with reason `merged`
// (GitHub emits one on every successful merge) reads as merged. A `pending` attempt that GitHub shows as not queued never happened: it is
// dropped from the count (the enqueue failed, or died before it landed). Changes the record in that one case only.
export async function reconcile({ gh, root, pr, head, sleep = defaultSleep, pollMs = 2000, log = () => {} }) {
  const state = gh.queueState(pr);
  if (state.state === 'MERGED') return { kind: 'merged', mergeSha: await readMergeSha({ gh, pr, first: state.mergeSha, sleep, pollMs }) };
  if (state.state === 'CLOSED') return { kind: 'closed' };
  if (state.head !== head) return { kind: 'head-moved', head: state.head };
  if (state.entry) return { kind: 'queued', entry: state.entry };
  const rec = root === undefined ? null : readQueueRecord(root, pr);
  const events = gh.queueEvents(pr);
  const lastAdded = events.map((e) => e.type).lastIndexOf('added');
  const after = lastAdded === -1 ? [] : events.slice(lastAdded + 1);
  const mergedAt = after.find((e) => e.type === 'merged' || (e.type === 'removed' && e.reason === REASON_MERGED));
  const ours = rec?.pending ? Date.parse(events[lastAdded]?.at) >= Date.parse(rec.pending.at) - CLOCK_SLACK_MS : true;
  if (mergedAt && ours) {
    const sha = mergedAt.beforeCommit && FULL_SHA.test(mergedAt.beforeCommit) ? mergedAt.beforeCommit : await readMergeSha({ gh, pr, first: null, sleep, pollMs });
    return { kind: 'merged', mergeSha: sha };
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
export async function watchQueue({ gh, root, pr, head, budgetMs, pollMs = 90_000, blockers = null, now = Date.now, sleep = defaultSleep, log = () => {} }) {
  const check = blockers ?? waitBlockers(gh, { base: null });
  const deadline = now() + budgetMs;
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
    const r = await reconcile({ gh, root, pr, head, sleep, pollMs: Math.min(pollMs, 2000), log });
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
        r = await reconcile({ gh, root, pr, head, sleep, pollMs: Math.min(pollMs, 2000), log });
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
      // The record ends here only when no lifted needs-human label is owed back: none was lifted, or it is on the PR again (a new hold).
      const labelOn = labelNames(view?.labels).some((n) => n.toLowerCase() === 'needs-human');
      if (rec && rec.terminal === null && (rec.hold === null || labelOn)) endRecord(root, pr, 'blocked');
      return result;
    }
    return out;
  }
}
