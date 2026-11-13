// The reading half of `pipeline ci-usage`: what to ask GitHub, in what order, and within which budget. Everything is read through the injected `gh` (createGitHub: `gh.api(method, path)`),
// by repository slug (so --repo-slug may name a repository other than the one gh resolves from the current directory), and handed to the pure classifier (lib/ci-usage.mjs).
// Read-only. The call budget is `--max-calls` GitHub calls (one per page) plus a stop when the rate limit is nearly spent; running out is `partial: true` with the skipped
// counts, never a failure. Only the first list (repository, workflow runs) failing is a failure (GhError: the caller maps it to exit 3).
import { MAX_PAGES, PAGE, pages } from './gh-pages.mjs';
import {
  HEAVY_ELAPSED_MS, UNEXCLUDABLE, aggregateUsage, analysePrUsage, classifierVersion, classifyRuns, elapsedMs,
} from './ci-usage.mjs';
import { parseYaml } from './yaml.mjs';
import { asciiLine } from './triage.mjs';

// Below this many calls left of the hourly limit nothing more is read (the limit is shared by every session of the machine).
export const MIN_REMAINING = 1000;
export const RATE_CHECK_EVERY = 50;
// The reads of the PRs stop at this share of --max-calls, so the jobs of the biggest runs (the cost) are always read too.
export const PR_SHARE = 0.6;

class BudgetStop extends Error {}

// Counts GitHub calls and decides when to stop. `tick()` is called before every page read; it throws BudgetStop once `limit` (default: all of --max-calls) is used or the rate limit is low.
export function makeBudget(gh, { maxCalls, warnings, label }) {
  let calls = 0;
  let rate = null;
  let rateWarned = false;
  let reason = null;
  const readRate = () => {
    try {
      const r = gh.api('GET', 'rate_limit');
      const core = r?.resources?.core ?? r?.rate;
      if (core && Number.isFinite(core.remaining)) rate = { remaining: core.remaining, limit: core.limit ?? null, reset: core.reset ?? null };
    } catch (err) {
      if (!rateWarned) warnings.push(`${label}: the rate limit could not be read (${asciiLine(err?.message, 100)}): reading on without it`);
      rateWarned = true;
    }
  };
  readRate();
  return {
    get calls() { return calls; },
    get rate() { return rate; },
    get reason() { return reason; },
    lowRate: () => rate !== null && rate.remaining < MIN_REMAINING,
    // `limit`: stop at this many calls instead of maxCalls (the PR reads).
    tick(limit = maxCalls) {
      if (calls >= Math.min(limit, maxCalls)) { reason ??= 'max-calls'; throw new BudgetStop('max-calls'); }
      if (rate !== null && rate.remaining < MIN_REMAINING) { reason ??= 'rate-limit'; throw new BudgetStop('rate-limit'); }
      calls += 1;
      if (calls % RATE_CHECK_EVERY === 0) readRate();
    },
    // A read that must happen (the first list): counted, never stopped.
    count() { calls += 1; },
    stop: BudgetStop,
  };
}

const prNumberOf = (run, byBranch) => {
  const n = run.pull_requests?.[0]?.number;
  if (Number.isInteger(n)) return n;
  const list = byBranch?.get(run.head_branch) ?? [];
  const created = Date.parse(run.created_at);
  // the newest PR of that branch created before the run
  return list.filter((p) => Date.parse(p.created_at) <= created).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0]?.number ?? null;
};

// ci.draft_while_iterating of the repository's own .claude/pipeline.yml on its default branch: true | false | 'unknown'. A config without the setting is false (its default).
function readDraftFlag(gh, slug, budget, warnings) {
  try {
    budget.count();
    const file = gh.api('GET', `repos/${slug}/contents/.claude/pipeline.yml`);
    const text = Buffer.from(String(file?.content ?? ''), file?.encoding === 'base64' ? 'base64' : 'utf8').toString('utf8');
    const flag = parseYaml(text)?.ci?.draft_while_iterating;
    if (flag === undefined) return false;
    if (typeof flag === 'boolean') return flag;
    warnings.push(`${slug}: ci.draft_while_iterating in .claude/pipeline.yml is not a boolean: missed redrafts are unknown`);
  } catch (err) {
    warnings.push(`${slug}: .claude/pipeline.yml could not be read (${asciiLine(err?.message, 100)}): ci.draft_while_iterating is unknown, so missed redrafts are not reported (pushes while ready still are)`);
  }
  return 'unknown';
}

// -> the repository's result (see docs/cli.md#ci-usage). `sinceMs`: UTC ms; `workflows`: names or file paths to keep (empty = all); `rates`: per-OS USD per minute overrides.
export function readRepoUsage({ gh, slug, sinceMs, workflows = [], maxCalls, rates = {}, viewer = null, warnings }) {
  const sinceIso = `${new Date(sinceMs).toISOString().slice(0, 19)}Z`;
  const warn = (m) => warnings.push(`${slug}: ${m}`);
  const budget = makeBudget(gh, { maxCalls, warnings, label: slug });
  const skipped = { prs: 0, jobs: 0 };

  // the first list: if GitHub cannot be reached for these, the whole command is "unavailable"
  budget.count();
  const repo = gh.api('GET', `repos/${slug}`);
  const isPrivate = repo?.private === true;
  const draftWhileIterating = readDraftFlag(gh, slug, budget, warnings);
  let totalCount = null;
  const listed = pages(gh, `repos/${slug}/actions/runs?created=${encodeURIComponent(`>=${sinceIso}`)}`, undefined,
    () => warn(`the list of workflow runs was cut after ${MAX_PAGES} pages (${MAX_PAGES * PAGE} runs): runs further back are missing, so the totals are short (use a later --since)`),
    { key: 'workflow_runs', onCall: () => budget.count(), onPage: (r) => { totalCount ??= Number.isFinite(r?.total_count) ? r.total_count : null; } });
  if (totalCount !== null && totalCount > listed.length && listed.length < MAX_PAGES * PAGE) warn(`GitHub lists ${totalCount} runs for this period but returned ${listed.length}: it caps a created= search at 1000 results, so the totals are short (use a later --since)`);
  const keep = new Set(workflows);
  const runs = keep.size === 0 ? listed : listed.filter((r) => keep.has(r.name) || keep.has(r.path) || keep.has(String(r.path ?? '').split('/').pop()));

  // PRs: the run's own pull_requests, else its branch against the PRs list (read once, only when some run needs it)
  const candidates = runs.filter((r) => elapsedMs(r) >= HEAVY_ELAPSED_MS);
  const prOfRun = new Map();
  let byBranch = null;
  const needsBranchLookup = candidates.some((r) => r.event === 'pull_request' && !Number.isInteger(r.pull_requests?.[0]?.number));
  if (needsBranchLookup) {
    try {
      const list = pages(gh, `repos/${slug}/pulls?state=all&sort=updated&direction=desc`, (l) => l.every((p) => String(p.updated_at ?? '') < sinceIso),
        () => warn(`the list of PRs was cut after ${MAX_PAGES} pages: runs on a PR from a fork or without a PR link may stay unclassified`), { onCall: () => budget.tick() });
      byBranch = new Map();
      for (const p of list) byBranch.set(p.head?.ref, [...(byBranch.get(p.head?.ref) ?? []), p]);
    } catch (err) {
      if (!(err instanceof budget.stop)) throw err;
    }
  }
  const prGroups = new Map(); // PR number -> { runs, candidateMs }
  for (const run of runs) {
    if (run.event !== 'pull_request') continue;
    const n = prNumberOf(run, byBranch);
    if (n === null) continue;
    prOfRun.set(run.id, n);
    const g = prGroups.get(n) ?? { runs: [], candidateMs: 0 };
    g.runs.push(run);
    if (elapsedMs(run) >= HEAVY_ELAPSED_MS) g.candidateMs += elapsedMs(run);
    prGroups.set(n, g);
  }

  // per PR with at least one heavy-candidate run, the biggest first: the PR itself, its timeline, its commits (and its comments, only when a catch-up head has heavy runs)
  const readPr = new Map();
  const order = [...prGroups.entries()].filter(([, g]) => g.candidateMs > 0).sort((a, b) => b[1].candidateMs - a[1].candidateMs);
  const cut = (what, n) => () => warn(`#${n}: the ${what} were cut after ${MAX_PAGES} pages: the classification of this PR may be short`);
  for (const [n] of order) {
    try {
      budget.tick(maxCalls * PR_SHARE);
      const pr = gh.api('GET', `repos/${slug}/pulls/${n}`);
      const timeline = pages(gh, `repos/${slug}/issues/${n}/timeline`, undefined, cut('timeline events', n), { onCall: () => budget.tick(maxCalls * PR_SHARE) });
      const commits = pages(gh, `repos/${slug}/pulls/${n}/commits`, undefined, cut('commits', n), { onCall: () => budget.tick(maxCalls * PR_SHARE) });
      readPr.set(n, { pr: { createdAt: pr?.created_at, draft: pr?.draft === true }, timeline, commits, comments: null });
    } catch (err) {
      if (err instanceof budget.stop) { skipped.prs += 1; continue; }
      warn(`#${n}: could not be read (${asciiLine(err?.message, 120)}): its runs stay unclassified`);
      skipped.prs += 1;
    }
  }
  // the PRs that were never tried because the budget ran out are skipped too
  skipped.prs = order.length - readPr.size;

  // the jobs of the biggest candidate runs first (the cost is there), one call each
  const jobsByRun = new Map();
  const bySize = [...candidates].sort((a, b) => elapsedMs(b) - elapsedMs(a));
  for (const run of bySize) {
    try {
      const jobs = pages(gh, `repos/${slug}/actions/runs/${encodeURIComponent(run.id)}/jobs?filter=all`, undefined,
        () => warn(`run ${run.id}: the jobs were cut after ${MAX_PAGES} pages`), { key: 'jobs', onCall: () => budget.tick() });
      jobsByRun.set(run.id, jobs);
    } catch (err) {
      if (err instanceof budget.stop) break;
      warn(`run ${run.id}: the jobs could not be read (${asciiLine(err?.message, 100)})`);
    }
  }
  skipped.jobs = candidates.length - jobsByRun.size;

  // the review-complete marker, for the PRs whose catch-up heads had heavy runs (read after the jobs: the budget left over)
  for (const [n, data] of readPr) {
    const g = prGroups.get(n);
    const rows = classifyRuns({ pr: data.pr, timeline: data.timeline, commits: data.commits, runs: g.runs, jobsByRun });
    if (!rows.some((r) => r.heavy && r.catchupHead && r.class !== 'ready-for-review')) continue;
    try {
      data.comments = pages(gh, `repos/${slug}/issues/${n}/comments`, undefined, cut('comments', n), { onCall: () => budget.tick() });
    } catch (err) {
      if (!(err instanceof budget.stop)) warn(`#${n}: the comments could not be read (${asciiLine(err?.message, 100)}): finalCatchupReruns is unknown for it`);
    }
  }

  // classify
  const prRows = [];
  const classified = [];
  for (const [n, data] of readPr) {
    const row = analysePrUsage({ number: n, ...data, runs: prGroups.get(n).runs, jobsByRun, rates, viewer });
    classified.push(...row.classified);
    const { classified: _omit, ...plain } = row;
    prRows.push(plain);
  }
  const unread = runs.filter((r) => !(r.event === 'pull_request' && readPr.has(prOfRun.get(r.id))));
  classified.push(...classifyRuns({ runs: unread, jobsByRun, rates }));
  const agg = aggregateUsage({ classified, prRows, isPrivate, rates, draftWhileIterating });

  const partial = budget.reason !== null || skipped.prs > 0 || skipped.jobs > 0;
  if (budget.reason === 'rate-limit') warn(`the rate limit is low (${budget.rate?.remaining} calls left, stopping below ${MIN_REMAINING}): the report is partial`);
  if (budget.reason === 'max-calls') warn(`--max-calls ${maxCalls} reached: the report is partial`);
  if (skipped.prs > 0) warn(`${skipped.prs} PR(s) with heavy runs were not read: their runs are unclassified`);
  if (skipped.jobs > 0) warn(`${skipped.jobs} run(s) of a minute or more had their jobs unread: job minutes and the estimate cover ${agg.totals.coverage}% of the heavy runs`);
  return {
    slug, private: isPrivate, billing: agg.billing, draftWhileIterating, classifierVersion, since: sinceIso, partial, calls: budget.calls, rateLimit: budget.rate, skipped,
    runsListed: listed.length, runsRead: runs.length,
    totals: agg.totals, assumptions: agg.assumptions,
    prs: prRows.sort((a, b) => a.pr - b.pr),
    unexcludable: [UNEXCLUDABLE],
  };
}
