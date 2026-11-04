// `pipeline ci-wait` as a command: option parsing, the exact gh reads (paginated with --jq so page 2 is not lost), and the
// exit codes, against the scripted fake gh. The state machine itself is test/ci-wait.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTmpRepo } from './helpers/tmprepo.mjs';
import { createFakeGh, pipelineYml, REPO_VIEW } from './helpers/fakegh-env.mjs';
import { run as ciWait, meta } from '../pipeline/commands/ci-wait.mjs';

const bin = join(dirname(fileURLToPath(import.meta.url)), '..', 'pipeline', 'bin', 'pipeline.mjs');
const HEAD = 'd'.repeat(40);

function repoWith(checks = ['ci']) {
  const repo = createTmpRepo();
  repo.write('.claude/pipeline.yml', pipelineYml('github', checks));
  repo.commit('init');
  return repo;
}

function cli(args, { repo, fake }) {
  const env = { ...process.env, ...fake.env };
  delete env.PIPELINE_OFF;
  const r = spawnSync(process.execPath, [bin, ...args], { cwd: repo.dir, env, encoding: 'utf8' });
  return { code: r.status, json: r.stdout ? JSON.parse(r.stdout) : null, stdout: r.stdout, stderr: r.stderr };
}

const run = (id, name, conclusion, app = 15368) => ({ id, name, status: 'completed', conclusion, app: { id: app }, check_suite: { id: 7 }, html_url: `https://github.example/runs/${id}` });
const pr = (over = {}) => ({ headRefOid: HEAD, isDraft: false, createdAt: '2026-01-01T00:00:00Z', baseRefName: 'main', ...over });
// gh --paginate --jq prints one JSON value per page, back to back
const pages = (...ps) => ps.map((p) => JSON.stringify(p)).join('\n') + '\n';
const base = (over = []) => [
  { match: '^repo view', stdoutJson: REPO_VIEW },
  { match: '^pr view 5 ', stdoutJson: pr() },
  { match: '^api repos/acme/widgets/branches/main/protection$', stdoutJson: { required_status_checks: { contexts: ['ci', 'lint'], checks: [{ context: 'ci', app_id: 15368 }, { context: 'lint', app_id: -1 }] } } },
  { match: '^api repos/acme/widgets/rules/branches/main', stdout: '[]\n' },
  ...over,
];

test('meta: a one-line usage naming every flag', () => {
  for (const flag of ['--pr', '--repo', '--appear-timeout', '--timeout', '--interval', '--wait-all']) assert.ok(meta.usage.includes(flag), flag);
});

test('ci-wait reads every page: check runs on 2 pages and statuses on 2 pages are both seen, with --paginate and a per-page jq', () => {
  const fake = createFakeGh(base([
    { match: `^api repos/acme/widgets/commits/${HEAD}/check-runs\\?per_page=100 --paginate --jq .check_runs$`, stdout: pages([run(1, 'noise', 'success')], [run(2, 'ci', 'success')]) },
    { match: `^api repos/acme/widgets/commits/${HEAD}/statuses\\?per_page=100 --paginate$`, stdout: pages([{ id: 5, context: 'other', state: 'success', creator: { login: 'x' } }], [{ id: 4, context: 'lint', state: 'success', creator: { login: 'y' } }]) },
  ]));
  const r = cli(['ci-wait', '--pr', '5', '--interval', '1'], { repo: repoWith(), fake });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.verdict, 'passed');
  assert.equal(r.json.head, HEAD);
  assert.deepEqual(r.json.requiredSource, { classic: 'present', rules: 'absent' });
  assert.deepEqual(r.json.checks.map((c) => [c.name, c.appId, c.state]), [['ci', 15368, 'pass'], ['lint', null, 'pass']]);
  assert.ok(fake.lines().includes(`api repos/acme/widgets/commits/${HEAD}/check-runs?per_page=100 --paginate --jq .check_runs`));
  assert.ok(fake.lines().includes('api repos/acme/widgets/rules/branches/main?per_page=100 --paginate'));
});

test('ci-wait: a draft at the start is exit 2 and reads nothing else; a failing check is exit 1 with its verdict', () => {
  // the first matching entry wins: the draft view goes before the base script
  const draft = createFakeGh([{ match: '^pr view 5 ', stdoutJson: pr({ isDraft: true }) }, ...base()]);
  const d = cli(['ci-wait', '--pr', '5'], { repo: repoWith(), fake: draft });
  assert.equal(d.code, 2);
  assert.equal(d.json.verdict, 'draft');
  assert.ok(!draft.lines().some((l) => /check-runs/.test(l)));
  const fake = createFakeGh(base([
    { match: '/check-runs', stdout: pages([run(1, 'ci', 'failure')]) },
    { match: '/statuses', stdout: '[]\n' },
  ]));
  const f = cli(['ci-wait', '--pr', '5'], { repo: repoWith(), fake });
  assert.equal(f.code, 1);
  assert.equal(f.json.verdict, 'failed');
  assert.match(f.json.message, /ci=fail \(https:\/\/github\.example\/runs\/1\)/);
});

test('ci-wait: usage errors are exit 2 (no --pr, bad numbers, unknown flag)', () => {
  const repo = repoWith();
  const fake = createFakeGh([]);
  for (const args of [[], ['--pr', 'x'], ['--pr', '0'], ['--pr', '5', '--interval', '0'], ['--pr', '5', '--timeout', '0'], ['--pr', '5', '--bogus']]) {
    const r = cli(['ci-wait', ...args], { repo, fake });
    assert.equal(r.code, 2, args.join(' '));
  }
});

test('ci-wait: GitHub that never answers is exit 3, after 5 reads in a row (in-process, simulated clock)', async () => {
  const repo = repoWith();
  let t = 0;
  const gh = { prView: () => { throw new Error('HTTP 502'); } };
  const r = await ciWait(['--pr', '5'], { cwd: repo.dir, env: process.env, ciWait: { gh, clock: { now: () => t, sleep: async (ms) => { t += ms; } }, onProgress: () => {} } });
  assert.equal(r.exitCode, 3);
  assert.equal(r.output.verdict, 'github');
  assert.equal(t, 60_000, 'default interval 15s, 4 sleeps between 5 reads');
});

test('ci-wait: --appear-timeout, --timeout, --interval and --wait-all reach the state machine', async () => {
  const repo = repoWith(['ci']);
  let t = 0;
  const gh = {
    prView: () => pr(),
    protection: () => ({ status: 200, json: { required_status_checks: { checks: [{ context: 'ci', app_id: 15368 }, { context: 'slow', app_id: 15368 }] } } }),
    branchRules: () => [],
    checkRunsOf: () => [run(1, 'ci', 'failure'), run(2, 'slow', 'in_progress')].map((r) => (r.name === 'slow' ? { ...r, status: 'in_progress', conclusion: null } : r)),
    statusesOf: () => [],
    timelineOf: () => [],
    workflowRunsOfSuite: () => [],
  };
  const clock = { now: () => t, sleep: async (ms) => { t += ms; } };
  const seam = { gh, clock, onProgress: () => {} };
  const eager = await ciWait(['--pr', '5'], { cwd: repo.dir, env: process.env, ciWait: seam });
  assert.equal(eager.output.verdict, 'failed');
  assert.equal(t, 0);
  t = 0;
  const all = await ciWait(['--pr', '5', '--wait-all', '--interval', '10', '--timeout', '35'], { cwd: repo.dir, env: process.env, ciWait: seam });
  assert.equal(all.output.verdict, 'timeout', 'slow stays pending past --timeout while --wait-all keeps going');
  assert.equal(t, 40_000, 'polls every 10s; first poll at or past 35s ends it');
  assert.deepEqual(all.output.checks.map((c) => c.state), ['fail', 'pending']);
});
