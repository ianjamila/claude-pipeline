// The pure rules of extra-round discipline (plan 2026-11-11-round-discipline-one-implementer.md, Item 1): the severity of an open item, whether the
// round limit may be closed by deferring the accepted fixes, the deferral itself, and what the rest of the loop does with a deferral (the Rulings inventory,
// the result cache, Claude's own rulings, the owner's override). Nothing here runs a command: test/cli-triage-round-request.test.mjs and
// test/cli-triage-defer-fixes.test.mjs do that.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyClaudeRuling, applyOwnerRuling, applyRoundCapDefer, claudeRulingRefusal, claudeRulingRows, deferEligibility, deferItemsInState, isRoundCapDeferral,
  itemSeverity, needsHumanCause, reuseRuled, reviewEligibilityProblems, roundCapDeferRefusal, roundOutcome, ruledCacheFrom, rulingsBlock, rulingsDigest,
  rulingsInventory,
} from '../pipeline/lib/triage.mjs';

// ---- fixtures -------------------------------------------------------------------------------

const HASH = 'a'.repeat(64);
let seq = 0;
function item(over = {}) {
  seq += 1;
  return {
    id: `R1-S${seq}`, round: 1, bucket: 'SUGGESTION', category: 'maintainability', title: `finding ${seq}`, file: 'src/big.js', line: 10,
    detail: 'detail', codexReasoning: 'codex reasoning', testable: false, fingerprint: `fp-${seq}`,
    judge: null, test: { status: 'none', evidence: '' }, arbiter: null,
    final: { decision: 'ACCEPT', by: 'judge', needsHuman: false, reason: 'worth doing' }, implemented: true, followupIssue: null, ...over,
  };
}
const round = (n, items, over = {}) => ({ n, fromHead: 'f'.repeat(40), toHead: 'e'.repeat(40), contentHashAtToHead: HASH, items, ...over });
// Two counted rounds at max_rounds 1: round 1 (settled, fixed, reviewed), round 2 (the automatic extra round) holds the accepts nobody reviewed.
const stateOf = (items, { maxRounds = 1, extra = [], rounds } = {}) => ({
  pr: 7, maxRounds, currentContentHash: HASH,
  rounds: rounds ?? [round(1, [item({ id: 'R1-S0', round: 1, fingerprint: 'fp-0', file: 'src/a.js' })]), round(2, items.map((i) => ({ ...i, round: 2 })), { admission: 'auto-extra' }), ...extra],
});
const FILES = [{ oldPath: 'src/a.js', newPath: 'src/a.js', path: 'src/a.js' }, { oldPath: 'src/big.js', newPath: 'src/big.js', path: 'src/big.js' }, { oldPath: 'src/old.js', newPath: 'src/new.js', path: 'src/new.js' }];
const CONFIG = { risk: { high_risk_paths: ['src/payroll/**'] }, review: { arbiter_always_paths: [] } };
const sev = (it, over = {}) => itemSeverity(it, { state: stateOf([it]), config: CONFIG, files: FILES, ...over });
const levels = (state, grants) => deferEligibility(state, CONFIG, FILES, { grants });

// ---- severity -------------------------------------------------------------------------------

test('severity: a non-BLOCKING item in an allowed category, in a plain changed file, is low', () => {
  for (const category of ['performance', 'maintainability', 'testing', 'design', 'docs', 'other']) {
    for (const bucket of ['SUGGESTION', 'WORTH_CONSIDERING']) assert.deepEqual(sev(item({ category, bucket })), { level: 'low', reasons: [] }, `${bucket} ${category}`);
  }
});

test('severity: BLOCKING, a bug, a security kind, an unknown bucket or category, or a missing one is high', () => {
  assert.equal(sev(item({ bucket: 'BLOCKING' })).level, 'high');
  for (const category of ['bug', 'broken-behaviour', 'security', 'auth', 'permissions', 'data-integrity', 'data-loss', 'novel', '', undefined, null, 7]) {
    assert.equal(sev(item({ category })).level, 'high', String(category));
  }
  for (const bucket of ['NITPICK', '', undefined, null]) assert.equal(sev(item({ bucket })).level, 'high', String(bucket));
  assert.equal(sev(null).level, 'high');
});

test('severity: a fix made in other files, or a file that also holds an accepted BLOCKING or security finding, is high', () => {
  assert.equal(sev(item({ implementedVia: 'other-files' })).level, 'high');
  const low = item({ file: 'src/big.js' });
  const blocking = item({ bucket: 'BLOCKING', category: 'bug', file: 'src/big.js' });
  assert.equal(itemSeverity(low, { state: stateOf([low, blocking]), config: CONFIG, files: FILES }).level, 'high');
  const sec = item({ category: 'auth', file: 'src/big.js', bucket: 'SUGGESTION' });
  assert.equal(itemSeverity(low, { state: stateOf([low, sec]), config: CONFIG, files: FILES }).level, 'high');
  // a dismissed BLOCKING finding in the same file does not count: only an ACCEPT
  const rejected = item({ bucket: 'BLOCKING', category: 'bug', file: 'src/big.js', final: { decision: 'REJECT', by: 'judge', needsHuman: false, reason: 'no' }, implemented: false });
  assert.equal(itemSeverity(low, { state: stateOf([low, rejected]), config: CONFIG, files: FILES }).level, 'low');
});

test('severity: the location must resolve to exactly one file of the reviewed diff', () => {
  for (const file of ['', undefined, null, 42, '/etc/passwd', 'C:/x/y.js', 'C:\\x\\y.js', '../src/big.js', 'src/../src/big.js', './src/big.js', 'src//big.js', 'src\\big.js', 'src/unknown.js', 'src/']) {
    assert.equal(sev(item({ file })).level, 'high', JSON.stringify(file));
  }
  assert.equal(sev(item(), { files: null }).level, 'high', 'a diff that could not be read');
  assert.equal(sev(item(), { files: [] }).level, 'high');
  // a rename: the old and the new path both name the file
  assert.equal(sev(item({ file: 'src/old.js' })).level, 'low');
  assert.equal(sev(item({ file: 'src/new.js' })).level, 'low');
  // ambiguous: two entries claim the path
  assert.equal(sev(item(), { files: [...FILES, { oldPath: 'src/x.js', newPath: 'src/big.js', path: 'src/big.js' }] }).level, 'high');
});

test('severity: a sensitive path (high_risk_paths or arbiter_always_paths, old or new path of a rename) is high; hard_stops.paths is not consulted', () => {
  const files = [...FILES, { oldPath: 'src/payroll/calc.js', newPath: 'src/calc.js', path: 'src/calc.js' }, { oldPath: 'src/z.js', newPath: 'src/z.js', path: 'src/z.js' }];
  assert.equal(sev(item({ file: 'src/calc.js' }), { files }).level, 'high', 'renamed out of a high-risk directory');
  assert.equal(sev(item({ file: 'src/payroll/calc.js' }), { files }).level, 'high');
  const cfg = { ...CONFIG, review: { arbiter_always_paths: ['src/z.js'] } };
  assert.equal(sev(item({ file: 'src/z.js' }), { files, config: cfg }).level, 'high');
  assert.equal(sev(item({ file: 'src/z.js' }), { files, config: { ...CONFIG, hard_stops: { paths: ['**'] } } }).level, 'low', 'hard_stops.paths does not make an item high');
  assert.equal(sev(item({ file: 'SRC/BIG.JS' }), { files: [{ oldPath: 'SRC/BIG.JS', newPath: 'SRC/BIG.JS', path: 'SRC/BIG.JS' }], config: { risk: { high_risk_paths: ['src/big.js'] } } }).level, 'high', 'matched without regard to case');
});

test('severity: a malformed config list throws, so the caller fails closed', () => {
  assert.throws(() => sev(item(), { config: { risk: { high_risk_paths: 'src/**' } } }), TypeError);
  assert.throws(() => sev(item(), { config: { review: { arbiter_always_paths: [1] } } }), TypeError);
});

// ---- deferEligibility -----------------------------------------------------------------------

test('deferEligibility: eligible when the limit is reached and every unreviewed accept is a low judge/arbiter fix', () => {
  const a = item({ id: 'R2-S1' });
  const b = item({ id: 'R2-S2', final: { decision: 'ACCEPT', by: 'arbiter', needsHuman: false, reason: 'r' }, category: 'docs', file: 'src/a.js' });
  const r = levels(stateOf([a, b]));
  assert.equal(r.eligible, true, r.refusals.join('; '));
  assert.deepEqual(r.ids, ['R2-S1', 'R2-S2']);
  assert.deepEqual(r.severities.map((s) => s.level), ['low', 'low']);
});

test('deferEligibility: not while the round limit is not reached or the automatic extra round is available', () => {
  const a = item({ id: 'R1-S1' });
  const one = { pr: 7, maxRounds: 1, currentContentHash: HASH, rounds: [round(1, [a])] };
  const r1 = levels(one);
  assert.equal(r1.eligible, false);
  assert.match(r1.refusals.join(';'), /automatic extra round is still available/);
  const two = { ...one, maxRounds: 3, rounds: [round(1, [a])] };
  assert.match(levels(two).refusals.join(';'), /round limit \(3\) is not reached/);
  assert.match(levels({ ...one, maxRounds: undefined }).refusals.join(';'), /max_rounds is not set/);
});

test('deferEligibility: anything else open refuses: pending, needs-human, an open BLOCKING, an unimplemented accept, a Fable pass owed', () => {
  const ok = item({ id: 'R2-S1' });
  const refuses = (other, re) => {
    const r = levels(stateOf([ok, other]));
    assert.equal(r.eligible, false);
    assert.match(r.refusals.join(';'), re);
  };
  refuses(item({ id: 'R2-S2', final: null, implemented: false }), /pending/);
  refuses(item({ id: 'R2-S3', final: { decision: 'REJECT', by: 'arbiter', needsHuman: true, reason: 'x', cause: 'low-confidence' }, implemented: false }), /wait for a human/);
  refuses(item({ id: 'R2-B1', bucket: 'BLOCKING', category: 'bug', final: null, implemented: false }), /BLOCKING/);
  refuses(item({ id: 'R2-S4', implemented: false }), /not implemented/);
  const fable = stateOf([ok]);
  fable.rounds[1].fableRequired = true;
  assert.match(levels(fable).refusals.join(';'), /Fable pass is owed/);
});

test('deferEligibility: an unspent owner grant for the next round (at any head) always wins; a throwing or malformed lookup is no grant', () => {
  const state = stateOf([item({ id: 'R2-S1' })]);
  const seen = [];
  const r = levels(state, (k) => { seen.push(k); return [{ grantId: 'g', head: 'c'.repeat(12), quote: 'extra round' }]; });
  assert.deepEqual(seen, [3], 'asked for counted round reviewed + 1');
  assert.equal(r.eligible, false);
  assert.match(r.refusals.join(';'), /granted extra round 3/);
  assert.equal(levels(state, () => { throw new Error('boom'); }).eligible, true);
  assert.equal(levels(state, () => 'nope').eligible, true);
  assert.equal(levels(state, () => []).eligible, true);
});

test('deferEligibility: each accept must be low, implemented, and the judge\'s or arbiter\'s (never a test, Claude, a second review, the owner or a cache copy)', () => {
  const refuses = (over, re) => {
    const r = levels(stateOf([item({ id: 'R2-S1', ...over })]));
    assert.equal(r.eligible, false, JSON.stringify(over));
    assert.match(r.refusals.join(';'), re);
  };
  refuses({ bucket: 'BLOCKING', category: 'bug' }, /not low severity/);
  refuses({ category: 'bug' }, /not low severity/);
  refuses({ file: 'src/payroll/x.js' }, /not low severity/);
  refuses({ final: { decision: 'ACCEPT', by: 'test', needsHuman: false, reason: 'test confirmed' } }, /accepted by test/);
  refuses({ final: { decision: 'ACCEPT', by: 'claude', needsHuman: false, reason: 'r', claude: { ruledAt: 'x', cause: 'low-confidence', critical: false, overruled: {} } } }, /ruled by Claude/);
  refuses({ final: { decision: 'ACCEPT', by: 'claude', forcedBy: 'second-review', needsHuman: false, reason: 'r', claude: { ruledAt: 'x', cause: 'low-confidence', critical: false, overruled: {} } } }, /ruled by Claude or forced/);
  refuses({ final: { decision: 'ACCEPT', by: 'owner', needsHuman: false, reason: 'r', ownerQuote: 'accept', ruledAt: 'x', overruled: {} } }, /ruled by the owner/);
  refuses({ final: { decision: 'ACCEPT', by: 'cache', needsHuman: false, reason: 'r', ownerQuote: 'accept' } }, /./);
});

test('deferEligibility: nothing to defer when no accept waits for a review round; a missing or malformed hash refuses', () => {
  const state = stateOf([]);
  state.rounds[1].items = [item({ id: 'R2-S1', final: { decision: 'FOLLOW-UP', by: 'judge', needsHuman: false, reason: 'later' }, implemented: false, followupIssue: 'https://github.com/a/b/issues/1' })];
  const r = levels(state);
  assert.equal(r.eligible, false);
  assert.match(r.refusals.join(';'), /nothing to defer/);
  const bad = stateOf([item({ id: 'R2-S1' })]);
  bad.rounds[1].contentHashAtToHead = '';
  assert.match(levels(bad).refusals.join(';'), /no content hash/);
  assert.equal(deferEligibility({ rounds: [] }, CONFIG, FILES).eligible, false);
});

test('deferEligibility: the ids span the rounds a resolution-only or base-only round sits between (the same obligation roundOutcome has)', () => {
  const a = item({ id: 'R2-S1' });
  const c = item({ id: 'R3-S1', round: 3 });
  const state = stateOf([a], { extra: [round(3, [c], { resolutionOnly: true }), round(4, [], { baseOnly: true })] });
  const o = roundOutcome(state);
  assert.deepEqual([...o.newAccepted].sort(), ['R2-S1', 'R3-S1']);
  const r = levels(state);
  assert.equal(r.eligible, true, r.refusals.join('; '));
  assert.deepEqual([...r.ids].sort(), ['R2-S1', 'R3-S1']);
});

test('deferEligibility: a config error throws instead of guessing', () => {
  assert.throws(() => deferEligibility(stateOf([item({ id: 'R2-S1' })]), { risk: { high_risk_paths: 5 } }, FILES), TypeError);
});

test('deferEligibility: a pre-existing Claude follow-up with no filed issue blocks (the deferral would not read as a clean review)', () => {
  const stuck = item({ id: 'R2-S2', implemented: false, final: { decision: 'FOLLOW-UP', by: 'claude', needsHuman: false, reason: 'later', claude: { ruledAt: 'x', cause: 'low-confidence', critical: false, overruled: {} } } });
  const r = levels(stateOf([item({ id: 'R2-S1' }), stuck]));
  assert.equal(r.eligible, false);
  assert.match(r.refusals.join(';'), /without a filed issue: R2-S2/);
});

// ---- the deferral ---------------------------------------------------------------------------

const PARAMS = { reason: 'minor, file it', ruledAt: '2026-11-11T10:00:00.000Z', fixHead: 'f'.repeat(40), reviewedHead: 'e'.repeat(40) };

test('applyRoundCapDefer: a FOLLOW-UP by claude with cause round-cap, the overruled ACCEPT kept, implemented and implementedVia gone, the item-level mark set', () => {
  const accepted = item({ id: 'R2-S1', implementedVia: 'other-files' });
  const d = applyRoundCapDefer(accepted, PARAMS);
  assert.deepEqual(d.final, {
    decision: 'FOLLOW-UP', by: 'claude', needsHuman: false, reason: 'minor, file it',
    claude: { ruledAt: PARAMS.ruledAt, cause: 'round-cap', critical: false, overruled: accepted.final, fixHead: PARAMS.fixHead, reviewedHead: PARAMS.reviewedHead },
  });
  assert.equal(d.implemented, false);
  assert.equal('implementedVia' in d, false);
  assert.deepEqual(d.roundCapDeferral, { fixHead: PARAMS.fixHead, reviewedHead: PARAMS.reviewedHead, at: PARAMS.ruledAt });
  assert.equal(isRoundCapDeferral(d), true);
  assert.equal(accepted.final.decision, 'ACCEPT', 'the input is not mutated');
  assert.equal(needsHumanCause(d), 'round-cap', 'the cause list knows round-cap');
});

test('applyRoundCapDefer: throws for what roundCapDeferRefusal refuses', () => {
  assert.throws(() => applyRoundCapDefer(item({ implemented: false }), PARAMS), /not implemented/);
  assert.throws(() => applyRoundCapDefer(item({ final: { decision: 'REJECT', by: 'judge', needsHuman: false, reason: 'x' } }), PARAMS), /not an accepted fix/);
  assert.throws(() => applyRoundCapDefer(applyRoundCapDefer(item(), PARAMS), PARAMS), /not an accepted fix/);
  assert.equal(roundCapDeferRefusal(item()), null);
});

test('after a deferral: the state reads clean once the issue is filed, and not before', () => {
  const state = stateOf([item({ id: 'R2-S1' })]);
  const proposed = deferItemsInState(state, ['R2-S1'], PARAMS);
  assert.equal(roundOutcome(proposed).clean, true);
  assert.match(reviewEligibilityProblems(proposed).join(';'), /without a filed issue: R2-S1/);
  const filed = deferItemsInState({ ...state }, ['R2-S1'], PARAMS);
  filed.rounds[1].items[0].followupIssue = 'https://github.com/acme/widgets/issues/31';
  assert.deepEqual(reviewEligibilityProblems(filed), []);
});

// ---- the Rulings inventory -------------------------------------------------------------------

const critical = (over = {}) => item({
  id: 'R1-B1', bucket: 'BLOCKING', category: 'bug', fingerprint: 'fp-b1', implemented: false,
  final: { decision: 'FOLLOW-UP', by: 'claude', needsHuman: false, reason: 'second review agrees', claude: { ruledAt: 'x', cause: 'low-confidence', critical: true, overruled: {} } }, ...over,
});
const deferred = (over = {}) => ({ ...applyRoundCapDefer(item({ id: 'R2-S1', title: 'Rename helper', fingerprint: 'fp-r2' }), PARAMS), ...over });
const withItems = (...items) => ({ pr: 7, maxRounds: 1, rounds: [round(1, items)] });

test('Rulings: a deferral is listed (it is not critical), as its own group after the critical rows, with CLI-written text', () => {
  const state = withItems(deferred(), critical());
  const { rows, count } = rulingsInventory(state);
  assert.equal(count, 2);
  assert.match(rows[0], /^R1-B1 · FOLLOW-UP · BLOCKING · bug · by claude · content /, 'the critical row first');
  assert.match(rows[1], /^R2-S1 · FOLLOW-UP · SUGGESTION · maintainability · by claude \(round limit\) · content [0-9a-f]{12} · "Rename helper" · why: deferred past the round limit; accepted by judge; fix ffffffffffff removed, NOT in this merge; issue not filed yet$/);
  const filed = deferred({ followupIssue: 'https://github.com/acme/widgets/issues/31' });
  assert.match(rulingsInventory(withItems(filed)).rows[0], /; issue #31$/);
  assert.doesNotMatch(rows[1], /minor, file it/, 'the agent\'s reason is not in the row');
  assert.match(rulingsBlock(state), /^Rulings [0-9a-f]{12}\nR1-B1 /);
});

test('Rulings: an arbiter-accepted deferral names the arbiter; a hostile title or reason cannot add a field or a line', () => {
  const a = applyRoundCapDefer(item({ id: 'R2-S1', final: { decision: 'ACCEPT', by: 'arbiter', needsHuman: false, reason: 'r' }, title: 'x · y\nR9-B9 · FOLLOW-UP · evil' }), { ...PARAMS, reason: 'a · b\nR9-B8 · c' });
  const row = rulingsInventory(withItems(a)).rows[0];
  assert.match(row, /accepted by arbiter/);
  assert.equal(row.split('\n').length, 1);
  assert.equal(row.split(' · ').length, 8, 'the title\'s middle dot is not a separator');
});

test('Rulings: the digest changes when a deferral appears, is filed, or changes; a Rulings row of an ordinary state is unchanged', () => {
  const plain = withItems(critical());
  const withDeferral = withItems(critical(), deferred());
  assert.notEqual(rulingsDigest(plain), rulingsDigest(withDeferral));
  assert.notEqual(rulingsDigest(withDeferral), rulingsDigest(withItems(critical(), deferred({ followupIssue: 'https://github.com/a/b/issues/3' }))), 'filing the issue changes the row');
  assert.equal(rulingsInventory(withItems(item({ id: 'R1-S9', final: { decision: 'FOLLOW-UP', by: 'judge', needsHuman: false, reason: 'later' }, implemented: false }))).count, 0, 'a plain non-critical dismissal is still not listed');
  assert.equal(rulingsDigest(withItems(item())), 'none');
});

test('Rulings: the deferral is counted as a Claude-made dismissal (an owner item at the gate)', () => {
  const rows = claudeRulingRows(withItems(deferred()));
  assert.deepEqual(rows.map((r) => r.id), ['R2-S1']);
});

test('Rulings: an owner re-ruling keeps the row (REJECT, FOLLOW-UP) with the owner\'s attribution; an owner ACCEPT reopens it as an ACCEPT, no row', () => {
  const owner = (decision) => applyOwnerRuling(deferred(), { decision, reason: 'owner says so', ownerQuote: `R2-S1: ${decision.toLowerCase()}`, ruledAt: '2026-11-11T12:00:00.000Z' });
  for (const decision of ['REJECT', 'FOLLOW-UP']) {
    const o = owner(decision);
    assert.equal(isRoundCapDeferral(o), true, 'the item-level mark survives');
    const { rows } = rulingsInventory(withItems(o));
    assert.equal(rows.length, 1, decision);
    assert.match(rows[0], new RegExp(`^R2-S1 · ${decision} · SUGGESTION · maintainability · by owner · content `));
    assert.match(rows[0], /why: owner says so$/);
    assert.deepEqual(claudeRulingRows(withItems(o)), [], 'no longer a Claude dismissal');
  }
  const accept = owner('ACCEPT');
  assert.equal(rulingsInventory(withItems(accept)).count, 0);
  assert.equal(accept.implemented, false, 'the fix and a review round are owed again');
});

// ---- Claude's rulings and the cache ----------------------------------------------------------

test('claudeRulingRefusal: a deferral cannot be touched by Claude (ACCEPT, FOLLOW-UP or REJECT); the owner\'s typed ruling can', () => {
  for (const decision of ['ACCEPT', 'FOLLOW-UP', 'REJECT']) {
    assert.match(claudeRulingRefusal(deferred(), decision), /deferred past the round limit.*only the owner's typed ruling/);
  }
  assert.throws(() => applyClaudeRuling(deferred(), { decision: 'ACCEPT', reason: 'x', ruledAt: PARAMS.ruledAt }), /deferred past the round limit/);
  assert.doesNotThrow(() => applyOwnerRuling(deferred(), { decision: 'ACCEPT', reason: 'r', ownerQuote: 'R2-S1: accept', ruledAt: PARAMS.ruledAt }));
  // an owner re-ruled deferral is still refused for Claude (the mark outlives the ruling)
  const o = applyOwnerRuling(deferred(), { decision: 'REJECT', reason: 'r', ownerQuote: 'R2-S1: reject', ruledAt: PARAMS.ruledAt });
  assert.match(claudeRulingRefusal(o, 'ACCEPT'), /deferred past the round limit/);
});

test('result cache: a round-cap deferral is never reused as a settled dismissal; an ordinary non-critical Claude dismissal still is', () => {
  const d = deferred();
  assert.deepEqual(ruledCacheFrom([d]), {}, 'not stored');
  const ordinary = item({ id: 'R1-S5', fingerprint: 'fp-ord', implemented: false, final: { decision: 'FOLLOW-UP', by: 'claude', needsHuman: false, reason: 'later', claude: { ruledAt: 'x', cause: 'low-confidence', critical: false, overruled: {} } } });
  assert.ok(ruledCacheFrom([ordinary])['fp-ord'], 'existing behaviour kept');
  // a hand-built cache entry carrying the cause is not reused either
  const cache = { 'fp-r2': { ...d.final, bucket: d.bucket, category: d.category } };
  const [again] = reuseRuled([{ ...item({ id: 'R3-S1', fingerprint: 'fp-r2', final: null, implemented: false }) }], cache);
  assert.equal(again.final, null);
  const [reused] = reuseRuled([{ ...item({ id: 'R3-S2', fingerprint: 'fp-ord', final: null, implemented: false }) }], ruledCacheFrom([ordinary]));
  assert.equal(reused.final.by, 'cache');
});
