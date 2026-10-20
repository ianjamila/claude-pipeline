// `pipeline notify`: sends the owner a push (ntfy + a Windows toast under WSL2). `--test` is the rollout check; `--event`
// is the manual route for a stop that is not expressed through `pipeline summary`. Best effort: a push that could not be
// sent is reported in the JSON, never a failing run.
import path from 'node:path';
import { EXIT, UsageError, intOption, parseCommandArgs, requireOption } from '../lib/cli.mjs';
import { notifyEvent, testEvent } from '../lib/notify.mjs';

export const meta = {
  summary: 'send the owner a push notification (ntfy, plus a Windows toast under WSL2)',
  usage: 'pipeline notify --test [--repo DIR]   |   pipeline notify --event owner-merge|plan-approval|owner-ui-merge|needs-human|arbiter-escalation|stopped --pr N --action TEXT [--cause CODE] [--repo DIR]   -> {ok, sent, reason?, transports:{ntfy, toast}}',
};

const EVENT_NAMES = ['owner-merge', 'plan-approval', 'owner-ui-merge', 'needs-human', 'arbiter-escalation', 'stopped'];
const CAUSE_RE = /^[A-Za-z0-9:_.-]{1,60}$/;

export async function run(argv, ctx = {}) {
  const { values } = parseCommandArgs(argv, {
    test: { type: 'boolean' },
    event: { type: 'string' },
    pr: { type: 'string' },
    action: { type: 'string' },
    cause: { type: 'string' },
    repo: { type: 'string' },
  }, { allowPositionals: false });
  if (values.test && values.event) throw new UsageError('use either --test or --event, not both');
  if (!values.test && !values.event) throw new UsageError('missing --test or --event');
  const cwd = path.resolve(ctx.cwd ?? process.cwd(), values.repo ?? '.');
  const deps = { cwd, env: ctx.env ?? process.env, ...(ctx.notifyDeps ?? {}) };

  if (values.test) {
    const result = await notifyEvent(testEvent(), deps);
    const t = result.transports;
    process.stderr.write(`notify --test: ntfy ${t.ntfy}, toast ${t.toast}${result.reason ? ` (${result.reason})` : ''}\n`);
    return { exitCode: result.transports.ntfy === 'sent' ? EXIT.OK : EXIT.FAILED, output: { ok: result.transports.ntfy === 'sent', ...result } };
  }

  const event = requireOption(values, 'event');
  if (!EVENT_NAMES.includes(event)) throw new UsageError(`--event must be one of ${EVENT_NAMES.join('|')}`);
  const pr = intOption(values, 'pr', { required: true, min: 1 });
  const action = requireOption(values, 'action');
  if (values.cause !== undefined && !CAUSE_RE.test(values.cause)) throw new UsageError('--cause must be a short code of letters, digits, : _ . -');
  const result = await notifyEvent({ event, pr, action, outcome: event, ...(values.cause ? { cause: values.cause } : {}) }, deps);
  return { exitCode: EXIT.OK, output: { ok: true, ...result } };
}
