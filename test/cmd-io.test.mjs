// Unit tests for the helpers the commands share (lib/cmd-io.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inlineOptionValues, tailLines, writeReviewJson } from '../pipeline/lib/cmd-io.mjs';

test('tailLines: last N lines, colours stripped, long lines clipped, trailing blanks dropped', () => {
  const text = `${Array.from({ length: 40 }, (_, i) => `l${i + 1}`).join('\n')}\n\n`;
  const t = tailLines(text, 30).split('\n');
  assert.equal(t.length, 30);
  assert.equal(t[0], 'l11');
  assert.equal(t.at(-1), 'l40');
  assert.equal(tailLines('\x1b[31mred\x1b[0m'), 'red');
  assert.ok(tailLines('x'.repeat(1000)).length < 500);
  assert.equal(tailLines(undefined), '');
});

test('inlineOptionValues: folds \`--name value\` into \`--name=value\` so dash-leading values (markdown bullets) survive parseArgs', () => {
  assert.deepEqual(inlineOptionValues(['--pr', '12', '--line', '- 2026 · #12'], ['--line']), ['--pr', '12', '--line=- 2026 · #12']);
  assert.deepEqual(inlineOptionValues(['--line=- x', '--pr', '1'], ['--line']), ['--line=- x', '--pr', '1']);
  assert.deepEqual(inlineOptionValues(['--line'], ['--line']), ['--line'], 'a dangling flag is left for parseArgs to reject');
  assert.deepEqual(inlineOptionValues(['--other', '--line'], ['--line']), ['--other', '--line']);
  assert.deepEqual(inlineOptionValues(['--built', '- a', '--outcome', 'ok'], ['--built', '--outcome']), ['--built=- a', '--outcome=ok']);
});

test('writeReviewJson: creates .review/, writes pretty json with a newline, leaves no tmp file, and does not need a git repo', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-cmdio-'));
  const file = writeReviewJson(dir, 'a.json', { ok: true });
  assert.equal(file, join(dir, '.review', 'a.json'));
  assert.equal(readFileSync(file, 'utf8'), '{\n  "ok": true\n}\n');
  writeReviewJson(dir, 'a.json', { ok: false });
  assert.match(readFileSync(file, 'utf8'), /"ok": false/);
  assert.deepEqual(readdirSync(join(dir, '.review')), ['a.json']);
});
