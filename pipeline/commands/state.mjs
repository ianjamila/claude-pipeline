// Reads and updates .review/state.json for the skills: which items are open, whether the loop may exit, and the few
// facts only the skill knows (an item was implemented, a follow-up issue exists, how the run ended). The state is the
// only memory of the review loop, so a lost local copy is rebuilt from the PR's triage comment, which embeds it.
import { EXIT, UnavailableError, UsageError, intOption, parseCommandArgs, requireOption } from '../lib/cli.mjs';
import { mkdirSync, existsSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Fail, guarded, requireConfig, resolveRepo } from '../lib/cmd-common.mjs';
import { GhError } from '../lib/proc.mjs';
import { GitError, effectiveReviewBase, git, headSha, isAncestor, mergeBase, revParse } from '../lib/git.mjs';
import { claimGrantMarkers, grantIdOf, ownerGrantedRounds, ownerPastRoundHistory, ownerPastRoundRecords, verifyOwnerGrant } from '../hooks/lib/owner-go.mjs';
import { pastRoundsNeedingApproval } from '../lib/owner-grants.mjs';
import { createGitHub, guardGh } from '../lib/github.mjs';
import { matchAny } from '../lib/glob.mjs';
import { docsExemptFrom } from '../lib/docs-exempt.mjs';
import { readReviewGate } from '../lib/model-floor.mjs';
import { wholePrOwed } from '../lib/review-route.mjs';
import { roundStats } from '../lib/round-stats.mjs';
import { prBaseBranch } from '../lib/risk.mjs';
import { addRound, loadState, saveState, updateItems } from '../lib/state.mjs';
import { arbiterFailures, countsTowardCap, finalIsReopenable, isOwnerRuled, isProtectedFinal, reviewedRoundCount, roundOutcome, staleFableRounds, staleSubstituteFableRounds } from '../lib/triage.mjs';
import { pastRoundHistoryProblem, publishTriage, readBaseline, readPublished, reviewContentHash, writeBaseline } from '../lib/review-publish.mjs';
import {
  allItems, canonicalJson, currentContentHash, decidedItemsKey, findItem, findRound, followupsPending, newStaleDir, quarantineReviewDir, refreshBaseRef, requireState, reviewBaseRef,
  adoptPublishedGrants, roundDir, stateExtends, withStateLock,
} from '../lib/review-context.mjs';

export const meta = {
  summary: 'show or update the review loop state (.review/state.json)',
  usage: [
    'pipeline state show [--round R] [--accepted] [--disputed] [--needs-human] [--pr N] [--repo DIR]',
    '  -> {ok, recovered, source, count, items}; with --pr and no local state, rebuilds it from the PR triage comment',
    '  with --pr and a local state: the published (triage comment) state is authoritative. Local is kept (source local) when it',
    '  equals or strictly EXTENDS the published one; otherwise .review/ moves to .review/stale-<UTC time>/ (source quarantined,',
    '  quarantinedTo) and the published state is restored. source is local | published | quarantined | local-ahead | local-unverified',
    '  (local-ahead: the PR still holds what this copy last published, every published round and item is still in the local copy, and the local copy holds a second-review verdict or a Claude / forced final that was',
    '  never published, or a decision that continues the published Claude / forced final or the published final of an item waiting for a human (a tightened ACCEPT, an owner ruling; possibly several unpublished steps, whose overruled chain reaches the published final), or an implementation mark or a follow-up issue link added after the last publish: kept, with a warning naming the retry command). A restored or quarantined copy records the published state as its baseline',
    '  (.review/published-baseline.json), which is what the next publication is checked against (lib/review-publish.mjs)',
    '  owner grants the PR holds on rounds this copy has (and it lacks or holds differently) are copied onto them, nothing is quarantined and local rounds / decisions are kept: grantsRestored:[round numbers]. This also holds when the PR moved off this copy\'s baseline by such a grant alone (another checkout published it) while this copy has unpublished decisions or a trailing round. A local-only owner grant (the PR\'s round has none) that does not verify on this machine is dropped, with the admission it set: grantsDropped:[round numbers] (the refusal `unverified-grant` of `state past-round-grant` names this remedy); it is checked against the gh repository, like `past-round-grant` does, and a check that failed with an error (not a "no") keeps the grant with a warning. After adopting grants the baseline follows the PR only when this copy equals the PR apart from grants and trailing local rounds (a copy that lacks a published decision or round-level proof keeps its baseline, so it cannot publish over it)',
    '  (GitHub unreachable but a local state exists: served as is with a `warnings` entry, exit 0; with no local state exit 3)',
    'pipeline state discard-round --round R [--pr N] [--repo DIR]',
    '  -> drop an unpublished, trailing round R from the local state and move .review/round-R/ into .review/stale-<UTC time>/;',
    '     refused (exit 2) when the PR triage comment already holds round R, or (error round-has-verdict) when the round holds a second-review verdict',
    'pipeline state outcome [--repo DIR]   -> roundOutcome + {clean, arbiterFailures, followupsPending, rounds, reviewedRounds, maxRounds, roundStats: {rounds: [{n, items, byBucket}], reRaised, ruledReRaised}, wholePrOwed, nextRound:{round, base, wholePrOwed}[, base]}; exit 0 whether or not clean',
    '  wholePrOwed: true (with base: the PR\'s merge base) when an Opus substitute round came before the PR\'s risk rose to high and no whole-PR round since: the next round must start at that base and reviews the whole PR',
    '    (codex-review rejects any other base). nextRound.base is the base to pass (the merge base when wholePrOwed, else the last round\'s toHead); the effort and route of that round: pipeline codex-review --plan',
    '  roundOutcome carries substituteRounds:[n] (rounds a Claude substitute reviewed first, while Codex was out of quota) and maxRisk (the highest risk the PR ever had: low|medium|high)',
    '  first fetches origin/<default_branch> (best effort: offline keeps the cached ref), so a PR updated from its base branch is not read as changed',
    '  grantedRound {k, grantId, head, quote}: the owner\'s open extra-round grant for the next counted round and the checked-out HEAD (chat mode, an owner',
    '  record younger than 24 h, not yet used) - it lifts reachedMax and effectiveMaxRounds by one; null otherwise. autoExtraOrdinal: the counted round the',
    '  automatic extra round took, or null',
    'pipeline state mark-implemented --ids a,b [--repo DIR]',
    '  -> exit 2 {error:no-code-change} unless the branch content differs from what the accepting round reviewed',
    '     and a non-test file changed since (a test file counts for a testing finding or the finding\'s own file)',
    '  -> a forced or Claude-ruled ACCEPT whose named file is empty or was not changed is still marked, with implementedVia \'other-files\': the next codex-review',
    '     round asks Codex to confirm it (round.confirmFixed) and review-complete waits for that round. Ordinary ACCEPTs get no such field',
    '  -> every mark records item.implementedAfterRound, the newest round number at that time (triage defer-fixes uses it to tell a fix made before the last reviewed round from a later one)',
    '  -> exit 3 {ok:false, unavailable:true, reason:base-refresh} and nothing is marked when origin/<default_branch> cannot be fetched (offline, remote down) while the',
    '     hash would be measured from it - also with no origin remote but a leftover origin/<default_branch> ref: a stale base would count the default branch\'s commits as the fix',
    'pipeline state fable-refresh --pr N [--repo DIR]',
    '  -> {ok, round, staleRounds, scope: "whole-pr"}: opens an uncounted Fable-only round (no Codex, not counted against review.max_rounds, allowed past it and with no new commit) on the pushed head, so a Fable pass proven with',
    '     a Fable older than MIN_FABLE (or the lower hold of model-floor reset --hold) is re-reviewed. Refused (exit 2) unless a proven Fable round - or a substitute-fable review that stood in for Codex - is below that and no later whole-PR pass at or above it replaced it (error nothing-stale), every earlier round is finished',
    '     (error unfinished-round: a Fable pass owed, an undecided, human-owed, unimplemented or newly accepted item), HEAD is the head of PR N on GitHub (error head-not-pushed; exit 3 when GitHub is unreachable)',
    '     and the content is what the last round reviewed, or only ledger rows were added since (review.docs_exempt_paths; the round then stays pinned at the last reviewed head) (error content-moved: run a normal codex-review round instead, its Fable pass already reads the whole PR). Then: arbiter needed --round R, the arbiter, arbiter apply',
    '     the whole-PR range starts at the PR\'s merge base with its base branch at the time of the call (a base branch merged in since the last round moves it); when GitHub names no base branch and the default branch cannot be anchored on the remote (the working tree\'s default_branch is the PR\'s to edit) the fork point the last round recorded is kept instead',
    'pipeline state record-followup --id ID --url URL [--repo DIR]',
    'pipeline state set-outcome --outcome TEXT [--repo DIR]',
    'pipeline state past-round-grant --pr N --round n [--repo DIR]',
    '  -> {ok, round, k, grantId, claimed, saved, published, remaining}: records the owner\'s approval of round n, which ALREADY ran (before owner grants were recorded, so it carries none): the owner typed',
    '     "approve round" (or "extra round", "grant round K", optionally with #N) after a reply ending with the line `triage round-request --pr N --past` printed (`🔂 Approve past review round #N: round K · head <head12> · repo owner/name`;',
    '     the owner-go hook records it as kind past-round, any session, last 24 h, never usable for a new round). Saves ownerGrant {grantId, k, quote, ownerTs, past: true} and admission owner on round n, then publishes the state. Under the review lock',
    '  -> before anything is claimed or saved (state and markers untouched on a refusal, exit 2 {ok:false, error, message}): label-mode (needs owner_approval: chat), no-max-rounds, host (the gh repo is not on github.com), state-pr-mismatch;',
    '     the history check against the PR\'s triage comment: history-unreadable | no-published-history | stale-history (run `pipeline state show --pr N`) | unpublished-history (run `pipeline comment --pr N --kind triage`); this copy may be ahead',
    '     only by owner-grant metadata that verifies (unverified-grant otherwise), and a stale baseline is refreshed only when it equals the PR apart from grants and trailing rounds (stale-publication otherwise: the PR holds a decision or round-level proof this copy lacks, run `pipeline state show --pr N`); not-eligible (round n is not one `triage round-request --pr N --past` would pick: a counted round past review.max_rounds + 1, held by the PR with a later counted round,',
    '     with no owner grant or one whose record is gone), already-approved (the PR already holds a verified grant on it); no-grant (no past-round record for this repository, PR, counted round and head, younger than 24 h, typed by the owner)',
    '  -> every matching unspent record is claimed together (one machine-global marker each, like codex-review), the newest is recorded. An interrupted run is resumed by running the command again: a record whose marker is already spent and verifies is',
    '     used without a new claim (at any age), leftovers are claimed. claim-failed | save-failed (exit 1) keep the markers; a failed publication keeps the saved state: exit 3 {unavailable:true, saved:true, published:false, next} for GitHub, exit 1',
    '     {error: stale-publication | history-loss, saved:true, published:false} when the PR moved; run the command again to retry. Re-approving a round whose published grant no longer verifies replaces that grant. remaining: [{n, k}] the other rounds still to approve',
  ].join('\n'),
};

// ---- show -----------------------------------------------------------------------------------

const isAccepted = (i) => i.final?.decision === 'ACCEPT' && !i.implemented;
const isDisputed = (i) => i.judge?.disputedBug === true && i.judge.settleTest?.possible === true && (i.test?.status ?? 'none') === 'none';
const needsHuman = (i) => i.final?.needsHuman === true;

// The published review state: the newest comment of ours that STARTS with the triage marker (a quoted or forged marker in someone else's comment,
// or in the middle of ours, must never become the state). -> { state, hash, ... } (lib/review-publish.mjs#readPublished); state is null when there is none.
function recoverState(root, pr, ctx, gh = createGitHub({ cwd: root, env: ctx.env })) {
  return guardGh(() => readPublished(gh, pr));
}

// The local copy holds a second-review verdict or a Claude / forced final that the published copy lacks for the same item (what a ruling saved while
// GitHub was down, or a second review, leaves behind), or a decision that CONTINUES the published final: Claude tightening a published dismissal, a second
// review forcing ACCEPT over it, or the owner's typed override (plan E6) of a Claude final or of an item still waiting for a human, each of which records the
// final it replaced (final.claude.overruled / final.overruled). Several such steps may be unpublished (a Claude REJECT re-ruled FOLLOW-UP, then ACCEPT, then
// the owner), each nesting the previous final: the chain is walked back until it reaches the published final. With the published copy equal to this copy's
// baseline that is plain local progress, not a superseded copy: it must be published, not quarantined. The chain is a parsed JSON tree, so it cannot cycle and
// the walk ends on its own, however many times Claude re-ruled (the writer sets no limit). Anything that ends without reaching the published final, or whose
// steps are not each a valid continuation, stays a superseded copy (fail closed).
// One step: `cur` replaced `prev`. The owner may rule over a Claude / forced final or a final waiting for a human; Claude may not loosen a protected
// ACCEPT, and may not overrule the owner. The caller has checked that `prev` is the final `cur` names as the one it replaced.
const validStep = (cur, prev) => {
  const owner = isOwnerRuled({ final: cur });
  if (owner) return isProtectedFinal({ final: prev }) || prev.needsHuman === true;
  if (isOwnerRuled({ final: prev })) return false;
  return !(isProtectedFinal({ final: prev }) && prev.decision === 'ACCEPT');
};
const replacedBy = (final) => (isOwnerRuled({ final }) ? final.overruled : isProtectedFinal({ final }) ? final.claude?.overruled : undefined);
const continuesPublished = (mine, theirs) => {
  const published = theirs.final;
  if (mine.final === undefined || published === undefined || canonicalJson(mine.final) === canonicalJson(published)) return false;
  if (!isProtectedFinal(theirs) && published.needsHuman !== true) return false;
  const target = canonicalJson(published);
  let cur = mine.final;
  for (;;) {
    const prev = replacedBy(cur);
    if (!isObjectLike(prev) || !validStep(cur, prev)) return false;
    if (canonicalJson(prev) === target) return true;
    cur = prev;
  }
};
const isObjectLike = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

const itemKey = (i) => decidedItemsKey({ items: [i] });
// A second-review verdict and / or a Claude / forced final saved next to a published item that has none. It is the WHOLE local change: the rest of the decided
// fields (everything but `final` and `secondReview`) are as published, the verdict is new (or unchanged), and the final is unchanged or a new protected final over
// a final that is not the owner's (the owner's ruling is never replaced by Claude's) and can still be reopened (waits for a human, or is a Claude dismissal: finalIsReopenable) and, where it records what it overruled, overruled exactly the published final.
// `triage second-review` writes the verdict and a forced ACCEPT final (overruling the final it found) together, so that pair is covered; so is a verdict followed by
// a Claude ruling, and a final that CONTINUES the published one (continuesPublished) is accepted on the same terms. Anything else riding along (a flipped
// `implemented`, a loosened final, a changed field) is not saved work.
const rest = (i) => itemKey({ ...i, final: undefined, secondReview: undefined });
function savedRulingIsAhead(i, before) {
  if (rest(i) !== rest(before)) return false;
  const verdictAdded = i.secondReview !== undefined && before.secondReview === undefined;
  if (!verdictAdded && canonicalJson(i.secondReview) !== canonicalJson(before.secondReview)) return false;
  // The writers never reopen a settled final (triage.mjs secondReviewRefusal / claudeRulingRefusal), so neither a verdict nor a ruling over one is saved work.
  if (canonicalJson(i.final) === canonicalJson(before.final)) return verdictAdded && finalIsReopenable(before);
  if (continuesPublished(i, before)) return true;
  if (!isProtectedFinal(i) || isProtectedFinal(before) || isOwnerRuled(before) || !finalIsReopenable(before)) return false;
  const overruled = i.final.claude?.overruled;
  if (overruled !== undefined && canonicalJson(overruled) !== canonicalJson(before.final)) return false;
  return i.final.forcedBy === undefined || verdictAdded;
}
// One item of the local copy against the published one: a permitted "ahead" change. Either saved ruling work on its own (savedRulingIsAhead above), or a mark
// added where the published item had none (`state mark-implemented`, `followups create`) with the item otherwise unchanged, so neither carries an unrelated edit
// with it. A changed or removed mark is not ahead.
function itemIsAhead(i, before) {
  if (savedRulingIsAhead(i, before)) return true;
  const addImplemented = Boolean(i.implemented) && before.implemented === undefined;
  const addFollowup = Boolean(i.followupIssue) && before.followupIssue === undefined;
  if (!addImplemented && !addFollowup) return false;
  return itemKey({ ...i, ...(addImplemented ? { implemented: undefined } : {}), ...(addFollowup ? { followupIssue: undefined } : {}) }) === itemKey(before);
}

// Kept as local-ahead only when the local copy still holds EVERYTHING the PR holds (every published round with the same n, toHead and contentHashAtToHead, and
// every published item of it), each item either unchanged or ahead by a permitted change, and at least one is ahead: the next publication replaces the PR's
// state with this copy, so a copy that lost a published item or round would drop it from the PR. Extra local rounds and items (an unpublished trailing round) are fine.
function localAheadOfPublished(local, published, baseline) {
  if (baseline === null || published.hash !== baseline) return false;
  const mine = new Map((local.rounds ?? []).map((r) => [r.n, r]));
  let ahead = false;
  for (const p of published.state.rounds ?? []) {
    const r = mine.get(p.n);
    if (r === undefined || r.toHead !== p.toHead || r.contentHashAtToHead !== p.contentHashAtToHead) return false;
    const have = new Map((r.items ?? []).map((i) => [i.id, i]));
    for (const before of p.items ?? []) {
      const i = have.get(before.id);
      if (i === undefined) return false;
      if (itemKey(i) === itemKey(before)) continue;
      if (!itemIsAhead(i, before)) return false;
      ahead = true;
    }
  }
  return ahead;
}

// The PR's state with the grant metadata (ownerGrant, admission) of the identity-equal rounds taken from \`local\`: what the PR held before another checkout published
// only a grant. Its hash against this copy's baseline tells a grant-only advance of the PR (adopt the grants, keep the local work) from one that moved decisions.
function publishedAtLocalGrants(published, local) {
  const mine = new Map((local.rounds ?? []).map((r) => [r.n, r]));
  return {
    ...published,
    rounds: (published.rounds ?? []).map((p) => {
      const r = mine.get(p.n);
      if (r === undefined || r.toHead !== p.toHead || r.contentHashAtToHead !== p.contentHashAtToHead) return p;
      const { ownerGrant: _g, admission: _a, ...bare } = p;
      return { ...bare, ...(r.ownerGrant === undefined ? {} : { ownerGrant: r.ownerGrant }), ...(r.admission === undefined ? {} : { admission: r.admission }) };
    }),
  };
}

// True when this copy equals what the PR holds apart from owner grant metadata (ownerGrant, admission) and trailing local-only rounds: every published round is here with the
// same content (items, the round-level arbiter / modelProof, everything the content hash covers) once the grant metadata is taken from the PR's round, and every extra local
// round comes after the newest published one. Only then has this copy "seen everything the PR holds", so its publication baseline may follow the PR (a stale copy that lacks
// a published item decision or round-level proof must keep its old baseline, or its next publication would erase it).
function equalsPublishedApartFromGrants(local, published) {
  const theirs = new Map((published.rounds ?? []).map((p) => [p.n, p]));
  const newest = Math.max(0, ...theirs.keys());
  const kept = [];
  for (const r of local.rounds ?? []) {
    const p = theirs.get(r.n);
    if (p === undefined) {
      if (r.n < newest) return false; // a gap in the PR's history, not a trailing round
      continue;
    }
    const { ownerGrant: _g, admission: _a, ...bare } = r;
    kept.push({ ...bare, ...(p.ownerGrant === undefined ? {} : { ownerGrant: p.ownerGrant }), ...(p.admission === undefined ? {} : { admission: p.admission }) });
  }
  return kept.length === theirs.size && canonicalJson(kept) === canonicalJson(published.rounds ?? []);
}

// The repository identity the owner's recorded approval is checked against: the gh slug (what past-round-grant and the gates use), read from the client that already
// read the PR (it caches the lookup: no second `gh repo view`). null when it cannot be resolved: the state's recorded slug may predate a repository move, and a
// verification against it would answer "mismatch" for a valid approval, so the caller keeps the grants instead of guessing.
function repoForGrants(gh) {
  try {
    const { slug, host } = gh.repo();
    if (host === 'github.com' && typeof slug === 'string' && slug !== '') return slug;
  } catch { /* unresolved: null */ }
  return null;
}

// A local owner grant on a round the PR holds WITHOUT one, that does not verify on this machine (its record, marker or transcript is gone), is dropped, together with the
// admission it set: the PR is the published history and the grant never was part of it, so it is only a refusal that would repeat (\`state past-round-grant\`).
// Only a verification that ran and said no drops a grant: one that threw is kept (`errored`), the caller warns.
function dropUnverifiedLocalGrants(local, published, repo) {
  const theirs = new Map((published.rounds ?? []).map((p) => [p.n, p]));
  const dropped = [];
  const errored = [];
  const rounds = (local.rounds ?? []).map((r) => {
    const p = theirs.get(r.n);
    if (r.ownerGrant === undefined || p === undefined || p.ownerGrant !== undefined || r.toHead !== p.toHead || r.contentHashAtToHead !== p.contentHashAtToHead) return r;
    let v;
    try {
      v = verifyOwnerGrant({ repo, pr: local.pr, k: ordinalOf(local, r.n), toHead: r.toHead, ownerGrant: r.ownerGrant });
    } catch (err) {
      errored.push({ n: r.n, message: String(err?.message ?? err).split('\n')[0].slice(0, 160) });
      return r;
    }
    if (v.ok) return r;
    dropped.push(r.n);
    const { ownerGrant: _g, admission: _a, ...bare } = r;
    return { ...bare, ...(p.admission === undefined ? {} : { admission: p.admission }) };
  });
  return { state: dropped.length === 0 ? local : { ...local, rounds }, dropped, errored };
}

async function show(rest, ctx) {
  const { values } = parseCommandArgs(rest, {
    round: { type: 'string' }, accepted: { type: 'boolean' }, disputed: { type: 'boolean' },
    'needs-human': { type: 'boolean' }, pr: { type: 'string' }, repo: { type: 'string' },
  }, { allowPositionals: false });
  const n = intOption(values, 'round', { min: 1 });
  const pr = intOption(values, 'pr', { min: 1 });
  const root = resolveRepo(values, ctx);
  // `show` may rebuild the state file, so it takes the lock like the commands that change it.
  return withStateLock(root, ctx, () => showLocked(values, n, pr, root, ctx), pr);
}

async function showLocked(values, n, pr, root, ctx) {
  const gh = createGitHub({ cwd: root, env: ctx.env }); // one client for the whole command: its repository lookup is cached
  let state;
  try {
    state = loadState(root);
  } catch (err) {
    throw new Fail(EXIT.USAGE, { ok: false, error: 'state', message: err.message });
  }
  let recovered = false;
  let source = 'local';
  const warnings = [];
  let quarantinedTo;
  let grantsRestored;
  let grantsDropped;
  if (!state) {
    if (pr === undefined) {
      throw new Fail(EXIT.USAGE, { ok: false, error: 'no-state', message: 'no review state here: pass --pr N to rebuild it from the PR triage comment' });
    }
    const found = await recoverState(root, pr, ctx, gh);
    state = found.state;
    if (!state) {
      throw new Fail(EXIT.USAGE, { ok: false, error: 'no-state', message: `no local review state and no triage comment with state on PR #${pr}` });
    }
    saveState(root, state);
    writeBaseline(root, pr, found.hash); // what this copy restored: the next publication is measured from it (lib/review-publish.mjs)
    recovered = true;
    source = 'published';
  } else if (pr !== undefined && state.pr !== pr) {
    throw new Fail(EXIT.USAGE, { ok: false, error: 'state-pr-mismatch', message: `.review/state.json belongs to PR #${state.pr}, not #${pr}` });
  } else if (pr !== undefined) {
    // The triage comment is what survives the machine: when the two disagree the published one wins, unless the local
    // state only goes further (its extra rounds were never published).
    // GitHub unreachable: the local state is all there is. It is served, but flagged: it was NOT compared with the published
    // triage comment, so the caller must not treat it as proven current.
    let found;
    try {
      found = await recoverState(root, pr, ctx, gh);
    } catch (err) {
      if (!(err instanceof UnavailableError)) throw err;
      warnings.push(`GitHub unavailable: the local review state was not compared with the published triage comment (${String(err.message).split('\n')[0].slice(0, 200)})`);
      source = 'local-unverified';
    }
    // The PR moving off this copy's baseline by owner grants alone (another checkout published one) is not a change of decisions: the grants are adopted below,
    // and, whatever else this copy holds that the PR lacks, the PR then differs from what this copy last saw by those grants only.
    const seen = found?.state ? readBaseline(root, pr) : null;
    const grantsOnly = seen !== null && found.hash !== seen && reviewContentHash(publishedAtLocalGrants(found.state, state)) === seen;
    if (found?.state && !stateExtends(state, found.state)) {
      if (localAheadOfPublished(state, found, grantsOnly ? found.hash : seen)) {
        source = 'local-ahead';
        warnings.push(`the local review state holds a second-review verdict, a Claude ruling (or a change to one), an owner ruling, an implementation mark or a follow-up issue link that the published triage comment lacks (it was saved but not published): kept as is; publish it now with \`pipeline comment --pr ${pr} --kind triage\``);
      } else {
        quarantinedTo = path.relative(root, quarantineReviewDir(root)).split(path.sep).join('/');
        state = found.state;
        saveState(root, state);
        writeBaseline(root, pr, found.hash);
        source = 'quarantined';
      }
    } else if (found?.state && found.hash === reviewContentHash(state) && readBaseline(root, pr) !== found.hash) {
      // Local IS the published state: that is what this copy last saw, whatever the file says (none: a checkout from before the baseline existed). Without it the
      // first decision on a published item would be quarantined here and refused as stale at publication (lib/review-publish.mjs#establishBaseline).
      writeBaseline(root, pr, found.hash);
    }
    // Grant metadata is add-only history: a local copy that lacks (or holds another) owner grant the PR holds on a round it has takes the PR's,
    // keeping its own decisions and trailing rounds, instead of being quarantined or later refused as history-loss at publication.
    if (found?.state && (source === 'local' || source === 'local-ahead')) {
      const repo = repoForGrants(gh);
      if (repo === null) warnings.push('could not resolve the GitHub repository: the owner grants this copy holds were not checked against the PR, and are kept');
      const dropped = repo === null ? { state, dropped: [], errored: [] } : dropUnverifiedLocalGrants(state, found.state, repo);
      for (const e of dropped.errored) warnings.push(`could not check the owner grant on round ${e.n} (${e.message}): kept`);
      if (dropped.dropped.length > 0) {
        state = dropped.state;
        saveState(root, state);
        grantsDropped = dropped.dropped;
        warnings.push(`dropped the owner grant on round${grantsDropped.length === 1 ? '' : 's'} ${grantsDropped.join(', ')}: this copy held it, the PR does not, and it does not verify on this machine`);
      }
      const adopted = adoptPublishedGrants(state, found.state);
      if (adopted.restored.length > 0) {
        state = adopted.state;
        saveState(root, state);
        // The baseline follows the PR only when this copy has now seen everything the PR holds: the PR moved off the baseline by grants alone (proved above by the baseline
        // hash check, whether this copy is ahead in decisions or in round-level content), or this copy equals the PR apart from grants; a copy that merely extends the PR may
        // still lack a round-level proof or a decision the PR holds, and its next publication would erase it.
        if (source === 'local-ahead' || grantsOnly || equalsPublishedApartFromGrants(state, found.state)) writeBaseline(root, pr, found.hash);
        grantsRestored = adopted.restored;
      }
    }
  }

  const pool = n === undefined ? allItems(state) : findRound(state, n).items;
  const items = pool.filter((i) => (!values.accepted || isAccepted(i)) && (!values.disputed || isDisputed(i)) && (!values['needs-human'] || needsHuman(i)));
  return {
    exitCode: EXIT.OK,
    output: { ok: true, recovered, source, ...(quarantinedTo ? { quarantinedTo } : {}), ...(grantsRestored ? { grantsRestored } : {}), ...(grantsDropped ? { grantsDropped } : {}), ...(warnings.length ? { warnings } : {}), pr: state.pr, lightLane: state.lightLane, count: items.length, items },
  };
}

// ---- discard-round --------------------------------------------------------------------------

// An interrupted round (Codex ran, the loop stopped before the triage comment) is thrown away and re-run under the same
// number. What is moved aside is kept, never deleted; a round the PR comment already holds is history and stays.
async function discardRound(rest, ctx) {
  const { values } = parseCommandArgs(rest, { round: { type: 'string' }, pr: { type: 'string' }, repo: { type: 'string' } }, { allowPositionals: false });
  const n = intOption(values, 'round', { required: true, min: 1 });
  let pr = intOption(values, 'pr', { min: 1 });
  const root = resolveRepo(values, ctx);
  const local = requireState(root);
  pr ??= local.pr;
  if (local.pr !== pr) {
    throw new Fail(EXIT.USAGE, { ok: false, error: 'state-pr-mismatch', message: `.review/state.json belongs to PR #${local.pr}, not #${pr}` });
  }
  return withStateLock(root, ctx, async () => {
    const state = requireState(root);
    const inState = (state.rounds ?? []).some((r) => r.n === n);
    const dir = roundDir(root, n);
    if (!inState && !existsSync(dir)) {
      throw new Fail(EXIT.USAGE, { ok: false, error: 'no-round', message: `round ${n} is neither in the review state nor on disk` });
    }
    if (inState && (state.rounds ?? []).some((r) => r.n > n)) {
      throw new Fail(EXIT.USAGE, { ok: false, error: 'not-trailing', message: `round ${n} is not the newest round: a later round builds on it` });
    }
    // A second review's verdict is evidence a round-trip through Codex bought: it is not thrown away with the round (re-running it is refused).
    const withVerdict = (state.rounds ?? []).find((r) => r.n === n)?.items?.filter((i) => i.secondReview !== undefined).map((i) => i.id) ?? [];
    if (withVerdict.length > 0) {
      throw new Fail(EXIT.USAGE, { ok: false, error: 'round-has-verdict', message: `round ${n} holds a second-review verdict (${withVerdict.join(', ')}), so it cannot be discarded: a second review runs once per item` });
    }
    const published = (await recoverState(root, pr, ctx)).state;
    if ((published?.rounds ?? []).some((r) => r.n === n)) {
      throw new Fail(EXIT.USAGE, { ok: false, error: 'round-published', message: `round ${n} is in the PR triage comment: it is history, not an interrupted round` });
    }
    const stale = newStaleDir(root);
    const round = (state.rounds ?? []).find((r) => r.n === n);
    if (round) writeFileSync(path.join(stale, `state-round-${n}.json`), `${JSON.stringify(round, null, 2)}\n`);
    if (existsSync(dir)) {
      mkdirSync(stale, { recursive: true });
      renameSync(dir, path.join(stale, `round-${n}`));
    }
    if (inState) saveState(root, { ...state, rounds: state.rounds.filter((r) => r.n !== n) });
    return {
      exitCode: EXIT.OK,
      output: { ok: true, discarded: n, quarantinedTo: path.relative(root, stale).split(path.sep).join('/'), stateRound: inState },
    };
  }, pr);
}

// ---- outcome --------------------------------------------------------------------------------

async function outcome(rest, ctx) {
  const { values } = parseCommandArgs(rest, { repo: { type: 'string' } }, { allowPositionals: false });
  const root = resolveRepo(values, ctx);
  const { config } = await requireConfig(root);
  const state = requireState(root);
  // Best effort: a stale origin/<default_branch> (after update-branch + a plain pull) only makes coverage look invalid; offline keeps the cached ref.
  refreshBaseRef(root, config);
  const hash = currentContentHash(root, config);
  // The owner's open extra-round grant for the next counted round, for the checked-out HEAD (chat mode only; codex-review is the authority).
  const head = headSha({ cwd: root });
  const grants = config.owner_approval === 'chat'
    ? (k) => ownerGrantedRounds({ repo: state.repo, pr: state.pr, k, anyHead: true }).map((r) => ({ grantId: grantIdOf(r), head: r.head, quote: r.prompt }))
    : undefined;
  const result = roundOutcome({ ...state, currentContentHash: hash }, { grants, head });
  // A whole-PR round is owed: it starts at the PR's merge base (the default branch; codex-review judges a PR into another branch itself).
  const owed = wholePrOwed(state);
  let forkPoint = null;
  if (owed) {
    try {
      forkPoint = mergeBase(reviewBaseRef(root, config), head, { cwd: root });
    } catch (err) {
      if (!(err instanceof GitError)) throw err;
    }
  }
  const nextBase = owed && forkPoint !== null ? forkPoint : state.rounds.at(-1)?.toHead ?? null;
  return {
    exitCode: EXIT.OK,
    output: { ok: true, ...result, roundStats: roundStats(state), wholePrOwed: owed, ...(owed && forkPoint !== null ? { base: forkPoint } : {}), nextRound: { round: state.rounds.length + 1, base: nextBase, wholePrOwed: owed }, arbiterFailures: arbiterFailures(state), followupsPending: followupsPending(state), currentContentHash: hash, rounds: state.rounds.length, reviewedRounds: reviewedRoundCount(state), maxRounds: state.maxRounds },
  };
}

// What to diff HEAD against when the default branch was merged into the PR with a conflict since `toHead`: walk the merge commits of
// the default branch on HEAD's first-parent history after `toHead`, OLDEST first (the first is the one that resolved the conflict), and
// take the first whose own review base is exact (effectiveReviewBase from that merge: 'previous', or 'synthetic' when the default branch
// was merged in again cleanly later, which leaves main's later files out). A merge counts only when its second parent is part of the
// default branch (a merge of any other branch says nothing about what main brought in). A merge whose own base is still 'whole-pr'
// (a second conflict) is skipped in favour of the next one. null when none gives an exact base: the caller refuses. Throws on a git error.
function baseAfterConflictMerge({ root, config, toHead, forkPoint }) {
  const o = { cwd: root };
  const baseRef = reviewBaseRef(root, config);
  const merges = git(['rev-list', '--first-parent', '--merges', '--reverse', `${revParse(toHead, o)}..HEAD`], o).split('\n').filter(Boolean);
  for (const m of merges) {
    const parents = git(['rev-list', '--parents', '-n', '1', m], o).trim().split(/\s+/).slice(1);
    if (parents.length !== 2 || !isAncestor(parents[1], baseRef, o)) continue;
    const since = effectiveReviewBase({ from: m, forkPoint }, o);
    if (since.kind === 'previous' || since.kind === 'synthetic') return since.base;
  }
  return null;
}

// ---- small updates --------------------------------------------------------------------------

// The records of `git diff --raw -z` / `git log --raw -z --format=`: `:<mode> <mode> <id> <id> <status>\0<path>\0`, repeated. Anything
// that is not exactly that throws (the caller turns it into base-unresolved). Ids are 40 hex (SHA-1) or 64 hex (SHA-256); with
// --no-renames the status is one of A, D, M, T. An empty field is accepted only where a record starts (git versions differ in
// whether they put a NUL between the commits of a log). The output is decoded as UTF-8, so distinct non-UTF-8 file names would all become
// the same U+FFFD string and ownAuthored could match a merge-only file against an ordinarily authored one: a path containing U+FFFD
// throws (a real name that holds a literal U+FFFD is refused too, which is acceptable). -> [{ path, id: the blob the path has after the change; all zeros = deleted }]
const RAW_META = /^:[0-7]{6} [0-7]{6} (?:[0-9a-f]{40}|[0-9a-f]{64}) ([0-9a-f]{40}|[0-9a-f]{64}) [ADMT]$/;
function parseRawZ(out) {
  const fields = out.split('\0');
  const records = [];
  for (let i = 0; i < fields.length;) {
    if (fields[i] === '') { i += 1; continue; }
    const m = RAW_META.exec(fields[i]);
    const file = fields[i + 1];
    if (!m || file === undefined || file === '') throw new Error(`unexpected git output: ${JSON.stringify(fields[i].slice(0, 80))}`);
    if (file.includes('\uFFFD')) throw new Error(`a changed path is not valid UTF-8, so it cannot be told apart from other such paths: ${JSON.stringify(file.slice(0, 80))}`);
    records.push({ path: file, id: m[1] });
    i += 2;
  }
  return records;
}

// Which of the net changes `changes` ([{ path, id }]) did an ordinary commit of the PR write? A path is kept only when its content at
// HEAD is EXACTLY a version that a non-merge commit since `toHead` left in that path (a deletion leaves the all-zero id). So:
// - what is typed into a merge commit (clean, conflict-resolving, octopus, a merge of another branch) never counts: the merge's tree
//   is not a blob any ordinary commit wrote; likewise a change that a later merge altered or discarded, or a file a later merge
//   also changed (main edited it too). Authorship, not "was touched", is the test: a revert followed by a hand edit in a merge
//   touches the file in the log but leaves a blob nobody wrote.
// - `^<default branch>` drops the default branch's own commits (they are not the PR's work); commits that came in by merging another
//   branch stay: they are the PR's.
// This proves "an ordinary PR commit wrote this code", not "the fix is real": a merge that re-chooses an earlier PR commit's content
// counts (C1 sets P=X, C2 sets P=Y, a merge puts P=X back), and a cherry-pick or a copy is an ordinary commit. Both are reviewable.
// Throws on a git error or output it cannot parse. -> the subset of `changes`
function ownAuthored({ root, config, toHead, changes }) {
  const o = { cwd: root };
  // --no-show-signature: a user's log.showSignature=true prints the gpg/ssh verdict before the records even with --format=
  const log = git(['log', '--no-merges', '--no-show-signature', '--no-renames', '--raw', '--no-abbrev', '-z', '--format=', `${revParse(toHead, o)}..HEAD`, `^${reviewBaseRef(root, config)}`], o);
  const wrote = new Map(); // path -> Set of the blob ids ordinary commits left there
  for (const { path: file, id } of parseRawZ(log)) {
    if (!wrote.has(file)) wrote.set(file, new Set());
    wrote.get(file).add(id);
  }
  return changes.filter((c) => wrote.get(c.path)?.has(c.id));
}

// The refusal's clause for the paths ownAuthored dropped ('' when none).
const notWritten = (paths) => (paths.length === 0 ? ''
  : ` (their current content was not written by an ordinary commit of this PR — it came from a merge or from the default branch: ${paths.slice(0, 3).join(', ')}; commit any further change to those files after the merge, or fix another file)`);

async function markImplemented(rest, ctx) {
  const { values } = parseCommandArgs(rest, { ids: { type: 'string' }, repo: { type: 'string' } }, { allowPositionals: false });
  const ids = [...new Set(requireOption(values, 'ids').split(',').map((s) => s.trim()).filter(Boolean))];
  if (ids.length === 0) throw new UsageError('--ids must list at least one item id');
  const root = resolveRepo(values, ctx);
  const { config } = await requireConfig(root);
  return withStateLock(root, ctx, () => {
    let state = requireState(root);
    // Resolve every id first so a typo cannot leave the state half-updated.
    const found = ids.map((id) => findItem(state, id));
    for (const { item } of found) {
      if (item.final?.decision !== 'ACCEPT') {
        throw new Fail(EXIT.USAGE, { ok: false, error: 'not-accepted', message: `${item.id} is not an accepted item, so it cannot be marked implemented` });
      }
    }
    // The hash must be measured from a FRESH origin/<default_branch>: a stale one makes the hash differ merely because main's new commits
    // (merged into the PR by update-branch, pulled without a fetch of main) count as the PR's diff, and they would pass for the fix.
    // So this fails CLOSED (exit 3, nothing marked) whenever the base ref used is origin/<branch> and it was not refreshed in this call:
    // the fetch failed or timed out, or there is no origin remote but a leftover refs/remotes/origin/<branch>. Only a repo whose base
    // resolves to the local <branch> (no origin/<branch> ref at all) has nothing to refresh and carries on.
    const refresh = refreshBaseRef(root, config);
    if (refresh.usesRemoteRef && !refresh.refreshed) {
      throw new Fail(EXIT.UNAVAILABLE, {
        ok: false, unavailable: true, reason: 'base-refresh',
        message: `origin/${config.default_branch} could not be refreshed${refresh.reason ? ` (${refresh.reason})` : ''}, and a stale base would count the default branch's new commits as the fix: nothing was marked; retry when the remote is reachable`,
      });
    }
    // An accepted item is only "implemented" by a change to the code: the branch content must differ from what the
    // round that accepted it reviewed. Otherwise an empty fix and an empty review round would clear a BLOCKING finding.
    const hash = currentContentHash(root, config);
    const otherFiles = new Set(); // ids of forced / Claude-ruled ACCEPTs whose fix is not in the file they name (E7)
    for (const { round, item } of found) {
      if (hash === round.contentHashAtToHead) {
        throw new Fail(EXIT.USAGE, {
          ok: false, error: 'no-code-change',
          message: `${item.id} cannot be marked implemented: the branch content is identical to what round ${round.n} reviewed (no fix has been committed)`,
        });
      }
      // A settle-by-test commit changes the hash too, so also require a non-test file to have changed since then.
      // Measured from the round's head, minus whatever was merged in from the default branch since (those are not the PR's
      // change). This gate fails closed: if that range cannot be worked out exactly (git failed, or a conflicting merge
      // whose resolution is not recorded as a merge commit), the mark is refused rather than counting files the fix did not touch.
      let changed;
      let dropped = []; // changed since the base, but the current content was written by a merge or by the default branch
      let netEmpty = false;
      let wholePr = false;
      try {
        const forkPoint = mergeBase(reviewBaseRef(root, config), 'HEAD', { cwd: root });
        const since = effectiveReviewBase({ from: round.toHead, forkPoint }, { cwd: root });
        let base = since.base;
        if (since.kind === 'whole-pr') {
          wholePr = true;
          // The trial merge conflicted (or is unsupported), and it will never change: both of its inputs are fixed. The PR's
          // own work since then is measured from the merge commit that resolved the conflict.
          base = baseAfterConflictMerge({ root, config, toHead: round.toHead, forkPoint });
          if (base === null) {
            throw new Error(`the default branch was merged into the PR since round ${round.n} with a conflict, and no merge commit of the default branch after that round records the resolution, so the PR's own changes cannot be told apart from the default branch's`);
          }
        } else if (since.kind !== 'previous' && since.kind !== 'synthetic') {
          throw new Error(`unexpected review base kind ${since.kind}`);
        }
        const net = parseRawZ(git(['diff', '--raw', '--no-renames', '--no-abbrev', '-z', `${base}..HEAD`], { cwd: root }));
        netEmpty = net.length === 0;
        // The authorship filter covers every changed path, test files too, so a test hand-edited inside a merge cannot satisfy testFix.
        const authored = new Set(ownAuthored({ root, config, toHead: round.toHead, changes: net }).map((c) => c.path));
        changed = net.filter((c) => authored.has(c.path)).map((c) => c.path);
        dropped = net.filter((c) => !authored.has(c.path) && c.path !== config.agent_log).map((c) => c.path);
      } catch (err) {
        throw new Fail(EXIT.USAGE, {
          ok: false, error: 'base-unresolved',
          message: `${item.id} cannot be marked implemented: could not tell which files changed since round ${round.n} (${err.message})`,
        });
      }
      const own = changed.filter((f) => f !== config.agent_log);
      const code = own.filter((f) => !matchAny(f, config.integrity.test_globs));
      // A test file is the fix itself when the finding is about the tests (category testing) or names that very file
      // (a helper under a test glob, #53). A settle-by-test commit touches neither, so it still does not count.
      const itemFile = String(item.file ?? '').replace(/^\.\//, '');
      const testFix = own.length > 0 && (item.category === 'testing' || (itemFile !== '' && own.includes(itemFile)));
      if (code.length === 0 && !testFix) {
        throw new Fail(EXIT.USAGE, {
          ok: false, error: 'no-code-change',
          message: `${item.id} cannot be marked implemented: since round ${round.n} only test files changed (${changed.join(', ') || 'nothing'}); commit the fix itself (a test-only fix counts only for a testing finding or one about that test file)${notWritten(dropped)}${wholePr && netEmpty ? '; a fix committed before the conflict-resolving merge must be committed again after it' : ''}`,
        });
      }
      // A forced or Claude-ruled ACCEPT whose named file is empty or was not changed: the mark stands, but nobody has seen that the named problem is
      // fixed, so it is confirm-needed ('other-files'): the next review round's prompt asks Codex, and review-complete waits for that round.
      // Ordinary ACCEPTs (the judge's, the arbiter's, a test's, the owner's) are untouched.
      const claudeOrForced = typeof item.final?.forcedBy === 'string' || item.final?.by === 'claude' || (item.final?.claude !== undefined && item.final.claude !== null);
      if (claudeOrForced && (itemFile === '' || !own.includes(itemFile))) otherFiles.add(item.id);
    }
    for (const { round, item } of found) {
      const { implementedVia: _earlier, ...rest } = item; // an earlier mark is judged again: the named file may have been changed since
      // implementedAfterRound: the newest round number at the time of the mark, so a later deferral can tell a fix made before the last reviewed round from one made after it (triage.mjs deferEligibility).
      state = updateItems(state, round.n, [{ ...rest, implemented: true, implementedAfterRound: Math.max(...state.rounds.map((r) => r.n)), ...(otherFiles.has(item.id) ? { implementedVia: 'other-files' } : {}) }]);
    }
    saveState(root, state);
    return { exitCode: EXIT.OK, output: { ok: true, marked: ids } };
  });
}

function recordFollowup(rest, ctx) {
  const { values } = parseCommandArgs(rest, { id: { type: 'string' }, url: { type: 'string' }, repo: { type: 'string' } }, { allowPositionals: false });
  const id = requireOption(values, 'id');
  const url = requireOption(values, 'url');
  if (!/^https?:\/\/\S+$/.test(url)) throw new UsageError('--url must be an http(s) URL');
  const root = resolveRepo(values, ctx);
  return withStateLock(root, ctx, () => {
    const state = requireState(root);
    const { round, item } = findItem(state, id);
    saveState(root, updateItems(state, round.n, [{ ...item, followupIssue: url }]));
    return { exitCode: EXIT.OK, output: { ok: true, id, url } };
  });
}

function setOutcome(rest, ctx) {
  const { values } = parseCommandArgs(rest, { outcome: { type: 'string' }, repo: { type: 'string' } }, { allowPositionals: false });
  const text = requireOption(values, 'outcome').replace(/\s+/g, ' ').trim();
  if (text === '' || text.length > 200) throw new UsageError('--outcome must be 1-200 characters of plain text');
  const root = resolveRepo(values, ctx);
  return withStateLock(root, ctx, () => {
    const state = requireState(root);
    saveState(root, { ...state, outcome: text });
    return { exitCode: EXIT.OK, output: { ok: true, outcome: text } };
  });
}

// ---- fable-refresh ------------------------------------------------------------------------

// A proven Fable pass recorded with a Fable older than MIN_FABLE is re-reviewed (plan 2026-11-10 A4b), not grandfathered. This opens the round that does it: no
// Codex, no items, the same code as the last round. It is uncounted (never capped: a PR at its last round, or past it, must still be able to refresh), and
// Fable-pending until a proven pass, so review-complete waits for it exactly as for any Fable round.
async function fableRefresh(rest, ctx) {
  const { values } = parseCommandArgs(rest, { pr: { type: 'string' }, repo: { type: 'string' } }, { allowPositionals: false });
  const pr = intOption(values, 'pr', { required: true, min: 1 });
  const root = resolveRepo(values, ctx);
  const { config } = await requireConfig(root);
  return withStateLock(root, ctx, async () => {
    const state = requireState(root);
    if (state.pr !== pr) {
      throw new Fail(EXIT.USAGE, { ok: false, error: 'state-pr-mismatch', message: `the review state belongs to PR #${state.pr}, not #${pr}` });
    }
    const gate = readReviewGate({ env: ctx.env ?? process.env });
    // The arbiter's Fable passes below the floor, plus the substitute-fable reviews below it (a substitute stood in for Codex): one whole-PR Fable pass replaces both.
    const staleByRound = new Map();
    for (const e of [...staleFableRounds(state, gate), ...staleSubstituteFableRounds(state, gate)]) staleByRound.set(e.round, [...new Set([...(staleByRound.get(e.round) ?? []), ...e.models])].sort());
    const stale = [...staleByRound].sort((a, b) => a[0] - b[0]).map(([round, models]) => ({ round, models }));
    if (stale.length === 0) {
      throw new Fail(EXIT.USAGE, { ok: false, error: 'nothing-stale', message: `no proven Fable round is below ${gate.threshold} (or a later whole-PR pass already replaced it): there is nothing to refresh` });
    }
    const last = state.rounds.at(-1);
    const o = { cwd: root };
    const head = headSha(o);
    // As in state outcome: a stale origin/<default_branch> only makes the content look moved, and the refusal below says what to do then.
    refreshBaseRef(root, config);
    const hash = currentContentHash(root, config);
    const outcome = roundOutcome({ ...state, currentContentHash: hash });
    const unfinished = [
      ...outcome.fablePending.map((n) => `the Fable pass of round ${n} is not proven`),
      ...[...new Set([...outcome.pending, ...outcome.needsHuman, ...outcome.openBlocking, ...outcome.unimplemented, ...outcome.newAccepted])]
        .map((id) => `${id} is undecided, waiting for a human, or an accepted fix not yet implemented and reviewed`),
    ];
    if (unfinished.length > 0) {
      throw new Fail(EXIT.USAGE, { ok: false, error: 'unfinished-round', message: `an earlier round is not finished: ${unfinished.join('; ')}`, unfinished });
    }
    // Only the head GitHub holds is refreshed: review-complete compares the reviewed head with the PR's.
    const view = await guardGh(() => createGitHub({ cwd: root, env: ctx.env }).prView(pr, ['headRefOid', 'baseRefName']));
    if (view.headRefOid !== head) {
      throw new Fail(EXIT.USAGE, {
        ok: false, error: 'head-not-pushed',
        message: `local HEAD ${head} is not the head of PR #${pr} on GitHub (${view.headRefOid ?? 'unknown'}): push or pull first`, localHead: head, prHead: view.headRefOid ?? null,
      });
    }
    // A head that review-complete accepts through the docs-only exemption (only ledger rows added since the last round) is refreshed too: the round
    // stays pinned at the last reviewed head, so the exemption still covers those commits afterwards.
    const exempt = outcome.coverageValid ? null : docsExemptFrom(state, { root, config, hash });
    if (!outcome.coverageValid && !exempt.exempt) {
      throw new Fail(EXIT.USAGE, {
        ok: false, error: 'content-moved',
        message: `the content changed since round ${last.n}: run a normal codex-review round instead (its Fable pass already reads the whole PR, so it replaces the old proof)${exempt.off ? '' : `; the docs-only exemption does not apply: ${exempt.reason}`}`,
        currentContentHash: hash,
      });
    }
    // The whole-PR range starts at the PR's merge base now (a base branch merged in since the last round moves it).
    let forkPoint = last.forkPoint ?? state.rounds[0]?.reviewBase;
    try {
      // An untrusted anchor (GitHub named no base branch and the remote did not name the default one) is the PR's to choose: keep the fork point the last round recorded rather than let it move the range (S1).
      const { branch: prBase, untrusted } = prBaseBranch(view, root, config);
      if (untrusted === null) forkPoint = mergeBase(reviewBaseRef(root, config, prBase), head, o);
    } catch (err) {
      if (!(err instanceof GitError)) throw err;
    }
    const n = last.n + 1;
    const models = [...new Set(stale.flatMap((s) => s.models))];
    const next = addRound({ ...state, currentContentHash: hash }, {
      n, fromHead: last.toHead, toHead: exempt?.exempt ? last.toHead : head, contentHashAtToHead: last.contentHashAtToHead, items: [],
      ...(last.reviewBase === undefined ? {} : { reviewBase: last.reviewBase, reviewBaseKind: last.reviewBaseKind }),
      ...(typeof forkPoint === 'string' && forkPoint !== '' ? { forkPoint } : {}),
      ...(typeof last.codexModel === 'string' ? { codexModel: last.codexModel } : {}),
      fableRefresh: true, fableRequired: true,
      fableReasons: [`fable-refresh: rounds ${stale.map((s) => s.round).join(',')} proven with ${models.join(', ')} below ${gate.threshold}`],
      sensitivePaths: Array.isArray(last.sensitivePaths) ? last.sensitivePaths : [],
    });
    saveState(root, next);
    return { exitCode: EXIT.OK, output: { ok: true, round: n, staleRounds: stale, scope: 'whole-pr' } };
  }, pr);
}

// ---- past-round-grant ---------------------------------------------------------------------

// The counted ordinal of round n in `state` (base-only and resolution-only rounds do not count), or null.
function ordinalOf(state, n) {
  let k = 0;
  for (const r of state.rounds ?? []) {
    if (countsTowardCap(r)) k += 1;
    if (r.n === n) return countsTowardCap(r) ? k : null;
  }
  return null;
}

async function pastRoundGrant(rest, ctx) {
  const { values } = parseCommandArgs(rest, { pr: { type: 'string' }, round: { type: 'string' }, repo: { type: 'string' } }, { allowPositionals: false });
  const pr = intOption(values, 'pr', { required: true, min: 1 });
  const n = intOption(values, 'round', { required: true, min: 1 });
  const root = resolveRepo(values, ctx);
  const { config } = await requireConfig(root);
  const refuse = (error, message, extra = {}) => new Fail(EXIT.USAGE, { ok: false, error, message, ...extra });
  if (config.owner_approval !== 'chat') throw refuse('label-mode', 'the owner\'s approval of a past round is recorded only with owner_approval: chat in pipeline.yml; in label mode the agent parks');
  const max = config.review?.max_rounds;
  if (!Number.isInteger(max) || max < 1) throw refuse('no-max-rounds', 'review.max_rounds is not configured in pipeline.yml, so no round is known to be past it');
  const gh = createGitHub({ cwd: root, env: ctx.env });
  return guardGh(() => withStateLock(root, ctx, () => {
    const local = requireState(root);
    if (local.pr !== pr) throw refuse('state-pr-mismatch', `the review state here belongs to PR #${local.pr}, not #${pr}`);
    const { slug, host } = gh.repo();
    if (host !== 'github.com') throw refuse('host', `gh resolves this repository on ${host ?? 'an unknown host'}, not github.com, and the owner's recorded approval names a repository on github.com`);
    const found = readPublished(gh, pr);
    const { problem, diff } = pastRoundHistoryProblem({ local, published: found, pr, tolerateGrants: true });
    if (problem) throw refuse(problem.error, problem.message);
    const ours = { repo: slug, pr };
    // Eligibility is decided on what the PR holds.
    const eligible = pastRoundsNeedingApproval(found.state, found.state, { maxRounds: max, ...ours });
    const target = eligible.find((e) => e.n === n);
    const publishedRound = found.state.rounds.find((r) => r.n === n);
    if (target === undefined) {
      const done = publishedRound?.ownerGrant !== undefined && verifyOwnerGrant({ ...ours, k: ordinalOf(found.state, n), toHead: publishedRound.toHead, ownerGrant: publishedRound.ownerGrant }).ok;
      if (done) throw refuse('already-approved', `round ${n} already carries an owner grant that verifies on this machine: nothing to approve`);
      throw refuse('not-eligible', `round ${n} is not a round the owner can approve after it ran: it must be a counted round past review.max_rounds (${max}) and its automatic extra round, held by the PR's triage comment with a LATER counted round after it, and carry no owner grant (or one whose record is gone)${eligible.length > 0 ? `; the rounds that qualify: ${eligible.map((e) => e.n).join(', ')}` : ''}`);
    }
    const { k, toHead } = target;
    const localRound = local.rounds.find((r) => r.n === n);
    // Grant metadata this copy holds that the PR lacks (or holds differently) is published with this call, so it must verify here first; a different grant is allowed
    // only for the round being re-approved, whose published grant has to be the unverifiable one.
    for (const m of [...(diff?.grantsAhead ?? []), ...(diff?.grantsDiffer ?? [])]) {
      const r = local.rounds.find((x) => x.n === m);
      const v = verifyOwnerGrant({ ...ours, k: ordinalOf(local, m), toHead: r.toHead, ownerGrant: r.ownerGrant });
      if (!v.ok) throw refuse('unverified-grant', `this copy holds an owner grant on round ${m} that the PR lacks and that does not verify on this machine (${v.reason}): run \`pipeline state show --pr ${pr}\`, which drops it (the PR is the published history), then ask again`);
      if (diff.grantsDiffer.includes(m) && m !== n) throw refuse('stale-history', `this copy holds another owner grant than the PR on round ${m}: run \`pipeline state show --pr ${pr}\` to restore the published state here, then try again`);
    }
    const replaced = publishedRound.ownerGrant !== undefined; // re-approval: the published grant no longer verifies (it is why the round is eligible)
    const q = { ...ours, k, head: toHead };
    // Resume: a record of this round whose marker is already spent and verifies (an earlier run claimed it and stopped before saving or publishing).
    const asGrant = (rec) => ({ grantId: grantIdOf(rec), k, quote: rec.prompt, ownerTs: rec.ts, past: true });
    const resumed = ownerPastRoundHistory(q).find((rec) => verifyOwnerGrant({ ...ours, k, toHead, ownerGrant: asGrant(rec) }).ok);
    const fresh = ownerPastRoundRecords(q); // unspent, < 24 h, the owner's own prompts
    if (resumed === undefined && fresh.length === 0) {
      throw refuse('no-grant', `no approval of past round ${n} (counted round ${k}, head ${toHead.slice(0, 12)}) is recorded for ${slug} #${pr}: run \`P triage round-request --pr ${pr} --past\`, show its closing line, and ask the owner to type "approve round" (within 24 h, typed by the owner, not while the agent is working)`);
    }
    // This copy holds what the PR holds (it may only carry grants and trailing rounds ahead): record that as its baseline BEFORE the claim. A stale baseline (a crash between
    // an earlier publication's upsert and its baseline write) would refuse the publication below as stale-publication after the owner's approval is spent, with no way out.
    // A copy that differs in anything else (a decision or round-level proof the PR holds) keeps its baseline, and is refused here for the same reason, before the claim.
    if (readBaseline(root, pr) !== found.hash && equalsPublishedApartFromGrants(local, found.state)) writeBaseline(root, pr, found.hash);
    if (readBaseline(root, pr) !== found.hash) {
      throw refuse('stale-publication', `the PR's triage comment holds a review state this copy did not publish or restore (another checkout or machine published since): publishing the approval now would erase it, so it is not claimed: run \`pipeline state show --pr ${pr}\` to restore the published state here, then ask again`);
    }
    const chosen = resumed ?? fresh[0];
    const claimed = [];
    // Every matching record is consumed together (a duplicate "approve round" must not outlive the claim); on resume only the leftovers are.
    const toClaim = resumed === undefined ? fresh : fresh.filter((rec) => grantIdOf(rec) !== grantIdOf(resumed));
    if (toClaim.length > 0) {
      const claim = claimGrantMarkers(toClaim, { repo: slug, pr, k, head: toHead, checkout: root });
      claimed.push(...(claim.claimed ?? []).map((c) => c.grantId));
      if (!claim.ok) {
        throw new Fail(EXIT.FAILED, {
          ok: false, error: 'claim-failed', round: n, k, claimed,
          message: `the owner's approval could not be claimed (${claim.reason}${claimed.length > 0 ? `; ${claimed.length} marker(s) are already spent` : ''}): run the command again to resume${claim.reason === 'used' ? '; if another checkout used the approval, it is picked up then' : ''}`,
        });
      }
    }
    const ownerGrant = asGrant(chosen);
    const alreadySaved = localRound.ownerGrant !== undefined && JSON.stringify(localRound.ownerGrant) === JSON.stringify(ownerGrant) && localRound.admission === 'owner';
    const next = { ...local, rounds: local.rounds.map((r) => (r.n === n ? { ...r, ownerGrant, admission: 'owner' } : r)) };
    if (!alreadySaved) {
      try {
        saveState(root, next);
      } catch (err) {
        throw new Fail(EXIT.FAILED, {
          ok: false, error: 'save-failed', round: n, k, grantId: ownerGrant.grantId, claimed,
          message: `the owner's approval is claimed (its marker stays spent) but the review state could not be saved (${String(err?.message ?? err).split('\n')[0].slice(0, 160)}): run the command again to resume`,
        });
      }
    }
    const out = { round: n, k, grantId: ownerGrant.grantId, claimed, saved: !alreadySaved };
    const remaining = eligible.filter((e) => e.n !== n).map(({ n: m, k: ord }) => ({ n: m, k: ord }));
    // \`pipeline comment\` publishes without replaceGrants, so it cannot publish a re-approval's replacement of the PR's grant.
    const retry = `run \`pipeline state past-round-grant --pr ${pr} --round ${n}\` again${replaced ? '' : ` (or \`pipeline comment --pr ${pr} --kind triage\`)`} to publish it`;
    try {
      publishTriage({ gh, root, pr, state: alreadySaved ? local : next, replaceGrants: replaced ? [n] : [] });
    } catch (err) {
      if (err instanceof GhError || err instanceof UnavailableError) {
        return { exitCode: EXIT.UNAVAILABLE, output: { ok: false, unavailable: true, reason: 'github', ...out, published: false, remaining, next: `GitHub could not be reached, so the approval is saved here only: ${retry}` } };
      }
      if (err instanceof Fail && (err.output?.error === 'stale-publication' || err.output?.error === 'history-loss')) {
        return { exitCode: EXIT.FAILED, output: { ok: false, error: err.output.error, ...out, published: false, remaining, reason: err.output.reason, next: `NOT published: the approval is saved here only. Run \`pipeline state show --pr ${pr}\`, then ${retry}` } };
      }
      throw err;
    }
    return { exitCode: EXIT.OK, output: { ok: true, ...out, published: true, remaining } };
  }, pr));
}

const SUBCOMMANDS = {
  show, 'discard-round': discardRound, outcome, 'mark-implemented': markImplemented, 'fable-refresh': fableRefresh, 'record-followup': recordFollowup, 'set-outcome': setOutcome, 'past-round-grant': pastRoundGrant,
};

export const run = guarded(async (argv, ctx) => {
  const [sub, ...rest] = argv;
  if (!sub || !Object.hasOwn(SUBCOMMANDS, sub)) throw new UsageError(`usage: pipeline state ${Object.keys(SUBCOMMANDS).join('|')} ...`);
  return SUBCOMMANDS[sub](rest, ctx);
});
