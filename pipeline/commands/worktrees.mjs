// `pipeline worktrees`: remove finished worktrees safely (prune), protect one with a keep-lock (keep / unkeep), and look
// at or purge the holding folder where removed worktrees' evidence waits 30 days (holding). Spec:
// docs/specs/2026-10-13-worktree-prune-design.md. One `worktrees.mode` setting governs every mutation: `report` (the
// default) and `off` change nothing, `--dry-run` never changes anything; keep-locks only protect, so they work in every
// mode. The prune flow lives in lib/worktree-prune/run.mjs. Exit 0 completed (skips are normal), 2 usage / repo / config,
// 3 GitHub unavailable.
import path from 'node:path';
import { EXIT, UsageError, parseCommandArgs } from '../lib/cli.mjs';
import { Fail, guarded } from '../lib/cmd-common.mjs';
import { git } from '../lib/git.mjs';
import { listWorktrees } from '../lib/local-branches.mjs';
import { samePath } from '../lib/paths.mjs';
import { holdingRoot, listHolding, purgeHolding } from '../lib/worktree-prune/act.mjs';
import { modeAllows } from '../lib/worktree-prune/rules.mjs';
import { loadRepo, prune } from '../lib/worktree-prune/run.mjs';

export const meta = {
  summary: 'remove finished worktrees (prune), keep one with a lock (keep / unkeep), list or purge the holding folder',
  usage: [
    'pipeline worktrees prune [--repo DIR] [--dry-run] [--notify]   -> {ok, mode, removed:[...], wouldRemove:[...], kept:[...], restored:[...], outside:[...], holding:{batches, purged}}',
    'pipeline worktrees keep NAME [--reason TEXT] [--repo DIR]   -> {ok, slug, locked}',
    'pipeline worktrees unkeep NAME [--run ID] [--repo DIR]   -> {ok, slug, unlocked}',
    'pipeline worktrees holding [--purge] [--repo DIR]   -> {ok, batches:[...], purged:[...]}',
  ].join('\n'),
};

export const KEEP_PREFIX = 'pipeline-keep:';
const SUBS = 'prune [--dry-run] [--notify] | keep NAME [--reason TEXT] | unkeep NAME [--run ID] | holding [--purge]';

// NAME is a direct child of <root>/<worktree_dir>: no separators, no dot-names (the quarantine), no control characters.
function findWorktree(repo, positionals, sub) {
  if (positionals.length !== 1) throw new UsageError(`worktrees ${sub} takes exactly one NAME`);
  const [name] = positionals;
  if (!/^[^/\\.\x00-\x1f][^/\\\x00-\x1f]*$/.test(name)) throw new UsageError(`not a worktree name: ${JSON.stringify(name)}`);
  const target = path.join(repo.root, repo.worktreeDir, name);
  const entry = listWorktrees(repo.root).find((e) => samePath(e.path, target));
  if (!entry) throw new Fail(EXIT.USAGE, { ok: false, error: 'no-such-worktree', message: `no worktree at ${target}` });
  return { name, entry };
}

async function keep(rest, ctx) {
  const { values, positionals } = parseCommandArgs(rest, { repo: { type: 'string' }, reason: { type: 'string' } });
  const text = values.reason?.trim() || 'kept by hand';
  if (/[\x00-\x1f]/.test(text)) throw new UsageError('--reason must be one line');
  const repo = await loadRepo(values, ctx);
  const { name, entry } = findWorktree(repo, positionals, 'keep');
  if (!modeAllows(repo.w.mode, 'keep-lock')) return { exitCode: EXIT.OK, output: { ok: true, slug: name, locked: false, reason: 'keep locks are disabled' } };
  if (entry.locked !== null && !entry.locked.startsWith(KEEP_PREFIX)) {
    return { exitCode: EXIT.OK, output: { ok: true, slug: name, locked: false, reason: 'already locked by someone else' } };
  }
  const reason = `${KEEP_PREFIX} ${text}`;
  if (entry.locked !== null) git(['worktree', 'unlock', entry.path], { cwd: repo.root }); // refresh our own reason
  git(['worktree', 'lock', '--reason', reason, entry.path], { cwd: repo.root });
  return { exitCode: EXIT.OK, output: { ok: true, slug: name, locked: true, reason } };
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Releases only a pipeline-keep lock, and with --run only the one carrying "ship run <ID>" (spec §2 "Locks").
async function unkeep(rest, ctx) {
  const { values, positionals } = parseCommandArgs(rest, { repo: { type: 'string' }, run: { type: 'string' } });
  if (values.run !== undefined && values.run.trim() === '') throw new UsageError('--run must not be empty');
  const repo = await loadRepo(values, ctx);
  const { name, entry } = findWorktree(repo, positionals, 'unkeep');
  const no = (reason) => ({ exitCode: EXIT.OK, output: { ok: true, slug: name, unlocked: false, reason } });
  if (entry.locked === null) return no('not locked');
  if (!entry.locked.startsWith(KEEP_PREFIX)) return no(`locked by someone else (${entry.locked || 'no reason given'})`);
  if (values.run !== undefined && !new RegExp(`ship run ${escapeRe(values.run.trim())}(?![A-Za-z0-9_-])`).test(entry.locked)) {
    return no(`the keep lock belongs to another run (${entry.locked})`);
  }
  git(['worktree', 'unlock', entry.path], { cwd: repo.root });
  return { exitCode: EXIT.OK, output: { ok: true, slug: name, unlocked: true } };
}

async function holding(rest, ctx) {
  const { values, positionals } = parseCommandArgs(rest, { repo: { type: 'string' }, purge: { type: 'boolean' } });
  if (positionals.length) throw new UsageError('worktrees holding takes no NAME');
  const env = ctx?.env ?? process.env;
  const repo = await loadRepo(values, ctx);
  const dir = holdingRoot(repo.slug, env);
  const output = { ok: true, dir, batches: [], purged: [] };
  if (values.purge) {
    if (modeAllows(repo.w.mode, 'purge')) {
      const r = purgeHolding(dir, { nowMs: Date.now() });
      output.purged = r.purged;
      output.keptBatches = r.kept;
    } else output.note = 'purge needs mode: on';
  }
  output.batches = listHolding(dir);
  return { exitCode: EXIT.OK, output };
}

export const run = guarded(async (argv, ctx) => {
  const [sub, ...rest] = argv;
  if (sub === 'prune') {
    const { values, positionals } = parseCommandArgs(rest, { repo: { type: 'string' }, 'dry-run': { type: 'boolean' }, notify: { type: 'boolean' } });
    if (positionals.length) throw new UsageError('worktrees prune takes no NAME');
    return prune(values, ctx);
  }
  if (sub === 'keep') return keep(rest, ctx);
  if (sub === 'unkeep') return unkeep(rest, ctx);
  if (sub === 'holding') return holding(rest, ctx);
  throw new UsageError(`usage: pipeline worktrees (${SUBS})`);
});
