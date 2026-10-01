import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseYaml } from '../pipeline/lib/yaml.mjs';

test('parses nested maps, lists, strings with braces', () => {
  const y = parseYaml('a: 1\nb:\n  c: [x, y]\nd: "npm run merge -- {pr}"\n');
  assert.deepEqual(y, { a: 1, b: { c: ['x', 'y'] }, d: 'npm run merge -- {pr}' });
});

test('keeps dates and yes/no as strings', () => {
  assert.deepEqual(parseYaml('x: 2026-10-01\ny: yes\n'), { x: '2026-10-01', y: 'yes' });
});

test('throws a readable error with line number on bad yaml', () => {
  assert.throws(() => parseYaml('a: [1,\n'), /line \d+/i);
});
