// `ship inbox` classifier: plain facts in, plain classification out. No IO, no gh, no git, no clock reads —
// the caller gathers the facts and injects `now`. Plan: docs/plans/2026-10-12-ship-inbox-resume-plan.md, section F.

const MINUTE = 60000;
const DAY = 86400000;

// ---- CI ---------------------------------------------------------------------------------------

const CHECK_PASS = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
const CHECK_FAIL = new Set(['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE']);

// 'pass' | 'fail' | 'pending' for one CheckRun or StatusContext row. Anything unknown (STALE, a new GitHub
// conclusion, a missing field) is pending: never a guess in either direction.
function rowVerdict(row) {
  if (row.state !== undefined && row.status === undefined) {
    if (row.state === 'SUCCESS') return 'pass';
    if (row.state === 'FAILURE' || row.state === 'ERROR') return 'fail';
    return 'pending';
  }
  if (row.status !== 'COMPLETED') return 'pending';
  if (CHECK_PASS.has(row.conclusion)) return 'pass';
  if (CHECK_FAIL.has(row.conclusion)) return 'fail';
  return 'pending';
}

export function ciStatus(contexts, requiredNames) {
  const latest = new Map();
  for (const row of Array.isArray(contexts) ? contexts : []) {
    const name = row?.name ?? row?.context;
    if (typeof name !== 'string' || name === '') continue;
    latest.set(name, rowVerdict(row)); // input is oldest first, so a later row replaces an earlier one
  }
  const required = Array.isArray(requiredNames) ? requiredNames : [];
  const verdicts = required.length > 0 ? required.map((n) => latest.get(n) ?? 'pending') : [...latest.values()];
  if (verdicts.length === 0) return 'incomplete';
  if (verdicts.includes('fail')) return 'failed';
  return verdicts.every((v) => v === 'pass') ? 'passed' : 'incomplete';
}

// ---- last activity ----------------------------------------------------------------------------

export function lastActivity(parts, now) {
  const nowMs = new Date(now).getTime();
  const p = parts ?? {};
  const candidates = [
    ['commit', [p.commitDate]],
    ['comment', p.commentUpdatedAts ?? []],
    ['review', p.reviewDates ?? []],
    ['created', [p.createdAt]],
  ];
  let best = null;
  for (const [kind, values] of candidates) {
    for (const v of values) {
      if (typeof v !== 'string') continue;
      let ms = Date.parse(v);
      if (Number.isNaN(ms)) continue;
      if (ms > nowMs) ms = nowMs;
      if (best === null || ms > best.ms) best = { ms, kind }; // ties keep the earlier kind in the list above
    }
  }
  return best === null ? { at: null, kind: null } : { at: new Date(best.ms).toISOString(), kind: best.kind };
}

// ---- classification ---------------------------------------------------------------------------

const SUGGEST = {
  'nothing-left': 'close',
  running: 'leave',
  'owner-decision': 'leave',
  'failing-check': 'resume',
  review: 'resume',
  'owner-merge': 'merge',
  pipeline: 'resume',
  abandoned: 'close',
};

const NEVER_GATED_STEPS = new Set(['build', 'verify', 'pr']);

const day = (iso) => iso.slice(0, 10);
const minutesAgo = (iso, nowMs) => Math.max(0, Math.round((nowMs - Date.parse(iso)) / MINUTE));
const sha7 = (s) => String(s ?? '').slice(0, 7);

// The live run, if any: { host, at } — a fresh heartbeat or an in-flight command still inside its budget.
function liveRun(record, nowMs, freshMinutes) {
  if (!record) return null;
  const f = record.inFlight;
  if (f) {
    const started = Date.parse(f.startedAt);
    if (!Number.isNaN(started) && nowMs - started <= (Number(f.maxMinutes) || 0) * MINUTE) {
      return { host: f.host, at: f.startedAt };
    }
  }
  const h = record.heartbeat;
  if (h) {
    const at = Date.parse(h.at);
    // A heartbeat from the future (clock skew) is as fresh as it gets; an unparsable one proves nothing.
    if (!Number.isNaN(at) && nowMs - at < freshMinutes * MINUTE) return { host: h.host, at: h.at };
  }
  return null;
}

function reviewReasons(f) {
  const reasons = [];
  const awaiting = f.labels.includes('awaiting-review') || f.record?.outcome === 'awaiting-review';
  if (awaiting) reasons.push('awaiting review');
  const t = f.triage;
  if (t) {
    if (f.contentHash != null && t.lastContentHash != null && f.contentHash !== t.lastContentHash) {
      reasons.push(`content changed since the last reviewed round (round ${t.lastRound})`);
    }
    if (!t.clean) reasons.push(`last review round (${t.lastRound}) was not clean`);
    if (t.followupsPending) reasons.push('review follow-ups pending');
  }
  return reasons;
}

function failingReasons(f) {
  const reasons = [];
  if (f.ci === 'failed') reasons.push('a required CI check failed');
  if (f.conflicts === true) reasons.push('merge conflicts with the base branch');
  if (f.labels.includes('pipeline-blocked')) reasons.push('pipeline-blocked label set');
  const v = f.record?.verify;
  if (v && v.ok === false && v.head === f.headRefOid) {
    reasons.push(`verify failed for this head${v.failedStep ? ` at ${v.failedStep}` : ''}`);
  }
  return reasons;
}

export function classifyPr(facts, options) {
  const f = { ...facts, labels: facts.labels ?? [] };
  const { staleDays, now, ownerApproval, heartbeatFreshMinutes = 90 } = options;
  const nowMs = new Date(now).getTime();
  const n = f.number;
  const resume = `ship resume ${n}`;

  const activity = lastActivity(f.activity, now);
  const stale = activity.at !== null && nowMs - Date.parse(activity.at) >= staleDays * DAY;
  const record = f.record ?? null;

  let waitingOn;
  let reason;
  let nextAction;

  const untracked = f.recordStatus === 'absent' && !record && !f.triage;
  const live = liveRun(record, nowMs, heartbeatFreshMinutes);
  const failing = failingReasons(f);
  const reviewing = reviewReasons(f);

  if (f.alreadyOnBase === true) {
    waitingOn = 'nothing-left';
    reason = 'the head is already on the base branch';
    nextAction = 'close';
  } else if (live) {
    waitingOn = 'running';
    reason = `a run is live on ${live.host}`;
    nextAction = `leave: running on ${live.host}, ${minutesAgo(live.at, nowMs)} min ago`;
  } else if (f.labels.includes('needs-human')) {
    waitingOn = 'owner-decision';
    if (ownerApproval === 'chat' && f.needsHumanHardStopOnly) {
      reason = `label-mode leftover: remove the needs-human label, then ${resume}`;
      nextAction = `remove the needs-human label, then ${resume}`;
    } else {
      reason = f.needsHumanReason || 'needs-human label set (no reason recorded)';
      nextAction = `leave: owner decision needed (${reason})`;
    }
  } else if (failing.length > 0) {
    waitingOn = 'failing-check';
    reason = failing.join('; ');
    nextAction = resume;
  } else if (reviewing.length > 0) {
    waitingOn = 'review';
    reason = reviewing.join('; ');
    nextAction = resume;
  } else if (untracked && !stale) {
    waitingOn = 'review';
    reason = `never reviewed: ${resume} adopts it`;
    nextAction = resume;
  } else if (
    record?.outcome === 'awaiting-owner-merge' &&
    record.head === f.headRefOid &&
    !f.isDraft &&
    f.ci === 'passed' &&
    f.conflicts !== true
  ) {
    waitingOn = 'owner-merge';
    reason = 'gated and clean for this head; only the owner\'s "merge" is missing';
    nextAction = `say "merge" (head ${sha7(f.headRefOid)})`;
  } else if (untracked) {
    waitingOn = 'abandoned';
    reason = `no pipeline history, last activity ${activity.at ? day(activity.at) : 'unknown'}`;
    nextAction = 'close';
  } else {
    waitingOn = 'pipeline';
    if (record?.outcome === 'awaiting-owner-merge') {
      const why = [];
      if (record.head !== f.headRefOid) why.push('head changed since the gate');
      if (f.isDraft) why.push('still a draft');
      if (f.ci !== 'passed') why.push(`CI ${f.ci}`);
      reason = `owner-merge record no longer holds (${why.join(', ')})`;
      nextAction = `re-gate: ${resume}`;
    } else if (!record) {
      reason = `run record ${f.recordStatus}`;
      nextAction = resume;
    } else if (f.isDraft && NEVER_GATED_STEPS.has(record.step)) {
      reason = `draft never gated (stopped at ${record.step})`;
      nextAction = resume;
    } else if (record.outcome == null) {
      const hb = record.heartbeat;
      const hbOk = hb && !Number.isNaN(Date.parse(hb.at));
      reason = `stalled at ${record.step}`;
      nextAction = hbOk ? `stalled on ${hb.host} since ${day(new Date(Date.parse(hb.at)).toISOString())}: ${resume}` : resume;
    } else {
      reason = `last run ended ${record.outcome}`;
      nextAction = resume;
    }
  }

  let suggest = SUGGEST[waitingOn];

  if (f.isCrossRepository) {
    nextAction = 'fork PR: not resumable by the pipeline';
    if (suggest === 'resume') suggest = 'leave';
  } else if (f.local) {
    const l = f.local;
    if (l.state === 'diverged') {
      nextAction = `local branch diverged in ${l.worktree}: owner decides; ${nextAction}`;
    } else if (l.unpushed > 0 || l.dirty > 0) {
      nextAction = `push/commit the local work in ${l.worktree} first; then ${nextAction}`;
    }
  }

  return { number: n, title: f.title, waitingOn, reason, nextAction, lastActivity: activity, stale, suggest };
}

// ---- merged PRs whose production watch never finished -----------------------------------------

// Outcomes a prod-watch run ends on. `merged` is NOT one of them: the merge happened, the watch did not finish.
const TERMINAL_AFTER_MERGE = new Set([
  'superseded',
  'recovered',
  'rollback-failed',
  'changed-during-recovery',
  'rollback-skipped',
  'not-live',
  'deploy-failed',
  'deploy-not-observed',
  'no-production',
]);

export function classifyStranded(merged, now) {
  const out = [];
  for (const m of merged ?? []) {
    const unfinishedRollback = Boolean(m.events?.rollbackIntent) && !m.events?.rollbackResult;
    const noTerminal = m.record != null && !TERMINAL_AFTER_MERGE.has(m.record.outcome);
    if (!unfinishedRollback && !noTerminal) continue;
    const reason = unfinishedRollback
      ? 'a rollback may have been in progress (rollback-intent without rollback-result)'
      : `merged, but the production watch never finished (outcome ${m.record.outcome ?? 'none'})`;
    out.push({
      number: m.number,
      mergedAt: m.mergedAt,
      recordStatus: m.recordStatus,
      reason,
      nextAction: `ship resume ${m.number} (observes production; never rolls back)`,
    });
  }
  void now; // reserved: the caller already filtered by --merged-days
  return out.sort((a, b) => a.number - b.number);
}

// ---- triage -----------------------------------------------------------------------------------

export function triageGroups(classified) {
  const groups = { merge: [], resume: [], close: [], leave: [] };
  const sorted = [...(classified ?? [])].sort((a, b) => a.number - b.number);
  for (const c of sorted) if (groups[c.suggest]) groups[c.suggest].push(c);
  return groups;
}
