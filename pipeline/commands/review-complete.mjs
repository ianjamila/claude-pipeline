// Ends a Codex outage: a PR labelled `awaiting-review` was merge-blocked because the cross-model review could not
// run. The label comes off only when the recorded review is valid for the content that exists NOW (a clean round
// covered exactly this content hash, and nothing anywhere is unresolved). Anything less keeps the PR blocked.
import { EXIT, intOption, parseCommandArgs } from '../lib/cli.mjs';
import { Fail, guarded, requireConfig, resolveRepo } from '../lib/cmd-common.mjs';
import { headSha } from '../lib/git.mjs';
import { createGitHub, guardGh } from '../lib/github.mjs';
import { loadState } from '../lib/state.mjs';
import { reviewValidFor, roundOutcome } from '../lib/triage.mjs';
import { currentContentHash, withReviewLock } from '../lib/review-context.mjs';

export const meta = {
  summary: 'remove awaiting-review once the review is valid for the current content',
  usage: [
    'pipeline review-complete --pr N [--repo DIR]   -> exit 0 {ok:true, removed:true}; exit 1 {ok:false, reason} when the review is not valid',
    '  the checked-out HEAD must be the head GitHub holds for the PR; exit 3 when the label is still on the PR after removal',
  ].join('\n'),
};

export const AWAITING_REVIEW = 'awaiting-review';

// Why the review is not valid, in words a person can act on.
function whyNot(state, hash) {
  if (!state) return 'no review state: the review has not run';
  if (state.rounds.length === 0) return 'no review round has run';
  const o = roundOutcome({ ...state, currentContentHash: hash });
  if (o.pending.length > 0) return `items still waiting for a decision: ${o.pending.join(', ')}`;
  if (o.needsHuman.length > 0) return `items need a human: ${o.needsHuman.join(', ')}`;
  if (o.openBlocking.length > 0 || o.unimplemented.length > 0) {
    return `accepted items are not implemented: ${[...new Set([...o.openBlocking, ...o.unimplemented])].join(', ')}`;
  }
  if (!o.coverageValid) return 'no review round covers the current content (the branch changed since the last review)';
  return 'the last review round accepted new items that still need a round to review their fixes';
}

export const run = guarded(async (argv, ctx) => {
  const { values } = parseCommandArgs(argv, { pr: { type: 'string' }, repo: { type: 'string' } }, { allowPositionals: false });
  const pr = intOption(values, 'pr', { required: true, min: 1 });
  const root = resolveRepo(values, ctx);
  const { config } = await requireConfig(root);
  return withReviewLock(root, pr, ctx, () => {
    let state;
    try {
      state = loadState(root);
    } catch (err) {
      throw new Fail(EXIT.USAGE, { ok: false, error: 'state', message: err.message });
    }
    if (state && state.pr !== pr) {
      return { exitCode: EXIT.FAILED, output: { ok: false, reason: `the review state belongs to PR #${state.pr}, not #${pr}` } };
    }
    return guardGh(() => {
      const gh = createGitHub({ cwd: root, env: ctx.env });
      // The review covers the content of the local checkout; the label is on the PR GitHub holds. They must be the same
      // commit, or the review of one would be used to release the other.
      const local = headSha({ cwd: root });
      const remote = gh.prView(pr, ['headRefOid']).headRefOid;
      if (remote !== local) {
        return {
          exitCode: EXIT.FAILED,
          output: { ok: false, reason: `local HEAD ${local} is not the head of PR #${pr} on GitHub (${remote ?? 'unknown'}): push or pull first`, localHead: local, prHead: remote ?? null },
        };
      }
      const hash = currentContentHash(root, config);
      if (!state || !reviewValidFor(state, hash)) {
        return { exitCode: EXIT.FAILED, output: { ok: false, reason: whyNot(state, hash), currentContentHash: hash } };
      }
      gh.removeLabels(pr, [AWAITING_REVIEW]);
      // gh exiting 0 is not the label being gone: read it back, and never report a removal that did not happen.
      if (gh.prLabels(pr).includes(AWAITING_REVIEW)) {
        return {
          exitCode: EXIT.UNAVAILABLE,
          output: { ok: false, unavailable: true, reason: 'label-not-removed', message: `${AWAITING_REVIEW} is still on PR #${pr} after removing it`, pr },
        };
      }
      return { exitCode: EXIT.OK, output: { ok: true, removed: true, pr, currentContentHash: hash } };
    });
  });
});
