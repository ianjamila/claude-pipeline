import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createTmpRepo } from './helpers/tmprepo.mjs';
import { createFakeGh, createFakeCodex, fullProtection, pipelineYml, REPO_VIEW } from './helpers/fakegh-env.mjs';
import { emptyState, saveState } from '../pipeline/lib/state.mjs';
import { MARKERS } from '../pipeline/lib/render.mjs';
import { applyCheckpoint, decodeRecord, emptyRecord, encodeRecord } from '../pipeline/lib/run-record.mjs';
import { assertExit } from './helpers/assert-exit.mjs';

const bin = join(dirname(fileURLToPath(import.meta.url)), '..', 'pipeline', 'bin', 'pipeline.mjs');

function repoWith(enforcement = 'github', checks) {
  const repo = createTmpRepo();
  repo.write('.claude/pipeline.yml', pipelineYml(enforcement, checks));
  repo.commit('init');
  return repo;
}

// Spawns the real CLI inside `repo` against a fake gh. The caller's own PIPELINE_* switches are scrubbed
// so a developer running these inside a pipeline session cannot change the outcome.
function cli(args, { repo, fake, env = {} }) {
  const base = { ...process.env, ...fake.env, ...env };
  if (!('PIPELINE_OFF' in env)) delete base.PIPELINE_OFF;
  if (!('PIPELINE_ADMIN' in env)) delete base.PIPELINE_ADMIN;
  const r = spawnSync(process.execPath, [bin, ...args], { cwd: repo.dir, env: base, encoding: 'utf8' });
  return { code: r.status, json: r.stdout ? JSON.parse(r.stdout) : null, stdout: r.stdout, stderr: r.stderr };
}

const REPO = { match: '^repo view', stdoutJson: REPO_VIEW };
const ME = { match: '^api user', stdout: 'me\n' };

// ---- labels ---------------------------------------------------------------------------------

test('labels ensure: creates missing labels, edits mismatched ones, leaves correct ones alone', () => {
  const repo = repoWith();
  const fake = createFakeGh([
    {
      match: '^label list',
      stdoutJson: [
        { name: 'needs-human', color: 'b60205', description: 'Waiting for the owner' },
        { name: 'awaiting-review', color: 'ffffff', description: 'Cross-model review pending (Codex unavailable)' },
        { name: 'Pipeline-Pause', color: '5319E7', description: 'Open issue with this label pauses all agent merges' },
        { name: 'agent-build', color: '1d76db', description: 'old description' },
        { name: 'unrelated', color: '000000', description: 'not ours' },
      ],
    },
    { match: '^label (create|edit) ', code: 0 },
  ]);
  const r = cli(['labels', 'ensure'], { repo, fake });
  assertExit(r, 0);
  assert.equal(r.json.ok, true);
  assert.deepEqual(r.json.unchanged.sort(), ['needs-human', 'pipeline-pause']);
  assert.deepEqual(r.json.updated.sort(), ['agent-build', 'awaiting-review']);
  assert.deepEqual(r.json.created.sort(), ['agent-suggestion', 'human-approved', 'pipeline-blocked', 'pipeline-rollback', 'test-change-approved']);
  const lines = fake.lines();
  assert.ok(lines.includes('label create pipeline-blocked --color d93f0b --description Verify could not be made green'));
  assert.ok(lines.includes('label edit awaiting-review --color fbca04 --description Cross-model review pending (Codex unavailable)'));
  assert.ok(lines.includes('label edit agent-build --color 1d76db --description Ask the pipeline to build this'));
  assert.ok(!lines.some((l) => /label (create|edit) (needs-human|pipeline-pause|unrelated)/i.test(l)));
});

test('labels ensure: a second run is a no-op once everything matches', () => {
  const repo = repoWith();
  const all = [
    ['needs-human', 'b60205', 'Waiting for the owner'],
    ['awaiting-review', 'fbca04', 'Cross-model review pending (Codex unavailable)'],
    ['pipeline-blocked', 'd93f0b', 'Verify could not be made green'],
    ['pipeline-pause', '5319e7', 'Open issue with this label pauses all agent merges'],
    ['pipeline-rollback', 'b60205', 'Production was rolled back; merges paused'],
    ['agent-suggestion', '0e8a16', 'Follow-up idea from the review loop'],
    ['agent-build', '1d76db', 'Ask the pipeline to build this'],
    ['human-approved', '0e8a16', 'Owner approved this head (hard-stop)'],
    ['test-change-approved', '0e8a16', 'Owner approved a test change'],
  ].map(([name, color, description]) => ({ name, color, description }));
  const fake = createFakeGh([{ match: '^label list', stdoutJson: all }]);
  const r = cli(['labels', 'ensure'], { repo, fake });
  assertExit(r, 0);
  assert.deepEqual([r.json.created, r.json.updated], [[], []]);
  assert.equal(r.json.unchanged.length, 9);
  assert.equal(fake.calls().length, 1);
});

test('labels ensure: a create that hits "already exists" falls back to an edit', () => {
  const repo = repoWith();
  const fake = createFakeGh([
    { match: '^label list', stdoutJson: [] },
    { match: '^label create needs-human', code: 1, stderr: 'label with name "needs-human" already exists' },
    { match: '^label (create|edit) ', code: 0 },
  ]);
  const r = cli(['labels', 'ensure'], { repo, fake });
  assertExit(r, 0);
  assert.ok(r.json.updated.includes('needs-human'));
  assert.ok(fake.lines().includes('label edit needs-human --color b60205 --description Waiting for the owner'));
});

test('labels: anything other than "ensure" is a usage error; a gh failure is exit 3', () => {
  const repo = repoWith();
  assertExit(cli(['labels'], { repo, fake: createFakeGh([]) }), 2);
  assertExit(cli(['labels', 'delete'], { repo, fake: createFakeGh([]) }), 2);
  const r = cli(['labels', 'ensure'], { repo, fake: createFakeGh([{ match: '.', code: 1, stderr: 'HTTP 401' }]) });
  assertExit(r, 3);
  assert.equal(r.json.ok, false);
});

// ---- preflight ------------------------------------------------------------------------------

const healthy = (over = []) => createFakeGh([
  ...over,
  { match: '^auth status', code: 0 },
  ME,
  REPO,
  { match: 'branches/main/protection', stdoutJson: fullProtection(['ci']) },
  { match: '^issue list', stdoutJson: [] },
]);

test('preflight exits 0 when the pipeline may merge', () => {
  const repo = repoWith('github');
  const r = cli(['preflight'], { repo, fake: healthy(), env: createFakeCodex().env });
  assertExit(r, 0);
  assert.equal(r.json.canMerge, true);
  assert.equal(r.json.enforcement.mode, 'github');
});

test('preflight exits 1 when it may not merge (declared github, protection missing)', () => {
  const repo = repoWith('github');
  const fake = healthy([{ match: 'protection', code: 1, stderr: 'gh: Upgrade to GitHub Pro or make this repository public to enable this feature. (HTTP 403)' }]);
  const r = cli(['preflight'], { repo, fake, env: createFakeCodex().env });
  assertExit(r, 1);
  assert.equal(r.json.canMerge, false);
  assert.equal(r.json.enforcement.mode, 'gate');
  assert.ok(r.json.reasons.length > 0);
});

test('preflight exits 1 under PIPELINE_OFF=1 and when a pause issue is open', () => {
  const repo = repoWith('github');
  const off = cli(['preflight'], { repo, fake: healthy(), env: { ...createFakeCodex().env, PIPELINE_OFF: '1' } });
  assertExit(off, 1);
  assert.equal(off.json.off, true);
  const paused = cli(['preflight'], {
    repo,
    fake: healthy([{ match: '^issue list --label pipeline-pause', stdoutJson: [{ number: 12, title: 'stop', url: 'u' }] }]),
    env: createFakeCodex().env,
  });
  assertExit(paused, 1);
  assert.equal(paused.json.pause.open, true);
});

test('preflight exits 2 when the config is missing or invalid', () => {
  const missing = createTmpRepo();
  missing.write('README.md', 'x');
  missing.commit('init');
  const a = cli(['preflight'], { repo: missing, fake: healthy(), env: createFakeCodex().env });
  assertExit(a, 2);
  assert.equal(a.json.config.ok, false);

  const invalid = createTmpRepo();
  invalid.write('.claude/pipeline.yml', 'version: 1\nbogus_key: true\n');
  invalid.commit('init');
  const b = cli(['preflight'], { repo: invalid, fake: healthy(), env: createFakeCodex().env });
  assertExit(b, 2);
});

// ---- comment --------------------------------------------------------------------------------

function stateRepo() {
  const repo = repoWith();
  saveState(repo.dir, emptyState({ repo: 'acme/widgets', pr: 4, branch: 'feat/x' }));
  return repo;
}

const commentWorld = (existing = []) => createFakeGh([
  REPO, ME,
  { match: '^pr view 4 --json', stdoutJson: { title: 'Add widget', headRefName: 'feat/w', baseRefName: 'main', headRefOid: 'a'.repeat(40) } },
  { match: 'issues/4/comments --paginate', stdoutJson: existing },
  { match: '^api -X PATCH repos/acme/widgets/issues/comments/(\\d+) ', stdoutJson: { id: 21, html_url: 'https://x/21' } },
  { match: '^api -X POST repos/acme/widgets/issues/4/comments ', stdoutJson: { id: 77, html_url: 'https://x/77' } },
]);

test('comment triage: PATCHes the existing marker comment with the rendered body', () => {
  const repo = stateRepo();
  const fake = commentWorld([{ id: 21, body: `${MARKERS.triage}\nold`, user: { login: 'me' } }]);
  const r = cli(['comment', '--pr', '4', '--kind', 'triage'], { repo, fake });
  assertExit(r, 0);
  assert.deepEqual([r.json.ok, r.json.action, r.json.url], [true, 'updated', 'https://x/21']);
  const patch = fake.calls().find((c) => c.argv.includes('PATCH'));
  assert.ok(JSON.parse(patch.stdin).body.startsWith(MARKERS.triage));
  assert.match(JSON.parse(patch.stdin).body, /Pipeline review triage/);
});

test('comment triage: POSTs a new comment when none carries the marker', () => {
  const repo = stateRepo();
  const fake = commentWorld([]);
  const r = cli(['comment', '--pr', '4', '--kind', 'triage'], { repo, fake });
  assertExit(r, 0);
  assert.equal(r.json.action, 'created');
  assert.ok(fake.lines().some((l) => l.startsWith('api -X POST repos/acme/widgets/issues/4/comments')));
});

test('comment triage and summary need review state: exit 2 without it', () => {
  const repo = repoWith();
  assertExit(cli(['comment', '--pr', '4', '--kind', 'triage'], { repo, fake: commentWorld() }), 2);
  assertExit(cli(['comment', '--pr', '4', '--kind', 'summary', '--outcome', 'merged'], { repo, fake: commentWorld() }), 2);
});

test('comment summary: passes outcome and built text into the body', () => {
  const repo = stateRepo();
  const fake = commentWorld();
  const r = cli(['comment', '--pr', '4', '--kind', 'summary', '--outcome', 'merged', '--built', 'Added the widget'], { repo, fake });
  assertExit(r, 0);
  const post = fake.calls().find((c) => c.argv.includes('POST'));
  const body = JSON.parse(post.stdin).body;
  assert.ok(body.startsWith(MARKERS.summary));
  assert.match(body, /Added the widget/);
  assert.match(body, /\*\*merged\*\*/);
  // the same comment carries the run record: this run ended `merged`
  const decoded = decodeRecord(body);
  assert.equal(decoded.status, 'ok');
  assert.deepEqual([decoded.record.outcome, decoded.record.step, decoded.record.branch, decoded.record.pr], ['merged', 'ended', 'feat/w', 4]);
  assert.deepEqual(r.json.warnings, []);
  // --outcome is required for a summary
  assertExit(cli(['comment', '--pr', '4', '--kind', 'summary'], { repo, fake: commentWorld() }), 2);
});

test('comment summary: keeps the run record a checkpoint wrote (tasks survive) and PATCHes the one comment', () => {
  const repo = stateRepo();
  const rec = applyCheckpoint(emptyRecord({ repo: 'acme/widgets', pr: 4, branch: 'feat/w', baseRef: 'main' }), {
    step: 'review', round: 2, tasks: [{ id: 'T1', title: 'one', spec: 's1', done: true }],
  }, { host: 'mac', now: 0 });
  const existing = () => [{ id: 21, body: `${MARKERS.summary}\n\n${encodeRecord(rec)}`, user: { login: 'me' } }];
  const fake = commentWorld(existing());
  const r = cli(['comment', '--pr', '4', '--kind', 'summary', '--outcome', 'awaiting-owner-merge'], { repo, fake });
  assertExit(r, 0);
  assert.equal(r.json.action, 'updated');
  const sent = decodeRecord(JSON.parse(fake.calls().find((c) => c.argv.includes('PATCH')).stdin).body);
  assert.equal(sent.status, 'ok');
  assert.deepEqual(sent.record.tasks, rec.tasks);
  assert.deepEqual([sent.record.outcome, sent.record.step, sent.record.round], ['awaiting-owner-merge', 'awaiting-owner-merge', 2]);
  // an outcome the record does not know is rendered, warned about, and never recorded
  const odd = cli(['comment', '--pr', '4', '--kind', 'summary', '--outcome', 'wild'], { repo, fake: commentWorld(existing()) });
  assertExit(odd, 0);
  assert.equal(odd.json.warnings.length, 1);
});

test('comment blocked: renders from .verify/report.json', () => {
  const repo = repoWith();
  repo.write('.verify/report.json', JSON.stringify({
    version: 1, mode: 'full', ok: false, git: { head: 'abcdef1234567' },
    steps: [{ name: 'unit', status: 'fail', durationMs: 1200, command: 'npm test', exitCode: 1, errorExcerpt: 'expected 1 got 2' }],
  }));
  const fake = commentWorld();
  const r = cli(['comment', '--pr', '4', '--kind', 'blocked'], { repo, fake });
  assertExit(r, 0);
  const body = JSON.parse(fake.calls().find((c) => c.argv.includes('POST')).stdin).body;
  assert.ok(body.startsWith(MARKERS.blocked));
  assert.match(body, /expected 1 got 2/);
  // no report -> exit 2
  assertExit(cli(['comment', '--pr', '4', '--kind', 'blocked'], { repo: repoWith(), fake: commentWorld() }), 2);
});

test('comment needs-human: reason, hard-stop hits from --hits-file, and state', () => {
  const repo = stateRepo();
  const hits = join(repo.dir, 'hits.json');
  writeFileSync(hits, JSON.stringify({ ok: false, hits: [{ rule: 'migration', file: 'supabase/migrations/1.sql' }] }));
  const fake = commentWorld();
  const r = cli(['comment', '--pr', '4', '--kind', 'needs-human', '--reason', 'touches a migration', '--hits-file', hits], { repo, fake });
  assertExit(r, 0);
  const body = JSON.parse(fake.calls().find((c) => c.argv.includes('POST')).stdin).body;
  assert.ok(body.startsWith(MARKERS.needsHuman));
  assert.match(body, /touches a migration/);
  assert.match(body, /migration — supabase\/migrations\/1\.sql/);
  assertExit(cli(['comment', '--pr', '4', '--kind', 'needs-human'], { repo, fake: commentWorld() }), 2);
});

test('comment needs-human: a P hardstops object lists only its blocking hits, never the report-only ones', () => {
  const repo = stateRepo();
  const hits = join(repo.dir, 'hits.json');
  const blocking = [{ rule: 'R1-destructive', file: 'supabase/migrations/1.sql' }];
  const advisory = [{ rule: 'R6-sensitive', file: 'lib/payroll/a.ts', advisory: true }];
  writeFileSync(hits, JSON.stringify({ ok: false, hits: [...blocking, ...advisory], blocking, advisory }));
  const fake = commentWorld();
  assertExit(cli(['comment', '--pr', '4', '--kind', 'needs-human', '--reason', 'drops a table', '--hits-file', hits], { repo, fake }), 0);
  const body = JSON.parse(fake.calls().find((c) => c.argv.includes('POST')).stdin).body;
  assert.match(body, /R1-destructive — supabase\/migrations\/1\.sql/);
  assert.doesNotMatch(body, /R6-sensitive/);
});

test('comment needs-human: advisory hits are dropped from a bare array and from a {hits:[...]} object, whatever the format', () => {
  const blocking = { rule: 'R1-destructive', file: 'supabase/migrations/1.sql' };
  const advisory = { rule: 'R6-sensitive', file: 'lib/payroll/a.ts', advisory: true };
  for (const [name, content] of [['array', [blocking, advisory]], ['hits object', { ok: false, hits: [blocking, advisory] }]]) {
    const repo = stateRepo();
    const hits = join(repo.dir, 'hits.json');
    writeFileSync(hits, JSON.stringify(content));
    const fake = commentWorld();
    assertExit(cli(['comment', '--pr', '4', '--kind', 'needs-human', '--reason', 'drops a table', '--hits-file', hits], { repo, fake }), 0);
    const body = JSON.parse(fake.calls().find((c) => c.argv.includes('POST')).stdin).body;
    assert.match(body, /R1-destructive — supabase\/migrations\/1\.sql/, name);
    assert.doesNotMatch(body, /R6-sensitive/, name);
  }
});

test('comment awaiting-review: carries the reason', () => {
  const repo = repoWith();
  const fake = commentWorld();
  const r = cli(['comment', '--pr', '4', '--kind', 'awaiting-review', '--reason', 'Codex quota exhausted'], { repo, fake });
  assertExit(r, 0);
  const body = JSON.parse(fake.calls().find((c) => c.argv.includes('POST')).stdin).body;
  assert.ok(body.startsWith(MARKERS.awaitingReview));
  assert.match(body, /Codex quota exhausted/);
});

test('comment: bad arguments are usage errors, a gh failure is exit 3', () => {
  const repo = stateRepo();
  const fake = commentWorld();
  assertExit(cli(['comment', '--kind', 'triage'], { repo, fake }), 2);
  assertExit(cli(['comment', '--pr', 'x', '--kind', 'triage'], { repo, fake }), 2);
  assertExit(cli(['comment', '--pr', '4', '--kind', 'bogus'], { repo, fake }), 2);
  assertExit(cli(['comment', '--pr', '4'], { repo, fake }), 2);
  assertExit(cli(['comment', '--pr', '4', '--kind', 'triage'], { repo, fake: createFakeGh([{ match: '.', code: 1, stderr: 'HTTP 500' }]) }), 3);
});

// ---- deploy url -----------------------------------------------------------------------------

const SHA = 'a'.repeat(40);
const deployArgs = (...extra) => ['deploy', 'url', '--sha', SHA, '--environment', 'Preview', '--timeout', '0', ...extra];

test('deploy url: success exits 0 with the URL', () => {
  const fake = createFakeGh([
    REPO,
    { match: 'deployments\\?sha=', stdoutJson: [{ id: 7, sha: SHA, created_at: '2026-10-01T00:00:00Z' }] },
    { match: 'deployments/7/statuses', stdoutJson: [{ state: 'success', environment_url: 'https://preview.example' }] },
  ]);
  const r = cli(deployArgs(), { repo: repoWith(), fake });
  assertExit(r, 0);
  assert.deepEqual([r.json.ok, r.json.url, r.json.id], [true, 'https://preview.example', 7]);
  assert.ok(fake.lines().includes(`api repos/acme/widgets/deployments?sha=${SHA}&environment=Preview&per_page=30`));
});

test('deploy url: a failed deployment exits 1', () => {
  const fake = createFakeGh([
    REPO,
    { match: 'deployments\\?sha=', stdoutJson: [{ id: 7, sha: SHA }] },
    { match: 'deployments/7/statuses', stdoutJson: [{ state: 'failure', log_url: 'https://logs.example' }] },
  ]);
  const r = cli(deployArgs(), { repo: repoWith(), fake });
  assertExit(r, 1);
  assert.deepEqual([r.json.ok, r.json.state, r.json.url], [false, 'failure', 'https://logs.example']);
});

test('deploy url: no deployment in time exits 3', () => {
  const fake = createFakeGh([REPO, { match: 'deployments\\?sha=', stdoutJson: [] }]);
  const r = cli(deployArgs(), { repo: repoWith(), fake });
  assertExit(r, 3);
  assert.equal(r.json.state, 'timeout');
});

test('deploy url: a still-pending deployment is polled again and then times out (exit 3)', () => {
  const fake = createFakeGh([
    REPO,
    { match: 'deployments\\?sha=', stdoutJson: [{ id: 7, sha: SHA }] },
    { match: 'deployments/7/statuses', stdoutJson: [{ state: 'in_progress' }] },
  ]);
  // A 6 s budget with a 1 s poll: each loop spawns the fake gh twice, and under machine load one loop alone can take over a
  // second, so `--timeout 1` timed out before a second poll could happen (flake, not a product bug).
  const r = cli(['deploy', 'url', '--sha', SHA, '--environment', 'Preview', '--timeout', '6', '--poll', '1'], { repo: repoWith(), fake });
  assertExit(r, 3);
  assert.ok(fake.lines().filter((l) => l.includes('/statuses')).length >= 2);
});

test('deploy url: usage errors (missing flags, short sha) exit 2', () => {
  const repo = repoWith();
  const fake = createFakeGh([]);
  assertExit(cli(['deploy', 'url', '--environment', 'Preview'], { repo, fake }), 2);
  assertExit(cli(['deploy', 'url', '--sha', SHA], { repo, fake }), 2);
  assertExit(cli(['deploy', 'url', '--sha', 'abc123', '--environment', 'P'], { repo, fake }), 2);
  assertExit(cli(['deploy', '--sha', SHA, '--environment', 'P'], { repo, fake }), 2);
  assert.equal(fake.calls().length, 0);
});

// ---- resume ---------------------------------------------------------------------------------

test('resume list: open PRs labelled awaiting-review', () => {
  const fake = createFakeGh([{
    match: '^pr list --label awaiting-review --state open',
    stdoutJson: [{ number: 5, title: 'Add widget', headRefName: 'feat/widget', url: 'https://github.com/acme/widgets/pull/5', labels: [] }],
  }]);
  const r = cli(['resume', 'list'], { repo: repoWith(), fake });
  assertExit(r, 0);
  assert.deepEqual(r.json, { ok: true, prs: [{ number: 5, title: 'Add widget', headRefName: 'feat/widget', url: 'https://github.com/acme/widgets/pull/5' }] });
  assertExit(cli(['resume'], { repo: repoWith(), fake }), 2);
});

// ---- protect --------------------------------------------------------------------------------

const PROTECTION_PAYLOAD = {
  required_status_checks: { strict: false, checks: [{ context: 'ci' }, { context: 'e2e' }] },
  enforce_admins: true,
  required_pull_request_reviews: { required_approving_review_count: 0, dismiss_stale_reviews: false, require_code_owner_reviews: false },
  restrictions: null,
  required_linear_history: true,
  allow_force_pushes: false,
  allow_deletions: false,
  required_conversation_resolution: false,
};

test('protect (dry run): prints the exact spec 6.6 payloads and changes nothing', () => {
  const fake = createFakeGh([REPO]);
  const r = cli(['protect', '--checks', 'ci,e2e'], { repo: repoWith(), fake });
  assertExit(r, 0);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.applied, false);
  assert.equal(r.json.commands.length, 3);
  const [protection, settings, workflow] = r.json.requests;
  assert.deepEqual([protection.method, protection.path], ['PUT', 'repos/acme/widgets/branches/main/protection']);
  assert.deepEqual(protection.body, PROTECTION_PAYLOAD);
  assert.deepEqual([settings.method, settings.path], ['PATCH', 'repos/acme/widgets']);
  assert.deepEqual(settings.body, {
    allow_auto_merge: true, allow_squash_merge: true, allow_merge_commit: false, allow_rebase_merge: false, delete_branch_on_merge: true,
  });
  assert.deepEqual([workflow.method, workflow.path], ['PUT', 'repos/acme/widgets/actions/permissions/workflow']);
  assert.deepEqual(workflow.body, { default_workflow_permissions: 'read', can_approve_pull_request_reviews: false });
  // The printed commands carry the same JSON, ready to paste.
  assert.ok(r.json.commands[0].startsWith("gh api -X PUT repos/acme/widgets/branches/main/protection --input - <<'JSON'\n"));
  const printed = r.json.commands[0].split('\n').slice(1, -1).join('\n');
  assert.deepEqual(JSON.parse(printed), PROTECTION_PAYLOAD);
  assert.ok(r.json.commands[1].startsWith("gh api -X PATCH repos/acme/widgets --input - <<'JSON'\n"));
  assert.ok(r.json.commands[2].startsWith("gh api -X PUT repos/acme/widgets/actions/permissions/workflow --input - <<'JSON'\n"));
  // Only the repo lookup ran: no write.
  assert.deepEqual(fake.lines(), ['repo view --json nameWithOwner,defaultBranchRef']);
});

test('protect: checks default to ci.required_checks; none at all is a usage error', () => {
  const fake = createFakeGh([REPO]);
  const fromConfig = cli(['protect'], { repo: repoWith('github', ['ci', 'build']), fake });
  assertExit(fromConfig, 0);
  assert.deepEqual(fromConfig.json.requests[0].body.required_status_checks.checks, [{ context: 'ci' }, { context: 'build' }]);
  const none = cli(['protect'], { repo: repoWith('github', []), fake });
  assertExit(none, 2);
  assert.match(none.json.message, /no required checks/);
  assertExit(cli(['protect', '--checks', ' , '], { repo: repoWith(), fake }), 2);
});

test('protect: the guard contexts are added to the config list (and are enough on their own) unless ci.guard_checks is false', () => {
  const fake = createFakeGh([REPO]);
  const repo = createTmpRepo();
  repo.write('.claude/pipeline.yml', pipelineYml('github', ['ci'], { guardChecks: true }));
  repo.commit('init');
  const r = cli(['protect'], { repo, fake });
  assertExit(r, 0);
  assert.deepEqual(r.json.requests[0].body.required_status_checks.checks.map((c) => c.context), ['ci', 'Test integrity', 'Hard-stop scan']);
  const bare = createTmpRepo();
  bare.write('.claude/pipeline.yml', pipelineYml('github', [], { guardChecks: true }));
  bare.commit('init');
  assert.deepEqual(cli(['protect'], { repo: bare, fake }).json.checks, ['Test integrity', 'Hard-stop scan']);
  // an explicit --checks is taken exactly as given
  assert.deepEqual(cli(['protect', '--checks', 'x'], { repo, fake }).json.checks, ['x']);
});

const writeEntries = [
  { match: '^api -X PUT repos/acme/widgets/branches/main/protection ', stdoutJson: {} },
  { match: '^api -X PATCH repos/acme/widgets ', stdoutJson: {} },
  { match: '^api -X PUT repos/acme/widgets/actions/permissions/workflow ', code: 0 },
];

test('protect --apply without PIPELINE_ADMIN=1 is refused (exit 2) before any gh call', () => {
  const fake = createFakeGh([REPO, ...writeEntries]);
  const r = cli(['protect', '--apply'], { repo: repoWith(), fake });
  assertExit(r, 2);
  assert.match(r.json.message, /PIPELINE_ADMIN=1/);
  assert.equal(fake.calls().length, 0);
  const wrong = cli(['protect', '--apply'], { repo: repoWith(), fake, env: { PIPELINE_ADMIN: 'yes' } });
  assertExit(wrong, 2);
});

test('protect --apply with PIPELINE_ADMIN=1: PUT, PATCH, PUT in order, then read back', () => {
  const fake = createFakeGh([
    REPO,
    ...writeEntries,
    { match: '^api repos/acme/widgets/branches/main/protection$', stdoutJson: fullProtection(['ci', 'e2e']) },
  ]);
  const r = cli(['protect', '--apply', '--checks', 'ci,e2e'], { repo: repoWith(), fake, env: { PIPELINE_ADMIN: '1' } });
  assertExit(r, 0);
  assert.deepEqual([r.json.ok, r.json.applied, r.json.mode, r.json.missing], [true, true, 'github', []]);
  const calls = fake.calls();
  const writes = calls.filter((c) => c.argv.includes('-X'));
  assert.deepEqual(writes.map((c) => `${c.argv[c.argv.indexOf('-X') + 1]} ${c.argv[c.argv.indexOf('-X') + 2]}`), [
    'PUT repos/acme/widgets/branches/main/protection',
    'PATCH repos/acme/widgets',
    'PUT repos/acme/widgets/actions/permissions/workflow',
  ]);
  assert.deepEqual(JSON.parse(writes[0].stdin), PROTECTION_PAYLOAD);
  assert.equal(JSON.parse(writes[1].stdin).allow_merge_commit, false);
  assert.equal(JSON.parse(writes[2].stdin).default_workflow_permissions, 'read');
  // the read-back is the last call
  assert.equal(calls.at(-1).argv.join(' '), 'api repos/acme/widgets/branches/main/protection');
});

test('protect --apply: a read-back that still misses settings is not ok (exit 1)', () => {
  const weak = fullProtection(['ci']);
  weak.enforce_admins = { enabled: false };
  const fake = createFakeGh([REPO, ...writeEntries, { match: '^api repos/acme/widgets/branches/main/protection$', stdoutJson: weak }]);
  const r = cli(['protect', '--apply', '--checks', 'ci'], { repo: repoWith(), fake, env: { PIPELINE_ADMIN: '1' } });
  assertExit(r, 1);
  assert.deepEqual([r.json.ok, r.json.mode, r.json.missing], [false, 'gate', ['enforce_admins']]);
});

test('protect --apply: 403 on a free plan is exit 1 with reason plan (and stops at the first write)', () => {
  const fake = createFakeGh([
    REPO,
    {
      match: '^api -X PUT repos/acme/widgets/branches/main/protection ',
      code: 1,
      stderr: 'gh: Upgrade to GitHub Pro or make this repository public to enable this feature. (HTTP 403)',
    },
    ...writeEntries,
  ]);
  const r = cli(['protect', '--apply', '--checks', 'ci'], { repo: repoWith(), fake, env: { PIPELINE_ADMIN: '1' } });
  assertExit(r, 1);
  assert.deepEqual([r.json.ok, r.json.applied, r.json.reason], [false, false, 'plan']);
  assert.match(r.json.message, /GitHub Pro required for private repos/);
  assert.equal(fake.calls().filter((c) => c.argv.includes('-X')).length, 1);
});

test('protect --apply: 403 without admin rights is exit 1 with reason permission and the commands to run', () => {
  const fake = createFakeGh([
    REPO,
    { match: '^api -X PUT repos/acme/widgets/branches/main/protection ', stdoutJson: {} },
    { match: '^api -X PATCH repos/acme/widgets ', code: 1, stderr: 'gh: Must have admin rights to Repository. (HTTP 403)' },
  ]);
  const r = cli(['protect', '--apply', '--checks', 'ci'], { repo: repoWith(), fake, env: { PIPELINE_ADMIN: '1' } });
  assertExit(r, 1);
  assert.equal(r.json.reason, 'permission');
  assert.equal(r.json.failedStep, 'repo-settings');
  assert.deepEqual(r.json.completed, ['branch-protection']);
  assert.equal(r.json.commands.length, 3);
});

test('protect --apply: a non-403 failure is exit 3, not a pass', () => {
  const fake = createFakeGh([REPO, { match: '^api -X PUT ', code: 1, stderr: 'gh: Server Error (HTTP 502)' }]);
  const r = cli(['protect', '--apply', '--checks', 'ci'], { repo: repoWith(), fake, env: { PIPELINE_ADMIN: '1' } });
  assertExit(r, 3);
  assert.equal(r.json.ok, false);
});
