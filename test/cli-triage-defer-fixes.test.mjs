// `pipeline triage defer-fixes`: at the round limit, low-severity accepted fixes are taken out of the PR (the caller reverts them first) and become follow-up
// issues instead of another review round (plan 2026-11-11-round-discipline-one-implementer.md, Item 1b). Every refusal leaves the state byte-identical; a success leaves a
// review that reads as clean, whose Rulings rows carry each deferral for the owner's "merge" to bind. Real CLI, real git, fake gh and codex (test/helpers/round-world.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { grantIdOf, markerPath } from '../pipeline/hooks/lib/owner-go.mjs';
import { assertExit } from './helpers/assert-exit.mjs';
import { cleanupAtExit, ownerGrants, ownerRules, roundRequest, rulingRequest } from './helpers/owner-go.mjs';
import { low, roundWorld } from './helpers/round-world.mjs';

const defer = (w, ids, fixHead, { reason = 'minor, file it', extra = [] } = {}) =>
  w.cli(['triage', 'defer-fixes', '--pr', '7', '--ids', ids, '--fix-head', fixHead, '--reason', reason, ...extra]);
// At the limit with the round-2 fix taken out, as the skill leaves it: -> { h1 (the reviewed head), h2 (the fix head), h3 (HEAD after the revert) }.
function reverted(w, round2) {
  const { h1, h2 } = w.atCap(round2);
  return { h1, h2, h3: w.revert(h2) };
}
// `run` is a function: the state is read BEFORE the command runs, so "untouched" compares against what the command was given.
const refused = (w, run, re, label = '') => {
  const before = w.stateText();
  const r = run();
  assert.equal(r.code, 1, `${label} exit ${r.code}: ${r.stdout}${r.stderr}`);
  assert.equal(r.json.ok, false, label);
  assert.match(r.json.reason, re, label);
  assert.equal(w.stateText(), before, `${label}: state untouched`);
};

test('defer-fixes: the reverted fixes become FOLLOW-UPs, the review reads clean, the issue names the removed fix, and review-complete passes', (t) => {
  const w = roundWorld(t);
  const { h1, h2, h3 } = reverted(w);
  assert.equal(w.cli(['state', 'outcome']).json.clean, false, 'before: the fix is unreviewed');
  const r = defer(w, 'R2-S1', h2);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.deepEqual([r.json.ok, r.json.deferred, r.json.rounds, r.json.published], [true, ['R2-S1'], [2], true]);
  const item = w.item('R2-S1');
  assert.deepEqual([item.final.decision, item.final.by, item.final.needsHuman, item.final.reason, item.final.claude.cause, item.final.claude.critical], ['FOLLOW-UP', 'claude', false, 'minor, file it', 'round-cap', false]);
  assert.equal(item.final.claude.overruled.decision, 'ACCEPT');
  assert.deepEqual([item.final.claude.fixHead, item.final.claude.reviewedHead], [h2, h1]);
  assert.deepEqual([item.implemented, 'implementedVia' in item], [false, false]);
  assert.deepEqual([item.roundCapDeferral.fixHead, item.roundCapDeferral.reviewedHead, typeof item.roundCapDeferral.at], [h2, h1, 'string']);
  assert.equal(w.state().version, 2);
  assert.equal(w.cli(['state', 'outcome']).json.clean, true, 'after: nothing owed');

  // the issue says where the removed fix is
  const filed = w.cli(['followups', 'create', '--round', '2']);
  assertExit(filed, 0, filed.stderr + filed.stdout);
  assert.deepEqual(filed.json.created.map((c) => c.id), ['R2-S1']);
  const post = w.fake.calls().find((c) => c.argv.join(' ').startsWith(`api -X POST repos/${w.slug}/issues `));
  const body = JSON.parse(post.stdin).body;
  assert.ok(body.includes(`A fix was written on PR #7 at ${h2} and taken out before merge to keep the review closed; compare it with the reviewed code: git diff ${h1} ${h2}`), body);

  // review-complete (the marker carries the rulings digest of this state)
  w.prHead(h3);
  const done = w.cli(['review-complete', '--pr', '7']);
  assertExit(done, 0, done.stderr + done.stdout);
  const marker = w.fake.comments().map((c) => c.body).find((b) => b.includes('claude-pipeline:review-complete'));
  assert.ok(marker, 'the review-complete marker was posted');
  assert.equal(done.json.ok, true);
});

test('defer-fixes: the Rulings block lists the deferral after filing (CLI-written row), its digest moved, and an old digest no longer matches', async (t) => {
  const w = roundWorld(t);
  const { h2 } = reverted(w);
  const { rulingsBlock, rulingsDigest } = await import('../pipeline/lib/triage.mjs');
  const empty = rulingsDigest(w.state());
  assertExit(defer(w, 'R2-S1', h2), 0);
  const beforeFiling = rulingsDigest(w.state());
  assert.notEqual(empty, beforeFiling);
  assert.match(rulingsBlock(w.state()), /R2-S1 · FOLLOW-UP · SUGGESTION · maintainability · by claude \(round limit\) · content [0-9a-f]{12} · "Issue 2" · why: deferred past the round limit; accepted by judge; fix [0-9a-f]{12} removed, NOT in this merge; issue not filed yet/);
  assertExit(w.cli(['followups', 'create', '--round', '2']), 0);
  assert.notEqual(rulingsDigest(w.state()), beforeFiling, 'filing the issue changes the row, so an approval of the earlier block no longer binds');
  assert.match(rulingsBlock(w.state()), /NOT in this merge; issue #31$/m);
});

test('defer-fixes: refused while the fixes are still in the tree, or when the content moved since the reviewed head', (t) => {
  const w = roundWorld(t);
  const { h1, h2 } = w.atCap();
  refused(w, () => defer(w, 'R2-S1', h2), /tree is not back at the last reviewed content.*revert every commit/, 'fix still in the tree');
  w.revert(h2);
  w.repo.write('src/extra.js', 'export const extra = 1;\n');
  w.repo.commit('something else');
  refused(w, () => defer(w, 'R2-S1', h2), /tree is not back at the last reviewed content/, 'other work since the reviewed head');
  assert.ok(h1);
});

test('defer-fixes: --ids must be exactly the unreviewed accepts: no partial defer, no extra id, no unknown id', (t) => {
  const w = roundWorld(t);
  const { h2 } = reverted(w, [low({ title: 'First' }), low({ title: 'Second', line: 5 })]);
  refused(w, () => defer(w, 'R2-S1', h2), /exactly the accepted fixes no round has reviewed \(R2-S1, R2-S2\).*no partial defer/, 'partial');
  refused(w, () => defer(w, 'R2-S1,R2-S2,R1-S1', h2), /exactly the accepted fixes/, 'an id that is no unreviewed accept');
  refused(w, () => defer(w, 'R2-S1,R2-S9', h2), /exactly the accepted fixes/, 'unknown id');
  const ok = defer(w, 'R2-S2,R2-S1', h2);
  assertExit(ok, 0, ok.stdout);
  assert.deepEqual(ok.json.deferred, ['R2-S1', 'R2-S2']);
});

test('defer-fixes: refused for anything that is not low severity: a bug, an unknown, empty, absolute or ../ location, a sensitive path', (t) => {
  for (const [label, over] of [
    ['bug', { category: 'bug' }], ['unknown file', { file: 'src/nowhere.js' }], ['empty file', { file: '' }], ['absolute file', { file: '/etc/passwd' }], ['../ file', { file: '../src/big.js' }],
  ]) {
    const w = roundWorld(t);
    const { h2 } = reverted(w, [low(over)]);
    refused(w, () => defer(w, 'R2-S1', h2), /not low severity/, label);
  }
  const sens = roundWorld(t);
  const { h2 } = reverted(sens);
  sens.config({ yml: 'risk:\n  high_risk_paths: ["src/big.js"]\n' });
  refused(sens, () => defer(sens, 'R2-S1', h2), /not low severity \(.*sensitive path/, 'high_risk_paths');
  const cat = roundWorld(t);
  const { h2: c2 } = reverted(cat);
  cat.edit((s) => { s.rounds[1].items[0].category = 'novel'; });
  refused(cat, () => defer(cat, 'R2-S1', c2), /not low severity \(category novel/, 'unknown category');
  const bucket = roundWorld(t);
  const { h2: b2 } = reverted(bucket);
  bucket.edit((s) => { s.rounds[1].items[0].bucket = 'NITPICK'; });
  refused(bucket, () => defer(bucket, 'R2-S1', b2), /not low severity \(unknown bucket/, 'unknown bucket');
  // the file of a BLOCKING ACCEPT anywhere in the state is high
  const same = roundWorld(t);
  const { h2: s2 } = reverted(same);
  same.edit((s) => {
    s.rounds[0].items.push({ ...s.rounds[0].items[0], id: 'R1-B9', bucket: 'BLOCKING', category: 'bug', file: 'src/big.js', fingerprint: 'fp-b9' });
  });
  refused(same, () => defer(same, 'R2-S1', s2), /not low severity \(src\/big\.js also holds an accepted BLOCKING/, 'same file as a BLOCKING accept');
});

test('defer-fixes: refused for an ACCEPT a test, Claude, a second review or the owner made, and one fixed through other files', (t) => {
  const cases = {
    'a settle test': [{ decision: 'ACCEPT', by: 'test', needsHuman: false, reason: 'test confirmed' }, /accepted by test/],
    'Claude': [{ decision: 'ACCEPT', by: 'claude', needsHuman: false, reason: 'r', claude: { ruledAt: 'x', cause: 'low-confidence', critical: false, overruled: {} } }, /ruled by Claude/],
    'a second review': [{ decision: 'ACCEPT', by: 'claude', forcedBy: 'second-review', needsHuman: false, reason: 'r', claude: { ruledAt: 'x', cause: 'low-confidence', critical: false, overruled: {} } }, /Claude or forced/],
    'the owner': [{ decision: 'ACCEPT', by: 'owner', needsHuman: false, reason: 'r', ownerQuote: 'R2-S1: accept', ruledAt: 'x', overruled: {} }, /ruled by the owner/],
  };
  for (const [label, [final, re]] of Object.entries(cases)) {
    const w = roundWorld(t);
    const { h2 } = reverted(w);
    w.edit((s) => { s.rounds[1].items[0].final = final; });
    refused(w, () => defer(w, 'R2-S1', h2), re, label);
  }
  const via = roundWorld(t);
  const { h2 } = reverted(via);
  via.edit((s) => { s.rounds[1].items[0].implementedVia = 'other-files'; });
  refused(via, () => defer(via, 'R2-S1', h2), /not low severity \(its fix was made in other files/, 'implementedVia');
});

test('defer-fixes: refused when the round limit is not reached, the automatic extra round is available, or anything else is open', (t) => {
  const early = roundWorld(t, { max: 3 });
  const e1 = early.reviewAndFix(1, early.base, early.head, [low()]);
  const early2 = early.revert(e1);
  assert.ok(early2);
  refused(early, () => defer(early, 'R1-S1', e1), /round limit \(3\) is not reached/, 'limit not reached');

  const auto = roundWorld(t);
  const a1 = auto.reviewAndFix(1, auto.base, auto.head, [low()]);
  auto.revert(a1);
  refused(auto, () => defer(auto, 'R1-S1', a1), /automatic extra round is still available/, 'automatic extra round');

  const open = roundWorld(t);
  const { h2 } = reverted(open);
  open.edit((s) => { s.rounds[1].items.push({ ...s.rounds[1].items[0], id: 'R2-S2', fingerprint: 'fp-x', final: null, implemented: false }); });
  refused(open, () => defer(open, 'R2-S1', h2), /items still pending: R2-S2/, 'pending');
  open.edit((s) => { s.rounds[1].items[1].final = { decision: 'REJECT', by: 'arbiter', needsHuman: true, reason: 'x', cause: 'low-confidence' }; });
  refused(open, () => defer(open, 'R2-S1', h2), /wait for a human: R2-S2/, 'needs a human');
  open.edit((s) => { s.rounds[1].items[1] = { ...s.rounds[1].items[1], bucket: 'BLOCKING', category: 'bug', final: { decision: 'ACCEPT', by: 'judge', needsHuman: false, reason: 'r' }, implemented: false }; });
  refused(open, () => defer(open, 'R2-S1', h2), /not implemented: R2-S2/, 'unimplemented accept');
  open.edit((s) => { s.rounds[1].items.pop(); s.rounds[1].fableRequired = true; });
  refused(open, () => defer(open, 'R2-S1', h2), /Fable pass is owed/, 'Fable pass owed');
});

test('defer-fixes: refused in label mode, for another PR, an empty or over-long reason, and a missing flag', (t) => {
  const label = roundWorld(t, { mode: 'label' });
  const { h2: l2 } = reverted(label);
  refused(label, () => defer(label, 'R2-S1', l2), /owner_approval: chat/, 'label mode');

  const w = roundWorld(t);
  const { h2 } = reverted(w);
  refused(w, () => w.cli(['triage', 'defer-fixes', '--pr', '8', '--ids', 'R2-S1', '--fix-head', h2, '--reason', 'r']), /review state is for PR #7, not #8/, 'wrong PR');
  refused(w, () => defer(w, 'R2-S1', h2, { reason: '   ' }), /must not be empty/, 'empty reason');
  refused(w, () => defer(w, 'R2-S1', h2, { reason: 'x'.repeat(1001) }), /at most 1000/, 'long reason');
  assertExit(w.cli(['triage', 'defer-fixes', '--pr', '7', '--ids', 'R2-S1', '--reason', 'r']), 2);
  assertExit(w.cli(['triage', 'defer-fixes', '--pr', '7', '--fix-head', h2, '--reason', 'r']), 2);
});

test('defer-fixes: --fix-head must be a commit that is an ancestor of HEAD with content other than the reviewed one', (t) => {
  const w = roundWorld(t);
  const { h1, h2, h3 } = reverted(w);
  refused(w, () => defer(w, 'R2-S1', 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'), /not a commit in this repository/, 'unknown commit');
  refused(w, () => w.cli(['triage', 'defer-fixes', '--pr', '7', '--ids', 'R2-S1', '--fix-head=--upload-pack=x', '--reason', 'r']), /not a commit in this repository/, 'an option-shaped value');
  refused(w, () => defer(w, 'R2-S1', h1), /has the reviewed content/, 'the reviewed head itself');
  refused(w, () => defer(w, 'R2-S1', h3), /has the reviewed content/, 'the reverted head');
  w.repo.git(['checkout', '-q', '-b', 'other', h1]);
  w.repo.write('src/side.js', 'export const side = 1;\n');
  const side = w.repo.commit('side branch');
  w.repo.git(['checkout', '-q', 'feat/x']);
  refused(w, () => defer(w, 'R2-S1', side), /not an ancestor of HEAD/, 'a commit on another branch');
  assertExit(defer(w, 'R2-S1', h2.slice(0, 10)), 0);
  assert.equal(w.item('R2-S1').roundCapDeferral.fixHead, h2, 'an abbreviated head is stored in full');
});

test('defer-fixes: a typed "extra round" always wins: ask -> owner grants -> revert -> defer-fixes is refused (the grant is for the head before the revert)', (t) => {
  const w = roundWorld(t);
  const { h2 } = w.atCap();
  const asked = w.cli(['triage', 'round-request', '--pr', '7']);
  assertExit(asked, 0, asked.stderr + asked.stdout);
  assert.equal(asked.json.recommend, 'follow-up');
  const record = ownerGrants(t, 'extra round', roundRequest(7, 3, h2, w.slug));
  assert.ok(record, 'the recorder wrote the grant');
  cleanupAtExit(markerPath(grantIdOf(record)));
  t.after(() => rmSync(markerPath(grantIdOf(record)), { force: true }));
  w.revert(h2); // the head moved: only an any-head lookup still sees the grant
  refused(w, () => defer(w, 'R2-S1', h2), /owner granted extra round 3 \(unspent\)/, 'grant at the old head');
  // and the ask itself now stops recommending the follow-up path
  const again = w.cli(['triage', 'round-request', '--pr', '7']);
  assertExit(again, 0, again.stderr + again.stdout);
  assert.equal(again.json.recommend, 'extra-round');
});

test('defer-fixes: accepts carried across a resolution-only round are included; the issues are filed per round and a retry after an interruption files nothing twice', (t) => {
  const w = roundWorld(t);
  const { h1, h2 } = w.atCap();
  // a resolution-only round 3 reviewed the same code and accepted (and had fixed) one more low item
  w.edit((s) => {
    const r2 = s.rounds[1];
    const extra = { ...r2.items[0], id: 'R3-S1', round: 3, title: 'Other idea', fingerprint: 'fp-r3', line: 7, file: 'src/a.js' };
    s.rounds.push({ ...r2, n: 3, items: [extra], resolutionOnly: true, admission: undefined });
  });
  w.revert(h2);
  refused(w, () => defer(w, 'R2-S1', h2), /exactly the accepted fixes no round has reviewed \(R2-S1, R3-S1\)|\(R3-S1, R2-S1\)/, 'a partial set');
  const r = defer(w, 'R3-S1,R2-S1', h2);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.deepEqual([r.json.deferred, r.json.rounds], [['R2-S1', 'R3-S1'], [2, 3]]);
  assert.equal(w.cli(['state', 'outcome']).json.clean, true);
  // interrupted after the first round's issues: the retry skips what is filed and files the rest
  const first = w.cli(['followups', 'create', '--round', '2']);
  assert.deepEqual(first.json.created.map((c) => c.id), ['R2-S1']);
  const posts = () => w.fake.lines().filter((l) => l.startsWith(`api -X POST repos/${w.slug}/issues `)).length;
  assert.equal(posts(), 1);
  const retry2 = w.cli(['followups', 'create', '--round', '2']);
  assert.deepEqual([retry2.json.created, retry2.json.skipped], [[], ['R2-S1']]);
  const second = w.cli(['followups', 'create', '--round', '3']);
  assert.deepEqual(second.json.created.map((c) => c.id), ['R3-S1']);
  assert.equal(posts(), 2, 'one issue per item, none twice');
  assert.ok(h1);
});

test('defer-fixes: Claude cannot reopen a deferral (claude-ruling refuses, state untouched); the owner\'s typed ruling can, and the Rulings row stays', async (t) => {
  const w = roundWorld(t);
  const { h2 } = reverted(w);
  assertExit(defer(w, 'R2-S1', h2), 0);
  assertExit(w.cli(['followups', 'create', '--round', '2']), 0);
  for (const decision of ['ACCEPT', 'FOLLOW-UP', 'REJECT']) {
    refused(w, () => w.cli(['triage', 'claude-ruling', '--round', '2', '--id', 'R2-S1', '--decision', decision, '--reason', 'x', '--pr', '7']), /deferred past the round limit.*only the owner's typed ruling/, `claude ${decision}`);
  }
  const asked = w.cli(['triage', 'ruling-request', '--pr', '7', '--ids', 'R2-S1']);
  assertExit(asked, 0, asked.stderr + asked.stdout);
  const digest = /content ([0-9a-f]{12})/.exec(asked.json.line)[1];
  assert.ok(ownerRules(t, 'R2-S1: reject', rulingRequest(7, ['R2-S1'], w.slug, digest)), 'the owner answered');
  const ruled = w.cli(['triage', 'owner-ruling', '--round', '2', '--id', 'R2-S1', '--decision', 'REJECT', '--reason', 'owner says drop it', '--owner-quote', 'R2-S1: reject', '--pr', '7']);
  assertExit(ruled, 0, ruled.stderr + ruled.stdout);
  const { rulingsBlock } = await import('../pipeline/lib/triage.mjs');
  assert.match(rulingsBlock(w.state()), /R2-S1 · REJECT · SUGGESTION · maintainability · by owner · .*why: owner says drop it/, 'the row stays, with the owner\'s attribution');
  assert.equal(w.item('R2-S1').roundCapDeferral.fixHead, h2, 'the item-level mark survives the owner ruling');
});

test('defer-fixes: a second call finds nothing left to defer', (t) => {
  const w = roundWorld(t);
  const { h2 } = reverted(w);
  assertExit(defer(w, 'R2-S1', h2), 0);
  refused(w, () => defer(w, 'R2-S1', h2), /nothing to defer/, 'again');
});
