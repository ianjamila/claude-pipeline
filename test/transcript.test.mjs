import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findSubagentTranscript, proveModel, extractJsonBlock } from '../pipeline/lib/transcript.mjs';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'transcripts');
const read = (name) => fs.readFileSync(path.join(FIX, name), 'utf8');
const prove = (name, extra = {}) =>
  proveModel({
    jsonlText: read(`${name}.jsonl`),
    metaText: read(`${name}.meta.json`),
    expectModelPrefix: 'claude-fable-',
    expectEffort: 'high',
    ...extra,
  });

// Small in-memory builders for shapes that would clutter the fixture directory.
const userLine = (content, extra = {}) => JSON.stringify({ type: 'user', message: { role: 'user', content }, ...extra });
const asstLine = ({ id = 'msg_1', model = 'claude-fable-5-1', effort = 'high', stop = 'end_turn', content, ...rest }) =>
  JSON.stringify({ type: 'assistant', effort, message: { model, id, role: 'assistant', stop_reason: stop, content }, ...rest });
const text = (t) => [{ type: 'text', text: t }];
const GOOD_META = '{"agentType":"arbiter","description":"d"}';
const proveText = (lines, extra = {}) =>
  proveModel({
    jsonlText: lines.join('\n') + '\n',
    metaText: GOOD_META,
    expectModelPrefix: 'claude-fable-',
    expectEffort: 'high',
    ...extra,
  });

// ---------- proveModel: fixtures ----------

test('fable-ok proves Fable at high effort and exposes prompt and ruling text', () => {
  const r = prove('fable-ok');
  assert.deepEqual(r.errors, []);
  assert.equal(r.ok, true);
  assert.equal(r.assistantLines, 2);
  assert.deepEqual(r.models, { 'claude-fable-5-1': 2 });
  assert.deepEqual(r.efforts, { high: 2 });
  assert.match(r.firstUserText, /^ROUND: 1\nINPUT-DIGEST: abc123def456/);
  assert.equal(r.finalStopReason, 'end_turn');
  assert.match(r.finalAssistantText, /Rulings below\./);
  assert.doesNotMatch(r.finalAssistantText, /Weighing the items/, 'thinking blocks are not ruling text');
  const rulings = extractJsonBlock(r.finalAssistantText);
  assert.equal(rulings.rulings.length, 1);
  assert.equal(rulings.rulings[0].id, 'R1-S2');
  assert.equal(rulings.rulings[0].ruling, 'REJECT');
});

test('wrong effort is reported on every offending line, for both effort and perTurnEffort', () => {
  const r = prove('fable-wrong-effort');
  assert.equal(r.ok, false);
  assert.deepEqual(r.errors, [
    'unexpected effort medium on line 2',
    'unexpected perTurnEffort medium on line 2',
    'unexpected effort medium on line 3',
    'unexpected perTurnEffort medium on line 3',
  ]);
  assert.deepEqual(r.efforts, { medium: 2 });
});

test('synthetic API-error transcript fails on model and API error', () => {
  const r = prove('synthetic-error');
  assert.equal(r.ok, false);
  assert.ok(r.errors.includes('unexpected model <synthetic> on line 2'), r.errors.join('|'));
  assert.ok(r.errors.includes('API error on line 2: model_not_found'), r.errors.join('|'));
  assert.ok(r.errors.includes('unexpected effort undefined on line 2'), 'a missing effort counts as a mismatch');
  assert.deepEqual(r.models, { '<synthetic>': 1 });
});

test('a fallback to another model mid-run is caught', () => {
  const r = prove('mixed-models');
  assert.equal(r.ok, false);
  assert.deepEqual(r.errors, ['unexpected model claude-opus-5-5 on line 4']);
  assert.deepEqual(r.models, { 'claude-fable-5-1': 1, 'claude-opus-5-5': 1 });
  assert.equal(r.firstUserText.startsWith('ROUND: 1'), true, 'tool_result user lines are not the prompt');
});

test('no assistant messages at all fails', () => {
  const r = prove('empty');
  assert.equal(r.ok, false);
  assert.deepEqual(r.errors, ['no assistant messages']);
  assert.equal(r.assistantLines, 0);
  assert.equal(r.finalAssistantText, '');
  assert.equal(r.finalStopReason, null);
});

test('a malformed line is reported with its 1-based number', () => {
  const r = prove('malformed');
  assert.equal(r.ok, false);
  assert.deepEqual(r.errors, ['unparseable line 2']);
  assert.equal(r.assistantLines, 2, 'good lines are still counted');
});

test('a final message cut off by max_tokens is incomplete', () => {
  const r = prove('truncated');
  assert.equal(r.ok, false);
  assert.deepEqual(r.errors, ['final message incomplete (stop_reason max_tokens)']);
  assert.equal(r.finalStopReason, 'max_tokens');
});

test('a per-call model override in meta fails unless it is the expected one', () => {
  const meta = read('fable-ok-override.meta.json');
  const bad = prove('fable-ok', { metaText: meta });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.errors, ['per-call model override present: claude-nonexistent-0']);
  const expected = prove('fable-ok', { metaText: meta, expectMetaModel: 'claude-nonexistent-0' });
  assert.deepEqual(expected.errors, []);
  assert.equal(expected.ok, true);
  const other = prove('fable-ok', { metaText: meta, expectMetaModel: 'claude-something-else' });
  assert.deepEqual(other.errors, ['per-call model override present: claude-nonexistent-0']);
});

// ---------- proveModel: fail-closed edge shapes ----------

test('unparseable, non-object, or missing meta fails closed', () => {
  const lines = [userLine('p'), asstLine({ content: text('ok') })];
  assert.deepEqual(proveText(lines, { metaText: '{nope' }).errors, ['unparseable meta']);
  assert.deepEqual(proveText(lines, { metaText: '[]' }).errors, ['unparseable meta']);
  assert.deepEqual(proveText(lines, { metaText: 'null' }).errors, ['unparseable meta']);
  assert.deepEqual(proveText(lines, { metaText: null }).errors, ['meta missing']);
  assert.deepEqual(proveText(lines, { metaText: undefined }).errors, ['meta missing']);
});

test('meta with "model": null still counts as an override by default', () => {
  const lines = [userLine('p'), asstLine({ content: text('ok') })];
  const r = proveText(lines, { metaText: '{"model":null}' });
  assert.deepEqual(r.errors, ['per-call model override present: null']);
});

test('valid JSON that is not an object is an unparseable line', () => {
  const r = proveText([userLine('p'), '42', 'null', '[1]', asstLine({ content: text('ok') })]);
  assert.deepEqual(r.errors, ['unparseable line 2', 'unparseable line 3', 'unparseable line 4']);
});

test('blank lines and CRLF are tolerated and do not shift line numbers', () => {
  const jsonlText = [userLine('p'), '', asstLine({ effort: 'low', content: text('ok') })].join('\r\n') + '\r\n';
  const r = proveModel({ jsonlText, metaText: GOOD_META, expectModelPrefix: 'claude-fable-', expectEffort: 'high' });
  assert.deepEqual(r.errors, ['unexpected effort low on line 3']);
});

test('an error key on an otherwise normal Fable line fails, even when null', () => {
  const l1 = asstLine({ content: text('ok'), error: 'rate_limit' });
  const l2 = asstLine({ id: 'msg_2', content: text('ok'), error: null });
  const r = proveText([userLine('p'), l1, l2]);
  assert.deepEqual(r.errors, ['API error on line 2: rate_limit', 'API error on line 3: null']);
});

test('isApiErrorMessage without an error key still fails', () => {
  const r = proveText([userLine('p'), asstLine({ content: text('ok'), isApiErrorMessage: true })]);
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /^API error on line 2: /);
});

test('a missing message.model counts as an unexpected model', () => {
  const l = JSON.stringify({ type: 'assistant', effort: 'high', message: { stop_reason: 'end_turn', content: text('x') } });
  const r = proveText([userLine('p'), l]);
  assert.ok(r.errors.includes('unexpected model undefined on line 2'), r.errors.join('|'));
});

test('only the last message id group decides completeness and ruling text', () => {
  const lines = [
    userLine('p'),
    asstLine({ id: 'msg_1', stop: 'tool_use', content: [{ type: 'tool_use', id: 't', name: 'Read', input: {} }] }),
    userLine([{ type: 'tool_result', tool_use_id: 't', content: 'x' }]),
    asstLine({ id: 'msg_2', stop: null, content: [{ type: 'thinking', thinking: 'hm' }] }),
    asstLine({ id: 'msg_2', stop: null, content: text('part one') }),
    asstLine({ id: 'msg_2', stop: 'end_turn', content: text('part two') }),
  ];
  const r = proveText(lines);
  assert.deepEqual(r.errors, []);
  assert.equal(r.finalAssistantText, 'part one\npart two');
  assert.equal(r.finalStopReason, 'end_turn');
  assert.equal(r.assistantLines, 4);
});

test('the stop_reason of the LAST line of the final group is the one that counts', () => {
  const lines = [
    userLine('p'),
    asstLine({ id: 'msg_2', stop: 'end_turn', content: text('a') }),
    asstLine({ id: 'msg_2', stop: 'max_tokens', content: text('b') }),
  ];
  const r = proveText(lines);
  assert.deepEqual(r.errors, ['final message incomplete (stop_reason max_tokens)']);
  assert.equal(r.finalStopReason, 'max_tokens');
  const ok = proveText([userLine('p'), asstLine({ id: 'msg_2', stop: 'max_tokens', content: text('a') }), asstLine({ id: 'msg_2', stop: 'end_turn', content: text('b') })]);
  assert.deepEqual(ok.errors, [], 'an earlier line of the group is not consulted');
});

test('a final message ending in tool_use (no answer yet) is incomplete and not a text answer', () => {
  const r = proveText([userLine('p'), asstLine({ stop: 'tool_use', content: [{ type: 'tool_use', id: 't', name: 'Read', input: {} }] })]);
  assert.deepEqual(r.errors, ['final message incomplete (stop_reason tool_use)', 'final message is not a text answer']);
});

test('a final assistant line without a message id is treated as a group of one', () => {
  const noId = JSON.stringify({ type: 'assistant', effort: 'high', message: { model: 'claude-fable-5-1', stop_reason: 'end_turn', content: text('only me') } });
  const noId2 = JSON.stringify({ type: 'assistant', effort: 'high', message: { model: 'claude-fable-5-1', stop_reason: 'end_turn', content: text('and me') } });
  const r = proveText([userLine('p'), noId, noId2]);
  assert.equal(r.finalAssistantText, 'and me');
});

test('prompt may be an array of text blocks; non-text blocks are ignored', () => {
  const r = proveText([
    userLine([{ type: 'text', text: 'ROUND: 2' }, { type: 'image', source: {} }, { type: 'text', text: 'INPUT-DIGEST: ff' }]),
    asstLine({ content: text('ok') }),
  ]);
  assert.equal(r.firstUserText, 'ROUND: 2\nINPUT-DIGEST: ff');
});

test('ignores system and attachment lines', () => {
  const r = proveText([
    JSON.stringify({ type: 'system', subtype: 'x' }),
    userLine('p'),
    JSON.stringify({ type: 'attachment', attachment: { type: 'x' } }),
    asstLine({ content: text('ok') }),
  ]);
  assert.deepEqual(r.errors, []);
  assert.equal(r.firstUserText, 'p');
});

test('empty or missing expectations fail closed instead of proving nothing', () => {
  const lines = [userLine('p'), asstLine({ content: text('ok') })];
  const a = proveText(lines, { expectModelPrefix: '' });
  assert.equal(a.ok, false);
  assert.ok(a.errors.includes('invalid expectation: expectModelPrefix'));
  const b = proveText(lines, { expectEffort: undefined });
  assert.equal(b.ok, false);
  assert.ok(b.errors.includes('invalid expectation: expectEffort'));
});

test('non-string transcript text fails closed', () => {
  const r = proveModel({ jsonlText: undefined, metaText: GOOD_META, expectModelPrefix: 'claude-fable-', expectEffort: 'high' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.includes('transcript text missing'));
});

test('all failures are collected together', () => {
  const r = proveText(
    [
      userLine('p'),
      'garbage',
      asstLine({ model: 'claude-opus-5-5', effort: 'low', stop: 'max_tokens', content: text('x'), error: 'boom' }),
    ],
    { metaText: '{"model":"m"}' }
  );
  assert.deepEqual(r.errors, [
    'unparseable line 2',
    'unexpected model claude-opus-5-5 on line 3',
    'API error on line 3: boom',
    'unexpected effort low on line 3',
    'per-call model override present: m',
    'final message incomplete (stop_reason max_tokens)',
  ]);
});

// ---------- findSubagentTranscript ----------

const tmpRoots = [];
const mkRoot = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-transcripts-'));
  tmpRoots.push(dir);
  return dir;
};
after(() => {
  for (const d of tmpRoots) fs.rmSync(d, { recursive: true, force: true });
});

function put(root, project, session, agentId, { meta, jsonl = '{}\n', ageMs = 0, now = Date.now() } = {}) {
  const dir = path.join(root, project, session, 'subagents');
  fs.mkdirSync(dir, { recursive: true });
  const jsonlPath = path.join(dir, `agent-${agentId}.jsonl`);
  const metaPath = path.join(dir, `agent-${agentId}.meta.json`);
  const when = new Date(now - ageMs);
  fs.writeFileSync(jsonlPath, jsonl);
  fs.utimesSync(jsonlPath, when, when);
  if (meta !== undefined) {
    fs.writeFileSync(metaPath, typeof meta === 'string' ? meta : JSON.stringify(meta));
    fs.utimesSync(metaPath, when, when);
  }
  return { jsonlPath, metaPath };
}
const metaFor = (description) => ({ agentType: 'arbiter', description, toolUseId: 'toolu_1', spawnDepth: 1 });
const TAG = 'pipeline-arbiter R1 ab12cd34';
const H = 3600e3;

test('finds a transcript by agent id across projects and sessions', () => {
  const root = mkRoot();
  put(root, '-Users-x-proj-a', 'sess-1', 'aaaa1111', { meta: metaFor('one') });
  const want = put(root, '-Users-x-proj-b', 'sess-2', 'bbbb2222', { meta: metaFor('two') });
  const r = findSubagentTranscript({ agentId: 'bbbb2222', projectsDir: root });
  assert.equal(r.jsonlPath, want.jsonlPath);
  assert.equal(r.metaPath, want.metaPath);
  assert.equal(r.meta.description, 'two');
});

test('by agent id the newest file wins when two sessions hold the same id', () => {
  const root = mkRoot();
  const now = Date.now();
  put(root, 'p', 'old', 'cccc3333', { meta: metaFor('old'), ageMs: 2 * H, now });
  const fresh = put(root, 'p', 'new', 'cccc3333', { meta: metaFor('new'), ageMs: 1000, now });
  const r = findSubagentTranscript({ agentId: 'cccc3333', projectsDir: root });
  assert.equal(r.jsonlPath, fresh.jsonlPath);
  assert.equal(r.meta.description, 'new');
});

test('by agent id with no meta file still finds the transcript, meta is null', () => {
  const root = mkRoot();
  const want = put(root, 'p', 's', 'dddd4444');
  const r = findSubagentTranscript({ agentId: 'dddd4444', projectsDir: root });
  assert.equal(r.jsonlPath, want.jsonlPath);
  assert.equal(r.metaPath, null);
  assert.equal(r.meta, null);
});

test('by agent id with a garbage meta returns the path and a null meta', () => {
  const root = mkRoot();
  const want = put(root, 'p', 's', 'eeee5555', { meta: 'not json{' });
  const r = findSubagentTranscript({ agentId: 'eeee5555', projectsDir: root });
  assert.equal(r.jsonlPath, want.jsonlPath);
  assert.equal(r.metaPath, want.metaPath);
  assert.equal(r.meta, null);
});

test('returns null when the agent id or tag is absent, or the projects dir is missing', () => {
  const root = mkRoot();
  put(root, 'p', 's', 'ffff6666', { meta: metaFor(TAG) });
  assert.equal(findSubagentTranscript({ agentId: 'nope0000', projectsDir: root }), null);
  assert.equal(findSubagentTranscript({ tag: 'pipeline-arbiter R9 00000000', projectsDir: root }), null);
  assert.equal(findSubagentTranscript({ agentId: 'ffff6666', projectsDir: path.join(root, 'missing') }), null);
  assert.equal(findSubagentTranscript({ projectsDir: root }), null, 'neither agentId nor tag');
});

test('an agent id that could escape the subagents directory is refused', () => {
  const root = mkRoot();
  put(root, 'p', 's', 'gggg7777', { meta: metaFor('x') });
  // Lexical normalisation would turn this into <session>/escape.jsonl, a file that does exist.
  fs.writeFileSync(path.join(root, 'p', 's', 'escape.jsonl'), '{}\n');
  assert.equal(findSubagentTranscript({ agentId: 'x/../../escape', projectsDir: root }), null);
  assert.equal(findSubagentTranscript({ agentId: '../agent-gggg7777', projectsDir: root }), null);
  assert.equal(findSubagentTranscript({ agentId: '', projectsDir: root }), null);
});

test('by tag finds the newest meta whose description matches exactly', () => {
  const root = mkRoot();
  const now = Date.now();
  put(root, 'p', 's1', 'tag10001', { meta: metaFor(TAG), ageMs: 3 * H, now });
  const fresh = put(root, 'p', 's2', 'tag10002', { meta: metaFor(TAG), ageMs: 1 * H, now });
  put(root, 'p', 's2', 'tag10003', { meta: metaFor(TAG + 'x'), ageMs: 1000, now });
  put(root, 'p', 's2', 'tag10004', { meta: metaFor('pipeline-arbiter R1 ab12cd3'), ageMs: 1000, now });
  put(root, 'p', 's2', 'tag10005', { meta: metaFor('pipeline-judge R1 ab12cd34'), ageMs: 1000, now });
  const r = findSubagentTranscript({ tag: TAG, projectsDir: root, now });
  assert.equal(r.jsonlPath, fresh.jsonlPath);
  assert.equal(r.metaPath, fresh.metaPath);
  assert.equal(r.meta.description, TAG);
});

test('by tag ignores meta files older than maxAgeMs', () => {
  const root = mkRoot();
  const now = Date.now();
  put(root, 'p', 's', 'old10001', { meta: metaFor(TAG), ageMs: 7 * H, now });
  assert.equal(findSubagentTranscript({ tag: TAG, projectsDir: root, now }), null, 'default window is 6 h');
  const wide = findSubagentTranscript({ tag: TAG, projectsDir: root, now, maxAgeMs: 8 * H });
  assert.ok(wide, 'a wider window finds it');
  assert.equal(findSubagentTranscript({ tag: TAG, projectsDir: root, now, maxAgeMs: 1 * H }), null);
});

test('by tag skips unreadable and garbage meta files instead of throwing', () => {
  const root = mkRoot();
  const now = Date.now();
  const good = put(root, 'p', 's', 'good0001', { meta: metaFor(TAG), ageMs: 2 * H, now });
  put(root, 'p', 's', 'junk0001', { meta: 'not json{', ageMs: 1000, now });
  put(root, 'p', 's', 'junk0002', { meta: '[]', ageMs: 1000, now });
  put(root, 'p', 's', 'junk0003', { meta: 'null', ageMs: 1000, now });
  put(root, 'p', 's', 'junk0004', { meta: JSON.stringify({ description: 42 }), ageMs: 1000, now });
  // A directory named like a meta file: stat succeeds, read throws EISDIR.
  fs.mkdirSync(path.join(root, 'p', 's', 'subagents', 'agent-dir00001.meta.json'));
  const r = findSubagentTranscript({ tag: TAG, projectsDir: root, now });
  assert.equal(r.jsonlPath, good.jsonlPath);
});

test('by tag returns the transcript path even if the jsonl has not been written yet', () => {
  const root = mkRoot();
  const dir = path.join(root, 'p', 's', 'subagents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'agent-pend0001.meta.json'), JSON.stringify(metaFor(TAG)));
  const r = findSubagentTranscript({ tag: TAG, projectsDir: root });
  assert.equal(r.jsonlPath, path.join(dir, 'agent-pend0001.jsonl'));
  assert.throws(() => fs.readFileSync(r.jsonlPath), /ENOENT/, 'callers must read it inside try/catch');
});

// ---------- extractJsonBlock ----------

test('extractJsonBlock picks the LAST json fenced block', () => {
  const t = 'Draft:\n```json\n{"v":1}\n```\nFinal:\n```json\n{"v":2}\n```\nThanks.';
  assert.deepEqual(extractJsonBlock(t), { v: 2 });
});

test('extractJsonBlock prefers a json block over a later plain block', () => {
  const t = '```json\n{"v":1}\n```\n```\nnot json at all\n```';
  assert.deepEqual(extractJsonBlock(t), { v: 1 });
});

test('extractJsonBlock falls back to the last plain fenced block, then bare JSON', () => {
  assert.deepEqual(extractJsonBlock('```\n{"v":3}\n```'), { v: 3 });
  assert.deepEqual(extractJsonBlock('  \n{"v":4}\n\n'), { v: 4 });
  assert.deepEqual(extractJsonBlock('{"rulings":[]}'), { rulings: [] });
});

test('extractJsonBlock handles CRLF, uppercase info strings and backticks inside strings', () => {
  assert.deepEqual(extractJsonBlock('```JSON\r\n{"v":5}\r\n```\r\n'), { v: 5 });
  assert.deepEqual(extractJsonBlock('```json\n{"code":"use ```x``` here"}\n```'), { code: 'use ```x``` here' });
});

test('extractJsonBlock throws on prose, empty text, and non-string input', () => {
  assert.throws(() => extractJsonBlock('I think the finding is valid, so ACCEPT.'), /no JSON found/);
  assert.throws(() => extractJsonBlock(''), /no JSON found/);
  assert.throws(() => extractJsonBlock(undefined), /no JSON found/);
  assert.throws(() => extractJsonBlock(null), /no JSON found/);
});

test('extractJsonBlock does not fall through to an earlier block when the last json block is broken', () => {
  const t = '```json\n{"v":1}\n```\nNow the real one:\n```json\n{"v":\n```';
  assert.throws(() => extractJsonBlock(t), /no JSON found/);
});

test('extractJsonBlock ignores an unclosed fence (truncated output)', () => {
  assert.throws(() => extractJsonBlock('```json\n{"v":1'), /no JSON found/);
});

// ---------- hardening round ----------

const TOOL_USE = [{ type: 'tool_use', id: 't', name: 'Read', input: {} }];
const TOOL_RESULT = [{ type: 'tool_result', tool_use_id: 't', content: 'x' }];
const MULTI = 'multiple prompts (agent was resumed); ruling cannot be bound to one input';

test('a non-Fable MIDDLE assistant line fails even with Fable on the first and last lines', () => {
  const r = proveText([
    userLine('p'),
    asstLine({ id: 'msg_1', stop: 'tool_use', content: TOOL_USE }),
    userLine(TOOL_RESULT),
    asstLine({ id: 'msg_2', model: 'claude-opus-5-5', stop: 'tool_use', content: TOOL_USE }),
    userLine(TOOL_RESULT),
    asstLine({ id: 'msg_3', content: text('done') }),
  ]);
  assert.equal(r.ok, false);
  assert.deepEqual(r.errors, ['unexpected model claude-opus-5-5 on line 4']);
  assert.deepEqual(r.models, { 'claude-fable-5-1': 2, 'claude-opus-5-5': 1 });
});

test('a wrong-effort or API-error MIDDLE assistant line fails too', () => {
  const mid = (extra) => [
    userLine('p'),
    asstLine({ id: 'msg_1', stop: 'tool_use', content: TOOL_USE }),
    userLine(TOOL_RESULT),
    asstLine({ id: 'msg_2', stop: 'tool_use', content: TOOL_USE, ...extra }),
    userLine(TOOL_RESULT),
    asstLine({ id: 'msg_3', content: text('done') }),
  ];
  assert.deepEqual(proveText(mid({ effort: 'medium' })).errors, ['unexpected effort medium on line 4']);
  assert.deepEqual(proveText(mid({ perTurnEffort: 'low' })).errors, ['unexpected perTurnEffort low on line 4']);
  assert.deepEqual(proveText(mid({ apiErrorStatus: 529 })).errors, ['API error on line 4: apiErrorStatus 529']);
});

test('a resumed transcript with two prompt turns cannot be bound to one input', () => {
  const r = proveText([
    userLine('first prompt'),
    asstLine({ id: 'msg_1', content: text('a') }),
    userLine('second prompt'),
    asstLine({ id: 'msg_2', content: text('b') }),
  ]);
  assert.equal(r.ok, false);
  assert.deepEqual(r.errors, [MULTI]);
  assert.equal(r.firstUserText, 'first prompt', 'firstUserText stays the first');
});

test('tool_result-only user lines are not prompt turns', () => {
  const r = proveText([
    userLine('p'),
    asstLine({ id: 'msg_1', stop: 'tool_use', content: TOOL_USE }),
    userLine(TOOL_RESULT),
    asstLine({ id: 'msg_2', stop: 'tool_use', content: TOOL_USE }),
    userLine(TOOL_RESULT),
    asstLine({ id: 'msg_3', content: text('done') }),
  ]);
  assert.deepEqual(r.errors, []);
});

test('a second prompt as a text-block array, or text beside a tool_result, also counts', () => {
  const second = (content) => proveText([userLine('p'), asstLine({ content: text('a') }), userLine(content), asstLine({ id: 'm2', content: text('b') })]);
  assert.deepEqual(second([{ type: 'text', text: 'again' }]).errors, [MULTI]);
  assert.deepEqual(second([...TOOL_RESULT, { type: 'text', text: 'and more' }]).errors, [MULTI]);
  assert.deepEqual(second([{ type: 'image', source: {} }]).errors, [], 'no text block, no prompt');
});

test('harness-injected isMeta lines without an origin are not prompts; external or unmarked ones are', () => {
  const second = (extra) => proveText([userLine('p'), asstLine({ content: text('a') }), userLine('<system-reminder>x</system-reminder>', extra), asstLine({ id: 'm2', content: text('b') })]);
  assert.deepEqual(second({ isMeta: true }).errors, [], 'real transcripts carry many reminder lines like this');
  assert.deepEqual(second({ isMeta: true, origin: { kind: 'coordinator' } }).errors, [MULTI], 'a message from another agent');
  assert.deepEqual(second({ isMeta: 'true' }).errors, [MULTI], 'only a literal true is excused');
  assert.deepEqual(second({ isMeta: false }).errors, [MULTI]);
});

test('firstUserText skips a leading harness reminder and returns the real prompt', () => {
  const r = proveText([userLine('<system-reminder>ctx</system-reminder>', { isMeta: true }), userLine('ROUND: 1'), asstLine({ content: text('ok') })]);
  assert.deepEqual(r.errors, []);
  assert.equal(r.firstUserText, 'ROUND: 1');
});

test('expectAgentType must equal meta.agentType when given', () => {
  const lines = [userLine('p'), asstLine({ content: text('ok') })];
  assert.deepEqual(proveText(lines, { metaText: '{"agentType":"arbiter"}', expectAgentType: 'arbiter' }).errors, []);
  assert.deepEqual(proveText(lines, { metaText: '{"agentType":"judge"}', expectAgentType: 'arbiter' }).errors, ['unexpected agent type judge']);
  assert.deepEqual(proveText(lines, { metaText: '{}', expectAgentType: 'arbiter' }).errors, ['unexpected agent type undefined']);
  assert.deepEqual(proveText(lines, { metaText: '{"agentType":"judge"}' }).errors, [], 'not checked unless asked');
  assert.deepEqual(proveText(lines, { metaText: '{"agentType":"arbiter"}', expectAgentType: '' }).errors, ['invalid expectation: expectAgentType']);
  assert.equal(prove('fable-ok', { expectAgentType: 'arbiter' }).ok, true);
  assert.deepEqual(prove('fable-ok', { expectAgentType: 'verifier' }).errors, ['unexpected agent type arbiter']);
});

test('perTurnEffort, when present and non-null, must also equal the expected effort', () => {
  const one = (extra) => proveText([userLine('p'), asstLine({ content: text('ok'), ...extra })]);
  assert.deepEqual(one({ perTurnEffort: 'low' }).errors, ['unexpected perTurnEffort low on line 2']);
  assert.deepEqual(one({ perTurnEffort: 'high' }).errors, []);
  assert.deepEqual(one({ perTurnEffort: null }).errors, [], 'null is the shape of a turn with no override');
  assert.deepEqual(one({}).errors, []);
});

test('API-error markers fail on their own: odd isApiErrorMessage values and any apiErrorStatus', () => {
  const one = (extra) => proveText([userLine('p'), asstLine({ content: text('ok'), ...extra })]);
  assert.match(one({ isApiErrorMessage: 'true' }).errors[0], /^API error on line 2: /);
  assert.match(one({ isApiErrorMessage: 1 }).errors[0], /^API error on line 2: /);
  assert.match(one({ isApiErrorMessage: null }).errors[0], /^API error on line 2: /);
  assert.deepEqual(one({ apiErrorStatus: 529 }).errors, ['API error on line 2: apiErrorStatus 529']);
  assert.equal(one({ apiErrorStatus: null }).ok, false);
  assert.deepEqual(one({ isApiErrorMessage: false }).errors, [], 'an explicit false is healthy');
  assert.deepEqual(one({ isApiErrorMessage: true, error: 'overloaded', apiErrorStatus: 529 }).errors, ['API error on line 2: overloaded'], 'one error per line');
});

test('a final message whose text is blank is a failure', () => {
  assert.deepEqual(proveText([userLine('p'), asstLine({ content: text('  \n\t') })]).errors, ['final message has no text']);
  assert.deepEqual(proveText([userLine('p'), asstLine({ stop: 'end_turn', content: text('') })]).errors, ['final message has no text']);
  assert.deepEqual(proveText([userLine('p'), asstLine({ content: text('x') })]).errors, []);
});

test('models and efforts counts survive keys that collide with Object.prototype', () => {
  const lines = [
    userLine('p'),
    asstLine({ id: 'm1', model: '__proto__', effort: 'constructor', stop: 'tool_use', content: TOOL_USE }),
    userLine(TOOL_RESULT),
    asstLine({ id: 'm2', model: 'constructor', effort: 'constructor', stop: 'tool_use', content: TOOL_USE }),
    userLine(TOOL_RESULT),
    asstLine({ id: 'm3', model: 'constructor', effort: 'toString', content: text('x') }),
  ];
  const r = proveText(lines);
  assert.equal(Object.hasOwn(r.models, '__proto__'), true);
  assert.equal(Object.getOwnPropertyDescriptor(r.models, '__proto__').value, 1);
  assert.equal(r.models.constructor, 2);
  assert.equal(r.efforts.constructor, 2);
  assert.equal(r.efforts.toString, 1);
  assert.deepEqual(Object.keys(r.models).sort(), ['__proto__', 'constructor']);
  assert.equal(r.ok, false);
});

test('equal mtimes tie-break on path, independent of creation order (by agent id)', () => {
  const now = Date.now();
  for (const order of [['sess-a', 'sess-b'], ['sess-b', 'sess-a']]) {
    const root = mkRoot();
    const made = {};
    for (const s of order) made[s] = put(root, 'p', s, 'tie10001', { meta: metaFor(s), ageMs: 1000, now });
    const r = findSubagentTranscript({ agentId: 'tie10001', projectsDir: root, now });
    assert.equal(r.jsonlPath, made['sess-b'].jsonlPath, `created ${order.join(',')}`);
  }
});

test('equal mtimes tie-break on path, independent of creation order (by tag)', () => {
  const now = Date.now();
  for (const order of [['sess-a', 'sess-b'], ['sess-b', 'sess-a']]) {
    const root = mkRoot();
    const made = {};
    for (const s of order) made[s] = put(root, 'p', s, `tie2000${s.slice(-1)}`, { meta: metaFor(TAG), ageMs: 1000, now });
    const r = findSubagentTranscript({ tag: TAG, projectsDir: root, now });
    assert.equal(r.metaPath, made['sess-b'].metaPath, `created ${order.join(',')}`);
  }
});

test('files dated in the future are ignored (beyond a 60 s clock-skew allowance)', () => {
  const now = Date.now();
  const root = mkRoot();
  put(root, 'p', 'future', 'fut10001', { meta: metaFor(TAG), ageMs: -120e3, now });
  assert.equal(findSubagentTranscript({ tag: TAG, projectsDir: root, now }), null, 'tag: future meta');
  assert.equal(findSubagentTranscript({ agentId: 'fut10001', projectsDir: root, now }), null, 'agentId: future jsonl');
  const nearRoot = mkRoot();
  const near = put(nearRoot, 'p', 'near', 'fut10002', { meta: metaFor(TAG), ageMs: -30e3, now });
  assert.equal(findSubagentTranscript({ tag: TAG, projectsDir: nearRoot, now }).metaPath, near.metaPath, '30 s skew is tolerated');
  // A future-dated stale copy must not shadow the legitimate newest one.
  const root2 = mkRoot();
  put(root2, 'p', 'future', 'fut10003', { meta: metaFor(TAG), ageMs: -10 * 60e3, now });
  const ok = put(root2, 'p', 'ok', 'fut10004', { meta: metaFor(TAG), ageMs: 1000, now });
  assert.equal(findSubagentTranscript({ tag: TAG, projectsDir: root2, now }).metaPath, ok.metaPath);
});

test('bad call shapes and non-finite numbers return null instead of throwing', () => {
  const root = mkRoot();
  const now = Date.now();
  put(root, 'p', 's', 'bad10001', { meta: metaFor(TAG), now, ageMs: 1000 });
  for (const bad of [null, undefined, 'x', 42, [], () => {}]) {
    assert.equal(findSubagentTranscript(bad), null, String(bad));
  }
  for (const badNum of [NaN, Infinity, -Infinity, null, '1', {}]) {
    assert.equal(findSubagentTranscript({ agentId: 'bad10001', projectsDir: root, now: badNum }), null, `agentId now=${String(badNum)}`);
    assert.equal(findSubagentTranscript({ tag: TAG, projectsDir: root, now: badNum }), null, `tag now=${String(badNum)}`);
    assert.equal(findSubagentTranscript({ agentId: 'bad10001', projectsDir: root, maxAgeMs: badNum }), null, `agentId maxAgeMs=${String(badNum)}`);
    assert.equal(findSubagentTranscript({ tag: TAG, projectsDir: root, maxAgeMs: badNum }), null, `tag maxAgeMs=${String(badNum)}`);
  }
  for (const badDir of [null, 42, '', {}]) {
    assert.equal(findSubagentTranscript({ tag: TAG, projectsDir: badDir }), null, `projectsDir=${String(badDir)}`);
  }
  for (const badId of [42, {}, [], true]) {
    assert.equal(findSubagentTranscript({ agentId: badId, projectsDir: root }), null);
  }
  assert.equal(findSubagentTranscript({ tag: 42, projectsDir: root }), null);
  assert.ok(findSubagentTranscript({ tag: TAG, projectsDir: root, now }), 'sanity: valid input still finds it');
});

// ---------- rule 7: streaming null stop_reason ----------

const THINKING = [{ type: 'thinking', thinking: 'hmm', signature: 's' }];

const ANSWER = '```json\n{"rulings":[]}\n```';

test('a null or absent stop_reason is accepted only for the last line of the transcript holding a complete JSON answer, and is recorded', () => {
  const nul = proveText([userLine('p'), asstLine({ stop: null, content: text(ANSWER) })]);
  assert.deepEqual(nul.errors, []);
  assert.equal(nul.ok, true);
  assert.equal(nul.finalStopReason, null);
  assert.equal(nul.stopReasonMissing, true);
  assert.equal(nul.finalAssistantText, ANSWER);
  const absent = JSON.stringify({ type: 'assistant', effort: 'high', message: { model: 'claude-fable-5-1', id: 'msg_1', role: 'assistant', content: text(ANSWER) } });
  const r = proveText([userLine('p'), absent]);
  assert.deepEqual(r.errors, []);
  assert.equal(r.finalStopReason, null);
  assert.equal(r.stopReasonMissing, true);
  const grouped = proveText([userLine('p'), asstLine({ stop: null, content: THINKING }), asstLine({ stop: null, content: text(ANSWER) })]);
  assert.deepEqual(grouped.errors, []);
  const real = proveText([userLine('p'), asstLine({ stop: 'end_turn', content: text('answer') })]);
  assert.equal(real.stopReasonMissing, false, 'end_turn is a real stop_reason');
  assert.deepEqual(real.errors, []);
});

test('a final message with no stop_reason and no complete JSON answer is refused', () => {
  const prose = proveText([userLine('p'), asstLine({ stop: null, content: text('answer') })]);
  assert.equal(prose.ok, false);
  assert.deepEqual(prose.errors, ['final message has no stop_reason and carries no complete JSON answer (a truncated message cannot be ruled out)']);
  assert.equal(prose.stopReasonMissing, true);
  const cut = proveText([userLine('p'), asstLine({ stop: null, content: text('```json\\n{"rulings":[{"id":"R1-S1"') })]);
  assert.equal(cut.ok, false);
  assert.match(cut.errors.join(), /no complete JSON answer/);
  const array = proveText([userLine('p'), asstLine({ stop: null, content: text('[1,2]') })]);
  assert.equal(array.ok, false, 'a JSON answer must be an object');
});

test('a final message with no stop_reason that is not the last line of the transcript is refused', () => {
  const lines = [userLine('p'), asstLine({ stop: null, content: text(ANSWER) }), JSON.stringify({ type: 'system', subtype: 'note' })];
  const r = proveText(lines);
  assert.equal(r.ok, false);
  assert.deepEqual(r.errors, ['final message has no stop_reason and is not the last line of the transcript']);
  // The same transcript with a real end_turn is fine: the position rule is only for the missing stop_reason.
  assert.deepEqual(proveText([userLine('p'), asstLine({ stop: 'end_turn', content: text(ANSWER) }), JSON.stringify({ type: 'system', subtype: 'note' })]).errors, []);
  // Blank lines after the answer do not count as lines.
  assert.deepEqual(proveText([userLine('p'), asstLine({ stop: null, content: text(ANSWER) }), '', '  ']).errors, []);
});

test('any explicit stop_reason other than end_turn is incomplete', () => {
  for (const stop of ['max_tokens', 'refusal', 'stop_sequence', 'tool_use', 'pause_turn', 'model_context_window_exceeded', '', 0, false]) {
    const r = proveText([userLine('p'), asstLine({ stop, content: text('answer') })]);
    assert.deepEqual(r.errors, [`final message incomplete (stop_reason ${String(stop)})`], `stop_reason ${JSON.stringify(stop)}`);
    assert.equal(r.ok, false);
  }
});

test('a final group that ends without a text block is not an answer, even with a null stop_reason', () => {
  const toolUse = proveText([userLine('p'), asstLine({ stop: null, content: TOOL_USE })]);
  assert.ok(toolUse.errors.includes('final message is not a text answer'));
  const thinkingOnly = proveText([userLine('p'), asstLine({ stop: null, content: THINKING })]);
  assert.ok(thinkingOnly.errors.includes('final message is not a text answer'));
  const empty = proveText([userLine('p'), asstLine({ stop: 'end_turn', content: [] })]);
  assert.deepEqual(empty.errors, ['final message is not a text answer']);
  // The LAST line of the group is what must carry the text: text followed by a trailing thinking/tool_use line is not an answer.
  const textThenTool = proveText([userLine('p'), asstLine({ stop: null, content: text('draft') }), asstLine({ stop: null, content: TOOL_USE })]);
  assert.ok(textThenTool.errors.includes('final message is not a text answer'));
  const textThenThinking = proveText([userLine('p'), asstLine({ stop: null, content: text('draft') }), asstLine({ stop: 'end_turn', content: THINKING })]);
  assert.deepEqual(textThenThinking.errors, ['final message is not a text answer']);
  const mixed = proveText([userLine('p'), asstLine({ stop: null, content: [...THINKING, { type: 'text', text: ANSWER }] })]);
  assert.deepEqual(mixed.errors, [], 'text anywhere in the last line counts');
});

test('an incomplete stop_reason and a missing text answer are both reported', () => {
  const r = proveText([userLine('p'), asstLine({ stop: 'max_tokens', content: THINKING })]);
  assert.deepEqual(r.errors, ['final message incomplete (stop_reason max_tokens)', 'final message is not a text answer']);
});

test('a real-shaped interactive (cli) transcript with a null stop_reason proves ok', () => {
  assert.match(read('fable-cli-null-stop.jsonl'), /"entrypoint":"cli"/);
  assert.match(read('fable-cli-null-stop.jsonl'), /"stop_reason":null/);
  const r = prove('fable-cli-null-stop', { expectAgentType: 'arbiter' });
  assert.deepEqual(r.errors, []);
  assert.equal(r.ok, true);
  assert.deepEqual(r.models, { 'claude-fable-5-1': 2 });
  assert.deepEqual(r.efforts, { high: 2 });
  assert.equal(r.finalStopReason, null);
  assert.match(r.firstUserText, /^ROUND: 2\nINPUT-DIGEST: 0123456789abcdef/);
  assert.equal(extractJsonBlock(r.finalAssistantText).rulings[0].id, 'R2-B1');
});

test('a cli transcript cut off mid-answer fails the proof itself (no stop_reason, no complete JSON)', () => {
  const cut = proveText([userLine('p'), asstLine({ stop: null, content: text('```json\n{"rulings":[{"id":"R1-S1"') })]);
  assert.equal(cut.ok, false);
  assert.match(cut.errors.join(), /no complete JSON answer/);
  assert.throws(() => extractJsonBlock(cut.finalAssistantText), /no JSON found/);
});

// ---------- hand-back finals: the report is delivered by a SubagentHandback tool call, not a text message ----------

const HB_ID = 'toolu_hb';
const HB_MESSAGE = '```json\n{"rulings":[{"id":"R1-S1"}]}\n```\n\nFree prose after the fence.';
const hbBlock = ({ id = HB_ID, name = 'SubagentHandback', input = { message: HB_MESSAGE } } = {}) => [{ type: 'tool_use', id, name, input }];
const hbLine = ({ id = 'msg_hb', stop = null, toolId = HB_ID, name, input, content, ...rest } = {}) =>
  asstLine({ id, stop, content: content ?? hbBlock({ id: toolId, name, input }), ...rest });
const OMIT = Symbol('omit'); // a default parameter would swallow undefined
const ackLine = ({ toolUseId = HB_ID, isError, toolUseResult = { success: true, message: 'Report delivered to your caller.' }, toolEndsTurn = true, content } = {}) =>
  JSON.stringify({
    type: 'user',
    ...(toolEndsTurn === OMIT ? {} : { toolEndsTurn }),
    ...(toolUseResult === OMIT ? {} : { toolUseResult }),
    message: {
      role: 'user',
      content: content ?? [{ tool_use_id: toolUseId, type: 'tool_result', ...(isError === undefined ? {} : { is_error: isError }), content: [{ type: 'text', text: '{"success":true}' }] }],
    },
  });
const thinkingLine = (id = 'msg_hb') => asstLine({ id, stop: null, content: THINKING });
const handback = (over = {}) => [userLine('p'), thinkingLine(), hbLine(over)];

test('a hand-back final answer (thinking line, SubagentHandback call, acknowledgment) proves ok and delivers the message', () => {
  const r = proveText([...handback(), ackLine()]);
  assert.deepEqual(r.errors, []);
  assert.equal(r.ok, true);
  assert.equal(r.finalVia, 'handback');
  assert.equal(r.finalAssistantText, HB_MESSAGE);
  assert.equal(r.finalStopReason, null);
  assert.equal(r.stopReasonMissing, true);
  const rulings = extractJsonBlock(r.finalAssistantText);
  assert.equal(rulings.rulings[0].id, 'R1-S1', 'JSON is found even with prose after the fence');
});

test('a hand-back needs no JSON answer-check when stop_reason is tool_use, and a matching wireToolInputs entry is fine', () => {
  const message = 'plain prose, no JSON';
  const r = proveText([userLine('p'), hbLine({ stop: 'tool_use', input: { message }, wireToolInputs: { [HB_ID]: { message } } }), ackLine()]);
  assert.deepEqual(r.errors, []);
  assert.equal(r.finalVia, 'handback');
  assert.equal(r.finalAssistantText, message);
  assert.equal(r.stopReasonMissing, false);
  // Blank lines around the acknowledgment do not count as lines.
  assert.deepEqual(proveText([...handback(), '', ackLine(), '  ']).errors, []);
  // An entry for some other tool id says nothing about this call.
  assert.deepEqual(proveText([...handback({ wireToolInputs: { other: { message: 'x' } } }), ackLine()]).errors, []);
});

test('plain text finals report finalVia text; no final message reports null', () => {
  assert.equal(proveText([userLine('p'), asstLine({ content: text('answer') })]).finalVia, 'text');
  assert.equal(proveText([userLine('p'), asstLine({ stop: null, content: text(ANSWER) })]).finalVia, 'text');
  assert.equal(proveText([userLine('p'), asstLine({ stop: 'max_tokens', content: text('answer') })]).finalVia, null);
  assert.equal(proveText([userLine('p')]).finalVia, null);
  assert.equal(proveText([userLine('p'), asstLine({ stop: null, content: text('no json') })]).finalVia, null);
});

function refused(lines, pattern, extra) {
  const r = proveText(lines, extra);
  assert.equal(r.ok, false, `expected refusal for ${pattern}`);
  assert.equal(r.finalVia, null);
  assert.ok(r.errors.some((e) => pattern.test(e)), `${pattern} not in: ${r.errors.join(' | ')}`);
  return r;
}

test('hand-back rule 1: the closing line must be exactly one SubagentHandback tool_use block', () => {
  const wrongName = refused([userLine('p'), hbLine({ name: 'SendMessage' }), ackLine()], /not a text answer/);
  assert.equal(wrongName.finalAssistantText, '');
  refused([userLine('p'), hbLine({ content: [{ type: 'text', text: ANSWER }, ...hbBlock()] }), ackLine()], /hand-back must be the only content block/);
  refused([userLine('p'), hbLine({ content: [...hbBlock(), { type: 'text', text: ANSWER }] }), ackLine()], /hand-back must be the only content block/);
  refused([userLine('p'), hbLine({ content: [...hbBlock(), ...hbBlock({ id: 'toolu_2' })] }), ackLine()], /hand-back must be the only content block/);
  refused([userLine('p'), hbLine({ toolId: '' }), ackLine({ toolUseId: '' })], /hand-back tool_use has no id/);
  // The call in an earlier line of the same message, followed by a thinking line, is not a closing hand-back.
  refused([userLine('p'), hbLine(), thinkingLine(), ackLine()], /hand-back must be the only content block/);
});

test('hand-back rule 2: input is exactly {message: non-empty string}', () => {
  const E = /hand-back input must be/;
  refused([userLine('p'), hbLine({ input: { message: HB_MESSAGE, extra: 1 } }), ackLine()], E);
  refused([userLine('p'), hbLine({ input: { message: '   \n' } }), ackLine()], E);
  refused([userLine('p'), hbLine({ input: { message: '' } }), ackLine()], E);
  refused([userLine('p'), hbLine({ input: { message: 42 } }), ackLine()], E);
  refused([userLine('p'), hbLine({ input: {} }), ackLine()], E);
  refused([userLine('p'), hbLine({ input: [HB_MESSAGE] }), ackLine()], E);
  refused([userLine('p'), hbLine({ input: HB_MESSAGE }), ackLine()], E);
  refused([userLine('p'), hbLine({ input: null }), ackLine()], E);
  const r = refused([userLine('p'), hbLine({ input: { message: HB_MESSAGE, extra: 1 } }), ackLine()], E);
  assert.equal(r.finalAssistantText, '', 'an invalid hand-back delivers nothing');
});

test('hand-back rule 3: a wireToolInputs entry for the call must equal its input', () => {
  const E = /hand-back input differs from its wire input/;
  refused([userLine('p'), hbLine({ wireToolInputs: { [HB_ID]: { message: HB_MESSAGE + ' tampered' } } }), ackLine()], E);
  refused([userLine('p'), hbLine({ wireToolInputs: { [HB_ID]: { message: HB_MESSAGE, extra: true } } }), ackLine()], E);
  refused([userLine('p'), hbLine({ wireToolInputs: { [HB_ID]: 'x' } }), ackLine()], E);
  refused([userLine('p'), hbLine({ wireToolInputs: 'nope' }), ackLine()], /hand-back wireToolInputs is not an object/);
});

test('hand-back rule 4: stop_reason must be null/absent or tool_use', () => {
  for (const stop of ['max_tokens', 'end_turn', 'refusal', '', 0, false]) {
    refused([userLine('p'), hbLine({ stop }), ackLine()], new RegExp(`final message incomplete \\(stop_reason ${String(stop)}\\)`));
  }
  const absent = JSON.stringify({ type: 'assistant', effort: 'high', message: { model: 'claude-fable-5-1', id: 'msg_hb', role: 'assistant', content: hbBlock() } });
  assert.deepEqual(proveText([userLine('p'), absent, ackLine()]).errors, []);
});

test('hand-back rule 5: exactly one acknowledgment line, the last, closing this very call', () => {
  refused([...handback()], /hand-back not acknowledged/);
  refused([...handback(), ackLine({ toolUseId: 'toolu_other' })], /hand-back acknowledgment invalid: tool_result is not for this call/);
  refused([...handback(), ackLine({ isError: true })], /hand-back acknowledgment invalid: tool_result is an error/);
  refused([...handback(), ackLine({ toolUseResult: { success: false, message: 'no' } })], /hand-back acknowledgment invalid: toolUseResult.success is not true/);
  refused([...handback(), ackLine({ toolUseResult: OMIT })], /hand-back acknowledgment invalid: toolUseResult.success is not true/);
  refused([...handback(), ackLine({ toolUseResult: 'ok' })], /hand-back acknowledgment invalid: toolUseResult.success is not true/);
  refused([...handback(), ackLine({ toolEndsTurn: false })], /hand-back acknowledgment invalid: toolEndsTurn is not true/);
  refused([...handback(), ackLine({ toolEndsTurn: OMIT })], /hand-back acknowledgment invalid: toolEndsTurn is not true/);
  refused([...handback(), ackLine({ content: 'delivered' })], /hand-back acknowledgment invalid: message.content is not one tool_result block/);
  refused([...handback(), ackLine({ content: [{ type: 'text', text: 'delivered' }] })], /hand-back acknowledgment invalid: message.content is not one tool_result block/);
  refused([...handback(), ackLine({ content: [{ tool_use_id: HB_ID, type: 'tool_result' }, { tool_use_id: HB_ID, type: 'tool_result' }] })], /message.content is not one tool_result block/);
  refused([...handback(), JSON.stringify({ type: 'system', subtype: 'note' })], /hand-back acknowledgment invalid: not a user line/);
  // A later, separate assistant message is simply the new final message (judged as plain text), not an acknowledgment.
  const later = proveText([...handback(), ackLine(), asstLine({ id: 'msg_after', content: text('more') })]);
  assert.equal(later.finalVia, 'text');
  assert.equal(later.finalAssistantText, 'more');
  refused([...handback(), ackLine(), JSON.stringify({ type: 'system', subtype: 'note' })], /extra lines after the hand-back acknowledgment/);
  refused([...handback(), ackLine(), ackLine()], /extra lines after the hand-back acknowledgment/);
  refused([...handback(), ackLine(), 'not json'], /extra lines after the hand-back acknowledgment/);
  refused([...handback(), 'not json'], /hand-back acknowledgment invalid: not a user line/);
});

test('hand-back rule 6: with a null stop_reason the message itself must carry a complete JSON answer', () => {
  const E = /final message has no stop_reason and carries no complete JSON answer/;
  const prose = refused([userLine('p'), hbLine({ input: { message: 'all done, no json' } }), ackLine()], E);
  assert.equal(prose.finalAssistantText, 'all done, no json', 'the delivered message is still reported, as for a plain-text final');
  refused([userLine('p'), hbLine({ input: { message: '```json\n{"rulings":[{"id":"R1-S1"' } }), ackLine()], E);
  refused([userLine('p'), hbLine({ input: { message: '[1,2]' } }), ackLine()], E);
  // Text that sat in an earlier block of the final message was never delivered, so it cannot supply the JSON.
  refused([userLine('p'), asstLine({ id: 'msg_hb', stop: null, content: text(ANSWER) }), hbLine({ input: { message: 'see above' } }), ackLine()], E);
});

test('hand-back: the usual model/effort checks still apply to the hand-back line', () => {
  const r = proveText([userLine('p'), hbLine({ model: 'claude-opus-5-5' }), ackLine()]);
  assert.equal(r.ok, false);
  assert.ok(r.errors.includes('unexpected model claude-opus-5-5 on line 2'));
  assert.equal(r.finalVia, 'handback');
  assert.equal(r.finalAssistantText, HB_MESSAGE);
});

test('hand-back: finalAssistantText is the hand-back message only, never text from earlier blocks of the same message', () => {
  const r = proveText([userLine('p'), asstLine({ id: 'msg_hb', stop: null, content: text('Draft that was never delivered.') }), hbLine(), ackLine()]);
  assert.deepEqual(r.errors, []);
  assert.equal(r.finalVia, 'handback');
  assert.equal(r.finalAssistantText, HB_MESSAGE);
});

// ---------- hand-back: parallel tool calls and the wire copy's \uXXXX escapes (both seen in real transcripts) ----------

// A tool call made in the same assistant message as the hand-back (one line per content block, same message.id).
const parallelCall = (toolId, id = 'msg_hb') => asstLine({ id, stop: null, content: [{ type: 'tool_use', id: toolId, name: 'Bash', input: { command: 'true' } }] });
const resultLine = (...toolIds) =>
  JSON.stringify({ type: 'user', toolUseResult: { stdout: '' }, message: { role: 'user', content: toolIds.map((id) => ({ tool_use_id: id, type: 'tool_result', content: 'ok' })) } });

test('hand-back: results of parallel tool calls from the same message may sit between the hand-back and its acknowledgment', () => {
  const head = [userLine('p'), thinkingLine(), parallelCall('toolu_p1'), parallelCall('toolu_p2'), hbLine()];
  const one = proveText([...head, resultLine('toolu_p1'), resultLine('toolu_p2'), ackLine()]);
  assert.deepEqual(one.errors, []);
  assert.equal(one.finalVia, 'handback');
  assert.equal(one.finalAssistantText, HB_MESSAGE);
  // One user line may carry several results, in any order.
  assert.deepEqual(proveText([...head, resultLine('toolu_p2', 'toolu_p1'), ackLine()]).errors, []);
  // A result for only some of the parallel calls is fine too (the others never answered).
  assert.deepEqual(proveText([...head, resultLine('toolu_p2'), ackLine()]).errors, []);
});

test('hand-back: anything but a first-time result for a same-message parallel call between the hand-back and the ack is refused', () => {
  const head = [userLine('p'), thinkingLine(), parallelCall('toolu_p1'), hbLine()];
  // A result for an id outside the final message group (even one that exists in an earlier message).
  refused([userLine('p'), parallelCall('toolu_old', 'msg_old'), thinkingLine(), hbLine(), resultLine('toolu_old'), ackLine()], /hand-back acknowledgment invalid: tool_result is not for this call/);
  refused([...head, resultLine('toolu_unknown'), ackLine()], /hand-back acknowledgment invalid: tool_result is not for this call/);
  // The same id twice, across lines or inside one line.
  refused([...head, resultLine('toolu_p1'), resultLine('toolu_p1'), ackLine()], /hand-back acknowledgment invalid: tool_result is not for this call/);
  refused([...head, resultLine('toolu_p1', 'toolu_p1'), ackLine()], /hand-back acknowledgment invalid: message.content is not one tool_result block/);
  // Prompt text, a text block beside a result, or a harness note.
  refused([...head, userLine('another prompt'), ackLine()], /hand-back acknowledgment invalid: message.content is not one tool_result block/);
  refused([...head, userLine([{ type: 'tool_result', tool_use_id: 'toolu_p1', content: 'ok' }, { type: 'text', text: 'hi' }]), ackLine()], /hand-back acknowledgment invalid/);
  refused([...head, userLine([{ type: 'tool_result', tool_use_id: 'toolu_p1', content: 'ok' }], { isMeta: true }), ackLine()], /hand-back acknowledgment invalid/);
  // Only user lines count: a non-user line shaped like a result, an empty user line, a non-tool_result block carrying an id.
  const asResult = (extra) => JSON.stringify({ message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_p1', content: 'ok' }] }, ...extra });
  refused([...head, asResult({ type: 'system' }), ackLine()], /hand-back acknowledgment invalid: not a user line/);
  refused([...head, userLine([]), ackLine()], /hand-back acknowledgment invalid: message.content is not one tool_result block/);
  refused([...head, userLine([{ type: 'text', tool_use_id: 'toolu_p1', text: 'hi' }]), ackLine()], /hand-back acknowledgment invalid: message.content is not one tool_result block/);
  // A second line closing the hand-back itself, or any parallel result AFTER the ack: the ack must be the last line.
  refused([...head, ackLine(), ackLine()], /extra lines after the hand-back acknowledgment/);
  refused([...head, ackLine(), resultLine('toolu_p1')], /extra lines after the hand-back acknowledgment/);
  // The hand-back call's own id is never a parallel result.
  refused([...head, resultLine(HB_ID), ackLine()], /extra lines after the hand-back acknowledgment/);
  // Without the final ack the parallel results do not acknowledge anything.
  refused([...head, resultLine('toolu_p1')], /hand-back not acknowledged/);
});

test('hand-back rule 3: the wire copy may hold \\uXXXX escapes for characters the input holds directly, and nothing else may differ', () => {
  const message = '```json\n{"note":"a\u00a0b \u00f1 \u2013 \u202f"}\n```';
  const wireOf = (m) => m.replace(/[\u0080-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  const withWire = (wireMessage, input = { message }) => [userLine('p'), hbLine({ input, wireToolInputs: { [HB_ID]: { message: wireMessage } } }), ackLine()];
  const ok = proveText(withWire(wireOf(message)));
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.finalAssistantText, message, 'the delivered text is the decoded input, not the wire copy');
  // Only some characters escaped (including an ASCII one), and upper-case hex digits.
  assert.deepEqual(proveText(withWire(message.replace('\u00a0', '\\u00a0').replace('\u00f1', '\\u00F1').replace('{"note"', '{"\\u006eote"'))).errors, []);
  // Literal backslash-u text that the input holds as text, too, is not an escape.
  const literal = '```json\n{"note":"write \\u00a0 for nbsp"}\n```';
  assert.deepEqual(proveText(withWire(literal, { message: literal })).errors, []);
  // Any real difference is still refused: an escape for another character, a changed word, a malformed escape, a missing escape char.
  const E = /hand-back input differs from its wire input/;
  refused(withWire(message.replace('\u00a0', '\\u00a1')), E);
  refused(withWire(wireOf(message).replace('note', 'nope')), E);
  refused(withWire(message.replace('\u00a0', '\\u00a')), E);
  refused(withWire(message.replace('\u00a0', '')), E);
  // An escape needs exactly four hex digits: \\u00a (three) is not U+000A.
  const nl = 'x\ny';
  refused(withWire('x\\u00ayy', { message: nl }), E);
  assert.deepEqual(proveText(withWire('x\\u000ay', { message: nl })).errors.filter((e) => E.test(e)), []);
  refused(withWire(wireOf(message) + 'x'), E);
  refused(withWire(wireOf(literal).replace('\\u00a0', '\u00a0'), { message: literal }), E);
});

test('hand-back rule 3: a literal backslash-u text in the input is matched even where the wire escapes a character after it', () => {
  const E = /hand-back input differs from its wire input/;
  const withWire = (wireMessage, input) => [userLine('p'), hbLine({ stop: 'tool_use', input: { message: input }, wireToolInputs: { [HB_ID]: { message: wireMessage } } }), ackLine()];
  // The input holds the six characters backslash-u005c as text; the wire holds them unchanged (a literal backslash there
  // is also a valid start of an escape for a backslash), and escapes the n-tilde. The comparison must back out of the escape reading.
  const literal = 'a \\u005c b ñ';
  const r = proveText(withWire('a \\u005c b \\u00f1', literal));
  assert.deepEqual(r.errors, []);
  assert.equal(r.finalVia, 'handback');
  // The reverse shape: the wire escapes the input's backslash (escape reading needed), followed by the same text.
  const r2 = proveText(withWire('a \\u005cu005c b', 'a \\u005c b'));
  assert.deepEqual(r2.errors, []);
  assert.equal(r2.finalVia, 'handback');
  // A near miss is still refused: the wire holds a different character where the input has a backslash.
  refused(withWire('a ]u005c b \\u00f1', literal), E);
  refused(withWire('a \\u005c b \\u00f2', literal), E);
  refused(withWire('a \\u005c b \\u00f1 ', literal), E);
  // A long ambiguous input finishes quickly: 20k backslashes against a wire of alternating escape and literal readings.
  const n = 20000;
  const t0 = Date.now();
  const big = proveText(withWire('\\u005c'.repeat(n) + '\\u005cu005c'.repeat(n) + ']', '\\'.repeat(n) + '\\u005c'.repeat(n) + '\\'));
  assert.ok(Date.now() - t0 < 1000, `took ${Date.now() - t0} ms`);
  assert.match(big.errors.join('\n'), E);
  const t1 = Date.now();
  const bigOk = proveText(withWire('\\u005c'.repeat(n) + '\\u005cu005c'.repeat(n), '\\'.repeat(n) + '\\u005c'.repeat(n)));
  assert.ok(Date.now() - t1 < 1000, `took ${Date.now() - t1} ms`);
  assert.deepEqual(bigOk.errors, []);
});
