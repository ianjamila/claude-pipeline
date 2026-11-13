// The evidence-file check of lib/substitute-proof.mjs (cp #256 R8-B2): "every file the agent was told to read really read" means the successful Reads of the file cover ALL of its
// lines (Read's offset / limit, default offset 1 and limit 2000), not just one Read call that names it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { READ_PAGE_LINES, lineCountOf, readsCoverFile } from '../pipeline/lib/substitute-proof.mjs';
import { toolCallsOf } from '../pipeline/lib/transcript.mjs';

const FILE = '/work/.review/round-1/substitute/diff.patch';
const read = (input = {}, { answered = true, isError = false, file = FILE } = {}) => ({ name: 'Read', input: { file_path: file, ...input }, id: 't', answered, isError });

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

test('toolCallsOf keeps a Read call\'s offset and limit', () => {
  const jsonl = [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a', name: 'Read', input: { file_path: FILE, offset: 5, limit: 7 } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: 'x' }] } },
  ].map((l) => JSON.stringify(l)).join('\n');
  const [call] = toolCallsOf(jsonl);
  assert.deepEqual([call.input.offset, call.input.limit, call.answered], [5, 7, true]);
});
