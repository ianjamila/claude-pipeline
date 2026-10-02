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
function script({ head, pullHeads = [head], labels = [], labelSeq, suites = [T('10:00')], statuses = [], events = [], failOn = [] }) {
  const lines = (a) => (a.length ? `${a.join('\n')}\n` : '');
  return [
    ...failOn.map((match) => ({ match, code: 1, stderr: 'HTTP 500' })),
    { match: `^api repos/${REPO}/pulls/${PR} `, sequence: pullHeads.map((h) => ({ stdout: `${h}\n` })) },
    { match: `^api repos/${REPO}/issues/${PR}/labels --paginate`, sequence: (labelSeq ?? [labels]).map((l) => ({ stdout: lines(l) })) },
    { match: `^api repos/${REPO}/commits/${head}/check-suites`, stdout: lines(suites) },
    { match: `^api repos/${REPO}/commits/${head}/statuses`, stdout: lines(statuses) },
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

test('a valid human-approved (owner, after the head appeared) passes the hard-stop', async () => {
  const s = await setup(addDrop);
  const r = await exec(s, { labels: ['human-approved'], events: [owner(T('10:05'))] });
  assert.equal(r.byContext('Hard-stop scan').state, 'success');
  assert.match(r.byContext('Hard-stop scan').description, /approved by label human-approved/);
  assert.deepEqual(r.deletes, []);
  assert.deepEqual(r.json.approvals.valid, ['human-approved']);
  assert.equal(r.json.approvals.headSeenAt, '2026-10-01T10:00:00.000Z');
});

test('a valid test-change-approved passes Test integrity, and human-approved does not stand in for it', async () => {
  const a = await setup(deleteTest);
  const ok = await exec(a, { labels: ['test-change-approved'], events: [owner(T('10:05'), 'test-change-approved')] });
  assert.equal(ok.byContext('Test integrity').state, 'success');
  assert.match(ok.byContext('Test integrity').description, /approved by label test-change-approved/);

  const b = await setup(deleteTest);
  const wrong = await exec(b, { labels: ['human-approved'], events: [owner(T('10:05'))] });
  assert.equal(wrong.byContext('Test integrity').state, 'failure');
});

test('an approval applied BEFORE the head appeared is ignored, removed, and explained', async () => {
  const s = await setup(addDrop);
  const r = await exec(s, { labels: ['human-approved'], events: [owner(T('09:00'))] });
  assert.equal(r.code, 0, r.stderr);
  const hs = r.byContext('Hard-stop scan');
  assert.equal(hs.state, 'failure');
  assert.match(hs.description, /approval predates the latest commit — re-apply$/);
  assert.ok(hs.description.length <= 140);
  assert.deepEqual(r.deletes, [`repos/${REPO}/issues/${PR}/labels/human-approved`]);
  // The verdict is on record before the label goes (removing it cancels this run).
  const lastPost = Math.max(...r.calls.map((c, i) => (c.argv[1]?.includes('/statuses/') ? i : -1)));
  const del = r.calls.findIndex((c) => c.argv[1] === '-X');
  assert.ok(del > lastPost, 'label removal happens after both statuses are published');
  assert.deepEqual(r.json.approvals.removed, ['human-approved']);
  assert.match(r.md, /## Approvals ignored/);
});

test('an approval applied at exactly the moment the head appeared is not "after" it', async () => {
  const s = await setup(addDrop);
  const r = await exec(s, { labels: ['human-approved'], events: [owner(T('10:00'))] });
  assert.equal(r.byContext('Hard-stop scan').state, 'failure');
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
  const r = await exec(s, { labels: ['human-approved'], events: [owner(T('10:05'), 'human-approved', 'ACME')] });
  assert.equal(r.byContext('Hard-stop scan').state, 'success');
});

test('the LATEST labeled event decides who approved', async () => {
  const a = await setup(addDrop);
  const stolen = await exec(a, { labels: ['human-approved'], events: [owner(T('10:05')), owner(T('10:07'), 'human-approved', 'mallory')] });
  assert.equal(stolen.byContext('Hard-stop scan').state, 'failure');

  const b = await setup(addDrop);
  const reapplied = await exec(b, { labels: ['human-approved'], events: [owner(T('10:04'), 'human-approved', 'mallory'), owner(T('10:06'))] });
  assert.equal(reapplied.byContext('Hard-stop scan').state, 'success');

  const c = await setup(addDrop);
  const none = await exec(c, { labels: ['human-approved'], events: [] });
  assert.equal(none.byContext('Hard-stop scan').state, 'failure', 'a label with no labeling event cannot be attributed');
  assert.match(none.byContext('Hard-stop scan').description, /no labeling event found/);
});

test('with no check suites and no statuses for the head, approvals are invalid', async () => {
  const s = await setup(addDrop);
  const r = await exec(s, { labels: ['human-approved'], events: [owner(T('10:05'))], suites: [], statuses: [] });
  assert.equal(r.byContext('Hard-stop scan').state, 'failure');
  assert.match(r.byContext('Hard-stop scan').description, /cannot tell when the commit appeared/);
  assert.equal(r.json.approvals.headSeenAt, null);
});

test('"head appeared" is the EARLIEST of check suites and statuses', async () => {
  const s = await setup(addDrop);
  // Label at 10:05: later than the earliest status (10:03) but earlier than the only check suite (10:10).
  const r = await exec(s, { labels: ['human-approved'], events: [owner(T('10:05'))], suites: [T('10:10')], statuses: [T('10:03'), T('10:20')] });
  assert.equal(r.byContext('Hard-stop scan').state, 'success');
  assert.equal(r.json.approvals.headSeenAt, '2026-10-01T10:03:00.000Z');
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
  const r = await exec(s, { labelSeq: [[], ['human-approved'], ['human-approved']], events: [owner(T('10:05'))] });
  assert.equal(r.api('/labels').length, 3);
  assert.equal(r.api('/events').length, 1, 'approvals were only resolved on the second pass');
  assert.equal(r.posts.length, 2, 'published once');
  assert.equal(r.byContext('Hard-stop scan').state, 'success');
});

test('a second pass is final: it is not repeated even if the labels moved again', async () => {
  const s = await setup(addDrop);
  const r = await exec(s, { labelSeq: [[], ['human-approved'], [], ['human-approved']], events: [owner(T('10:05'))] });
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
  const r = await exec(s, { labels: ['human-approved'], events: [owner(T('10:05'))] });
  const filter = (suffix) => r.api(suffix)[0].argv[r.api(suffix)[0].argv.indexOf('--jq') + 1];
  const jq = (expr, payload) => spawnSync('jq', ['-r', expr], { input: JSON.stringify(payload), encoding: 'utf8' }).stdout;

  assert.equal(jq(filter(`/pulls/${PR}`), { number: 7, head: { sha: s.head } }).trim(), s.head);
  assert.equal(jq(filter('/labels'), [{ name: 'a' }, { name: 'human-approved' }]), 'a\nhuman-approved\n');
  assert.equal(jq(filter('/check-suites'), { total_count: 1, check_suites: [{ created_at: T('10:00') }] }), `${T('10:00')}\n`);
  assert.equal(jq(filter('/statuses'), [{ created_at: T('10:01') }, { created_at: T('10:02') }]), `${T('10:01')}\n${T('10:02')}\n`);
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

// ---- who may approve: ci.approvers, the owner of a user repo, never an org name -----------------------------------------

const APPROVERS = { config: CONFIG(undefined, 'ci:\n  approvers: [alice, "Bob"]\n') };

test('ci.approvers: a listed login (any case) approves; the repo owner does NOT when the list exists; others are ignored', async () => {
  const s = await setup(addDrop, APPROVERS);
  const alice = await exec(s, { labels: ['human-approved'], events: [owner(T('10:05'), 'human-approved', 'Alice')] }, { OWNER_TYPE: 'Organization' });
  assert.equal(alice.byContext('Hard-stop scan').state, 'success');
  assert.deepEqual(alice.json.approvals.valid, ['human-approved']);
  const bob = await exec(s, { labels: ['human-approved'], events: [owner(T('10:05'), 'human-approved', 'bob')] }, { OWNER_TYPE: 'Organization' });
  assert.equal(bob.byContext('Hard-stop scan').state, 'success');
  const ownerOnly = await exec(s, { labels: ['human-approved'], events: [owner(T('10:05'))] }, { OWNER_TYPE: 'User' });
  assert.equal(ownerOnly.byContext('Hard-stop scan').state, 'failure');
  assert.match(ownerOnly.byContext('Hard-stop scan').description, /not applied by a login listed in ci\.approvers/);
  assert.equal(ownerOnly.json.approvals.ignored[0].reason, 'not-approver');
});

test('org-owned repo with no ci.approvers fails closed with a clear reason, even if the actor is called like the org', async () => {
  const s = await setup(addDrop);
  const r = await exec(s, { labels: ['human-approved'], events: [owner(T('10:05'))] }, { OWNER_TYPE: 'Organization' });
  assert.equal(r.byContext('Hard-stop scan').state, 'failure');
  assert.match(r.byContext('Hard-stop scan').description, /org-repo-needs-ci\.approvers/);
  assert.equal(r.json.approvals.ignored[0].reason, 'org-repo-needs-ci.approvers');
  assert.equal(r.deletes.length, 1);
});

test('user-owned repo with no list keeps the owner rule (OWNER_TYPE User, or unset for old workflows)', async () => {
  const s = await setup(addDrop);
  for (const env of [{ OWNER_TYPE: 'User' }, {}]) {
    const r = await exec(s, { labels: ['human-approved'], events: [owner(T('10:05'))] }, env);
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
