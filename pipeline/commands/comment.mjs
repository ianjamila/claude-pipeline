// `pipeline comment`: renders one of the pipeline's PR comments (render.mjs) and upserts it, so a PR
// carries ONE comment per kind that is edited in place rather than a new one per round.
import { existsSync, readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { resolve, join } from 'node:path';
import { EXIT, UsageError, parseCommandArgs, intOption, requireOption } from '../lib/cli.mjs';
import { guarded } from '../lib/cmd-common.mjs';
import { loadConfig, DEFAULTS } from '../lib/config.mjs';
import { loadState } from '../lib/state.mjs';
import { MARKERS, summarySections, needsHumanComment, blockedComment, blockedReasonComment, awaitingReviewComment } from '../lib/render.mjs';
import { recordForOutcome } from '../lib/run-record.mjs';
import { readSummaryComment, writeSummaryComment } from '../lib/summary-comment.mjs';
import { createGitHub, commandCwd, guardGh, requireRepoRoot } from '../lib/github.mjs';
import { parkStatusLines } from '../lib/round-status.mjs';
import { allItems, readModelProofs, withReviewLock } from '../lib/review-context.mjs';
import { publishTriage } from '../lib/review-publish.mjs';

export const meta = {
  summary: 'render and upsert a pipeline PR comment (triage, summary, needs-human, blocked, awaiting-review)',
  usage: [
    'pipeline comment --pr N --kind triage|summary|needs-human|blocked|awaiting-review [--outcome O] [--built TEXT] [--reason TEXT] [--hits-file F] [--repo DIR]',
    '  --kind triage publishes the review state under the review lock as a compare-and-swap on its content (lib/review-publish.mjs): it is refused',
    '  (exit 1 {ok:false, error:\'stale-publication\', reason}) when the PR holds a state this copy neither published nor restored: run `pipeline state show --pr N`',
    '  and redo the decision; {action:\'unchanged\'} when the PR already holds exactly this state. The other kinds take no lock.',
    '  --kind blocked renders the verify report\'s failure; with --reason TEXT it renders a "the review stopped: TEXT" comment instead (no report needed), e.g. the advice of a stop that waits for a terminal restart.',
    '  --kind needs-human adds, when a review state with at least one round exists for this PR, a short status block under the paragraph: rounds, booked cost (with the last round\'s share),',
    '  open items with their severity and why the review is not clean (the extra-round ask\'s text without its recommendation). Display only: a part that cannot be read becomes a "not available" line; the comment is always written.',
    '  --kind triage also adds {redraftAdvice:true, warnings:[...]}: run `pipeline redraft --pr N` before the first fix push, when the repo has ci.draft_while_iterating, the state holds',
    '  an ACCEPT item not yet implemented (a fix is coming) and the PR is READY. Advice only, never a failure: no such item, a draft PR or a PR that cannot be read gets none.',
  ].join('\n'),
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

// The summary comment also carries the run record: write the sections through the one writer, which keeps an existing
// record (and sets how the run ended on it).
function summaryKind(gh, pr, sections, outcome) {
  const view = gh.prView(pr, ['headRefName', 'baseRefName', 'headRefOid']);
  const existing = readSummaryComment(gh, pr);
  if (existing.status === 'unsupported') throw new UsageError('the summary comment carries a run record from a newer pipeline version: update the pipeline CLI first');
  const { record, warnings } = recordForOutcome(existing.status === 'ok' ? existing.record : null, {
    repo: gh.repo().slug, pr, branch: view.headRefName, baseRef: view.baseRefName, head: view.headRefOid,
    outcome, host: hostname(), now: Date.now(),
  });
  const r = writeSummaryComment(gh, pr, { record, sections, existing });
  return { exitCode: EXIT.OK, output: { ok: true, kind: 'summary', pr, action: r.action, url: r.url, id: r.id, step: record.step, warnings } };
}

// true only when GitHub says the PR is a ready (non-draft) PR; a failed read, or any other answer, is false.
function prIsReady(gh, pr) {
  try {
    return gh.prView(pr, ['isDraft']).isDraft === false;
  } catch {
    return false;
  }
}

// The review round has a fix coming (an ACCEPT item no one has implemented yet) in a repo that iterates in draft (ci.draft_while_iterating) and the PR is
// READY: every fix push would re-run the heavy CI, so say so before the first one (the review skill's Rule 8: `pipeline redraft`). Advice only, never a failure.
// The cheap checks come first: a repo that does not iterate, or a round with nothing to fix, never reads the PR.
function redraftAdvice({ config, state, gh, pr }) {
  if (config?.ci?.draft_while_iterating !== true) return {};
  const fixComing = allItems(state).some((i) => i.final?.decision === 'ACCEPT' && i.final.needsHuman !== true && !i.implemented);
  if (!fixComing || !prIsReady(gh, pr)) return {};
  return {
    redraftAdvice: true,
    warnings: [`PR #${pr} is ready and this repo iterates in draft (ci.draft_while_iterating): run \`pipeline redraft --pr ${pr}\` BEFORE you push any fix from this round, so CI waits for the re-ready instead of running on every fix push`],
  };
}

export const run = guarded(async (argv, ctx) => {
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
    const state = requireState(root, kind);
    if (state.pr !== pr) throw new UsageError(`the local review state belongs to PR #${state.pr}, not #${pr}: the triage comment is rendered from it`);
  } else if (kind === 'summary') {
    const outcome = requireOption(values, 'outcome');
    const state = requireState(root, kind);
    body = summarySections(state, { outcome, built: values.built, modelProofs: readModelProofs(root, state) });
  } else if (kind === 'blocked' && values.reason !== undefined) {
    body = blockedReasonComment(values.reason);
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
    const cfg = await loadConfig(root);
    const reportFile = resolve(root, cfg.ok ? cfg.config.verify.report : DEFAULTS.verify.report);
    const report = existsSync(reportFile) ? readJson(reportFile, 'verify report') : null;
    body = needsHumanComment({
      reasons: [reason],
      hits,
      verified: typeof report?.ok === 'boolean' ? report.ok : null,
      reviewed: state ? state.rounds?.length > 0 : null,
      // Display only: rounds, booked cost, open items and why the review is not clean (never throws; a failed line says "not available").
      review: parkStatusLines({ root, config: cfg.ok ? cfg.config : null, state, pr, gh: createGitHub({ cwd, env: ctx.env }) }),
    });
  } else {
    body = awaitingReviewComment(values.reason ?? '');
  }

  const gh = createGitHub({ cwd, env: ctx.env });
  // The triage state is read again under the lock, so what is published is what the lock-holders before us left.
  if (kind === 'triage') {
    const cfg = await loadConfig(root);
    return guardGh(() => withReviewLock(root, pr, ctx, () => {
      const state = requireState(root, kind);
      const r = publishTriage({ gh, root, pr, state });
      return { exitCode: EXIT.OK, output: { ok: true, kind, pr, action: r.action, url: r.url, id: r.id, ...redraftAdvice({ config: cfg.ok ? cfg.config : null, state, gh, pr }) } };
    }));
  }
  return guardGh(() => {
    if (kind === 'summary') return summaryKind(gh, pr, body, values.outcome);
    const r = gh.upsertComment(pr, MARKER_OF[kind], body);
    return { exitCode: EXIT.OK, output: { ok: true, kind, pr, action: r.action, url: r.url, id: r.id } };
  });
});
