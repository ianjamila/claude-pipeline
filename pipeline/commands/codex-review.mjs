// One round of the cross-model review: runs the Codex CLI over `base..head`, validates what it wrote, gives every
// finding an id and appends the round to .review/state.json. The merge gate must never read "Codex failed" as
// "Codex found nothing", so every way this can go wrong (non-zero exit, timeout, no binary, no output file, a stale
// file, output that is not the schema) is exit 3 with `unavailable:true` and a reason; only a validated findings file
// (even an empty one) becomes a round.
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { EXIT, UsageError, intOption, parseCommandArgs, requireOption } from '../lib/cli.mjs';
import {
  FINDINGS_SCHEMA_PATH, assignIds, buildCodexArgs, buildReviewPrompt, classifyCodexFailure, renderFindingsMarkdown,
  validateFindings,
} from '../lib/codex.mjs';
import { Fail, guarded, requireConfig, resolveRepo } from '../lib/cmd-common.mjs';
import { git, GitError, diffFiles, headSha, revParse, showFile } from '../lib/git.mjs';
import { collectHardStops } from '../lib/hardstops.mjs';
import { createGitHub } from '../lib/github.mjs';
import { GhError, codexCommand, run as runProcess } from '../lib/proc.mjs';
import { assessRisk, isLightLane } from '../lib/risk.mjs';
import { addRound, emptyState, loadState, saveState } from '../lib/state.mjs';
import { reuseRuled, ruledCacheFrom } from '../lib/triage.mjs';
import {
  allItems, currentContentHash, ensureRoundDir, excerptWindow, roundDir, writeFileAtomic, writeJson,
} from '../lib/review-context.mjs';

export const meta = {
  summary: 'run one Codex review round over base..head and record its findings',
  usage: [
    'pipeline codex-review --pr N --round R --base SHA --head SHA --effort low|medium|high|xhigh [--model M] [--repo DIR]',
    '  -> {ok, round, counts:{blocking, suggestions, worth_considering}, preRuled, lightLane, path}',
    '  exit 3 {ok:false, unavailable:true, reason: quota|auth|unavailable|error|malformed|github} when Codex or GitHub could not deliver',
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

  let state = loadState(root);
  if (state && state.pr !== pr) {
    throw new Fail(EXIT.USAGE, {
      ok: false, error: 'state-pr-mismatch', message: `.review/state.json belongs to PR #${state.pr}, not #${pr}`,
    });
  }
  const expected = (state?.rounds.length ?? 0) + 1;
  if (round !== expected) {
    const exists = state?.rounds.some((r) => r.n === round);
    throw new Fail(EXIT.USAGE, {
      ok: false, error: 'round-order',
      message: exists ? `round ${round} already exists in the review state` : `next round is ${expected}, not ${round}`,
    });
  }

  ensureRoundDir(root, round);
  const gh = createGitHub({ cwd: root, env: ctx.env });
  let view;
  let slug;
  try {
    view = gh.prView(pr, ['title', 'body', 'headRefName']);
    if (!state) slug = gh.repo().slug;
  } catch (err) {
    if (err instanceof GhError) throw unavailable('github', { error: 'unavailable', message: err.message });
    throw err;
  }

  if (!state) {
    const files = diffFiles(base, head, o);
    const hits = await collectHardStops({ base, head, cwd: root, config });
    const { level, changedLines } = assessRisk({ files, hits, config });
    state = emptyState({
      repo: slug, pr, branch: view.headRefName ?? 'HEAD', risk: level,
      lightLane: isLightLane({ level, changedLines, hits, config }), maxRounds: config.review.max_rounds,
    });
  }

  // What Codex is shown (and what the fix commits are measured against) is exactly this range.
  writeFileAtomic(path.join(dir, 'diff.patch'), git(['diff', '--binary', '--no-color', '--no-ext-diff', `${base}..${head}`], o));

  const priorItems = allItems(state);
  const cache = ruledCacheFrom(priorItems);
  const latestByFingerprint = new Map();
  for (const item of priorItems) if (Object.hasOwn(cache, item.fingerprint ?? '')) latestByFingerprint.set(item.fingerprint, item);
  const priorRulings = [...latestByFingerprint].map(([fp, item]) => ({
    id: item.id, title: item.title, ruling: `${cache[fp].decision ?? 'unknown'}: ${cache[fp].reason ?? ''}`,
  }));
  const prompt = buildReviewPrompt({
    pr, title: view.title, body: view.body, base, head, risk: state.risk, round, lightLane: state.lightLane, priorRulings,
  });

  const hashAtHead = currentContentHash(root, config);

  // Whatever is at the output path now was not written by this run; remove it so it can never be read as this
  // run's answer. (The mtime check below is the second line of defence.)
  rmSync(outPath, { force: true });
  const startedAt = Date.now();
  const { cmd, prefixArgs } = codexCommand(ctx.env);
  const r = runProcess(cmd, [...prefixArgs, ...args], { cwd: root, env: ctx.env, input: prompt, timeoutMs: CODEX_TIMEOUT_MS });
  // proc.run reports a spawn failure as stderr "spawnSync <cmd> ENOENT"; classify it as the missing binary it is.
  const spawnError = /^spawnSync .*\bENOENT\b/.test(r.stderr) ? { code: 'ENOENT', message: r.stderr } : undefined;
  if (r.code !== 0 || r.timedOut) {
    const reason = classifyCodexFailure({ code: r.code, stderr: r.stderr, stdout: r.stdout, timedOut: r.timedOut, spawnError });
    throw unavailable(reason, { code: r.code, timedOut: r.timedOut, detail: tail(r.stderr || r.stdout) });
  }

  if (headSha(o) !== head) {
    throw new Fail(EXIT.USAGE, { ok: false, error: 'head-moved', message: 'HEAD moved while Codex was reviewing; run the round again' });
  }

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
  const items = reuseRuled(assignIds(findings, round, excerptFor), cache);

  state = addRound({ ...state, currentContentHash: hashAtHead }, {
    n: round, fromHead: base, toHead: head, contentHashAtToHead: hashAtHead, items,
  });
  writeJson(path.join(dir, 'codex.json'), { findings, items });
  writeFileAtomic(path.join(dir, 'codex.md'), renderFindingsMarkdown(findings, round, items));
  saveState(root, state);

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
