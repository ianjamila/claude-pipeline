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
  "// import h from './pay.test'", "const s = 'see pay.test.ts';",
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
  ['app/views.py', '# from tests.helper import x'], ['lib/pay.rb', "require 'json'"], ['lib/pay.rb', "require_relative 'helpers'"],
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
const REAL_COMMENTS = ["/* import h from '../tests/helper' */", " * import h from '../tests/helper'", "// import h from '../tests/helper'", "/*", "# from tests.helper import x", "*/"];
test('an import after a closed block comment is code, not a comment: forward and reverse; real comment lines stay quiet', async () => {
  for (const line of AFTER_COMMENT) assert.deepEqual(rules([file('lib/pay.ts', { added: [line] })]), ['R0-unscannable'], line);
  for (const line of REAL_COMMENTS) assert.deepEqual(rules([file('lib/pay.ts', { added: [line] })]), [], line);
  assert.deepEqual(rules([file('app/views.py', { added: ['# from tests.helper import x'] })]), []);
  for (const line of AFTER_COMMENT.slice(0, 2)) {
    const repo = await reverseRepo({ 'tests/helper.ts': 'export const wipe = 1;\n', 'spec/x.ts': 'export const a = 1;\n', 'lib/pay.ts': line + '\n' });
    const target = line.includes('spec') ? 'spec/x.ts' : 'tests/helper.ts';
    repo.write(target, EVIL_BODY);
    repo.commit('edit');
    assert.deepEqual((await collectWith(repo)).map((h) => h.file), [target], line);
  }
});
