// Merge queue ("queue mode"): when GitHub says a PR's base requires a merge queue, the pipeline enqueues the approved head and GitHub
// merges it after testing it on top of the base. Queue mode is never configured: it is read live from GitHub on every call, so turning
// the queue off restores the direct-merge path by itself, and an unreadable queue refuses (never falls back to a direct merge).
// This file holds the live detection and the pure helpers; the record, reconciliation and watcher are added below by later tasks.

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
