// One round of the cross-model review: runs the Codex CLI over `base..head`, validates what it wrote, gives every
// finding an id and appends the round to .review/state.json. The merge gate must never read "Codex failed" as
// "Codex found nothing", so every way this can go wrong (non-zero exit, timeout, no binary, no output file, a stale
// file, output that is not the schema) is exit 3 with `unavailable:true` and a reason; only a validated findings file
// (even an empty one) becomes a round.
//
// The range is not the caller's to choose. Round 1 must start at the merge base of the PR (so the review covers the
// whole PR and risk / light lane are measured on all of it); every later round must start where the previous one
// ended (so nothing between two rounds goes unreviewed). Anything else is exit 2 before Codex runs.
// What Codex is shown for a later round is that range minus whatever was merged in from the PR's base branch since the
// previous round (git.mjs#effectiveReviewBase): those commits were reviewed in their own PRs. A round that is nothing but
// such a merge is recorded as `baseOnly` without running Codex. When that merge conflicted and the resolver only chose lines
// the two sides already had (git.mjs#resolutionReviewBase proves it), the round is shown just the resolution and is recorded as
// `resolutionOnly`: a real review that does not count toward the round cap. The state is
// read-modified-written under the per-PR lock, but the lock is NOT held while Codex runs (up to 30 minutes): the
// state is read again under the lock once Codex has answered, and a round recorded in the meantime wins.
import { createHash } from 'node:crypto';
import path from 'node:path';
import { EXIT, UsageError, intOption, parseCommandArgs, requireOption } from '../lib/cli.mjs';
import {
  FINDINGS_SCHEMA_PATH, assignIds, buildCodexArgs, buildReviewPrompt, largeBinaryNote, renderFindingsMarkdown, validateFindings,
} from '../lib/codex.mjs';
import { CODEX_TIMEOUT_MS, execCodex, readCodexAnswer } from '../lib/codex-exec.mjs';
import { Fail, guarded, requireConfig, resolveRepo } from '../lib/cmd-common.mjs';
import {
  GitError, NETWORK_TIMEOUT_MS, diffFiles, effectiveReviewBase, git, headSha, mergeBase, resolutionReviewBase, reviewPatch, revParse, showFile,
} from '../lib/git.mjs';
import { collectHardStops } from '../lib/hardstops.mjs';
import { createGitHub } from '../lib/github.mjs';
import { GhError } from '../lib/proc.mjs';
import { assessRisk, isLightLane, reviewLane } from '../lib/risk.mjs';
import { addRound, emptyState, loadState, saveState } from '../lib/state.mjs';
import { linkDeferredFollowups, reuseRuled, reviewedRoundCount, roundAdmission, roundOutcome, ruledCacheFrom } from '../lib/triage.mjs';
import { claimGrantMarkers, grantIdOf, ownerGrantConfigDirHint, ownerGrantedRounds, ownerGrantGap } from '../hooks/lib/owner-go.mjs';
import {
  allItems, currentContentHash, ensureRoundDir, excerptWindow, reviewBaseRef, roundDir, withReviewLock, writeFileAtomic,
  writeJson,
} from '../lib/review-context.mjs';

export const meta = {
  summary: 'run one Codex review round over base..head and record its findings',
  usage: [
    'pipeline codex-review --pr N --round R --base SHA --head SHA --effort low|medium|high|xhigh [--model M] [--repo DIR]',
    '  -> {ok, round, counts:{blocking, suggestions, worth_considering}, preRuled, lightLane, reviewer, reviewerReasons, path}',
    '  --base must be the PR\'s merge base for round 1 and the previous round\'s toHead after that, else exit 2 {error:base-mismatch}',
    '  exit 2 {error:empty-range} when earlier rounds accepted items and the branch content is unchanged since the last round (base == head, an empty commit,',
    '    an amend); the message names the accepted items still waiting for a fix, or says the content is what round N reviewed. Never for a round that only merged',
    '    the base branch in (below): that is recorded as baseOnly even when the content hash did not move',
    '  exit 2 {error:round-cap} past review.max_rounds, except ONE extra round when the last round only accepted fixes (state outcome extraRound)',
    '    or ONE round per owner grant (owner_approval: chat only): the owner typed "extra round" after a reply ending with the line triage round-request',
    '    printed, for this repository, PR, counted round and head (an owner record younger than 24 h; the automatic extra round is used first). The',
    '    grant is claimed AFTER Codex answered, under the final lock, as the last step before the state is saved, by exclusively creating a machine-global marker (one grant admits one run on',
    '    this machine): a grant already used, or recorded for another head ("ask again"), is exit 2 round-cap; Codex exit 3, head-moved and a kill before the claim',
    '    leave the grant open (a failure after the claim spends it: ask again). Success adds grantUsed:{grantId}; the round records admission and ownerGrant {grantId, k, quote, ownerTs}',
    '    base-only rounds and resolution-only rounds (below) never count toward the cap',
    '  reviewer: fable (medium/high risk or a sensitive path: risk.high_risk_paths, review.arbiter_always_paths) records the round as fableRequired',
    '    (the Fable pass must run: arbiter needed/apply) and gives Codex an attacker\'s brief for the sensitive files; judge otherwise. Once fable, always fable',
    '  confirm fixed: an accepted item that a forced or Claude ruling marked implemented through files other than the one it names (state mark-implemented,',
    '    implementedVia other-files) is listed in the prompt of the next round that runs Codex (not a base-only one), with its original finding fenced as untrusted',
    '    text: Codex says whether it is really fixed and raises it again as BLOCKING when it is not. The round records round.confirmFixed:[ids] (absent when none)',
    '  commits merged in from the PR\'s base branch since the previous round are left out of the reviewed diff; a round that only merged them in',
    '    is recorded without running Codex: {ok:true, baseOnly:true, counts all 0}',
    '  when that merge conflicted and the resolution only chose lines the two sides already had, Codex reviews just the resolution:',
    '    {resolutionOnly:true, conflicted, conflictedCount}; the round is a real review but does not count toward the cap. Otherwise',
    '    the whole PR is reviewed as before (a counted round) and {resolutionIneligible:"<reason>"} says why the resolution was not',
    '    taken alone',
    '  exit 3 {ok:false, unavailable:true, reason: quota|auth|unavailable|error|malformed|github} when Codex or GitHub could not deliver',
    '  env: PIPELINE_CODEX_TIMEOUT_MS overrides the 30 minute Codex timeout (tests)',
  ].join('\n'),
};

export { CODEX_TIMEOUT_MS };

// What the prompt and the stored round carry of a proven resolution. The lists are cut to 50 (dropped blocks first, so a cut never
// hides a drop); the totals are over ALL blocks and travel with them, so nothing downstream has to count a truncated list.
const resolutionSummary = (r) => ({
  conflicted: r.conflicted.slice(0, 50),
  conflictedCount: r.conflictedCount,
  blocks: [...r.blocks.filter((b) => b.droppedTheirs > 0), ...r.blocks.filter((b) => b.droppedTheirs === 0)].slice(0, 50),
  blockCount: r.blockCount,
  blocksWithDrops: r.blocksWithDrops,
  droppedTheirsTotal: r.droppedTheirsTotal,
});

const unavailable = (reason, extra = {}) => new Fail(EXIT.UNAVAILABLE, { ok: false, unavailable: true, reason, ...extra });

export const run = guarded(async (argv, ctx) => {
  const { values } = parseCommandArgs(argv, {
    pr: { type: 'string' }, round: { type: 'string' }, base: { type: 'string' }, head: { type: 'string' },
    effort: { type: 'string' }, model: { type: 'string' }, repo: { type: 'string' },
  }, { allowPositionals: false });
  const pr = intOption(values, 'pr', { required: true, min: 1 });
  const round = intOption(values, 'round', { required: true, min: 1 });
  const baseRef = requireOption(values, 'base');
  const headRef = requireOption(values, 'head');
  const effort = requireOption(values, 'effort');
  const root = resolveRepo(values, ctx);
  const { config } = await requireConfig(root);
  const o = { cwd: root };

  // Full SHAs everywhere: they go into the prompt, the state and the round's recorded range.
  const base = revParse(`${baseRef}^{commit}`, o);
  const head = revParse(`${headRef}^{commit}`, o);
  if (headSha(o) !== head) {
    throw new Fail(EXIT.USAGE, {
      ok: false, error: 'head-mismatch',
      message: `--head ${head} is not the checked-out HEAD ${headSha(o)}: review the commit that is checked out`,
    });
  }

  const dir = roundDir(root, round);
  const outPath = path.join(dir, 'codex-raw.json');
  const model = values.model ?? config.review.codex_model;
  let args;
  try {
    args = buildCodexArgs({ cwd: root, model, effort, schemaPath: FINDINGS_SCHEMA_PATH, outPath });
  } catch (err) {
    throw new UsageError(err.message);
  }

  const readState = () => {
    try {
      return loadState(root);
    } catch (err) {
      throw new Fail(EXIT.USAGE, { ok: false, error: 'state', message: err.message });
    }
  };
  // Is this the next round of this PR's review? Run before Codex and again under the lock afterwards (the cap: see checkCap).
  const checkRound = (st) => {
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
  // The round cap counts reviewed rounds only, so it waits until baseOnly / resolutionOnly are known (before anything is
  // written for the round).
  // An owner grant is looked up only when ordinary admission does not cover the round, and only in chat mode (label mode never grants).
  // The lookup is the owner's records for this PR on github.com (the gh repo), any head: roundAdmission compares the head itself.
  // The gh repo is resolved eagerly below, before any admission check, in chat mode: roundAdmission swallows what the lookup throws
  // (no grant), so a GitHub failure here would otherwise read as a round-cap refusal instead of exit 3.
  let ghRepo;
  const ownerRecords = (k) => {
    if (config.owner_approval !== 'chat') return [];
    if (ghRepo.host !== 'github.com') return [];
    return ownerGrantedRounds({ repo: ghRepo.slug, pr, k, anyHead: true }).map((r) => ({ grantId: grantIdOf(r), head: r.head, quote: r.prompt }));
  };
  const admit = (st, flags) => (st ? roundAdmission(st, round, { ...flags, head, grants: ownerRecords }) : { admission: reviewedAdmission(flags), problem: null });
  const reviewedAdmission = ({ baseOnly, resolutionOnly }) => (baseOnly || resolutionOnly ? 'uncounted' : 'normal');
  // #128: an extra round recorded for this PR whose prompt cannot be confirmed as the owner's grants nothing; the refusal says so (and, R2-F3, says the config dir must be a .claude* folder under the home when that may be the reason).
  const unconfirmedGrant = (st) => {
    try {
      if (config.owner_approval !== 'chat' || ghRepo?.host !== 'github.com') return '';
      const q = { repo: ghRepo.slug, pr, k: reviewedRoundCount(st) + 1, anyHead: true };
      if (ownerGrantGap(q) !== 'provenance') return '';
      const hint = ownerGrantConfigDirHint(q);
      return `; an extra round is recorded for this PR, but it cannot be confirmed as typed by the owner (it may have been typed while the agent was still working)${hint ? ` (${hint})` : ''}: run \`P triage round-request\` again, show its FRESH closing lines, and ask the owner to type "extra round" again after the reply ends`;
    } catch {
      return '';
    }
  };
  const checkCap = (st, flags, { already = false } = {}) => {
    const { admission, problem } = admit(st, flags);
    // resolutionIneligible: why the free (resolution-only) round was refused, when one was tried (it is computed before the cap).
    if (problem) {
      throw new Fail(EXIT.USAGE, {
        ok: false, error: 'round-cap',
        message: (already ? `the owner's extra round was already used (grant already used): ${problem}` : problem) + unconfirmedGrant(st),
        ...(resolutionIneligible === undefined ? {} : { resolutionIneligible }),
      });
    }
    return admission;
  };

  let state = readState();
  checkRound(state);

  const gh = createGitHub({ cwd: root, env: ctx.env });
  let view;
  let slug;
  try {
    view = gh.prView(pr, ['title', 'body', 'headRefName', 'baseRefName']);
    if (config.owner_approval === 'chat') ghRepo = gh.repo();
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
  const checkBase = (st) => {
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
  checkBase(state);

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

  // What Codex is shown (and what the fix commits are measured against) is exactly this range. Round 1 starts at the merge
  // base; a later round starts where the previous one ended, with the base branch's commits merged in since then taken out.
  // Only commits that came from the protected default branch are left out: the base side is origin/<default_branch> (never a
  // branch the PR author chose), and a PR that targets any other branch leaves nothing out. A failed or stale fetch only
  // leaves an older origin/<default_branch>, which can only make the range bigger.
  // The conflict case ('whole-pr' above): when the merge of the default branch conflicted and the resolution only chose lines the
  // two sides had, the range is the resolution alone and the round is free of the cap (resolutionReviewBase has every rule).
  const baseBranchRef = reviewBaseRef(root, config, prBase);
  const tryResolution = () => resolutionReviewBase({ from: base, forkPoint, head, baseRef: baseBranchRef }, o);
  let review = { base: forkPoint, kind: 'merge-base' };
  let resolution = null;
  let resolutionIneligible;
  if (state?.rounds.length > 0) {
    review = prBase === config.default_branch
      ? effectiveReviewBase({ from: base, forkPoint }, o)
      : { base, kind: 'previous' };
    if (review.kind === 'whole-pr') {
      const found = tryResolution();
      if (found.ineligible === undefined) {
        resolution = found;
        review = { base: found.base, kind: 'resolution' };
      } else {
        resolutionIneligible = found.ineligible;
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
  const preAdmission = checkCap(state, { baseOnly, resolutionOnly });
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
  const prompt = buildReviewPrompt({
    pr, title: view.title, body: view.body, base: review.base, head, risk: level, round, lightLane, priorRulings, rulesRef: forkPoint, largeBinaries, baseKind: review.kind,
    sensitivePaths: lane.sensitivePaths,
    ...(confirmItems.length > 0 ? { confirmFixed: confirmItems.map((i) => ({ id: i.id, title: i.title, file: i.file, detail: i.detail })) } : {}),
    ...(resolutionOnly ? { resolution: { from: base, forkPoint, ...resolutionView } } : {}),
  });

  const hashAtHead = currentContentHash(root, config);
  // The exact bytes Codex gets on stdin. Saved as round-<R>/prompt.md BEFORE Codex starts (so a timed-out or crashed round keeps it)
  // from this same buffer, and its sha256 goes into the round record: the hash is of what was sent, not of a re-serialisation.
  // A base-only round asks nothing, so it has neither.
  const promptBytes = Buffer.from(prompt, 'utf8');
  const promptSha256 = baseOnly ? undefined : createHash('sha256').update(promptBytes).digest('hex');

  const headMoved = () => new Fail(EXIT.USAGE, { ok: false, error: 'head-moved', message: 'HEAD moved while Codex was reviewing; run the round again' });
  // Runs Codex over the prepared prompt and returns its validated findings (every failure is an exit-3 Fail).
  const askCodex = async () => {
    // execCodex removes whatever is at the output path first (so it can never be read as this run's answer; the mtime check in
    // readCodexAnswer is the second line of defence, the tree kill on timeout the third).
    writeFileAtomic(path.join(dir, 'prompt.md'), promptBytes);
    const ran = await execCodex({ root, env: ctx.env, args, promptBytes, outPath });
    if (!ran.ok) throw unavailable(ran.reason, { code: ran.code, timedOut: ran.timedOut, detail: ran.detail });

    if (headSha(o) !== head) throw headMoved();

    let findings;
    try {
      findings = readCodexAnswer(outPath, ran.startedAt);
    } catch (err) {
      throw unavailable('malformed', { errors: [err.message] });
    }
    const checked = validateFindings(findings);
    if (!checked.ok) throw unavailable('malformed', { errors: checked.errors });

    return findings;
  };
  // A base-merge-only round has nothing to ask about: zero findings, and the round says why.
  const findings = baseOnly
    ? { summary: 'Only the base branch was merged in since the previous round; Codex was not run.', blocking: [], suggestions: [], worth_considering: [] }
    : await askCodex();

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
  const items = await withReviewLock(root, pr, ctx, async () => {
    // Codex took a while: whatever happened to the review meanwhile (another session recorded this round, the PR's
    // state was replaced) is read again, and what is there now wins.
    const fresh = readState();
    checkRound(fresh);
    // A grant that admitted the round before Codex ran but is gone now (another checkout claimed it meanwhile) says so.
    const admission = checkCap(fresh, { baseOnly, resolutionOnly }, { already: preAdmission === 'owner' });
    checkBase(fresh);
    if (headSha(o) !== head) throw headMoved();
    // The cap waiver rests on the proof above. from (checkBase), head and forkPoint are pinned, but origin/<default> may have moved
    // while Codex ran, and it is one of the proof's inputs: prove it again, and only accept the very range Codex was shown.
    if (resolutionOnly && tryResolution().base !== review.base) {
      throw new Fail(EXIT.USAGE, { ok: false, error: 'resolution-changed', message: 'the conflict resolution can no longer be proven while Codex was reviewing; run the round again' });
    }
    if (!fresh && slug === undefined) {
      throw new Fail(EXIT.USAGE, { ok: false, error: 'state-changed', message: '.review/state.json disappeared while Codex was reviewing; run the round again' });
    }
    // The owner's grant is read here and claimed just before the state is saved (below), after everything else that can fail has run.
    let ownerGrant;
    let claimGrant = () => {};
    if (admission === 'owner') {
      const k = reviewedRoundCount(fresh) + 1;
      const records = ownerGrantedRounds({ repo: ghRepo.slug, pr, k, head });
      const newest = records[0];
      if (newest !== undefined) ownerGrant = { grantId: grantIdOf(newest), k, quote: newest.prompt, ownerTs: newest.ts };
      // Every record that covers this head is consumed together (a duplicate "extra round" must not admit a second run after
      // discard-round); the first claimer on the machine wins. A failed claim discards Codex's answer.
      claimGrant = () => {
        const claim = claimGrantMarkers(records, { repo: ghRepo.slug, pr, k, head, checkout: root });
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
    const base0 = fresh ?? emptyState({ repo: slug, pr, branch: view.headRefName ?? 'HEAD', risk: level, lightLane, maxRounds: config.review.max_rounds });
    const ruled = linkDeferredFollowups(reuseRuled(assignIds(findings, round, excerptFor, { contentHash: hashAtHead }), ruledCacheFrom(allItems(base0))), allItems(base0));
    const reviewer = fable || fresh?.reviewer === 'fable' ? 'fable' : 'judge';
    const reasons = lane.reasons.length > 0 ? lane.reasons : ['reviewed by Fable in an earlier round'];
    const next = addRound({ ...base0, risk: level, lightLane: reviewer === 'fable' ? false : lightLane, reviewer, currentContentHash: hashAtHead }, {
      n: round, fromHead: base, toHead: head, contentHashAtToHead: hashAtHead, items: ruled,
      reviewBase: review.base, reviewBaseKind: review.kind, forkPoint, codexModel: model, ...(promptSha256 === undefined ? {} : { promptSha256 }), ...(baseOnly ? { baseOnly: true } : {}),
      ...(admission === 'uncounted' ? {} : { admission }), ...(ownerGrant === undefined ? {} : { ownerGrant }),
      ...(confirmItems.length > 0 ? { confirmFixed: confirmItems.map((i) => i.id) } : {}),
      ...(resolutionOnly ? { resolutionOnly: true, ...resolutionView } : {}),
      ...(reviewer === 'fable' && !baseOnly ? { fableRequired: true, fableReasons: reasons, sensitivePaths: lane.sensitivePaths.slice(0, 50) } : {}),
    });
    writeJson(path.join(dir, 'codex.json'), { findings, items: ruled });
    writeFileAtomic(path.join(dir, 'codex.md'), renderFindingsMarkdown(findings, round, ruled));
    claimGrant();
    saveState(root, next);
    state = next;
    grantUsed = ownerGrant === undefined ? undefined : { grantId: ownerGrant.grantId };
    return ruled;
  });

  return {
    exitCode: EXIT.OK,
    output: {
      ok: true,
      round,
      counts: {
        blocking: findings.blocking.length,
        suggestions: findings.suggestions.length,
        worth_considering: findings.worth_considering.length,
      },
      ...(baseOnly ? { baseOnly: true } : {}),
      ...(resolutionOnly ? { resolutionOnly: true, conflicted: resolutionView.conflicted, conflictedCount: resolution.conflictedCount } : {}),
      ...(resolutionIneligible === undefined ? {} : { resolutionIneligible }),
      ...(grantUsed === undefined ? {} : { grantUsed }),
      preRuled: items.filter((i) => i.final).length,
      lightLane: state.lightLane,
      reviewer: state.reviewer,
      reviewerReasons: state.rounds.at(-1)?.fableReasons ?? [],
      path: dir,
    },
  };
});
