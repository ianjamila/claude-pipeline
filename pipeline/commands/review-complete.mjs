// Records that the cross-model review of a PR ended clean, for exactly the content that exists NOW (a clean round covered
// this content hash, nothing anywhere is unresolved, and every Fable pass the PR needed is proven). Then it posts the
// review-complete comment: a fixed marker line plus JSON {contentHash, base, head, rounds, codexModel, modelProofDigest},
// which is what marks the PR as reviewed (the review instructions mark the PR ready only after it exists; the guard
// workflow will check it against the head). It also ends a Codex outage: `awaiting-review` comes off the PR once the
// review is valid. Anything less posts nothing and keeps the label.
import { createHash } from 'node:crypto';
import { EXIT, intOption, parseCommandArgs } from '../lib/cli.mjs';
import { Fail, guarded, requireConfig, resolveRepo } from '../lib/cmd-common.mjs';
import { diffFiles, headSha, mergeBase } from '../lib/git.mjs';
import { createGitHub, guardGh } from '../lib/github.mjs';
import { assessRisk, reviewLane } from '../lib/risk.mjs';
import { loadState } from '../lib/state.mjs';
import { reviewValidFor, roundOutcome } from '../lib/triage.mjs';
import { currentContentHash, readModelProofs, reviewBaseRef, withReviewLock } from '../lib/review-context.mjs';

export const meta = {
  summary: 'post the review-complete comment (and remove awaiting-review) once the review is valid for the current content',
  usage: [
    'pipeline review-complete --pr N [--repo DIR]   -> exit 0 {ok:true, posted|reused, comment:{id, url}, review, removed}; exit 1 {ok:false, reason} when the review is not valid',
    '  the checked-out HEAD must be the head GitHub holds for the PR; the PR must have had every Fable pass its risk or paths need',
    `  the comment starts with the line ${'`<!-- claude-pipeline:review-complete v1 -->`'} and carries the JSON {contentHash, base, head, rounds, codexModel, modelProofDigest}`,
    '  (base = the merge base the content hash is measured from; modelProofDigest = sha256 of the Fable model proofs, null when no Fable pass ran);',
    '  an identical latest comment of ours is reused, not posted again; exit 3 when GitHub is unavailable or the label is still on the PR after removal',
  ].join('\n'),
};

export const AWAITING_REVIEW = 'awaiting-review';
export const REVIEW_COMPLETE_MARKER = '<!-- claude-pipeline:review-complete v1 -->';
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

export function reviewRecord(state, { contentHash, base, head, modelProofs, defaultCodexModel }) {
  const last = state.rounds.at(-1);
  return {
    contentHash,
    base,
    head,
    rounds: state.rounds.length,
    codexModel: typeof last?.codexModel === 'string' && last.codexModel !== '' ? last.codexModel : defaultCodexModel,
    modelProofDigest: modelProofs.length > 0 ? createHash('sha256').update(JSON.stringify(modelProofs)).digest('hex') : null,
  };
}

export function reviewCompleteBody(record) {
  const fable = record.modelProofDigest ? `, Fable proof \`${record.modelProofDigest.slice(0, 8)}\`` : '';
  return [
    REVIEW_COMPLETE_MARKER,
    `**Cross-model review complete** for \`${record.head.slice(0, 12)}\`: ${record.rounds} round(s), Codex \`${record.codexModel}\`${fable}.`,
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
      const base = mergeBase(reviewBaseRef(root, config), local, { cwd: root });
      const lane = laneProblem(state, root, config, base);
      if (lane) return { exitCode: EXIT.FAILED, output: { ok: false, reason: lane, currentContentHash: hash } };

      const record = reviewRecord(state, {
        contentHash: hash, base, head: local, modelProofs: readModelProofs(root, state), defaultCodexModel: config.review.codex_model,
      });
      const body = reviewCompleteBody(record);
      // Retrying after a crash must not stack identical comments: our own latest marker comment with this exact body stands.
      const me = gh.viewer();
      const latest = gh.listComments(pr)
        .filter((c) => typeof c.body === 'string' && c.body.startsWith(REVIEW_COMPLETE_MARKER) && c.user?.login === me)
        .sort((a, b) => Number(a.id) - Number(b.id))
        .at(-1);
      const reused = latest !== undefined && latest.body.trim() === body.trim();
      const comment = reused ? { id: latest.id, url: latest.html_url ?? null } : gh.createComment(pr, body);

      gh.removeLabels(pr, [AWAITING_REVIEW]);
      // gh exiting 0 is not the label being gone: read it back, and never report a removal that did not happen.
      if (gh.prLabels(pr).includes(AWAITING_REVIEW)) {
        return {
          exitCode: EXIT.UNAVAILABLE,
          output: { ok: false, unavailable: true, reason: 'label-not-removed', message: `${AWAITING_REVIEW} is still on PR #${pr} after removing it`, pr, comment },
        };
      }
      return {
        exitCode: EXIT.OK,
        output: { ok: true, ...(reused ? { reused: true } : { posted: true }), comment, review: record, removed: true, pr, currentContentHash: hash },
      };
    });
  });
});
