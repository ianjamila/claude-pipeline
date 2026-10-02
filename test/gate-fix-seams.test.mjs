// Test seams (PIPELINE_GH / PIPELINE_CODEX / PIPELINE_VERCEL / PIPELINE_TEST_MODE) work from the repo checkout and are
// ignored, with one stderr warning, by an installed copy (a pipeline root holding INSTALLED.json).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isInstalledCopy, seamFlag, seamValue, overrideCommand, SEAM_VARS } from '../pipeline/lib/proc.mjs';

const here = dirname(fileURLToPath(import.meta.url));

function rootWith(manifest) {
  const dir = mkdtempSync(join(tmpdir(), 'cp-seam-'));
  if (manifest) writeFileSync(join(dir, 'INSTALLED.json'), '{}');
  return dir;
}

test('the repo checkout is not an installed copy, so seams are honoured', () => {
  assert.equal(isInstalledCopy(), false);
  assert.equal(seamValue('PIPELINE_GH', { PIPELINE_GH: 'node fake.mjs' }), 'node fake.mjs');
  assert.equal(seamFlag('PIPELINE_TEST_MODE', { PIPELINE_TEST_MODE: '1' }), true);
  assert.equal(seamFlag('PIPELINE_TEST_MODE', { PIPELINE_TEST_MODE: 'yes' }), false);
  assert.deepEqual(SEAM_VARS.slice().sort(), ['PIPELINE_CODEX', 'PIPELINE_GH', 'PIPELINE_TEST_MODE', 'PIPELINE_VERCEL']);
});

test('a root with INSTALLED.json ignores every seam and warns once per variable', (t) => {
  const root = rootWith(true);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(isInstalledCopy(root), true);
  const warnings = [];
  const opts = { root, warn: (m) => warnings.push(m) };
  assert.equal(seamValue('PIPELINE_CODEX', { PIPELINE_CODEX: 'node fake.mjs' }, opts), undefined);
  assert.equal(seamValue('PIPELINE_CODEX', { PIPELINE_CODEX: 'node fake.mjs' }, opts), undefined);
  assert.equal(seamFlag('PIPELINE_TEST_MODE', { PIPELINE_TEST_MODE: '1' }, opts), false);
  assert.equal(warnings.length, 2, warnings.join(''));
  assert.match(warnings[0], /ignoring PIPELINE_CODEX/);
  assert.equal(seamValue('PIPELINE_GH', {}, opts), undefined);
  assert.equal(warnings.length, 2, 'an unset seam is not worth a warning');
  assert.deepEqual(overrideCommand('PIPELINE_VERCEL', 'vercel', { PIPELINE_VERCEL: 'node fake.mjs' }, opts), { cmd: 'vercel', prefixArgs: [] });
});

test('a real installed copy: gh / codex / vercel / test-mode seams are ignored end to end', (t) => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'cp-installed-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const installed = join(dir, 'pipeline');
  cpSync(join(here, '..', 'pipeline'), installed, { recursive: true });
  writeFileSync(join(installed, 'INSTALLED.json'), '{}');
  // Built per root: the probe holds file:// URLs, so a string replace of a Windows path would never match.
  const probeFor = (root) => `
    const p = await import(${JSON.stringify(pathToFileURL(join(root, 'lib', 'proc.mjs')).href)});
    const v = await import(${JSON.stringify(pathToFileURL(join(root, 'lib', 'vercel.mjs')).href)});
    console.log(JSON.stringify({ codex: p.codexCommand(), vercel: v.vercelCommand(), mode: p.seamFlag('PIPELINE_TEST_MODE'), installed: p.isInstalledCopy() }));
  `;
  const probe = probeFor(installed);
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
    encoding: 'utf8',
    env: { ...process.env, PIPELINE_GH: 'node x', PIPELINE_CODEX: 'node fake-codex.mjs', PIPELINE_VERCEL: 'node fake-vercel.mjs', PIPELINE_TEST_MODE: '1' },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { codex: { cmd: 'codex', prefixArgs: [] }, vercel: { cmd: 'vercel', prefixArgs: [] }, mode: false, installed: true });
  for (const name of ['PIPELINE_CODEX', 'PIPELINE_VERCEL', 'PIPELINE_TEST_MODE']) assert.match(r.stderr, new RegExp(`ignoring ${name}`));

  // The same probe against the checkout honours them.
  const probe2 = probeFor(join(here, '..', 'pipeline'));
  const ok = spawnSync(process.execPath, ['--input-type=module', '-e', probe2], {
    encoding: 'utf8', env: { ...process.env, PIPELINE_CODEX: 'node fake-codex.mjs', PIPELINE_VERCEL: 'fv', PIPELINE_TEST_MODE: '1' },
  });
  assert.deepEqual(JSON.parse(ok.stdout), { codex: { cmd: 'node', prefixArgs: ['fake-codex.mjs'] }, vercel: { cmd: 'fv', prefixArgs: [] }, mode: true, installed: false });
  assert.equal(ok.stderr, '');
});
