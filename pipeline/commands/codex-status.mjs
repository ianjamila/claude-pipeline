// `pipeline codex-status [--wait [--timeout-minutes N]]`: how much of Codex's WEEKLY quota is used, when it resets, the last quota outage and the PRs
// waiting for Codex. READ-ONLY (it never writes the record; codex-review and review-complete will, later). Logic and the record: lib/codex-usage.mjs.
import { EXIT, UsageError, intOption, parseCommandArgs } from '../lib/cli.mjs';
import { backAtMs, codexStatus } from '../lib/codex-usage.mjs';
import { seamValue } from '../lib/seams.mjs';
import { summariseUsage } from '../lib/codex-usage-kinds.mjs';

export const meta = {
  summary: 'show how much of Codex\'s weekly quota is used and when it resets, the last quota outage, and the PRs waiting for Codex; --wait blocks until Codex is back',
  usage: [
    'pipeline codex-status   -> {ok, weeklyUsedPct, windowMinutes, resetsAt, observedAt, source: \'codex-sessions\'|\'unknown\', lastOutage: {at, resetAt, resetText, repo, pr, round, worktree}|null, waiting: [{repo, pr, worktree, round, since, resume}]} : READ-ONLY, exit 0',
    'pipeline codex-status --usage [--since ISO]   -> {ok, since, sessions, totalTokens, byKind: {<kind>: {sessions, tokens}}, line} : Codex tokens from the session logs since ISO (default 7 days), by kind (pipeline round 1, pipeline fix-check, pipeline second review, plan review, code review, other; the kind comes from the prompt header the pipeline writes, anything else is `other`); `line` is one agent-log line: P agent-log publish --line "<line>"',
    'pipeline codex-status --wait [--timeout-minutes N]   -> the same object plus {waited: {outage, backAt, waitedMs, timedOut}} : returns at once when nothing is out, else polls every 60 s until Codex is back; exit 0 back, 1 timed out (default 600)',
    '  weeklyUsedPct / resetsAt / observedAt come from the newest `codex` weekly reading (window 10080 min) in Codex\'s own session logs ($CODEX_HOME/sessions), only when it is under 6 h old and its reset is still ahead;',
    '  otherwise they are null and source is `unknown` (never an error). The quota-failure `premium` reading and any other limit are ignored.',
    '  lastOutage and waiting come from the machine-wide record ~/.claude/pipeline-state/codex/status.json that the pipeline keeps; `resume` is the sentence that picks a parked PR back up.',
    '  --wait: Codex counts as out until the LATER of the last outage\'s resetAt (2 h after its `at` when it has none) and, when weeklyUsedPct >= 100, resetsAt. Run it as a job: `P job start codex-wait -- P codex-status --wait`.',
  ].join('\n'),
};

const POLL_MS = 60_000;
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function run(argv, ctx = {}) {
  const env = ctx.env ?? process.env;
  const { values } = parseCommandArgs(argv, { wait: { type: 'boolean' }, 'timeout-minutes': { type: 'string' }, usage: { type: 'boolean' }, since: { type: 'string' } }, { allowPositionals: false });
  const timeoutMinutes = intOption(values, 'timeout-minutes', { min: 1, max: 24 * 60 * 14 });
  if (timeoutMinutes !== undefined && !values.wait) throw new UsageError('--timeout-minutes needs --wait');
  if (values.since !== undefined && !values.usage) throw new UsageError('--since needs --usage');
  if (values.usage && (values.wait || timeoutMinutes !== undefined)) throw new UsageError('--usage cannot be combined with --wait');
  const clock = ctx.now ?? Date.now;
  if (values.usage) {
    if (values.since !== undefined && !Number.isFinite(Date.parse(values.since))) throw new UsageError('--since must be an ISO date');
    return { exitCode: EXIT.OK, output: { ok: true, ...summariseUsage({ env, now: clock(), since: values.since }) } };
  }
  const opts = { env, ...(ctx.record ?? {}) };
  const read = () => codexStatus({ ...opts, now: clock() });

  if (!values.wait) return { exitCode: EXIT.OK, output: { ok: true, ...read() } };

  const pollRaw = Number(ctx.pollMs ?? seamValue('PIPELINE_CODEX_STATUS_POLL_MS', env));
  const pollMs = Number.isFinite(pollRaw) && pollRaw > 0 ? pollRaw : POLL_MS;
  const sleep = ctx.sleep ?? defaultSleep;
  const startedMs = clock();
  const deadlineMs = startedMs + (timeoutMinutes ?? 600) * 60_000;
  let status = read();
  let backAt = backAtMs(status, clock());
  const outage = backAt !== null;
  const firstBackAt = backAt;
  while (backAt !== null) {
    const nowMs = clock();
    if (nowMs >= deadlineMs) {
      return { exitCode: EXIT.FAILED, output: { ok: false, ...status, waited: { outage, backAt: new Date(backAt).toISOString(), waitedMs: nowMs - startedMs, timedOut: true } } };
    }
    await sleep(Math.max(1, Math.min(pollMs, deadlineMs - nowMs, backAt - nowMs)));
    status = read();
    backAt = backAtMs(status, clock());
  }
  return { exitCode: EXIT.OK, output: { ok: true, ...status, waited: { outage, backAt: firstBackAt === null ? null : new Date(firstBackAt).toISOString(), waitedMs: clock() - startedMs, timedOut: false } } };
}
