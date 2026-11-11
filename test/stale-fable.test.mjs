// Old Fable proofs are re-reviewed, not grandfathered (plan 2026-11-10, A4b): which proven Fable rounds are stale, and how an uncounted
// "Fable refresh" round is treated by the round cap and the Fable-pending rule. The CLI side (state fable-refresh, review-complete, the final
// gate) is in cli-review.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyState, addRound } from '../pipeline/lib/state.mjs';
import { MIN_FABLE } from '../pipeline/lib/model-floor.mjs';
import {
  countsTowardCap, fablePendingRounds, provenNotStale, reviewedRoundCount, fableBypassNote, fableBypassRounds, reviewValidFor, roundAdmission, roundOutcome, staleFableReason, staleFableRounds,
} from '../pipeline/lib/triage.mjs';

const OLD = 'claude-fable-5-1';
const NEW = 'claude-fable-5-2';

// A proven (or not) Fable round: models is the recorded modelProof.models; scope the stored arbiter.scope.
const fable = (n, { models = { [OLD]: 1 }, scope, proven = true, over = {} } = {}) => ({
  n, fromHead: `h${n - 1}`, toHead: `h${n}`, contentHashAtToHead: `c${n}`, items: [], fableRequired: true, fableReasons: ['x'], sensitivePaths: [],
  arbiter: { proofOk: proven, ...(scope ? { scope } : {}) },
  ...(proven && models ? { modelProof: { transcript: '/t.jsonl', models } } : {}),
  ...over,
});
const stateOf = (...rounds) => ({ ...emptyState({ repo: 'o/r', pr: 7, branch: 'b', risk: 'low', lightLane: false, maxRounds: 3 }), rounds });

test('staleFableRounds: a Fable round proven below MIN_FABLE is stale, and names its model', () => {
  assert.equal(MIN_FABLE, NEW, 'the cases below assume the floor constant is 5.2');
  assert.deepEqual(staleFableRounds(stateOf(fable(1))), [{ round: 1, models: [OLD] }]);
  assert.deepEqual(staleFableRounds(stateOf(fable(1), fable(2, { models: { [OLD]: 2, 'claude-fable-5': 1 } }))).map((s) => [s.round, s.models]), [[1, [OLD]], [2, ['claude-fable-5', OLD]]]);
});

test('staleFableRounds: nothing at or above MIN_FABLE, no Fable round, an unproven round or a non-Fable model is not stale', () => {
  assert.deepEqual(staleFableRounds(stateOf(fable(1, { models: { [NEW]: 1 } }))), []);
  assert.deepEqual(staleFableRounds(stateOf(fable(1, { models: { 'claude-fable-5-3': 1, 'claude-fable-6': 1, 'claude-fable-5-2-20261101': 1 } }))), []);
  assert.deepEqual(staleFableRounds(stateOf({ n: 1, items: [], toHead: 'h' })), [], 'a round that never needed Fable');
  assert.deepEqual(staleFableRounds(stateOf()), []);
  assert.deepEqual(staleFableRounds(null), []);
  assert.deepEqual(staleFableRounds(stateOf(fable(1, { proven: false }))), [], 'an unproven pass is Fable-pending, not stale');
  assert.deepEqual(staleFableRounds(stateOf(fable(1, { models: { 'claude-opus-4-1': 1 } }))), []);
  assert.deepEqual(staleFableRounds(stateOf(fable(1, { models: null }))), [], 'a proof that recorded no model says nothing');
  assert.deepEqual(staleFableRounds(stateOf(fable(1, { over: { baseOnly: true } }))), []);
});

test('staleFableRounds: an unparseable claude-fable-* id is stale (fail closed); another family\'s unparseable id is ignored', () => {
  assert.deepEqual(staleFableRounds(stateOf(fable(1, { models: { 'claude-fable-x': 1 } }))), [{ round: 1, models: ['claude-fable-x'] }]);
  assert.deepEqual(staleFableRounds(stateOf(fable(1, { models: { 'claude-fable': 1 } }))), [{ round: 1, models: ['claude-fable'] }]);
  assert.deepEqual(staleFableRounds(stateOf(fable(1, { models: { 'claude-sonnet-x': 1 } }))), []);
  assert.deepEqual(staleFableRounds(stateOf(fable(1, { models: { [NEW]: 1, 'claude-fable-5-1': 1 } }))), [{ round: 1, models: [OLD] }], 'one old Fable among the models is enough');
});

test('staleFableRounds: a LATER proven whole-PR pass at or above MIN_FABLE replaces the old proof', () => {
  assert.deepEqual(staleFableRounds(stateOf(fable(1), fable(2, { models: { [NEW]: 1 }, scope: 'whole-pr' }))), []);
  assert.deepEqual(staleFableRounds(stateOf(fable(1), fable(2), fable(3, { models: { 'claude-fable-5-3': 1 }, scope: 'whole-pr' }))), [], 'one whole-PR pass replaces every earlier old proof');
});

test('staleFableRounds: a later pass that reviewed only its own round, has no stored scope, is unproven, earlier, or itself stale does not replace it', () => {
  assert.deepEqual(staleFableRounds(stateOf(fable(1), fable(2, { models: { [NEW]: 1 }, scope: 'round' }))).map((s) => s.round), [1]);
  assert.deepEqual(staleFableRounds(stateOf(fable(1), fable(2, { models: { [NEW]: 1 } }))).map((s) => s.round), [1], 'no stored scope: not a superseder');
  assert.deepEqual(staleFableRounds(stateOf(fable(1), fable(2, { models: { [NEW]: 1 }, scope: 'whole-pr', proven: false }))).map((s) => s.round), [1]);
  assert.deepEqual(staleFableRounds(stateOf(fable(1), fable(2, { models: { [OLD]: 1 }, scope: 'whole-pr' }))).map((s) => s.round), [1, 2], 'a whole-PR pass with the old Fable is itself stale');
  assert.deepEqual(staleFableRounds(stateOf(fable(1), fable(2, { models: { [NEW]: 1, [OLD]: 1 }, scope: 'whole-pr' }))).map((s) => s.round), [1, 2], 'a mixed-model pass is stale');
  assert.deepEqual(staleFableRounds(stateOf(fable(1, { models: { [NEW]: 1 }, scope: 'whole-pr' }), fable(2))).map((s) => s.round), [2], 'an EARLIER fresh pass does not replace a later old proof');
  assert.deepEqual(staleFableRounds(stateOf(fable(1), fable(2, { models: {}, scope: 'whole-pr' }))).map((s) => s.round), [1], 'a proof that names no Fable replaces nothing');
});

test('staleFableRounds: a fresh slice-only pass followed by a fresh whole-PR pass still replaces the old proof', () => {
  // round 2 is fresh but only reviewed its slice; round 3 is fresh and whole-PR: the old proof of round 1 is replaced
  assert.deepEqual(staleFableRounds(stateOf(fable(1), fable(2, { models: { [NEW]: 1 }, scope: 'round' }), fable(3, { models: { [NEW]: 1 }, scope: 'whole-pr' }))), []);
});

test('staleFableReason names the rounds, their models and the command that clears it', () => {
  const r = staleFableReason(staleFableRounds(stateOf(fable(1), fable(3, { models: { 'claude-fable-5': 1 } }))), 7);
  assert.match(r, /round 1 \(claude-fable-5-1\), 3 \(claude-fable-5\) was proven with a Fable older than claude-fable-5-2/);
  assert.match(r, /run `pipeline state fable-refresh --pr 7`/);
});

test('provenNotStale: only a proven Fable round with no Fable below MIN_FABLE counts as an earlier pass for the whole-PR rule', () => {
  assert.equal(provenNotStale(fable(1, { models: { [NEW]: 1 } })), true);
  assert.equal(provenNotStale(fable(1, { models: null })), true, 'a proof that recorded no model counts as it always did');
  assert.equal(provenNotStale(fable(1)), false);
  assert.equal(provenNotStale(fable(1, { proven: false })), false);
  assert.equal(provenNotStale({ n: 1, items: [] }), false);
});

// ---- the refresh round: uncounted, but Fable-pending until proven -----------------------------------------------------------------

const withRefresh = (state, n, { proven = false } = {}) => addRound(state, {
  n, fromHead: state.rounds.at(-1).toHead, toHead: state.rounds.at(-1).toHead, contentHashAtToHead: state.rounds.at(-1).contentHashAtToHead, items: [],
  fableRefresh: true, fableRequired: true, fableReasons: ['fable-refresh: rounds 1 proven with claude-fable-5-1 below claude-fable-5-2'], sensitivePaths: [],
  forkPoint: 'fork', codexModel: 'm',
}).rounds.map((r) => (r.n === n && proven ? { ...r, arbiter: { proofOk: true, scope: 'whole-pr' }, modelProof: { transcript: '/t', models: { [NEW]: 1 } } } : r));

test('addRound keeps fableRefresh and records no admission for it (it is never a counted round)', () => {
  const state = { ...stateOf(fable(1)), rounds: withRefresh(stateOf(fable(1)), 2) };
  const r = state.rounds[1];
  assert.deepEqual([r.fableRefresh, r.fableRequired, r.admission, r.forkPoint, r.codexModel], [true, true, undefined, 'fork', 'm']);
  assert.equal(countsTowardCap(r), false);
  assert.equal(countsTowardCap(state.rounds[0]), true);
});

test('a refresh round is not counted against max_rounds, even past the cap, and takes no extra or granted round', () => {
  const base = stateOf(fable(1), fable(2), fable(3, { models: { [OLD]: 1 } }));
  assert.equal(base.maxRounds, 3);
  const state = { ...base, rounds: withRefresh(base, 4) };
  assert.equal(reviewedRoundCount(state), 3, 'three counted rounds; the refresh is the fourth round but not a counted one');
  assert.deepEqual(roundAdmission(state, 5, { fableRefresh: true }), { admission: 'uncounted', problem: null });
  assert.equal(roundAdmission(state, 5, {}).problem !== null, true, 'a counted round 4 would pass the cap');
  const outcome = roundOutcome({ ...state, currentContentHash: 'c3' });
  assert.equal(outcome.extraRound, false);
  assert.equal(outcome.autoExtraOrdinal, null);
});

test('a refresh round is Fable-pending until a proven pass, and then review is valid again', () => {
  const base = stateOf(fable(1));
  const pending = { ...base, rounds: withRefresh(base, 2) };
  assert.deepEqual(fablePendingRounds(pending), [2]);
  assert.equal(roundOutcome({ ...pending, currentContentHash: 'c1' }).clean, false);
  assert.equal(reviewValidFor(pending, 'c1'), false);
  // the old proof is still stale while the refresh is unproven
  assert.deepEqual(staleFableRounds(pending).map((s) => s.round), [1]);

  const proven = { ...base, rounds: withRefresh(base, 2, { proven: true }) };
  assert.deepEqual(fablePendingRounds(proven), []);
  assert.deepEqual(staleFableRounds(proven), []);
  assert.equal(roundOutcome({ ...proven, currentContentHash: 'c1' }).clean, true);
  assert.equal(reviewValidFor(proven, 'c1'), true);
});

// ---- review round 1: the threshold is passed in (R1-B1) and an allowed exact id is current (R1-F1) ----
test('staleFableRounds / provenNotStale take the re-review threshold: an owner hold below MIN_FABLE makes the held Fable current', () => {
  const state = stateOf(fable(1));
  assert.deepEqual(staleFableRounds(state, { threshold: 'claude-fable-5-1', allow: [] }), []);
  assert.equal(provenNotStale(state.rounds[0], { threshold: 'claude-fable-5-1', allow: [] }), true);
  assert.deepEqual(staleFableRounds(state, { threshold: 'claude-fable-5-2', allow: [] }), [{ round: 1, models: [OLD] }]);
  assert.deepEqual(staleFableRounds(state), [{ round: 1, models: [OLD] }], 'no gate: MIN_FABLE');
  assert.match(staleFableReason(staleFableRounds(state), 7, 'claude-fable-5-3'), /older than claude-fable-5-3:/);
  // an even older proof is still stale under the hold, unless a later whole-PR pass at the held version replaces it
  const older = stateOf(fable(1, { models: { 'claude-fable-5': 1 } }), fable(2));
  assert.deepEqual(staleFableRounds(older, { threshold: 'claude-fable-5-1', allow: [] }).map((s) => s.round), [1]);
  assert.deepEqual(staleFableRounds(older, { threshold: 'claude-fable-5-1', allow: [] }).map((s) => s.models), [['claude-fable-5']]);
  const replaced = stateOf(fable(1, { models: { 'claude-fable-5': 1 } }), fable(2, { scope: 'whole-pr', models: { [OLD]: 1 } }));
  assert.deepEqual(staleFableRounds(replaced, { threshold: 'claude-fable-5-1', allow: [] }), []);
  assert.deepEqual(staleFableRounds(replaced).map((s) => s.round), [1, 2], 'without the hold the 5.1 pass cannot replace anything');
});

test('an unparseable claude-fable-* id is stale unless the owner allowed that exact id; an allowed pass can supersede', () => {
  const ID = 'claude-fable-6-preview';
  const state = stateOf(fable(1, { models: { [ID]: 1 } }));
  assert.deepEqual(staleFableRounds(state), [{ round: 1, models: [ID] }]);
  assert.deepEqual(staleFableRounds(state, { threshold: MIN_FABLE, allow: [ID] }), []);
  assert.deepEqual(staleFableRounds(state, { threshold: MIN_FABLE, allow: ['claude-fable-6'] }), [{ round: 1, models: [ID] }], 'exact match only');
  const later = stateOf(fable(1), fable(2, { models: { [ID]: 1 }, scope: 'whole-pr' }));
  assert.deepEqual(staleFableRounds(later, { threshold: MIN_FABLE, allow: [ID] }), []);
});

// ---- review round 2: R2-F2 (d) the allowance covers only an id the parser cannot read; a standing bypass is named ----
test('R2-F2 (d): an allowed id the parser reads and the threshold has passed is stale again; an unreadable allowed id and one at or above the threshold stay current', () => {
  const state = stateOf(fable(1));
  assert.deepEqual(staleFableRounds(state, { threshold: MIN_FABLE, allow: [OLD] }), [{ round: 1, models: [OLD] }], 'forgotten allowance of 5.1 under a 5.2 threshold');
  assert.equal(provenNotStale(state.rounds[0], { threshold: MIN_FABLE, allow: [OLD] }), false);
  assert.deepEqual(staleFableRounds(state, { threshold: OLD, allow: [OLD] }), [], 'at the threshold it is current with or without the allowance');
  assert.deepEqual(staleFableRounds(stateOf(fable(1, { models: { 'claude-fable-6-preview': 1 } })), { threshold: MIN_FABLE, allow: ['claude-fable-6-preview'] }), []);
  const later = stateOf(fable(1), fable(2, { models: { [OLD]: 1 }, scope: 'whole-pr' }));
  assert.deepEqual(staleFableRounds(later, { threshold: MIN_FABLE, allow: [OLD] }).map((s) => s.round), [1, 2], 'an allowed older pass cannot replace anything');
});

test('R2-F2 (b): fableBypassRounds lists the proven rounds that count only through the allowance or a hold below MIN_FABLE; fableBypassNote words them', () => {
  const ID = 'claude-fable-6-preview';
  const state = stateOf(fable(1, { models: { [NEW]: 1 } }), fable(2, { models: { [ID]: 1 } }), fable(3, { models: { [OLD]: 1 } }), fable(4, { models: { [NEW]: 1 }, proven: false }));
  assert.deepEqual(fableBypassRounds(state, { threshold: MIN_FABLE, allow: [] }), [], 'no bypass in force: nothing is current-by-bypass (rounds 2 and 3 are stale)');
  const allow = { threshold: MIN_FABLE, allow: [ID] };
  assert.deepEqual(fableBypassRounds(state, allow), [{ round: 2, via: 'allow', id: ID }]);
  assert.equal(fableBypassNote(fableBypassRounds(state, allow), allow), `Fable round 2 counted via owner allowance ${ID}`);
  const hold = { threshold: OLD, allow: [] };
  assert.deepEqual(fableBypassRounds(state, hold), [{ round: 3, via: 'hold', id: OLD }]);
  assert.equal(fableBypassNote(fableBypassRounds(state, hold), hold), 'Fable round 3 counted via owner hold claude-fable-5-1 (below claude-fable-5-2)');
  const both = { threshold: OLD, allow: [ID] };
  assert.equal(fableBypassNote(fableBypassRounds(state, both), both),
    `Fable round 2 counted via owner allowance ${ID}; Fable round 3 counted via owner hold claude-fable-5-1 (below claude-fable-5-2)`);
  assert.equal(fableBypassNote([], both), null);
  assert.deepEqual(fableBypassRounds(stateOf(), both), []);
  assert.deepEqual(fableBypassRounds(null, both), []);
  // a stale round is never named as counted: an allowance for 5.1 does not make it current under a 5.2 threshold
  assert.deepEqual(fableBypassRounds(stateOf(fable(1)), { threshold: MIN_FABLE, allow: [OLD] }), []);
});
