// The shared half of a review round: everything that decides whether a round may be recorded and then records it, with no
// reviewer in it. `P codex-review` runs a round as admitRound -> (build the prompt: roundPrompt) -> ask Codex -> recordRound; a
// second reviewer (the Claude substitute while Codex is out of quota) calls the same two functions, so round order, the base
// rule, the round cap, owner grants, the conflict-resolution proof and the state write cannot drift between the two paths.
//
//  admitRound   the pre-run admission, before the reviewer is asked anything: round order (round-order / state-pr-mismatch), the PR on
//               GitHub (exit 3 `github` when unreachable), the base rule (base-mismatch), risk / light lane / reviewer, the range that is
//               shown (merge base, previous head, merge-from-base left out, resolution-only), baseOnly, empty-range, the round cap and the
//               owner grant lookup (round-cap). Writes .review/round-R/diff.patch. Nothing about the round is saved yet.
//  recordRound  the final admission under the per-PR review lock once the reviewer has answered (the lock is not held while a reviewer
//               runs): the state is read again, round order / cap / base are re-checked, the head must not have moved, a
//               resolution-only waiver is proven again, the owner grant is claimed as the last step before the state is saved, prior
//               rulings are reused, addRound, codex.json / codex.md are written and the state is saved.
//
// Reviewer-specific facts go in `roundFields` (spread into the stored round after the range fields: today `codexModel` and
// `promptSha256`; a substitute passes `firstReviewer` / `substitute` and no codexModel). The module never reads them back.
import path from 'node:path';
import { EXIT } from './cli.mjs';
import { assignIds, buildReviewPrompt, largeBinaryNote, renderFindingsMarkdown } from './codex.mjs';
import { Fail } from './cmd-common.mjs';
import {
  GitError, NETWORK_TIMEOUT_MS, diffFiles, effectiveReviewBase, git, headSha, mergeBase, resolutionReviewBase, reviewPatch, showFile,
} from './git.mjs';
import { collectHardStops } from './hardstops.mjs';
import { createGitHub } from './github.mjs';
import { GhError } from './proc.mjs';
import { assessRisk, isLightLane, reviewLane } from './risk.mjs';
import { addRound, emptyState, loadState, maxRiskOf, saveState } from './state.mjs';
import { linkDeferredFollowups, reuseRuled, reviewedRoundCount, roundAdmission, roundOutcome, ruledCacheFrom } from './triage.mjs';
import { claimGrantMarkers, grantIdOf, ownerGrantConfigDirHint, ownerGrantedRounds, ownerGrantGap } from '../hooks/lib/owner-go.mjs';
import {
  allItems, currentContentHash, ensureRoundDir, excerptWindow, reviewBaseRef, roundDir, withReviewLock, writeFileAtomic, writeJson,
} from './review-context.mjs';

// What the prompt and the stored round carry of a proven resolution. The lists are cut to 50 (dropped blocks first, so a cut never
// hides a drop); the totals are over ALL blocks and travel with them, so nothing downstream has to count a truncated list.
export const resolutionSummary = (r) => ({
  conflicted: r.conflicted.slice(0, 50),
  conflictedCount: r.conflictedCount,
  blocks: [...r.blocks.filter((b) => b.droppedTheirs > 0), ...r.blocks.filter((b) => b.droppedTheirs === 0)].slice(0, 50),
  blockCount: r.blockCount,
  blocksWithDrops: r.blocksWithDrops,
  droppedTheirsTotal: r.droppedTheirsTotal,
});

// Exit 3: the reviewer or GitHub could not deliver. Never "found nothing".
export const unavailable = (reason, extra = {}) => new Fail(EXIT.UNAVAILABLE, { ok: false, unavailable: true, reason, ...extra });

export const headMoved = () => new Fail(EXIT.USAGE, { ok: false, error: 'head-moved', message: 'HEAD moved while Codex was reviewing; run the round again' });

// The review state on disk (null when there is none); a state that cannot be read is exit 2, never "start fresh".
export const readReviewState = (root) => {
  try {
    return loadState(root);
  } catch (err) {
    throw new Fail(EXIT.USAGE, { ok: false, error: 'state', message: err.message });
  }
};

// Is this the next round of this PR's review? Run before the reviewer and again under the lock afterwards (the cap: see checkCap).
export const checkRound = (st, { pr, round }) => {
  if (st && st.pr !== pr) {
    throw new Fail(EXIT.USAGE, {
      ok: false, error: 'state-pr-mismatch', message: `.review/state.json belongs to PR #${st.pr}, not #${pr}`,
    });
  }
  const expected = (st?.rounds.length ?? 0) + 1;
  if (round !== expected) {
    const exists = st?.rounds.some((r) => r.n === round);
    throw new Fail(EXIT.USAGE, {
      ok: false, error: 'round-order',
      message: exists ? `round ${round} already exists in the review state` : `next round is ${expected}, not ${round}`,
    });
  }
};

// Round 1 starts at the PR's merge base; every later round starts where the previous one ended.
export const checkBase = (st, { round, base, forkPoint }) => {
  const last = st?.rounds.at(-1);
  const required = last ? last.toHead : forkPoint;
  if (base !== required) {
    throw new Fail(EXIT.USAGE, {
      ok: false, error: 'base-mismatch',
      message: last
        ? `round ${round} must start at the previous round's toHead ${required}, not ${base}`
        : `round 1 must review the whole PR: --base must be its merge base ${required}, not ${base}`,
    });
  }
};

// The round cap counts reviewed rounds only, so it waits until baseOnly / resolutionOnly are known (before anything is written for the round).
// An owner grant is looked up only when ordinary admission does not cover the round, and only in chat mode (label mode never grants).
// The lookup is the owner's records for this PR on github.com (the gh repo), any head: roundAdmission compares the head itself.
// The gh repo is resolved eagerly in admitRound, in chat mode, before any admission check: roundAdmission swallows what the lookup throws
// (no grant), so a GitHub failure here would otherwise read as a round-cap refusal instead of exit 3.
const ownerRecords = (c, k) => {
  if (c.config.owner_approval !== 'chat') return [];
  if (c.ghRepo.host !== 'github.com') return [];
  return ownerGrantedRounds({ repo: c.ghRepo.slug, pr: c.pr, k, anyHead: true }).map((r) => ({ grantId: grantIdOf(r), head: r.head, quote: r.prompt }));
};
const reviewedAdmission = ({ baseOnly, resolutionOnly }) => (baseOnly || resolutionOnly ? 'uncounted' : 'normal');
const admit = (c, st, flags) => (st
  ? roundAdmission(st, c.round, { ...flags, head: c.head, grants: (k) => ownerRecords(c, k) })
  : { admission: reviewedAdmission(flags), problem: null });
// #128: an extra round recorded for this PR whose prompt cannot be confirmed as the owner's grants nothing; the refusal says so (and, R2-F3, says the config dir must be a .claude* folder under the home when that may be the reason).
const unconfirmedGrant = (c, st) => {
  try {
    if (c.config.owner_approval !== 'chat' || c.ghRepo?.host !== 'github.com') return '';
    const q = { repo: c.ghRepo.slug, pr: c.pr, k: reviewedRoundCount(st) + 1, anyHead: true };
    if (ownerGrantGap(q) !== 'provenance') return '';
    const hint = ownerGrantConfigDirHint(q);
    return `; an extra round is recorded for this PR, but it cannot be confirmed as typed by the owner (it may have been typed while the agent was still working)${hint ? ` (${hint})` : ''}: run \`P triage round-request\` again, show its FRESH closing lines, and ask the owner to type "extra round" again after the reply ends`;
  } catch {
    return '';
  }
};
// Returns the admission ('normal' | 'uncounted' | 'extraRound' | 'owner'); a refused round is exit 2 round-cap.
export const checkCap = (c, st, flags, { already = false } = {}) => {
  const { admission, problem } = admit(c, st, flags);
  // resolutionIneligible: why the free (resolution-only) round was refused, when one was tried (it is computed before the cap).
  if (problem) {
    throw new Fail(EXIT.USAGE, {
      ok: false, error: 'round-cap',
      message: (already ? `the owner's extra round was already used (grant already used): ${problem}` : problem) + unconfirmedGrant(c, st),
      ...(c.resolutionIneligible === undefined ? {} : { resolutionIneligible: c.resolutionIneligible }),
    });
  }
  return admission;
};

// Phase one. `base` and `head` are full SHAs (head is the checked-out HEAD). Returns the admitted round (opaque to the caller except
// for these fields): { state, view, slug, ghRepo, forkPoint, level, lane, fable, lightLane, review: {base, kind}, resolution,
// resolutionOnly, resolutionView, resolutionIneligible, baseOnly, patch, largeBinaries, preAdmission, priorRulings, confirmItems,
// hashAtHead, dir } plus the inputs it was given.
export async function admitRound({ root, config, ctx, pr, round, base, head }) {
  const o = { cwd: root };
  const dir = roundDir(root, round);
  const c = { root, config, ctx, pr, round, base, head, dir, ghRepo: undefined, resolutionIneligible: undefined };

  const state = readReviewState(root);
  checkRound(state, c);

  const gh = createGitHub({ cwd: root, env: ctx.env });
  let view;
  let slug;
  try {
    view = gh.prView(pr, ['title', 'body', 'headRefName', 'baseRefName']);
    if (config.owner_approval === 'chat') c.ghRepo = gh.repo();
    if (!state) slug = gh.repo().slug;
  } catch (err) {
    if (err instanceof GhError) throw unavailable('github', { error: 'unavailable', message: err.message });
    throw err;
  }

  // The merge base of the whole PR: where the PR forked from the branch it targets (origin/<base> when it exists).
  const prBase = typeof view.baseRefName === 'string' && view.baseRefName !== '' ? view.baseRefName : config.default_branch;
  // Best effort: a fresh origin/<base> is what "merged in from the base branch" is measured against. Offline, no remote or a
  // slow one just means the cached ref is used.
  try {
    git(['fetch', '--no-tags', 'origin', `+refs/heads/${prBase}:refs/remotes/origin/${prBase}`], { ...o, timeoutMs: NETWORK_TIMEOUT_MS });
  } catch (err) {
    if (!(err instanceof GitError)) throw err;
  }
  const forkPoint = mergeBase(reviewBaseRef(root, config, prBase), head, o);
  c.forkPoint = forkPoint;
  checkBase(state, c);

  // Risk and light lane describe the whole PR (merge base..head), whatever slice this round reviews. A later round can
  // only take a PR off the light lane, never put it on.
  const files = diffFiles(forkPoint, head, o);
  const hits = await collectHardStops({ base: forkPoint, head, cwd: root, config });
  const { level, changedLines } = assessRisk({ files, hits, config });
  // The reviewer after Codex: a PR that was ever reviewed by Fable stays with Fable (a later round can only escalate), and a
  // Fable PR is never on the light lane (that lane exists to skip the second reviewer).
  const lane = reviewLane({ level, files, config });
  const fable = lane.reviewer === 'fable' || state?.reviewer === 'fable';
  const lightLane = !fable && (state ? state.lightLane === true : true) && isLightLane({ level, changedLines, hits, config });

  // What the reviewer is shown (and what the fix commits are measured against) is exactly this range. Round 1 starts at the merge
  // base; a later round starts where the previous one ended, with the base branch's commits merged in since then taken out.
  // Only commits that came from the protected default branch are left out: the base side is origin/<default_branch> (never a
  // branch the PR author chose), and a PR that targets any other branch leaves nothing out. A failed or stale fetch only
  // leaves an older origin/<default_branch>, which can only make the range bigger.
  // The conflict case ('whole-pr' above): when the merge of the default branch conflicted and the resolution only chose lines the
  // two sides had, the range is the resolution alone and the round is free of the cap (resolutionReviewBase has every rule).
  const baseBranchRef = reviewBaseRef(root, config, prBase);
  c.tryResolution = () => resolutionReviewBase({ from: base, forkPoint, head, baseRef: baseBranchRef }, o);
  let review = { base: forkPoint, kind: 'merge-base' };
  let resolution = null;
  if (state?.rounds.length > 0) {
    review = prBase === config.default_branch
      ? effectiveReviewBase({ from: base, forkPoint }, o)
      : { base, kind: 'previous' };
    if (review.kind === 'whole-pr') {
      const found = c.tryResolution();
      if (found.ineligible === undefined) {
        resolution = found;
        review = { base: found.base, kind: 'resolution' };
      } else {
        c.resolutionIneligible = found.ineligible;
      }
    }
  }
  const resolutionOnly = resolution !== null;
  // Large binary documents would overflow the buffer; they are named at the end of the patch and in the prompt instead.
  const { patch, skipped: largeBinaries } = reviewPatch(review.base, head, o);
  // Only the base branch was merged in since the last round: there is nothing of the PR's own to review.
  const baseOnly = review.kind === 'synthetic' && patch === '' && largeBinaries.length === 0;
  // A later round exists to review the fixes for what earlier rounds accepted. An empty range (or no change in the branch content
  // since the last round) reviews nothing, and would let an unfixed accepted item look resolved. It is judged HERE, once baseOnly
  // is known: a round that only merged the base branch in is never refused (it is recorded below, without Codex, and does not
  // count; an accepted, unfixed item stays unimplemented through it: roundOutcome / reviewValidFor skip baseOnly rounds). A clean
  // merge that leaves the content hash alone is exactly that case, so refusing it as empty-range (#1658) was wrong. Still before
  // checkCap and before anything is written. base == head is kind 'previous' with an empty patch, so never baseOnly.
  const hasAccepted = allItems(state ?? { rounds: [] }).some((i) => i.final?.decision === 'ACCEPT');
  if (state && hasAccepted && !baseOnly && (base === head || currentContentHash(root, config) === state.rounds.at(-1)?.contentHashAtToHead)) {
    const last = state.rounds.at(-1).n;
    const waiting = roundOutcome(state).newAccepted;
    throw new Fail(EXIT.USAGE, {
      ok: false, error: 'empty-range',
      message: waiting.length > 0
        ? `round ${round} would review nothing: the branch content has not changed since round ${last}, and these accepted items still need a fix: commit the fix for ${waiting.join(', ')} first`
        : `round ${round} would review nothing: nothing new to review: the content is what round ${last} reviewed; if that round was clean, review-complete uses it`,
    });
  }
  const preAdmission = checkCap(c, state, { baseOnly, resolutionOnly });
  const resolutionView = resolutionOnly ? resolutionSummary(resolution) : null;
  ensureRoundDir(root, round);
  const note = largeBinaryNote(largeBinaries);
  writeFileAtomic(path.join(dir, 'diff.patch'), note.length === 0 ? patch : `${patch}\nLarge binary files (content not shown):\n${note.join('\n')}\n`);

  const priorItems = allItems(state ?? { rounds: [] });
  const cache = ruledCacheFrom(priorItems);
  const latestByFingerprint = new Map();
  for (const item of priorItems) if (Object.hasOwn(cache, item.fingerprint ?? '')) latestByFingerprint.set(item.fingerprint, item);
  const priorRulings = [...latestByFingerprint].map(([fp, item]) => ({
    id: item.id, title: item.title, ruling: `${cache[fp].decision ?? 'unknown'}: ${cache[fp].reason ?? ''}`,
  }));
  // Accepted items a forced or Claude ruling marked fixed through OTHER files than the one they name (state mark-implemented, implementedVia
  // 'other-files'), not yet asked about in an earlier round: this round's prompt asks whether they are really fixed, and the round records the ids
  // (round.confirmFixed) so review-complete can see they were asked. A base-only round asks nothing, so it consumes none.
  const confirmed = new Set((state?.rounds ?? []).flatMap((r) => (Array.isArray(r.confirmFixed) ? r.confirmFixed : [])));
  const confirmItems = baseOnly ? [] : priorItems.filter((i) => i.implementedVia === 'other-files' && !confirmed.has(i.id));

  return {
    ...c, state, view, slug, level, lane, fable, lightLane, review, resolution, resolutionOnly, resolutionView,
    baseOnly, patch, largeBinaries, preAdmission, priorRulings, confirmItems, hashAtHead: currentContentHash(root, config),
  };
}

// The exact prompt of an admitted round (the reviewer's whole brief: range, risk, prior rulings, confirm-fixed list, resolution).
export const roundPrompt = (adm) => buildReviewPrompt({
  pr: adm.pr, title: adm.view.title, body: adm.view.body, base: adm.review.base, head: adm.head, risk: adm.level, round: adm.round,
  lightLane: adm.lightLane, priorRulings: adm.priorRulings, rulesRef: adm.forkPoint, largeBinaries: adm.largeBinaries, baseKind: adm.review.kind,
  sensitivePaths: adm.lane.sensitivePaths,
  ...(adm.confirmItems.length > 0 ? { confirmFixed: adm.confirmItems.map((i) => ({ id: i.id, title: i.title, file: i.file, detail: i.detail })) } : {}),
  ...(adm.resolutionOnly ? { resolution: { from: adm.base, forkPoint: adm.forkPoint, ...adm.resolutionView } } : {}),
});

// A base-merge-only round has nothing to ask about: zero findings, and the round says why.
export const baseOnlyFindings = () => ({
  summary: 'Only the base branch was merged in since the previous round; Codex was not run.', blocking: [], suggestions: [], worth_considering: [],
});

// Phase two. `findings` are the reviewer's validated findings (validateFindings ok). `roundFields` are stored on the round as given.
// `gate()` runs inside the lock right after the round-order check, before anything is written (throw to abort: codex-review's compare-and-swap on route.json, exit 2 superseded);
// `afterSave()` runs inside the lock once the state is saved.
// Returns { items (the round's items after reuse of prior rulings), state (the saved state), grantUsed: {grantId} | undefined }.
export async function recordRound({ adm, findings, roundFields = {}, gate, afterSave }) {
  const { root, ctx, pr, round, base, head, config, dir } = adm;
  const o = { cwd: root };
  const flags = { baseOnly: adm.baseOnly, resolutionOnly: adm.resolutionOnly };

  const fileCache = new Map();
  const excerptFor = (file, line) => {
    if (!file) return '';
    if (!fileCache.has(file)) {
      let text = null;
      try {
        text = showFile(head, file, o);
      } catch (err) {
        if (!(err instanceof GitError)) throw err; // an unreadable path is treated like a missing file
      }
      fileCache.set(file, text);
    }
    return excerptWindow(fileCache.get(file), line)?.lines.join('\n') ?? '';
  };
  let grantUsed;
  let saved;
  const items = await withReviewLock(root, pr, ctx, async () => {
    // The reviewer took a while: whatever happened to the review meanwhile (another session recorded this round, the PR's
    // state was replaced) is read again, and what is there now wins.
    const fresh = readReviewState(root);
    checkRound(fresh, adm); // a round another writer recorded meanwhile wins first (exit 2 round-order), as before
    if (gate) await gate();
    // A grant that admitted the round before the reviewer ran but is gone now (another checkout claimed it meanwhile) says so.
    const admission = checkCap(adm, fresh, flags, { already: adm.preAdmission === 'owner' });
    checkBase(fresh, adm);
    if (headSha(o) !== head) throw headMoved();
    // The cap waiver rests on the proof above. from (checkBase), head and forkPoint are pinned, but origin/<default> may have moved
    // while the reviewer ran, and it is one of the proof's inputs: prove it again, and only accept the very range it was shown.
    if (adm.resolutionOnly && adm.tryResolution().base !== adm.review.base) {
      throw new Fail(EXIT.USAGE, { ok: false, error: 'resolution-changed', message: 'the conflict resolution can no longer be proven while Codex was reviewing; run the round again' });
    }
    if (!fresh && adm.slug === undefined) {
      throw new Fail(EXIT.USAGE, { ok: false, error: 'state-changed', message: '.review/state.json disappeared while Codex was reviewing; run the round again' });
    }
    // The owner's grant is read here and claimed just before the state is saved (below), after everything else that can fail has run.
    let ownerGrant;
    let claimGrant = () => {};
    if (admission === 'owner') {
      const k = reviewedRoundCount(fresh) + 1;
      const records = ownerGrantedRounds({ repo: adm.ghRepo.slug, pr, k, head });
      const newest = records[0];
      if (newest !== undefined) ownerGrant = { grantId: grantIdOf(newest), k, quote: newest.prompt, ownerTs: newest.ts };
      // Every record that covers this head is consumed together (a duplicate "extra round" must not admit a second run after
      // discard-round); the first claimer on the machine wins. A failed claim discards the reviewer's answer.
      claimGrant = () => {
        const claim = claimGrantMarkers(records, { repo: adm.ghRepo.slug, pr, k, head, checkout: root });
        if (!claim.ok) {
          throw new Fail(EXIT.USAGE, {
            ok: false, error: 'round-cap',
            message: claim.reason === 'used' || claim.reason === 'none'
              ? "the owner's extra round was already used (grant already used): ask the owner again (triage round-request)"
              : `the owner's extra round could not be claimed (${claim.reason}) and is spent: ask the owner again (triage round-request)`,
          });
        }
      };
    }
    const base0 = fresh ?? emptyState({ repo: adm.slug, pr, branch: adm.view.headRefName ?? 'HEAD', risk: adm.level, lightLane: adm.lightLane, maxRounds: config.review.max_rounds });
    const ruled = linkDeferredFollowups(reuseRuled(assignIds(findings, round, excerptFor, { contentHash: adm.hashAtHead }), ruledCacheFrom(allItems(base0)), { round }), allItems(base0));
    const reviewer = adm.fable || fresh?.reviewer === 'fable' ? 'fable' : 'judge';
    const reasons = adm.lane.reasons.length > 0 ? adm.lane.reasons : ['reviewed by Fable in an earlier round'];
    // maxRisk is read from the state as it was BEFORE this round overwrites state.risk (a legacy state without maxRisk starts it from what it recorded).
    const next = addRound({ ...base0, ...(fresh ? { maxRisk: maxRiskOf(fresh) } : {}), risk: adm.level, lightLane: reviewer === 'fable' ? false : adm.lightLane, reviewer, currentContentHash: adm.hashAtHead }, {
      n: round, fromHead: base, toHead: head, contentHashAtToHead: adm.hashAtHead, items: ruled, risk: adm.level,
      reviewBase: adm.review.base, reviewBaseKind: adm.review.kind, forkPoint: adm.forkPoint, ...roundFields, ...(adm.baseOnly ? { baseOnly: true } : {}),
      ...(admission === 'uncounted' ? {} : { admission }), ...(ownerGrant === undefined ? {} : { ownerGrant }),
      ...(adm.confirmItems.length > 0 ? { confirmFixed: adm.confirmItems.map((i) => i.id) } : {}),
      ...(adm.resolutionOnly ? { resolutionOnly: true, ...adm.resolutionView } : {}),
      ...(reviewer === 'fable' && !adm.baseOnly ? { fableRequired: true, fableReasons: reasons, sensitivePaths: adm.lane.sensitivePaths.slice(0, 50) } : {}),
    });
    writeJson(path.join(dir, 'codex.json'), { findings, items: ruled });
    writeFileAtomic(path.join(dir, 'codex.md'), renderFindingsMarkdown(findings, round, ruled));
    claimGrant();
    saveState(root, next);
    saved = next;
    if (afterSave) await afterSave();
    grantUsed = ownerGrant === undefined ? undefined : { grantId: ownerGrant.grantId };
    return ruled;
  });
  return { items, state: saved, grantUsed };
}
