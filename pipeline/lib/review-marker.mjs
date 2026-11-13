// The review-complete comment: what `pipeline review-complete` posts once the cross-model review of a PR ended clean, and
// what the pipeline-guards workflow reads back to post the `Cross-model review` status. One definition, shared by the
// command that writes it, the CI orchestrator that reads it (vendored into projects) and the git guard that keeps agents
// from posting it any other way.
//
// The comment: the marker line, one line of prose, then a ```json fence holding ONE line of JSON
//   { contentHash, base, head, rounds, codexModel, modelProofDigest, stateHash[, rulingsDigest][, substitute, substituteDigest] }
// contentHash is git.mjs#reviewContentHash of the reviewed head (merge base -> head, agent log excluded); base is that merge
// base; modelProofDigest is the sha256 of the Fable model proofs, or null when no Fable pass ran. rulingsDigest (lib/triage.mjs#rulingsDigest,
// the dismissed BLOCKING / security items and who decided them) is written only when there are some: an ordinary marker has no such field,
// and a marker without it reads as 'none' (parseReviewRecord). stateHash (lib/review-publish.mjs#reviewContentHash) is the hash of the review state the marker was
// issued for: the owner-go check (finalgate.mjs#reviewCompletionCheck) requires it to equal the state it is judging, so a state republished after the marker
// does not ride on it. A marker written before the field reads as 'none' and is valid here (the CI status only judges the content) but refused there.
// substitute { rounds, agents, models } and substituteDigest (lib/triage.mjs#substituteDigest) are written only when a Claude stand-in reviewed instead of Codex (plan
// 2026-11-11-codex-substitute-reviewer): the digest is compared with the live inventory like rulingsDigest, so a substitute round or second review added at the same head is not covered
// by an older marker. With no Codex round at all codexModel reads `none-substitute:<model>` (any non-empty string passes an older parser, so older vendored CI guards print that instead of
// a Codex model that never ran). An older parser drops the two keys it does not know.
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
  // Absent = 'none' (a marker written before rulings, or for a review with none); present must be a 64-hex digest.
  if (r.rulingsDigest !== undefined && !(typeof r.rulingsDigest === 'string' && HASH.test(r.rulingsDigest))) return null;
  // Absent = 'none' (a marker written before the field); present must be a 64-hex hash.
  if (r.stateHash !== undefined && !(typeof r.stateHash === 'string' && HASH.test(r.stateHash))) return null;
  // Absent = none; present: a 64-hex digest and a { rounds: [int], agents: [string], models: [string] } summary (both or neither).
  const sub = r.substitute;
  const subOk = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string' && x !== '');
  if (sub !== undefined) {
    if (sub === null || typeof sub !== 'object' || Array.isArray(sub)) return null;
    if (!Array.isArray(sub.rounds) || !sub.rounds.every((n) => Number.isInteger(n) && n > 0) || !subOk(sub.agents) || !subOk(sub.models)) return null;
    if (!(typeof r.substituteDigest === 'string' && HASH.test(r.substituteDigest))) return null;
  } else if (r.substituteDigest !== undefined) {
    return null;
  }
  return {
    contentHash: r.contentHash, base: r.base, head: r.head, rounds: r.rounds, codexModel: r.codexModel, modelProofDigest: r.modelProofDigest,
    rulingsDigest: r.rulingsDigest === undefined ? 'none' : r.rulingsDigest,
    stateHash: r.stateHash === undefined ? 'none' : r.stateHash,
    // (only when present, so the record of an ordinary review reads exactly as it always did; absent = 'none')
    ...(sub === undefined ? {} : { substituteDigest: r.substituteDigest, substitute: { rounds: [...sub.rounds], agents: [...sub.agents], models: [...sub.models] } }),
  };
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
