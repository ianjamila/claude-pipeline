// `pipeline stats rounds`: what the review rounds past the limit (review.max_rounds) found and cost, read from the merged PRs' own comments (the triage state and the
// run record). Pure: the command fetches and decodes, this module only counts. Display only: nothing here decides anything. The audit scripts of 2026-11-11 were the
// first version of this (their SEC regex is the fallback security heuristic below).
import { SECURITY_CATEGORIES, countsTowardCap } from './triage.mjs';

// itemSeverity needs the reviewed diff, which a PR comment does not carry, so the audit's rule judges an item: BLOCKING or security is not low.
const SEC = /secur|auth|permission|rls|grant|policy|privilege|role|token|secret|injection|xss|csrf|leak|pii|tenant|access|escalat|sanitiz|credential|session|data loss|corrupt|migration|idempot|race|integrity/i;
export const isSecurityItem = (item) => SECURITY_CATEGORIES.includes(item?.category) || SEC.test(`${item?.title ?? ''} ${item?.category ?? ''} ${item?.file ?? ''} ${item?.codexReasoning || item?.detail || ''}`);

const decisionOf = (item) => item?.final?.decision ?? null;
const accepted = (round) => (round?.items ?? []).filter((i) => decisionOf(i) === 'ACCEPT');
const money = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
const share = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 1000 : null);

// How a past-limit round was let in: 'owner-granted', 'auto-extra' (recorded, or the first round past the limit with no record), else 'unknown'.
function admissionOf(round, k, max) {
  if (round.ownerGrant !== undefined || round.admission === 'owner') return 'owner-granted';
  if (round.admission === 'auto-extra') return 'auto-extra';
  if (round.admission === undefined && k === max + 1) return 'auto-extra';
  return 'unknown';
}

// One PR: { repo, pr, id, maxRounds, countedRounds, pastCapRounds, usd, blockingLoop, rounds: [one row per counted round] }, or null when it has no review state.
export function analysePr({ repo, pr, state, record }) {
  if (!state || !Array.isArray(state.rounds)) return null;
  const max = Number.isFinite(state.maxRounds) ? state.maxRounds : null;
  const byRound = record?.cost?.byRound && typeof record.cost.byRound === 'object' ? record.cost.byRound : {};
  const rows = [];
  let k = 0;
  let prev = null;
  for (const r of state.rounds) {
    if (!countsTowardCap(r)) {
      if (r.baseOnly !== true && r.fableRefresh !== true) prev = r;
      continue;
    }
    k += 1;
    const items = r.items ?? [];
    const row = { n: r.n, k, pastCap: max !== null && k > max, usd: money(byRound[String(r.n)]?.usd), acceptedBlocking: items.some((i) => i.bucket === 'BLOCKING' && decisionOf(i) === 'ACCEPT') };
    if (row.pastCap) {
      const prevAccepts = accepted(prev);
      row.admission = admissionOf(r, k, max);
      // what the round before it had to re-check: nothing, only fixes of non-BLOCKING non-security items ("low"), or something heavier
      row.previous = prevAccepts.length === 0 ? 'no-accepts' : prevAccepts.every((i) => i.bucket !== 'BLOCKING' && !isSecurityItem(i)) ? 'only-low-fixes' : 'blocking-or-security';
      row.found = row.acceptedBlocking ? 'new-blocking' : items.some((i) => decisionOf(i) === 'ACCEPT') ? 'accepts' : 'nothing-accepted';
    }
    rows.push(row);
    prev = r;
  }
  const blockingLoop = rows.some((row, i) => i > 0 && row.acceptedBlocking && rows[i - 1].acceptedBlocking);
  const usd = Number.isFinite(record?.cost?.total?.usd) ? money(record.cost.total.usd) : null;
  return { repo, pr, id: `${String(repo).split('/').pop()}#${pr}`, maxRounds: max, countedRounds: rows.length, pastCapRounds: rows.filter((r) => r.pastCap).length, usd, blockingLoop, rounds: rows };
}

const bump = (o, key) => { o[key] = (o[key] ?? 0) + 1; };

// { prs, prsPastCap, countedRounds, pastCapRounds, pastCapShare, admission, previous, found, blockingLoopPrs, usd, pastCapUsd } over analysed PRs (nulls dropped).
export function aggregate(analysed) {
  const prs = analysed.filter(Boolean);
  const t = { prs: prs.length, prsPastCap: 0, countedRounds: 0, pastCapRounds: 0, pastCapShare: null, admission: {}, previous: {}, found: {}, blockingLoopPrs: 0, usd: 0, pastCapUsd: null };
  let pastUsd = 0;
  let pastKnown = 0;
  for (const p of prs) {
    t.countedRounds += p.countedRounds;
    t.pastCapRounds += p.pastCapRounds;
    if (p.pastCapRounds > 0) t.prsPastCap += 1;
    if (p.blockingLoop) t.blockingLoopPrs += 1;
    t.usd += p.usd ?? 0;
    for (const r of p.rounds.filter((x) => x.pastCap)) {
      bump(t.admission, r.admission);
      bump(t.previous, r.previous);
      bump(t.found, r.found);
      if (r.usd !== null) { pastUsd += r.usd; pastKnown += 1; }
    }
  }
  t.pastCapShare = share(t.pastCapRounds, t.countedRounds);
  t.usd = money(t.usd);
  t.pastCapUsd = pastKnown > 0 ? { usd: money(pastUsd), rounds: pastKnown } : null;
  return t;
}

const pad = (s, n) => String(s).padEnd(n);
const usdText = (v) => (v === null || v === undefined ? '-' : `$${v.toFixed(2)}`);

// The plain-text table: one line per PR, then the totals.
export function renderTable({ since, repos, totals, prs }) {
  const out = [`Review rounds of PRs merged since ${since} in ${repos.join(', ')}`, ''];
  out.push(`${pad('PR', 28)}${pad('limit', 7)}${pad('rounds', 8)}${pad('past', 6)}${pad('cost', 10)}${pad('loop', 6)}past-limit rounds (admission, previous round, found)`);
  for (const p of prs) {
    const past = p.rounds.filter((r) => r.pastCap).map((r) => `r${r.n}(${r.admission}; ${r.previous}; ${r.found}${r.usd === null ? '' : `; ${usdText(r.usd)}`})`).join(' ');
    out.push(`${pad(p.id, 28)}${pad(p.maxRounds ?? '-', 7)}${pad(p.countedRounds, 8)}${pad(p.pastCapRounds, 6)}${pad(usdText(p.usd), 10)}${pad(p.blockingLoop ? 'yes' : '', 6)}${past}`);
  }
  const list = (o) => Object.entries(o).map(([k, v]) => `${k} ${v}`).join(', ') || 'none';
  out.push('', `PRs ${totals.prs} (${totals.prsPastCap} went past the limit) · counted rounds ${totals.countedRounds} · past the limit ${totals.pastCapRounds}${totals.pastCapShare === null ? '' : ` (${(totals.pastCapShare * 100).toFixed(1)}%)`} · booked ${usdText(totals.usd)}`);
  out.push(`Past-limit admission: ${list(totals.admission)}`, `Round before them: ${list(totals.previous)}`, `What they found: ${list(totals.found)}`);
  out.push(`PRs with a BLOCKING loop (BLOCKING accepted in 2+ consecutive rounds): ${totals.blockingLoopPrs}${totals.pastCapUsd ? ` · past-limit rounds with a booking: ${totals.pastCapUsd.rounds}, ${usdText(totals.pastCapUsd.usd)}` : ''}`);
  return out.join('\n');
}
