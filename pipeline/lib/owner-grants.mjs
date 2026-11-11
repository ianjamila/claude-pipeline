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
import { verifyOwnerGrant } from '../hooks/lib/owner-go.mjs';
import { countsTowardCap } from './triage.mjs';

// Why verifyOwnerGrant said no (its `reason`), in plain words; the first check that failed is the one named.
const WHY = {
  provenance: "the owner's words for this grant were not found as typed by the owner in this session's transcript on this machine (a record from before transcript capture is proven through exactly one <config dir>/projects/*/<session>.jsonl in a Claude config folder under the home directory; none, or more than one, was found)",
  'no-marker': 'this grant was never consumed on this machine',
  'no-record': "no record of the owner's words for this grant exists on this machine",
  mismatch: "the owner's record or the grant marker is for a different repository, PR, round or head",
  'unverifiable-marker': "this grant's marker on this machine is unreadable or incomplete",
  quote: "the quoted words differ from the owner's recorded words",
  malformed: 'the grant recorded on the round is malformed',
};

// What to do when the owner's record cannot be read here, then why (`reason`: verifyOwnerGrant's, when it gave one).
const cannotVerify = (n, pr, reason) => {
  const base = `round ${n}: owner grant cannot be verified on this machine — run the gate on the machine that reviewed it (the only recovery once the round is published), or, for an unpublished trailing round only, \`P state discard-round --pr ${pr} --round ${n}\`, \`P triage round-request\`, and ask the owner again`;
  const why = reason === undefined ? undefined : (WHY[reason] ?? `the owner's record failed the ${reason} check`);
  return why === undefined ? base : `${base}. Why: ${why}`;
};

// -> { ok: true, granted: [{ n, k, quote }] } | { ok: false, problems: [string], granted }. `opts`: { repo, pr, maxRounds?, home?, now? }. Never throws.
export function verifyOwnerGrants(state, { repo, pr, maxRounds, ...opts } = {}) {
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
      if (v.ok) granted.push({ n, k, quote: v.quote });
      else problems.push(cannotVerify(n, pr, v.reason));
      continue;
    }
    if (r?.admission === 'owner') {
      problems.push(`round ${n}: recorded as admitted by an owner grant, but carries none`);
    } else if (counted && capped && k > max + 1) {
      problems.push(`round ${n}: counted round ${k} is past review.max_rounds (${max}) and its automatic extra round, and carries no owner grant`);
    } else if (counted && capped && k === max + 1 && r?.admission !== undefined && r.admission !== 'auto-extra') {
      problems.push(`round ${n}: counted round ${k} is past review.max_rounds (${max}) but was not admitted as the automatic extra round and carries no owner grant`);
    }
  }
  return problems.length === 0 ? { ok: true, granted } : { ok: false, problems, granted };
}
