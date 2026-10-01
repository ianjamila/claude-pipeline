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

// ---- strictness and robustness (review follow-ups) ----

const PREFIX_ERROR = 'unexpected diff path prefix — run git diff with --src-prefix=a/ --dst-prefix=b/';
const HEAD = 'diff --git a/f b/f\n--- a/f\n+++ b/f\n';

test('--no-prefix output throws instead of guessing (header-only, top-level b/ dir, quoted names)', () => {
  // Real `git diff --no-prefix` output. The `b/top.ts` file is the dangerous one: its path starts with "b/", so a
  // lenient parser would strip it and report `top.ts`.
  for (const name of ['no-prefix-header-only', 'no-prefix-b-dir', 'no-prefix-quoted']) {
    assert.throws(() => parseUnifiedDiff(fixture(name)), { message: PREFIX_ERROR }, name);
  }
});

test('a wrong prefix on the header pair or on a ---/+++ path throws; /dev/null stays allowed', () => {
  assert.throws(() => parseUnifiedDiff('diff --git c/f w/f\nold mode 100644\nnew mode 100755\n'), { message: PREFIX_ERROR });
  assert.throws(() => parseUnifiedDiff('diff --git a/f a/f\nold mode 100644\nnew mode 100755\n'), { message: PREFIX_ERROR });
  assert.throws(() => parseUnifiedDiff('diff --git "a/f" "w/f"\nold mode 100644\nnew mode 100755\n'), { message: PREFIX_ERROR });
  assert.throws(() => parseUnifiedDiff('diff --git a/f b/f\n--- f\n+++ b/f\n@@ -1 +1 @@\n-x\n+y\n'), { message: PREFIX_ERROR });
  assert.throws(() => parseUnifiedDiff('diff --git a/f b/f\n--- a/f\n+++ f\n@@ -1 +1 @@\n-x\n+y\n'), { message: PREFIX_ERROR });
  assert.equal(parseUnifiedDiff(fixture('add'))[0].status, 'A');
  assert.equal(parseUnifiedDiff(fixture('delete'))[0].status, 'D');
});

const ALL_FIXTURES = [
  'add', 'delete', 'modify-two-hunks', 'rename-edit', 'rename-pure', 'binary', 'spaces', 'quoted', 'plusplus',
  'no-newline', 'mode-only', 'rename-ambiguous-header', 'quoted-header-only',
];

test('CRLF-converted fixtures (git autocrlf checkouts) parse the same; only content lines keep their \\r', () => {
  const withCr = (l) => ({ ...l, text: `${l.text}\r` });
  for (const name of ALL_FIXTURES) {
    const lf = parseUnifiedDiff(fixture(name));
    const crlf = parseUnifiedDiff(fixture(name).replace(/\n/g, '\r\n'));
    const expected = lf.map((f) => ({ ...f, added: f.added.map(withCr), removed: f.removed.map(withCr) }));
    assert.deepEqual(crlf, expected, name);
  }
});

test('CRLF header lines: trailing \\r is stripped from rename, similarity, binary and ---/+++ tab-suffixed paths', () => {
  const text = 'diff --git a/p b/q.txt b/r.txt\r\nsimilarity index 75%\r\nrename from p b/q.txt\r\nrename to r.txt\r\n'
    + 'index 1..2 100644\r\n--- a/p b/q.txt\t\r\n+++ b/r.txt\r\n@@ -1 +1 @@\r\n-a\r\n+b\r\n'
    + 'diff --git a/i.bin b/i.bin\r\nindex 1..2 100644\r\nBinary files a/i.bin and b/i.bin differ\r\n';
  assert.deepEqual(parseUnifiedDiff(text), [
    entry({
      oldPath: 'p b/q.txt', newPath: 'r.txt', path: 'r.txt', status: 'R', similarity: 75,
      removed: [ln(1, 'a\r')], added: [ln(1, 'b\r')],
    }),
    entry({ oldPath: 'i.bin', newPath: 'i.bin', path: 'i.bin', status: 'M', binary: true }),
  ]);
});

test('hunk count overflow throws: lines beyond the declared counts are never silently dropped', () => {
  assert.throws(() => parseUnifiedDiff(`${HEAD}@@ -1 +1 @@\n-a\n+b\n+c\n`), /overflow/); // extra line after the hunk is full
  assert.throws(() => parseUnifiedDiff(`${HEAD}@@ -1 +1 @@\n-a\n-b\n+c\n`), /overflow/); // second removal exceeds old count
  assert.throws(() => parseUnifiedDiff(`${HEAD}@@ -1 +1 @@\n-a\n+b\n+++ b/g\n`), /overflow/); // header lookalike after a full hunk
  assert.throws(() => parseUnifiedDiff(`${HEAD}@@ -1 +1 @@\n-a\n+b\n--- y\n`), /overflow/);
  // At exactly the declared counts, and with a following hunk, it still parses.
  const [f] = parseUnifiedDiff(`${HEAD}@@ -1 +1 @@\n-a\n+b\n@@ -3,0 +3 @@\n+c\n`);
  assert.deepEqual(f.removed, [ln(1, 'a')]);
  assert.deepEqual(f.added, [ln(1, 'b'), ln(3, 'c')]);
});

test('hunk count underflow throws: a hunk cut short by the next header is malformed', () => {
  assert.throws(() => parseUnifiedDiff(`${HEAD}@@ -1,2 +1 @@\n-a\ndiff --git a/g b/g\n`), /ended early/);
  assert.throws(() => parseUnifiedDiff(`${HEAD}@@ -1,2 +1 @@\n-a\n@@ -9 +9 @@\n-z\n`), /ended early/);
});

test('a blank line inside a hunk is a context line, but only while both sides have lines left', () => {
  const [f] = parseUnifiedDiff(`${HEAD}@@ -1,3 +1,3 @@\n a\n\n-x\n+y\n`);
  assert.deepEqual(f.removed, [ln(3, 'x')]);
  assert.deepEqual(f.added, [ln(3, 'y')]);
  assert.throws(() => parseUnifiedDiff(`${HEAD}@@ -1,2 +1,0 @@\n-a\n\n`), /overflow/);
  // CRLF-converted: the blank context line arrives as a bare \r.
  const [g] = parseUnifiedDiff(`${HEAD}@@ -1,3 +1,3 @@\n a\n\n-x\n+y\n`.replace(/\n/g, '\r\n'));
  assert.deepEqual(g.removed, [ln(3, 'x\r')]);
  assert.deepEqual(g.added, [ln(3, 'y\r')]);
});

test('rename from/to override a wrong guess from the `diff --git` line', () => {
  // `diff --git a/p b/q.txt b/r.txt` cannot be split reliably: the first " b/" lands inside the old name.
  assert.deepEqual(parseUnifiedDiff(fixture('rename-ambiguous-header')), [
    entry({ oldPath: 'p b/q.txt', newPath: 'r.txt', path: 'r.txt', status: 'R', similarity: 100 }),
  ]);
});

test('quoted-header-only.diff: header-only entries on quoted non-ASCII names (empty add, binary add/del/mod, mode-only)', () => {
  assert.deepEqual(parseUnifiedDiff(fixture('quoted-header-only')), [
    entry({ oldPath: null, newPath: 'naïve/empty é.txt', path: 'naïve/empty é.txt', status: 'A' }),
    entry({ oldPath: 'naïve/gone ✓.bin', newPath: null, path: 'naïve/gone ✓.bin', status: 'D', binary: true }),
    entry({ oldPath: null, newPath: 'naïve/new ✓.bin', path: 'naïve/new ✓.bin', status: 'A', binary: true }),
    entry({ oldPath: 'naïve/ß.bin', newPath: 'naïve/ß.bin', path: 'naïve/ß.bin', status: 'M', binary: true }),
    entry({ oldPath: 'naïve/é ü.sh', newPath: 'naïve/é ü.sh', path: 'naïve/é ü.sh', status: 'M' }),
  ]);
});

test('unquoteCPath rejects trailing text and input that is not a quoted token', () => {
  assert.throws(() => unquoteCPath('"a" b'), /trailing/);
  assert.throws(() => unquoteCPath('"a"x'), /trailing/);
  assert.throws(() => unquoteCPath('abc"'), /not a quoted/);
  assert.throws(() => unquoteCPath(''), /not a quoted/);
});
