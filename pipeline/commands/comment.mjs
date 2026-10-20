// `pipeline comment`: renders one of the pipeline's PR comments (render.mjs) and upserts it, so a PR
// carries ONE comment per kind that is edited in place rather than a new one per round.
import { existsSync, readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { resolve, join } from 'node:path';
import { EXIT, UsageError, parseCommandArgs, intOption, requireOption } from '../lib/cli.mjs';
import { loadConfig, DEFAULTS } from '../lib/config.mjs';
import { loadState } from '../lib/state.mjs';
import { MARKERS, triageComment, summarySections, needsHumanComment, blockedComment, awaitingReviewComment } from '../lib/render.mjs';
import { recordForOutcome } from '../lib/run-record.mjs';
import { readSummaryComment, writeSummaryComment } from '../lib/summary-comment.mjs';
import { createGitHub, commandCwd, guardGh, requireRepoRoot } from '../lib/github.mjs';
import { readModelProofs } from '../lib/review-context.mjs';

export const meta = {
  summary: 'render and upsert a pipeline PR comment (triage, summary, needs-human, blocked, awaiting-review)',
  usage: 'pipeline comment --pr N --kind triage|summary|needs-human|blocked|awaiting-review [--outcome O] [--built TEXT] [--reason TEXT] [--hits-file F] [--repo DIR]',
};

const MARKER_OF = {
  triage: MARKERS.triage,
  summary: MARKERS.summary,
  'needs-human': MARKERS.needsHuman,
  blocked: MARKERS.blocked,
  'awaiting-review': MARKERS.awaitingReview,
};

function readJson(file, what) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new UsageError(`cannot read ${what} ${file}: ${err.message}`);
  }
}

function stateOrNull(root) {
  try {
    return loadState(root);
  } catch (err) {
    throw new UsageError(err.message);
  }
}

function requireState(root, kind) {
  const state = stateOrNull(root);
  if (!state) throw new UsageError(`no review state at ${join(root, '.review', 'state.json')}: the ${kind} comment is rendered from it`);
  return state;
}

// `.verify/report.json`, wherever the project's config says it lives (default location if the config is unusable).
async function reportPath(root) {
  const cfg = await loadConfig(root);
  return resolve(root, cfg.ok ? cfg.config.verify.report : DEFAULTS.verify.report);
}

// owner_approval from the repo's config; an unreadable config is label behaviour, as before.
async function ownerApprovalOf(root) {
  try {
    const cfg = await loadConfig(root);
    if (cfg.ok) return cfg.config.owner_approval;
  } catch { /* label behaviour */ }
  return 'label';
}

// The summary comment also carries the run record: write the sections through the one writer, which keeps an existing
// record (and sets how the run ended on it).
function summaryKind(gh, pr, sections, outcome, ownerApproval) {
  const view = gh.prView(pr, ['headRefName', 'baseRefName', 'headRefOid']);
  const existing = readSummaryComment(gh, pr);
  if (existing.status === 'unsupported') throw new UsageError('the summary comment carries a run record from a newer pipeline version: update the pipeline CLI first');
  const { record, warnings } = recordForOutcome(existing.status === 'ok' ? existing.record : null, {
    repo: gh.repo().slug, pr, branch: view.headRefName, baseRef: view.baseRefName, head: view.headRefOid,
    outcome, host: hostname(), now: Date.now(), ownerApproval,
  });
  const r = writeSummaryComment(gh, pr, { record, sections, existing });
  return { exitCode: EXIT.OK, output: { ok: true, kind: 'summary', pr, action: r.action, url: r.url, id: r.id, step: record.step, warnings } };
}

export async function run(argv, ctx) {
  const { values } = parseCommandArgs(argv, {
    pr: { type: 'string' },
    kind: { type: 'string' },
    outcome: { type: 'string' },
    built: { type: 'string' },
    reason: { type: 'string' },
    'hits-file': { type: 'string' },
    repo: { type: 'string' },
  }, { allowPositionals: false });
  const pr = intOption(values, 'pr', { required: true, min: 1 });
  const kind = requireOption(values, 'kind');
  if (!Object.hasOwn(MARKER_OF, kind)) throw new UsageError(`--kind must be one of ${Object.keys(MARKER_OF).join('|')}`);
  const cwd = commandCwd(values, ctx);
  const root = requireRepoRoot(cwd);

  let body;
  if (kind === 'triage') {
    body = triageComment(requireState(root, kind));
  } else if (kind === 'summary') {
    const outcome = requireOption(values, 'outcome');
    const state = requireState(root, kind);
    body = summarySections(state, { outcome, built: values.built, modelProofs: readModelProofs(root, state) });
  } else if (kind === 'blocked') {
    const file = await reportPath(root);
    if (!existsSync(file)) throw new UsageError(`no verify report at ${file}: the blocked comment is rendered from it`);
    body = blockedComment(readJson(file, 'verify report'));
  } else if (kind === 'needs-human') {
    const reason = requireOption(values, 'reason');
    const hitsFile = values['hits-file'];
    const parsed = hitsFile ? readJson(resolve(cwd, hitsFile), 'hits file') : [];
    // A `P hardstops` object lists blocking hits separately: the needs-human note is about those, not report-only ones.
    const listed = Array.isArray(parsed) ? parsed : (parsed?.blocking ?? parsed?.hits);
    if (!Array.isArray(listed)) throw new UsageError('--hits-file must hold a JSON array (or an object with a "hits" array)');
    // Whatever the format, an advisory (report-only) hit never makes a PR need a human: drop it before the note is built.
    const hits = listed.filter((h) => h?.advisory !== true);
    const state = stateOrNull(root);
    const reportFile = await reportPath(root);
    const report = existsSync(reportFile) ? readJson(reportFile, 'verify report') : null;
    body = needsHumanComment({
      reasons: [reason],
      hits,
      verified: typeof report?.ok === 'boolean' ? report.ok : null,
      reviewed: state ? state.rounds?.length > 0 : null,
    });
  } else {
    body = awaitingReviewComment(values.reason ?? '');
  }

  const ownerApproval = kind === 'summary' ? await ownerApprovalOf(root) : 'label';
  const gh = createGitHub({ cwd, env: ctx.env });
  return guardGh(() => {
    if (kind === 'summary') return summaryKind(gh, pr, body, values.outcome, ownerApproval);
    const r = gh.upsertComment(pr, MARKER_OF[kind], body);
    return { exitCode: EXIT.OK, output: { ok: true, kind, pr, action: r.action, url: r.url, id: r.id } };
  });
}
