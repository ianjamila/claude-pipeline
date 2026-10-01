import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseUnifiedDiff, diffStats, parseHunkHeader, unquoteCPath } from '../pipeline/lib/diff.mjs';

// Fixtures are real `git diff -M --unified=0 --no-color --no-ext-diff` output saved as text, so tests never run git.
const fixture = (name) => readFileSync(new URL(`./fixtures/diffs/${name}.diff`, import.meta.url), 'utf8');
const ln = (line, text) => ({ line, text });
// Expected file entry with the defaults every non-binary modification shares.
const entry = (over) => ({
  oldPath: null, newPath: null, path: null, status: 'M', similarity: null, binary: false, added: [], removed: [], ...over,
});

test('empty and header-only input parse to no files', () => {
  assert.deepEqual(parseUnifiedDiff(''), []);
  assert.deepEqual(parseUnifiedDiff('commit abc\nAuthor: x\n\n    message\n'), []);
});

test('add.diff: new file is status A with new-file line numbers 1..3', () => {
  assert.deepEqual(parseUnifiedDiff(fixture('add')), [
    entry({
      oldPath: null, newPath: 'src/new.ts', path: 'src/new.ts', status: 'A',
      added: [ln(1, 'export const a = 1;'), ln(2, 'export const b = 2;'), ln(3, 'export const c = 3;')],
    }),
  ]);
});

test('delete.diff: deleted file is status D, path is the old path, removed lines use old numbers', () => {
  assert.deepEqual(parseUnifiedDiff(fixture('delete')), [
    entry({
      oldPath: 'src/gone.ts', newPath: null, path: 'src/gone.ts', status: 'D',
      removed: [ln(1, 'alpha'), ln(2, 'beta'), ln(3, 'gamma'), ln(4, 'delta')],
    }),
  ]);
});

test('modify-two-hunks.diff: removed lines carry old numbers, added lines carry new numbers across the shift', () => {
  // Hunk 1 swaps old lines 2-3 for one new line (shift of -1); hunk 2 inserts after old line 9, which is new line 8.
  assert.deepEqual(parseUnifiedDiff(fixture('modify-two-hunks')), [
    entry({
      oldPath: 'src/mod.ts', newPath: 'src/mod.ts', path: 'src/mod.ts', status: 'M',
      removed: [ln(2, 'line 2'), ln(3, 'line 3')],
      added: [ln(2, 'line two and three, merged'), ln(9, 'inserted A'), ln(10, 'inserted B')],
    }),
  ]);
});

test('rename-edit.diff: status R with similarity, both paths, one added and one removed line', () => {
  assert.deepEqual(parseUnifiedDiff(fixture('rename-edit')), [
    entry({
      oldPath: 'src/old-name.ts', newPath: 'src/new-name.ts', path: 'src/new-name.ts', status: 'R', similarity: 86,
      removed: [ln(5, 'line 5')], added: [ln(5, 'line five')],
    }),
  ]);
});

test('rename-pure.diff: a rename with no content change has no lines', () => {
  assert.deepEqual(parseUnifiedDiff(fixture('rename-pure')), [
    entry({ oldPath: 'lib/before.ts', newPath: 'lib/after/after.ts', path: 'lib/after/after.ts', status: 'R', similarity: 100 }),
  ]);
});

test('binary.diff: binary modify, add and delete are flagged binary with no lines', () => {
  assert.deepEqual(parseUnifiedDiff(fixture('binary')), [
    entry({ oldPath: 'img/logo.bin', newPath: 'img/logo.bin', path: 'img/logo.bin', status: 'M', binary: true }),
    entry({ oldPath: null, newPath: 'img/new.bin', path: 'img/new.bin', status: 'A', binary: true }),
    entry({ oldPath: 'img/old.bin', newPath: null, path: 'img/old.bin', status: 'D', binary: true }),
  ]);
});

test('spaces.diff: unquoted paths with spaces resolve in every header shape (hunk, empty add, mode-only, pure rename)', () => {
  // Git does not quote plain spaces; it appends a tab to the ---/+++ lines instead, and header-only entries
  // (empty file, mode change) carry the path only in the `diff --git a/x y b/x y` line.
  assert.deepEqual(parseUnifiedDiff(fixture('spaces')), [
    entry({ oldPath: null, newPath: 'docs/empty file.md', path: 'docs/empty file.md', status: 'A' }),
    entry({ oldPath: 'docs/mode only.sh', newPath: 'docs/mode only.sh', path: 'docs/mode only.sh', status: 'M' }),
    entry({
      oldPath: 'docs/my file.md', newPath: 'docs/my file.md', path: 'docs/my file.md', status: 'M',
      removed: [ln(3, 'doc line 3')], added: [ln(3, 'doc line THREE')],
    }),
    entry({ oldPath: 'docs/old name.md', newPath: 'docs/new name.md', path: 'docs/new name.md', status: 'R', similarity: 100 }),
  ]);
});

test('a raw path that itself contains " b/" is split in the middle of a header-only entry', () => {
  const text = 'diff --git a/x b/y.txt b/x b/y.txt\nold mode 100644\nnew mode 100755\n';
  assert.deepEqual(parseUnifiedDiff(text), [
    entry({ oldPath: 'x b/y.txt', newPath: 'x b/y.txt', path: 'x b/y.txt', status: 'M' }),
  ]);
});

test('quoted.diff: C-quoted paths decode quotes, backslashes, tabs, octal UTF-8 and combine with spaces', () => {
  const body = { removed: [ln(2, 'b')], added: [ln(2, 'B')] };
  const same = (p, extra = {}) => entry({ oldPath: p, newPath: p, path: p, status: 'M', ...body, ...extra });
  assert.deepEqual(parseUnifiedDiff(fixture('quoted')), [
    same('docs/back\\slash.md'),
    entry({
      oldPath: 'docs/café old.md', newPath: 'docs/café new.md', path: 'docs/café new.md', status: 'R', similarity: 75,
      removed: [ln(3, 'k3')], added: [ln(3, 'K3')],
    }),
    same('docs/café.md'),
    same('docs/emoji \u{1F642}.md'),
    same('docs/say "hi".md'),
    same('docs/tab\there.md'),
    entry({ oldPath: null, newPath: 'naïve/new ß.md', path: 'naïve/new ß.md', status: 'A', added: [ln(1, 'fresh')] }),
  ]);
});

test('plusplus.diff: +++/--- content lines inside a hunk are content, not file headers', () => {
  // The first hunk is `--- y` then `+++ x` — byte-for-byte what a file header pair looks like.
  assert.deepEqual(parseUnifiedDiff(fixture('plusplus')), [
    entry({
      oldPath: 'patch.txt', newPath: 'patch.txt', path: 'patch.txt', status: 'M',
      removed: [ln(2, '-- y')], added: [ln(2, '++ x'), ln(4, '++ b/evil.ts')],
    }),
    entry({
      oldPath: 'zz-after.txt', newPath: 'zz-after.txt', path: 'zz-after.txt', status: 'M',
      removed: [ln(2, 'tail 2')], added: [ln(2, 'tail two')],
    }),
  ]);
});

test('no-newline.diff: "\\ No newline at end of file" markers are ignored, including after the last hunk line', () => {
  assert.deepEqual(parseUnifiedDiff(fixture('no-newline')), [
    entry({
      oldPath: 'src/nonl.txt', newPath: 'src/nonl.txt', path: 'src/nonl.txt', status: 'M',
      removed: [ln(3, 'three')], added: [ln(3, 'three changed')],
    }),
    entry({ oldPath: null, newPath: 'src/tail.txt', path: 'src/tail.txt', status: 'A', added: [ln(1, 'x')] }),
  ]);
});

test('mode-only.diff: a mode change is status M with no lines', () => {
  assert.deepEqual(parseUnifiedDiff(fixture('mode-only')), [
    entry({ oldPath: 'bin/run.sh', newPath: 'bin/run.sh', path: 'bin/run.sh', status: 'M' }),
  ]);
});

test('hunk header: a missing count means 1, a zero count means no lines on that side', () => {
  assert.deepEqual(parseHunkHeader('@@ -9 +8,0 @@ ctx'), { oldStart: 9, oldCount: 1, newStart: 8, newCount: 0 });
  assert.deepEqual(parseHunkHeader('@@ -0,0 +1,3 @@'), { oldStart: 0, oldCount: 0, newStart: 1, newCount: 3 });
  assert.equal(parseHunkHeader('@@@ -1 -1 +1 @@@'), null);
  const text = 'diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -9 +8,0 @@\n-l9\n@@ -20,0 +20 @@\n+new20\n';
  const [f] = parseUnifiedDiff(text);
  assert.deepEqual(f.removed, [ln(9, 'l9')]);
  assert.deepEqual(f.added, [ln(20, 'new20')]);
});

test('context lines (non --unified=0 input) advance both counters', () => {
  const text = 'diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -4,3 +4,3 @@\n ctx a\n-old\n+new\n ctx b\n';
  const [f] = parseUnifiedDiff(text);
  assert.deepEqual(f.removed, [ln(5, 'old')]);
  assert.deepEqual(f.added, [ln(5, 'new')]);
});

test('added content that looks like a diff header stays content', () => {
  const text = 'diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -0,0 +1,3 @@\n+diff --git a/fake b/fake\n++++ b/fake\n+@@ -1 +1 @@\n';
  const files = parseUnifiedDiff(text);
  assert.equal(files.length, 1);
  assert.deepEqual(files[0].added, [ln(1, 'diff --git a/fake b/fake'), ln(2, '+++ b/fake'), ln(3, '@@ -1 +1 @@')]);
});

test('CRLF content is preserved in text while headers still parse', () => {
  const [f] = parseUnifiedDiff('diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1 +1 @@\n-old\r\n+new\r\n');
  assert.deepEqual(f.removed, [ln(1, 'old\r')]);
  assert.deepEqual(f.added, [ln(1, 'new\r')]);
});

test('raw UTF-8 paths (core.quotePath=false) and "GIT binary patch" bodies parse', () => {
  const text = 'diff --git a/naïve/é.bin b/naïve/é.bin\nindex 1..2 100644\nGIT binary patch\nliteral 3\nKcmZQzVPWAQ0RR\n\nliteral 0\nHcmV?d00001\n\n';
  assert.deepEqual(parseUnifiedDiff(text), [
    entry({ oldPath: 'naïve/é.bin', newPath: 'naïve/é.bin', path: 'naïve/é.bin', status: 'M', binary: true }),
  ]);
});

test('unquoteCPath decodes escapes and multi-byte octal sequences', () => {
  assert.equal(unquoteCPath('"a\\tb\\nc\\"d\\\\e"'), 'a\tb\nc"d\\e');
  assert.equal(unquoteCPath('"caf\\303\\251"'), 'café');
  assert.equal(unquoteCPath('"\\360\\237\\231\\202"'), '\u{1F642}');
  assert.equal(unquoteCPath('"plain ünïcode"'), 'plain ünïcode');
  assert.throws(() => unquoteCPath('"unterminated'), /unterminated/);
  assert.throws(() => unquoteCPath('"bad\\qescape"'), /escape/);
});

test('a truncated hunk or an orphan hunk header fails loudly instead of returning partial data', () => {
  assert.throws(() => parseUnifiedDiff('diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,2 +1,2 @@\n-one\n'), /truncated|ended/i);
  assert.throws(() => parseUnifiedDiff('diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1 +1 @@\n-one\ndiff --git a/g b/g\n'), /ended|malformed/i);
  assert.throws(() => parseUnifiedDiff('@@ -1 +1 @@\n-x\n+y\n'), /before any file/i);
});

test('diffStats totals files, added, removed and changedLines over a combined fixture', () => {
  const combined = ['add', 'delete', 'modify-two-hunks', 'rename-edit', 'rename-pure', 'binary', 'plusplus']
    .map(fixture).join('');
  assert.deepEqual(diffStats(parseUnifiedDiff(combined)), { files: 10, added: 10, removed: 9, changedLines: 19 });
  assert.deepEqual(diffStats([]), { files: 0, added: 0, removed: 0, changedLines: 0 });
});
