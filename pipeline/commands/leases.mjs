// Shows what the review-lease folder says is running: the leases that keep `pipeline update` waiting (live), the files nobody can read (they count as live too),
// and with --all the dead leases the next sweep will remove. Read only: it takes no lease of its own (it is not a leased command), writes nothing and sweeps
// nothing. The judgement is scanLeases'; a lease marked `unchecked` could not be proven alive or dead and carries a `hint` (usually the file to delete once no
// pipeline command is running in a terminal). `--repo DIR` keeps only the leases inside that repository's worktrees (git worktree list); unreadable files stay,
// because their worktree is unknown. Exit 0 scanned, 1 the scan itself failed, 2 usage.
import path from 'node:path';
import { EXIT, parseCommandArgs } from '../lib/cli.mjs';
import { Fail, guarded, resolveRepo } from '../lib/cmd-common.mjs';
import { listWorktrees } from '../lib/local-branches.mjs';
import { canonicalPath, isInside } from '../lib/paths.mjs';
import { scanLeases } from '../lib/review-lease.mjs';

export const meta = {
  summary: 'show the review leases that keep an update waiting (live, unreadable; --all adds the dead ones), read only',
  usage: 'pipeline leases [--all] [--repo DIR]   -> {ok, live:[{holder, sessionId, worktree, repoId, pr|branch, command?, pid?, openedAt, renewedAt, why, unchecked?, hint?}], unreadable:[{sessionId, file, why, unchecked?, hint?}], dead?:[...]}   read only; exit 1 {ok:false, error:"scan-failed", message} when the folder cannot be scanned',
};

// The public shape of one lease: the library's entry without its internal generation.
const shown = ({ generation, ...entry }) => entry;

export const run = guarded(async (argv, ctx) => {
  const { values } = parseCommandArgs(argv, { all: { type: 'boolean' }, repo: { type: 'string' } }, { allowPositionals: false });
  let trees = null;
  if (values.repo !== undefined) {
    const root = resolveRepo(values, ctx);
    try { trees = listWorktrees(root).map((w) => canonicalPath(w.path)); } catch (err) {
      throw new Fail(EXIT.USAGE, { ok: false, error: 'git', message: `cannot list the worktrees of ${root}: ${err.message}` });
    }
  }
  let scan;
  try {
    scan = scanLeases({ env: ctx?.env ?? process.env, ...(ctx?.leaseOpts ?? {}) });
  } catch (err) {
    return { exitCode: EXIT.FAILED, output: { ok: false, error: 'scan-failed', message: `cannot scan the review lease folder: ${err?.message ?? err}` } };
  }
  const keep = (e) => trees === null || (typeof e.worktree === 'string' && trees.some((t) => isInside(canonicalPath(path.resolve(e.worktree)), t)));
  const output = { ok: true, live: scan.live.filter(keep).map(shown), unreadable: scan.unreadable };
  if (values.all) output.dead = scan.dead.filter(keep).map(shown);
  return { exitCode: EXIT.OK, output };
});
