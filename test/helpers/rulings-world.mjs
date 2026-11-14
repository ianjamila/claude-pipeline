// Fixtures for the Rulings block tests (plan 2026-11-05-claude-rulings): a review state holding dismissed BLOCKING items, and the PR comments a finished
// review leaves behind (the triage comment with that state, the review-complete marker), as the fake gh lists them.
import { addRound, emptyState } from '../../pipeline/lib/state.mjs';
import { triageComment } from '../../pipeline/lib/render.mjs';
import { REVIEW_COMPLETE_MARKER } from '../../pipeline/lib/review-marker.mjs';
import { rulingsDigest, substituteDigest, substituteSummary } from '../../pipeline/lib/triage.mjs';
import { reviewContentHash } from '../../pipeline/lib/review-publish.mjs';

const base = (over) => ({
  round: 1, bucket: 'BLOCKING', category: 'security', title: 'Missing check', file: 'src/app.js', line: 1, detail: 'x is used before it is checked', codexReasoning: 'y',
  testable: false, fingerprint: `fp-${over.id}`, judge: null, test: { status: 'none', evidence: '' }, arbiter: null, implemented: false, followupIssue: null, ...over,
});
// A dismissal CLAUDE made (final.by 'claude'; E3: a gated owner item).
export const claudeItem = (over = {}) => base({
  id: 'R1-B1',
  final: { decision: 'REJECT', by: 'claude', needsHuman: false, reason: 'a false positive: the caller checks it', claude: { ruledAt: '2026-11-05T11:00:00.000Z', cause: 'security-dismissal', critical: true, overruled: null } },
  ...over,
});
// A dismissal the arbiter made (listed in the Rulings block, never a gated owner item).
export const arbiterItem = (over = {}) => base({ id: 'R1-B2', title: 'Unchecked input', final: { decision: 'REJECT', by: 'arbiter', needsHuman: false, reason: 'the arbiter found it unreachable' }, ...over });

export function rulingState({ hash, items = [], pr = 12, repo = 'acme/widgets', branch = 'agent/feature', rounds = [] } = {}) {
  let s = emptyState({ repo, pr, branch, risk: 'low', maxRounds: 2 });
  s.currentContentHash = hash;
  s = addRound(s, { n: 1, fromHead: 'a', toHead: 'b', contentHashAtToHead: hash, items });
  for (const r of rounds) s = addRound(s, r);
  return s;
}

export const comment = (id, body, { login = 'me', at = '2026-11-05T10:00:00Z', updated = at } = {}) => ({ id, body, user: { login }, created_at: at, updated_at: updated });
export const markerBody = ({ contentHash, head, base: b = '9'.repeat(40), digest = 'none', rounds = 1, stateHash = 'none', substituteDigest: subDigest = 'none', substitute = null, codexModel = 'gpt-x' }) => {
  // stateHash: the review state the marker was issued for (review-complete writes it); 'none' = a marker from before the field (omitted).
  const rec = { contentHash, base: b, head, rounds, codexModel, modelProofDigest: null, ...(digest !== 'none' ? { rulingsDigest: digest } : {}), ...(stateHash !== 'none' ? { stateHash } : {}), ...(subDigest !== 'none' ? { substitute, substituteDigest: subDigest } : {}) };
  return `${REVIEW_COMPLETE_MARKER}\nReview complete.\n\`\`\`json\n${JSON.stringify(rec)}\n\`\`\`\n`;
};
// What a finished review leaves on the PR: the triage comment with `state` and the marker for `hash` carrying the state's rulings digest (override with `marker`).
export const publishedComments = (state, { hash, head, base: b, marker = {} } = {}) => [
  comment(1, triageComment(state)),
  comment(2, markerBody({ contentHash: hash, head, base: b, digest: rulingsDigest(state), rounds: state.rounds.length, stateHash: reviewContentHash(state), substituteDigest: substituteDigest(state), substitute: substituteSummary(state), ...marker }), { at: '2026-11-05T10:05:00Z' }),
];
