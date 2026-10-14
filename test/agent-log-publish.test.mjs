// `pipeline agent-log publish` (and the deprecated `stage`): the log lives on the orphan branch pipeline-agent-log, built with
// plumbing in a temp index and pushed to that one ref. Real git against a real bare origin, so "the caller's checkout is
// never touched", the push target and the race retry are proven against actual git, not a mock.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTmpRepo } from './helpers/tmprepo.mjs';
import { createFakeGh, pipelineYml, REPO_VIEW } from './helpers/fakegh-env.mjs';
import { cli, AGENT_LOG } from './helpers/gate-env.mjs';
import { assertExit } from './helpers/assert-exit.mjs';
import { git as gitRun, GitError } from '../pipeline/lib/git.mjs';
import { run as procRun } from '../pipeline/lib/proc.mjs';
import { AGENT_LOG_BRANCH, AGENT_LOG_HEADER, assertSafeLogTarget, logRelPath, publishLines } from '../pipeline/lib/agentlog.mjs';

const BRANCH = AGENT_LOG_BRANCH;
const scratch = [];
const tmp = (prefix) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(d);
  return d;
};
after(() => scratch.forEach((d) => rmSync(d, { recursive: true, force: true, maxRetries: 3 })));

const raw = (args, cwd) => {
  const r = procRun('git', args, { cwd, env: { GIT_DIR: undefined, GIT_INDEX_FILE: undefined } });
  if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
};

// A repo on a feature branch with a real bare origin whose main already has a small log (the legacy place lines used to ride in).
function world({ mainLog = `${AGENT_LOG_HEADER}\n- 2026-09-01 · #1 · old · risk low · rounds 1 · arbiter 0 · merged\n`, origin = true } = {}) {
  const repo = createTmpRepo();
  repo.write('.claude/pipeline.yml', pipelineYml());
  repo.write('.gitignore', '.review/\n');
  repo.write('README.md', '# demo\n');
  if (mainLog !== null) repo.write(AGENT_LOG, mainLog);
  repo.commit('init');
  const bare = tmp('cp-log-origin-');
  raw(['init', '--bare', '-q', '-b', 'main', bare], repo.dir);
  if (origin) {
    repo.git(['remote', 'add', 'origin', bare]);
    repo.git(['push', '-q', '-u', 'origin', 'main']);
  }
  repo.branch('agent/feature');
  const fake = createFakeGh([]);
  const queueFile = join(repo.dir, '.git', 'claude-pipeline', 'agent-log-queue.jsonl');
  const queued = () => (existsSync(queueFile) ? readFileSync(queueFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).line) : []);
  const onOrigin = (...args) => raw(['--git-dir', bare, ...args], repo.dir);
  const logOnBranch = () => onOrigin('show', `${BRANCH}:${AGENT_LOG}`);
  const run = (args, opts = {}) => cli(['agent-log', ...args], { dir: repo.dir, fake, ...opts });
  // Everything about the caller's checkout that a publish must not change.
  const snapshot = () => ({
    head: repo.git(['rev-parse', 'HEAD']),
    branch: repo.git(['symbolic-ref', 'HEAD']),
    index: repo.git(['ls-files', '-s']),
    status: repo.git(['status', '--porcelain']),
    refs: repo.git(['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads']),
    worktrees: repo.git(['worktree', 'list', '--porcelain']),
    log: existsSync(join(repo.dir, AGENT_LOG)) ? readFileSync(join(repo.dir, AGENT_LOG), 'utf8') : null,
  });
  return { repo, bare, fake, queueFile, queued, onOrigin, logOnBranch, run, snapshot };
}

const L1 = '- 2026-10-01 · #10 · first · risk low · rounds 1 · arbiter 0 · merged — prod smoke pending';
const L2 = '- 2026-10-02 · #11 · second · risk low · rounds 1 · arbiter 0 · merged — prod smoke pending';

test('publish creates the orphan branch seeded from main\'s log, pushes only that ref, and leaves the caller\'s checkout untouched', () => {
  const w = world();
  w.run(['queue', '--line', L1]);
  w.repo.write('README.md', '# demo edited, uncommitted\n'); // a dirty tree does not matter: publish never reads it
  w.repo.git(['add', 'README.md']); // ...nor a staged change
  const before = w.snapshot();
  const mainBefore = w.onOrigin('rev-parse', 'main');

  const r = w.run(['publish', '--line', L2]);
  assertExit(r, 0);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.branch, BRANCH);
  assert.equal(r.json.pushed, true);
  assert.deepEqual(r.json.lines, [L1, L2]);
  assert.equal(r.json.remaining, 0);
  assert.equal(r.json.commit, w.onOrigin('rev-parse', BRANCH).trim());

  // the seed keeps main's history of the file, then the new lines, oldest first
  const log = w.logOnBranch();
  assert.ok(log.startsWith(AGENT_LOG_HEADER) && log.includes('· #1 · old ·'));
  assert.ok(log.indexOf('#1 · old') < log.indexOf(L1) && log.indexOf(L1) < log.indexOf(L2));
  // an orphan: one root commit, a tree of just the log file, no shared history with main
  assert.deepEqual(w.onOrigin('ls-tree', '-r', '--name-only', BRANCH).split('\n').filter(Boolean), [AGENT_LOG]);
  assert.equal(w.onOrigin('rev-list', '--max-parents=0', BRANCH).trim().split('\n').length, 1);
  assert.equal(w.onOrigin('rev-list', '--count', BRANCH).trim(), '1');
  assert.throws(() => w.onOrigin('merge-base', BRANCH, 'main'));
  assert.equal(w.onOrigin('rev-parse', 'main'), mainBefore, 'main on origin is untouched');
  assert.deepEqual(w.onOrigin('for-each-ref', '--format=%(refname)', 'refs/heads').trim().split('\n').sort(), [`refs/heads/main`, `refs/heads/${BRANCH}`].sort());
  assert.equal(w.onOrigin('log', '-1', '--format=%s', BRANCH).trim(), 'docs: agent log (2 lines)');
  // the caller's checkout: HEAD, branch, index (the staged change survives), status, local branches, worktrees, log file
  assert.deepEqual(w.snapshot(), before);
  assert.equal(w.repo.git(['for-each-ref', 'refs/heads/']).includes(BRANCH), false, 'no local branch was created');
  assert.deepEqual(w.queued(), [], 'published entries leave the queue');
});

test('a second publish appends on top of the branch without duplicating, and republishing the same lines pushes nothing', () => {
  const w = world();
  assertExit(w.run(['publish', '--line', L1]), 0);
  const tip1 = w.onOrigin('rev-parse', BRANCH).trim();
  const r = w.run(['publish', '--line', L2]);
  assertExit(r, 0);
  assert.deepEqual(r.json.lines, [L2]);
  const log = w.logOnBranch();
  assert.equal(log.split('\n').filter((l) => l === L1).length, 1);
  assert.equal(log.split('\n').filter((l) => l === L2).length, 1);
  assert.ok(log.indexOf(L1) < log.indexOf(L2));
  assert.equal(w.onOrigin('rev-parse', `${BRANCH}^`).trim(), tip1, 'a fast-forward on top of the old tip');

  // the same line again: already on the branch, nothing queued, nothing pushed
  const tip2 = w.onOrigin('rev-parse', BRANCH).trim();
  const again = w.run(['publish', '--line', L2]);
  assertExit(again, 0);
  assert.equal(again.json.pushed, false);
  assert.deepEqual(again.json.lines, []);
  assert.equal(again.json.remaining, 0);
  assert.equal(w.onOrigin('rev-parse', BRANCH).trim(), tip2);
  assert.deepEqual(w.queued(), []);
});

test('publish with nothing queued and nothing given pushes nothing and creates no branch', () => {
  const w = world();
  const r = w.run(['publish']);
  assertExit(r, 0);
  assert.equal(r.json.pushed, false);
  assert.equal(r.json.commit, null);
  assert.equal(w.onOrigin('for-each-ref', '--format=%(refname)', `refs/heads/${BRANCH}`).trim(), '');
});

test('with no log on main yet the branch starts from the header; a line main\'s legacy copy already has is dropped, not republished', () => {
  const w = world({ mainLog: null });
  const r = w.run(['publish', '--line', L1]);
  assertExit(r, 0);
  assert.equal(w.logOnBranch(), `${AGENT_LOG_HEADER}${L1}\n`);

  // a PR opened before this change lands L2 in main's file: publish drops it from the queue instead of copying it over
  const legacy = world();
  legacy.repo.git(['checkout', '-q', 'main']);
  legacy.repo.write(AGENT_LOG, `${AGENT_LOG_HEADER}\n${L2}\n`);
  legacy.repo.commit('legacy copy');
  legacy.repo.git(['push', '-q', 'origin', 'main']);
  legacy.repo.git(['checkout', '-q', 'agent/feature']);
  const dropped = legacy.run(['publish', '--line', L2]);
  assertExit(dropped, 0);
  assert.equal(dropped.json.dropped, 1);
  assert.equal(dropped.json.pushed, false);
  assert.deepEqual(legacy.queued(), []);
});

test('a lost push race (the branch moved) is retried on top of the new tip, keeping their line; a spy proves the only pushed ref', () => {
  const w = world();
  assertExit(w.run(['publish', '--line', L1]), 0);
  const other = tmp('cp-log-other-');
  raw(['clone', '-q', w.bare, other], w.repo.dir);
  raw(['config', 'user.name', 'Other'], other);
  raw(['config', 'user.email', 'other@example.invalid'], other);
  const THEIRS = '- 2026-10-03 · #12 · theirs · risk low · rounds 1 · arbiter 0 · merged — prod smoke pending';
  let raced = false;
  const seen = [];
  const gitFn = (args, o) => {
    seen.push(args);
    if (args[0] === 'push' && !raced) {
      raced = true;
      raw(['fetch', '-q', 'origin', `${BRANCH}:refs/remotes/origin/${BRANCH}`], other);
      raw(['checkout', '-q', '-B', 'scratch', `origin/${BRANCH}`], other);
      writeFileSync(join(other, AGENT_LOG), `${raw(['show', `HEAD:${AGENT_LOG}`], other)}${THEIRS}\n`);
      raw(['commit', '-q', '-am', 'theirs'], other);
      raw(['push', '-q', 'origin', `HEAD:refs/heads/${BRANCH}`], other);
    }
    return gitRun(args, o);
  };
  const r = publishLines({ root: w.repo.dir, logRel: AGENT_LOG, lines: [L2], defaultBranch: 'main', gitFn });
  assert.equal(raced, true);
  assert.equal(r.pushed, true);
  const log = w.logOnBranch();
  assert.ok(log.includes(THEIRS) && log.includes(L2) && log.includes(L1), 'their line was kept');
  const pushes = seen.filter((a) => a[0] === 'push');
  assert.equal(pushes.length, 2, 'one rejected push, one retried');
  for (const p of pushes) {
    assert.equal(p.includes('--force') || p.includes('-f') || p.some((a) => a.startsWith('--force')), false, 'never forced');
    assert.match(p.at(-1), new RegExp(`^[0-9a-f]{40}:refs/heads/${BRANCH}$`));
  }
});

test('a race lost three times in a row is an error (the caller keeps its lines)', () => {
  const w = world();
  assertExit(w.run(['publish', '--line', L1]), 0);
  let pushes = 0;
  const gitFn = (args, o) => {
    if (args[0] === 'push') {
      pushes += 1;
      throw new GitError({ args, code: 1, stderr: ' ! [rejected]        x -> pipeline-agent-log (fetch first)\nerror: failed to push some refs' });
    }
    return gitRun(args, o);
  };
  assert.throws(() => publishLines({ root: w.repo.dir, logRel: AGENT_LOG, lines: [L2], defaultBranch: 'main', gitFn }), GitError);
  assert.equal(pushes, 3);
});

test('the log branch deleted on the remote: a stale cached copy does not make publish drop a line; the branch is recreated with it', () => {
  const w = world();
  assertExit(w.run(['publish', '--line', L1]), 0);
  assertExit(w.run(['publish', '--line', L2]), 0); // fetches the branch, so the remote-tracking copy is cached with L1 and L2
  const cached = `refs/remotes/origin/${BRANCH}`;
  assert.ok(w.repo.git(['rev-parse', '--verify', '-q', cached]).trim(), 'the remote-tracking copy exists');
  w.onOrigin('update-ref', '-d', `refs/heads/${BRANCH}`);

  const r = w.run(['publish', '--line', L1]); // L1 was in the old log, which is gone
  assertExit(r, 0, r.stderr + r.stdout);
  assert.equal(r.json.pushed, true, JSON.stringify(r.json));
  assert.deepEqual(r.json.lines, [L1]);
  assert.ok(w.logOnBranch().split('\n').includes(L1), 'the recreated branch carries the line');
  assert.deepEqual(w.queued(), []);
});

test('the remote cannot be asked whether the log branch exists: a line only the cached copy has stays queued, never dropped', () => {
  const w = world();
  assertExit(w.run(['publish', '--line', L1]), 0);
  assertExit(w.run(['publish', '--line', L2]), 0);
  w.repo.git(['remote', 'set-url', 'origin', join(w.bare, 'does-not-exist')]);
  const r = w.run(['publish', '--line', L1]);
  assertExit(r, 3, r.stderr + r.stdout);
  assert.deepEqual(w.queued(), [L1], 'the cached copy is not proof that the line is published');
});

test('a failed push (origin unreachable) exits 3 and every line stays queued, including --line', () => {
  const w = world();
  w.run(['queue', '--line', L1]);
  w.repo.git(['remote', 'set-url', 'origin', join(w.bare, 'does-not-exist')]);
  const before = w.snapshot();
  const r = w.run(['publish', '--line', L2]);
  assertExit(r, 3);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.error, 'publish-failed');
  assert.deepEqual(w.queued(), [L1, L2]);
  assert.deepEqual(w.snapshot(), before);

  // and a push that git itself rejects (a pre-receive hook on the remote) behaves the same
  const w2 = world();
  mkdirSync(join(w2.bare, 'hooks'), { recursive: true });
  writeFileSync(join(w2.bare, 'hooks', 'pre-receive'), '#!/bin/sh\necho no >&2\nexit 1\n', { mode: 0o755 });
  const r2 = w2.run(['publish', '--line', L1]);
  assertExit(r2, 3);
  assert.deepEqual(w2.queued(), [L1]);
  // once the remote recovers the next publish carries everything
  rmSync(join(w2.bare, 'hooks', 'pre-receive'));
  const ok = w2.run(['publish']);
  assertExit(ok, 0);
  assert.deepEqual(ok.json.lines, [L1]);
  assert.deepEqual(w2.queued(), []);
});

test('stage is a deprecated alias: it never commits into the worktree, publishes the queue, and an older skill\'s --pr still parses', () => {
  const w = world();
  w.run(['queue', '--line', L1]);
  const before = w.snapshot();
  // PR 12 is open (GitHub says so), so its line is held back until it merges; the rest of the queue is published.
  w.fake.setScript([{ match: '^pr view 12 --json state', stdoutJson: { state: 'OPEN' } }]);
  const r = w.run(['stage', '--pr', '12', '--line', L2]);
  assertExit(r, 0);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.deprecated, true);
  assert.equal(r.json.committed, null);
  assert.equal(r.json.pushed, true);
  assert.deepEqual(r.json.lines, [L1]);
  assert.deepEqual(w.snapshot(), before, 'no commit, no file written in the worktree');
  assert.ok(w.logOnBranch().includes(L1));
  assert.ok(!w.logOnBranch().includes(L2), 'the line of an unmerged PR is not published');
  assert.deepEqual(w.queued(), [L2]);
  assertExit(w.run(['stage', '--pr', 'x']), 2);
  assertExit(w.run(['stage', '--bogus']), 2);
});

// The older ship skill calls `stage --pr N` (no --line) before merging and never queues a line for a clean merge: the line it
// would have built has to reach the log once PR N merges, and not before.
const queueEntries = (w) => (existsSync(w.queueFile) ? readFileSync(w.queueFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const PR12_TITLE = [{ match: '^pr view 12 --json title', stdoutJson: { title: 'Add widget' } }, { match: '^pr view 12 --json state', stdoutJson: { state: 'OPEN' } }];
const stageDefault = (w) => {
  w.fake.setScript(PR12_TITLE);
  return w.run(['stage', '--pr', '12']);
};

test('stage --pr N without --line builds the PR\'s default line and queues it for after the merge, publishing nothing for it', () => {
  const w = world();
  const r = stageDefault(w);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.equal(r.json.pushed, false);
  assert.deepEqual(r.json.lines, []);
  const entries = queueEntries(w);
  assert.equal(entries.length, 1);
  assert.match(entries[0].line, /#12 · Add widget · .*merged — prod smoke pending/);
  assert.equal(entries[0].afterMerge, 12);
  assert.equal(w.onOrigin('branch', '--list', BRANCH).trim(), '', 'no branch was created for an unmerged PR');
  assert.equal(r.json.remaining, 1);
  // stage twice (a retried step) does not duplicate it
  stageDefault(w);
  assert.equal(queueEntries(w).length, 1);
});

test('stage --pr N without --line exits 3 when GitHub cannot be reached, as the old command did', () => {
  const w = world();
  w.fake.setScript([{ match: '.', code: 1, stderr: 'HTTP 401' }]);
  const r = w.run(['stage', '--pr', '12']);
  assertExit(r, 3, r.stderr + r.stdout);
  assert.deepEqual(queueEntries(w), []);
});

test('publish: a line held for PR N is published once N is MERGED, dropped when N was CLOSED, and kept while it is open or unreadable', () => {
  const w = world();
  stageDefault(w);
  const line = queueEntries(w)[0].line;
  const state = (v) => w.fake.setScript([{ match: '^pr view 12 --json state', stdoutJson: { state: v } }]);

  state('OPEN');
  assertExit(w.run(['publish']), 0);
  assert.deepEqual(queueEntries(w).map((e) => e.line), [line], 'open: kept');
  w.fake.setScript([{ match: '.', code: 1, stderr: 'HTTP 502' }]);
  const unreadable = w.run(['publish']);
  assertExit(unreadable, 0);
  assert.deepEqual(queueEntries(w).map((e) => e.line), [line], 'GitHub unreadable: kept');
  assert.equal(unreadable.json.pushed, false);

  state('MERGED');
  const merged = w.run(['publish']);
  assertExit(merged, 0, merged.stderr + merged.stdout);
  assert.deepEqual(merged.json.lines, [line]);
  assert.ok(w.logOnBranch().includes(line));
  assert.deepEqual(queueEntries(w), []);

  const w2 = world();
  stageDefault(w2);
  w2.fake.setScript([{ match: '^pr view 12 --json state', stdoutJson: { state: 'CLOSED' } }]);
  const closed = w2.run(['publish']);
  assertExit(closed, 0, closed.stderr + closed.stdout);
  assert.deepEqual(queueEntries(w2), [], 'closed without merging: dropped');
  assert.equal(closed.json.pushed, false);
  assert.equal(w2.onOrigin('branch', '--list', BRANCH).trim(), '');
});

test('queue entries round-trip afterMerge, and an invalid value is ignored (a plain entry)', () => {
  const w = world();
  mkdirSync(join(w.repo.dir, '.git', 'claude-pipeline'), { recursive: true });
  writeFileSync(w.queueFile, [
    { line: L1, at: 'a', afterMerge: 5 }, { line: L2, at: 'b', afterMerge: 'x' }, { line: '- three', at: 'c', afterMerge: -1 }, { line: '- four', at: 'd', afterMerge: 1.5 },
  ].map((e) => JSON.stringify(e)).join('\n') + '\n');
  w.fake.setScript([{ match: '^pr view 5 --json state', stdoutJson: { state: 'OPEN' } }]);
  const r = w.run(['publish']);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.deepEqual(r.json.lines, [L2, '- three', '- four'], 'only the valid afterMerge entry is held');
  assert.deepEqual(queueEntries(w), [{ line: L1, at: 'a', afterMerge: 5 }]);
});

test('an old queue file with "staged" entries is read as plain queued and published', () => {
  const w = world();
  mkdirSync(join(w.repo.dir, '.git', 'claude-pipeline'), { recursive: true });
  writeFileSync(w.queueFile, `${JSON.stringify({ line: L1, at: '2026-10-01T00:00:00.000Z', staged: { pr: 9, at: '2026-10-01T01:00:00.000Z' } })}\n`);
  const r = w.run(['publish']);
  assertExit(r, 0);
  assert.deepEqual(r.json.lines, [L1]);
  assert.deepEqual(w.queued(), []);
});

test('an agent_log path outside the repo (or through .git) is refused and nothing is pushed; multi-line --line is a usage error', () => {
  const w = world();
  const t = createTmpRepo();
  t.write('.claude/pipeline.yml', `${pipelineYml()}agent_log: ../outside.md\n`);
  t.commit('init');
  const r = cli(['agent-log', 'publish', '--line', '- x'], { dir: t.dir, fake: w.fake });
  assertExit(r, 2);
  assert.match(r.json.message, /inside the repo/);
  assertExit(w.run(['publish', '--line', '- a\n- forged']), 2);
  assert.deepEqual(w.queued(), []);
  assert.throws(() => logRelPath('/repo', '/etc/passwd'), /relative/);
  assert.throws(() => logRelPath('/repo', '../x.md'), /inside the repo/);
  assert.throws(() => logRelPath('/repo', '.git/hooks/log.md'), /usable path/);
  assert.throws(() => logRelPath('/repo', 'docs/.GIT/x.md'), /usable path/);
  assert.equal(logRelPath('/repo', 'docs/./agent-log.md'), 'docs/agent-log.md');
});

test('assertSafeLogTarget only allows refs/heads/pipeline-agent-log', () => {
  assert.equal(assertSafeLogTarget('refs/heads/pipeline-agent-log'), 'refs/heads/pipeline-agent-log');
  for (const bad of ['refs/heads/main', 'main', 'refs/heads/pipeline-agent-log2', 'refs/heads/pipeline-artifacts', '', 'HEAD', '+refs/heads/pipeline-agent-log']) {
    assert.throws(() => assertSafeLogTarget(bad), /refusing to push/, bad);
  }
});

test('lines are single-line: a forged newline never reaches the log', () => {
  const w = world();
  assert.throws(() => publishLines({ root: w.repo.dir, logRel: AGENT_LOG, lines: ['- ok\n- forged'], defaultBranch: 'main' }), /single line/);
  assert.throws(() => publishLines({ root: w.repo.dir, logRel: AGENT_LOG, lines: ['- a - b'], defaultBranch: 'main' }), /single line/);
});

test('the plumbing runs in a temp index: GIT_INDEX_FILE is set for the plumbing children only, and never the caller\'s own index', () => {
  const w = world();
  const seen = [];
  const gitFn = (args, o) => { seen.push({ args, env: o.env, cwd: o.cwd }); return gitRun(args, o); };
  publishLines({ root: w.repo.dir, logRel: AGENT_LOG, lines: [L1], defaultBranch: 'main', gitFn });
  const withIndex = seen.filter((s) => s.env?.GIT_INDEX_FILE);
  assert.ok(withIndex.length >= 3, 'hash-object / update-index / write-tree run against the temp index');
  for (const s of withIndex) {
    assert.ok(!s.env.GIT_INDEX_FILE.startsWith(join(w.repo.dir, '.git')), 'not the repo\'s own index');
    assert.ok(['read-tree', 'hash-object', 'update-index', 'write-tree'].includes(s.args[0]), s.args.join(' '));
  }
  for (const verb of ['checkout', 'add', 'commit', 'reset', 'worktree', 'branch', 'update-ref', 'merge', 'switch']) {
    assert.equal(seen.some((s) => s.args.includes(verb) && s.args[0] === verb), false, `no git ${verb}`);
  }
});

test('close reads the log branch copy: a pending line that only lives on pipeline-agent-log is found', () => {
  const w = world({ mainLog: null });
  const pending = '- 2026-10-01 · #1420 · Add widget · risk low · rounds 1 · arbiter 0 · merged — prod smoke pending';
  assertExit(w.run(['publish', '--line', pending]), 0);
  // a worktree whose own log file does not exist and whose origin/main has no log: only the branch knows #1420
  w.fake.setScript([
    { match: '^auth status', stdout: 'Logged in' },
    { match: '^repo view', stdoutJson: REPO_VIEW },
    { match: '^pr view 1420 --json mergeCommit', stdoutJson: { mergeCommit: null } },
  ]);
  const r = w.run(['close']);
  assertExit(r, 0);
  assert.deepEqual(r.json.pending, [1420], r.stderr);
  assert.equal(r.json.originReadable, true);
  assert.equal(r.json.originRefreshed, true, 'a remote with the log branch is a successful refresh');
});

test('a box with no git identity still publishes (fallback author), without writing any config', () => {
  const w = world();
  w.repo.git(['config', '--unset', 'user.name']);
  w.repo.git(['config', '--unset', 'user.email']);
  w.repo.git(['config', 'user.useConfigOnly', 'true']);
  const home = tmp('cp-log-home-');
  const saved = { HOME: process.env.HOME, GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM };
  Object.assign(process.env, { HOME: home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' });
  try {
    assert.throws(() => w.repo.git(['var', 'GIT_AUTHOR_IDENT']), 'precondition: git has no identity here');
    const r = publishLines({ root: w.repo.dir, logRel: AGENT_LOG, lines: [L1], defaultBranch: 'main' });
    assert.equal(r.pushed, true);
    assert.equal(w.onOrigin('log', '-1', '--format=%an', BRANCH).trim(), 'claude-pipeline');
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

// ---- the log branch is untrusted data (anyone with push access can rewrite it) -----------------------

// Pushes a commit straight onto the log branch from a second clone, as a hostile or careless writer would. `build(dir)` lays out
// the files; the commit is made on top of the branch's current tip when it exists.
function plant(w, build, { message = 'planted', stageAll = true } = {}) {
  const other = tmp('cp-log-planter-');
  raw(['init', '-q', '-b', 'planter', other], w.repo.dir);
  raw(['config', 'user.name', 'Planter'], other);
  raw(['config', 'user.email', 'planter@example.invalid'], other);
  raw(['config', 'commit.gpgsign', 'false'], other);
  raw(['remote', 'add', 'origin', w.bare], other);
  try {
    raw(['fetch', '-q', 'origin', `${BRANCH}:${BRANCH}`], other);
    raw(['checkout', '-q', BRANCH], other);
  } catch { /* no branch yet: the planted commit is a root */ }
  build(other);
  if (stageAll) raw(['add', '-A'], other);
  raw(['commit', '-q', '-m', message], other);
  raw(['push', '-q', '-f', 'origin', `HEAD:refs/heads/${BRANCH}`], other);
}
const tipTree = (w) => w.onOrigin('ls-tree', '-r', '--name-only', BRANCH).split('\n').filter(Boolean);

test('hardening 1: the new commit\'s tree holds ONLY the log file, whatever else the remote tip carries (a planted workflow is not carried over)', () => {
  const w = world();
  assertExit(w.run(['publish', '--line', L1]), 0);
  plant(w, (d) => {
    mkdirSync(join(d, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(d, '.github', 'workflows', 'x.yml'), 'on: push\njobs: {}\n');
    writeFileSync(join(d, 'other.txt'), 'extra\n');
  });
  assert.ok(tipTree(w).includes('.github/workflows/x.yml'), 'precondition: the tip carries the planted file');
  const planted = w.onOrigin('rev-parse', BRANCH).trim();
  assertExit(w.run(['publish', '--line', L2]), 0);
  assert.deepEqual(tipTree(w), [AGENT_LOG], 'only the log file in our commit');
  assert.equal(w.onOrigin('rev-parse', `${BRANCH}^`).trim(), planted, 'still a fast-forward of their tip');
  const log = w.logOnBranch();
  assert.ok(log.includes(L1) && log.includes(L2));
});

test('hardening 2: a symlink, a directory or a submodule at the log path is "no file": the branch restarts from main\'s copy, as a regular file', () => {
  for (const make of [
    (d) => { mkdirSync(join(d, 'docs'), { recursive: true }); symlinkSync('/etc/hostname', join(d, AGENT_LOG)); },
    (d) => { mkdirSync(join(d, AGENT_LOG), { recursive: true }); writeFileSync(join(d, AGENT_LOG, 'inner.md'), 'x\n'); },
  ]) {
    const w = world();
    plant(w, make);
    const r = w.run(['publish', '--line', L1]);
    assertExit(r, 0);
    assert.equal(r.json.pushed, true);
    assert.equal(w.onOrigin('ls-tree', BRANCH, '--', AGENT_LOG).split(' ')[0], '100644');
    assert.deepEqual(tipTree(w), [AGENT_LOG]);
    const log = w.logOnBranch();
    assert.ok(log.includes('· #1 · old ·') && log.includes(L1), 'seeded from main\'s copy');
    assert.ok(!log.includes('/etc/hostname'));
  }
  // a gitlink (submodule) entry at the path
  const w = world();
  plant(w, (d) => {
    mkdirSync(join(d, 'docs'), { recursive: true });
    raw(['update-index', '--add', '--cacheinfo', `160000,${'a'.repeat(40)},${AGENT_LOG}`], d);
  }, { stageAll: false });
  assert.equal(w.onOrigin('ls-tree', BRANCH, '--', AGENT_LOG).split(' ')[0], '160000', 'precondition: a gitlink sits at the log path');
  assertExit(w.run(['publish', '--line', L1]), 0);
  assert.equal(w.onOrigin('ls-tree', BRANCH, '--', AGENT_LOG).split(' ')[0], '100644');
});

test('hardening 2: a log over 5 MB on the branch is refused (exit 1, clear error), never read, and every line stays queued', () => {
  const w = world();
  plant(w, (d) => {
    mkdirSync(join(d, 'docs'), { recursive: true });
    writeFileSync(join(d, AGENT_LOG), `${'x'.repeat(1023)}\n`.repeat(5 * 1024 + 8));
  });
  const tip = w.onOrigin('rev-parse', BRANCH).trim();
  const r = w.run(['publish', '--line', L1]);
  assertExit(r, 1);
  assert.equal(r.json.error, 'log-too-large');
  assert.match(r.json.message, /5 MB/);
  assert.deepEqual(w.queued(), [L1]);
  assert.equal(w.onOrigin('rev-parse', BRANCH).trim(), tip, 'nothing pushed');
  // close does not read it either: the origin copy counts as unreadable
  w.fake.setScript([{ match: '^auth status', stdout: 'Logged in' }, { match: '^repo view', stdoutJson: REPO_VIEW }]);
  const c = w.run(['close']);
  assert.equal(c.json.originReadable, false);
});

test('hardening 3: existing lines are never rewritten or dropped, only appended after (odd content, CRLF and a missing final newline included)', () => {
  const w = world();
  const theirs = '# Not our header\r\n- weird line\r\n\n- 2026-01-01 · #5 · mine · merged — prod smoke pending';
  plant(w, (d) => { mkdirSync(join(d, 'docs'), { recursive: true }); writeFileSync(join(d, AGENT_LOG), theirs); });
  assertExit(w.run(['publish', '--line', L1]), 0);
  const log = w.logOnBranch();
  assert.ok(log.startsWith(theirs), 'their bytes are a verbatim prefix');
  assert.equal(log, `${theirs}\n${L1}\n`);
});

test('hardening 4: the landed-check matches lines exactly (a near-miss on the branch does not drop a queued line)', () => {
  const w = world();
  plant(w, (d) => { mkdirSync(join(d, 'docs'), { recursive: true }); writeFileSync(join(d, AGENT_LOG), `${AGENT_LOG_HEADER}${L1} \n${L2.toUpperCase()}\n`); });
  w.run(['queue', '--line', L1]);
  const r = w.run(['publish', '--line', L2]);
  assertExit(r, 0);
  assert.equal(r.json.dropped, 0);
  assert.deepEqual(r.json.lines, [L1, L2]);
});
