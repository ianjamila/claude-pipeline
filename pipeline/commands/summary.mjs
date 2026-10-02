// `pipeline summary --pr N --outcome O [--built TEXT]`: upserts the PR's single summary comment (rendered from the
// review state, the Fable model proofs and the follow-up issues) and prints the agent-log line for this run.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT, UsageError, intOption, parseCommandArgs, requireOption } from '../lib/cli.mjs';
import { guarded, resolveRepo } from '../lib/cmd-common.mjs';
import { createGitHub, guardGh } from '../lib/github.mjs';
import { emptyState, loadState } from '../lib/state.mjs';
import { loadConfig } from '../lib/config.mjs';
import { MARKERS, summaryComment } from '../lib/render.mjs';
import { buildAgentLogLine } from '../lib/agentlog.mjs';
import { inlineOptionValues } from '../lib/finalgate.mjs';

export const meta = {
  summary: 'upsert the PR summary comment and print the agent-log line',
  usage: 'pipeline summary --pr N --outcome O [--built TEXT] [--repo DIR]   -> {ok, url, agentLogLine}',
};

// The two early-stop paths never reach a review round (verify red three times, or Codex out in round 1), so there is no
// state.json to render from. They still get a comment and a log line: rounds are empty, the verify report (if any) names
// where it stopped.
const NO_STATE_OUTCOMES = new Set(['blocked', 'awaiting-review']);

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

// One entry per round whose Fable model proof passed; a round without (or with a failed) proof adds nothing.
function readModelProofs(root) {
  const dir = join(root, '.review');
  if (!existsSync(dir)) return [];
  const proofs = [];
  for (const name of readdirSync(dir).filter((n) => /^round-\d+$/.test(n)).sort((a, b) => Number(a.slice(6)) - Number(b.slice(6)))) {
    try {
      const p = JSON.parse(readFileSync(join(dir, name, 'model-proof.json'), 'utf8'));
      if (p?.ok !== true) continue;
      const efforts = p.efforts && typeof p.efforts === 'object' ? Object.keys(p.efforts).join(', ') : '';
      proofs.push({ transcript: p.transcript, models: p.models, ...(efforts ? { effort: efforts } : {}) });
    } catch { /* no proof for this round */ }
  }
  return proofs;
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

export const run = guarded(async (argv, ctx) => {
  const { values } = parseCommandArgs(inlineOptionValues(argv, ['--outcome', '--built']), {
    pr: { type: 'string' }, outcome: { type: 'string' }, built: { type: 'string' }, repo: { type: 'string' },
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
    const { title } = gh.prView(pr, ['title']);
    const body = summaryComment(state, { outcome: detail ? `${outcome} — ${detail}` : outcome, built: values.built, followups: followupsOf(state), modelProofs: readModelProofs(root) });
    const posted = gh.upsertComment(pr, MARKERS.summary, body);
    const agentLogLine = buildAgentLogLine({ state, pr, title, outcome });
    return { exitCode: EXIT.OK, output: { ok: true, url: posted.url, action: posted.action, agentLogLine } };
  });
});
