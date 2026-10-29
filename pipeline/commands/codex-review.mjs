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
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { EXIT, UsageError, intOption, parseCommandArgs, requireOption } from '../lib/cli.mjs';
import {
  FINDINGS_SCHEMA_PATH, assignIds, buildCodexArgs, buildReviewPrompt, classifyCodexFailure, largeBinaryNote, renderFindingsMarkdown,
  validateFindings,
} from '../lib/codex.mjs';
import { Fail, guarded, requireConfig, resolveRepo } from '../lib/cmd-common.mjs';
import {
  GitError, NETWORK_TIMEOUT_MS, diffFiles, effectiveReviewBase, git, headSha, mergeBase, resolutionReviewBase, reviewPatch, revParse, showFile,
} from '../lib/git.mjs';
import { collectHardStops } from '../lib/hardstops.mjs';
import { createGitHub } from '../lib/github.mjs';
import { GhError, codexCommand, runAsync } from '../lib/proc.mjs';
import { assessRisk, isLightLane, reviewLane } from '../lib/risk.mjs';
import { addRound, emptyState, loadState, saveState } from '../lib/state.mjs';
import { reuseRuled, roundCapProblem, ruledCacheFrom } from '../lib/triage.mjs';
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
    '  exit 2 {error:empty-range} when earlier rounds accepted items and the branch content is unchanged since the last round (base == head)',
    '  exit 2 {error:round-cap} past review.max_rounds, except ONE extra round when the last round only accepted fixes (state outcome extraRound);',
    '    base-only rounds and resolution-only rounds (below) never count toward the cap',
    '  reviewer: fable (medium/high risk or a sensitive path: risk.high_risk_paths, review.arbiter_always_paths) records the round as fableRequired',
    '    (the Fable pass must run: arbiter needed/apply) and gives Codex an attacker\'s brief for the sensitive files; judge otherwise. Once fable, always fable',
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

export const CODEX_TIMEOUT_MS = 30 * 60 * 1000;
// A file system may round mtimes down (1-2 s on some); the file was unlinked before the run, so this only has to
// tell "written during this run" from "left over from long ago".
const MTIME_SLACK_MS = 2000;
const DETAIL_CHARS = 1000;

const tail = (s) => {
  const text = String(s ?? '').trim();
  return text.length > DETAIL_CHARS ? text.slice(-DETAIL_CHARS) : text;
};

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
  const checkCap = (st, flags) => {
    const capped = st ? roundCapProblem(st, round, flags) : null;
    if (capped) throw new Fail(EXIT.USAGE, { ok: false, error: 'round-cap', message: capped });
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
  checkCap(state, { baseOnly, resolutionOnly });
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
  const prompt = buildReviewPrompt({
    pr, title: view.title, body: view.body, base: review.base, head, risk: level, round, lightLane, priorRulings, rulesRef: forkPoint, largeBinaries, baseKind: review.kind,
    sensitivePaths: lane.sensitivePaths,
    ...(resolutionOnly ? { resolution: { from: base, forkPoint, conflicted: resolution.conflicted.slice(0, 50), conflictedCount: resolution.conflictedCount, blocks: resolution.blocks.slice(0, 50) } } : {}),
  });

  const hashAtHead = currentContentHash(root, config);

  const headMoved = () => new Fail(EXIT.USAGE, { ok: false, error: 'head-moved', message: 'HEAD moved while Codex was reviewing; run the round again' });
  // Runs Codex over the prepared prompt and returns its validated findings (every failure is an exit-3 Fail).
  const askCodex = async () => {
    // Whatever is at the output path now was not written by this run; remove it so it can never be read as this
    // run's answer. (The mtime check below is the second line of defence, the tree kill on timeout the third.)
    rmSync(outPath, { force: true });
    const startedAt = Date.now();
    const { cmd, prefixArgs } = codexCommand(ctx.env);
    const timeoutMs = Number(ctx.env?.PIPELINE_CODEX_TIMEOUT_MS) || CODEX_TIMEOUT_MS;
    // On a timeout the whole process tree is killed, so a helper Codex started cannot write its answer afterwards.
    const r = await runAsync(cmd, [...prefixArgs, ...args], { cwd: root, env: ctx.env, input: prompt, timeoutMs });
    // A spawn failure is reported as stderr "spawn <cmd> ENOENT"; classify it as the missing binary it is.
    const spawnError = /^spawn(?:Sync)? .*\bENOENT\b/.test(r.stderr) ? { code: 'ENOENT', message: r.stderr } : undefined;
    if (r.code !== 0 || r.timedOut) {
      rmSync(outPath, { force: true });
      const reason = classifyCodexFailure({ code: r.code, stderr: r.stderr, stdout: r.stdout, timedOut: r.timedOut, spawnError });
      throw unavailable(reason, { code: r.code, timedOut: r.timedOut, detail: tail(r.stderr || r.stdout) });
    }

    if (headSha(o) !== head) throw headMoved();

    let findings;
    try {
      if (!existsSync(outPath)) throw new Error('codex exited 0 but wrote no output file');
      if (statSync(outPath).mtimeMs < startedAt - MTIME_SLACK_MS) throw new Error('codex output file predates this run');
      findings = JSON.parse(readFileSync(outPath, 'utf8'));
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
  const items = await withReviewLock(root, pr, ctx, async () => {
    // Codex took a while: whatever happened to the review meanwhile (another session recorded this round, the PR's
    // state was replaced) is read again, and what is there now wins.
    const fresh = readState();
    checkRound(fresh);
    checkCap(fresh, { baseOnly, resolutionOnly });
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
    const base0 = fresh ?? emptyState({ repo: slug, pr, branch: view.headRefName ?? 'HEAD', risk: level, lightLane, maxRounds: config.review.max_rounds });
    const ruled = reuseRuled(assignIds(findings, round, excerptFor, { contentHash: hashAtHead }), ruledCacheFrom(allItems(base0)));
    const reviewer = fable || fresh?.reviewer === 'fable' ? 'fable' : 'judge';
    const reasons = lane.reasons.length > 0 ? lane.reasons : ['reviewed by Fable in an earlier round'];
    const next = addRound({ ...base0, risk: level, lightLane: reviewer === 'fable' ? false : lightLane, reviewer, currentContentHash: hashAtHead }, {
      n: round, fromHead: base, toHead: head, contentHashAtToHead: hashAtHead, items: ruled,
      reviewBase: review.base, reviewBaseKind: review.kind, forkPoint, codexModel: model, ...(baseOnly ? { baseOnly: true } : {}),
      ...(resolutionOnly ? { resolutionOnly: true, conflicted: resolution.conflicted.slice(0, 50), conflictedCount: resolution.conflictedCount, blocks: resolution.blocks.slice(0, 50) } : {}),
      ...(reviewer === 'fable' && !baseOnly ? { fableRequired: true, fableReasons: reasons, sensitivePaths: lane.sensitivePaths.slice(0, 50) } : {}),
    });
    writeJson(path.join(dir, 'codex.json'), { findings, items: ruled });
    writeFileAtomic(path.join(dir, 'codex.md'), renderFindingsMarkdown(findings, round, ruled));
    saveState(root, next);
    state = next;
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
      ...(resolutionOnly ? { resolutionOnly: true, conflicted: resolution.conflicted.slice(0, 50), conflictedCount: resolution.conflictedCount } : {}),
      ...(resolutionIneligible === undefined ? {} : { resolutionIneligible }),
      preRuled: items.filter((i) => i.final).length,
      lightLane: state.lightLane,
      reviewer: state.reviewer,
      reviewerReasons: state.rounds.at(-1)?.fableReasons ?? [],
      path: dir,
    },
  };
});
