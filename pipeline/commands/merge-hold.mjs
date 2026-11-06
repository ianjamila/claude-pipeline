// `pipeline merge-hold --pr N [--check | --release --reason <code>]`: the merge-hold seam of a repo that keeps a cooperative merge
// lock of its own (merge.hold_command / hold_release_command / hold_check_command, see lib/merge-hold.mjs). It runs ONLY those
// commands for the session's own PR, never merges, and never touches another PR's hold. A repo without the keys is exit 0
// `configured:false`, so a skill can call it unconditionally.
import { EXIT, UsageError, parseCommandArgs, intOption } from '../lib/cli.mjs';
import { requireConfig, resolveRepo, guarded } from '../lib/cmd-common.mjs';
import { RELEASE_REASONS, checkHolds, holdGateFrom, releaseHold, takeHold } from '../lib/merge-hold.mjs';

const REASON_CODES = Object.keys(RELEASE_REASONS);

export const meta = {
  summary: 'take, check or release the repo\'s cooperative merge hold for this PR (repos with merge.hold_* keys; otherwise a no-op)',
  usage: `pipeline merge-hold --pr N [--repo DIR]   -> {ok, configured, confirmed, code, lines} : take (or keep) PR N\'s own hold with merge.hold_command; exit 0 confirmed, 1 refused or NOT confirmed, 2 the command errored (any other exit code or a timeout); a repo without the keys: exit 0 {ok:true, configured:false}
pipeline merge-hold --pr N --check [--repo DIR]   -> {ok, configured, readable, blockedBy:[PR numbers], holds, error?, verdict?, doNotUpdate?, reason?} : READ-ONLY, runs merge.hold_check_command; exit 0 nothing ahead of this PR, 1 error queued-behind (another PR\'s active hold is ahead: do NOT update the branch) or hold-unreadable
pipeline merge-hold --pr N --release --reason <${REASON_CODES.join('|')}> [--repo DIR]   -> {ok, configured, confirmed, code, lines} : release PR N\'s own hold with merge.hold_release_command (the code maps to a fixed sentence; no free text reaches the shell); same exit codes as take
It never merges and acts only on the PR given (the session\'s own); use it to hold the merge queue at a merge hand-off and to release it when the hand-off ends without a merge.`,
};

export const run = guarded(async (argv, ctx) => {
  const { values } = parseCommandArgs(argv, {
    pr: { type: 'string' }, check: { type: 'boolean' }, release: { type: 'boolean' }, reason: { type: 'string' }, repo: { type: 'string' },
  }, { allowPositionals: false });
  const pr = intOption(values, 'pr', { required: true, min: 1 });
  const check = values.check === true;
  const release = values.release === true;
  if (check && release) throw new UsageError('--check and --release cannot be combined');
  if (values.reason !== undefined && !release) throw new UsageError('--reason belongs to --release');
  if (release && values.reason === undefined) throw new UsageError(`--release needs --reason <${REASON_CODES.join('|')}>`);
  if (release && !REASON_CODES.includes(values.reason)) throw new UsageError(`--reason must be one of ${REASON_CODES.join(', ')}`);
  const root = resolveRepo(values, ctx);
  const { config } = await requireConfig(root);
  const args = { config, pr, root, env: ctx.env };

  if (check) {
    const answer = await checkHolds(args);
    if (!answer.configured) return { exitCode: EXIT.OK, output: { ok: true, configured: false } };
    const gate = holdGateFrom(answer);
    return {
      exitCode: gate ? EXIT.FAILED : EXIT.OK,
      output: gate
        ? { ok: false, configured: true, readable: answer.ok, blockedBy: [], ...gate }
        : { ok: true, configured: true, readable: true, blockedBy: [] },
    };
  }

  const result = release ? await releaseHold({ ...args, reason: values.reason }) : await takeHold(args);
  if (!result.configured) return { exitCode: EXIT.OK, output: { ok: true, configured: false } };
  // 0 = confirmed, 1 = refused / NOT confirmed (the provider said no), anything else = the command itself went wrong (a timeout, or a kill: runShellAsync
  // reports a signalled child as code 1 plus `signal`). runShellAsync has no output cap (no maxBuffer), so overBuffer cannot occur here.
  const exitCode = result.confirmed ? EXIT.OK : (result.code === 1 && result.timedOut !== true && !result.signal ? EXIT.FAILED : EXIT.USAGE);
  return { exitCode, output: { ok: result.confirmed, ...result } };
});
