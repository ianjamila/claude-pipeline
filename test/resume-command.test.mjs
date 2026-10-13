// `pipeline resume list` / `resume plan` against a fake gh and a real tmp repo with a bare "origin"
// (refs/pull/<n>/head is created in the bare repo, as GitHub does).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTmpRepo } from './helpers/tmprepo.mjs';
import { createFakeGh, pipelineYml, REPO_VIEW } from './helpers/fakegh-env.mjs';
import { assertExit } from './helpers/assert-exit.mjs';
import { addRound, emptyState, encodeForComment } from '../pipeline/lib/state.mjs';
import { MARKERS, needsHumanComment } from '../pipeline/lib/render.mjs';
import { emptyRecord, encodeRecord } from '../pipeline/lib/run-record.mjs';
import { renderEvent } from '../pipeline/lib/run-events.mjs';
import { reviewContentHash } from '../pipeline/lib/git.mjs';

const bin = join(dirname(fileURLToPath(import.meta.url)), '..', 'pipeline', 'bin', 'pipeline.mjs');
const DAY = 86400000;
const ago = (ms) => new Date(Date.now() - ms).toISOString();
const AGENT_LOG = 'docs/agent-log.md';

const GIT_ENV = (() => {
  const env = { ...process.env };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_COMMON_DIR']) delete env[k];
  return env;
})();
const sh = (cwd, args) => {
  const r = spawnSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
};

function world() {
  const bare = realpathSync.native(mkdtempSync(join(tmpdir(), 'cp-resume-origin-')));
  sh(bare, ['init', '-q', '--bare', '-b', 'main']);
  const repo = createTmpRepo();
  repo.write('.claude/pipeline.yml', pipelineYml('github', ['ci']));
  repo.write('a.txt', 'base\n');
  const base = repo.commit('base');
  repo.git(['remote', 'add', 'origin', bare]);
  repo.git(['push', '-q', 'origin', 'main']);
  return {
    repo, bare, base,
    // A branch agent/pr-<n> (local ref, checked out nowhere) whose tip is also refs/pull/<n>/head and the branch on the origin.
    prBranch(n, files) {
      repo.checkout('main');
      repo.branch(`agent/pr-${n}`);
      for (const [f, c] of Object.entries(files)) repo.write(f, c);
      const sha = repo.commit(`pr ${n}`);
      repo.git(['push', '-q', 'origin', `${sha}:refs/pull/${n}/head`, `${sha}:refs/heads/agent/pr-${n}`]);
      repo.checkout('main');
      return sha;
    },
  };
}

const ME = 'me';
const BASE_ENTRIES = [{ match: '^repo view', stdoutJson: REPO_VIEW }, { match: '^api user', stdout: `${ME}\n` }];
const comment = (id, login, body, over = {}) => ({ id, user: { login }, body, created_at: ago(2 * DAY), updated_at: ago(2 * DAY), html_url: `https://x/c/${id}`, ...over });
const COMMENTS = (n) => `^api repos/acme/widgets/issues/${n}/comments --paginate`;
const VIEW = (n) => `^pr view ${n} --json`;

const view = (n, sha, over = {}) => ({
  number: n, title: `PR ${n}`, url: `https://github.com/acme/widgets/pull/${n}`, state: 'OPEN', isDraft: false,
  headRefName: `agent/pr-${n}`, headRefOid: sha, baseRefName: 'main', isCrossRepository: false, labels: [], autoMergeRequest: null, mergeCommit: null, ...over,
});

function recordComment(id, n, over = {}) {
  const record = { ...emptyRecord({ repo: 'acme/widgets', pr: n, branch: `agent/pr-${n}`, baseRef: 'main' }), step: 'review', ...over };
  return comment(id, ME, `${MARKERS.summary}\n\nRunning.\n\n${encodeRecord(record)}`);
}
function triageStateComment(id, n, hash, items = []) {
  let state = emptyState({ repo: 'acme/widgets', pr: n, branch: `agent/pr-${n}`, risk: 'low' });
  state = addRound(state, { n: 1, fromHead: 'a', toHead: 'b', contentHashAtToHead: hash, items });
  return comment(id, ME, `${MARKERS.triage}\n\nround 1\n\n${encodeForComment(state)}`);
}

function resume(args, { w, fake, cwd }) {
  const env = { ...process.env, ...fake.env };
  delete env.PIPELINE_OFF;
  const r = spawnSync(process.execPath, [bin, 'resume', ...args], { cwd: cwd ?? w.repo.dir, env, encoding: 'utf8' });
  return { code: r.status, json: r.stdout ? JSON.parse(r.stdout) : null, stdout: r.stdout, stderr: r.stderr };
}

// resume only READS: no write verb, no body on stdin, no mutation, no label/merge subcommand.
function assertReadOnly(fake) {
  const calls = fake.calls();
  assert.ok(calls.length > 0);
  for (const c of calls) {
    const line = c.argv.join(' ');
    assert.ok(/^(api user|repo view|api graphql|pr view \d+ --json|api repos\/acme\/widgets\/issues\/\d+\/comments --paginate)/.test(line), `unexpected gh call: ${line.slice(0, 120)}`);
    assert.ok(!/(^| )(-X|--method|--input)( |$)/.test(line), `write flag in: ${line.slice(0, 120)}`);
    assert.ok(!/POST|PATCH|DELETE|PUT|mutation/.test(line), `write verb in: ${line.slice(0, 120)}`);
    assert.equal(c.stdin, '', 'nothing may be piped to gh');
  }
}

// ---- plan -------------------------------------------------------------------------------------

test('plan: output shape for an open, reviewed PR whose local branch matches (gate)', () => {
  const w = world();
  const sha = w.prBranch(7, { 'b.txt': 'b\n' });
  const hash = reviewContentHash({ branch: 'main', agentLog: AGENT_LOG, head: sha, baseSha: w.base }, { cwd: w.repo.dir });
  const events = comment(4, ME, renderEvent('prod-before', 'e1', 'before the merge', { deployment: { id: 9 } }));
  const fake = createFakeGh([
    ...BASE_ENTRIES,
    { match: VIEW(7), stdoutJson: view(7, sha) },
    { match: COMMENTS(7), stdoutJson: [recordComment(1, 7, { head: sha, round: 1, tasks: [{ id: 't1', title: 'one', spec: 's', done: true }], verify: { head: sha, tree: 't', mode: 'full', ok: true, failedStep: null }, heartbeat: { host: 'elsewhere', at: ago(5 * DAY) } }), triageStateComment(2, 7, hash), events] },
  ]);
  const r = resume(['plan', '--pr', '7'], { w, fake });
  assertExit(r, 0);
  const j = r.json;
  assert.equal(j.ok, true);
  assert.deepEqual([j.pr, j.branch, j.base, j.liveHead, j.prState], [7, 'agent/pr-7', 'main', sha, 'OPEN']);
  assert.equal(j.enter, 'gate');
  assert.equal(j.stop, 'needs-human', 'label mode (the default): resume ends at the owner, never at a merge');
  assert.equal(j.adopt, false);
  assert.equal(j.confirm, null);
  assert.equal(j.autoMerge, null);
  assert.deepEqual(j.worktree, { action: 'add-existing-ref' });
  assert.equal(j.recordStatus, 'ok');
  assert.deepEqual([j.record.step, j.record.outcome, j.record.head, j.record.round], ['review', null, sha, 1]);
  assert.deepEqual(j.record.tasks, [{ id: 't1', title: 'one', spec: 's', done: true }]);
  assert.equal(j.record.heartbeat.host, 'elsewhere');
  assert.equal(j.events.count, 1);
  assert.deepEqual(j.events.latest['prod-before'].data, { deployment: { id: 9 } });
  assert.equal(j.local.state, 'equal');
  assert.equal(j.contentHash, hash);
  assert.deepEqual(j.warnings, []);
  assert.ok(Array.isArray(j.notes));
  assertReadOnly(fake);
});

test('plan: no run record and no review state adopts the PR and goes to review', () => {
  const w = world();
  const sha = w.prBranch(7, { 'b.txt': 'b\n' });
  const fake = createFakeGh([...BASE_ENTRIES, { match: VIEW(7), stdoutJson: view(7, sha) }, { match: COMMENTS(7), stdout: '[]' }]);
  const r = resume(['plan', '--pr', '7'], { w, fake });
  assertExit(r, 0);
  assert.deepEqual([r.json.enter, r.json.adopt, r.json.recordStatus, r.json.record], ['review', true, 'absent', null]);
  assertReadOnly(fake);
});

test('plan: a stale triage hash routes to review; a foreign (forged) record is ignored', () => {
  const w = world();
  const sha = w.prBranch(7, { 'b.txt': 'b\n' });
  const forged = comment(1, 'mallory', `${MARKERS.summary}\n\n${encodeRecord({ ...emptyRecord({ repo: 'acme/widgets', pr: 7, branch: 'agent/pr-7', baseRef: 'main' }), step: 'merge' })}`);
  const fake = createFakeGh([
    ...BASE_ENTRIES, { match: VIEW(7), stdoutJson: view(7, sha) },
    { match: COMMENTS(7), stdoutJson: [forged, triageStateComment(2, 7, 'f'.repeat(64))] },
  ]);
  const r = resume(['plan', '--pr', '7'], { w, fake });
  assertExit(r, 0);
  assert.equal(r.json.recordStatus, 'absent');
  assert.equal(r.json.enter, 'review');
  assert.match(r.json.reason, /content changed/);
  assert.equal(r.json.adopt, true);
});

test('plan: needs-human is a decision with the stated reason; auto-merge armed is reported for disarming', () => {
  const w = world();
  const sha = w.prBranch(7, { 'b.txt': 'b\n' });
  const nh = comment(3, ME, needsHumanComment({ reasons: ['touches the auth module'], hits: [{ rule: 'auth', file: 'lib/auth.js' }], verified: true, reviewed: true }));
  const fake = createFakeGh([
    ...BASE_ENTRIES,
    { match: VIEW(7), stdoutJson: view(7, sha, { labels: [{ name: 'needs-human' }], autoMergeRequest: { enabledAt: ago(DAY) } }) },
    { match: COMMENTS(7), stdoutJson: [nh] },
  ]);
  const r = resume(['plan', '--pr', '7'], { w, fake });
  assertExit(r, 0);
  assert.equal(r.json.enter, 'decision');
  assert.equal(r.json.reason, 'touches the auth module');
  assert.deepEqual(r.json.autoMerge, { armed: true, action: 'disarm' });
  assertReadOnly(fake);
});

test('plan: local commits the PR lacks are pushed first; uncommitted work stops the resume', () => {
  const w = world();
  const sha = w.prBranch(7, { 'b.txt': 'b\n' });
  w.repo.checkout('agent/pr-7');
  w.repo.write('local.txt', 'only here\n');
  w.repo.commit('local only');
  const fake = createFakeGh([...BASE_ENTRIES, { match: VIEW(7), stdoutJson: view(7, sha) }, { match: COMMENTS(7), stdout: '[]' }]);
  const ahead = resume(['plan', '--pr', '7'], { w, fake });
  assertExit(ahead, 0);
  assert.equal(ahead.json.local.state, 'ahead');
  assert.equal(ahead.json.local.unpushed, 1);
  assert.deepEqual(ahead.json.worktree, { action: 'reuse', path: w.repo.dir, then: 'push' });

  w.repo.write('wip.txt', 'half done\n');
  const dirty = resume(['plan', '--pr', '7'], { w, fake });
  assertExit(dirty, 0);
  assert.equal(dirty.json.enter, 'local-work');
  assert.equal(dirty.json.local.dirty, 1);
  assert.deepEqual(dirty.json.worktree, { action: 'none' });
});

test('plan: a branch that exists only on origin is added from the remote; a behind local ref fast-forwards', () => {
  const w = world();
  const sha = w.prBranch(7, { 'b.txt': 'b\n' });
  w.repo.git(['branch', '-D', 'agent/pr-7']);
  const fake = createFakeGh([...BASE_ENTRIES, { match: VIEW(7), stdoutJson: view(7, sha) }, { match: COMMENTS(7), stdout: '[]' }]);
  const gone = resume(['plan', '--pr', '7'], { w, fake });
  assertExit(gone, 0);
  assert.equal(gone.json.local.state, 'none');
  assert.deepEqual(gone.json.worktree, { action: 'add-from-remote' });

  // the PR gained a commit on GitHub; the local ref is one behind
  w.repo.git(['branch', 'agent/pr-7', sha]);
  w.repo.checkout('agent/pr-7');
  w.repo.write('c.txt', 'c\n');
  const newer = w.repo.commit('pushed from the other machine');
  w.repo.git(['push', '-q', 'origin', `${newer}:refs/pull/7/head`]);
  w.repo.checkout('main');
  const fake2 = createFakeGh([...BASE_ENTRIES, { match: VIEW(7), stdoutJson: view(7, newer) }, { match: COMMENTS(7), stdout: '[]' }]);
  w.repo.git(['branch', '-f', 'agent/pr-7', sha]);
  const behind = resume(['plan', '--pr', '7'], { w, fake: fake2 });
  assertExit(behind, 0);
  assert.equal(behind.json.local.state, 'behind');
  assert.deepEqual(behind.json.worktree, { action: 'add-existing-ref', then: 'ff-only' });
});

test('plan: the plan refreshes origin/<branch> too, so the skill\'s fast-forward lands on the live head, not a stale tracking ref', () => {
  const w = world();
  const old = w.prBranch(7, { 'b.txt': 'b\n' });
  // the other machine pushed `newer`; this clone last fetched the branch when it was at `old`
  w.repo.git(['fetch', '-q', 'origin', '+refs/heads/agent/pr-7:refs/remotes/origin/agent/pr-7']);
  w.repo.checkout('agent/pr-7');
  w.repo.write('c.txt', 'c\n');
  const newer = w.repo.commit('pushed from the other machine');
  w.repo.git(['push', '-q', 'origin', `${newer}:refs/heads/agent/pr-7`, `${newer}:refs/pull/7/head`]);
  w.repo.git(['reset', '-q', '--hard', old]);
  w.repo.git(['update-ref', 'refs/remotes/origin/agent/pr-7', old]); // the push above advanced it; make it stale again
  w.repo.checkout('main');
  assert.equal(w.repo.git(['rev-parse', 'refs/remotes/origin/agent/pr-7']).trim(), old, 'precondition: the tracking ref is stale');
  const fake = createFakeGh([...BASE_ENTRIES, { match: VIEW(7), stdoutJson: view(7, newer) }, { match: COMMENTS(7), stdout: '[]' }]);
  const r = resume(['plan', '--pr', '7'], { w, fake });
  assertExit(r, 0);
  assert.equal(r.json.local.state, 'behind');
  assert.equal(r.json.liveHead, newer);
  assert.equal(w.repo.git(['rev-parse', 'refs/remotes/origin/agent/pr-7']).trim(), newer, 'origin/<branch> now equals the live head');
});

test('plan: another machine\'s fresh heartbeat asks for confirmation', () => {
  const w = world();
  const sha = w.prBranch(7, { 'b.txt': 'b\n' });
  const fake = createFakeGh([
    ...BASE_ENTRIES, { match: VIEW(7), stdoutJson: view(7, sha) },
    { match: COMMENTS(7), stdoutJson: [recordComment(1, 7, { step: 'build', heartbeat: { host: `not-${hostname()}`, at: ago(10 * 60000) } })] },
  ]);
  const r = resume(['plan', '--pr', '7'], { w, fake });
  assertExit(r, 0);
  assert.equal(r.json.confirm.host, `not-${hostname()}`);
  assert.equal(r.json.confirm.step, 'build');
  assert.ok(r.json.confirm.minutesAgo >= 9 && r.json.confirm.minutesAgo <= 11);
  const own = createFakeGh([
    ...BASE_ENTRIES, { match: VIEW(7), stdoutJson: view(7, sha) },
    { match: COMMENTS(7), stdoutJson: [recordComment(1, 7, { step: 'build', heartbeat: { host: hostname(), at: ago(10 * 60000) } })] },
  ]);
  assert.equal(resume(['plan', '--pr', '7'], { w, fake: own }).json.confirm, null);
});

test('plan: merged, ended record, attempt 1 resolved but attempt 2 interrupted -> observe-prod (results are matched per attempt)', () => {
  const w = world();
  const sha = w.prBranch(7, { 'b.txt': 'b\n' });
  const fake = createFakeGh([
    ...BASE_ENTRIES,
    { match: VIEW(7), stdoutJson: view(7, sha, { state: 'MERGED', mergeCommit: { oid: 'c'.repeat(40) } }) },
    { match: COMMENTS(7), stdoutJson: [
      recordComment(1, 7, { step: 'ended', outcome: 'merged' }),
      comment(2, ME, renderEvent('rollback-intent', 'ccccccc-1', 'rolling back', {})),
      comment(3, ME, renderEvent('rollback-result', 'ccccccc-1', 'done', {})),
      comment(4, ME, renderEvent('rollback-intent', 'ccccccc-2', 'rolling back again', {})),
    ] },
  ]);
  const r = resume(['plan', '--pr', '7'], { w, fake });
  assertExit(r, 0);
  assert.equal(r.json.enter, 'observe-prod');
  assert.deepEqual(r.json.events.unresolvedRollbacks, ['ccccccc-2']);
});

test('plan: merged mid prod-watch observes production and carries the merge commit; closed is closed', () => {
  const w = world();
  const sha = w.prBranch(7, { 'b.txt': 'b\n' });
  const fake = createFakeGh([
    ...BASE_ENTRIES,
    { match: VIEW(7), stdoutJson: view(7, sha, { state: 'MERGED', mergeCommit: { oid: 'c'.repeat(40) } }) },
    { match: COMMENTS(7), stdoutJson: [recordComment(1, 7, { step: 'prod-watch' }), comment(2, ME, renderEvent('rollback-intent', 'r1', 'rolling back', { target: 'd1' }))] },
  ]);
  const r = resume(['plan', '--pr', '7'], { w, fake });
  assertExit(r, 0);
  assert.equal(r.json.enter, 'observe-prod');
  assert.equal(r.json.mergeSha, 'c'.repeat(40));
  assert.equal(r.json.events.rollbackIntent, true);
  assert.equal(r.json.events.rollbackResult, false);
  assert.deepEqual(r.json.events.unresolvedRollbacks, ['r1']);
  assert.deepEqual(r.json.worktree, { action: 'none' });
  assert.equal(r.json.local, null, 'a merged PR\'s branch is not compared');
  assertReadOnly(fake);

  const closed = createFakeGh([...BASE_ENTRIES, { match: VIEW(7), stdoutJson: view(7, sha, { state: 'CLOSED' }) }, { match: COMMENTS(7), stdout: '[]' }]);
  assert.equal(resume(['plan', '--pr', '7'], { w, fake: closed }).json.enter, 'closed');
});

test('plan: a fork PR is not resumable', () => {
  const w = world();
  const sha = w.prBranch(7, { 'b.txt': 'b\n' });
  const fake = createFakeGh([...BASE_ENTRIES, { match: VIEW(7), stdoutJson: view(7, sha, { isCrossRepository: true }) }, { match: COMMENTS(7), stdout: '[]' }]);
  const r = resume(['plan', '--pr', '7'], { w, fake });
  assertExit(r, 0);
  assert.equal(r.json.enter, 'not-resumable');
  assert.equal(r.json.local, null);
});

test('plan: unknown PR is exit 2, gh failing is exit 3, bad usage is exit 2', () => {
  const w = world();
  const missing = createFakeGh([...BASE_ENTRIES, { match: VIEW(99), code: 1, stderr: 'GraphQL: Could not resolve to a PullRequest with the number of 99. (repository.pullRequest)' }]);
  const nf = resume(['plan', '--pr', '99'], { w, fake: missing });
  assertExit(nf, 2);
  assert.equal(nf.json.error, 'not-found');

  const down = createFakeGh([...BASE_ENTRIES, { match: VIEW(7), code: 1, stderr: 'error connecting to api.github.com' }]);
  assertExit(resume(['plan', '--pr', '7'], { w, fake: down }), 3);

  assertExit(resume(['plan'], { w, fake: down }), 2);
  assertExit(resume(['plan', '--pr', 'abc'], { w, fake: down }), 2);
  assertExit(resume([], { w, fake: down }), 2);
  assertExit(resume(['nope'], { w, fake: down }), 2);
  assertExit(resume(['plan', '--pr', '7', '--bogus'], { w, fake: down }), 2);
});

// ---- list -------------------------------------------------------------------------------------

const page = (nodes) => ({ data: { repository: { pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } } });
const node = (n, over = {}) => ({
  number: n, title: `PR ${n}`, url: `https://github.com/acme/widgets/pull/${n}`, isDraft: false, createdAt: ago(5 * DAY),
  baseRefName: 'main', headRefName: `agent/pr-${n}`, headRefOid: `${n}`.repeat(40).slice(0, 40), isCrossRepository: false, mergeable: 'MERGEABLE',
  labels: { nodes: [] }, autoMergeRequest: null, reviews: { nodes: [] }, commits: { nodes: [] }, ...over,
});

test('list: awaiting-review PRs plus open PRs whose own run record is mid-run; nothing else', () => {
  const w = world();
  const fake = createFakeGh([
    ...BASE_ENTRIES,
    { match: 'graphql[\\s\\S]*states: OPEN', stdoutJson: page([
      node(1, { labels: { nodes: [{ name: 'awaiting-review' }] } }),
      node(2), // mid-run
      node(3), // run ended
      node(4), // no comments
      node(5), // forged record by someone else
      node(6, { isCrossRepository: true }), // fork, mid-run record: not listed
      node(7), // record belongs to another PR
    ]) },
    { match: COMMENTS(1), stdout: '[]' },
    { match: COMMENTS(2), stdoutJson: [recordComment(1, 2, { step: 'verify' })] },
    { match: COMMENTS(3), stdoutJson: [recordComment(1, 3, { step: 'ended', outcome: 'awaiting-owner-merge' })] },
    { match: COMMENTS(4), stdout: '[]' },
    { match: COMMENTS(5), stdoutJson: [{ ...recordComment(1, 5), user: { login: 'mallory' } }] },
    { match: COMMENTS(6), stdoutJson: [recordComment(1, 6)] },
    { match: COMMENTS(7), stdoutJson: [recordComment(1, 99)] },
  ]);
  const r = resume(['list'], { w, fake });
  assertExit(r, 0);
  assert.equal(r.json.ok, true);
  assert.deepEqual(r.json.prs.map((p) => p.number), [1, 2]);
  assert.deepEqual(Object.keys(r.json.prs[0]).sort(), ['headRefName', 'number', 'title', 'url', 'why']);
  assert.match(r.json.prs[0].why, /awaiting-review/);
  assert.match(r.json.prs[1].why, /mid-way at step verify/);
  assertReadOnly(fake);
});

test('list: a failing gh is exit 3', () => {
  const w = world();
  const fake = createFakeGh([...BASE_ENTRIES, { match: 'graphql', code: 1, stderr: 'boom' }]);
  assertExit(resume(['list'], { w, fake }), 3);
});

test('plan: owner_approval chat names awaiting-owner-merge as the stop; the record shows resumed', () => {
  const w = world();
  const sha = w.prBranch(7, { 'b.txt': 'b\n' });
  w.repo.write('.claude/pipeline.yml', `${pipelineYml('github', ['ci'])}owner_approval: chat\n`);
  const hash = reviewContentHash({ branch: 'main', agentLog: AGENT_LOG, head: sha, baseSha: w.base }, { cwd: w.repo.dir });
  const resumed = { at: '2026-10-12T08:00:00.000Z', host: 'pc-2', head: sha };
  const fake = createFakeGh([
    ...BASE_ENTRIES,
    { match: VIEW(7), stdoutJson: view(7, sha) },
    { match: COMMENTS(7), stdoutJson: [recordComment(1, 7, { head: sha, round: 1, resumed, verify: { head: sha, tree: 't', mode: 'full', ok: true, failedStep: null } }), triageStateComment(2, 7, hash)] },
  ]);
  const r = resume(['plan', '--pr', '7'], { w, fake });
  assertExit(r, 0);
  assert.equal(r.json.enter, 'gate');
  assert.equal(r.json.stop, 'awaiting-owner-merge');
  assert.deepEqual(r.json.record.resumed, resumed);
});
