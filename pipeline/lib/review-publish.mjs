// Publishing the review state (the triage comment) as a compare-and-swap on CONTENT (plan 2026-11-05-claude-rulings.md E1).
// Why: the triage comment is what survives the machine and what the owner-go / merge checks compare the local state with. Two checkouts of one
// PR can both reach "the same revision number" with different decisions, so a counter proves nothing; what is compared is the CONTENT of every round.
//   reviewContentHash(state)   sha256 of the canonical JSON of the whole `rounds` array.
//   .review/published-baseline.json {pr, hash}   (local only, not part of the state) what THIS copy last published or restored.
//   readPublished(gh, pr)      what the PR holds: the newest viewer-authored triage state, its hash, and the facts the merge check needs.
//   publishTriage(...)         under the review lock: publish only when the PR holds nothing, holds what this copy last saw (baseline), or already
//                              holds this very copy (a retry after a crash between the upsert and the baseline write). Otherwise refuse
//                              `stale-publication`: another checkout published since, and publishing would erase its work.
// Residual (documented): locks are per machine, so two MACHINES publishing in the same second can still race; the merge check's equality still
// catches the loser.
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { EXIT } from './cli.mjs';
import { Fail } from './cmd-common.mjs';
import { MARKERS, triageComment } from './render.mjs';
import { decodeFromComment } from './state.mjs';
import { REVIEW_COMPLETE_MARKER, latestReviewComment } from './review-marker.mjs';
import { canonicalJson, reviewDir, sha256, stateExtends, writeJson } from './review-context.mjs';

export const reviewContentHash = (state) => sha256(canonicalJson(state?.rounds ?? []));

const startsWithAny = (c, markers) => typeof c?.body === 'string' && markers.some((m) => c.body.startsWith(m));

/**
 * Reads the PR's comments once. -> {
 *   state: the newest VIEWER-authored triage comment's state for this PR, or null; hash: reviewContentHash(state) or null,
 *   undecodable: such a comment exists but holds no readable state for this PR,
 *   history: the viewer ever posted a triage or review-complete comment (the review skill has run for this PR),
 *   marker: latestReviewComment(...) over the viewer's comments ({found:false} | {found, comment, record, reason}) }
 * Only comments of ours count: a quoted or forged marker in someone else's comment (or in the middle of ours) must never become the state.
 */
export function readPublished(gh, pr) {
  const me = gh.viewer();
  const comments = gh.listComments(pr);
  const mine = comments.filter((c) => c.user?.login === me);
  const triage = mine
    .filter((c) => typeof c.body === 'string' && c.body.startsWith(MARKERS.triage))
    .sort((a, b) => Number(a.id) - Number(b.id));
  const newest = triage.at(-1);
  const decoded = newest ? decodeFromComment(newest.body) : null;
  const state = decoded && decoded.pr === pr ? decoded : null;
  const meLower = String(me).toLowerCase();
  const marker = latestReviewComment(
    comments.map((c) => ({ id: c.id, by: c.user?.login, at: c.created_at, updated: c.updated_at, body: c.body })),
    (login) => login === meLower,
  );
  return {
    state,
    hash: state ? reviewContentHash(state) : null,
    undecodable: newest !== undefined && state === null,
    history: mine.some((c) => startsWithAny(c, [MARKERS.triage, REVIEW_COMPLETE_MARKER])),
    marker,
  };
}

// ---- the local baseline ---------------------------------------------------------------------------------------------------------------

const baselineFile = (root) => path.join(reviewDir(root), 'published-baseline.json');

// The hash this copy last published or restored for PR `pr`; null when there is no baseline file, it is unreadable, or it is for another PR.
export function readBaseline(root, pr) {
  try {
    const b = JSON.parse(readFileSync(baselineFile(root), 'utf8'));
    return b && b.pr === pr && typeof b.hash === 'string' && /^[0-9a-f]{64}$/.test(b.hash) ? b.hash : null;
  } catch {
    return null;
  }
}

export function writeBaseline(root, pr, hash) {
  mkdirSync(reviewDir(root), { recursive: true });
  writeJson(baselineFile(root), { pr, hash });
}

/**
 * A checkout with no baseline (it predates the file) whose state already IS what the PR holds: record that, BEFORE a decision changes the state. Without it the first
 * decision on a published item can never publish (publishTriage's no-baseline fallback needs the state to extend the published one, and a decided item does not),
 * and `state show` would quarantine it. Only when the two are equal; otherwise nothing is written and the rules stay as they are. -> true when a baseline was written.
 * `published` is an already-read readPublished() result, or omitted to read it here, only when there is no baseline (may throw GhError).
 */
export function establishBaseline({ gh, root, pr, state, published }) {
  if (readBaseline(root, pr) !== null) return false; // checked first: with a baseline there is nothing to establish, so no GitHub read
  published ??= readPublished(gh, pr);
  if (published.state === null || published.hash !== reviewContentHash(state)) return false;
  writeBaseline(root, pr, published.hash);
  return true;
}

// ---- the swap -------------------------------------------------------------------------------------------------------------------------

const RETRY_SHOW = (pr) => `run \`pipeline state show --pr ${pr}\` to restore the published state here, then redo this decision`;

/**
 * Publishes `state` as the PR's triage comment, under the caller's review lock. -> { action: 'created' | 'updated' | 'unchanged', id?, url? }.
 * Throws Fail(EXIT.FAILED, {ok:false, error:'stale-publication', reason}) when the PR holds a different state than this copy last published
 * (or, with no usable baseline for this PR, one this copy does not extend: a state from an older CLI is still allowed to move forward). Throws GhError
 * when GitHub fails (the caller decides: exit 3, or "local result stands").
 */
export function publishTriage({ gh, root, pr, state }) {
  const published = readPublished(gh, pr);
  const mine = reviewContentHash(state);
  if (published.state !== null && published.hash !== mine) {
    const baseline = readBaseline(root, pr);
    const allowed = baseline !== null ? published.hash === baseline : stateExtends(state, published.state);
    if (!allowed) {
      throw new Fail(EXIT.FAILED, {
        ok: false, error: 'stale-publication',
        reason: `the PR's triage comment holds a review state this copy did not publish or restore (another checkout or machine published since): publishing now would erase it; ${RETRY_SHOW(pr)}`,
        pr,
      });
    }
  }
  let result;
  if (published.state !== null && published.hash === mine) {
    result = { action: 'unchanged' };
  } else {
    const r = gh.upsertComment(pr, MARKERS.triage, triageComment(state), { retry: true });
    result = { action: r.action, url: r.url, id: r.id };
  }
  writeBaseline(root, pr, mine);
  return result;
}
