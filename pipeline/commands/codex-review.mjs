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
// such a merge is recorded as `baseOnly` without running Codex. The state is
// read-modified-written under the per-PR lock, but the lock is NOT held while Codex runs (up to 30 minutes): the
// state is read again under the lock once Codex has answered, and a round recorded in the meantime wins.
import path from 'node:path';
import { EXIT, UsageError, intOption, parseCommandArgs, requireOption } from '../lib/cli.mjs';
import {
  FINDINGS_SCHEMA_PATH, assignIds, buildCodexArgs, buildReviewPrompt, largeBinaryNote, renderFindingsMarkdown,
} from '../lib/codex.mjs';
import { CODEX_TIMEOUT_MS, askCodex } from '../lib/codex-run.mjs';
import { Fail, guarded, requireConfig, resolveRepo } from '../lib/cmd-common.mjs';
import {
  GitError, NETWORK_TIMEOUT_MS, diffFiles, effectiveReviewBase, git, headSha, mergeBase, reviewPatch, revParse, showFile,
} from '../lib/git.mjs';
import { collectHardStops } from '../lib/hardstops.mjs';
import { createGitHub } from '../lib/github.mjs';
import { GhError } from '../lib/proc.mjs';
import { assessRisk, assessSecurity, isLightLane } from '../lib/risk.mjs';
import { obligationDigest, promptHeader, requiredObligations } from '../lib/obligations.mjs';
import { addRound, emptyState, loadState, saveState } from '../lib/state.mjs';
import { reuseRuled, ruledCacheFrom } from '../lib/triage.mjs';
import {
  allItems, currentContentHash, ensureRoundDir, excerptWindow, reviewBaseRef, roundDir, withReviewLock, writeFileAtomic,
  writeJson,
} from '../lib/review-context.mjs';

export const meta = {
  summary: 'run one Codex review round over base..head and record its findings',
  usage: [
    'pipeline codex-review --pr N --round R --base SHA --head SHA --effort low|medium|high|xhigh [--model M] [--repo DIR]',
    '  -> {ok, round, counts:{blocking, suggestions, worth_considering}, preRuled, lightLane, path, obligations:[{source, promptHeader}]}',
    '  obligations: reviewers this round owes (security on a security-relevant PR, the optional Fable final pass), derived here; dispatch each with its promptHeader pasted verbatim, then `pipeline review add`',
    '  --base must be the PR\'s merge base for round 1 and the previous round\'s toHead after that, else exit 2 {error:base-mismatch}',
    '  exit 2 {error:empty-range} when earlier rounds accepted items and the branch content is unchanged since the last round (base == head)',
    '  commits merged in from the PR\'s base branch since the previous round are left out of the reviewed diff; a round that only merged them in',
    '    is recorded without running Codex: {ok:true, baseOnly:true, counts all 0}',
    '  exit 3 {ok:false, unavailable:true, reason: quota|auth|unavailable|error|malformed|github} when Codex or GitHub could not deliver',
    '  env: PIPELINE_CODEX_TIMEOUT_MS overrides the 30 minute Codex timeout (tests)',
  ].join('\n'),
};

export { CODEX_TIMEOUT_MS };

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
  // Is this the next round of this PR's review? Run before Codex and again under the lock afterwards.
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

  let state = readState();
  checkRound(state);

  const gh = createGitHub({ cwd: root, env: ctx.env });
  let view;
  let slug;
  try {
    view = gh.prView(pr, ['title', 'body', 'headRefName', 'baseRefName']);
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

  // A later round exists to review the fixes for what earlier rounds accepted. An empty range (or no change in the
  // branch content since the last round) reviews nothing, and would let an unfixed accepted item look resolved.
  const hasAccepted = allItems(state ?? { rounds: [] }).some((i) => i.final?.decision === 'ACCEPT');
  if (state && hasAccepted && (base === head || currentContentHash(root, config) === state.rounds.at(-1)?.contentHashAtToHead)) {
    throw new Fail(EXIT.USAGE, {
      ok: false, error: 'empty-range',
      message: `round ${round} would review nothing: the branch content has not changed since round ${state.rounds.at(-1).n}, and earlier rounds accepted items that need a fix`,
    });
  }

  // Risk and light lane describe the whole PR (merge base..head), whatever slice this round reviews. A later round can
  // only take a PR off the light lane, never put it on.
  const files = diffFiles(forkPoint, head, o);
  const hits = await collectHardStops({ base: forkPoint, head, cwd: root, config });
  const { level, changedLines } = assessRisk({ files, hits, config });
  const lightLane = (state ? state.lightLane === true : true) && isLightLane({ level, changedLines, hits, config });

  ensureRoundDir(root, round);
  // What Codex is shown (and what the fix commits are measured against) is exactly this range. Round 1 starts at the merge
  // base; a later round starts where the previous one ended, with the base branch's commits merged in since then taken out.
  // Only commits that came from the protected default branch are left out: the base side is origin/<default_branch> (never a
  // branch the PR author chose), and a PR that targets any other branch leaves nothing out. A failed or stale fetch only
  // leaves an older origin/<default_branch>, which can only make the range bigger.
  let review = { base: forkPoint, kind: 'merge-base' };
  if (state?.rounds.length > 0) {
    review = prBase === config.default_branch
      ? effectiveReviewBase({ from: base, forkPoint }, o)
      : { base, kind: 'previous' };
  }
  // Security trigger: for the whole PR (round 1) or, later, for this round's own range (previous toHead..head) only, so a docs-only
  // fix round does not owe a second security review. (A synthetic review base is a tree, which diffFiles cannot take.) Git work
  // stays outside the lock.
  const sec = assessSecurity({ files, hits, config });
  const rangeFiles = round > 1 ? diffFiles(base, head, o) : files;
  const changedInRange = new Set(rangeFiles.flatMap((f) => [f.oldPath, f.newPath, f.path]).filter(Boolean));
  const secInRange = round > 1 && assessSecurity({ files: rangeFiles, hits: hits.filter((h) => changedInRange.has(h.file)), config }).security;
  // Large binary documents would overflow the buffer; they are named at the end of the patch and in the prompt instead.
  const { patch, skipped: largeBinaries } = reviewPatch(review.base, head, o);
  // Only the base branch was merged in since the last round: there is nothing of the PR's own to review.
  const baseOnly = review.kind === 'synthetic' && patch === '' && largeBinaries.length === 0;
  const note = largeBinaryNote(largeBinaries);
  writeFileAtomic(path.join(dir, 'diff.patch'), note.length === 0 ? patch : `${patch}\nLarge binary files (content not shown):\n${note.join('\n')}\n`);

  const priorItems = allItems(state ?? { rounds: [] });
  const cache = ruledCacheFrom(priorItems);
  const latestByFingerprint = new Map();
  for (const item of priorItems) if (Object.hasOwn(cache, item.fingerprint ?? '')) latestByFingerprint.set(item.fingerprint, item);
  const priorRulings = [...latestByFingerprint].map(([fp, item]) => ({
    id: item.id, title: item.title, ruling: `${cache[fp].decision ?? 'unknown'}: ${cache[fp].reason ?? ''}`,
  }));
  const prompt = buildReviewPrompt({
    pr, title: view.title, body: view.body, base: review.base, head, risk: level, round, lightLane, priorRulings, rulesRef: forkPoint, largeBinaries, baseKind: review.kind,
  });

  const hashAtHead = currentContentHash(root, config);

  const headMoved = () => new Fail(EXIT.USAGE, { ok: false, error: 'head-moved', message: 'HEAD moved while Codex was reviewing; run the round again' });
  // Runs Codex over the prepared prompt and returns its validated findings (every failure is an exit-3 Fail).
  const askRound = async () => {
    const r = await askCodex({ root, args, prompt, outPath, env: ctx.env, afterRun: () => { if (headSha(o) !== head) throw headMoved(); } });
    if (!r.ok) {
      throw unavailable(r.reason, r.reason === 'malformed' ? { errors: r.errors } : { code: r.code, timedOut: r.timedOut, detail: r.detail });
    }
    return r.findings;
  };
  // A base-merge-only round has nothing to ask about: zero findings, and the round says why.
  const findings = baseOnly
    ? { summary: 'Only the base branch was merged in since the previous round; Codex was not run.', blocking: [], suggestions: [], worth_considering: [] }
    : await askRound();

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
  let obligations = [];
  const items = await withReviewLock(root, pr, ctx, async () => {
    // Codex took a while: whatever happened to the review meanwhile (another session recorded this round, the PR's
    // state was replaced) is read again, and what is there now wins.
    const fresh = readState();
    checkRound(fresh);
    checkBase(fresh);
    if (headSha(o) !== head) throw headMoved();
    if (!fresh && slug === undefined) {
      throw new Fail(EXIT.USAGE, { ok: false, error: 'state-changed', message: '.review/state.json disappeared while Codex was reviewing; run the round again' });
    }
    const base0 = fresh ?? emptyState({ repo: slug, pr, branch: view.headRefName ?? 'HEAD', risk: level, lightLane, maxRounds: config.review.max_rounds });
    const ruled = reuseRuled(assignIds(findings, round, excerptFor, { contentHash: hashAtHead }), ruledCacheFrom(allItems(base0)));
    // Reviewer obligations: derived from this round's own inputs. `repo` is the state's (slug is only read when no state existed).
    const owed = requiredObligations({
      round, security: sec.security, securityInRange: secInRange, level, finalPass: config.review.final_pass,
      blockingCount: findings.blocking.length, priorRounds: base0.rounds,
    }).map((source) => ({ source, status: 'pending', digest: obligationDigest({ repo: base0.repo, pr, source, base: review.base, head }) }));
    const next = addRound({ ...base0, risk: level, lightLane, currentContentHash: hashAtHead }, {
      n: round, fromHead: base, toHead: head, contentHashAtToHead: hashAtHead, items: ruled, obligations: owed,
      reviewBase: review.base, reviewBaseKind: review.kind, ...(baseOnly ? { baseOnly: true } : {}),
    });
    writeJson(path.join(dir, 'codex.json'), { findings, items: ruled });
    writeFileAtomic(path.join(dir, 'codex.md'), renderFindingsMarkdown(findings, round, ruled));
    saveState(root, next);
    state = next;
    obligations = owed;
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
      preRuled: items.filter((i) => i.final).length,
      lightLane: state.lightLane,
      path: dir,
      obligations: obligations.map((ob) => ({ source: ob.source, promptHeader: promptHeader(round, ob.digest) })),
    },
  };
});
