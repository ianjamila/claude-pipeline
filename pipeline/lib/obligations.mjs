// Reviewer obligations: which extra reviewers a review round owes before it can count as clean. They are DERIVED from the
// round's own inputs (never from what the controller says it did), recorded on the round as `pending`, and settled only by
// `P review add`, which proves the model that answered and the input it was bound to.
//   security: a Sonnet security review, owed in round 1 of a security-relevant PR and again in any later round whose own
//             range touches a security trigger (so a fix that edits the migration is reviewed, a docs fix is not).
//   fable:    the optional Fable final pass (review.final_pass: risky), owed once, on a high-risk PR with no open BLOCKING item.
import { createHash } from 'node:crypto';

export const OBLIGATION_SOURCES = Object.freeze(['security', 'fable']);

export function requiredObligations({ round, security, securityInRange, level, finalPass, blockingCount, priorRounds }) {
  const out = [];
  if (security && (round === 1 || securityInRange)) out.push('security');
  const fableMet = (priorRounds ?? []).some((r) => (r.obligations ?? []).some((o) => o.source === 'fable' && o.status === 'met'));
  if (finalPass === 'risky' && level === 'high' && blockingCount === 0 && !fableMet) out.push('fable');
  return out;
}

// Binds a reviewer's prompt to one repo, PR, source and commit range: an answer to another range cannot settle this obligation.
export const obligationDigest = ({ repo, pr, source, base, head }) => createHash('sha256').update([repo, pr, source, base, head].join('\n')).digest('hex');

export const promptHeader = (round, digest) => `ROUND: ${round}\nINPUT-DIGEST: ${digest}`;
