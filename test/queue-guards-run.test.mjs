// Tests for scripts/pipeline/queue-guards-run.mjs (the queue-guards workflow's poster). It runs the VENDORED copy from a tmp
// project with a scripted fake `gh` (test/fixtures/fake-gh-seq.mjs) standing in for GitHub; the statuses it posts are asserted from
// the fake's call log. Both phases run like the workflow does: Evaluate, then (after GitHub's artifact upload) --publish.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BLOCKING_LABELS } from '../pipeline/lib/finalgate.mjs';
import { parseQueueVerdictArtifactName, verdictArtifactName } from '../pipeline/lib/guard-provenance.mjs';
import { parseYaml } from '../pipeline/lib/yaml.mjs';
import { CONFIG, project, runNode, scratchDir } from './helpers/project.mjs';

const fakeGh = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-gh-seq.mjs');
const REPO = 'acme/app';
const sha = (c) => c.repeat(40);
const MAIN = sha('1');
const A = sha('a'); // queue commit of entry #3
const Q = sha('b'); // queue commit of entry #5 (the one under test)
const HEAD3 = sha('3');
const HEAD5 = sha('5');
const T = (hhmm) => `2026-10-01T${hhmm}:00Z`;
const BOT = 'github-actions[bot]';
const POSTER_RUN = 'https://github.example/acme/app/actions/runs/700';
const REF = `refs/heads/gh-readonly-queue/main/pr-5-${A}`;
const CTX = { integrity: 'Test integrity', hardstops: 'Hard-stop scan', review: 'Cross-model review' };
const REVIEW_ON = CONFIG(undefined, 'ci:\n  review_check: true\n');

const entry = (id, pr, head, headCommit, baseCommit) => ({
  id, state: 'AWAITING_CHECKS', headCommit: { oid: headCommit }, baseCommit: { oid: baseCommit },
  pullRequest: { number: pr, headRefOid: head, baseRefName: 'main' },
});
const TWO = () => [entry('E3', 3, HEAD3, A, MAIN), entry('E5', 5, HEAD5, Q, A)];
const queueReply = (nodes) => ({ data: { repository: { mergeQueue: { entries: { pageInfo: { hasNextPage: false }, nodes } } } } });
const COMPARE = { total: 2, commits: [{ sha: A, parents: 1, subject: 'Fix the thing (#3)' }, { sha: Q, parents: 1, subject: 'Add the other (#5)' }] };
const heads = { 3: HEAD3, 5: HEAD5 };
const runUrl = (pr) => `https://github.example/acme/app/actions/runs/${pr}00`;
const goodStatus = (pr) => ({ state: 'success', by: BOT, at: T('10:05'), url: runUrl(pr) });
const guardRun = (pr) => ({
  path: '.github/workflows/pipeline-guards.yml@refs/heads/main', event: 'pull_request_target', status: 'completed', head_sha: heads[pr], run_attempt: 1,
  created_at: T('10:00'), updated_at: T('10:12'), pull_requests: [{ number: pr, head: { sha: heads[pr] }, base: { ref: 'main', sha: sha('9') } }],
});
const lines = (a) => (a.length ? `${a.join('\n')}\n` : '');

// The scripted GitHub.
//   queue: [at evaluate, at publish] entry lists (the last repeats); queueFail: the Nth read fails (0 = evaluate)
//   status: (pr, check) -> a status object | an array (one per call) | null (none);  runs: (pr) -> run override (merged over guardRun)
//   labels / issues: blockers; prs: GET pulls/N answers (the publish re-check of a member that left the queue)
//   post: 'fail' makes every status POST fail
function script({ queue = [TWO()], queueFail = [], compare = COMPARE, status = goodStatus, runs = {}, artifacts = {}, labels = {}, issues = {}, prs = {}, defaultStatus = 'identical', post = 'ok' } = {}) {
  const ctxName = Object.entries(CTX);
  const statusEntries = [3, 5].flatMap((pr) => ctxName.map(([check, context]) => {
    const s = status(pr, check);
    const seq = s === null ? [{ stdout: 'null\n' }] : (Array.isArray(s) ? s : [s]).map((x) => ({ stdout: `${JSON.stringify(x)}\n` }));
    return { match: `^api repos/${REPO}/commits/${heads[pr]}/statuses\\?per_page=100 --jq .*context == "${context}"`, sequence: seq };
  }));
  return [
    { match: `^api repos/${REPO}/statuses/${Q} `, ...(post === 'fail' ? { code: 1, stderr: 'HTTP 500' } : { stdoutJson: { id: 1 } }) },
    { match: `^api repos/${REPO} --jq \\.default_branch`, stdout: 'main\n' },
    { match: '^api graphql ', sequence: queue.map((nodes, i) => (queueFail.includes(i) ? { code: 1, stderr: 'HTTP 502' } : { stdoutJson: queueReply(nodes) })) },
    { match: `^api repos/${REPO}/compare/[0-9a-f]{40}\\.\\.\\.${Q}\\?per_page=100 `, stdout: `${JSON.stringify(compare)}\n` },
    { match: `^api repos/${REPO}/compare/[0-9a-f]{40}\\.\\.\\.main `, stdout: `${defaultStatus}\n` },
    ...[3, 5].map((pr) => ({ match: `^api repos/${REPO}/issues/${pr}/labels --paginate`, stdout: lines(labels[pr] ?? []) })),
    ...['pipeline-pause', 'pipeline-rollback'].map((l) => ({ match: `^api repos/${REPO}/issues\\?state=open&labels=${l}`, stdout: lines(issues[l] ? [String(issues[l])] : []) })),
    ...statusEntries,
    ...[3, 5].flatMap((pr) => [
      { match: `^api repos/${REPO}/actions/runs/${pr}00 `, stdout: `${JSON.stringify({ ...guardRun(pr), ...(runs[pr] ?? {}) })}\n` },
      { match: `^api repos/${REPO}/actions/runs/${pr}00/artifacts\\?per_page=100 `, stdout: lines(artifacts[pr] ?? [verdictArtifactName({ head: heads[pr], integrity: 'success', hardstops: 'success', review: 'success' })]) },
    ]),
    ...Object.entries(prs).map(([n, body]) => ({ match: `^api repos/${REPO}/pulls/${n} `, stdout: `${JSON.stringify(body)}\n` })),
  ];
}

async function exec(opts = {}, { env = {}, config = REVIEW_ON, publish = true, args = [] } = {}) {
  const repo = await project({ config });
  const dir = scratchDir();
  const scriptFile = join(dir, 'script.json');
  const log = join(dir, 'log.jsonl');
  const output = join(dir, 'github-output');
  const verdictDir = join(dir, 'queue-verdict');
  writeFileSync(scriptFile, JSON.stringify(script(opts)));
  const runEnv = {
    GH_TOKEN: 'test-token', GITHUB_REPOSITORY: REPO, QUEUE_SHA: Q, QUEUE_REF: REF, QUEUE_EVENT: 'merge_group', RUN_URL: POSTER_RUN, GITHUB_RUN_ATTEMPT: '1',
    GITHUB_OUTPUT: output, PIPELINE_VERDICT_DIR: verdictDir, QUEUE_POLL_MS: '20', QUEUE_PENDING_WAIT_MS: '300',
    PIPELINE_GH: `node ${fakeGh}`, PIPELINE_FAKE_GH_SCRIPT: scriptFile, PIPELINE_FAKE_GH_LOG: log,
    ...env,
  };
  const phase1 = await runNode(['scripts/pipeline/queue-guards-run.mjs', ...args], { cwd: repo.dir, env: runEnv });
  let announced = '';
  try { announced = readFileSync(output, 'utf8'); } catch { /* nothing announced */ }
  const artifact = /^artifact=(.+)$/m.exec(announced)?.[1] ?? null;
  const publishNow = () => runNode(['scripts/pipeline/queue-guards-run.mjs', '--publish', ...args], { cwd: repo.dir, env: runEnv });
  const phase2 = publish && artifact && phase1.code === 0 ? await publishNow() : null;
  let verdict = null;
  try { verdict = JSON.parse(readFileSync(join(verdictDir, 'verdict.json'), 'utf8')); } catch { /* none written */ }
  let calls = [];
  try { calls = readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { /* gh never ran */ }
  const posts = calls.filter((c) => c.argv[0] === 'api' && c.argv[1] === `repos/${REPO}/statuses/${Q}`).map((c) => ({
    ...Object.fromEntries(c.argv.slice(2).map((a, i, all) => (all[i - 1] === '-f' ? a.split(/=(.*)/s).slice(0, 2) : null)).filter(Boolean)),
  }));
  // The state each context ended on (the last post wins on GitHub).
  const final = (context) => posts.filter((p) => p.context === context).at(-1);
  return { phase1, phase2, publishNow, artifact, verdict, verdictFile: join(verdictDir, 'verdict.json'), calls, posts, final, code: phase1.code !== 0 ? phase1.code : (phase2?.code ?? 0) };
}

const states = (r) => Object.fromEntries(Object.values(CTX).map((c) => [c, r.final(c)?.state]));
const ALL = (state) => ({ [CTX.integrity]: state, [CTX.hardstops]: state, [CTX.review]: state });

test('poster: both members verified => 3 success, artifact names Q', async () => {
  const r = await exec();
  assert.equal(r.code, 0, r.phase1.stderr + (r.phase2?.stderr ?? ''));
  assert.deepEqual(r.posts.slice(0, 3).map((p) => [p.context, p.state]), Object.values(CTX).map((c) => [c, 'pending']), 'pending first, one per context');
  assert.deepEqual(states(r), ALL('success'));
  for (const c of Object.values(CTX)) {
    assert.match(r.final(c).description, /^earned on their heads by #3, #5$/);
    assert.equal(r.final(c).target_url, POSTER_RUN);
  }
  assert.equal(r.artifact, `queue-verdict_v1_${Q}_success_success_success`);
  assert.deepEqual(parseQueueVerdictArtifactName(r.artifact), { queueSha: Q, integrity: 'success', hardstops: 'success', review: 'success' });
  assert.equal(r.verdict.version, 1);
  assert.equal(r.verdict.queueSha, Q);
  assert.deepEqual(r.verdict.members.map((m) => [m.pr, m.head]), [[3, HEAD3], [5, HEAD5]]);
  assert.equal(r.verdict.checks.integrity.state, 'success');
});

test('poster: member status by another creator / failed provenance => failure naming it', async () => {
  const other = await exec({ status: (pr, check) => (pr === 3 && check === 'hardstops' ? { ...goodStatus(3), by: 'mallory' } : goodStatus(pr)) });
  assert.equal(other.code, 0, other.phase1.stderr);
  assert.equal(other.final(CTX.hardstops).state, 'failure');
  assert.match(other.final(CTX.hardstops).description, /^#3: .*github-actions\[bot\]/);
  assert.equal(other.final(CTX.integrity).state, 'success', 'the other contexts are judged on their own');
  assert.equal(other.artifact, `queue-verdict_v1_${Q}_success_failure_success`);

  const wrongWorkflow = await exec({ runs: { 5: { path: '.github/workflows/other.yml@refs/heads/main' } } });
  assert.deepEqual(states(wrongWorkflow), ALL('failure'));
  assert.match(wrongWorkflow.final(CTX.integrity).description, /^#5: /);

  const notSuccess = await exec({ status: (pr, check) => (pr === 5 && check === 'review' ? { ...goodStatus(5), state: 'failure' } : goodStatus(pr)) });
  assert.equal(notSuccess.final(CTX.review).state, 'failure');
  assert.match(notSuccess.final(CTX.review).description, /^#5: /);

  const none = await exec({ status: (pr, check) => (pr === 3 && check === 'integrity' ? null : goodStatus(pr)) });
  assert.equal(none.final(CTX.integrity).state, 'failure');
  assert.match(none.final(CTX.integrity).description, /^#3: /);
});

test('poster: a failure reason is clipped to 80 characters', async () => {
  const r = await exec({ status: (pr) => ({ ...goodStatus(pr), by: 'x'.repeat(39) }) });
  const parts = r.final(CTX.integrity).description.split('; ');
  for (const p of parts) assert.ok(p.length <= 85, p);
  assert.ok(r.final(CTX.integrity).description.length <= 140);
});

test('poster: member labelled pipeline-blocked or a pause issue open => failure', async () => {
  const blocked = await exec({ labels: { 5: ['pipeline-blocked'] } });
  assert.deepEqual(states(blocked), ALL('failure'));
  assert.match(blocked.final(CTX.integrity).description, /^#5: .*pipeline-blocked/);
  const human = await exec({ labels: { 3: ['needs-human'] } });
  assert.deepEqual(states(human), ALL('failure'));
  assert.match(human.final(CTX.hardstops).description, /^#3: .*needs-human/);
  const pause = await exec({ issues: { 'pipeline-pause': 41 } });
  assert.deepEqual(states(pause), ALL('failure'));
  assert.match(pause.final(CTX.integrity).description, /pipeline-pause/);
  const rollback = await exec({ issues: { 'pipeline-rollback': 42 } });
  assert.deepEqual(states(rollback), ALL('failure'));
  const unrelated = await exec({ labels: { 5: ['bug', 'agent-x'] } });
  assert.deepEqual(states(unrelated), ALL('success'));
  assert.ok(BLOCKING_LABELS.includes('needs-human') && BLOCKING_LABELS.includes('pipeline-blocked'), 'the poster\'s two labels are still among the merge gate\'s blockers');
});

test('poster: entry moved between evaluate and publish => error', async () => {
  const moved = TWO();
  moved[1].pullRequest.headRefOid = sha('c');
  const r = await exec({ queue: [TWO(), moved] });
  assert.equal(r.code, 0, r.phase2?.stderr);
  assert.deepEqual(states(r), ALL('error'));
  assert.match(r.final(CTX.integrity).description, /head or entry moved/);
});

test('poster: predecessor A merged at its own entry commit between evaluate and publish => B still success', async () => {
  const r = await exec({ queue: [TWO(), [TWO()[1]]], prs: { 3: { state: 'closed', merged: true, mergeCommit: A } } });
  assert.equal(r.code, 0, r.phase2?.stderr);
  assert.deepEqual(states(r), ALL('success'));
});

test('poster: predecessor A removed (not merged), or merged at another commit, between evaluate and publish => error', async () => {
  const removed = await exec({ queue: [TWO(), [TWO()[1]]], prs: { 3: { state: 'open', merged: false, mergeCommit: null } } });
  assert.deepEqual(states(removed), ALL('error'));
  const other = await exec({ queue: [TWO(), [TWO()[1]]], prs: { 3: { state: 'closed', merged: true, mergeCommit: sha('c') } } });
  assert.deepEqual(states(other), ALL('error'));
  const unreadable = await exec({ queue: [TWO(), [TWO()[1]]] });
  assert.deepEqual(states(unreadable), ALL('error'), 'the PR cannot be read');
});

// eaglewatch#1769: GitHub empties `pull_requests` on the guard runs of a PR that merged, so a predecessor that merged after the manifest was taken can no longer
// pass the provenance check. A member that LEFT the queue merged at its OWN queue commit (on the default branch) is settled; a live member keeps the full check.
const MERGED_RUN = { pull_requests: [] }; // (what GitHub shows for the predecessor's guard run once it merged)
const ONLY_5 = () => [TWO()[1]];

test('poster: predecessor A merged between the manifest and the guard check (its run lists no PR any more) at its own entry commit => B still success, in both phases (eaglewatch#1769)', async () => {
  const r = await exec({ queue: [TWO(), ONLY_5(), ONLY_5()], runs: { 3: MERGED_RUN }, prs: { 3: { state: 'closed', merged: true, mergeCommit: A } } });
  assert.equal(r.code, 0, r.phase1.stderr + (r.phase2?.stderr ?? ''));
  assert.equal(r.phase1.code, 0);
  assert.deepEqual(['integrity', 'hardstops', 'review'].map((k) => r.verdict.checks[k].state), ['success', 'success', 'success'], 'evaluate');
  assert.deepEqual(states(r), ALL('success'), 'publish');
  assert.match(r.final(CTX.integrity).description, /^earned on their heads by #3 \(merged\), #5$/);
  assert.equal(r.artifact, `queue-verdict_v1_${Q}_success_success_success`);
});

test('poster: predecessor A merged at ANOTHER commit, or left unmerged, before the guard check => error in evaluate (and so in publish) (eaglewatch#1769)', async () => {
  const other = await exec({ queue: [TWO(), ONLY_5(), ONLY_5()], runs: { 3: MERGED_RUN }, prs: { 3: { state: 'closed', merged: true, mergeCommit: sha('c') } } });
  assert.deepEqual(states(other), ALL('error'));
  assert.equal(other.verdict.checks.integrity.state, 'error', 'evaluate');
  assert.match(other.verdict.checks.integrity.description, /^#3: .*without merging its queue commit/);
  assert.equal(other.artifact, `queue-verdict_v1_${Q}_error_error_error`);
  const removed = await exec({ queue: [TWO(), ONLY_5(), ONLY_5()], runs: { 3: MERGED_RUN }, prs: { 3: { state: 'open', merged: false, mergeCommit: null } } });
  assert.deepEqual(states(removed), ALL('error'));
});

test('poster: a LIVE member whose provenance fails is still a failure, even when its run lists no PR (eaglewatch#1769)', async () => {
  const live = await exec({ runs: { 3: MERGED_RUN } });
  assert.deepEqual(states(live), ALL('failure'));
  assert.match(live.final(CTX.integrity).description, /^#3: /);
  assert.equal(live.artifact, `queue-verdict_v1_${Q}_failure_failure_failure`);
});

test('poster: the member lookup that could not be read keeps the member\'s own verdict (failure), never a success (eaglewatch#1769)', async () => {
  const r = await exec({ queue: [TWO(), ONLY_5(), ONLY_5()], runs: { 3: MERGED_RUN } }); // (GET pulls/3 is not scripted: unreadable)
  assert.notEqual(r.final(CTX.integrity)?.state, 'success');
});

test('poster: top entry re-created with the same PR (new id) between evaluate and publish => error', async () => {
  const again = TWO();
  again[1].id = 'E5-new';
  const r = await exec({ queue: [TWO(), again], prs: {} });
  assert.deepEqual(states(r), ALL('error'));
});

test('poster: members unknown => error on every context', async () => {
  const stale = await exec({ queue: [[entry('E3', 3, HEAD3, A, MAIN), entry('E5b', 5, HEAD5, sha('c'), A)]] });
  assert.equal(stale.code, 0, stale.phase1.stderr);
  assert.deepEqual(states(stale), ALL('error'));
  for (const c of Object.values(CTX)) assert.match(stale.final(c).description, /^members unknown: /);
  assert.equal(stale.artifact, `queue-verdict_v1_${Q}_error_error_error`);
  assert.equal(stale.verdict.members, null);

  const unreadable = await exec({ queueFail: [0] });
  assert.deepEqual(states(unreadable), ALL('error'));
  assert.match(unreadable.final(CTX.hardstops).description, /^members unknown: /);
});

test('poster: member guard status pending, then success within the window => success; still pending at the deadline => failure', async () => {
  const pending = { ...goodStatus(5), state: 'pending' };
  const settles = await exec({ status: (pr, check) => (pr === 5 && check === 'integrity' ? [pending, pending, goodStatus(5)] : goodStatus(pr)) }, { env: { QUEUE_PENDING_WAIT_MS: '60000' } });
  assert.equal(settles.code, 0, settles.phase1.stderr);
  assert.deepEqual(states(settles), ALL('success'));
  const polls = settles.calls.filter((c) => c.argv[1].startsWith(`repos/${REPO}/commits/${HEAD5}/statuses`) && c.argv.join(' ').includes('Test integrity'));
  assert.equal(polls.length, 3, 'polled until it settled');

  const never = await exec({ status: (pr, check) => (pr === 5 && check === 'integrity' ? pending : goodStatus(pr)) }, { env: { QUEUE_PENDING_WAIT_MS: '2500' } });
  assert.equal(never.final(CTX.integrity).state, 'failure');
  assert.match(never.final(CTX.integrity).description, /^#5: .*pending/);
  assert.equal(never.final(CTX.hardstops).state, 'success');
});

test('poster: GITHUB_RUN_ATTEMPT=2 => no posts in either phase, exit 0', async () => {
  const r = await exec({}, { env: { GITHUB_RUN_ATTEMPT: '2' } });
  assert.equal(r.code, 0);
  assert.equal(r.posts.length, 0);
  assert.equal(r.artifact, null);
  assert.match(r.phase1.stderr, /attempt 2 never posts/);
  const publish = await r.publishNow();
  assert.equal(publish.code, 0);
  const error = await exec({}, { env: { GITHUB_RUN_ATTEMPT: '2' }, args: ['--publish', '--error', 'the poster failed'] });
  assert.equal(error.code, 0);
  assert.equal(error.posts.length, 0);
  const unset = await exec({}, { env: { GITHUB_RUN_ATTEMPT: '' } });
  assert.equal(unset.posts.length, 0, 'an unknown attempt never posts either');
});

test('poster: review check off => 2 contexts; push event / non-queue ref => no posts', async () => {
  const off = await exec({}, { config: CONFIG() });
  assert.equal(off.code, 0, off.phase1.stderr);
  assert.deepEqual(off.posts.map((p) => p.context).filter((c, i, a) => a.indexOf(c) === i), [CTX.integrity, CTX.hardstops]);
  assert.equal(off.final(CTX.review), undefined);
  assert.equal(off.artifact, `queue-verdict_v1_${Q}_success_success_off`);
  assert.equal(off.final(CTX.integrity).state, 'success');

  const push = await exec({}, { env: { QUEUE_EVENT: 'push' } });
  assert.equal(push.code, 0);
  assert.equal(push.posts.length, 0);
  assert.equal(push.calls.length, 0, 'nothing is even read');
  const branch = await exec({}, { env: { QUEUE_REF: 'refs/heads/main' } });
  assert.equal(branch.code, 0);
  assert.equal(branch.posts.length, 0);
  const otherBase = await exec({}, { env: { QUEUE_REF: `refs/heads/gh-readonly-queue/develop/pr-5-${A}` } });
  assert.equal(otherBase.posts.length, 0);
});

test('poster: --publish --error posts the message as error on every context', async () => {
  const r = await exec({}, { args: ['--publish', '--error', 'the poster failed'], publish: false });
  assert.equal(r.code, 0, r.phase1.stderr);
  assert.deepEqual(r.posts.map((p) => [p.context, p.state, p.description]), Object.values(CTX).map((c) => [c, 'error', 'the poster failed']));
  const none = await exec({}, { args: ['--publish', '--error', 'x'], config: CONFIG(), publish: false });
  assert.deepEqual(none.posts.map((p) => p.context), [CTX.integrity, CTX.hardstops]);
});

test('poster: --publish without a verdict from Evaluate, or a verdict for another commit => exit 1, nothing posted', async () => {
  const r = await exec({}, { args: ['--publish'], publish: false });
  assert.equal(r.code, 1);
  assert.equal(r.posts.length, 0);
});

test('poster: a failed status post exits 1', async () => {
  const r = await exec({ post: 'fail' });
  assert.equal(r.code, 1);
});

// ---- the two workflow templates ----------------------------------------------------------------------------------------------

const wf = (name) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'pipeline', 'templates', 'workflows', name), 'utf8');

test('queue-intake.yml: one cheap merge_group job named Queue intake with read-only permissions', () => {
  const y = parseYaml(wf('queue-intake.yml'));
  assert.equal(y.name, 'Queue intake');
  assert.deepEqual(y.on, { merge_group: { types: ['checks_requested'] } });
  assert.deepEqual(y.permissions, { contents: 'read' });
  assert.equal(y.jobs.intake.name, 'Queue intake');
  assert.ok(y.jobs.intake['timeout-minutes'] <= 2);
});

test('queue-guards.yml: workflow_run on Queue intake, main\'s copy only, runs the vendored poster in the exact step order', () => {
  const text = wf('queue-guards.yml');
  const y = parseYaml(text);
  assert.equal(y.name, 'Queue guards');
  assert.deepEqual(y.on, { workflow_run: { workflows: ['Queue intake'], types: ['completed'] } });
  assert.deepEqual(y.permissions, { contents: 'read', 'pull-requests': 'read', issues: 'read', statuses: 'write', actions: 'read' });
  const job = y.jobs.post;
  assert.equal(job.if, "github.event.workflow_run.event == 'merge_group'");
  assert.equal(job['timeout-minutes'], 10);
  assert.equal(job.env.QUEUE_SHA, '${{ github.event.workflow_run.head_sha }}');
  assert.equal(job.env.QUEUE_REF, '${{ github.event.workflow_run.head_branch }}');
  assert.equal(job.env.QUEUE_EVENT, '${{ github.event.workflow_run.event }}');
  assert.match(job.env.RUN_URL, /github\.run_id/);
  const runs = job.steps.map((s) => s.run ?? s.uses);
  assert.deepEqual(runs, [
    'actions/checkout@v4',
    'node scripts/pipeline/queue-guards-run.mjs',
    'actions/upload-artifact@v4',
    'node scripts/pipeline/queue-guards-run.mjs --publish',
    'node scripts/pipeline/queue-guards-run.mjs --publish --error "the poster failed"',
  ]);
  assert.equal(job.steps[4].if, 'failure()');
  assert.equal(job.steps[1].id, 'eval');
  assert.equal(job.steps[0].with['persist-credentials'], false);
  // It must never run or check out the queue commit: no ref: input anywhere, no npm/install.
  assert.doesNotMatch(text, /^\s*ref:/m);
  assert.doesNotMatch(text, /npm |pnpm |yarn /);
});
