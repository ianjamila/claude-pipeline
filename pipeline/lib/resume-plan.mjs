// `ship resume <pr>`: where does a stalled run pick up? Plain facts in, a plan out. No IO, no gh, no git, no clock reads:
// `P resume plan` gathers the facts and injects `now`. Plan: docs/plans/2026-10-12-ship-inbox-resume-plan.md, section E.
//
// facts = {
//   state: 'OPEN' | 'CLOSED' | 'MERGED', isCrossRepository, labels[], liveHead, autoMergeArmed, host (this machine),
//   recordStatus: ok | absent | legacy | unsupported | invalid | mismatch, record (decoded, bound to this PR) | null,
//   triage: null | { rounds, lastRound, lastRoundComplete, lastContentHash, clean (items only), followupsPending },
//   contentHash: the live head's review hash | null (unknown), needsHumanReason, events: [{kind}],
//   local: null (unknown / not asked) | { state: none|equal|ahead|behind|diverged|unknown, localRef, unpushed, dirty, worktrees: [{path, dirty}] },
// }
// Resume never merges and never rolls production back: every route that reaches `gate` ends at the owner-merge stop, and
// `observe-prod` only watches.

const MINUTE = 60000;

// Routes the skill acts on; the rest only report.
const REPORT_ONLY = new Set(['closed', 'ended', 'not-resumable', 'decision']);
const NO_RECORD = new Set(['absent', 'legacy', 'invalid', 'unsupported', 'mismatch']);

const firstSentence = (s) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  const m = /^(.*?[.!?])(\s|$)/.exec(t);
  return (m ? m[1] : t).slice(0, 200);
};

// The record may hold an abbreviated head; compare as a prefix (at least 7 characters) either way round.
const sameSha = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length >= 7 && b.length >= 7 && (a.startsWith(b) || b.startsWith(a));

const ageMinutes = (iso, nowMs) => {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : Math.max(0, Math.round((nowMs - ms) / MINUTE));
};

// A command the record says is still running: inside its own time budget (any host). A missing budget falls back to the
// heartbeat window rather than "never expires".
function liveInFlight(record, nowMs, fallbackMinutes) {
  const f = record?.inFlight;
  if (!f) return null;
  const started = Date.parse(f.startedAt);
  if (Number.isNaN(started)) return null;
  const budget = Number.isFinite(Number(f.maxMinutes)) && Number(f.maxMinutes) > 0 ? Number(f.maxMinutes) : fallbackMinutes;
  // a start in the future (clock skew) counts as just started
  return nowMs - started <= budget * MINUTE ? { ...f, minutesAgo: Math.max(0, Math.round((nowMs - started) / MINUTE)) } : null;
}

function routeMerged(facts, record) {
  const rollbackOpen = facts.events.some((e) => e.kind === 'rollback-intent') && !facts.events.some((e) => e.kind === 'rollback-result');
  const midMerge = facts.recordStatus === 'ok' && record != null && record.outcome == null && (record.step === 'merge' || record.step === 'prod-watch');
  if (!rollbackOpen && !midMerge) {
    return { enter: 'ended', reason: record?.outcome ? `already merged; the run ended ${record.outcome}` : 'already merged; nothing left to resume' };
  }
  const notes = [];
  if (rollbackOpen) notes.push('a rollback may have been in progress (rollback-intent without rollback-result): compare the live deployment with the rollback target and report; do not roll back');
  notes.push('run from a detached worktree of origin/<base> at the merge commit');
  notes.push('observe only: never roll production back from a resumed run');
  return {
    enter: 'observe-prod',
    reason: rollbackOpen
      ? 'merged, and a rollback was started but its result was never recorded'
      : `merged, but the run stopped in the ${record.step} step before production was confirmed`,
    notes,
  };
}

// The review route for an open PR whose build is done: review, followups or gate.
function routeReview(facts) {
  const t = facts.triage;
  if (!t) return { enter: 'review', reason: 'no review state: never reviewed' };
  if (facts.labels.includes('awaiting-review') || facts.record?.outcome === 'awaiting-review') {
    return { enter: 'review', reason: 'awaiting-review: the cross-model review was postponed' };
  }
  if (!t.lastRoundComplete) return { enter: 'review', reason: `review round ${t.lastRound} is incomplete` };
  const changed = facts.contentHash != null && t.lastContentHash != null && facts.contentHash !== t.lastContentHash;
  if (changed) return { enter: 'review', reason: `content changed since the last reviewed round (round ${t.lastRound})` };
  if (!t.clean) return { enter: 'review', reason: `review round ${t.lastRound} is not clean` };
  if (t.followupsPending) return { enter: 'followups', reason: 'published review follow-ups have no issue yet' };
  return { enter: 'gate', reason: 'reviewed and clean: run the gate again, then stop for the owner\'s "merge"' };
}

function route(facts, record) {
  if (facts.state === 'CLOSED') return { enter: 'closed', reason: 'the PR is closed without a merge' };
  if (facts.state === 'MERGED') return routeMerged(facts, record);
  if (facts.isCrossRepository) return { enter: 'not-resumable', reason: 'fork PR: the pipeline cannot push to or resume it' };

  const l = facts.local;
  if (l && (l.state === 'diverged' || l.dirty > 0)) {
    const where = l.worktrees?.find((w) => w.dirty > 0)?.path ?? l.worktrees?.[0]?.path ?? `refs/heads/<branch>`;
    return {
      enter: 'local-work',
      reason: l.state === 'diverged'
        ? `the local branch diverged from the PR (${l.unpushed} local commit${l.unpushed === 1 ? '' : 's'} the PR lacks): the owner decides`
        : `uncommitted work in ${where}: commit or stash it first`,
    };
  }
  if (facts.labels.includes('needs-human')) {
    return { enter: 'decision', reason: firstSentence(facts.needsHumanReason) || 'needs-human label set (no reason recorded)' };
  }

  if (record) {
    const open = (record.tasks ?? []).filter((t) => t.done !== true);
    if (open.length > 0) {
      return { enter: 'build', reason: `${open.length} of ${record.tasks.length} task${record.tasks.length === 1 ? '' : 's'} not done (next: ${open[0].title || open[0].id})` };
    }
    const v = record.verify;
    const verifiedHead = Boolean(v) && sameSha(v.head, facts.liveHead) && v.ok === true;
    const reachedVerify = record.step === 'build' || record.step === 'verify' || record.outcome === 'blocked';
    if (!verifiedHead && reachedVerify) {
      return { enter: 'verify', reason: v && v.ok === false && sameSha(v.head, facts.liveHead) ? `verify failed for this head${v.failedStep ? ` at ${v.failedStep}` : ''}` : 'no passing verify recorded for this head' };
    }
  }
  return routeReview(facts);
}

// Reuse a worktree that already holds the branch; else check out the existing local ref; else make the branch from origin.
// Never `worktree add -B`: that would reset unpushed work. `then` brings the checkout level with the PR head.
function planWorktree(enter, facts, notes) {
  if (REPORT_ONLY.has(enter) || enter === 'observe-prod' || enter === 'local-work') return { action: 'none' };
  const l = facts.local;
  let worktree;
  if (!l) {
    notes.push('local branch state unavailable: not compared with the PR head');
    worktree = { action: 'add-from-remote' };
  } else if (l.worktrees?.length > 0) {
    worktree = { action: 'reuse', path: l.worktrees[0].path };
  } else if (l.state !== 'none') {
    worktree = { action: 'add-existing-ref' };
  } else {
    worktree = { action: 'add-from-remote' };
  }
  if (l?.state === 'behind') worktree.then = 'ff-only';
  else if (l?.state === 'ahead') worktree.then = 'push';
  else if (l?.state === 'unknown') notes.push('the PR head is not in this clone: git fetch origin before comparing the local branch');
  if (worktree.then === 'push') notes.push(`${l.unpushed} commit${l.unpushed === 1 ? '' : 's'} exist only on this machine: push them (no force) before resuming`);
  return worktree;
}

export function planResume(facts, { now, heartbeatFreshMinutes = 90 } = {}) {
  const f = { ...facts, labels: facts.labels ?? [], events: facts.events ?? [] };
  const nowMs = new Date(now).getTime();
  const record = f.recordStatus === 'ok' ? (f.record ?? null) : null;
  const picked = route({ ...f, record }, record);
  const enter = picked.enter;
  const notes = [...(picked.notes ?? [])];

  if (f.recordStatus === 'unsupported') notes.push('the run record comes from a newer pipeline version: update the CLI before this run writes one');
  if (f.recordStatus === 'invalid') notes.push('the run record could not be read: treated as no record');
  if (f.recordStatus === 'mismatch') notes.push('the run record belongs to another PR or branch: treated as no record');
  if (f.recordStatus === 'legacy') notes.push('legacy summary, pre-record CLI: no run record');

  const noRecord = f.state === 'OPEN' && !f.isCrossRepository && NO_RECORD.has(f.recordStatus) && !REPORT_ONLY.has(enter);
  if (noRecord && f.triage) notes.push('no run record, but a published review state exists: the review resumes from it, not from round 1');
  if (enter === 'review' && f.triage && f.contentHash == null) notes.push('the live content hash is unavailable: review freshness not checked');

  // Who might still be running this?
  let confirm = null;
  const flight = liveInFlight(record, nowMs, heartbeatFreshMinutes);
  const hb = record?.heartbeat;
  const hbAge = hb ? ageMinutes(hb.at, nowMs) : null;
  if (!REPORT_ONLY.has(enter)) {
    if (flight) {
      confirm = { host: flight.host, step: record.step, minutesAgo: flight.minutesAgo, why: `a ${flight.kind} command is still inside its time budget (max ${flight.maxMinutes ?? heartbeatFreshMinutes} min)` };
    } else if (hb && hbAge !== null && hb.host !== f.host && hbAge < heartbeatFreshMinutes) {
      confirm = { host: hb.host, step: record.step, minutesAgo: hbAge, why: `the last heartbeat came from another machine ${hbAge} min ago` };
    }
  }

  // A queued auto-merge is an unattended merge: resume disarms it unless a live merge of this run owns it.
  const liveMerge = flight?.kind === 'merge';
  const autoMerge = f.state === 'OPEN' && f.autoMergeArmed === true && !liveMerge ? { armed: true, action: 'disarm' } : null;
  if (autoMerge) notes.push('auto-merge is armed on this PR with no live merge of this run: disarm it and report');

  const worktree = planWorktree(enter, f, notes);
  return { enter, reason: picked.reason, adopt: noRecord, confirm, autoMerge, worktree, notes };
}
