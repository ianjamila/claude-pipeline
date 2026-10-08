// summary and agent-log: the PR summary comment + log line, and the queue/stage flow for the agent log file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTmpRepo } from './helpers/tmprepo.mjs';
import { createFakeGh, pipelineYml } from './helpers/fakegh-env.mjs';
import { cli, PR, AGENT_LOG, ME, REPO } from './helpers/gate-env.mjs';
import { addRound, emptyState, saveState } from '../pipeline/lib/state.mjs';
import { MARKERS } from '../pipeline/lib/render.mjs';
import { assertExit } from './helpers/assert-exit.mjs';

// ---- summary --------------------------------------------------------------------------------------

function summaryState() {
  let s = emptyState({ repo: 'acme/widgets', pr: PR, branch: 'agent/feature', risk: 'medium' });
  s = addRound(s, {
    n: 1, fromHead: 'a', toHead: 'b', contentHashAtToHead: 'h1',
    items: [
      {
        id: 'F1', bucket: 'BLOCKING', category: 'bug', title: 'Null deref', file: 'src/a.js', line: 3, fingerprint: 'fp1', codexReasoning: 'can be null',
        judge: { decision: 'REJECT', confidence: 'low', reason: 'looks fine' }, arbiter: { ruling: 'ACCEPT', confidence: 'high', reasoning: 'it can be null' },
        final: { decision: 'ACCEPT', by: 'arbiter', needsHuman: false, reason: 'it can be null' }, implemented: true,
      },
      {
        id: 'F2', bucket: 'SUGGESTION', title: 'Rename x', fingerprint: 'fp2', judge: { decision: 'FOLLOW-UP', confidence: 'high', reason: 'later' },
        final: { decision: 'FOLLOW-UP', by: 'judge', needsHuman: false, reason: 'later' },
        followupIssue: { number: 99, url: 'https://github.com/acme/widgets/issues/99', title: 'Rename x' },
      },
    ],
  });
  return addRound(s, { n: 2, fromHead: 'b', toHead: 'c', contentHashAtToHead: 'h2', items: [] });
}

const summaryGh = (existing = []) => createFakeGh([
  { match: '^pr view 12 --json title', stdoutJson: { title: 'Add widget' } },
  ME, REPO,
  { match: '^api repos/acme/widgets/issues/12/comments --paginate', stdoutJson: existing },
  { match: '^api -X POST repos/acme/widgets/issues/12/comments', stdoutJson: { id: 5, html_url: 'https://github.com/acme/widgets/pull/12#issuecomment-5' } },
  { match: '^api -X PATCH repos/acme/widgets/issues/comments/9', stdoutJson: { id: 9, html_url: 'https://github.com/acme/widgets/pull/12#issuecomment-9' } },
]);

test('summary: upserts the marker comment from the state and prints the agent-log line', () => {
  const repo = createTmpRepo();
  repo.write('.claude/pipeline.yml', pipelineYml());
  repo.write('.gitignore', '.review/\n');
  repo.commit('init');
  saveState(repo.dir, summaryState());
  repo.write('.review/round-1/model-proof.json', JSON.stringify({ ok: true, transcript: '/t/agent-1.jsonl', models: { 'claude-fable-5-1': 4 }, efforts: { high: 4 } }));
  repo.write('.review/round-2/model-proof.json', JSON.stringify({ ok: false, transcript: '/t/bad.jsonl', models: { 'claude-opus': 1 } }));
  const fake = summaryGh();

  const r = cli(['summary', '--pr', String(PR), '--outcome', 'merged', '--built', 'A widget.'], { dir: repo.dir, fake });
  assertExit(r, 0);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.url, 'https://github.com/acme/widgets/pull/12#issuecomment-5');
  assert.match(r.json.agentLogLine, /^- \d{4}-\d{2}-\d{2} · #12 · Add widget · risk medium · rounds 2 · arbiter 1 · merged$/);
  assert.equal(r.json.agentLogLine.split(' · ')[0].slice(2), new Date().toISOString().slice(0, 10));

  const post = fake.calls().find((c) => c.argv.includes('POST'));
  const body = JSON.parse(post.stdin).body;
  assert.ok(body.startsWith(MARKERS.summary));
  assert.match(body, /Null deref/);
  assert.match(body, /A widget\./);
  assert.match(body, /Fable proof: \/t\/agent-1\.jsonl, models claude-fable-5-1×4, effort high/);
  assert.doesNotMatch(body, /bad\.jsonl/, 'a failed proof adds nothing');
  assert.match(body, /\[Rename x\]\(https:\/\/github\.com\/acme\/widgets\/issues\/99\)/);
  assert.match(body, /\*\*merged\*\*/);
});

test('summary: edits the existing summary comment in place (marker + same author) and needs a review state', () => {
  const repo = createTmpRepo();
  repo.write('.claude/pipeline.yml', pipelineYml());
  repo.write('.gitignore', '.review/\n');
  repo.commit('init');
  const fake = summaryGh([{ id: 9, body: `${MARKERS.summary}\nold`, user: { login: 'me' } }]);
  const none = cli(['summary', '--pr', String(PR), '--outcome', 'merged'], { dir: repo.dir, fake });
  assertExit(none, 2, 'no state to render from');
  assert.equal(fake.calls().length, 0, 'and nothing was posted');

  saveState(repo.dir, summaryState());
  const r = cli(['summary', '--pr', String(PR), '--outcome', 'merged'], { dir: repo.dir, fake });
  assertExit(r, 0);
  assert.equal(r.json.action, 'updated');
  assert.ok(fake.lines().some((l) => l.startsWith('api -X PATCH repos/acme/widgets/issues/comments/9')));
  assert.ok(!fake.lines().some((l) => l.includes('-X POST')));
  assertExit(cli(['summary', '--pr', String(PR)], { dir: repo.dir, fake }), 2, '--outcome is required');
});

// The two early-stop paths (verify red 3x, Codex out in round 1) have no state.json; they still need a comment and a log line.
test('summary: --outcome blocked / awaiting-review render without state.json (empty rounds, verify failure named) and print the agent-log line', () => {
  const repo = createTmpRepo();
  repo.write('.claude/pipeline.yml', pipelineYml());
  repo.write('.gitignore', '.review/\n.verify/\n');
  repo.commit('init');
  repo.write('.verify/report.json', JSON.stringify({ version: 1, mode: 'full', ok: false, steps: [{ name: 'install', status: 'pass' }, { name: 'lint', status: 'fail' }, { name: 'unit', status: 'not-run' }] }));

  const fake = summaryGh();
  const blocked = cli(['summary', '--pr', String(PR), '--outcome', 'blocked'], { dir: repo.dir, fake });
  assertExit(blocked, 0);
  assert.match(blocked.json.agentLogLine, /^- \d{4}-\d{2}-\d{2} · #12 · Add widget · risk unknown · rounds 0 · arbiter 0 · blocked$/);
  const body = JSON.parse(fake.calls().find((c) => c.argv.includes('POST')).stdin).body;
  assert.ok(body.startsWith(MARKERS.summary));
  assert.match(body, /\*\*blocked — verify failed at step lint \(full\)\*\*/);
  assert.match(body, /### Suggestions implemented\n\n_None_/);

  const fake2 = summaryGh();
  const awaiting = cli(['summary', '--pr', String(PR), '--outcome', 'awaiting-review', '--built', 'A widget.'], { dir: repo.dir, fake: fake2 });
  assertExit(awaiting, 0);
  assert.match(awaiting.json.agentLogLine, /· rounds 0 · arbiter 0 · awaiting-review$/);
  const body2 = JSON.parse(fake2.calls().find((c) => c.argv.includes('POST')).stdin).body;
  assert.match(body2, /\*\*awaiting-review\*\*/, 'only a blocked outcome gets the verify detail');
  assert.match(body2, /A widget\./);
});

test('summary: blocked without a verify report still renders; every other outcome without state stays exit 2', () => {
  const repo = createTmpRepo();
  repo.write('.claude/pipeline.yml', pipelineYml());
  repo.write('.gitignore', '.review/\n');
  repo.commit('init');
  const fake = summaryGh();
  const r = cli(['summary', '--pr', String(PR), '--outcome', 'blocked'], { dir: repo.dir, fake });
  assertExit(r, 0);
  assert.match(JSON.parse(fake.calls().find((c) => c.argv.includes('POST')).stdin).body, /\*\*blocked\*\*/);
  for (const outcome of ['merged', 'needs-human', 'reverted']) {
    const none = cli(['summary', '--pr', String(PR), '--outcome', outcome], { dir: repo.dir, fake: summaryGh() });
    assertExit(none, 2, outcome);
    assert.match(none.json.message, /only --outcome blocked\|awaiting-review/);
  }
});

test('summary: an unreachable GitHub is exit 3', () => {
  const repo = createTmpRepo();
  repo.write('.claude/pipeline.yml', pipelineYml());
  repo.write('.gitignore', '.review/\n');
  repo.commit('init');
  saveState(repo.dir, summaryState());
  const r = cli(['summary', '--pr', String(PR), '--outcome', 'merged'], { dir: repo.dir, fake: createFakeGh([{ match: '.', code: 1, stderr: 'HTTP 401' }]) });
  assertExit(r, 3);
});

// ---- agent-log ------------------------------------------------------------------------------------

function logRepo() {
  const repo = createTmpRepo();
  repo.write('.claude/pipeline.yml', pipelineYml());
  repo.write('.gitignore', '.review/\n');
  repo.write('README.md', '# demo\n');
  repo.commit('init');
  repo.branch('agent/feature');
  const fake = createFakeGh([]);
  // The PR as GitHub sees it: on the branch the worktree is on, at the commit the worktree is at (unless a test says otherwise).
  const prFor = (over = {}) => ({ headRefName: repo.git(['symbolic-ref', '-q', '--short', 'HEAD']).trim(), headRefOid: repo.git(['rev-parse', 'HEAD']).trim(), ...over });
  const script = (pr) => [
    { match: '^pr view 12 --json title', stdoutJson: { title: 'Add widget' } },
    { match: '^pr view 12 --json headRefName,headRefOid', stdoutJson: pr },
  ];
  const q = (line) => cli(['agent-log', 'queue', '--line', line], { dir: repo.dir, fake });
  const stage = (...args) => {
    fake.setScript(script(prFor()));
    return cli(['agent-log', 'stage', '--pr', String(PR), ...args], { dir: repo.dir, fake });
  };
  const stageAgainst = (pr, ...args) => {
    fake.setScript(script(pr));
    return cli(['agent-log', 'stage', '--pr', String(PR), ...args], { dir: repo.dir, fake });
  };
  const queueFile = () => join(repo.dir, '.git', 'claude-pipeline', 'agent-log-queue.jsonl');
  return { repo, fake, q, stage, stageAgainst, prFor, queueFile };
}

test('agent-log queue: appends {line, at} to the queue file under the git common dir', () => {
  const t = logRepo();
  const a = t.q('- 2026-09-30 · #10 · first · risk low · rounds 1 · arbiter 0 · merged');
  assertExit(a, 0);
  assert.equal(a.json.queued, 1);
  assert.equal(t.q('- second').json.queued, 2);
  const entries = readFileSync(t.queueFile(), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(entries.map((e) => e.line), ['- 2026-09-30 · #10 · first · risk low · rounds 1 · arbiter 0 · merged', '- second']);
  assert.ok(entries.every((e) => Number.isFinite(Date.parse(e.at))));
  assert.equal(a.json.file, t.queueFile());
});

test('agent-log queue: a missing, empty or multi-line --line is a usage error and queues nothing', () => {
  const t = logRepo();
  assertExit(cli(['agent-log', 'queue'], { dir: t.repo.dir, fake: t.fake }), 2);
  assertExit(t.q(''), 2);
  assertExit(t.q('- a\n- forged'), 2);
  assertExit(cli(['agent-log'], { dir: t.repo.dir, fake: t.fake }), 2);
  assertExit(cli(['agent-log', 'flush'], { dir: t.repo.dir, fake: t.fake }), 2);
  assert.equal(existsSync(t.queueFile()), false);
});

test('agent-log stage: writes the header, queued lines oldest first, then this line; commits; keeps the queued lines marked as staged', () => {
  const t = logRepo();
  t.q('- queued one');
  t.q('- queued two');
  const before = t.repo.git(['rev-parse', 'HEAD']).trim();
  const r = t.stage('--line', '- this PR');
  assertExit(r, 0);
  assert.equal(r.json.ok, true);
  assert.deepEqual(r.json.lines, ['- queued one', '- queued two', '- this PR']);
  const after = t.repo.git(['rev-parse', 'HEAD']).trim();
  assert.notEqual(after, before);
  assert.equal(r.json.committed, after);
  assert.equal(t.repo.git(['log', '-1', '--format=%s']).trim(), 'docs: agent log for #12');
  const log = readFileSync(join(t.repo.dir, AGENT_LOG), 'utf8');
  assert.match(log, /^# Agent log\n/);
  assert.ok(log.indexOf('- queued one') < log.indexOf('- queued two') && log.indexOf('- queued two') < log.indexOf('- this PR'));
  assert.equal(t.repo.git(['show', '--stat', '--format=', 'HEAD']).trim().split('\n').length, 2, 'only the log file (plus the stat summary line)');
  assert.match(t.repo.git(['show', '--name-only', '--format=', 'HEAD']), /^docs\/agent-log\.md$/m);
  assert.equal(t.repo.git(['status', '--porcelain']), '');
  // Not cleared: if this PR never merges the lines would be lost. They stay, marked "staged in PR 12", until origin/main has them.
  const queued = readFileSync(t.queueFile(), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(queued.map((e) => [e.line, e.staged?.pr]), [['- queued one', 12], ['- queued two', 12]]);
  assert.equal(r.json.staged, 2);
  assert.equal(r.json.dropped, 0);
});

test('agent-log stage: default line is the PR\'s agent-log line with outcome "merged — prod smoke pending"; appends to an existing log', () => {
  const t = logRepo();
  t.repo.write(AGENT_LOG, '# Agent log\n\n- 2026-09-01 · #1 · old · risk low · rounds 1 · arbiter 0 · merged');
  t.repo.commit('seed log without a final newline');
  saveState(t.repo.dir, summaryState());
  const r = t.stage();
  assertExit(r, 0);
  assert.equal(r.json.lines.length, 1);
  assert.match(r.json.lines[0], /^- \d{4}-\d{2}-\d{2} · #12 · Add widget · risk medium · rounds 2 · arbiter 1 · merged — prod smoke pending$/);
  const log = readFileSync(join(t.repo.dir, AGENT_LOG), 'utf8');
  assert.equal(log.split('\n').filter((l) => l.startsWith('# Agent log')).length, 1, 'the header is not repeated');
  assert.ok(log.includes('· old ·'));
  assert.ok(log.endsWith('prod smoke pending\n'));
  assert.ok(t.fake.lines().includes('pr view 12 --json title'));
});

test('agent-log stage: refuses (exit 2) when the worktree has other uncommitted changes; queue and history untouched', () => {
  const t = logRepo();
  t.q('- queued');
  t.repo.write('README.md', '# demo edited\n');
  const head = t.repo.git(['rev-parse', 'HEAD']).trim();
  const r = t.stage('--line', '- x');
  assertExit(r, 2);
  assert.equal(r.json.error, 'dirty');
  assert.equal(t.repo.git(['rev-parse', 'HEAD']).trim(), head);
  assert.equal(existsSync(join(t.repo.dir, AGENT_LOG)), false);
  assert.match(readFileSync(t.queueFile(), 'utf8'), /queued/);
  t.repo.write('new-untracked.txt', 'x');
  t.repo.git(['checkout', '--', 'README.md']);
  assertExit(t.stage('--line', '- x'), 2, 'an untracked file counts as other changes too');
});

test('agent-log stage: running it again with a line already in the log writes nothing (idempotent)', () => {
  const t = logRepo();
  assertExit(t.stage('--line', '- same'), 0);
  const head = t.repo.git(['rev-parse', 'HEAD']).trim();
  t.q('- same');
  const again = t.stage('--line', '- same');
  assertExit(again, 0);
  assert.equal(again.json.committed, null);
  assert.deepEqual(again.json.lines, []);
  assert.equal(t.repo.git(['rev-parse', 'HEAD']).trim(), head);
  assert.equal(JSON.parse(readFileSync(t.queueFile(), 'utf8').trim()).staged.pr, 12, 'the duplicate stays queued, marked staged, until main has it');
});

// A real origin: staged lines survive a PR that never merges, are dropped once origin/main has them, and are not
// re-staged into a second PR while the first is still open.
function logRepoWithOrigin() {
  const t = logRepo();
  const bare = mkdtempSync(join(tmpdir(), 'cp-log-origin-'));
  t.repo.git(['init', '--bare', '-q', bare]);
  t.repo.git(['remote', 'add', 'origin', bare]);
  t.repo.git(['push', '-q', 'origin', 'main']);
  t.bare = bare;
  t.stagePr = (n, branch, state, ...args) => {
    t.fake.setScript([
      { match: `^pr view ${n} --json headRefName,headRefOid`, stdoutJson: { headRefName: branch, headRefOid: t.repo.git(['rev-parse', 'HEAD']).trim() } },
      { match: '^pr view 12 --json state', stdoutJson: { state } },
    ]);
    return cli(['agent-log', 'stage', '--pr', String(n), ...args], { dir: t.repo.dir, fake: t.fake });
  };
  t.queued = () => (existsSync(t.queueFile()) ? readFileSync(t.queueFile(), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  return t;
}

test('agent-log stage: a PR that never merges does not lose the lines it staged: they are re-staged once that PR is closed', () => {
  const t = logRepoWithOrigin();
  try {
    t.q('- queued a');
    assertExit(t.stagePr(12, 'agent/feature', 'OPEN', '--line', '- pr12'), 0);
    assert.deepEqual(t.queued().map((e) => [e.line, e.staged?.pr]), [['- queued a', 12]]);

    // A second PR (branched from main, which does not have PR 12's commit).
    t.repo.git(['checkout', '-q', '-b', 'agent/other', 'main']);
    const open = t.stagePr(13, 'agent/other', 'OPEN', '--line', '- pr13');
    assertExit(open, 0);
    assert.deepEqual(open.json.lines, ['- pr13'], 'staged in an OPEN PR: not carried a second time (it would collide when both merge)');
    assert.equal(open.json.staged, 0);
    assert.equal(t.queued()[0].staged.pr, 12);

    t.repo.write('docs/trigger.txt', 'x');
    t.repo.commit('another change');
    const closed = t.stagePr(13, 'agent/other', 'CLOSED', '--line', '- pr13 again');
    assertExit(closed, 0);
    assert.deepEqual(closed.json.lines, ['- queued a', '- pr13 again'], 'PR 12 closed unmerged: its queued line is re-staged here');
    assert.equal(t.queued()[0].staged.pr, 13);
  } finally {
    rmSync(t.bare, { recursive: true, force: true });
  }
});

test('agent-log: staged lines are dropped from the queue only once origin/<default> contains them (stage and queue both prune)', () => {
  const t = logRepoWithOrigin();
  try {
    t.q('- landed one');
    t.q('- still waiting');
    assertExit(t.stagePr(12, 'agent/feature', 'OPEN', '--line', '- pr12'), 0);
    assert.equal(t.queued().length, 2);
    // PR 12 "merges": main on origin gets the log with the first line only.
    t.repo.git(['checkout', '-q', 'main']);
    t.repo.write(AGENT_LOG, '# Agent log\n\n- landed one\n- pr12\n');
    t.repo.commit('log landed');
    t.repo.git(['push', '-q', 'origin', 'main']);
    t.repo.git(['checkout', '-q', 'agent/feature']);
    const q = t.q('- fresh');
    assertExit(q, 0);
    assert.deepEqual(t.queued().map((e) => e.line), ['- still waiting', '- fresh'], 'the landed line left the queue on the next queue call');
    assert.equal(q.json.queued, 2);
    // stage prunes too (it fetches origin first): land the second line and stage again.
    t.repo.git(['checkout', '-q', 'main']);
    t.repo.write(AGENT_LOG, '# Agent log\n\n- landed one\n- pr12\n- still waiting\n');
    t.repo.commit('more landed');
    t.repo.git(['push', '-q', 'origin', 'main']);
    t.repo.git(['update-ref', '-d', 'refs/remotes/origin/main']); // forget it: stage must fetch
    t.repo.git(['checkout', '-q', 'agent/feature']);
    const s = t.stagePr(12, 'agent/feature', 'OPEN', '--line', '- pr12 again');
    assertExit(s, 0);
    assert.equal(s.json.dropped, 1);
    assert.deepEqual(t.queued().map((e) => e.line), ['- fresh']);
  } finally {
    rmSync(t.bare, { recursive: true, force: true });
  }
});

test('agent-log stage: --pr is required, and an agent_log path outside the repo is refused', () => {
  const t = logRepo();
  assertExit(cli(['agent-log', 'stage'], { dir: t.repo.dir, fake: t.fake }), 2);
  const escape = createTmpRepo();
  escape.write('.claude/pipeline.yml', `${pipelineYml()}agent_log: ../outside.md\n`);
  escape.commit('init');
  const r = cli(['agent-log', 'stage', '--pr', '12', '--line', '- x'], { dir: escape.dir, fake: t.fake });
  assertExit(r, 2);
  assert.match(r.json.message, /inside the repo/);
});

test('agent-log: the queue is shared across worktrees of one repo (lines queued in one are staged from another)', () => {
  const t = logRepo();
  const other = mkdtempSync(join(tmpdir(), 'cp-wt-'));
  try {
    t.repo.git(['worktree', 'add', '-q', '-b', 'agent/second', join(other, 'wt')]);
    const wt = join(other, 'wt');
    assertExit(cli(['agent-log', 'queue', '--line', '- from the second worktree'], { dir: wt, fake: t.fake }), 0);
    const r = t.stage('--line', '- from the first');
    assertExit(r, 0);
    assert.deepEqual(r.json.lines, ['- from the second worktree', '- from the first']);
  } finally {
    rmSync(other, { recursive: true, force: true });
  }
});


// ---- agent-log stage: which branch it may commit to (reviewer finding 5) -----------------------------

test('agent-log stage: refuses on the default branch (reviewer repro D) and on master/main, committing and queueing nothing', () => {
  const t = logRepo();
  t.repo.git(['checkout', '-q', 'main']);
  t.q('- queued');
  const head = t.repo.git(['rev-parse', 'HEAD']).trim();
  const r = t.stage('--line', '- x');
  assertExit(r, 2);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.error, 'branch');
  assert.match(r.json.message, /default branch/);
  assert.equal(t.repo.git(['rev-parse', 'HEAD']).trim(), head, 'no commit landed on main');
  assert.equal(existsSync(join(t.repo.dir, AGENT_LOG)), false);
  assert.match(readFileSync(t.queueFile(), 'utf8'), /queued/, 'the queue was not consumed');

  // main/master are refused even when config names another default branch
  const other = createTmpRepo();
  other.write('.claude/pipeline.yml', `${pipelineYml()}default_branch: trunk\n`);
  other.write('.gitignore', '.review/\n');
  other.commit('init');
  for (const name of ['master', 'main', 'trunk']) {
    other.git(['checkout', '-q', '-B', name]);
    const refused = cli(['agent-log', 'stage', '--pr', '12', '--line', '- x'], { dir: other.dir, fake: t.fake });
    assertExit(refused, 2, name);
    assert.equal(refused.json.error, 'branch', name);
  }
});

test('agent-log stage: refuses on a detached HEAD', () => {
  const t = logRepo();
  t.repo.git(['checkout', '-q', '--detach']);
  const head = t.repo.git(['rev-parse', 'HEAD']).trim();
  const r = cli(['agent-log', 'stage', '--pr', '12', '--line', '- x'], { dir: t.repo.dir, fake: t.fake });
  assertExit(r, 2);
  assert.equal(r.json.error, 'branch');
  assert.match(r.json.message, /detached/);
  assert.equal(t.repo.git(['rev-parse', 'HEAD']).trim(), head);
});

test('agent-log stage: the PR must be this branch at this commit, even when --line is given', () => {
  const t = logRepo();
  const head = t.repo.git(['rev-parse', 'HEAD']).trim();
  const wrongBranch = t.stageAgainst(t.prFor({ headRefName: 'agent/other' }), '--line', '- x');
  assertExit(wrongBranch, 2);
  assert.equal(wrongBranch.json.error, 'pr-mismatch');
  assert.match(wrongBranch.json.message, /agent\/other/);
  const wrongHead = t.stageAgainst(t.prFor({ headRefOid: 'd'.repeat(40) }), '--line', '- x');
  assertExit(wrongHead, 2);
  assert.equal(wrongHead.json.error, 'pr-mismatch');
  assert.match(wrongHead.json.message, /dddddddd/);
  const noFields = t.stageAgainst({}, '--line', '- x');
  assertExit(noFields, 2, 'a PR reply without the fields proves nothing');
  assert.equal(t.repo.git(['rev-parse', 'HEAD']).trim(), head, 'nothing was committed');
  assert.equal(existsSync(join(t.repo.dir, AGENT_LOG)), false);
  assert.ok(t.fake.lines().some((l) => l === 'pr view 12 --json headRefName,headRefOid'), 'the PR is fetched even with --line');
});

test('agent-log stage: an unreachable GitHub is exit 3 and commits nothing', () => {
  const t = logRepo();
  t.fake.setScript([{ match: '.', code: 1, stderr: 'HTTP 401' }]);
  const head = t.repo.git(['rev-parse', 'HEAD']).trim();
  const r = cli(['agent-log', 'stage', '--pr', '12', '--line', '- x'], { dir: t.repo.dir, fake: t.fake });
  assertExit(r, 3);
  assert.equal(t.repo.git(['rev-parse', 'HEAD']).trim(), head);
});
