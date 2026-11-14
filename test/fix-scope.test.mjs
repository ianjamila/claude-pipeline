// #374 change 3 (PR A: pure and computed live in chooseBrief): fixRoundScope measures what a fix round adds so a new mechanism is flagged, and countedOrdinal
// numbers the counted rounds. Test files are ignored (classified under EVERY config given), exports are advisory, a doc is no source file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS } from '../pipeline/lib/config.mjs';
import { countedOrdinal, fixRoundScope } from '../pipeline/lib/fix-verify.mjs';
import { assertExit } from './helpers/assert-exit.mjs';
import { findingsOf, low, roundWorld } from './helpers/round-world.mjs';

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

// ---- `pipeline state fix-scope` (PR B): the same measure, over round R's toHead..HEAD, before the push. Real CLI, real git (test/helpers/round-world.mjs). ----------------------------
const body = (n, text = 'export const x') => Array.from({ length: n }, (_, i) => `${text}${i} = ${i};`).join('\n') + '\n';
// Round 1 reviewed (base..head), its one SUGGESTION accepted; the caller then makes the fix commit(s).
function reviewed(t, opts = {}) {
  const w = roundWorld(t, { max: 3, ...opts });
  assertExit(w.codex(1, findingsOf([], [low({ title: 'Issue 1' })])), 0);
  assertExit(w.judge(1, { 'R1-S1': ['ACCEPT'] }), 0);
  return w;
}
const scopeOf = (w, ...more) => w.cli(['state', 'fix-scope', '--round', '1', ...more]);

test('state fix-scope: a small edit of existing source is not flagged; the output is read-only (no state change)', (t) => {
  const w = reviewed(t);
  const before = w.stateText();
  w.repo.write('src/b.js', `${body(5, 'export const s')}`);
  w.repo.commit('small fix');
  const r = scopeOf(w);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.equal(r.json.ok, true);
  assert.deepEqual([r.json.round, r.json.flagged, r.json.fixScope.newFiles, r.json.fixScope.limit], [1, false, [], 150]);
  assert.ok(r.json.fixScope.nonTestLines >= 5);
  assert.equal(w.stateText(), before, 'read-only');
  assert.equal(w.state().rounds[0].fixScope, undefined, 'fixScope is never persisted on the round');
});

test('state fix-scope: lines over the limit flag; the stricter of the working-tree and fork-point limits wins', (t) => {
  const w = reviewed(t);
  w.repo.write('src/b.js', body(60, 'export const q'));
  w.repo.commit('bigger fix');
  assert.equal(scopeOf(w).json.flagged, false, '60 lines under the committed 150');
  w.config({ review: '  fix_round_max_lines: 20\n' });
  const tight = scopeOf(w);
  assert.deepEqual([tight.json.flagged, tight.json.fixScope.limit], [true, 20], 'working tree stricter than the fork point');
  assert.match(tight.json.reasons.join(';'), /non-test added lines > 20/);
  w.config({ review: '  fix_round_max_lines: 1000\n' });
  const loose = scopeOf(w);
  assert.deepEqual([loose.json.flagged, loose.json.fixScope.limit], [false, 150], 'a looser working-tree limit does not loosen the fork point');
  w.repo.write('src/b.js', body(200, 'export const z'));
  w.repo.commit('huge fix');
  assert.equal(scopeOf(w).json.flagged, true, 'over the fork-point limit even though the working tree allows 1000');
});

test('state fix-scope: a new non-test source file flags; a new document and new test files do not; exports are advisory text only', (t) => {
  const w = reviewed(t);
  w.repo.write('docs/notes.md', '# notes\n\nmore\n');
  w.repo.write('test/new.test.mjs', body(300, 'export const t'));
  w.repo.commit('docs and tests');
  const quiet = scopeOf(w);
  assert.deepEqual([quiet.json.flagged, quiet.json.fixScope.newFiles, quiet.json.fixScope.nonTestLines], [false, [], 3]);
  w.repo.write('src/helper.js', 'export function helper() {}\nexport const a = 1;\nexport const b = 2;\n');
  w.repo.commit('helper');
  const r = scopeOf(w);
  assert.deepEqual([r.json.flagged, r.json.fixScope.newFiles], [true, ['src/helper.js']]);
  assert.equal(r.json.fixScope.newExports, 3);
  assert.match(r.json.advisory.join(';'), /3 new exports/);
});

test('state fix-scope: exports alone never flag', (t) => {
  const w = reviewed(t);
  w.repo.write('src/b.js', `${body(8, 'export const w')}export function f1() {}\nexport function f2() {}\nexport function f3() {}\n`);
  w.repo.commit('exports');
  const r = scopeOf(w);
  assert.deepEqual([r.json.flagged, r.json.fixScope.newExports >= 3], [false, true]);
  assert.match(r.json.advisory.join(';'), /new exports/);
});

test('state fix-scope R3: a working-tree config that widens integrity.test_globs does not turn a new helper into a test file', (t) => {
  const w = reviewed(t);
  w.repo.write('helpers/make.js', body(400, 'export const h'));
  w.repo.commit('helper in a widened test glob');
  w.config({ yml: 'integrity:\n  test_globs: ["**/*.test.*", "test/**", "helpers/**"]\n' });
  const r = scopeOf(w);
  assert.deepEqual([r.json.flagged, r.json.fixScope.newFiles], [true, ['helpers/make.js']]);
});

test('state fix-scope: --head limits the range; an unknown round, a head that is not a descendant, and no state are refusals', (t) => {
  const w = reviewed(t);
  w.repo.write('src/big.js', `${body(200, 'export const huge')}`);
  const first = w.repo.commit('big edit');
  w.repo.write('docs/x.md', 'x\n');
  w.repo.commit('later doc');
  const cut = scopeOf(w, '--head', first);
  assertExit(cut, 0, cut.stderr + cut.stdout);
  assert.deepEqual([cut.json.head, cut.json.flagged], [first, true]);
  const none = w.cli(['state', 'fix-scope', '--round', '9']);
  assertExit(none, 2, none.stderr + none.stdout);
  assert.equal(none.json.error, 'no-round');
  const sideways = scopeOf(w, '--head', w.base);
  assertExit(sideways, 2, sideways.stderr + sideways.stdout);
  assert.equal(sideways.json.error, 'not-descendant');
  const missing = w.cli(['state', 'fix-scope']);
  assertExit(missing, 2, missing.stderr + missing.stdout);
});
