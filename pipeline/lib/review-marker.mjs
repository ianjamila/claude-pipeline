// The review-complete comment: what `pipeline review-complete` posts once the cross-model review of a PR ended clean, and
// what the pipeline-guards workflow reads back to post the `Cross-model review` status. One definition, shared by the
// command that writes it, the CI orchestrator that reads it (vendored into projects) and the git guard that keeps agents
// from posting it any other way.
//
// The comment: the marker line, one line of prose, then a ```json fence holding ONE line of JSON
//   { contentHash, base, head, rounds, codexModel, modelProofDigest }
// contentHash is git.mjs#reviewContentHash of the reviewed head (merge base -> head, agent log excluded); base is that merge
// base; modelProofDigest is the sha256 of the Fable model proofs, or null when no Fable pass ran.
//
// Which comment counts (latestReviewComment): the NEWEST marker comment by an allowed author (the repo owner of a user-owned
// repo, or a login in ci.approvers: the same rule as approval labels), and only if it was never edited. A newer comment
// replaces an older one even when the newer one is malformed: the latest word of the review loop is the one judged.
// Residual: the author's token is also the agent's token, so the comment proves only that it went through a path the
// guards allow; the git guard (hooks/lib/git-policy.mjs) refuses the marker on every other path it can see.
export const REVIEW_COMPLETE_MARKER = '<!-- claude-pipeline:review-complete v1 -->';
// What the git guard looks for in command text and request bodies: the marker without its comment delimiters or version,
// so `v2`, extra spaces or a different comment wrapper are caught too.
export const REVIEW_MARKER_TEXT = 'claude-pipeline:review-complete';
// The commit status the pipeline-guards workflow posts from the comment.
export const REVIEW_CONTEXT = 'Cross-model review';

const HASH = /^[0-9a-f]{64}$/;
const SHA = /^[0-9a-f]{40}$/;
const FENCE = '```json';

/** The record of a review-complete comment body, or null when the body is not exactly that shape. */
export function parseReviewRecord(body) {
  const text = String(body ?? '');
  if (!text.startsWith(REVIEW_COMPLETE_MARKER)) return null;
  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''));
  const at = lines.indexOf(FENCE);
  if (at < 0 || lines[at + 2] !== '```') return null;
  let r;
  try {
    r = JSON.parse(lines[at + 1]);
  } catch {
    return null;
  }
  if (r === null || typeof r !== 'object' || Array.isArray(r)) return null;
  if (!HASH.test(String(r.contentHash)) || !SHA.test(String(r.base)) || !SHA.test(String(r.head))) return null;
  if (!Number.isInteger(r.rounds) || r.rounds < 1) return null;
  if (typeof r.codexModel !== 'string' || r.codexModel === '') return null;
  if (r.modelProofDigest !== null && !HASH.test(String(r.modelProofDigest))) return null;
  return { contentHash: r.contentHash, base: r.base, head: r.head, rounds: r.rounds, codexModel: r.codexModel, modelProofDigest: r.modelProofDigest };
}

/**
 * comments: [{ id, by, at, updated, body }] (by = author login, at / updated = created_at / updated_at). allowed(login) says
 * whose comments count (login lowercased). Returns { found: false } when no allowed author posted a marker comment, else
 * { found: true, comment, record, reason }: record is null (and reason says why) when the newest one is edited or malformed.
 */
export function latestReviewComment(comments, allowed) {
  const marked = (Array.isArray(comments) ? comments : [])
    .filter((c) => c && typeof c.body === 'string' && c.body.startsWith(REVIEW_COMPLETE_MARKER)
      && typeof c.by === 'string' && allowed(c.by.toLowerCase()) && Number.isFinite(Date.parse(c.at)))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || Number(a.id) - Number(b.id));
  const comment = marked.at(-1);
  if (!comment) return { found: false };
  // An edit is not a path review-complete ever takes (it posts a new comment or reuses an identical one), so an edited comment
  // says nothing about the review: it is refused rather than skipped, so an older comment cannot come back into force through it.
  // A newer comment that is DELETED (or edited until it no longer starts with the marker) does let the one before it count again
  // (Codex review of 4c595df). That revives nothing unreviewed: every comment is posted by review-complete for a content hash it
  // checked, and the status is success only when that hash is the head's, so an older comment can only vouch for exactly the
  // content it reviewed.
  if (Date.parse(comment.updated) !== Date.parse(comment.at)) return { found: true, comment, record: null, reason: 'the latest review-complete comment was edited after it was posted' };
  const record = parseReviewRecord(comment.body);
  return record
    ? { found: true, comment, record, reason: null }
    : { found: true, comment, record: null, reason: 'the latest review-complete comment does not carry a valid review record' };
}
