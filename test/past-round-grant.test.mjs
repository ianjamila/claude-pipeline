// Owner approval of a round that ALREADY ran (plan 2026-11-12-legacy-round-grants.md, B): pastRoundsNeedingApproval, `triage round-request --past`,
// `state past-round-grant`. Real CLI against a synthetic review state (max_rounds 1) published to a fake gh that remembers the PR's comments; the owner's
// words are recorded by the real owner-go recorder under a repository name of its own (test/helpers/owner-go.mjs). Every refusal proves the state and the markers are unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertExit } from './helpers/assert-exit.mjs';
import { roundWorld } from './helpers/round-world.mjs';
import { cleanupAtExit, ownerApprovesPast, ownerGrants, pastRoundRequest, roundRequest } from './helpers/owner-go.mjs';
import { addRound, decodeFromComment, emptyState, saveState } from '../pipeline/lib/state.mjs';
import { triageComment } from '../pipeline/lib/render.mjs';
import { roundOutcome } from '../pipeline/lib/triage.mjs';
import { readBaseline, reviewContentHash, writeBaseline } from '../pipeline/lib/review-publish.mjs';
import { pastRoundsNeedingApproval, verifyOwnerGrants } from '../pipeline/lib/owner-grants.mjs';
import { claimGrantMarkers, grantIdOf, markerPath, ownerGoDir, presentedPastRoundRequest } from '../pipeline/hooks/lib/owner-go.mjs';

const H = (n) => String(n).repeat(40);
// max_rounds 1: round 1 normal, 2 the automatic extra round, then counted rounds 3.. need the owner. Round 4 is base-only (n differs from k afterwards).
const SPEC = [{ n: 1, admission: 'normal' }, { n: 2, admission: 'auto-extra' }, { n: 3 }, { n: 4, baseOnly: true }, { n: 5 }, { n: 6 }];
const build = (slug, spec = SPEC) => spec.reduce((st, r) => addRound(st, { fromHead: H(0), contentHashAtToHead: `c${r.n}`.padEnd(64, '0'), items: [], toHead: H(r.n), ...r }), emptyState({ repo: slug, pr: 7, branch: 'feat/x', maxRounds: 1 }));
const KS = { 3: 3, 5: 4, 6: 5 }; // round n -> counted ordinal k

function world(t, { spec = SPEC, mode = 'chat', publish = true, localSpec } = {}) {
  const w = roundWorld(t, { max: 1, mode });
  const state = build(w.slug, spec);
  saveState(w.repo.dir, localSpec ? build(w.slug, localSpec) : state);
  if (publish) w.fake.addComment({ body: triageComment(state) });
  w.past = () => w.cli(['triage', 'round-request', '--pr', '7', '--past']);
  w.grant = (n) => w.cli(['state', 'past-round-grant', '--pr', '7', '--round', String(n)]);
  w.published = () => decodeFromComment(w.fake.comments().filter((c) => c.body.includes('claude-pipeline:triage')).at(-1).body);
  // The owner types `prompt` after the reply that ends with the 🔂 line for round n.
  w.approve = (n, { prompt = 'approve round', k = KS[n], head = H(n), after, age } = {}) => {
    const rec = ownerApprovesPast(t, prompt, pastRoundRequest(7, k, head, w.slug), undefined, after);
    assert.ok(rec, 'the recorder wrote the approval');
    cleanupAtExit(markerPath(grantIdOf(rec)));
    t.after(() => rmSync(markerPath(grantIdOf(rec)), { force: true }));
    if (age) { // the record's time moves back (its grant id changes with it, so it is a different record)
      const file = join(ownerGoDir(), `${rec.session}.jsonl`);
      const old = { ...rec, ts: new Date(Date.now() - age).toISOString() };
      writeFileSync(file, `${JSON.stringify(old)}\n`);
      return old;
    }
    return rec;
  };
  w.marker = (rec) => existsSync(markerPath(grantIdOf(rec)));
  return w;
}
// A refusal leaves the review state, the PR and the markers as they were.
function unchanged(w, recs, fn) {
  const state = w.stateText();
  const comments = JSON.stringify(w.fake.comments());
  const r = fn();
  assert.equal(w.stateText(), state, 'state untouched');
  assert.equal(JSON.stringify(w.fake.comments()), comments, 'PR untouched');
  for (const rec of recs) assert.equal(w.marker(rec), false, 'no marker claimed');
  return r;
}

test('pastRoundsNeedingApproval: the plan\'s rules, n != k, exclusions, last round, a gone record', () => {
  const ctx = { maxRounds: 1, repo: 'acme/widgets', pr: 7 };
  const s = build('acme/widgets');
  assert.deepEqual(pastRoundsNeedingApproval(s, s, ctx).map((x) => [x.n, x.k]), [[3, 3], [5, 4]], 'the base-only round counts nothing; the newest round (6) is never one; k = max + 1 (round 2) is not');
  assert.deepEqual(pastRoundsNeedingApproval(s, s, ctx).map((x) => x.toHead), [H(3), H(5)]);
  assert.deepEqual(pastRoundsNeedingApproval(s, s, { ...ctx, maxRounds: undefined }), [], 'no configured cap');
  // published must hold the very same round, and a later counted round
  const forged = { ...s, rounds: s.rounds.map((r) => (r.n === 3 ? { ...r, toHead: H(9) } : r)) };
  assert.deepEqual(pastRoundsNeedingApproval(s, forged, ctx).map((x) => x.n), [5], 'another head in the PR: not the same round');
  assert.deepEqual(pastRoundsNeedingApproval(s, { ...s, rounds: s.rounds.slice(0, 5) }, ctx).map((x) => x.n), [3], 'round 5 is the newest published counted round');
  assert.deepEqual(pastRoundsNeedingApproval(s, { ...s, rounds: s.rounds.slice(0, 2) }, ctx), [], 'not published at all');
  // admission present without a grant: today\'s refusals stay (owner without a grant, a normal admission)
  for (const admission of ['owner', 'normal', 'auto-extra']) {
    const t = build('acme/widgets', SPEC.map((r) => (r.n === 3 ? { ...r, admission } : r)));
    assert.deepEqual(pastRoundsNeedingApproval(t, t, ctx).map((x) => x.n), [5], admission);
  }
  // a grant whose owner record is gone qualifies again; a malformed one does not
  const gone = { grantId: 'a'.repeat(16), k: 3, quote: 'approve round', ownerTs: '2026-11-01T00:00:00.000Z', past: true };
  const g = build('acme/widgets', SPEC.map((r) => (r.n === 3 ? { ...r, ownerGrant: gone } : r)));
  assert.deepEqual(pastRoundsNeedingApproval(g, g, ctx).map((x) => x.n), [3, 5]);
  const bad = build('acme/widgets', SPEC.map((r) => (r.n === 3 ? { ...r, ownerGrant: { ...gone, grantId: 'zz' } } : r)));
  assert.deepEqual(pastRoundsNeedingApproval(bad, bad, ctx).map((x) => x.n), [5]);
});

test('verifyOwnerGrants: the refusal for a qualifying round names the remedy; others keep their text; never throws', () => {
  const s = build('acme/widgets');
  const r = verifyOwnerGrants(s, { repo: 'acme/widgets', pr: 7, maxRounds: 1 });
  assert.equal(r.ok, false);
  const p3 = r.problems.find((x) => x.startsWith('round 3:'));
  assert.match(p3, /counted round 3 is past review\.max_rounds \(1\) and its automatic extra round, and carries no owner grant; it ran before owner grants were recorded, so approve it now: `P triage round-request --pr 7 --past`.*`P state past-round-grant --pr 7 --round 3`/);
  const p6 = r.problems.find((x) => x.startsWith('round 6:'));
  assert.doesNotMatch(p6, /past-round-grant/, 'the newest round is a possible fake: no remedy');
  // with the published state at hand a round the PR does not hold gets none
  const short = { ...s, rounds: s.rounds.slice(0, 2) };
  assert.doesNotMatch(verifyOwnerGrants(s, { repo: 'acme/widgets', pr: 7, maxRounds: 1, published: short }).problems.join('|'), /past-round-grant/);
  assert.doesNotThrow(() => verifyOwnerGrants(null, { published: 7 }));
});

test('display: a past grant admits nothing (no effectiveMaxRounds increase, no autoExtra change)', () => {
  const mk = (ownerGrant) => build('acme/widgets', [{ n: 1, admission: 'normal' }, { n: 2, admission: 'auto-extra', ...(ownerGrant ? { ownerGrant } : {}) }]);
  const g = { grantId: 'b'.repeat(16), k: 2, quote: 'approve round', ownerTs: '2026-11-01T00:00:00.000Z' };
  const none = roundOutcome(build('acme/widgets', SPEC.slice(0, 3)));
  const past = roundOutcome(build('acme/widgets', SPEC.slice(0, 3).map((r) => (r.n === 3 ? { ...r, ownerGrant: { ...g, k: 3, past: true } } : r))));
  const extra = roundOutcome(build('acme/widgets', SPEC.slice(0, 3).map((r) => (r.n === 3 ? { ...r, ownerGrant: { ...g, k: 3 } } : r))));
  assert.equal(past.effectiveMaxRounds, none.effectiveMaxRounds);
  assert.equal(extra.effectiveMaxRounds, none.effectiveMaxRounds + 1, 'control: an extra-round grant does lift it');
  assert.ok(mk(null) && mk(g));
});

test('round-request --past: the oldest qualifying round, a line the hook parses, read-only; refusals come BEFORE the owner is asked', (t) => {
  const w = world(t);
  const r = unchanged(w, [], () => w.past());
  assertExit(r, 0, r.stderr + r.stdout);
  assert.equal(r.json.line, `🔂 Approve past review round #7: round 3 · head ${H(3).slice(0, 12)} · repo ${w.slug}`);
  assert.deepEqual([r.json.k, r.json.n, r.json.head, r.json.past, r.json.remaining], [3, 3, H(3), true, [{ n: 5, k: 4 }]]);
  assert.deepEqual(presentedPastRoundRequest(`words\n${r.json.line}`), { pr: 7, k: 3, head: H(3).slice(0, 12), repo: w.slug });
  assert.equal(presentedPastRoundRequest(r.json.line.replace('🔂 Approve past review', '🔁 Extra review')), null);
  // refusals
  const label = world(t, { mode: 'label' });
  assert.equal(unchanged(label, [], () => label.past()).json.error, 'label-mode');
  const wrongPr = unchanged(w, [], () => w.cli(['triage', 'round-request', '--pr', '8', '--past']));
  assert.equal(wrongPr.json.error, 'state-pr-mismatch');
  const behind = world(t, { localSpec: SPEC.slice(0, 5) }); // the PR holds round 6, this copy lacks it
  const b = unchanged(behind, [], () => behind.past());
  assertExit(b, 1);
  assert.equal(b.json.error, 'stale-history');
  assert.match(b.json.reason, /pipeline state show --pr 7/);
  const ahead = world(t, { localSpec: [...SPEC, { n: 7 }] });
  const a = unchanged(ahead, [], () => ahead.past());
  assert.equal(a.json.error, 'unpublished-history');
  assert.match(a.json.reason, /pipeline comment --pr 7 --kind triage/);
  const none = world(t, { spec: SPEC.slice(0, 3) });
  assert.equal(unchanged(none, [], () => none.past()).json.error, 'nothing-to-approve');
  const unpublished = world(t, { publish: false });
  assert.equal(unchanged(unpublished, [], () => unpublished.past()).json.error, 'no-published-history');
});

test('past-round-grant: the happy path (n != k), verifyOwnerGrants accepts the round, the grant admits nothing, the PR holds it', (t) => {
  const w = world(t);
  const rec3 = w.approve(3);
  const r = w.grant(3);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.deepEqual([r.json.ok, r.json.round, r.json.k, r.json.grantId, r.json.claimed, r.json.saved, r.json.published, r.json.remaining], [true, 3, 3, grantIdOf(rec3), [grantIdOf(rec3)], true, true, [{ n: 5, k: 4 }]]);
  const local = w.state().rounds.find((x) => x.n === 3);
  assert.deepEqual(local.ownerGrant, { grantId: grantIdOf(rec3), k: 3, quote: 'approve round', ownerTs: rec3.ts, past: true });
  assert.equal(local.admission, 'owner');
  assert.deepEqual(w.published().rounds.find((x) => x.n === 3).ownerGrant, local.ownerGrant);
  const v = verifyOwnerGrants(w.state(), { repo: w.slug, pr: 7, maxRounds: 1 });
  assert.equal(v.problems.some((p) => p.startsWith('round 3:')), false, v.problems.join('|'));
  assert.deepEqual(v.granted.map((g) => [g.n, g.k, g.past]), [[3, 3, true]]);
  // the second round (k 4, after the base-only round 4)
  w.approve(5);
  const r5 = w.grant(5);
  assertExit(r5, 0, r5.stderr + r5.stdout);
  assert.deepEqual([r5.json.k, r5.json.remaining], [4, []]);
  const all = verifyOwnerGrants(w.state(), { repo: w.slug, pr: 7, maxRounds: 1 });
  assert.deepEqual(all.problems.map((p) => p.slice(0, 8)), ['round 6:'], 'only the newest round still needs its own grant');
  assert.equal(roundOutcome(w.state()).effectiveMaxRounds, 2, 'a past grant lifted no limit');
  const again = w.grant(3);
  assertExit(again, 2);
  assert.equal(again.json.error, 'already-approved');
});

test('past-round-grant: refusals before the claim leave state, PR and markers unchanged', (t) => {
  const w = world(t);
  const noRec = unchanged(w, [], () => w.grant(3));
  assertExit(noRec, 2);
  assert.equal(noRec.json.error, 'no-grant');
  assert.match(noRec.json.message, /P triage round-request --pr 7 --past/);
  const others = [w.approve(3, { k: 4 }), w.approve(3, { head: H(9) }), w.approve(5)]; // another k, another head, another round
  const extra = ownerGrants(t, 'extra round', roundRequest(7, 3, H(3), w.slug));
  assert.ok(extra);
  cleanupAtExit(markerPath(grantIdOf(extra)));
  const synthetic = w.approve(3, { after: { promptSource: 'system', isMeta: true, entrypoint: 'cli' } });
  const expired = w.approve(3, { age: 30 * 3600_000 });
  assert.equal(unchanged(w, [...others, extra, synthetic, expired], () => w.grant(3)).json.error, 'no-grant');
  // not eligible: the newest round, a round the PR lacks, an earlier round
  for (const n of [6, 9, 2]) {
    const e = unchanged(w, others, () => w.grant(n));
    assert.equal(e.json.error, 'not-eligible', `round ${n}`);
  }
  const label = world(t, { mode: 'label' });
  const l = unchanged(label, [], () => label.grant(3));
  assertExit(l, 2);
  assert.equal(l.json.error, 'label-mode');
  // out of sync
  const behind = world(t, { localSpec: SPEC.slice(0, 5) });
  const rb = behind.approve(3);
  assert.equal(unchanged(behind, [rb], () => behind.grant(3)).json.error, 'stale-history');
  const ahead = world(t, { localSpec: [...SPEC, { n: 7 }] });
  const ra = ahead.approve(3);
  assert.equal(unchanged(ahead, [ra], () => ahead.grant(3)).json.error, 'unpublished-history');
});

test('past-round-grant: grant metadata that is only local must verify; one that does not refuses before the claim', (t) => {
  const bogus = { grantId: 'c'.repeat(16), k: 3, quote: 'approve round', ownerTs: '2026-11-01T00:00:00.000Z', past: true };
  const w = world(t, { localSpec: SPEC.map((r) => (r.n === 3 ? { ...r, ownerGrant: bogus, admission: 'owner' } : r)) });
  const rec = w.approve(5);
  const r = unchanged(w, [rec], () => w.grant(5));
  assertExit(r, 2);
  assert.equal(r.json.error, 'unverified-grant');
  assert.match(r.json.message, /round 3/);
});

test('past-round-grant: duplicates are claimed together; the newest is recorded', (t) => {
  const w = world(t);
  const first = w.approve(3);
  const second = w.approve(3, { prompt: 'approve past round' });
  const r = w.grant(3);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.equal(r.json.claimed.length, 2);
  assert.equal(w.marker(first) && w.marker(second), true);
  assert.deepEqual([...r.json.claimed].sort(), [grantIdOf(first), grantIdOf(second)].sort());
  assert.ok([grantIdOf(first), grantIdOf(second)].includes(r.json.grantId));
  assert.equal(w.state().rounds.find((x) => x.n === 3).ownerGrant.grantId, r.json.grantId);
});

test('past-round-grant: resumes after the claim (a save that failed, 24 h later): no new claim, leftovers claimed', (t) => {
  const w = world(t);
  const old = w.approve(3, { age: 30 * 3600_000 }); // typed 30 h ago, claimed by a run that then stopped before saving
  const claim = claimGrantMarkers([old], { repo: w.slug, pr: 7, k: 3, head: H(3), checkout: w.repo.dir });
  assert.equal(claim.ok, true);
  const dup = w.approve(3, { prompt: 'extra round' }); // a leftover unspent duplicate, typed now
  const r = w.grant(3);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.deepEqual([r.json.grantId, r.json.claimed, r.json.saved, r.json.published], [grantIdOf(old), [grantIdOf(dup)], true, true]);
  assert.equal(w.marker(dup), true, 'the leftover was claimed');
  const v = verifyOwnerGrants(w.state(), { repo: w.slug, pr: 7, maxRounds: 1 });
  assert.equal(v.problems.some((p) => p.startsWith('round 3:')), false, v.problems.join('|'));
});

test('past-round-grant: a publish failure keeps the saved approval, retrying publishes it without a new claim', (t) => {
  const w = world(t);
  const rec = w.approve(3);
  w.fake.setFail({ write: true });
  const r = w.grant(3);
  assertExit(r, 3, r.stderr + r.stdout);
  assert.deepEqual([r.json.unavailable, r.json.saved, r.json.published, r.json.claimed], [true, true, false, [grantIdOf(rec)]]);
  assert.match(r.json.next, /past-round-grant --pr 7 --round 3/);
  assert.equal(w.marker(rec), true);
  assert.equal(w.published().rounds.find((x) => x.n === 3).ownerGrant, undefined, 'the PR does not hold it yet');
  w.fake.setFail({});
  const again = w.grant(3);
  assertExit(again, 0, again.stderr + again.stdout);
  assert.deepEqual([again.json.saved, again.json.published, again.json.claimed], [false, true, []]);
  assert.equal(w.published().rounds.find((x) => x.n === 3).ownerGrant.grantId, grantIdOf(rec));
  assert.ok(readFileSync(join(w.repo.dir, '.review', 'state.json'), 'utf8').includes(grantIdOf(rec)));
});

test('past-round-grant: re-approval of a round whose published grant no longer verifies replaces it and publishes', (t) => {
  const gone = { grantId: 'd'.repeat(16), k: 3, quote: 'approve round', ownerTs: '2026-10-01T00:00:00.000Z', past: true };
  const spec = SPEC.map((r) => (r.n === 3 ? { ...r, ownerGrant: gone, admission: 'owner' } : r));
  const w = world(t, { spec });
  const first = w.past();
  assertExit(first, 0, first.stderr + first.stdout);
  assert.equal(first.json.n, 3, 'the round with the unverifiable grant is asked again');
  const rec = w.approve(3);
  const r = w.grant(3);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.equal(w.published().rounds.find((x) => x.n === 3).ownerGrant.grantId, grantIdOf(rec));
  assert.equal(w.state().rounds.find((x) => x.n === 3).ownerGrant.grantId, grantIdOf(rec));
});

test('past-round-grant: a stale baseline while this copy equals the PR is refreshed before the claim, so the approval publishes', (t) => {
  const w = world(t);
  writeBaseline(w.repo.dir, 7, 'e'.repeat(64)); // e.g. a crash between the PR upsert and the baseline write of an earlier publication
  const rec = w.approve(3);
  const r = w.grant(3);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.deepEqual([r.json.saved, r.json.published], [true, true]);
  assert.equal(w.published().rounds.find((x) => x.n === 3).ownerGrant.grantId, grantIdOf(rec));
  assert.equal(readBaseline(w.repo.dir, 7), reviewContentHash(w.published()), 'the baseline follows the publication');
});

test('past-round-grant: re-approval whose publication fails does not offer `pipeline comment` (it cannot publish a replacement); a first approval still does', (t) => {
  const gone = { grantId: 'd'.repeat(16), k: 3, quote: 'approve round', ownerTs: '2026-10-01T00:00:00.000Z', past: true };
  const w = world(t, { spec: SPEC.map((r) => (r.n === 3 ? { ...r, ownerGrant: gone, admission: 'owner' } : r)) });
  w.approve(3);
  w.fake.setFail({ write: true });
  const r = w.grant(3);
  assertExit(r, 3, r.stderr + r.stdout);
  assert.match(r.json.next, /past-round-grant --pr 7 --round 3/);
  assert.doesNotMatch(r.json.next, /pipeline comment/);
  const first = world(t);
  first.approve(3);
  first.fake.setFail({ write: true });
  const f = first.grant(3);
  assertExit(f, 3, f.stderr + f.stdout);
  assert.match(f.json.next, /pipeline comment --pr 7 --kind triage/);
});

test('state show: a local-only owner grant that does not verify is dropped (the PR is the history), so past-round-grant is not refused forever', (t) => {
  const bogus = { grantId: 'c'.repeat(16), k: 3, quote: 'approve round', ownerTs: '2026-11-01T00:00:00.000Z', past: true };
  const w = world(t, { localSpec: SPEC.map((r) => (r.n === 3 ? { ...r, ownerGrant: bogus, admission: 'owner' } : r)) });
  const rec = w.approve(5);
  const refused = w.grant(5);
  assert.equal(refused.json.error, 'unverified-grant');
  assert.match(refused.json.message, /state show/);
  const show = w.cli(['state', 'show', '--pr', '7']);
  assertExit(show, 0, show.stderr + show.stdout);
  assert.deepEqual([show.json.grantsDropped, show.json.source, show.json.quarantinedTo], [[3], 'local', undefined]);
  const round3 = w.state().rounds.find((x) => x.n === 3);
  assert.deepEqual([round3.ownerGrant, round3.admission], [undefined, undefined], 'back to what the PR holds');
  const r = w.grant(5);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.deepEqual([r.json.published, r.json.claimed], [true, [grantIdOf(rec)]]);
});

test('state show: another checkout published only a grant; this copy keeps its unpublished mark and trailing round, adopts the grant, is not quarantined', (t) => {
  const item = { id: 'R1-B1', round: 1, bucket: 'BLOCKING', category: 'bug', title: 'x', file: 'src/a.js', line: 1, detail: 'd', fingerprint: 'f'.repeat(40), final: { decision: 'ACCEPT', by: 'judge', needsHuman: false, reason: 'r' } };
  const withItem = (spec, extra = {}) => spec.map((r) => (r.n === 1 ? { ...r, items: [{ ...item, ...extra }] } : r));
  const w = world(t, { spec: withItem(SPEC), localSpec: [...withItem(SPEC, { implemented: true }), { n: 7 }] });
  writeBaseline(w.repo.dir, 7, reviewContentHash(build(w.slug, withItem(SPEC)))); // this copy last saw the PR before the other checkout published
  const grant = { grantId: 'a'.repeat(16), k: 3, quote: 'approve round', ownerTs: '2026-11-01T00:00:00.000Z', past: true };
  const theirs = build(w.slug, withItem(SPEC.map((r) => (r.n === 3 ? { ...r, ownerGrant: grant, admission: 'owner' } : r))));
  w.fake.addComment({ body: triageComment(theirs) });
  const show = w.cli(['state', 'show', '--pr', '7']);
  assertExit(show, 0, show.stderr + show.stdout);
  assert.equal(show.json.quarantinedTo, undefined, JSON.stringify(show.json));
  assert.deepEqual([show.json.source, show.json.grantsRestored], ['local-ahead', [3]]);
  const local = w.state();
  assert.equal(local.rounds[0].items[0].implemented, true, 'the unpublished mark is kept');
  assert.ok(local.rounds.some((r) => r.n === 7), 'so is the trailing round');
  assert.deepEqual(local.rounds.find((r) => r.n === 3).ownerGrant, grant);
  assert.equal(readBaseline(w.repo.dir, 7), reviewContentHash(theirs), 'this copy has now seen everything the PR holds');
});

// Another checkout applied Fable to a round with no items (a round-level modelProof, in the content hash) and published it; this copy never saw that.
const proof = { transcript: '/tmp/t.jsonl', models: ['claude-fable-5'] };
const withProof = (spec) => spec.map((r) => (r.n === 2 ? { ...r, modelProof: proof } : r));
function staleWorld(t, { grant } = {}) {
  const w = world(t);
  const theirs = build(w.slug, SPEC).rounds.map((r) => (r.n === 2 ? { ...r, modelProof: proof } : r.n === 3 && grant ? { ...r, ownerGrant: grant, admission: 'owner' } : r));
  writeBaseline(w.repo.dir, 7, reviewContentHash(build(w.slug))); // this copy last saw the PR before the other checkout published
  w.fake.addComment({ body: triageComment({ ...build(w.slug), rounds: theirs }) });
  return w;
}

test('state show: a copy that lacks a published round-level proof does not move its baseline onto the PR (adopting a grant included), so it cannot erase the proof', (t) => {
  const grant = { grantId: 'a'.repeat(16), k: 3, quote: 'approve round', ownerTs: '2026-11-01T00:00:00.000Z', past: true };
  const w = staleWorld(t, { grant });
  const show = w.cli(['state', 'show', '--pr', '7']);
  assertExit(show, 0, show.stderr + show.stdout);
  assert.deepEqual([show.json.source, show.json.grantsRestored], ['local', [3]]);
  assert.notEqual(readBaseline(w.repo.dir, 7), reviewContentHash(w.published()), 'the baseline still differs from the PR');
  const pub = w.cli(['comment', '--pr', '7', '--kind', 'triage']);
  assert.notEqual(pub.status, 0, pub.stderr + pub.stdout);
  assert.deepEqual(w.published().rounds.find((r) => r.n === 2).modelProof, proof, 'the PR keeps the proof');
});

test('past-round-grant: a stale copy that lacks a published round-level proof is refused BEFORE the claim (nothing spent), and the PR keeps the proof', (t) => {
  const w = staleWorld(t);
  const rec = w.approve(3);
  const r = unchanged(w, [rec], () => w.grant(3));
  assertExit(r, 2);
  assert.equal(r.json.error, 'stale-publication');
  assert.match(r.json.message, /state show --pr 7/);
  assert.deepEqual(w.published().rounds.find((x) => x.n === 2).modelProof, proof);
});

test('state show: a local-only grant that verifies is KEPT (no grantsDropped), and the retried past-round-grant publishes it without a new claim', (t) => {
  const w = world(t);
  const rec = w.approve(3);
  w.fake.setFail({ write: true });
  const failed = w.grant(3);
  assertExit(failed, 3, failed.stderr + failed.stdout);
  assert.equal(failed.json.saved, true);
  const show = w.cli(['state', 'show', '--pr', '7']);
  assertExit(show, 0, show.stderr + show.stdout);
  assert.equal(show.json.grantsDropped, undefined, JSON.stringify(show.json));
  const round3 = w.state().rounds.find((x) => x.n === 3);
  assert.deepEqual([round3.ownerGrant.grantId, round3.admission], [grantIdOf(rec), 'owner']);
  w.fake.setFail({});
  const again = w.grant(3);
  assertExit(again, 0, again.stderr + again.stdout);
  assert.deepEqual([again.json.published, again.json.claimed], [true, []]);
  assert.equal(w.published().rounds.find((x) => x.n === 3).ownerGrant.grantId, grantIdOf(rec));
});

test('state show: a saved grant is verified against the gh repository, not the slug the state recorded (after a repository move they differ)', (t) => {
  const w = world(t);
  const rec = w.approve(3);
  w.fake.setFail({ write: true });
  assertExit(w.grant(3), 3);
  saveState(w.repo.dir, { ...w.state(), repo: 'old-org/old-name' }); // the state predates the move
  const show = w.cli(['state', 'show', '--pr', '7']);
  assertExit(show, 0, show.stderr + show.stdout);
  assert.equal(show.json.grantsDropped, undefined, JSON.stringify(show.json));
  assert.equal(w.state().rounds.find((x) => x.n === 3).ownerGrant.grantId, grantIdOf(rec));
});
