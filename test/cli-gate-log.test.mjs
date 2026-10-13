// summary and agent-log: the PR summary comment + log line, and the queue/stage flow for the agent log file.
import { test, after } from 'node:test';
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
import { LEDGER_NAME } from '../pipeline/lib/notify.mjs';

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

// ---- summary: the owner push ---------------------------------------------------------------------
// In process, so the notify transports are fakes: nothing here reaches the network or a real home directory.

const TOPIC = 'SUMMARYSENTINELTOPIC';
const scratchDirs = [];
after(() => scratchDirs.forEach((d) => rmSync(d, { recursive: true, force: true, maxRetries: 3 })));

function notifyRig() {
  const dir = mkdtempSync(join(tmpdir(), 'cp-summary-notify-'));
  scratchDirs.push(dir);
  const secretsFile = join(dir, 'secrets.sh');
  writeFileSync(secretsFile, `export NTFY_TOPIC=${TOPIC}\n`);
  const fetchCalls = [];
  const deps = {
    env: {},
    secretsFile,
    stateDir: join(dir, 'state'),
    git: (args) => (args[0] === 'remote' ? 'git@github.com:acme/widgets.git' : ''),
    isWsl: () => false,
    lookup: async () => { throw new Error('summary must not look the PR up again when it has the title'); },
    fetch: async (url, init) => {
      fetchCalls.push({ url, body: JSON.parse(init.body) });
      return { ok: true, status: 200 };
    },
  };
  return { deps, fetchCalls, ledger: () => (existsSync(join(dir, 'state', LEDGER_NAME)) ? readFileSync(join(dir, 'state', LEDGER_NAME), 'utf8') : '') };
}

function pushRepo(state = summaryState()) {
  const repo = createTmpRepo();
  repo.write('.claude/pipeline.yml', pipelineYml());
  repo.write('.gitignore', '.review/\n');
  repo.commit('init');
  if (state) saveState(repo.dir, state);
  return repo;
}

async function summaryIn(repo, args, { fake = summaryGh(), rig = notifyRig() } = {}) {
  const stderr = [];
  const orig = process.stderr.write;
  process.stderr.write = (c, ...rest) => { stderr.push(String(c)); return true; };
  try {
    const argv = ['--pr', String(PR), ...args];
    const ctx = { cwd: repo.dir, env: { ...process.env, ...fake.env }, notifyDeps: rig.deps };
    let res;
    let error;
    try {
      res = await summaryRun(argv, ctx);
    } catch (err) {
      error = err;
    }
    return { res, error, rig, fake, stderr: stderr.join('') };
  } finally {
    process.stderr.write = orig;
  }
}

function needsHumanState() {
  let s = emptyState({ repo: 'acme/widgets', pr: PR, branch: 'agent/feature', risk: 'medium' });
  s = addRound(s, {
    n: 1, fromHead: 'a', toHead: 'b', contentHashAtToHead: 'h1',
    items: [
      { id: 'F1', bucket: 'BLOCKING', title: 'Judge could not parse', fingerprint: 'fp1', final: { decision: null, by: 'judge', needsHuman: true, reason: 'invalid judge output' } },
      { id: 'F2', bucket: 'BLOCKING', category: 'security', title: 'Arbiter unsure', fingerprint: 'fp2', final: { decision: 'ACCEPT', by: 'arbiter', needsHuman: true, reason: 'arbiter low confidence' } },
      { id: 'F4', bucket: 'SUGGESTION', title: 'Settled', fingerprint: 'fp4', final: { decision: 'ACCEPT', by: 'arbiter', needsHuman: false, reason: 'ok' } },
    ],
  });
  return addRound(s, {
    n: 2, fromHead: 'b', toHead: 'c', contentHashAtToHead: 'h2',
    items: [{ id: 'F3', bucket: 'BLOCKING', title: 'Unproven ruling', fingerprint: 'fp3', final: { decision: 'REJECT', by: 'arbiter', needsHuman: true, reason: 'model-proof failed: ruling not provably from Fable' } }],
  });
}

test('summary push: each outcome that needs the owner sends exactly one push with the right event and text', async () => {
  const cases = [
    { outcome: 'awaiting-owner-merge', state: summaryState(), label: 'Ready to merge', text: /^Ready to merge: Check the listed items, then say "merge" for head [0-9a-f]{7} \(widgets\)$/ },
    { outcome: 'needs-human', state: summaryState(), label: 'Needs you', text: /^Needs you: Read the needs-human comment and decide \(widgets\)$/ },
    { outcome: 'blocked', state: null, label: 'Run stopped', text: /^Run stopped: Verify stays red after 3 fixes: read the blocked comment \(widgets\)$/ },
    { outcome: 'awaiting-review', state: null, label: 'Run stopped', text: /^Run stopped: Codex review is unavailable: say "resume pipeline reviews" later \(widgets\)$/ },
    { outcome: 'stopped', state: null, label: 'Run stopped', text: /^Run stopped: Read the PR: the run stopped \(widgets\)$/ },
  ];
  for (const c of cases) {
    const repo = pushRepo(c.state);
    const t = await summaryIn(repo, ['--outcome', c.outcome]);
    assert.equal(t.error, undefined, c.outcome);
    assert.equal(t.res.exitCode, 0, c.outcome);
    assert.equal(t.rig.fetchCalls.length, 1, `${c.outcome}: one push`);
    const body = t.rig.fetchCalls[0].body;
    assert.equal(body.title, '#12 Add widget', c.outcome);
    assert.match(body.message, c.text, c.outcome);
    assert.equal(body.priority, 4);
    assert.equal(body.click, 'https://github.com/acme/widgets/pull/12', 'the click target is the PR, not the comment');
    assert.equal(t.res.output.notify.sent, true, c.outcome);
    assert.equal(t.res.output.ok, true);
    assert.match(t.res.output.agentLogLine, new RegExp(`· ${c.outcome}$`));
    assert.ok(!t.res.output.notify.errors && !JSON.stringify(t.res.output).includes(TOPIC));
  }
});

test('summary push: merged, closed, merged-externally and every prod-watch word never push', async () => {
  for (const outcome of ['merged', 'closed', 'merged-externally', 'recovered', 'superseded', 'rollback-failed', 'not-live', 'deploy-failed']) {
    const repo = pushRepo(['closed', 'merged-externally'].includes(outcome) ? null : summaryState());
    const t = await summaryIn(repo, ['--outcome', outcome]);
    assert.equal(t.error, undefined, outcome);
    assert.equal(t.res.exitCode, 0, outcome);
    assert.deepEqual(t.res.output.notify, { sent: false, reason: 'no-event' }, outcome);
    assert.equal(t.rig.fetchCalls.length, 0, outcome);
    assert.equal(t.stderr, '', `${outcome}: no warning for a classified word`);
  }
});

test('summary push: an unclassified outcome word sends nothing, says so in the JSON and warns once on stderr', async () => {
  const repo = pushRepo();
  const t = await summaryIn(repo, ['--outcome', 'progressing']);
  assert.equal(t.res.exitCode, 0, 'the comment is still posted');
  assert.deepEqual(t.res.output.notify, { sent: false, reason: 'unclassified-outcome' });
  assert.equal(t.rig.fetchCalls.length, 0);
  assert.equal(t.stderr.trim().split('\n').length, 1);
  assert.match(t.stderr, /outcome "progressing" is not classified for owner notifications/);
});

test('summary push: needs-human with an arbiter-parked item becomes an arbiter escalation naming ALL open items, arbiter ones first', async () => {
  const repo = pushRepo(needsHumanState());
  const t = await summaryIn(repo, ['--outcome', 'needs-human']);
  assert.equal(t.res.exitCode, 0);
  assert.equal(t.rig.fetchCalls.length, 1);
  const body = t.rig.fetchCalls[0].body;
  assert.equal(body.message, 'Arbiter escalation: Rule on F2, F3, F1 in the triage comment [items: F2, F3, F1] (widgets)');
  assert.ok(!body.message.includes('F4'), 'a settled item is not listed');
  assert.match(t.rig.ledger(), /"event":"arbiter-escalation"/);
});

test('summary push: needs-human with only judge/test-parked items stays a plain needs-human push that lists them', async () => {
  let s = emptyState({ repo: 'acme/widgets', pr: PR, branch: 'agent/feature', risk: 'medium' });
  s = addRound(s, { n: 1, fromHead: 'a', toHead: 'b', contentHashAtToHead: 'h1', items: [
    { id: 'F1', bucket: 'BLOCKING', title: 'x', fingerprint: 'fp1', final: { decision: 'REJECT', by: 'test', needsHuman: true, reason: 'test disproved, but it would dismiss a security/data item' } },
  ] });
  const t = await summaryIn(pushRepo(s), ['--outcome', 'needs-human']);
  assert.equal(t.rig.fetchCalls[0].body.message, 'Needs you: Read the needs-human comment and decide [items: F1] (widgets)');
});

test('summary push: --action and --cause flow into the event; --cause is part of the identity, --action is not', async () => {
  const repo = pushRepo(null);
  const rig = notifyRig();
  const a = await summaryIn(repo, ['--outcome', 'stopped', '--action', '- Final gate refused: a blocking label is set', '--cause', 'final-gate:labels'], { rig });
  assert.equal(a.res.exitCode, 0);
  assert.equal(rig.fetchCalls[0].body.message, 'Run stopped: - Final gate refused: a blocking label is set (widgets)', 'a value that starts with a dash is accepted');
  assert.match(rig.ledger(), /"event":"stopped"/);
  // the same stop, reworded: still one push
  const b = await summaryIn(repo, ['--outcome', 'stopped', '--action', 'Something else entirely', '--cause', 'final-gate:labels'], { rig, fake: summaryGh() });
  assert.equal(b.res.output.notify.reason, 'duplicate');
  assert.equal(rig.fetchCalls.length, 1);
  // a different cause on the same head is a new push
  const c = await summaryIn(repo, ['--outcome', 'stopped', '--action', 'Another', '--cause', 'merge:pre-merge'], { rig, fake: summaryGh() });
  assert.equal(c.res.output.notify.sent, true);
  assert.equal(rig.fetchCalls.length, 2);
  // an invalid cause is a usage error before anything is sent
  await assert.rejects(summaryIn(repo, ['--outcome', 'stopped', '--cause', 'bad cause!'], { rig }).then((r) => { if (r.error) throw r.error; }), /--cause must be a short code/);
});

test('summary push: `stopped`, `closed` and `merged-externally` work with no review state', async () => {
  for (const outcome of ['stopped', 'closed', 'merged-externally']) {
    const t = await summaryIn(pushRepo(null), ['--outcome', outcome]);
    assert.equal(t.error, undefined, outcome);
    assert.equal(t.res.exitCode, 0, outcome);
    assert.match(t.res.output.agentLogLine, new RegExp(`· rounds 0 · arbiter 0 · ${outcome}$`));
  }
  // other outcomes without state are still a usage error, and nothing is pushed
  const none = await summaryIn(pushRepo(null), ['--outcome', 'needs-human']);
  assert.match(none.error.message, /only --outcome blocked\|awaiting-review\|stopped\|closed\|merged-externally/);
  assert.equal(none.rig.fetchCalls.length, 0);
});

test('summary push: the title lookup failing still sends the push (no title), and the exit stays 3', async () => {
  const fake = createFakeGh([{ match: '^pr view 12 --json title', code: 1, stderr: 'HTTP 502' }]);
  const rig = notifyRig();
  rig.deps.lookup = async () => null; // notify's own bounded lookup finds nothing either
  const t = await summaryIn(pushRepo(), ['--outcome', 'awaiting-owner-merge'], { fake, rig });
  assert.ok(t.error instanceof UnavailableError, 'the unavailable-GitHub error (exit 3) is unchanged');
  assert.equal(rig.fetchCalls.length, 1);
  assert.equal(rig.fetchCalls[0].body.title, '#12');
  assert.match(rig.fetchCalls[0].body.message, /^Ready to merge: /);
  assert.equal(rig.fetchCalls[0].body.click, 'https://github.com/acme/widgets/pull/12', 'offline click target comes from the git remote');
});

test('summary push: the comment upsert failing (exit 3) still sends exactly one push, with the title already fetched', async () => {
  const fake = createFakeGh([
    { match: '^pr view 12 --json title', stdoutJson: { title: 'Add widget' } },
    ME, REPO,
    { match: '^api repos/acme/widgets/issues/12/comments --paginate', stdoutJson: [] },
    { match: '^api -X POST repos/acme/widgets/issues/12/comments', code: 1, stderr: 'HTTP 502' },
  ]);
  const rig = notifyRig();
  const repo = pushRepo();
  const t = await summaryIn(repo, ['--outcome', 'needs-human'], { fake, rig });
  assert.ok(t.error instanceof UnavailableError);
  assert.equal(rig.fetchCalls.length, 1);
  assert.equal(rig.fetchCalls[0].body.title, '#12 Add widget');
  // the retry after GitHub recovers is the same terminal state: no second push
  const again = await summaryIn(repo, ['--outcome', 'needs-human'], { rig });
  assert.equal(again.res.output.notify.reason, 'duplicate');
  assert.equal(rig.fetchCalls.length, 1);
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

test('agent-log queue: queueing the same line twice leaves one entry, also when the first copy is already staged in another open PR', () => {
  const t = logRepo();
  assert.equal(t.q('- same line').json.queued, 1);
  assert.equal(t.q('- same line').json.queued, 1);
  assertExit(t.stage('--line', '- this PR'), 0);
  const staged = readFileSync(t.queueFile(), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(staged.map((e) => [e.line, e.staged?.pr]), [['- same line', PR]]);
  assert.equal(t.q('- same line').json.queued, 1, 'a line staged in an open PR is not re-added');
  const after = readFileSync(t.queueFile(), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(after, staged, 'the staged entry is untouched');
  assert.equal(t.q('- another').json.queued, 2);
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
