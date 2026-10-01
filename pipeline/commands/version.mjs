// Reports the installed pipeline version so skills and the installer can detect drift.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXIT, parseCommandArgs } from '../lib/cli.mjs';

export const meta = { summary: 'print the pipeline version', usage: 'pipeline version' };

export async function run(argv) {
  parseCommandArgs(argv, {}, { allowPositionals: false });
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  let version = 'unknown';
  try { version = readFileSync(join(root, 'VERSION'), 'utf8').trim(); } catch {
    try { version = JSON.parse(readFileSync(join(root, 'pipeline', 'INSTALLED.json'), 'utf8')).version; } catch { /* keep unknown */ }
  }
  return { exitCode: EXIT.OK, output: { ok: true, version } };
}
