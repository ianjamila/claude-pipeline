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
  assert.equal(r.code, 0, `${r.stderr}\n${r.stdout}`);
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
  assert.equal(none.code, 2, 'no state to render from');
  assert.equal(fake.calls().length, 0, 'and nothing was posted');

  saveState(repo.dir, summaryState());
  const r = cli(['summary', '--pr', String(PR), '--outcome', 'merged'], { dir: repo.dir, fake });
  assert.equal(r.code, 0, `${r.stderr}\n${r.stdout}`);
  assert.equal(r.json.action, 'updated');
  assert.ok(fake.lines().some((l) => l.startsWith('api -X PATCH repos/acme/widgets/issues/comments/9')));
  assert.ok(!fake.lines().some((l) => l.includes('-X POST')));
  assert.equal(cli(['summary', '--pr', String(PR)], { dir: repo.dir, fake }).code, 2, '--outcome is required');
});

test('summary: an unreachable GitHub is exit 3', () => {
  const repo = createTmpRepo();
  repo.write('.claude/pipeline.yml', pipelineYml());
  repo.write('.gitignore', '.review/\n');
  repo.commit('init');
  saveState(repo.dir, summaryState());
  const r = cli(['summary', '--pr', String(PR), '--outcome', 'merged'], { dir: repo.dir, fake: createFakeGh([{ match: '.', code: 1, stderr: 'HTTP 401' }]) });
  assert.equal(r.code, 3);
});

// ---- agent-log ------------------------------------------------------------------------------------

function logRepo() {
  const repo = createTmpRepo();
  repo.write('.claude/pipeline.yml', pipelineYml());
  repo.write('.gitignore', '.review/\n');
  repo.write('README.md', '# demo\n');
  repo.commit('init');
  repo.branch('agent/feature');
  const fake = createFakeGh([{ match: '^pr view 12 --json title', stdoutJson: { title: 'Add widget' } }]);
  const q = (line) => cli(['agent-log', 'queue', '--line', line], { dir: repo.dir, fake });
  const stage = (...args) => cli(['agent-log', 'stage', '--pr', String(PR), ...args], { dir: repo.dir, fake });
  const queueFile = () => join(repo.dir, '.git', 'claude-pipeline', 'agent-log-queue.jsonl');
  return { repo, fake, q, stage, queueFile };
}

test('agent-log queue: appends {line, at} to the queue file under the git common dir', () => {
  const t = logRepo();
  const a = t.q('- 2026-09-30 · #10 · first · risk low · rounds 1 · arbiter 0 · merged');
  assert.equal(a.code, 0, a.stderr);
  assert.equal(a.json.queued, 1);
  assert.equal(t.q('- second').json.queued, 2);
  const entries = readFileSync(t.queueFile(), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(entries.map((e) => e.line), ['- 2026-09-30 · #10 · first · risk low · rounds 1 · arbiter 0 · merged', '- second']);
  assert.ok(entries.every((e) => Number.isFinite(Date.parse(e.at))));
  assert.equal(a.json.file, t.queueFile());
});

test('agent-log queue: a missing, empty or multi-line --line is a usage error and queues nothing', () => {
  const t = logRepo();
  assert.equal(cli(['agent-log', 'queue'], { dir: t.repo.dir, fake: t.fake }).code, 2);
  assert.equal(t.q('').code, 2);
  assert.equal(t.q('- a\n- forged').code, 2);
  assert.equal(cli(['agent-log'], { dir: t.repo.dir, fake: t.fake }).code, 2);
  assert.equal(cli(['agent-log', 'flush'], { dir: t.repo.dir, fake: t.fake }).code, 2);
  assert.equal(existsSync(t.queueFile()), false);
});

test('agent-log stage: writes the header, queued lines oldest first, then this line; commits; clears the queue', () => {
  const t = logRepo();
  t.q('- queued one');
  t.q('- queued two');
  const before = t.repo.git(['rev-parse', 'HEAD']).trim();
  const r = t.stage('--line', '- this PR');
  assert.equal(r.code, 0, `${r.stderr}\n${r.stdout}`);
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
  assert.equal(existsSync(t.queueFile()) ? readFileSync(t.queueFile(), 'utf8').trim() : '', '', 'the written lines left the queue');
});

test('agent-log stage: default line is the PR\'s agent-log line with outcome "merged — prod smoke pending"; appends to an existing log', () => {
  const t = logRepo();
  t.repo.write(AGENT_LOG, '# Agent log\n\n- 2026-09-01 · #1 · old · risk low · rounds 1 · arbiter 0 · merged');
  t.repo.commit('seed log without a final newline');
  saveState(t.repo.dir, summaryState());
  const r = t.stage();
  assert.equal(r.code, 0, `${r.stderr}\n${r.stdout}`);
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
  assert.equal(r.code, 2);
  assert.equal(r.json.error, 'dirty');
  assert.equal(t.repo.git(['rev-parse', 'HEAD']).trim(), head);
  assert.equal(existsSync(join(t.repo.dir, AGENT_LOG)), false);
  assert.match(readFileSync(t.queueFile(), 'utf8'), /queued/);
  t.repo.write('new-untracked.txt', 'x');
  t.repo.git(['checkout', '--', 'README.md']);
  assert.equal(t.stage('--line', '- x').code, 2, 'an untracked file counts as other changes too');
});

test('agent-log stage: running it again with a line already in the log writes nothing (idempotent), and still clears the queue', () => {
  const t = logRepo();
  assert.equal(t.stage('--line', '- same').code, 0);
  const head = t.repo.git(['rev-parse', 'HEAD']).trim();
  t.q('- same');
  const again = t.stage('--line', '- same');
  assert.equal(again.code, 0);
  assert.equal(again.json.committed, null);
  assert.deepEqual(again.json.lines, []);
  assert.equal(t.repo.git(['rev-parse', 'HEAD']).trim(), head);
  assert.equal(existsSync(t.queueFile()), false);
});

test('agent-log stage: --pr is required, and an agent_log path outside the repo is refused', () => {
  const t = logRepo();
  assert.equal(cli(['agent-log', 'stage'], { dir: t.repo.dir, fake: t.fake }).code, 2);
  const escape = createTmpRepo();
  escape.write('.claude/pipeline.yml', `${pipelineYml()}agent_log: ../outside.md\n`);
  escape.commit('init');
  const r = cli(['agent-log', 'stage', '--pr', '12', '--line', '- x'], { dir: escape.dir, fake: t.fake });
  assert.equal(r.code, 2);
  assert.match(r.json.message, /inside the repo/);
});

test('agent-log: the queue is shared across worktrees of one repo (lines queued in one are staged from another)', () => {
  const t = logRepo();
  const other = mkdtempSync(join(tmpdir(), 'cp-wt-'));
  try {
    t.repo.git(['worktree', 'add', '-q', '-b', 'agent/second', join(other, 'wt')]);
    const wt = join(other, 'wt');
    assert.equal(cli(['agent-log', 'queue', '--line', '- from the second worktree'], { dir: wt, fake: t.fake }).code, 0);
    const r = t.stage('--line', '- from the first');
    assert.equal(r.code, 0, `${r.stderr}\n${r.stdout}`);
    assert.deepEqual(r.json.lines, ['- from the second worktree', '- from the first']);
  } finally {
    rmSync(other, { recursive: true, force: true });
  }
});

