// Reads and updates .review/state.json for the skills: which items are open, whether the loop may exit, and the few
// facts only the skill knows (an item was implemented, a follow-up issue exists, how the run ended). The state is the
// only memory of the review loop, so a lost local copy is rebuilt from the PR's triage comment, which embeds it.
import { EXIT, UnavailableError, UsageError, intOption, parseCommandArgs, requireOption } from '../lib/cli.mjs';
import { mkdirSync, existsSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Fail, guarded, requireConfig, resolveRepo } from '../lib/cmd-common.mjs';
import { GitError, effectiveReviewBase, git, headSha, isAncestor, mergeBase, revParse } from '../lib/git.mjs';
import { grantIdOf, ownerGrantedRounds } from '../hooks/lib/owner-go.mjs';
import { createGitHub, guardGh } from '../lib/github.mjs';
import { matchAny } from '../lib/glob.mjs';
import { docsExemptFrom } from '../lib/docs-exempt.mjs';
import { readReviewGate } from '../lib/model-floor.mjs';
import { addRound, loadState, saveState, updateItems } from '../lib/state.mjs';
import { arbiterFailures, finalIsReopenable, isOwnerRuled, isProtectedFinal, reviewedRoundCount, roundOutcome, staleFableRounds } from '../lib/triage.mjs';
import { readBaseline, readPublished, reviewContentHash, writeBaseline } from '../lib/review-publish.mjs';
import {
  allItems, canonicalJson, currentContentHash, decidedItemsKey, findItem, findRound, followupsPending, newStaleDir, quarantineReviewDir, refreshBaseRef, requireState, reviewBaseRef,
  roundDir, stateExtends, withStateLock,
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
    '  (GitHub unreachable but a local state exists: served as is with a `warnings` entry, exit 0; with no local state exit 3)',
    'pipeline state discard-round --round R [--pr N] [--repo DIR]',
    '  -> drop an unpublished, trailing round R from the local state and move .review/round-R/ into .review/stale-<UTC time>/;',
    '     refused (exit 2) when the PR triage comment already holds round R, or (error round-has-verdict) when the round holds a second-review verdict',
    'pipeline state outcome [--repo DIR]   -> roundOutcome + {clean, arbiterFailures, followupsPending, rounds, reviewedRounds, maxRounds}; exit 0 whether or not clean',
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
    '     a Fable older than MIN_FABLE (or the lower hold of model-floor reset --hold) is re-reviewed. Refused (exit 2) unless a proven Fable round is below that and no later whole-PR pass at or above it replaced it (error nothing-stale), every earlier round is finished',
    '     (error unfinished-round: a Fable pass owed, an undecided, human-owed, unimplemented or newly accepted item), HEAD is the head of PR N on GitHub (error head-not-pushed; exit 3 when GitHub is unreachable)',
    '     and the content is what the last round reviewed, or only ledger rows were added since (review.docs_exempt_paths; the round then stays pinned at the last reviewed head) (error content-moved: run a normal codex-review round instead, its Fable pass already reads the whole PR). Then: arbiter needed --round R, the arbiter, arbiter apply',
    'pipeline state record-followup --id ID --url URL [--repo DIR]',
    'pipeline state set-outcome --outcome TEXT [--repo DIR]',
  ].join('\n'),
};

// ---- show -----------------------------------------------------------------------------------

const isAccepted = (i) => i.final?.decision === 'ACCEPT' && !i.implemented;
const isDisputed = (i) => i.judge?.disputedBug === true && i.judge.settleTest?.possible === true && (i.test?.status ?? 'none') === 'none';
const needsHuman = (i) => i.final?.needsHuman === true;

// The published review state: the newest comment of ours that STARTS with the triage marker (a quoted or forged marker in someone else's comment,
// or in the middle of ours, must never become the state). -> { state, hash, ... } (lib/review-publish.mjs#readPublished); state is null when there is none.
function recoverState(root, pr, ctx) {
  return guardGh(() => readPublished(createGitHub({ cwd: root, env: ctx.env }), pr));
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
  if (!state) {
    if (pr === undefined) {
      throw new Fail(EXIT.USAGE, { ok: false, error: 'no-state', message: 'no review state here: pass --pr N to rebuild it from the PR triage comment' });
    }
    const found = await recoverState(root, pr, ctx);
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
      found = await recoverState(root, pr, ctx);
    } catch (err) {
      if (!(err instanceof UnavailableError)) throw err;
      warnings.push(`GitHub unavailable: the local review state was not compared with the published triage comment (${String(err.message).split('\n')[0].slice(0, 200)})`);
      source = 'local-unverified';
    }
    if (found?.state && !stateExtends(state, found.state)) {
      if (localAheadOfPublished(state, found, readBaseline(root, pr))) {
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
  }

  const pool = n === undefined ? allItems(state) : findRound(state, n).items;
  const items = pool.filter((i) => (!values.accepted || isAccepted(i)) && (!values.disputed || isDisputed(i)) && (!values['needs-human'] || needsHuman(i)));
  return {
    exitCode: EXIT.OK,
    output: { ok: true, recovered, source, ...(quarantinedTo ? { quarantinedTo } : {}), ...(warnings.length ? { warnings } : {}), pr: state.pr, lightLane: state.lightLane, count: items.length, items },
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
  return {
    exitCode: EXIT.OK,
    output: { ok: true, ...result, arbiterFailures: arbiterFailures(state), followupsPending: followupsPending(state), currentContentHash: hash, rounds: state.rounds.length, reviewedRounds: reviewedRoundCount(state), maxRounds: state.maxRounds },
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
    const stale = staleFableRounds(state, gate);
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
      const prBase = typeof view.baseRefName === 'string' && view.baseRefName !== '' ? view.baseRefName : config.default_branch;
      forkPoint = mergeBase(reviewBaseRef(root, config, prBase), head, o);
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

const SUBCOMMANDS = {
  show, 'discard-round': discardRound, outcome, 'mark-implemented': markImplemented, 'fable-refresh': fableRefresh, 'record-followup': recordFollowup, 'set-outcome': setOutcome,
};

export const run = guarded(async (argv, ctx) => {
  const [sub, ...rest] = argv;
  if (!sub || !Object.hasOwn(SUBCOMMANDS, sub)) throw new UsageError(`usage: pipeline state ${Object.keys(SUBCOMMANDS).join('|')} ...`);
  return SUBCOMMANDS[sub](rest, ctx);
});
