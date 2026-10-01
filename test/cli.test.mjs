import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const bin = join(dirname(fileURLToPath(import.meta.url)), '..', 'pipeline', 'bin', 'pipeline.mjs');
const cli = (...args) => {
  const r = spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8' });
  return { code: r.status, json: r.stdout ? JSON.parse(r.stdout) : null, stderr: r.stderr };
};

test('no command → usage error exit 2 with command list', () => {
  const r = cli();
  assert.equal(r.code, 2);
  assert.ok(r.json.commands.includes('version'));
});

test('unknown command → exit 2', () => {
  const r = cli('nope');
  assert.equal(r.code, 2);
  assert.match(r.json.message, /unknown command: nope/);
});

test('path-like command names are rejected, not imported', () => {
  assert.equal(cli('../lib/cli').code, 2);
});

test('version prints one JSON object', () => {
  const r = cli('version');
  assert.equal(r.code, 0);
  assert.equal(r.json.ok, true);
  assert.match(r.json.version, /^\d+\.\d+\.\d+/);
});

test('unknown flag is a usage error', () => {
  const r = cli('version', '--bogus');
  assert.equal(r.code, 2);
  assert.equal(r.json.error, 'usage');
});
