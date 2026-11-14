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
import { git, headSha, isAncestor, mergeBase, revParse } from '../lib/git.mjs';
import { behindFreshEnough, lazyDiff } from '../lib/finalgate.mjs';
import { QueueUnreadable, queueModeFor } from '../lib/merge-queue.mjs';
import { createGitHub, guardGh } from '../lib/github.mjs';
import { assessRisk, prBaseBranch, rateBranch, reviewLane } from '../lib/risk.mjs';
import { routeConfigFor } from '../lib/review-round.mjs';
import { isSubstituteRound, loadState } from '../lib/state.mjs';
import { readReviewGate } from '../lib/model-floor.mjs';
import { noteReviewed } from '../lib/codex-usage.mjs';
import { fableBypassNote, fableBypassRounds, reviewEligibilityProblems, reviewValidFor, roundOutcome, rulingsDigest, staleFableReason, staleFableRounds, substituteDigest, substituteRefusal, substituteSummary } from '../lib/triage.mjs';
import { verifyOwnerGrants } from '../lib/owner-grants.mjs';
import { docsExemptFrom } from '../lib/docs-exempt.mjs';
import { REVIEW_COMPLETE_MARKER } from '../lib/review-marker.mjs';
import { closingKeywordProblem, multiIssueClosingLines } from '../lib/closing-keywords.mjs';
import { anchorBranch, currentContentHash, refreshBaseRef, refreshTrustedDefault, reviewBaseRef, withReviewLock } from '../lib/review-context.mjs';
import { publishTriage, readPublished, reviewContentHash } from '../lib/review-publish.mjs';

export const meta = {
  summary: 'post the review-complete comment (and remove awaiting-review) once the review is valid for the current content',
  usage: [
    'pipeline review-complete --pr N [--repo DIR]   -> exit 0 {ok:true, posted|reused, comment:{id, url}, review, removed, recheck, recheckError?, warnings?}; exit 1 {ok:false, reason} when the review is not valid',
    '  origin/<default branch> (the anchor `pipeline risk` describes: the trusted fork point of the model and lanes too) is fetched first (best effort: offline keeps the cached ref, and a coverage refusal then says it could not be refreshed), so a PR updated',
    '  from its base branch and pulled is judged against the main that was merged in',
    '  after the validity checks it also refuses (exit 1) while a Claude-ruled follow-up has no issue or a fix made outside the file the finding names is not yet',
    '  confirmed by a later round, and (exit 1 {error:closing-keywords}) a PR body that lists several issues after one closing keyword ("Closes #1, #2" closes only #1),',
    '  a substitute review (a Claude stand-in for Codex while its quota was spent) writes substitute {rounds, agents, models} and substituteDigest into the record, and codexModel none-substitute:<model> when no Codex round ran (the newest Codex model otherwise); it refuses (exit 1 {error}) substitute-escalation (a high-risk PR whose substitute rounds were Opus alone, with no later whole-PR Fable-substitute or Codex round) and substitute-unproven (a substitute round whose agent, models, effort or Fable floor proof does not hold)',
    '  then publishes the triage state when the PR holds a different one (exit 1 {error:stale-publication} when the PR holds a state this',
    '  copy did not publish or restore: run `pipeline state show --pr N`), and only then posts the marker. The record carries rulingsDigest only when there are rulings',
    '  the checked-out HEAD must be the head GitHub holds for the PR; the PR must have had every Fable pass its risk or paths need',
    `  the comment starts with the line ${'`<!-- claude-pipeline:review-complete v1 -->`'} and carries the JSON {contentHash, base, head, rounds, codexModel, modelProofDigest, stateHash}`,
    '  (base = the merge base the content hash is measured from; modelProofDigest = sha256 of the Fable model proofs, null when no Fable pass ran; stateHash = the hash of the review state the marker',
    '  was issued for: the owner-go review-complete check refuses a state republished after the marker, and a marker from before the field, until `review-complete` is run again);',
    '  an identical latest comment of ours is reused, not posted again; exit 3 when GitHub is unavailable or the label is still on the PR after removal',
    '  a round past review.max_rounds must carry the owner\'s extra-round grant (codex-review records it), re-proved here against the owner\'s record and its marker on THIS machine (the',
    '  same check as the final gate\'s review check): exit 1 {ok:false, reason: "round n: owner grant cannot be verified on this machine ..."} otherwise',
    '  a proven Fable round recorded with a Fable older than MIN_FABLE (or the lower hold of model-floor reset --hold) that no later whole-PR pass at or above it replaced is refused: exit 1 {ok:false, error:fable-refresh, reason, staleFableRounds:[{round, models}]},',
    '  the reason names the rounds and models and says `run `pipeline state fable-refresh --pr N``; the final gate\'s review check refuses the same PR the same way',
    '  when GitHub names no base branch and the default branch cannot be anchored on the remote (an origin remote that answered neither origin/HEAD nor ls-remote: the working tree\'s default_branch is the PR\'s to edit), it is refused too: exit 1 {ok:false, reason: "GitHub did not name the PR\'s base branch, and ..."}',
    '  when a proven Fable round counts as current only because of the owner\'s allowance (model-floor reset --allow-id, an id the parser cannot read) or a hold below MIN_FABLE, the comment gets one line',
    '  "Standing Fable bypass: Fable round 3 counted via owner allowance <id>" (or "... via owner hold <id> (below <MIN_FABLE>)"), the output carries fableBypass:{note, rounds:[{round, via, id}]},',
    '  and the final gate\'s review check detail carries the same note',
    '  a DRAFT whose head lacks commits of origin/<default branch> is refused last, before anything is published or posted (labels stay): exit 1 {ok:false, reason:\'behind-base\', error:\'behind-base\', base, behindBy, detail (why the check refused it: the helper\'s reason), remedy},',
    '  so the review skill catches it up BEFORE `gh pr ready` and CI runs once, on current main: the remedy is `pipeline update-branch --pr N`, `git pull --ff-only`, the next codex-review round (only main was merged in: baseOnly, Codex does not run,',
    '  nothing is counted), then review-complete again. merge.behind_base: update = behind when origin/<default branch> is not an ancestor of HEAD; disjoint = behind only when the merge would refuse it too (the same check as `merge --owner-go`; a `mergeable` GitHub has not computed yet, UNKNOWN, is not a conflict: if everything else passes, the draft posts with a warning).',
    '  A ready PR is never refused for this; the check is skipped with a `warnings` entry when the base ref could not be refreshed (offline), the base has a merge queue (or it cannot be read), or the ancestry cannot be read',
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

// The state says which rounds needed Fable, but the state is a local file: re-derive the lane from the PR itself (its files, size and
// recorded risk, rated under the working-tree config and the default branch's committed one, risk.mjs#rateBranch) and refuse a PR that needs
// Fable when no round ran a proven Fable pass. A recorded high risk is Fable without looking further. When the hard stops cannot be collected the
// lane is Fable whatever the level (fail closed). A recorded medium stays medium and only the judge lane of a fresh size-only medium may keep it
// with the judge: a medium that came from a hit (now gone from a fresh scan, or never found by it) needs Fable.
// `prBase`: the PR's base branch; a stack never gets the size-only judge (rateBranch). Without one it is the TRUSTED default branch (rateBranch defaults it; never the
// working-tree config's default_branch, which the PR can edit: #398).
export async function laneProblem(state, root, config, base, { prBase, rate = rateBranch } = {}) {
  const recorded = LEVELS.includes(state.risk) ? state.risk : 'low';
  const proven = state.rounds.some((r) => r.fableRequired === true && r.arbiter?.proofOk === true);
  const needs = (why) => (proven ? null : `the PR needs the Fable review pass (${why}), but no review round ran a proven one`);
  if (recorded === 'high') return needs('high risk');
  let rated;
  try {
    rated = await rate({ root, head: 'HEAD', config, ...(prBase === undefined ? {} : { prBase }), base });
  } catch (err) {
    return needs(`hard stops could not be collected: ${oneLine(err)}`);
  }
  if (rated.reviewer === 'fable') return needs(rated.laneReasons.join('; ') || `${rated.level} risk`);
  if (recorded === 'medium' && rated.sizeOnly !== true) return needs('recorded medium risk');
  return null;
}

// The Fable review passes that count: proven ones of Fable rounds, in round order (a dispute-mode ruling or a failed
// attempt is not a Fable review). Empty for a judge-only PR, so its digest is null.
export const fableProofs = (state) => (state?.rounds ?? [])
  .filter((r) => r.fableRequired === true && r.arbiter?.proofOk === true && r.modelProof && typeof r.modelProof === 'object')
  .map((r) => ({ round: r.n, transcript: r.modelProof.transcript, models: r.modelProof.models, ...(r.modelProof.effort ? { effort: r.modelProof.effort } : {}) }));

export function reviewRecord(state, { contentHash, base, head, modelProofs, defaultCodexModel }) {
  const rulings = rulingsDigest(state);
  const substitute = substituteSummary(state);
  // The newest round Codex itself reviewed: its model is the marker's codexModel. A PR whose rounds were ALL reviewed by a substitute has none: the field then says so
  // (`none-substitute:<model>`, still a non-empty string for an older parser) instead of naming a Codex model that never ran. Mixed history: the newest Codex round's model, plus `substitute`.
  const last = substitute === null ? state.rounds.at(-1) : state.rounds.findLast((r) => !isSubstituteRound(r) && typeof r?.codexModel === 'string' && r.codexModel !== '');
  return {
    contentHash,
    base,
    head,
    rounds: state.rounds.length,
    codexModel: typeof last?.codexModel === 'string' && last.codexModel !== '' ? last.codexModel : substitute === null ? defaultCodexModel : `none-substitute:${substitute.models[0] ?? substitute.agents[0]}`,
    modelProofDigest: modelProofs.length > 0 ? createHash('sha256').update(JSON.stringify(modelProofs)).digest('hex') : null,
    // The review state this marker vouches for (the one just published): the owner-go check refuses a state republished after it.
    stateHash: reviewContentHash(state),
    // Only when there are rulings, so the marker of an ordinary review is byte-identical to what it always was.
    ...(rulings === 'none' ? {} : { rulingsDigest: rulings }),
    // Only when a substitute reviewed (triage.mjs#substituteInventory): the final gate compares the digest with the live inventory.
    ...(substitute === null ? {} : { substitute, substituteDigest: substituteDigest(state) }),
  };
}

// docsExempt ({ files, reviewedHead }, lib/docs-exempt.mjs): the head is past the last reviewed one only by lines added to listed documents.
// The record is unchanged (the guards read the same JSON); the extra line is for the people reading the PR.
// fableNote (triage.mjs#fableBypassNote): a Fable round counts as current only because of an owner allowance or hold; the line sits outside the JSON record.
// "Codex <model>" for an ordinary review; with a substitute: "Codex <model>, substitute review of round(s) 2-3 by substitute-opus (Claude ...)" or, when no Codex round ran, "no Codex round, substitute review ...".
const reviewerWords = (record) => {
  const sub = record.substitute;
  if (!sub) return `Codex \`${record.codexModel}\``;
  const rounds = sub.rounds.length > 0 ? ` of round(s) ${sub.rounds.join(', ')}` : '';
  const who = `substitute review${rounds} by ${sub.agents.join(', ')} (Claude ${sub.models.join(', ') || 'model unrecorded'}) while Codex was out of quota`;
  return record.codexModel.startsWith('none-substitute:') ? `no Codex round, ${who}` : `Codex \`${record.codexModel}\` and ${who}`;
};
export function reviewCompleteBody(record, docsExempt = null, fableNote = null) {
  const fable = record.modelProofDigest ? `, Fable proof \`${record.modelProofDigest.slice(0, 8)}\`` : '';
  const docs = docsExempt
    ? [`**Docs-only exemption** (review.docs_exempt_paths): lines were added to ${docsExempt.files.map((f) => `\`${f}\``).join(', ')} after the last reviewed head \`${docsExempt.reviewedHead.slice(0, 12)}\`; no new review round.`]
    : [];
  return [
    REVIEW_COMPLETE_MARKER,
    `**Cross-model review complete** for \`${record.head.slice(0, 12)}\`: ${record.rounds} round(s), ${reviewerWords(record)}${fable}.`,
    ...docs,
    ...(fableNote ? [`**Standing Fable bypass:** ${fableNote}.`] : []),
    '',
    '```json',
    JSON.stringify(record),
    '```',
    '',
  ].join('\n');
}

const oneLine = (err) => String(err?.message ?? err).split('\n')[0].slice(0, 200);

// A DRAFT that lacks commits of origin/<default branch> is caught up BEFORE it is marked ready, so its required CI runs once, on current main (the
// merge dry run sees behind-base only after CI, and the catch-up then costs a second full run). A ready PR is never judged here: the merge flow handles it.
// -> { refusal } (the output of the exit-1 refusal) | { warning } (the check could not be made: offline refresh, a merge queue, an unreadable queue or
// ancestry; never a block) | {} (not a draft, or not behind). merge.behind_base: 'update' = behind when origin/<branch> is not an ancestor of HEAD;
// 'disjoint' = behind only when the merge path would refuse it too (finalgate.behindFreshEnough, which reads the mode from the BASE commit's config).
function draftBehindBase({ root, config, gh, pr, view, refresh }) {
  if (view.isDraft !== true) return {};
  const branch = anchorBranch(root, config);
  if (!refresh.refreshed) return { warning: `behind-base check skipped: origin/${branch} could not be refreshed (${refresh.reason ?? 'fetch failed'})` };
  const o = { cwd: root };
  let baseSha;
  try {
    baseSha = revParse(`refs/remotes/origin/${branch}^{commit}`, o);
    if (isAncestor(baseSha, 'HEAD', o)) return {};
  } catch (err) {
    return { warning: `behind-base check skipped: could not compare HEAD with origin/${branch} (${oneLine(err)})` };
  }
  try {
    if (queueModeFor({ gh, pr }).queue) return { warning: `behind-base check skipped: ${branch} has a merge queue, which tests the PR on top of the current base itself` };
  } catch (err) {
    if (!(err instanceof QueueUnreadable)) throw err;
    return { warning: `behind-base check skipped: ${err.message}` };
  }
  // The helper wants GitHub's mergeStateStatus, which is DRAFT here and would always refuse; GitHub's `mergeable` (conflicts) still counts.
  // GitHub recomputes `mergeable` lazily after the base moves, so right then it can answer UNKNOWN (or nothing): that is "not known yet", not a
  // conflict. The helper refuses anything but MERGEABLE, so ask it with MERGEABLE and warn when that is what made it pass; the conflict-free
  // checks (mode, overlapping files, toolchain paths) still refuse as usual. Only CONFLICTING is a real answer.
  const known = view.mergeable === 'MERGEABLE' || view.mergeable === 'CONFLICTING';
  const fresh = behindFreshEnough({
    root, config, diff: lazyDiff(root, config, { sha: baseSha, branch }), baseSha,
    info: { mergeStateStatus: 'CLEAN', mergeable: known ? view.mergeable : 'MERGEABLE' }, branch,
  });
  if (fresh.ok) {
    return known ? {} : { warning: `behind-base check skipped: GitHub had not computed the PR's mergeability yet (mergeable is ${JSON.stringify(view.mergeable ?? null)}), so conflicts were not ruled out; origin/${branch} changed no file this PR touches` };
  }
  let behindBy = null;
  try {
    const n = Number(git(['rev-list', '--count', `HEAD..${baseSha}`], o).trim());
    if (Number.isInteger(n)) behindBy = n;
  } catch { /* the count is a courtesy */ }
  return {
    refusal: {
      ok: false, reason: 'behind-base', error: 'behind-base', base: branch, behindBy, detail: fresh.reason,
      remedy: `this draft lacks commits of origin/${branch}; catch it up before it is marked ready, so CI runs once on current ${branch}: run \`pipeline update-branch --pr ${pr}\`, \`git pull --ff-only\`, `
        + 'then the next codex-review round (only main was merged in, so it is baseOnly: Codex does not run and nothing is counted), then review-complete again',
    },
  };
}

export const run = guarded(async (argv, ctx) => {
  const { values } = parseCommandArgs(argv, { pr: { type: 'string' }, repo: { type: 'string' } }, { allowPositionals: false });
  const pr = intOption(values, 'pr', { required: true, min: 1 });
  const root = resolveRepo(values, ctx);
  const { config } = await requireConfig(root);
  const result = await withReviewLock(root, pr, ctx, () => {
    let state;
    try {
      state = loadState(root);
    } catch (err) {
      throw new Fail(EXIT.USAGE, { ok: false, error: 'state', message: err.message });
    }
    if (state && state.pr !== pr) {
      return { exitCode: EXIT.FAILED, output: { ok: false, reason: `the review state belongs to PR #${state.pr}, not #${pr}` } };
    }
    return guardGh(async () => {
      const gh = createGitHub({ cwd: root, env: ctx.env });
      // The review covers the content of the local checkout; the comment and the label are on the PR GitHub holds. They
      // must be the same commit, or the review of one would be used to vouch for the other.
      const local = headSha({ cwd: root });
      const view = gh.prView(pr, ['headRefOid', 'isDraft', 'labels', 'body', 'mergeable', 'baseRefName']);
      const remote = view.headRefOid;
      if (remote !== local) {
        return {
          exitCode: EXIT.FAILED,
          output: { ok: false, reason: `local HEAD ${local} is not the head of PR #${pr} on GitHub (${remote ?? 'unknown'}): push or pull first`, localHead: local, prHead: remote ?? null },
        };
      }
      // The hash is measured from origin/<default branch>; after `update-branch` + `git pull --ff-only` that ref is older than the main that
      // was merged in, so refresh it first (best effort: offline keeps the cached ref and the round's own hash is what it is compared to).
      const refresh = refreshBaseRef(root, config);
      refreshTrustedDefault(root, config, { except: anchorBranch(root, config) }); // refreshBaseRef fetched the anchor already; the trusted fork point (model, lanes) is measured from the remote's default branch, which can be another one
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
            ? ` (origin/${anchorBranch(root, config)} could not be refreshed: ${refresh.reason})` : '';
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
      const grantOpts = { repo: gh.repo().slug, pr, maxRounds: config.review.max_rounds };
      let grants = verifyOwnerGrants(state, grantOpts);
      if (!grants.ok) {
        // The refusal for a round that ran before grants were recorded names the remedy only for a round the PR really holds: read the published state for that (best effort).
        let published;
        try {
          published = readPublished(gh, pr).state ?? { rounds: [] };
        } catch { /* local-only remedy text */ }
        if (published !== undefined) grants = verifyOwnerGrants(state, { ...grantOpts, published });
      }
      if (!grants.ok) return { exitCode: EXIT.FAILED, output: { ok: false, reason: grants.problems.join('; '), currentContentHash: hash } };
      const base = mergeBase(reviewBaseRef(root, config), local, { cwd: root });
      // GitHub's base branch, else the trusted default branch; when that fallback is the working tree's own (an origin remote that did not answer) the PR chose it: refuse (S1).
      const { branch: prBase, untrusted: prBaseUntrusted } = prBaseBranch(view, root, config);
      if (prBaseUntrusted !== null) return { exitCode: EXIT.FAILED, output: { ok: false, reason: `GitHub did not name the PR's base branch, and ${prBaseUntrusted}`, currentContentHash: hash } };
      const lane = await laneProblem(state, root, config, base, { prBase });
      if (lane) return { exitCode: EXIT.FAILED, output: { ok: false, reason: lane, currentContentHash: hash } };
      // A Claude stand-in reviewed instead of Codex (plan 2026-11-11-codex-substitute-reviewer): a high-risk PR it covered with Opus alone, or a substitute round whose proof does not hold, is refused.
      const subRefusal = substituteRefusal(state, gate);
      if (subRefusal) return { exitCode: EXIT.FAILED, output: { ok: false, reason: subRefusal.reason, error: subRefusal.error, currentContentHash: hash } };
      // Items that read as resolved but are not yet: a Claude-ruled follow-up with no issue, a fix made outside the file the finding names that no
      // later round confirmed (triage.mjs#reviewEligibilityProblems).
      const eligibility = reviewEligibilityProblems(state);
      if (eligibility.length > 0) return { exitCode: EXIT.FAILED, output: { ok: false, reason: eligibility.join('; '), currentContentHash: hash } };
      // Last, once the review itself is valid: a body that names several issues after ONE closing keyword ("Closes #170, #171") closes only the
      // first on merge. Fixing it is a body edit, not a code change, so no round is owed (lib/closing-keywords.mjs).
      const closing = closingKeywordProblem(multiIssueClosingLines(view.body), pr);
      if (closing) return { exitCode: EXIT.FAILED, output: { ok: false, reason: closing, error: 'closing-keywords', currentContentHash: hash } };
      // A draft behind its base is refused BEFORE anything is published or posted (labels stay as they are); see draftBehindBase.
      const behind = draftBehindBase({ root, config, gh, pr, view, refresh });
      if (behind.refusal) return { exitCode: EXIT.FAILED, output: { ...behind.refusal, currentContentHash: hash } };
      const warnings = behind.warning ? [behind.warning] : [];
      // The marker vouches for the state the PR holds, so publish it first when it differs (a base-only round or a late mark-implemented leaves the
      // copies apart). A PR that holds a state this copy did not publish or restore is refused (stale-publication, exit 1); GitHub failing is exit 3.
      publishTriage({ gh, root, pr, state });

      const record = reviewRecord(state, {
        contentHash: hash, base, head: local, modelProofs: fableProofs(state), defaultCodexModel: routeConfigFor(root, config).codexModel,
      });
      const bypass = fableBypassRounds(state, gate);
      const fableNote = fableBypassNote(bypass, gate);
      const body = reviewCompleteBody(record, docsExempt, fableNote);
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
          ...(fableNote ? { fableBypass: { note: fableNote, rounds: bypass } } : {}),
          ...(recheckError ? { recheckError } : {}), ...(warnings.length > 0 ? { warnings } : {}), pr, currentContentHash: hash,
        },
      };
    });
  });
  // The PR is reviewed: it no longer waits for Codex (best effort: a failure here is a warning, never a failed review).
  if (result.exitCode !== EXIT.OK || result.output?.ok !== true) return result;
  const parked = await noteReviewed({ pr, repo: () => createGitHub({ cwd: root, env: ctx.env }).repo().slug, env: ctx.env });
  return parked.length === 0 ? result : { ...result, output: { ...result.output, warnings: [...(result.output.warnings ?? []), ...parked] } };
});
