// Ends a Codex outage: a PR labelled `awaiting-review` was merge-blocked because the cross-model review could not
// run. The label comes off only when the recorded review is valid for the content that exists NOW (a clean round
// covered exactly this content hash, and nothing anywhere is unresolved). Anything less keeps the PR blocked.
import { EXIT, intOption, parseCommandArgs } from '../lib/cli.mjs';
import { guarded, requireConfig, resolveRepo } from '../lib/cmd-common.mjs';
import { createGitHub, guardGh } from '../lib/github.mjs';
import { loadState } from '../lib/state.mjs';
import { reviewValidFor, roundOutcome } from '../lib/triage.mjs';
import { currentContentHash } from '../lib/review-context.mjs';

export const meta = {
  summary: 'remove awaiting-review once the review is valid for the current content',
  usage: 'pipeline review-complete --pr N [--repo DIR]   -> exit 0 {ok:true, removed:true}; exit 1 {ok:false, reason} when the review is not valid',
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
  const state = loadState(root);
  if (state && state.pr !== pr) {
    return { exitCode: EXIT.FAILED, output: { ok: false, reason: `the review state belongs to PR #${state.pr}, not #${pr}` } };
  }
  const hash = currentContentHash(root, config);
  if (!state || !reviewValidFor(state, hash)) {
    return { exitCode: EXIT.FAILED, output: { ok: false, reason: whyNot(state, hash), currentContentHash: hash } };
  }
  return guardGh(() => {
    createGitHub({ cwd: root, env: ctx.env }).removeLabels(pr, [AWAITING_REVIEW]);
    return { exitCode: EXIT.OK, output: { ok: true, removed: true, pr, currentContentHash: hash } };
  });
});
