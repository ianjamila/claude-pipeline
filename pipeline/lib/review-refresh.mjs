// Merge-carry, the review half: `P merge --owner-go` may update the PR from its base branch, which gives it a new head (H1) the
// review has never seen. When the PR was reviewed (or the repository requires the review check) the review state must follow
// the head before CI is waited on, WITHOUT a Codex run and without asking anyone:
//   - the last round already ended at H1: nothing to record. If the review-complete marker for H1 is on the PR (and vouches for the
//     state we hold) the review is `already-current`; if not, only `review-complete` is run;
//   - otherwise H1 must be a head that only merged the base branch in: `codex-review --base-only` records that as a baseOnly round
//     (no Codex, not counted) and REFUSES (`not-base-only`) anything else, then `review-complete` posts the marker for H1. review-complete
//     publishes the triage state itself (a baseOnly round leaves the PR's copy behind) and takes `awaiting-review` off, so nothing else
//     is a publication step of a baseOnly round: the skill's `P comment --kind triage` is for a round that had items to triage.
// Any refusal or failure is `{ok:false, code, reason}`: the caller stops and tells the owner. This never falls back to a real review.
//
// Both commands take the PR's review lock themselves; the caller (the merge job) holds only the per-PR merge lock, so no lock is
// assumed here. The commands are called in process through their exported `run(argv, ctx)`; `run(name, argv, ctx)` is injectable.
import { loadState } from './state.mjs';
import { createGitHub } from './github.mjs';
import { GhError } from './proc.mjs';
import { readPublished, reviewContentHash } from './review-publish.mjs';

// The real commands, loaded on first use (the review commands pull in most of the pipeline).
export async function runCommand(name, argv, ctx) {
  const mod = name === 'codex-review'
    ? await import('../commands/codex-review.mjs')
    : await import('../commands/review-complete.mjs');
  return mod.run(argv, ctx);
}

const firstLine = (v) => String(v ?? '').split('\n')[0].slice(0, 400);

// A command's refusal as {code, reason}: its error code (error, or the unavailable reason), and the words it gave.
function refusal(name, result) {
  const out = result?.output ?? {};
  const code = typeof out.error === 'string' ? out.error : (typeof out.reason === 'string' && out.unavailable === true ? out.reason : `${name}-failed`);
  const said = out.reason ?? out.message ?? (Array.isArray(out.errors) ? out.errors.join('; ') : undefined);
  const reason = said === undefined ? `${name} exited ${result?.exitCode}` : firstLine(said);
  return { ok: false, code, reason, command: name, exitCode: result?.exitCode ?? null };
}

const trimCodex = (o) => ({ round: o.round, baseOnly: o.baseOnly === true, counts: o.counts, path: o.path });
const trimComplete = (o) => ({
  ...(o.reused ? { reused: true } : { posted: o.posted === true }),
  comment: o.comment ?? null, head: o.review?.head ?? null, rounds: o.review?.rounds ?? null, recheck: o.recheck ?? null,
});

/**
 * @param {{root: string, config: object, pr: number, head: string, ctx?: {cwd?: string, env?: object},
 *   run?: (name: 'codex-review'|'review-complete', argv: string[], ctx: object) => Promise<{exitCode: number, output: object}>,
 *   published?: () => {marker?: {found: boolean, record?: object|null}}}} a
 *   head: the new PR head (the checked-out HEAD). `published` replaces the GitHub read of the PR's comments (tests).
 * @returns {Promise<{ok: true, kind: 'not-applicable'|'already-current'|'base-only'|'review-complete', codexReview?: object, reviewComplete?: object}
 *   | {ok: false, code: string, reason: string, command?: string, exitCode?: number|null}>}
 *   codes: state | state-pr-mismatch | no-review-state | github | not-base-only | (any codex-review / review-complete error code or unavailable
 *   reason, e.g. base-mismatch, head-mismatch, head-moved, round-order, round-cap, unavailable) | codex-review-failed | review-complete-failed | error
 */
export async function refreshReview({ root, config, pr, head, ctx = {}, run = runCommand, published } = {}) {
  const cmdCtx = { ...ctx, cwd: root, env: ctx.env ?? process.env };
  let state;
  try {
    state = loadState(root);
  } catch (err) {
    return { ok: false, code: 'state', reason: firstLine(err.message) };
  }
  if (state && state.pr !== pr) return { ok: false, code: 'state-pr-mismatch', reason: `.review/state.json belongs to PR #${state.pr}, not #${pr}` };
  const rounds = state?.rounds ?? [];
  // R15: nothing was ever reviewed here and no review marker is required: the owner-go merge keeps what it did before.
  if (rounds.length === 0 && config?.ci?.review_check !== true) return { ok: true, kind: 'not-applicable' };
  if (rounds.length === 0) {
    return { ok: false, code: 'no-review-state', reason: 'ci.review_check is on but this checkout holds no review state (.review/state.json): the PR was not reviewed here, so there is nothing to carry to the new head' };
  }
  const last = rounds.at(-1);

  const call = async (name, argv) => {
    try {
      return { result: await run(name, argv, cmdCtx) };
    } catch (err) {
      return { failed: { ok: false, code: 'error', reason: firstLine(err?.message ?? err), command: name, exitCode: null } };
    }
  };

  let codexReview;
  if (last.toHead !== head) {
    const effort = config?.review?.effort?.followup;
    const argv = ['--pr', String(pr), '--round', String(rounds.length + 1), '--base', last.toHead, '--head', head, '--effort', effort, '--base-only', '--repo', root];
    const { result, failed } = await call('codex-review', argv);
    if (failed) return failed;
    if (result.exitCode !== 0 || result.output?.ok !== true) return refusal('codex-review', result);
    // The flag guarantees it; a command that answered ok without recording a base-only round is not trusted.
    if (result.output.baseOnly !== true) return { ok: false, code: 'not-base-only', reason: 'codex-review did not record a base-only round', command: 'codex-review', exitCode: result.exitCode };
    codexReview = trimCodex(result.output);
  } else {
    // The state is at H1 already. The marker may be too (a retry after the job died between the two steps).
    let marker;
    try {
      marker = (published ? published() : readPublished(createGitHub({ cwd: root, env: cmdCtx.env }), pr)).marker;
    } catch (err) {
      if (err instanceof GhError) return { ok: false, code: 'github', reason: firstLine(err.message) };
      throw err;
    }
    if (marker?.found === true && marker.record?.head === head && marker.record?.stateHash === reviewContentHash(state)) {
      return { ok: true, kind: 'already-current' };
    }
  }

  const { result, failed } = await call('review-complete', ['--pr', String(pr), '--repo', root]);
  if (failed) return failed;
  if (result.exitCode !== 0 || result.output?.ok !== true) return { ...refusal('review-complete', result), ...(codexReview ? { codexReview } : {}) };
  return { ok: true, kind: codexReview ? 'base-only' : 'review-complete', ...(codexReview ? { codexReview } : {}), reviewComplete: trimComplete(result.output) };
}
