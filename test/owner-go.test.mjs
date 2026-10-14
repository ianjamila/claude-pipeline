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
