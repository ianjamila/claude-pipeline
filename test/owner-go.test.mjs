// #58: the owner-go recorder (hooks/lib/owner-go.mjs). What counts as the owner's "merge", what it is bound to (only the
// request the reply right before it showed), who can never record one (subagents, other hook events), and how the records
// are stored and read (real folders and files only, a day at most). All in a temp home.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  approvedPr, approvedRequest, lastRequestText, ownerGoDir, ownerItemsDigest, parseApproval, presentedRequests, readApprovals, recordApproval,
  parsePlanApproval, presentedPlanRequest, readPlanApprovals, PLAN_RECORD_MAX_AGE_MS,
} from '../pipeline/hooks/lib/owner-go.mjs';

const HEAD = '0123456789abcdef0123456789abcdef01234567';
const ITEMS = 'abcdef012345';
const REQUEST = `Two items for you.\nHead ${HEAD.slice(0, 12)} · items ${ITEMS}\n🔀 Ready to merge #58 — say "merge"`;

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
  assert.deepEqual(presentedRequests(REQUEST), { prs: [58], requests: [{ pr: 58, head: HEAD.slice(0, 12), items: ITEMS }] });
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
  assert.deepEqual(r.requests, [{ pr: 58, head: HEAD.slice(0, 12), items: ITEMS }]);
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
  const q = { pr: 58, head: HEAD, items: ITEMS, home };
  assert.equal(approvedRequest({ ...q, now: () => at + 60_000 }), true);
  assert.equal(approvedRequest({ ...q, now: () => at + 25 * 3600_000 }), false, 'older than a day');
  assert.equal(approvedRequest({ ...q, now: () => at - 3600_000 }), false, 'from the future');
  assert.equal(approvedRequest({ ...q, head: `${'f'.repeat(12)}${HEAD.slice(12)}`, now: () => at }), false, 'another head');
  assert.equal(approvedRequest({ ...q, head: HEAD.slice(0, 12), now: () => at }), false, 'the full head is required');
  assert.equal(approvedRequest({ ...q, items: 'none', now: () => at }), false, 'another item set');
  assert.equal(approvedRequest({ ...q, pr: 59, now: () => at }), false, 'another PR');
  // the guard's question: this PR at this full head, this session
  const g = { pr: 58, head: HEAD, session: 'sess-1', home, now: () => at };
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
  assert.deepEqual(presentedRequests(two), { prs: [8], requests: [{ pr: 8, head: B, items: 'none' }] }, 'the earlier #7 block is not a request');
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
  assert.deepEqual(recordApproval(fresh, { home, now }).requests, [{ pr: 58, head: HEAD.slice(0, 12), items: ITEMS }]);
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

// T3 (ship redesign): the owner's "approve" for a plan
const BLOB = 'ab'.repeat(20);
const SCOPE = 'cd'.repeat(6);
const PLAN_REQ = `Here is the plan.\nPlan ${BLOB} · scope ${SCOPE}\n📋 Ready to approve plan #58 — say "approve"`;
const MERGE_REQ = `Two items.\nHead ${'e'.repeat(12)} · items none\n🔀 Ready to merge #58 — say "merge"`;
const NOW = Date.parse('2026-10-19T10:00:00Z');

test('parsePlanApproval accepts approve forms and refuses questions and negations', () => {
  assert.deepEqual(parsePlanApproval('approve'), { prs: [], blobs: [] });
  assert.deepEqual(parsePlanApproval('Approved #58.'), { prs: [58], blobs: [] });
  assert.deepEqual(parsePlanApproval(`approve ${BLOB.slice(0, 7)}`), { prs: [], blobs: [BLOB.slice(0, 7)] });
  for (const p of ['approve?', "don't approve", 'approve later', 'why approve', 'merge']) assert.equal(parsePlanApproval(p), null, p);
});

test('presentedPlanRequest binds only the terminal two-line block', () => {
  assert.deepEqual(presentedPlanRequest(PLAN_REQ), { pr: 58, blob: BLOB, scopeDigest: SCOPE });
  assert.equal(presentedPlanRequest(`${PLAN_REQ}\nmore text`), null);
  assert.equal(presentedPlanRequest(PLAN_REQ.replace(BLOB, BLOB.slice(0, 12))), null, 'a 12-hex blob is refused');
  assert.equal(presentedPlanRequest(PLAN_REQ.replace('\n📋', '\nprose\n📋')), null);
  // Spec §2a ambiguity: exactly ONE Plan line and ONE 📋 line in the whole reply, and no 🔀 merge line.
  const other = `Plan ${'ef'.repeat(20)} · scope ${SCOPE}`;
  assert.equal(presentedPlanRequest(PLAN_REQ.replace('Here is the plan.\n', `Here is the plan.\n${other}\n`)), null, 'consecutive duplicate Plan lines');
  assert.equal(presentedPlanRequest(`Plan ${BLOB} · scope ${SCOPE}\nsome prose\n${PLAN_REQ}`), null, 'a second Plan line anywhere');
  assert.ok(presentedPlanRequest(`Old: Plan ${BLOB} · scope ${SCOPE}\n${PLAN_REQ}`), 'a quoted line that is not a whole Plan line is prose');
  assert.equal(presentedPlanRequest(`🔀 Ready to merge #58 — say "merge"\n${PLAN_REQ}`), null, 'mixed merge + plan request');
});

test('the recorder reads a reply that ends with ONLY the plan request (no merge marker), and still refuses a stale one', () => {
  const home = tmp();
  // said() replies have no 🔀 line: lastRequestText must accept the 📋 marker on the plan path.
  assert.equal(recordApproval(input(home, 'approve', [said(PLAN_REQ)]), { home, now: () => NOW })?.kind, 'plan');
  // A later assistant turn with text but no request makes the old request stale (same slot rule as merge).
  const home2 = tmp();
  assert.equal(recordApproval(input(home2, 'approve', [said(PLAN_REQ), said('Working on it.')]), { home: home2, now: () => NOW }), null);
});

test('"approve" after a plan request writes a plan record; merge readers never see it', () => {
  const home = tmp();
  const rec = recordApproval(input(home, 'approve', [said(PLAN_REQ)]), { home, now: () => NOW });
  assert.equal(rec.kind, 'plan');
  assert.match(rec.record_id, /^[0-9a-f]{16}$/);
  assert.deepEqual(rec.plan, { pr: 58, blob: BLOB, scopeDigest: SCOPE });
  assert.equal(readApprovals({ home, now: () => NOW }).length, 0);
  assert.equal(readPlanApprovals({ home, now: () => NOW })[0].blob, BLOB);
});

test('cross-kind: "approve" after a merge request and "merge" after a plan request record nothing of the other kind', () => {
  const home = tmp();
  assert.equal(recordApproval(input(home, 'approve', [said(MERGE_REQ)]), { home, now: () => NOW }), null);
  recordApproval(input(home, 'merge', [said(PLAN_REQ)]), { home, now: () => NOW });
  assert.equal(readPlanApprovals({ home, now: () => NOW }).length, 0);
  assert.equal(approvedRequest({ pr: 58, head: 'e'.repeat(40), items: 'none', home, now: () => NOW }), false);
});

test('approve narrowed by #N or blob prefix; a mismatch records nothing', () => {
  const home = tmp();
  assert.equal(recordApproval(input(home, 'approve #59', [said(PLAN_REQ)]), { home, now: () => NOW }), null);
  assert.equal(recordApproval(input(home, `approve ${'f'.repeat(7)}`, [said(PLAN_REQ)]), { home, now: () => NOW }), null);
  assert.ok(recordApproval(input(home, `approve #58 ${BLOB.slice(0, 8)}`, [said(PLAN_REQ)]), { home, now: () => NOW }));
});

test('the request-line regexes match pipeline/lib/plan.mjs exactly', async () => {
  const plan = await import('../pipeline/lib/plan.mjs');
  const og = await import('../pipeline/hooks/lib/owner-go.mjs');
  assert.equal(og.PLAN_LINE_RE.source, plan.PLAN_LINE_RE.source);
  assert.equal(og.PLAN_READY_RE.source, plan.PLAN_READY_RE.source);
});

test('plan records are read for 30 days, never from the future, and subagent prompts never record', () => {
  const home = tmp();
  recordApproval(input(home, 'approve', [said(PLAN_REQ)]), { home, now: () => NOW });
  assert.equal(readPlanApprovals({ home, now: () => NOW + PLAN_RECORD_MAX_AGE_MS - 1000 }).length, 1);
  assert.equal(readPlanApprovals({ home, now: () => NOW + PLAN_RECORD_MAX_AGE_MS + 1000 }).length, 0);
  assert.equal(readPlanApprovals({ home, now: () => NOW - 10 * 60_000 }).length, 0);
  assert.equal(recordApproval(input(home, 'approve', [said(PLAN_REQ)], { agent_id: 'x' }), { home, now: () => NOW }), null);
});
// The 24 h issuance window and the UTC / future-skew boundaries are checked by `P plan approve` (T4 tests):
// a record exactly 24 h old is accepted, 24 h + 1 s refused; a record dated in the future beyond the existing skew
// allowance (owner-go.mjs ~245) is refused; timestamps are compared as UTC epoch ms.
