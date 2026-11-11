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
import { OWNER_ENTRY, link, linesOf, mergeRequest, roundRequest, rulingRequest, runHook } from './helpers/owner-go.mjs';

const HEAD = '0123456789abcdef0123456789abcdef01234567';
const ITEMS = 'abcdef012345';
let pid = 0;
const prompt = (text, meta = OWNER_ENTRY) => { const n = ++pid; return { type: 'user', message: { content: text }, promptId: `pid-${n}`, uuid: `u-prompt-${n}`, ...meta }; };
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
function record(kind, entries, answer = KINDS[kind].answer) {
  const home = tmp();
  mkdirSync(join(home, 'p'), { recursive: true });
  const file = join(home, 'p', 't.jsonl');
  writeFileSync(file, linesOf(entries));
  return KINDS[kind].rec({ hook_event_name: 'UserPromptSubmit', session_id: 'sess-1', cwd: home, prompt: answer, transcript_path: file }, { home });
}
const run = (kind, entries, answer = KINDS[kind].answer) => KINDS[kind].bound(record(kind, entries, answer));
const withOwner = (kind, entries) => [...entries, prompt(KINDS[kind].answer)];
const filler = (mb) => `${JSON.stringify(said('x'.repeat(1024 * 1024 - 100)))}\n`.repeat(mb);
function runFile(kind, lines, tailEntries = []) {
  const home = tmp();
  mkdirSync(join(home, 'p'), { recursive: true });
  const file = join(home, 'p', 't.jsonl');
  writeFileSync(file, lines + linesOf([...tailEntries, prompt(KINDS[kind].answer)]));
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
  writeFileSync(file, linesOf([prompt('go'), said('mine'), prompt('poll', SDK), said('hidden'), prompt('done')]));
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
    const cutOff = prompt('poll', SDK);
    const lines = `${JSON.stringify(cutOff)}\n${filler(5)}${JSON.stringify({ ...said(KINDS[kind].ask), uuid: 'u-ask', parentUuid: cutOff.uuid })}\n`; // (the window starts after the prompt: the ask's parent is not in it)
    assert.equal(runFile(kind, lines), false, kind);
  }
});

test('#191 A3: a window that holds the opening owner prompt of the reply still records (control)', () => {
  for (const kind of Object.keys(KINDS)) {
    const opening = prompt('ship it');
    const small = linesOf([opening, said(KINDS[kind].ask)]);
    assert.equal(runFile(kind, `${filler(5)}${small}`), true, `${kind}: file larger than the window`);
    assert.equal(runFile(kind, small), true, `${kind}: small file`);
  }
});

test('#191 A3: text before the first prompt (no known origin) is never a reply', () => {
  const file = join(tmp(), 't.jsonl');
  writeFileSync(file, linesOf([said(MERGE_ASK), prompt('merge')]));
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
  writeFileSync(file, linesOf([prompt('go'), prompt('poll', FUTURE), said(RULING_ASK), prompt('done')]));
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
  assert.match(QUEUED_NUDGE, /FRESH closing lines/);
  assert.match(QUEUED_NUDGE, /once more after the reply ends/);
  assert.equal(QUEUED_NUDGE.includes('\n'), false);
  assert.notEqual(QUEUED_NUDGE, RULING_NUDGE);
});

const hookInput = (entries, answer, extra = {}) => {
  const dir = tmp();
  const file = join(dir, 't.jsonl');
  writeFileSync(file, linesOf(entries));
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
  const writeAll = (entries) => writeFileSync(file, linesOf(entries));
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

// ---- R1-B1: text belongs to the prompt it was written for (uuid / parentUuid), not to the prompt that happens to be newest ---------------------------
// A headless `claude -p --resume <session>` process appends to the owner's transcript while the owner types and the interactive session answers. Its output interleaves with the
// owner's turn, so "the assistant text after the last prompt" is no proof of who wrote it. Each assistant entry (and each tool result) is attributed to its originating prompt through
// the parentUuid chain; text whose origin is an invisible turn is never the owner's reply, whatever its position.

const ASK59 = { merge: mergeRequest(59, HEAD, ITEMS), round: roundRequest(59, 2, HEAD), ruling: rulingRequest(59, ['R1-B1']) };
const of = (p, e) => ({ ...e, parentUuid: p.uuid }); // an entry written for prompt `p` (what its process chains it to)
const pr = (kind, r) => (r === null ? null : kind === 'merge' ? r.requests.map((q) => q.pr) : r.pr); // the PR a record binds
const bound58 = (kind) => (kind === 'merge' ? [58] : 58);

test('#191 R1-B1 (interleaving 1): an sdk turn started BEFORE the owner\'s prompt appends its request after the interactive reply: only the owner-turn ask binds', () => {
  for (const kind of Object.keys(KINDS)) {
    const sdk = prompt('poll', SDK);
    const owner = prompt('ship it');
    // sdk prompt, owner prompt, the interactive reply asks for #58, then the still-running sdk process writes its #59 request, then the owner answers
    const entries = [sdk, owner, of(owner, said(KINDS[kind].ask)), of(sdk, said(ASK59[kind])), prompt(KINDS[kind].answer)];
    assert.deepEqual(pr(kind, record(kind, entries)), bound58(kind), `${kind}: the request the owner saw`);
    // the owner-turn reply asked for nothing: the sdk request binds nothing
    const silent = [sdk, owner, of(owner, said('working on it')), of(sdk, said(ASK59[kind])), prompt(KINDS[kind].answer)];
    assert.equal(run(kind, silent), false, `${kind}: nothing in the owner turn`);
    // a tool-only sdk tail does not turn the owner-turn ask stale either
    const quiet = [sdk, owner, of(owner, said(KINDS[kind].ask)), of(sdk, toolOnly()), of(sdk, toolResult()), prompt(KINDS[kind].answer)];
    assert.deepEqual(pr(kind, record(kind, quiet)), bound58(kind), `${kind}: sdk tool calls after the ask`);
  }
});

test('#191 R1-B1 (interleaving 2): an sdk prompt written DURING the interactive reply: its request binds nothing, the owner-turn ask (written last) binds', () => {
  for (const kind of Object.keys(KINDS)) {
    const owner = prompt('ship it');
    const sdk = prompt('poll', SDK);
    const entries = [owner, of(owner, said('checking')), sdk, of(sdk, said(ASK59[kind])), of(owner, said(KINDS[kind].ask)), prompt(KINDS[kind].answer)];
    assert.deepEqual(pr(kind, record(kind, entries)), bound58(kind), `${kind}: the request the owner saw`);
    const silent = [owner, of(owner, said('checking')), sdk, of(sdk, said(ASK59[kind])), of(owner, said('done')), prompt(KINDS[kind].answer)];
    assert.equal(run(kind, silent), false, `${kind}: nothing in the owner turn`);
    // the sdk turn is the last thing written: the strict A2 rule stays (an invisible turn after the owner's reply makes it stale)
    const trailing = [owner, of(owner, said(KINDS[kind].ask)), sdk, of(sdk, said(ASK59[kind])), prompt(KINDS[kind].answer)];
    assert.equal(run(kind, trailing), false, `${kind}: sdk turn opened after the owner's reply ended`);
  }
});

test('#191 R1-B1: an sdk request appended after the owner\'s typed answer (and before the transcript caught up) binds nothing', () => {
  for (const kind of Object.keys(KINDS)) {
    const sdk = prompt('poll', SDK);
    const owner = prompt('ship it');
    const entries = [sdk, owner, of(owner, said(KINDS[kind].ask)), prompt(KINDS[kind].answer), of(sdk, said(ASK59[kind]))];
    // (the owner's answer is no longer the newest entry: the reply read is the owner-turn one, not the sdk text)
    assert.deepEqual(pr(kind, record(kind, entries)), bound58(kind), `${kind}: never the sdk request`);
  }
});

test('#191 R1-B1 (c): an assistant entry whose parent chain does not resolve inside the window is dropped (missing parent, unknown uuid, cycle, a chain ending at no prompt)', () => {
  for (const kind of Object.keys(KINDS)) {
    const owner = prompt('ship it');
    const good = of(owner, said(KINDS[kind].ask));
    const answer = prompt(KINDS[kind].answer);
    const orphans = {
      'parentUuid null': { ...said(ASK59[kind]), parentUuid: null },
      'parent outside the window': { ...said(ASK59[kind]), parentUuid: 'u-not-in-this-file' },
      'no uuid at all': (() => { const e = { ...said(ASK59[kind]) }; delete e.parentUuid; return { ...e, uuid: undefined, parentUuid: undefined }; })(),
      'self cycle': { ...said(ASK59[kind]), uuid: 'u-cycle', parentUuid: 'u-cycle' },
    };
    for (const [name, orphan] of Object.entries(orphans)) {
      // after the owner-turn ask: the dropped entry changes nothing
      assert.deepEqual(pr(kind, record(kind, [owner, good, orphan, answer])), bound58(kind), `${kind}: ${name}`);
      // alone: nothing binds
      assert.equal(run(kind, [owner, orphan, answer]), false, `${kind}: ${name} alone`);
    }
    const a = { ...said(ASK59[kind]), uuid: 'u-cyc-a', parentUuid: 'u-cyc-b' };
    const b = { ...said(ASK59[kind]), uuid: 'u-cyc-b', parentUuid: 'u-cyc-a' };
    assert.equal(run(kind, [owner, a, b, answer]), false, `${kind}: two-entry cycle`);
    // a chain that ends at an assistant entry with no parent (not at a prompt)
    const root = { ...said('x'), uuid: 'u-root', parentUuid: null };
    assert.equal(run(kind, [owner, root, { ...said(KINDS[kind].ask), parentUuid: 'u-root' }, answer]), false, `${kind}: chain ends at a parentless assistant entry`);
    // two entries claiming one uuid make the chain ambiguous
    const twin1 = { ...said('x'), uuid: 'u-twin', parentUuid: owner.uuid };
    const twin2 = { ...said('y'), uuid: 'u-twin', parentUuid: owner.uuid };
    assert.equal(run(kind, [owner, twin1, twin2, { ...said(KINDS[kind].ask), parentUuid: 'u-twin' }, answer]), false, `${kind}: duplicate uuid`);
  }
});

test('#191 R1-B1 (c): a tool result inside an invisible turn, or with an unresolved chain, never reaches the ruling slot as owner-turn content', () => {
  // a ruling ask in the owner's turn; an sdk tool_result that surfaces an ask is the sdk turn's content: it never voids the owner's slot when the turn was written during it
  const owner = prompt('ship it');
  const sdk = prompt('poll', SDK);
  const entries = [owner, of(owner, said('checking')), sdk, of(sdk, { type: 'user', message: { content: [{ type: 'tool_result', content: 'ruling-request R1-B1 for PR #59?' }] } }), of(owner, said(RULING_ASK)), prompt('R1-B1: accept')];
  assert.deepEqual(pr('ruling', record('ruling', entries)), 58);
  // a tool result nobody can place is dropped (it would void the slot if it were the owner's)
  const stray = { type: 'user', message: { content: [{ type: 'tool_result', content: 'ruling-request R1-B1 for PR #59?' }] }, parentUuid: 'u-gone' };
  assert.deepEqual(pr('ruling', record('ruling', [owner, of(owner, said(RULING_ASK)), stray, prompt('R1-B1: accept')])), 58);
});

test('#191 R1-B1 (d) / R2-B1: controls: a proper chain still binds; late text from an OLDER visible turn revives nothing, and after the selected request makes it stale', () => {
  for (const kind of Object.keys(KINDS)) {
    const first = prompt('ship it');
    const answer = prompt(KINDS[kind].answer);
    assert.deepEqual(pr(kind, record(kind, [first, of(first, said('one')), of(first, said(KINDS[kind].ask)), answer])), bound58(kind), `${kind}: a plain visible turn`);
    // an older visible turn writes its (new) ask after a newer prompt: only the reply slot right before the owner's current prompt is read, and that one is empty
    const second = prompt('keep going');
    assert.equal(run(kind, [first, of(first, said(KINDS[kind].ask)), second, of(second, toolOnly()), of(first, said(ASK59[kind])), answer]), false, `${kind}: late text from an older turn does not bind`);
    // R2-B1: ... but a visible ask in the newest turn goes stale when an older VISIBLE turn then prints text after it (the owner was last shown that text, not the ask): nothing binds
    assert.equal(run(kind, [first, of(first, said('x')), second, of(second, said(KINDS[kind].ask)), of(first, said(ASK59[kind])), answer]), false, `${kind}: late text from an older turn after the selected request voids it`);
    // ... any text counts, not only a request; a tool-only entry from the older turn shows nothing and changes nothing
    assert.equal(run(kind, [first, of(first, said('x')), second, of(second, said(KINDS[kind].ask)), of(first, said('one more thing')), answer]), false, `${kind}: late plain text from an older turn voids it too`);
    assert.deepEqual(pr(kind, record(kind, [first, of(first, said('x')), second, of(second, said(KINDS[kind].ask)), of(first, toolOnly()), answer])), bound58(kind), `${kind}: late tool-only entry from an older turn shows nothing`);
    // control: the older turn's text lands BEFORE the selected slot's last entry (interleaved) -> the selected request still binds
    assert.deepEqual(pr(kind, record(kind, [first, of(first, said('x')), second, of(first, said(ASK59[kind])), of(second, said(KINDS[kind].ask)), answer])), bound58(kind), `${kind}: older turn's text before the selected slot's last entry still binds`);
  }
});

const BOUNDARY = { type: 'system', subtype: 'compact_boundary' };
const SUMMARY = { type: 'user', message: { role: 'user', content: 'This session is being continued from a previous conversation.' }, isCompactSummary: true, isVisibleInTranscriptOnly: true, entrypoint: 'cli' };

test('#191 R1-B1 (d): a compaction in the chain is transparent: between the ask and the answer, and in the middle of a turn', () => {
  for (const kind of Object.keys(KINDS)) {
    const owner = prompt('ship it');
    // ask, compaction, answer (the summary opens no slot)
    assert.deepEqual(pr(kind, record(kind, [owner, of(owner, said(KINDS[kind].ask)), BOUNDARY, SUMMARY, prompt(KINDS[kind].answer)])), bound58(kind), `${kind}: compaction before the answer`);
    // auto-compact in the middle of the owner's turn: the text after the summary chains through it (boundary: parentUuid null, logicalParentUuid the entry before) to the owner's prompt
    assert.deepEqual(pr(kind, record(kind, [owner, of(owner, said('working')), BOUNDARY, SUMMARY, said(KINDS[kind].ask), prompt(KINDS[kind].answer)])), bound58(kind), `${kind}: compaction in the middle of the turn`);
    // the same in an sdk turn: the compaction does not turn its text into the owner's
    const sdk = prompt('poll', SDK);
    assert.equal(run(kind, [owner, of(owner, said('x')), sdk, of(sdk, said('working')), BOUNDARY, SUMMARY, said(ASK59[kind]), prompt(KINDS[kind].answer)]), false, `${kind}: compaction inside an invisible turn`);
    // a boundary whose logical parent is outside the window leaves the text unplaced: dropped
    assert.equal(run(kind, [owner, { ...BOUNDARY, parentUuid: null, logicalParentUuid: 'u-gone' }, SUMMARY, said(KINDS[kind].ask), prompt(KINDS[kind].answer)]), false, `${kind}: compaction with its past outside the window`);
  }
});

test('#191 R1-B1: a legacy transcript (no entry has a uuid) keeps the positional attribution; one uuid anywhere makes it a modern one', () => {
  const strip = (entries) => entries.map(({ uuid, parentUuid, ...e }) => e);
  for (const kind of Object.keys(KINDS)) {
    const mk = (entries) => {
      const home = tmp();
      mkdirSync(join(home, 'p'), { recursive: true });
      const file = join(home, 'p', 't.jsonl');
      writeFileSync(file, `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`);
      return KINDS[kind].rec({ hook_event_name: 'UserPromptSubmit', session_id: 'sess-1', cwd: home, prompt: KINDS[kind].answer, transcript_path: file }, { home });
    };
    const plain = [prompt('ship it'), said(KINDS[kind].ask), prompt(KINDS[kind].answer)];
    assert.equal(KINDS[kind].bound(mk(strip(plain))), true, `${kind}: legacy, plain turn`);
    assert.equal(KINDS[kind].bound(mk(strip([prompt('ship it'), prompt('poll', SDK), said(KINDS[kind].ask), prompt(KINDS[kind].answer)]))), false, `${kind}: legacy, invisible turn (A2 by position)`);
    // the attacker cannot choose the fallback by wording; one entry with a uuid (a system line, say) makes the file modern and the unchained assistant entry is dropped
    assert.equal(KINDS[kind].bound(mk([...strip(plain.slice(0, 2)), { type: 'system', subtype: 'turn_duration', uuid: 'u-sys' }, ...strip(plain.slice(2))])), false, `${kind}: one uuid anywhere -> modern`);
  }
});

// ---- R3-B1 / #241 / R3-F1: what the owner was last SHOWN decides which request is current ---------------------------------------------
// shownAfter compares another visible slot's shown position with the selected slot's last SHOWN entry (its text), never with its last entry of any kind (R3-B1), counts a surfaced tool
// ask of another visible slot as shown (#241), and a visibleSynthetic turn that is not promoted voids the ruling by what it shows after the selected slot's last shown entry (R3-F1).

const toolUse = (command) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command } }] } });
const toolResultOf = (content) => ({ type: 'user', message: { content: [{ type: 'tool_result', content }] } });

test('R3-B1: a trailing tool-only entry (or tool result) in the selected slot does not hide a later visible request of another slot', () => {
  for (const kind of Object.keys(KINDS)) {
    const first = prompt('ship it');
    const second = prompt('keep going');
    const answer = prompt(KINDS[kind].answer);
    for (const [name, tail] of [['tool_use', toolOnly()], ['tool_result', toolResult()]]) {
      // selected #58 text (second), other slot's #59 text (first), then a tool-only entry in the selected slot: the owner was last shown #59
      assert.equal(run(kind, [first, of(first, said('x')), second, of(second, said(KINDS[kind].ask)), of(first, said(ASK59[kind])), of(second, tail), answer]), false, `${kind}: ${name} after the other slot's request`);
    }
    // controls: the other slot's text came BEFORE the selected slot's last text, then the selected slot went tool-only: the selected request still binds
    assert.deepEqual(pr(kind, record(kind, [first, of(first, said('x')), second, of(first, said(ASK59[kind])), of(second, said(KINDS[kind].ask)), of(second, toolOnly()), of(second, toolResult()), answer])), bound58(kind), `${kind}: older text before the selected text`);
    assert.deepEqual(pr(kind, record(kind, [first, of(first, said('x')), second, of(second, said(KINDS[kind].ask)), of(second, toolOnly()), of(second, toolResult()), answer])), bound58(kind), `${kind}: tool-only tail alone`);
  }
});

test('#241: a surfaced tool ask (tool_use input or tool_result) of ANOTHER visible slot after the selected request makes it stale; a tool block without an ask, or the selected slot\'s own, does not', () => {
  for (const kind of Object.keys(KINDS)) {
    const first = prompt('ship it');
    const second = prompt('keep going');
    const answer = prompt(KINDS[kind].answer);
    const base = [first, of(first, said('x')), second, of(second, said(KINDS[kind].ask))];
    assert.equal(run(kind, [...base, of(first, toolUse(`echo '${ASK59[kind]}'`)), answer]), false, `${kind}: tool_use input prints the other request`);
    assert.equal(run(kind, [...base, of(first, toolUse('ls')), of(first, toolResultOf(ASK59[kind])), answer]), false, `${kind}: tool_result prints the other request`);
    assert.equal(run(kind, [...base, of(first, toolResultOf([{ type: 'text', text: ASK59[kind] }])), answer]), false, `${kind}: tool_result text blocks`);
    // controls: no ask in the other slot's tool block; the surfaced ask lands BEFORE the selected request; the selected slot's own tool block
    assert.deepEqual(pr(kind, record(kind, [...base, of(first, toolUse('ls')), of(first, toolResultOf('ok')), answer])), bound58(kind), `${kind}: tool block without an ask`);
    assert.deepEqual(pr(kind, record(kind, [first, of(first, said('x')), second, of(first, toolUse(`echo '${ASK59[kind]}'`)), of(second, said(KINDS[kind].ask)), answer])), bound58(kind), `${kind}: other slot's surfaced ask before the selected request`);
    assert.deepEqual(pr(kind, record(kind, [...base, of(second, toolUse(`echo '${ASK59[kind]}'`)), answer])), bound58(kind), `${kind}: the selected slot's own surfaced ask is not another slot`);
  }
});

test('R3-F1 (rulings): a visibleSynthetic turn opened BEFORE the selected slot\'s last entry that shows text or a surfaced ask after it voids the ruling; an invisible one does not', () => {
  const owner = prompt('ship it');
  const answer = prompt('R1-B1: accept');
  const surfaced = toolUse(`ruling-request R1-B1 for PR #59?`);
  for (const [name, meta] of [['task notice', NOTICE], ['peer message', PEER], ['plugin message', PLUGIN]]) {
    const synth = prompt('notice', meta);
    const open = [owner, synth, of(owner, said(RULING_ASK))];
    assert.equal(run('ruling', [...open, of(synth, said('plain text')), answer]), false, `${name}: plain text after the ask`);
    assert.equal(run('ruling', [...open, of(synth, surfaced), answer]), false, `${name}: surfaced tool ask after the ask`);
    assert.equal(run('ruling', [...open, of(synth, toolResultOf('ruling-request R1-B1 for PR #59?')), answer]), false, `${name}: surfaced tool result after the ask`);
    // controls: it printed BEFORE the ask (interleaved, the ask is the last thing shown); it printed nothing shown
    assert.equal(run('ruling', [owner, synth, of(synth, said('plain text')), of(owner, said(RULING_ASK)), answer]), true, `${name}: text before the ask`);
    assert.equal(run('ruling', [...open, of(synth, toolOnly()), of(synth, toolResult()), answer]), true, `${name}: tool-only turn shows nothing`);
  }
  // an INVISIBLE interleaved turn doing the same: its output is never shown, the ask still binds
  for (const [name, meta] of [['sdk', SDK], ['non-human origin', NON_HUMAN], ['future source', FUTURE]]) {
    const hidden = prompt('poll', meta);
    const open = [owner, hidden, of(owner, said(RULING_ASK))];
    assert.equal(run('ruling', [...open, of(hidden, said('plain text')), answer]), true, `${name}: plain text`);
    assert.equal(run('ruling', [...open, of(hidden, surfaced), answer]), true, `${name}: surfaced tool ask`);
  }
});

// ---- R4-F1: a harness line inside the owner's own interactive turn is no invisible turn ---------------------------------------------
// Claude Code 2.1.322 writes `entrypoint: "cli"` (and userType) on EVERY line of an interactive transcript, so that field alone is envelope, not provenance. Real user-line shapes:
//   typed prompt: isMeta false, promptSource typed, origin {kind human}; skill body mid-turn (after the Skill tool_result): isMeta true, promptSource / origin / turnOrigin null;
//   subagent hand-back: isMeta true, promptSource system, origin {kind peer}; headless note: entrypoint sdk-cli.
const HARNESS_NOTE = { isMeta: true, promptSource: null, origin: null, turnOrigin: null, entrypoint: 'cli', userType: 'external' };
const SYSTEM_REMINDER = { type: 'user', isMeta: true, message: { content: [{ type: 'text', text: '<system-reminder>\nSomething the harness injected.\n</system-reminder>' }] }, promptSource: null, origin: null, entrypoint: 'cli', userType: 'external' };
const note = (meta = HARNESS_NOTE) => prompt('Base directory for this skill: /x/skills/ship\n\nFollow the steps.', meta);

test('R4-F1: an interactive harness line (isMeta, no promptSource / origin, entrypoint cli) is no invisible turn: the request printed after it binds, M right after the prompt or mid-turn', () => {
  for (const kind of Object.keys(KINDS)) {
    const o = prompt('ship it');
    const m = note();
    assert.deepEqual(pr(kind, record(kind, [o, m, of(m, said(KINDS[kind].ask)), prompt(KINDS[kind].answer)])), bound58(kind), `${kind}: M right after the prompt`);
    const m2 = note();
    assert.deepEqual(pr(kind, record(kind, [o, of(o, toolOnly()), of(o, toolResult()), m2, of(m2, said(KINDS[kind].ask)), prompt(KINDS[kind].answer)])), bound58(kind), `${kind}: M mid-turn, after the tool result`);
    const m3 = note();
    assert.deepEqual(pr(kind, record(kind, [o, of(o, said('working on it')), m3, of(m3, said(KINDS[kind].ask)), prompt(KINDS[kind].answer)])), bound58(kind), `${kind}: M after some text`);
    // a system-reminder note written as a text-block array, and one with no provenance field but the envelope
    const r = { ...SYSTEM_REMINDER, uuid: 'u-reminder-1' };
    assert.deepEqual(pr(kind, record(kind, [o, r, of(r, said(KINDS[kind].ask)), prompt(KINDS[kind].answer)])), bound58(kind), `${kind}: system-reminder note`);
    const bare = note({ entrypoint: 'cli', userType: 'external' });
    assert.deepEqual(pr(kind, record(kind, [o, bare, of(bare, said(KINDS[kind].ask)), prompt(KINDS[kind].answer)])), bound58(kind), `${kind}: envelope only`);
    // the note is still a boundary: an older request is not revived by it (as before #191)
    const m4 = note();
    assert.equal(run(kind, [o, of(o, said(KINDS[kind].ask)), m4, of(m4, toolOnly()), prompt(KINDS[kind].answer)]), false, `${kind}: an older request stays stale across the note`);
  }
});

test('R4-F1: with the owner prompt\'s tool result landing AFTER the harness line, the NEWEST visible request binds, not the older one', () => {
  for (const kind of Object.keys(KINDS)) {
    const o = prompt('ship it');
    const a1 = of(o, said(ASK59[kind])); // the older request (another PR), with a tool call still running
    const m = note();
    const a2 = of(m, said(KINDS[kind].ask)); // the newer request, after the harness line
    const late = of(a1, toolResult()); // the tool result of the owner's turn lands after M (a parallel tool call)
    assert.deepEqual(pr(kind, record(kind, [o, a1, m, a2, late, prompt(KINDS[kind].answer)])), bound58(kind), `${kind}: newest request`);
  }
});

test('R4-F1: a headless note (entrypoint sdk-cli, with or without null fields), an unknown promptSource / turnOrigin / entrypoint stay invisible', () => {
  for (const [name, meta] of [
    ['sdk-cli with the null envelope', { ...HARNESS_NOTE, entrypoint: 'sdk-cli' }],
    ['sdk-cli alone', { entrypoint: 'sdk-cli' }],
    ['unknown promptSource, other fields null', { ...HARNESS_NOTE, promptSource: 'brand-new-source' }],
    ['unknown turnOrigin, other fields null', { ...HARNESS_NOTE, turnOrigin: 'brand-new-turn' }],
    ['origin object without a kind', { ...HARNESS_NOTE, origin: {} }],
    ['an entrypoint other than cli', { ...HARNESS_NOTE, entrypoint: 'brand-new-entry' }],
  ]) {
    for (const kind of Object.keys(KINDS)) {
      const o = prompt('ship it');
      const h = prompt('poll', meta);
      assert.equal(run(kind, [o, h, of(h, said(KINDS[kind].ask)), prompt(KINDS[kind].answer)]), false, `${kind}: ${name}`);
    }
  }
  assert.equal(entrySource(prompt('x', HARNESS_NOTE)), 'unknown');
});

test('R4-F1: a `!` block and an interrupt marker (interactive, entrypoint cli) are plain boundaries in every reader, ruling included, as on main', () => {
  const bang = (text) => prompt(text, { promptSource: null, origin: null, entrypoint: 'cli', userType: 'external' });
  for (const kind of Object.keys(KINDS)) {
    const o = prompt('ship it');
    for (const [name, text] of [['`!` block', '<bash-input>git status</bash-input>\n<bash-stdout>clean</bash-stdout><bash-stderr></bash-stderr>'], ['interrupt marker', '[Request interrupted by user]']]) {
      // a request printed after it binds ...
      const b = bang(text);
      assert.deepEqual(pr(kind, record(kind, [o, b, of(b, said(KINDS[kind].ask)), prompt(KINDS[kind].answer)])), bound58(kind), `${kind}: request after the ${name}`);
      // ... and one printed before it is stale: the `!` block is a prompt of its own and nothing was asked after it (main's behaviour)
      const b2 = bang(text);
      assert.equal(run(kind, [o, of(o, said(KINDS[kind].ask)), b2, prompt(KINDS[kind].answer)]), false, `${kind}: request before the ${name} is stale`);
    }
  }
});
