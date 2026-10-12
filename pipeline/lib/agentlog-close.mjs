// `pipeline agent-log close`: resolves the "merged — prod smoke pending" lines of the agent log. A project with
// `production.watch: workflow` has a CI workflow that smokes production after the deploy and leaves a bot-authored
// result comment on the merged PR:
//   <!-- prod-smoke-result v=1 sha=… deployment=… status=… vercel=… outcome=… observed=… run=… -->
// This reads those comments and builds one resolution line per pending PR whose newest result is not logged yet:
//   - <PHT date of observed> · #<N> · prod smoke <outcome> · deploy <vercel host> · observed <PHT date HH:mm> · run <run id>
// The leading date comes from `observed` (never the clock), so one result is always the byte-identical line and the
// queue/stage verbatim dedupe holds across runs and days. Only github-actions[bot] comments count, only for the PR's merge
// commit, and the newest result is chosen by its embedded `observed`, never by comment or file order.
import { DEFAULT_OUTCOME } from './agentlog.mjs';

export const BOT_AUTHOR = 'github-actions[bot]';
export const OUTCOMES = Object.freeze(['passed', 'failed', 'superseded', 'not-live', 'build-failed', 'unverified', 'untrusted']);

const MARKER_KEYS = ['sha', 'deployment', 'status', 'vercel', 'outcome', 'observed', 'run'];
const HOST_RE = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const ID_RE = /^\d{1,18}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
// Bounded AND complete reading. The log is append-only, so every merged PR stays "pending" forever and reading each one
// every run would not scale. Instead ONE repo-wide read lists the issue comments updated in the last RESOLVED_SKIP_DAYS days
// (a new result on an old, long-resolved PR shows up there: a manual backfill dispatch, a deployment whose health changed),
// and per-PR reads are kept for the PRs that need them: pending PRs with no resolution line yet, the newest pending PR,
// the PRs named by the caller, and everything with `all`. A resolved PR the scan did not mention costs no gh call.
// The producing workflow reports deployments of the last 7 days unless dispatched by hand, so 14 days leaves margin.
export const RESOLVED_SKIP_DAYS = 14;
const PHT_OFFSET_MS = 8 * 3600 * 1000; // Asia/Manila is UTC+8 all year, no DST

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const PENDING_RE = new RegExp(`^- \\S+ · #(\\d+) · .* · ${escapeRe(DEFAULT_OUTCOME)}$`);
const RESOLUTION_RE = /^- \S+ · #(\d+) · prod smoke (\S+) · deploy (\S+) · observed (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) · run (\d+)$/;

/** A PHT wall clock for an instant (ms): { date: 'YYYY-MM-DD', time: 'HH:mm' }. Fixed +8h shift, host-zone-proof. */
export function formatPht(ms) {
  const iso = new Date(ms + PHT_OFFSET_MS).toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 16) };
}

/** The instant (ms) of a PHT wall-clock minute, the inverse of formatPht. */
export const parsePht = (date, time) => Date.parse(`${date}T${time}:00Z`) - PHT_OFFSET_MS;

function markerProblems(o) {
  const problems = [];
  if (!SHA_RE.test(String(o.sha))) problems.push('sha');
  for (const k of ['deployment', 'status', 'run']) if (!ID_RE.test(String(o[k]))) problems.push(k);
  if (!HOST_RE.test(String(o.vercel))) problems.push('vercel');
  if (!OUTCOMES.includes(o.outcome)) problems.push('outcome');
  if (!ISO_RE.test(String(o.observed)) || Number.isNaN(Date.parse(String(o.observed)))) problems.push('observed');
  return problems;
}

/** Strict: a marker with an unknown, duplicate or missing key, or a bad value, is skipped, never partially read. */
export function parseResultMarkers(commentBody) {
  const out = [];
  for (const m of String(commentBody ?? '').matchAll(/<!-- prod-smoke-result v=1 ([^<>]*?) -->/g)) {
    const o = {};
    let bad = false;
    for (const part of m[1].split(' ')) {
      const eq = part.indexOf('=');
      const key = eq < 0 ? '' : part.slice(0, eq);
      if (!MARKER_KEYS.includes(key) || key in o) { bad = true; break; }
      o[key] = part.slice(eq + 1);
    }
    if (bad || MARKER_KEYS.some((k) => !(k in o)) || markerProblems(o).length) continue;
    out.push(o);
  }
  return out;
}

/** Markers from issue comments, trusting only github-actions[bot], and only the ones for `sha`. */
export function resultsFromComments(comments, sha) {
  const out = [];
  for (const c of comments ?? []) {
    if (c?.user?.login !== BOT_AUTHOR) continue;
    for (const r of parseResultMarkers(c.body)) if (r.sha === sha) out.push(r);
  }
  return out;
}

export const newestByObserved = (results) =>
  results.reduce((best, r) => (best === null || Date.parse(r.observed) > Date.parse(best.observed) ? r : best), null);

export function resolutionLine({ pr, result }) {
  const obs = formatPht(Date.parse(result.observed));
  return `- ${obs.date} · #${pr} · prod smoke ${result.outcome} · deploy ${result.vercel} · observed ${obs.date} ${obs.time} · run ${result.run}`;
}

/** Pending PR numbers (unique, in file order) and every logged resolution per PR. */
export function parseLog(text) {
  const pending = [];
  const resolutions = new Map();
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const p = PENDING_RE.exec(line);
    if (p) {
      if (!pending.includes(p[1])) pending.push(p[1]);
      continue;
    }
    const r = RESOLUTION_RE.exec(line);
    if (r) {
      const list = resolutions.get(r[1]) ?? [];
      list.push({ outcome: r[2], host: r[3], observed: `${r[4]} ${r[5]}`, run: r[6], at: parsePht(r[4], r[5]) });
      resolutions.set(r[1], list);
    }
  }
  return { pending, resolutions };
}

// The newest logged resolution by its embedded observed time; on a tie the later line wins.
const newestLogged = (list) => (list ?? []).reduce((best, r) => (best === null || r.at >= best.at ? r : best), null);

/** The PR number a repo-wide issue comment belongs to, from its `issue_url` (…/issues/<N>); null when it has none. */
export const prFromIssueUrl = (url) => /\/issues\/(\d+)$/.exec(String(url ?? ''))?.[1] ?? null;

/** ISO instant (second precision) `RESOLVED_SKIP_DAYS` before `now` (ms): the `since` of the repo-wide read. */
export const scanSince = (now) => new Date(now - RESOLVED_SKIP_DAYS * 24 * 3600 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

const oneLine = (err) => String(err?.message ?? err).replace(/[\r\n]+/g, ' ').slice(0, 200);

/**
 * gh: { mergeSha(pr) -> sha | null, listComments(pr) -> comments[], listRepoComments(sinceIso) -> comments[] (each with
 * `issue_url`) }. `now` (ms; tests always pass it) sets the repo-wide window. `prs` (strings) are pending PRs to read
 * per-PR whatever their state; `all` reads every pending PR per-PR.
 * Returns { lines, pending, skipped, unreadable, scanError }. A PR that cannot be read lands in `unreadable` and the rest
 * carry on; if the repo-wide read itself fails, `scanError` says so and resolved PRs are left unchecked this run.
 */
export async function closeLines({ logText, gh, now = Date.now(), prs = [], all = false }) {
  const { pending, resolutions } = parseLog(logText);
  const lines = [];
  const skipped = [];
  const unreadable = [];
  let scanError = null;
  const newestPending = pending.reduce((best, pr) => (best === null || Number(pr) > Number(best) ? pr : best), null);
  const named = new Set(prs.map(String));
  const readPerPr = (pr) => all || !resolutions.has(pr) || pr === newestPending || named.has(pr);

  // One repo-wide read, only when some resolved PR would otherwise go unchecked.
  const scanned = new Map();
  if (pending.some((pr) => !readPerPr(pr))) {
    try {
      for (const c of await gh.listRepoComments(scanSince(now))) {
        const n = prFromIssueUrl(c?.issue_url);
        if (n === null || !pending.includes(n)) continue;
        if (!scanned.has(n)) scanned.set(n, []);
        scanned.get(n).push(c);
      }
    } catch (err) {
      scanError = oneLine(err);
    }
  }

  for (const pr of pending) {
    const lastLogged = newestLogged(resolutions.get(pr));
    const perPr = readPerPr(pr);
    if (!perPr && !scanned.has(pr)) {
      skipped.push(pr);
      continue;
    }
    try {
      const sha = await gh.mergeSha(pr);
      if (!sha) continue; // not merged (or no merge commit named yet): nothing to close
      const comments = perPr ? await gh.listComments(pr) : scanned.get(pr);
      const newest = newestByObserved(resultsFromComments(comments, sha));
      if (!newest) continue;
      const obs = formatPht(Date.parse(newest.observed));
      if (lastLogged && lastLogged.host === newest.vercel && lastLogged.outcome === newest.outcome && lastLogged.observed === `${obs.date} ${obs.time}`) continue;
      lines.push(resolutionLine({ pr, result: newest }));
    } catch (err) {
      unreadable.push({ pr, message: oneLine(err) });
    }
  }
  return { lines, pending, skipped, unreadable, scanError };
}
