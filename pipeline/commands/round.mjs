// Two bundles that chain existing, repeat-safe pipeline steps so the controller spends one turn where it spent four to ten:
//
//   round codex   --pr N --round R [--base B] [--head H] [--max-minutes 60]   Codex's round, start to finish. Run it in the BACKGROUND
//                 (Bash run_in_background): it waits for the Codex job, so the controller is woken once. codex-review --plan, job start,
//                 the wait, the result, and (a Fable round with no arbiter record) `arbiter needed`.
//   round publish --pr N --round R                                              the publish half of a round: triage comment, follow-up
//                 issues, the comment again (issue links), the accepted items, state outcome.
//
// Each step is the existing command, run as its own CLI process, so it keeps its own admission, lock, lease and JSON; a failing step's JSON
// is handed back unchanged. Nothing here decides anything a step does not: no cost booking, no ruling, no discard-round.
// Exit codes follow the step that stopped the bundle (0 ok, 1 refused / failed, 2 usage / environment, 3 dependency unavailable).
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { EXIT, UsageError, intOption, parseCommandArgs } from '../lib/cli.mjs';
import { Fail, guarded, requireConfig, resolveRepo } from '../lib/cmd-common.mjs';
import { revParse } from '../lib/git.mjs';
import { readJob, waitJob } from '../lib/jobs.mjs';
import { defaultRoundRange } from '../lib/review-round.mjs';
import { seamValue } from '../lib/seams.mjs';
import { loadState } from '../lib/state.mjs';
import { ensureRoundDir, roundDir, writeFileAtomic } from '../lib/review-context.mjs';

export const meta = {
  summary: 'run Codex\'s review round (codex) or the publish half of a round (publish) as one command',
  usage: [
    'pipeline round codex --pr N --round R [--base B] [--head H] [--max-minutes M] [--repo DIR]   (M default 60, max 120)   RUN IT IN THE BACKGROUND (Bash run_in_background): it waits for Codex',
    '  -> exit 0 {ok, codex:{counts, codexPath, baseOnly?, resolutionOnly?, fromState?}, reviewer, arbiter?}   arbiter: the JSON of `arbiter needed --pr N --round R` verbatim, run once when reviewer is fable and the round has no arbiter record',
    '     (with an arbiter record: arbiterState:{recorded, proofOk}; `arbiter needed` is not a read, so it is not called again)',
    '  -> a failed `arbiter needed` (non-zero exit or no JSON): {ok:false, step:"arbiter-needed", error, result:<its JSON>, codex, reviewer} with the step\'s exit code (error copied from the child; same shape as round publish), e.g. stale-terminal with restartRequired',
    '  -> exit 0 {ok, state:"running", next:"rerun round codex"}: still running after M minutes; the same command adopts the same job',
    '  -> exit 1 {ok:false, error:"parent-gone", next:"rerun round codex"}: the process that started the command (read when it began) was gone before the job was started: nothing was started; gone later: the same with state:"running", the job keeps running',
    '  -> a refusal or failure of a step is that step\'s JSON, unchanged, with its exit code (codex-review --plan, job start, codex-review: empty-range, base-mismatch, head-moved, round-cap, exit 3 unavailable / substitute …);',
    '     update-in-progress adds next:"rerun in a minute"; a job that was replaced by a newer run: {state:"replaced", next:"reconcile"} (never discard-round on its own); lost / missing: the job JSON',
    '  identity (before anything runs, and again before the result and the arbiter call): no .review/state.json is fine for round 1; else its pr must be N and R the next round, else exit 1 identity-mismatch',
    '  --base / --head default to what codex-review admits: the head is the checked-out HEAD, the base the previous round\'s toHead (round 1 or a whole-PR round: the merge base with the PR\'s real base branch, read from GitHub)',
    '  the Codex run is the job codex-rR tagged <pr>:<R>:<base>:<head>: the same tag running is adopted (no second start), another tag running is exit 1 job-conflict',
    '  the result is read from the job\'s whole stdout; when that is missing (an older runner) or was cut, and the state records round R, the report is built from the state, else {next:"job read"}',
    '  a round already recorded picks up a job codex-rR only when its tag\'s base:head are the recorded round\'s fromHead:toHead (a job left by a discarded round is never used: exit 1 identity-mismatch);',
    '     a job that ended non-zero while the state already records round R (round recorded another way, e.g. substitute apply) reports from the state ({codex:{fromState:true}}), not the failure JSON',
    '  the command exits early when the process that started it is gone (the job keeps running; rerun it)',
    'pipeline round publish --pr N --round R [--repo DIR]',
    '  -> exit 0 {ok, accepted:{ids, path, count}, followups:[{id, issue}], held:[ids], warnings, outcome}; outcome is `state outcome` verbatim, needsHuman included (published first, then read)',
    '  steps, in order: comment --pr N --kind triage · followups create --round R · comment --pr N --kind triage · state show --round R --accepted · state outcome',
    '  identity: .review/state.json is for PR N and records round R, else exit 1 identity-mismatch before anything runs',
    '  the first failing step stops it: {ok:false, step, ran:[steps done], error, result:<that step\'s JSON>} with that step\'s exit code; every step is repeat-safe, so the recovery is to run it again',
  ].join('\n'),
};

// The doc a `next` that is not an action points at (path under skills/review/): printed as `doc`. test/docs-facts.test.mjs checks every one exists.
export const ROUND_DOCS = Object.freeze(['reference/special-rounds.md']);
const SPECIAL = ROUND_DOCS[0];
export const DEFAULT_MAX_MINUTES = 60;
export const MAX_MAX_MINUTES = 120;
const POLL_MS = 1000;
const BIN = fileURLToPath(new URL('../bin/pipeline.mjs', import.meta.url));

// One step: the pipeline CLI as a child process (its own lease, lock and JSON). -> { code, json, stdout, stderr }.
function step(root, args, ctx) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd: root, env: ctx?.env ?? process.env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  return { code: r.status ?? EXIT.FAILED, ...parseJson(r.stdout), stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function parseJson(text) {
  try {
    const json = JSON.parse(text);
    return { json: json !== null && typeof json === 'object' ? json : null };
  } catch {
    return { json: null };
  }
}

const identityMismatch = (message, extra = {}) => new Fail(EXIT.FAILED, { ok: false, error: 'identity-mismatch', message, ...extra });

// The review state on disk, or null; one that cannot be read is exit 2 `state`, never "none".
function readState(root) {
  try {
    return loadState(root, { cleanup: false });
  } catch (err) {
    throw new Fail(EXIT.USAGE, { ok: false, error: 'state', message: err.message });
  }
}

// The same admission review-round.mjs#checkRound applies, with the answer shaped for the controller. `mayBeRecorded`: round R may already be in the
// state (a finished job being picked up); otherwise R must be the next round. -> { state, recorded }.
function checkIdentity(root, pr, round, { mayBeRecorded = false } = {}) {
  const state = readState(root);
  if (state && state.pr !== pr) {
    throw identityMismatch(`.review/state.json belongs to PR #${state.pr}, not #${pr}: nothing was run`);
  }
  const recorded = state?.rounds.some((r) => r.n === round) === true;
  if (recorded && !mayBeRecorded) {
    throw identityMismatch(`round ${round} is already recorded in the review state: nothing was run`);
  }
  const expected = (state?.rounds.length ?? 0) + 1;
  if (!recorded && round !== expected) {
    throw identityMismatch(`the next round is ${expected}, not ${round}: nothing was run`);
  }
  return { state, recorded };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// round codex
// ---------------------------------------------------------------------------------------------------------------------------------------------

// Is the process that started this command still there? (ppid changes when a parent dies and the process is adopted.)
function parentWatcher() {
  const ppid = process.ppid;
  return () => {
    if (process.ppid !== ppid) return true;
    try {
      process.kill(ppid, 0);
      return false;
    } catch (err) {
      return err.code !== 'EPERM';
    }
  };
}

const countsFromState = (round) => {
  const own = round.items.filter((i) => i.source !== 'fable');
  const n = (bucket) => own.filter((i) => i.bucket === bucket).length;
  return { blocking: n('BLOCKING'), suggestions: n('SUGGESTION'), worth_considering: n('WORTH_CONSIDERING') };
};

// What the controller reads of a recorded round when the job's own output cannot be used.
function reportFromState(root, state, round) {
  const r = state.rounds.find((x) => x.n === round);
  return {
    ok: true,
    codex: {
      counts: countsFromState(r), codexPath: roundDir(root, round), fromState: true,
      ...(r.baseOnly ? { baseOnly: true } : {}), ...(r.resolutionOnly ? { resolutionOnly: true } : {}),
    },
    reviewer: state.reviewer,
  };
}

function reportFromOutput(json) {
  return {
    ok: true,
    codex: {
      counts: json.counts, codexPath: json.path,
      ...(json.baseOnly ? { baseOnly: true } : {}), ...(json.resolutionOnly ? { resolutionOnly: true } : {}),
    },
    reviewer: json.reviewer,
    ...(Array.isArray(json.warnings) && json.warnings.length > 0 ? { warnings: json.warnings } : {}),
  };
}

// PIPELINE_ROUND_HOLD_AFTER_PLAN=<file>: test seam (checkout only, lib/seams.mjs). After the plan step the command writes <file>.reached, then waits (60 s at most)
// until <file> exists, so a test can end the parent process at a known point of the command.
async function holdAfterPlan(ctx) {
  const file = seamValue('PIPELINE_ROUND_HOLD_AFTER_PLAN', ctx?.env ?? process.env);
  if (file === undefined) return;
  writeFileAtomic(`${file}.reached`, 'reached\n');
  const end = Date.now() + 60_000;
  while (!existsSync(file) && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 50));
}

const fullSha = (ref, root) => revParse(`${ref}^{commit}`, { cwd: root });

async function roundCodex(rest, ctx) {
  const { values } = parseCommandArgs(rest, {
    pr: { type: 'string' }, round: { type: 'string' }, base: { type: 'string' }, head: { type: 'string' },
    'max-minutes': { type: 'string' }, repo: { type: 'string' },
  }, { allowPositionals: false });
  const pr = intOption(values, 'pr', { required: true, min: 1 });
  const round = intOption(values, 'round', { required: true, min: 1 });
  const maxMinutes = intOption(values, 'max-minutes', { min: 1, max: MAX_MAX_MINUTES }) ?? DEFAULT_MAX_MINUTES;
  // The parent is captured HERE, before any step runs: under load the steps below can outlast it, and a parent read later is the adoptive one.
  const gone = parentWatcher();
  const root = resolveRepo(values, ctx);
  const { config } = await requireConfig(root);
  const name = `codex-r${round}`;
  const prefix = `${pr}:${round}:`;

  // Phase 1: may this round be run (or picked up) at all?
  const { state: before, recorded } = checkIdentity(root, pr, round, { mayBeRecorded: true });
  const existing = readJob(name, { cwd: root });
  let runId;

  if (recorded) {
    // The round is in the state: only a finished or running job of THIS round is picked up (a rerun after the waiter was lost); nothing is started.
    // "Of this round" is the recorded range: a job left by a round that was discarded and run again (or recorded another way) carries another base:head.
    const recordedRound = before.rounds.find((r) => r.n === round);
    const tagParts = String(existing.tag ?? '').split(':');
    const sameRange = tagParts.length === 4 && tagParts[2] === recordedRound.fromHead && tagParts[3] === recordedRound.toHead;
    if (!['running', 'done'].includes(existing.state) || !String(existing.tag ?? '').startsWith(prefix) || !sameRange) {
      throw identityMismatch(`round ${round} is already recorded in the review state and no job ${name} of this round (base:head as recorded) is there to pick up: nothing was run`);
    }
    for (const [flag, at] of [['base', 2], ['head', 3]]) {
      if (values[flag] !== undefined && fullSha(values[flag], root) !== existing.tag.split(':')[at]) {
        throw new Fail(EXIT.FAILED, { ok: false, error: 'job-conflict', message: `job ${name} ran with another --${flag} (tag ${existing.tag})`, tag: existing.tag, runId: existing.runId });
      }
    }
    runId = existing.runId;
  } else {
    let base = values.base;
    let head = values.head;
    if (base === undefined || head === undefined) {
      const dflt = defaultRoundRange({ root, config, ctx, pr, state: before });
      base ??= dflt.base;
      head ??= dflt.head;
    }
    base = fullSha(base, root);
    head = fullSha(head, root);
    const tag = `${prefix}${base}:${head}`;

    if (existing.state === 'running') {
      if (existing.tag !== tag) {
        throw new Fail(EXIT.FAILED, {
          ok: false, error: 'job-conflict', tag: existing.tag, runId: existing.runId,
          message: `job ${name} is already running with another tag (${existing.tag}), this call is for ${tag}: wait for it with \`job wait ${name} --run-id ${existing.runId}\` or let it finish; nothing was started`,
        });
      }
      runId = existing.runId; // a lost response of an earlier call: the job is ours
    } else {
      const common = ['--pr', String(pr), '--round', String(round), '--base', base, '--head', head];
      const plan = step(root, ['codex-review', ...common, '--plan'], ctx);
      if (plan.code !== EXIT.OK) return passThrough(plan);
      await holdAfterPlan(ctx);
      // The process that started this command is already gone: start nothing (a job started now would have no waiter; the rerun starts it).
      if (gone()) return { exitCode: EXIT.FAILED, output: { ok: false, error: 'parent-gone', next: 'rerun round codex', message: 'the process that started this command is gone: no job was started' } };
      const effort = plan.json?.expectedEffort;
      if (typeof effort !== 'string') {
        return { exitCode: EXIT.FAILED, output: { ok: false, error: 'plan-unreadable', message: 'codex-review --plan printed no expectedEffort', stdout: plan.stdout.slice(0, 2000) } };
      }
      const started = step(root, ['job', 'start', '--tag', tag, name, '--', 'node', BIN, 'codex-review', ...common, '--effort', effort], ctx);
      if (started.code !== EXIT.OK || typeof started.json?.runId !== 'string') {
        // Lost a race with another start of the same job: it is ours when the tag is.
        const again = readJob(name, { cwd: root });
        if (!(started.json?.error === 'already-running' && again.state === 'running' && again.tag === tag)) return passThrough(started);
        runId = again.runId;
      } else {
        runId = started.json.runId;
      }
    }
  }

  // Phase 2: wait. Only this call's own parent ending (or the limit) ends it early; the job keeps running either way.
  // PIPELINE_ROUND_WAIT_MS / PIPELINE_ROUND_POLL_MS: test seams (checkout only, lib/seams.mjs): a wait limit and a poll interval in milliseconds.
  const seamMs = (varName) => {
    const n = Number(seamValue(varName, ctx?.env ?? process.env));
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  const snap = await waitJob(name, {
    cwd: root, timeoutMs: seamMs('PIPELINE_ROUND_WAIT_MS') ?? maxMinutes * 60_000, pollMs: seamMs('PIPELINE_ROUND_POLL_MS') ?? POLL_MS, expectRunId: runId, full: true, shouldStop: gone,
  });
  const jobInfo = { name, runId, ...(snap.tag === undefined ? {} : { tag: snap.tag }) };
  if (snap.state === 'running') {
    if (snap.stopped) {
      return { exitCode: EXIT.FAILED, output: { ok: false, error: 'parent-gone', state: 'running', ...jobInfo, next: 'rerun round codex' } };
    }
    return { exitCode: EXIT.OK, output: { ok: true, state: 'running', ...jobInfo, elapsedMs: snap.elapsedMs, next: 'rerun round codex' } };
  }
  if (snap.state === 'replaced') {
    return { exitCode: EXIT.FAILED, output: { ok: false, state: 'replaced', ...jobInfo, next: 'reconcile', doc: SPECIAL, message: `job ${name} now belongs to another run: another session may own this round; reconcile, never discard the round on this alone` } };
  }
  if (snap.state === 'lost' || snap.state === 'missing') {
    return { exitCode: snap.state === 'missing' ? EXIT.USAGE : EXIT.FAILED, output: { ok: false, ...jobInfo, ...snap, doc: SPECIAL } };
  }
  return finish({ root, ctx, pr, round, snap, jobInfo });
}

// A step that did not succeed: its own JSON and exit code, unchanged (what the controller's table of exits keys on). No JSON at all is said so.
function passThrough(r) {
  if (r.json !== null) return { exitCode: r.code, output: r.json };
  return { exitCode: r.code === EXIT.OK ? EXIT.FAILED : r.code, output: { ok: false, error: 'no-json', exitCode: r.code, message: 'the step printed no JSON', stdout: r.stdout.slice(0, 2000), stderr: r.stderr.slice(0, 2000) } };
}

// The job is done: what it printed decides, keyed on the JSON's `error`, not on the exit number alone (exit 2 is also usage, a crash, a lease that
// could not be taken).
async function finish({ root, ctx, pr, round, snap, jobInfo }) {
  const usable = typeof snap.output === 'string' && snap.outputTruncated !== true;
  const json = usable ? parseJson(snap.output).json : null;

  if (snap.exitCode !== 0) {
    // A failed job does not record a round: a recorded round R was recorded another way (the substitute path), so the state answers, not the failure.
    const recordedState = readState(root);
    if (recordedState && recordedState.pr === pr && recordedState.rounds.some((r) => r.n === round)) {
      return finishFromState({ root, ctx, pr, round, state: recordedState, report: reportFromState(root, recordedState, round) });
    }
    if (json === null) {
      return {
        exitCode: snap.exitCode === EXIT.USAGE || snap.exitCode === EXIT.UNAVAILABLE ? snap.exitCode : EXIT.FAILED,
        output: { ok: false, error: 'codex-no-json', ...jobInfo, exitCode: snap.exitCode, next: 'job read', doc: SPECIAL, tail: snap.tail },
      };
    }
    return { exitCode: snap.exitCode, output: json.error === 'update-in-progress' ? { ...json, next: 'rerun in a minute' } : json };
  }

  // Exit 0. Phase 3: the round must be in this PR's state (fail closed); then report from the job's output, else from the state.
  const { state } = checkIdentity(root, pr, round, { mayBeRecorded: true });
  const inState = state?.rounds.some((r) => r.n === round) === true;
  let report;
  if (json !== null && json.ok === true && json.counts !== undefined) {
    if (!inState) throw identityMismatch(`the job reports round ${round} recorded, but the review state does not hold it: run \`state show --pr ${pr}\``, { job: jobInfo });
    report = reportFromOutput(json);
  } else if (inState) {
    report = reportFromState(root, state, round);
  } else {
    return { exitCode: EXIT.FAILED, output: { ok: false, error: 'result-unavailable', ...jobInfo, next: 'job read', doc: SPECIAL, message: `job ${jobInfo.name} finished with exit 0 but its output is missing or cut, and the review state does not hold round ${round}`, tail: snap.tail } };
  }

  return finishFromState({ root, ctx, pr, round, state, report });
}

// The report is built; a Fable round with no arbiter record also gets `arbiter needed`.
function finishFromState({ root, ctx, pr, round, state, report }) {
  if (report.reviewer !== 'fable') return { exitCode: EXIT.OK, output: report };
  const roundRecord = state.rounds.find((r) => r.n === round);
  if (roundRecord.arbiter !== undefined && roundRecord.arbiter !== null) {
    // `arbiter needed` is not a read: it clears unproven / malfunction finals. With a record the controller follows the skill.
    return { exitCode: EXIT.OK, output: { ...report, arbiterState: { recorded: true, proofOk: roundRecord.arbiter.proofOk ?? null } } };
  }
  const needed = step(root, ['arbiter', 'needed', '--pr', String(pr), '--round', String(round)], ctx);
  if (needed.code !== EXIT.OK || needed.json === null) {
    // Same shape as round publish: the step that failed, its error, its JSON; the exit code is the step's.
    const result = needed.json ?? { ok: false, error: 'no-json', stdout: needed.stdout.slice(0, 2000), stderr: needed.stderr.slice(0, 2000) };
    return { exitCode: needed.code === EXIT.OK ? EXIT.FAILED : needed.code, output: { ...report, ok: false, step: 'arbiter-needed', ...(typeof result.error === 'string' ? { error: result.error } : {}), result } };
  }
  return { exitCode: EXIT.OK, output: { ...report, arbiter: needed.json } };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// round publish
// ---------------------------------------------------------------------------------------------------------------------------------------------

// The publish steps, in the skill's order (publish first, outcome after). `state show` takes NO --pr: with it the command reaches GitHub and can quarantine .review/.
export const publishSteps = (pr, round) => [
  ['comment', ['comment', '--pr', String(pr), '--kind', 'triage']],
  ['followups', ['followups', 'create', '--round', String(round)]],
  ['comment-links', ['comment', '--pr', String(pr), '--kind', 'triage']],
  ['accepted', ['state', 'show', '--round', String(round), '--accepted']],
  ['outcome', ['state', 'outcome']],
];

async function roundPublish(rest, ctx) {
  const { values } = parseCommandArgs(rest, { pr: { type: 'string' }, round: { type: 'string' }, repo: { type: 'string' } }, { allowPositionals: false });
  const pr = intOption(values, 'pr', { required: true, min: 1 });
  const round = intOption(values, 'round', { required: true, min: 1 });
  const root = resolveRepo(values, ctx);

  const state = readState(root);
  if (!state) throw identityMismatch(`there is no review state here, so round ${round} of PR #${pr} cannot be published: nothing was run`);
  checkIdentity(root, pr, round, { mayBeRecorded: true });
  if (!state.rounds.some((r) => r.n === round)) throw identityMismatch(`round ${round} is not recorded in the review state: nothing was run`);

  const steps = publishSteps(pr, round);
  const ran = [];
  const results = {};
  for (const [id, args] of steps) {
    const r = step(root, args, ctx);
    if (r.code !== EXIT.OK) {
      const result = r.json ?? { ok: false, error: 'no-json', stdout: r.stdout.slice(0, 2000), stderr: r.stderr.slice(0, 2000) };
      return { exitCode: r.code === EXIT.OK ? EXIT.FAILED : r.code, output: { ok: false, step: id, ran, ...(typeof result.error === 'string' ? { error: result.error } : {}), result } };
    }
    if (r.json === null) {
      return { exitCode: EXIT.FAILED, output: { ok: false, step: id, ran, error: 'no-json', result: { ok: false, error: 'no-json', stdout: r.stdout.slice(0, 2000) } } };
    }
    results[id] = r.json;
    ran.push(id);
  }

  const items = Array.isArray(results.accepted.items) ? results.accepted.items : [];
  ensureRoundDir(root, round);
  const file = path.join(roundDir(root, round), 'accepted.json');
  writeFileAtomic(file, `${JSON.stringify(results.accepted, null, 2)}\n`);

  // The issue links come from the state the follow-up step just wrote (created, reused and skipped alike).
  const after = readState(root);
  const followups = (after?.rounds.find((r) => r.n === round)?.items ?? [])
    .filter((i) => i.final?.decision === 'FOLLOW-UP' && typeof i.followupIssue === 'string')
    .map((i) => ({ id: i.id, issue: i.followupIssue }));
  const warnings = ['comment', 'followups', 'comment-links', 'accepted'].flatMap((id) => (Array.isArray(results[id].warnings) ? results[id].warnings : []));
  return {
    exitCode: EXIT.OK,
    output: {
      ok: true,
      accepted: { ids: items.map((i) => i.id), path: file, count: results.accepted.count ?? items.length },
      followups,
      held: Array.isArray(results.followups.held) ? results.followups.held : [],
      warnings,
      outcome: results.outcome,
    },
  };
}

export const run = guarded(async (argv, ctx) => {
  const [sub, ...rest] = argv;
  if (sub === 'codex') return roundCodex(rest, ctx);
  if (sub === 'publish') return roundPublish(rest, ctx);
  throw new UsageError('usage: pipeline round (codex --pr N --round R [--base B] [--head H] [--max-minutes M] | publish --pr N --round R)');
});
