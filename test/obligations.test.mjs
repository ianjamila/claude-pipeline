// Derived reviewer obligations (ship redesign T7): which extra reviewers a round owes, and how an unmet one blocks "clean".
import test from 'node:test';
import assert from 'node:assert/strict';
import { requiredObligations, obligationDigest } from '../pipeline/lib/obligations.mjs';
import { roundOutcome, reviewValidFor } from '../pipeline/lib/triage.mjs';
import { addRound, emptyState } from '../pipeline/lib/state.mjs';

const base = { round: 1, security: true, securityInRange: false, level: 'high', finalPass: 'off', blockingCount: 0, priorRounds: [] };
test('security in round 1; later rounds only when trigger files changed; fable only with final_pass risky + high + no BLOCKING, once', () => {
  assert.deepEqual(requiredObligations(base), ['security']);
  assert.deepEqual(requiredObligations({ ...base, round: 2 }), []);
  assert.deepEqual(requiredObligations({ ...base, round: 2, securityInRange: true }), ['security']);
  assert.deepEqual(requiredObligations({ ...base, security: false, finalPass: 'risky' }), ['fable']);
  assert.deepEqual(requiredObligations({ ...base, security: false, finalPass: 'risky', blockingCount: 1 }), []);
  assert.deepEqual(requiredObligations({ ...base, security: false, finalPass: 'risky', priorRounds: [{ obligations: [{ source: 'fable', status: 'met' }] }] }), []);
  assert.deepEqual(requiredObligations({ ...base, security: false, finalPass: 'risky', level: 'medium' }), []);
  assert.deepEqual(requiredObligations({ ...base, finalPass: 'risky' }), ['security', 'fable']);
  assert.match(obligationDigest({ repo: 'a/b', pr: 1, source: 'security', base: 'x', head: 'y' }), /^[0-9a-f]{64}$/);
  assert.notEqual(
    obligationDigest({ repo: 'a/b', pr: 1, source: 'security', base: 'x', head: 'y' }),
    obligationDigest({ repo: 'a/b', pr: 1, source: 'security', base: 'x', head: 'z' }),
  );
});

const st = (obligations) => ({ maxRounds: 3, currentContentHash: 'h', rounds: [{ n: 1, contentHashAtToHead: 'h', items: [], obligations }] });
test('an unmet obligation keeps a round with zero items from being clean; failed → needsHuman; met → clean', () => {
  const pending = roundOutcome(st([{ source: 'security', status: 'pending', digest: 'd' }]));
  assert.equal(pending.clean, false);
  assert.deepEqual(pending.unmetObligations, ['R1:security']);
  assert.deepEqual(roundOutcome(st([{ source: 'fable', status: 'failed', digest: 'd' }])).needsHuman, ['R1:fable-proof']);
  assert.equal(roundOutcome(st([{ source: 'fable', status: 'failed', digest: 'd' }])).clean, false);
  assert.equal(roundOutcome(st([{ source: 'security', status: 'met', digest: 'd' }])).clean, true);
  assert.deepEqual(roundOutcome(st(undefined)).unmetObligations, []);
  assert.equal(reviewValidFor(st([{ source: 'security', status: 'pending', digest: 'd' }]), 'h'), false);
  assert.equal(reviewValidFor(st([{ source: 'security', status: 'failed', digest: 'd' }]), 'h'), false);
  assert.equal(reviewValidFor(st([{ source: 'security', status: 'met', digest: 'd' }]), 'h'), true);
});

test('addRound keeps obligations when given and refuses an unknown source', () => {
  const s0 = emptyState({ repo: 'a/b', pr: 1, branch: 'x', risk: 'high' });
  const r = { n: 1, fromHead: 'a', toHead: 'b', contentHashAtToHead: 'h', items: [] };
  const o = [{ source: 'security', status: 'pending', digest: 'd' }];
  assert.deepEqual(addRound(s0, { ...r, obligations: o }).rounds[0].obligations, o);
  assert.equal('obligations' in addRound(s0, r).rounds[0], false);
  assert.equal('obligations' in addRound(s0, { ...r, obligations: [] }).rounds[0], false, 'an empty list is not recorded');
  assert.throws(() => addRound(s0, { ...r, obligations: [{ source: 'gemini', status: 'pending', digest: 'd' }] }), /obligation/);
});
