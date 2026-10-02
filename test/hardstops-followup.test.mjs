// Follow-up to the review round: lockfile-only major bumps, `env.NAME` reads through an imported env object, SQL function
// bodies (dollar quotes, BEGIN ATOMIC) as ONE statement, psql meta-commands, and more payroll-adjacent terms.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyHardStops, collectHardStops, scanEnvLine, enclosingStatements } from '../pipeline/lib/hardstops.mjs';
import { createTmpRepo } from './helpers/tmprepo.mjs';
import { MIG, cfg, file, rulesOf, run } from './helpers/hardstops.mjs';

const A = (path, ...added) => file(path, { status: 'A', added });
const flags = (files, opts) => rulesOf(run(files, opts));

function branchRepo(base = {}) {
  const repo = createTmpRepo();
  repo.write('README.md', 'x\n');
  for (const [p, c] of Object.entries(base)) repo.write(p, c);
  repo.commit('base');
  repo.branch('feat');
  return repo;
}
const collect = (repo, config = cfg()) => collectHardStops({ base: 'main', head: 'feat', cwd: repo.dir, config });
const lockHits = (hits, f) => hits.filter((h) => h.file === f && h.rule === 'R5-major-dep' && /lockfile major bump/.test(h.detail));

// ---- 1. lockfile-only majors -----------------------------------------------------------------------------------------

const PKG = JSON.stringify({ name: 'app', dependencies: { next: '^15.5.15', zod: '^3.23.0', 'left-pad': '^0.3.0' }, devDependencies: { '@scope/tool': '^1.0.0' } }, null, 2);
const npmLock = (v) => JSON.stringify({
  lockfileVersion: 3,
  packages: {
    '': { name: 'app', dependencies: { next: '^15.5.15', zod: '^3.23.0', 'left-pad': '^0.3.0' }, devDependencies: { '@scope/tool': '^1.0.0' } },
    'node_modules/next': { version: v.next }, 'node_modules/zod': { version: v.zod }, 'node_modules/left-pad': { version: v['left-pad'] },
    'node_modules/@scope/tool': { version: v.tool }, 'node_modules/transitive': { version: v.transitive },
    'node_modules/zod/node_modules/nested': { version: v.nested },
  },
}, null, 2);
const BASE_V = { next: '15.5.15', zod: '3.23.0', 'left-pad': '0.3.0', tool: '1.0.0', transitive: '1.0.0', nested: '1.0.0' };

test('1 IO: package-lock.json - a DIRECT dependency major (or 0.x minor) bump with package.json untouched is R5; minors and transitive-only changes are silent', async () => {
  const repo = branchRepo({ 'package.json': PKG, 'package-lock.json': npmLock(BASE_V) });
  repo.write('package-lock.json', npmLock({ ...BASE_V, next: '16.0.0', 'left-pad': '0.4.0', tool: '2.0.0', zod: '3.24.1', transitive: '9.0.0', nested: '9.0.0' }));
  repo.commit('lock only');
  const hits = lockHits(await collect(repo), 'package-lock.json');
  const text = hits.map((h) => h.detail).join('|');
  for (const name of ['next', 'left-pad', '@scope/tool']) assert.match(text, new RegExp(name.replace('/', '\\/')), `${name}: ${text}`);
  assert.ok(!/zod|transitive|nested/.test(text), text);
});

test('1 IO: a lockfile with only transitive / minor changes is silent', async () => {
  const repo = branchRepo({ 'package.json': PKG, 'package-lock.json': npmLock(BASE_V) });
  repo.write('package-lock.json', npmLock({ ...BASE_V, zod: '3.99.0', transitive: '7.0.0', nested: '4.0.0' }));
  repo.commit('churn');
  assert.deepEqual(await collect(repo), []);
});

test('1 IO: lockfileVersion 1 (nested "dependencies" map) is read too', async () => {
  const v1 = (n) => JSON.stringify({ lockfileVersion: 1, dependencies: { next: { version: n }, zod: { version: '3.23.0' } } });
  const repo = branchRepo({ 'package.json': PKG, 'package-lock.json': v1('15.5.15') });
  repo.write('package-lock.json', v1('16.1.0'));
  repo.commit('v1 bump');
  assert.equal(lockHits(await collect(repo), 'package-lock.json').length, 1);
});

test('1 IO: pnpm-lock.yaml (v6/v9 keys) and yarn.lock (classic and berry) direct major bumps are R5', async () => {
  const pnpm = (n) => `lockfileVersion: '9.0'\n\nimporters:\n  .:\n    dependencies:\n      next:\n        specifier: ^15.5.15\n        version: ${n}(react@19.0.0)\n\npackages:\n\n  next@${n}:\n    resolution: {integrity: sha512-x}\n\n  zod@3.23.0:\n    resolution: {integrity: sha512-y}\n\n  other@1.0.0:\n    resolution: {integrity: sha512-z}\n`;
  const classic = (n, o) => `# yarn lockfile v1\n\n\nnext@^15.5.15:\n  version "${n}"\n  resolved "https://x"\n\nother@^1.0.0, other@^1.2.0:\n  version "${o}"\n`;
  const berry = (n, o) => `__metadata:\n  version: 8\n\n"next@npm:^15.5.15":\n  version: ${n}\n  resolution: "next@npm:${n}"\n\n"other@npm:^1.0.0":\n  version: ${o}\n`;
  for (const [name, make] of [['pnpm-lock.yaml', (n, o) => pnpm(n, o).replace('other@1.0.0', `other@${o}`)], ['yarn.lock', classic], ['apps/web/yarn.lock', berry]]) {
    const dir = name.includes('/') ? 'apps/web/' : '';
    const repo = branchRepo({ [`${dir}package.json`]: PKG, [name]: make('15.5.15', '1.0.0') });
    repo.write(name, make('16.0.0', '5.0.0')); // `other` is not a direct dependency
    repo.commit('bump');
    const hits = lockHits(await collect(repo), name);
    assert.equal(hits.length, 1, `${name}: ${JSON.stringify(hits)}`);
    assert.match(hits[0].detail, /next/);
  }
});

test('1 IO: an unparseable lockfile is R0-unscannable; a deleted or new lockfile is not a bump', async () => {
  const repo = branchRepo({ 'package.json': PKG, 'package-lock.json': npmLock(BASE_V), 'yarn.lock': '# yarn lockfile v1\n\nnext@^15:\n  version "15.0.0"\n' });
  repo.write('package-lock.json', '{ "lockfileVersion": 3, "packages": {');
  repo.write('yarn.lock', 'this is not a lockfile\nat all\n');
  repo.commit('mangled');
  const hits = await collect(repo);
  assert.ok(hits.some((h) => h.rule === 'R0-unscannable' && h.file === 'package-lock.json'), JSON.stringify(hits));
  assert.ok(hits.some((h) => h.rule === 'R0-unscannable' && h.file === 'yarn.lock'), JSON.stringify(hits));

  const repo2 = branchRepo({ 'package.json': PKG });
  repo2.write('package-lock.json', npmLock(BASE_V));
  repo2.commit('new lock');
  assert.deepEqual(lockHits(await collect(repo2), 'package-lock.json'), []);
});

test('1 pure: lock pairs compare direct names only; an error pair is R0; a lockfile in the diff needs its pair', () => {
  const lock = file('package-lock.json', { added: ['x'] });
  const pair = { file: 'package-lock.json', kind: 'lock', direct: ['a'], base: { a: ['1.2.0'], b: ['1.0.0'] }, head: { a: ['2.0.0'], b: ['5.0.0'] } };
  const hits = classifyHardStops({ files: [lock], config: cfg(), pkgPairs: [pair], sqlStatements: [] });
  assert.deepEqual(hits.filter((h) => h.rule === 'R5-major-dep').map((h) => /^a /.test(h.detail) || / a /.test(h.detail)), [true]);
  assert.deepEqual(rulesOf(classifyHardStops({ files: [lock], config: cfg(), pkgPairs: [{ ...pair, direct: null }], sqlStatements: [] })), ['R5-major-dep']);
  assert.deepEqual(rulesOf(classifyHardStops({ files: [lock], config: cfg(), pkgPairs: [{ file: 'package-lock.json', kind: 'lock', error: 'head' }], sqlStatements: [] })), ['R0-unscannable']);
  assert.throws(() => classifyHardStops({ files: [lock], config: cfg(), pkgPairs: [], sqlStatements: [] }), /package-lock\.json/);
});

// ---- 2. env.NAME through an imported env object -----------------------------------------------------------------------

test('2 scanEnvLine: env.NAME / env["NAME"] are names only when the file imports env; $env/* named imports always are', () => {
  assert.deepEqual(scanEnvLine('const k = env.NEW_KEY + env["OTHER_KEY"];', { envObject: true }).names.sort(), ['NEW_KEY', 'OTHER_KEY']);
  assert.deepEqual(scanEnvLine('const k = env.NEW_KEY;').names, []);
  assert.deepEqual(scanEnvLine('const k = env.lowercase + this.env.NOPE + process.env.REAL;', { envObject: true }).names, ['REAL']);
  assert.deepEqual(scanEnvLine("import { SECRET_A, SECRET_B as b } from '$env/static/private';").names.sort(), ['SECRET_A', 'SECRET_B']);
});

test('2 pure: env.NAME in a file whose added lines import env -> R3; without the import it is not', () => {
  const imp = file('src/a.ts', { status: 'A', added: ["import { env } from '@/env';", 'export const k = env.NEW_KEY;'] });
  const hits = run([imp]);
  assert.ok(hits.some((h) => h.rule === 'R3-secrets' && /NEW_KEY/.test(h.detail)), JSON.stringify(hits));
  assert.deepEqual(flags([A('src/b.ts', 'export const k = env.NEW_KEY;')]), []);
  assert.ok(flags([A('src/c.ts', "import { NEW_SECRET } from '$env/static/private';")]).includes('R3-secrets'));
  assert.ok(flags([A('src/d.ts', "import { env } from '$env/dynamic/private';", "const k = env['NEW_KEY'];")]).includes('R3-secrets'));
});

test('2 IO: env.NAME is new unless the base ALREADY reads it; an import on an unchanged line still counts', async () => {
  const repo = branchRepo({
    'src/a.ts': "import { env } from '@/env';\nexport const a = env.KNOWN_KEY;\n",
    'src/b.ts': "import { env } from '@/env';\nexport const b = 1;\n",
    'docs/plan.md': 'we will read env.DOC_ONLY_KEY\n',
  });
  repo.write('src/a.ts', "import { env } from '@/env';\nexport const a = env.KNOWN_KEY;\nexport const a2 = env.KNOWN_KEY;\n");
  repo.write('src/b.ts', "import { env } from '@/env';\nexport const b = 1;\nexport const c = env.FRESH_KEY;\nexport const d = env.DOC_ONLY_KEY;\n");
  repo.commit('use env');
  const hits = await collect(repo);
  const text = hits.filter((h) => h.rule === 'R3-secrets').map((h) => `${h.file}:${h.detail}`).join('|');
  assert.match(text, /src\/b\.ts:.*FRESH_KEY/);
  assert.match(text, /src\/b\.ts:.*DOC_ONLY_KEY/);
  assert.ok(!/KNOWN_KEY/.test(text), text);
});

// ---- 3. function bodies are one statement -----------------------------------------------------------------------------

const ATOMIC = 'create function can_see(uid uuid) returns boolean\n  language sql\n  security definer\nbegin atomic\n  select 1;\n  select 2;\nend;\nselect 3;\n';

test('3 enclosingStatements: BEGIN ATOMIC ... END is ONE statement; the next statement is separate', () => {
  for (const ln of [5, 6, 7]) {
    const s = enclosingStatements(ATOMIC, [ln]);
    assert.equal(s.length, 1, `line ${ln}: ${JSON.stringify(s)}`);
    assert.match(s[0], /security definer/);
    assert.match(s[0], /select 1;\s*select 2;\s*end;$/);
  }
  assert.deepEqual(enclosingStatements(ATOMIC, [8]), ['select 3;']);
});

test('3 enclosingStatements: CASE ... END inside an atomic body does not end it early; END outside a body is ignored', () => {
  const t = 'create function f() returns int language sql security definer\nbegin atomic\n  select case when a then 1 else 2 end;\n  select 2;\nend;\nselect case when x then 1 end;\nselect 9;\n';
  const s = enclosingStatements(t, [4]);
  assert.equal(s.length, 1);
  assert.match(s[0], /security definer/);
  assert.deepEqual(enclosingStatements(t, [7]), ['select 9;']);
  assert.deepEqual(enclosingStatements(t, [6]), ['select case when x then 1 end;']);
});

test('3 enclosingStatements: a dollar-quoted body (plain and tagged) is one statement for any line inside it', () => {
  for (const tag of ['$$', '$fn$']) {
    const t = `create or replace function f() returns int language plpgsql security definer as ${tag}\nbegin\n  perform 1;\n  perform 2;\nend;\n${tag};\nselect 3;\n`;
    for (const ln of [3, 4, 5]) {
      const s = enclosingStatements(t, [ln]);
      assert.equal(s.length, 1, `${tag} line ${ln}`);
      assert.match(s[0], /security definer/);
    }
  }
});

test('3 IO: editing the second statement inside a BEGIN ATOMIC security definer body -> R2-sql-statement', async () => {
  const repo = branchRepo({ 'db/schema.sql': ATOMIC });
  repo.write('db/schema.sql', ATOMIC.replace('select 2;', 'select 2 /* changed */ + 0;'));
  repo.commit('edit body');
  const hits = await collect(repo);
  assert.ok(hits.some((h) => h.rule === 'R2-sql-statement' && h.file === 'db/schema.sql' && /security definer/i.test(h.detail)), JSON.stringify(hits));
});

// ---- 4. psql meta-commands -------------------------------------------------------------------------------------------

test('4 psql meta-commands on added SQL lines are R1 (they run other files, programs or reconnect)', () => {
  for (const line of ['\\i other.sql', '  \\ir ./seed.sql', '\\include x.sql', "\\copy t from 'x.csv'", '\\connect other_db', '\\c postgres', '\\! rm -rf /', '\\o /tmp/out', '\\set ON_ERROR_STOP 0', '\\gset']) {
    for (const p of [MIG, 'db/seed.sql']) {
      const hits = run([file(p, { status: 'A', added: [line] })]);
      assert.ok(hits.some((h) => h.rule === 'R1-destructive' && /psql meta-command/.test(h.detail)), `${p}: ${line}`);
    }
  }
});

test('4 psql meta-command lookalikes are not flagged: comments, strings, non-SQL files, \\copyright-style words', () => {
  assert.deepEqual(flags([file('db/seed.sql', { status: 'A', added: ['-- \\i other.sql', "select '\\i x';", 'select 1; -- \\copy'] })]), []);
  assert.deepEqual(flags([A('lib/x.ts', "const s = '\\\\copy';")]), []);
  assert.deepEqual(flags([file('db/seed.sql', { status: 'A', added: ['\\copyright'] })]), []);
});

// ---- 5. more payroll-adjacent terms --------------------------------------------------------------------------------------

test('5 R6 paths: compensation, withholding, gov contributions, 13th month, BIR 2316 (word-bounded; not bare tax)', () => {
  for (const p of ['lib/compensation/adjust.ts', 'lib/tax/withholding.ts', 'lib/gov-contributions.ts', 'lib/govContributions.ts', 'lib/gov_contribution.ts', 'lib/13th-month.ts', 'lib/thirteenth/13thMonthPay.ts', 'lib/bir-2316.ts', 'lib/bir_2316/x.ts']) {
    assert.deepEqual(flags([file(p)]), ['R6-sensitive'], p);
  }
  for (const p of ['lib/tax/rates.ts', 'lib/compensatory.ts', 'lib/government.ts', 'lib/birds.ts']) assert.deepEqual(flags([file(p)]), [], p);
});

test('5 R6 content: the same terms in added production code (camelCase and snake_case), not in comments, tests or docs', () => {
  for (const line of ['const w = computeWithholding(g);', 'const c = totalCompensation(e);', 'sendGovContributions(list);', 'const gov_contributions = [];', 'pay13thMonth(e);', 'const m = "13th-month";', 'renderBir2316(e);', 'const f = "bir_2316";']) {
    assert.deepEqual(flags([A('lib/x.ts', line)]), ['R6-sensitive'], line);
  }
  assert.deepEqual(flags([A('lib/x.ts', '// notes on compensation and withholding')]), []);
  assert.deepEqual(flags([A('lib/x.test.ts', 'const w = withholding;')]), []);
  assert.deepEqual(flags([A('docs/pay.md', 'compensation, withholding')]), []);
  assert.deepEqual(flags([A('lib/x.ts', 'const taxRate = 0.12;')]), []);
});
