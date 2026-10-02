// One round of the cross-model review: runs the Codex CLI over `base..head`, validates what it wrote, gives every
// finding an id and appends the round to .review/state.json. The merge gate must never read "Codex failed" as
// "Codex found nothing", so every way this can go wrong (non-zero exit, timeout, no binary, no output file, a stale
// file, output that is not the schema) is exit 3 with `unavailable:true` and a reason; only a validated findings file
// (even an empty one) becomes a round.
//
// The range is not the caller's to choose. Round 1 must start at the merge base of the PR (so the review covers the
// whole PR and risk / light lane are measured on all of it); every later round must start where the previous one
// ended (so nothing between two rounds goes unreviewed). Anything else is exit 2 before Codex runs. The state is
// read-modified-written under the per-PR lock, but the lock is NOT held while Codex runs (up to 30 minutes): the
// state is read again under the lock once Codex has answered, and a round recorded in the meantime wins.
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { EXIT, UsageError, intOption, parseCommandArgs, requireOption } from '../lib/cli.mjs';
import {
  FINDINGS_SCHEMA_PATH, assignIds, buildCodexArgs, buildReviewPrompt, classifyCodexFailure, renderFindingsMarkdown,
  validateFindings,
} from '../lib/codex.mjs';
import { Fail, guarded, requireConfig, resolveRepo } from '../lib/cmd-common.mjs';
import { git, GitError, diffFiles, headSha, mergeBase, revParse, showFile } from '../lib/git.mjs';
import { collectHardStops } from '../lib/hardstops.mjs';
import { createGitHub } from '../lib/github.mjs';
import { GhError, codexCommand, runAsync } from '../lib/proc.mjs';
import { assessRisk, isLightLane } from '../lib/risk.mjs';
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
    '  -> {ok, round, counts:{blocking, suggestions, worth_considering}, preRuled, lightLane, path}',
    '  --base must be the PR\'s merge base for round 1 and the previous round\'s toHead after that, else exit 2 {error:base-mismatch}',
    '  exit 2 {error:empty-range} when earlier rounds accepted items and the branch content is unchanged since the last round (base == head)',
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
  // What Codex is shown (and what the fix commits are measured against) is exactly this range.
  writeFileAtomic(path.join(dir, 'diff.patch'), git(['diff', '--binary', '--no-color', '--no-ext-diff', `${base}..${head}`], o));

  const priorItems = allItems(state ?? { rounds: [] });
  const cache = ruledCacheFrom(priorItems);
  const latestByFingerprint = new Map();
  for (const item of priorItems) if (Object.hasOwn(cache, item.fingerprint ?? '')) latestByFingerprint.set(item.fingerprint, item);
  const priorRulings = [...latestByFingerprint].map(([fp, item]) => ({
    id: item.id, title: item.title, ruling: `${cache[fp].decision ?? 'unknown'}: ${cache[fp].reason ?? ''}`,
  }));
  const prompt = buildReviewPrompt({
    pr, title: view.title, body: view.body, base, head, risk: level, round, lightLane, priorRulings, rulesRef: forkPoint,
  });

  const hashAtHead = currentContentHash(root, config);

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

  const headMoved = () => new Fail(EXIT.USAGE, { ok: false, error: 'head-moved', message: 'HEAD moved while Codex was reviewing; run the round again' });
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
    checkBase(fresh);
    if (headSha(o) !== head) throw headMoved();
    if (!fresh && slug === undefined) {
      throw new Fail(EXIT.USAGE, { ok: false, error: 'state-changed', message: '.review/state.json disappeared while Codex was reviewing; run the round again' });
    }
    const base0 = fresh ?? emptyState({ repo: slug, pr, branch: view.headRefName ?? 'HEAD', risk: level, lightLane, maxRounds: config.review.max_rounds });
    const ruled = reuseRuled(assignIds(findings, round, excerptFor, { contentHash: hashAtHead }), ruledCacheFrom(allItems(base0)));
    const next = addRound({ ...base0, risk: level, lightLane, currentContentHash: hashAtHead }, {
      n: round, fromHead: base, toHead: head, contentHashAtToHead: hashAtHead, items: ruled,
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
      preRuled: items.filter((i) => i.final).length,
      lightLane: state.lightLane,
      path: dir,
    },
  };
});
