// The owner's extra-round grants, re-checked from the review state (the final gate and review-complete share this, so a grant forged
// into .review/state.json cannot clear either). Review state is a local file an agent's tool could in principle write, so nothing in it
// is believed on its own: every round that carries an `ownerGrant` is proven against the owner's record and its machine-global marker
// (hooks/lib/owner-go.mjs#verifyOwnerGrant), and every counted round past the cap must carry one.
//
//  (a) every round carrying `ownerGrant` is verified, whatever its ordinal and whether or not max_rounds is finite;
//  (b) every counted round with ordinal k > max_rounds + 1 must carry a verified grant;
//  (c) a counted round at ordinal max_rounds + 1 without a grant is the automatic extra round: accepted when it is recorded
//      `admission: 'auto-extra'` or has no admission field (a state written before admission was recorded); `'normal'` fails.
// Any round recorded `admission: 'owner'` must carry its grant. The cap is the configured review.max_rounds, which both callers pass as
// `maxRounds` (an integer 1..5): the state's own maxRounds is only a cross-check (a state recording a larger or non-finite cap than the
// configured one fails closed), because a cap read from the very state being verified could be edited away. Only a caller that passes no
// cap (a hand-built state) falls back to the state's value, and there a non-finite max_rounds (JSON turns Infinity into null) skips (b) and (c).
// The ordinal k counts only rounds that count toward the cap (never baseOnly / resolutionOnly); n is the round number in the state.
// A round that RAN before owner grants were recorded (cp #104) has none and can never get one by a new run: the owner approves it afterwards
// (`P triage round-request --pr N --past`, then `P state past-round-grant`), which saves a grant with `past: true` that this module verifies like any
// other (record kind `past-round`, hooks/lib/owner-go.mjs). pastRoundsNeedingApproval says which rounds that applies to; the refusal for one names the remedy.
import { verifyOwnerGrant } from '../hooks/lib/owner-go.mjs';
import { countsTowardCap } from './triage.mjs';

const FULL_SHA = /^[0-9a-f]{40}$/;

// What to do when the owner's record cannot be read here.
const cannotVerify = (n, pr) => `round ${n}: owner grant cannot be verified on this machine — run the gate on the machine that reviewed it (the only recovery once the round is published), or, for an unpublished trailing round only, \`P state discard-round --pr ${pr} --round ${n}\`, \`P triage round-request\`, and ask the owner again`;

// The remedy a refusal names for a round that qualifies (see pastRoundsNeedingApproval).
const pastRemedy = (n, pr) => `approve it now: \`P triage round-request --pr ${pr} --past\`, show the closing line it prints, and once the owner has typed "approve round" run \`P state past-round-grant --pr ${pr} --round ${n}\``;

/**
 * The rounds the owner may approve AFTER they ran, as [{ n, k, toHead }] (oldest first). A round of `state` qualifies when ALL hold:
 *  - it counts toward the cap, with ordinal k > maxRounds + 1 (the automatic extra round, k = max + 1, never qualifies);
 *  - the PUBLISHED state holds the very same round (n, toHead, contentHashAtToHead) and a LATER counted round (a forward grant turned into a fake
 *    round is always the newest one, so the newest round never qualifies);
 *  - and EITHER it carries no `ownerGrant` and no `admission` (it ran before grants were recorded), OR its `ownerGrant` no longer verifies because the
 *    owner's record is gone or no longer the owner's (`no-record` / `provenance`: the transcripts are cleaned up), which the owner can approve again.
 * Not qualifying, so their refusals keep their text: k = max + 1 admitted `normal`, a round recorded `admission: 'owner'` without a grant, any other admission.
 * `state` is the copy whose grants are checked (the local one; pass the published state as both to decide on what the PR holds). `maxRounds` is the
 * configured review.max_rounds (an integer >= 1; anything else returns []). `opts`: { repo, pr, home?, now? }. Never throws.
 */
export function pastRoundsNeedingApproval(state, published, { maxRounds, repo, pr, ...opts } = {}) {
  try {
    if (!Number.isInteger(maxRounds) || maxRounds < 1) return [];
    const mine = Array.isArray(state?.rounds) ? state.rounds : [];
    const theirs = Array.isArray(published?.rounds) ? published.rounds : [];
    const out = [];
    let k = 0;
    for (const r of mine) {
      if (!countsTowardCap(r)) continue;
      k += 1;
      if (k <= maxRounds + 1 || !FULL_SHA.test(String(r.toHead))) continue;
      const p = theirs.find((x) => x?.n === r.n);
      if (p === undefined || p.toHead !== r.toHead || p.contentHashAtToHead !== r.contentHashAtToHead) continue;
      if (!theirs.some((x) => countsTowardCap(x) && x.n > r.n)) continue;
      if (r.ownerGrant === undefined) {
        if (r.admission === undefined) out.push({ n: r.n, k, toHead: r.toHead });
        continue;
      }
      let v = { ok: false };
      try {
        v = verifyOwnerGrant({ repo, pr, k, toHead: r.toHead, ownerGrant: r.ownerGrant }, opts);
      } catch { /* unverifiable here: not a reason to approve again */ }
      if (!v.ok && (v.reason === 'no-record' || v.reason === 'provenance')) out.push({ n: r.n, k, toHead: r.toHead });
    }
    return out;
  } catch {
    return [];
  }
}

// -> { ok: true, granted: [{ n, k, quote, past? }] } | { ok: false, problems: [string], granted }. `opts`: { repo, pr, maxRounds?, published?, home?, now? }. Never throws.
// `published`: the PR's published state, when the caller could read it; a refusal for a round that ran before grants were recorded (or whose grant record is
// gone) names the remedy only when that round is published and followed by a later one. Without it the check is local-only: the local state stands in for the
// published one (the command that carries the remedy out reads the published state itself and refuses a round that does not qualify).
export function verifyOwnerGrants(state, { repo, pr, maxRounds, published, ...opts } = {}) {
  const rounds = Array.isArray(state?.rounds) ? state.rounds : [];
  const stateMax = state?.maxRounds;
  const configured = Number.isInteger(maxRounds) && maxRounds >= 1;
  const max = configured ? maxRounds : stateMax;
  const capped = Number.isFinite(max);
  const problems = [];
  if (configured && !(Number.isFinite(stateMax) && stateMax <= maxRounds)) {
    problems.push(`the review state records maxRounds ${JSON.stringify(stateMax ?? null)}, not within the configured review.max_rounds (${maxRounds}): the cap cannot be trusted`);
  }
  const granted = [];
  let qualifying;
  const pastRound = (n) => {
    qualifying ??= new Set(pastRoundsNeedingApproval(state, published ?? state, { maxRounds: configured ? maxRounds : undefined, repo, pr, ...opts }).map((x) => x.n));
    return qualifying.has(n);
  };
  let k = 0;
  for (const r of rounds) {
    const counted = countsTowardCap(r);
    if (counted) k += 1;
    const n = r?.n;
    if (r?.ownerGrant !== undefined) {
      let v = { ok: false };
      try {
        if (counted) v = verifyOwnerGrant({ repo, pr, k, toHead: r.toHead, ownerGrant: r.ownerGrant }, opts);
      } catch { /* unverifiable */ }
      if (v.ok) granted.push({ n, k, quote: v.quote, ...(r.ownerGrant?.past === true ? { past: true } : {}) });
      else problems.push(cannotVerify(n, pr) + (pastRound(n) ? `; or, when the owner's words for it are gone from every transcript, ${pastRemedy(n, pr)}` : ''));
      continue;
    }
    if (r?.admission === 'owner') {
      problems.push(`round ${n}: recorded as admitted by an owner grant, but carries none`);
    } else if (counted && capped && k > max + 1) {
      problems.push(`round ${n}: counted round ${k} is past review.max_rounds (${max}) and its automatic extra round, and carries no owner grant${pastRound(n) ? `; it ran before owner grants were recorded, so ${pastRemedy(n, pr)}` : ''}`);
    } else if (counted && capped && k === max + 1 && r?.admission !== undefined && r.admission !== 'auto-extra') {
      problems.push(`round ${n}: counted round ${k} is past review.max_rounds (${max}) but was not admitted as the automatic extra round and carries no owner grant`);
    }
  }
  return problems.length === 0 ? { ok: true, granted } : { ok: false, problems, granted };
}
