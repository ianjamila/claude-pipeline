// #374 change 1, the pure side: `scope: "out-of-model"` on a ruling or a Fable finding, the marker `final.outOfModel`, the needsHuman waiver for a
// BLOCKING security FOLLOW-UP (only under rules (a)-(c)), the inventory label, and the filing gate in reviewEligibilityProblems.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyRulings, fableFindingItems, reviewEligibilityProblems, roundOutcome, rulingsBlock, rulingsDigest, rulingsInventory, validateRulings,
} from '../pipeline/lib/triage.mjs';
import { rulingsBlockDigest } from '../pipeline/hooks/lib/owner-go.mjs';

const MODELS = [{ name: 'guards', paths: ['pipeline/hooks/**'], text: 't' }, { name: 'docs', paths: ['docs/**'], text: 'd' }];
const entry = (path, over = {}) => ({ path, oldPath: path, newPath: path, status: 'M', binary: false, added: [], removed: [], ...over });
const FILES = [entry('pipeline/hooks/a.mjs'), entry('src/outside.mjs'), entry('docs/x.md'), entry('lib/auth.mjs')];

let seq = 0;
const item = (over = {}) => {
  seq += 1;
  return {
    id: `R1-B${seq}`, round: 1, bucket: 'BLOCKING', category: 'security', title: `finding ${seq}`, file: 'pipeline/hooks/a.mjs', line: 4,
    detail: 'd', codexReasoning: 'c', testable: false, fingerprint: `fp-${seq}`, judge: null, test: { status: 'none', evidence: '' },
    arbiter: null, final: null, implemented: false, followupIssue: null, ...over,
  };
};
const rule = (it, over = {}) => ({ id: it.id, ruling: 'FOLLOW-UP', confidence: 'high', reasoning: 'outside the model', scope: 'out-of-model', ...over });
const apply = (items, rulings, opts = {}) => applyRulings(items, { rulings }, { proofOk: true, transcript: 't', models: MODELS, diffFiles: FILES, ...opts });
const stateOf = (items, extra = {}) => ({ version: 1, repo: 'a/b', pr: 7, branch: 'x', risk: 'high', lightLane: false, maxRounds: 3, currentContentHash: 'h', rounds: [{ n: 1, toHead: 'h', contentHashAtToHead: 'h', items }], ...extra });

// ---- validation ------------------------------------------------------------------------------------------------------------------------------------

test('validateRulings: scope is optional and only "out-of-model" is accepted, on a ruling and on a finding', () => {
  const ok = { rulings: [{ id: 'R1-B1', ruling: 'FOLLOW-UP', confidence: 'high', reasoning: 'r', scope: 'out-of-model' }] };
  assert.equal(validateRulings(ok, ['R1-B1']).ok, true);
  for (const bad of ['in-model', '', 5, null, 'OUT-OF-MODEL']) {
    const r = validateRulings({ rulings: [{ ...ok.rulings[0], scope: bad }] }, ['R1-B1']);
    assert.equal(r.ok, false, String(bad));
    assert.match(r.errors.join(';'), /R1-B1: scope must be "out-of-model"/);
  }
  const finding = { bucket: 'SUGGESTION', category: 'security', title: 't', file: 'a', line: 1, detail: 'd', ruling: 'FOLLOW-UP', confidence: 'high', reasoning: 'r' };
  assert.equal(validateRulings({ rulings: [], findings: [{ ...finding, scope: 'out-of-model' }] }, [], { review: true }).ok, true);
  assert.match(validateRulings({ rulings: [], findings: [{ ...finding, scope: 'in-model' }] }, [], { review: true }).errors.join(';'), /findings\[0\]\.scope must be "out-of-model"/);
  assert.match(validateRulings({ rulings: [], findings: [{ ...finding, nope: 1 }] }, [], { review: true }).errors.join(';'), /unexpected key "nope"/, 'an unknown key is still refused');
});

// ---- F3 (a)-(c): the waiver ------------------------------------------------------------------------------------------------------------------------

test('applyRulings: a BLOCKING security FOLLOW-UP with scope out-of-model on a modelled file is final, marked with the model, no human', () => {
  const it = item();
  const [out] = apply([it], [rule(it)]);
  assert.deepEqual(out.final, { decision: 'FOLLOW-UP', by: 'arbiter', needsHuman: false, reason: 'outside the model', outOfModel: 'guards' });
});

test('applyRulings: without models, or with a file outside the model paths, the same ruling still parks for a human as security-dismissal', () => {
  const it = item();
  for (const opts of [{ models: [] }, { models: undefined }, { models: null }]) {
    const [out] = apply([it], [rule(it)], opts);
    assert.equal(out.final.needsHuman, true, JSON.stringify(opts));
    assert.equal(out.final.cause, 'security-dismissal');
    assert.equal(out.final.outOfModel, undefined);
  }
  const elsewhere = item({ file: 'src/outside.mjs' });
  const [out] = apply([elsewhere], [rule(elsewhere)]);
  assert.deepEqual([out.final.needsHuman, out.final.cause, out.final.outOfModel], [true, 'security-dismissal', undefined]);
});

test('applyRulings: F3(c) only category security is waived; auth, permissions, data-integrity and data-loss keep security-dismissal', () => {
  for (const category of ['auth', 'permissions', 'data-integrity', 'data-loss']) {
    const it = item({ category });
    const [out] = apply([it], [rule(it)]);
    assert.deepEqual([out.final.needsHuman, out.final.cause], [true, 'security-dismissal'], category);
  }
});

test('applyRulings: F3(a) the file must resolve to exactly one entry of the reviewed diff, cleanly', () => {
  const cases = {
    'no diff given': [{ file: 'pipeline/hooks/a.mjs' }, { diffFiles: null }],
    'file not in the diff': [{ file: 'pipeline/hooks/ghost.mjs' }, {}],
    'empty file': [{ file: '' }, {}],
    'climbs out': [{ file: 'pipeline/hooks/../../etc/passwd' }, {}],
    'absolute': [{ file: '/pipeline/hooks/a.mjs' }, {}],
    'ambiguous entry': [{ file: 'pipeline/hooks/a.mjs' }, { diffFiles: [...FILES, entry('pipeline/hooks/b.mjs', { oldPath: 'pipeline/hooks/a.mjs' })] }],
  };
  for (const [name, [over, opts]] of Object.entries(cases)) {
    const it = item(over);
    const [out] = apply([it], [rule(it)], opts);
    assert.deepEqual([out.final.needsHuman, out.final.cause], [true, 'security-dismissal'], name);
  }
});

test('applyRulings: F3(b) every path of the entry, old and new, must match the model: a rename out of the model goes to a human', () => {
  const renamedOut = entry('src/moved.mjs', { oldPath: 'pipeline/hooks/a.mjs', newPath: 'src/moved.mjs', status: 'R' });
  const it = item({ file: 'src/moved.mjs' });
  const [out] = apply([it], [rule(it)], { diffFiles: [renamedOut] });
  assert.deepEqual([out.final.needsHuman, out.final.cause], [true, 'security-dismissal']);
  const renamedWithin = entry('pipeline/hooks/new.mjs', { oldPath: 'pipeline/hooks/old.mjs', newPath: 'pipeline/hooks/new.mjs', status: 'R' });
  const inside = item({ file: 'pipeline/hooks/old.mjs' });
  const [ok] = apply([inside], [rule(inside)], { diffFiles: [renamedWithin] });
  assert.deepEqual([ok.final.needsHuman, ok.final.outOfModel], [false, 'guards']);
});

test('R1-F2 validateRulings: scope out-of-model is an error on a REJECT or an ACCEPT, on a ruling and on a Fable finding (only FOLLOW-UP may carry it)', () => {
  for (const ruling of ['REJECT', 'ACCEPT']) {
    const r = validateRulings({ rulings: [{ id: 'R1-B1', ruling, confidence: 'high', reasoning: 'r', scope: 'out-of-model' }] }, ['R1-B1']);
    assert.equal(r.ok, false, ruling);
    assert.match(r.errors.join(';'), /R1-B1: scope is only allowed with ruling FOLLOW-UP/, ruling);
  }
  const finding = { bucket: 'SUGGESTION', category: 'security', title: 't', file: 'a', line: 1, detail: 'd', ruling: 'ACCEPT', confidence: 'high', reasoning: 'r', scope: 'out-of-model' };
  const f = validateRulings({ rulings: [], findings: [finding] }, [], { review: true });
  assert.equal(f.ok, false);
  assert.match(f.errors.join(';'), /findings\[0\]\.scope is only allowed with ruling FOLLOW-UP/);
  assert.equal(validateRulings({ rulings: [], findings: [{ ...finding, ruling: 'FOLLOW-UP' }] }, [], { review: true }).ok, true);
  assert.equal(validateRulings({ rulings: [{ id: 'R1-B1', ruling: 'REJECT', confidence: 'high', reasoning: 'r' }] }, ['R1-B1']).ok, true, 'no scope: unchanged');
});

test('applyRulings: low confidence and an unproven answer still park for a human', () => {
  const low = item();
  assert.equal(apply([low], [rule(low, { confidence: 'low' })])[0].final.needsHuman, true);
  const unproven = item();
  const [u] = apply([unproven], [rule(unproven)], { proofOk: false });
  assert.deepEqual([u.final.needsHuman, u.final.cause, u.final.outOfModel], [true, 'model-proof', undefined]);
});

// ---- R4: a bug on a modelled path ------------------------------------------------------------------------------------------------------------------

test('R4: a non-security BLOCKING bug on a modelled path: nothing new is waived (today\'s rule for a bug stands), the marker only forces its issue', () => {
  const bug = item({ category: 'logic' });
  const [out] = apply([bug], [rule(bug)]);
  // Today's rule for a non-security BLOCKING FOLLOW-UP is unchanged: settled by the arbiter, no human (the marker only forces the issue to be filed).
  assert.deepEqual([out.final.decision, out.final.needsHuman], ['FOLLOW-UP', false]);
  assert.equal(out.final.outOfModel, 'guards', 'marked, so it must be filed');
});

test('R4 mixed paths: a model governs only its own paths: the same ruling on another file carries no marker', () => {
  const inModel = item({ bucket: 'SUGGESTION', category: 'maintainability' });
  const other = item({ bucket: 'SUGGESTION', category: 'maintainability', file: 'src/outside.mjs' });
  const [a, b] = apply([inModel, other], [rule(inModel), rule(other)]);
  assert.equal(a.final.outOfModel, 'guards');
  assert.equal(b.final.outOfModel, undefined);
  assert.deepEqual([b.final.decision, b.final.needsHuman], ['FOLLOW-UP', false]);
});

test('R4 overlapping models: the first model (config order) that matches the entry names the marker', () => {
  const both = [{ name: 'wide', paths: ['pipeline/**'], text: 'w' }, ...MODELS];
  const it = item();
  const [out] = apply([it], [rule(it)], { models: both });
  assert.deepEqual([out.final.needsHuman, out.final.outOfModel], [false, 'wide']);
});

// ---- B1: every validated out-of-model FOLLOW-UP carries the marker --------------------------------------------------------------------------------

test('B1: the marker is set for a SUGGESTION and a WORTH_CONSIDERING FOLLOW-UP as well as a BLOCKING one', () => {
  const items = [item({ bucket: 'SUGGESTION' }), item({ bucket: 'WORTH_CONSIDERING', category: 'design' }), item({ bucket: 'BLOCKING' })];
  const out = apply(items, items.map((i) => rule(i)));
  assert.deepEqual(out.map((i) => i.final.outOfModel), ['guards', 'guards', 'guards']);
  assert.deepEqual(out.map((i) => i.final.needsHuman), [false, false, false]);
});

// ---- fableFindingItems ------------------------------------------------------------------------------------------------------------------------------

const finding = (over = {}) => ({
  bucket: 'BLOCKING', category: 'security', title: 'sandbox escape', file: 'pipeline/hooks/a.mjs', line: 3, detail: 'd', ruling: 'FOLLOW-UP', confidence: 'high', reasoning: 'outside the model', scope: 'out-of-model', ...over,
});
const findingItems = (list, opts = {}) => fableFindingItems(list, 1, { models: MODELS, diffFiles: FILES, ...opts });

test('fableFindingItems: an out-of-model BLOCKING security finding is final with the marker; the same finding without models is security-dismissal', () => {
  const [a] = findingItems([finding()]);
  assert.deepEqual(a.final, { decision: 'FOLLOW-UP', by: 'arbiter', needsHuman: false, reason: 'outside the model', outOfModel: 'guards' });
  const [b] = findingItems([finding()], { models: [] });
  assert.deepEqual([b.final.needsHuman, b.final.cause, b.final.outOfModel], [true, 'security-dismissal', undefined]);
  const [c] = findingItems([finding({ file: 'src/outside.mjs' })]);
  assert.deepEqual([c.final.needsHuman, c.final.cause], [true, 'security-dismissal']);
  const [d] = findingItems([finding({ category: 'auth' })]);
  assert.deepEqual([d.final.needsHuman, d.final.cause], [true, 'security-dismissal']);
  const [e] = findingItems([finding({ file: 'pipeline/hooks/ghost.mjs' })]);
  assert.equal(e.final.needsHuman, true, 'a file outside the reviewed diff is not waived');
});

test('fableFindingItems B1: SUGGESTION and BLOCKING findings both carry the marker; low confidence does not', () => {
  const items = findingItems([finding({ bucket: 'SUGGESTION', category: 'design' }), finding({ bucket: 'BLOCKING' }), finding({ confidence: 'low' })]);
  assert.deepEqual(items.map((i) => i.final.outOfModel), ['guards', 'guards', undefined]);
  assert.equal(items[2].final.cause, 'low-confidence');
});

// ---- inventory, filing gate, round outcome ---------------------------------------------------------------------------------------------------------

const marked = (over = {}) => item({ id: 'R1-B1', final: { decision: 'FOLLOW-UP', by: 'arbiter', needsHuman: false, reason: 'outside', outOfModel: 'guards' }, ...over });

test('the inventory row names the model: "arbiter (outside threat model guards)"; a legacy row is byte-identical and the digest follows the label', () => {
  const [row] = rulingsInventory(stateOf([marked()])).rows;
  assert.equal(row.split(' · ')[4], 'by arbiter (outside threat model guards)');
  const legacy = marked({ final: { decision: 'FOLLOW-UP', by: 'arbiter', needsHuman: false, reason: 'outside' } });
  assert.equal(rulingsInventory(stateOf([legacy])).rows[0].split(' · ')[4], 'by arbiter');
  assert.notEqual(rulingsDigest(stateOf([marked()])), rulingsDigest(stateOf([legacy])));
  assert.notEqual(rulingsDigest(stateOf([marked()])), rulingsDigest(stateOf([marked({ final: { ...marked().final, outOfModel: 'docs' } })])), 'a changed attribution changes the digest');
  assert.equal(rulingsInventory(stateOf([marked({ final: { ...marked().final, outOfModel: 'a · b\n"x"' } })])).rows[0].split(' · ').length, 8, 'free text cannot add a column');
});

test('F5: an unfiled marked FOLLOW-UP blocks review-complete; filing it clears; roundOutcome is untouched', () => {
  for (const bucket of ['BLOCKING', 'SUGGESTION', 'WORTH_CONSIDERING']) {
    const s = stateOf([marked({ bucket })]);
    assert.match(reviewEligibilityProblems(s).join(';'), /out-of-model follow-up\(s\) without a filed issue: R1-B1/, bucket);
    assert.deepEqual(reviewEligibilityProblems(stateOf([marked({ bucket, followupIssue: 'https://github.com/a/b/issues/9' })])), [], bucket);
  }
  const unfiled = stateOf([marked()]);
  const filed = stateOf([marked({ followupIssue: 'https://github.com/a/b/issues/9' })]);
  assert.deepEqual(roundOutcome(unfiled), roundOutcome(filed), 'reachedMax / extraRound / newAccepted do not move with the filing');
  const plain = marked({ final: { decision: 'FOLLOW-UP', by: 'arbiter', needsHuman: false, reason: 'x' } });
  assert.deepEqual(reviewEligibilityProblems(stateOf([plain])), [], 'an ordinary arbiter follow-up is not this rule');
});

test('the merge gate sees it: the Rulings block (what the final gate binds the owner\'s "merge" to) lists "outside threat model guards" and its digest moves with the attribution; a legacy block is unchanged', () => {
  const legacy = marked({ final: { decision: 'FOLLOW-UP', by: 'arbiter', needsHuman: false, reason: 'outside' } });
  const block = rulingsBlock(stateOf([marked()]));
  assert.match(block, /^Rulings [0-9a-f]{12}\n/);
  assert.match(block, /by arbiter \(outside threat model guards\)/);
  const other = rulingsBlock(stateOf([marked({ final: { ...marked().final, outOfModel: 'docs' } })]));
  assert.notEqual(rulingsBlockDigest(block), rulingsBlockDigest(other), 'a changed model name is a different block: a prior "merge" no longer binds');
  assert.notEqual(rulingsBlockDigest(block), rulingsBlockDigest(rulingsBlock(stateOf([legacy]))));
  assert.doesNotMatch(rulingsBlock(stateOf([legacy])), /threat model/, 'a ruling without the marker renders exactly as before');
  assert.equal(rulingsBlockDigest(rulingsBlock(stateOf([]))), 'none');
});
