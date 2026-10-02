// The CLI entry guard must fire when the script is reached through a symlinked directory (a symlinked ~/.claude,
// macOS /tmp -> /private/tmp): Node realpaths import.meta.url but not process.argv[1].
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, symlinkSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('pipeline.mjs runs when invoked through a symlinked directory', { skip: process.platform === 'win32' }, (t) => {
  const tmp = realpathSync.native(mkdtempSync(join(tmpdir(), 'cp-symlink-')));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  symlinkSync(join(root, 'pipeline'), join(tmp, 'linked'), 'dir');
  const r = spawnSync(process.execPath, [join(tmp, 'linked', 'bin', 'pipeline.mjs'), 'version'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.trim().length > 0, 'stdout must not be empty');
  assert.equal(JSON.parse(r.stdout).ok, true);
});
