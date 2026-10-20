// `pipeline resume list` finds the PRs a session can pick up; `pipeline resume plan --pr N` says where a stalled run
// resumes (the routing itself is pure: pipeline/lib/resume-plan.mjs). Both are read-only: no comment, label or merge is
// written; the only git write is the object download of one `git fetch` and the remote-tracking ref of the PR's base.
import { hostname } from 'node:os';
import { EXIT, UsageError, intOption, parseCommandArgs } from '../lib/cli.mjs';
import { Fail, guarded, requireConfig, resolveRepo } from '../lib/cmd-common.mjs';
import { NETWORK_TIMEOUT_MS, git, reviewContentHash, revParse } from '../lib/git.mjs';
import { createGitHub, guardGh } from '../lib/github.mjs';
import { localBranchState } from '../lib/local-branches.mjs';
import { analyseComments } from '../lib/pr-facts.mjs';
import { accountHome, readPlanApprovals } from '../hooks/lib/owner-go.mjs';
import { planResumeFacts, bindOf } from '../lib/plan-state.mjs';
import { GhError } from '../lib/proc.mjs';
import { planResume } from '../lib/resume-plan.mjs';
import { unresolvedRollbacks } from '../lib/run-events.mjs';
import { bindRecord } from '../lib/run-record.mjs';
import { summaryFromComments } from '../lib/summary-comment.mjs';

export const meta = {
  summary: 'find PRs a session can pick up, and plan where a stalled run resumes',
  usage: [
    'pipeline resume list [--repo DIR]',
    '  -> {ok, prs[{number, title, headRefName, url, why}]}: open PRs labelled awaiting-review, plus open PRs whose run record',
    '     (written by this GitHub user) is readable and has no outcome yet (a run that stopped mid-way)',
    'pipeline resume plan --pr N [--repo DIR]',
    '  -> {ok, pr, title, url, prState, branch, base, liveHead, enter, reason, adopt, planApproveFirst, confirm, autoMerge, worktree, stop, recordStatus, record,',
    '      plan, events, local, mergeSha, notes[], warnings[]}; read-only (its only git writes are fetches: the PR head, the base and origin/<branch>)',
    '     enter: closed | ended | observe-prod | not-resumable | local-work | decision | plan | owner-ui-merge | build | verify | review | followups | gate',
    '     plan (null on a PR with no plan evidence): {approval: none|unverified|verified|lost, openWork, needsApproveCheckpoint, activeBlob, lostReason}; enter plan = show the plan request again and wait for "approve" (stop awaiting-plan-approval);',
    '     decision with a lost plan = the evidence is missing or edited; owner-ui-merge = handed to the owner for a GitHub merge (report only);',
    '     planApproveFirst: true = run `P plan approve` (it reuses the posted approval and copies the tasks into the record) before building;',
    '     adopt: no run record (the PR was not started by the pipeline); confirm: {host, step, minutesAgo, why} when another run may be live,',
    '     stop: where a run on a route that can reach Step 5 ends, never at a merge: awaiting-owner-merge (owner_approval chat) | needs-human (label mode); null on the other routes',
    '     autoMerge: {armed, action: disarm} when an unattended auto-merge is queued, worktree: {action: reuse|add-existing-ref|add-from-remote|none, path?, then?}',
    '  exit 2 when the PR does not exist',
  ].join('\n'),
};

const USAGE = 'usage: pipeline resume list [--repo DIR] | pipeline resume plan --pr N [--repo DIR]';
const describe = (err) => String(err?.message ?? err).split('\n')[0].slice(0, 300);

// ---- list -----------------------------------------------------------------------------------

function listPrs(gh) {
  const viewer = gh.viewer();
  const repo = gh.repo().slug;
  const out = [];
  for (const p of gh.listOpenPrsDetailed()) {
    const entry = { number: p.number, title: p.title, headRefName: p.headRefName, url: p.url };
    if (p.labels.includes('awaiting-review')) {
      out.push({ ...entry, why: 'awaiting a cross-model review (label awaiting-review)' });
      continue;
    }
    if (p.isCrossRepository) continue; // a fork is not resumable: nothing to list
    const summary = summaryFromComments(gh.listComments(p.number), viewer);
    if (summary.status !== 'ok' || bindRecord(summary.record, { repo, pr: p.number, branch: p.headRefName }).length > 0) continue;
    if (summary.record.outcome == null) out.push({ ...entry, why: `a run stopped mid-way at step ${summary.record.step}` });
  }
  return out;
}

async function list(argv, ctx) {
  const { values } = parseCommandArgs(argv.slice(1), { repo: { type: 'string' } }, { allowPositionals: false });
  const root = resolveRepo(values, ctx);
  const gh = createGitHub({ cwd: root, env: ctx.env });
  return guardGh(() => ({ exitCode: EXIT.OK, output: { ok: true, prs: listPrs(gh) } }));
}

// ---- plan -----------------------------------------------------------------------------------

const VIEW_FIELDS = ['number', 'title', 'url', 'state', 'isDraft', 'headRefName', 'headRefOid', 'baseRefName', 'isCrossRepository', 'labels', 'autoMergeRequest', 'mergeCommit'];
const NOT_FOUND = /could not resolve to a (pullrequest|repository)|no pull requests? found|could not find pull request/i;

function viewPr(gh, pr) {
  try {
    return gh.prView(pr, VIEW_FIELDS);
  } catch (err) {
    if (err instanceof GhError && !err.timedOut && NOT_FOUND.test(`${err.stderr ?? ''} ${err.message}`)) {
      throw new Fail(EXIT.USAGE, { ok: false, error: 'not-found', message: `PR #${pr} does not exist in this repository` });
    }
    throw err;
  }
}

// The live head's review hash and this machine's branch state, best effort: any failure is a warning and an unknown fact.
function gitFacts({ root, config, pr, view, warnings }) {
  const o = { cwd: root };
  const out = { contentHash: null, local: null };
  let baseSha = null;
  try {
    git(['fetch', '--no-tags', 'origin', `+refs/heads/${view.baseRefName}:refs/remotes/origin/${view.baseRefName}`, `refs/pull/${pr}/head`], { ...o, timeoutMs: NETWORK_TIMEOUT_MS });
    baseSha = revParse(`refs/remotes/origin/${view.baseRefName}`, o);
  } catch (err) {
    warnings.push(`git fetch failed (content hash and local comparison may be unavailable): ${describe(err)}`);
  }
  // The skill later fast-forwards a behind checkout, and a stale origin/<branch> would answer "already up to date": refresh it
  // too (same-repo PRs only; the caller never asks for a fork's). The plan's `then` merges the exact liveHead regardless.
  try {
    git(['fetch', '--no-tags', 'origin', `+refs/heads/${view.headRefName}:refs/remotes/origin/${view.headRefName}`], { ...o, timeoutMs: NETWORK_TIMEOUT_MS });
  } catch (err) {
    warnings.push(`git fetch of origin/${view.headRefName} failed (a fast-forward must use the live head sha): ${describe(err)}`);
  }
  if (baseSha !== null) {
    try {
      out.contentHash = reviewContentHash({ branch: view.baseRefName, agentLog: config.agent_log, head: view.headRefOid, baseSha }, o);
    } catch (err) {
      warnings.push(`content hash unavailable: ${describe(err)}`);
    }
  }
  try {
    out.local = localBranchState(root, view.headRefName, view.headRefOid);
  } catch (err) {
    warnings.push(`local branch state unavailable: ${describe(err)}`);
  }
  return out;
}

const taskView = (t) => ({ id: t.id, title: t.title, spec: t.spec, done: t.done === true });

function recordView(record) {
  if (!record) return null;
  return {
    step: record.step, outcome: record.outcome, next: record.next, detail: record.detail, head: record.head, round: record.round,
    mergeSha: record.mergeSha ?? null, heartbeat: record.heartbeat ?? null, inFlight: record.inFlight ?? null, verify: record.verify ?? null, resumed: record.resumed ?? null,
    request: record.request, tasks: (record.tasks ?? []).map(taskView), agentLogLine: record.agentLogLine ?? null,
  };
}

// The newest event of each kind (the rollback target lives in `prod-before`), and which rollback attempts began without a result of their own id.
function eventsView(events) {
  const latest = {};
  for (const e of events) latest[e.kind] = { id: e.id, url: e.url, sentence: e.sentence, data: e.data };
  return {
    count: events.length,
    rollbackIntent: events.some((e) => e.kind === 'rollback-intent'),
    rollbackResult: events.some((e) => e.kind === 'rollback-result'),
    unresolvedRollbacks: unresolvedRollbacks(events).map((e) => e.id),
    latest,
  };
}

// Plan evidence for the router (spec §7): approval judged against the owner's local records and the approved plan's git blob.
// A blob this clone cannot read is `lost`, never a silent skip of the plan step.
function planFactsFor({ root, a, bind, home }) {
  return planResumeFacts({
    events: a.events,
    bind,
    recordPlan: a.record?.plan ?? null,
    localRecords: readPlanApprovals({ home }),
    recordTasks: a.record?.tasks,
    readBlob: (b) => {
      if (!/^[0-9a-f]{40}$/.test(String(b))) return null;
      try { return git(['cat-file', 'blob', b], { cwd: root }); } catch { return null; }
    },
  });
}

const planView = (p) => (p.evidence ? { approval: p.approval, openWork: p.openWork, needsApproveCheckpoint: p.needsApproveCheckpoint, activeBlob: p.active?.blob ?? null, lostReason: p.lostReason ?? null } : null);

async function plan(argv, ctx) {
  const { values } = parseCommandArgs(argv.slice(1), { pr: { type: 'string' }, repo: { type: 'string' } }, { allowPositionals: false });
  const pr = intOption(values, 'pr', { required: true, min: 1 });
  const root = resolveRepo(values, ctx);
  const { config } = await requireConfig(root);
  const gh = createGitHub({ cwd: root, env: ctx.env });
  return guardGh(() => {
    const warnings = [];
    const viewer = gh.viewer();
    const repo = gh.repo().slug;
    const view = viewPr(gh, pr);
    const a = analyseComments(gh.listComments(pr), viewer, { repo, pr, branch: view.headRefName }, warnings);
    const prState = view.state;
    const labels = (view.labels ?? []).map((l) => (typeof l === 'string' ? l : l?.name)).filter(Boolean);

    // Only an open, non-fork PR has a branch worth comparing with this machine's.
    const open = prState === 'OPEN' && view.isCrossRepository !== true;
    const g = open ? gitFacts({ root, config, pr, view, warnings }) : { contentHash: null, local: null };

    const planFacts = planFactsFor({ root, a, bind: bindOf({ repo, pr, branch: view.headRefName }), home: ctx.home ?? accountHome() });
    const result = planResume({
      state: prState, isCrossRepository: view.isCrossRepository === true, labels, liveHead: view.headRefOid,
      autoMergeArmed: view.autoMergeRequest != null, host: hostname(),
      recordStatus: a.recordStatus, record: a.record, triage: a.triage, contentHash: g.contentHash,
      needsHumanReason: a.needsHumanReason, events: a.events, local: g.local, plan: planFacts,
    }, { now: Date.now(), ownerApproval: config.owner_approval });

    return {
      exitCode: EXIT.OK,
      output: {
        ok: true,
        pr,
        title: view.title ?? '',
        url: view.url ?? null,
        prState,
        isDraft: view.isDraft === true,
        branch: view.headRefName,
        base: view.baseRefName,
        liveHead: view.headRefOid,
        ...result,
        recordStatus: a.recordStatus,
        record: recordView(a.record),
        plan: planView(planFacts),
        events: eventsView(a.events),
        local: g.local && { state: g.local.state, localRef: g.local.localRef, unpushed: g.local.unpushed, dirty: g.local.dirty, worktrees: g.local.worktrees },
        mergeSha: view.mergeCommit?.oid ?? a.record?.mergeSha ?? null,
        contentHash: g.contentHash,
        review: a.triage && { rounds: a.triage.rounds, lastRound: a.triage.lastRound, clean: a.triage.clean, followupsPending: a.triage.followupsPending },
        warnings,
      },
    };
  });
}

export const run = guarded(async (argv, ctx) => {
  const sub = argv[0];
  if (sub === 'list') return list(argv, ctx);
  if (sub === 'plan') return plan(argv, ctx);
  throw new UsageError(USAGE);
});
