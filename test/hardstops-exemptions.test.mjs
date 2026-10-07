// R5″-era review of the hard-stop EXEMPTIONS (docs/, markdown, test files): every way a change could reach production while
// sitting in a path the content rules skip. Table-driven: [name, files, expected rules] with hit and no-hit rows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUnifiedDiff } from '../pipeline/lib/diff.mjs';
import { cfg, file, rulesOf, run } from './helpers/hardstops.mjs';

const A = (path, ...added) => file(path, { status: 'A', added });
const rules = (files, opts) => rulesOf(run(files, opts));
// Built from pieces so this file never contains a real-looking secret.
const STRIPE = 'sk_' + 'live_' + 'abcdefghij1234';
const AWS = 'AKIA' + 'ABCDEFGHIJKLMNOP';
const JWT = 'eyJ' + 'hbGciOiJIUzI1NiIsInR5cCI6' + '.eyJ' + 'zdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6' + '.abcdefghij1234';
const EVIL = ['await supabase.auth.admin.deleteUser(id);', 'export const k = process.env.NEW_SECRET_THING;'];

// ---- (a) docs/** is exempt only for non-executable documentation ------------------------------------------------

const DOCS_ROWS = [
  // [path, expected rules]
  ['docs/evil.ts', ['R2-auth', 'R3-secrets']], ['docs/evil.tsx', ['R2-auth', 'R3-secrets']], ['docs/lib/evil.js', ['R2-auth', 'R3-secrets']],
  ['docs/evil.mjs', ['R2-auth', 'R3-secrets']], ['docs/evil.cjs', ['R2-auth', 'R3-secrets']], ['docs/EVIL.TS', ['R2-auth', 'R3-secrets']],
  ['docs/evil.mdx', ['R2-auth', 'R3-secrets']], ['docs/evil.json', ['R2-auth', 'R3-secrets']], ['docs/evil.html', ['R2-auth', 'R3-secrets']],
  ['docs/evil.svg', ['R2-auth', 'R3-secrets']], ['docs/Makefile', ['R2-auth', 'R3-secrets']], ['docs/evil', ['R2-auth', 'R3-secrets']],
  ['pages/guide.mdx', ['R2-auth', 'R3-secrets']], ['content/post.mdx', ['R2-auth', 'R3-secrets']],
  ['app/docs/page.md', ['R2-auth', 'R3-secrets']], ['pages/help.md', ['R2-auth', 'R3-secrets']],
  // genuinely non-executable documentation stays exempt
  ['docs/guide.md', []], ['docs/guide.MD', []], ['docs/notes.txt', []], ['docs/api.rst', []], ['docs/api.adoc', []],
  ['docs/img/arch.png', []], ['docs/img/a.JPG', []], ['docs/spec.pdf', []], ['README.md', []], ['packages/x/CHANGELOG.md', []],
  ['docs/deep/er/guide.md', []],
];
test('docs/ exempts only non-executable documentation; a module there is code (it can be imported); .mdx is code; .md under app/ or pages/ is a page', () => {
  for (const [p, expected] of DOCS_ROWS) assert.deepEqual(rules([A(p, ...EVIL)]), expected, p);
});

test('a SQL file under docs/ is scanned as SQL; docs/migrations stays a migration unless it is markdown', () => {
  assert.ok(rules([A('docs/seed.sql', 'drop table users;')]).includes('R1-destructive'));
  assert.deepEqual(rules([A('docs/migrations/plan.md', 'drop table users;')]), []);
});

// ---- (b) test files: key-shaped secrets still count; production code importing a test module is flagged ----------

const TEST_FILES = ['lib/pay.test.ts', 'lib/pay.spec.tsx', 'e2e/pay.ts', 'tests/helpers/pay.ts', 'lib/__tests__/pay.ts', 'supabase/tests/rls.test.sql'];
test('test files still hit on key-shaped secret literals', () => {
  for (const p of TEST_FILES) {
    const hits = run([A(p, `const key = "${STRIPE}";`)]);
    assert.deepEqual(rulesOf(hits), ['R3-secrets'], p);
    assert.match(hits[0].detail, /secret-like literal in a test file \(Stripe live key\)/);
    assert.equal(hits[0].excerpt, undefined, 'never echo the secret');
    assert.ok(!JSON.stringify(hits).includes(STRIPE));
  }
  assert.deepEqual(rules([A('lib/a.test.ts', `const k = "${AWS}";`)]), ['R3-secrets']);
});

test('test files stay exempt from everything else, and from fake-looking or JWT fixtures', () => {
  for (const p of TEST_FILES) {
    assert.deepEqual(rules([A(p, ...EVIL, 'payroll', 'DROP TABLE users;')]), [], p);
    assert.deepEqual(rules([A(p, `const jwt = "${JWT}";`)]), [], `${p}: local-stack JWT fixtures are everywhere`);
  }
  for (const line of [`k = "${AWS.slice(0, 4)}IOSFODNN7EXAMPLE"`, `// fake: ${STRIPE}`, `const k = "${STRIPE}"; // dummy`, `key: "${AWS}" // placeholder`]) {
    assert.deepEqual(rules([A('lib/a.test.ts', line)]), [], line);
  }
  assert.deepEqual(rules([A('docs/a.md', STRIPE)]), [], 'documentation is not judged for secrets');
});

const IMPORT_HITS = [
  "import { helper } from './pay.test';", "import helper from '../lib/pay.test.ts'", "import x from '@/lib/pay.spec'",
  "const h = require('./pay.test.js');", "const h = await import('./helpers/pay.spec.ts');", "export { h } from './pay.test'",
  "import h from '../tests/helpers/pay';", "import h from '@/e2e/support/login'", "import h from './__tests__/pay'", "import m from '../__mocks__/db'",
  "import f from '../fixtures/users'",
];
const IMPORT_NO_HITS = [
  "import { it } from 'node:test';", "import request from 'supertest';", "import x from './latest';", "import x from './contest';",
  "import x from './protest.ts';", "import { expect } from 'vitest';", "import x from './spec-utils';", "import x from '@testing-library/react';",
  "// import h from './pay.test'", "const s = 'see pay.test.ts';",
];
test('production code importing a test module is flagged (R0-unscannable); lookalikes and comments are not', () => {
  for (const line of IMPORT_HITS) {
    const hits = run([file('lib/pay.ts', { added: [line] })]);
    assert.deepEqual(rulesOf(hits), ['R0-unscannable'], line);
    assert.match(hits[0].detail, /imports a test\/fixture module into production code/);
  }
  for (const line of IMPORT_NO_HITS) assert.deepEqual(rules([file('lib/pay.ts', { added: [line] })]), [], line);
});

test('test files may import test modules, and so may docs', () => {
  for (const p of ['lib/a.test.ts', 'e2e/a.spec.ts', 'tests/helpers/b.ts', 'docs/a.md']) {
    assert.deepEqual(rules([file(p, { added: ["import h from './pay.test';", "import f from '../fixtures/users'"] })]), [], p);
  }
});

// ---- (c) content that moves: renames out of exempt paths, symlinks, binaries ------------------------------------

const RENAME_ROWS = [
  // [oldPath, newPath, expected]
  ['lib/evil.test.ts', 'lib/evil.ts', ['R0-unscannable']], ['tests/helpers/x.ts', 'lib/x.ts', ['R0-unscannable']],
  ['e2e/support.ts', 'src/support.ts', ['R0-unscannable']], ['docs/x.md', 'lib/x.ts', ['R0-unscannable']],
  ['docs/x.txt', 'lib/x.js', ['R0-unscannable']], ['lib/__tests__/a.ts', 'lib/a.ts', ['R0-unscannable']],
  // not a move out of an exempt path
  ['lib/a.ts', 'lib/b.ts', []], ['lib/a.test.ts', 'lib/b.test.ts', []], ['docs/a.md', 'docs/b.md', []],
  ['lib/a.ts', 'lib/a.test.ts', []], ['lib/a.ts', 'docs/a.md', []], ['docs/a.md', 'README.md', []],
];
test('a rename from a test/docs path into production code is flagged even when the diff shows no lines (100% similarity)', () => {
  for (const [oldPath, newPath, expected] of RENAME_ROWS) {
    assert.deepEqual(rules([file(newPath, { status: 'R', oldPath })]), expected, `${oldPath} -> ${newPath}`);
    assert.deepEqual(rules([file(newPath, { status: 'R', oldPath, added: ['// tweak'], removed: ['// old'] })]), expected, `${oldPath} -> ${newPath} (edited)`);
  }
});

test('renaming production code INTO an exempt path: added lines are not judged, but the removed side and path rules still are', () => {
  assert.deepEqual(rules([file('lib/auth/session.test.ts', { status: 'R', oldPath: 'lib/auth/session.ts' })]), ['R2-auth']);
  assert.deepEqual(rules([file('docs/auth.md', { status: 'R', oldPath: 'lib/auth/session.ts', removed: ['requireAuth(user);'] })]).sort(), ['R2-auth', 'R2-auth-removed']);
});

const diffOf = (body) => parseUnifiedDiff(body.join('\n') + '\n');
test('the diff parser marks symlinks (mode 120000) however they appear, and nothing else', () => {
  const sym = (hdr) => diffOf(['diff --git a/lib/x.ts b/lib/x.ts', ...hdr, '--- /dev/null', '+++ b/lib/x.ts', '@@ -0,0 +1 @@', '+../tests/evil.ts', '\\ No newline at end of file']);
  assert.equal(sym(['new file mode 120000', 'index 0000000..abc1234']).at(0).symlink, true);
  assert.equal(diffOf(['diff --git a/lib/x.ts b/lib/x.ts', 'deleted file mode 120000', 'index abc1234..0000000', '--- a/lib/x.ts', '+++ /dev/null', '@@ -1 +0,0 @@', '-../tests/evil.ts']).at(0).symlink, true);
  assert.equal(diffOf(['diff --git a/lib/x.ts b/lib/x.ts', 'index abc1234..def5678 120000', '--- a/lib/x.ts', '+++ b/lib/x.ts', '@@ -1 +1 @@', '-../a.ts', '+../b.ts']).at(0).symlink, true);
  assert.equal(diffOf(['diff --git a/lib/x.ts b/lib/x.ts', 'old mode 100644', 'new mode 120000']).at(0).symlink, true);
  const plain = diffOf(['diff --git a/lib/x.ts b/lib/x.ts', 'new file mode 100644', 'index 0000000..abc1234', '--- /dev/null', '+++ b/lib/x.ts', '@@ -0,0 +1 @@', '+x']).at(0);
  assert.equal(Object.hasOwn(plain, 'symlink'), false);
  const exec = diffOf(['diff --git a/lib/x.sh b/lib/x.sh', 'old mode 100644', 'new mode 100755']).at(0);
  assert.equal(Object.hasOwn(exec, 'symlink'), false);
});

test('a symlink is a hard-stop whatever it points at (its target may sit in an exempt path)', () => {
  for (const p of ['lib/evil.ts', 'src/app/page.tsx', 'tests/x.ts', 'docs/a.md', 'public/logo.png']) {
    for (const status of ['A', 'M', 'D']) {
      const f = { ...file(p, { status, added: status === 'D' ? [] : ['../tests/evil.ts'], removed: status === 'D' ? ['../tests/evil.ts'] : [] }), symlink: true };
      assert.ok(rules([f]).includes('R4-pipeline'), `${p} ${status}`);
    }
  }
  assert.deepEqual(rules([file('lib/x.ts', { status: 'A', added: ['x'] })]), []);
});

test('a wasm module is not an accepted binary asset (replacing one changes what runs with no source line)', () => {
  for (const status of ['A', 'M']) {
    assert.ok(rules([file('public/engine.wasm', { status, binary: true })]).includes('R0-unscannable'), status);
  }
  assert.deepEqual(rules([file('public/logo.png', { status: 'M', binary: true })]), []);
});

test('archives (.zip .gz .tgz .bin) are not accepted unread: replacing one that code extracts or loads changes what runs; only test fixtures are exempt', () => {
  for (const ext of ['zip', 'gz', 'tgz', 'bin', 'ZIP']) {
    for (const status of ['A', 'M']) {
      assert.ok(rules([file(`src/data.${ext}`, { status, binary: true })]).includes('R0-unscannable'), `src ${ext} ${status}`);
      assert.deepEqual(rules([file(`tests/fixtures/data.${ext}`, { status, binary: true })]), [], `fixture ${ext} ${status}`);
    }
  }
  // every path must be a test file: moving an archive between production and a fixture dir is not a fixture-only change
  assert.ok(rules([file('tests/fixtures/data.zip', { status: 'R', oldPath: 'src/data.zip', binary: true })]).includes('R0-unscannable'));
  assert.ok(rules([file('src/data.zip', { status: 'R', oldPath: 'tests/fixtures/data.zip', binary: true })]).includes('R0-unscannable'));
  assert.deepEqual(rules([file('tests/fixtures/b.zip', { status: 'R', oldPath: 'tests/fixtures/a.zip', binary: true })]), []);
  // images, fonts, media, pdf, svg and snapshots stay accepted anywhere
  for (const p of ['src/logo.png', 'public/a.woff2', 'public/a.mp4', 'docs/a.pdf', 'e2e/__snapshots__/a.snap']) assert.deepEqual(rules([file(p, { status: 'A', binary: true })]), [], p);
});

test('IO: the exemption holes through real git: docs module, test-to-prod rename, symlink', async () => {
  const { createTmpRepo } = await import('./helpers/tmprepo.mjs');
  const { collectHardStops } = await import('../pipeline/lib/hardstops.mjs');
  const { symlinkSync, mkdirSync } = await import('node:fs');
  const { join } = await import('node:path');
  const repo = createTmpRepo();
  repo.write('README.md', 'x\n');
  repo.write('tests/helpers/evil.ts', 'export const a = 1;\n');
  repo.write('lib/old.ts', 'export const old = 1;\n');
  repo.commit('base');
  repo.branch('feat');
  repo.write('docs/evil.ts', 'export const k = process.env.TOTALLY_NEW_KEY;\n');
  repo.git(['mv', 'tests/helpers/evil.ts', 'lib/evil.ts']);
  repo.git(['rm', '-q', 'lib/old.ts']);
  mkdirSync(join(repo.dir, 'lib'), { recursive: true });
  symlinkSync('../tests/helpers/x.ts', join(repo.dir, 'lib/old.ts'));
  repo.commit('attack');
  const hits = await collectHardStops({ base: 'main', head: 'feat', cwd: repo.dir, config: cfg() });
  const byFile = (p) => rulesOf(hits.filter((h) => h.file === p));
  assert.deepEqual(byFile('docs/evil.ts'), ['R3-secrets']);
  assert.deepEqual(byFile('lib/evil.ts'), ['R0-unscannable']);
  assert.ok(byFile('lib/old.ts').includes('R4-pipeline'), 'the symlink that replaced a production file');
});
