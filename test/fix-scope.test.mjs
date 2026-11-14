// #374 change 3 (PR A: pure and computed live in chooseBrief): fixRoundScope measures what a fix round adds so a new mechanism is flagged, and countedOrdinal
// numbers the counted rounds. Test files are ignored (classified under EVERY config given), exports are advisory, a doc is no source file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS } from '../pipeline/lib/config.mjs';
import { countedOrdinal, fixRoundScope } from '../pipeline/lib/fix-verify.mjs';

const cfg = (over = {}) => {
  const c = structuredClone(DEFAULTS);
  c.review = { ...c.review, ...over.review };
  c.integrity = { ...c.integrity, ...over.integrity };
  return c;
};
const lines = (n, text = 'x = 1;') => Array.from({ length: n }, (_, i) => ({ line: i + 1, text }));
const file = (path, added, { status = 'M', oldPath } = {}) => ({ oldPath: oldPath ?? path, newPath: path, path, status, binary: false, added: Array.isArray(added) ? added : lines(added), removed: [] });
const scope = (files, config = cfg()) => fixRoundScope({ files, config });

test('fixRoundScope: under the limit and no new source file is not flagged; the numbers are reported', () => {
  const r = scope([file('src/a.mjs', 40), file('src/b.mjs', 20)]);
  assert.deepEqual([r.nonTestLines, r.newFiles, r.limit, r.flagged, r.reasons], [60, [], 150, false, []]);
});

test('fixRoundScope: more non-test added lines than review.fix_round_max_lines flags (the limit itself does not)', () => {
  assert.equal(scope([file('src/a.mjs', 150)]).flagged, false);
  const over = scope([file('src/a.mjs', 151)]);
  assert.equal(over.flagged, true);
  assert.match(over.reasons.join(';'), /151 non-test added lines > 150/);
  assert.equal(scope([file('src/a.mjs', 31)], cfg({ review: { fix_round_max_lines: 30 } })).flagged, true);
});

test('fixRoundScope: a new non-test SOURCE file flags; a new document, a docs_exempt_paths file and a new test file do not', () => {
  const src = scope([file('src/new-helper.mjs', 5, { status: 'A' })]);
  assert.deepEqual([src.flagged, src.newFiles], [true, ['src/new-helper.mjs']]);
  assert.match(src.reasons.join(';'), /new non-test file/);
  assert.equal(scope([file('docs/notes.md', 5, { status: 'A' })]).flagged, false, 'a document is not a mechanism');
  assert.equal(scope([file('README.md', 5, { status: 'A' })]).flagged, false);
  assert.equal(scope([file('notes/extra.md', 5, { status: 'A' })], cfg({ review: { docs_exempt_paths: ['notes/extra.md'] } })).flagged, false);
  assert.equal(scope([file('test/new.test.mjs', 500, { status: 'A' })]).flagged, false, 'test files are ignored, lines and all');
});

test('fixRoundScope: test files do not count toward the lines', () => {
  const r = scope([file('src/a.mjs', 10), file('test/a.test.mjs', 400)]);
  assert.deepEqual([r.nonTestLines, r.flagged], [10, false]);
});

test('fixRoundScope: new exports are counted but advisory only (never flag on their own)', () => {
  const exports = ['export function a() {}', 'export async function b() {}', 'export const c = 1;', 'export class D {}', 'const notExported = 1;'].map((text, i) => ({ line: i + 1, text }));
  const r = scope([file('src/a.mjs', exports)]);
  assert.deepEqual([r.newExports, r.flagged], [4, false]);
});

test('fixRoundScope R3: a file is a test only when EVERY config classifies it so; a renamed file counts as new unless both paths are test under all', () => {
  const widened = cfg({ integrity: { test_globs: [...DEFAULTS.integrity.test_globs, 'helpers/**'] } });
  const helper = file('helpers/make.mjs', 400, { status: 'A' });
  assert.equal(fixRoundScope({ files: [helper], config: widened }).flagged, false, 'one config alone says test');
  const both = fixRoundScope({ files: [helper], configs: [widened, cfg()] });
  assert.deepEqual([both.flagged, both.newFiles], [true, ['helpers/make.mjs']], 'the stricter config does not: round k widened test_globs, round k+1 adds a helper there');
  const moved = file('test/b.test.mjs', 5, { status: 'R', oldPath: 'src/b.mjs' });
  assert.equal(scope([moved]).flagged, true, 'a rename from a source path to a test path is a new non-test file');
  const within = file('test/b.test.mjs', 5, { status: 'R', oldPath: 'test/a.test.mjs' });
  assert.equal(scope([within]).flagged, false);
  assert.equal(fixRoundScope({ files: [file('src/a.mjs', 100)], configs: [cfg({ review: { fix_round_max_lines: 200 } }), cfg({ review: { fix_round_max_lines: 50 } })] }).limit, 50, 'the stricter limit');
});

test('fixRoundScope: bad input throws instead of reading as "not flagged"', () => {
  assert.throws(() => fixRoundScope({ files: 'x', config: cfg() }), TypeError);
  assert.throws(() => fixRoundScope({ files: [], config: null }), TypeError);
});

test('countedOrdinal: the number of counted rounds up to and including n (base-only, resolution-only and Fable-refresh rounds are not counted)', () => {
  const state = { rounds: [{ n: 1 }, { n: 2, baseOnly: true }, { n: 3 }, { n: 4, resolutionOnly: true }, { n: 5, fableRefresh: true }, { n: 6 }] };
  assert.deepEqual([1, 2, 3, 4, 5, 6].map((n) => countedOrdinal(state, n)), [1, 1, 2, 2, 2, 3]);
  assert.equal(countedOrdinal({ rounds: [] }, 1), 0);
});
