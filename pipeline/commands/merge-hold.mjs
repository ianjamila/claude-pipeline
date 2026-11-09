// `pipeline merge-hold --pr N [--check | --release --reason <code>]`: the merge-hold seam of a repo that keeps a cooperative merge
// lock of its own (merge.hold_command / hold_release_command / hold_check_command, see lib/merge-hold.mjs). It runs ONLY those
// commands for the session's own PR, never merges, and never touches another PR's hold. A repo without the keys is exit 0
// `configured:false`, so a skill can call it unconditionally.
import { EXIT, UsageError, parseCommandArgs, intOption } from '../lib/cli.mjs';
import { requireConfig, resolveRepo, guarded } from '../lib/cmd-common.mjs';
import { createGitHub } from '../lib/github.mjs';
import { HOLD_POLL_MS, RELEASE_REASONS, checkHolds, holdGate, holdGateFrom, holdsConfigured, ownSuccessor, releaseHold, takeHold, waitForTurn } from '../lib/merge-hold.mjs';

const REASON_CODES = Object.keys(RELEASE_REASONS);

export const meta = {
  summary: 'take, check or release the repo\'s cooperative merge hold for this PR (repos with merge.hold_* keys; otherwise a no-op)',
  usage: `pipeline merge-hold --pr N [--repo DIR]   -> {ok, configured, confirmed, code, lines} : take (or keep) PR N\'s own hold with merge.hold_command; exit 0 confirmed, 1 refused or NOT confirmed, 2 the command errored (any other exit code or a timeout); a repo without the keys: exit 0 {ok:true, configured:false}
pipeline merge-hold --pr N --check [--repo DIR]   -> {ok, configured, readable, blockedBy:[PR numbers], holds, error?, verdict?, doNotUpdate?, reason?} : READ-ONLY, runs merge.hold_check_command; exit 0 nothing ahead of this PR, 1 error queued-behind (another PR\'s active hold is ahead: do NOT update the branch) or hold-unreadable
pipeline merge-hold --pr N --check --wait [--max-minutes M=120] [--repo DIR]   -> {ok, configured, outcome: front|timeout|unreadable, polls, waitedMinutes, blockedBy, holds?, reason?} : polls the READ-ONLY check at once and then every 5 minutes (fixed: the repo\'s check costs ~15 API calls and the budget is shared) until nothing is ahead of this PR; M is an integer 5..240 and bounds when a poll may START (a running check keeps its own 5 min timeout); exit 0 front (retry the update now), 1 timeout (still queued behind blockedBy) or unreadable (two unreadable answers in a row); a repo without the keys: exit 0 {ok:true, configured:false}. Run it as \`pipeline job start turn -- pipeline merge-hold --pr N --check --wait\` (it runs longer than a tool call may)
pipeline merge-hold --pr N --release --reason <${REASON_CODES.join('|')}> [--repo DIR]   -> {ok, configured, confirmed, code, lines, warnings?} : release PR N\'s own hold with merge.hold_release_command (the code maps to a fixed sentence; no free text reaches the shell); same exit codes as take. Exception: --reason new-commits on a PR head that THIS repo\'s \`pipeline update-branch\` / \`pipeline merge\` produced (a recorded successor whose parents GitHub still shows as exactly [the head it was made from, the base tip of that update]) runs nothing and keeps the hold: exit 0 {ok:true, configured:true, kept:true, why:'own-successor', head}; a PR-side push, an unrecorded head or a head that cannot be read releases as usual (the unreadable case with a warning). Codes added for the automatic cases: ci-failed (the required checks failed), update-conflict (the catch-up conflicts), queued-behind (an older hold is ahead and the wait ended), hold-unreadable (the check could not be read)
It never merges and acts only on the PR given (the session\'s own); use it to hold the merge queue at a merge hand-off and to release it when the hand-off ends without a merge.`,
};

export const run = guarded(async (argv, ctx) => {
  const { values } = parseCommandArgs(argv, {
    pr: { type: 'string' }, check: { type: 'boolean' }, release: { type: 'boolean' }, reason: { type: 'string' }, wait: { type: 'boolean' }, 'max-minutes': { type: 'string' }, repo: { type: 'string' },
  }, { allowPositionals: false });
  const pr = intOption(values, 'pr', { required: true, min: 1 });
  const check = values.check === true;
  const release = values.release === true;
  if (check && release) throw new UsageError('--check and --release cannot be combined');
  if (values.reason !== undefined && !release) throw new UsageError('--reason belongs to --release');
  if (release && values.reason === undefined) throw new UsageError(`--release needs --reason <${REASON_CODES.join('|')}>`);
  if (release && !REASON_CODES.includes(values.reason)) throw new UsageError(`--reason must be one of ${REASON_CODES.join(', ')}`);
  const wait = values.wait === true;
  if (wait && !check) throw new UsageError('--wait belongs to --check');
  if (values['max-minutes'] !== undefined && !wait) throw new UsageError('--max-minutes belongs to --check --wait');
  const maxMinutes = intOption(values, 'max-minutes', { min: 5, max: 240 }) ?? 120;
  const root = resolveRepo(values, ctx);
  const { config } = await requireConfig(root);
  const args = { config, pr, root, env: ctx.env };

  if (check && wait) {
    if (!holdsConfigured(config)) return { exitCode: EXIT.OK, output: { ok: true, configured: false } };
    const waited = await waitForTurn({ check: () => holdGate(args), pollMs: HOLD_POLL_MS, maxMs: maxMinutes * 60_000 });
    const last = waited.last;
    return {
      exitCode: waited.outcome === 'front' ? EXIT.OK : EXIT.FAILED,
      output: {
        ok: waited.outcome === 'front', configured: true, outcome: waited.outcome, polls: waited.polls, waitedMinutes: Math.round(waited.waitedMs / 6000) / 10,
        blockedBy: last?.blockedBy ?? [], ...(last?.holds ? { holds: last.holds } : {}), ...(last?.reason ? { reason: last.reason } : {}),
      },
    };
  }

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

  const warnings = [];
  // A new-commits release after the pipeline's OWN catch-up must not give the turn away: the head is the merge commit the pipeline made
  // (recorded when it was proven, parents re-read from GitHub). A head that cannot be read releases as before (the safe direction).
  if (release && values.reason === 'new-commits' && holdsConfigured(config)) {
    let gh = null;
    let head = null;
    try {
      gh = createGitHub({ cwd: root, env: ctx.env });
      head = gh.prView(pr, ['headRefOid']).headRefOid;
    } catch (err) {
      warnings.push(`the PR head could not be read (${String(err?.message ?? err).slice(0, 200)}): the hold is released as for a push by someone else`);
    }
    if (typeof head === 'string' && ownSuccessor({ root, pr, head, gh })) {
      return { exitCode: EXIT.OK, output: { ok: true, configured: true, kept: true, why: 'own-successor', head } };
    }
  }

  const result = release ? await releaseHold({ ...args, reason: values.reason }) : await takeHold(args);
  if (!result.configured) return { exitCode: EXIT.OK, output: { ok: true, configured: false } };
  // 0 = confirmed, 1 = refused / NOT confirmed (the provider said no), anything else = the command itself went wrong (a timeout, or a kill: runShellAsync
  // reports a signalled child as code 1 plus `signal`). runShellAsync has no output cap (no maxBuffer), so overBuffer cannot occur here.
  const exitCode = result.confirmed ? EXIT.OK : (result.code === 1 && result.timedOut !== true && !result.signal ? EXIT.FAILED : EXIT.USAGE);
  return { exitCode, output: { ok: result.confirmed, ...result, ...(warnings.length > 0 ? { warnings } : {}) } };
});
