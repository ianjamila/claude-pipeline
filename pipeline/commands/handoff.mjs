// `pipeline handoff check --pr N [--post]`: the busy-main hand-off (cp #88). When main keeps moving, a PR whose own head is fully
// proven can be handed to the owner to merge in GitHub, with an honest comment about what was and was not verified. This command
// only DECIDES and (with --post) writes that one comment; it never merges and never touches the gate (the gate must fail ONLY
// `pr-open: behind-base`). Every fact is pinned to H = the gate's head and read live; any doubt is "not eligible" (exit 1).
import { randomBytes } from 'node:crypto';
import { existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EXIT, UsageError, parseCommandArgs, intOption } from '../lib/cli.mjs';
import { guarded, requireConfig, resolveRepo } from '../lib/cmd-common.mjs';
import { createGitHub, guardGh } from '../lib/github.mjs';
import { NETWORK_TIMEOUT_MS, diffFiles, git, headSha, mergeBase, mergeTree, revParse } from '../lib/git.mjs';
import { evaluateGate, tailLines } from '../lib/finalgate.mjs';
import { ciTestedBase, handoffEligibility, renderHandoffComment } from '../lib/handoff.mjs';
import { runShellAsync } from '../lib/proc.mjs';
import { VIEW_FIELDS, createRunRecorder } from '../lib/run-progress.mjs';
import { readSummaryComment } from '../lib/summary-comment.mjs';

export const meta = {
  summary: 'busy-main hand-off: decide whether a fully verified PR can be handed to the owner to merge in GitHub, and post the honest comment',
  usage: 'pipeline handoff check --pr N [--post] [--repo DIR]   -> exit 0 {ok, eligible: true, head, baseTip, ciBase, commits[{sha, subject, files}] (the newest 50), totalCommits, truncated, overlap[] (over the whole main range, not just the listed commits), ownerItems[], itemsChanged?, quickVerify{ok, exitCode, tail}, production, posted?{id, url}, warnings?}; exit 1 {ok: false, eligible: false, reasons[], head?, baseTip?, quickVerify?} (never an error: a missing fact is "not eligible"); 3 GitHub unavailable. Eligible = the run record holds >= 2 confirmed base updates (behindBaseUpdates), branch protection provably does NOT require up-to-date branches, the LIVE final gate fails ONLY pr-open behind-base, git merge-tree of the gate head with the base tip is clean, and verify.quick passes on that merge in a temporary worktree (removed afterwards; a failed condition skips the quick verify). Everything is pinned to the gate head. --post re-checks the PR head and the gate right before posting one hand-off comment (the final gate\'s owner items; itemsChanged: true when they differ from the first gate\'s) and records handoff {head, baseTip, at} in the run record; any change exits 1 "the PR changed during the check: run it again" and posts nothing. It never merges',
};

const QUICK_TIMEOUT_MS = 10 * 60_000;
const MAX_COMMITS = 50;
const IDENTITY = { GIT_AUTHOR_NAME: 'claude-pipeline', GIT_AUTHOR_EMAIL: 'pipeline@localhost', GIT_COMMITTER_NAME: 'claude-pipeline', GIT_COMMITTER_EMAIL: 'pipeline@localhost' };

const notEligible = (reasons, extra = {}) => ({ exitCode: EXIT.FAILED, output: { ok: false, eligible: false, reasons, ...extra } });
const firstLine = (err) => String(err?.message ?? err).split('\n')[0];

// strict: true / false from a readable protection; null = not provably off (403, 404, any failure).
function readStrict(gh, branch) {
  try {
    const p = gh.protection(branch);
    return p.status === 200 ? (p.json?.required_status_checks?.strict ?? false) : null;
  } catch {
    return null;
  }
}

// verify.quick on the prospective merge (head + base tip) in a throwaway detached worktree. The worktree is always removed.
async function quickVerifyOnMerge({ root, command, tree, head, baseTip, pr, env }) {
  const o = { cwd: root };
  const commit = git(['commit-tree', tree, '-p', head, '-p', baseTip, '-m', 'handoff check'], { ...o, env: IDENTITY }).trim();
  const tmp = join(tmpdir(), `cp-handoff-${pr}-${randomBytes(4).toString('hex')}`);
  try {
    git(['worktree', 'add', '--detach', tmp, commit], o);
    const modules = join(root, 'node_modules');
    if (existsSync(modules)) {
      try { symlinkSync(modules, join(tmp, 'node_modules'), 'junction'); } catch { /* the command then reports what it lacks */ }
    }
    const ran = await runShellAsync(command, { cwd: tmp, env, timeoutMs: QUICK_TIMEOUT_MS });
    return { ok: ran.code === 0 && !ran.timedOut, exitCode: ran.code, ...(ran.timedOut ? { timedOut: true } : {}), tail: tailLines(`${ran.stdout}${ran.stderr ? `\n${ran.stderr}` : ''}`, 20) };
  } finally {
    try { git(['worktree', 'remove', '--force', tmp], o); } catch { /* pruned below */ }
    try { git(['worktree', 'prune'], o); } catch { /* best effort */ }
  }
}

// main's commits since the fork point with their files (the LISTED ones are capped), every file main changed in the whole range
// (never capped: the overlap must not depend on which commits are shown), and the files this PR changes.
function baseFacts({ root, head, baseTip }) {
  const o = { cwd: root };
  const mb = mergeBase(head, baseTip, o);
  const rows = git(['log', `--max-count=${MAX_COMMITS}`, '--format=%H%x09%s', `${mb}..${baseTip}`], o).split('\n').filter(Boolean);
  const commits = rows.map((row) => {
    const [sha, ...subject] = row.split('\t');
    const files = git(['diff-tree', '--no-commit-id', '--name-only', '-r', '-m', '--first-parent', '-z', sha], o).split('\0').filter(Boolean);
    return { sha, subject: subject.join('\t'), files };
  });
  const totalCommits = Number.parseInt(git(['rev-list', '--count', `${mb}..${baseTip}`], o).trim(), 10);
  const baseFiles = git(['diff', '--name-only', '--no-renames', '-z', mb, baseTip], o).split('\0').filter(Boolean);
  const prFiles = [...new Set(diffFiles(mb, head, o).flatMap((f) => [f.path, f.oldPath, f.newPath].filter(Boolean)))];
  return { commits, totalCommits: Number.isInteger(totalCommits) ? totalCommits : commits.length, truncated: totalCommits > commits.length, baseFiles, prFiles };
}

async function check(argv, ctx) {
  const { values } = parseCommandArgs(argv, { pr: { type: 'string' }, post: { type: 'boolean' }, repo: { type: 'string' } }, { allowPositionals: false });
  const pr = intOption(values, 'pr', { required: true, min: 1 });
  const root = resolveRepo(values, ctx);
  const { config } = await requireConfig(root);
  const gh = createGitHub({ cwd: root, env: ctx.env });

  return guardGh(async () => {
    // 1. The confirmed base updates the run recorded (P merge / P update-branch append them).
    const existing = readSummaryComment(gh, pr);
    const updates = existing.status === 'ok' ? (existing.record.behindBaseUpdates?.length ?? 0) : 0;

    // 2. Protection that cannot be read is not "off".
    const view = gh.prView(pr, [...VIEW_FIELDS]);
    const base = view.baseRefName;
    const strict = readStrict(gh, base);

    // 3. The live gate, and the head everything else is pinned to.
    const evalGate = () => evaluateGate({ root, config, pr, gh, env: ctx.env, home: ctx.home });
    const gate = await evalGate();
    const H = gate.head;
    if (headSha({ cwd: root }) !== H) return notEligible(['head-moved'], { head: H });

    // 4. The base tip now, and whether head merges with it cleanly.
    const reasons = [];
    let baseTip = null;
    let tree = null;
    let mergeTreeOk = null;
    try {
      git(['fetch', '--no-tags', 'origin', `+refs/heads/${base}:refs/remotes/origin/${base}`], { cwd: root, timeoutMs: NETWORK_TIMEOUT_MS });
      baseTip = revParse(`refs/remotes/origin/${base}^{commit}`, { cwd: root });
      const merged = mergeTree(baseTip, H, { cwd: root });
      mergeTreeOk = merged.clean;
      tree = merged.tree;
    } catch (err) {
      reasons.push(`could not read ${base} or merge it with the head (${firstLine(err)})`);
    }

    // 5/6. Quick verify, only when everything before it holds.
    let quickVerify = { skipped: true };
    let quickVerifyOk = null;
    const before = handoffEligibility({ updates, strict, gate, mergeTreeOk, quickVerifyOk: true });
    if (before.eligible) {
      if (!config.verify?.quick) {
        quickVerify = { ok: false, error: 'verify.quick is not configured' };
        quickVerifyOk = false;
      } else {
        try {
          quickVerify = await quickVerifyOnMerge({ root, command: config.verify.quick, tree, head: H, baseTip, pr, env: ctx.env });
        } catch (err) {
          quickVerify = { ok: false, error: firstLine(err) };
        }
        quickVerifyOk = quickVerify.ok === true;
      }
    }
    const verdict = handoffEligibility({ updates, strict, gate, mergeTreeOk, quickVerifyOk });
    if (!verdict.eligible) return notEligible([...reasons, ...verdict.reasons], { head: H, baseTip, quickVerify });

    // 7-10. What the owner is shown.
    const { commits, totalCommits, truncated, baseFiles, prFiles } = baseFacts({ root, head: H, baseTip });
    const touched = new Set(prFiles);
    const overlap = [...new Set(baseFiles.filter((f) => touched.has(f)))];
    const ciBase = ciTestedBase({ gh, pr, head: H });
    const production = config.production?.watch ?? (config.production ? 'session' : 'none');
    const itemsOf = (g) => g.checks.flatMap((c) => c.ownerItems ?? []);
    const output = { ok: true, eligible: true, head: H, baseTip, ciBase, commits, totalCommits, truncated, overlap, ownerItems: itemsOf(gate), quickVerify, production };
    if (values.post !== true) return { exitCode: EXIT.OK, output };

    // 11. Re-validate right before publishing: nothing may have changed during the (slow) quick verify.
    const changed = () => notEligible(['the PR changed during the check: run it again'], { head: H, baseTip });
    if (gh.prView(pr, [...VIEW_FIELDS]).headRefOid !== H || headSha({ cwd: root }) !== H) return changed();
    const final = await evalGate();
    if (final.head !== H || !handoffEligibility({ updates, strict, gate: final, mergeTreeOk: true, quickVerifyOk: true }).eligible) return changed();
    const itemsChanged = final.ownerItems !== gate.ownerItems;
    const finalItems = itemsOf(final);
    const body = renderHandoffComment({ pr, head: H, baseTip, ciBase, commits, totalCommits, overlap, ownerItems: finalItems, productionWatch: production, itemsChanged });
    const posted = gh.createComment(pr, body);
    const recorder = createRunRecorder({ gh, pr });
    recorder.update({ handoff: { head: H, baseTip, at: new Date().toISOString() } }, { initialStep: 'gate' });
    return {
      exitCode: EXIT.OK,
      output: { ...output, ownerItems: finalItems, ...(itemsChanged ? { itemsChanged: true } : {}), posted, ...(recorder.warnings.length > 0 ? { warnings: recorder.warnings } : {}) },
    };
  });
}

const SUBCOMMANDS = { check };

export const run = guarded(async (argv, ctx) => {
  const [sub, ...rest] = argv;
  if (!sub || !Object.hasOwn(SUBCOMMANDS, sub)) throw new UsageError(`usage: pipeline handoff ${Object.keys(SUBCOMMANDS).join('|')} --pr N [--post] [--repo DIR]`);
  return SUBCOMMANDS[sub](rest, ctx);
});
