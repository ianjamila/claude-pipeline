// #58: the owner-go recorder (hooks/lib/owner-go.mjs). What counts as the owner's "merge", what it is bound to (only the
// request the reply right before it showed), who can never record one (subagents, other hook events), and how the records
// are stored and read (real folders and files only, a day at most). All in a temp home.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  approvedPr, approvedRequest, lastRequestText, ownerGoDir, ownerItemsDigest, parseApproval, presentedRequests, readApprovals, recordApproval,
  presentedRuling, recordRuling, ownerRuled, rulingsIn,
  parseRoundGrant, presentedRoundRequest, recordRoundGrant, ownerGrantedRounds, grantIdOf, markerPath, claimGrantMarkers, readGrantMarker, verifyOwnerGrant,
} from '../pipeline/hooks/lib/owner-go.mjs';
import { ownerGrants, roundRequest } from './helpers/owner-go.mjs';

const HEAD = '0123456789abcdef0123456789abcdef01234567';
const ITEMS = 'abcdef012345';
const REPO = 'acme/app';
const REQUEST = `Two items for you.\nHead ${HEAD.slice(0, 12)} · items ${ITEMS} · repo ${REPO}\n🔀 Ready to merge #58 — say "merge"`;

const tmp = () => mkdtempSync(join(tmpdir(), 'owner-go-unit-'));
function transcript(dir, entries) {
  const file = join(dir, `t-${Math.random().toString(36).slice(2)}.jsonl`);
  writeFileSync(file, `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`);
  return file;
}
const user = (text) => ({ type: 'user', message: { content: text } });
const said = (text) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
const toolResult = () => ({ type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } });
const input = (home, prompt, entries, extra = {}) => ({
  hook_event_name: 'UserPromptSubmit', session_id: 'sess-1', cwd: home, prompt, transcript_path: transcript(home, [...entries, user(prompt)]), ...extra,
});

test('owner-go: only a prompt that STARTS with "merge" and holds nothing but targets approves', () => {
  for (const [p, want] of [
    ['merge', { prs: [], shas: [] }],
    ['Merge.', { prs: [], shas: [] }],
    ['  merge it please ', { prs: [], shas: [] }],
    ['merge #58', { prs: [58], shas: [] }],
    ['merge 1318, #1319 and 1318', { prs: [1318, 1319], shas: [] }],
    ['merge 0123456789ab', { prs: [], shas: ['0123456789ab'] }],
  ]) assert.deepEqual(parseApproval(p), want, p);
  for (const p of ['do not merge', "don't merge #58", 'merge?', 'merge #58?', 'merge later', 'merge after CI', 'merged', 'merge-it', 'why merge', 'not yet, merge tomorrow', '', null]) {
    assert.equal(parseApproval(p), null, String(p));
  }
});

test('owner-go: the request lines bind a PR to the head and item set shown; lines for PRs not on the 🔀 line are ignored', () => {
  assert.deepEqual(presentedRequests(REQUEST), { prs: [58], requests: [{ pr: 58, head: HEAD.slice(0, 12), items: ITEMS, repo: REPO }] });
  const two = `#1318 head ${'a'.repeat(12)} · items none\n#1319 head ${'b'.repeat(40)} · items ${ITEMS}\n#77 head ${'c'.repeat(12)} · items none\n🔀 Ready to merge #1318, #1319 — say "merge"`;
  assert.deepEqual(presentedRequests(two).requests.map((r) => r.pr), [1318, 1319]);
  // a bare Head line with several PRs on the 🔀 line names none of them; a 7-character head or a missing item set binds nothing
  assert.deepEqual(presentedRequests(`Head ${'a'.repeat(12)} · items none\n🔀 Ready to merge #1, #2 — say "merge"`).requests, []);
  assert.deepEqual(presentedRequests(`Head ${'a'.repeat(7)} · items none\n🔀 Ready to merge #1 — say "merge"`).requests, []);
  assert.deepEqual(presentedRequests(`Head ${'a'.repeat(12)}\n🔀 Ready to merge #1 — say "merge"`).requests, []);
  assert.deepEqual(presentedRequests('Head 0123456789ab · items none').prs, []);
});

test('owner-go: the request is read from the LAST reply only; an older one is never revived', () => {
  const home = tmp();
  const t1 = transcript(home, [user('go'), said(REQUEST), toolResult(), said('…and CI is green.'), user('merge')]);
  assert.match(lastRequestText(t1), /Ready to merge #58/, 'tool results and later text blocks are the same reply');
  const t2 = transcript(home, [user('go'), said(REQUEST), user('what changed?'), said('Only the docs.'), user('merge')]);
  assert.equal(lastRequestText(t2), '', 'a later reply without a request: nothing to approve');
  assert.equal(lastRequestText(join(home, 'missing.jsonl')), '');
});

test('owner-go: an approval is recorded with what was shown, narrowed by the PRs or head the owner named', () => {
  const home = tmp();
  const now = () => Date.parse('2026-10-14T10:00:00Z');
  const r = recordApproval(input(home, 'merge', [said(REQUEST)]), { home, now });
  assert.deepEqual(r.requests, [{ pr: 58, head: HEAD.slice(0, 12), items: ITEMS, repo: REPO }]);
  assert.deepEqual(r.prs, [58]);
  assert.equal(r.session, 'sess-1');
  assert.ok(!JSON.stringify(r).includes('"merge"'), 'the prompt is stored as a hash only');
  assert.deepEqual(recordApproval(input(home, 'merge #59', [said(REQUEST)]), { home, now }).requests, [], 'another PR named: the shown request is not approved');
  assert.deepEqual(recordApproval(input(home, 'merge #59', [said(REQUEST)]), { home, now }).prs, [59], '…but the named PR is (for a direct merge)');
  assert.deepEqual(recordApproval(input(home, 'merge ffffffffffff', [said(REQUEST)]), { home, now }).requests, [], 'another head named');
  assert.equal(recordApproval(input(home, 'do not merge', [said(REQUEST)]), { home, now }), null);
  const lines = readFileSync(join(ownerGoDir(home), 'sess-1.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 4);
});

test('owner-go: subagents, other hook events and odd session names never record', () => {
  const home = tmp();
  for (const extra of [
    { agent_id: 'a1' },
    { hook_event_name: 'PreToolUse' },
    { transcript_path: join(home, 'projects', 'x', 'subagents', 'agent-1.jsonl') },
    { session_id: '../etc' },
    { session_id: '' },
  ]) assert.equal(recordApproval(input(home, 'merge', [said(REQUEST)], extra), { home }), null, JSON.stringify(extra));
  assert.equal(existsSync(join(ownerGoDir(home), '..etc.jsonl')), false);
});

// Phase 3b: the ruling recorder (triage owner-ruling --owner-quote must be the owner's whole answer to a ruling request).
test('owner-go: a ruling is recorded only after a reply that ends with the ruling line, and only for the owner', () => {
  const home = tmp();
  const now = () => Date.parse('2026-10-14T10:00:00Z');
  const CONTENT = 'abcdef012345';
  const ASK = `R1-B1 waits for you.\n⚖️ Owner ruling needed #58: R1-B1, R2-S3 · content ${CONTENT} · repo O/R`;
  assert.deepEqual(presentedRuling(ASK), { pr: 58, repo: 'o/r', ids: ['R1-B1', 'R2-S3'], content: CONTENT });
  assert.equal(presentedRuling(ASK.replace(CONTENT, CONTENT.toUpperCase())).content, CONTENT, 'the digest is read in lower case');
  assert.deepEqual(presentedRuling('⚖️ Owner ruling needed #58: R1-B1 · repo o/r'), { pr: 58, repo: 'o/r', ids: ['R1-B1'], content: null }, 'the old line shape has no content');
  for (const bad of ['abcdef01234', 'abcdef0123456', 'ghijkl012345', 'none']) {
    assert.equal(presentedRuling(ASK.replace(CONTENT, bad)), null, `content ${bad}`);
  }
  assert.deepEqual(presentedRuling('Owner ruling needed #58: R1-B1 | repo o/r'), null, 'the ⚖ mark is part of the line');
  for (const bad of [`${ASK}\nanything after`, '⚖️ Owner ruling needed #58: R1-B1', '⚖️ Owner ruling needed: R1-B1 · repo o/r', '⚖️ Owner ruling needed #58: all of them · repo o/r']) {
    assert.equal(presentedRuling(bad), null, bad);
  }
  const answer = 'R1-B1: reject,  R2-S3 follow-up';
  const r = recordRuling(input(home, answer, [said(ASK)]), { home, now });
  assert.deepEqual([r.kind, r.repo, r.pr, r.ids, r.content, r.prompt], ['ruling', 'o/r', 58, ['R1-B1', 'R2-S3'], CONTENT, answer]);
  const ruled = (o) => ownerRuled({ repo: 'o/r', pr: 58, id: 'R1-B1', quote: 'r1-b1: REJECT, r2-s3 follow-up', decision: 'REJECT', contentOf: () => CONTENT, home, now, ...o });
  assert.equal(ruled({}), true, 'the whole answer, white space and case aside');
  assert.equal(ruled({ id: 'R2-S3', decision: 'FOLLOW-UP' }), true, 'each item its own decision');
  assert.equal(ruled({ id: 'R2-S3', decision: 'REJECT' }), false, 'the decision written for another item');
  assert.equal(ruled({ quote: 'R1-B1: reject' }), false, 'a part of the answer');
  assert.equal(recordRuling(input(home, `R1-B1: accept${' '.repeat(1000)}.`, [said(ASK)]), { home, now }), null, 'an answer over 1000 characters is not recorded (never cut)');
  assert.equal(ruled({ decision: 'ACCEPT' }), false);
  assert.equal(ruled({ id: 'R3-B1' }), false, 'an item not asked about');
  assert.equal(ruled({ quote: '  ' }), false, 'an empty quote');
  assert.equal(ruled({ now: () => now() + 25 * 3600 * 1000 }), false, 'older than a day');
  // #110: the recorded digest must equal the one recomputed over the record's WHOLE id list from the current state
  let asked;
  assert.equal(ruled({ contentOf: (ids) => { asked = ids; return CONTENT; } }), true);
  assert.deepEqual(asked, ['R1-B1', 'R2-S3'], 'every id of the request, not only the one being ruled');
  assert.equal(ruled({ contentOf: () => '000000000000' }), false, 'the finding text changed');
  assert.equal(ruled({ contentOf: () => null }), false, 'one of the items is gone');
  assert.equal(ruled({ contentOf: undefined }), false, 'no way to check the content: fail closed');
  const old = recordRuling(input(home, 'R1-B1: reject', [said('R1-B1 waits.\n⚖️ Owner ruling needed #59: R1-B1 · repo o/r')]), { home, now });
  assert.deepEqual([old.pr, old.content], [59, null]);
  assert.equal(ruled({ pr: 59, quote: 'R1-B1: reject', contentOf: () => CONTENT }), false, 'a ruling asked in the old line shape approves nothing');
  assert.deepEqual(readApprovals({ home, now }), [], 'a ruling never reads as a "merge"');
  assert.equal(recordRuling(input(home, 'reject it', [said(ASK)], { agent_id: 'a1' }), { home, now }), null, 'a subagent');
  assert.equal(recordRuling(input(home, 'reject it', [said('No ruling asked here.')]), { home, now }), null, 'no ruling line');
  assert.equal(recordApproval(input(home, 'reject it', [said(ASK)]), { home, now }), null, 'not a "merge" either');
});

// Security reviews of f17b251 / ff8090f: the answer is read in one fixed form, so a negation, a loose answer to several items or
// a decision written for another item never passes for the owner's ruling.
test('owner-go: rulingsIn reads an answer that is only "<id>: <decision>" pairs, the id always written', () => {
  const two = ['R1-B1', 'R2-S3'];
  const read = (answer, asked = two) => Object.fromEntries(rulingsIn(answer, asked));
  assert.deepEqual(read('R1-B1: accept. R2-S3 - reject'), { 'R1-B1': 'ACCEPT', 'R2-S3': 'REJECT' });
  assert.deepEqual(read('r1-b1 followup, r2-s3=Follow up!'), { 'R1-B1': 'FOLLOW-UP', 'R2-S3': 'FOLLOW-UP' });
  assert.deepEqual(read('R1-B1: accept and R2-S3: reject'), { 'R1-B1': 'ACCEPT', 'R2-S3': 'REJECT' });
  assert.deepEqual(read('R2-S3: reject'), { 'R2-S3': 'REJECT' }, 'some of the asked items');
  // anything but decisions decides nothing (security reviews of f17b251, ff8090f, 009d435)
  for (const bad of ['R1-B1: accept, it is fine', 'accept one, reject the other', 'accept R1-B1', 'R1-B1: accept, R1-B1: reject', 'R1-B1: accept, R1-B1: accept',
    'R1-B10: accept', "R1-B1: don’t accept", 'R1-B1: accept rather than reject', 'R1-B1: accept, R2-S3: reject. R1-B1 is fine', 'R1-B1: accepted', '']) {
    assert.deepEqual(read(bad), {}, bad);
  }
  const one = (answer) => read(answer, ['R1-B1']);
  assert.deepEqual(one('R1-B1: reject'), { 'R1-B1': 'REJECT' });
  for (const bad of ['Follow-up.', 'accept', 'Yes, file it as a follow-up', 'ok', 'accept the first, reject the rest', 'accept R2-S3', 'do not accept', 'no follow-up', 'accept accept']) {
    assert.deepEqual(one(bad), {}, bad);
  }
  assert.deepEqual(read('accept'), {}, 'a bare decision when two items were asked');
});

test('owner-go: records are written and read only through real folders and files', { skip: process.platform === 'win32' }, () => {
  // a symlinked owner-go folder
  const home = tmp();
  const elsewhere = tmp();
  mkdirSync(join(home, '.claude', 'pipeline-state'), { recursive: true });
  symlinkSync(elsewhere, join(home, '.claude', 'pipeline-state', 'owner-go'));
  assert.equal(recordApproval(input(home, 'merge', [said(REQUEST)]), { home }), null);
  assert.deepEqual(readApprovals({ home }), []);
  // a symlinked session file
  const home2 = tmp();
  mkdirSync(ownerGoDir(home2), { recursive: true });
  const target = join(tmp(), 'x.jsonl');
  writeFileSync(target, '');
  symlinkSync(target, join(ownerGoDir(home2), 'sess-1.jsonl'));
  assert.equal(recordApproval(input(home2, 'merge', [said(REQUEST)]), { home: home2 }), null);
  assert.equal(readFileSync(target, 'utf8'), '', 'nothing written through the link');
});

test('owner-go: approvals last a day, never come from the future, and must be in their own session\'s file', () => {
  const home = tmp();
  const at = Date.parse('2026-10-14T10:00:00Z');
  recordApproval(input(home, 'merge', [said(REQUEST)]), { home, now: () => at });
  const q = { repo: REPO, pr: 58, head: HEAD, items: ITEMS, home };
  assert.equal(approvedRequest({ ...q, now: () => at + 60_000 }), true);
  assert.equal(approvedRequest({ ...q, now: () => at + 25 * 3600_000 }), false, 'older than a day');
  assert.equal(approvedRequest({ ...q, now: () => at - 3600_000 }), false, 'from the future');
  assert.equal(approvedRequest({ ...q, head: `${'f'.repeat(12)}${HEAD.slice(12)}`, now: () => at }), false, 'another head');
  assert.equal(approvedRequest({ ...q, head: HEAD.slice(0, 12), now: () => at }), false, 'the full head is required');
  assert.equal(approvedRequest({ ...q, items: 'none', now: () => at }), false, 'another item set');
  assert.equal(approvedRequest({ ...q, pr: 59, now: () => at }), false, 'another PR');
  // the guard's question: this PR at this full head, this session
  const g = { repo: REPO, pr: 58, head: HEAD, session: 'sess-1', home, now: () => at };
  assert.equal(approvedPr(g), true);
  assert.equal(approvedPr({ ...g, session: 'sess-2' }), false);
  assert.equal(approvedPr({ ...g, pr: 59 }), false);
  assert.equal(approvedPr({ ...g, head: HEAD.slice(0, 12) }), false, 'a full head only');
  assert.equal(approvedPr({ ...g, head: 'f'.repeat(40) }), false, 'another head');
  // a PR merely named in the prompt approves no head
  recordApproval(input(home, 'merge #60', [said('nothing shown')]), { home, now: () => at });
  assert.equal(approvedPr({ ...g, pr: 60 }), false);
  // a line copied into another session's file does not count there
  const line = readFileSync(join(ownerGoDir(home), 'sess-1.jsonl'), 'utf8');
  writeFileSync(join(ownerGoDir(home), 'sess-2.jsonl'), line);
  assert.equal(approvedPr({ ...g, session: 'sess-2' }), false);
});

test('owner-go: the owner-item digest is order-free and "none" without items', () => {
  assert.equal(ownerItemsDigest([]), 'none');
  assert.equal(ownerItemsDigest(['hardstop R1 a', 'review F2 x']), ownerItemsDigest(['review F2 x', 'hardstop R1 a', 'hardstop R1 a']));
  assert.notEqual(ownerItemsDigest(['hardstop R1 a']), ownerItemsDigest(['hardstop R1 b']));
  assert.match(ownerItemsDigest(['x']), /^[0-9a-f]{12}$/);
});

test('owner-go hook: never blocks a prompt; prints one line of context only when it recorded something', () => {
  const hook = fileURLToPath(new URL('../pipeline/hooks/owner-go.mjs', import.meta.url));
  for (const stdin of ['not json', '{}', JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's', prompt: 'hello' })]) {
    const r = spawnSync(process.execPath, [hook], { input: stdin, encoding: 'utf8' });
    assert.equal(r.status, 0, stdin);
    assert.equal(r.stdout, '', stdin);
  }
});

// Codex review (#58) finding 4: only the terminal request block (the reply's last lines) binds anything
test('owner-go: only the terminal request block binds; an earlier block, trailing text or a duplicate binding binds nothing', () => {
  const A = 'a'.repeat(12);
  const B = 'b'.repeat(12);
  const two = `Head ${A} · items none\n🔀 Ready to merge #7 — say "merge"\nHead ${B} · items none\n🔀 Ready to merge #8 — say "merge"`;
  assert.deepEqual(presentedRequests(two), { prs: [8], requests: [{ pr: 8, head: B, items: 'none', repo: null }] }, 'the earlier #7 block is not a request');
  const dup = `Head ${A} · items none\nHead ${B} · items none\n🔀 Ready to merge #8 — say "merge"`;
  assert.deepEqual(presentedRequests(dup).requests, [], 'two heads for one PR: ambiguous, so none');
  const dupPr = `#8 head ${A} · items none\n#8 head ${A} · items none\n🔀 Ready to merge #8, #9 — say "merge"`;
  assert.deepEqual(presentedRequests(dupPr).requests, [], 'the same PR bound twice: ambiguous');
  const after = `Head ${A} · items none\n🔀 Ready to merge #8 — say "merge"\nOne more thing: also CI is green.`;
  assert.deepEqual(presentedRequests(after), { prs: [], requests: [] }, 'text after the 🔀 line: the reply does not END with the request');
  const apart = `Head ${A} · items none\nSome prose.\n🔀 Ready to merge #8 — say "merge"`;
  assert.deepEqual(presentedRequests(apart).requests, [], 'a Head line not directly above the 🔀 line is not part of the block');
});

// Codex review (#58) finding 5: only the slot of the current prompt may be empty
test('owner-go: a tool-only turn between the request and the "merge" invalidates it', () => {
  const home = tmp();
  const t1 = transcript(home, [user('go'), said(REQUEST), user('run the tests'), { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'x', name: 'Bash', input: {} }] } }, toolResult(), user('merge')]);
  assert.equal(lastRequestText(t1), '', 'an intervening prompt and a text-less assistant turn: the old request is stale');
  const t2 = transcript(home, [user('go'), said(REQUEST), user('run the tests'), { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'x', name: 'Bash', input: {} }] } }, toolResult()]);
  assert.equal(lastRequestText(t2), '', 'the "merge" not yet in the transcript: the text-less turn is the last reply');
  const t3 = transcript(home, [user('go'), said(REQUEST), user('merge'), { type: 'system', content: 'x' }]);
  assert.match(lastRequestText(t3), /Ready to merge #58/, 'the current prompt\'s own empty slot is skipped (other entry kinds do not count)');
});

// #58 round 3: whether the hook runs before or after the current prompt is written to the transcript must not matter
test('owner-go: the newest prompt in the transcript is "the current one" only when its text is the prompt being submitted', () => {
  const home = tmp();
  const req = /Ready to merge #58/;
  // the current prompt is already in the transcript: its own empty slot is skipped
  assert.match(lastRequestText(transcript(home, [user('go'), said(REQUEST), user('merge')]), { prompt: 'merge' }), req);
  assert.match(lastRequestText(transcript(home, [user('go'), said(REQUEST), { type: 'user', message: { content: [{ type: 'text', text: 'merge' }] } }]), { prompt: 'merge' }), req, 'block content');
  assert.match(lastRequestText(transcript(home, [user('go'), said(REQUEST), user('merge\n')]), { prompt: '  merge' }), req, 'surrounding whitespace is ignored');
  // not yet written: the newest entry is the reply itself
  assert.match(lastRequestText(transcript(home, [user('go'), said(REQUEST)]), { prompt: 'merge' }), req);
  // the newest entry is an OLDER, unanswered prompt: its empty slot is the reply to use, so there is no request (the request before it is stale)
  assert.equal(lastRequestText(transcript(home, [user('go'), said(REQUEST), user('run the tests')]), { prompt: 'merge' }), '');
  assert.equal(lastRequestText(transcript(home, [user('go'), said(REQUEST), user('run the tests'), toolResult()]), { prompt: 'merge' }), '');
  // and through the recorder: an approval recorded for a request that an older prompt already made stale shows nothing
  const now = () => Date.parse('2026-10-14T10:00:00Z');
  const stale = { hook_event_name: 'UserPromptSubmit', session_id: 'sess-1', cwd: home, prompt: 'merge', transcript_path: transcript(home, [user('go'), said(REQUEST), user('run the tests')]) };
  assert.deepEqual(recordApproval(stale, { home, now }).requests, []);
  assert.deepEqual(recordApproval(stale, { home, now }).prs, []);
  const fresh = { ...stale, transcript_path: transcript(home, [user('go'), said(REQUEST)]) };
  assert.deepEqual(recordApproval(fresh, { home, now }).requests, [{ pr: 58, head: HEAD.slice(0, 12), items: ITEMS, repo: REPO }]);
});

// #58 round 4: an image-only (or any non-text, non-tool_result) user message is a prompt boundary too
test('owner-go: a user message with no tool_result is a prompt, text or not', () => {
  const home = tmp();
  const image = { type: 'user', message: { content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }] } };
  const tools = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'x', name: 'Bash', input: {} }] } };
  // request -> image-only user message -> tool-only assistant turn -> "merge": the request is stale
  assert.equal(lastRequestText(transcript(home, [user('go'), said(REQUEST), image, tools, user('merge')]), { prompt: 'merge' }), '');
  assert.equal(lastRequestText(transcript(home, [user('go'), said(REQUEST), image, tools, user('merge')])), '');
  // the image is the newest entry (the hook runs before the transcript has "merge"): an older, unanswered prompt, not the current one
  assert.equal(lastRequestText(transcript(home, [user('go'), said(REQUEST), image]), { prompt: 'merge' }), '');
  // a text + image message is a prompt whose text is compared
  const both = { type: 'user', message: { content: [{ type: 'text', text: 'merge' }, image.message.content[0]] } };
  assert.match(lastRequestText(transcript(home, [user('go'), said(REQUEST), both]), { prompt: 'merge' }), /Ready to merge #58/);
  // an image-only message is the current prompt only when the submitted prompt is empty too
  assert.match(lastRequestText(transcript(home, [user('go'), said(REQUEST), image]), { prompt: '' }), /Ready to merge #58/);
  assert.equal(lastRequestText(transcript(home, [user('go'), said(REQUEST), image]), { prompt: 'merge' }), '');
  // tool_result entries stay non-prompts (even with other blocks), and the request survives them
  const mixed = { type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }, image.message.content[0]] } };
  assert.match(lastRequestText(transcript(home, [user('go'), said(REQUEST), toolResult(), mixed, user('merge')]), { prompt: 'merge' }), /Ready to merge #58/);
  // through the recorder
  const now = () => Date.parse('2026-10-14T10:00:00Z');
  const stale = { hook_event_name: 'UserPromptSubmit', session_id: 'sess-1', cwd: home, prompt: 'merge', transcript_path: transcript(home, [user('go'), said(REQUEST), image, tools, user('merge')]) };
  assert.deepEqual(recordApproval(stale, { home, now }).requests, []);
});

// Phase 3b: the owner's "merge" names its repository; one for #N of another repository (a fork, a mirror) never approves this one.
test('owner-go: the request line binds the repository; a line without one is recorded but approves nothing', () => {
  const home = tmp();
  const at = Date.parse('2026-10-29T10:00:00Z');
  const now = () => at;
  assert.deepEqual(presentedRequests(`#7 head ${'a'.repeat(12)} | items none | repo Acme/App\n🔀 Ready to merge #7 — say "merge"`).requests, [{ pr: 7, head: 'a'.repeat(12), items: 'none', repo: 'acme/app' }]);
  assert.deepEqual(presentedRequests(`Head ${'a'.repeat(12)} · items none · repo acme\n🔀 Ready to merge #7 — say "merge"`).requests, [], 'a repository is owner/name');
  recordApproval(input(home, 'merge', [said(REQUEST)]), { home, now });
  const q = { repo: REPO, pr: 58, head: HEAD, items: ITEMS, home, now };
  assert.equal(approvedRequest(q), true);
  assert.equal(approvedRequest({ ...q, repo: 'ACME/APP' }), true, 'GitHub names are case-insensitive');
  assert.equal(approvedRequest({ ...q, repo: 'acme/fork' }), false, 'another repository');
  assert.equal(approvedRequest({ ...q, repo: undefined }), false, 'no repository asked about');
  assert.equal(approvedPr({ repo: REPO, pr: 58, head: HEAD, session: 'sess-1', home, now }), true);
  assert.equal(approvedPr({ repo: 'acme/fork', pr: 58, head: HEAD, session: 'sess-1', home, now }), false);
  assert.equal(approvedPr({ repo: null, pr: 58, head: HEAD, session: 'sess-1', home, now }), false);
  // a request line from before Phase 3b (no repo): recorded for the audit trail, approves nothing
  const home2 = tmp();
  const old = REQUEST.replace(` · repo ${REPO}`, '');
  assert.deepEqual(recordApproval(input(home2, 'merge', [said(old)]), { home: home2, now }).requests, [{ pr: 58, head: HEAD.slice(0, 12), items: ITEMS, repo: null }]);
  assert.equal(approvedRequest({ ...q, home: home2 }), false);
  assert.equal(approvedPr({ repo: REPO, pr: 58, head: HEAD, session: 'sess-1', home: home2, now }), false);
});

// ---- owner-granted extra review round ------------------------------------------------------------------------------------
const GHEAD = 'abcdef0123456789abcdef0123456789abcdef01';
const ASK = roundRequest(58, 4, GHEAD, REPO);
const AT = Date.parse('2026-11-03T10:00:00Z');
const NOW = () => AT;
const rulingAsk = () => 'R1-B1 waits.\n⚖️ Owner ruling needed #58: R1-B1 · content abcdef012345 · repo acme/app';

test('owner-go round grant: only a prompt that STARTS with "extra round" / "grant round" and holds nothing but targets and filler', () => {
  for (const [p, want] of [
    ['extra round', { prs: [], numbers: [] }],
    ['Extra Round.', { prs: [], numbers: [] }],
    ['extra round #1544', { prs: [1544], numbers: [] }],
    ['grant round 4', { prs: [], numbers: [4] }],
    ['grant round 4 #1544', { prs: [1544], numbers: [4] }],
    ['extra review round, please', { prs: [], numbers: [] }],
    ['  GRANT review round 4 and #58 now ', { prs: [58], numbers: [4] }],
    ['extra round 1544', { prs: [], numbers: [1544] }], // a bare integer is read against the line (R3.7)
    ['extra round\n#58\nplease', { prs: [58], numbers: [] }], // multi-line, as parseApproval
    ['extra round #58 4 #58', { prs: [58], numbers: [4] }],
  ]) assert.deepEqual(parseRoundGrant(p), want, p);
  for (const p of ['extra round?', 'no extra round', 'grant round 4 after CI', 'why extra round', 'extra rounds', 'extra round-ish', 'extra roundup',
    'extra round later', 'extra round #12345678', 'extra round 4 5 and 6 maybe', 'grant round #', 'extra', 'round', 'extra review', 'grant round 4 ?', '', null]) {
    assert.equal(parseRoundGrant(p), null, String(p));
  }
});

test('owner-go round grant: the request line is the last non-blank line and names PR, counted round, head and repository', () => {
  assert.deepEqual(presentedRoundRequest(ASK), { pr: 58, k: 4, head: GHEAD.slice(0, 12), repo: REPO });
  assert.deepEqual(presentedRoundRequest(`${ASK}\n\n  `), { pr: 58, k: 4, head: GHEAD.slice(0, 12), repo: REPO }, 'trailing blank lines');
  assert.deepEqual(presentedRoundRequest(`🔁 Extra review round needed #58: round 4 | head ${GHEAD} | repo Acme/App`), { pr: 58, k: 4, head: GHEAD, repo: 'acme/app' });
  assert.equal(presentedRoundRequest('Extra review round needed #58: round 4 · head abcdef012345 · repo a/b').pr, 58, 'the 🔁 mark is optional');
  for (const bad of [
    `${ASK}\nanything after`, // text after the line
    `${ASK}\nmore\nThen prose.`,
    'Extra review round needed #58: round 4 · head abcdef012345', // no repo
    'Extra review round needed #58: round 4 · head abcdef01234 · repo a/b', // 11-char head
    'Extra review round needed #58: round 4 · head abcdef01234g · repo a/b', // not hex
    `Extra review round needed #58: round 4 · head ${'a'.repeat(41)} · repo a/b`,
    'Extra review round needed #58: round x · head abcdef012345 · repo a/b',
    'Extra review round needed: round 4 · head abcdef012345 · repo a/b',
    'Extra review round needed #58: round 4 · head abcdef012345 · repo acme',
    '', null,
  ]) assert.equal(presentedRoundRequest(bad), null, String(bad));
  assert.equal(presentedRoundRequest(`Extra review round needed #58: round 4 · head abcdef012345 · repo a/b\nA mid-reply line: ${ASK}\nnext`), null, 'a line in the middle of a reply binds nothing');
});

test('owner-go round grant: recorded only after a reply that ends with the line, verbatim, for the owner only', () => {
  const home = tmp();
  const r = recordRoundGrant(input(home, 'Extra  Round, please', [said(ASK)]), { home, now: NOW });
  assert.deepEqual([r.v, r.kind, r.repo, r.pr, r.k, r.head, r.prompt, r.session, r.ts], [1, 'extra-round', REPO, 58, 4, GHEAD.slice(0, 12), 'Extra  Round, please', 'sess-1', new Date(AT).toISOString()]);
  assert.match(r.prompt_sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(readApprovals({ home, now: NOW }), [], 'a grant never reads as a "merge"');
  assert.equal(ownerRuled({ repo: REPO, pr: 58, id: 'R1-B1', quote: 'extra round', decision: 'ACCEPT', contentOf: () => 'abcdef012345', home, now: NOW }), false, 'nor as a ruling');
  const no = (why, i) => assert.equal(recordRoundGrant(i, { home, now: NOW }), null, why);
  no('text after the line', input(home, 'extra round', [said(`${ASK}\nBy the way.`)]));
  no('line mid-reply', input(home, 'extra round', [said(`${ASK}\nCI is green.\nDone.`)]));
  no('an older reply', input(home, 'extra round', [said(ASK), user('and?'), said('Still thinking.')]));
  no('a tool-only turn in between', input(home, 'extra round', [said(ASK), user('run it'), { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'x', name: 'Bash', input: {} }] } }, toolResult()]));
  no('no repo', input(home, 'extra round', [said(ASK.replace(/ · repo .*$/, ''))]));
  no('malformed head', input(home, 'extra round', [said(ASK.replace(GHEAD.slice(0, 12), 'zzzzzzzzzzzz'))]));
  no('short head', input(home, 'extra round', [said(ASK.replace(GHEAD.slice(0, 12), GHEAD.slice(0, 11)))]));
  no('no line at all', input(home, 'extra round', [said('Nothing asked.')]));
  no('subagent', input(home, 'extra round', [said(ASK)], { agent_id: 'a1' }));
  no('subagent transcript', input(home, 'extra round', [said(ASK)], { transcript_path: join(home, 'projects', 'x', 'subagents', 'a.jsonl') }));
  no('other hook event', input(home, 'extra round', [said(ASK)], { hook_event_name: 'PreToolUse' }));
  no('odd session', input(home, 'extra round', [said(ASK)], { session_id: '../x' }));
  no('not a grant', input(home, 'extra round?', [said(ASK)]));
  no('merge is no grant', input(home, 'merge', [said(ASK)]));
  const long = `extra round ${'please '.repeat(60)}`;
  assert.ok(long.length > 300);
  no('over-length prompt (never cut)', input(home, long, [said(ASK)]));
  no('an empty prompt', input(home, '  ', [said(ASK)]));
  assert.equal(recordApproval(input(home, 'extra round', [said(ASK)]), { home, now: NOW }), null, 'not a "merge" either');
  assert.equal(recordRuling(input(home, 'extra round', [said(ASK)]), { home, now: NOW }), null, 'not a ruling either');
});

test('owner-go round grant: a prompt naming another PR or round than the line records nothing; bare integers are read against the line', () => {
  const home = tmp();
  const grant = (p) => recordRoundGrant(input(home, p, [said(ASK)]), { home, now: NOW });
  for (const p of ['extra round #58', 'grant round 4', 'grant round 4 #58', 'extra round 58', 'extra round 4 58', 'extra round #58 4']) assert.ok(grant(p), p);
  for (const p of ['extra round #59', 'grant round 5', 'grant round 3 #58', 'grant round 4 #59', 'extra round 59', 'extra round 5', 'extra round 4 5', 'extra round #58 #59']) assert.equal(grant(p), null, p);
});

test('owner-go round grant: ownerGrantedRounds returns ALL open matching records, newest first, only for exactly this repository, PR, round and head', () => {
  const home = tmp();
  recordRoundGrant(input(home, 'extra round', [said(ASK)], { session_id: 'sess-a' }), { home, now: () => AT });
  recordRoundGrant(input(home, 'grant round 4', [said(ASK)], { session_id: 'sess-b' }), { home, now: () => AT + 60_000 });
  const q = { repo: 'ACME/App', pr: 58, k: 4, head: GHEAD, home, now: () => AT + 120_000 };
  const found = ownerGrantedRounds(q);
  assert.deepEqual(found.map((r) => r.session), ['sess-b', 'sess-a'], 'both, newest first');
  assert.deepEqual(found.map((r) => r.prompt), ['grant round 4', 'extra round']);
  assert.equal(ownerGrantedRounds({ ...q, head: `${GHEAD.slice(0, 12)}${'0'.repeat(28)}` }).length, 2, 'the recorded head is a prefix of the full head');
  for (const [why, o] of [
    ['other repo', { repo: 'acme/fork' }], ['no repo', { repo: undefined }], ['other PR', { pr: 59 }], ['other round', { k: 5 }], ['string round', { k: '4' }],
    ['other head', { head: `${'f'.repeat(12)}${GHEAD.slice(12)}` }], ['short head', { head: GHEAD.slice(0, 12) }], ['non-hex head', { head: 'g'.repeat(40) }],
    ['older than a day', { now: () => AT + 25 * 3600_000 }], ['from the future', { now: () => AT - 3600_000 }],
  ]) assert.deepEqual(ownerGrantedRounds({ ...q, ...o }), [], why);
  // a merge or ruling record is no grant
  const home2 = tmp();
  recordApproval(input(home2, 'merge', [said(REQUEST)]), { home: home2, now: NOW });
  recordRuling(input(home2, 'R1-B1: reject', [said(rulingAsk())]), { home: home2, now: NOW });
  assert.deepEqual(ownerGrantedRounds({ ...q, home: home2, repo: REPO, pr: 58 }), []);
  // hand-written lines: another session's file, another version, a prompt that does not hash to prompt_sha256, another kind
  const home3 = tmp();
  const rec = recordRoundGrant(input(home3, 'extra round', [said(ASK)]), { home: home3, now: NOW });
  const file = join(ownerGoDir(home3), 'sess-1.jsonl');
  const line = readFileSync(file, 'utf8');
  writeFileSync(join(ownerGoDir(home3), 'sess-9.jsonl'), line);
  writeFileSync(file, [line, `${JSON.stringify({ ...rec, v: 2 })}\n`, `${JSON.stringify({ ...rec, prompt: 'extra round, I mean it' })}\n`, `${JSON.stringify({ ...rec, kind: 'ruling' })}\n`].join(''));
  assert.equal(ownerGrantedRounds({ ...q, home: home3 }).length, 1, 'only the genuine line');
});

test('owner-go round grant: records are written and read only through real folders and files', { skip: process.platform === 'win32' }, () => {
  const home = tmp();
  const elsewhere = tmp();
  mkdirSync(join(home, '.claude', 'pipeline-state'), { recursive: true });
  symlinkSync(elsewhere, join(home, '.claude', 'pipeline-state', 'owner-go'));
  assert.equal(recordRoundGrant(input(home, 'extra round', [said(ASK)]), { home }), null);
  const home2 = tmp();
  mkdirSync(ownerGoDir(home2), { recursive: true });
  const target = join(tmp(), 'x.jsonl');
  writeFileSync(target, '');
  symlinkSync(target, join(ownerGoDir(home2), 'sess-1.jsonl'));
  assert.equal(recordRoundGrant(input(home2, 'extra round', [said(ASK)]), { home: home2 }), null);
  assert.equal(readFileSync(target, 'utf8'), '', 'nothing written through the link');
});

test('owner-go round grant: the grant id binds session, time and prompt hash (16 hex)', () => {
  const rec = { session: 's', ts: '2026-11-03T10:00:00.000Z', prompt_sha256: 'ab'.repeat(32) };
  const id = grantIdOf(rec);
  assert.match(id, /^[0-9a-f]{16}$/);
  assert.equal(id, createHash('sha256').update(`s|2026-11-03T10:00:00.000Z|${'ab'.repeat(32)}`).digest('hex').slice(0, 16));
  for (const o of [{ session: 't' }, { ts: '2026-11-03T10:00:00.001Z' }, { prompt_sha256: 'cd'.repeat(32) }]) assert.notEqual(grantIdOf({ ...rec, ...o }), id);
  assert.equal(grantIdOf({ ...rec, session: undefined }), null);
  assert.equal(grantIdOf(null), null);
});

const BODY = { repo: REPO, pr: 58, k: 4, head: GHEAD, checkout: '/work/app' };
function twoGrants(home) {
  recordRoundGrant(input(home, 'extra round', [said(ASK)], { session_id: 'sess-a' }), { home, now: () => AT });
  recordRoundGrant(input(home, 'grant round 4', [said(ASK)], { session_id: 'sess-b' }), { home, now: () => AT + 1000 });
  return ownerGrantedRounds({ repo: REPO, pr: 58, k: 4, head: GHEAD, home, now: () => AT + 2000 });
}

test('owner-go markers: one claim marks EVERY open matching record, once, with the full body; a second claim finds them used', () => {
  const home = tmp();
  const records = twoGrants(home);
  assert.equal(records.length, 2);
  const ids = records.map(grantIdOf);
  const c = claimGrantMarkers(records, BODY, { home, now: () => AT + 3000 });
  assert.equal(c.ok, true);
  assert.deepEqual([...c.claimed.map((m) => m.grantId)].sort(), [...ids].sort());
  for (const id of ids) {
    const file = markerPath(id, { home });
    assert.equal(file, join(ownerGoDir(home), 'consumed', `${id}.json`));
    if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { v: 1, grantId: id, repo: REPO, pr: 58, k: 4, head: GHEAD, consumedAt: new Date(AT + 3000).toISOString(), checkout: '/work/app' });
    assert.equal(readGrantMarker(id, { home }).marker.grantId, id);
  }
  assert.deepEqual(ownerGrantedRounds({ repo: REPO, pr: 58, k: 4, head: GHEAD, home, now: () => AT + 4000 }), [], 'no record is open after the claim');
  // a second claimer (another checkout, a race) loses: nothing is overwritten
  const again = claimGrantMarkers(records, { ...BODY, checkout: '/other' }, { home });
  assert.deepEqual([again.ok, again.reason], [false, 'used']);
  assert.equal(JSON.parse(readFileSync(markerPath(ids[0], { home }), 'utf8')).checkout, '/work/app');
  assert.equal(readdirSync(join(ownerGoDir(home), 'consumed')).length, 2);
});

test('owner-go markers: a duplicate grant cannot admit a second run: claim, discard, ask again => nothing open', () => {
  const home = tmp();
  const records = twoGrants(home);
  assert.equal(claimGrantMarkers(records, BODY, { home }).ok, true);
  // the same ordinal comes round again (discard-round): both records are spent, not just the newest
  assert.deepEqual(ownerGrantedRounds({ repo: REPO, pr: 58, k: 4, head: GHEAD, home, now: () => AT + 5000 }), []);
});

test('owner-go markers: unsafe or invalid input creates nothing', { skip: process.platform === 'win32' }, () => {
  const records = twoGrants(tmp());
  assert.deepEqual(claimGrantMarkers([], BODY, { home: tmp() }), { ok: false, reason: 'none' });
  for (const bad of [{ ...BODY, repo: 'acme' }, { ...BODY, pr: '58' }, { ...BODY, k: 0.5 }, { ...BODY, head: GHEAD.slice(0, 12) }]) {
    assert.equal(claimGrantMarkers(records, bad, { home: tmp() }).reason, 'invalid', JSON.stringify(bad));
  }
  assert.equal(claimGrantMarkers([{ ...records[0], session: undefined }], BODY, { home: tmp() }).reason, 'invalid');
  // a symlinked consumed/ folder
  const home = tmp();
  const elsewhere = tmp();
  mkdirSync(ownerGoDir(home), { recursive: true });
  symlinkSync(elsewhere, join(ownerGoDir(home), 'consumed'));
  const c = claimGrantMarkers(records, BODY, { home });
  assert.deepEqual([c.ok, c.reason], [false, 'unsafe']);
  assert.deepEqual(readdirSync(elsewhere), [], 'nothing written through the link');
  assert.equal(readGrantMarker(grantIdOf(records[0]), { home }).verifiable, false, 'a marker read through a linked folder is not trusted');
  // a symlinked owner-go folder
  const home2 = tmp();
  mkdirSync(join(home2, '.claude', 'pipeline-state'), { recursive: true });
  symlinkSync(tmp(), join(home2, '.claude', 'pipeline-state', 'owner-go'));
  assert.equal(claimGrantMarkers(records, BODY, { home: home2 }).reason, 'unsafe');
  // a pre-existing symlink (dangling) where the marker goes: refused, nothing written through it
  const home3 = tmp();
  mkdirSync(join(ownerGoDir(home3), 'consumed'), { recursive: true });
  const target = join(tmp(), 'victim');
  const [first] = records.map(grantIdOf).sort();
  symlinkSync(target, markerPath(first, { home: home3 }));
  const c3 = claimGrantMarkers(records, BODY, { home: home3 });
  assert.deepEqual([c3.ok, c3.reason], [false, 'used']);
  assert.equal(existsSync(target), false, 'nothing created through the link');
  const read = readGrantMarker(first, { home: home3 });
  assert.deepEqual([read.spent, read.verifiable], [true, false]);
});

test('owner-go markers: a write failing after the marker exists leaves the grant SPENT; a partial marker is spent and unverifiable', () => {
  const home = tmp();
  const records = twoGrants(home);
  const boom = () => { throw new Error('ENOSPC'); };
  const c = claimGrantMarkers(records, BODY, { home, io: { writeSync: boom } });
  assert.deepEqual([c.ok, c.reason], [false, 'spent']);
  const id = records.map(grantIdOf).find((x) => existsSync(markerPath(x, { home })));
  assert.ok(id, 'the marker file exists');
  assert.equal(ownerGrantedRounds({ repo: REPO, pr: 58, k: 4, head: GHEAD, home, now: () => AT + 5000 }).map(grantIdOf).includes(id), false, 'spent: not open');
  const read = readGrantMarker(id, { home });
  assert.deepEqual([read.spent, read.verifiable], [true, false], 'an empty marker');
  for (const text of ['{"v":1,"grantId":', 'null', '[]', JSON.stringify({ v: 1, grantId: 'f'.repeat(16), repo: REPO, pr: 58, k: 4, head: GHEAD, consumedAt: 'x' }), JSON.stringify({ v: 1, grantId: id, repo: REPO, pr: 58, k: 4, head: GHEAD.slice(0, 12), consumedAt: 'x' })]) {
    writeFileSync(markerPath(id, { home }), text);
    const r = readGrantMarker(id, { home });
    assert.deepEqual([r.spent, r.verifiable], [true, false], text);
  }
  assert.deepEqual(readGrantMarker('0'.repeat(16), { home }), { spent: false, verifiable: false }, 'no marker');
  assert.deepEqual(readGrantMarker('../x', { home }), { spent: true, verifiable: false }, 'not a grant id: never trusted');
  assert.equal(markerPath('../x', { home }), null);
});

test('owner-go markers: the gate check (verifyOwnerGrant) needs record AND marker to agree on repo, PR, round, the full head and the quote', () => {
  const home = tmp();
  const all = twoGrants(home);
  const rec = all[0];
  const grantId = grantIdOf(rec);
  assert.equal(claimGrantMarkers([rec], BODY, { home, now: () => AT + 3000 }).ok, true);
  const q = { repo: 'ACME/APP', pr: 58, k: 4, toHead: GHEAD, ownerGrant: { grantId, quote: rec.prompt } };
  const late = { home, now: () => AT + 40 * 24 * 3600_000 }; // the gate may run days later: the record's age does not matter
  const ok = verifyOwnerGrant(q, late);
  assert.equal(ok.ok, true);
  assert.equal(ok.quote, rec.prompt);
  const bad = (why, o, opts = late) => assert.equal(verifyOwnerGrant({ ...q, ...o }, opts).ok, false, why);
  bad('other repo', { repo: 'acme/fork' });
  bad('other PR', { pr: 59 });
  bad('other round', { k: 5 });
  bad('another head under review (same 12-char prefix)', { toHead: `${GHEAD.slice(0, 12)}${'0'.repeat(28)}` });
  bad('short head', { toHead: GHEAD.slice(0, 12) });
  bad('paraphrased quote', { ownerGrant: { grantId, quote: rec.prompt.toUpperCase() } });
  bad('trailing space in the quote', { ownerGrant: { grantId, quote: `${rec.prompt} ` } });
  bad('no quote', { ownerGrant: { grantId } });
  bad('no ownerGrant', { ownerGrant: undefined });
  bad('an unknown grant id', { ownerGrant: { grantId: '0'.repeat(16), quote: rec.prompt } });
  bad('a malformed grant id', { ownerGrant: { grantId: '../x', quote: rec.prompt } });
  bad('another ownerGrant.k', { ownerGrant: { grantId, quote: rec.prompt, k: 5 } });
  bad('another home (record unreadable)', {}, { home: tmp(), now: late.now });
  // a record nobody consumed is not a consumption
  const other = all[1];
  bad('a record with no marker', { ownerGrant: { grantId: grantIdOf(other), quote: other.prompt } });
  // a marker for the same grant but another PR / round / head, or a partial one
  const file = markerPath(grantId, { home });
  const body = JSON.parse(readFileSync(file, 'utf8'));
  for (const patch of [{ pr: 60 }, { k: 5 }, { repo: 'acme/fork' }, { grantId: 'f'.repeat(16) }, { head: 'e'.repeat(40) }]) {
    writeFileSync(file, JSON.stringify({ ...body, ...patch }));
    bad(`marker ${JSON.stringify(patch)}`, {});
  }
  writeFileSync(file, '{"v":1');
  bad('partial marker: unverifiable', {});
  writeFileSync(file, JSON.stringify(body));
  assert.equal(verifyOwnerGrant(q, late).ok, true, 'restored');
  // a big session file does not hide the record from the gate
  writeFileSync(join(ownerGoDir(home), 'sess-z.jsonl'), `${'x'.repeat(1_500_000)}\n`);
  assert.equal(verifyOwnerGrant(q, late).ok, true);
});

test('owner-go hook: records an extra round, prints ONE context line naming the counted round, exits 0', () => {
  const hook = fileURLToPath(new URL('../pipeline/hooks/owner-go.mjs', import.meta.url));
  const dir = tmp();
  const session = `test-hook-${Math.random().toString(36).slice(2)}`;
  const tp = transcript(dir, [user('go'), said(ASK), user('extra round')]);
  try {
    const run = (prompt) => spawnSync(process.execPath, [hook], { encoding: 'utf8', input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: session, transcript_path: tp, cwd: dir, prompt }) });
    const miss = run('hello there');
    assert.deepEqual([miss.status, miss.stdout], [0, ''], 'nothing recorded: nothing printed');
    const r = run('extra round');
    assert.equal(r.status, 0);
    assert.equal(r.stdout, `[claude-pipeline owner-go] the owner's extra round is recorded for ${REPO} #58 counted round 4 head ${GHEAD.slice(0, 12)}: run P codex-review --pr 58 --round <the n from round-request>\n`);
  } finally {
    rmSync(join(ownerGoDir(), `${session}.jsonl`), { force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('owner-go round grant: the helper records through the account home under a random session and cleans up', (t) => {
  const r = ownerGrants(t, 'grant round 4', roundRequest(7, 4, GHEAD, 'Acme/Widgets'));
  assert.deepEqual([r.kind, r.repo, r.pr, r.k], ['extra-round', 'acme/widgets', 7, 4]);
  assert.equal(ownerGrantedRounds({ repo: 'acme/widgets', pr: 7, k: 4, head: GHEAD }).some((x) => x.session === r.session), true);
});
