// The owner's extra-round grants, re-checked from the review state (the final gate and review-complete share this, so a grant forged
// into .review/state.json cannot clear either). Review state is a local file an agent's tool could in principle write, so nothing in it
// is believed on its own: every round that carries an `ownerGrant` is proven against the owner's record and its machine-global marker
// (hooks/lib/owner-go.mjs#verifyOwnerGrant), and every counted round past the cap must carry one.
//
//  (a) every round carrying `ownerGrant` is verified, whatever its ordinal and whether or not max_rounds is finite;
//  (b) every counted round with ordinal k > max_rounds + 1 must carry a verified grant;
//  (c) a counted round at ordinal max_rounds + 1 without a grant is the automatic extra round: accepted when it is recorded
//      `admission: 'auto-extra'` or has no admission field (a state written before admission was recorded); `'normal'` fails.
// Any round recorded `admission: 'owner'` must carry its grant. A non-finite max_rounds (JSON turns Infinity into null) skips (b) and (c).
// The ordinal k counts only rounds that count toward the cap (never baseOnly / resolutionOnly); n is the round number in the state.
import { verifyOwnerGrant } from '../hooks/lib/owner-go.mjs';
import { countsTowardCap } from './triage.mjs';

// What to do when the owner's record cannot be read here.
const cannotVerify = (n, pr) => `round ${n}: owner grant cannot be verified on this machine — run the gate on the machine that reviewed it, or \`P state discard-round --pr ${pr} --round ${n}\`, \`P triage round-request\`, and ask the owner again`;

// -> { ok: true, granted: [{ n, k, quote }] } | { ok: false, problems: [string], granted }. `opts`: { repo, pr, home?, now? }. Never throws.
export function verifyOwnerGrants(state, { repo, pr, ...opts } = {}) {
  const rounds = Array.isArray(state?.rounds) ? state.rounds : [];
  const max = state?.maxRounds;
  const capped = Number.isFinite(max);
  const problems = [];
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
      else problems.push(cannotVerify(n, pr));
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
