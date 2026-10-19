// Shared by ci-proof-merge*.test.mjs: the GitHub side of a scenario (workflow runs, jobs, merge commit) as scripted gh entries, and
// readers for what the CLI wrote to the PR. Split over files only so node runs the slow CLI tests in parallel.
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { assertExit } from './assert-exit.mjs';
import { ghEntries } from './gate-env.mjs';
import { fakeGhPath } from './fakegh-env.mjs';
import { decodeRecord } from '../../pipeline/lib/run-record.mjs';
import { parseEvent } from '../../pipeline/lib/run-events.mjs';

export { assertExit, ghEntries };
export const SEQ_GH = `node "${join(fakeGhPath, '..', 'fake-gh-seq.mjs')}"`;
export const WORKFLOW = '.github/workflows/ci.yml';
export const JOB = 'Unit tests';
export const MERGE_SHA = 'd'.repeat(40);
export const SLUG = 'acme/widgets';

// The GitHub side of one scenario: runs = [{ id, number, attempt?, status?, conclusion?, job? }] (job: the job's conclusion).
export function ciEntries(s, runs, { mergeTree = s.repo.git(['rev-parse', 'HEAD^{tree}']).trim() } = {}) {
  const run = (r) => ({
    id: r.id, run_number: r.number, run_attempt: r.attempt ?? 1, event: 'pull_request', path: WORKFLOW, status: r.status ?? 'completed',
    conclusion: r.status && r.status !== 'completed' ? null : (r.conclusion ?? 'success'), head_sha: s.head, head_branch: 'agent/feature',
    html_url: `https://github.com/${SLUG}/actions/runs/${r.id}`, repository: { full_name: SLUG }, head_repository: { full_name: SLUG },
    pull_requests: [{ number: 12, head: { ref: 'agent/feature', sha: s.head }, base: { ref: 'main', sha: s.baseTip } }],
    referenced_workflows: [{ path: `${SLUG}/.github/workflows/x.yml@${MERGE_SHA}`, ref: 'refs/pull/12/merge', sha: MERGE_SHA }],
  });
  const jobs = (r) => ({
    total_count: 2,
    jobs: [
      { id: r.id * 10, run_id: r.id, run_attempt: r.attempt ?? 1, name: JOB, status: 'completed', conclusion: r.job ?? 'success', head_sha: s.head },
      { id: r.id * 10 + 1, run_id: r.id, run_attempt: r.attempt ?? 1, name: 'lint', status: 'completed', conclusion: 'success', head_sha: s.head },
    ],
  });
  return [
    { match: `api repos/${SLUG}/actions/workflows/ci\\.yml/runs\\?`, stdoutJson: { total_count: runs.length, workflow_runs: runs.map(run) } },
    ...runs.map((r) => ({ match: `api repos/${SLUG}/actions/runs/${r.id}/attempts/${r.attempt ?? 1}/jobs\\?`, stdoutJson: jobs(r) })),
    { match: `api repos/${SLUG}/git/commits/${MERGE_SHA}$`, stdoutJson: { sha: MERGE_SHA, tree: { sha: mergeTree } } },
  ];
}

export const serve = (s, runs, opts) => s.fake.setScript([...ciEntries(s, runs, opts), ...ghEntries({ prHead: s.head })]);

// Every body written to the PR's comments: the summary comment(s) and the run events, decoded.
export function writes(s) {
  return s.fake.calls()
    .filter((c) => /-X (POST|PATCH) repos\/acme\/widgets\/issues/.test(c.argv.join(' ')))
    .map((c) => JSON.parse(c.stdin).body);
}
export const events = (s, kind) => writes(s).map(parseEvent).filter((e) => e?.kind === kind);
export const records = (s) => writes(s).map((b) => decodeRecord(b)).filter((d) => d.status === 'ok').map((d) => d.record);

export const okGate = (s) => {
  const g = s.gate();
  assertExit(g, 0, `${g.stderr}${g.stdout}`);
  return g;
};


