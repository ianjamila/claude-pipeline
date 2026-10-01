// `pipeline comment`: renders one of the pipeline's PR comments (render.mjs) and upserts it, so a PR
// carries ONE comment per kind that is edited in place rather than a new one per round.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { EXIT, UsageError, parseCommandArgs, intOption, requireOption } from '../lib/cli.mjs';
import { loadConfig, DEFAULTS } from '../lib/config.mjs';
import { loadState } from '../lib/state.mjs';
import { MARKERS, triageComment, summaryComment, needsHumanComment, blockedComment, awaitingReviewComment } from '../lib/render.mjs';
import { createGitHub, commandCwd, guardGh, requireRepoRoot } from '../lib/github.mjs';

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

// One entry per round whose Fable model proof passed; rounds without (or with a failed) proof add nothing.
function readModelProofs(root) {
  const dir = join(root, '.review');
  if (!existsSync(dir)) return [];
  const proofs = [];
  for (const name of readdirSync(dir).filter((n) => /^round-\d+$/.test(n)).sort()) {
    try {
      const p = JSON.parse(readFileSync(join(dir, name, 'model-proof.json'), 'utf8'));
      if (p?.ok !== true) continue;
      const efforts = p.efforts && typeof p.efforts === 'object' ? Object.keys(p.efforts).join(', ') : '';
      proofs.push({ transcript: p.transcript, models: p.models, ...(efforts ? { effort: efforts } : {}) });
    } catch { /* no proof for this round */ }
  }
  return proofs;
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
    body = summaryComment(requireState(root, kind), { outcome, built: values.built, modelProofs: readModelProofs(root) });
  } else if (kind === 'blocked') {
    const file = await reportPath(root);
    if (!existsSync(file)) throw new UsageError(`no verify report at ${file}: the blocked comment is rendered from it`);
    body = blockedComment(readJson(file, 'verify report'));
  } else if (kind === 'needs-human') {
    const reason = requireOption(values, 'reason');
    const hitsFile = values['hits-file'];
    const parsed = hitsFile ? readJson(resolve(cwd, hitsFile), 'hits file') : [];
    const hits = Array.isArray(parsed) ? parsed : parsed?.hits;
    if (!Array.isArray(hits)) throw new UsageError('--hits-file must hold a JSON array (or an object with a "hits" array)');
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

  const gh = createGitHub({ cwd, env: ctx.env });
  return guardGh(() => {
    const r = gh.upsertComment(pr, MARKER_OF[kind], body);
    return { exitCode: EXIT.OK, output: { ok: true, kind, pr, action: r.action, url: r.url, id: r.id } };
  });
}
