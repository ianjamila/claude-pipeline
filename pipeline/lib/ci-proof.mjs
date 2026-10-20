// CI proof for a verify step the final gate lets GitHub Actions vouch for (verify.deferrable_steps + verify.ci_proof).
// finalgate.mjs#verifyReportCheck calls this when a report row says `skipped` + `skipKind: "ci"`; the settings (`spec`) come from the
// BASE branch, never from the PR. Everything here fails closed: any doubt is 'missing' (the Mac then runs the step), never a pass.
//
// Contract (finalgate.mjs#verifyReportCheck relies on it):
//   ciProof({ root, step, spec, pr, head, tree, base, gh, env }) -> Promise<{ state, reason, run? }>
//     root   the PR worktree          step  the deferred step's name (e.g. 'sql-arms')
//     spec   { workflow, job, event, steps? } from the BASE branch's verify.ci_proof[step] (workflow = '.github/workflows/<file>.yml', event
//            already defaulted to 'pull_request'; steps = optional names of steps inside the job, see rule 5); never the PR's own copy
//     pr     the PR number            head  the PR head SHA the gate is judging            tree  `git rev-parse HEAD^{tree}`-style
//            fingerprint the gate computed (treeFingerprint) for that head (not used here: HEAD^{tree} is read from `root`)
//     base   { ref, sha } the default branch name and its tip as fetched just now (origin/<ref>)
//     gh     the createGitHub() client (api, repo, prView)       env  the command's environment
//   state  'pass'    the exact-head run of spec.workflow/spec.job completed successfully and belongs to this PR
//          'pending' the newest run/attempt is queued or in progress (an older success never wins)
//          'failure' the run completed and the job did not succeed
//          'missing' no usable run, anything ineligible, or any API/parse error (fail closed; a cancelled or skipped run counts as missing)
//   reason one short human line (always present; shown in the gate detail)
//   run    required for 'pass', ignored otherwise: { id, attempt, jobId, workflow, job, url, steps? } - the run/attempt/job that was used
//          (steps = the step names rule 5 checked, present only when spec.steps was set)
// The caller treats a throw, an unknown state, or a 'pass' without `run` as 'missing': nothing here can make the gate pass by failing.
//
// How the run is chosen and bound (plan "Run selection" / "The run must belong to THIS PR"):
//   1. List `actions/workflows/<file>/runs?head_sha=<head>&event=<event>` with COMPLETE pagination (stop only when total_count is reached;
//      a short page before that, a changing total or a duplicate run is an inconsistent listing -> missing). Keep runs whose head_sha,
//      repository.full_name, path (any `@ref` suffix stripped) and event all match. Take the highest run_number (no timestamps);
//      a duplicate run_number or a missing field -> missing. Its run_attempt is the newest attempt. If that run/attempt is not completed
//      the answer is 'pending' - an older success on the same head never wins.
//   2. Binding: `pull_requests` (filled at READ time, so it proves the PR link but not what was tested) must hold exactly one entry, this
//      PR, into the default branch; `head_branch` must be the PR's head branch; `head_repository` must be this repo (not a fork).
//   3. What was tested: GitHub exposes `referenced_workflows` with the merge commit the run executed (`ref: refs/pull/<N>/merge` + `sha`).
//      That commit's tree (API git/commits/<sha>) must equal `git rev-parse HEAD^{tree}` of the worktree: a deterministic "this run tested
//      exactly my tree". There is NO weaker case (controller decision, stricter than the plan's first draft): a run without a usable
//      refs/pull/<N>/merge entry carries no evidence of what it tested, so it is 'missing' and the Mac runs the step.
//   4. The jobs of that attempt (`runs/<id>/attempts/<n>/jobs`, paginated) must hold exactly ONE job named spec.job (a sharded job needs a
//      configured aggregator name; 0 or 2+ -> missing). completed+success -> pass; completed+failure|timed_out -> failure; cancelled,
//      skipped and anything else -> missing (a cancelled run was superseded, it is not red); queued/in_progress -> pending.
//   5. Optional spec.steps (non-empty, distinct, non-empty names). A job can report `success` while every work step inside it was skipped
//      (a step-level "docs-only" skip), so a green job alone proves nothing there. When spec.steps is set, a job that is completed+success
//      (rule 4) is a pass ONLY IF each named step appears EXACTLY ONCE in that job's `steps` with status completed and conclusion success.
//      Absent, listed twice, skipped, cancelled, neutral, failure (a continue-on-error step under a green job), unknown, or a malformed
//      steps list -> 'missing' (the Mac runs the step; never 'failure': the job itself was green), the reason names the step. The steps come
//      from the jobs listing; a job object without a usable steps array costs ONE extra `actions/jobs/<jobId>` read (still nothing usable ->
//      missing). A spec.steps that is not a non-empty array of distinct non-empty strings is an unusable spec -> missing, before any call.
//      Without spec.steps nothing here changes: no extra call, the same result and the same reason as before.
// No retries, no waiting: the skill decides how long to wait for 'pending'.
import { git } from './git.mjs';

const SHA = /^[0-9a-f]{40}$/;
const WORKFLOW = /^\.github\/workflows\/[^/]+\.ya?ml$/;
const PER_PAGE = 100;
const MAX_PAGES = 20;
const PENDING_STATUSES = new Set(['queued', 'in_progress', 'waiting', 'requested', 'pending']);

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isCount = (v) => Number.isInteger(v) && v >= 0;
const isPositive = (v) => Number.isInteger(v) && v > 0;
const isStr = (v) => typeof v === 'string' && v !== '';

// An answer, not a bug: thrown inside the lookup, turned into { state, reason } at the top.
class Verdict extends Error {
  constructor(state, reason) {
    super(reason);
    this.state = state;
  }
}
const missing = (reason) => new Verdict('missing', reason);

// Every page of a `{ total_count, <key>: [...] }` listing. Fail closed on anything that does not add up.
function listAll(gh, path, key, what) {
  const joiner = path.includes('?') ? '&' : '?';
  const items = [];
  let total = null;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const body = gh.api('GET', `${path}${joiner}per_page=${PER_PAGE}&page=${page}`);
    if (!isObject(body) || !Array.isArray(body[key]) || !isCount(body.total_count)) throw missing(`GitHub's ${what} listing has an unexpected shape`);
    if (total !== null && body.total_count !== total) throw missing(`the ${what} listing changed while it was being read (${total} then ${body.total_count})`);
    total = body.total_count;
    items.push(...body[key]);
    if (items.length === total) return items;
    if (items.length > total) throw missing(`the ${what} listing returned more entries than its total (${items.length} of ${total})`);
    if (body[key].length < PER_PAGE) throw missing(`the ${what} listing is incomplete (${items.length} of ${total}, page ${page} was short)`);
  }
  throw missing(`the ${what} listing needs more than ${MAX_PAGES} pages`);
}

const workflowOf = (run) => String(run.path ?? '').split('@')[0];

// The runs of spec.workflow for this head and event, as the strict facts the rest of the lookup uses.
function candidateRuns({ gh, slug, head, spec }) {
  const file = spec.workflow.split('/').at(-1);
  const path = `repos/${slug}/actions/workflows/${encodeURIComponent(file)}/runs?head_sha=${head}&event=${encodeURIComponent(spec.event)}`;
  const all = listAll(gh, path, 'workflow_runs', 'workflow run');
  const seen = new Set();
  const kept = [];
  for (const run of all) {
    if (!isObject(run) || !isPositive(run.id)) throw missing('a listed workflow run has no id');
    if (seen.has(run.id)) throw missing(`workflow run ${run.id} is listed twice (the listing moved while it was being read)`);
    seen.add(run.id);
    if (String(run.head_sha ?? '').toLowerCase() !== head) continue;
    if (run.repository?.full_name !== slug) continue;
    if (workflowOf(run) !== spec.workflow) continue;
    if (run.event !== spec.event) continue;
    if (!isPositive(run.run_number) || !isPositive(run.run_attempt) || !isStr(run.status)) throw missing(`workflow run ${run.id} lacks run_number, run_attempt or status`);
    kept.push(run);
  }
  return kept;
}

// Highest run_number wins; two runs with the same number cannot be told apart.
function newestRun(kept, spec, head) {
  if (kept.length === 0) throw missing(`no ${spec.event} run of ${spec.workflow} for ${head.slice(0, 7)}`);
  const top = Math.max(...kept.map((r) => r.run_number));
  const tops = kept.filter((r) => r.run_number === top);
  if (tops.length > 1) throw missing(`runs ${tops.map((r) => r.id).join(' and ')} share run number ${top}`);
  return tops[0];
}

// The run must belong to THIS PR (pull_requests proves the link, not what was tested).
function checkBinding({ run, pr, base, slug, view }) {
  const prs = Array.isArray(run.pull_requests) ? run.pull_requests : [];
  if (prs.length === 0) throw missing(`run ${run.id} lists no pull request, so it cannot be bound to PR #${pr}`);
  if (prs.length > 1) throw missing(`run ${run.id} lists ${prs.length} pull requests`);
  const [p] = prs;
  if (!isObject(p) || p.number !== pr) throw missing(`run ${run.id} is about PR #${p?.number ?? '?'}, not #${pr}`);
  if (p.base?.ref !== base.ref) throw missing(`run ${run.id} is about PR #${pr} into ${p.base?.ref ?? '(unknown)'}, not ${base.ref}`);
  if (run.head_branch !== view.headRefName) throw missing(`run ${run.id} ran branch ${run.head_branch ?? '(unknown)'}, the PR's branch is ${view.headRefName}`);
  if (run.head_repository?.full_name !== slug) throw missing(`run ${run.id} ran a head from ${run.head_repository?.full_name ?? '(unknown)'}, not ${slug} (a fork never counts)`);
}

// The merge commit the run executed, from referenced_workflows. Anything but exactly one usable refs/pull/<pr>/merge commit is missing.
function mergeCommitOf(run, pr) {
  const noEvidence = () => missing(`run ${run.id} does not say which merge commit it tested; the Mac runs the step`);
  if (run.referenced_workflows === undefined || run.referenced_workflows === null) throw noEvidence();
  if (!Array.isArray(run.referenced_workflows)) throw missing(`run ${run.id} has unreadable referenced_workflows`);
  const wanted = `refs/pull/${pr}/merge`;
  const found = new Set();
  for (const w of run.referenced_workflows) {
    if (!isObject(w) || typeof w.ref !== 'string' || !/^refs\/pull\/[^/]+\/merge$/.test(w.ref)) continue;
    if (w.ref !== wanted) throw missing(`run ${run.id} executed ${w.ref}, not ${wanted}`);
    if (typeof w.sha !== 'string' || !SHA.test(w.sha)) throw missing(`run ${run.id} names no merge commit for ${wanted}`);
    found.add(w.sha);
  }
  if (found.size > 1) throw missing(`run ${run.id} executed more than one merge commit of ${wanted}`);
  if (found.size === 0) throw noEvidence();
  return [...found][0];
}

function treeOfMergeCommit({ gh, slug, sha, root, run, pr }) {
  const commit = gh.api('GET', `repos/${slug}/git/commits/${sha}`);
  const theirs = commit?.tree?.sha;
  if (typeof theirs !== 'string' || !SHA.test(theirs)) throw missing(`GitHub did not return the tree of merge commit ${sha.slice(0, 7)}`);
  const mine = git(['rev-parse', '--verify', 'HEAD^{tree}'], { cwd: root }).trim();
  if (theirs !== mine) throw missing(`run ${run.id} tested merge commit ${sha.slice(0, 7)} (refs/pull/${pr}/merge), whose tree is not this PR head's tree`);
}

function pickJob({ gh, slug, run, spec, head }) {
  const jobs = listAll(gh, `repos/${slug}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs`, 'jobs', 'job');
  for (const j of jobs) {
    if (!isObject(j) || !isPositive(j.id)) throw missing(`a job of run ${run.id} has no id`);
  }
  const named = jobs.filter((j) => j.name === spec.job);
  if (named.length !== 1) throw missing(`run ${run.id} attempt ${run.run_attempt} has ${named.length} jobs named "${spec.job}", expected exactly one`);
  const [job] = named;
  // run_id, run_attempt and head_sha are REQUIRED on the job and must match (absent = missing): the job must be this run's, this attempt's, this head's.
  if (job.run_id !== run.id) throw missing(`job ${job.id} belongs to run ${job.run_id ?? '(unknown)'}, not ${run.id}`);
  if (job.run_attempt !== run.run_attempt) throw missing(`job ${job.id} is from attempt ${job.run_attempt ?? '(unknown)'}, not ${run.run_attempt}`);
  if (String(job.head_sha ?? '').toLowerCase() !== head) throw missing(`job ${job.id} ran ${job.head_sha ? String(job.head_sha).slice(0, 7) : '(unknown)'}, not ${head.slice(0, 7)}`);
  return job;
}

// Rule 5: the steps of the (completed, successful) job - from the listing when it carries them, else one `actions/jobs/<id>` read.
function stepsOf({ gh, slug, job }) {
  if (Array.isArray(job.steps) && job.steps.length > 0) return job.steps;
  const body = gh.api('GET', `repos/${slug}/actions/jobs/${job.id}`);
  if (!isObject(body) || body.id !== job.id) throw missing(`GitHub's reply for job ${job.id} is not that job (needed to read its steps)`);
  if (!Array.isArray(body.steps) || body.steps.length === 0) throw missing(`job ${job.id} lists no steps, so its required steps cannot be checked`);
  return body.steps;
}

// Each required step must be listed exactly once and be completed+success. Returns nothing; throws a 'missing' naming the first offender.
function checkSteps({ gh, slug, job, spec, label }) {
  const listed = stepsOf({ gh, slug, job });
  for (const st of listed) {
    if (!isObject(st) || typeof st.name !== 'string') throw missing(`job "${spec.job}" of ${label} has an unreadable entry in its steps`);
  }
  for (const name of spec.steps) {
    const hits = listed.filter((st) => st.name === name);
    if (hits.length !== 1) throw missing(`step "${name}" is ${hits.length === 0 ? 'not in' : `listed ${hits.length} times in`} job "${spec.job}" of ${label}; the Mac runs the step`);
    const [st] = hits;
    if (st.status !== 'completed' || st.conclusion !== 'success') {
      throw missing(`step "${name}" of job "${spec.job}" in ${label} did not succeed (${st.status === 'completed' ? st.conclusion ?? 'no conclusion' : st.status ?? 'no status'}); the Mac runs the step`);
    }
  }
}

async function lookup({ root, step, spec, pr, head, base, gh }) {
  if (!isObject(spec) || !WORKFLOW.test(String(spec.workflow ?? '')) || !isStr(spec.job) || !isStr(spec.event)) throw missing(`verify.ci_proof.${step} is not a usable { workflow, job, event }`);
  if (spec.steps !== undefined && !(Array.isArray(spec.steps) && spec.steps.length > 0 && spec.steps.every((n) => isStr(n) && n.trim() !== '') && new Set(spec.steps).size === spec.steps.length)) {
    throw missing(`verify.ci_proof.${step}.steps is not a non-empty list of distinct step names`);
  }
  if (!Number.isInteger(pr) || pr < 1) throw missing('no PR number to bind the run to');
  if (typeof head !== 'string' || !SHA.test(head)) throw missing('no full head SHA to look for');
  if (!isObject(base) || !isStr(base.ref)) throw missing('no base branch to bind the run to');
  if (git(['rev-parse', '--verify', 'HEAD'], { cwd: root }).trim() !== head) throw missing('the worktree HEAD is not the head being judged');

  const slug = gh.repo().slug;
  if (!isStr(slug)) throw missing('could not name the repository');
  const view = gh.prView(pr, ['headRefOid', 'headRefName', 'baseRefName']);
  if (view?.headRefOid !== head) throw missing(`the PR head is ${String(view?.headRefOid).slice(0, 7)}, not ${head.slice(0, 7)}`);
  if (!isStr(view.headRefName)) throw missing('GitHub did not name the PR branch');
  if (view.baseRefName !== base.ref) throw missing(`the PR targets ${view.baseRefName}, not ${base.ref}`);

  const run = newestRun(candidateRuns({ gh, slug, head, spec }), spec, head);
  const label = `run ${run.id} attempt ${run.run_attempt}`;
  checkBinding({ run, pr, base, slug, view });

  if (run.status !== 'completed') {
    if (PENDING_STATUSES.has(run.status)) return { state: 'pending', reason: `${label} of ${spec.workflow} is ${run.status}` };
    throw missing(`${label} has the unknown status "${run.status}"`);
  }
  if (run.conclusion === 'cancelled') throw missing(`${label} was cancelled (superseded), so it proves nothing`);
  if (run.conclusion === 'skipped') throw missing(`${label} was skipped (a draft PR, or a path filter)`);
  if (!['success', 'failure', 'timed_out'].includes(run.conclusion)) throw missing(`${label} ended ${run.conclusion ?? 'without a conclusion'}`);

  const mergeSha = mergeCommitOf(run, pr);
  treeOfMergeCommit({ gh, slug, sha: mergeSha, root, run, pr });

  const job = pickJob({ gh, slug, run, spec, head });
  if (job.status !== 'completed') {
    if (PENDING_STATUSES.has(job.status)) return { state: 'pending', reason: `job "${spec.job}" of ${label} is ${job.status}` };
    throw missing(`job "${spec.job}" of ${label} has the unknown status "${job.status}"`);
  }
  if (job.conclusion === 'success') {
    if (spec.steps !== undefined) checkSteps({ gh, slug, job, spec, label });
    const how = `tested merge commit ${mergeSha.slice(0, 7)}, tree equal to HEAD`;
    return {
      state: 'pass',
      reason: `job "${spec.job}" passed in ${label} of ${spec.workflow} (${how})${spec.steps !== undefined ? `; steps succeeded: ${spec.steps.map((n) => `"${n}"`).join(', ')}` : ''}`,
      run: {
        id: run.id, attempt: run.run_attempt, jobId: job.id, workflow: spec.workflow, job: spec.job, url: isStr(run.html_url) ? run.html_url : `https://github.com/${slug}/actions/runs/${run.id}`,
        ...(spec.steps !== undefined ? { steps: [...spec.steps] } : {}),
      },
    };
  }
  if (job.conclusion === 'failure' || job.conclusion === 'timed_out') return { state: 'failure', reason: `job "${spec.job}" ${job.conclusion} in ${label} of ${spec.workflow}` };
  throw missing(`job "${spec.job}" of ${label} ended ${job.conclusion ?? 'without a conclusion'} (${job.conclusion === 'cancelled' ? 'superseded' : 'not a pass'})`);
}

export async function ciProof(args) {
  try {
    return await lookup(args ?? {});
  } catch (err) {
    if (err instanceof Verdict) return { state: err.state, reason: err.message };
    return { state: 'missing', reason: `the GitHub lookup failed: ${String(err?.message ?? err).split('\n')[0].slice(0, 240)}` };
  }
}
