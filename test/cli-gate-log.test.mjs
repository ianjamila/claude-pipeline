// summary and agent-log: the PR summary comment + log line, and the queue/publish flow for the agent log (the publish command itself is
// covered against a real origin in agent-log-publish.test.mjs).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTmpRepo } from './helpers/tmprepo.mjs';
import { createFakeGh, pipelineYml } from './helpers/fakegh-env.mjs';
import { cli, PR, AGENT_LOG, ME, REPO } from './helpers/gate-env.mjs';
import { addRound, emptyState, saveState } from '../pipeline/lib/state.mjs';
import { MARKERS } from '../pipeline/lib/render.mjs';
import { applyCheckpoint, decodeRecord, emptyRecord, encodeRecord } from '../pipeline/lib/run-record.mjs';
import { listEvents, openOwnerStops, renderEvent } from '../pipeline/lib/run-events.mjs';
import { assertExit } from './helpers/assert-exit.mjs';
import { run as summaryRun } from '../pipeline/commands/summary.mjs';
import { UnavailableError } from '../pipeline/lib/cli.mjs';
import { LEDGER_NAME } from '../pipeline/lib/notify.mjs';
import { ownerStopsDir } from '../pipeline/lib/owner-stop.mjs';

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
    platform: 'linux',
    hostname: () => 'testbox',
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

// Owner-stop seams for in-process runs: a private home (pending files, locks), the repo identity without a git remote, a fixed stop id.
function stopRig({ disarm = () => true } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'cp-summary-stops-'));
  scratchDirs.push(home);
  const calls = [];
  return {
    home, calls,
    deps: { home, remoteUrl: () => 'git@github.com:acme/widgets.git', newId: () => '5f3a9c2e', hostname: () => 'testbox', lock: { waitMs: 2000, pollMs: 5 }, disableAutoMerge: (a) => { calls.push(a.pr); return disarm(a); } },
    heldFiles: () => (existsSync(ownerStopsDir(home)) ? readdirSync(ownerStopsDir(home)) : []),
  };
}

async function summaryIn(repo, args, { fake = summaryGh(), rig = notifyRig(), stops = stopRig() } = {}) {
  const stderr = [];
  const orig = process.stderr.write;
  process.stderr.write = (c, ...rest) => { stderr.push(String(c)); return true; };
  try {
    const argv = ['--pr', String(PR), ...args];
    const ctx = { cwd: repo.dir, env: { ...process.env, ...fake.env }, notifyDeps: rig.deps, ownerStopDeps: stops.deps };
    let res;
    let error;
    try {
      res = await summaryRun(argv, ctx);
    } catch (err) {
      error = err;
    }
    return { res, error, rig, fake, stops, stderr: stderr.join('') };
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
    assert.equal(body.title, '[testbox] #12 Add widget', c.outcome);
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
  assert.equal(rig.fetchCalls[0].body.title, '[testbox] #12');
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
  assert.equal(rig.fetchCalls[0].body.title, '[testbox] #12 Add widget');
  // the retry after GitHub recovers is the same terminal state: no second push
  const again = await summaryIn(repo, ['--outcome', 'needs-human'], { rig });
  assert.equal(again.res.output.notify.reason, 'duplicate');
  assert.equal(rig.fetchCalls.length, 1);
});

// ---- summary: owner stops (owner_approval: chat) ---------------------------------------------------
// The stop is an append-only event; the record holds a display copy and the mode-aware "next" text. Nothing here may clear a stop.

const CHAT_YML = `${pipelineYml()}owner_approval: chat\n`;
const STOP = { id: 'ab12cd34', cause: 'merge:command-failed', head: 'a'.repeat(40), at: '2026-10-20T08:00:00.000Z' };
const stopEvent = (cid = 3) => ({ id: cid, user: { login: 'me' }, body: renderEvent('owner-stop', STOP.id, 'Owner stop ab12cd34 on #12.', { repo: 'acme/widgets', pr: PR, ...STOP }) });
const summaryComment = (record, id = 9) => ({ id, user: { login: 'me' }, body: `${MARKERS.summary}\n\nold sections${record ? `\n\n${encodeRecord(record)}` : ''}` });
const ID12 = { repo: 'acme/widgets', pr: PR, branch: 'agent/feature', baseRef: 'main' };
const stoppedRecord = () => applyCheckpoint(emptyRecord(ID12), { step: 'review', ownerStop: STOP }, { host: 'mac', now: 0 });
const chatRepo = (yml = CHAT_YML) => {
  const repo = pushRepo();
  repo.write('.claude/pipeline.yml', yml);
  return repo;
};
const writesOf = (fake) => fake.calls().filter((c) => c.argv.includes('POST') || c.argv.includes('PATCH')).map((c) => ({ call: c, body: JSON.parse(c.stdin).body }));
const posted = (fake) => decodeRecord(writesOf(fake).find((w) => w.body.startsWith(MARKERS.summary)).body);

test('summary --outcome needs-human: "next" follows owner_approval (label text unchanged; chat text; unreadable config falls back to label)', async () => {
  const label = await summaryIn(pushRepo(), ['--outcome', 'needs-human']);
  const rl = posted(label.fake).record;
  assert.deepEqual([rl.v, rl.next, 'ownerStop' in rl], [1, 'owner review: add `human-approved`, then merge', false], 'label mode: no copy, version 1');
  const chat = await summaryIn(chatRepo(), ['--outcome', 'needs-human']);
  const rc = posted(chat.fake).record;
  assert.equal(rc.outcome, 'needs-human');
  assert.equal(rc.next, 'owner reply needed in chat (stop 5f3a9c2e): ship resume 12');
  const broken = await summaryIn(chatRepo('version: 1\nbogus_key: true\nowner_approval: chat\n'), ['--outcome', 'needs-human']);
  assert.equal(posted(broken.fake).record.next, 'owner review: add `human-approved`, then merge', 'an unreadable config is label behaviour, as today');
  const other = await summaryIn(chatRepo(), ['--outcome', 'stopped']);
  assert.equal(posted(other.fake).record.next, 'clear what stopped the run (see the action), then resume', 'chat changes needs-human only');
});

test('summary --outcome stopped after a stop: the event stays open however the record is replaced, blanked or hand-edited', async () => {
  const variants = {
    'record with the copy': summaryComment(stoppedRecord()),
    'copy hand-removed': summaryComment(applyCheckpoint(stoppedRecord(), { ownerStop: null }, { host: 'mac', now: 0 })),
    'record blanked (marker only)': summaryComment(null),
    'record replaced by an unrelated one': summaryComment(applyCheckpoint(emptyRecord({ ...ID12, pr: 99 }), { step: 'verify' }, { host: 'mac', now: 0 })),
  };
  for (const [what, existing] of Object.entries(variants)) {
    const fake = summaryGh([stopEvent(), existing]);
    const t = await summaryIn(chatRepo(), ['--outcome', 'stopped'], { fake });
    assert.equal(t.error, undefined, what);
    const writes = fake.calls().filter((c) => c.argv.includes('POST') || c.argv.includes('PATCH'));
    assert.equal(writes.length, 1, `${what}: exactly one write`);
    assert.match(writes[0].argv.join(' '), /issues\/comments\/9\b|issues\/12\/comments\b/, `${what}: only the summary comment is written`);
    // re-read GitHub as it stands after the write
    const after = [stopEvent()];
    if (writes[0].argv.includes('PATCH')) after.push({ ...existing, body: JSON.parse(writes[0].stdin).body });
    assert.deepEqual(openOwnerStops(listEvents(after, 'me')).map((e) => e.id), [STOP.id], `${what}: the stop is still open`);
  }
  // the copy is display only: an ordinary outcome neither clears it nor, without it, invents one
  const keep = await summaryIn(chatRepo(), ['--outcome', 'stopped'], { fake: summaryGh([stopEvent(), variants['record with the copy']]) });
  const kept = posted(keep.fake).record;
  assert.deepEqual([kept.ownerStop, kept.v], [STOP, 2]);
  const none = await summaryIn(chatRepo(), ['--outcome', 'stopped'], { fake: summaryGh([stopEvent(), variants['copy hand-removed']]) });
  assert.deepEqual(['ownerStop' in posted(none.fake).record, posted(none.fake).record.v], [false, 1]);
});

// T2: chat + needs-human creates the stop (event first, then the summary); label mode is untouched.
test('summary --outcome needs-human in chat: the owner-stop event is posted before the summary, the reply and copy are returned, no label, the push names the way out', async () => {
  const t = await summaryIn(chatRepo(), ['--outcome', 'needs-human', '--cause', 'merge:command-failed']);
  assert.equal(t.error, undefined);
  assert.equal(t.res.exitCode, 0);
  const writes = writesOf(t.fake);
  assert.equal(writes.length, 2);
  assert.ok(writes[0].body.startsWith('<!-- claude-pipeline:event:owner-stop:5f3a9c2e -->'), 'the event comes first');
  assert.ok(writes[1].body.startsWith(MARKERS.summary));
  assert.ok(!t.fake.lines().some((l) => /label/.test(l)), 'no label call');
  assert.equal(t.res.output.ownerStop.id, '5f3a9c2e');
  assert.equal(t.res.output.ownerStop.cause, 'merge:command-failed');
  assert.equal(t.res.output.reply, 'Stopped #12 · stop 5f3a9c2e\n⏸ Waiting on you for #12 — rule in chat, then say "ship resume 12"');
  const rec = posted(t.fake).record;
  assert.deepEqual([rec.v, rec.ownerStop.id, rec.next], [2, '5f3a9c2e', 'owner reply needed in chat (stop 5f3a9c2e): ship resume 12']);
  assert.deepEqual(t.stops.heldFiles(), [], 'the pending file is gone once the event posted');
  assert.deepEqual(t.stops.calls, [12], 'auto-merge was disarmed');
  assert.equal(t.rig.fetchCalls.length, 1);
  assert.equal(t.rig.fetchCalls[0].body.message, 'Needs you: Rule in chat, then say "ship resume 12" (widgets)');
});

test('summary --outcome needs-human in chat: an open stop is reused (no second event); other outcomes never create one', async () => {
  const again = await summaryIn(chatRepo(), ['--outcome', 'needs-human'], { fake: summaryGh([stopEvent()]) });
  assert.equal(again.res.output.ownerStop.id, STOP.id, 'the existing stop, not a new id');
  assert.equal(writesOf(again.fake).filter((w) => w.body.includes('claude-pipeline:event:')).length, 0, 'no second event');
  const stopped = await summaryIn(chatRepo(), ['--outcome', 'stopped']);
  assert.equal(writesOf(stopped.fake).filter((w) => w.body.includes('claude-pipeline:event:')).length, 0);
  assert.equal(stopped.res.output.ownerStop, undefined);
  assert.deepEqual(stopped.stops.calls, []);
});

test('summary --outcome needs-human in label mode: no event, no pending file, no disarm, no reply (unchanged)', async () => {
  const t = await summaryIn(pushRepo(), ['--outcome', 'needs-human']);
  assert.equal(t.res.exitCode, 0);
  assert.equal(writesOf(t.fake).length, 1);
  assert.deepEqual([t.res.output.ownerStop, t.res.output.reply, t.stops.calls, t.stops.heldFiles()], [undefined, undefined, [], []]);
  assert.equal(t.rig.fetchCalls[0].body.message, 'Needs you: Read the needs-human comment and decide (widgets)');
});

test('summary --outcome needs-human in chat, GitHub unreadable at the stop: exit 3, one push, the pending file stays, the reply goes to stderr', async () => {
  const fake = createFakeGh([
    { match: '^pr view 12 --json title', stdoutJson: { title: 'Add widget' } },
    ME, REPO,
    { match: '^api repos/acme/widgets/issues/12/comments --paginate', code: 1, stderr: 'HTTP 502' },
  ]);
  const t = await summaryIn(chatRepo(), ['--outcome', 'needs-human'], { fake });
  assert.ok(t.error instanceof UnavailableError);
  assert.match(t.error.message, /owner stop 5f3a9c2e is held locally/);
  assert.match(t.stderr, /Stopped #12 · stop 5f3a9c2e\n⏸ Waiting on you for #12/);
  assert.equal(t.rig.fetchCalls.length, 1, 'the push is still sent');
  assert.deepEqual(t.stops.heldFiles(), ['acme__widgets__12__5f3a9c2e.json']);
});

test('summary --outcome needs-human in chat: the summary comment failing to write is a warning only; the stop stands and the reply is returned', async () => {
  const fake = createFakeGh([
    { match: '^pr view 12 --json title', stdoutJson: { title: 'Add widget' } },
    ME, REPO,
    { match: '^api repos/acme/widgets/issues/12/comments --paginate', stdoutJson: [summaryComment(null)] },
    { match: '^api -X POST repos/acme/widgets/issues/12/comments', stdoutJson: { id: 5, html_url: 'https://github.com/acme/widgets/pull/12#issuecomment-5' } },
    { match: '^api -X PATCH repos/acme/widgets/issues/comments/9', code: 1, stderr: 'HTTP 502' },
  ]);
  const t = await summaryIn(chatRepo(), ['--outcome', 'needs-human'], { fake });
  assert.equal(t.error, undefined);
  assert.equal(t.res.exitCode, 0);
  assert.match(t.res.output.warnings[0], /summary comment not written.*owner stop 5f3a9c2e stands on GitHub/);
  assert.equal(t.res.output.ownerStop.id, '5f3a9c2e');
  assert.match(t.res.output.reply, /^Stopped #12 · stop 5f3a9c2e/);
  assert.equal(writesOf(fake).filter((w) => w.body.includes('claude-pipeline:event:owner-stop:5f3a9c2e')).length, 1);
  assert.deepEqual(t.stops.heldFiles(), []);
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
