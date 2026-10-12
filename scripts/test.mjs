// Cross-version test runner: Node 20 has no --test globbing and cmd.exe does not expand globs,
// so list the test files ourselves and hand them to node --test.
import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
// Owner push notifications are off for the whole suite: no test may ever send a real push.
// A fixed machine id keeps lock tests from creating ~/.claude/pipeline-state/machine-id on the developer's machine.
// The secrets file is pointed at a path that never exists, so even a test that forgets to inject one cannot read the real
// ~/.config/claude-secrets.sh (test/notify.test.mjs has the guard).
const env = {
  ...process.env,
  PIPELINE_MACHINE_ID: process.env.PIPELINE_MACHINE_ID || 'test-machine-id',
  PIPELINE_NOTIFY: 'off',
  PIPELINE_SECRETS_FILE: join(tmpdir(), `pipeline-tests-no-secrets-${process.pid}`, 'claude-secrets.sh'),
};
const r = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit', env });
process.exit(r.status ?? 1);
