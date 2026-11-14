// `pipeline round publish` (plan C §3) and the §4 lock check of the two side-by-side pairs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { roundWorld, findingsOf, low } from './helpers/round-world.mjs';
import { assertExit } from './helpers/assert-exit.mjs';
import { publishSteps } from '../pipeline/commands/round.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const bin = join(here, '..', 'pipeline', 'bin', 'pipeline.mjs');
const pub = (w, round = '1') => w.cli(['round', 'publish', '--pr', '7', '--round', round]);
const issuePosts = (w) => w.fake.lines().filter((l) => /^api -X POST repos\/.*\/issues /.test(l)).length;

// Round 1 recorded: R1-S1 accepted, R1-S2 a follow-up.
function world(t) {
  const w = roundWorld(t, { max: 3 });
  assertExit(w.codex(1, findingsOf([], [low({ title: 'Fix me' }), low({ title: 'Later', line: 9 })])), 0);
  assertExit(w.judge(1, { 'R1-S1': ['ACCEPT'], 'R1-S2': ['FOLLOW-UP'] }), 0);
  // the judge leaves a follow-up unsettled until it is confirmed: record the decision as final
  w.edit((s) => { s.rounds[0].items.find((i) => i.id === 'R1-S2').final = { decision: 'FOLLOW-UP', by: 'judge', needsHuman: false, reason: 'later' }; });
  return w;
}
const postFollowupsFail = (w) => w.fake.setScript([
  { match: '^pr view 7', stdoutJson: { title: 'Add compute', body: 'b', headRefName: 'feat/x', baseRefName: 'main', headRefOid: w.head } },
  { match: '^repo view', stdoutJson: { nameWithOwner: w.slug, defaultBranchRef: { name: 'main' }, url: `https://github.com/${w.slug}` } },
  { match: `^api repos/${w.slug}/issues\\?creator=me&state=all&per_page=100 --paginate`, stdout: '[]' },
  { match: `^api -X POST repos/${w.slug}/issues `, code: 1, stderr: 'gh: boom' },
]);

test('publish: identity is checked before anything runs (no state, another PR, an unrecorded round)', (t) => {
  const w = roundWorld(t, { max: 3 });
  assert.equal(pub(w).json.error, 'identity-mismatch');
  assertExit(w.codex(1, findingsOf([], [low()])), 0);
  assertExit(pub(w, '2'), 1);
  w.edit((s) => { s.pr = 8; });
  const r = pub(w);
  assertExit(r, 1, r.stdout);
  assert.equal(r.json.error, 'identity-mismatch');
  assert.equal(w.fake.comments().length, 0, 'nothing was posted');
  assert.equal(issuePosts(w), 0);
});

test('publish: order and success shape: one comment (with the issue link), one issue, accepted ids and path, outcome verbatim', (t) => {
  const w = world(t);
  const r = pub(w);
  assertExit(r, 0, r.stdout + r.stderr);
  assert.deepEqual(r.json.accepted.ids, ['R1-S1']);
  assert.equal(r.json.accepted.count, 1);
  assert.ok(existsSync(r.json.accepted.path));
  assert.deepEqual(r.json.followups, [{ id: 'R1-S2', issue: w.issueUrl(31) }]);
  assert.deepEqual(r.json.held, []);
  assert.ok(Array.isArray(r.json.warnings));
  assert.deepEqual(r.json.outcome, w.cli(['state', 'outcome']).json, 'state outcome JSON verbatim');
  assert.equal(w.fake.comments().length, 1, 'comment upserts: one triage comment');
  assert.equal(w.item('R1-S2').followupIssue, w.issueUrl(31), 'the issue link is in the state the second comment pass publishes');
  assert.equal(issuePosts(w), 1);
});

test('publish: the exact child flags; state show carries no --pr; publish first, outcome last', () => {
  assert.deepEqual(publishSteps(7, 2).map(([id, args]) => [id, args.join(' ')]), [
    ['comment', 'comment --pr 7 --kind triage'],
    ['followups', 'followups create --round 2'],
    ['comment-links', 'comment --pr 7 --kind triage'],
    ['accepted', 'state show --round 2 --accepted'],
    ['outcome', 'state outcome'],
  ]);
  assert.equal(publishSteps(7, 2).some(([id, args]) => id === 'accepted' && args.includes('--pr')), false);
});

test('publish: a failing step stops the bundle with that step\'s full JSON, its exit code and ran[]', (t) => {
  const w = world(t);
  w.fake.setFail({ write: true });
  const one = pub(w);
  assert.notEqual(one.code, 0);
  assert.deepEqual([one.json.ok, one.json.step, one.json.ran], [false, 'comment', []]);
  assert.equal(typeof one.json.result, 'object');
  assert.equal(issuePosts(w), 0, 'followups did not run');
  w.fake.setFail({});
  postFollowupsFail(w);
  const two = pub(w);
  assert.notEqual(two.code, 0);
  assert.deepEqual([two.json.step, two.json.ran], ['followups', ['comment']]);
  assert.equal(typeof two.json.result, 'object');
  w.prHead(w.head);
  w.fake.setFail({ writeAfter: 1 });
  const three = pub(w);
  assert.notEqual(three.code, 0);
  assert.deepEqual([three.json.step, three.json.ran], ['comment-links', ['comment', 'followups']]);
});

for (const [name, setup, newIssues] of [
  ['the first comment', (w) => w.fake.setFail({ write: true }), 1],
  ['the follow-up issue call', (w) => postFollowupsFail(w), 1],
  ['the second comment', (w) => w.fake.setFail({ writeAfter: 1 }), 0], // the issue was filed before the comment failed: the rerun files none
]) {
  test(`publish: rerun after a failure at ${name}: one triage comment, no duplicate issue, the same result as another run`, (t) => {
    const w = world(t);
    setup(w);
    assert.notEqual(pub(w).code, 0);
    const attempted = issuePosts(w); // a failed POST is a call too: count the ones made after the fault is gone
    w.fake.setFail({});
    w.prHead(w.head);
    const rerun = pub(w);
    assertExit(rerun, 0, rerun.stdout + rerun.stderr);
    assert.equal(w.fake.comments().length, 1);
    assert.equal(issuePosts(w) - attempted, newIssues);
    assert.equal(rerun.json.followups.length, 1);
    const again = pub(w);
    assertExit(again, 0);
    assert.deepEqual(again.json, rerun.json);
    assert.equal(w.fake.comments().length, 1);
    assert.equal(issuePosts(w) - attempted, newIssues, 'no second issue');
  });
}

test('publish: needsHuman is returned after publishing, as today (held follow-ups are listed, no issue is filed for them)', (t) => {
  const w = world(t);
  w.edit((s) => { s.rounds[0].items.find((i) => i.id === 'R1-S2').final.needsHuman = true; });
  const r = pub(w);
  assertExit(r, 0, r.stdout + r.stderr);
  assert.deepEqual(r.json.held, ['R1-S2']);
  assert.equal(w.fake.comments().length, 1, 'published before the controller reads needsHuman');
  assert.ok(JSON.stringify(r.json.outcome.needsHuman ?? []).includes('R1-S2'));
  assert.equal(issuePosts(w), 0);
});

// ---- §4: the two side-by-side pairs serialise ------------------------------------------------------------------------------------------

const run = (w, args, env) => new Promise((resolveRun) => {
  const child = spawn(process.execPath, [bin, ...args], { cwd: w.repo.dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.on('close', (code) => { let json = null; try { json = JSON.parse(out); } catch { /* leave null */ } resolveRun({ code, json, out }); });
});

test('lock check: cost --from-transcript ∥ arbiter apply, and cost implementer ∥ state mark-implemented, run side by side as real CLI processes without admission errors', async (t) => {
  const w = world(t);
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cp-pairs-')));
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  mkdirSync(join(root, 'review-leases'), { recursive: true });
  const transcript = join(root, 'transcript.jsonl');
  writeFileSync(transcript, `${JSON.stringify({ message: { model: 'claude-sonnet-4-5', usage: { input_tokens: 10, output_tokens: 5 } } })}\n`);
  const env = {
    ...process.env, ...w.fake.env, PIPELINE_LOCK_DIR: join(w.scratch, 'locks'), HOME: home, USERPROFILE: home,
    PIPELINE_REVIEW_LEASE_DIR: join(root, 'review-leases'), PIPELINE_MACHINE_ID: 'machine-pairs', CLAUDECODE: '1',
  };
  const lease = /^(update-in-progress|review-lease|admission)/;
  const pairs = [
    [['cost', '--pr', '7', '--phase', 'review', '--role', 'judge', '--round', '1', '--from-transcript', transcript], ['arbiter', 'apply', '--round', '1', '--tag', 'no-such-tag']],
    [['cost', '--pr', '7', '--phase', 'review', '--role', 'implementer', '--round', '1', '--input', '10', '--output', '5', '--model', 'claude-sonnet-4-5'], ['state', 'mark-implemented', '--ids', 'R1-S1']],
  ];
  for (const [a, b] of pairs) {
    const [ra, rb] = await Promise.all([run(w, a, env), run(w, b, env)]);
    for (const r of [ra, rb]) {
      assert.ok(r.json, `printed JSON: ${r.out}`);
      assert.doesNotMatch(String(r.json.error ?? ''), lease, JSON.stringify(r.json).slice(0, 300));
      assert.doesNotMatch(String(r.json.message ?? ''), /admission|lock/i, r.out.slice(0, 300));
    }
  }
  assert.ok(readdirSync(join(root, 'review-leases')).length >= 1, 'leases were really on');
});
