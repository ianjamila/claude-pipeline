// The needs-human hold the owner's "merge" lifts (plan 2026-11-05-chat-merge-protected, rev 4 items 2a, 5; review note 6), recorder and parser side:
// a canonical `Hold <id> by <login> at <ISO>` line directly above a Head line that carries `· hold <id>`, the lift wording on the 🔀 line, and a record that
// approvalGap matches against the LIVE hold exactly. Any Hold-shaped line that is not consumed exactly so makes the whole reply bind nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ownerSays } from './helpers/owner-go.mjs';
import { approvalGap, areasBlock, areasDigest, holdBlock, holdDigest, LIFT_PHRASE, presentedRequests, readyLine } from '../pipeline/hooks/lib/owner-go.mjs';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const ITEMS = 'abcdefabcdef';
const HOLD = { id: 'LE_lADOabc123_xyz-9', login: 'jamila', at: '2026-11-05T08:30:00Z' };
const sha = (s) => createHash('sha256').update(s).digest('hex');
const head = (h, { pr, hold, items = ITEMS, repo = 'acme/widgets' } = {}) => `${pr ? `#${pr} ` : ''}head ${h.slice(0, 12)} · items ${items}${hold ? ` · hold ${hold}` : ''}${repo ? ` · repo ${repo}` : ''}`;
const holdLine = (h = HOLD, pr) => `${pr ? `#${pr} ` : ''}${holdBlock(h)}`;
const READY = readyLine([7], { lift: true });
const reply = (...lines) => lines.join('\n');
const one = reply(holdLine(), head(A, { hold: HOLD.id }), READY);
const nothing = (text, why) => assert.deepEqual(presentedRequests(text).requests, [], why ?? text);

test('holdBlock / holdDigest: the canonical block and its digest; invalid input is "no showable hold"', () => {
  assert.equal(holdBlock(HOLD), 'Hold LE_lADOabc123_xyz-9 by jamila at 2026-11-05T08:30:00Z');
  assert.equal(holdBlock({ ...HOLD, login: 'dependabot[bot]' }), 'Hold LE_lADOabc123_xyz-9 by dependabot[bot] at 2026-11-05T08:30:00Z');
  for (const bad of [null, undefined, {}, { ...HOLD, id: '' }, { ...HOLD, id: 'a b' }, { ...HOLD, id: 'x'.repeat(129) }, { ...HOLD, login: 'a b' }, { ...HOLD, login: 'x'.repeat(40) },
    { ...HOLD, at: '2026-11-05T08:30:00.000Z' }, { ...HOLD, at: '2026-11-05 08:30:00Z' }, { ...HOLD, at: '2026-11-05T08:30:00z' }, { ...HOLD, at: '2026-11-05T08:30:00+00:00' }, { ...HOLD, id: 7 }]) {
    assert.equal(holdBlock(bad), '', JSON.stringify(bad));
  }
  assert.equal(holdDigest(HOLD), sha(holdBlock(HOLD)));
  assert.equal(holdDigest(null), 'none');
  assert.equal(holdDigest(undefined), 'none');
  assert.equal(holdDigest({ ...HOLD, login: 'bad login' }), 'invalid', 'a hold with no showable block equals no record value');
});

test('readyLine renders the exact wording', () => {
  assert.equal(readyLine([7]), '🔀 Ready to merge #7 — say "merge"');
  assert.equal(readyLine([7], { lift: true }), '🔀 Ready to merge #7 and lift its needs-human hold — say "merge"');
  assert.equal(readyLine([1, 2], { lift: true }), '🔀 Ready to merge #1, #2 and lift their needs-human holds — say "merge"');
  assert.deepEqual(LIFT_PHRASE, { one: 'and lift its needs-human hold', many: 'and lift their needs-human holds' });
});

test('parser: Hold + Head + lift wording binds the hold id and the block digest', () => {
  const r = presentedRequests(one);
  assert.deepEqual(r.prs, [7]);
  assert.deepEqual(r.requests, [{ pr: 7, head: A.slice(0, 12), items: ITEMS, repo: 'acme/widgets', hold: HOLD.id, holdBlock: holdDigest(HOLD) }]);
});

test('parser: Areas + Hold + Head binds both digests', () => {
  const r = presentedRequests(reply('Protected.', areasBlock(['R1-a', 'R2-b']), holdLine(), head(A, { hold: HOLD.id }), READY));
  assert.equal(r.requests.length, 1);
  assert.equal(r.requests[0].areas, areasDigest(['R1-a', 'R2-b']));
  assert.equal(r.requests[0].hold, HOLD.id);
  assert.equal(r.requests[0].holdBlock, holdDigest(HOLD));
});

test('parser: a request with no hold is unchanged (no hold fields), with or without Areas', () => {
  const plain = presentedRequests(reply(head(A), readyLine([7])));
  assert.equal('hold' in plain.requests[0], false);
  assert.equal('holdBlock' in plain.requests[0], false);
  assert.equal(presentedRequests(reply('Areas R1-a', head(A), readyLine([7]))).requests[0].areas, areasDigest(['R1-a']));
});

test('parser: HEAD_LINE reads `|` separators, `items none · hold X`, and any case', () => {
  assert.equal(presentedRequests(reply(holdLine(), `HEAD ${A.slice(0, 12)} | ITEMS none | HOLD ${HOLD.id} | REPO Acme/Widgets`, READY)).requests[0].hold, HOLD.id);
  const none = presentedRequests(reply(holdLine(), `head ${A.slice(0, 12)} · items none · hold ${HOLD.id}`, READY)).requests[0];
  assert.equal(none.items, 'none');
  assert.equal(none.repo, null);
  assert.equal(none.hold, HOLD.id);
  const lower = presentedRequests(reply(holdLine().replace(/^Hold/, 'HOLD'), head(A, { hold: HOLD.id }), READY));
  assert.equal(lower.requests[0]?.holdBlock, holdDigest(HOLD), 'the keyword is read in any case; the digest is of the canonical block');
});

test('parser: the Hold id on the Head line is opaque and case-sensitive: another id binds nothing', () => {
  nothing(reply(holdLine(), head(A, { hold: HOLD.id.toLowerCase() }), READY));
  nothing(reply(holdLine(), head(A, { hold: 'LE_other' }), READY));
});

test('parser: a Hold line with a malformed shape (no author, bad time, bad login) binds nothing', () => {
  for (const bad of [`Hold ${HOLD.id}`, `Hold ${HOLD.id} by ${HOLD.login}`, `Hold ${HOLD.id} by ${HOLD.login} at yesterday`, `Hold ${HOLD.id} by ${HOLD.login} at 2026-11-05T08:30:00.000Z`,
    `Hold ${HOLD.id} by ${HOLD.login} at 2026-11-05T08:30:00z`, `Hold ${HOLD.id} by bad_login at ${HOLD.at}`, `Hold ${HOLD.id} by ${HOLD.login} at ${HOLD.at} extra`, `Hold ${HOLD.id} for ${HOLD.login} at ${HOLD.at}`]) {
    nothing(reply(bad, head(A, { hold: HOLD.id }), READY), bad);
  }
});

test('parser: a Hold line with prose between it and the Head line binds nothing (unlike Areas)', () => {
  nothing(reply(holdLine(), 'The hold is explained here.', head(A, { hold: HOLD.id }), READY));
  nothing(reply(holdLine(), '', head(A, { hold: HOLD.id }), READY));
  assert.equal(presentedRequests(reply('Areas R1-a', 'prose', head(A), readyLine([7]))).requests.length, 1, 'an Areas line with prose still binds without areas (PR 1)');
});

test('parser: a Hold line EARLIER in the reply (not in the terminal block) binds nothing', () => {
  nothing(reply(holdLine(), 'Some text.', head(A), readyLine([7])));
  nothing(reply(holdLine(), 'Some text.', holdLine(), head(A, { hold: HOLD.id }), READY));
});

test('parser: Hold above Areas (wrong order) binds nothing', () => {
  nothing(reply(holdLine(), 'Areas R1-a', head(A, { hold: HOLD.id }), READY));
  nothing(reply(holdLine(), 'Areas R1-a', head(A), readyLine([7])));
});

test('parser: two Hold lines in a row bind nothing', () => {
  nothing(reply(holdLine(), holdLine(), head(A, { hold: HOLD.id }), READY));
  nothing(reply(holdLine({ ...HOLD, id: 'LE_older' }), holdLine(), head(A, { hold: HOLD.id }), READY));
});

test('parser: a Hold line against the 🔀 line binds nothing', () => {
  nothing(reply(head(A), holdLine(), readyLine([7])));
  nothing(reply(head(A, { hold: HOLD.id }), holdLine(), READY));
});

test('parser: a Head line with `hold X` and no Hold line right above binds nothing', () => {
  nothing(reply(head(A, { hold: HOLD.id }), READY));
  nothing(reply(head(A, { hold: HOLD.id }), readyLine([7])), 'even under the plain wording');
  nothing(reply('prose', head(A, { hold: HOLD.id }), READY));
  nothing(reply('Areas R1-a', head(A, { hold: HOLD.id }), READY));
});

test('parser: a Hold line above a Head line without the hold field binds nothing', () => {
  nothing(reply(holdLine(), head(A), readyLine([7])));
  nothing(reply(holdLine(), head(A), READY));
});

test('parser: the hold field repeated or after `repo` is no Head line', () => {
  nothing(reply(holdLine(), `${head(A, { hold: HOLD.id, repo: null })} · hold ${HOLD.id} · repo acme/widgets`, READY));
  nothing(reply(holdLine(), `head ${A.slice(0, 12)} · items ${ITEMS} · repo acme/widgets · hold ${HOLD.id}`, READY));
  nothing(reply(holdLine(), `head ${A.slice(0, 12)} · hold ${HOLD.id} · items ${ITEMS} · repo acme/widgets`, READY));
});

test('parser: a hold needs the lift wording on the 🔀 line; the wording needs a hold', () => {
  nothing(reply(holdLine(), head(A, { hold: HOLD.id }), readyLine([7])), 'hold without the phrase');
  nothing(reply(head(A), READY), 'phrase without a hold');
  nothing(reply(holdLine(), head(A, { hold: HOLD.id }), '🔀 Ready to merge #7 and lift the needs-human hold — say "merge"'), 'another wording');
  nothing(reply(holdLine(), head(A, { hold: HOLD.id }), '🔀 Ready to merge #7 and lift their needs-human holds — say "merge"'), 'plural wording for one PR');
  nothing(reply(holdLine(), head(A, { hold: HOLD.id }), '🔀 Ready to merge #7 and lift its needs-human hold'), 'no say "merge"');
  nothing(reply(holdLine(), head(A, { pr: 7, hold: HOLD.id }), '🔀 Ready to merge #8 and lift its needs-human hold — say "merge"'), 'a prefixed Head line for a PR the line does not name');
  assert.equal(presentedRequests(reply(holdLine(), head(A, { hold: HOLD.id }), '🔀 Ready to merge #7 and lift its needs-human hold - say "merge".')).requests.length, 1, 'a hyphen and a final full stop read');
  assert.equal(presentedRequests(reply(holdLine(), head(A, { hold: HOLD.id }), '🔀 Ready to merge #7 and lift its needs-human hold -- say "merge"')).requests.length, 1);
});

test('parser: the PR numbers on the lift line are still read', () => {
  assert.deepEqual(presentedRequests(one).prs, [7]);
  assert.deepEqual(presentedRequests(reply('x', readyLine([1, 2, 3], { lift: true }))).prs, [1, 2, 3]);
});

test('parser: several PRs with holds and the plural wording', () => {
  const h1 = { ...HOLD, id: 'LE_one' };
  const h2 = { ...HOLD, id: 'LE_two', login: 'octo-bot[bot]', at: '2026-11-04T01:02:03Z' };
  const text = reply('#1 areas R1-a', holdLine(h1, 1), head(A, { pr: 1, hold: h1.id }), holdLine(h2, 2), head(B, { pr: 2, hold: h2.id }), readyLine([1, 2], { lift: true }));
  const r = presentedRequests(text);
  assert.deepEqual(r.prs, [1, 2]);
  assert.deepEqual(r.requests.map((q) => [q.pr, q.hold, q.holdBlock, q.areas]), [[1, 'LE_one', holdDigest(h1), areasDigest(['R1-a'])], [2, 'LE_two', holdDigest(h2), undefined]]);
  // one PR with a hold, one without: the plural wording covers it
  const mixed = presentedRequests(reply(holdLine(h1, 1), head(A, { pr: 1, hold: h1.id }), head(B, { pr: 2 }), readyLine([1, 2], { lift: true })));
  assert.deepEqual(mixed.requests.map((q) => [q.pr, q.hold]), [[1, 'LE_one'], [2, undefined]]);
  nothing(reply(holdLine(h1, 1), head(A, { pr: 1, hold: h1.id }), head(B, { pr: 2 }), readyLine([1, 2])), 'holds without the wording');
  nothing(reply(holdLine(h1, 1), head(A, { pr: 1, hold: h1.id }), head(B, { pr: 2 }), '🔀 Ready to merge #1, #2 and lift its needs-human hold — say "merge"'), 'singular wording for two PRs');
});

test('parser: another PR\'s Hold line (prefix differs from its Head line) binds nothing', () => {
  nothing(reply(holdLine(HOLD, 2), head(A, { pr: 1, hold: HOLD.id }), head(B, { pr: 2 }), readyLine([1, 2], { lift: true })));
  nothing(reply(holdLine(HOLD), head(A, { pr: 1, hold: HOLD.id }), readyLine([1], { lift: true })));
  nothing(reply(holdLine(HOLD, 1), head(A, { hold: HOLD.id }), READY));
});

test('parser: Areas two lines above Head (over a Hold) must carry the Head\'s PR number', () => {
  nothing(reply('#2 areas R1-a', holdLine(HOLD, 1), head(A, { pr: 1, hold: HOLD.id }), readyLine([1], { lift: true })));
  const ok = presentedRequests(reply('#1 areas R1-a', holdLine(HOLD, 1), head(A, { pr: 1, hold: HOLD.id }), readyLine([1], { lift: true })));
  assert.equal(ok.requests[0]?.areas, areasDigest(['R1-a']));
});

test('parser: a Hold line elsewhere in the reply (earlier prose "Hold ...") fails the whole reply, even without a hold request', () => {
  nothing(reply('Hold on, a second.', head(A), readyLine([7])));
});

// ----- the record and the match -----

const REPO = 'acme/widgets';
const q = (extra = {}) => ({ repo: REPO, pr: 7, head: A, items: ITEMS, areas: [], ...extra });
const said = (t, text) => {
  const record = ownerSays(t, 'merge', text);
  assert.ok(record, 'the "merge" is recorded');
  return record;
};

test('record: the hold id and block digest are stored on the request, nothing else changes', (t) => {
  const record = said(t, one);
  assert.deepEqual(record.requests, [{ pr: 7, head: A.slice(0, 12), items: ITEMS, repo: REPO, hold: HOLD.id, holdBlock: holdDigest(HOLD) }]);
  assert.equal(approvalGap(q({ hold: HOLD })), 'ok');
});

test('round trip: holdBlock + a rendered Head line + readyLine -> presentedRequests -> recordApproval -> approvalGap ok', (t) => {
  const text = reply('The parked PR is listed above.', areasBlock(['R1-a']), holdBlock(HOLD), head(A, { hold: HOLD.id }), readyLine([7], { lift: true }));
  const record = said(t, text);
  assert.equal(record.requests[0].areas, areasDigest(['R1-a']));
  assert.equal(approvalGap(q({ areas: ['R1-a'], hold: HOLD })), 'ok');
});

test('approvalGap: a record for hold X never covers hold Y; the block (login, time) must match as well', (t) => {
  said(t, one);
  assert.equal(approvalGap(q({ hold: HOLD })), 'ok');
  assert.equal(approvalGap(q({ hold: { ...HOLD, id: 'LE_lADOabc123_xyz-8' } })), 'none', 'another id');
  assert.equal(approvalGap(q({ hold: { ...HOLD, id: HOLD.id.toLowerCase() } })), 'none', 'the id is compared exactly (case-sensitive)');
  assert.equal(approvalGap(q({ hold: { ...HOLD, login: 'someone-else' } })), 'none', 'another login');
  assert.equal(approvalGap(q({ hold: { ...HOLD, at: '2026-11-05T08:30:01Z' } })), 'none', 'another time');
  assert.equal(approvalGap(q({ hold: { ...HOLD, login: 'bad login' } })), 'none', 'a hold with no showable block');
});

test('approvalGap: a record with a hold never approves a PR whose live state has no hold (exact equality both ways)', (t) => {
  said(t, one);
  assert.equal(approvalGap(q({ hold: undefined })), 'none');
  assert.equal(approvalGap(q()), 'none', 'absent = no hold');
  assert.equal('hold' in q(), false);
});

test('approvalGap: an old record without a hold never lifts one; with no live hold it still approves', (t) => {
  said(t, reply(head(A), readyLine([7])));
  assert.equal(approvalGap(q({ hold: HOLD })), 'none');
  assert.equal(approvalGap(q({ hold: undefined })), 'ok');
  assert.equal(approvalGap(q()), 'ok');
});

test('approvalGap: hold: null (the gated route) compares nothing; undefined means no hold', (t) => {
  said(t, one);
  assert.equal(approvalGap(q({ hold: null })), 'ok', 'hold: null binds nothing');
  assert.equal(approvalGap(q({ hold: null, areas: null })), 'ok');
  assert.equal(approvalGap(q({ hold: { ...HOLD, id: 'LE_other' } })), 'none');
});

test('record: a block that binds nothing records no request', (t) => {
  const record = ownerSays(t, 'merge', reply(holdLine(), head(A, { hold: HOLD.id }), readyLine([7])));
  assert.deepEqual(record?.requests ?? [], []);
  assert.equal(approvalGap(q({ hold: HOLD })), 'none');
});
