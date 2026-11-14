// What the ask for one more review round shows the owner (`pipeline triage round-request`): how many rounds ran, what the PR has cost, which items are
// still open and how serious they are, why the review is not clean, and whether the accepted fixes could be taken out and filed as follow-ups instead.
// Display only: nothing here decides anything (the decision is `triage defer-fixes`, which re-checks all of it). Pure: git, GitHub and the owner's records are
// read by the command and handed in. Every title is untrusted text (Codex / Fable output) and goes through the ASCII one-line sanitiser, so a hostile title can
// neither add a line nor fake the closing `Extra review round needed` line (which only the CLI writes).
import { asciiLine, autoExtraOrdinal, countsTowardCap, itemSeverity, reviewedRoundCount } from './triage.mjs';

const cents = (n) => (Number.isFinite(n) ? Math.round(n * 100) / 100 : null);
const usd = (n) => `$${n.toFixed(2)}`;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const BUCKET_WORDS = { BLOCKING: 'BLOCKING', SUGGESTION: 'SUGGESTIONS', WORTH_CONSIDERING: 'WORTH CONSIDERING' };
const SHOWN = 6;

// { bookedUsd, reviewUsd, fableUsd, perRoundUsd, lastRound, lastRoundUsd } from a run record (record.cost), or null when it holds no usable cost.
// lastRoundUsd is what was booked to the newest COUNTED round of `state` that has a cost.byRound entry (`P cost --round R`; R is the round's number `n`), lastRound its
// number; both null for a record without byRound, or when no state is given. A base-only / resolution-only round is not a counted one, so its booking is skipped.
export function costFrom(record, reviewed, state) {
  const c = record?.cost;
  if (!isObj(c) || !isObj(c.total) || !Number.isFinite(c.total.usd)) return null;
  const reviewUsd = Number.isFinite(c.byPhase?.review?.usd) ? c.byPhase.review.usd : 0;
  const fableUsd = Number.isFinite(c.byRole?.arbiter?.usd) ? c.byRole.arbiter.usd : 0;
  const byRound = isObj(c.byRound) ? c.byRound : {};
  const last = [...(state?.rounds ?? [])].reverse().find((r) => countsTowardCap(r) && Number.isInteger(r.n) && Number.isFinite(byRound[String(r.n)]?.usd));
  return {
    bookedUsd: cents(c.total.usd), reviewUsd: cents(reviewUsd), fableUsd: cents(fableUsd), perRoundUsd: reviewed > 0 ? cents(reviewUsd / reviewed) : null,
    lastRound: last ? last.n : null, lastRoundUsd: last ? cents(byRound[String(last.n)].usd) : null,
  };
}

// { reviewed, max, autoExtraUsed, ownerGranted, next } (next: the counted round the ask is for).
export function roundsFrom(state) {
  const reviewed = reviewedRoundCount(state);
  return {
    reviewed,
    max: Number.isFinite(state?.maxRounds) ? state.maxRounds : null,
    autoExtraUsed: autoExtraOrdinal(state) !== null,
    ownerGranted: (state?.rounds ?? []).filter((r) => countsTowardCap(r) && typeof r.ownerGrant?.grantId === 'string' && r.ownerGrant.past !== true).length, // (a past-round approval admitted nothing)
    next: reviewed + 1,
  };
}

// Every item that keeps the outcome from clean, as { id, round, bucket, category, severity, title, file }. A severity or config error makes every item high
// (and adds a warning): the ask is still written. `baseConfig`: the trusted base config (itemSeverity takes the union of both sensitive lists); `baseProblem` (why it
// could not be read) shows every item as high, as defer-fixes refuses on it.
export function openItems(state, outcome, { config, files, baseConfig, baseProblem }, warnings) {
  const ids = new Set([...outcome.newAccepted, ...outcome.unimplemented, ...outcome.openBlocking, ...outcome.pending, ...outcome.needsHuman]);
  const found = (state?.rounds ?? []).flatMap((r) => (r.items ?? []).map((item) => ({ item, round: item.round ?? r.n }))).filter(({ item }) => ids.has(item.id));
  let broken = false;
  if (baseProblem && found.length > 0) { // (nothing open: nothing to judge, no warning about items that do not exist)
    broken = true;
    warnings.push(`severity could not be judged: the trusted base config is unreadable (${asciiLine(baseProblem, 120)}): every open item is shown as high`);
  }
  return found.map(({ item, round }) => {
    let severity = 'high';
    if (!broken) {
      try {
        severity = itemSeverity(item, { state, config, files, baseConfig }).level;
      } catch (err) {
        broken = true;
        warnings.push(`severity could not be judged (${asciiLine(err?.message, 120)}): every open item is shown as high`);
      }
    }
    return { id: String(item.id), round, bucket: item.bucket ?? null, category: asciiLine(item.category, 40) || null, severity, title: asciiLine(item.title, 100), file: asciiLine(item.file, 100) };
  }).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// The reasons the outcome is not clean, in plain words. `changed` = { commits, files, lines } since the last review (only given when the coverage is invalid
// and no accepted fix explains it).
export function notCleanReasons(outcome, changed) {
  const out = [];
  if (outcome.newAccepted.length > 0) out.push(`fixes not re-reviewed (${outcome.newAccepted.join(', ')})`);
  if (changed) out.push(`changed since the last review: ${plural(changed.commits, 'commit')}, ${plural(changed.files, 'file')}, ${plural(changed.lines, 'line')} that fix no item`);
  if (outcome.needsHuman.length > 0) out.push(`needs a ruling (${outcome.needsHuman.join(', ')})`);
  if (outcome.fablePending.length > 0) out.push(`Fable pass owed (round ${outcome.fablePending.join(', ')})`);
  if (outcome.pending.length > 0) out.push(`pending (${outcome.pending.join(', ')})`);
  if (outcome.unimplemented.length > 0) out.push(`accepted, not yet implemented (${outcome.unimplemented.join(', ')})`);
  if (outcome.openBlocking.length > 0) out.push(`open BLOCKING (${outcome.openBlocking.join(', ')})`);
  return out;
}

// "(the last round (R) cost $X; about $Y per round)": the last round's own figure when `P cost --round` booked one, the average as the fallback.
const costDetail = (cost) => {
  const parts = [
    Number.isFinite(cost.lastRoundUsd) && Number.isInteger(cost.lastRound) ? `the last round (${cost.lastRound}) cost ${usd(cost.lastRoundUsd)}` : null,
    cost.perRoundUsd === null || cost.perRoundUsd === undefined ? null : `about ${usd(cost.perRoundUsd)} per round`,
  ].filter(Boolean);
  return parts.length ? ` (${parts.join('; ')})` : '';
};

const sentence = (s) => {
  const t = String(s).trim();
  return t === '' ? t : `${t[0].toUpperCase()}${t.slice(1)}${/[.!?]$/.test(t) ? '' : '.'}`;
};

// The status lines the ask and the park comment share: Rounds, Booked agent cost, Open (with severity), Not clean because. `asking` (the ask) adds "this would be round N" to the
// Rounds line; the park comment is not asking for a round and leaves it out.
export function statusLines({ rounds, cost, open, notClean, asking = true }) {
  const limit = [`limit ${rounds.max ?? 'none'}`, rounds.autoExtraUsed ? 'the automatic extra round' : null, rounds.ownerGranted > 0 ? plural(rounds.ownerGranted, 'owner-granted round') : null].filter(Boolean).join(' + ');
  const lines = [`Rounds: ${rounds.reviewed} reviewed (${limit})${asking ? `; this would be round ${rounds.next}` : ''}.`];
  lines.push(cost === null
    ? 'Booked agent cost so far: not available.'
    : `Booked agent cost so far: ${usd(cost.bookedUsd)}, review ${usd(cost.reviewUsd)}${costDetail(cost)}.`);
  if (open.length === 0) lines.push('Open: no item is open.');
  else {
    const shown = open.slice(0, SHOWN).map((i) => `${i.id} (${BUCKET_WORDS[i.bucket] ?? asciiLine(i.bucket, 20)}, ${i.category ?? 'no category'})`);
    const high = open.filter((i) => i.severity !== 'low');
    const verdict = high.length === 0 ? (open.length === 1 ? 'low severity' : 'all low severity') : `${high.length} of ${open.length} not low severity (${high.slice(0, SHOWN).map((i) => i.id).join(', ')})`;
    lines.push(`Open: ${shown.join(', ')}${open.length > SHOWN ? `, and ${open.length - SHOWN} more` : ''}: ${verdict}.`);
  }
  if (notClean.length > 0) lines.push(`Not clean because: ${notClean.join('; ')}.`);
  return lines;
}

// The process review the trip-wire (triage.mjs#roundTripWire) asks for before another round (#374 PR B): a prompt, not a gate. `wire` = roundTripWire's answer, `fixScope` = fixRoundScope's (or null
// when it could not be measured). -> { headline, summary }; the headline is the one line the park comment carries (`pipeline comment --kind blocked --reason`). Pure and display only.
export function processReviewSummary({ rounds, cost, open, notClean, wire, fixScope, nextRound }) {
  const past = Number.isFinite(wire.max) ? Math.max(0, wire.reviewed - wire.max) : 0;
  const share = wire.reviewed > 0 ? Math.round((past / wire.reviewed) * 100) : 0;
  const headline = `Process review before round ${nextRound}: ${wire.reasons.map((r) => asciiLine(r, 160)).join('; ')}`;
  const lines = [headline, 'This is a prompt, not a gate: the owner decides, and the usual extra-round words are still needed.', ...statusLines({ rounds, cost, open: open ?? [], notClean: notClean ?? [] })];
  lines.push(`New accepts per round: ${wire.acceptsByRound.join(', ') || 'none'}. Past the limit: ${past} of ${wire.reviewed} counted rounds (${share}%).`);
  if (fixScope) lines.push(fixScope.flagged ? `Fix scope since the last review: flagged (${fixScope.reasons.map((r) => asciiLine(r, 120)).join('; ')}).` : `Fix scope since the last review: not flagged (${fixScope.nonTestLines} non-test added lines).`);
  lines.push('Options: file the open items as follow-up issues (triage defer-fixes when it is eligible), split the PR, or run one more round (round-request --after-process-review).');
  return { headline, summary: lines.join('\n') };
}

// The plain-English block the agent pastes above the closing line, and the one-sentence why. `follow` = deferEligibility's answer.
export function askSummary({ rounds, cost, open, notClean, follow, discard }) {
  const lines = statusLines({ rounds, cost, open, notClean });
  if (follow.eligible) {
    lines.push(`Recommendation: file them as follow-up issues and merge what was reviewed (say "follow up"), or type "extra round". Following up takes out ${plural(discard.count, 'commit')} made since the last review (listed under discard): the fixes and anything else in them.`);
  } else {
    lines.push('Recommendation: one more review round (type "extra round").');
  }
  const why = follow.eligible
    ? 'Every open item is low severity and each fix can be taken out and filed as a follow-up, so nothing unreviewed would ship.'
    : sentence(`Another round is the safe path: ${follow.refusals[0] ?? 'the open items cannot be deferred'}`);
  return { summary: lines.join('\n'), why };
}
