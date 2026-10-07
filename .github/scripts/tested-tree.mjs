// Decides whether a push-to-main CI job can be skipped because this exact tree already passed the same job on the PR.
// Prints the evidence and writes `run=true|false` to $GITHUB_OUTPUT. It only ever answers `false` when every check below
// holds; any doubt or error answers `true` (fail open toward running), and the exit code is always 0.
//
//   1. the pushed commit has exactly one associated PR, merged, with base `main`;
//   2. that PR head commit's tree is byte-identical to the pushed commit's tree;
//   3. the PR head contains the commit main was at just before this push, so the PR run's merge-ref checkout
//      (refs/pull/N/merge = head + base at the time) had the same tree as the head itself;
//   4. a completed run of this workflow (event pull_request) on the PR head sha has a job with the SAME name as
//      this one that concluded `success` (any attempt).
//
// Env: REPO (owner/name), SHA (pushed commit), JOB_NAME (this job's display name), GH_TOKEN (read by gh),
//      GITHUB_OUTPUT (optional), WORKFLOW_FILE (default ci.yml), BASE_BRANCH (default main),
//      TESTED_TREE_GH_ARGV (tests only: JSON array standing in for ["gh"], e.g. ["node","fake-gh.mjs"]).
import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';

const { REPO, SHA, JOB_NAME, GITHUB_OUTPUT } = process.env;
const WORKFLOW_FILE = process.env.WORKFLOW_FILE || 'ci.yml';
const BASE_BRANCH = process.env.BASE_BRANCH || 'main';
const ghArgv = process.env.TESTED_TREE_GH_ARGV ? JSON.parse(process.env.TESTED_TREE_GH_ARGV) : ['gh'];

class Run extends Error {}
const mustRun = (why) => { throw new Run(why); };

function capture(argv) {
  const r = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error) mustRun(`${argv.join(' ')}: ${r.error.message}`);
  if (r.status !== 0) mustRun(`${argv.join(' ')} exited ${r.status}: ${(r.stderr || '').trim().slice(0, 200)}`);
  return r.stdout.trim();
}

function api(endpoint) {
  const out = capture([...ghArgv, 'api', endpoint]);
  try { return JSON.parse(out); } catch { return mustRun(`${endpoint}: reply is not JSON`); }
}

function decide() {
  if (!REPO || !SHA || !JOB_NAME) mustRun('REPO, SHA and JOB_NAME are required');
  const tree = capture(['git', 'rev-parse', 'HEAD^{tree}']);
  console.log(`pushed commit ${SHA} tree ${tree}`);

  const pulls = api(`repos/${REPO}/commits/${SHA}/pulls`);
  if (!Array.isArray(pulls) || pulls.length !== 1) mustRun(`expected exactly one associated PR, got ${Array.isArray(pulls) ? pulls.length : 'a non-list'}`);
  const pr = pulls[0];
  if (!pr.merged_at) mustRun(`PR #${pr.number} is not merged`);
  if (pr.base?.ref !== BASE_BRANCH) mustRun(`PR #${pr.number} base is ${pr.base?.ref}, not ${BASE_BRANCH}`);
  const head = pr.head?.sha;
  if (!/^[0-9a-f]{40}$/.test(head || '')) mustRun(`PR #${pr.number} has no head sha`);

  const headTree = api(`repos/${REPO}/git/commits/${head}`).tree?.sha;
  console.log(`PR #${pr.number} head ${head} tree ${headTree}`);
  if (!headTree || headTree !== tree) mustRun('tree differs from the PR head tree (PR branch was not up to date at merge, or the merge changed content)');

  const parent = api(`repos/${REPO}/commits/${SHA}`).parents?.[0]?.sha;
  if (!parent) mustRun('pushed commit has no parent');
  const status = api(`repos/${REPO}/compare/${parent}...${head}`).status;
  console.log(`PR head vs previous main ${parent}: ${status}`);
  if (status !== 'ahead' && status !== 'identical') mustRun(`PR head does not contain previous main (compare status ${status})`);

  const runs = api(`repos/${REPO}/actions/workflows/${WORKFLOW_FILE}/runs?head_sha=${head}&event=pull_request&per_page=100`).workflow_runs;
  if (!Array.isArray(runs)) mustRun('no workflow_runs list');
  for (const wr of runs) {
    if (wr.status !== 'completed') continue;
    const jobs = api(`repos/${REPO}/actions/runs/${wr.id}/jobs?filter=all&per_page=100`).jobs;
    if (!Array.isArray(jobs)) mustRun(`run ${wr.id}: no jobs list`);
    const ok = jobs.find((j) => j.name === JOB_NAME && j.conclusion === 'success');
    if (ok) {
      console.log(`evidence: run ${wr.id} (${wr.html_url ?? 'no url'}) job "${JOB_NAME}" concluded ${ok.conclusion} on PR head ${head}`);
      return false;
    }
  }
  return mustRun(`no completed ${WORKFLOW_FILE} pull_request run of ${head} has a successful "${JOB_NAME}" job`);
}

let run = true;
try {
  run = decide();
  console.log('SKIP: this exact tree already passed this job on the PR');
} catch (e) {
  console.log(`RUN: ${e instanceof Run ? e.message : `unexpected error: ${e?.message ?? e}`}`);
}
if (GITHUB_OUTPUT) appendFileSync(GITHUB_OUTPUT, `run=${run}\n`);
process.exitCode = 0;
