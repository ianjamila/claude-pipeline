// Wiring of the review leases (lib/review-lease.mjs, plan 2026-11-10 B1 "Lifecycle") into the CLI: which commands hold a lease and what a lease error
// does to them. ONE call site, bin/pipeline.mjs#main: it takes the lease just before a leased command's run() and closes it just after a stop, so
// no command (and no later command someone adds to LEASED_COMMANDS) calls the library itself.
//
// WHICH COMMANDS. Every command that reads or writes a worktree's review state or the run that goes with it: the review loop (codex-review, triage,
// arbiter, state, comment, followups, review-complete, verify), the gate and merge steps (final-gate, merge, merge-hold, update-branch, ci-wait, smoke),
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
// written by then, so a review's state stays exactly as it was. A plain terminal (no Claude Code session) gets { skipped: 'no-session' } and proceeds silently.
//
// CLOSING. `P summary` (the stop ritual) closes the lease after it succeeds; `P checkpoint` does when the run record it wrote says step `ended` (the only
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

export const LEASED_COMMANDS = new Set([
  'agent-log', 'arbiter', 'checkpoint', 'ci-wait', 'codex-review', 'comment', 'cost', 'final-gate', 'followups', 'job', 'merge', 'merge-hold',
  'review-complete', 'smoke', 'state', 'summary', 'triage', 'update-branch', 'verify',
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
    const result = await openOrRenewLease({ worktree: root, repoId: repoLockKey(root), ...(pr !== undefined ? { pr } : { branch }), env, ...(waitMs >= 0 ? { waitMs } : {}) });
    if (result.skipped) return { held: null };
    return { held: { worktree: root, generation: result.generation, action: result.action } };
  } catch (err) {
    return { failure: failureOf(err) };
  }
}

// After the command ran: close the lease when this command's result ended the review.
export async function settleReviewLease(name, result, held, ctx = {}) {
  if (!held || !CLOSES[name]?.(result)) return;
  try {
    const { closeLease } = await import('./review-lease.mjs');
    await closeLease({ worktree: held.worktree, generation: held.generation, env: ctx.env ?? process.env });
  } catch (err) {
    process.stderr.write(`pipeline: could not close this session's review lease (${err?.message ?? err}); it expires by itself\n`);
  }
}
