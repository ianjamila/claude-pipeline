import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GhError } from '../pipeline/lib/proc.mjs';
import { createGitHub, parseConcatenatedJson, classifyApiError } from '../pipeline/lib/github.mjs';
import { findDeployment, currentProduction } from '../pipeline/lib/deploy.mjs';
import { createFakeGh, REPO_VIEW } from './helpers/fakegh-env.mjs';

const cwd = process.cwd();
const REPO = { match: '^repo view', stdoutJson: REPO_VIEW };
const ME = { match: '^api user', stdout: 'me\n' };
const MARKER = '<!-- claude-pipeline:triage -->';
const mk = (entries) => {
  const fake = createFakeGh(entries);
  return { fake, gh: createGitHub({ cwd, env: fake.env }) };
};

// ---- repo / viewer --------------------------------------------------------------------------

test('repo() parses gh repo view once and caches it', () => {
  const { fake, gh } = mk([REPO]);
  assert.deepEqual(gh.repo(), { owner: 'acme', name: 'widgets', slug: 'acme/widgets', host: 'github.com', defaultBranch: 'main' });
  gh.repo();
  assert.equal(fake.lines().filter((l) => l.startsWith('repo view')).length, 1);
});

test('viewer() returns the trimmed login and is cached', () => {
  const { fake, gh } = mk([ME]);
  assert.equal(gh.viewer(), 'me');
  gh.viewer();
  assert.equal(fake.calls().length, 1);
});

test('every method throws GhError when gh fails (an API error is never "fine")', () => {
  const { gh } = mk([{ match: '.', stderr: 'boom', code: 1 }]);
  assert.throws(() => gh.viewer(), GhError);
  assert.throws(() => gh.repo(), GhError);
  assert.throws(() => gh.listIssues({ label: 'x' }), GhError);
  assert.throws(() => gh.prLabels(1), GhError);
});

test('authStatus reports ok from the exit code and never throws', () => {
  assert.equal(mk([{ match: '^auth status', code: 0 }]).gh.authStatus().ok, true);
  const bad = mk([{ match: '^auth status', code: 1, stderr: 'You are not logged in' }]).gh.authStatus();
  assert.equal(bad.ok, false);
  assert.match(bad.message, /not logged in/);
});

// ---- PRs, labels, issues --------------------------------------------------------------------

test('prView asks for exactly the requested fields', () => {
  const { fake, gh } = mk([{ match: '^pr view 7', stdoutJson: { headRefOid: 'abc', title: 't' } }]);
  assert.deepEqual(gh.prView(7, ['headRefOid', 'title']), { headRefOid: 'abc', title: 't' });
  assert.equal(fake.lines()[0], 'pr view 7 --json headRefOid,title');
});

test('prLabels returns label names', () => {
  const { gh } = mk([{ match: '^pr view 7 --json labels', stdoutJson: { labels: [{ name: 'a' }, { name: 'b' }] } }]);
  assert.deepEqual(gh.prLabels(7), ['a', 'b']);
});

test('addLabels / removeLabels use gh pr edit; an empty list makes no call', () => {
  const { fake, gh } = mk([{ match: '^pr edit', code: 0 }]);
  gh.addLabels(5, ['needs-human', 'x']);
  gh.removeLabels(5, ['awaiting-review']);
  gh.addLabels(5, []);
  assert.deepEqual(fake.lines(), [
    'pr edit 5 --add-label needs-human --add-label x',
    'pr edit 5 --remove-label awaiting-review',
  ]);
});

test('a non-numeric PR number is rejected before any gh call', () => {
  const { fake, gh } = mk([]);
  assert.throws(() => gh.prLabels('5; rm -rf'), /PR number/);
  assert.equal(fake.calls().length, 0);
});

test('listIssues defaults to open issues and passes the label', () => {
  const { fake, gh } = mk([{ match: '^issue list', stdoutJson: [{ number: 3, title: 't', url: 'u', labels: [] }] }]);
  assert.equal(gh.listIssues({ label: 'pipeline-pause' })[0].number, 3);
  assert.equal(fake.lines()[0], 'issue list --label pipeline-pause --state open --json number,title,url,labels --limit 100');
});

test('issueCreate posts JSON on stdin and returns {number, url}', () => {
  const { fake, gh } = mk([REPO, { match: '^api -X POST repos/acme/widgets/issues ', stdoutJson: { number: 9, html_url: 'https://github.com/acme/widgets/issues/9' } }]);
  const r = gh.issueCreate({ title: 'T', body: 'B', labels: ['agent-suggestion'] });
  assert.deepEqual(r, { number: 9, url: 'https://github.com/acme/widgets/issues/9' });
  const call = fake.calls().find((c) => c.argv[0] === 'api');
  assert.ok(call.argv.includes('--input'));
  assert.deepEqual(JSON.parse(call.stdin), { title: 'T', body: 'B', labels: ['agent-suggestion'] });
});

test('listPrs filters by label and state', () => {
  const { fake, gh } = mk([{ match: '^pr list', stdoutJson: [{ number: 1 }] }]);
  assert.equal(gh.listPrs({ label: 'awaiting-review' }).length, 1);
  assert.equal(fake.lines()[0], 'pr list --label awaiting-review --state open --json number,title,headRefName,url --limit 100');
});

// ---- comments -------------------------------------------------------------------------------

test('parseConcatenatedJson handles paginated arrays glued together, slurped arrays and braces in strings', () => {
  assert.deepEqual(parseConcatenatedJson('[{"a":1}]\n[{"b":"}]["},{"c":3}]'), [{ a: 1 }, { b: '}][' }, { c: 3 }]);
  assert.deepEqual(parseConcatenatedJson('[[{"a":1}],[{"b":2}]]'), [{ a: 1 }, { b: 2 }]);
  assert.deepEqual(parseConcatenatedJson('[]'), []);
  assert.deepEqual(parseConcatenatedJson(''), []);
  assert.throws(() => parseConcatenatedJson('[{"a":1}'), /truncated|unbalanced/i);
  assert.throws(() => parseConcatenatedJson('nope'), /unexpected/i);
});

test('listComments concatenates every page', () => {
  const page1 = JSON.stringify([{ id: 1, body: 'a' }, { id: 2, body: 'b' }]);
  const page2 = JSON.stringify([{ id: 3, body: 'c' }]);
  const { fake, gh } = mk([REPO, { match: 'issues/4/comments --paginate', stdout: `${page1}${page2}` }]);
  assert.deepEqual(gh.listComments(4).map((c) => c.id), [1, 2, 3]);
  assert.ok(fake.lines().includes('api repos/acme/widgets/issues/4/comments --paginate'));
});

const comments = (...c) => ({ match: 'issues/4/comments --paginate', stdoutJson: c });

test('upsertComment PATCHes the viewer\'s existing marker comment (the newest one)', () => {
  const { fake, gh } = mk([
    REPO, ME,
    comments(
      { id: 10, body: `${MARKER}\nold`, user: { login: 'me' } },
      { id: 12, body: `${MARKER}\nnewer`, user: { login: 'me' } },
      { id: 11, body: 'unrelated', user: { login: 'me' } },
    ),
    { match: '^api -X PATCH repos/acme/widgets/issues/comments/12 ', stdoutJson: { id: 12, html_url: 'https://x/12' } },
  ]);
  const r = gh.upsertComment(4, MARKER, `${MARKER}\nnew body`);
  assert.deepEqual(r, { id: 12, url: 'https://x/12', action: 'updated' });
  const patch = fake.calls().find((c) => c.argv.includes('PATCH'));
  assert.deepEqual(JSON.parse(patch.stdin), { body: `${MARKER}\nnew body` });
  assert.ok(!fake.lines().some((l) => l.includes('-X POST')));
});

test('upsertComment POSTs when only ANOTHER user has a marker comment (never edit what is not ours)', () => {
  const { fake, gh } = mk([
    REPO, ME,
    comments({ id: 10, body: `${MARKER}\nforged`, user: { login: 'mallory' } }),
    { match: '^api -X POST repos/acme/widgets/issues/4/comments ', stdoutJson: { id: 99, html_url: 'https://x/99' } },
  ]);
  const r = gh.upsertComment(4, MARKER, `${MARKER}\nmine`);
  assert.deepEqual(r, { id: 99, url: 'https://x/99', action: 'created' });
  assert.ok(!fake.lines().some((l) => l.includes('PATCH')));
});

test('upsertComment only matches a comment that STARTS with the marker', () => {
  const { gh } = mk([
    REPO, ME,
    comments({ id: 10, body: `quoting ${MARKER} in the middle`, user: { login: 'me' } }),
    { match: '^api -X POST ', stdoutJson: { id: 5, html_url: 'u' } },
  ]);
  assert.equal(gh.upsertComment(4, MARKER, `${MARKER}\nx`).action, 'created');
});

test('upsertComment refuses a body that does not start with its marker (it would never be found again)', () => {
  const { fake, gh } = mk([REPO, ME]);
  assert.throws(() => gh.upsertComment(4, MARKER, 'no marker here'), /marker/);
  assert.equal(fake.calls().length, 0);
});

test('upsertComment finds the marker comment across a second page', () => {
  const page1 = JSON.stringify([{ id: 1, body: 'x', user: { login: 'me' } }]);
  const page2 = JSON.stringify([{ id: 2, body: `${MARKER}\nold`, user: { login: 'me' } }]);
  const { gh } = mk([
    REPO, ME,
    { match: 'comments --paginate', stdout: page1 + page2 },
    { match: '^api -X PATCH repos/acme/widgets/issues/comments/2 ', stdoutJson: { id: 2, html_url: 'u' } },
  ]);
  assert.equal(gh.upsertComment(4, MARKER, `${MARKER}\nnew`).action, 'updated');
});

// ---- branch protection ----------------------------------------------------------------------

test('protection: 200 returns the parsed body', () => {
  const { gh } = mk([REPO, { match: 'branches/main/protection', stdoutJson: { enforce_admins: { enabled: true } } }]);
  assert.deepEqual(gh.protection('main'), { status: 200, json: { enforce_admins: { enabled: true } } });
});

test('protection: 403 "Upgrade to GitHub Pro" is a plan problem', () => {
  const { gh } = mk([REPO, {
    match: 'protection',
    code: 1,
    stdout: '{"message":"Upgrade to GitHub Pro or make this repository public to enable this feature.","status":"403"}',
    stderr: 'gh: Upgrade to GitHub Pro or make this repository public to enable this feature. (HTTP 403)',
  }]);
  const r = gh.protection('main');
  assert.equal(r.status, 403);
  assert.equal(r.reason, 'plan');
  assert.match(r.message, /Upgrade to GitHub Pro/);
});

test('protection: any other 403 is a permission problem', () => {
  const { gh } = mk([REPO, { match: 'protection', code: 1, stderr: 'gh: Resource not accessible by personal access token (HTTP 403)' }]);
  const r = gh.protection('main');
  assert.equal(r.status, 403);
  assert.equal(r.reason, 'permission');
});

test('protection: "Branch not protected" is a 404', () => {
  const { gh } = mk([REPO, { match: 'protection', code: 1, stderr: 'gh: Branch not protected (HTTP 404)' }]);
  const r = gh.protection('main');
  assert.equal(r.status, 404);
  assert.equal(r.reason, 'not-protected');
});

test('protection: an unrecognised failure throws instead of being read as a status', () => {
  const { gh } = mk([REPO, { match: 'protection', code: 1, stderr: 'gh: Server Error (HTTP 502)' }]);
  assert.throws(() => gh.protection('main'), GhError);
});

test('classifyApiError ignores errors it does not recognise', () => {
  assert.equal(classifyApiError({ stderr: 'gh: Server Error (HTTP 502)', stdout: '' }), null);
});

test('protection: a branch containing a slash keeps its slashes in the path', () => {
  const { fake, gh } = mk([REPO, { match: 'protection', stdoutJson: {} }]);
  gh.protection('release/1.x');
  assert.ok(fake.lines().includes('api repos/acme/widgets/branches/release/1.x/protection'));
});

// ---- deployments ----------------------------------------------------------------------------

test('deployments / deploymentStatuses build the right API paths', () => {
  const { fake, gh } = mk([REPO, { match: 'deployments\\?', stdoutJson: [{ id: 1 }] }, { match: 'statuses', stdoutJson: [{ state: 'success' }] }]);
  assert.deepEqual(gh.deployments({ sha: 'a'.repeat(40), environment: 'Preview' }), [{ id: 1 }]);
  assert.deepEqual(gh.deploymentStatuses(77), [{ state: 'success' }]);
  assert.deepEqual(gh.deployments({ environment: 'Production' }), [{ id: 1 }]);
  assert.deepEqual(fake.lines().filter((l) => l.startsWith('api repos/acme/widgets/deployments')), [
    `api repos/acme/widgets/deployments?sha=${'a'.repeat(40)}&environment=Preview&per_page=30`,
    'api repos/acme/widgets/deployments/77/statuses?per_page=30',
    'api repos/acme/widgets/deployments?environment=Production&per_page=30',
  ]);
});

// ---- checks ---------------------------------------------------------------------------------

test('checks parses the JSON that gh prints while exiting 8 (pending) or 1 (failed)', () => {
  const rows = [{ name: 'ci', state: 'PENDING', bucket: 'pending', link: 'l', workflow: 'w' }];
  for (const code of [0, 1, 8]) {
    const { gh } = mk([{ match: '^pr checks 3', stdoutJson: rows, code }]);
    assert.deepEqual(gh.checks(3), rows, `exit ${code}`);
  }
});

test('checks passes --required, and throws when stdout is not JSON', () => {
  const { fake, gh } = mk([{ match: '^pr checks 3 .*--required', stdoutJson: [], code: 0 }]);
  gh.checks(3, { required: true });
  assert.equal(fake.lines()[0], 'pr checks 3 --json name,state,bucket,link,workflow --required');
  const bad = mk([{ match: '^pr checks', stderr: "no checks reported on the 'x' branch", code: 1 }]);
  assert.throws(() => bad.gh.checks(3), GhError);
});

// ---- deploy.mjs -----------------------------------------------------------------------------

// A scripted gh for deploy.mjs: each poll consumes the next frame { deployments, statuses: {id: [...]} }.
function stubGh(frames) {
  let i = -1;
  const frame = () => frames[Math.min(i, frames.length - 1)];
  return {
    deployments: () => { i += 1; return frame().deployments; },
    deploymentStatuses: (id) => frame().statuses[id] ?? [],
  };
}
const clock = () => {
  let t = 1_000;
  return { now: () => t, sleep: async (ms) => { t += ms; } };
};
const SHA = 'a'.repeat(40);

test('findDeployment: success returns the environment_url of the newest deployment', async () => {
  const gh = stubGh([{
    deployments: [{ id: 1, sha: SHA, created_at: '2026-10-01T00:00:00Z' }, { id: 2, sha: SHA, created_at: '2026-10-01T01:00:00Z' }],
    statuses: {
      1: [{ state: 'failure' }],
      2: [{ state: 'success', environment_url: 'https://preview.example', target_url: 'https://log' }, { state: 'in_progress' }],
    },
  }]);
  const r = await findDeployment({ gh, sha: SHA, environment: 'Preview', timeoutMs: 60_000, ...clock() });
  assert.deepEqual(r, { state: 'success', id: 2, url: 'https://preview.example', sha: SHA, createdAt: '2026-10-01T01:00:00Z' });
});

test('findDeployment: falls back to target_url when there is no environment_url', async () => {
  const gh = stubGh([{ deployments: [{ id: 1, sha: SHA }], statuses: { 1: [{ state: 'success', target_url: 'https://t.example' }] } }]);
  const r = await findDeployment({ gh, sha: SHA, environment: 'Preview', timeoutMs: 1000, ...clock() });
  assert.equal(r.url, 'https://t.example');
});

test('findDeployment: failure and error statuses are failures', async () => {
  for (const state of ['failure', 'error']) {
    const gh = stubGh([{ deployments: [{ id: 5, sha: SHA }], statuses: { 5: [{ state, log_url: 'https://logs' }] } }]);
    const r = await findDeployment({ gh, sha: SHA, environment: 'Preview', timeoutMs: 1000, ...clock() });
    assert.equal(r.state, 'failure');
    assert.equal(r.id, 5);
    assert.equal(r.url, 'https://logs');
  }
});

test('findDeployment: keeps polling through "no deployment yet" and "in progress", then succeeds', async () => {
  const gh = stubGh([
    { deployments: [], statuses: {} },
    { deployments: [{ id: 3, sha: SHA }], statuses: { 3: [{ state: 'in_progress' }, { state: 'pending' }] } },
    { deployments: [{ id: 3, sha: SHA }], statuses: { 3: [{ state: 'success', environment_url: 'https://ok' }] } },
  ]);
  const c = clock();
  const slept = [];
  const r = await findDeployment({ gh, sha: SHA, environment: 'Preview', timeoutMs: 600_000, pollMs: 15_000, now: c.now, sleep: async (ms) => { slept.push(ms); await c.sleep(ms); } });
  assert.equal(r.state, 'success');
  assert.deepEqual(slept, [15_000, 15_000]);
});

test('findDeployment: times out when nothing finishes (injected clock, no real waiting)', async () => {
  const gh = stubGh([{ deployments: [{ id: 3, sha: SHA }], statuses: { 3: [{ state: 'in_progress' }] } }]);
  const r = await findDeployment({ gh, sha: SHA, environment: 'Preview', timeoutMs: 45_000, pollMs: 15_000, ...clock() });
  assert.deepEqual(r, { state: 'timeout' });
});

test('findDeployment: always polls once, even with a zero timeout', async () => {
  const calls = [];
  const gh = { deployments: () => { calls.push(1); return []; }, deploymentStatuses: () => [] };
  const r = await findDeployment({ gh, sha: SHA, environment: 'Preview', timeoutMs: 0, ...clock() });
  assert.equal(r.state, 'timeout');
  assert.equal(calls.length, 1);
});

test('findDeployment: a superseded (inactive) status does not hide the success underneath it', async () => {
  const gh = stubGh([{ deployments: [{ id: 3, sha: SHA }], statuses: { 3: [{ state: 'inactive' }, { state: 'success', environment_url: 'https://was-ok' }] } }]);
  const r = await findDeployment({ gh, sha: SHA, environment: 'Preview', timeoutMs: 1000, ...clock() });
  assert.equal(r.state, 'success');
});

test('findDeployment: a success with no URL at all is not a success', async () => {
  const gh = stubGh([{ deployments: [{ id: 3, sha: SHA }], statuses: { 3: [{ state: 'success' }] } }]);
  const r = await findDeployment({ gh, sha: SHA, environment: 'Preview', timeoutMs: 20_000, pollMs: 10_000, ...clock() });
  assert.equal(r.state, 'timeout');
});

test('findDeployment: tolerates a transient gh error but gives up after three in a row', async () => {
  let n = 0;
  const flaky = {
    deployments: () => { n += 1; if (n === 1) throw new GhError({ code: 1, stderr: 'HTTP 502', args: ['api'] }); return [{ id: 1, sha: SHA }]; },
    deploymentStatuses: () => [{ state: 'success', environment_url: 'https://ok' }],
  };
  assert.equal((await findDeployment({ gh: flaky, sha: SHA, environment: 'P', timeoutMs: 60_000, ...clock() })).state, 'success');
  const dead = { deployments: () => { throw new GhError({ code: 1, stderr: 'HTTP 401', args: ['api'] }); }, deploymentStatuses: () => [] };
  await assert.rejects(findDeployment({ gh: dead, sha: SHA, environment: 'P', timeoutMs: 600_000, ...clock() }), GhError);
});

test('currentProduction: newest deployment whose latest status is success', async () => {
  const gh = {
    deployments: () => [
      { id: 30, sha: 'c'.repeat(40), created_at: '2026-10-03T00:00:00Z' },
      { id: 20, sha: 'b'.repeat(40), created_at: '2026-10-02T00:00:00Z' },
      { id: 10, sha: 'a'.repeat(40), created_at: '2026-10-01T00:00:00Z' },
    ],
    deploymentStatuses: (id) => ({
      30: [{ state: 'in_progress' }],
      20: [{ state: 'success', environment_url: 'https://prod.example' }, { state: 'in_progress' }],
      10: [{ state: 'inactive' }, { state: 'success', environment_url: 'https://old' }],
    })[id],
  };
  assert.deepEqual(await currentProduction({ gh, environment: 'Production' }), { id: 20, sha: 'b'.repeat(40), url: 'https://prod.example' });
});

test('currentProduction: null when nothing has succeeded', async () => {
  const gh = { deployments: () => [{ id: 1, sha: SHA }], deploymentStatuses: () => [{ state: 'failure' }] };
  assert.equal(await currentProduction({ gh, environment: 'Production' }), null);
  assert.equal(await currentProduction({ gh: { deployments: () => [], deploymentStatuses: () => [] }, environment: 'Production' }), null);
});

test('a gh call that timed out is a failure even if it printed something parseable', () => {
  const gh = createGitHub({ cwd, ghFn: () => ({ code: 0, stdout: '[]', stderr: '', timedOut: true }) });
  assert.throws(() => gh.checks(3), GhError);
  assert.throws(() => gh.listIssues({ label: 'x' }), GhError);
});

test('pagePullRequests: extra variables reach gh api graphql as -f name=value', () => {
  const calls = [];
  const ghFn = (args) => {
    calls.push(args);
    if (args[0] === 'repo') return { code: 0, stdout: JSON.stringify(REPO_VIEW), stderr: '', timedOut: false };
    const data = { repository: { pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } };
    return { code: 0, stdout: JSON.stringify({ data }), stderr: '', timedOut: false };
  };
  const gh = createGitHub({ cwd, ghFn });
  gh.pagePullRequests('query { x }', () => {}, { branch: 'feat/x' });
  const gql = calls.find((a) => a[0] === 'api');
  const at = gql.indexOf('branch=feat/x');
  assert.ok(at > 0 && gql[at - 1] === '-f');
});

test('pagePullRequests: extra variables cannot override owner, name, first or after', () => {
  const calls = [];
  const ghFn = (args) => {
    calls.push(args);
    if (args[0] === 'repo') return { code: 0, stdout: JSON.stringify(REPO_VIEW), stderr: '', timedOut: false };
    const data = { repository: { pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } };
    return { code: 0, stdout: JSON.stringify({ data }), stderr: '', timedOut: false };
  };
  const gh = createGitHub({ cwd, ghFn });
  gh.pagePullRequests('query { x }', () => {}, { branch: 'feat/x', owner: 'evil', name: 'evil', first: 1, after: 'evil' });
  const gql = calls.find((a) => a[0] === 'api');
  assert.ok(gql.includes('owner=acme') && gql.includes('name=widgets'), gql.join(' '));
  assert.ok(gql.includes('branch=feat/x'));
  assert.deepEqual(gql.filter((a) => /=evil$|^first=1$|^after=/.test(a)), [], gql.join(' '));
});
