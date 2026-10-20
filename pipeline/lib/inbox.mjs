// `ship inbox` classifier: plain facts in, plain classification out. No IO, no gh, no git, no clock reads —
// the caller gathers the facts and injects `now`. Plan: docs/plans/2026-10-12-ship-inbox-resume-plan.md, section F.

import { openOwnerStops } from './run-events.mjs';

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

// -> { status: 'passed'|'failed'|'incomplete', failed: [names], missing: [names] } over the names that count (the required
// checks, or every context seen when none are configured). `missing` = no row yet or not finished.
export function ciDetail(contexts, requiredNames) {
  const latest = new Map();
  for (const row of Array.isArray(contexts) ? contexts : []) {
    const name = row?.name ?? row?.context;
    if (typeof name !== 'string' || name === '') continue;
    latest.set(name, rowVerdict(row)); // input is oldest first, so a later row replaces an earlier one
  }
  const required = Array.isArray(requiredNames) ? requiredNames : [];
  const names = required.length > 0 ? required : [...latest.keys()];
  const verdicts = names.map((n) => [n, latest.get(n) ?? 'pending']);
  const failed = verdicts.filter(([, v]) => v === 'fail').map(([n]) => n);
  const missing = verdicts.filter(([, v]) => v === 'pending').map(([n]) => n);
  if (verdicts.length === 0) return { status: 'incomplete', failed, missing };
  if (failed.length > 0) return { status: 'failed', failed, missing };
  return { status: missing.length === 0 ? 'passed' : 'incomplete', failed, missing };
}

export const ciStatus = (contexts, requiredNames) => ciDetail(contexts, requiredNames).status;

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

const LABEL_FRAGMENT = 'needs-human label present: the run continues but ends at the owner (no merge)';

const RESUMABLE_OUTCOMES = new Set(['awaiting-review', 'blocked', 'awaiting-owner-merge', 'stopped']);

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

// Why a PR cannot go on as it is: [{ text, action }]. `action` says what the resume has to do about it.
function failingReasons(f) {
  const base = f.baseRefName || 'the base branch';
  const out = [];
  if (f.ci === 'failed') {
    const names = Array.isArray(f.ciFailed) && f.ciFailed.length > 0 ? f.ciFailed : null;
    out.push({
      text: names ? `required check${names.length === 1 ? '' : 's'} failed: ${names.join(', ')}` : 'a required CI check failed',
      action: names ? `fix the failing check${names.length === 1 ? '' : 's'}: ${names.join(', ')}` : 'fix the failing check',
    });
  }
  if (f.conflicts === true) out.push({ text: `conflicts with ${base}`, action: `update with ${base}, resolve conflicts` });
  if (f.record?.outcome === 'blocked') out.push({ text: 'last run ended blocked (verify)', action: 'see why verify was blocked' });
  if (f.labels.includes('pipeline-blocked')) out.push({ text: 'pipeline-blocked label set', action: 'see why verify was blocked' });
  const v = f.record?.verify;
  if (v && v.ok === false && v.head === f.headRefOid) {
    out.push({ text: `verify failed for this head${v.failedStep ? ` at ${v.failedStep}` : ''}`, action: 'fix the verify failure' });
  }
  return out;
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
  let suggestOverride = null;

  const untracked = f.recordStatus === 'absent' && !record && !f.triage;
  const live = liveRun(record, nowMs, heartbeatFreshMinutes);
  const failing = failingReasons(f);
  const reviewing = reviewReasons(f);
  // Step 3.5 labels a hard-stop PR before the review loop: with a usable record that has no outcome the run has not stopped
  // at the owner yet (or ended with work left: awaiting-review, blocked, awaiting-owner-merge), so the label does not decide the
  // category; only a run that ended at the owner, or an unreadable record, does.
  // owner_approval: chat never reads the label: the owner's decisions are owner-stop events and review items needing a ruling.
  const chat = ownerApproval === 'chat';
  const ownerDecisions = [];
  if (chat) {
    for (const e of openOwnerStops(f.events)) {
      const cause = e.dataStatus === 'ok' && e.data?.cause ? e.data.cause : 'unreadable';
      ownerDecisions.push({ reason: `owner stop ${e.id} (${cause}) is open`, detail: `stop ${e.id}: ${cause}` });
    }
    const items = f.triage?.needsHumanItems ?? [];
    if (items.length > 0) {
      const ids = items.map((i) => String(i?.id ?? i)).join(', ');
      ownerDecisions.push({ reason: `review items need the owner's ruling in chat: ${ids}`, detail: `review items ${ids}` });
    }
  }
  const midRunLabel = !chat && f.labels.includes('needs-human') && f.recordStatus === 'ok' && record != null && (record.outcome == null || RESUMABLE_OUTCOMES.has(record.outcome));

  if (f.alreadyOnBase === true) {
    waitingOn = 'nothing-left';
    reason = 'the head is already on the base branch';
    nextAction = 'close';
  } else if (live) {
    waitingOn = 'running';
    reason = `a run is live on ${live.host}`;
    nextAction = `leave: running on ${live.host}, ${minutesAgo(live.at, nowMs)} min ago`;
  } else if (chat ? ownerDecisions.length > 0 : f.labels.includes('needs-human') && !midRunLabel) {
    waitingOn = 'owner-decision';
    if (chat) {
      reason = ownerDecisions.map((d) => d.reason).join('; ');
      nextAction = `leave: owner decision needed (${ownerDecisions.map((d) => d.detail).join('; ')}); rule or reply in chat, then ${resume}`;
    } else {
      reason = f.needsHumanReason || 'needs-human label set (no reason recorded)';
      nextAction = `leave: owner decision needed (${reason})`;
    }
  } else if (untracked && stale && (f.isDraft || failing.length > 0)) {
    // Nothing drives it: no record, no review state, quiet for staleDays, AND something says it is going nowhere (a draft,
    // a red check, conflicts, blocked). Whatever else is wrong with it is context for the close decision, not a reason to
    // resume it. Age alone is never enough: see the owner-decision branch below.
    waitingOn = 'abandoned';
    const also = [...failing.map((x) => x.text), ...(f.isDraft ? ['still a draft'] : [])];
    reason = `no pipeline history, last activity ${activity.at ? day(activity.at) : 'unknown'}${also.length ? `; also ${also.join('; ')}` : ''}`;
    nextAction = 'close';
  } else if (untracked && stale) {
    // Quiet and unmanaged, but ready with nothing failing: nothing says it is dead, so the pipeline does not suggest closing it.
    waitingOn = 'owner-decision';
    reason = `no pipeline history and quiet since ${activity.at ? day(activity.at) : 'unknown'}, but ready with nothing failing: the owner decides`;
    nextAction = `owner decides: ${resume} adopts it, or close it`;
  } else if (failing.length > 0) {
    waitingOn = 'failing-check';
    reason = failing.map((x) => x.text).join('; ');
    nextAction = `${resume} (${failing.map((x) => x.action).join('; ')})`;
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
    !midRunLabel && // label mode: with the label the gate ends in needs-human, never in an owner-merge (chat: midRunLabel is always false)
    record.head === f.headRefOid &&
    !f.isDraft &&
    f.ci === 'passed' &&
    f.conflicts !== true
  ) {
    waitingOn = 'owner-merge';
    reason = 'gated and clean for this head; only the owner\'s "merge" is missing';
    nextAction = `say "merge" (head ${sha7(f.headRefOid)})`;
    if (f.conflicts == null) {
      // Mergeability unknown (no git check, GitHub not computed): the owner-merge state holds, but "merge" is not suggested.
      reason += '; mergeability unknown (no git check and GitHub had not computed it)';
      nextAction = `check it merges cleanly, then say "merge" (head ${sha7(f.headRefOid)})`;
      suggestOverride = 'leave';
    }
  } else {
    waitingOn = 'pipeline';
    if (record?.outcome === 'awaiting-owner-merge') {
      const why = [];
      if (record.head !== f.headRefOid) why.push('head changed since the gate');
      if (f.isDraft) why.push('still a draft');
      if (f.ci !== 'passed') why.push(`CI ${f.ci}`);
      if (midRunLabel) why.push('needs-human label set');
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

  if (midRunLabel && waitingOn !== 'nothing-left' && waitingOn !== 'running') {
    reason = `${reason}; ${LABEL_FRAGMENT}`;
  }

  let suggest = suggestOverride ?? SUGGEST[waitingOn];

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

// Steps that mean the run was inside the merge / production phase when it stopped (outcome is null there).
// `P summary` writes outcome `merged` only after prod-watch finished, so any ended record, `merged` included,
// is not stranded; neither is an owner's hand merge from an awaiting-owner-merge record.
const IN_MERGE_PHASE = new Set(['merge', 'prod-watch']);

export function classifyStranded(merged, now) {
  const out = [];
  for (const m of merged ?? []) {
    const unfinishedRollback = Number(m.events?.unresolvedRollbacks) > 0;
    const midMerge = m.recordStatus === 'ok' && m.record != null && IN_MERGE_PHASE.has(m.record.step);
    if (!unfinishedRollback && !midMerge) continue;
    const reason = unfinishedRollback
      ? 'a rollback may have been in progress (rollback-intent without rollback-result)'
      : `merged, but the run stopped in the ${m.record.step} step before production was confirmed`;
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
