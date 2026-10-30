// summary and agent-log: the PR summary comment + log line, and the queue/publish flow for the agent log (the publish command itself is
// covered against a real origin in agent-log-publish.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTmpRepo } from './helpers/tmprepo.mjs';
import { createFakeGh, pipelineYml } from './helpers/fakegh-env.mjs';
import { cli, PR, AGENT_LOG, ME, REPO } from './helpers/gate-env.mjs';
import { addRound, emptyState, saveState } from '../pipeline/lib/state.mjs';
import { MARKERS } from '../pipeline/lib/render.mjs';
import { applyCheckpoint, decodeRecord, emptyRecord, encodeRecord } from '../pipeline/lib/run-record.mjs';
import { assertExit } from './helpers/assert-exit.mjs';
import { run as summaryRun } from '../pipeline/commands/summary.mjs';
import { UnavailableError } from '../pipeline/lib/cli.mjs';

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
  assert.equal(r.json.pendingLogLine, r.json.agentLogLine.replace(/merged$/, 'merged — prod smoke pending'), 'a merged run also prints the line agent-log close resolves');

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
  assert.equal('pendingLogLine' in blocked.json, false, 'only a merged run has a pending line');
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

// ---- summary: outcomes, options and exit codes ----------------------------------------------------
// In process. No owner push exists any more: the output has no `notify` field and nothing is sent anywhere.

function pushRepo(state = summaryState()) {
  const repo = createTmpRepo();
  repo.write('.claude/pipeline.yml', pipelineYml());
  repo.write('.gitignore', '.review/\n');
  repo.commit('init');
  if (state) saveState(repo.dir, state);
  return repo;
}

async function summaryIn(repo, args, { fake = summaryGh() } = {}) {
  const stderr = [];
  const orig = process.stderr.write;
  process.stderr.write = (c, ...rest) => { stderr.push(String(c)); return true; };
  try {
    const argv = ['--pr', String(PR), ...args];
    const ctx = { cwd: repo.dir, env: { ...process.env, ...fake.env } };
    let res;
    let error;
    try {
      res = await summaryRun(argv, ctx);
    } catch (err) {
      error = err;
    }
    return { res, error, fake, stderr: stderr.join('') };
  } finally {
    process.stderr.write = orig;
  }
}

test('summary: every outcome word posts the comment and logs a line, with no notify field and no stderr warning', async () => {
  const stateless = ['blocked', 'awaiting-review', 'stopped', 'closed', 'merged-externally'];
  for (const outcome of ['awaiting-owner-merge', 'needs-human', 'merged', 'progressing', ...stateless]) {
    const t = await summaryIn(pushRepo(stateless.includes(outcome) ? null : summaryState()), ['--outcome', outcome]);
    assert.equal(t.error, undefined, outcome);
    assert.equal(t.res.exitCode, 0, outcome);
    assert.equal(t.res.output.ok, true, outcome);
    assert.match(t.res.output.agentLogLine, new RegExp(`· ${outcome}$`), outcome);
    assert.equal('notify' in t.res.output, false, `${outcome}: no notify field`);
    assert.equal(t.stderr, '', `${outcome}: nothing on stderr`);
  }
});

test('summary: --action and --cause are accepted and change nothing; an invalid --cause is still a usage error', async () => {
  const repo = pushRepo(null);
  const plain = await summaryIn(repo, ['--outcome', 'stopped']);
  const withOpts = await summaryIn(repo, ['--outcome', 'stopped', '--action', '- Final gate refused: a blocking label is set', '--cause', 'final-gate:labels']);
  assert.equal(withOpts.error, undefined);
  assert.equal(withOpts.res.exitCode, 0);
  assert.equal(withOpts.res.output.agentLogLine, plain.res.output.agentLogLine);
  assert.equal('notify' in withOpts.res.output, false);
  const bad = await summaryIn(repo, ['--outcome', 'stopped', '--cause', 'bad cause!']);
  assert.match(bad.error.message, /--cause must be a short code/);
});

test('summary: `stopped`, `closed` and `merged-externally` work with no review state', async () => {
  for (const outcome of ['stopped', 'closed', 'merged-externally']) {
    const t = await summaryIn(pushRepo(null), ['--outcome', outcome]);
    assert.equal(t.error, undefined, outcome);
    assert.equal(t.res.exitCode, 0, outcome);
    assert.match(t.res.output.agentLogLine, new RegExp(`· rounds 0 · arbiter 0 · ${outcome}$`));
  }
  // other outcomes without state are still a usage error
  const none = await summaryIn(pushRepo(null), ['--outcome', 'needs-human']);
  assert.match(none.error.message, /only --outcome blocked\|awaiting-review\|stopped\|closed\|merged-externally/);
});

test('summary: the PR lookup failing is the unavailable-GitHub error (exit 3)', async () => {
  const fake = createFakeGh([{ match: '^pr view 12 --json title', code: 1, stderr: 'HTTP 502' }]);
  const t = await summaryIn(pushRepo(), ['--outcome', 'awaiting-owner-merge'], { fake });
  assert.ok(t.error instanceof UnavailableError);
});

test('summary: the comment upsert failing is the unavailable-GitHub error (exit 3)', async () => {
  const fake = createFakeGh([
    { match: '^pr view 12 --json title', stdoutJson: { title: 'Add widget' } },
    ME, REPO,
    { match: '^api repos/acme/widgets/issues/12/comments --paginate', stdoutJson: [] },
    { match: '^api -X POST repos/acme/widgets/issues/12/comments', code: 1, stderr: 'HTTP 502' },
  ]);
  const t = await summaryIn(pushRepo(), ['--outcome', 'needs-human'], { fake });
  assert.ok(t.error instanceof UnavailableError);
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
  const q = (line) => cli(['agent-log', 'queue', '--line', line], { dir: repo.dir, fake });
  const queueFile = () => join(repo.dir, '.git', 'claude-pipeline', 'agent-log-queue.jsonl');
  return { repo, fake, q, queueFile };
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

test('agent-log queue: queueing the same line twice leaves one entry; an old entry marked "staged" is just a queued line', () => {
  const t = logRepo();
  assert.equal(t.q('- same line').json.queued, 1);
  assert.equal(t.q('- same line').json.queued, 1);
  assert.equal(t.q('- another').json.queued, 2);
  writeFileSync(t.queueFile(), `${JSON.stringify({ line: '- old staged', at: '2026-10-12T00:00:00.000Z', staged: { pr: 9, at: '2026-10-12T01:00:00.000Z' } })}\n`);
  assert.equal(t.q('- old staged').json.queued, 1, 'not added a second time');
  assert.equal(t.q('- next').json.queued, 2);
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

// A real origin: lines leave the queue once the log branch (or main's legacy copy of the log) contains them.
function logRepoWithOrigin() {
  const t = logRepo();
  const bare = mkdtempSync(join(tmpdir(), 'cp-log-origin-'));
  t.repo.git(['init', '--bare', '-q', '-b', 'main', bare]);
  t.repo.git(['remote', 'add', 'origin', bare]);
  t.repo.git(['push', '-q', 'origin', 'main']);
  t.bare = bare;
  t.queued = () => (existsSync(t.queueFile()) ? readFileSync(t.queueFile(), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  t.publish = (...args) => cli(['agent-log', 'publish', ...args], { dir: t.repo.dir, fake: t.fake });
  return t;
}

test('agent-log: lines leave the queue only once the log branch or main\'s copy contains them (queue and publish both prune)', () => {
  const t = logRepoWithOrigin();
  try {
    t.q('- landed on main');
    t.q('- still waiting');
    assert.equal(t.queued().length, 2);
    // a legacy PR merged: main on origin gets the first line
    t.repo.git(['checkout', '-q', 'main']);
    t.repo.write(AGENT_LOG, '# Agent log\n\n- landed on main\n');
    t.repo.commit('log landed');
    t.repo.git(['push', '-q', 'origin', 'main']);
    t.repo.git(['checkout', '-q', 'agent/feature']);
    const q = t.q('- fresh');
    assertExit(q, 0);
    assert.deepEqual(t.queued().map((e) => e.line), ['- still waiting', '- fresh'], 'the landed line left the queue on the next queue call');
    assert.equal(q.json.queued, 2);
    // publish prunes too (it fetches origin first): land the second line on main, forget the cached ref, publish.
    t.repo.git(['checkout', '-q', 'main']);
    t.repo.write(AGENT_LOG, '# Agent log\n\n- landed on main\n- still waiting\n');
    t.repo.commit('more landed');
    t.repo.git(['push', '-q', 'origin', 'main']);
    t.repo.git(['update-ref', '-d', 'refs/remotes/origin/main']);
    t.repo.git(['checkout', '-q', 'agent/feature']);
    const p = t.publish('--line', '- pr12');
    assertExit(p, 0);
    assert.equal(p.json.dropped, 1);
    assert.deepEqual(p.json.lines, ['- fresh', '- pr12']);
    assert.deepEqual(t.queued(), []);
    // and a line on the log branch is dropped the same way when queued again
    assert.equal(t.q('- pr12').json.queued, 0);
  } finally {
    rmSync(t.bare, { recursive: true, force: true });
  }
});

test('agent-log publish: an agent_log path outside the repo is refused', () => {
  const t = logRepo();
  const escape = createTmpRepo();
  escape.write('.claude/pipeline.yml', `${pipelineYml()}agent_log: ../outside.md\n`);
  escape.commit('init');
  const r = cli(['agent-log', 'stage', '--pr', '12', '--line', '- x'], { dir: escape.dir, fake: t.fake });
  assertExit(r, 2);
  assert.match(r.json.message, /inside the repo/);
});

test('agent-log: the queue is shared across worktrees of one repo (lines queued in one are published from another)', () => {
  const t = logRepoWithOrigin();
  const other = mkdtempSync(join(tmpdir(), 'cp-wt-'));
  try {
    t.repo.git(['worktree', 'add', '-q', '-b', 'agent/second', join(other, 'wt')]);
    const wt = join(other, 'wt');
    assertExit(cli(['agent-log', 'queue', '--line', '- from the second worktree'], { dir: wt, fake: t.fake }), 0);
    const r = t.publish('--line', '- from the first');
    assertExit(r, 0);
    assert.deepEqual(r.json.lines, ['- from the second worktree', '- from the first']);
  } finally {
    rmSync(other, { recursive: true, force: true });
    rmSync(t.bare, { recursive: true, force: true });
  }
});

test('agent-log publish: needs no GitHub, no clean tree and no PR branch (default branch, detached HEAD and a dirty tree all work); stage only asks about its own PR', () => {
  const t = logRepoWithOrigin();
  try {
    t.fake.setScript([{ match: '.', code: 1, stderr: 'HTTP 401' }]); // any gh call would fail
    t.repo.write('README.md', '# dirty\n');
    t.repo.git(['checkout', '-q', 'main']);
    assertExit(t.publish('--line', '- on main'), 0);
    t.repo.git(['checkout', '-q', '--detach']);
    assert.deepEqual(t.fake.lines(), [], 'plain publish never called GitHub');
    // stage --pr N holds its line until PR 12 merges, so it asks GitHub about that PR (and only that)
    assertExit(cli(['agent-log', 'stage', '--pr', '12', '--line', '- detached'], { dir: t.repo.dir, fake: t.fake }), 0);
    assert.ok(t.fake.lines().every((l) => l.startsWith('pr view 12 ')), t.fake.lines().join('\n'));
    assert.equal(t.repo.git(['status', '--porcelain']).trim(), 'M README.md');
  } finally {
    rmSync(t.bare, { recursive: true, force: true });
  }
});

// ---- summary and the run record ---------------------------------------------------------------------

test('summary: keeps the run record a checkpoint wrote (tasks survive), records how the run ended, edits the one comment', () => {
  const repo = createTmpRepo();
  repo.write('.claude/pipeline.yml', pipelineYml());
  repo.write('.gitignore', '.review/\n');
  repo.commit('init');
  saveState(repo.dir, summaryState());
  const rec = applyCheckpoint(emptyRecord({ repo: 'acme/widgets', pr: PR, branch: 'agent/feature', baseRef: 'main' }), {
    step: 'gate', tasks: [{ id: 'T1', title: 'one', spec: 's', done: true }],
  }, { host: 'mac', now: 0 });
  const fake = createFakeGh([
    { match: '^pr view 12 --json', stdoutJson: { title: 'Add widget', headRefName: 'agent/feature', baseRefName: 'main', headRefOid: 'e'.repeat(40) } },
    ME, REPO,
    { match: '^api repos/acme/widgets/issues/12/comments --paginate', stdoutJson: [{ id: 9, user: { login: 'me' }, body: `${MARKERS.summary}\n\n${encodeRecord(rec)}` }] },
    { match: '^api -X PATCH repos/acme/widgets/issues/comments/9', stdoutJson: { id: 9, html_url: 'https://github.com/acme/widgets/pull/12#issuecomment-9' } },
  ]);
  const r = cli(['summary', '--pr', String(PR), '--outcome', 'awaiting-owner-merge'], { dir: repo.dir, fake });
  assertExit(r, 0);
  assert.deepEqual([r.json.action, r.json.step, r.json.warnings], ['updated', 'awaiting-owner-merge', []]);
  assert.match(r.json.agentLogLine, /awaiting-owner-merge$/);
  const body = JSON.parse(fake.calls().find((c) => c.argv.includes('PATCH')).stdin).body;
  const decoded = decodeRecord(body);
  assert.equal(decoded.status, 'ok');
  assert.deepEqual(decoded.record.tasks, rec.tasks);
  assert.deepEqual([decoded.record.outcome, decoded.record.head, decoded.record.agentLogLine], ['awaiting-owner-merge', 'e'.repeat(40), r.json.agentLogLine]);
  assert.match(body, /### Outcome/);
  assert.ok(!fake.lines().some((l) => l.includes('-X POST')));
});
