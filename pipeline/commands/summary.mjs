// `pipeline summary --pr N --outcome O [--built TEXT]`: upserts the PR's single summary
// comment (rendered from the review state, the Fable model proofs and the follow-up issues, with the run record riding in
// it) and prints the agent-log line for this run.
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { EXIT, UsageError, intOption, parseCommandArgs, requireOption } from '../lib/cli.mjs';
import { guarded, resolveRepo } from '../lib/cmd-common.mjs';
import { createGitHub, guardGh } from '../lib/github.mjs';
import { emptyState, loadState } from '../lib/state.mjs';
import { loadConfig } from '../lib/config.mjs';
import { summarySections } from '../lib/render.mjs';
import { recordForOutcome } from '../lib/run-record.mjs';
import { costReport, guardLogFile, readGuardLog } from '../lib/run-cost.mjs';
import { readSummaryComment, writeSummaryComment } from '../lib/summary-comment.mjs';
import { DEFAULT_OUTCOME, buildAgentLogLine } from '../lib/agentlog.mjs';
import { inlineOptionValues } from '../lib/cmd-io.mjs';
import { readModelProofs } from '../lib/review-context.mjs';

export const meta = {
  summary: 'upsert the PR summary comment and print the agent-log line',
  usage: 'pipeline summary --pr N --outcome O [--built TEXT] [--session ID]... [--repo DIR]   -> {ok, url, agentLogLine, pendingLogLine?, cost}   (pendingLogLine: only for --outcome merged, the same line with outcome "merged — prod smoke pending")',
};

// These stops never reach a review round (verify red three times, Codex out in round 1) or happen after the run's state
// is no longer the point (a stop on a gate, the owner closing the PR, an outside merge), so there may be no state.json to
// render from. They still get a comment and a log line: rounds are empty, the verify report (if any) names where it stopped.
const NO_STATE_OUTCOMES = new Set(['blocked', 'awaiting-review', 'stopped', 'closed', 'merged-externally']);

async function verifyDetail(root) {
  let file = join(root, '.verify', 'report.json');
  try {
    const loaded = await loadConfig(root);
    if (loaded.ok) file = join(root, loaded.config.verify.report);
  } catch { /* the default location will do */ }
  try {
    const report = JSON.parse(readFileSync(file, 'utf8'));
    const failed = (report?.steps ?? []).find((s) => s?.status === 'fail');
    if (failed?.name) return `verify failed at step ${String(failed.name).slice(0, 60)}${report.mode ? ` (${String(report.mode).slice(0, 20)})` : ''}`;
  } catch { /* no usable report */ }
  return null;
}

// FOLLOW-UP items that have an issue filed, once per finding (the same fingerprint can come back in a later round).
function followupsOf(state) {
  const seen = new Set();
  const out = [];
  for (const round of state.rounds ?? []) {
    for (const item of round.items ?? []) {
      if (item.final?.decision !== 'FOLLOW-UP' || !item.followupIssue) continue;
      const key = item.fingerprint || item.id;
      if (seen.has(key)) continue;
      seen.add(key);
      const issue = typeof item.followupIssue === 'object' ? item.followupIssue : { url: item.followupIssue };
      out.push({ id: item.id, title: item.title, ...issue });
    }
  }
  return out;
}

// Where the guard hooks' deny log is (tests and odd installs point PIPELINE_GUARD_LOG_FILE at another file).
const guardLogPath = (ctx) => ctx.guardLogFile ?? ctx.env?.PIPELINE_GUARD_LOG_FILE ?? guardLogFile();

// How many commands the guards denied to this run's sessions: the ones the record already knows plus --session. No
// session known, or no log file (the guards have not written one yet): nothing is counted and the old count stays.
function guardBlocksFor(record, extraSessions, ctx) {
  const sessions = [...new Set([...(record?.cost?.sessions ?? []), ...extraSessions])];
  if (!sessions.length) return { blocks: undefined, bySession: undefined, warnings: [] };
  const log = readGuardLog(guardLogPath(ctx), sessions);
  if (!log.present) return { blocks: undefined, bySession: undefined, warnings: [] };
  return { blocks: log.blocks, bySession: log.bySession, warnings: log.skipped ? [`guard log: ${log.skipped} unreadable line(s) skipped`] : [] };
}

export const run = guarded(async (argv, ctx) => {
  const { values } = parseCommandArgs(inlineOptionValues(argv, ['--outcome', '--built', '--session']), {
    pr: { type: 'string' }, outcome: { type: 'string' }, built: { type: 'string' }, repo: { type: 'string' },
    session: { type: 'string', multiple: true },
  }, { allowPositionals: false });
  const pr = intOption(values, 'pr', { required: true, min: 1 });
  const outcome = requireOption(values, 'outcome');
  const root = resolveRepo(values, ctx);

  let state;
  try {
    state = loadState(root);
  } catch (err) {
    throw new UsageError(err.message);
  }
  let detail = null;
  if (!state) {
    if (!NO_STATE_OUTCOMES.has(outcome)) {
      throw new UsageError(`no review state at ${join(root, '.review', 'state.json')}: the summary comment is rendered from it (only --outcome ${[...NO_STATE_OUTCOMES].join('|')} can be summarised without one)`);
    }
    state = emptyState({ repo: '', pr, branch: '', risk: null });
    detail = outcome === 'blocked' ? await verifyDetail(root) : null;
  }

  const gh = createGitHub({ cwd: root, env: ctx.env });
  return guardGh(() => {
    const view = gh.prView(pr, ['title', 'headRefName', 'baseRefName', 'headRefOid']);
    const { title } = view;
    const sections = summarySections(state, { outcome: detail ? `${outcome} — ${detail}` : outcome, built: values.built, followups: followupsOf(state), modelProofs: readModelProofs(root, state) });
    const agentLogLine = buildAgentLogLine({ state, pr, title, outcome });
    // The run record rides in the same comment: keep the one a checkpoint wrote, set how the run ended.
    const existing = readSummaryComment(gh, pr);
    if (existing.status === 'unsupported') throw new UsageError('the summary comment carries a run record from a newer pipeline version: update the pipeline CLI first');
    const guard = guardBlocksFor(existing.status === 'ok' ? existing.record : null, values.session ?? [], ctx);
    const { record, warnings } = recordForOutcome(existing.status === 'ok' ? existing.record : null, {
      repo: gh.repo().slug, pr, branch: view.headRefName, baseRef: view.baseRefName, head: view.headRefOid,
      outcome, detail, agentLogLine, host: hostname(), now: Date.now(), sessions: values.session, guardBlocks: guard.blocks, guardBySession: guard.bySession,
    });
    warnings.push(...guard.warnings);
    const posted = writeSummaryComment(gh, pr, { record, sections, existing });
    const output = { ok: true, url: posted.url, action: posted.action, agentLogLine, step: record.step, cost: costReport(record.cost), warnings };
    // A merged run under `production.watch: workflow` logs the line `agent-log close` later resolves from the CI smoke result.
    if (outcome === 'merged') output.pendingLogLine = buildAgentLogLine({ state, pr, title, outcome: DEFAULT_OUTCOME });
    return { exitCode: EXIT.OK, output };
  });
});
