// Wiring of the review leases (lib/review-lease.mjs, plan 2026-11-10 B1 "Lifecycle") into the CLI: which commands hold a lease and what a lease error
// does to them. ONE call site, bin/pipeline.mjs#main: it takes the lease just before a leased command's run() and closes it just after a stop, so
// no command (and no later command someone adds to LEASED_COMMANDS) calls the library itself.
//
// WHICH COMMANDS. Every command that reads or writes a worktree's review state or the run that goes with it: the review loop (codex-review, triage,
// arbiter, state, comment, followups, review-complete, verify), the gate and merge steps (final-gate, merge, merge-hold, redraft, update-branch, ci-wait, smoke),
// the run record (checkpoint, cost, summary, agent-log) and the detached jobs (job). A lease is opened-or-renewed by each of them (renew opens when
// absent, so a review begun on an older install gets one at its next command). NOT leased: commands that only compute or only talk to the machine
// (preflight, config, labels, update, version, vendor, model-floor, model-proof, risk, hardstops, integrity, queue-sweep, stacks, worktrees, protect,
// repo-move, guard-log, artifacts): they never read a worktree's review state, so they neither keep an update away nor wait for one.
//
// ORDER (the lock order of B1): admission (taken briefly INSIDE openOrRenewLease and released before it returns) -> the per-PR state lock -> model-floor.
// Because the lease is taken here, before mod.run(), a command never holds the state lock (or the floor) while it waits for admission: the installer,
// which holds admission across its scan and swap, can therefore never wait on a review that waits on it. test/review-lease-wiring.test.mjs pins it.
//
// WHICH LEASE. The worktree is the repository top level of `--repo DIR` (default: the current directory), exactly what the command resolves itself. The
// PR is `--pr N`, else the PR named by the worktree's .review/state.json; with neither the lease is a BRANCH lease (the checked-out branch) and the first
// command that knows the PR turns it into the PR lease (same generation, review-lease.mjs). repoId is `repoLockKey(root)`, the repository identity the
// per-PR state lock already uses (the normalized origin remote, else the git common dir), so a lease and the lock of the same review name the same repo.
//
// ERRORS fail CLOSED: a command that cannot get its lease does not run (exit 2, one JSON object with a coded `error`): `update-in-progress` while an update holds
// admission past the wait ("retry in a minute"), `review-lease-unwritable` / `review-lease-busy` / anything else from the lease I/O. Nothing has been read or
// written by then, so a review's state stays exactly as it was.
//
// PLAIN TERMINALS. A command with no Claude Code session above it takes a PROCESS lease (plan 2026-11-12): the same admission, the same wait and refusal, a file
// of its own (proc-<pid>-<8 hex>) that lives only while the command runs. It is closed after EVERY command whatever the result (a usage error, a failure, a throw:
// bin/pipeline.mjs settles from a finally), by a synchronous 'exit' handler when the command leaves through process.exit, and by a signal handler for SIGINT /
// SIGTERM / SIGHUP that closes and then lets the signal kill the process as it would have without a lease (R4-2). Only SIGKILL (or a crash of the machine)
// leaves the file; the judge reads it dead once its pid is gone and the next terminal command's cleanup (or the installer's sweep) removes it. A detached
// `P job` still running at the close keeps the worktree covered through the shared job-<hash> file (review-lease.mjs closeLease).
//
// CLOSING (a session's lease). `P summary` (the stop ritual) closes the lease after it succeeds; `P checkpoint` does when the run record it wrote says step `ended` (the only
// two writers of an ended run, run-record.mjs). The close names the generation this very invocation just opened or renewed, so a lease that was reopened
// for other work since is left alone. A failed close is a stderr warning, never a changed result: ending a review must not fail because of a lease.
//
// TESTS. A repo checkout run under `node --test` (NODE_TEST_CONTEXT) with no PIPELINE_REVIEW_LEASE_DIR takes no lease: the existing suite spawns the real CLI
// hundreds of times, and inside a Claude Code session each would write a lease into the account's real folder (and make a real update defer). An installed
// copy never looks at that variable. The tests of this wiring set PIPELINE_REVIEW_LEASE_DIR, which turns leases on. PIPELINE_ADMISSION_WAIT_MS shortens
// the admission wait (checkout only, like PIPELINE_LOCK_WAIT_MS; it can only make a command give up sooner, which is the closed direction).
import path from 'node:path';
import { EXIT } from './cli.mjs';
import { isInstalledCopy, seamValue } from './seams.mjs';
import { claudeCodeAncestorPid } from './claude-ancestry.mjs';

export const LEASED_COMMANDS = new Set([
  'agent-log', 'arbiter', 'checkpoint', 'ci-wait', 'codex-review', 'comment', 'cost', 'final-gate', 'followups', 'job', 'merge', 'merge-hold',
  'redraft', 'review-complete', 'smoke', 'state', 'substitute', 'summary', 'triage', 'update-branch', 'verify',
]);
export const ADMISSION_WAIT_ENV = 'PIPELINE_ADMISSION_WAIT_MS';

// What ends the session's review for a leased command: its result decides (the run record is the source of truth for "ended").
const CLOSES = {
  summary: (result) => result.exitCode === EXIT.OK,
  checkpoint: (result) => result.exitCode === EXIT.OK && result.output?.record?.step === 'ended',
};

export const isLeasedCommand = (name) => LEASED_COMMANDS.has(name);

// `--repo DIR` and `--pr N` from the argv before any `--`, in both `--flag value` and `--flag=value` spelling. Lenient on purpose: a malformed value is
// the command's own usage error to report, not a reason to lose the lease.
export function leaseArgs(argv) {
  const own = argv.includes('--') ? argv.slice(0, argv.indexOf('--')) : argv;
  const out = {};
  for (let i = 0; i < own.length; i += 1) {
    for (const flag of ['repo', 'pr']) {
      if (own[i] === `--${flag}` && own[i + 1] !== undefined) out[flag] = own[i + 1];
      else if (own[i].startsWith(`--${flag}=`)) out[flag] = own[i].slice(flag.length + 3);
    }
  }
  return out;
}

const positiveInt = (v) => {
  const n = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v;
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
};

// true: this is a test run of a checkout that did not ask for leases (see TESTS above). `installed` is injectable for the unit test.
export function leasesOffForTests(env, installed = isInstalledCopy()) {
  if (installed) return false;
  const e = env ?? process.env;
  return Boolean(e.NODE_TEST_CONTEXT) && !e.PIPELINE_REVIEW_LEASE_DIR;
}

// The coded failure of a command that could not get its lease.
function failureOf(err) {
  const code = typeof err?.code === 'string' && (err.code === 'update-in-progress' || err.code.startsWith('review-lease')) ? err.code : 'review-lease';
  const message = code === 'update-in-progress'
    ? `${err.message}: this command was not run and nothing was changed`
    : `could not record this session's review lease (${err?.message ?? err}): this command was not run and nothing was changed; retry, or fix the lease folder`;
  return { exitCode: EXIT.USAGE, output: { ok: false, error: code, message } };
}

// ONE walk of the process tree per command. Finding the Claude Code ancestor costs one `ps` per hop on POSIX (milliseconds) and one PowerShell process-table query per walk on Windows (1-3 s), and the
// library asks for it at every step of a command: the early plain-terminal check, the take, the exit / signal close, the settle (and `job start`'s hand-off).
// So the wiring answers it once, lazily, and every step reuses that answer through `ancestorPid` (null, "no Claude ancestor", is an answer too). An
// `ancestorPid` the caller injected (the tests' seam) is left alone. The memo is published as `ctx.leaseAncestorPid` for the command's own run().
function withSharedAncestor(leaseOpts, ctx) {
  if (leaseOpts.ancestorPid !== undefined) return leaseOpts;
  let done = false;
  let answer = null;
  const ancestorPid = () => {
    if (!done) { answer = claudeCodeAncestorPid(leaseOpts.ancestry ?? {}); done = true; }
    return answer;
  };
  ctx.leaseAncestorPid = ancestorPid;
  return { ...leaseOpts, ancestorPid };
}

// Take (open or renew) the lease for `name`. -> { held: null | { worktree, generation, action } } or { failure: { exitCode, output } }.
export async function holdReviewLease(name, argv, ctx = {}) {
  if (!isLeasedCommand(name)) return { held: null };
  const env = ctx.env ?? process.env;
  if (leasesOffForTests(env)) return { held: null };
  let root;
  try {
    const { repoRoot } = await import('./repo.mjs');
    root = repoRoot(path.resolve(ctx.cwd ?? process.cwd(), leaseArgs(argv).repo ?? '.'));
  } catch {
    return { held: null }; // not a repository: the command reports that itself and has no review state to protect
  }
  try {
    const [{ openOrRenewLease }, { repoLockKey }] = await Promise.all([import('./review-lease.mjs'), import('./review-context.mjs')]);
    let pr = positiveInt(leaseArgs(argv).pr);
    if (pr === undefined) {
      try {
        const { loadState } = await import('./state.mjs');
        pr = positiveInt(loadState(root)?.pr);
      } catch { /* no readable state: a branch lease */ }
    }
    let branch;
    if (pr === undefined) {
      try {
        const { git } = await import('./git.mjs');
        branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root }).trim() || 'HEAD';
      } catch { branch = 'HEAD'; }
    }
    const rawWait = seamValue(ADMISSION_WAIT_ENV, env);
    const waitMs = rawWait === undefined ? NaN : Number(rawWait);
    const leaseOpts = withSharedAncestor(ctx.leaseOpts ?? {}, ctx); // in-process seams of the tests (an injected holder, ps ...); never from the environment
    // A plain terminal's exit / signal close is registered BEFORE the file is written (a signal between the write and a later registration would leave the file
    // behind). The generation is not known yet: until it is, the close takes this process's lease whatever its generation (the file is this process's own).
    const held = { worktree: root, generation: undefined, action: undefined, sessionId: undefined, process: false, leaseOpts, undo: () => {} };
    const { isProcessHolderCase } = await import('./review-lease.mjs');
    const early = isProcessHolderCase({ env, ...leaseOpts }) ? await registerExitClose(held, env) : null;
    let result;
    try {
      result = await openOrRenewLease({ worktree: root, repoId: repoLockKey(root), command: name, ...(pr !== undefined ? { pr } : { branch }), env, ...(waitMs >= 0 ? { waitMs } : {}), ...leaseOpts });
    } catch (err) {
      early?.();
      throw err;
    }
    if (result.skipped || !PROCESS_ID.test(result.sessionId)) early?.(); // no lease, or not a process lease after all: nothing to close on exit
    if (result.skipped) return { held: null };
    Object.assign(held, { generation: result.generation, action: result.action, sessionId: result.sessionId, process: PROCESS_ID.test(result.sessionId) });
    if (held.process) held.undo = early ?? (await registerExitClose(held, env));
    return { held };
  } catch (err) {
    return { failure: failureOf(err) };
  }
}

const PROCESS_ID = /^proc-[1-9][0-9]*-[0-9a-f]{8}$/;
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];

// The paths that skip bin/pipeline.mjs's finally (R4-2): an 'exit' listener (process.exit anywhere) and, for each of SIGINT / SIGTERM / SIGHUP that has NO listener
// yet, one that, only while it is the sole listener, closes synchronously, removes itself and re-raises the signal (default death, the same status as without a
// lease). When the command installed a handler of its own meanwhile (verify slot --run, hold.mjs installRestoreOnSignal) it does nothing: the command keeps running
// and keeps its lease, and ends it through process.exit (the 'exit' close) or main's finally. -> the function that unregisters them all (called only after a successful close).
async function registerExitClose(held, env) {
  const { closeLeaseSync } = await import('./review-lease.mjs');
  const close = () => {
    try { closeLeaseSync({ worktree: held.worktree, generation: held.generation, env, ...held.leaseOpts }); } catch { /* the file stays; its pid is gone, so the next sweep removes it */ }
  };
  const handlers = [];
  process.once('exit', close);
  handlers.push(['exit', close]);
  for (const sig of SIGNALS) {
    if (process.listenerCount(sig) > 0) continue;
    const onSignal = () => {
      if (process.listenerCount(sig) === 1 && process.listeners(sig)[0] === onSignal) {
        close();
        process.removeListener(sig, onSignal);
        process.kill(process.pid, sig);
      }
      // Another listener (verify slot --run forwards the signal to its child tree and waits; hold.mjs restores and exits) means the command keeps running: the
      // lease stays until that path ends the process (the 'exit' close) or main's finally settles it (R4-F1).
    };
    process.on(sig, onSignal);
    handlers.push([sig, onSignal]);
  }
  return () => { for (const [event, fn] of handlers) process.removeListener(event, fn); };
}

// After the command ran (or threw: `result` is undefined). A PROCESS lease is closed after EVERY command, whatever the result; then its exit / signal handlers are
// unregistered (only after a close that did not throw) and the dead proc- / job- files of earlier commands are swept, best effort. A session's lease is closed when
// this command's result ended the review (CLOSES). A failure is a stderr warning, never a changed result. Safe to call twice.
export async function settleReviewLease(name, result, held, ctx = {}) {
  if (!held || held.settled) return;
  const env = ctx.env ?? process.env;
  if (!held.process) {
    if (!result || !CLOSES[name]?.(result)) return;
    held.settled = true;
    try {
      const { closeLease } = await import('./review-lease.mjs');
      await closeLease({ worktree: held.worktree, generation: held.generation, env, ...held.leaseOpts });
    } catch (err) {
      process.stderr.write(`pipeline: could not close this session's review lease (${err?.message ?? err}); it expires by itself\n`);
    }
    return;
  }
  try {
    const { closeLease, sweepDeadLeases } = await import('./review-lease.mjs');
    await closeLease({ worktree: held.worktree, generation: held.generation, env, ...held.leaseOpts });
    held.settled = true;
    held.undo();
    try {
      await sweepDeadLeases({ env, ...held.leaseOpts, only: ['proc-', 'job-'] });
    } catch (err) {
      process.stderr.write(`pipeline: could not clean up finished review leases (${err?.message ?? err}); the next update does\n`);
    }
  } catch (err) {
    process.stderr.write(`pipeline: could not close this command's review lease (${err?.message ?? err}); it is removed once this process has ended\n`);
  }
}

// The command must not run (the install changed while it started): give back the lease just taken. A process lease always; a session's only when this very
// call opened it (a renewal belongs to the session's review and stays).
export async function releaseHeldLease(held, ctx = {}) {
  if (!held || held.settled) return;
  if (!held.process && held.action !== 'opened') { held.settled = true; return; }
  try {
    const { closeLease } = await import('./review-lease.mjs');
    await closeLease({ worktree: held.worktree, generation: held.generation, env: ctx.env ?? process.env, ...held.leaseOpts });
    held.settled = true;
    held.undo();
  } catch (err) {
    process.stderr.write(`pipeline: could not give back the review lease (${err?.message ?? err})\n`);
  }
}

// Fingerprint of the installed copy (the manifest the installer writes last), or null for a checkout / nothing readable. Cheap on purpose: it is read twice per
// leased command and must not hash the install (lib/identity.mjs installedIdentity does, for `version`). Two reads that differ mean an update ran in between.
export async function readInstalledStamp() {
  if (!isInstalledCopy()) return null;
  try {
    const [{ readManifest }, { pipelineRoot }] = await Promise.all([import('./installer.mjs'), import('./seams.mjs')]);
    const { manifest } = readManifest(path.dirname(pipelineRoot()));
    return manifest ? JSON.stringify(manifest) : 'unreadable';
  } catch { return 'unreadable'; }
}
