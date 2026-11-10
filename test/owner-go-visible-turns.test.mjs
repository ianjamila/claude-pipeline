// #191 Part A: one visibility rule for every reader of the reply slot (hooks/lib/owner-go.mjs lastReply). A turn the interactive UI does
// not render (a headless `claude -p --resume` turn, any non-human origin that is not a harness notice) writes into the owner's transcript;
// its text must never be the "reply before the owner's prompt" a "merge" / "extra round" binds to (A2), a window that starts inside a turn
// has no known origin (A3, cut-off origin), and a synthetic prompt carrying the owner's words is never the owner's answer (A4).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  lastReply, recordApproval, recordRoundGrant, recordRuling, entrySource, queuedNudge, QUEUED_NUDGE, RULING_NUDGE, approvalGap, ownerGrantGap, ownerRuled, ownerRulingGap, promptProvenance,
} from '../pipeline/hooks/lib/owner-go.mjs';
import { OWNER_ENTRY, mergeRequest, roundRequest, rulingRequest, runHook } from './helpers/owner-go.mjs';

const HEAD = '0123456789abcdef0123456789abcdef01234567';
const ITEMS = 'abcdef012345';
let pid = 0;
const prompt = (text, meta = OWNER_ENTRY) => ({ type: 'user', message: { content: text }, promptId: `pid-${++pid}`, ...meta });
const said = (text) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
const toolOnly = () => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } });
const toolResult = () => ({ type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } });

const SDK = { promptSource: 'sdk', turnOrigin: 'sdk', entrypoint: 'sdk-cli' };
const NON_HUMAN = { origin: { kind: 'channel' }, entrypoint: 'cli' }; // a non-human origin that is not a harness notice
const SDK_CLI_ONLY = { entrypoint: 'sdk-cli' };
const NOTICE = { origin: { kind: 'task-notification', producer: 'session-task' }, promptSource: 'system', turnOrigin: 'task_notification', entrypoint: 'cli' };
const PEER = { origin: { kind: 'peer' }, promptSource: 'system', isMeta: true, entrypoint: 'cli' };
const PLUGIN = { origin: { kind: 'plugin' }, promptSource: 'system', isMeta: true, entrypoint: 'cli' };
const FUTURE = { promptSource: 'brand-new-source', entrypoint: 'cli' }; // a value Claude Code may add later: entrySource 'unknown', but it carries provenance
const QUEUED = { origin: { kind: 'human' }, promptSource: 'queued', entrypoint: 'cli' };

const MERGE_ASK = mergeRequest(58, HEAD, ITEMS);
const ROUND_ASK = roundRequest(58, 2, HEAD);
const RULING_ASK = rulingRequest(58, ['R1-B1']);
// The three recorders: what the owner types, the reply that asks for it, and whether the recorder wrote anything BOUND to that ask.
const KINDS = {
  merge: { ask: MERGE_ASK, answer: 'merge', bound: (r) => r !== null && r.requests.length > 0, rec: recordApproval },
  round: { ask: ROUND_ASK, answer: 'extra round', bound: (r) => r !== null, rec: recordRoundGrant },
  ruling: { ask: RULING_ASK, answer: 'R1-B1: accept', bound: (r) => r !== null, rec: recordRuling },
};
const STRICT = ['merge', 'round']; // the kinds read without skipSynthetic

const tmp = () => mkdtempSync(join(tmpdir(), 'owner-go-visible-'));
function run(kind, entries, answer = KINDS[kind].answer) {
  const home = tmp();
  mkdirSync(join(home, 'p'), { recursive: true });
  const file = join(home, 'p', 't.jsonl');
  writeFileSync(file, `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`);
  const r = KINDS[kind].rec({ hook_event_name: 'UserPromptSubmit', session_id: 'sess-1', cwd: home, prompt: answer, transcript_path: file }, { home });
  return KINDS[kind].bound(r);
}
const withOwner = (kind, entries) => [...entries, prompt(KINDS[kind].answer)];
const filler = (mb) => `${JSON.stringify(said('x'.repeat(1024 * 1024 - 100)))}\n`.repeat(mb);
function runFile(kind, lines, tailEntries = []) {
  const home = tmp();
  mkdirSync(join(home, 'p'), { recursive: true });
  const file = join(home, 'p', 't.jsonl');
  writeFileSync(file, lines + `${[...tailEntries, prompt(KINDS[kind].answer)].map((e) => JSON.stringify(e)).join('\n')}\n`);
  const r = KINDS[kind].rec({ hook_event_name: 'UserPromptSubmit', session_id: 'sess-1', cwd: home, prompt: KINDS[kind].answer, transcript_path: file }, { home });
  return KINDS[kind].bound(r);
}

// ---- A2: an invisible turn's text is never bound ----------------------------------------------------------------------------------

test('#191 A2: a merge or round request printed by an invisible turn binds nothing (sdk, non-human origin, entrypoint sdk-cli alone)', () => {
  for (const kind of STRICT) {
    for (const [name, meta] of [['sdk', SDK], ['non-human origin', NON_HUMAN], ['entrypoint sdk-cli alone', SDK_CLI_ONLY]]) {
      const entries = withOwner(kind, [prompt('ship it'), said('working on it'), prompt('poll', meta), said(KINDS[kind].ask)]);
      assert.equal(run(kind, entries), false, `${kind}: ${name}`);
    }
  }
});

test('#191 A2: an invisible turn stays a boundary, so an older owner-turn request is not revived by it', () => {
  for (const kind of STRICT) {
    // the ask was shown in the owner's own turn; a hidden sdk turn then ran (tool calls only): the owner's "merge" does not reach back over it (strict, as today)
    const entries = withOwner(kind, [prompt('ship it'), said(KINDS[kind].ask), prompt('poll', SDK), toolOnly(), toolResult()]);
    assert.equal(run(kind, entries), false, `${kind}: tool-only invisible turn`);
  }
});

test('#191 A2: a visible synthetic turn (system + cli) still records, for a task notice, a peer message and a plugin message', () => {
  // (F2) the interactive UI renders the assistant text of every such turn (isMeta hides the PROMPT, never the reply), so the owner saw the ask
  for (const kind of STRICT) {
    for (const [name, meta] of [['task notice', NOTICE], ['peer message', PEER], ['plugin message', PLUGIN]]) {
      const entries = withOwner(kind, [prompt('ship it'), said('working on it'), prompt('notice', meta), said(KINDS[kind].ask)]);
      assert.equal(run(kind, entries), true, `${kind}: ${name}`);
    }
  }
});

test('#191 A2: an owner-turn request still records (control)', () => {
  for (const kind of Object.keys(KINDS)) assert.equal(run(kind, withOwner(kind, [prompt('ship it'), said(KINDS[kind].ask)])), true, kind);
});

test('#191 A2: the invisible turn\'s text never reaches lastReply, whatever the mode', () => {
  const file = join(tmp(), 't.jsonl');
  writeFileSync(file, [prompt('go'), said('mine'), prompt('poll', SDK), said('hidden'), prompt('done')].map((e) => JSON.stringify(e)).join('\n') + '\n');
  assert.equal(lastReply(file, { prompt: 'done' }).text, '');
  assert.equal(lastReply(file, { prompt: 'done', skipSynthetic: true }).text, '');
});

// ---- F1: a provenance-bearing entry that is not the owner's and not visible is invisible ------------------------------------------

test('#191 F1: a future promptSource value (provenance field, source unknown) is invisible; a field-less unknown prompt stays a boundary', () => {
  assert.equal(entrySource(prompt('x', FUTURE)), 'unknown');
  for (const kind of STRICT) {
    assert.equal(run(kind, withOwner(kind, [prompt('ship it'), prompt('poll', FUTURE), said(KINDS[kind].ask)])), false, `${kind}: future source`);
    // a field-less user entry (an interrupt marker, a legacy transcript) is a plain boundary: the text after it is the reply, as today
    const bare = { type: 'user', message: { content: '[Request interrupted by user]' } };
    assert.equal(run(kind, withOwner(kind, [prompt('ship it'), bare, said(KINDS[kind].ask)])), true, `${kind}: field-less unknown`);
  }
});

// ---- A3: cut-off origin -----------------------------------------------------------------------------------------------------------

test('#191 A3: a window that starts inside a turn (its prompt cut off) never yields that turn as a reply, for all three recorders', () => {
  for (const kind of Object.keys(KINDS)) {
    // the sdk prompt and 5 MB of its output precede the window; the ask is the turn's last text, then the owner's answer
    const lines = `${JSON.stringify(prompt('poll', SDK))}\n${filler(5)}${JSON.stringify(said(KINDS[kind].ask))}\n`;
    assert.equal(runFile(kind, lines), false, kind);
  }
});

test('#191 A3: a window that holds the opening owner prompt of the reply still records (control)', () => {
  for (const kind of Object.keys(KINDS)) {
    const lines = `${filler(5)}${JSON.stringify(prompt('ship it'))}\n${JSON.stringify(said(KINDS[kind].ask))}\n`;
    assert.equal(runFile(kind, lines), true, `${kind}: file larger than the window`);
    assert.equal(runFile(kind, `${JSON.stringify(prompt('ship it'))}\n${JSON.stringify(said(KINDS[kind].ask))}\n`), true, `${kind}: small file`);
  }
});

test('#191 A3: text before the first prompt (no known origin) is never a reply', () => {
  const file = join(tmp(), 't.jsonl');
  writeFileSync(file, [said(MERGE_ASK), prompt('merge')].map((e) => JSON.stringify(e)).join('\n') + '\n');
  assert.deepEqual(lastReply(file, { prompt: 'merge' }), { text: '', promoted: false });
  assert.deepEqual(lastReply(file, { prompt: 'merge', skipSynthetic: true }), { text: '', promoted: false });
});

// ---- A4: a synthetic prompt with the owner's words is no owner answer --------------------------------------------------------------

test('#191 A4: an sdk prompt carrying the owner\'s words, newest in the transcript, records nothing', () => {
  for (const kind of Object.keys(KINDS)) {
    const answer = KINDS[kind].answer;
    assert.equal(run(kind, [prompt('ship it'), said(KINDS[kind].ask), prompt(answer, SDK)]), false, `${kind}: same-text sdk prompt newest`);
  }
});

test('#191 A4 (F4): sdk "merge" prompt + sdk reply ending with the ask binds nothing, the owner entry absent or present', () => {
  for (const kind of STRICT) {
    const answer = KINDS[kind].answer;
    const sdkTurn = [prompt('ship it'), prompt(answer, SDK), said(KINDS[kind].ask)];
    assert.equal(run(kind, sdkTurn), false, `${kind}: owner entry absent`);
    assert.equal(run(kind, [...sdkTurn, prompt(answer)]), false, `${kind}: owner entry present`);
  }
});

test('#191 A4 (F4): the race, an sdk entry appended after the owner\'s typed answer (other text, same text), binds nothing', () => {
  for (const kind of Object.keys(KINDS)) {
    const answer = KINDS[kind].answer;
    const asked = [prompt('ship it'), said(KINDS[kind].ask), prompt(answer)];
    // (rulings, A1/#189: a synthetic prompt opens no slot, so the owner's answer still reads the owner-turn ask right before it: unchanged)
    assert.equal(run(kind, [...asked, prompt('status', SDK)]), kind === 'ruling', `${kind}: other text`);
    assert.equal(run(kind, [...asked, prompt(answer, SDK)]), false, `${kind}: same text`);
  }
});

// ---- item 0: one rule for every reader, the ruling reader (skipSynthetic) included -------------------------------------------------

test('#191 F1 (rulings): a provenance-bearing prompt of unknown source is skipped like a synthetic turn: never promoted, and it voids the slot when it shows anything', () => {
  const bare = { type: 'user', message: { content: '[Request interrupted by user]' } };
  // it prints the ask itself: not promotable (only a visibleSynthetic turn promotes), so there is no ask
  assert.equal(run('ruling', withOwner('ruling', [prompt('ship it'), prompt('poll', FUTURE), said(RULING_ASK)])), false, 'ask printed inside the unknown-source turn');
  // it prints anything after the owner-turn ask: that voids the ask (as for any synthetic turn)
  assert.equal(run('ruling', withOwner('ruling', [prompt('ship it'), said(RULING_ASK), prompt('poll', FUTURE), said('hello')])), false, 'text in the unknown-source turn voids the owner-turn ask');
  // it shows nothing: the owner-turn ask stays (a skipped turn opens no slot)
  assert.equal(run('ruling', withOwner('ruling', [prompt('ship it'), said(RULING_ASK), prompt('poll', FUTURE), toolOnly(), toolResult()])), true, 'a silent unknown-source turn leaves the ask');
  // a field-less unknown entry (an interrupt marker, a legacy transcript) is a plain boundary as before
  assert.equal(run('ruling', withOwner('ruling', [prompt('ship it'), bare, said(RULING_ASK)])), true, 'field-less unknown');
  // lastReply says the same: skipped, nothing promoted
  const file = join(tmp(), 't.jsonl');
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, `${[prompt('go'), prompt('poll', FUTURE), said(RULING_ASK), prompt('done')].map((e) => JSON.stringify(e)).join('\n')}\n`);
  assert.deepEqual(lastReply(file, { prompt: 'done', skipSynthetic: true }), { text: '', promoted: false });
});

// ---- Part B: a queued answer never binds -------------------------------------------------------------------------------------------

test('#191 B1: each recorder refuses an answer the owner typed while the agent was busy (promptSource queued); a typed one records (B3)', () => {
  for (const kind of Object.keys(KINDS)) {
    assert.equal(run(kind, [prompt('ship it'), said(KINDS[kind].ask), prompt(KINDS[kind].answer, QUEUED)]), false, `${kind}: queued`);
    assert.equal(run(kind, [prompt('ship it'), said(KINDS[kind].ask), prompt(KINDS[kind].answer)]), true, `${kind}: typed`);
  }
});

test('#191 B1: the hook prints the queued nudge and records nothing for a queued answer; a typed answer records and gets no nudge', (t) => {
  for (const kind of Object.keys(KINDS)) {
    const entries = [prompt('ship it'), said(KINDS[kind].ask)];
    const queued = runHook(t, { entries, prompt: KINDS[kind].answer, entry: QUEUED });
    assert.equal(queued.status, 0);
    assert.equal(queued.record, null, `${kind}: nothing recorded`);
    assert.equal(queued.stdout, `${QUEUED_NUDGE}\n`, `${kind}: the queued nudge, one line, and not the ruling nudge`);
    const typed = runHook(t, { entries, prompt: KINDS[kind].answer });
    assert.notEqual(typed.record, null, `${kind}: typed records`);
    assert.doesNotMatch(typed.stdout, /typed while the agent was still working/, `${kind}: no nudge for a typed answer`);
  }
  // no ask was shown: still nudged (over-nudging is harmless), and the ruling nudge does not replace it
  assert.equal(runHook(t, { entries: [prompt('ship it'), said('nothing to ask')], prompt: 'R1-B1: accept', entry: QUEUED }).stdout, `${QUEUED_NUDGE}\n`);
  // a typed ruling-shaped prompt with no ask keeps the ruling nudge
  assert.equal(runHook(t, { entries: [prompt('ship it'), said('nothing to ask')], prompt: 'R1-B1: accept' }).stdout, `${RULING_NUDGE}\n`);
});

test('#191 F3/F6: the nudge text tells the agent what happened and what to do', () => {
  assert.match(QUEUED_NUDGE, /^\[claude-pipeline owner-go\]/);
  assert.match(QUEUED_NUDGE, /typed while the agent was still working/);
  assert.match(QUEUED_NUDGE, /not recorded/);
  assert.match(QUEUED_NUDGE, /P merge --pr N --dry-run --owner-go/);
  assert.match(QUEUED_NUDGE, /P triage round-request/);
  assert.match(QUEUED_NUDGE, /P triage ruling-request/);
  assert.match(QUEUED_NUDGE, /fresh closing lines/);
  assert.match(QUEUED_NUDGE, /once more after the reply ends/);
  assert.equal(QUEUED_NUDGE.includes('\n'), false);
  assert.notEqual(QUEUED_NUDGE, RULING_NUDGE);
});

const hookInput = (entries, answer, extra = {}) => {
  const dir = tmp();
  const file = join(dir, 't.jsonl');
  writeFileSync(file, `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`);
  return { hook_event_name: 'UserPromptSubmit', session_id: 'sess-1', prompt: answer, transcript_path: file, ...extra };
};
test('#191 F3: queuedNudge applies to a merge, an extra round and a ruling answer whose entry is queued, and to nothing else', () => {
  const asked = [prompt('ship it'), said(MERGE_ASK)];
  for (const answer of ['merge', 'merge #58', 'extra round', 'R1-B1: accept', 'R1-B1: accept, R2-F1: follow-up']) {
    assert.equal(queuedNudge(hookInput([...asked, prompt(answer, QUEUED)], answer)), QUEUED_NUDGE, answer);
    assert.equal(queuedNudge(hookInput([...asked, prompt(answer)], answer)), null, `${answer}: typed`);
  }
  assert.equal(queuedNudge(hookInput([...asked, prompt('what is the status', QUEUED)], 'what is the status')), null, 'not an answer');
  assert.equal(queuedNudge(hookInput([...asked, prompt('merge it later maybe', QUEUED)], 'merge it later maybe')), null, 'not an answer (words after merge)');
  const notice = '<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n</task-notification>';
  assert.equal(queuedNudge(hookInput([...asked, prompt(notice, SDK)], notice)), null, 'a notice');
  assert.equal(queuedNudge(hookInput([...asked, prompt('merge', SDK)], 'merge')), null, 'a synthetic entry is not queued');
  assert.equal(queuedNudge(hookInput([...asked, prompt('merge', QUEUED)], 'merge', { origin: { kind: 'peer' } })), null, 'the hook input itself says it is not typed');
  assert.equal(queuedNudge(hookInput([...asked, prompt('merge', QUEUED)], 'merge', { agent_id: 'sub-1' })), null, 'a subagent');
  assert.equal(queuedNudge(hookInput([...asked, prompt('merge', QUEUED)], 'merge', { hook_event_name: 'Stop' })), null, 'another event');
  assert.equal(queuedNudge(hookInput([...asked, prompt('merge', QUEUED), said('ok')], 'merge')), null, 'the queued entry is not the newest');
  assert.equal(queuedNudge(hookInput([...asked], 'merge')), null, 'the entry is not in the transcript yet');
  for (const bad of [undefined, null, 5, { prompt: 7 }, { prompt: 'merge', transcript_path: 5 }, { prompt: 'merge', transcript_path: '/no/such/file' }]) assert.equal(queuedNudge(bad), null);
});

// B2: the hook ran BEFORE the transcript had the entry (it cannot tell), the entry then turned out to be queued. Each kind at use time.
const NOW = Date.parse('2026-11-10T10:00:00Z');
const now = () => NOW;
function recordedThen(kind, meta) {
  const home = tmp();
  const dir = join(home, '.claude', 'projects', '-repo');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 't.jsonl');
  const before = [prompt('ship it'), said(KINDS[kind].ask)];
  const writeAll = (entries) => writeFileSync(file, `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`);
  writeAll(before);
  const answer = KINDS[kind].answer;
  const rec = KINDS[kind].rec({ hook_event_name: 'UserPromptSubmit', session_id: 'sess-1', cwd: home, prompt: answer, prompt_id: 'pid-ans', transcript_path: file }, { home, now });
  assert.ok(KINDS[kind].bound(rec), `${kind}: recorded while the transcript lacked the entry`);
  writeAll([...before, { type: 'user', message: { content: answer }, promptId: 'pid-ans', ...meta }]);
  return { home, rec };
}
const RULED = { repo: 'acme/widgets', pr: 58, id: 'R1-B1', quote: 'R1-B1: accept', decision: 'ACCEPT', contentOf: () => 'c0ffee000000' };
const GAPS = {
  merge: ({ home }) => approvalGap({ repo: 'acme/widgets', pr: 58, head: HEAD, items: ITEMS, home, now }),
  round: ({ home }) => ownerGrantGap({ repo: 'acme/widgets', pr: 58, k: 2, head: HEAD, home, now }),
  ruling: ({ home }) => (ownerRuled({ ...RULED, home, now }) ? 'ok' : ownerRulingGap({ ...RULED, home, now })),
};
test('#191 B2: a record written before the transcript had the entry is refused at use time when the entry is queued, for every kind; typed is unchanged (B3)', () => {
  for (const kind of Object.keys(KINDS)) {
    const queued = recordedThen(kind, QUEUED);
    assert.equal(promptProvenance(queued.rec, { home: queued.home }), 'synthetic', `${kind}: provenance of a queued entry`);
    assert.equal(GAPS[kind](queued), 'provenance', `${kind}: queued`);
    const typed = recordedThen(kind, OWNER_ENTRY);
    assert.equal(promptProvenance(typed.rec, { home: typed.home }), 'owner');
    assert.equal(GAPS[kind](typed), 'ok', `${kind}: typed`);
  }
});
