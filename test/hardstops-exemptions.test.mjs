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
  // The fake marker must sit IN the credential token itself (AWS's documented example key does).
  for (const line of [`k = "${AWS.slice(0, 4)}IOSFODNN7EXAMPLE"`, `k = "${STRIPE}EXAMPLE"`, `k = "sk_live_${'x'.repeat(12)}"`, `k = "${AWS.slice(0, 4)}0000000000000000"`, `k = "fake_${STRIPE}"`]) {
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
  "const s = 'see pay.test.ts';",
];
test('a fake marker elsewhere on the line (comment, neighbouring identifier) does not exempt a real-looking key', () => {
  for (const line of [
    `const k = "${STRIPE}"; // example`, `// fake: ${STRIPE}`, `const k = "${STRIPE}"; // dummy`, `key: "${AWS}" // placeholder`,
    `const fakeUser = { id: 1, key: "${STRIPE}" };`, `const k = "${STRIPE}"; const e = "AKIAIOSFODNN7EXAMPLE";`, `dummy("${AWS}")`,
  ]) {
    assert.deepEqual(rules([A('lib/a.test.ts', line)]), ['R3-secrets'], line);
  }
});

test('production code importing a test module is flagged (R0-unscannable); lookalikes and comments are not', () => {
  for (const line of IMPORT_HITS) {
    const hits = run([file('lib/pay.ts', { added: [line] })]);
    assert.deepEqual(rulesOf(hits), ['R0-unscannable'], line);
    assert.match(hits[0].detail, /imports a test\/fixture module into production code/);
  }
  for (const line of IMPORT_NO_HITS) assert.deepEqual(rules([file('lib/pay.ts', { added: [line] })]), [], line);
});

// Import detection resolves each specifier to candidate repo paths and asks the SAME predicate the exemption uses, so no spelling
// of a path into an exempt location slips past (the old fixed regex missed every row below).
const IMPORT_FORMS = [
  // [file, line] in production code, each naming a module the exemption predicate treats as a test file
  ['lib/pay.ts', "import h from '../spec/helper'"], ['lib/pay.ts', "import h from '@/cypress/helper'"], ['lib/pay.ts', "import h from './helper.cy'"],
  ['lib/pay.ts', "import h from 'tests/helper'"], ['lib/pay.ts', "import { x } from 'e2e/support/x';"], ['lib/pay.ts', "import '@acme/x/tests/h'"],
  ['lib/pay.ts', "import h from '~/e2e/x'"], ['lib/pay.ts', "import h from '#/spec/x'"], ['lib/pay.ts', "import h from '@@/tests/x'"],
  ['lib/a/b/pay.ts', "const h = require('../../../tests/x');"], ['lib/pay.ts', "const h = await import('../spec/x')"], ['lib/pay.ts', "export * from '../cypress/x'"],
  ['lib/pay.ts', "} from '../tests/x';"], ['lib/pay.ts', "import '../spec/setup';"], ['lib/pay.ts', "const h = require.resolve('./tests/x')"],
  ['lib/pay.ts', "import h from './conftest.py'"], ['lib/pay.tsx', 'import h from "../e2e/x.js"'], ['lib/pay.mjs', "import h from `../spec/x`"],
  ['app/views.py', 'from tests.helper import x'], ['app/views.py', 'import tests.helper'], ['app/views.py', 'import os, tests.helper as th'],
  ['app/views.py', 'from ..tests.helper import x'], ['app/views.py', 'from . import conftest'], ['app/views.py', 'from tests import helper'],
  ['app/views.py', "m = importlib.import_module('tests.helper')"], ['app/views.py', 'from .test_helpers import x'],
  ['lib/pay.rb', "require_relative 'spec/x'"], ['lib/pay.rb', "require_relative '../spec/x'"], ['lib/pay.rb', "require 'spec/helper'"], ['lib/pay.rb', 'load "tests/x.rb"'],
];
const IMPORT_FORMS_CLEAN = [
  ['lib/pay.ts', "import test from 'node:test';"], ['lib/pay.ts', "import x from '@/lib/spec-utils'"], ['lib/pay.ts', "import x from 'inspector'"],
  ['lib/pay.ts', "import x from './helper'"], ['lib/pay.ts', "import x from '../lib/pay'"], ['lib/pay.ts', "const x = require('@acme/x/lib/h')"],
  ['app/views.py', 'import os, json'], ['app/views.py', 'from collections import abc'], ['app/views.py', 'from . import util'], ['app/views.py', 'from app.models import User'],
  ['lib/pay.rb', "require 'json'"], ['lib/pay.rb', "require_relative 'helpers'"],
];
test('every spelling of an import that resolves into an exempt test path is flagged (R0-unscannable); lookalikes are not', () => {
  for (const [path, line] of IMPORT_FORMS) {
    const hits = run([file(path, { added: [line] })]);
    assert.deepEqual(rulesOf(hits), ['R0-unscannable'], `${path}: ${line}`);
    assert.match(hits[0].detail, /imports a test\/fixture module into production code/);
  }
  for (const [path, line] of IMPORT_FORMS_CLEAN) assert.deepEqual(rules([file(path, { added: [line] })]), [], `${path}: ${line}`);
});

test('an exempt module that deletes users is not judged, and the production file that imports it through a root-level spelling is flagged', () => {
  const evil = ['await supabase.auth.admin.deleteUser(id);', 'await db.from("patients").delete().eq("id", id);'];
  const hits = run([A('spec/helper.ts', ...evil), A('lib/pay.ts', "import { wipe } from '../spec/helper';")]);
  assert.deepEqual(rulesOf(hits), ['R0-unscannable']);
  assert.equal(hits[0].file, 'lib/pay.ts');
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

// A 100% rename prints only similarity/rename headers (no mode line), so the diff parser cannot see a symlink or submodule
// that merely MOVES; collectHardStops reads the tree modes from `git diff --raw` instead.
test('IO: a 100% rename of an existing symlink (or gitlink) is still a symlink (R4); a plain 100% rename is not', async () => {
  const { createTmpRepo } = await import('./helpers/tmprepo.mjs');
  const { collectHardStops } = await import('../pipeline/lib/hardstops.mjs');
  const repo = createTmpRepo();
  repo.write('README.md', 'x\n');
  repo.write('assets/plain.js', 'export const plain = 1;\nexport const more = 2;\nexport const evenMore = 3;\n');
  repo.commit('base');
  // Index-only entries: no dependence on the platform's symlink support in the working tree.
  const blob = repo.git(['hash-object', '-w', '--stdin'], { input: '../tests/helpers/evil.js' }).trim();
  repo.git(['update-index', '--add', '--cacheinfo', `120000,${blob},assets/helper.js`]);
  repo.git(['update-index', '--add', '--cacheinfo', '160000,1234567890123456789012345678901234567890,vendor/sub']);
  repo.git(['commit', '-q', '-m', 'add symlink and gitlink']);
  repo.branch('feat');
  repo.git(['update-index', '--force-remove', 'assets/helper.js']);
  repo.git(['update-index', '--add', '--cacheinfo', `120000,${blob},src/helper.js`]);
  repo.git(['update-index', '--force-remove', 'vendor/sub']);
  repo.git(['update-index', '--add', '--cacheinfo', '160000,1234567890123456789012345678901234567890,deps/sub']);
  repo.git(['update-index', '--force-remove', 'assets/plain.js']);
  const plain = repo.git(['hash-object', '-w', 'assets/plain.js']).trim();
  repo.git(['update-index', '--add', '--cacheinfo', `100644,${plain},src/plain.js`]);
  repo.git(['commit', '-q', '-m', 'move them']);
  const hits = await collectHardStops({ base: 'main', head: 'feat', cwd: repo.dir, config: cfg() });
  const byFile = (p) => hits.filter((h) => h.file === p);
  assert.ok(byFile('src/helper.js').some((h) => h.rule === 'R4-pipeline' && /symlink/.test(h.detail)), 'moved symlink');
  assert.ok(byFile('deps/sub').some((h) => h.rule === 'R4-pipeline' && /submodule/.test(h.detail)), 'moved gitlink');
  assert.deepEqual(rulesOf(byFile('src/plain.js')), [], 'an ordinary 100% rename stays clean');
});

// ---- reverse case: unchanged production code already imports the exempt file this PR edits -------------------------------

async function reverseRepo(base) {
  const { createTmpRepo } = await import('./helpers/tmprepo.mjs');
  const repo = createTmpRepo();
  repo.write('README.md', 'x\n');
  for (const [p, c] of Object.entries(base)) repo.write(p, c);
  repo.commit('base');
  repo.branch('feat');
  return repo;
}
async function collectWith(repo, extra = {}) {
  const { collectHardStops } = await import('../pipeline/lib/hardstops.mjs');
  return collectHardStops({ base: 'main', head: 'feat', cwd: repo.dir, config: cfg(), ...extra });
}
const EVIL_BODY = 'export const wipe = () => supabase.auth.admin.deleteUser(id);\n';

test('IO: editing an exempt test file that unchanged production code already imports is flagged on the test file, naming the importer', async () => {
  const cases = [
    ['tests/helper.ts', 'lib/pay.ts', "import { wipe } from '../tests/helper';\n"],
    ['tests/helper.ts', 'lib/pay.ts', "import { wipe } from '@/tests/helper';\n"],
    ['packages/web/tests/helper.ts', 'packages/web/src/pay.ts', "import { wipe } from '../tests/helper';\n"],
    ['packages/web/tests/helper.ts', 'src/pay.ts', "import { wipe } from '@acme/web/tests/helper';\n"],
    ['spec/support/seed.ts', 'lib/pay.ts', "const { wipe } = require('../spec/support/seed');\n"],
    ['tests/helper.py', 'app/views.py', 'from tests.helper import wipe\n'],
    ['spec/x.rb', 'lib/pay.rb', "require_relative '../spec/x'\n"],
    ['tests/helpers/index.ts', 'lib/pay.ts', "import { wipe } from '../tests/helpers';\n"],
    ['lib/pay.test.ts', 'lib/other.ts', "import { wipe } from './pay.test';\n"],
  ];
  for (const [testPath, importer, line] of cases) {
    const repo = await reverseRepo({ [testPath]: 'export const wipe = () => 1;\n', [importer]: line });
    repo.write(testPath, EVIL_BODY);
    repo.commit('edit the exempt helper only');
    const hits = await collectWith(repo);
    assert.deepEqual(rulesOf(hits), ['R0-unscannable'], testPath);
    assert.equal(hits[0].file, testPath);
    assert.match(hits[0].detail, new RegExp(`production code \\(${importer.replace(/[.]/g, '\\.')}:1\\)`), testPath);
  }
});

test('IO: a changed test file that no production code imports stays quiet, whatever its basename resembles', async () => {
  const repo = await reverseRepo({
    'tests/helper.ts': 'export const a = 1;\n', 'tests/helpers/pay.ts': 'export const b = 1;\n', 'lib/pay.ts': 'export const p = 1;\n',
    'lib/other.ts': "import { p } from './pay';\nimport x from 'helper';\nimport y from 'lib/pay';\n", // same names, different modules
    'docs/note.md': "import h from '../tests/helper'\n", // documentation is not code
  });
  repo.write('tests/helper.ts', EVIL_BODY);
  repo.write('tests/helpers/pay.ts', EVIL_BODY);
  repo.commit('edit unimported helpers');
  assert.deepEqual(rulesOf(await collectWith(repo)), []);
});

test('IO: the reverse check fails closed: a file name git cannot search for, or more candidate importers than the cap, flags the test file', async () => {
  const repo = await reverseRepo({ 'tests/helper.ts': 'export const a = 1;\n', 'lib/pay.ts': "import { a } from '../tests/helper';\n", 'lib/pay2.ts': "import { a } from '../tests/helper';\n" });
  repo.write('tests/helper.ts', EVIL_BODY);
  repo.commit('edit');
  const capped = await collectWith(repo, { maxImporterHits: 1 });
  assert.deepEqual(rulesOf(capped), ['R0-unscannable']);
  assert.match(capped[0].detail, /could not be checked \(more than 1 files mention it\)/);
  assert.deepEqual(rulesOf(await collectWith(repo, { maxImporterHits: 2 })), ['R0-unscannable']); // within the cap: found for real
  assert.doesNotMatch((await collectWith(repo, { maxImporterHits: 2 }))[0].detail, /could not be checked/);
  if (process.platform !== 'win32') {
    const odd = await reverseRepo({ 'README.md': 'x\n' });
    odd.write('tests/a\nb.ts', 'export const a = 1;\n');
    odd.commit('add a test file whose name has a newline');
    const hits = await collectWith(odd);
    assert.deepEqual(rulesOf(hits), ['R0-unscannable']);
    assert.match(hits[0].detail, /a file name cannot be searched for/);
  }
});

// ---- review round 2: .js written for .ts, transitive chains, imports split over lines, imports after a block comment ----------

test('a TypeScript-ESM import (`.js` written for a `.ts` file) reaches the test file: forward and reverse', async () => {
  // forward: the test glob only matches the .ts spelling
  const config = cfg({ test_globs: ['helpers/**/*.ts'] });
  assert.deepEqual(rulesOf(run([file('lib/pay.ts', { added: ["import { x } from '../helpers/x.js';"] })], { config })), ['R0-unscannable']);
  assert.deepEqual(rulesOf(run([file('lib/pay.ts', { added: ["import { x } from '../helpers/x.mjs';"] })], { config: cfg({ test_globs: ['helpers/**/*.mts'] }) })), ['R0-unscannable']);
  assert.deepEqual(rulesOf(run([file('lib/pay.ts', { added: ["import { x } from '../helpers/y.js';"] })], { config: cfg({ test_globs: ['helpers/x.ts'] }) })), []);
  // reverse
  const repo = await reverseRepo({ 'tests/helper.ts': 'export const wipe = () => 1;\n', 'lib/pay.ts': "import { wipe } from '../tests/helper.js';\n" });
  repo.write('tests/helper.ts', EVIL_BODY);
  repo.commit('edit');
  const hits = await collectWith(repo);
  assert.deepEqual(hits.map((h) => [h.rule, h.file]), [['R0-unscannable', 'tests/helper.ts']]);
});

test('IO: the reverse check follows test-to-test imports: prod -> tests/a.ts -> tests/b.ts, editing only b is flagged', async () => {
  const chain = { 'lib/pay.ts': "import { a } from '../tests/a';\n", 'tests/a.ts': "export * from './b';\n", 'tests/b.ts': 'export const b = 1;\n' };
  const repo = await reverseRepo(chain);
  repo.write('tests/b.ts', EVIL_BODY);
  repo.commit('edit b only');
  const hits = await collectWith(repo);
  assert.deepEqual(hits.map((h) => [h.rule, h.file]), [['R0-unscannable', 'tests/b.ts']]);
  assert.match(hits[0].detail, /production code \(lib\/pay\.ts:1, through tests\/a\.ts\)/);

  // three deep, with a cycle; an unrelated test file importing b is not a chain from production
  const deep = await reverseRepo({
    'lib/pay.ts': "import { a } from '../tests/a';\n", 'tests/a.ts': "export * from './b';\n", 'tests/b.ts': "export * from './c';\nimport './a';\n",
    'tests/c.ts': 'export const c = 1;\n', 'tests/d.ts': 'export const d = 1;\n', 'tests/lonely.ts': "import './d';\n",
  });
  deep.write('tests/c.ts', EVIL_BODY);
  deep.write('tests/d.ts', EVIL_BODY);
  deep.commit('edit c and d');
  const hits2 = await collectWith(deep);
  assert.deepEqual(hits2.map((h) => h.file).sort(), ['tests/c.ts']);

  // a chain deeper than the round cap fails closed (every file concerned is flagged)
  const files = { 'lib/pay.ts': "import '../tests/t0';\n" };
  for (let i = 0; i < 8; i++) files[`tests/t${i}.ts`] = i < 7 ? `import './t${i + 1}';\n` : 'export const end = 1;\n';
  const long = await reverseRepo(files);
  long.write('tests/t7.ts', EVIL_BODY);
  long.commit('edit the end of a long chain');
  const hits3 = await collectWith(long);
  assert.deepEqual(hits3.map((h) => h.file), ['tests/t7.ts']);
  assert.match(hits3[0].detail, /could not be checked \(test files import each other more than 5 deep\)/);
});

const SPLIT_IMPORTS = [
  ["const h = require(", "  '../tests/helper'", ');'], ['const m = await import(', "'../spec/x')"], ['import {', '  wipe,', "} from '../tests/x';"],
  ['import wipe', "  from '../spec/x'"], ['export {', ' a', "} from '../cypress/x'"],
];
test('an import split over several lines is read whole: forward (whatever lines the diff added) and reverse', async () => {
  for (const lines of SPLIT_IMPORTS) {
    assert.deepEqual(rules([file('lib/pay.ts', { added: lines })]), ['R0-unscannable'], `added all: ${lines.join(' / ')}`);
    // only the line that holds the specifier was added; the rest is unchanged context, known from the head text
    const at = lines.findIndex((l) => /['"]\.\.\//.test(l));
    const hits = run([file('lib/pay.ts', { added: [lines[at]], at: at + 1 })], { headFiles: new Map([['lib/pay.ts', lines.join('\n') + '\n']]) });
    assert.deepEqual(rulesOf(hits), ['R0-unscannable'], `context: ${lines.join(' / ')}`);
    // an edit elsewhere in the file leaves an old split import alone (the reverse check, not this one, owns it)
    assert.deepEqual(rules([file('lib/pay.ts', { added: ['const x = 1;'], at: 10 })], { headFiles: new Map([['lib/pay.ts', [...lines, '', '', '', '', '', '', '', '', 'const x = 1;'].join('\n')]]) }), []);
  }
  for (const lines of SPLIT_IMPORTS.slice(0, 3)) {
    const repo = await reverseRepo({ 'tests/helper.ts': 'export const wipe = 1;\n', 'tests/x.ts': 'export const wipe = 1;\n', 'spec/x.ts': 'export const wipe = 1;\n', 'cypress/x.ts': 'export const a = 1;\n', 'lib/pay.ts': lines.join('\n') + '\n' });
    const target = lines.join(' ').match(/(tests\/helper|tests\/x|spec\/x)/)[1] + '.ts';
    repo.write(target, EVIL_BODY);
    repo.commit('edit');
    const hits = await collectWith(repo);
    assert.deepEqual(hits.map((h) => h.file), [target], lines.join(' / '));
    assert.match(hits[0].detail, /production code \(lib\/pay\.ts:\d+\)/);
  }
});

const AFTER_COMMENT = [
  "/* eslint-disable */ import { wipe } from '../tests/helper';", "*/ const h = require('../spec/x')", "/* a */ /* b */ import h from '../tests/h'",
  "/** doc */ const m = await import('../cypress/x')", " * end of a comment */ import h from '../tests/h'",
];
// Comments are never blanked for the import checks (a comment prefix is not always a comment), so an import written inside one is
// flagged too: an accepted false positive.
const COMMENTED_IMPORTS = ["// import h from '../tests/helper'", "-- import h from '../tests/helper'", "  // require('../spec/x')", "// import h from './pay.test'"];
test('an import after a closed block comment is code, not a comment; a commented-out import is flagged too (accepted); empty comment lines are quiet', async () => {
  for (const line of AFTER_COMMENT) assert.deepEqual(rules([file('lib/pay.ts', { added: [line] })]), ['R0-unscannable'], line);
  for (const line of ['/*', '*/', '// nothing to see', '# a note', '-- a note']) assert.deepEqual(rules([file('lib/pay.ts', { added: [line] })]), [], line);
  for (const line of [...COMMENTED_IMPORTS, "/* import h from '../tests/helper' */", " * import h from '../tests/helper'"]) assert.deepEqual(rules([file('lib/pay.ts', { added: [line] })]), ['R0-unscannable'], line);
  for (const line of AFTER_COMMENT.slice(0, 2)) {
    const repo = await reverseRepo({ 'tests/helper.ts': 'export const wipe = 1;\n', 'spec/x.ts': 'export const a = 1;\n', 'lib/pay.ts': line + '\n' });
    const target = line.includes('spec') ? 'spec/x.ts' : 'tests/helper.ts';
    repo.write(target, EVIL_BODY);
    repo.commit('edit');
    assert.deepEqual((await collectWith(repo)).map((h) => h.file), [target], line);
  }
});

// ---- review round 3: leading `*`, unclosed quotes, Python statements over several lines ----------------------------------------

const STAR_CODE = [
  "*gen() { return require('../tests/helper') }", "  *require('../tests/x').k", "**(await import('../spec/x')).v", "*gen() { return require('../tests/helper') } /* done */",
  "a = b */ require('../tests/x'); /* c", "*/ x = 1; /* a */ const h = require('../spec/x')",
];
test('a line that merely starts with `*` (generator, multiplication, spread of a call) is code; a later `*/` does not hide what comes before it', async () => {
  for (const line of STAR_CODE) assert.deepEqual(rules([file('lib/pay.ts', { added: [line] })]), ['R0-unscannable'], line);
  const repo = await reverseRepo({ 'tests/helper.ts': 'export const wipe = 1;\n', 'lib/pay.ts': STAR_CODE[0] + '\n' });
  repo.write('tests/helper.ts', EVIL_BODY);
  repo.commit('edit');
  assert.deepEqual((await collectWith(repo)).map((h) => h.file), ['tests/helper.ts']);
});

test('an unclosed quote earlier in the text does not swallow a real import: forward (whole file and added lines) and reverse', async () => {
  const lines = ['doThing(); // see require("', "const h = require('../tests/helper');", 'const s = "from \'";', "import x from '../spec/x';"];
  assert.deepEqual(rules([file('lib/pay.ts', { added: lines })]), ['R0-unscannable']);
  const hits = run([file('lib/pay.ts', { added: [lines[1]], at: 2 })], { headFiles: new Map([['lib/pay.ts', lines.join('\n')]]) });
  assert.deepEqual(rulesOf(hits), ['R0-unscannable']);
  assert.equal(hits[0].line, 2);
  const repo = await reverseRepo({ 'tests/helper.ts': 'export const wipe = 1;\n', 'lib/pay.ts': lines.slice(0, 2).join('\n') + '\n' });
  repo.write('tests/helper.ts', EVIL_BODY);
  repo.commit('edit');
  assert.deepEqual((await collectWith(repo)).map((h) => h.file), ['tests/helper.ts']);
  // the specifier itself is read cleanly (the resolver's tail matching alone would also flag the garbage a swallowing match yields)
  const { importSpecifiers } = await import('../pipeline/lib/hardstops.mjs');
  assert.deepEqual(importSpecifiers(lines.join('\n'), 'lib/pay.ts').map((x) => x.spec).sort(), ['../spec/x', '../tests/helper']);
  // a specifier never spans a line break, and its closing quote must match its opening one
  assert.deepEqual(rules([file('lib/pay.ts', { added: ["const t = from('", "tests/helper');"] })]), []);
});

test('Python imports split over lines (brackets, backslashes) are one statement: forward by whichever line was added, and reverse', async () => {
  const paren = ['from pkg import (', '    models,', '    tests,', ')'];
  const slash = ['import os, \\', '    tests.helper'];
  assert.deepEqual(rules([file('app/views.py', { added: paren })]), ['R0-unscannable']);
  assert.deepEqual(rules([file('app/views.py', { added: slash })]), ['R0-unscannable']);
  // only one line inside an existing block was added
  for (const [lines, at] of [[paren, 3], [slash, 2], [['from pkg import (', '    models,', '    tests,', ')'], 3]]) {
    const hits = run([file('app/views.py', { added: [lines[at - 1]], at })], { headFiles: new Map([['app/views.py', lines.join('\n')]]) });
    assert.deepEqual(rulesOf(hits), ['R0-unscannable'], lines.join(' / '));
  }
  // an unrelated added line in the same file stays quiet, and a clean statement over lines stays quiet
  assert.deepEqual(rules([file('app/views.py', { added: ['x = 1'], at: 6 })], { headFiles: new Map([['app/views.py', [...paren, '', '', 'x = 1'].join('\n')]]) }), []);
  assert.deepEqual(rules([file('app/views.py', { added: ['from pkg import (', '    models,', '    views,', ')'] })]), []);
  const repo = await reverseRepo({ 'tests/helper.py': 'def wipe(): pass\n', 'app/views.py': slash.join('\n') + '\n' });
  repo.write('tests/helper.py', 'def wipe(): delete_everything()\n');
  repo.commit('edit');
  assert.deepEqual((await collectWith(repo)).map((h) => h.file), ['tests/helper.py']);
});

// ---- review round 4: comments are never blanked; Python tokenizer; no statement cap while a bracket is open -----------------------

const COMMENT_PREFIX_CODE = [
  ['lib/pay.ts', "-- i; const h = require('../tests/helper')"], ['app/views.py', '-- x; import tests.helper'],
  ['lib/pay.ts', "// */ require('../tests/helper')"], ['lib/pay.ts', "# x; import('../spec/x')"], ['app/views.py', '# ; from tests.helper import x'],
];
test('a comment-looking prefix hides nothing: `-- i; require(..)`, `-- x; import tests.helper`, `// */ require(..)` are all read as imports (forward, reverse)', async () => {
  for (const [path, line] of COMMENT_PREFIX_CODE) assert.deepEqual(rules([file(path, { added: [line] })]), ['R0-unscannable'], `${path}: ${line}`);
  for (const [path, line, testPath] of [['lib/pay.ts', COMMENT_PREFIX_CODE[0][1], 'tests/helper.ts'], ['app/views.py', COMMENT_PREFIX_CODE[1][1], 'tests/helper.py'], ['lib/pay.ts', COMMENT_PREFIX_CODE[2][1], 'tests/helper.ts']]) {
    const repo = await reverseRepo({ [testPath]: 'x = 1\n', [path]: line + '\n' });
    repo.write(testPath, EVIL_BODY);
    repo.commit('edit');
    assert.deepEqual((await collectWith(repo)).map((h) => h.file), [testPath], line);
  }
  // and through a chain: prod -> tests/a.ts (the commented-looking import) -> tests/b.ts
  const repo = await reverseRepo({ 'lib/pay.ts': "import '../tests/a';\n", 'tests/a.ts': "-- i; const h = require('./b')\n", 'tests/b.ts': 'export const b = 1;\n' });
  repo.write('tests/b.ts', EVIL_BODY);
  repo.commit('edit b');
  assert.deepEqual((await collectWith(repo)).map((h) => h.file), ['tests/b.ts']);
});

const PAD = (n) => Array.from({ length: n }, (_, i) => (i % 2 === 0 ? '' : '    # padding'));
test('a bracketed Python import stays one statement however many blank or comment lines sit inside it, and a long name list is read to its end', async () => {
  for (const pad of [61, 500, 5000]) {
    const lines = ['from app import (', ...PAD(pad), '    tests,', ')'];
    assert.deepEqual(rules([file('app/views.py', { added: lines })]), ['R0-unscannable'], `pad ${pad}`);
    // only the line inside the block was added
    const hits = run([file('app/views.py', { added: ['    tests,'], at: pad + 2 })], { headFiles: new Map([['app/views.py', lines.join('\n')]]) });
    assert.deepEqual(rulesOf(hits), ['R0-unscannable'], `pad ${pad} context`);
  }
  const names = Array.from({ length: 400 }, (_, i) => `name_${i}`).join(', ');
  assert.deepEqual(rules([file('app/views.py', { added: [`from app import ${names}, tests`] })]), ['R0-unscannable']);
  const repo = await reverseRepo({ 'tests/__init__.py': 'x = 1\n', 'app/views.py': ['from app import (', ...PAD(200), '    tests,', ')'].join('\n') + '\n' });
  repo.write('app/tests/__init__.py', EVIL_BODY);
  repo.commit('edit app/tests');
  assert.deepEqual((await collectWith(repo)).map((h) => h.file), ['app/tests/__init__.py']);
});

test('a string syntax the tokenizer does not model (PEP 701 f-strings) cannot hide a bracketed or continued Python import (string-blind fallback)', () => {
  const cases = [
    ['v = f"{d["("]}"', 'from app import (', '    tests,', ')'],
    ['v = f"{"\'\'\'"}"', 'from app import (', '    tests,', ')'],
    ['v = f"{"\'\'\'"}"', 'import os, \\', '    tests.helper'],
  ];
  for (const lines of cases) {
    const at = lines.findIndex((l) => l.includes('tests')) + 1;
    const hits = run([file('app/views.py', { added: [lines[at - 1]], at })], { headFiles: new Map([['app/views.py', lines.join('\n')]]) });
    assert.deepEqual(rulesOf(hits), ['R0-unscannable'], lines.join(' / '));
  }
  // an edit to the head line alone still reaches the names below it
  const headOnly = ['v = f"{d["("]}"', 'from app import (', '    tests,', ')'];
  const hits = run([file('app/views.py', { added: [headOnly[1]], at: 2 })], { headFiles: new Map([['app/views.py', headOnly.join('\n')]]) });
  assert.deepEqual(rulesOf(hits), ['R0-unscannable']);
});

test('Python brackets are counted outside strings and comments: a quoted bracket or an open docstring cannot desync the statement', () => {
  const cases = [
    ['x = "("', 'from app import (', '    tests,', ')'],
    ["x = '(('", 'from app import (', '    tests,', ')'],
    ['"""Helpers (see below', 'and more ((', '"""', 'from app import (', '    tests,', ')'],
    ["x = r'\\(' ; y = f'{z}('", 'from app import (', '    tests,', ')'],
    ['from app import (  # open (', '    tests,  # a ) in a comment', ')'],
    ['y = """a """ + "("', 'from app import (', '    tests,', ')'],
  ];
  for (const lines of cases) {
    const at = lines.findIndex((l) => l.includes('tests,')) + 1;
    const hits = run([file('app/views.py', { added: [lines[at - 1]], at })], { headFiles: new Map([['app/views.py', lines.join('\n')]]) });
    assert.deepEqual(rulesOf(hits), ['R0-unscannable'], lines.join(' / '));
  }
  // clean statements around strings stay clean
  const clean = ['x = "("', 'from app import (', '    views,', ')'];
  assert.deepEqual(rules([file('app/views.py', { added: ['    views,'], at: 3 })], { headFiles: new Map([['app/views.py', clean.join('\n')]]) }), []);
});

test('whole-file import reading covers every language the parser reads (.mdx, Ruby Gemfile): only the specifier line changed', async () => {
  const cases = [
    ['docs-site/page.mdx', 'import {\n  helper\n} from\n  \'./ok\'\n', 'import {\n  helper\n} from\n  \'../tests/helper\'\n'],
    ['Gemfile', 'require\n  \'./ok\'\n', 'require\n  \'./spec/support/x\'\n'],
  ];
  for (const [name, before, after] of cases) {
    const repo = await reverseRepo({ [name]: before });
    repo.write(name, after);
    repo.commit(`edit ${name}`);
    const hits = await collectWith(repo);
    assert.ok(hits.some((h) => h.rule === 'R0-unscannable' && h.file === name), `${name}: ${JSON.stringify(hits.map((h) => [h.rule, h.file]))}`);
  }
});

test('the reverse check finds importers whatever the case of their extension (Helper.TS, page.MDX)', async () => {
  for (const importer of ['lib/Helper.TS', 'site/page.MDX']) {
    const repo = await reverseRepo({ 'tests/helper.ts': 'export const a = 1;\n', [importer]: "import { a } from '../tests/helper';\n" });
    repo.write('tests/helper.ts', EVIL_BODY);
    repo.commit('edit helper');
    const hits = await collectWith(repo);
    assert.ok(hits.some((h) => h.rule === 'R0-unscannable' && h.file === 'tests/helper.ts'), `${importer}: ${JSON.stringify(hits.map((h) => [h.rule, h.file]))}`);
  }
});

test('the string-blind Python fallback reads heads anywhere on a line and ignores brackets in comments', () => {
  const desync = 'v = f"{d["("]}"';
  const cases = [
    [desync, 'x = 1; from app import (', '    tests,', ')'],
    [desync, 'if c: from app import (', '    tests,', ')'],
    [desync, 'from app import (  # see foo()', '    tests,', ')'],
    [desync, 'from app import (', '    views,  # x)', '    tests,', ')'],
  ];
  for (const lines of cases) {
    const at = lines.findIndex((l) => l.includes('tests')) + 1;
    const hits = run([file('app/views.py', { added: [lines[at - 1]], at })], { headFiles: new Map([['app/views.py', lines.join('\n')]]) });
    assert.deepEqual(rulesOf(hits), ['R0-unscannable'], lines.join(' / '));
  }
});

test('a large file the import parser does not read (data, lockfile) is not unscannable for its size', async () => {
  const repo = await reverseRepo({ 'README.md': 'x\n' });
  repo.write('data/catalog.csv', 'a,b\n'.repeat(700_000));
  repo.commit('add a large data file');
  const hits = await collectWith(repo);
  assert.ok(!hits.some((h) => /larger than/.test(h.detail ?? '')), JSON.stringify(hits.map((h) => [h.rule, h.file, h.detail])));
});

test('a code file over ~2 MB is unscannable for imports (fails closed), forward and reverse', async () => {
  const big = 'x = 1\n'.repeat(400_000);
  const repo = await reverseRepo({ 'README.md': 'x\n' });
  repo.write('lib/huge.ts', big + "// end\n");
  repo.commit('add a huge code file');
  const hits = await collectWith(repo);
  assert.deepEqual(hits.map((h) => [h.rule, h.file]), [['R0-unscannable', 'lib/huge.ts']]);
  assert.match(hits[0].detail, /larger than .* its imports cannot be checked/);
  const rev = await reverseRepo({ 'tests/helper.ts': 'export const a = 1;\n', 'lib/huge.ts': `import '../tests/helper';\n${big}` });
  rev.write('tests/helper.ts', EVIL_BODY);
  rev.commit('edit helper');
  const hits2 = await collectWith(rev);
  assert.deepEqual(hits2.map((h) => [h.rule, h.file]), [['R0-unscannable', 'tests/helper.ts']]);
  assert.match(hits2[0].detail, /could not be checked \(the search failed: .*larger than/);
});

// ---- review round 5: comments between tokens, docs as code, Python package initializers, require_relative, more extensions ----

const COMMENT_BETWEEN = [
  "import { wipe } from /* annotation */ '../tests/helper.js'", "const m = await import(/* webpackMode: 'eager' */ '../tests/helper.js')",
  "const h = require(/* x */ '../spec/x')", "const h = require(/* a", " b */ '../spec/x')",
];
test('a block comment between the tokens of an import leaves the specifier readable: forward and reverse', async () => {
  for (const line of COMMENT_BETWEEN.slice(0, 3)) assert.deepEqual(rules([file('lib/pay.ts', { added: [line] })]), ['R0-unscannable'], line);
  assert.deepEqual(rules([file('lib/pay.ts', { added: COMMENT_BETWEEN.slice(3) })]), ['R0-unscannable'], 'multi-line comment');
  const { importSpecifiers } = await import('../pipeline/lib/hardstops.mjs');
  assert.deepEqual(importSpecifiers(COMMENT_BETWEEN[0], 'lib/pay.ts').map((x) => x.spec), ['../tests/helper.js']);
  const repo = await reverseRepo({ 'tests/helper.ts': 'export const wipe = 1;\n', 'lib/pay.ts': COMMENT_BETWEEN[1] + '\n' });
  repo.write('tests/helper.ts', EVIL_BODY);
  repo.commit('edit');
  assert.deepEqual((await collectWith(repo)).map((h) => h.file), ['tests/helper.ts']);
  // an unclosed comment opener is left alone and cannot hide a later import
  assert.deepEqual(rules([file('lib/pay.ts', { added: ["// see /* here", "import x from '../tests/h'"] })]), ['R0-unscannable']);
});

test('non-code documentation is reachable code (require loads .md/.txt as JavaScript): importing it is flagged forward, and editing one production already imports is flagged in reverse', async () => {
  for (const line of ["const h = require('../docs/helper.md')", "import x from './docs/note.txt'", "const r = require('../README.md')", "import x from '@/docs/guide.rst'"]) {
    assert.deepEqual(rules([file('lib/pay.ts', { added: [line] })]), ['R0-unscannable'], line);
  }
  assert.deepEqual(rules([file('lib/pay.ts', { added: ["import x from './docs/note'", "import y from '../lib/docs-helper'"] })]), []);
  const repo = await reverseRepo({
    'docs/helper.md': 'module.exports = 1;\n', 'docs/guide.md': 'guide\n', 'README.md': 'read me\n',
    'lib/pay.ts': "const h = require('../docs/helper.md');\nconst r = require('../README.md');\n",
  });
  repo.write('docs/helper.md', 'module.exports = require("child_process").execSync("id");\n');
  repo.write('docs/guide.md', 'a changed guide nobody imports\n');
  repo.write('README.md', 'changed readme\n');
  repo.commit('edit docs');
  const hits = await collectWith(repo);
  assert.deepEqual(hits.map((h) => h.file).sort(), ['README.md', 'docs/helper.md']);
  assert.match(hits[0].detail, /production code \(lib\/pay\.ts:\d\) already imports this test\/docs file/);
});

test('importing a Python module runs every package initializer on its path: forward and reverse', async () => {
  const config = cfg({ test_globs: ['tests/__init__.py'] });
  assert.deepEqual(rulesOf(run([file('app/views.py', { added: ['from tests.helper import wipe'] })], { config })), ['R0-unscannable']);
  assert.deepEqual(rulesOf(run([file('app/views.py', { added: ['import tests.helper.deep'] })], { config })), ['R0-unscannable']);
  assert.deepEqual(rulesOf(run([file('app/views.py', { added: ['from other.helper import wipe'] })], { config })), []);
  const repo = await reverseRepo({ 'pkg/tests/__init__.py': 'x = 1\n', 'pkg/tests/helper/deep.py': 'x = 1\n', 'app/views.py': 'from pkg.tests.helper.deep import wipe\n' });
  repo.write('pkg/tests/__init__.py', 'import os; os.system("id")\n');
  repo.commit('edit the package initializer only');
  assert.deepEqual((await collectWith(repo)).map((h) => h.file), ['pkg/tests/__init__.py']);
  const rel = await reverseRepo({ 'tests/__init__.py': 'x = 1\n', 'app/views.py': 'from ..tests.helper import wipe\n' });
  rel.write('tests/__init__.py', 'import os; os.system("id")\n');
  rel.commit('edit');
  assert.deepEqual((await collectWith(rel)).map((h) => h.file), ['tests/__init__.py']);
});

test('Ruby require_relative resolves against the requiring file (lib/), require against the load path', async () => {
  const repo = await reverseRepo({ 'lib/helper_spec.rb': 'x = 1\n', 'other/helper_spec.rb': 'x = 1\n', 'lib/main.rb': "require_relative 'helper_spec'\n" });
  repo.write('lib/helper_spec.rb', 'system("id")\n');
  repo.write('other/helper_spec.rb', 'system("id")\n');
  repo.commit('edit both');
  assert.deepEqual((await collectWith(repo)).map((h) => h.file), ['lib/helper_spec.rb']); // not other/: it is not next to lib/main.rb
  const req = await reverseRepo({ 'lib/helper_spec.rb': 'x = 1\n', 'lib/main.rb': "require 'helper_spec'\n" });
  req.write('lib/helper_spec.rb', 'system("id")\n');
  req.commit('edit');
  assert.deepEqual((await collectWith(req)).map((h) => h.file), ['lib/helper_spec.rb']);
  const { importCandidates } = await import('../pipeline/lib/hardstops.mjs');
  assert.ok(importCandidates('helper_spec', 'lib/main.rb', { ruby: 'rel' }).some((c) => c.path === 'lib/helper_spec.rb' && c.mode === 'exact'));
});

test('every source extension the parser reads is a candidate extension (.mdx, .astro, .vue, .svelte): editing tests/helper.mdx that production imports as ../tests/helper is flagged', async () => {
  for (const ext of ['mdx', 'astro', 'vue', 'svelte', 'pyi', 'rake']) {
    const repo = await reverseRepo({ [`tests/helper.${ext}`]: 'x\n', 'lib/pay.ts': "import h from '../tests/helper';\n" });
    repo.write(`tests/helper.${ext}`, 'changed\n');
    repo.commit('edit');
    assert.deepEqual((await collectWith(repo)).map((h) => h.file), [`tests/helper.${ext}`], ext);
  }
  const repo = await reverseRepo({ 'tests/helper/index.mdx': 'x\n', 'lib/pay.ts': "import h from '../tests/helper';\n" });
  repo.write('tests/helper/index.mdx', 'changed\n');
  repo.commit('edit');
  assert.deepEqual((await collectWith(repo)).map((h) => h.file), ['tests/helper/index.mdx']);
});
