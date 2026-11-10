// #189 (plan docs/plans/2026-11-06-followups-185-188-ruling-compaction.md, item 3 and the Fable plan pass findings 1-3): the owner-go readers across a
// context compaction, and a ruling ask the agent made inside a hand-back turn. Entry shapes are the real ones (session transcript 4369b774, Claude Code
// 2.1.314). The agent is the untrusted party: every negative case here is something the agent could print to forge or revive an owner ruling.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  lastReplyText, ownerGrantedRounds, ownerRuled, ownerRulingGap, approvedRequest, promptProvenance, recordApproval, recordRoundGrant, recordRuling, notOwnerWords,
} from '../pipeline/hooks/lib/owner-go.mjs';
import { OWNER_ENTRY, roundRequest } from './helpers/owner-go.mjs';

const AT = Date.parse('2026-11-03T10:00:00Z');
const now = () => AT;
const HEAD = '0123456789abcdef0123456789abcdef01234567';
const ITEMS = 'abcdef012345';
const REPO = 'acme/app';
const REQUEST = `Two items for you.\nHead ${HEAD.slice(0, 12)} · items ${ITEMS} · repo ${REPO}\n🔀 Ready to merge #58 — say "merge"`;
const GHEAD = 'abcdef0123456789abcdef0123456789abcdef01';
const RASK = roundRequest(58, 4, GHEAD, REPO);
const ASK = '⚖️ Owner ruling needed #58: R1-F1 · content abcdef012345 · repo acme/app';
const ASK_REPLY = `R1-F1 waits for you.\n${ASK}`;
const ASK59 = '⚖️ Owner ruling needed #59: R1-F1 · content bbbbbbbbbbbb · repo acme/app';
const NOTICE = '<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n</task-notification>';
const HANDBACK = 'Another Claude session sent a message:\n<agent-message from="worker">\nDone.\n</agent-message>';
const SUMMARY_TEXT = 'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion.';

const tmp = () => mkdtempSync(join(tmpdir(), 'owner-go-compact-'));
const lines = (entries) => `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`;
function transcript(dir, entries) {
  mkdirSync(join(dir, '.claude', 'projects', '-repo'), { recursive: true });
  const file = join(dir, '.claude', 'projects', '-repo', `t-${Math.random().toString(36).slice(2)}.jsonl`);
  writeFileSync(file, lines(entries));
  return file;
}
let pid = 0;
const NOTICE_META = { origin: { kind: 'task-notification', producer: 'session-task' }, promptSource: 'system', turnOrigin: 'task_notification', entrypoint: 'cli' };
const PEER_META = { origin: { kind: 'peer' }, promptSource: 'system', isMeta: true, entrypoint: 'cli' };
const SDK_META = { promptSource: 'sdk', turnOrigin: 'sdk', entrypoint: 'sdk-cli' };
const SYSTEM_SDK_CLI = { promptSource: 'system', entrypoint: 'sdk-cli' };
const SYSTEM_NO_ENTRYPOINT = { promptSource: 'system', origin: { kind: 'peer' } };
const QUEUED_META = { origin: { kind: 'human' }, promptSource: 'queued', entrypoint: 'cli' };
const promptEntry = (text, meta = OWNER_ENTRY, promptId = `pid-${++pid}`) => ({ type: 'user', message: { content: text }, promptId, ...meta });
const said = (text) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
const use = (command) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'x', name: 'Bash', input: { command } }] } });
const result = (c) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: c }] } });
const toolsOnly = use('ls');

// What Claude Code writes around a compaction (transcript 4369b774): hook and turn bookkeeping, the boundary, the summary the owner never sees as a prompt,
// then attachments re-injected into the new context and bookkeeping lines.
const sys = (subtype) => ({ type: 'system', subtype, uuid: `u-${subtype}` });
const summary = (text = SUMMARY_TEXT, extra = {}) => ({
  type: 'user', message: { role: 'user', content: text }, isCompactSummary: true, isVisibleInTranscriptOnly: true, entrypoint: 'cli', uuid: 'u-summary', parentUuid: 'u-boundary', timestamp: '2026-11-03T09:59:00Z', ...extra,
});
const COMPACTION = (s = summary()) => [
  sys('stop_hook_summary'), sys('turn_duration'), sys('away_summary'), sys('informational'),
  { type: 'system', subtype: 'compact_boundary', uuid: 'u-boundary' },
  s,
  { type: 'attachment', attachment: { type: 'file', filename: 'CLAUDE.md' } }, { type: 'attachment', attachment: { type: 'plan_mode' } },
  { type: 'last-prompt', lastPrompt: 'x' }, { type: 'ai-title', aiTitle: 'x' }, { type: 'mode', mode: 'default' },
];

// The hook input for `prompt` over `entries`; present: the transcript already holds the prompt's own entry (the hook can run before or after).
function hookInput(home, prompt, entries, { present = true, meta = OWNER_ENTRY, id = `pid-h-${++pid}`, extra = {} } = {}) {
  const e = promptEntry(prompt, meta, id);
  return { hook_event_name: 'UserPromptSubmit', session_id: 'sess-1', cwd: home, prompt, prompt_id: id, transcript_path: transcript(home, present ? [...entries, e] : entries), ...extra };
}
// (recordApproval writes a record with no requests for a 'merge' that follows no request; "nothing approved" is requests: [] and prs: [])
const approvedNothing = (r) => r === null || (r.requests.length === 0 && r.prs.length === 0);
const rule = (home, entries, answer = 'R1-F1: accept', opts) => recordRuling(hookInput(home, answer, entries, opts), { home, now });

test('#189 compaction: a ruling ask, then compaction, then the owner\'s answer, is recorded (the summary opens no reply slot)', () => {
  for (const present of [true, false]) {
    const home = tmp();
    const r = rule(home, [promptEntry('go'), said(ASK_REPLY), ...COMPACTION()], 'R1-F1: accept', { present });
    assert.deepEqual([r?.pr, r?.ids, r?.content, r?.repo], [58, ['R1-F1'], 'abcdef012345', 'acme/app'], `present ${present}`);
    assert.equal(r.ask_turn, undefined, 'an owner-turn ask carries no ask_turn');
  }
});

test('#189 compaction: a 🔀 merge request and an extra-round request survive compaction too', () => {
  for (const present of [true, false]) {
    const home = tmp();
    const m = recordApproval(hookInput(home, 'merge', [promptEntry('go'), said(REQUEST), ...COMPACTION()], { present }), { home, now });
    assert.deepEqual(m?.requests.map((q) => [q.pr, q.head, q.items]), [[58, HEAD.slice(0, 12), ITEMS]], `merge, present ${present}`);
    const g = recordRoundGrant(hookInput(home, 'extra round', [promptEntry('go'), said(RASK), ...COMPACTION()], { present }), { home, now });
    assert.deepEqual([g?.pr, g?.k, g?.head], [58, 4, GHEAD.slice(0, 12)], `grant, present ${present}`);
  }
});

test('#189 compaction: the record is honoured at use time (the owner\'s prompt is found past the compaction)', () => {
  const home = tmp();
  const r = rule(home, [promptEntry('go'), said(ASK_REPLY), ...COMPACTION()], 'R1-F1: accept', { id: 'pid-use' });
  assert.ok(r);
  const q = { repo: 'acme/app', pr: 58, id: 'R1-F1', quote: 'R1-F1: accept', decision: 'ACCEPT', contentOf: () => 'abcdef012345', home, now };
  assert.equal(ownerRuled(q), true);
  assert.equal(ownerRulingGap(q), 'changed', 'applies (the gap only matters when it does not)');
  assert.equal(notOwnerWords({ prompt: 'R1-F1: accept' }, r.transcript_path), false, 'and the owner\'s prompt is no synthetic entry');
});

test('#189 compaction (finding 3): a summary is skipped only when BOTH flags say the owner never saw it; a visible or half-flagged one stays a boundary', () => {
  for (const [name, s] of [
    ['no isVisibleInTranscriptOnly', summary(SUMMARY_TEXT, { isVisibleInTranscriptOnly: undefined })],
    ['isVisibleInTranscriptOnly false', summary(SUMMARY_TEXT, { isVisibleInTranscriptOnly: false })],
    ['no isCompactSummary', summary(SUMMARY_TEXT, { isCompactSummary: undefined })],
    ['isCompactSummary "true" (a string)', summary(SUMMARY_TEXT, { isCompactSummary: 'true' })],
  ]) {
    for (const present of [true, false]) {
      assert.equal(rule(tmp(), [promptEntry('go'), said(ASK_REPLY), ...COMPACTION(s)], 'R1-F1: accept', { present }), null, `${name} (present ${present})`);
    }
    assert.ok(approvedNothing(recordApproval(hookInput(tmp(), 'merge', [promptEntry('go'), said(REQUEST), ...COMPACTION(s)]), { home: tmp(), now })), `${name}: a merge request`);
  }
});

test('#189 compaction: the summary\'s text is never part of a reply, and compaction revives nothing', () => {
  const quoted = `${SUMMARY_TEXT}\nEarlier I asked:\n${ASK}`;
  for (const present of [true, false]) {
    // a summary quoting a ruling line after an answered ask: nothing recorded for the next answer
    const answered = [promptEntry('go'), said(ASK_REPLY), promptEntry('R1-F1: accept'), said('Recorded.')];
    assert.equal(rule(tmp(), [...answered, ...COMPACTION(summary(quoted))], 'R1-F1: reject', { present }), null, `a quoted ask in the summary (present ${present})`);
    // an answered ask, compaction, a second typed answer: the first answer is the boundary
    const answeredNoReply = [promptEntry('go'), said(ASK_REPLY), promptEntry('R1-F1: accept')];
    assert.equal(rule(tmp(), [...answeredNoReply, ...COMPACTION()], 'R1-F1: reject', { present }), null, `a second answer after compaction (present ${present})`);
    // the same for a merge request quoted in a summary
    assert.ok(approvedNothing(recordApproval(hookInput(tmp(), 'merge', [promptEntry('go'), said(REQUEST), promptEntry('merge'), said('Merging.'), ...COMPACTION(summary(`${SUMMARY_TEXT}\n${REQUEST}`))], { present }), { home: tmp(), now })), `a quoted 🔀 line (present ${present})`);
  }
  // and the summary adds no text when it is the only thing between the ask and the answer: the string API is unchanged
  const file = transcript(tmp(), [promptEntry('go'), said(ASK_REPLY), ...COMPACTION(summary(quoted)), promptEntry('R1-F1: accept')]);
  assert.equal(lastReplyText(file, { prompt: 'R1-F1: accept' }), `${ASK_REPLY}\n`);
});

test('#189 compaction: agent text after the summary (auto-compact mid-turn) decides: the last line wins', () => {
  for (const present of [true, false]) {
    const talks = rule(tmp(), [promptEntry('go'), said(ASK_REPLY), ...COMPACTION(), said('Anything else I should know?')], 'R1-F1: accept', { present });
    assert.equal(talks, null, `text after the ask voids it (present ${present})`);
    const asksAgain = rule(tmp(), [promptEntry('go'), said('Working.'), ...COMPACTION(), said(ASK_REPLY)], 'R1-F1: accept', { present });
    assert.deepEqual([asksAgain?.pr, asksAgain?.ids], [58, ['R1-F1']], `an ask after the summary binds (present ${present})`);
    const moved = rule(tmp(), [promptEntry('go'), said(ASK_REPLY), ...COMPACTION(), said(`Moving on.\n${ASK59}`)], 'R1-F1: accept', { present });
    assert.deepEqual([moved?.pr, moved?.content], [59, 'bbbbbbbbbbbb'], `a newer ask after the summary is the one (present ${present})`);
  }
});

test('#189 hand-back turn: an ask written inside a subagent hand-back (system + cli) turn that ENDS with the line is recorded for exactly that PR, ids and digest', () => {
  for (const present of [true, false]) {
    const home = tmp();
    const entries = [promptEntry('go'), said('Spawned a reviewer.'), promptEntry(HANDBACK, PEER_META), said(`Reviewer is done.\n${ASK_REPLY}`)];
    const r = rule(home, entries, 'R1-F1: follow-up', { present });
    assert.deepEqual([r?.kind, r?.repo, r?.pr, r?.ids, r?.content, r?.ask_turn], ['ruling', 'acme/app', 58, ['R1-F1'], 'abcdef012345', 'synthetic'], `present ${present}`);
    // a task notice (also system + cli) is the same
    const n = rule(tmp(), [promptEntry('go'), promptEntry(NOTICE, NOTICE_META), said(ASK_REPLY)], 'R1-F1: follow-up', { present });
    assert.deepEqual([n?.pr, n?.ids, n?.ask_turn], [58, ['R1-F1'], 'synthetic'], `a task notice (present ${present})`);
  }
  // the promoted ask binds only its own ids: an answer for an id it did not ask about, or a different shape, records the prompt but ownerRuled needs the id
  const home = tmp();
  const r = rule(home, [promptEntry('go'), promptEntry(HANDBACK, PEER_META), said(`Done.\n⚖️ Owner ruling needed #61: R2-S3, R2-S4 · content cccccccccccc · repo acme/app`)], 'R2-S3: accept, R2-S4: reject', { id: 'pid-hb' });
  assert.deepEqual([r?.pr, r?.ids, r?.content], [61, ['R2-S3', 'R2-S4'], 'cccccccccccc']);
  assert.equal(ownerRuled({ repo: 'acme/app', pr: 58, id: 'R2-S3', quote: 'R2-S3: accept, R2-S4: reject', decision: 'ACCEPT', contentOf: () => 'cccccccccccc', home, now }), false, 'not for another PR');
  assert.equal(ownerRuled({ repo: 'acme/app', pr: 61, id: 'R2-S3', quote: 'R2-S3: accept, R2-S4: reject', decision: 'ACCEPT', contentOf: () => 'dddddddddddd', home, now }), false, 'not for another digest');
  assert.equal(ownerRuled({ repo: 'acme/app', pr: 61, id: 'R2-S3', quote: 'R2-S3: accept, R2-S4: reject', decision: 'ACCEPT', contentOf: () => 'cccccccccccc', home, now }), true, 'for exactly this PR, id and digest');
});

test('#189 hand-back turn: an ask inside a synthetic turn that does NOT end with the line (text after it, a 🔀 line, another PR) still voids the slot', () => {
  for (const present of [true, false]) {
    for (const [name, text] of [
      ['text after the line', `${ASK_REPLY}\nBy the way.`],
      ['a non-canonical ask', 'For #58 what is your call on R1-F1?'],
      ['a 🔀 request', REQUEST],
      ['plain text', 'Reviewer is done.'],
    ]) {
      assert.equal(rule(tmp(), [promptEntry('go'), said(ASK_REPLY), promptEntry(HANDBACK, PEER_META), said(text)], 'R1-F1: accept', { present }), null, `${name} (present ${present})`);
    }
    // an ask in the owner turn stays standing over a tool-only hand-back turn (existing rule)
    const stands = rule(tmp(), [promptEntry('go'), said(ASK_REPLY), promptEntry(HANDBACK, PEER_META), toolsOnly, result('a.txt')], 'R1-F1: accept', { present });
    assert.deepEqual([stands?.pr, stands?.ask_turn], [58, undefined], `tool-only turn (present ${present})`);
  }
});

test('#189 hand-back turn (Codex): a ruling-request call, its result, then the canonical line is promoted; the line followed by another ask in a tool output is voided', () => {
  for (const present of [true, false]) {
    const ok = rule(tmp(), [promptEntry('go'), promptEntry(HANDBACK, PEER_META), use('P triage ruling-request --pr 58'), result(ASK), said(ASK_REPLY)], 'R1-F1: accept', { present });
    assert.deepEqual([ok?.pr, ok?.ids, ok?.content, ok?.ask_turn], [58, ['R1-F1'], 'abcdef012345', 'synthetic'], `call, result, line (present ${present})`);
    const other = rule(tmp(), [promptEntry('go'), promptEntry(HANDBACK, PEER_META), said(ASK_REPLY), use('cat out.txt'), result(ASK59)], 'R1-F1: accept', { present });
    assert.equal(other, null, `line, then a tool output asking about another PR (present ${present})`);
    const call = rule(tmp(), [promptEntry('go'), promptEntry(HANDBACK, PEER_META), said(ASK_REPLY), use('P triage ruling-request --pr 59')], 'R1-F1: accept', { present });
    assert.equal(call, null, `line, then a ruling-request call (present ${present})`);
    const quiet = rule(tmp(), [promptEntry('go'), promptEntry(HANDBACK, PEER_META), said(ASK_REPLY), use('ls'), result('a.txt')], 'R1-F1: accept', { present });
    assert.deepEqual([quiet?.pr, quiet?.ask_turn], [58, 'synthetic'], `line, then an unrelated tool use (present ${present})`);
  }
});

test('#189 hand-back turn: consecutive synthetic turns each flush on their own (text voids a promoted slot, a tool-only turn leaves it)', () => {
  for (const present of [true, false]) {
    const base = [promptEntry('go'), promptEntry(HANDBACK, PEER_META), said(ASK_REPLY), promptEntry(NOTICE, NOTICE_META)];
    assert.equal(rule(tmp(), [...base, said('The build finished.')], 'R1-F1: accept', { present }), null, `promoted, then text (present ${present})`);
    const stands = rule(tmp(), [...base, toolsOnly, result('a.txt')], 'R1-F1: accept', { present });
    assert.deepEqual([stands?.pr, stands?.ask_turn], [58, 'synthetic'], `promoted, then tool-only (present ${present})`);
    // a later synthetic turn that ends with its own line replaces the earlier promoted ask
    const newer = rule(tmp(), [...base, said(`Also.\n${ASK59}`)], 'R1-F1: accept', { present });
    assert.deepEqual([newer?.pr, newer?.content], [59, 'bbbbbbbbbbbb'], `promoted, then a newer promoted ask (present ${present})`);
    // an owner prompt after a promoted ask is a boundary as ever
    assert.equal(rule(tmp(), [promptEntry('go'), promptEntry(HANDBACK, PEER_META), said(ASK_REPLY), promptEntry('wait, what is R1-F1?'), said('A finding.')], 'R1-F1: accept', { present }), null, `an owner question in between (present ${present})`);
  }
});

test('#189 hand-back turn (finding 1): only system + cli is promoted; an sdk / sdk-cli / other-origin / unknown turn ending with the line is voided as before', () => {
  for (const present of [true, false]) {
    for (const [name, meta] of [
      ['sdk-cli (a headless `claude -p --resume` of this session)', SDK_META],
      ['system but sdk-cli', SYSTEM_SDK_CLI],
      ['system with no entrypoint', SYSTEM_NO_ENTRYPOINT],
      ['sdk promptSource on cli', { promptSource: 'sdk', entrypoint: 'cli' }],
      ['a non-human origin without promptSource', { origin: { kind: 'peer' }, entrypoint: 'cli' }],
    ]) {
      const entries = [promptEntry('go'), said('Working.'), promptEntry('headless text', meta), said(ASK_REPLY)];
      assert.equal(rule(tmp(), entries, 'R1-F1: accept', { present }), null, `${name} (present ${present})`);
    }
  }
});

test('#189 promotion is for the ruling reader only: a merge or round-grant read (no skipSynthetic) keeps a hand-back turn as a reply slot of its own, as before', () => {
  const file = transcript(tmp(), [promptEntry('go'), said(ASK_REPLY), promptEntry(HANDBACK, PEER_META), said('Reviewer is done.')]);
  assert.equal(lastReplyText(file), 'Reviewer is done.\n', 'the hand-back reply is its own slot');
  assert.equal(lastReplyText(transcript(tmp(), [promptEntry('go'), promptEntry(HANDBACK, PEER_META), said(ASK_REPLY), promptEntry('x')]), { prompt: 'x' }), `${ASK_REPLY}\n`, 'unchanged: the string API');
  // with skipSynthetic the same hand-back turn is a promoted slot, and the SAME text reads out
  assert.equal(lastReplyText(transcript(tmp(), [promptEntry('go'), promptEntry(HANDBACK, PEER_META), said(ASK_REPLY), promptEntry('x')]), { prompt: 'x', skipSynthetic: true }), `${ASK_REPLY}\n`);
});

test('#189 queued answers (finding 2): a queued answer is refused for a promoted ask and (#191 B) for an owner-turn ask, at record time and at use time', () => {
  const promoted = [promptEntry('go'), promptEntry(HANDBACK, PEER_META), said(ASK_REPLY)];
  // record time: the queued answer is already in the transcript
  assert.equal(rule(tmp(), promoted, 'R1-F1: accept', { meta: QUEUED_META }), null, 'recorder refuses a queued answer to a promoted ask');
  // a typed answer to the same ask is fine
  assert.ok(rule(tmp(), promoted, 'R1-F1: accept', { meta: OWNER_ENTRY }), 'typed answer');
  // use time: the hook ran before the transcript had the entry (it cannot tell), and the entry later turned out to be queued
  const home = tmp();
  const file = transcript(home, promoted);
  const answer = 'R1-F1: accept';
  const r = recordRuling({ hook_event_name: 'UserPromptSubmit', session_id: 'sess-1', cwd: home, prompt: answer, prompt_id: 'pid-q', transcript_path: file }, { home, now });
  assert.equal(r?.ask_turn, 'synthetic');
  const q = { repo: 'acme/app', pr: 58, id: 'R1-F1', quote: answer, decision: 'ACCEPT', contentOf: () => 'abcdef012345', home, now };
  writeFileSync(file, lines([...promoted, promptEntry(answer, QUEUED_META, 'pid-q')]));
  assert.equal(promptProvenance(r, { home }), 'synthetic', 'the record\'s prompt entry is queued: treated as synthetic');
  assert.deepEqual([ownerRuled(q), ownerRulingGap(q)], [false, 'provenance'], 'a queued answer to a promoted ask never applies');
  writeFileSync(file, lines([...promoted, promptEntry(answer, OWNER_ENTRY, 'pid-q')]));
  assert.equal(promptProvenance(r, { home }), 'owner');
  assert.equal(ownerRuled(q), true, 'the same words typed after the ask apply');
  // an owner-turn ask: a typed answer is accepted; #191 B: a queued one is refused too (every kind of ask), at record time and at use time
  const home2 = tmp();
  const ownerAsk = [promptEntry('go'), said(ASK_REPLY)];
  const f2 = transcript(home2, ownerAsk);
  const r2 = recordRuling({ hook_event_name: 'UserPromptSubmit', session_id: 'sess-1', cwd: home2, prompt: answer, prompt_id: 'pid-q2', transcript_path: f2 }, { home: home2, now });
  assert.equal(r2.ask_turn, undefined);
  writeFileSync(f2, lines([...ownerAsk, promptEntry(answer, OWNER_ENTRY, 'pid-q2')]));
  assert.equal(ownerRuled({ ...q, home: home2 }), true, 'owner-turn ask, typed answer');
  assert.ok(rule(tmp(), ownerAsk, answer, { meta: OWNER_ENTRY }), 'and the recorder takes it');
  writeFileSync(f2, lines([...ownerAsk, promptEntry(answer, QUEUED_META, 'pid-q2')]));
  assert.deepEqual([ownerRuled({ ...q, home: home2 }), ownerRulingGap({ ...q, home: home2 })], [false, 'provenance'], 'owner-turn ask, queued answer: refused at use time');
  assert.equal(rule(tmp(), ownerAsk, answer, { meta: QUEUED_META }), null, 'and the recorder refuses it');
});

test('#189 queued answers: a promoted ask whose answer is the owner\'s typed prompt, with a queued one only EARLIER, is not refused', () => {
  const home = tmp();
  // a queued prompt delivered earlier in the session (before the ask) is no part of this answer
  const entries = [promptEntry('go'), promptEntry('also check X', QUEUED_META), said('Checked.'), promptEntry(HANDBACK, PEER_META), said(ASK_REPLY)];
  const r = rule(home, entries, 'R1-F1: accept', { id: 'pid-t' });
  assert.deepEqual([r?.pr, r?.ask_turn], [58, 'synthetic']);
  assert.equal(ownerRuled({ repo: 'acme/app', pr: 58, id: 'R1-F1', quote: 'R1-F1: accept', decision: 'ACCEPT', contentOf: () => 'abcdef012345', home, now }), true);
});

test('#189 extra-round grants and approvals still read an owner-turn ask across compaction at use time', () => {
  const home = tmp();
  const g = recordRoundGrant(hookInput(home, 'extra round', [promptEntry('go'), said(RASK), ...COMPACTION()], { id: 'pid-g' }), { home, now });
  assert.ok(g);
  assert.equal(ownerGrantedRounds({ repo: REPO, pr: 58, k: 4, head: GHEAD, home, now }).length, 1);
  const m = recordApproval(hookInput(home, 'merge', [promptEntry('go'), said(REQUEST), ...COMPACTION()], { id: 'pid-m' }), { home, now });
  assert.ok(m);
  assert.equal(approvedRequest({ repo: REPO, pr: 58, head: HEAD, items: ITEMS, home, now }), true);
});
