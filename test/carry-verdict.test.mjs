// carryVerdict (lib/carry-verdict.mjs): approvalVerdict's SYNC carry callback fed by an ASYNC proof, in two passes; and carryApprovalFor (the entry of the loop).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CARRY_LINE, carryApprovalFor, holdBlock } from '../pipeline/hooks/lib/owner-go.mjs';
import { carryVerdict } from '../pipeline/lib/carry-verdict.mjs';
import { ownerSays } from './helpers/owner-go.mjs';

const HEAD = '5d3a91e05b2d48f6a1c0d9e8b7f6a5c4d3e2f1a0';
const NEW_HEAD = 'f1d2c3b4a5968778695a4b3c2d1e0f9a8b7c6d5e';
const ITEMS = '5c0a7e1d9b34';
const REPO = 'acme/carry-verdict-test';
const H16 = HEAD.slice(0, 16);
const READY = '🔀 Ready to merge #61 — say "merge"';
const request = (...lines) => `Here is the request.\n${[...lines, READY].join('\n')}`;
const HEADLINE = `Head ${H16} · items ${ITEMS} · repo ${REPO}`;
const live = (over = {}) => ({ repo: REPO, pr: 61, head: NEW_HEAD, items: ITEMS, areas: [], hold: undefined, rulings: 'none', ...over });

test('carryVerdict: the async proof is asked once per prefix and its answer decides; the verdict carries the proofs', async (t) => {
  ownerSays(t, 'merge', request(CARRY_LINE, HEADLINE));
  const asked = [];
  const ok = await carryVerdict(live(), async ({ prefix, request: req }) => { asked.push([prefix, req.carry]); return { ok: true, from: HEAD }; });
  assert.deepEqual(asked, [[H16, true]]);
  assert.equal(ok.gap, 'ok');
  assert.equal(ok.carriedFrom, HEAD);
  assert.equal(ok.carriedPrefix, H16);
  assert.deepEqual(ok.proofs.get(H16), { ok: true, from: HEAD });

  const no = await carryVerdict(live(), async () => ({ ok: false, code: 'conflict', reason: 'someone resolved a conflict by hand' }));
  assert.equal(no.gap, 'carry');
  assert.match(no.reason, /this head is not a main-only update of it: someone resolved a conflict by hand/);
});

test('carryVerdict: a proof that throws is a refusal; the exact head and "no carry request" never run the proof', async (t) => {
  ownerSays(t, 'merge', request(CARRY_LINE, HEADLINE));
  const boom = await carryVerdict(live(), async () => { throw new Error('git exploded'); });
  assert.equal(boom.gap, 'carry');
  assert.match(boom.reason, /git exploded/);

  let calls = 0;
  const prove = async () => { calls += 1; return { ok: true, from: HEAD }; };
  assert.equal((await carryVerdict(live({ head: HEAD }), prove)).gap, 'ok', 'exact head');
  assert.equal((await carryVerdict(live({ pr: 62 }), prove)).gap, 'none', 'another PR');
  assert.equal((await carryVerdict(live({ items: '000000000000' }), prove)).gap, 'none', 'other items');
  assert.equal(calls, 0);
});

test('carryVerdict: nothing is remembered between calls (a later call proves again, against ITS head and base)', async (t) => {
  ownerSays(t, 'merge', request(CARRY_LINE, HEADLINE));
  let calls = 0;
  const prove = async () => { calls += 1; return { ok: calls > 1, from: HEAD, reason: 'first proof refused' }; };
  assert.equal((await carryVerdict(live(), prove)).gap, 'carry');
  assert.equal((await carryVerdict(live(), prove)).gap, 'ok');
  assert.equal(calls, 2);
});

test('carryApprovalFor: an owned carry record for EXACTLY this head gives its prefix; no Carry line, another head, another items or a hold gives null', (t) => {
  assert.equal(carryApprovalFor(live({ head: HEAD })), null, 'nothing recorded yet');
  ownerSays(t, 'merge', request(CARRY_LINE, HEADLINE));
  assert.deepEqual(carryApprovalFor(live({ head: HEAD })), { prefix: H16 });
  assert.equal(carryApprovalFor(live({ head: NEW_HEAD })), null, 'another head');
  assert.equal(carryApprovalFor(live({ head: HEAD, items: '000000000000' })), null);
  assert.equal(carryApprovalFor(live({ head: HEAD, pr: 62 })), null);
  assert.equal(carryApprovalFor(live({ head: HEAD, hold: { id: 'LE_x1', login: 'jamila', at: '2026-11-05T09:00:00Z' } })), null, 'a live hold never carries');
  assert.equal(carryApprovalFor(live({ head: HEAD, hold: null })), null, 'hold: null is the gated route, not this one');
});

test('carryApprovalFor: a plain record (no Carry line), a record without the owner behind it, and a request that named a hold are not carry approvals', (t) => {
  const OTHER = 'c3a91e05b2d48f6a1c0d9e8b7f6a5c4d3e2f1a07';
  ownerSays(t, 'merge', request(`Head ${OTHER.slice(0, 16)} · items ${ITEMS} · repo ${REPO}`));
  assert.equal(carryApprovalFor(live({ head: OTHER })), null, 'plain record');
  const NOBODY = 'a4a91e05b2d48f6a1c0d9e8b7f6a5c4d3e2f1a08';
  ownerSays(t, 'merge', request(CARRY_LINE, `Head ${NOBODY.slice(0, 16)} · items ${ITEMS} · repo ${REPO}`), undefined, 'missing');
  assert.equal(carryApprovalFor(live({ head: NOBODY })), null, 'provenance missing');
  const held = 'b7b91e05b2d48f6a1c0d9e8b7f6a5c4d3e2f1a09';
  const hold = { id: 'LE_x1', login: 'jamila', at: '2026-11-05T09:00:00Z' };
  ownerSays(t, 'merge', request(CARRY_LINE, holdBlock(hold), `Head ${held.slice(0, 16)} · items ${ITEMS} · hold ${hold.id} · repo ${REPO}`));
  assert.equal(carryApprovalFor(live({ head: held })), null);
  assert.equal(carryApprovalFor(live({ head: held, hold })), null);
});
