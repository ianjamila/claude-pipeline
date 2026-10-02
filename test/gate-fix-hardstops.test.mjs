// Gate-hardening regressions for the hard-stop classifier (review findings 1, 5, 6, 9).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUnifiedDiff } from '../pipeline/lib/diff.mjs';
import { collectHardStops } from '../pipeline/lib/hardstops.mjs';
import { createTmpRepo } from './helpers/tmprepo.mjs';
import { cfg, file, rulesOf, run } from './helpers/hardstops.mjs';

// ---- 1. test globs never hide code that really runs ---------------------------------------------------------------

test('1 a migration named *.test.sql is still a migration: content rules and R1 apply', () => {
  const hits = run([file('supabase/migrations/20260102000000_cleanup.test.sql', {
    status: 'A', added: ['drop table patients cascade;', 'alter table staff disable row level security;'],
  })]);
  assert.ok(rulesOf(hits).includes('R1-destructive'), JSON.stringify(hits));
  assert.ok(rulesOf(hits).includes('R2-auth'), JSON.stringify(hits));
});

test('1 a route handler under a test/ directory is still a new server entry point and scanned', () => {
  const hits = run([file('app/api/test/route.ts', { status: 'A', added: ['const sb = createAdminClient();'] })]);
  assert.ok(rulesOf(hits).includes('R2-auth'));
  assert.ok(hits.some((h) => /server entry/.test(h.detail)), JSON.stringify(hits));
  assert.ok(hits.some((h) => /service-role|admin-client/.test(h.detail)), JSON.stringify(hits));
});

test('1 .sql outside supabase/tests is scanned even under a tests/ directory; supabase/tests stays exempt', () => {
  assert.ok(rulesOf(run([file('db/tests/seed.sql', { status: 'A', added: ['drop table t;'] })])).includes('R1-destructive'));
  assert.deepEqual(rulesOf(run([file('supabase/tests/rls.test.sql', { status: 'A', added: ['drop table t;', 'grant all on t to anon;'] })])), []);
});

test('1 genuine tests stay exempt (spec/test names, __tests__, e2e, tests/, test/)', () => {
  for (const p of ['lib/x.test.ts', 'lib/x.spec.tsx', 'e2e/a.spec.ts', 'lib/__tests__/a.ts', 'test/helpers/x.ts', 'tests/a.ts', 'app/x/route.test.ts']) {
    assert.deepEqual(rulesOf(run([file(p, { added: ['createAdminClient();', 'drop table t;'] })])), [], p);
  }
});

test('1 a removed requireRole( in a test file is still not a hit', () => {
  assert.deepEqual(rulesOf(run([file('lib/x.test.ts', { removed: ['requireRole(user);'] })])), []);
});

test('1 a configured test glob still exempts a plain test directory but not a server entry', () => {
  const c = cfg({ test_globs: ['**/specs/**'] });
  assert.deepEqual(rulesOf(run([file('lib/specs/a.ts', { added: ['createAdminClient();'] })], { config: c })), []);
  assert.ok(rulesOf(run([file('app/specs/route.ts', { status: 'A', added: ['createAdminClient();'] })], { config: c })).includes('R2-auth'));
});

// ---- 6. agent-instruction files are pipeline files ----------------------------------------------------------------

test('6 edits to CLAUDE.md / AGENTS.md / .cursorrules / copilot-instructions are R4 hard-stops at any depth', () => {
  for (const p of ['CLAUDE.md', 'AGENTS.md', 'sub/dir/CLAUDE.md', 'pkg/AGENTS.md', '.cursorrules', 'a/.cursorrules', '.github/copilot-instructions.md']) {
    assert.ok(rulesOf(run([file(p, { added: ['be nice'] })])).includes('R4-pipeline'), p);
  }
});

// ---- 9. submodules -------------------------------------------------------------------------------------------------

test('9 .gitmodules changes are hard-stops', () => {
  assert.ok(rulesOf(run([file('.gitmodules', { status: 'A', added: ['[submodule "x"]'] })])).includes('R4-pipeline'));
  assert.ok(rulesOf(run([file('vendor/.gitmodules', { status: 'M', added: ['url = x'] })])).includes('R4-pipeline'));
});

test('9 a gitlink (mode 160000) entry is a hard-stop even without .gitmodules', () => {
  const f = { ...file('vendor/lib', { status: 'A', added: ['Subproject commit abc'] }), gitlink: true };
  assert.ok(rulesOf(run([f])).includes('R4-pipeline'));
});

test('9 end to end: git submodule add is flagged', async () => {
  const repo = createTmpRepo();
  repo.write('a.txt', 'x\n');
  repo.commit('base');
  const sub = createTmpRepo();
  sub.write('s.txt', 's\n');
  sub.commit('sub');
  repo.git(['checkout', '-b', 'feat']);
  repo.git(['-c', 'protocol.file.allow=always', 'submodule', 'add', sub.dir, 'vendor/lib']);
  repo.git(['commit', '-m', 'add submodule']);
  const hits = await collectHardStops({ base: 'main', head: 'feat', cwd: repo.dir, config: cfg() });
  assert.ok(rulesOf(hits).includes('R4-pipeline'), JSON.stringify(hits));
});

test('9 the diff parser marks mode-160000 entries as gitlinks and nothing else', () => {
  const sub = 'diff --git a/vendor/lib b/vendor/lib\nnew file mode 160000\nindex 0000000..abcdef0\n--- /dev/null\n+++ b/vendor/lib\n@@ -0,0 +1 @@\n+Subproject commit abcdef0123\n';
  assert.equal(parseUnifiedDiff(sub)[0].gitlink, true);
  const bump = 'diff --git a/vendor/lib b/vendor/lib\nindex 1111111..2222222 160000\n--- a/vendor/lib\n+++ b/vendor/lib\n@@ -1 +1 @@\n-Subproject commit 1111111\n+Subproject commit 2222222\n';
  assert.equal(parseUnifiedDiff(bump)[0].gitlink, true);
  const plain = 'diff --git a/a.txt b/a.txt\nnew file mode 100644\nindex 0000000..e69de29\n--- /dev/null\n+++ b/a.txt\n@@ -0,0 +1 @@\n+x\n';
  assert.equal(Object.hasOwn(parseUnifiedDiff(plain)[0], 'gitlink'), false);
});
