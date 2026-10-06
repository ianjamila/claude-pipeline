// Tests for scripts/pipeline/ci-guards-run.mjs (the pipeline-guards workflow orchestrator). It runs the VENDORED copy
// from a tmp "base checkout" whose `origin` is a bare repo holding refs/pull/7/head, with a scripted fake `gh`
// (test/fixtures/fake-gh-seq.mjs) standing in for GitHub; the published statuses are asserted from the fake's call log.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run as procRun } from '../pipeline/lib/proc.mjs';
import { CONFIG, project, runNode, scratchDir } from './helpers/project.mjs';

const fakeGh = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-gh-seq.mjs');
const REPO = 'acme/app';
const PR = 7;
const OTHER_SHA = 'f'.repeat(40);
const T = (hhmm) => `2026-10-01T${hhmm}:00Z`;
const ctxName = { integrity: 'Test integrity', hardstops: 'Hard-stop scan' };

const deleteTest = (repo) => repo.rm('test/app.test.js');
const addDrop = (repo) => repo.write('supabase/migrations/20260101000000_drop.sql', 'DROP TABLE users;\n');
const cleanChange = (repo) => repo.write('src/app.js', 'export const a = 2;\n');

// A base checkout (main) whose origin has the PR head at refs/pull/7/head.
async function setup(change, projectOpts) {
  const repo = await project(projectOpts);
  const bare = join(scratchDir(), 'origin.git');
  mkdirSync(bare);
  assert.equal(procRun('git', ['init', '--bare', '-q', bare]).code, 0);
  repo.git(['remote', 'add', 'origin', bare]);
  repo.git(['push', '-q', 'origin', 'main']);
  repo.branch('pr');
  change(repo);
  const head = repo.commit('pr change');
  repo.git(['push', '-q', 'origin', `${head}:refs/pull/${PR}/head`]);
  repo.checkout('main');
  return { repo, head, bare };
}

// The scripted GitHub. labelSeq/pullSeq: per-call replies (the last one repeats).
// receipts: statuses of the head (any creator), as the jq filter in ci-guards-run.mjs shapes them.
// runs: Actions runs by id as GitHub reports them (path/event/head_sha); compare: the default branch vs each run's head_sha.
const GOOD_RUN = { path: '.github/workflows/pipeline-guards.yml@refs/heads/main', event: 'pull_request_target', head_sha: 'a'.repeat(40), run_started_at: T('10:00'), updated_at: T('10:12') };
function script({ head, pullHeads = [head], labels = [], labelSeq, suites = [T('10:00')], receipts = [], events = [], failOn = [], runs = {}, compare = 'ahead' }) {
  const lines = (a) => (a.length ? `${a.join('\n')}\n` : '');
  return [
    ...failOn.map((match) => ({ match, code: 1, stderr: 'HTTP 500' })),
    { match: `^api repos/${REPO}/pulls/${PR} `, sequence: pullHeads.map((h) => ({ stdout: `${h}\n` })) },
    { match: `^api repos/${REPO}/issues/${PR}/labels --paginate`, sequence: (labelSeq ?? [labels]).map((l) => ({ stdout: lines(l) })) },
    { match: `^api repos/${REPO}/commits/${head}/check-suites`, stdout: lines(suites) },
    { match: `^api repos/${REPO}/commits/${head}/statuses`, stdout: lines(receipts.map((r) => JSON.stringify(r))) },
    ...Object.entries({ 1: GOOD_RUN, ...runs }).map(([id, run]) => ({ match: `^api repos/${REPO}/actions/runs/${id} `, stdout: `${JSON.stringify({ ...GOOD_RUN, pull_requests: [{ number: PR, head: { sha: head }, base: { ref: 'main' } }], ...run })}\n` })),
    { match: `^api repos/${REPO} --jq \\.default_branch`, stdout: 'main\n' },
    { match: `^api repos/${REPO}/compare/[0-9a-f]{40}\\.\\.\\.main `, stdout: `${compare}\n` },
    { match: `^api repos/${REPO}/issues/${PR}/events`, stdout: lines(events.map((e) => JSON.stringify(e))) },
    { match: `^api -X DELETE repos/${REPO}/issues/${PR}/labels/`, stdout: '[]' },
    { match: `^api repos/${REPO}/statuses/${head} `, stdoutJson: { id: 1 } },
  ];
}

async function exec({ repo, head }, ghOpts = {}, env = {}) {
  const dir = scratchDir();
  const scriptFile = join(dir, 'script.json');
  const log = join(dir, 'log.jsonl');
  const summary = join(dir, 'summary.md');
  writeFileSync(scriptFile, JSON.stringify(script({ head, ...ghOpts })));
  const r = await runNode(['scripts/pipeline/ci-guards-run.mjs'], {
    cwd: repo.dir,
    env: {
      GH_TOKEN: 'test-token', REPO, PR_NUMBER: String(PR), EVENT_HEAD: head, BASE_SHA: repo.base,
      RUN_URL: 'https://github.example/acme/app/actions/runs/1', GITHUB_STEP_SUMMARY: summary,
      PIPELINE_GH: `node ${fakeGh}`, PIPELINE_FAKE_GH_SCRIPT: scriptFile, PIPELINE_FAKE_GH_LOG: log,
      ...env,
    },
  });
  let calls = [];
  try { calls = readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { /* gh never ran */ }
  const posts = calls.filter((c) => /^repos\/acme\/app\/statuses\/[0-9a-f]{40}$/.test(c.argv[1])).map((c) => ({
    sha: c.argv[1].split('/').pop(),
    ...Object.fromEntries(c.argv.slice(2).map((a, i, all) => (all[i - 1] === '-f' ? a.split(/=(.*)/s).slice(0, 2) : null)).filter(Boolean)),
  }));
  const deletes = calls.filter((c) => c.argv[1] === '-X' && c.argv[2] === 'DELETE').map((c) => c.argv[3]);
  let md = '';
  try { md = readFileSync(summary, 'utf8'); } catch { /* none written */ }
  const api = (suffix) => calls.filter((c) => c.argv[0] === 'api' && c.argv[1].endsWith(suffix));
  return { ...r, calls, posts, deletes, md, api, byContext: (c) => posts.find((p) => p.context === c) };
}

const owner = (at, label = 'human-approved', actor = 'acme') => ({ label, actor, at });
const BOT = 'github-actions[bot]';
// The receipt the guard workflow posted on the head in response to a labeling (default: for owner()'s event at the same time).
const RUN_1 = 'https://github.example/acme/app/actions/runs/1';
const receipt = (at, label = 'human-approved', by = BOT, url = RUN_1, who = 'acme') => ({ context: `pipeline-approval: ${label}`, by, at, url, description: `${label} approved by ${who}` });
// What the workflow passes for a `labeled` event.
const labeledEnv = (sender = 'acme', label = 'human-approved') => ({ EVENT_ACTION: 'labeled', EVENT_LABEL: label, EVENT_SENDER: sender });

test('a clean PR publishes two success statuses bound to the head sha', async () => {
  const s = await setup(cleanChange);
  const r = await exec(s);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.posts.length, 2);
  assert.deepEqual(r.posts.map((p) => [p.context, p.state]), [['Test integrity', 'success'], ['Hard-stop scan', 'success']]);
  for (const p of r.posts) {
    assert.equal(p.sha, s.head);
    assert.equal(p.target_url, 'https://github.example/acme/app/actions/runs/1');
    assert.ok(p.description.length > 0 && p.description.length <= 140);
  }
  assert.equal(r.json.ok, true);
  assert.equal(r.json.head, s.head);
  assert.equal(r.api('/events').length, 0, 'no approval label => no timeline lookups');
  assert.deepEqual(r.deletes, []);
  assert.match(r.md, /## Test integrity/);
  assert.match(r.md, /## Hard-stop scan/);
});

test('it fetches the PR head into refs/remotes/pr/head', async () => {
  const s = await setup(cleanChange);
  await exec(s);
  assert.equal(s.repo.git(['rev-parse', 'refs/remotes/pr/head']).trim(), s.head);
});

test('a migration DROP fails the Hard-stop scan only', async () => {
  const s = await setup(addDrop);
  const r = await exec(s);
  assert.equal(r.code, 0, 'the verdict lives in the status, not the exit code');
  assert.equal(r.byContext('Test integrity').state, 'success');
  assert.equal(r.byContext('Hard-stop scan').state, 'failure');
  assert.match(r.byContext('Hard-stop scan').description, /^2 hard-stops: R1-destructive supabase\/migrations\//);
  assert.equal(r.json.ok, false);
  assert.match(r.md, /Override: owner adds label `human-approved`/);
});

test('a deleted test fails Test integrity only', async () => {
  const s = await setup(deleteTest);
  const r = await exec(s);
  assert.equal(r.byContext('Test integrity').state, 'failure');
  assert.match(r.byContext('Test integrity').description, /^1 violation: test-deleted test\/app\.test\.js/);
  assert.equal(r.byContext('Hard-stop scan').state, 'success');
});

test('a valid human-approved (owner, with a receipt on this head) passes the hard-stop', async () => {
  const s = await setup(addDrop);
  const r = await exec(s, { labels: ['human-approved'], events: [owner(T('10:05'))], receipts: [receipt(T('10:05'))] });
  assert.equal(r.byContext('Hard-stop scan').state, 'success');
  assert.match(r.byContext('Hard-stop scan').description, /approved by label human-approved/);
  assert.deepEqual(r.deletes, []);
  assert.deepEqual(r.json.approvals.valid, ['human-approved']);
  assert.equal(r.api('/check-suites').length, 0, 'check-suite timestamps no longer decide anything');
});

test('a valid test-change-approved passes Test integrity, and human-approved does not stand in for it', async () => {
  const a = await setup(deleteTest);
  const ok = await exec(a, { labels: ['test-change-approved'], events: [owner(T('10:05'), 'test-change-approved')], receipts: [receipt(T('10:05'), 'test-change-approved')] });
  assert.equal(ok.byContext('Test integrity').state, 'success');
  assert.match(ok.byContext('Test integrity').description, /approved by label test-change-approved/);

  const b = await setup(deleteTest);
  const wrong = await exec(b, { labels: ['human-approved'], events: [owner(T('10:05'))], receipts: [receipt(T('10:05'))] });
  assert.equal(wrong.byContext('Test integrity').state, 'failure');
});

test('an approval label with no receipt on this head is ignored, removed, and explained', async () => {
  const s = await setup(addDrop);
  const r = await exec(s, { labels: ['human-approved'], events: [owner(T('09:00'))], receipts: [] });
  assert.equal(r.code, 0, r.stderr);
  const hs = r.byContext('Hard-stop scan');
  assert.equal(hs.state, 'failure');
  assert.match(hs.description, /approval not recorded for this commit — re-apply the label$/);
  assert.ok(hs.description.length <= 140);
  assert.deepEqual(r.deletes, [`repos/${REPO}/issues/${PR}/labels/human-approved`]);
  // The verdict is on record before the label goes (removing it cancels this run).
  const lastPost = Math.max(...r.calls.map((c, i) => (c.argv[1]?.includes('/statuses/') ? i : -1)));
  const del = r.calls.findIndex((c) => c.argv[1] === '-X');
  assert.ok(del > lastPost, 'label removal happens after both statuses are published');
  assert.deepEqual(r.json.approvals.removed, ['human-approved']);
  assert.match(r.md, /## Approvals ignored/);
});

test('a receipt older than the label\'s latest labeled event does not count; one posted in the same second does', async () => {
  const a = await setup(addDrop);
  const older = await exec(a, { labels: ['human-approved'], events: [owner(T('10:05'))], receipts: [receipt(T('10:04'))] });
  assert.equal(older.byContext('Hard-stop scan').state, 'failure');
  assert.equal(older.json.approvals.ignored[0].reason, 'no-receipt');
  const b = await setup(addDrop);
  const same = await exec(b, { labels: ['human-approved'], events: [owner(T('10:05'))], receipts: [receipt(T('10:05'))] });
  assert.equal(same.byContext('Hard-stop scan').state, 'success');
});

test('an approval by someone other than the repo owner is ignored', async () => {
  const s = await setup(addDrop);
  const r = await exec(s, { labels: ['human-approved'], events: [owner(T('10:05'), 'human-approved', 'mallory')] });
  assert.equal(r.byContext('Hard-stop scan').state, 'failure');
  assert.match(r.byContext('Hard-stop scan').description, /not applied by the repo owner/);
  assert.equal(r.deletes.length, 1);
});

test('the owner login is compared case-insensitively', async () => {
  const s = await setup(addDrop);
  const r = await exec(s, { labels: ['human-approved'], events: [owner(T('10:05'), 'human-approved', 'ACME')], receipts: [receipt(T('10:05'))] });
  assert.equal(r.byContext('Hard-stop scan').state, 'success');
});

test('the LATEST labeled event decides who approved', async () => {
  const a = await setup(addDrop);
  const stolen = await exec(a, { labels: ['human-approved'], events: [owner(T('10:05')), owner(T('10:07'), 'human-approved', 'mallory')], receipts: [receipt(T('10:05')), receipt(T('10:07'))] });
  assert.equal(stolen.byContext('Hard-stop scan').state, 'failure');

  const b = await setup(addDrop);
  const reapplied = await exec(b, { labels: ['human-approved'], events: [owner(T('10:04'), 'human-approved', 'mallory'), owner(T('10:06'))], receipts: [receipt(T('10:06'))] });
  assert.equal(reapplied.byContext('Hard-stop scan').state, 'success');

  const c = await setup(addDrop);
  const none = await exec(c, { labels: ['human-approved'], events: [] });
  assert.equal(none.byContext('Hard-stop scan').state, 'failure', 'a label with no labeling event cannot be attributed');
  assert.match(none.byContext('Hard-stop scan').description, /no labeling event found/);
});

test('a head that moved on GitHub is superseded: error statuses, nothing evaluated', async () => {
  const s = await setup(addDrop);
  const r = await exec(s, { pullHeads: [OTHER_SHA] });
  assert.equal(r.code, 0);
  assert.deepEqual(r.posts.map((p) => [p.context, p.state, p.description, p.sha]), [
    ['Test integrity', 'error', 'superseded by a newer commit', s.head],
    ['Hard-stop scan', 'error', 'superseded by a newer commit', s.head],
  ]);
  assert.equal(r.api('/labels').length, 0, 'no evaluation happened');
  assert.equal(r.json.superseded, true);
});

test('a PR ref that no longer points at the event head is superseded too', async () => {
  const s = await setup(addDrop);
  s.repo.git(['push', '-q', '-f', 'origin', `${s.repo.base}:refs/pull/${PR}/head`]);
  const r = await exec(s);
  assert.deepEqual(r.posts.map((p) => p.state), ['error', 'error']);
  assert.equal(r.api('/labels').length, 0);
});

test('a head that moves while the guards run is superseded instead of published over', async () => {
  const s = await setup(cleanChange);
  const r = await exec(s, { pullHeads: [s.head, OTHER_SHA] });
  assert.deepEqual(r.posts.map((p) => [p.state, p.description]), [['error', 'superseded by a newer commit'], ['error', 'superseded by a newer commit']]);
  assert.ok(r.posts.every((p) => p.state !== 'success'));
});

test('labels that change while the guards run trigger exactly one re-evaluation', async () => {
  const s = await setup(addDrop);
  // pass 1 sees no labels; the pre-publish re-read sees human-approved; pass 2 sees it too.
  const r = await exec(s, { labelSeq: [[], ['human-approved'], ['human-approved']], events: [owner(T('10:05'))], receipts: [receipt(T('10:05'))] });
  assert.equal(r.api('/labels').length, 3);
  assert.equal(r.api('/events').length, 1, 'approvals were only resolved on the second pass');
  assert.equal(r.posts.length, 2, 'published once');
  assert.equal(r.byContext('Hard-stop scan').state, 'success');
});

test('a second pass is final: it is not repeated even if the labels moved again', async () => {
  const s = await setup(addDrop);
  const r = await exec(s, { labelSeq: [[], ['human-approved'], [], ['human-approved']], events: [owner(T('10:05'))], receipts: [receipt(T('10:05'))] });
  assert.equal(r.api('/labels').length, 3, 'one initial read, one re-read, one redo - no fourth');
  assert.equal(r.byContext('Hard-stop scan').state, 'failure', 'whatever the second pass says');
  assert.equal(r.posts.length, 2);
});

test('stable labels cost one extra read and no re-evaluation', async () => {
  const s = await setup(cleanChange);
  const r = await exec(s, { labels: ['needs-review'] });
  assert.equal(r.api('/labels').length, 2);
  assert.equal(r.posts.length, 2);
});

test('an invalid pipeline.yml on the base is published as error statuses (fail closed)', async () => {
  const s = await setup(cleanChange, { config: null });
  const r = await exec(s);
  assert.equal(r.code, 0);
  assert.deepEqual(r.posts.map((p) => p.state), ['error', 'error']);
  assert.match(r.posts[0].description, /^Guard error: invalid or missing \.claude\/pipeline\.yml/);
});

test('a failed label removal is best effort', async () => {
  const s = await setup(addDrop);
  const r = await exec(s, { labels: ['human-approved'], events: [owner(T('09:00'))], failOn: ['^api -X DELETE'] });
  assert.equal(r.code, 0);
  assert.equal(r.byContext('Hard-stop scan').state, 'failure');
  assert.deepEqual(r.json.approvals.removed, []);
});

test('a status that cannot be published is an internal error (exit 1) so the workflow marks it error', async () => {
  const s = await setup(cleanChange);
  const r = await exec(s, { failOn: [`^api repos/${REPO}/statuses/`] });
  assert.equal(r.code, 1);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.error, 'internal');
  assert.match(r.stderr, /ci-guards-run failed/);
});

test('missing or malformed environment is an internal error (exit 1)', async () => {
  const s = await setup(cleanChange);
  assert.equal((await exec(s, {}, { PR_NUMBER: '' })).code, 1);
  const bad = await exec(s, {}, { EVENT_HEAD: 'not-a-sha' });
  assert.equal(bad.code, 1);
  assert.match(bad.json.message, /EVENT_HEAD is not a full commit sha/);
  assert.equal((await exec(s, {}, { REPO: 'no-slash' })).code, 1);
  assert.equal((await exec(s, {}, { PR_NUMBER: '7; rm -rf /' })).code, 1);
  assert.equal(s.repo.git(['status', '--porcelain']).trim(), '');
});

test('a gh failure while reading is an internal error (exit 1) and publishes nothing', async () => {
  const s = await setup(cleanChange);
  const r = await exec(s, { failOn: [`^api repos/${REPO}/issues/${PR}/labels`] });
  assert.equal(r.code, 1);
  assert.equal(r.posts.length, 0);
});

// The fake gh returns canned text, so prove the REAL jq filters the script passes to gh against GitHub-shaped payloads.
const hasJq = spawnSync('jq', ['--version']).status === 0;
test('the --jq filters work on GitHub-shaped payloads', { skip: !hasJq && 'jq not installed' }, async () => {
  const s = await setup(addDrop);
  const r = await exec(s, { labels: ['human-approved'], events: [owner(T('10:05'))], receipts: [receipt(T('10:05'))] });
  const filter = (suffix) => r.api(suffix)[0].argv[r.api(suffix)[0].argv.indexOf('--jq') + 1];
  const jq = (expr, payload) => spawnSync('jq', ['-r', expr], { input: JSON.stringify(payload), encoding: 'utf8' }).stdout.replace(/\r\n/g, '\n'); // Windows jq writes CRLF; gh --jq does not

  assert.equal(jq(filter(`/pulls/${PR}`), { number: 7, head: { sha: s.head } }).trim(), s.head);
  assert.equal(jq(filter('/labels'), [{ name: 'a' }, { name: 'human-approved' }]), 'a\nhuman-approved\n');
  const statuses = [
    { context: 'pipeline-approval: human-approved', state: 'success', creator: { login: BOT }, created_at: T('10:05'), target_url: RUN_1, description: 'human-approved approved by acme' },
    { context: 'pipeline-approval: human-approved', state: 'success', creator: { login: 'acme' }, created_at: T('10:06'), target_url: null, description: null },
    { context: 'pipeline-approval: test-change-approved', state: 'pending', creator: { login: BOT }, created_at: T('10:07') },
    { context: 'pipeline-approval: test-change-approved', state: 'failure', creator: { login: BOT }, created_at: T('10:07') },
    { context: 'Hard-stop scan', state: 'success', creator: { login: BOT }, created_at: T('10:08') },
    { context: 'ci/vercel', state: 'success', creator: null, created_at: T('10:09') },
  ];
  assert.deepEqual(jq(filter('/statuses'), statuses).trim().split('\n').map((l) => JSON.parse(l)), [
    { context: 'pipeline-approval: human-approved', by: BOT, at: T('10:05'), url: RUN_1, description: 'human-approved approved by acme' },
    { context: 'pipeline-approval: human-approved', by: 'acme', at: T('10:06'), url: null, description: null },
  ]);
  const events = jq(filter('/events'), [
    { event: 'labeled', label: { name: 'human-approved' }, actor: { login: 'Acme' }, created_at: T('10:05') },
    { event: 'unlabeled', label: { name: 'human-approved' }, actor: { login: 'Acme' }, created_at: T('10:06') },
    { event: 'labeled', label: { name: 'x' }, actor: null, created_at: T('10:07') },
    { event: 'closed', actor: { login: 'Acme' }, created_at: T('10:08') },
  ]).trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(events, [
    { label: 'human-approved', actor: 'Acme', at: T('10:05') },
    { label: 'x', actor: null, at: T('10:07') },
  ]);
});

test('pipeline-guards.yml re-evaluates a PR whose base changed (edited), but ignores title/body edits without cancelling real runs', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const yml = readFileSync(join(root, 'pipeline', 'templates', 'workflows', 'pipeline-guards.yml'), 'utf8');
  const types = /types: \[([^\]]*)\]/.exec(yml)[1].split(',').map((x) => x.trim());
  for (const t of ['opened', 'synchronize', 'reopened', 'ready_for_review', 'labeled', 'unlabeled', 'edited']) assert.ok(types.includes(t), t);
  assert.match(yml, /^    if: github\.event\.action != 'edited' \|\| github\.event\.changes\.base$/m);
  assert.match(yml, /group: pipeline-guards-\$\{\{ github\.event\.pull_request\.number \}\}\$\{\{ github\.event\.action == 'edited' && !github\.event\.changes\.base && '-noop' \|\| '' \}\}/);
  // The orchestrator takes the base from the event payload, which after a retarget holds the NEW base.
  assert.match(yml, /BASE_SHA: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
  assert.match(yml, /ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
});

test('pipeline-guards.yml hands the labeling event to the job through env only, and runs on a supported Node', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const yml = readFileSync(join(root, 'pipeline', 'templates', 'workflows', 'pipeline-guards.yml'), 'utf8');
  assert.match(yml, /^      EVENT_ACTION: \$\{\{ github\.event\.action \}\}$/m);
  assert.match(yml, /^      EVENT_LABEL: \$\{\{ github\.event\.label\.name \}\}$/m);
  assert.match(yml, /^      EVENT_SENDER: \$\{\{ github\.event\.sender\.login \}\}$/m);
  // Expression interpolation inside a run: block is script injection: only env: may carry event data.
  const runBlocks = yml.split(/\n(?=\s*- name:)/).flatMap((step) => (/\n\s+run:/.test(step) ? [step.slice(step.search(/\n\s+run:/))] : []));
  assert.ok(runBlocks.length >= 3);
  for (const b of runBlocks) assert.doesNotMatch(b, /\$\{\{/);
  assert.match(yml, /node-version: 24$/m);
  assert.doesNotMatch(yml, /checks: read/);
});

// ---- who may approve: ci.approvers, the owner of a user repo, never an org name -----------------------------------------

const APPROVERS = { config: CONFIG(undefined, 'ci:\n  approvers: [alice, "Bob"]\n') };

test('ci.approvers: a listed login (any case) approves; the repo owner does NOT when the list exists; others are ignored', async () => {
  const s = await setup(addDrop, APPROVERS);
  const alice = await exec(s, { labels: ['human-approved'], events: [owner(T('10:05'), 'human-approved', 'Alice')], receipts: [receipt(T('10:05'), 'human-approved', BOT, RUN_1, 'Alice')] }, { OWNER_TYPE: 'Organization' });
  assert.equal(alice.byContext('Hard-stop scan').state, 'success');
  assert.deepEqual(alice.json.approvals.valid, ['human-approved']);
  const bob = await exec(s, { labels: ['human-approved'], events: [owner(T('10:05'), 'human-approved', 'bob')], receipts: [receipt(T('10:05'), 'human-approved', BOT, RUN_1, 'bob')] }, { OWNER_TYPE: 'Organization' });
  assert.equal(bob.byContext('Hard-stop scan').state, 'success');
  const ownerOnly = await exec(s, { labels: ['human-approved'], events: [owner(T('10:05'))], receipts: [receipt(T('10:05'))] }, { OWNER_TYPE: 'User' });
  assert.equal(ownerOnly.byContext('Hard-stop scan').state, 'failure');
  assert.match(ownerOnly.byContext('Hard-stop scan').description, /not applied by a login listed in ci\.approvers/);
  assert.equal(ownerOnly.json.approvals.ignored[0].reason, 'not-approver');
});

test('org-owned repo with no ci.approvers fails closed with a clear reason, even if the actor is called like the org', async () => {
  const s = await setup(addDrop);
  const r = await exec(s, { labels: ['human-approved'], events: [owner(T('10:05'))], receipts: [receipt(T('10:05'))] }, { OWNER_TYPE: 'Organization' });
  assert.equal(r.byContext('Hard-stop scan').state, 'failure');
  assert.match(r.byContext('Hard-stop scan').description, /org-repo-needs-ci\.approvers/);
  assert.equal(r.json.approvals.ignored[0].reason, 'org-repo-needs-ci.approvers');
  assert.equal(r.deletes.length, 1);
});

test('user-owned repo with no list keeps the owner rule (OWNER_TYPE User, or unset for old workflows)', async () => {
  const s = await setup(addDrop);
  for (const env of [{ OWNER_TYPE: 'User' }, {}]) {
    const r = await exec(s, { labels: ['human-approved'], events: [owner(T('10:05'))], receipts: [receipt(T('10:05'))] }, env);
    assert.equal(r.byContext('Hard-stop scan').state, 'success', JSON.stringify(env));
  }
});

test('an unreadable config with an approval label present is an internal error (statuses are left for the fail-closed step)', async () => {
  const s = await setup(addDrop);
  s.repo.write('.claude/pipeline.yml', 'version: 1\n');
  const r = await exec(s, { labels: ['human-approved'], events: [owner(T('10:05'))] });
  assert.notEqual(r.code, 0);
  assert.equal(r.posts.length, 0);
});

// ---- approvals are bound to the exact head sha by a receipt ---------------------------------------------------------

const receiptPosts = (r) => r.posts.filter((p) => p.context.startsWith('pipeline-approval: '));

test('REGRESSION (R5\u2033): an approval on head A does not cover a descendant B that already had check suites/statuses from before the approval', async () => {
  // B (malicious, descendant of the approved A) was pushed EARLIER elsewhere (another branch, a fork PR) so GitHub holds
  // check suites for it at 09:00. The owner labeled the PR at 10:05 while its head was A, so the receipt sits on A and
  // B's own statuses carry none. The old rule ("label later than the earliest check suite of the head") passed B.
  const s = await setup(addDrop);
  const r = await exec(s, { labels: ['human-approved'], events: [owner(T('10:05'))], suites: [T('09:00')], receipts: [] });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.byContext('Hard-stop scan').state, 'failure', 'unreviewed B must stay red');
  assert.match(r.byContext('Hard-stop scan').description, /approval not recorded for this commit/);
  assert.equal(r.json.approvals.ignored[0].reason, 'no-receipt');
  assert.deepEqual(r.deletes, [`repos/${REPO}/issues/${PR}/labels/human-approved`], 'the stale label is removed so the owner can re-apply');
  assert.equal(receiptPosts(r).length, 0, 'a non-labeled run never mints a receipt');

  const t = await setup(deleteTest);
  const i = await exec(t, { labels: ['test-change-approved'], events: [owner(T('10:05'), 'test-change-approved')], suites: [T('09:00')], receipts: [] });
  assert.equal(i.byContext('Test integrity').state, 'failure');
});

test('a labeled run by an approver posts the receipt on the head FIRST, before reading the timeline or evaluating', async () => {
  const s = await setup(addDrop);
  const r = await exec(s, { labels: ['human-approved'], events: [owner(T('10:05'))], receipts: [receipt(T('10:05'))] }, labeledEnv('Acme'));
  assert.equal(r.code, 0, r.stderr);
  const [first] = r.posts;
  assert.deepEqual([first.context, first.state, first.sha, first.description], ['pipeline-approval: human-approved', 'success', s.head, 'human-approved approved by Acme']);
  assert.equal(first.target_url, 'https://github.example/acme/app/actions/runs/1');
  const idx = (pred) => r.calls.findIndex(pred);
  const receiptAt = idx((c) => c.argv.includes('context=pipeline-approval: human-approved'));
  assert.ok(receiptAt >= 0 && receiptAt < idx((c) => c.argv[1]?.endsWith('/events')));
  assert.ok(receiptAt < idx((c) => c.argv.includes('context=Hard-stop scan')));
  assert.equal(r.posts.length, 3, 'receipt + the two guard statuses');
  assert.equal(r.byContext('Hard-stop scan').state, 'success');

  const t = await setup(deleteTest);
  const i = await exec(t, { labels: ['test-change-approved'], events: [owner(T('10:05'), 'test-change-approved')], receipts: [receipt(T('10:05'), 'test-change-approved')] }, labeledEnv('acme', 'test-change-approved'));
  assert.equal(receiptPosts(i)[0].context, 'pipeline-approval: test-change-approved');
});

test('approver rules apply to the receipt: ci.approvers, the owner of a user repo; an org without a list mints nothing', async () => {
  const s = await setup(addDrop, APPROVERS);
  const alice = await exec(s, { labels: ['human-approved'], events: [owner(T('10:05'), 'human-approved', 'alice')], receipts: [receipt(T('10:05'), 'human-approved', BOT, RUN_1, 'alice')] }, { ...labeledEnv('alice'), OWNER_TYPE: 'Organization' });
  assert.equal(receiptPosts(alice).length, 1);
  const repoOwner = await exec(s, { labels: ['human-approved'], events: [owner(T('10:05'))] }, { ...labeledEnv('acme'), OWNER_TYPE: 'User' });
  assert.equal(receiptPosts(repoOwner).length, 0, 'the repo owner is not an approver when a list exists');

  const u = await setup(addDrop);
  const userRepo = await exec(u, { labels: ['human-approved'], events: [owner(T('10:05'))] }, { ...labeledEnv('mallory'), OWNER_TYPE: 'User' });
  assert.equal(receiptPosts(userRepo).length, 0, 'a collaborator who is not the owner');
  assert.equal(userRepo.byContext('Hard-stop scan').state, 'failure');

  const o = await setup(addDrop);
  const org = await exec(o, { labels: ['human-approved'], events: [owner(T('10:05'))] }, { ...labeledEnv('acme'), OWNER_TYPE: 'Organization' });
  assert.equal(receiptPosts(org).length, 0);
  assert.equal(org.json.approvals.ignored[0].reason, 'org-repo-needs-ci.approvers');
});

test('no receipt unless this is a labeled event for an approval label whose head is still the PR head', async () => {
  // event head != current head: superseded before anything (so before a receipt)
  const a = await setup(addDrop);
  const stale = await exec(a, { labels: ['human-approved'], events: [owner(T('10:05'))], pullHeads: [OTHER_SHA] }, labeledEnv());
  assert.equal(receiptPosts(stale).length, 0);
  assert.ok(stale.posts.every((p) => p.state === 'error'));
  // the ref fetched from GitHub is not the event head
  const f = await setup(addDrop);
  f.repo.git(['push', '-q', '-f', 'origin', `${f.repo.base}:refs/pull/${PR}/head`]);
  assert.equal(receiptPosts(await exec(f, {}, labeledEnv())).length, 0);
  // some other label, or another action carrying a sender and label
  const b = await setup(addDrop);
  assert.equal(receiptPosts(await exec(b, {}, labeledEnv('acme', 'needs-review'))).length, 0);
  assert.equal(receiptPosts(await exec(b, {}, { EVENT_ACTION: 'unlabeled', EVENT_LABEL: 'human-approved', EVENT_SENDER: 'acme' })).length, 0);
  assert.equal(receiptPosts(await exec(b, {}, { EVENT_ACTION: 'synchronize', EVENT_LABEL: 'human-approved', EVENT_SENDER: 'acme' })).length, 0);
  assert.equal(receiptPosts(await exec(b, {}, { EVENT_ACTION: 'labeled', EVENT_LABEL: 'human-approved', EVENT_SENDER: '' })).length, 0);
});

test('a receipt not created by github-actions[bot] (a human or an agent with the owner token) is ignored', async () => {
  const s = await setup(addDrop);
  const r = await exec(s, { labels: ['human-approved'], events: [owner(T('10:05'))], receipts: [receipt(T('10:06'), 'human-approved', 'acme')] });
  assert.equal(r.byContext('Hard-stop scan').state, 'failure');
  assert.equal(r.json.approvals.ignored[0].reason, 'no-receipt');
  const nobody = await exec(s, { labels: ['human-approved'], events: [owner(T('10:05'))], receipts: [receipt(T('10:06'), 'human-approved', null)] });
  assert.equal(nobody.byContext('Hard-stop scan').state, 'failure');
});

test('a receipt for the OTHER approval label does not stand in', async () => {
  const s = await setup(addDrop);
  const r = await exec(s, { labels: ['human-approved'], events: [owner(T('10:05'))], receipts: [receipt(T('10:05'), 'test-change-approved')] });
  assert.equal(r.byContext('Hard-stop scan').state, 'failure');
});

test('remove + re-add: the new labeling needs its own receipt; an earlier approval\'s receipt is not reused', async () => {
  const s = await setup(addDrop);
  const events = [owner(T('10:05')), owner(T('10:09'))];
  const reapplied = await exec(s, { labels: ['human-approved'], events, receipts: [receipt(T('10:05')), receipt(T('10:09'))] }, labeledEnv());
  assert.equal(reapplied.byContext('Hard-stop scan').state, 'success');
  // re-added, but that labeled run was cancelled before it posted: only the first receipt exists -> fail closed
  const cancelled = await exec(s, { labels: ['human-approved'], events, receipts: [receipt(T('10:05'))] });
  assert.equal(cancelled.byContext('Hard-stop scan').state, 'failure');
  assert.match(cancelled.byContext('Hard-stop scan').description, /re-apply the label/);
});

test('malformed labeling-event env is an internal error (exit 1)', async () => {
  const s = await setup(cleanChange);
  assert.equal((await exec(s, {}, { EVENT_ACTION: 'labeled; rm -rf /', EVENT_LABEL: 'human-approved', EVENT_SENDER: 'acme' })).code, 1);
  const bad = await exec(s, {}, { EVENT_ACTION: 'labeled', EVENT_LABEL: 'human-approved', EVENT_SENDER: 'a b$(x)' });
  assert.equal(bad.code, 1);
  assert.match(bad.json.message, /EVENT_SENDER is not a login/);
  assert.equal((await exec(s, {}, { EVENT_ACTION: 'labeled', EVENT_LABEL: 'human-approved', EVENT_SENDER: 'dependabot[bot]' })).code, 0);
});

// ---- provenance: a bot receipt only counts when the pipeline-guards workflow from the default branch posted it ---------

const approve = (extra = {}, env = {}) => setup(addDrop).then((s) => exec(s, { labels: ['human-approved'], events: [owner(T('10:05'))], receipts: [receipt(T('10:05'))], ...extra }, env));
const ignoredAsNoReceipt = (r) => {
  assert.equal(r.byContext('Hard-stop scan').state, 'failure');
  assert.equal(r.json.approvals.ignored[0].reason, 'no-receipt');
  assert.equal(r.deletes.length, 1);
};

test('provenance: a run of the real workflow from the default branch is accepted (an @ref suffix on its path is ignored)', async () => {
  for (const path of ['.github/workflows/pipeline-guards.yml', '.github/workflows/pipeline-guards.yml@refs/heads/main']) {
    const r = await approve({ runs: { 1: { path } } });
    assert.equal(r.byContext('Hard-stop scan').state, 'success', path);
  }
  assert.equal((await approve({ compare: 'identical' })).byContext('Hard-stop scan').state, 'success');
});

test('provenance: a receipt from a run of a DIFFERENT workflow file is ignored', async () => {
  for (const path of ['.github/workflows/evil.yml@refs/heads/main', '.github/workflows/pipeline-guards.yaml', '.github/workflows/pipeline-guards.yml.bak', 'pipeline-guards.yml', '']) {
    ignoredAsNoReceipt(await approve({ runs: { 1: { path } } }));
  }
});

test('provenance: a receipt from a run triggered by pull_request (or anything but pull_request_target) is ignored', async () => {
  for (const event of ['pull_request', 'push', 'workflow_dispatch', 'schedule']) ignoredAsNoReceipt(await approve({ runs: { 1: { event } } }));
});

test('provenance: a run whose workflow came from a commit NOT on the default branch is ignored', async () => {
  // The attack: branch x carries an edited pipeline-guards.yml; a PR into x runs it and posts bot receipts on the shared head.
  for (const compare of ['diverged', 'behind', '', 'weird']) ignoredAsNoReceipt(await approve({ compare }));
  const r = await approve({ compare: 'diverged' });
  assert.match(r.stderr, /not on the default branch \(diverged\)/);
});

test('provenance: a receipt without a usable run URL, from another repository, or whose run cannot be read is ignored', async () => {
  const at = T('10:05');
  for (const url of [null, '', 'https://github.example/acme/app/commit/abc', 'https://github.example/evil/app/actions/runs/1', 'https://github.example/acme/app/actions/runs/0', 'https://github.example/acme/app/actions/runs/1x', 'javascript:alert(1)']) {
    ignoredAsNoReceipt(await approve({ receipts: [receipt(at, 'human-approved', BOT, url)] }));
  }
  ignoredAsNoReceipt(await approve({ failOn: [`^api repos/${REPO}/actions/runs/1 `] }));
  ignoredAsNoReceipt(await approve({ failOn: [`^api repos/${REPO} --jq \\.default_branch`] }));
});

test('provenance: a forged receipt does not block, or stand in for, a genuine one', async () => {
  const evilRun = 'https://github.example/acme/app/actions/runs/2';
  const forgedNewer = await approve({ receipts: [receipt(T('10:05')), receipt(T('10:06'), 'human-approved', BOT, evilRun)], runs: { 2: { path: '.github/workflows/evil.yml' } } });
  assert.equal(forgedNewer.byContext('Hard-stop scan').state, 'success');
  const onlyForged = await approve({ receipts: [receipt(T('10:06'), 'human-approved', BOT, evilRun)], runs: { 2: { event: 'pull_request' } } });
  ignoredAsNoReceipt(onlyForged);
});

test('provenance: the receipt is posted with the run URL as target_url, and not at all without one', async () => {
  const s = await setup(addDrop);
  const r = await exec(s, { labels: ['human-approved'], events: [owner(T('10:05'))], receipts: [receipt(T('10:05'))] }, labeledEnv());
  assert.equal(receiptPosts(r)[0].target_url, RUN_1);
  const t = await setup(addDrop);
  const none = await exec(t, {}, { ...labeledEnv(), RUN_URL: '' });
  assert.equal(none.code, 1);
  assert.match(none.json.message, /RUN_URL is required to post an approval receipt/);
  assert.equal(receiptPosts(none).length, 0);
});

// ---- provenance binding: the run must be ABOUT this PR, head and moment, not merely a genuine run ---------------------

test('binding: a run that lists no pull request, another PR, another head sha, or a base that is not the default branch is ignored', async () => {
  const other = 'e'.repeat(40);
  const variants = [
    () => [],
    (h) => [{ number: PR + 1, head: { sha: h }, base: { ref: 'main' } }],
    () => [{ number: PR, head: { sha: other }, base: { ref: 'main' } }],
    (h) => [{ number: PR, head: { sha: h }, base: { ref: 'release' } }],
    (h) => [{ number: PR, head: { sha: h } }],
    (h) => [{ number: PR + 1, head: { sha: h }, base: { ref: 'main' } }, { number: PR, head: { sha: other }, base: { ref: 'main' } }],
    () => null,
  ];
  for (const make of variants) {
    const s = await setup(addDrop);
    const r = await exec(s, { labels: ['human-approved'], events: [owner(T('10:05'))], receipts: [receipt(T('10:05'))], runs: { 1: { pull_requests: make(s.head) } } });
    ignoredAsNoReceipt(r);
  }
});

test('binding: DOWNGRADE - a run for a PR into a side branch cut from an old main commit is an ancestor of main but is untrusted', async () => {
  const s = await setup(addDrop);
  const r = await exec(s, {
    labels: ['human-approved'], events: [owner(T('10:05'))], receipts: [receipt(T('10:05'))], compare: 'ahead',
    runs: { 1: { pull_requests: [{ number: PR, head: { sha: s.head }, base: { ref: 'old-main-copy' } }] } },
  });
  ignoredAsNoReceipt(r);
  assert.match(r.stderr, /not about PR #7 at [0-9a-f]{7} into main/);
});

test('binding: a receipt posted outside the run window (beyond 10 s) is ignored; within the slack it counts', async () => {
  const win = { run_started_at: T('10:06'), updated_at: T('10:08') };
  ignoredAsNoReceipt(await approve({ runs: { 1: win }, receipts: [receipt(T('10:20'))], events: [owner('2026-10-01T10:06:05Z')] }));
  ignoredAsNoReceipt(await approve({ runs: { 1: win }, receipts: [receipt('2026-10-01T10:08:11Z')], events: [owner(T('10:06'))] }));
  assert.equal((await approve({ runs: { 1: win }, receipts: [receipt('2026-10-01T10:08:09Z')], events: [owner('2026-10-01T10:06:05Z')] })).byContext('Hard-stop scan').state, 'success');
  assert.equal((await approve({ runs: { 1: win }, receipts: [receipt('2026-10-01T10:06:01Z')], events: [owner('2026-10-01T10:05:55Z')] })).byContext('Hard-stop scan').state, 'success');
});

test('binding: the latest labeling must fall inside the window of the run that posted the receipt', async () => {
  // A spoofing run started after the real labeling, pointing at a genuine run that is open NOW: its window does not hold the label event.
  const win = { run_started_at: T('10:30'), updated_at: T('10:32') };
  ignoredAsNoReceipt(await approve({ runs: { 1: win }, receipts: [receipt(T('10:31'))], events: [owner(T('10:05'))] }));
  assert.equal((await approve({ runs: { 1: win }, receipts: [receipt(T('10:31'))], events: [owner(T('10:30'))] })).byContext('Hard-stop scan').state, 'success');
});

test('binding: the receipt description must name this label and the approver of the latest labeling', async () => {
  for (const description of ['approved by acme', 'test-change-approved approved by acme', 'human-approved approved by mallory', '', null]) {
    ignoredAsNoReceipt(await approve({ receipts: [{ ...receipt(T('10:05')), description }] }));
  }
  const ok = await approve({ receipts: [{ ...receipt(T('10:05')), description: 'human-approved approved by ACME' }] });
  assert.equal(ok.byContext('Hard-stop scan').state, 'success');
});

test('binding: the run is read once per run id however many receipts point at it', async () => {
  const r = await approve({ receipts: [receipt(T('10:05')), receipt(T('10:06')), receipt(T('10:07'), 'test-change-approved')] });
  assert.equal(r.byContext('Hard-stop scan').state, 'success');
  assert.equal(r.api('/actions/runs/1').length, 1);
});

test('guard-provenance: parseRunUrl accepts exactly Actions run URLs', async () => {
  const { parseRunUrl } = await import('../pipeline/lib/guard-provenance.mjs');
  assert.deepEqual(parseRunUrl('https://github.com/acme/app/actions/runs/123'), { repo: 'acme/app', runId: '123' });
  assert.deepEqual(parseRunUrl('https://ghe.example.com/acme/app/actions/runs/123/job/9?pr=1'), { repo: 'acme/app', runId: '123' });
  for (const bad of ['', null, undefined, 'https://github.com/acme/app/actions/runs/', 'https://github.com/acme/app/actions/workflows/x.yml', 'ftp://x/acme/app/actions/runs/1', 'https://github.com/acme/actions/runs/1']) {
    assert.equal(parseRunUrl(bad), null, String(bad));
  }
});
