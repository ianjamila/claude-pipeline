// `pipeline triage defer-fixes`: at the round limit, low-severity accepted fixes are taken out of the PR (the caller reverts them first) and become follow-up
// issues instead of another review round (plan 2026-11-11-round-discipline-one-implementer.md, Item 1b). Every refusal leaves the state byte-identical; a success leaves a
// review that reads as clean, whose Rulings rows carry each deferral for the owner's "merge" to bind. Real CLI, real git, fake gh and codex (test/helpers/round-world.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { grantIdOf, markerPath } from '../pipeline/hooks/lib/owner-go.mjs';
import { assertExit } from './helpers/assert-exit.mjs';
import { cleanupAtExit, OWNER_ENTRY, ownerGrants, ownerRules, roundRequest, rulingRequest } from './helpers/owner-go.mjs';
import { aFile, low, roundWorld } from './helpers/round-world.mjs';

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
  assert.equal(w.state().version, 3, 'a deferral writes format version 3: a pre-deferral pipeline would drop its Rulings row');
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

test('defer-fixes: refused when main was merged in after the last reviewed head with no base-only round, and the merge moved the content hash', (t) => {
  const w = roundWorld(t);
  const { h2 } = reverted(w);
  // main edits a line two above the one the PR changed (src/a.js line 12): the merge is clean, and the PR's own patch now has other context lines, so its content hash moves
  w.repo.git(['checkout', '-q', 'main']);
  w.repo.write('src/a.js', aFile(false).replace('export const v10 = 10;', 'export const v10 = 1000;'));
  w.repo.commit('main edits near the PR');
  w.repo.git(['checkout', '-q', 'feat/x']);
  w.repo.git(['merge', '--no-edit', 'main']);
  refused(w, () => defer(w, 'R2-S1', h2), /tree is not back at the last reviewed content/, 'main merged in');
});

test('defer-fixes: a cached BLOCKING accept fixed after the last round (next to a low accept in another file) is refused, and round-request recommends the round (R1-F1)', (t) => {
  const w = roundWorld(t);
  const { h2 } = w.atCap();
  // round 2 also holds a copy of a BLOCKING ACCEPT that reuseRuled carried over unimplemented; the agent fixed it in the round-2 fix commit and marked it (the CLI records when)
  w.edit((s) => {
    const base = s.rounds[1].items[0];
    s.rounds[1].items.push({
      ...base, id: 'R2-B1', bucket: 'BLOCKING', category: 'bug', file: 'src/a.js', title: 'Cached bug', fingerprint: 'fp-cached-blocking',
      final: { decision: 'ACCEPT', by: 'cache', needsHuman: false, reason: 'accepted in round 1' }, implemented: false,
    });
  });
  assertExit(w.cli(['state', 'mark-implemented', '--ids', 'R2-B1']), 0);
  assert.equal(w.item('R2-B1').implementedAfterRound, 2, 'the mark records the newest round at the time');
  const asked = w.cli(['triage', 'round-request', '--pr', '7']);
  assertExit(asked, 0, asked.stderr + asked.stdout);
  assert.equal(asked.json.recommend, 'extra-round', 'the ask agrees with the command');
  w.revert(h2);
  refused(w, () => defer(w, 'R2-S1', h2), /R2-B1 is an accepted BLOCKING or security fix marked implemented that is not proven to be in the last reviewed head/, 'cached BLOCKING accept');
  assert.equal(w.item('R2-B1').implemented, true, 'the state still says it is in, and nothing was dropped');
});

test('defer-fixes: an extra round recorded for this PR whose provenance cannot be confirmed refuses (it may be the owner\'s), and so does the ask\'s recommendation (R1-F2)', (t) => {
  const w = roundWorld(t);
  const { h2 } = w.atCap();
  const record = ownerGrants(t, 'extra round', roundRequest(7, 3, h2, w.slug), OWNER_ENTRY, 'missing');
  assert.ok(record, 'the recorder wrote the grant');
  cleanupAtExit(markerPath(grantIdOf(record)));
  t.after(() => rmSync(markerPath(grantIdOf(record)), { force: true }));
  w.revert(h2);
  refused(w, () => defer(w, 'R2-S1', h2), /recorded for round 3 but cannot be confirmed as typed by the owner/, 'unconfirmed grant');
  const again = w.cli(['triage', 'round-request', '--pr', '7']);
  assertExit(again, 0, again.stderr + again.stdout);
  assert.equal(again.json.recommend, 'extra-round');
});

test('defer-fixes: --fix-head must descend from the last reviewed head: an older head (the original feature head, round 1\'s) is refused (R1-F3)', (t) => {
  const w = roundWorld(t);
  const { h1, h2 } = reverted(w);
  refused(w, () => defer(w, 'R2-S1', w.head), /older than the last reviewed head/, 'an older head with other content');
  assert.ok(h1);
  const ok = defer(w, 'R2-S1', h2);
  assertExit(ok, 0, ok.stderr + ok.stdout);
});

// A second item waiting for a human next to a deferral, to run the other writers of the state on it.
const withWaiting = (w) => w.edit((s) => {
  const { roundCapDeferral: _mark, ...rest } = s.rounds[1].items[0];
  s.rounds[1].items.push({ ...rest, id: 'R2-S2', title: 'Another idea', fingerprint: 'fp-waiting', line: 7, final: { decision: 'REJECT', by: 'arbiter', needsHuman: true, reason: 'unsure', cause: 'low-confidence' }, implemented: false });
});

test('defer-fixes: a later claude-ruling or second-review keeps the state at version 3, never back at 2 (R1-B1)', (t) => {
  const w = roundWorld(t);
  const { h2 } = reverted(w);
  assertExit(defer(w, 'R2-S1', h2), 0);
  assert.equal(w.state().version, 3);
  withWaiting(w);
  const ruled = w.cli(['triage', 'claude-ruling', '--round', '2', '--id', 'R2-S2', '--decision', 'FOLLOW-UP', '--reason', 'later', '--pr', '7']);
  assertExit(ruled, 0, ruled.stderr + ruled.stdout);
  assert.equal(w.state().version, 3, 'claude-ruling');
  // a second review on another waiting item
  w.edit((s) => {
    s.rounds[1].items.push({ ...s.rounds[1].items.find((i) => i.id === 'R2-S2'), id: 'R2-S3', title: 'A third idea', fingerprint: 'fp-third', line: 9, final: { decision: 'REJECT', by: 'arbiter', needsHuman: true, reason: 'unsure', cause: 'low-confidence' }, implemented: false });
  });
  const second = w.cli(['triage', 'second-review', '--round', '2', '--ids', 'R2-S3', '--pr', '7'], {
    FAKE_CODEX_OUTPUT: w.file('second.json', { items: [{ id: 'R2-S3', decision: 'REJECT', confidence: 'high', reasoning: 'not worth it' }] }),
  });
  assertExit(second, 0, second.stderr + second.stdout);
  assert.equal(w.state().version, 3, 'second-review');
});

test('defer-fixes: a second review is refused for a deferral without running Codex, state untouched (R1-F4)', (t) => {
  const w = roundWorld(t);
  const { h2 } = reverted(w);
  assertExit(defer(w, 'R2-S1', h2), 0);
  refused(w, () => w.cli(['triage', 'second-review', '--round', '2', '--ids', 'R2-S1', '--pr', '7']), /deferred past the round limit.*only the owner's typed ruling/, 'second-review of a deferral');
});

test('defer-fixes: a finding raised again in a later granted round links the follow-up issue already filed for it, and the triage comment says so (no second issue)', (t) => {
  const w = roundWorld(t);
  const { h1, h2 } = reverted(w);
  assertExit(defer(w, 'R2-S1', h2), 0);
  assertExit(w.cli(['followups', 'create', '--round', '2']), 0);
  w.repo.write('src/more.js', 'export const more = 1;\n'); // new work the granted round reviews
  const h4 = w.repo.commit('more work');
  const posts = () => w.fake.lines().filter((l) => l.startsWith(`api -X POST repos/${w.slug}/issues `)).length;
  assert.equal(posts(), 1);
  // the owner grants round 3 (for the head the ask named); Codex raises the deferred finding again
  const record = ownerGrants(t, 'extra round', roundRequest(7, 3, h4, w.slug));
  assert.ok(record, 'the recorder wrote the grant');
  cleanupAtExit(markerPath(grantIdOf(record)));
  t.after(() => rmSync(markerPath(grantIdOf(record)), { force: true }));
  const third = w.codex(3, { summary: 'Reviewed.', blocking: [], suggestions: [low({ title: 'Issue 2' })], worth_considering: [] }, { from: h1, to: h4 });
  assertExit(third, 0, third.stderr + third.stdout);
  const again = w.item('R3-S1');
  assert.equal(again.followupIssue, w.issueUrl(31), 'linked to the open follow-up');
  assert.deepEqual(again.reraisedDeferral, { id: 'R2-S1', issue: w.issueUrl(31) });
  // it is ruled a follow-up again: no second issue is filed
  w.edit((st) => { st.rounds[2].items[0].final = { decision: 'FOLLOW-UP', by: 'judge', needsHuman: false, reason: 'already filed' }; });
  const filed = w.cli(['followups', 'create', '--round', '3']);
  assertExit(filed, 0, filed.stderr + filed.stdout);
  assert.deepEqual([filed.json.created, filed.json.skipped], [[], ['R3-S1']]);
  assert.equal(posts(), 1, 'no duplicate issue');
  const published = w.cli(['comment', '--pr', '7', '--kind', 'triage']);
  assertExit(published, 0, published.stderr + published.stdout);
  const body = w.fake.comments().map((c) => c.body).find((b) => b.includes('Raised again after a deferral'));
  assert.ok(body, 'the triage comment has the section');
  assert.match(body, /- R3-S1: the same finding as R2-S1, whose fix was deferred past the round limit; follow-up issue https:\/\/github\.com\/[^ ]+\/issues\/31 is already filed, no new issue/);
});

test('defer-fixes: an EARLIER round\'s accept ruled and fixed after the last reviewed head is refused too, and round-request recommends the round (R2-F1)', (t) => {
  const w = roundWorld(t);
  const { h2 } = w.atCap();
  // round 1 holds a BLOCKING item that waited for a human; it was ruled ACCEPT after round 2, and fixed in the round-2 fix commit next to the low R2-S1
  w.edit((s) => {
    s.rounds[0].items.push({
      ...s.rounds[0].items[0], id: 'R1-B9', bucket: 'BLOCKING', category: 'bug', file: 'src/a.js', title: 'Late bug', fingerprint: 'fp-late',
      final: { decision: 'ACCEPT', by: 'claude', needsHuman: false, reason: 'ruled after round 2', claude: { ruledAt: 'x', cause: 'low-confidence', critical: true, overruled: {} } }, implemented: false,
    });
  });
  assertExit(w.cli(['state', 'mark-implemented', '--ids', 'R1-B9']), 0);
  assert.equal(w.item('R1-B9').implementedAfterRound, 2);
  const asked = w.cli(['triage', 'round-request', '--pr', '7']);
  assertExit(asked, 0, asked.stderr + asked.stdout);
  assert.equal(asked.json.recommend, 'extra-round');
  w.revert(h2);
  refused(w, () => defer(w, 'R2-S1', h2), /R1-B9 is an accepted BLOCKING or security fix marked implemented that is not proven/, 'earlier-round accept fixed after the last review');
  // a state from before the field (no record) falls back to the round as well
  w.edit((s) => { delete s.rounds[0].items.find((i) => i.id === 'R1-B9').implementedAfterRound; });
  refused(w, () => defer(w, 'R2-S1', h2), /R1-B9 is an accepted .*not proven/, 'no record of when it was marked');
});
