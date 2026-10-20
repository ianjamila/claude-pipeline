import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { classifyHardStops, collectHardStops, enclosingStatements, stripSqlComments, envNamesIn } from '../pipeline/lib/hardstops.mjs';
import { diffFiles } from '../pipeline/lib/git.mjs';
import { createTmpRepo } from './helpers/tmprepo.mjs';
import { MIG, pkg, cfg, file, rulesOf, classify, run } from './helpers/hardstops.mjs';

// ---- the 26 table cases ----------------------------------------------------------------------------------------

const TABLE = [
  ['1 migration adds DROP TABLE', { files: [file(MIG, { status: 'A', added: ['DROP TABLE foo;'] })] }, ['R1-destructive']],
  ['2 migration adds only a drop-table comment', { files: [file(MIG, { status: 'A', added: ['-- drop table later'] })] }, []],
  ['3 migration creates a plain table', { files: [file(MIG, { status: 'A', added: ['create table t(id int);'] })] }, []],
  ['4 create policy using auth.uid()', {
    files: [file(MIG, { status: 'A', added: ['create policy p on t for select using (auth.uid() = owner);'] })],
  }, ['R2-auth']],
  ['5 grant', { files: [file(MIG, { status: 'A', added: ['grant select on t to authenticated;'] })] }, ['R2-auth']],
  ['6 new env var not on base', {
    files: [file('lib/a.ts', { added: ['const k = process.env.NEW_SECRET;'] })],
  }, ['R3-secrets']],
  ['7 env var already on base', {
    files: [file('lib/a.ts', { added: ['const k = process.env.NEXT_PUBLIC_SUPABASE_URL;'] })],
    baseEnvNames: new Set(['NEXT_PUBLIC_SUPABASE_URL']),
  }, []],
  ['8 .env.example modified', { files: [file('.env.example')] }, ['R3-secrets']],
  ['9 workflow modified', { files: [file('.github/workflows/x.yml')] }, ['R4-pipeline']],
  ['10 workflow adds secrets.FOO', {
    files: [file('.github/workflows/x.yml', { added: ['        token: ${{ secrets.FOO }}'] })],
  }, ['R3-secrets', 'R4-pipeline']],
  ['11 vitest.config.ts', { files: [file('vitest.config.ts')] }, ['R4-pipeline']],
  ['12 .claude/pipeline.yml', { files: [file('.claude/pipeline.yml')] }, ['R4-pipeline']],
  ['13 next 15.5.15 -> 16.0.0', {
    files: [], basePkg: pkg({ next: '15.5.15' }), headPkg: pkg({ next: '16.0.0' }),
  }, ['R5-major-dep']],
  ['14 zod ^3.22.0 -> ^3.23.0', {
    files: [], basePkg: pkg({ zod: '^3.22.0' }), headPkg: pkg({ zod: '^3.23.0' }),
  }, []],
  ['15 foo 0.3.0 -> 0.4.0', {
    files: [], basePkg: pkg({ foo: '0.3.0' }), headPkg: pkg({ foo: '0.4.0' }),
  }, ['R5-major-dep']],
  ['16 lib/payroll/compute.ts', { files: [file('lib/payroll/compute.ts')] }, ['R6-sensitive']],
  ['17 docs/payroll-guide.md', { files: [file('docs/payroll-guide.md', { added: ['text'] })] }, []],
  ['18 middleware.ts', { files: [file('middleware.ts')] }, ['R2-auth']],
  ['19 page adds createAdminClient(', {
    files: [file('app/x/page.tsx', { added: ['const sb = createAdminClient();'] })],
  }, ['R2-auth']],
  ['20 migration deleted', { files: [file(MIG, { status: 'D', removed: ['create table t(id int);'] })] },
    ['R1-destructive', 'R1-migration-edited']],
  ['21 config path + payroll path', {
    files: [file('lib/hr-payroll/a.ts')], config: cfg({ paths: ['lib/hr-payroll/**'] }),
  }, ['P-path', 'R6-sensitive']],
  ['22 config pattern on an added line', {
    files: [file('lib/x.ts', { added: ["import faceapi from 'faceapi';"] })],
    config: cfg({ patterns: [{ name: 'face', regex: 'face(api|[-_]?recog)' }] }),
  }, ['P-pattern']],
  ['23 login page text change', {
    files: [file('app/(public)/login/page.tsx', { added: ['<h1>Welcome back</h1>'], removed: ['<h1>Hello</h1>'] })],
  }, []],
  ['24 rename into a payroll path', {
    files: [file('lib/payroll/util.ts', { status: 'R', oldPath: 'lib/util.ts' })],
  }, ['R6-sensitive']],
  ['25 ALTER TABLE ... RENAME COLUMN', {
    files: [file(MIG, { status: 'A', added: ['ALTER TABLE t RENAME COLUMN a TO b;'] })],
  }, ['R1-destructive']],
  // "SET role" is also the spec's R2 `SET ROLE` pattern: a per-line scan cannot tell a column assignment from a role
  // switch, so it flags both (a deliberate false positive).
  ['26 UPDATE ... SET', {
    files: [file(MIG, { status: 'A', added: ["UPDATE users SET role='admin';"] })],
  }, ['R1-destructive', 'R2-auth']],
];

for (const [name, input, expected] of TABLE) {
  test(`table: ${name}`, () => {
    const hits = classify({ config: cfg(), ...input });
    assert.deepEqual(rulesOf(hits), expected, JSON.stringify(hits));
    for (const h of hits) {
      assert.equal(typeof h.file, 'string');
      assert.equal(typeof h.detail, 'string');
    }
  });
}

// ---- revision cases: removals, weakening, edits of existing migrations ----------------------------------------

test('removed project auth call (auth_calls) in code -> R2-auth-removed', () => {
  const hits = classify({
    config: cfg({ auth_calls: ['requireSAScope'] }),
    files: [file('lib/x.ts', { removed: ['  await requireSAScope(ctx);'] })],
  });
  assert.deepEqual(rulesOf(hits), ['R2-auth-removed']);
  assert.equal(hits[0].file, 'lib/x.ts');
  assert.equal(hits[0].line, 1);
});

test('auth_calls names are what flag a project-specific guard (no generic pattern matches it)', () => {
  const f = [file('lib/x.ts', { removed: ['const ids = await getAccessibleDetachmentIds(user);'] })];
  assert.deepEqual(rulesOf(classify({ config: cfg(), files: f })), []);
  assert.deepEqual(
    rulesOf(classify({ config: cfg({ auth_calls: ['getAccessibleDetachmentIds'] }), files: f })),
    ['R2-auth-removed'],
  );
});

test('removed generic requireRole( -> R2-auth-removed', () => {
  assert.deepEqual(rulesOf(run([file('lib/x.ts', { removed: ['  requireRole(user, "admin");'] })])), ['R2-auth-removed']);
});

test('removed auth guards: each generic pattern', () => {
  for (const text of [
    'await requireAuth()', 'requireUser(req)', 'requireAdminSession()', 'assertAuthenticated(x)', 'assertRole(r)',
    'checkPermission(a)', 'checkPermissions(a)', 'authorize(x)', 'authorizeRequest(x)', 'supabase.auth.getUser()',
    'const u = await getUser()', 'if (isAdmin(u))', 'user.hasRole("x")', 'ability.can("x")', 'getSession()',
    'require_auth(x)', 'is_admin(u)', 'has_role(u)',
    'return NextResponse.json({ error: "no" }, { status: 403 });', 'if (!session) redirect("/login");',
    'if (user.role !== "admin") return;', 'export const config = { matcher: ["/dashboard/:path*"] };',
  ]) {
    assert.deepEqual(rulesOf(run([file('lib/x.ts', { removed: [text] })])), ['R2-auth-removed'], text);
  }
});

test('removed auth call in a test file -> none', () => {
  assert.deepEqual(rulesOf(run([file('lib/x.test.ts', { removed: ['requireRole(user);'] })])), []);
});

test('ADDED auth calls are not flagged by the removal rule', () => {
  assert.deepEqual(rulesOf(run([file('lib/x.ts', { added: ['requireRole(user);'] })])), []);
});

test('editing an existing migration -> R1-migration-edited', () => {
  const hits = run([file(MIG, { status: 'M', added: ['-- note'], removed: ['-- old note'] })]);
  assert.deepEqual(rulesOf(hits), ['R1-migration-edited']);
});

test('renaming a migration (either end) -> R1-migration-edited; moving one OUT of migrations is also destructive', () => {
  assert.deepEqual(rulesOf(run([file('supabase/migrations/2_y.sql', { status: 'R', oldPath: MIG })])), ['R1-migration-edited']);
  assert.deepEqual(rulesOf(run([file('archive/1_x.sql', { status: 'R', oldPath: MIG })])), ['R1-destructive', 'R1-migration-edited']);
  // Moving a file INTO migrations is still a change to the migration set.
  assert.deepEqual(rulesOf(run([file(MIG, { status: 'R', oldPath: 'archive/1_x.sql' })])), ['R1-migration-edited']);
});

test('a brand-new migration is not "edited"', () => {
  assert.deepEqual(rulesOf(run([file(MIG, { status: 'A', added: ['create table t(id int);'] })])), []);
});

test('renaming lib/auth/x.ts out of the auth dir is still R2 (old path tested)', () => {
  const hits = run([file('lib/x.ts', { status: 'R', oldPath: 'lib/auth/x.ts' })]);
  assert.deepEqual(rulesOf(hits), ['R2-auth']);
  assert.equal(hits[0].file, 'lib/x.ts');
});

test('removed grant line in a SQL file -> R2-sql-removed', () => {
  const hits = run([file('db/schema.sql', { removed: ['grant select on t to authenticated;'] })]);
  assert.deepEqual(rulesOf(hits), ['R2-sql-removed']);
});

test('removed SQL comment mentioning grant -> none', () => {
  assert.deepEqual(rulesOf(run([file('db/schema.sql', { removed: ['-- grant select on t'] })])), []);
});

test('removed using-line replaced by using (true) in a new migration -> R2-auth + R2-sql-removed', () => {
  const hits = run([file('db/schema.sql', {
    added: ['create policy p on t', '  for select', '  using (true);'],
    removed: ['  using (owner = auth.uid());'],
    at: 1,
  })]);
  assert.deepEqual(rulesOf(hits), ['R2-auth', 'R2-sql-removed']);
});

test('R2-sql-statement: a hit for each statement that matches an R2 pattern', () => {
  const hits = run([], {
    sqlStatements: [
      { file: 'db/schema.sql', text: 'create policy p on t\n  for select\n  using (true);' },
      { file: 'db/schema.sql', text: 'create table t (id int);' },
    ],
  });
  assert.deepEqual(rulesOf(hits), ['R2-sql-statement']);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].file, 'db/schema.sql');
  assert.ok(hits[0].detail.length <= 200);
});

test('multi-line UPDATE ... SET is caught at statement level (R1-destructive)', () => {
  const hits = run([], { sqlStatements: [{ file: 'db/seed.sql', text: "update users\n  set is_admin = true\n where id = 1;" }] });
  assert.deepEqual(rulesOf(hits), ['R1-destructive']);
});

test('binary .env file -> R3 (path rules still apply to binaries) and R0 (content unreadable)', () => {
  assert.deepEqual(rulesOf(run([file('config/.env', { binary: true })])), ['R0-unscannable', 'R3-secrets']);
});

// ---- SQL comment / string handling -----------------------------------------------------------------------------

test('SQL: single-line block comment hides a keyword; trailing comment does not hide code before it', () => {
  assert.deepEqual(rulesOf(run([file(MIG, { status: 'A', added: ['/* DROP TABLE x; */'] })])), []);
  assert.deepEqual(rulesOf(run([file(MIG, { status: 'A', added: ['delete from t; -- cleanup'] })])), ['R1-destructive']);
  assert.deepEqual(rulesOf(run([file(MIG, { status: 'A', added: ['/* note */ drop table t;'] })])), ['R1-destructive']);
});

test('SQL: a block comment spanning consecutive added lines hides its body', () => {
  const f = file(MIG, { status: 'A', added: ['/*', 'DROP TABLE x;', '*/', 'select 1;'] });
  assert.deepEqual(rulesOf(run([f])), []);
});

test('SQL: block-comment state is NOT carried across a gap in line numbers (unsure -> still match)', () => {
  const f = file(MIG, { status: 'A', added: ['/* start'] });
  f.added.push({ line: 5, text: 'DROP TABLE x;' });
  assert.deepEqual(rulesOf(run([f])), ['R1-destructive']);
});

test('SQL: comment markers inside a string do not hide the code after them', () => {
  assert.deepEqual(rulesOf(run([file(MIG, { status: 'A', added: ["select '--'; drop table users;"] })])), ['R1-destructive']);
  assert.deepEqual(rulesOf(run([file(MIG, { status: 'A', added: ["select '/*'; drop table users; select '*/';"] })])), ['R1-destructive']);
});

test('SQL: keywords inside dynamic-SQL strings still count', () => {
  assert.deepEqual(rulesOf(run([file(MIG, { status: 'A', added: ["execute 'DROP TABLE ' || name;"] })])), ['R1-destructive']);
});

test('SQL: every R1 / R2 pattern fires (and is case-insensitive)', () => {
  const r1 = [
    'drop table t;', 'DROP COLUMN x', 'drop schema s', 'drop view v', 'drop materialized view v', 'drop function f()',
    'drop policy p on t', 'drop trigger t on x', 'drop index i', 'drop type ty', 'drop database d', 'drop role r',
    'drop extension e', 'alter table t drop constraint c;', 'TRUNCATE t;', 'alter table t rename to u;',
    'alter table t rename column a to b;', 'delete from t;', 'update public.t set a = 1;', 'update t as x set a = 1;',
    'update "t" tt set a = 1;', 'alter table t alter column a type text;', 'alter table t alter column a set data type text;',
    'alter table t alter column a drop not null;', 'insert into t values (1) on conflict (id) do update set a = 1;',
    'merge into t using s on t.id = s.id when matched then delete;',
  ];
  for (const text of r1) {
    // drop policy / drop role are R2 as well; every sample must at least be R1.
    assert.ok(rulesOf(run([file(MIG, { status: 'A', added: [text] })])).includes('R1-destructive'), text);
  }
  const r2 = [
    'create policy p on t using (true);', 'ALTER POLICY p ON t', 'drop policy if exists p on t;', 'alter table t enable row level security;',
    'alter table t disable row level security;', 'alter table t force row level security;', 'alter table t no force row level security;',
    'grant all on t to anon;', 'revoke all on t from anon;', 'create function f() returns int security definer as $$ select 1 $$;',
    'alter function f() security invoker;', 'using (auth.uid() = id)', 'using (auth.jwt() ->> x)', 'using (auth.role() = y)',
    'create role r;', 'alter role r with login;', 'set role postgres;', 'set local role anon;', 'alter role r bypassrls;',
    'alter default privileges in schema public grant select on tables to anon;', 'alter table t owner to postgres;',
    'insert into auth.users (id) values (gen_random_uuid());', 'insert into "auth"."users" (id) values (1);',
  ];
  for (const text of r2) {
    const got = rulesOf(run([file(MIG, { status: 'A', added: [text] })]));
    assert.ok(got.includes('R2-auth'), `${text} -> ${got}`);
  }
});

test('SQL rules only apply to SQL files', () => {
  assert.deepEqual(rulesOf(run([file('lib/a.ts', { added: ['// DROP TABLE x; grant all'] })])), []);
});

test('SQL rules apply under a migrations dir even without a .sql extension', () => {
  assert.deepEqual(rulesOf(run([file('db/migrations/001_x.ts', { status: 'A', added: ["await q('DROP TABLE x')"] })])), ['R1-destructive']);
});

test('dedupe keeps hits on different lines, and line-less hits whose details differ', () => {
  const lines = run([file(MIG, { status: 'A', added: ['drop table a;', 'truncate b;'] })]);
  assert.deepEqual(lines.map((h) => h.line), [1, 2]);
  const deps = classify({
    config: cfg(), files: [], basePkg: pkg({ a: '1.0.0', b: '1.0.0' }), headPkg: pkg({ a: '2.0.0', b: '2.0.0' }),
  });
  assert.equal(deps.length, 2);
  const statements = run([], { sqlStatements: [{ file: 'a.sql', text: 'grant a;' }, { file: 'a.sql', text: 'revoke b;' }, { file: 'a.sql', text: 'grant a;' }] });
  assert.equal(statements.length, 2);
});

test('dedupe: one hit per (rule, file, line) even when several patterns match the line', () => {
  const hits = run([file(MIG, { status: 'A', added: ['drop table a; truncate b; delete from c;'] })]);
  assert.equal(hits.filter((h) => h.rule === 'R1-destructive').length, 1);
});

// ---- R2 / R3 / R4 / R6 extras ----------------------------------------------------------------------------------

test('R2 service-role references (case-insensitive) in production code; docs and tests are exempt', () => {
  for (const text of ['service_role', 'SERVICE_ROLE_KEY', 'serviceRole', 'supabaseAdmin.from()', 'createAdminClient(', 'SUPABASE_SERVICE_KEY']) {
    assert.deepEqual(rulesOf(run([file('lib/x.ts', { added: [text] })])), ['R2-auth'], text);
    assert.deepEqual(rulesOf(run([file('docs/x.md', { added: [text] })])), [], `docs: ${text}`);
    assert.deepEqual(rulesOf(run([file('lib/x.test.ts', { added: [text] })])), [], `test: ${text}`);
  }
});

test('R2 path rules', () => {
  for (const p of [
    'lib/auth/session.ts', 'src/middleware.ts', 'middleware.js', 'proxy.ts', 'lib/rbac/x.ts', 'lib/rbac.ts', 'lib/team-rbac/x.ts',
    'lib/roles.ts', 'lib/roles/x.ts', 'lib/permissions.ts', 'lib/permissions/x.ts', 'lib/rls/x.ts', 'db/user-policy.sql',
    'lib/policy.ts', 'lib/auth.ts', 'hooks/useAuth.ts', 'lib/Auth/X.ts', 'lib/supabase/admin.ts', 'lib/adminClient.ts',
    'lib/admin-client.ts', 'lib/service-role.ts', 'supabase/config.toml',
  ]) {
    assert.deepEqual(rulesOf(run([file(p)])), ['R2-auth'], p);
  }
  for (const p of ['lib/author.ts', 'app/(public)/login/page.tsx', 'lib/utils.ts', 'components/policy-banner.tsx']) {
    assert.deepEqual(rulesOf(run([file(p)])), [], p);
  }
});

test('R2 path rules are skipped for tests and docs', () => {
  assert.deepEqual(rulesOf(run([file('lib/auth/x.test.ts')])), []);
  assert.deepEqual(rulesOf(run([file('docs/auth/notes.md')])), []);
});

test('R3 secret paths and dirs', () => {
  for (const p of ['.env', 'apps/web/.env.local', '.env.production', 'certs/a.pem', 'keys/b.key', 'secrets/x.json', 'deploy/id_rsa', 'x/store.p12']) {
    assert.deepEqual(rulesOf(run([file(p)])), ['R3-secrets'], p);
  }
});

test('R3 vercel.json env/build lines (added or removed); other vercel.json edits are fine', () => {
  assert.deepEqual(rulesOf(run([file('vercel.json', { added: ['  "env": { "A": "b" },'] })])), ['R3-secrets']);
  assert.deepEqual(rulesOf(run([file('vercel.json', { added: ['  "build": {'] })])), ['R3-secrets']);
  assert.deepEqual(rulesOf(run([file('vercel.json', { removed: ['  "buildCommand": "x"'] })])), ['R3-secrets']);
  assert.deepEqual(rulesOf(run([file('vercel.json', { added: ['  "crons": [{ "path": "/api/x" }]'] })])), ['R3-secrets']);
  assert.deepEqual(rulesOf(run([file('vercel.json', { added: ['  "headers": []'] })])), ['R3-secrets']);
  assert.deepEqual(rulesOf(run([file('vercel.json', { added: ['  "regions": ["sin1"]'] })])), []);
});

test('R3 workflow secrets. reference only on added lines of workflows', () => {
  assert.deepEqual(rulesOf(run([file('lib/a.ts', { added: ['// secrets.x'] })])), []);
  const hits = run([file('.github/workflows/x.yml', { removed: ['  a: ${{ secrets.OLD }}'] })]);
  assert.deepEqual(rulesOf(hits), ['R4-pipeline']);
});

test('R3 env names: every access style; tests and docs are ignored; only new names flag', () => {
  const styles = [
    'const a = process.env.AAA_ONE;', "const a = process.env['AAA_ONE'];", 'const a = process.env["AAA_ONE"];',
    'const a = import.meta.env.AAA_ONE;', "const a = Deno.env.get('AAA_ONE');", "a = os.environ['AAA_ONE']",
    "a = os.environ.get('AAA_ONE')", "a = os.getenv('AAA_ONE')", 'const a = Bun.env.AAA_ONE;',
    'const { AAA_ONE } = process.env;', 'const { X, AAA_ONE: renamed = "d" } = import.meta.env;',
  ];
  for (const text of styles) {
    assert.deepEqual(envNamesIn(text).includes('AAA_ONE'), true, text);
    assert.deepEqual(rulesOf(run([file('lib/a.ts', { added: [text] })])), ['R3-secrets'], text);
    assert.deepEqual(rulesOf(run([file('lib/a.ts', { added: [text] })], { baseEnvNames: new Set(['AAA_ONE', 'X']) })), [], text);
  }
  assert.deepEqual(rulesOf(run([file('lib/a.test.ts', { added: ['process.env.NEW_ONE'] })])), []);
  assert.deepEqual(rulesOf(run([file('docs/a.md', { added: ['process.env.NEW_ONE'] })])), []);
  const two = run([file('lib/a.ts', { added: ['const { A_ONE, B_TWO } = process.env;'] })], { baseEnvNames: ['A_ONE'] });
  assert.match(two[0].detail, /new env var B_TWO/);
  assert.doesNotMatch(two[0].detail, /A_ONE/);
});

test('R3 env names: a multi-line destructure cannot be checked, so it flags', () => {
  const hits = run([file('lib/a.ts', { added: ['} = process.env;'] })], { baseEnvNames: new Set(['X']) });
  assert.deepEqual(rulesOf(hits), ['R3-secrets']);
});

test('R4 pipeline paths', () => {
  for (const p of [
    '.claude/settings.json', '.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS', '.github/workflows/ci.yml', '.github/dependabot.yml',
    'scripts/pipeline/ci-guard.mjs', 'x/pipeline.yml', 'apps/web/vitest.config.ts', 'vitest.workspace.ts', 'jest.config.js',
    'playwright.config.ts', 'playwright.ci.config.ts', '.nycrc', '.nycrc.json', 'codecov.yml', 'codecov.yaml',
    'cypress.config.ts', 'vitest.setup.ts', '.gitmodules', 'scripts/verify', 'scripts/verify.mjs', 'scripts/verify-sql-arms.mjs', 'eslint.config.mjs',
    '.eslintrc.json', 'tsconfig.json',
  ]) {
    assert.deepEqual(rulesOf(run([file(p)])), ['R4-pipeline'], p);
  }
  // The rest of the old R4 list is R4-config (report-only eligible), never nothing.
  for (const p of [
    '.githooks/pre-push', '.husky/pre-commit', 'CLAUDE.md', '.github/copilot-instructions.md',
  ]) {
    assert.deepEqual(rulesOf(run([file(p)])), ['R4-config'], p);
  }
  assert.deepEqual(rulesOf(run([file('src/app.ts')])), []);
});

test('R4 old path counts on renames out of .github', () => {
  assert.deepEqual(rulesOf(run([file('ci/x.yml', { status: 'R', oldPath: '.github/workflows/x.yml' })])), ['R4-pipeline']);
});

test('R6 sensitive paths: every keyword, camelCase and separators, case-insensitive', () => {
  for (const p of [
    'lib/biometric/x.ts', 'lib/facial-scan.ts', 'lib/face-recognition.ts', 'lib/faceMatch.ts', 'lib/face_detect.ts', 'lib/faceapi.ts',
    'lib/liveness.ts', 'lib/rekognition.ts', 'lib/health-records.ts', 'lib/medical.ts', 'app/patients/x.ts', 'lib/diagnosis.ts',
    'lib/Payroll/x.ts', 'lib/payslip.ts', 'lib/salary.ts', 'lib/salaries/x.ts', 'lib/wage.ts', 'lib/bank-account.ts',
    'lib/bank_account.ts', 'lib/ssn.ts', 'lib/tin.ts', 'lib/get-tin.ts', 'lib/employeeTin.ts', 'lib/validateSSN.ts', 'lib/sss/x.ts',
    'lib/tin_number.ts', 'lib/philhealth.ts', 'lib/pag-ibig.ts', 'lib/pagibig.ts', 'LIB/PAYROLL/X.TS',
  ]) {
    assert.deepEqual(rulesOf(run([file(p)])), ['R6-sensitive'], p);
  }
  for (const p of [
    'lib/routing.ts', 'lib/string-utils.ts', 'lib/cassette.ts', 'lib/utils.ts', 'app/api/health/route.ts', 'lib/diagnostics/logger.ts',
    'lib/interface.ts', 'lib/surface.ts', 'lib/typeface.ts', 'lib/bankruptcy.ts',
  ]) {
    assert.deepEqual(rulesOf(run([file(p)])), [], p);
  }
});

test('R6 skips tests, docs and markdown but covers the OLD path of a rename', () => {
  assert.deepEqual(rulesOf(run([file('lib/payroll/compute.test.ts')])), []);
  assert.deepEqual(rulesOf(run([file('lib/payroll/README.md')])), []);
  assert.deepEqual(rulesOf(run([file('lib/x.ts', { status: 'R', oldPath: 'lib/payroll/x.ts' })])), ['R6-sensitive']);
});

test('P-path respects negation entries and tests both case variants', () => {
  const c = cfg({ paths: ['lib/secure/**', '!lib/secure/public/**'] });
  assert.deepEqual(rulesOf(classify({ config: c, files: [file('lib/secure/a.ts')] })), ['P-path']);
  assert.deepEqual(rulesOf(classify({ config: c, files: [file('lib/secure/public/a.ts')] })), []);
  assert.deepEqual(rulesOf(classify({ config: c, files: [file('lib/Secure/a.ts')] })), ['P-path']);
});

test('P-pattern: removed lines count; paths scoping; default scope is code files only', () => {
  const c = cfg({ patterns: [{ name: 'face', regex: 'facial' }, { name: 'scoped', regex: 'zzz', paths: ['only/**'] }] });
  assert.deepEqual(rulesOf(classify({ config: c, files: [file('lib/x.ts', { removed: ['// FACIAL scan'] })] })), ['P-pattern']);
  assert.deepEqual(rulesOf(classify({ config: c, files: [file('docs/x.md', { added: ['facial'] })] })), []);
  assert.deepEqual(rulesOf(classify({ config: c, files: [file('lib/x.ts', { added: ['zzz'] })] })), []);
  const scoped = classify({ config: c, files: [file('only/x.md', { added: ['zzz'] })] });
  assert.deepEqual(rulesOf(scoped), ['P-pattern']);
  assert.match(scoped[0].detail, /scoped/);
});

test('hit shape: file is the new path (old for deletions); line and excerpt present on line rules', () => {
  const hits = run([file(MIG, { status: 'A', added: ['', '  DROP TABLE foo;  '], at: 10 })]);
  assert.equal(hits.length, 1);
  assert.deepEqual(
    { rule: hits[0].rule, file: hits[0].file, line: hits[0].line, excerpt: hits[0].excerpt },
    { rule: 'R1-destructive', file: MIG, line: 11, excerpt: 'DROP TABLE foo;' },
  );
  assert.equal(run([file(MIG, { status: 'D' })])[0].file, MIG);
});

test('a missing integrity/hard_stops section in config falls back to defaults instead of crashing', () => {
  const hits = classify({ config: {}, files: [file('lib/payroll/x.test.ts'), file('lib/payroll/y.ts')] });
  assert.deepEqual(rulesOf(hits), ['R6-sensitive']);
  assert.equal(hits[0].file, 'lib/payroll/y.ts');
});

// ---- R5 ---------------------------------------------------------------------------------------------------------

test('R5: every dependency section, engines.node, and the ways it must stay quiet', () => {
  for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const hits = classify({ config: cfg(), files: [], basePkg: { [section]: { a: '^1.2.3' } }, headPkg: { [section]: { a: '^2.0.0' } } });
    assert.deepEqual(rulesOf(hits), ['R5-major-dep'], section);
    assert.equal(hits[0].file, 'package.json');
  }
  const q = (b, h, extra = {}) => rulesOf(classify({ config: cfg(), files: [], basePkg: b, headPkg: h, ...extra }));
  assert.deepEqual(q({ engines: { node: '>=18' } }, { engines: { node: '>=20' } }), ['R5-major-dep']);
  assert.deepEqual(q({ engines: { node: '>=20' } }, { engines: { node: '>=20.1' } }), []);
  assert.deepEqual(q(pkg({ a: '^1.0.0' }), pkg({ a: '^1.0.0', b: '^9.0.0' })), [], 'new deps are not hits');
  assert.deepEqual(q(pkg({ a: '^1.0.0', b: '^2.0.0' }), pkg({ a: '^1.0.0' })), [], 'removed deps are not hits');
  assert.deepEqual(q(pkg({ a: '^0.3.1' }), pkg({ a: '^0.3.9' })), [], '0.x patch bump');
  assert.deepEqual(q(pkg({ a: '~0.3' }), pkg({ a: '~0.4' })), ['R5-major-dep'], '0.x minor, no patch');
  assert.deepEqual(q(pkg({ a: '^1 || ^2' }), pkg({ a: '^2 || ^3' })), ['R5-major-dep']);
  assert.deepEqual(q(pkg({ a: '^2.0.0' }), pkg({ a: '^1.9.0' })), ['R5-major-dep'], 'a major downgrade is also reviewed');
  assert.deepEqual(q(null, pkg({ a: '^2.0.0' })), []);
  assert.deepEqual(q(pkg({ a: '^1.0.0' }), null), []);
  assert.deepEqual(q(null, null), []);
});

test('R5: non-semver ranges are ignored unless the spec itself changed', () => {
  const q = (b, h) => rulesOf(classify({ config: cfg(), files: [], basePkg: pkg({ a: b }), headPkg: pkg({ a: h }) }));
  for (const same of ['workspace:*', 'git+https://github.com/x/y.git#v2.0.0', 'file:../x', '*', 'latest', 'github:x/y#semver:^2.0.0']) {
    assert.deepEqual(q(same, same), [], same);
  }
  // Retargeting a dependency to a git URL / tag / other source is a supply-chain change, not noise.
  assert.deepEqual(q('^1.0.0', 'git+https://github.com/x/y.git#v1.0.0'), ['R5-major-dep']);
  assert.deepEqual(q('^1.0.0', 'latest'), ['R5-major-dep']);
  assert.deepEqual(q('git+https://x/y.git#v1.0.0', 'git+https://x/y.git#v2.0.0'), ['R5-major-dep']);
});

test('R5: extra package.json pairs (monorepo packages) and unparseable files', () => {
  const hits = classify({
    config: cfg(), files: [],
    pkgPairs: [
      { file: 'apps/web/package.json', base: pkg({ next: '15.0.0' }), head: pkg({ next: '16.0.0' }) },
      { file: 'apps/api/package.json', base: pkg({ x: '1.0.0' }), head: pkg({ x: '1.1.0' }) },
      { file: 'apps/bad/package.json', error: 'head' },
    ],
  });
  assert.deepEqual(hits.map((h) => h.file).sort(), ['apps/bad/package.json', 'apps/web/package.json']);
});

// ---- stripSqlComments / enclosingStatements --------------------------------------------------------------------

test('stripSqlComments keeps length and line structure, drops comments, keeps strings', () => {
  const src = "a -- c\nb /* x\ny */ c\n'--' \"/*\" $$ -- z\n$$ d";
  const out = stripSqlComments(src);
  assert.equal(out.length, src.length);
  assert.equal(out.split('\n').length, src.split('\n').length);
  assert.equal(out.split('\n')[0].trim(), 'a');
  assert.match(out, /'--'/);
  assert.match(out, /"\/\*"/);
  assert.doesNotMatch(out, /\bx\b/);
  assert.doesNotMatch(out, /\bz\b/); // a comment inside a dollar-quoted body is still a comment
  assert.match(out, /\bd\b/);
});

const POLICY_SQL = [
  'create table t (id int);', // 1
  '', // 2
  'create policy p on t', // 3
  '  for select', // 4
  '  using (true);', // 5
  'grant select on t to anon;', // 6
].join('\n');

test('enclosingStatements: the full multi-line statement around a middle line', () => {
  assert.deepEqual(enclosingStatements(POLICY_SQL, [4]), ['create policy p on t\n  for select\n  using (true);']);
});

test('enclosingStatements: first / last / several lines, deduped, in file order', () => {
  assert.deepEqual(enclosingStatements(POLICY_SQL, [1]), ['create table t (id int);']);
  assert.deepEqual(enclosingStatements(POLICY_SQL, [6]), ['grant select on t to anon;']);
  assert.deepEqual(enclosingStatements(POLICY_SQL, [5, 3, 4, 1]), [
    'create table t (id int);',
    'create policy p on t\n  for select\n  using (true);',
  ]);
});

test('enclosingStatements: blank and comment-only lines belong to no statement; unknown lines are ignored', () => {
  assert.deepEqual(enclosingStatements(POLICY_SQL, [2]), []);
  assert.deepEqual(enclosingStatements('a;\n-- just a note\nb;', [2]), []);
  assert.deepEqual(enclosingStatements(POLICY_SQL, [99, 0, -1]), []);
});

test('enclosingStatements: comments are removed, and a ; inside a comment or string is not a boundary', () => {
  const sql = "create policy p on t -- owner; only\n  using (a = ';' /* ; */ and b);\nselect 1;";
  assert.deepEqual(enclosingStatements(sql, [2]), ["create policy p on t\n  using (a = ';'  and b);"]);
});

test('enclosingStatements: a changed line inside a dollar-quoted body yields the whole function statement', () => {
  const sql = [
    'create function f() returns void', // 1
    'language plpgsql security definer as $fn$', // 2
    'begin', // 3
    '  delete from t; -- cleanup', // 4
    '  perform 1;', // 5
    'end $fn$;', // 6
    'select 2;', // 7
  ].join('\n');
  const [stmt, ...rest] = enclosingStatements(sql, [5]);
  assert.equal(rest.length, 0);
  assert.match(stmt, /^create function f\(\)/);
  assert.match(stmt, /security definer/);
  assert.match(stmt, /end \$fn\$;$/);
  assert.doesNotMatch(stmt, /cleanup/);
});

test('enclosingStatements: several statements on one line, a final statement with no ;, CRLF', () => {
  assert.deepEqual(enclosingStatements('a; b; c', [1]), ['a;', 'b;', 'c']);
  assert.deepEqual(enclosingStatements('x\r\ny', [2]), ['x\ny']);
});

test('enclosingStatements: an E-string with an escaped quote does not swallow the rest of the file', () => {
  const sql = "select E'it\\'s'; \ngrant all on t to anon;";
  assert.deepEqual(enclosingStatements(sql, [2]), ['grant all on t to anon;']);
});

// ---- collectHardStops (real git) -------------------------------------------------------------------------------

const POLICY_BASE = 'create table t (owner uuid);\ncreate policy p on t\n  for select\n  using (owner = auth.uid());\n';

test('IO: predicate-only edit inside an existing multi-line create policy in schema.sql -> R2-sql-statement', async () => {
  const repo = createTmpRepo();
  repo.write('schema.sql', POLICY_BASE);
  repo.commit('base');
  repo.branch('feat');
  repo.write('schema.sql', POLICY_BASE.replace('using (owner = auth.uid());', 'using (true);'));
  repo.commit('weaken');
  const hits = await collectHardStops({ base: 'main', head: 'feat', cwd: repo.dir, config: cfg() });
  assert.ok(hits.some((h) => h.rule === 'R2-sql-statement' && h.file === 'schema.sql'), JSON.stringify(hits));
  // The changed lines themselves contain no R2 keyword on the added side, and schema.sql is not a migration.
  assert.ok(!hits.some((h) => h.rule === 'R1-migration-edited'));
});

test('IO: an unrelated edit in schema.sql (a different statement) does not flag the policy', async () => {
  const repo = createTmpRepo();
  repo.write('schema.sql', POLICY_BASE);
  repo.commit('base');
  repo.branch('feat');
  repo.write('schema.sql', POLICY_BASE.replace('(owner uuid)', '(owner uuid, note text)'));
  repo.commit('add column def');
  const hits = await collectHardStops({ base: 'main', head: 'feat', cwd: repo.dir, config: cfg() });
  assert.deepEqual(hits, []);
});

test('IO: removing a line from a policy is judged against the BASE statement', async () => {
  const repo = createTmpRepo();
  repo.write('schema.sql', POLICY_BASE);
  repo.commit('base');
  repo.branch('feat');
  repo.write('schema.sql', 'create table t (owner uuid);\n');
  repo.commit('drop policy text');
  const hits = await collectHardStops({ base: 'main', head: 'feat', cwd: repo.dir, config: cfg() });
  assert.ok(hits.some((h) => h.rule === 'R2-sql-statement'), JSON.stringify(hits));
  assert.ok(hits.some((h) => h.rule === 'R2-sql-removed'), JSON.stringify(hits));
});

test('IO: a new multi-line UPDATE in a new migration is caught at statement level', async () => {
  const repo = createTmpRepo();
  repo.write('README.md', 'x\n');
  repo.commit('base');
  repo.branch('feat');
  repo.write('supabase/migrations/2_y.sql', "update users\n  set is_admin = true\n where id = 1;\n");
  repo.commit('seed admin');
  const hits = await collectHardStops({ base: 'main', head: 'feat', cwd: repo.dir, config: cfg() });
  assert.deepEqual(rulesOf(hits), ['R1-destructive']);
});

test('IO: new env var not on base -> R3; already on base -> none; a longer name on base does not count', async () => {
  const repo = createTmpRepo();
  repo.write('lib/other.ts', 'export const o = process.env.SOMETHING_ELSE;\nexport const n = process.env.FOO_TOKEN_OLD;\n');
  repo.write('lib/b.ts', 'export const b = process.env.ALREADY_USED;\n');
  repo.commit('base');
  repo.branch('feat');
  repo.write('lib/a.ts', 'export const t = process.env.FOO_TOKEN;\nexport const u = process.env.ALREADY_USED;\n');
  repo.commit('use env');
  const hits = await collectHardStops({ base: 'main', head: 'feat', cwd: repo.dir, config: cfg() });
  assert.deepEqual(rulesOf(hits), ['R3-secrets']);
  assert.equal(hits.length, 1);
  assert.match(hits[0].detail, /new env var FOO_TOKEN$/);
  assert.equal(hits[0].file, 'lib/a.ts');
  assert.equal(hits[0].line, 1);

  const repo2 = createTmpRepo();
  repo2.write('lib/other.ts', 'export const n = process.env.FOO_TOKEN;\n');
  repo2.commit('base');
  repo2.branch('feat');
  repo2.write('lib/a.ts', 'export const t = process.env.FOO_TOKEN;\n');
  repo2.commit('use env');
  assert.deepEqual(await collectHardStops({ base: 'main', head: 'feat', cwd: repo2.dir, config: cfg() }), []);
});

test('IO: env names are looked up at the MERGE-BASE, not at base tip', async () => {
  const repo = createTmpRepo();
  repo.write('README.md', 'x\n');
  repo.commit('base');
  repo.branch('feat');
  repo.write('lib/a.ts', 'export const t = process.env.LATE_VAR;\n');
  repo.commit('use env');
  repo.checkout('main');
  repo.write('lib/other.ts', 'export const t = process.env.LATE_VAR;\n'); // lands on main after the fork
  repo.commit('main moves on');
  const hits = await collectHardStops({ base: 'main', head: 'feat', cwd: repo.dir, config: cfg() });
  assert.deepEqual(rulesOf(hits), ['R3-secrets']);
});

test('IO: package.json major bump is detected through showFile (root and nested), minor bumps are not', async () => {
  const repo = createTmpRepo();
  repo.write('package.json', JSON.stringify({ dependencies: { next: '15.5.15', zod: '^3.22.0' }, engines: { node: '>=20' } }, null, 2));
  repo.write('apps/web/package.json', JSON.stringify({ dependencies: { react: '^18.0.0' } }, null, 2));
  repo.commit('base');
  repo.branch('feat');
  repo.write('package.json', JSON.stringify({ dependencies: { next: '16.0.0', zod: '^3.23.0' }, engines: { node: '>=20' } }, null, 2));
  repo.write('apps/web/package.json', JSON.stringify({ dependencies: { react: '^19.0.0' } }, null, 2));
  repo.commit('bump');
  const hits = await collectHardStops({ base: 'main', head: 'feat', cwd: repo.dir, config: cfg() });
  assert.deepEqual(rulesOf(hits), ['R5-major-dep']);
  assert.deepEqual(hits.map((h) => h.file).sort(), ['apps/web/package.json', 'package.json']);
  assert.ok(hits.some((h) => /next/.test(h.detail)));
  assert.ok(!hits.some((h) => /zod/.test(h.detail)));
});

test('IO: an unparseable package.json at head is flagged rather than silently skipped', async () => {
  const repo = createTmpRepo();
  repo.write('package.json', JSON.stringify({ dependencies: { a: '1.0.0' } }));
  repo.commit('base');
  repo.branch('feat');
  repo.write('package.json', '{ "dependencies": { "a": "2.0.0", }');
  repo.commit('break');
  const hits = await collectHardStops({ base: 'main', head: 'feat', cwd: repo.dir, config: cfg() });
  assert.deepEqual(rulesOf(hits), ['R0-unscannable']); // fail-closed: stays blocking even when R5-major-dep is report-only
  assert.match(hits[0].detail, /could not be parsed/);
});

test('IO: deleted and renamed migrations, and a clean change', async () => {
  const repo = createTmpRepo();
  repo.write('supabase/migrations/1_a.sql', 'create table a (id int);\n');
  repo.write('supabase/migrations/2_b.sql', 'create table b (id int);\n');
  repo.write('lib/ok.ts', 'export const a = 1;\n');
  repo.commit('base');
  repo.branch('clean');
  repo.write('lib/ok.ts', 'export const a = 2;\n');
  repo.commit('clean change');
  assert.deepEqual(await collectHardStops({ base: 'main', head: 'clean', cwd: repo.dir, config: cfg() }), []);

  repo.checkout('main');
  repo.branch('bad');
  repo.rm('supabase/migrations/1_a.sql');
  repo.git(['mv', 'supabase/migrations/2_b.sql', 'supabase/migrations/3_b.sql']);
  repo.commit('mess with migrations');
  const hits = await collectHardStops({ base: 'main', head: 'bad', cwd: repo.dir, config: cfg() });
  assert.deepEqual(rulesOf(hits), ['R1-destructive', 'R1-migration-edited']);
  assert.equal(hits.filter((h) => h.rule === 'R1-migration-edited').length, 2);
});

test('IO: a binary secret file is caught by path (and flagged unreadable)', async () => {
  const repo = createTmpRepo();
  repo.write('README.md', 'x\n');
  repo.commit('base');
  repo.branch('feat');
  repo.write('certs/a.pem', Buffer.from([0, 1, 2, 3, 0, 255]).toString('latin1'));
  repo.commit('add cert');
  const hits = await collectHardStops({ base: 'main', head: 'feat', cwd: repo.dir, config: cfg() });
  assert.deepEqual(rulesOf(hits), ['R0-unscannable', 'R3-secrets']);
});

test('R0-unscannable is not raised for the pure deletion of a large binary diffFiles skipped, but is for adding or editing one', () => {
  const skipped = (path, status, over = {}) => ({ ...file(path, { status, binary: true, ...over }), skippedLargeBinary: true });
  assert.deepEqual(rulesOf(run([skipped('data/report.xlsx', 'D')])), []);
  assert.deepEqual(rulesOf(run([skipped('data/report.xlsx', 'A')])), ['R0-unscannable']);
  assert.deepEqual(rulesOf(run([skipped('data/report.xlsx', 'M')])), ['R0-unscannable']);
  assert.deepEqual(rulesOf(run([skipped('data/new.xlsx', 'R', { oldPath: 'data/old.xlsx' })])), ['R0-unscannable']);
  // the exemption is for the skipped large binary only: any other binary deletion keeps its flag
  assert.deepEqual(rulesOf(run([file('data/report.xlsx', { status: 'D', binary: true })])), ['R0-unscannable']);
});

// diffFiles leaves a big binary document out of the --text diff (it would overflow the buffer); its paths must still reach
// the path rules. Real default threshold (4 MiB), so the files are 5 MiB of random bytes.
test('IO: a large binary under migrations, deleted or moved out with an edit, is still caught by path (content skipped by diffFiles)', async () => {
  const [gone, sheet] = [randomBytes(5 * 1024 * 1024), randomBytes(5 * 1024 * 1024)]; // distinct, so git pairs the rename unambiguously
  const repo = createTmpRepo();
  repo.write('README.md', 'x\n');
  repo.write('supabase/migrations/20240101_gone.xlsx', gone);
  repo.write('supabase/migrations/20240102_moved.xlsx', sheet);
  repo.commit('base');
  repo.branch('feat');
  repo.rm('supabase/migrations/20240101_gone.xlsx');
  repo.rm('supabase/migrations/20240102_moved.xlsx');
  repo.write('exports/moved.xlsx', Buffer.concat([sheet, Buffer.from('tail')]));
  repo.commit('delete one, move and edit the other');
  // precondition: both really were skipped, so the hits below come from their paths alone
  assert.deepEqual(diffFiles('main', 'feat', { cwd: repo.dir }).map((f) => f.skippedLargeBinary), [true, true]);
  const hits = await collectHardStops({ base: 'main', head: 'feat', cwd: repo.dir, config: cfg() });
  const of = (file) => rulesOf(hits.filter((h) => h.file === file));
  assert.ok(of('supabase/migrations/20240101_gone.xlsx').includes('R1-destructive'));
  assert.ok(of('supabase/migrations/20240101_gone.xlsx').includes('R1-migration-edited'));
  // a pure deletion adds nothing to read, so it is not "unscannable"; the move-with-edit puts new bytes at a new path, so it is
  assert.ok(!of('supabase/migrations/20240101_gone.xlsx').includes('R0-unscannable'));
  assert.ok(of('exports/moved.xlsx').includes('R0-unscannable'));
  assert.ok(hits.some((h) => h.file === 'exports/moved.xlsx' && h.rule === 'R1-destructive' && /moved out of the migrations dir/.test(h.detail)));
});
