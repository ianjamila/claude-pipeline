// Small helpers the commands share for reading their arguments and writing their output: folding dash-leading option
// values, clipping command output, and writing a `.review/` json file atomically.
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const TAIL_LINES = 30;
const MAX_LINE = 400;

// tmp + rename: a reader (merge, final-gate) sees the old file or the whole new one, never half of it.
export function writeReviewJson(root, name, value) {
  const file = join(root, '.review', name);
  mkdirSync(join(root, '.review'), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, file);
  return file;
}

// Last `n` lines of command output: colours stripped, absurdly long lines (minified bundles) clipped.
export function tailLines(text, n = TAIL_LINES) {
  const lines = String(text ?? '')
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .split(/\r?\n/)
    .map((l) => (l.length > MAX_LINE ? `${l.slice(0, MAX_LINE)}...` : l));
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  return lines.slice(-n).join('\n');
}

// node's parseArgs refuses an option value that starts with a dash (`--line "- 2026-10-01 ..."`: markdown bullets do), so
// fold `--name value` into `--name=value` for the named options before parsing. Only the token right after the name is taken.
export function inlineOptionValues(argv, names) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (names.includes(a) && i + 1 < argv.length) {
      out.push(`${a}=${argv[i + 1]}`);
      i += 1;
    } else {
      out.push(a);
    }
  }
  return out;
}
