// The evidence-file check of lib/substitute-proof.mjs (cp #256 R8-B2): "every file the agent was told to read really read" means the successful Reads of the file cover ALL of its
// lines (Read's offset / limit, default offset 1 and limit 2000), not just one Read call that names it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_READ_PAGES, READ_PAGE_LINES, READ_TOKENS_PER_CALL, lineCountOf, readsCoverFile, unreadablePacket } from '../pipeline/lib/substitute-proof.mjs';
import { toolCallsOf } from '../pipeline/lib/transcript.mjs';
import { readResultText } from './helpers/read-result.mjs';

const FILE = '/work/.review/round-1/substitute/diff.patch';
// A successful Read call as toolCallsOf yields it: `returned` is the range of line numbers its result showed (lib/transcript.mjs#readReturnedRange); by default what a faithful
// Read of a long file returns for the request (offset 0 returns from line 1), or `returned` as given (null: the result could not be parsed).
const read = (input = {}, { answered = true, isError = false, file = FILE, returned } = {}) => {
  const start = input.offset === undefined || input.offset < 1 ? 1 : input.offset;
  const faithful = Number.isInteger(start) && Number.isInteger(input.limit ?? 2000) ? { first: start, last: start + (input.limit ?? READ_PAGE_LINES) - 1 } : null;
  return { name: 'Read', input: { file_path: file, ...input }, id: 't', answered, isError, returned: returned === undefined ? faithful : returned };
};

test('lineCountOf: lines as Read numbers them (a final newline does not add one; an empty file has none)', () => {
  assert.equal(lineCountOf(''), 0);
  assert.equal(lineCountOf('a'), 1);
  assert.equal(lineCountOf('a\n'), 1);
  assert.equal(lineCountOf('a\nb\n'), 2);
  assert.equal(lineCountOf('a\n\nb'), 3);
  assert.equal(READ_PAGE_LINES, 2000);
});

test('a one-line Read does not cover the file', () => {
  assert.equal(readsCoverFile([read({ offset: 1, limit: 1 })], FILE, 50), false);
  assert.equal(readsCoverFile([read({ limit: 10 })], FILE, 50), false);
  assert.equal(readsCoverFile([read({ offset: 40 })], FILE, 50), false, 'starting past line 1 leaves the head unread');
});

test('paged Reads that together cover every line are accepted, in any order', () => {
  assert.equal(readsCoverFile([read({ offset: 1, limit: 20 }), read({ offset: 21, limit: 20 }), read({ offset: 41, limit: 10 })], FILE, 50), true);
  assert.equal(readsCoverFile([read({ offset: 41, limit: 100 }), read({ offset: 1, limit: 25 }), read({ offset: 20, limit: 25 })], FILE, 50), true, 'overlap is fine');
  assert.equal(readsCoverFile([read({ offset: 1, limit: 50 })], FILE, 50), true);
});

test('a gap between pages is refused', () => {
  assert.equal(readsCoverFile([read({ offset: 1, limit: 20 }), read({ offset: 22, limit: 29 })], FILE, 50), false, 'line 21 was never read');
});

test('a default Read (no offset, no limit) covers up to 2000 lines and no more', () => {
  assert.equal(readsCoverFile([read()], FILE, 2000), true);
  assert.equal(readsCoverFile([read()], FILE, 1), true);
  assert.equal(readsCoverFile([read()], FILE, 2001), false);
  assert.equal(readsCoverFile([read(), read({ offset: 2001 })], FILE, 2500), true, 'the next page closes it');
});

test('only successful Reads of THIS file count; an empty file needs one successful Read', () => {
  assert.equal(readsCoverFile([read({}, { isError: true })], FILE, 5), false);
  assert.equal(readsCoverFile([read({}, { answered: false })], FILE, 5), false);
  assert.equal(readsCoverFile([read({}, { file: '/work/other' })], FILE, 5), false);
  assert.equal(readsCoverFile([{ name: 'Grep', input: { file_path: FILE }, answered: true, isError: false }], FILE, 5), false);
  assert.equal(readsCoverFile([], FILE, 0), false);
  assert.equal(readsCoverFile([read()], FILE, 0), true);
});

test('a malformed offset / limit never counts as covering anything', () => {
  for (const bad of [{ offset: '1', limit: 2000 }, { offset: 1.5 }, { limit: 0 }, { limit: -3 }, { offset: -1 }, { limit: 'all' }]) {
    assert.equal(readsCoverFile([read(bad)], FILE, 5), false, JSON.stringify(bad));
  }
});

test('R9-F3: a Read with offset 0 is accepted (it returns from line 1); offset -1 stays refused', () => {
  assert.equal(readsCoverFile([read({ offset: 0, limit: 50 })], FILE, 50), true);
  assert.equal(readsCoverFile([read({ offset: 0 })], FILE, 5), true);
  assert.equal(readsCoverFile([read({ offset: -1 })], FILE, 5), false);
});

test('R9-F1: coverage is what the Read RETURNED, not what it asked for', () => {
  // a Read that stopped at the size cap: lines 1-524 of 648 came back
  assert.equal(readsCoverFile([read({}, { returned: { first: 1, last: 524 } })], FILE, 648), false);
  assert.equal(readsCoverFile([read({}, { returned: { first: 1, last: 524 } }), read({ offset: 525 }, { returned: { first: 525, last: 648 } })], FILE, 648), true, 'the follow-up from line 525 completes it');
  assert.equal(readsCoverFile([read({ offset: 1, limit: 100000 }, { returned: { first: 1, last: 524 } })], FILE, 30000), false, 'limit 100000 asked for far more than came back');
  assert.equal(readsCoverFile([read({ offset: 1, limit: 100000 }, { returned: { first: 1, last: 524 } }), read({ offset: 600 }, { returned: { first: 600, last: 648 } })], FILE, 648), false, 'lines 525-599 never came back');
  // a result whose line numbers could not be parsed credits nothing (fail closed), and so does a Read that returned nothing
  assert.equal(readsCoverFile([read({ offset: 1, limit: 50 }, { returned: null })], FILE, 50), false);
  assert.equal(readsCoverFile([{ ...read({ offset: 1, limit: 50 }), returned: undefined }], FILE, 50), false, 'a call without a parsed range');
});

test('toolCallsOf keeps, for a Read, the range of line numbers its result showed (from the numbered rows of the tool_result text)', () => {
  const call = (id, input, content, extra = {}) => [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: FILE, ...input } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content, ...extra }] } },
  ];
  const text = (n, from = 1) => Array.from({ length: n }, (_, i) => `${from + i}\tline ${from + i}`).join('\n');
  const rows = [
    ...call('a', {}, text(524)), // stopped at the size cap: 1-524 of 648
    ...call('b', { offset: 525 }, text(124, 525)),
    ...call('c', { offset: 0 }, text(3)), // offset 0 returns from line 1
    ...call('d', {}, [{ type: 'text', text: text(2, 10) }]), // block content
    ...call('e', {}, `${text(2)}\n\n<system-reminder>PARTIAL view: showing lines 1-1 of 9 total (26233 tokens, cap 25000)</system-reminder>`), // R10-B1: the numbered rows decide; no clamp by a note
    ...call('f', {}, 'ok'), // no numbered lines
    ...call('g', {}, `1\ta\n3\tc`), // a gap in the numbers
    ...call('h', {}, text(4), { is_error: true }),
    ...call('i', {}, `  7\u2192seven\n  8\u2192eight`), // arrow-separated numbers
  ];
  const got = toolCallsOf(rows.map((l) => JSON.stringify(l)).join('\n')).map((c) => c.returned);
  assert.deepEqual(got, [{ first: 1, last: 524 }, { first: 525, last: 648 }, { first: 1, last: 3 }, { first: 10, last: 11 }, { first: 1, last: 2 }, null, null, null, { first: 7, last: 8 }]);
});

test('readResultText models Read: numbered lines, offset 0 from line 1, a cap that stops early', () => {
  const body = 'a\nb\nc\n';
  assert.equal(readResultText({ file_path: 'x', offset: 0 }, { text: body }), '1\ta\n2\tb\n3\tc');
  assert.equal(readResultText({ file_path: 'x', offset: 2, limit: 5 }, { text: body, maxLines: 1 }), '2\tb');
});

test('toolCallsOf keeps a Read call\'s offset and limit', () => {
  const jsonl = [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a', name: 'Read', input: { file_path: FILE, offset: 5, limit: 7 } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: 'x' }] } },
  ].map((l) => JSON.stringify(l)).join('\n');
  const [call] = toolCallsOf(jsonl);
  assert.deepEqual([call.input.offset, call.input.limit, call.answered], [5, 7, true]);
});

const lines = (n, width = 5) => `${Array.from({ length: n }, () => 'x'.repeat(width)).join('\n')}\n`;

test('unreadablePacket: a file needs ceil(lines / 2000) Reads (an empty one needs 1); the Read calls of all files together may not pass MAX_READ_PAGES', () => {
  assert.equal(MAX_READ_PAGES, 15);
  assert.equal(unreadablePacket([{ rel: 'in.md', content: lines(10) }, { rel: 'diff.patch', content: lines(5000) }, { rel: 'e', content: '' }]), null, '1 + 3 + 1 pages');
  assert.equal(unreadablePacket([{ rel: 'a', content: lines(2000 * 14) }, { rel: 'b', content: lines(1) }]), null, 'exactly 15 pages');
  const over = unreadablePacket([{ rel: 'a', content: lines(2000 * 14) }, { rel: 'b', content: lines(1) }, { rel: 'c', content: lines(1) }]);
  assert.equal(over.pages, 16);
  assert.equal(over.maxPages, 15);
  assert.deepEqual(over.files.map((f) => [f.rel, f.lines, f.pages]), [['a', 28000, 14], ['b', 1, 1], ['c', 1, 1]]);
  assert.match(over.message, /Read calls/);
});

test('R9-F1: a file needs max(ceil(lines / 2000), ceil(estimated tokens / READ_TOKENS_PER_CALL)) Reads: a few huge lines are many calls', () => {
  assert.ok(READ_TOKENS_PER_CALL > 0 && READ_TOKENS_PER_CALL < 25000, 'below the 25,000-token cap of one Read');
  // 400 lines of 3000 characters: 1.2M characters, a million-odd characters is far beyond 15 calls of 20,000 tokens
  const big = unreadablePacket([{ rel: 'diff.patch', content: `${'q'.repeat(2999)}\n`.repeat(400) }]);
  assert.ok(big !== null, 'refused');
  const row = big.files[0];
  assert.equal(row.lines, 400);
  assert.ok(row.tokens > 300000 && row.pages === Math.ceil(row.tokens / READ_TOKENS_PER_CALL) && row.pages > MAX_READ_PAGES, JSON.stringify(row));
  assert.match(big.message, /tokens/);
  // the same lines, short: fine
  assert.equal(unreadablePacket([{ rel: 'diff.patch', content: lines(400, 100) }]), null);
  // within budget by lines AND tokens: 100 lines of 1000 characters is 2 calls
  assert.equal(unreadablePacket([{ rel: 'a', content: lines(100, 1000) }]), null);
});

test('R9-F2: a long line is not a reason to refuse: a 10,000-character line is just counted in the token estimate', () => {
  const r = unreadablePacket([{ rel: 'a', content: `ok\n${'y'.repeat(10000)}\nfine\n` }]);
  assert.equal(r, null);
});

// ---- R10-B1 / R10-F1 / R10-F2 ----

const resultOf = (id, input, content) => [
  { type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: FILE, ...input } }] } },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content }] } },
];
const callsFor = (...results) => toolCallsOf(results.flat().map((l) => JSON.stringify(l)).join('\n'));
const numbered = (arr, from = 1) => arr.map((t, i) => `${from + i}\t${t}`).join('\n');

test('R10-B1: file text that contains "showing lines A-B" does not shrink or null the credited range', () => {
  const fileLines = ['# agent', 'it says "PARTIAL view: showing lines 1-1 of 9" in its text', 'last'];
  const calls = callsFor(resultOf('a', {}, numbered(fileLines)));
  assert.deepEqual(calls[0].returned, { first: 1, last: 3 });
  assert.equal(readsCoverFile(calls, FILE, 3, `${fileLines.join('\n')}\n`), true);
  const odd = callsFor(resultOf('b', {}, numbered(['x', 'showing lines 5-9 here', 'y'])));
  assert.deepEqual(odd[0].returned, { first: 1, last: 3 }, 'a phrase naming other lines nulls nothing');
});

test('R10-F1: a row is credited only when its text equals the file\'s line; coverage ends before the first row that differs', () => {
  const file = ['alpha', 'bravo', 'charlie', 'delta'];
  const text = `${file.join('\n')}\n`;
  // a row cut short (line 2 returned as "brav"): lines 2.. are not credited, nor are later lines that match
  const cut = callsFor(resultOf('a', {}, numbered(['alpha', 'brav', 'charlie', 'delta'])));
  assert.equal(readsCoverFile(cut, FILE, 4, text), false);
  const withFollow = callsFor(resultOf('a', {}, numbered(['alpha', 'brav', 'charlie', 'delta'])), resultOf('b', { offset: 3 }, numbered(['charlie'], 3)));
  assert.equal(readsCoverFile(withFollow, FILE, 4, text), false, 'line 2 and 4 stay unread');
  const fixed = callsFor(resultOf('a', {}, numbered(['alpha', 'brav'])), resultOf('b', { offset: 2 }, numbered(['bravo', 'charlie', 'delta'], 2)));
  assert.equal(readsCoverFile(fixed, FILE, 4, text), true, 'the re-Read of the cut line completes it');
  // the first row cut short credits nothing
  assert.equal(readsCoverFile(callsFor(resultOf('a', {}, numbered(['alp', 'bravo', 'charlie', 'delta']))), FILE, 4, text), false);
  // a trailing \r on either side is ignored
  const crlf = 'one\r\ntwo\r\n';
  assert.equal(readsCoverFile(callsFor(resultOf('a', {}, numbered(['one', 'two']))), FILE, 2, crlf), true, 'file has CR, result has none');
  assert.equal(readsCoverFile(callsFor(resultOf('a', {}, numbered(['one\r', 'two\r']))), FILE, 2, 'one\ntwo\n'), true, 'result has CR, file has none');
  // text a Read invented (right numbers, wrong text) credits nothing
  assert.equal(readsCoverFile(callsFor(resultOf('a', {}, numbered(['nope', 'nope']))), FILE, 2, 'one\ntwo\n'), false);
});

test('R10-F1: a 10,000-character line returned whole is credited', () => {
  const long = 'y'.repeat(10000);
  const text = `ok\n${long}\nfine\n`;
  assert.equal(readsCoverFile(callsFor(resultOf('a', {}, numbered(['ok', long, 'fine']))), FILE, 3, text), true);
});

test('R10-F1: a single line over the per-call token budget makes the packet unreadable, naming the file and the line', () => {
  const huge = 'z'.repeat(READ_TOKENS_PER_CALL * 3 + 10);
  const r = unreadablePacket([{ rel: 'in.md', content: 'ok\n' }, { rel: 'diff.patch', content: `a\n${huge}\nb\n` }]);
  assert.ok(r !== null, 'refused');
  assert.match(r.message, /diff\.patch/);
  assert.match(r.message, /line 2/);
  assert.deepEqual([r.longLine.rel, r.longLine.line], ['diff.patch', 2]);
  assert.equal(unreadablePacket([{ rel: 'a', content: `${'z'.repeat(READ_TOKENS_PER_CALL * 3 - 10)}\n` }]), null, 'a line that just fits is fine');
});

test('R10-F2: a required file Read cannot return as numbered text makes the packet unreadable, naming it', () => {
  for (const rel of ['sides/ours/a/logo.png', 'sides/base/x.JPG', 'sides/ours/n.ipynb', 'sides/ours/d.pdf', 'sides/ours/i.jpeg', 'sides/ours/i.gif', 'sides/ours/i.webp', 'sides/ours/i.bmp', 'sides/ours/i.ico']) {
    const r = unreadablePacket([{ rel: 'in.md', content: 'ok\n' }, { rel, content: 'text-like\n' }]);
    assert.ok(r !== null, rel);
    assert.ok(r.message.includes(rel), r.message);
    assert.equal(r.unreadableFile.rel, rel);
  }
  const nul = unreadablePacket([{ rel: 'sides/ours/data.bin', content: 'ab\u0000cd\n' }]);
  assert.ok(nul !== null && nul.message.includes('sides/ours/data.bin') && /NUL|binary/.test(nul.message));
  assert.equal(unreadablePacket([{ rel: 'sides/ours/logo.svg', content: '<svg/>\n' }, { rel: 'sides/ours/a.md', content: 'x\n' }]), null, 'svg is text');
});

test('R11-F1: a leading BOM and repeated trailing \\r do not stop a faithful row from being credited', () => {
  // (a) the file starts with a UTF-8 BOM; Read returns row 1 without it
  const bom = '﻿one\ntwo\n';
  assert.equal(readsCoverFile(callsFor(resultOf('a', {}, numbered(['one', 'two']))), FILE, 2, bom), true, 'file has BOM, result has none');
  assert.equal(readsCoverFile(callsFor(resultOf('a', {}, numbered(['﻿one', 'two']))), FILE, 2, 'one\ntwo\n'), true, 'result has BOM, file has none');
  // (b) a line ending \r\r\n is read back as 'x'
  assert.equal(readsCoverFile(callsFor(resultOf('a', {}, numbered(['x', 'two']))), FILE, 2, 'x\r\r\ntwo\n'), true, 'file has \\r\\r');
  assert.equal(readsCoverFile(callsFor(resultOf('a', {}, numbered(['x\r\r', 'two']))), FILE, 2, 'x\ntwo\n'), true, 'result has \\r\\r');
  // (c) a row that really differs is still not credited (a BOM only counts on line 1)
  assert.equal(readsCoverFile(callsFor(resultOf('a', {}, numbered(['one', 'tw']))), FILE, 2, bom), false, 'cut row');
  assert.equal(readsCoverFile(callsFor(resultOf('a', {}, numbered(['one', '﻿two']))), FILE, 2, 'one\ntwo\n'), false, 'a BOM past line 1 is real text');
  assert.equal(readsCoverFile(callsFor(resultOf('a', {}, numbered(['y', 'two']))), FILE, 2, 'x\r\r\ntwo\n'), false, 'different text');
});
