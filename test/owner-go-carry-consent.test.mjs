// Merge-carry consent (plan 2026-11-05-merge-survives-main-reviewed R9/R13, F7/F10, C4/C5/C12): the `Carry: …` line in the owner's merge request, the per-request `carry: true` the hook records for it,
// and the optional carry callback that approvalVerdict / approvalGap consult once the exact head matched nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CARRY_LINE, approvalConfigDirHint, approvalGap, approvalVerdict, approvedPr, areasBlock, holdBlock, presentedRequests, rulingsBlockDigest } from '../pipeline/hooks/lib/owner-go.mjs';
import { OWNER_ENTRY, ownerSays, runHook } from './helpers/owner-go.mjs';

const HEAD = '7c3a91e05b2d48f6a1c0d9e8b7f6a5c4d3e2f1a0'; // the head the owner was shown
const NEW_HEAD = 'e1d2c3b4a5968778695a4b3c2d1e0f9a8b7c6d5e'; // a later head (main merged in)
const ITEMS = '5c0a7e1d9b34';
const REPO = 'acme/carry-consent-test';
const H16 = HEAD.slice(0, 16);
const HEADLINE = `Head ${H16} · items ${ITEMS} · repo ${REPO}`;
const READY = '🔀 Ready to merge #58 — say "merge"';
const RH = 'Rulings 0123456789ab';
const ROW = 'R1-B1 · REJECT · BLOCKING · security · by claude+codex · content 0123456789ab · "Missing check" · why: a false positive';
const AREAS = areasBlock(['hard-stop']);
const reply = (...lines) => `Here is the request.\n${[...lines, READY].join('\n')}`;
const only = (text) => {
  const r = presentedRequests(text);
  assert.equal(r.requests.length, 1, JSON.stringify(r));
  return r.requests[0];
};
const base = { pr: 58, head: H16, items: ITEMS, repo: REPO };

// ---- the parser -------------------------------------------------------------------------------------------------------------------------

test('carry: the constant is the exact line the plan names', () => {
  assert.equal(CARRY_LINE, 'Carry: also covers main-only updates (clean merges of main, no other change)');
});

test('carry: the line above Head / Areas / Rulings (each optional block) sets carry: true and nothing else changes', () => {
  assert.deepEqual(only(reply(CARRY_LINE, HEADLINE)), { ...base, carry: true });
  assert.deepEqual(only(reply(`  ${CARRY_LINE}  `, '', HEADLINE)), { ...base, carry: true }, 'spaces and blank lines are tolerated');
  const withAreas = only(reply(CARRY_LINE, AREAS, HEADLINE));
  assert.equal(withAreas.carry, true);
  assert.equal(typeof withAreas.areas, 'string');
  const withRulings = only(reply(CARRY_LINE, RH, ROW, HEADLINE));
  assert.equal(withRulings.carry, true);
  assert.equal(withRulings.rulings, rulingsBlockDigest([RH, ROW].join('\n')));
  const all = only(reply(CARRY_LINE, RH, ROW, AREAS, HEADLINE));
  assert.deepEqual([all.carry, typeof all.areas, typeof all.rulings], [true, 'string', 'string']);
  // 'none' items and a 40-hex head are fine too
  assert.equal(only(reply(CARRY_LINE, `Head ${HEAD} · items none · repo ${REPO}`)).carry, true);
});

test('carry: a request without the line has no carry field', () => {
  assert.deepEqual(only(reply(HEADLINE)), base);
  assert.equal('carry' in only(reply(RH, ROW, AREAS, HEADLINE)), false);
});

test('carry: a Hold line (C12) records the request without carry, and the exact head still binds', () => {
  const hold = { id: 'LE_x1', login: 'jamila', at: '2026-11-05T09:00:00Z' };
  const q = only(['x', CARRY_LINE, holdBlock(hold), `Head ${H16} · items ${ITEMS} · hold ${hold.id} · repo ${REPO}`, '🔀 Ready to merge #58 and lift its needs-human hold — say "merge"'].join('\n'));
  assert.equal(q.carry, undefined);
  assert.equal(q.head, H16);
  assert.equal(q.hold, hold.id);
});

test('carry: a Carry line between the rulings rows and Areas / Head binds no carry and no rulings (a PR with live rulings is refused)', (t) => {
  for (const below of [[HEADLINE], [AREAS, HEADLINE]]) {
    const q = only(reply(RH, ROW, CARRY_LINE, ...below));
    assert.equal(q.carry, undefined);
    assert.equal(q.rulings, undefined, 'the rulings block does not bind either');
  }
  // what that request is worth: exact-head approval of a PR WITHOUT rulings, and no approval at all for a PR that has them
  ownerSays(t, 'merge', reply(RH, ROW, CARRY_LINE, HEADLINE));
  const live = { repo: REPO, pr: 58, head: HEAD, items: ITEMS, areas: [], hold: undefined };
  assert.equal(approvalGap({ ...live, rulings: 'none' }), 'ok');
  assert.equal(approvalGap({ ...live, rulings: rulingsBlockDigest([RH, ROW].join('\n')) }), 'none');
});

test('carry: a duplicate Carry line, or a Carry line anywhere else, gives no carry and never voids the request', () => {
  assert.deepEqual(only(reply(CARRY_LINE, CARRY_LINE, HEADLINE)), base, 'duplicate');
  assert.deepEqual(only(reply(CARRY_LINE, '', `  ${CARRY_LINE}`, HEADLINE)), base, 'duplicate across a blank line');
  assert.deepEqual(only(reply(CARRY_LINE, 'Some prose.', HEADLINE)), base, 'prose between the line and the block');
  assert.equal(only(reply(AREAS, CARRY_LINE, HEADLINE)).carry, undefined, 'between Areas and Head');
  assert.equal(only(reply(`Head ${'c'.repeat(16)} · items none · repo ${REPO}`, CARRY_LINE, HEADLINE)).carry, undefined, 'below an earlier Head line');
  assert.deepEqual(only(`${CARRY_LINE}\nSome prose.\n${HEADLINE}\n${READY}`), base);
  assert.deepEqual(only(`${HEADLINE}\n${READY}\n`), base);
  assert.equal(only(reply(`${CARRY_LINE} (and more)`, HEADLINE)).carry, undefined, 'not the exact line');
  assert.equal(only(reply(CARRY_LINE.toLowerCase(), HEADLINE)).carry, undefined, 'not the exact line (case)');
  assert.equal(only(reply(CARRY_LINE.replace('also ', ''), HEADLINE)).carry, undefined, 'not the exact line (words)');
});

test('carry: several PRs on the 🔀 line never carry (F7)', () => {
  const r = presentedRequests([CARRY_LINE, `#58 head ${H16} · items ${ITEMS} · repo ${REPO}`, `#59 head ${'1'.repeat(16)} · items none · repo ${REPO}`, '🔀 Ready to merge #58, #59 — say "merge"'].join('\n'));
  assert.equal(r.requests.length, 2);
  assert.ok(r.requests.every((q) => q.carry === undefined));
  // a single Head line against a two-PR 🔀 line binds one request, still no carry
  const one = presentedRequests([CARRY_LINE, `#58 head ${H16} · items ${ITEMS} · repo ${REPO}`, '🔀 Ready to merge #58, #59 — say "merge"'].join('\n'));
  assert.ok(one.requests.every((q) => q.carry === undefined));
});

test('carry: a head of 12 hex records without carry (C4); 16 is enough', () => {
  const short = only(reply(CARRY_LINE, `Head ${HEAD.slice(0, 12)} · items ${ITEMS} · repo ${REPO}`));
  assert.deepEqual(short, { ...base, head: HEAD.slice(0, 12) });
  assert.equal(only(reply(CARRY_LINE, `Head ${HEAD.slice(0, 15)} · items ${ITEMS} · repo ${REPO}`)).carry, undefined);
  assert.equal(only(reply(CARRY_LINE, `Head ${H16} · items ${ITEMS} · repo ${REPO}`)).carry, true);
});

test('rollback (C4): non-empty items and a 16-hex head — the request minus `carry` equals the one parsed without the line, and the carry record approves its exact head', (t) => {
  for (const blocks of [[], [AREAS], [RH, ROW], [RH, ROW, AREAS]]) {
    const withLine = only(reply(CARRY_LINE, ...blocks, HEADLINE));
    const withoutLine = only(reply(...blocks, HEADLINE));
    const { carry, ...rest } = withLine;
    assert.equal(carry, true);
    assert.notEqual(rest.items, 'none');
    assert.deepEqual(rest, withoutLine);
  }
  const record = ownerSays(t, 'merge', reply(CARRY_LINE, HEADLINE));
  assert.equal(record.requests[0].carry, true);
  assert.equal(record.v, 1);
  assert.equal(approvalGap({ repo: REPO, pr: 58, head: HEAD, items: ITEMS, areas: [], hold: undefined, rulings: 'none' }), 'ok');
  assert.equal(approvedPr({ repo: REPO, pr: 58, head: HEAD, session: record.session }), true);
});

test('the hook prints "(carries over main-only updates)" for a carry request only', (t) => {
  const entries = (text) => [{ type: 'user', message: { content: 'ship it' }, ...OWNER_ENTRY }, { type: 'assistant', message: { content: [{ type: 'text', text }] } }];
  const carried = runHook(t, { entries: entries(reply(CARRY_LINE, HEADLINE)), prompt: 'merge' });
  assert.match(carried.stdout, new RegExp(`head ${H16} items ${ITEMS} \\(carries over main-only updates\\)`));
  assert.equal(carried.record.requests[0].carry, true);
  const plain = runHook(t, { entries: entries(reply(HEADLINE)), prompt: 'merge' });
  assert.doesNotMatch(plain.stdout, /carries over/);
});

// ---- the callback seam ------------------------------------------------------------------------------------------------------------------

const live = (over = {}) => ({ repo: REPO, pr: 58, head: NEW_HEAD, items: ITEMS, areas: [], hold: undefined, rulings: 'none', ...over });
const spy = (answer = { ok: true, from: 'abc' }) => {
  const calls = [];
  const carry = (arg) => { calls.push(arg); return typeof answer === 'function' ? answer(arg) : answer; };
  return { carry, calls };
};

test('callback: the exact head wins without calling it, and a non-carry record never calls it', (t) => {
  ownerSays(t, 'merge', reply(CARRY_LINE, HEADLINE));
  const a = spy();
  assert.deepEqual(approvalVerdict(live({ head: HEAD, carry: a.carry })), { gap: 'ok' });
  assert.equal(a.calls.length, 0);

  const other = { ...live({ pr: 70, items: 'none' }) };
  ownerSays(t, 'merge', `x\nHead ${H16} · items none · repo ${REPO}\n🔀 Ready to merge #70 — say "merge"`);
  const b = spy();
  assert.equal(approvalVerdict({ ...other, carry: b.carry }).gap, 'none');
  assert.equal(b.calls.length, 0, 'no carry field on the record');
});

test('callback: an accepted carry is gap ok with carriedFrom / carriedPrefix; a refusal is gap carry with the reason; a throw refuses', (t) => {
  ownerSays(t, 'merge', reply(CARRY_LINE, HEADLINE));
  const ok = spy((arg) => ({ ok: true, from: arg.prefix }));
  const v = approvalVerdict(live({ carry: ok.carry }));
  assert.deepEqual(v, { gap: 'ok', carriedFrom: H16, carriedPrefix: H16 });
  assert.equal(ok.calls.length, 1);
  assert.equal(ok.calls[0].prefix, H16);
  assert.equal(ok.calls[0].request.carry, true);
  assert.equal(typeof ok.calls[0].record.session, 'string');
  assert.equal(approvalGap(live({ carry: ok.carry })), 'ok');

  const no = spy({ ok: false, reason: 'a non-merge commit in the chain' });
  const r = approvalVerdict(live({ carry: no.carry }));
  assert.equal(r.gap, 'carry');
  assert.equal(r.reason, `the owner approved ${H16.slice(0, 12)}…; this head is not a main-only update of it: a non-merge commit in the chain`);
  assert.equal(approvalGap(live({ carry: no.carry })), 'carry');

  const boom = approvalVerdict(live({ carry: () => { throw new Error('git exploded'); } }));
  assert.equal(boom.gap, 'carry');
  assert.match(boom.reason, /git exploded/);
  assert.equal(approvalVerdict(live({ carry: () => ({ ok: 'yes' }) })).gap, 'carry', 'a malformed answer is a refusal');
  assert.equal(approvalVerdict(live({ carry: () => undefined })).gap, 'carry');
});

test('callback: no callback means gap none (existing callers), and a carry record does not cover another head through approvalGap / approvedPr', (t) => {
  const record = ownerSays(t, 'merge', reply(CARRY_LINE, HEADLINE));
  assert.equal(approvalGap(live()), 'none');
  assert.deepEqual(approvalVerdict(live()), { gap: 'none' });
  assert.equal(approvedPr({ repo: REPO, pr: 58, head: NEW_HEAD, session: record.session }), false, 'the direct-merge guard stays exact-head');
  assert.equal(approvedPr({ repo: REPO, pr: 58, head: HEAD, session: record.session }), true);
});

test('callback: called once per distinct prefix, not for a record whose other fields differ', (t) => {
  const H2 = '9a9a9a9a9a9a9a9a';
  ownerSays(t, 'merge', reply(CARRY_LINE, HEADLINE));
  ownerSays(t, 'merge', reply(CARRY_LINE, HEADLINE)); // the same prefix again
  ownerSays(t, 'merge', reply(CARRY_LINE, `Head ${H2} · items ${ITEMS} · repo ${REPO}`));
  const s = spy({ ok: false, reason: 'no' });
  const v = approvalVerdict(live({ carry: s.carry }));
  assert.deepEqual(s.calls.map((c) => c.prefix).sort(), [H2, H16].sort());
  assert.match(v.reason, new RegExp(`${H2.slice(0, 12)}….*no`));
  // the shared memo makes approvalConfigDirHint (and a second verdict) call nothing more
  const memo = new Map();
  const m = spy();
  approvalVerdict(live({ carry: m.carry, carryMemo: memo }));
  approvalConfigDirHint(live({ carry: m.carry, carryMemo: memo }));
  approvalVerdict(live({ carry: m.carry, carryMemo: memo }));
  assert.equal(m.calls.length, 2, 'once per prefix across all three calls');
  assert.equal(approvalConfigDirHint(live()), '');
});

test('callback: items, areas, rulings, pr and repo mismatches never reach it', (t) => {
  ownerSays(t, 'merge', reply(CARRY_LINE, AREAS, HEADLINE));
  const s = spy();
  const areasOk = live({ areas: ['hard-stop'] });
  assert.equal(approvalVerdict({ ...areasOk, carry: s.carry }).gap, 'ok');
  assert.equal(s.calls.length, 1);
  const before = s.calls.length;
  for (const over of [{ items: 'none' }, { items: '000000000000' }, { areas: [] }, { areas: ['other'] }, { rulings: rulingsBlockDigest([RH, ROW].join('\n')) }, { pr: 59 }, { repo: 'acme/other' }]) {
    assert.equal(approvalVerdict({ ...areasOk, ...over, carry: s.carry }).gap, 'none', JSON.stringify(over));
  }
  assert.equal(s.calls.length, before);
});

test('callback: a rulings request carries only against the same rulings digest; hold must be none on both sides', (t) => {
  ownerSays(t, 'merge', reply(CARRY_LINE, RH, ROW, HEADLINE));
  const digest = rulingsBlockDigest([RH, ROW].join('\n'));
  const s = spy();
  assert.equal(approvalVerdict(live({ rulings: digest, carry: s.carry })).gap, 'ok');
  assert.equal(approvalVerdict(live({ rulings: 'none', carry: s.carry })).gap, 'none');
  assert.equal(approvalVerdict(live({ rulings: digest, hold: { id: 'LE_x1', login: 'jamila', at: '2026-11-05T09:00:00Z' }, carry: s.carry })).gap, 'none', 'a live hold never carries');
  assert.equal(s.calls.length, 1);
});

test('callback: provenance still applies to a carried record, and a record older than 24 h never carries', (t) => {
  ownerSays(t, 'merge', reply(CARRY_LINE, HEADLINE), undefined, 'missing');
  const s = spy();
  assert.deepEqual(approvalVerdict(live({ carry: s.carry })), { gap: 'provenance' });
  assert.equal(s.calls.length, 1);

  ownerSays(t, 'merge', reply(CARRY_LINE, `Head ${'d'.repeat(16)} · items ${ITEMS} · repo ${REPO}`));
  const old = spy();
  const later = () => Date.now() + 25 * 3600 * 1000;
  assert.deepEqual(approvalVerdict(live({ items: ITEMS, carry: old.carry, now: later })), { gap: 'none' });
  assert.equal(old.calls.length, 0);
});

test('callback: a carry:true record whose stored head is shorter than 16 hex is never a candidate', (t) => {
  const record = ownerSays(t, 'merge', reply(HEADLINE.replace(H16, HEAD.slice(0, 12))));
  assert.equal(record.requests[0].carry, undefined);
  const s = spy();
  assert.equal(approvalVerdict(live({ carry: s.carry })).gap, 'none');
  assert.equal(s.calls.length, 0);
});
