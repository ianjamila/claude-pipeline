// The CI-proof lookup (pipeline/lib/ci-proof.mjs): run selection, PR binding, what-was-tested, job rules and fail-closed behaviour,
// against a fake GitHub serving the real reply shapes (test/fixtures/ci-proof). The gate rules around it are in ci-proof-gate*.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ciProof } from '../pipeline/lib/ci-proof.mjs';
import { MERGE_SHA, SLUG, SPEC, jobsFor, lookupScenario, runFor, stepsList } from './helpers/ci-proof-lookup-env.mjs';

const lookup = (s) => ciProof(s.args);
const is = (res, state, text, label) => {
  assert.equal(res.state, state, `${label ?? ''}: ${res.reason}`);
  assert.equal(typeof res.reason, 'string');
  assert.ok(res.reason.length > 0);
  if (text) assert.match(res.reason, text, label);
  if (state !== 'pass') assert.equal(res.run, undefined, `${label ?? ''}: only a pass names a run`);
};

// ---- selection -------------------------------------------------------------------------------------

test('exact-head success passes and names the run, attempt, job, workflow and url; the listing asks for this head, event and workflow file', async () => {
  const s = lookupScenario();
  const run = s.addRun({ id: 5001, attempt: 2 });
  s.jobs[5001] = jobsFor(run);
  const res = await lookup(s);
  is(res, 'pass', /job "SQL arms" passed in run 5001 attempt 2.*tested merge commit d{7}/);
  assert.deepEqual(res.run, {
    id: 5001, attempt: 2, jobId: 500100 + 4, workflow: SPEC.workflow, job: 'SQL arms', url: `https://github.com/${SLUG}/actions/runs/5001`,
  });
  const listing = s.calls.find((c) => c.includes('/workflows/'));
  assert.match(listing, new RegExp(`^GET repos/${SLUG}/actions/workflows/migration-replay\\.yml/runs\\?head_sha=${s.head}&event=pull_request&per_page=100&page=1$`));
  assert.ok(s.calls.some((c) => c.includes('/actions/runs/5001/attempts/2/jobs?per_page=100')), 'jobs of the run\'s own attempt');
});

test('no run for the head, a run for another head, another workflow path with the same job name, another event, or another repository: all missing', async () => {
  const s = lookupScenario();
  is(await lookup(s), 'missing', /no pull_request run of .*migration-replay\.yml for/, 'nothing at all');

  s.addRun({ patch: { head_sha: 'e'.repeat(40) } });
  is(await lookup(s), 'missing', /no pull_request run/, 'other head');

  const other = lookupScenario();
  other.addRun({ patch: { path: '.github/workflows/impostor.yml' } });
  is(await lookup(other), 'missing', /no pull_request run/, 'other workflow with the same job name');

  const ev = lookupScenario();
  ev.addRun({ patch: { event: 'push' } });
  is(await lookup(ev), 'missing', /no pull_request run/, 'other event');

  const repoMismatch = lookupScenario();
  repoMismatch.addRun({ patch: { repository: { full_name: 'someone/else' } } });
  is(await lookup(repoMismatch), 'missing', /no pull_request run/, 'other repository');
});

test('the @ref suffix GitHub can append to a run path is stripped; the file must still be the configured one', async () => {
  const s = lookupScenario();
  s.addRun({ patch: { path: `${SPEC.workflow}@refs/pull/12/merge` } });
  is(await lookup(s), 'pass', null, 'suffix stripped');
  const t = lookupScenario();
  t.addRun({ patch: { path: '.github/workflows/migration-replay.yml.bak@refs/heads/main' } });
  is(await lookup(t), 'missing', null, 'a different file with a similar name');
});

test('the highest run_number wins, then the run\'s newest attempt: an older success never beats a newer failure or a newer attempt', async () => {
  const s = lookupScenario();
  s.addRun({ id: 1, number: 10 });
  const newer = s.addRun({ id: 2, number: 11 });
  s.jobs[2] = jobsFor(newer, { patch: (j) => { j.conclusion = 'failure'; } });
  is(await lookup(s), 'failure', /job "SQL arms" failure in run 2 attempt 1/, 'newer run red, older green');

  const order = lookupScenario();
  order.addRun({ id: 3, number: 12 }); // listed first, but 11 is the higher number below
  order.addRun({ id: 4, number: 9 });
  assert.equal((await lookup(order)).run.id, 3, 'listing order is irrelevant');

  const attempts = lookupScenario();
  const rerun = attempts.addRun({ id: 7, number: 20, attempt: 3 });
  attempts.jobs[7] = jobsFor(rerun, { patch: (j) => { j.conclusion = 'failure'; } });
  const res = await lookup(attempts);
  is(res, 'failure', /run 7 attempt 3/, 'the run\'s newest attempt');
  assert.ok(attempts.calls.some((c) => c.includes('/runs/7/attempts/3/jobs')));
  assert.ok(!attempts.calls.some((c) => c.includes('/attempts/1/jobs')));
});

test('a newer run or attempt that is queued or in progress makes the answer pending, never the older success', async () => {
  for (const status of ['queued', 'in_progress', 'waiting', 'requested', 'pending']) {
    const s = lookupScenario();
    s.addRun({ id: 1, number: 10 });
    s.addRun({ id: 2, number: 11, patch: { status, conclusion: null } });
    is(await lookup(s), 'pending', new RegExp(`run 2 attempt 1 of .* is ${status}`), `newer run ${status}`);
    assert.ok(!s.calls.some((c) => c.includes('/jobs?')), 'no job lookup for a run that is still going');
  }
  const rerun = lookupScenario();
  rerun.addRun({ id: 1, number: 10, attempt: 2, patch: { status: 'in_progress', conclusion: null } });
  is(await lookup(rerun), 'pending', /run 1 attempt 2/, 're-run attempt in progress');

  const job = lookupScenario();
  const r = job.addRun({ id: 1, number: 10 });
  job.jobs[1] = jobsFor(r, { patch: (j) => { j.status = 'in_progress'; j.conclusion = null; } });
  is(await lookup(job), 'pending', /job "SQL arms" of run 1 attempt 1 is in_progress/, 'job still running');
});

test('equal run numbers, missing run metadata and unknown statuses are refused', async () => {
  const dup = lookupScenario();
  dup.addRun({ id: 1, number: 10 });
  dup.addRun({ id: 2, number: 10 });
  is(await lookup(dup), 'missing', /runs 1 and 2 share run number 10/, 'equal run_number');

  for (const field of ['run_number', 'run_attempt', 'status']) {
    const s = lookupScenario();
    s.addRun({ patch: { [field]: undefined } });
    is(await lookup(s), 'missing', /lacks run_number, run_attempt or status/, `missing ${field}`);
  }
  const noId = lookupScenario();
  noId.addRun({ patch: { id: undefined } });
  is(await lookup(noId), 'missing', /no id/, 'no id');

  const weird = lookupScenario();
  weird.addRun({ patch: { status: 'hovering' } });
  is(await lookup(weird), 'missing', /unknown status "hovering"/, 'unknown status');
});

// ---- pagination ------------------------------------------------------------------------------------

test('pagination: the matching run on page 2 of 150 is found; a truncated page, a moving total, duplicates and an odd shape are refused', async () => {
  const noise = (s, n) => { for (let i = 0; i < n; i += 1) s.runs.push(runFor({ head: s.head, id: 100 + i, number: 1 + i, patch: { head_sha: 'f'.repeat(40) } })); };

  const s = lookupScenario();
  noise(s, 120);
  s.addRun({ id: 9000, number: 500 }); // index 120: second page
  s.jobs[9000] = jobsFor(s.runs.at(-1));
  const res = await lookup(s);
  is(res, 'pass', null, 'found on page 2');
  assert.equal(res.run.id, 9000);
  assert.ok(s.calls.some((c) => c.includes('page=2')));

  const truncated = lookupScenario();
  noise(truncated, 120);
  truncated.addRun({ id: 9000, number: 500 });
  truncated.totals['/workflows/'] = 150; // GitHub says 150, only 121 come back
  is(await lookup(truncated), 'missing', /incomplete \(121 of 150, page 2 was short\)/, 'truncated');

  const tooMany = lookupScenario();
  noise(tooMany, 120);
  tooMany.totals['/workflows/'] = 50;
  is(await lookup(tooMany), 'missing', /more entries than its total/, 'more than the total');

  const empty = lookupScenario();
  empty.totals['/workflows/'] = 3;
  is(await lookup(empty), 'missing', /incomplete \(0 of 3/, 'total but nothing returned');

  const dup = lookupScenario();
  noise(dup, 100);
  dup.runs.push(dup.runs[0]); // the same run again on page 2
  dup.totals['/workflows/'] = 101;
  is(await lookup(dup), 'missing', /listed twice/, 'duplicate across pages');

  const shape = lookupScenario();
  shape.gh.api = () => ({ workflow_runs: 'many' });
  is(await lookup(shape), 'missing', /unexpected shape/, 'odd shape');
  const noTotal = lookupScenario();
  noTotal.gh.api = () => ({ workflow_runs: [] });
  is(await lookup(noTotal), 'missing', /unexpected shape/, 'no total_count');

  const moving = lookupScenario();
  noise(moving, 120);
  let calls = 0;
  const real = moving.gh.api;
  moving.gh.api = (m, p) => { const b = real(m, p); calls += 1; return calls === 2 ? { ...b, total_count: b.total_count + 1 } : b; };
  is(await lookup(moving), 'missing', /changed while it was being read/, 'total moved between pages');
});

// ---- jobs ------------------------------------------------------------------------------------------

test('exactly one job named like the configured one: shards alone, duplicates or no listing are refused; the aggregator among shards is picked', async () => {
  const s = lookupScenario();
  const run = s.addRun();
  const res = await lookup(s);
  is(res, 'pass', null, 'aggregator among shard and other jobs');
  assert.equal(res.run.jobId, run.id * 100 + 4, 'the "SQL arms" job, not a "SQL arms (shard n/3)" one');

  const shardsOnly = lookupScenario();
  const r2 = shardsOnly.addRun();
  shardsOnly.jobs[r2.id].jobs = shardsOnly.jobs[r2.id].jobs.filter((j) => j.name !== 'SQL arms');
  shardsOnly.jobs[r2.id].total_count = 6;
  is(await lookup(shardsOnly), 'missing', /has 0 jobs named "SQL arms"/, 'shards only');

  const twice = lookupScenario();
  const r3 = twice.addRun();
  twice.jobs[r3.id].jobs.push({ ...twice.jobs[r3.id].jobs[4], id: 999 });
  twice.jobs[r3.id].total_count = 8;
  is(await lookup(twice), 'missing', /has 2 jobs named "SQL arms"/, 'matrix gives the same name twice');

  const jobPages = lookupScenario();
  const r4 = jobPages.addRun();
  const body = jobPages.jobs[r4.id];
  const filler = Array.from({ length: 110 }, (_, i) => ({ ...body.jobs[2], id: 70000 + i, name: `filler ${i}` }));
  body.jobs = [...filler, ...body.jobs];
  body.total_count = body.jobs.length;
  const paged = await lookup(jobPages);
  is(paged, 'pass', null, 'aggregator on job page 2');
  assert.ok(jobPages.calls.some((c) => c.includes('/jobs?per_page=100&page=2')));

  const cut = lookupScenario();
  const r5 = cut.addRun();
  cut.jobs[r5.id].total_count = 9; // 7 returned
  is(await lookup(cut), 'missing', /job listing is incomplete \(7 of 9/, 'truncated job listing');

  const foreign = lookupScenario();
  const r6 = foreign.addRun();
  foreign.jobs[r6.id] = jobsFor(r6, { patch: (j) => { j.run_attempt = 9; } });
  is(await lookup(foreign), 'missing', /from attempt 9, not 1/, 'job from another attempt');
  const otherHead = lookupScenario();
  const r7 = otherHead.addRun();
  otherHead.jobs[r7.id] = jobsFor(r7, { patch: (j) => { j.head_sha = 'a'.repeat(40); } });
  is(await lookup(otherHead), 'missing', /ran aaaaaaa, not/, 'job from another head');

  // run_id, run_attempt and head_sha are REQUIRED on the job: absent is as bad as wrong
  for (const field of ['run_id', 'run_attempt', 'head_sha']) {
    const bare = lookupScenario();
    const r8 = bare.addRun();
    bare.jobs[r8.id] = jobsFor(r8, { patch: (j) => { delete j[field]; } });
    is(await lookup(bare), 'missing', /\(unknown\)/, `job without ${field}`);
  }
  const wrongRun = lookupScenario();
  const r9 = wrongRun.addRun();
  wrongRun.jobs[r9.id] = jobsFor(r9, { patch: (j) => { j.run_id = 1; } });
  is(await lookup(wrongRun), 'missing', /belongs to run 1, not/, 'job of another run');
});

test('job outcomes: failure and timed_out are failures; cancelled, skipped, neutral and unknown are missing (a cancelled run was superseded, not red)', async () => {
  for (const conclusion of ['failure', 'timed_out']) {
    const s = lookupScenario();
    const run = s.addRun();
    s.jobs[run.id] = jobsFor(run, { patch: (j) => { j.conclusion = conclusion; } });
    is(await lookup(s), 'failure', new RegExp(`job "SQL arms" ${conclusion} in run ${run.id}`), conclusion);
  }
  for (const conclusion of ['cancelled', 'skipped', 'neutral', 'action_required', null]) {
    const s = lookupScenario();
    const run = s.addRun();
    s.jobs[run.id] = jobsFor(run, { patch: (j) => { j.conclusion = conclusion; } });
    is(await lookup(s), 'missing', /ended/, `job ${conclusion}`);
  }
  const weird = lookupScenario();
  const w = weird.addRun();
  weird.jobs[w.id] = jobsFor(w, { patch: (j) => { j.status = 'teleporting'; } });
  is(await lookup(weird), 'missing', /unknown status "teleporting"/, 'unknown job status');

  for (const conclusion of ['cancelled', 'skipped', 'stale', 'startup_failure', null]) {
    const s = lookupScenario();
    s.addRun({ patch: { conclusion } });
    is(await lookup(s), 'missing', /cancelled \(superseded\)|skipped|ended/, `run ${conclusion}`);
    assert.ok(!s.calls.some((c) => c.includes('/jobs?')), 'no job lookup for a run that cannot count');
  }
  // a red run whose own job is green (another job failed) still proves the job
  const red = lookupScenario();
  red.addRun({ patch: { conclusion: 'failure' } });
  is(await lookup(red), 'pass', null, 'the proof is the job, not the whole run');
});

// ---- binding ---------------------------------------------------------------------------------------

test('the run must belong to THIS PR: another PR or base, empty or several pull_requests, another branch or a fork head are all refused', async () => {
  const cases = [
    ['another PR', { pull_requests: [{ number: 13, base: { ref: 'main' } }] }, /about PR #13, not #12/],
    ['another base', { pull_requests: [{ number: 12, base: { ref: 'release' } }] }, /into release, not main/],
    ['empty pull_requests', { pull_requests: [] }, /lists no pull request/],
    ['absent pull_requests', { pull_requests: undefined }, /lists no pull request/],
    ['two pull_requests', { pull_requests: [{ number: 12, base: { ref: 'main' } }, { number: 13, base: { ref: 'main' } }] }, /lists 2 pull requests/],
    ['another branch', { head_branch: 'someone-elses-branch' }, /ran branch someone-elses-branch, the PR's branch is agent\/feature/],
    ['a fork head', { head_repository: { full_name: 'fork/widgets' } }, /fork never counts/],
    ['no head repository (deleted fork)', { head_repository: null }, /fork never counts/],
  ];
  for (const [label, patch, text] of cases) {
    const s = lookupScenario();
    s.addRun({ patch });
    is(await lookup(s), 'missing', text, label);
    assert.ok(!s.calls.some((c) => c.includes('/jobs?')), `${label}: no job lookup for an unbound run`);
  }
  // the NEWEST run decides: an older, correctly bound run is not a fallback
  const s = lookupScenario();
  s.addRun({ id: 1, number: 10 });
  s.addRun({ id: 2, number: 11, patch: { pull_requests: [] } });
  is(await lookup(s), 'missing', /run 2 lists no pull request/, 'older bound run is not a fallback');
});

test('the PR itself is read live: a moved head, another base branch or no branch name is refused', async () => {
  const moved = lookupScenario();
  moved.addRun();
  moved.view.headRefOid = 'b'.repeat(40);
  is(await lookup(moved), 'missing', /PR head is bbbbbbb, not/, 'head moved');
  assert.ok(!moved.calls.some((c) => c.includes('/workflows/')), 'no listing before the PR is confirmed');

  const base = lookupScenario();
  base.addRun();
  base.view.baseRefName = 'release';
  is(await lookup(base), 'missing', /PR targets release, not main/, 'other base');

  const noName = lookupScenario();
  noName.addRun();
  noName.view.headRefName = '';
  is(await lookup(noName), 'missing', /did not name the PR branch/, 'no branch');
});

// ---- what was tested -------------------------------------------------------------------------------

test('referenced_workflows: the merge commit\'s tree must equal HEAD\'s tree (match passes, mismatch is missing); the check also guards a red run', async () => {
  const same = lookupScenario();
  same.addRun();
  const ok = await lookup(same);
  is(ok, 'pass', /tested merge commit ddddddd, tree equal to HEAD/);
  assert.ok(same.calls.some((c) => c === `GET repos/${SLUG}/git/commits/${MERGE_SHA}`));

  const diff = lookupScenario();
  diff.addRun();
  diff.mergeTree = '1'.repeat(40);
  is(await lookup(diff), 'missing', /tested merge commit ddddddd .*whose tree is not this PR head's tree/, 'tree mismatch');

  const red = lookupScenario();
  const r = red.addRun();
  red.jobs[r.id] = jobsFor(r, { patch: (j) => { j.conclusion = 'failure'; } });
  red.mergeTree = '1'.repeat(40);
  is(await lookup(red), 'missing', /whose tree is not/, 'a red job on the wrong tree is not "failure" either');

  const noTree = lookupScenario();
  noTree.addRun();
  noTree.mergeTree = 'not-a-sha';
  is(await lookup(noTree), 'missing', /did not return the tree/, 'unreadable tree');

  const apiDown = lookupScenario();
  apiDown.addRun();
  apiDown.fail.add('/git/commits/');
  is(await lookup(apiDown), 'missing', /GitHub lookup failed.*HTTP 502/, 'commit API error');
});

test('referenced_workflows: another PR\'s merge ref, a malformed sha or several merge commits are refused; unrelated entries are ignored; no merge-commit evidence at all is missing (no weaker case)', async () => {
  const cases = [
    ['another PR ref', [{ ref: 'refs/pull/13/merge', sha: MERGE_SHA }], /executed refs\/pull\/13\/merge, not refs\/pull\/12\/merge/],
    ['no sha', [{ ref: 'refs/pull/12/merge' }], /names no merge commit/],
    ['short sha', [{ ref: 'refs/pull/12/merge', sha: 'abc123' }], /names no merge commit/],
    ['two merge commits', [{ ref: 'refs/pull/12/merge', sha: MERGE_SHA }, { ref: 'refs/pull/12/merge', sha: 'e'.repeat(40) }], /more than one merge commit/],
  ];
  for (const [label, refs, text] of cases) {
    const s = lookupScenario();
    s.addRun({ patch: { referenced_workflows: refs } });
    is(await lookup(s), 'missing', text, label);
  }
  const notAList = lookupScenario();
  notAList.addRun({ patch: { referenced_workflows: 'refs/pull/12/merge' } });
  is(await lookup(notAList), 'missing', /unreadable referenced_workflows/, 'not a list');

  const unrelated = lookupScenario();
  unrelated.addRun({ patch: { referenced_workflows: [{ path: 'org/shared/.github/workflows/x.yml@v1', ref: 'refs/tags/v1', sha: 'c'.repeat(40) }, { ref: 'refs/pull/12/merge', sha: MERGE_SHA }] } });
  is(await lookup(unrelated), 'pass', /tested merge commit/, 'a reusable workflow from another repo is ignored');

  for (const refs of [undefined, null, [], [{ path: 'org/shared/.github/workflows/x.yml@v1', ref: 'refs/tags/v1', sha: 'c'.repeat(40) }]]) {
    const weak = lookupScenario();
    weak.addRun({ patch: { referenced_workflows: refs } });
    const res = await lookup(weak);
    is(res, 'missing', /run 5001 does not say which merge commit it tested; the Mac runs the step/, `no evidence ${JSON.stringify(refs)}`);
    assert.ok(!weak.calls.some((c) => c.includes('/git/commits/') || c.includes('/jobs?')), 'nothing further is looked up');
  }
});

// ---- fail closed -----------------------------------------------------------------------------------

test('any GitHub or gh error is missing with the reason, after one attempt (no retries)', async () => {
  for (const [label, key, text] of [
    ['repo lookup', 'repo', /gh repo view failed/],
    ['PR lookup', 'prView', /gh pr view failed/],
    ['run listing', '/workflows/', /gh api repos\/acme\/widgets\/actions\/workflows.* failed/],
    ['job listing', '/jobs?', /gh api repos\/acme\/widgets\/actions\/runs.* failed/],
  ]) {
    const s = lookupScenario();
    s.addRun();
    s.fail.add(key);
    const res = await lookup(s);
    is(res, 'missing', text, label);
    assert.match(res.reason, /^the GitHub lookup failed:/);
    const hits = s.calls.filter((c) => (key === 'repo' || key === 'prView' ? c.startsWith('pr view') : c.includes(key)));
    assert.ok(hits.length <= 1, `${label}: asked ${hits.length} times`);
  }
  const garbage = lookupScenario();
  garbage.addRun();
  garbage.gh.api = () => { throw new SyntaxError('Unexpected token < in JSON\nat line 2'); };
  const res = await lookup(garbage);
  is(res, 'missing', /Unexpected token < in JSON$/, 'unparseable body (first line only)');
});

test('unusable inputs never reach GitHub: a bad spec, PR, head, base or a worktree that is not at the head', async () => {
  const s = lookupScenario();
  s.addRun();
  const a = s.args;
  for (const [label, patch] of [
    ['workflow outside .github/workflows', { spec: { ...SPEC, workflow: 'scripts/ci.yml' } }],
    ['workflow in a subfolder', { spec: { ...SPEC, workflow: '.github/workflows/sub/x.yml' } }],
    ['no job', { spec: { ...SPEC, job: '' } }],
    ['no event', { spec: { ...SPEC, event: undefined } }],
    ['spec is a string', { spec: 'ci' }],
    ['PR 0', { pr: 0 }],
    ['PR as string', { pr: '12' }],
    ['short head', { head: 'abc' }],
    ['uppercase head', { head: s.head.toUpperCase() }],
    ['no base ref', { base: {} }],
    ['worktree elsewhere', { head: 'a'.repeat(40) }],
  ]) {
    s.calls.length = 0;
    const res = await ciProof({ ...a, ...patch });
    is(res, 'missing', null, label);
    assert.deepEqual(s.calls, [], `${label}: no GitHub call`);
  }
  is(await ciProof(undefined), 'missing', null, 'no arguments at all');
  is(await ciProof({}), 'missing', null, 'empty arguments');
  is(await ciProof({ ...a, root: '/nonexistent/dir/for/ci-proof' }), 'missing', /GitHub lookup failed|HEAD/, 'unreadable worktree');
});

// ---- required job steps (spec.steps, rule 5) -------------------------------------------------------

const WORK = ['Typecheck', 'Vitest'];
// A scenario whose aggregator job carries `steps` laid out like checks.yml's "Typecheck + Vitest"; the spec asks for WORK to have succeeded.
function stepScenario({ outcomes, names, listing = true, steps = WORK } = {}) {
  const s = lookupScenario();
  const run = s.addRun();
  s.jobs[run.id] = jobsFor(run, { patch: (j) => { if (listing) j.steps = stepsList(outcomes, names); } });
  const args = s.args;
  return { s, run, ask: () => ciProof({ ...args, spec: { ...args.spec, steps } }) };
}

test('steps: the job and every named step succeeded -> pass, naming the steps in the reason and on the run', async () => {
  const { s, ask } = stepScenario();
  const res = await ask();
  is(res, 'pass', /job "SQL arms" passed in run 5001 attempt 1.*; steps succeeded: "Typecheck", "Vitest"/);
  assert.deepEqual(res.run.steps, WORK);
  assert.ok(!s.calls.some((c) => c.includes('/actions/jobs/')), 'the listing already had the steps: no extra read');
});

test('steps: the docs-only case (job success, every work step skipped) is missing, not a pass', async () => {
  const skipped = { Typecheck: ['completed', 'skipped'], Vitest: ['completed', 'skipped'], Install: ['completed', 'skipped'] };
  const { ask } = stepScenario({ outcomes: skipped });
  is(await ask(), 'missing', /step "Typecheck" of job "SQL arms" in run 5001 attempt 1 did not succeed \(skipped\); the Mac runs the step/, 'both skipped');
  const one = stepScenario({ outcomes: { Vitest: ['completed', 'skipped'] } });
  is(await one.ask(), 'missing', /step "Vitest" .*\(skipped\)/, 'one of two skipped');
});

test('steps: absent, listed twice, failure under a green job, cancelled, neutral, unfinished and unknown conclusions are all missing', async () => {
  const absent = stepScenario({ names: ['Set up job', 'Checkout', 'Typecheck'] });
  is(await absent.ask(), 'missing', /step "Vitest" is not in job "SQL arms"/, 'absent');
  const twice = stepScenario({ names: ['Set up job', 'Typecheck', 'Vitest', 'Vitest'] });
  is(await twice.ask(), 'missing', /step "Vitest" is listed 2 times in job "SQL arms"/, 'duplicated');
  for (const [label, outcome, text] of [
    ['failure under success (continue-on-error)', ['completed', 'failure'], /\(failure\)/],
    ['cancelled', ['completed', 'cancelled'], /\(cancelled\)/],
    ['neutral', ['completed', 'neutral'], /\(neutral\)/],
    ['unknown conclusion', ['completed', 'surprising'], /\(surprising\)/],
    ['no conclusion', ['completed', null], /\(no conclusion\)/],
    ['still running', ['in_progress', null], /\(in_progress\)/],
    ['pending', ['pending', null], /\(pending\)/],
  ]) {
    const t = stepScenario({ outcomes: { Typecheck: outcome } });
    const res = await t.ask();
    is(res, 'missing', text, label);
    assert.match(res.reason, /step "Typecheck"/, label);
  }
  const garbage = stepScenario();
  garbage.s.jobs[5001].jobs.find((j) => j.name === SPEC.job).steps.push('not an object');
  is(await garbage.ask(), 'missing', /unreadable entry in its steps/, 'a malformed entry');
});

test('steps: the job\'s own verdict still wins - a failed job is failure and a pending job is pending without looking at steps', async () => {
  const red = stepScenario();
  red.s.jobs[5001].jobs.find((j) => j.name === SPEC.job).conclusion = 'failure';
  is(await red.ask(), 'failure', /job "SQL arms" failure/);
  const running = stepScenario();
  Object.assign(running.s.jobs[5001].jobs.find((j) => j.name === SPEC.job), { status: 'in_progress', conclusion: null });
  is(await running.ask(), 'pending', /is in_progress/);
});

test('steps: a job object without steps in the listing costs one actions/jobs/<id> read; nothing usable there is missing', async () => {
  const fetched = stepScenario({ listing: false });
  const job = fetched.s.jobs[5001].jobs.find((j) => j.name === SPEC.job);
  fetched.s.jobDetail[job.id] = { ...job, steps: stepsList() };
  const res = await fetched.ask();
  is(res, 'pass', /steps succeeded/, 'steps read from the job');
  assert.equal(fetched.s.calls.filter((c) => c === `GET repos/${SLUG}/actions/jobs/${job.id}`).length, 1, 'exactly one extra read');

  const emptyList = stepScenario({ listing: false });
  const j2 = emptyList.s.jobs[5001].jobs.find((j) => j.name === SPEC.job);
  j2.steps = [];
  emptyList.s.jobDetail[j2.id] = { ...j2, steps: stepsList({ Vitest: ['completed', 'skipped'] }) };
  is(await emptyList.ask(), 'missing', /step "Vitest" .*\(skipped\)/, 'an empty listed steps array is not usable: the fallback is read, and its verdict counts');

  const noSteps = stepScenario({ listing: false });
  is(await noSteps.ask(), 'missing', /lists no steps, so its required steps cannot be checked/, 'the job read has no steps either');

  const wrongJob = stepScenario({ listing: false });
  const j3 = wrongJob.s.jobs[5001].jobs.find((j) => j.name === SPEC.job);
  wrongJob.s.jobDetail[j3.id] = { ...j3, id: j3.id + 1, steps: stepsList() };
  is(await wrongJob.ask(), 'missing', /is not that job/, 'a reply for another job');

  const broken = stepScenario({ listing: false });
  broken.s.fail.add('/actions/jobs/');
  const bad = await broken.ask();
  is(bad, 'missing', /gh api .*\/actions\/jobs\/\d+ failed/, 'the extra read fails');
  assert.match(bad.reason, /^the GitHub lookup failed:/);
});

test('steps: without spec.steps nothing changes - no extra call, no steps on the run, the same reason', async () => {
  const s = lookupScenario();
  const run = s.addRun();
  s.jobs[run.id] = jobsFor(run, { patch: (j) => { j.steps = stepsList({ Typecheck: ['completed', 'skipped'] }); } });
  const res = await lookup(s);
  is(res, 'pass', /^job "SQL arms" passed in run 5001 attempt 1 of .*\(tested merge commit d{7}, tree equal to HEAD\)$/);
  assert.equal('steps' in res.run, false);
  assert.ok(!s.calls.some((c) => c.includes('/actions/jobs/')));
});

test('steps: an unusable spec.steps is missing before any GitHub call', async () => {
  const s = lookupScenario();
  s.addRun();
  const a = s.args;
  for (const [label, steps] of [['empty', []], ['duplicates', ['a', 'a']], ['non-string', ['a', 3]], ['blank', ['  ']], ['a string', 'Typecheck'], ['null', null], ['an object', {}]]) {
    s.calls.length = 0;
    const res = await ciProof({ ...a, spec: { ...a.spec, steps } });
    is(res, 'missing', /steps is not a non-empty list of distinct step names/, label);
    assert.deepEqual(s.calls, [], `${label}: no GitHub call`);
  }
});
