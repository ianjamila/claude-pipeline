// `pipeline queue-sweep [--repo <root>]`: carries every queued PR to its end (the renewable observer of queue mode).
// A `P merge` job watches a queue entry for a finite time and a session can die; the durable record is the responsibility, so anything that reads it
// can finish the job. Logic: lib/queue-sweep.mjs. A LaunchAgent (macOS) runs this every 10 minutes: lib/queue-sweep-schedule.mjs.
import os from 'node:os';
import { EXIT, parseCommandArgs } from '../lib/cli.mjs';
import { guarded, resolveRepo } from '../lib/cmd-common.mjs';
import { defaultNotify, sweepAll } from '../lib/queue-sweep.mjs';

export const meta = {
  summary: 'carry every queued PR of the pipeline repos to its end (the renewable observer for queue mode).',
  usage: 'pipeline queue-sweep [--repo <root>]   -> {ok, repos:[{root, settled:[{pr, outcome, terminal?, hold?, position?, removalReason?, message?, why?}], skipped:[{pr, why}], errors:[text]}]} ; settles each live merge-queue record once (merged | queued | requeued | ended | unsettled ...); no live record = no GitHub call; exit 0, 1 when a record could not be settled (unsettled / restore-failed / error)',
};

const BAD = new Set(['unsettled', 'restore-failed', 'error']);

export const run = guarded(async (argv, ctx) => {
  const { values } = parseCommandArgs(argv, { repo: { type: 'string' } }, { allowPositionals: false });
  const env = ctx?.env ?? process.env;
  const home = ctx?.home ?? os.homedir();
  const repo = values.repo === undefined ? null : resolveRepo(values, ctx);
  const result = await sweepAll({ repo, env, home, requeue: true, notify: ctx?.notify ?? defaultNotify({ env }), ...(ctx?.deps ?? {}) });
  const failed = result.repos.some((r) => r.errors.length > 0 || r.settled.some((s) => BAD.has(s.outcome)));
  return { exitCode: failed ? EXIT.FAILED : EXIT.OK, output: { ok: !failed, ...result }, compact: true };
});
