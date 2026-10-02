// Cross-version test runner: Node 20 has no --test globbing and cmd.exe does not expand globs,
// so list the test files ourselves and hand them to node --test.
import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const testDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'test');
const only = process.argv.slice(2);
const files = readdirSync(testDir)
  .filter((f) => f.endsWith('.test.mjs'))
  .filter((f) => only.length === 0 || only.some((o) => f.includes(o)))
  .map((f) => join(testDir, f));
if (files.length === 0) {
  console.error('no test files matched');
  process.exit(2);
}
// A fixed machine id keeps lock tests from creating ~/.claude/pipeline-state/machine-id on the developer's machine.
const env = { ...process.env, PIPELINE_MACHINE_ID: process.env.PIPELINE_MACHINE_ID || 'test-machine-id' };
const r = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit', env });
process.exit(r.status ?? 1);
