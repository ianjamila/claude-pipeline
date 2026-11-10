// Records that the cross-model review of a PR ended clean, for exactly the content that exists NOW (a clean round covered
// this content hash, nothing anywhere is unresolved, and every Fable pass the PR needed is proven). Then it posts the
// review-complete comment: a fixed marker line plus JSON {contentHash, base, head, rounds, codexModel, modelProofDigest, stateHash},
// which is what marks the PR as reviewed (the review instructions mark the PR ready only after it exists; the guard
// workflow will check it against the head). It also ends a Codex outage: `awaiting-review` comes off the PR once the
// review is valid. Anything less posts nothing and keeps the label.
// The guard workflow judges the comment on its next run. A draft gets one when it is marked ready; a PR that is ready
// already (a re-review after a push) gets no event from a comment, so the command adds and removes the label
// `pipeline-recheck` (a labeling event starts the guards; nothing else listens to it). Best effort: a failed nudge is
// reported (recheck: 'failed') and never undoes the posted comment.
import { createHash } from 'node:crypto';
import { EXIT, intOption, parseCommandArgs } from '../lib/cli.mjs';
import { Fail, guarded, requireConfig, resolveRepo } from '../lib/cmd-common.mjs';
import { diffFiles, headSha, mergeBase } from '../lib/git.mjs';
import { createGitHub, guardGh } from '../lib/github.mjs';
import { assessRisk, reviewLane } from '../lib/risk.mjs';
import { loadState } from '../lib/state.mjs';
import { readReviewGate } from '../lib/model-floor.mjs';
import { reviewEligibilityProblems, reviewValidFor, roundOutcome, rulingsDigest, staleFableReason, staleFableRounds } from '../lib/triage.mjs';
import { verifyOwnerGrants } from '../lib/owner-grants.mjs';
import { docsExemptFrom } from '../lib/docs-exempt.mjs';
import { REVIEW_COMPLETE_MARKER } from '../lib/review-marker.mjs';
import { closingKeywordProblem, multiIssueClosingLines } from '../lib/closing-keywords.mjs';
import { currentContentHash, refreshBaseRef, reviewBaseRef, withReviewLock } from '../lib/review-context.mjs';
import { publishTriage, reviewContentHash } from '../lib/review-publish.mjs';

export const meta = {
  summary: 'post the review-complete comment (and remove awaiting-review) once the review is valid for the current content',
  usage: [
    'pipeline review-complete --pr N [--repo DIR]   -> exit 0 {ok:true, posted|reused, comment:{id, url}, review, removed, recheck, recheckError?}; exit 1 {ok:false, reason} when the review is not valid',
    '  origin/<default_branch> is fetched first (best effort: offline keeps the cached ref, and a coverage refusal then says it could not be refreshed), so a PR updated',
    '  from its base branch and pulled is judged against the main that was merged in',
    '  after the validity checks it also refuses (exit 1) while a Claude-ruled follow-up has no issue or a fix made outside the file the finding names is not yet',
    '  confirmed by a later round, and (exit 1 {error:closing-keywords}) a PR body that lists several issues after one closing keyword ("Closes #1, #2" closes only #1),',
    '  then publishes the triage state when the PR holds a different one (exit 1 {error:stale-publication} when the PR holds a state this',
    '  copy did not publish or restore: run `pipeline state show --pr N`), and only then posts the marker. The record carries rulingsDigest only when there are rulings',
    '  the checked-out HEAD must be the head GitHub holds for the PR; the PR must have had every Fable pass its risk or paths need',
    `  the comment starts with the line ${'`<!-- claude-pipeline:review-complete v1 -->`'} and carries the JSON {contentHash, base, head, rounds, codexModel, modelProofDigest, stateHash}`,
    '  (base = the merge base the content hash is measured from; modelProofDigest = sha256 of the Fable model proofs, null when no Fable pass ran; stateHash = the hash of the review state the marker',
    '  was issued for: the owner-go review-complete check refuses a state republished after the marker, and a marker from before the field, until `review-complete` is run again);',
    '  an identical latest comment of ours is reused, not posted again; exit 3 when GitHub is unavailable or the label is still on the PR after removal',
    '  a round past review.max_rounds must carry the owner\'s extra-round grant (codex-review records it), re-proved here against the owner\'s record and its marker on THIS machine (the',
    '  same check as the final gate\'s review check): exit 1 {ok:false, reason: "round n: owner grant cannot be verified on this machine ..."} otherwise',
    '  a proven Fable round recorded with a Fable older than MIN_FABLE that no later whole-PR pass at or above it replaced is refused: exit 1 {ok:false, error:fable-refresh, reason, staleFableRounds:[{round, models}]},',
    '  the reason names the rounds and models and says `run `pipeline state fable-refresh --pr N``; the final gate\'s review check refuses the same PR the same way',
  ].join('\n'),
};

export const AWAITING_REVIEW = 'awaiting-review';
export { REVIEW_COMPLETE_MARKER };
export const RECHECK_LABEL = 'pipeline-recheck';
const LEVELS = ['low', 'medium', 'high'];

// Why the review is not valid, in words a person can act on.
function whyNot(state, hash) {
  if (!state) return 'no review state: the review has not run';
  if (state.rounds.length === 0) return 'no review round has run';
  const o = roundOutcome({ ...state, currentContentHash: hash });
  if (o.fablePending.length > 0) return `the Fable review pass has not been proven for round ${o.fablePending.join(', ')}: run arbiter needed / apply`;
  if (o.pending.length > 0) return `items still waiting for a decision: ${o.pending.join(', ')}`;
  if (o.needsHuman.length > 0) return `items need a human: ${o.needsHuman.join(', ')}`;
  if (o.openBlocking.length > 0 || o.unimplemented.length > 0) {
    return `accepted items are not implemented: ${[...new Set([...o.openBlocking, ...o.unimplemented])].join(', ')}`;
  }
  if (!o.coverageValid) return 'no review round covers the current content (the branch changed since the last review)';
  return 'the last review round accepted new items that still need a round to review their fixes';
}

// The state says which rounds needed Fable, but the state is a local file: re-derive the lane from the PR itself (its
// files, size and recorded risk) and refuse a PR that needs Fable when no round ran a proven Fable pass.
function laneProblem(state, root, config, base) {
  const files = diffFiles(base, 'HEAD', { cwd: root });
  const measured = assessRisk({ files, hits: [], config }).level; // hard-stop hits are in the recorded risk
  const recorded = LEVELS.includes(state.risk) ? state.risk : 'low';
  const level = LEVELS[Math.max(LEVELS.indexOf(measured), LEVELS.indexOf(recorded))];
  const lane = reviewLane({ level, files, config });
  if (lane.reviewer !== 'fable') return null;
  const proven = state.rounds.some((r) => r.fableRequired === true && r.arbiter?.proofOk === true);
  return proven ? null : `the PR needs the Fable review pass (${lane.reasons.join('; ')}), but no review round ran a proven one`;
}

// The Fable review passes that count: proven ones of Fable rounds, in round order (a dispute-mode ruling or a failed
// attempt is not a Fable review). Empty for a judge-only PR, so its digest is null.
export const fableProofs = (state) => (state?.rounds ?? [])
  .filter((r) => r.fableRequired === true && r.arbiter?.proofOk === true && r.modelProof && typeof r.modelProof === 'object')
  .map((r) => ({ round: r.n, transcript: r.modelProof.transcript, models: r.modelProof.models, ...(r.modelProof.effort ? { effort: r.modelProof.effort } : {}) }));

export function reviewRecord(state, { contentHash, base, head, modelProofs, defaultCodexModel }) {
  const rulings = rulingsDigest(state);
  const last = state.rounds.at(-1);
  return {
    contentHash,
    base,
    head,
    rounds: state.rounds.length,
    codexModel: typeof last?.codexModel === 'string' && last.codexModel !== '' ? last.codexModel : defaultCodexModel,
    modelProofDigest: modelProofs.length > 0 ? createHash('sha256').update(JSON.stringify(modelProofs)).digest('hex') : null,
    // The review state this marker vouches for (the one just published): the owner-go check refuses a state republished after it.
    stateHash: reviewContentHash(state),
    // Only when there are rulings, so the marker of an ordinary review is byte-identical to what it always was.
    ...(rulings === 'none' ? {} : { rulingsDigest: rulings }),
  };
}

// docsExempt ({ files, reviewedHead }, lib/docs-exempt.mjs): the head is past the last reviewed one only by lines added to listed documents.
// The record is unchanged (the guards read the same JSON); the extra line is for the people reading the PR.
export function reviewCompleteBody(record, docsExempt = null) {
  const fable = record.modelProofDigest ? `, Fable proof \`${record.modelProofDigest.slice(0, 8)}\`` : '';
  const docs = docsExempt
    ? [`**Docs-only exemption** (review.docs_exempt_paths): lines were added to ${docsExempt.files.map((f) => `\`${f}\``).join(', ')} after the last reviewed head \`${docsExempt.reviewedHead.slice(0, 12)}\`; no new review round.`]
    : [];
  return [
    REVIEW_COMPLETE_MARKER,
    `**Cross-model review complete** for \`${record.head.slice(0, 12)}\`: ${record.rounds} round(s), Codex \`${record.codexModel}\`${fable}.`,
    ...docs,
    '',
    '```json',
    JSON.stringify(record),
    '```',
    '',
  ].join('\n');
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
      // The review covers the content of the local checkout; the comment and the label are on the PR GitHub holds. They
      // must be the same commit, or the review of one would be used to vouch for the other.
      const local = headSha({ cwd: root });
      const view = gh.prView(pr, ['headRefOid', 'isDraft', 'labels', 'body']);
      const remote = view.headRefOid;
      if (remote !== local) {
        return {
          exitCode: EXIT.FAILED,
          output: { ok: false, reason: `local HEAD ${local} is not the head of PR #${pr} on GitHub (${remote ?? 'unknown'}): push or pull first`, localHead: local, prHead: remote ?? null },
        };
      }
      // The hash is measured from origin/<default_branch>; after `update-branch` + `git pull --ff-only` that ref is older than the main that
      // was merged in, so refresh it first (best effort: offline keeps the cached ref and the round's own hash is what it is compared to).
      const refresh = refreshBaseRef(root, config);
      const hash = currentContentHash(root, config);
      // The review is valid for the content as it is, or (review.docs_exempt_paths) the content is the reviewed one plus lines added to
      // listed documents. The same helper decides it in the final gate; everything below (grants, Fable, the lane) runs either way.
      let docsExempt = null;
      if (!state || !reviewValidFor(state, hash)) {
        const ex = state ? docsExemptFrom(state, { root, config, hash }) : null;
        if (!ex?.exempt) {
          const why = whyNot(state, hash);
          const note = ex && !ex.off ? `; the docs-only exemption does not apply: ${ex.reason}` : '';
          // A stale origin/<branch> is the one cause a person cannot see: say that the ref could not be refreshed.
          const stale = !refresh.refreshed && refresh.usesRemoteRef && why.startsWith('no review round covers')
            ? ` (origin/${config.default_branch} could not be refreshed: ${refresh.reason})` : '';
          return { exitCode: EXIT.FAILED, output: { ok: false, reason: `${why}${stale}${note}`, currentContentHash: hash } };
        }
        docsExempt = ex;
      }
      // A Fable pass proven below MIN_FABLE (or the owner's lower hold) is re-reviewed, not grandfathered (plan 2026-11-10 A4b): the same refusal as the final gate's review check.
      const gate = readReviewGate({ env: ctx.env ?? process.env });
      const staleFable = staleFableRounds(state, gate);
      if (staleFable.length > 0) {
        return { exitCode: EXIT.FAILED, output: { ok: false, reason: staleFableReason(staleFable, pr, gate.threshold), error: 'fable-refresh', staleFableRounds: staleFable, currentContentHash: hash } };
      }
      // The same proof as the final gate: a round past review.max_rounds must be backed by the owner's record and its marker.
      const grants = verifyOwnerGrants(state, { repo: gh.repo().slug, pr, maxRounds: config.review.max_rounds });
      if (!grants.ok) return { exitCode: EXIT.FAILED, output: { ok: false, reason: grants.problems.join('; '), currentContentHash: hash } };
      const base = mergeBase(reviewBaseRef(root, config), local, { cwd: root });
      const lane = laneProblem(state, root, config, base);
      if (lane) return { exitCode: EXIT.FAILED, output: { ok: false, reason: lane, currentContentHash: hash } };
      // Items that read as resolved but are not yet: a Claude-ruled follow-up with no issue, a fix made outside the file the finding names that no
      // later round confirmed (triage.mjs#reviewEligibilityProblems).
      const eligibility = reviewEligibilityProblems(state);
      if (eligibility.length > 0) return { exitCode: EXIT.FAILED, output: { ok: false, reason: eligibility.join('; '), currentContentHash: hash } };
      // Last, once the review itself is valid: a body that names several issues after ONE closing keyword ("Closes #170, #171") closes only the
      // first on merge. Fixing it is a body edit, not a code change, so no round is owed (lib/closing-keywords.mjs).
      const closing = closingKeywordProblem(multiIssueClosingLines(view.body), pr);
      if (closing) return { exitCode: EXIT.FAILED, output: { ok: false, reason: closing, error: 'closing-keywords', currentContentHash: hash } };
      // The marker vouches for the state the PR holds, so publish it first when it differs (a base-only round or a late mark-implemented leaves the
      // copies apart). A PR that holds a state this copy did not publish or restore is refused (stale-publication, exit 1); GitHub failing is exit 3.
      publishTriage({ gh, root, pr, state });

      const record = reviewRecord(state, {
        contentHash: hash, base, head: local, modelProofs: fableProofs(state), defaultCodexModel: config.review.codex_model,
      });
      const body = reviewCompleteBody(record, docsExempt);
      // Retrying after a crash must not stack identical comments: our own latest marker comment with this exact body stands.
      // It must also be what the guard workflow will judge (lib/review-marker.mjs#latestReviewComment): the newest marker comment
      // of ANY author, and never edited — an edited one, even if edited back to this text, fails there forever (Codex review of
      // 4c595df). Otherwise a new comment is posted.
      const me = gh.viewer();
      const latest = gh.listComments(pr)
        .filter((c) => typeof c.body === 'string' && c.body.startsWith(REVIEW_COMPLETE_MARKER))
        .sort((a, b) => Number(a.id) - Number(b.id))
        .at(-1);
      const reused = latest !== undefined && latest.user?.login === me && latest.body.trim() === body.trim()
        && String(latest.updated_at ?? '') === String(latest.created_at ?? '');
      const comment = reused ? { id: latest.id, url: latest.html_url ?? null } : gh.createComment(pr, body);

      gh.removeLabels(pr, [AWAITING_REVIEW]);
      // gh exiting 0 is not the label being gone: read it back, and never report a removal that did not happen.
      if (gh.prLabels(pr).includes(AWAITING_REVIEW)) {
        return {
          exitCode: EXIT.UNAVAILABLE,
          output: { ok: false, unavailable: true, reason: 'label-not-removed', message: `${AWAITING_REVIEW} is still on PR #${pr} after removing it`, pr, comment },
        };
      }
      // Removing awaiting-review already fired an `unlabeled` event; a draft gets its run when it is marked ready.
      const hadAwaiting = (Array.isArray(view.labels) ? view.labels : []).some((l) => (typeof l === 'string' ? l : l?.name) === AWAITING_REVIEW);
      let recheck = view.isDraft === false ? (hadAwaiting ? 'label-removed' : 'triggered') : 'on-ready';
      let recheckError = null;
      if (recheck === 'triggered') {
        try {
          gh.addLabels(pr, [RECHECK_LABEL]);
          gh.removeLabels(pr, [RECHECK_LABEL]);
        } catch (err) {
          recheck = 'failed';
          recheckError = `${String(err?.message ?? err).split('\n')[0].slice(0, 160)}; run \`P labels\` (creates ${RECHECK_LABEL}), then add and remove ${RECHECK_LABEL} by hand, so the guards post Cross-model review`;
        }
      }
      return {
        exitCode: EXIT.OK,
        output: {
          ok: true, ...(reused ? { reused: true } : { posted: true }), comment, review: record, removed: true, recheck,
          ...(docsExempt ? { docsExempt: { files: docsExempt.files, reviewedHead: docsExempt.reviewedHead } } : {}),
          ...(recheckError ? { recheckError } : {}), pr, currentContentHash: hash,
        },
      };
    });
  });
});
