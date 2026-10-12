// `pipeline summary --pr N --outcome O [--built TEXT] [--action TEXT] [--cause CODE]`: upserts the PR's single summary
// comment (rendered from the review state, the Fable model proofs and the follow-up issues), prints the agent-log line for
// this run and, for an outcome that needs the owner, sends the one push (pipeline/lib/notify.mjs) whether or not GitHub
// answered.
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
import { headSha } from '../lib/git.mjs';
import { classifyOutcome, defaultAction, notifyEvent } from '../lib/notify.mjs';

export const meta = {
  summary: 'upsert the PR summary comment and print the agent-log line',
  usage: 'pipeline summary --pr N --outcome O [--built TEXT] [--action TEXT] [--cause CODE] [--repo DIR]   -> {ok, url, agentLogLine, notify}',
};

// These stops never reach a review round (verify red three times, Codex out in round 1) or happen after the run's state
// is no longer the point (a stop on a gate, the owner closing the PR, an outside merge), so there may be no state.json to
// render from. They still get a comment and a log line: rounds are empty, the verify report (if any) names where it stopped.
const NO_STATE_OUTCOMES = new Set(['blocked', 'awaiting-review', 'stopped', 'closed', 'merged-externally']);
const CAUSE_RE = /^[A-Za-z0-9:_.-]{1,60}$/;

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

// Every item (any round) still waiting on a human, once per id. `arbiter` are the ones an arbiter ruling parked there
// (low confidence, a dismissed blocking security/data item, a failed model proof, unusable output): those turn the push
// into an arbiter escalation. The push names ALL open ids, the arbiter ones first, so it is complete by construction.
export function openNeedsHuman(state) {
  const seen = new Set();
  const arbiter = [];
  const other = [];
  for (const round of state?.rounds ?? []) {
    for (const item of round.items ?? []) {
      if (item?.final?.needsHuman !== true || !item.id || seen.has(item.id)) continue;
      seen.add(item.id);
      (item.final.by === 'arbiter' ? arbiter : other).push(item.id);
    }
  }
  return { arbiter, ids: [...arbiter, ...other] };
}

function localHead(root) {
  try {
    return headSha({ cwd: root });
  } catch {
    return undefined;
  }
}

// The event to push for this outcome, or null (and why not). Decided before any GitHub call.
function planPush({ outcome, state, values, root }) {
  const { known, event } = classifyOutcome(outcome);
  if (!known) return { event: null, reason: 'unclassified-outcome' };
  if (!event) return { event: null, reason: 'no-event' };
  const head = localHead(root);
  let kind = event;
  let ids = [];
  if (event === 'needs-human') {
    const open = openNeedsHuman(state);
    ids = open.ids;
    if (open.arbiter.length) kind = 'arbiter-escalation';
  }
  const cause = values.cause;
  const action = values.action
    || (outcome === 'blocked' ? 'Verify stays red after 3 fixes: read the blocked comment'
      : outcome === 'awaiting-review' ? `Codex review is unavailable${cause ? ` (${cause})` : ''}: say "resume pipeline reviews" later`
        : defaultAction(kind, { head, ids }));
  return { event: { event: kind, outcome, action, ids, ...(head ? { head } : {}), ...(cause ? { cause } : {}) } };
}

export const run = guarded(async (argv, ctx) => {
  const { values } = parseCommandArgs(inlineOptionValues(argv, ['--outcome', '--built', '--action', '--cause']), {
    pr: { type: 'string' }, outcome: { type: 'string' }, built: { type: 'string' }, repo: { type: 'string' },
    action: { type: 'string' }, cause: { type: 'string' },
  }, { allowPositionals: false });
  const pr = intOption(values, 'pr', { required: true, min: 1 });
  const outcome = requireOption(values, 'outcome');
  if (values.cause !== undefined && !CAUSE_RE.test(values.cause)) throw new UsageError('--cause must be a short code of letters, digits, : _ . -');
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

  // Classified before any GitHub call, so a GitHub outage cannot change whether the owner hears about this stop.
  const plan = planPush({ outcome, state, values, root });
  if (plan.reason === 'unclassified-outcome') {
    process.stderr.write(`summary: outcome "${outcome.slice(0, 40)}" is not classified for owner notifications: no push sent\n`);
  }

  const gh = createGitHub({ cwd: root, env: ctx.env });
  let title;
  let url;
  let result;
  try {
    result = await guardGh(() => {
      ({ title } = gh.prView(pr, ['title']));
      const body = summaryComment(state, { outcome: detail ? `${outcome} — ${detail}` : outcome, built: values.built, followups: followupsOf(state), modelProofs: readModelProofs(root) });
      const posted = gh.upsertComment(pr, MARKERS.summary, body);
      const prUrl = typeof posted.url === 'string' ? posted.url.replace(/#.*$/, '') : '';
      if (/\/pull\/\d+$/.test(prUrl)) url = prUrl;
      const agentLogLine = buildAgentLogLine({ state, pr, title, outcome });
      return { exitCode: EXIT.OK, output: { ok: true, url: posted.url, action: posted.action, agentLogLine } };
    });
  } finally {
    // Whether or not GitHub answered. When it threw, the error keeps its exit code and the push is still sent.
    result = await pushAfter(result, plan, { pr, title, url, root, ctx });
  }
  return result;
});

async function pushAfter(result, plan, { pr, title, url, root, ctx }) {
  let notify;
  if (!plan.event) {
    notify = { sent: false, reason: plan.reason };
  } else {
    notify = await notifyEvent(
      { ...plan.event, pr, ...(title ? { title } : {}), ...(url ? { url } : {}) },
      { cwd: root, env: ctx.env ?? process.env, ...(ctx.notifyDeps ?? {}) },
    );
  }
  return result ? { ...result, output: { ...result.output, notify } } : result;
}
