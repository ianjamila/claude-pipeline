// `pipeline inbox` against a fake gh and a real tmp repo with a bare "origin" (refs/pull/<n>/head created in the bare repo).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

// A tmp repo with a bare origin; main is pushed. `prBranch` makes a branch + refs/pull/<n>/head in the bare repo.
function world({ yml = pipelineYml('github', ['ci']) } = {}) {
  const bare = realpathSync.native(mkdtempSync(join(tmpdir(), 'cp-inbox-origin-')));
  sh(bare, ['init', '-q', '--bare', '-b', 'main']);
  const repo = createTmpRepo();
  repo.write('.claude/pipeline.yml', yml);
  repo.write('a.txt', 'base\n');
  const base = repo.commit('base');
  repo.git(['remote', 'add', 'origin', bare]);
  repo.git(['push', '-q', 'origin', 'main']);
  return {
    repo, bare, base,
    prBranch(n, files, from = 'main') {
      repo.checkout(from);
      repo.branch(`agent/pr-${n}`);
      for (const [f, c] of Object.entries(files)) repo.write(f, c);
      const sha = repo.commit(`pr ${n}`);
      repo.git(['push', '-q', 'origin', `${sha}:refs/pull/${n}/head`]);
      repo.checkout('main');
      return sha;
    },
    advanceMain(files, msg = 'main moves') {
      repo.checkout('main');
      for (const [f, c] of Object.entries(files)) repo.write(f, c);
      const sha = repo.commit(msg);
      repo.git(['push', '-q', 'origin', 'main']);
      return sha;
    },
  };
}

// ---- gh payload builders ----------------------------------------------------------------------

const passing = [{ __typename: 'CheckRun', name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }];
const node = (n, sha, over = {}) => ({
  number: n, title: `PR ${n}`, url: `https://github.com/acme/widgets/pull/${n}`, isDraft: false, createdAt: ago(5 * DAY),
  baseRefName: 'main', headRefName: `agent/pr-${n}`, headRefOid: sha, isCrossRepository: false, mergeable: 'MERGEABLE',
  labels: { nodes: [] }, autoMergeRequest: null, reviews: { nodes: [] },
  commits: { nodes: [{ commit: { committedDate: ago(DAY), statusCheckRollup: { contexts: { nodes: passing } } } }] },
  ...over,
});
const page = (nodes, next = null) => ({ data: { repository: { pullRequests: { pageInfo: { hasNextPage: next !== null, endCursor: next }, nodes } } } });
const comment = (id, login, body, over = {}) => ({ id, user: { login }, body, created_at: ago(2 * DAY), updated_at: ago(2 * DAY), html_url: `https://x/c/${id}`, ...over });
const COMMENTS = (n) => `^api repos/acme/widgets/issues/${n}/comments --paginate`;
const OPEN_ONLY = (stdoutJson) => ({ match: 'graphql[\\s\\S]*states: OPEN', stdoutJson });
const NO_MERGED = { match: 'graphql[\\s\\S]*states: MERGED', stdoutJson: page([]) };
const BASE_ENTRIES = [
  { match: '^repo view', stdoutJson: REPO_VIEW },
  { match: '^api user', stdout: 'me\n' },
];

function recordComment(id, n, sha, over = {}) {
  const record = { ...emptyRecord({ repo: 'acme/widgets', pr: n, branch: `agent/pr-${n}`, baseRef: 'main' }), step: 'awaiting-owner-merge', outcome: 'awaiting-owner-merge', head: sha, ...over };
  return comment(id, 'me', `${MARKERS.summary}\n\nDone.\n\n${encodeRecord(record)}`);
}
function triageStateComment(id, n, hash, items = []) {
  let state = emptyState({ repo: 'acme/widgets', pr: n, branch: `agent/pr-${n}`, risk: 'low' });
  state = addRound(state, { n: 1, fromHead: 'a', toHead: 'b', contentHashAtToHead: hash, items });
  return comment(id, 'me', `${MARKERS.triage}\n\nround 1\n\n${encodeForComment(state)}`);
}

// ---- run the CLI ------------------------------------------------------------------------------

function inbox(args, { w, fake }) {
  const env = { ...process.env, ...fake.env };
  delete env.PIPELINE_OFF;
  const r = spawnSync(process.execPath, [bin, 'inbox', ...args], { cwd: w.repo.dir, env, encoding: 'utf8' });
  return { code: r.status, json: r.stdout ? JSON.parse(r.stdout) : null, stdout: r.stdout, stderr: r.stderr };
}

// The inbox may only READ: no write verb, no body on stdin, no mutation in any GraphQL document, no `pr` subcommand.
function assertReadOnly(fake) {
  const calls = fake.calls();
  assert.ok(calls.length > 0);
  for (const c of calls) {
    const line = c.argv.join(' ');
    assert.ok(/^(api user|repo view|api graphql|api repos\/acme\/widgets\/issues\/\d+\/comments --paginate)/.test(line), `unexpected gh call: ${line.slice(0, 120)}`);
    assert.ok(!/(^| )(-X|--method|--input)( |$)/.test(line), `write flag in: ${line.slice(0, 120)}`);
    assert.ok(!/POST|PATCH|DELETE|mutation/.test(line), `write verb in: ${line.slice(0, 120)}`);
    assert.equal(c.stdin, '', 'nothing may be piped to gh');
  }
}

// ---- tests ------------------------------------------------------------------------------------

test('pagination: open PRs over two GraphQL pages, comments over two REST pages (> 100); the summary on page 2 is found', () => {
  const w = world();
  const shas = [1, 2, 3].map((n) => w.prBranch(n, { [`f${n}.txt`]: `${n}\n` }));
  const filler = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => comment(from + i, 'someone', `chatter ${from + i}`));
  const pageOne = filler(1, 60);
  const pageTwo = [...filler(61, 119), recordComment(120, 1, shas[0])];
  const fake = createFakeGh([
    ...BASE_ENTRIES,
    { match: 'graphql[\\s\\S]*states: OPEN[\\s\\S]*after=c1', stdoutJson: page([node(3, shas[2])]) },
    OPEN_ONLY(page([node(1, shas[0]), node(2, shas[1])], 'c1')),
    NO_MERGED,
    { match: COMMENTS(1), stdout: `${JSON.stringify(pageOne)}${JSON.stringify(pageTwo)}` },
    { match: COMMENTS(2), stdout: '[]' },
    { match: COMMENTS(3), stdout: '[]' },
  ]);
  const r = inbox([], { w, fake });
  assertExit(r, 0);
  assert.equal(r.json.ok, true);
  assert.deepEqual(r.json.prs.map((p) => p.number), [1, 2, 3]);
  assert.equal(r.json.prs[0].recordStatus, 'ok');
  assert.equal(r.json.prs[0].step, 'awaiting-owner-merge');
  assert.equal(r.json.prs[1].recordStatus, 'absent');
  assert.ok(fake.lines().some((l) => /-f after=c1/.test(l)), 'the second page was requested with the cursor');
  assert.equal(fake.lines().filter((l) => /states: OPEN/.test(l)).length, 2);
  assertReadOnly(fake);
});

test('git facts on real commits: clean, conflicts, alreadyOnBase; the content hash is the gate\'s for that head', () => {
  const w = world();
  const clean = w.prBranch(1, { 'b.txt': 'b\n' });
  const conflict = w.prBranch(2, { 'a.txt': 'branch edit\n' });
  const onBase = w.prBranch(3, { 'c.txt': 'c\n' });
  w.repo.checkout('main');
  w.repo.git(['merge', '-q', '--ff-only', 'agent/pr-3']);
  const mainSha = w.advanceMain({ 'a.txt': 'main edit\n' });
  w.repo.git(['push', '-q', 'origin', 'main']);
  const fake = createFakeGh([
    ...BASE_ENTRIES,
    OPEN_ONLY(page([node(1, clean), node(2, conflict), node(3, onBase)])),
    NO_MERGED,
    { match: '^api repos/.*comments', stdout: '[]' },
  ]);
  const r = inbox([], { w, fake });
  assertExit(r, 0);
  const [p1, p2, p3] = r.json.prs;
  assert.deepEqual([p1.conflicts, p1.alreadyOnBase], [false, false]);
  assert.deepEqual([p2.conflicts, p2.alreadyOnBase], [true, false]);
  assert.deepEqual([p3.conflicts, p3.alreadyOnBase], [false, true]);
  assert.equal(p3.waitingOn, 'nothing-left');
  assert.equal(p3.suggest, 'close');
  assert.equal(p2.waitingOn, 'failing-check');
  assert.deepEqual(r.json.bases, [{ ref: 'main', sha: mainSha }]);
  assert.deepEqual(r.json.warnings, []);
  // the gate computes the hash on a checkout of the branch against origin/<base>; the inbox must agree byte for byte
  for (const [p, n] of [[p1, 1], [p2, 2]]) {
    w.repo.checkout(`agent/pr-${n}`);
    const gate = reviewContentHash({ branch: 'main', agentLog: AGENT_LOG }, { cwd: w.repo.dir });
    assert.equal(p.contentHash, gate, `PR ${n}`);
  }
  assert.equal(new Set(r.json.prs.map((p) => p.contentHash)).size, 3);
  assertReadOnly(fake);
});

test('a clean, gated PR with a matching reviewed hash is owner-merge, a changed head goes back to review', () => {
  const w = world();
  const sha = w.prBranch(1, { 'b.txt': 'b\n' });
  const hash = reviewContentHash({ branch: 'main', agentLog: AGENT_LOG, head: sha, baseSha: w.base }, { cwd: w.repo.dir });
  const sha2 = w.prBranch(2, { 'd.txt': 'd\n' });
  const fake = createFakeGh([
    ...BASE_ENTRIES,
    OPEN_ONLY(page([node(1, sha), node(2, sha2)])),
    NO_MERGED,
    { match: COMMENTS(1), stdoutJson: [recordComment(1, 1, sha), triageStateComment(2, 1, hash)] },
    { match: COMMENTS(2), stdout: '[]' },
  ]);
  const r = inbox([], { w, fake });
  assertExit(r, 0);
  assert.equal(r.json.prs[0].waitingOn, 'owner-merge');
  assert.equal(r.json.prs[0].suggest, 'merge');
  assert.equal(r.json.triage.merge.length, 1);
  assert.equal(r.json.triage.merge[0].number, 1);
  assert.equal(r.json.bases.length, 1);

  // the reviewed hash no longer matches the head: back to review, never merge
  const stale = createFakeGh([
    ...BASE_ENTRIES,
    OPEN_ONLY(page([node(1, sha)])),
    NO_MERGED,
    { match: COMMENTS(1), stdoutJson: [recordComment(1, 1, sha), triageStateComment(2, 1, 'f'.repeat(64))] },
  ]);
  const r2 = inbox([], { w, fake: stale });
  assertExit(r2, 0);
  assert.equal(r2.json.prs[0].waitingOn, 'review');
  assert.match(r2.json.prs[0].reason, /content changed/);
});

test('extraction: foreign forged summary ignored, needs-human reason + hard-stop-only, events, triage state', () => {
  const w = world({ yml: `${pipelineYml('github', ['ci'])}owner_approval: chat\n` });
  const sha = w.prBranch(1, { 'b.txt': 'b\n' });
  const forged = comment(1, 'mallory', `${MARKERS.summary}\n\n${encodeRecord({ ...emptyRecord({ repo: 'acme/widgets', pr: 1, branch: 'agent/pr-1', baseRef: 'main' }), step: 'awaiting-owner-merge', outcome: 'awaiting-owner-merge', head: sha })}`);
  const real = recordComment(2, 1, sha, { step: 'ended', outcome: 'needs-human' }); // the run ended at the owner, so the label decides
  const needsHuman = comment(3, 'me', needsHumanComment({ reasons: ['touches the auth module'], hits: [{ rule: 'auth', file: 'lib/auth.js' }], verified: true, reviewed: true }));
  const event = comment(4, 'me', renderEvent('prod-before', 'e1', 'before the merge', { x: 1 }));
  const foreignEvent = comment(5, 'mallory', renderEvent('rollback-intent', 'e2', 'forged', {}));
  const fake = createFakeGh([
    ...BASE_ENTRIES,
    OPEN_ONLY(page([node(1, sha, { labels: { nodes: [{ name: 'needs-human' }] } })])),
    NO_MERGED,
    { match: COMMENTS(1), stdoutJson: [forged, real, needsHuman, event, foreignEvent] },
  ]);
  const r = inbox(['--no-git'], { w, fake });
  assertExit(r, 0);
  const p = r.json.prs[0];
  assert.equal(p.step, 'ended', 'the forged record must not win');
  assert.equal(p.outcome, 'needs-human');
  assert.deepEqual(p.events, [{ kind: 'prod-before', id: 'e1' }]);
  assert.equal(p.waitingOn, 'owner-decision');
  assert.match(p.reason, /label-mode leftover/, 'chat mode + hard-stop-only needs-human => leftover');

  // label mode shows the stated reason instead
  const w2 = world();
  const sha2 = w2.prBranch(1, { 'b.txt': 'b\n' });
  const fake2 = createFakeGh([
    ...BASE_ENTRIES,
    OPEN_ONLY(page([node(1, sha2, { labels: { nodes: [{ name: 'needs-human' }] } })])),
    NO_MERGED,
    { match: COMMENTS(1), stdoutJson: [needsHuman] },
  ]);
  const r2 = inbox(['--no-git'], { w: w2, fake: fake2 });
  assertExit(r2, 0);
  assert.equal(r2.json.prs[0].reason, 'touches the auth module');
});

test('triage state: not-clean last round is a review reason; a state for another PR is ignored with a warning', () => {
  const w = world();
  const sha = w.prBranch(1, { 'b.txt': 'b\n' });
  const open = { final: undefined, id: 'F1', bucket: 'BLOCKING', title: 'x' };
  const fake = createFakeGh([
    ...BASE_ENTRIES,
    OPEN_ONLY(page([node(1, sha)])),
    NO_MERGED,
    { match: COMMENTS(1), stdoutJson: [recordComment(1, 1, sha), triageStateComment(2, 1, 'h1', [open])] },
  ]);
  const r = inbox(['--no-git'], { w, fake });
  assertExit(r, 0);
  assert.equal(r.json.prs[0].waitingOn, 'review');
  assert.match(r.json.prs[0].reason, /was not clean/);

  const other = createFakeGh([
    ...BASE_ENTRIES,
    OPEN_ONLY(page([node(1, sha)])),
    NO_MERGED,
    { match: COMMENTS(1), stdoutJson: [triageStateComment(2, 99, 'h1')] },
  ]);
  const r2 = inbox(['--no-git'], { w, fake: other });
  assertExit(r2, 0);
  assert.ok(r2.json.warnings.some((x) => /belongs to PR 99/.test(x)));
});

test('--no-git: git facts are null and git is never called (an unreachable origin raises no warning)', () => {
  const w = world();
  const sha = w.prBranch(1, { 'b.txt': 'b\n' });
  w.repo.git(['remote', 'set-url', 'origin', join(tmpdir(), 'cp-inbox-no-such-origin')]);
  const fake = createFakeGh([
    ...BASE_ENTRIES,
    OPEN_ONLY(page([node(1, sha)])),
    NO_MERGED,
    { match: COMMENTS(1), stdout: '[]' },
  ]);
  const r = inbox(['--no-git'], { w, fake });
  assertExit(r, 0);
  const p = r.json.prs[0];
  assert.deepEqual([p.conflicts, p.alreadyOnBase, p.contentHash, p.local], [null, null, null, null]);
  assert.deepEqual(r.json.bases, []);
  assert.deepEqual(r.json.warnings, []);
  assert.deepEqual(r.json.local, { unpushed: null, orphanWorktrees: null });
  assertReadOnly(fake);
});

test('a failing git fetch: warnings + null git facts, the command still answers', () => {
  const w = world();
  const sha = w.prBranch(1, { 'b.txt': 'b\n' });
  w.repo.git(['remote', 'set-url', 'origin', join(tmpdir(), 'cp-inbox-no-such-origin')]);
  const fake = createFakeGh([
    ...BASE_ENTRIES,
    OPEN_ONLY(page([node(1, sha)])),
    NO_MERGED,
    { match: COMMENTS(1), stdout: '[]' },
  ]);
  const r = inbox([], { w, fake });
  assertExit(r, 0);
  const p = r.json.prs[0];
  assert.deepEqual([p.conflicts, p.alreadyOnBase, p.contentHash], [null, null, null]);
  assert.equal(r.json.bases[0].sha, null);
  assert.ok(r.json.warnings.some((x) => /git fetch for base main failed/.test(x)), r.json.warnings.join('|'));
  assert.ok(['review', 'abandoned', 'pipeline'].includes(p.waitingOn));
});

test('stranded after merge: recently merged with a record stuck in prod-watch; outside the window is not asked for', () => {
  const w = world();
  const stuck = comment(1, 'me', `${MARKERS.summary}\n\n${encodeRecord({ ...emptyRecord({ repo: 'acme/widgets', pr: 9, branch: 'agent/pr-9', baseRef: 'main' }), step: 'prod-watch', outcome: null })}`);
  const intent = comment(2, 'me', renderEvent('rollback-intent', 'r1', 'rolling back', {}));
  const merged = (n, daysAgo) => ({ number: n, title: `M${n}`, url: 'u', mergedAt: ago(daysAgo * DAY), updatedAt: ago(daysAgo * DAY), baseRefName: 'main', headRefName: `agent/pr-${n}`, headRefOid: 'a'.repeat(40), isCrossRepository: false });
  const fake = createFakeGh([
    ...BASE_ENTRIES,
    OPEN_ONLY(page([])),
    { match: 'graphql[\\s\\S]*states: MERGED', stdoutJson: page([merged(9, 1), merged(8, 2), merged(7, 30)], 'm1') },
    { match: COMMENTS(9), stdoutJson: [stuck] },
    { match: COMMENTS(8), stdoutJson: [intent] },
    { match: COMMENTS(7), stdout: '[]' },
  ]);
  const r = inbox(['--merged-days', '7'], { w, fake });
  assertExit(r, 0);
  assert.deepEqual(r.json.strandedAfterMerge.map((s) => s.number), [8, 9]);
  assert.match(r.json.strandedAfterMerge[0].reason, /rollback may have been in progress/);
  assert.ok(!fake.lines().some((l) => /comments/.test(l) && /issues\/7\//.test(l)), 'a PR merged outside the window is not read');
  assert.equal(fake.lines().filter((l) => /states: MERGED/.test(l)).length, 1, 'the walk stops at the first page that reaches the window edge');
  assertReadOnly(fake);
});

test('stranded after merge: attempt 1 resolved but attempt 2 interrupted is still stranded; fully resolved is not', () => {
  const w = world();
  const ev = (n, kind, id) => comment(n, 'me', renderEvent(kind, id, kind, {}));
  const merged = (n, daysAgo = 1) => ({ number: n, title: `M${n}`, url: 'u', mergedAt: ago(daysAgo * DAY), updatedAt: ago(daysAgo * DAY), baseRefName: 'main', headRefName: `agent/pr-${n}`, headRefOid: 'a'.repeat(40), isCrossRepository: false });
  const fake = createFakeGh([
    ...BASE_ENTRIES,
    OPEN_ONLY(page([])),
    { match: 'graphql[\\s\\S]*states: MERGED', stdoutJson: page([merged(9), merged(8), merged(7, 30)], 'm1') },
    { match: COMMENTS(9), stdoutJson: [ev(1, 'rollback-intent', 'r-1'), ev(2, 'rollback-result', 'r-1'), ev(3, 'rollback-intent', 'r-2')] },
    { match: COMMENTS(8), stdoutJson: [ev(4, 'rollback-intent', 'r-1'), ev(5, 'rollback-result', 'r-1')] },
  ]);
  const r = inbox(['--merged-days', '7'], { w, fake });
  assertExit(r, 0);
  assert.deepEqual(r.json.strandedAfterMerge.map((s) => s.number), [9]);
});

test('local work: an unpushed commit overrides nextAction and is listed; orphan worktrees are listed, never touched', () => {
  const w = world();
  const sha = w.prBranch(1, { 'b.txt': 'b\n' });
  const dir = join(w.repo.dir, '.worktrees', 'pr-1');
  w.repo.git(['worktree', 'add', '-q', dir, 'agent/pr-1']);
  sh(dir, ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'local only']);
  w.repo.git(['branch', 'agent/orphan', w.base]);
  const orphanDir = join(w.repo.dir, '.worktrees', 'orphan');
  w.repo.git(['worktree', 'add', '-q', orphanDir, 'agent/orphan']);
  const fake = createFakeGh([
    ...BASE_ENTRIES,
    OPEN_ONLY(page([node(1, sha)])),
    NO_MERGED,
    { match: COMMENTS(1), stdout: '[]' },
  ]);
  const r = inbox([], { w, fake });
  assertExit(r, 0);
  const p = r.json.prs[0];
  assert.equal(p.local.state, 'ahead');
  assert.equal(p.local.unpushed, 1);
  assert.match(p.nextAction, /push\/commit the local work/);
  assert.equal(r.json.local.unpushed.length, 1);
  assert.equal(r.json.local.unpushed[0].number, 1);
  assert.deepEqual(r.json.local.orphanWorktrees.map((o) => o.branch), ['agent/orphan']);
  assert.equal(sh(w.repo.dir, ['rev-parse', 'agent/orphan']).trim(), w.base, 'nothing was changed');
});

test('usage and availability: bad numbers and flags exit 2, an unavailable gh exits 3', () => {
  const w = world();
  const fake = createFakeGh([...BASE_ENTRIES]);
  assertExit(inbox(['--stale-days', 'soon'], { w, fake }), 2);
  assertExit(inbox(['--merged-days', '-1'], { w, fake }), 2);
  assertExit(inbox(['--nope'], { w, fake }), 2);
  assertExit(inbox(['extra'], { w, fake }), 2);
  const down = createFakeGh([{ match: '.', stderr: 'gh: not logged in', code: 4 }]);
  assertExit(inbox([], { w, fake: down }), 3);
});

test('a GraphQL error is a failure (exit 3), never an empty inbox', () => {
  const w = world();
  const fake = createFakeGh([
    ...BASE_ENTRIES,
    { match: 'graphql', stdoutJson: { data: null, errors: [{ message: 'rate limited' }] } },
  ]);
  const r = inbox([], { w, fake });
  assertExit(r, 3);
});

test('a failed required check is named; an untracked PR quiet past --stale-days is abandoned even with a red check', () => {
  const w = world();
  const sha1 = w.prBranch(1, { 'b.txt': 'b\n' });
  const sha2 = w.prBranch(2, { 'c.txt': 'c\n' });
  const red = [{ __typename: 'CheckRun', name: 'ci', status: 'COMPLETED', conclusion: 'FAILURE' }];
  const commits = (date) => ({ nodes: [{ commit: { committedDate: date, statusCheckRollup: { contexts: { nodes: red } } } }] });
  const fake = createFakeGh([
    ...BASE_ENTRIES,
    OPEN_ONLY(page([
      node(1, sha1, { commits: commits(ago(DAY)) }),
      node(2, sha2, { createdAt: ago(40 * DAY), commits: commits(ago(30 * DAY)) }),
    ])),
    NO_MERGED,
    { match: '^api repos/.*comments', stdout: '[]' },
  ]);
  const r = inbox(['--no-git'], { w, fake });
  assertExit(r, 0);
  const [active, stale] = r.json.prs;
  assert.equal(active.waitingOn, 'failing-check');
  assert.deepEqual(active.ciFailed, ['ci']);
  assert.equal(active.reason, 'required check failed: ci');
  assert.equal(active.nextAction, 'ship resume 1 (fix the failing check: ci)');
  assert.equal(stale.waitingOn, 'abandoned');
  assert.equal(stale.suggest, 'close');
  assert.match(stale.reason, /; also required check failed: ci$/);
  assert.deepEqual(r.json.triage.close.map((p) => p.number), [2]);
});

// ---- mergeability when git cannot say ---------------------------------------------------------

// One awaiting-owner-merge PR per GitHub `mergeable` value, optionally with git on.
function mergeableRun(mergeable, args, { prFiles = { 'b.txt': 'b\n' }, mainFiles = null } = {}) {
  const w = world();
  const sha = w.prBranch(1, prFiles);
  if (mainFiles) w.advanceMain(mainFiles);
  const fake = createFakeGh([
    ...BASE_ENTRIES,
    OPEN_ONLY(page([node(1, sha, { mergeable })])),
    NO_MERGED,
    { match: COMMENTS(1), stdoutJson: [recordComment(1, 1, sha)] },
  ]);
  const r = inbox(args, { w, fake });
  assertExit(r, 0);
  assertReadOnly(fake);
  return r.json.prs[0];
}

test('--no-git: GitHub CONFLICTING on an awaiting-owner-merge record is failing-check, never merge', () => {
  const p = mergeableRun('CONFLICTING', ['--no-git']);
  assert.equal(p.conflicts, null); // the output keeps git's answer; only the classification uses GitHub's
  assert.equal(p.mergeable, 'CONFLICTING');
  assert.equal(p.waitingOn, 'failing-check');
  assert.equal(p.reason, 'conflicts with main');
  assert.notEqual(p.suggest, 'merge');
  assert.equal(p.suggest, 'resume');
});

test('--no-git: GitHub MERGEABLE on an awaiting-owner-merge record is owner-merge / merge', () => {
  const p = mergeableRun('MERGEABLE', ['--no-git']);
  assert.equal(p.waitingOn, 'owner-merge');
  assert.equal(p.suggest, 'merge');
  assert.equal(p.nextAction, `say "merge" (head ${p.head})`);
});

test('--no-git: GitHub UNKNOWN stays owner-merge but suggests leave, with the unknown-mergeability wording', () => {
  for (const mergeable of ['UNKNOWN', null, 'SOMETHING_NEW']) {
    const p = mergeableRun(mergeable, ['--no-git']);
    assert.equal(p.waitingOn, 'owner-merge', String(mergeable));
    assert.equal(p.suggest, 'leave', String(mergeable));
    assert.match(p.reason, /; mergeability unknown \(no git check and GitHub had not computed it\)$/);
    assert.equal(p.nextAction, `check it merges cleanly, then say "merge" (head ${p.head})`);
  }
});

test('with git: its answer wins over GitHub in both directions', () => {
  // git says clean, GitHub has not computed it (or even says CONFLICTING): merge
  for (const mergeable of ['UNKNOWN', 'CONFLICTING']) {
    const p = mergeableRun(mergeable, []);
    assert.equal(p.conflicts, false);
    assert.equal(p.waitingOn, 'owner-merge', mergeable);
    assert.equal(p.suggest, 'merge', mergeable);
  }
  // git says conflicts, GitHub says MERGEABLE: failing-check
  const p = mergeableRun('MERGEABLE', [], { prFiles: { 'a.txt': 'branch edit\n' }, mainFiles: { 'a.txt': 'main edit\n' } });
  assert.equal(p.conflicts, true);
  assert.equal(p.waitingOn, 'failing-check');
  assert.notEqual(p.suggest, 'merge');
});

test('owner-ui-merge hand-off: owner-github-merge, with the commits main moved since the hand-off counted by GitHub; a failed compare only warns', () => {
  const w = world();
  const sha = w.prBranch(1, { 'b.txt': 'b\n' });
  const handoff = { head: sha, baseTip: w.base, at: ago(DAY) };
  const comments = { match: COMMENTS(1), stdoutJson: [recordComment(1, 1, sha, { step: 'awaiting-owner-merge', outcome: 'owner-ui-merge', handoff })] };
  const fake = createFakeGh([
    ...BASE_ENTRIES,
    OPEN_ONLY(page([node(1, sha)])),
    NO_MERGED,
    comments,
    { match: '^api repos/acme/widgets/compare/', stdoutJson: { status: 'ahead', behind_by: 0, ahead_by: 3, base: w.base } },
  ]);
  const r = inbox(['--no-git'], { w, fake });
  assertExit(r, 0);
  assert.equal(r.json.prs[0].waitingOn, 'owner-github-merge');
  assert.equal(r.json.prs[0].suggest, 'leave');
  assert.match(r.json.prs[0].reason, /main moved 3 commits since the hand-off/);
  assert.equal(r.json.triage.leave.length, 1);
  const compare = fake.calls().find((c) => c.argv.join(' ').startsWith('api repos/acme/widgets/compare/'));
  assert.ok(compare.argv.join(' ').includes(`compare/${w.base}...main`), 'counted from the hand-off base tip to the base branch');

  const failing = createFakeGh([
    ...BASE_ENTRIES,
    OPEN_ONLY(page([node(1, sha)])),
    NO_MERGED,
    comments,
    { match: '^api repos/acme/widgets/compare/', code: 1, stderr: 'boom' },
  ]);
  const r2 = inbox(['--no-git'], { w, fake: failing });
  assertExit(r2, 0);
  assert.equal(r2.json.prs[0].waitingOn, 'owner-github-merge');
  assert.doesNotMatch(r2.json.prs[0].reason, /main moved/);
  assert.ok(r2.json.warnings.some((x) => /since the hand-off/.test(x)));
});
