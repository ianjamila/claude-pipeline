// Why: `P substitute apply` requires --pr (exit 2 without it), and the review skill is the only caller; a skill line without it fails on every substitute round (R1-F4).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('every `substitute apply` command line in the skills and docs names --pr', () => {
  for (const file of ['skills/review/SKILL.md', 'skills/review/reference/substitute.md', 'skills/review/reference/special-rounds.md', 'docs/cli.md']) {
    const text = readFileSync(join(root, file), 'utf8');
    for (const m of text.matchAll(/(?:P|pipeline) substitute apply ([^`\n]*)/g)) assert.match(m[1], /--pr\b/, `${file}: ${m[0]}`);
  }
});
