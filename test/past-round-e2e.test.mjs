// End to end for the owner's approval of past rounds (plan 2026-11-12-legacy-round-grants.md, "End to end"): states shaped like the two real PRs that were stuck
// (EW #1448 and #1533): counted rounds that ran before owner grants were recorded, followed by rounds that were granted properly. The real CLI against a
// published-history fake gh; the owner's words are recorded by the real owner-go recorder (test/helpers/owner-go.mjs). The loop is the skill's:
// grant check refuses -> `triage round-request --past` -> the owner types `approve round` -> `state past-round-grant` -> until nothing remains -> the grant check passes.
// The grant check is verifyOwnerGrants, the one call review-complete (with the published state it reads) and the final gate's review check both make.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { assertExit } from './helpers/assert-exit.mjs';
import { roundWorld } from './helpers/round-world.mjs';
import { cleanupAtExit, ownerApprovesPast, ownerGrants, pastRoundRequest, roundRequest } from './helpers/owner-go.mjs';
import { addRound, decodeFromComment, emptyState, saveState } from '../pipeline/lib/state.mjs';
import { triageComment } from '../pipeline/lib/render.mjs';
import { verifyOwnerGrants } from '../pipeline/lib/owner-grants.mjs';
import { claimGrantMarkers, grantIdOf, markerPath } from '../pipeline/hooks/lib/owner-go.mjs';

const H = (n) => String(n).repeat(40);

// A world whose state holds `spec` rounds (published too). A spec entry with `granted: true` carries a real extra-round grant: the owner's record and a claimed marker.
function world(t, spec, max = 3) {
  const w = roundWorld(t, { max, mode: 'chat' });
  let k = 0;
  const rounds = spec.map((r) => {
    if (!r.resolutionOnly && !r.baseOnly) k += 1;
    if (!r.granted) return r;
    const { granted, ...round } = r;
    const rec = ownerGrants(t, 'extra round', roundRequest(7, k, H(r.n), w.slug));
    assert.ok(rec, 'the recorder wrote the extra-round grant');
    cleanupAtExit(markerPath(grantIdOf(rec)));
    t.after(() => rmSync(markerPath(grantIdOf(rec)), { force: true }));
    assert.equal(claimGrantMarkers([rec], { repo: w.slug, pr: 7, k, head: H(r.n), checkout: w.repo.dir }).ok, true);
    return { ...round, admission: 'owner', ownerGrant: { grantId: grantIdOf(rec), k, quote: 'extra round', ownerTs: rec.ts } };
  });
  const state = rounds.reduce((st, r) => addRound(st, { fromHead: H(0), contentHashAtToHead: `c${r.n}`.padEnd(64, '0'), items: [], toHead: H(r.n), ...r }), emptyState({ repo: w.slug, pr: 7, branch: 'feat/x', maxRounds: max }));
  saveState(w.repo.dir, state);
  w.fake.addComment({ body: triageComment(state) });
  w.max = max;
  w.ordinal = (n) => { let c = 0; for (const r of spec) { if (!r.resolutionOnly && !r.baseOnly) c += 1; if (r.n === n) return c; } return null; };
  w.published = () => decodeFromComment(w.fake.comments().filter((c) => c.body.includes('claude-pipeline:triage')).at(-1).body);
  // What review-complete and the final gate's review check both ask (review-complete reads the published state for the remedy text).
  w.check = () => verifyOwnerGrants(w.state(), { repo: w.slug, pr: 7, maxRounds: max, published: w.published() });
  return w;
}

// The skill's loop. Returns the rounds offered, oldest first.
function approveAll(t, w) {
  const offered = [];
  for (let guard = 0; guard < 10; guard += 1) {
    const ask = w.cli(['triage', 'round-request', '--pr', '7', '--past']);
    if (ask.code !== 0) {
      assert.equal(ask.json.error, 'nothing-to-approve', ask.stdout + ask.stderr);
      return offered;
    }
    assert.equal(ask.json.past, true);
    assert.match(ask.json.line, /^🔂 Approve past review round #7: round \d+ · head [0-9a-f]{12} · repo /);
    offered.push(ask.json.n);
    // The reply ends with the CLI's own line; the owner types the words after it.
    const rec = ownerApprovesPast(t, 'approve round', `Round ${ask.json.k} already ran at ${ask.json.head.slice(0, 12)}.\n${ask.json.line}`);
    assert.ok(rec, 'the recorder wrote the approval');
    cleanupAtExit(markerPath(grantIdOf(rec)));
    t.after(() => rmSync(markerPath(grantIdOf(rec)), { force: true }));
    const g = w.cli(['state', 'past-round-grant', '--pr', '7', '--round', String(ask.json.n)]);
    assertExit(g, 0, g.stderr + g.stdout);
    assert.equal(g.json.published, true);
    assert.deepEqual(g.json.remaining, ask.json.remaining, 'remaining is what round-request --past listed besides the round it offered');
  }
  assert.fail('the loop did not end');
}

test('EW #1448: rounds 5 and 6 ran before grants (rounds 7 and 8 granted, 9 resolution-only): refused with the remedy, approved oldest first, then clean', (t) => {
  const w = world(t, [
    { n: 1, admission: 'normal' }, { n: 2, admission: 'normal' }, { n: 3, admission: 'normal' }, { n: 4, admission: 'auto-extra' },
    { n: 5 }, { n: 6 }, { n: 7, granted: true }, { n: 8, granted: true }, { n: 9, resolutionOnly: true },
  ]);
  const before = w.check();
  assert.equal(before.ok, false);
  assert.equal(before.problems.length, 2, before.problems.join('|'));
  assert.match(before.problems[0], /^round 5: counted round 5 is past review\.max_rounds \(3\).*ran before owner grants were recorded.*triage round-request --pr 7 --past.*past-round-grant --pr 7 --round 5/);
  assert.match(before.problems[1], /^round 6: .*past-round-grant --pr 7 --round 6/);
  assert.deepEqual(before.granted.map((g) => g.n), [7, 8], 'the properly granted rounds verify');

  const first = w.cli(['triage', 'round-request', '--pr', '7', '--past']);
  assertExit(first, 0, first.stderr + first.stdout);
  assert.deepEqual([first.json.n, first.json.k, first.json.remaining.map((x) => x.n)], [5, 5, [6]], 'the oldest round is offered first');
  const offered = approveAll(t, w);
  assert.deepEqual(offered, [5, 6]);

  const after = w.check();
  assert.equal(after.ok, true, (after.problems ?? []).join('|'));
  assert.deepEqual(after.granted.map((g) => [g.n, g.k, g.past === true]), [[5, 5, true], [6, 6, true], [7, 7, false], [8, 8, false]]);
  assert.deepEqual(w.published().rounds.filter((r) => r.ownerGrant).map((r) => r.n), [5, 6, 7, 8], 'the PR holds every grant');
  assert.equal(w.cli(['triage', 'round-request', '--pr', '7', '--past']).json.error, 'nothing-to-approve');
});

test('EW #1533: round 5 ran before grants (rounds 6 to 9 granted): refused with the remedy, one approval, then clean', (t) => {
  const w = world(t, [
    { n: 1, admission: 'normal' }, { n: 2, admission: 'normal' }, { n: 3, admission: 'normal' }, { n: 4, admission: 'auto-extra' },
    { n: 5 }, { n: 6, granted: true }, { n: 7, granted: true }, { n: 8, granted: true }, { n: 9, granted: true },
  ]);
  const before = w.check();
  assert.equal(before.ok, false);
  assert.equal(before.problems.length, 1, before.problems.join('|'));
  assert.match(before.problems[0], /^round 5: .*past-round-grant --pr 7 --round 5/);
  assert.deepEqual(before.granted.map((g) => g.n), [6, 7, 8, 9]);

  assert.deepEqual(approveAll(t, w), [5]);
  const after = w.check();
  assert.equal(after.ok, true, (after.problems ?? []).join('|'));
  assert.deepEqual(after.granted.map((g) => [g.n, g.past === true]), [[5, true], [6, false], [7, false], [8, false], [9, false]]);
  assert.equal(w.published().rounds.find((r) => r.n === 5).ownerGrant.past, true);
});

// #269 R26-F1: --ask with --past answers with ask: null and a reason (a past round is approved by typing), never with neither key, and issues no ask.
test('round-request --past --ask: the line as without --ask, plus ask null and askSkipped (a past round is approved by typing)', (t) => {
  const w = world(t, [
    { n: 1, admission: 'normal' }, { n: 2, admission: 'normal' }, { n: 3, admission: 'normal' }, { n: 4, admission: 'auto-extra' },
    { n: 5 }, { n: 6, granted: true }, { n: 7, granted: true }, { n: 8, granted: true }, { n: 9, granted: true },
  ]);
  const plain = w.cli(['triage', 'round-request', '--pr', '7', '--past']);
  assertExit(plain, 0, plain.stderr + plain.stdout);
  assert.equal('ask' in plain.json, false, 'without --ask nothing is added');
  const asked = w.cli(['triage', 'round-request', '--pr', '7', '--past', '--ask']);
  assertExit(asked, 0, asked.stderr + asked.stdout);
  assert.equal(asked.json.line, plain.json.line);
  assert.equal(asked.json.past, true);
  assert.equal(asked.json.ask, null);
  assert.match(asked.json.askSkipped, /past round is approved by typing/);
});
