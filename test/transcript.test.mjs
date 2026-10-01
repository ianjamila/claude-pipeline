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
const userLine = (content) => JSON.stringify({ type: 'user', message: { role: 'user', content } });
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

test('wrong effort is reported once per offending line', () => {
  const r = prove('fable-wrong-effort');
  assert.equal(r.ok, false);
  assert.deepEqual(r.errors, ['unexpected effort medium on line 2', 'unexpected effort medium on line 3']);
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
    asstLine({ id: 'msg_2', stop: null, content: text('b') }),
  ];
  const r = proveText(lines);
  assert.deepEqual(r.errors, ['final message incomplete (stop_reason null)']);
  assert.equal(r.finalStopReason, null);
});

test('a final message ending in tool_use (no answer yet) is incomplete', () => {
  const r = proveText([userLine('p'), asstLine({ stop: 'tool_use', content: [{ type: 'tool_use', id: 't', name: 'Read', input: {} }] })]);
  assert.deepEqual(r.errors, ['final message incomplete (stop_reason tool_use)']);
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
