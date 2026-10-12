// `pipeline inbox`: one read-only look at every open PR of the repo (and the ones merged lately) and what each is waiting
// for. This file gathers the facts (GitHub, git); pipeline/lib/inbox.mjs classifies them. It never comments, labels,
// closes, merges or creates a ref of its own: the only git writes are the object downloads of one `git fetch` and the
// remote-tracking ref of each base branch.
import { EXIT, intOption, parseCommandArgs } from '../lib/cli.mjs';
import { guarded, requireConfig, resolveRepo } from '../lib/cmd-common.mjs';
import { requiredChecks } from '../lib/config.mjs';
import { NETWORK_TIMEOUT_MS, git, mergeTree, reviewContentHash, revParse, supportsMergeTreeWrite } from '../lib/git.mjs';
import { createGitHub, guardGh } from '../lib/github.mjs';
import { classifyPr, classifyStranded, ciDetail, triageGroups } from '../lib/inbox.mjs';
import { listWorktrees, localBranchState, orphanWorktrees } from '../lib/local-branches.mjs';
import { analyseComments } from '../lib/pr-facts.mjs';
import { listEvents } from '../lib/run-events.mjs';
import { summaryFromComments } from '../lib/summary-comment.mjs';

export const meta = {
  summary: 'read-only triage of every open PR (and recently merged ones): what each waits for and the next action',
  usage: [
    'pipeline inbox [--stale-days 14] [--merged-days 7] [--no-git] [--repo DIR]',
    '  -> {ok, generatedAt, bases[{ref, sha}], prs[], triage{merge, resume, close, leave}, strandedAfterMerge[], local{unpushed[], orphanWorktrees[]}, warnings[]}',
  ].join('\n'),
};

const DAY = 86400000;
const sha7 = (s) => String(s ?? '').slice(0, 7);
const describe = (err) => String(err?.message ?? err).split('\n')[0].slice(0, 300);

// ---- git facts ----------------------------------------------------------------------------------

// -> { bases: [{ref, sha}], facts: Map<number, {conflicts, alreadyOnBase, contentHash}> }. One fetch per distinct base.
function gitFacts({ root, config, prs, warnings }) {
  const o = { cwd: root };
  const facts = new Map();
  const bases = [];
  const byBase = new Map();
  for (const pr of prs) byBase.set(pr.baseRefName, [...(byBase.get(pr.baseRefName) ?? []), pr]);

  let mergeTreeOk = false;
  try {
    mergeTreeOk = supportsMergeTreeWrite(o);
  } catch (err) {
    warnings.push(`git version unreadable: ${describe(err)}`);
  }
  if (!mergeTreeOk) warnings.push('git is older than 2.38 (no merge-tree --write-tree): conflicts and alreadyOnBase are null');

  for (const [ref, group] of byBase) {
    const refspecs = [`+refs/heads/${ref}:refs/remotes/origin/${ref}`, ...group.map((p) => `refs/pull/${p.number}/head`)];
    let baseSha = null;
    try {
      git(['fetch', '--no-tags', 'origin', ...refspecs], { ...o, timeoutMs: NETWORK_TIMEOUT_MS });
      baseSha = revParse(`refs/remotes/origin/${ref}`, o);
    } catch (err) {
      warnings.push(`git fetch for base ${ref} failed (${group.length} PR${group.length === 1 ? '' : 's'} without git facts): ${describe(err)}`);
    }
    bases.push({ ref, sha: baseSha });
    if (baseSha === null) continue;

    let baseTree = null;
    for (const pr of group) {
      const f = { conflicts: null, alreadyOnBase: null, contentHash: null };
      facts.set(pr.number, f);
      try {
        f.contentHash = reviewContentHash({ branch: ref, agentLog: config.agent_log, head: pr.headRefOid, baseSha }, o);
      } catch (err) {
        warnings.push(`#${pr.number}: content hash unavailable: ${describe(err)}`);
      }
      if (!mergeTreeOk) continue;
      try {
        const merged = mergeTree(baseSha, pr.headRefOid, o);
        baseTree ??= revParse(`${baseSha}^{tree}`, o);
        f.conflicts = !merged.clean;
        f.alreadyOnBase = merged.clean && merged.tree === baseTree;
      } catch (err) {
        warnings.push(`#${pr.number}: trial merge unavailable: ${describe(err)}`);
      }
    }
  }
  return { bases, facts };
}

function localFacts({ root, prs, warnings }) {
  const perPr = new Map();
  let worktrees = null;
  try {
    worktrees = listWorktrees(root);
  } catch (err) {
    warnings.push(`local worktrees unreadable: ${describe(err)}`);
    return { perPr, worktrees: null };
  }
  for (const pr of prs) {
    if (pr.isCrossRepository) continue; // the branch name belongs to a fork; a local ref of the same name proves nothing
    try {
      perPr.set(pr.number, localBranchState(root, pr.headRefName, pr.headRefOid, { worktrees }));
    } catch (err) {
      warnings.push(`#${pr.number}: local branch state unavailable: ${describe(err)}`);
    }
  }
  return { perPr, worktrees };
}

// The classifier's view of one PR's local state: null when this machine holds nothing for the branch.
function localForClassifier(s, branch) {
  if (!s || (s.state === 'none' && s.worktrees.length === 0)) return null;
  return { state: s.state, worktree: s.worktrees[0]?.path ?? `refs/heads/${branch}`, unpushed: s.unpushed, dirty: s.dirty };
}

// ---- the command --------------------------------------------------------------------------------

export const run = guarded(async (argv, ctx) => {
  const { values } = parseCommandArgs(argv, {
    'stale-days': { type: 'string' }, 'merged-days': { type: 'string' }, 'no-git': { type: 'boolean' }, repo: { type: 'string' },
  }, { allowPositionals: false });
  const staleDays = intOption(values, 'stale-days', { min: 0, max: 3650 }) ?? 14;
  const mergedDays = intOption(values, 'merged-days', { min: 0, max: 3650 }) ?? 7;
  const useGit = values['no-git'] !== true;
  const root = resolveRepo(values, ctx);
  const { config } = await requireConfig(root);

  const gh = createGitHub({ cwd: root, env: ctx.env });
  return guardGh(() => {
    const now = new Date();
    const warnings = [];
    const viewer = gh.viewer();
    const repo = gh.repo().slug;
    const open = gh.listOpenPrsDetailed();
    const merged = gh.listMergedPrsSince(now.getTime() - mergedDays * DAY);

    const gitPart = useGit ? gitFacts({ root, config, prs: open, warnings }) : { bases: [], facts: new Map() };
    const local = useGit ? localFacts({ root, prs: open, warnings }) : { perPr: new Map(), worktrees: null };
    const required = requiredChecks(config.ci);

    const prs = open.map((p) => {
      const comments = gh.listComments(p.number);
      const a = analyseComments(comments, viewer, { repo, pr: p.number, branch: p.headRefName }, warnings);
      const g = gitPart.facts.get(p.number) ?? { conflicts: null, alreadyOnBase: null, contentHash: null };
      const ls = local.perPr.get(p.number) ?? null;
      const ciInfo = ciDetail(p.contexts, required);
      const ci = ciInfo.status;
      const classified = classifyPr({
        number: p.number, title: p.title, isDraft: p.isDraft, labels: p.labels, headRefOid: p.headRefOid,
        isCrossRepository: p.isCrossRepository, baseRefName: p.baseRefName, ci, ciFailed: ciInfo.failed, conflicts: g.conflicts, alreadyOnBase: g.alreadyOnBase,
        record: a.record, recordStatus: a.recordStatus, triage: a.triage, contentHash: g.contentHash,
        needsHumanReason: a.needsHumanReason, needsHumanHardStopOnly: a.needsHumanHardStopOnly,
        activity: { commitDate: p.commitDate, commentUpdatedAts: a.commentUpdatedAts, reviewDates: p.reviewDates, createdAt: p.createdAt },
        local: localForClassifier(ls, p.headRefName),
      }, { staleDays, now, ownerApproval: config.owner_approval });
      return {
        ...classified,
        url: p.url,
        isDraft: p.isDraft,
        labels: p.labels,
        base: p.baseRefName,
        branch: p.headRefName,
        head: sha7(p.headRefOid),
        ci,
        ciFailed: ciInfo.failed,
        ciMissing: ciInfo.missing,
        mergeable: p.mergeable,
        autoMerge: p.autoMergeEnabledAt !== null,
        conflicts: g.conflicts,
        alreadyOnBase: g.alreadyOnBase,
        contentHash: g.contentHash,
        recordStatus: a.recordStatus,
        step: a.record?.step ?? null,
        outcome: a.record?.outcome ?? null,
        events: a.events.map((e) => ({ kind: e.kind, id: e.id })),
        local: ls && { state: ls.state, localRef: ls.localRef, unpushed: ls.unpushed, dirty: ls.dirty, worktrees: ls.worktrees },
      };
    });

    const mergedFacts = merged.map((m) => {
      const comments = gh.listComments(m.number);
      const summary = summaryFromComments(comments, viewer);
      const events = listEvents(comments, viewer);
      return {
        number: m.number, mergedAt: m.mergedAt,
        recordStatus: summary.status, record: summary.status === 'ok' ? summary.record : null,
        events: { rollbackIntent: events.some((e) => e.kind === 'rollback-intent'), rollbackResult: events.some((e) => e.kind === 'rollback-result') },
      };
    });

    const unpushed = useGit
      ? prs.filter((p) => p.local && (p.local.unpushed > 0 || p.local.dirty > 0 || p.local.state === 'diverged'))
        .map((p) => ({ number: p.number, branch: p.branch, state: p.local.state, unpushed: p.local.unpushed, dirty: p.local.dirty, worktrees: p.local.worktrees.map((w) => w.path) }))
      : null;
    let orphans = null;
    if (useGit && local.worktrees) {
      try {
        orphans = orphanWorktrees(root, open.map((p) => p.headRefName), config.worktree_dir, { worktrees: local.worktrees });
      } catch (err) {
        warnings.push(`orphan worktrees unavailable: ${describe(err)}`);
      }
    }

    return {
      exitCode: EXIT.OK,
      output: {
        ok: true,
        generatedAt: now.toISOString(),
        bases: gitPart.bases,
        prs,
        triage: triageGroups(prs),
        strandedAfterMerge: classifyStranded(mergedFacts, now),
        local: { unpushed, orphanWorktrees: orphans },
        warnings,
      },
    };
  });
});
