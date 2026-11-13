// What CI really costs per PR and per class of run, and how often an agent pushed to a READY PR without `pipeline redraft` first (a missed redraft).
// Pure: no I/O, the commands read GitHub and hand the answers in (`pipeline ci-usage`, and the `pushedWhileReady` warning of `pipeline summary`).
// Display only: nothing here decides anything. Bump `classifierVersion` whenever a rule below changes, so two reports can be compared.
//
// Shapes in (GitHub's own, untouched):
//   timeline  [{ event: 'ready_for_review' | 'converted_to_draft' | 'committed' | 'head_ref_force_pushed' | ..., created_at, actor: { login } }]
//   pr        { createdAt, draft }  (`draft` is the PR's CURRENT draft flag: with no draft/ready event on the timeline it is also what the PR always was)
//   commits   normalised by normalizeCommit: { sha, parents (count), committer (login), message }
//   runs      workflow runs: { id, name, path, event, head_sha, run_attempt, conclusion, created_at, run_started_at, updated_at }
//   jobs      actions/runs/{id}/jobs?filter=all (every attempt): { run_attempt, conclusion, started_at, completed_at, labels }
import { parseReviewRecord } from './review-marker.mjs';
import { asciiLine } from './triage.mjs';

export const classifierVersion = 1;

// A run created this long after `ready_for_review` is the run that event started; a run cancelled this long after `converted_to_draft` was cancelled by it.
export const WINDOW_MS = 120_000;
// A run is HEAVY when its jobs add up to a minute or more; with no jobs read, when it ran for a minute or more (flagged `heavyFromElapsed`).
export const HEAVY_JOB_MINUTES = 1;
export const HEAVY_ELAPSED_MS = 60_000;
export const OS_KEYS = Object.freeze(['linux', 'windows', 'macos', 'self-hosted']);
// USD per minute of a GitHub-hosted runner (the standard rates; larger runners cost more, so they are underestimated). Overridable with `--rate os=usd`. Self-hosted runners cost nothing here.
export const DEFAULT_RATES = Object.freeze({ linux: 0.008, windows: 0.016, macos: 0.08 });
export const CLASSES = Object.freeze(['ready-for-review', 'push-while-ready', 'push-while-draft', 'converted-cancel', 'catch-up', 'rerun', 'other', 'unclassified']);

const ms = (v) => {
  const t = typeof v === 'number' ? v : Date.parse(v);
  return Number.isFinite(t) ? t : null;
};
const round = (v, digits = 2) => (Number.isFinite(v) ? Math.round(v * 10 ** digits) / 10 ** digits : null);
const sha12 = (s) => String(s ?? '').slice(0, 12);

// ---- the PR's phase -------------------------------------------------------------------------------------------------

// [{ t, to: 'ready' | 'draft', actor }] oldest first.
function toggles(timeline) {
  const out = [];
  for (const e of Array.isArray(timeline) ? timeline : []) {
    const t = ms(e?.created_at);
    if (t === null) continue;
    if (e.event === 'ready_for_review') out.push({ t, to: 'ready', actor: e.actor?.login ?? null });
    else if (e.event === 'converted_to_draft') out.push({ t, to: 'draft', actor: e.actor?.login ?? null });
  }
  return out.sort((a, b) => a.t - b.t);
}

// 'draft' | 'ready' when the PR was opened: the first event says what it was before (ready_for_review => it was a draft); no event at all => it never changed.
export function initialPhase(timeline, draftNow) {
  const first = toggles(timeline)[0];
  if (first) return first.to === 'ready' ? 'draft' : 'ready';
  return draftNow === true ? 'draft' : 'ready';
}

// 'draft' | 'ready' at time `t` (ms or ISO). `prCreated` = { createdAt, draft } (see the header).
export function prPhaseAt(timeline, prCreated, t) {
  const at = ms(t);
  let phase = initialPhase(timeline, prCreated?.draft);
  if (at === null) return phase;
  for (const e of toggles(timeline)) {
    if (e.t > at) break;
    phase = e.to;
  }
  return phase;
}

// ---- catch-ups (update-branch) --------------------------------------------------------------------------------------

// GitHub's "Update branch" (PUT pulls/{n}/update-branch, which `pipeline update-branch` calls, lib/updatebranch.mjs) makes a merge commit of the base into the
// PR branch: two parents, committed by GitHub itself (login `web-flow`), message "Merge branch '<base>' into <head-branch>". Either mark counts (a local
// `git merge main` writes the same message, and is the same base churn).
const UPDATE_BRANCH_MESSAGE = /^Merge branch '[^'\n]+' into \S+/;
export function normalizeCommit(c) {
  const parents = typeof c?.parents === 'number' ? c.parents : Array.isArray(c?.parents) ? c.parents.length : 0;
  const committer = typeof c?.committer === 'string' ? c.committer : (c?.committer?.login ?? null);
  const message = typeof c?.message === 'string' ? c.message : String(c?.commit?.message ?? '');
  return { sha: String(c?.sha ?? ''), parents, committer, message };
}
export function isCatchUpCommit(c) {
  const k = normalizeCommit(c);
  if (k.parents !== 2) return false;
  return k.committer === 'web-flow' || UPDATE_BRANCH_MESSAGE.test(k.message.split('\n')[0]);
}
const catchUpShas = (commits) => new Set((commits ?? []).filter(isCatchUpCommit).map((c) => normalizeCommit(c).sha));

// ---- cost of one run ------------------------------------------------------------------------------------------------

// Provider runners (not GitHub-hosted) and anything we cannot recognise cost nothing here and are counted on their own.
const PROVIDER_LABEL = /^(self-hosted|ubicloud|blacksmith|buildjet|depot|warpbuild|namespace|runs-on|actuated|cirrus)/;
export function runnerOs(labels) {
  const list = (Array.isArray(labels) ? labels : []).map((l) => String(l?.name ?? l).toLowerCase());
  if (list.some((l) => PROVIDER_LABEL.test(l))) return 'self-hosted';
  if (list.some((l) => /^windows/.test(l))) return 'windows';
  if (list.some((l) => /^macos/.test(l))) return 'macos';
  if (list.some((l) => /^ubuntu|^linux/.test(l))) return 'linux';
  return 'self-hosted';
}

const zeroMinutes = () => Object.fromEntries(OS_KEYS.map((k) => [k, 0]));

// -> { minutes: { linux, windows, macos, 'self-hosted' } (the sum of the job durations, every attempt), rerunMinutes (the part from attempts after the first),
//      usd (each job rounded UP to a whole minute x the rate of its OS; self-hosted 0), jobs (counted) }. Jobs that never ran (no start or end time, skipped) add nothing.
export function costOfJobs(jobs, rates = DEFAULT_RATES) {
  const minutes = zeroMinutes();
  let rerunMinutes = 0;
  let usd = 0;
  let counted = 0;
  for (const j of Array.isArray(jobs) ? jobs : []) {
    const start = ms(j?.started_at);
    const end = ms(j?.completed_at);
    if (start === null || end === null || end < start || j.conclusion === 'skipped') continue;
    const min = (end - start) / 60_000;
    const os = runnerOs(j.labels);
    minutes[os] += min;
    if (Number(j.run_attempt) > 1) rerunMinutes += min;
    if (os !== 'self-hosted') usd += Math.ceil(min) * (rates[os] ?? DEFAULT_RATES[os]);
    counted += 1;
  }
  return { minutes, rerunMinutes, usd, jobs: counted };
}
const sumMinutes = (m) => OS_KEYS.reduce((s, k) => s + m[k], 0);

// updated_at - run_started_at, in ms (measured: for a re-run only its last attempt).
export function elapsedMs(run) {
  const start = ms(run?.run_started_at) ?? ms(run?.created_at);
  const end = ms(run?.updated_at);
  return start === null || end === null ? 0 : Math.max(0, end - start);
}

// ---- classification -------------------------------------------------------------------------------------------------

// Every run gets ONE class, the first that fits:
//   other             not a pull_request run (push to main, schedule, workflow_dispatch, a guards run on `labeled` ...): kept apart, by event
//   unclassified      a pull_request run of a PR whose timeline could not be read
//   converted-cancel  cancelled within 120 s after a converted_to_draft: the redraft stopped it
//   rerun             run_attempt > 1 (the whole run, all its attempts, is charged to this class)
//   ready-for-review  created within 120 s after a ready_for_review: the one suite the redraft flow plans for
//   catch-up          its head is an update-branch merge of the base
//   push-while-ready  first seen on a head pushed while the PR was ready
//   push-while-draft  the same while it was a draft
// `jobsByRun`: Map run id -> jobs for the runs whose jobs were read. -> one row per run, same order.
export function classifyRuns({ pr = null, timeline = null, commits = [], runs, jobsByRun = new Map(), rates = DEFAULT_RATES }) {
  const events = timeline ? toggles(timeline) : [];
  const catchups = catchUpShas(commits);
  return (runs ?? []).map((run) => {
    const created = ms(run.created_at);
    const updated = ms(run.updated_at);
    let cls;
    if (run.event !== 'pull_request') cls = 'other';
    else if (!pr || !timeline) cls = 'unclassified';
    else if (run.conclusion === 'cancelled' && updated !== null && events.some((e) => e.to === 'draft' && updated - e.t >= 0 && updated - e.t <= WINDOW_MS)) cls = 'converted-cancel';
    else if (Number(run.run_attempt) > 1) cls = 'rerun';
    else if (created !== null && events.some((e) => e.to === 'ready' && created - e.t >= 0 && created - e.t <= WINDOW_MS)) cls = 'ready-for-review';
    else if (catchups.has(run.head_sha)) cls = 'catch-up';
    else cls = prPhaseAt(timeline, pr, created) === 'ready' ? 'push-while-ready' : 'push-while-draft';
    const read = jobsByRun.has(run.id);
    const cost = read ? costOfJobs(jobsByRun.get(run.id), rates) : null;
    const jobMinutes = cost ? sumMinutes(cost.minutes) : null;
    const elapsed = elapsedMs(run);
    const heavy = read ? jobMinutes >= HEAVY_JOB_MINUTES : elapsed >= HEAVY_ELAPSED_MS;
    return {
      id: run.id, name: run.name ?? null, event: run.event, class: cls, headSha: run.head_sha ?? null, createdAt: run.created_at ?? null,
      catchupHead: catchups.has(run.head_sha), elapsedMin: elapsed / 60_000, jobsRead: read, jobMinutes: cost ? cost.minutes : null, rerunJobMinutes: cost ? cost.rerunMinutes : 0,
      usd: cost ? cost.usd : null, heavy, heavyFromElapsed: heavy && !read,
    };
  });
}

// ---- the pushes (heads) of one PR -----------------------------------------------------------------------------------

// One row per head commit that pull_request runs were created for, oldest first (all workflows of one push share a head: one row):
//   { sha, createdAt, phase, kind: 'opening' | 'catch-up' | 'ready-run' | 'push' }
// opening = the head the PR was opened with (its first run within 120 s of the PR's creation); catch-up = an update-branch merge; ready-run = the head's first run
// was the one `ready_for_review` started (nothing ran on it before: the workflow skips drafts); push = a push of the agent. `phase` is the PR's phase when the first run was
// created. A re-run keeps its original created_at, so a re-run never makes a push look newer; only the first run of a head counts.
export function headPushes({ pr, timeline, commits = [], runs }) {
  const events = toggles(timeline);
  const catchups = catchUpShas(commits);
  const first = new Map();
  for (const run of runs ?? []) {
    if (run.event !== 'pull_request' || !run.head_sha) continue;
    const t = ms(run.created_at);
    if (t === null) continue;
    const seen = first.get(run.head_sha);
    if (!seen || t < seen.t || (t === seen.t && Number(run.id) < Number(seen.run.id))) first.set(run.head_sha, { t, run });
  }
  const rows = [...first.entries()].sort((a, b) => a[1].t - b[1].t);
  const opened = ms(pr?.createdAt);
  return rows.map(([sha, { t }], i) => {
    let kind = 'push';
    if (i === 0 && opened !== null && Math.abs(t - opened) <= WINDOW_MS) kind = 'opening';
    else if (catchups.has(sha)) kind = 'catch-up';
    else if (events.some((e) => e.to === 'ready' && t - e.t >= 0 && t - e.t <= WINDOW_MS)) kind = 'ready-run';
    return { sha, createdAt: new Date(t).toISOString(), t, phase: prPhaseAt(timeline, pr, t), kind };
  });
}

// Heads pushed while the PR was READY: the missed redrafts (when the repository iterates in draft). Excluded: the opening head, catch-ups, heads whose first run was the
// ready one, and re-runs (see headPushes). NOT excludable: a push after Rule 8's proven `convert-failed` rejection (GitHub refused the redraft, so the review skill pushes
// anyway) leaves no trace on GitHub; it counts here like any other push while ready.
export const UNEXCLUDABLE = 'A push made after a proven convert-failed rejection of `pipeline redraft` (Rule 8: push anyway) leaves no trace on GitHub and counts as pushed while ready.';
export function pushedWhileReady({ pr, timeline, commits = [], runs }) {
  const heads = headPushes({ pr, timeline, commits, runs }).filter((h) => h.kind === 'push' && h.phase === 'ready');
  return { count: heads.length, heads: heads.map((h) => ({ sha: h.sha, createdAt: h.createdAt })) };
}

// A converted_to_draft (by `viewer`, else anybody) followed by a ready_for_review with no new head in between: the redraft bought nothing. A new head is a head with a first
// run, a force push, or a commit dated in between.
export function wastedRedrafts({ pr, timeline, commits = [], runs, viewer = null }) {
  const events = toggles(timeline);
  const pushes = headPushes({ pr, timeline, commits, runs }).filter((h) => h.kind !== 'opening').map((h) => h.t);
  for (const e of Array.isArray(timeline) ? timeline : []) {
    if (e?.event === 'head_ref_force_pushed' && ms(e.created_at) !== null) pushes.push(ms(e.created_at));
    if (e?.event === 'committed') {
      const d = ms(e.committer?.date ?? e.author?.date);
      if (d !== null) pushes.push(d);
    }
  }
  let wasted = 0;
  events.forEach((e, i) => {
    if (e.to !== 'draft' || (viewer !== null && e.actor !== viewer)) return;
    const next = events[i + 1];
    if (!next || next.to !== 'ready') return;
    if (!pushes.some((t) => t > e.t && t < next.t)) wasted += 1;
  });
  return wasted;
}

// ---- one PR ---------------------------------------------------------------------------------------------------------

// The newest review-complete marker comment's time (ms), or null. Author not checked (as ci-wait does not).
export function lastReviewMarkerAt(comments) {
  let at = null;
  for (const c of Array.isArray(comments) ? comments : []) {
    if (parseReviewRecord(c?.body) === null) continue;
    const t = ms(c.created_at);
    if (t !== null && (at === null || t > at)) at = t;
  }
  return at;
}

const addTo = (acc, minutes) => { for (const k of OS_KEYS) acc[k] += minutes[k] ?? 0; };

// -> the PR's row and its classified runs. `comments` null = not read (needed only for finalCatchupReruns, which is then null).
export function analysePrUsage({ number, pr, timeline, commits = [], comments = null, runs, jobsByRun = new Map(), rates = DEFAULT_RATES, viewer = null }) {
  const classified = classifyRuns({ pr, timeline, commits, runs, jobsByRun, rates });
  const pushes = headPushes({ pr, timeline, commits, runs });
  const pushedReady = pushes.filter((h) => h.kind === 'push' && h.phase === 'ready');
  const markerAt = comments === null ? null : lastReviewMarkerAt(comments);
  const jobMinutes = zeroMinutes();
  let usd = 0;
  let workflowElapsedMin = 0;
  let heavyRuns = 0;
  let churnRuns = 0;
  let churnMinutes = 0;
  let churnUnreadRuns = 0;
  let finalCatchupReruns = 0;
  for (const r of classified) {
    if (!r.heavy) continue;
    heavyRuns += 1;
    workflowElapsedMin += r.elapsedMin;
    if (r.jobMinutes) addTo(jobMinutes, r.jobMinutes);
    usd += r.usd ?? 0;
    // base churn: a heavy run on an update-branch head, other than the ready-for-review suite the flow plans for
    if (r.catchupHead && r.class !== 'ready-for-review') {
      churnRuns += 1;
      if (r.jobMinutes) churnMinutes += sumMinutes(r.jobMinutes);
      else churnUnreadRuns += 1;
      if (markerAt !== null && ms(r.createdAt) > markerAt) finalCatchupReruns += 1;
    }
  }
  const toggled = toggles(timeline);
  return {
    pr: number,
    readyCycles: (initialPhase(timeline, pr?.draft) === 'ready' ? 1 : 0) + toggled.filter((e) => e.to === 'ready').length,
    pushesWhileReady: pushedReady.length,
    pushedHeads: pushedReady.map((h) => sha12(h.sha)),
    pushesWhileDraft: pushes.filter((h) => h.kind === 'push' && h.phase === 'draft').length,
    wastedRedrafts: wastedRedrafts({ pr, timeline, commits, runs, viewer }),
    catchups: [...catchUpShas(commits)].length,
    heavyRuns, workflowElapsedMin: round(workflowElapsedMin), jobMinutes: roundMinutes(jobMinutes), estimatedUsd: round(usd, 4),
    churnRuns, churnMinutes: round(churnMinutes), churnUnreadRuns,
    finalCatchupReruns: comments === null ? null : finalCatchupReruns,
    classified,
  };
}
const roundMinutes = (m) => Object.fromEntries(OS_KEYS.map((k) => [k, round(m[k])]));

// ---- totals ---------------------------------------------------------------------------------------------------------

// `classified`: every run's row (all PRs and the non-PR runs). `prRows`: analysePrUsage results. `jobsWanted`: how many heavy-candidate runs jobs were wanted for (coverage = the share read).
// `isPrivate`: only a private repository is billed; a public one is free (estimatedUsd 0, billing 'free-public').
export function aggregateUsage({ classified, prRows, isPrivate, rates = DEFAULT_RATES, draftWhileIterating = 'unknown' }) {
  const heavy = classified.filter((r) => r.heavy);
  const jobMinutes = zeroMinutes();
  const byClass = {};
  const byEvent = {};
  let workflowElapsedMin = 0;
  let usd = 0;
  const bucket = (map, key) => (map[key] ??= { runs: 0, heavyRuns: 0, workflowElapsedMin: 0, jobMinutes: zeroMinutes() });
  for (const r of classified) {
    const slots = [bucket(byClass, r.class)];
    if (r.class === 'other') slots.push(bucket(byEvent, r.event ?? 'unknown'));
    for (const s of slots) {
      s.runs += 1;
      if (!r.heavy) continue;
      s.heavyRuns += 1;
      s.workflowElapsedMin += r.elapsedMin;
      if (r.jobMinutes) addTo(s.jobMinutes, r.jobMinutes);
    }
  }
  for (const r of heavy) {
    workflowElapsedMin += r.elapsedMin;
    if (r.jobMinutes) addTo(jobMinutes, r.jobMinutes);
    usd += r.usd ?? 0;
  }
  for (const map of [byClass, byEvent]) {
    for (const s of Object.values(map)) {
      s.workflowElapsedMin = round(s.workflowElapsedMin);
      s.jobMinutes = roundMinutes(s.jobMinutes);
    }
  }
  const read = heavy.filter((r) => r.jobsRead).length;
  const pushesWhileReady = prRows.reduce((s, p) => s + p.pushesWhileReady, 0);
  const totals = {
    prs: prRows.length,
    heavyRuns: heavy.length,
    workflowElapsedMin: round(workflowElapsedMin),
    jobMinutes: roundMinutes(jobMinutes),
    coverage: heavy.length === 0 ? 100 : Math.round((read / heavy.length) * 100),
    byClass, byEvent,
    pushesWhileReady,
    // a push while ready is a MISSED redraft only where the repository iterates in draft (ci.draft_while_iterating: true); null = that setting could not be read
    missedRedrafts: draftWhileIterating === true ? pushesWhileReady : draftWhileIterating === false ? 0 : null,
    wastedRedrafts: prRows.reduce((s, p) => s + p.wastedRedrafts, 0),
    catchupsPerPr: prRows.length === 0 ? null : round(prRows.reduce((s, p) => s + p.catchups, 0) / prRows.length),
    churnRuns: prRows.reduce((s, p) => s + p.churnRuns, 0),
    churnMinutes: round(prRows.reduce((s, p) => s + p.churnMinutes, 0)),
    churnUnreadRuns: prRows.reduce((s, p) => s + p.churnUnreadRuns, 0),
    finalCatchupReruns: prRows.reduce((s, p) => s + (p.finalCatchupReruns ?? 0), 0),
    estimatedUsd: isPrivate ? round(usd, 4) : 0,
  };
  return {
    totals,
    billing: isPrivate ? 'estimate-private' : 'free-public',
    assumptions: {
      estimate: true,
      rates: { ...DEFAULT_RATES, ...rates, 'self-hosted': 0 },
      note: isPrivate
        ? 'each job is rounded up to a whole minute and priced at its runner OS rate; larger runners, free included minutes and discounts are not modelled; jobs not read are not priced (see coverage)'
        : 'a public repository does not pay for Actions minutes: estimatedUsd is 0',
    },
  };
}

// ---- the plain-text table -------------------------------------------------------------------------------------------

const pad = (s, n) => asciiLine(s, 200).padEnd(n);
const cell = (s) => asciiLine(s, 200);
const usdText = (v) => (v === null || v === undefined ? '-' : `$${v.toFixed(2)}`);
const minText = (m) => (m === null || m === undefined ? '-' : m.toFixed(1));
const osText = (m) => OS_KEYS.filter((k) => m[k] > 0).map((k) => `${k} ${m[k].toFixed(1)}`).join(', ') || '0';

export function renderUsageTable({ since, repos }) {
  const out = [];
  for (const r of repos) {
    const t = r.totals;
    out.push(cell(`CI usage since ${since} in ${r.slug} (${r.private ? 'private' : 'public'}; classifier v${r.classifierVersion}${r.partial ? '; PARTIAL' : ''})`), '');
    out.push(`${pad('PR', 8)}${pad('ready', 7)}${pad('push-rdy', 10)}${pad('push-dft', 10)}${pad('wasted', 8)}${pad('catchups', 10)}${pad('heavy', 7)}${pad('job min', 9)}${pad('est $', 9)}pushed-while-ready heads`);
    for (const p of r.prs) {
      out.push(`${pad(`#${p.pr}`, 8)}${pad(p.readyCycles, 7)}${pad(p.pushesWhileReady, 10)}${pad(p.pushesWhileDraft, 10)}${pad(p.wastedRedrafts, 8)}${pad(p.catchups, 10)}${pad(p.heavyRuns, 7)}${pad(minText(Object.values(p.jobMinutes).reduce((s, v) => s + (v ?? 0), 0)), 9)}${pad(r.private ? usdText(p.estimatedUsd) : '-', 9)}${cell(p.pushedHeads.join(' '))}`);
    }
    out.push('', 'Heavy runs by class (runs, heavy runs, workflow elapsed min, job minutes by OS):');
    for (const [name, s] of Object.entries(t.byClass)) {
      out.push(`  ${pad(name, 18)}${pad(s.runs, 6)}${pad(s.heavyRuns, 6)}${pad(minText(s.workflowElapsedMin), 9)}${osText(s.jobMinutes)}`);
      if (name === 'other') for (const [ev, e] of Object.entries(t.byEvent)) out.push(`    ${pad(`event ${ev}`, 16)}${pad(e.runs, 6)}${pad(e.heavyRuns, 6)}${pad(minText(e.workflowElapsedMin), 9)}${osText(e.jobMinutes)}`);
    }
    out.push('', `PRs ${t.prs} · heavy runs ${t.heavyRuns} · workflow elapsed ${minText(t.workflowElapsedMin)} min (measured) · job minutes ${osText(t.jobMinutes)} · jobs read for ${t.coverage}% of the heavy runs`);
    out.push(r.private ? `Estimated cost ${usdText(t.estimatedUsd)} (an estimate, not a bill: ${cell(r.assumptions.note)})` : 'Public repository: Actions minutes are free (estimated cost $0.00)');
    out.push(`Pushed while ready ${t.pushesWhileReady} · missed redrafts ${t.missedRedrafts === null ? 'unknown (ci.draft_while_iterating could not be read)' : t.missedRedrafts} (draft_while_iterating ${r.draftWhileIterating}) · wasted redrafts ${t.wastedRedrafts}`);
    out.push(`Base churn: ${t.churnRuns} heavy run(s) on catch-up heads, ${minText(t.churnMinutes)} job min · ${t.catchupsPerPr ?? '-'} catch-ups per PR · ${t.finalCatchupReruns} heavy run(s) on a catch-up head after the last review-complete`);
    out.push(`Calls ${r.calls}${r.rateLimit ? ` · rate limit remaining ${r.rateLimit.remaining}` : ''}${r.partial ? ` · skipped: ${cell(JSON.stringify(r.skipped))}` : ''}`);
    for (const u of r.unexcludable) out.push(cell(`Note: ${u}`));
    out.push('');
  }
  return out.join('\n').trimEnd();
}
