// Review-driven cases: every way the first classifier let a dangerous change through (or flagged something harmless).
// Each test names the bypass it closes. Pure tests use the table builders; IO tests run real git.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyHardStops, collectHardStops, scanEnvLine, parsePythonDeps, enclosingStatements } from '../pipeline/lib/hardstops.mjs';
import { createTmpRepo } from './helpers/tmprepo.mjs';
import { MIG, pkg, cfg, file, rulesOf, classify, run } from './helpers/hardstops.mjs';
import { assertLinear } from './helpers/timing.mjs';

const A = (path, ...added) => file(path, { status: 'A', added });
const flags = (files, opts) => rulesOf(run(files, opts));
const details = (hits) => hits.map((h) => h.detail);
// CPU time (user + system) a call burns, in ms. The ReDoS guards below are about work done, not wall-clock: under machine load
// a wall-clock budget flakes, while CPU time stays put (a quadratic regex still blows it).
function cpuMs(fn) {
  const t0 = process.cpuUsage();
  const value = fn();
  const d = process.cpuUsage(t0);
  return { value, ms: (d.user + d.system) / 1000 };
}

// A repo with `base` files on main and a `feat` branch checked out; `collect(repo)` classifies feat against main.
function branchRepo(base = {}) {
  const repo = createTmpRepo();
  repo.write('README.md', 'x\n');
  for (const [p, c] of Object.entries(base)) repo.write(p, c);
  repo.commit('base');
  repo.branch('feat');
  return repo;
}
const collect = (repo, config = cfg()) => collectHardStops({ base: 'main', head: 'feat', cwd: repo.dir, config });
const NUL = String.fromCharCode(0);

// ---- 1. binary diffs cannot be read -----------------------------------------------------------------------------

test('1 binary diff of a non-asset file -> R0-unscannable (a single NUL byte makes git call a text file binary)', () => {
  for (const p of [MIG, 'lib/a.ts', 'Makefile', 'data/x.dat', 'a.png.ts', 'scripts/run.sh']) {
    const hits = run([file(p, { status: 'A', binary: true })]);
    assert.ok(rulesOf(hits).includes('R0-unscannable'), p);
    assert.match(hits.find((h) => h.rule === 'R0-unscannable').detail, /binary/);
  }
});

test('1 binary assets are accepted without reading (case-insensitive)', () => {
  for (const ext of ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'ico', 'svg', 'pdf', 'woff', 'woff2', 'ttf', 'otf', 'eot', 'mp4', 'mov', 'mp3', 'wav', 'snap', 'PNG']) {
    assert.deepEqual(flags([file(`public/x.${ext}`, { status: 'A', binary: true })]), [], ext);
  }
});

test('1 a binary rename from an asset to a non-asset is unscannable (every path must be an asset)', () => {
  assert.ok(flags([file('lib/a.ts', { status: 'R', oldPath: 'public/a.png', binary: true })]).includes('R0-unscannable'));
});

test('1 .gitattributes -> R4-pipeline (it can switch diff/textconv off for other files)', () => {
  assert.deepEqual(flags([file('.gitattributes')]), ['R4-pipeline']);
  assert.deepEqual(flags([file('apps/web/.gitattributes')]), ['R4-pipeline']);
});

test('1 a NUL byte inside a changed line (UTF-16 text read with --text) is unscannable too', () => {
  const utf16 = [...'drop table t;'].join(NUL);
  assert.ok(flags([A(MIG, utf16)]).includes('R0-unscannable'));
  assert.ok(flags([A('lib/k.ts', `// ${NUL}`)]).includes('R0-unscannable'));
});

test('1 IO: NUL byte in a migration / a .ts / a UTF-16 migration / .gitattributes trick are all flagged', async () => {
  const repo = branchRepo();
  repo.write('supabase/migrations/20260102_x.sql', `drop table public.employees;\n-- ${NUL}\n`);
  repo.write('lib/k.ts', `// ${NUL}\nexport const k = process.env.NEW_SECRET;\n`);
  repo.write('supabase/migrations/20260102_z.sql', Buffer.from('﻿drop table public.employees;\n', 'utf16le'));
  repo.write('.gitattributes', '*.sql -diff\n');
  repo.commit('sneaky');
  const hits = await collect(repo);
  for (const f of ['supabase/migrations/20260102_x.sql', 'lib/k.ts', 'supabase/migrations/20260102_z.sql']) {
    assert.ok(hits.some((h) => h.file === f), `${f} must be flagged: ${JSON.stringify(hits.map((h) => [h.rule, h.file]))}`);
  }
  assert.ok(hits.some((h) => h.rule === 'R4-pipeline' && h.file === '.gitattributes'));
});

// ---- 2. env baseline: only a real READ on the base counts ------------------------------------------------------

test('2 IO: a name is known only if base code reads it; docs, markdown, comments and longer names do not count', async () => {
  const repo = branchRepo({
    'docs/setup.md': 'Later we will add NEW_DOC_ONLY for the exporter.\n',
    'notes/plan.md': 'NEW_MD_ONLY=1\n',
    'lib/c.ts': '// FOO_COMMENT_ONLY is not read yet\nexport const x = process.env.FOO_COMMENT_ONLY_OLD;\n',
    'lib/known.ts': [
      "export const a = process.env['KNOWN_BRACKET'];",
      "export const b = Deno.env.get('KNOWN_DENO');",
      'export const c = import.meta.env.KNOWN_VITE;',
      'export const { KNOWN_DESTRUCT, OTHER } = process.env;',
      'export const d = process.env[`KNOWN_BACKTICK`];',
      '',
    ].join('\n'),
    'scripts/p.py': 'import os\nx = os.getenv("KNOWN_PY")\ny = os.environ.get("KNOWN_PY_GET")\nz = getenv("KNOWN_BARE")\n',
    'app/Http/c.php': "<?php $v = env('KNOWN_PHP');\n",
  });
  repo.write('lib/new.ts', [
    'export const n = [',
    '  process.env.NEW_DOC_ONLY, process.env.NEW_MD_ONLY, process.env.FOO_COMMENT_ONLY,',
    "  process.env['KNOWN_BRACKET'], Deno.env.get('KNOWN_DENO'), import.meta.env.KNOWN_VITE, process.env.KNOWN_DESTRUCT,",
    '  process.env.KNOWN_BACKTICK, process.env.OTHER,',
    '];',
    'export const py = [os.getenv("KNOWN_PY"), os.environ.get("KNOWN_PY_GET"), getenv("KNOWN_BARE"), env("KNOWN_PHP")];',
    '',
  ].join('\n'));
  repo.commit('use env');
  const hits = (await collect(repo)).filter((h) => h.rule === 'R3-secrets');
  const flagged = hits.map((h) => h.detail).join(' ');
  for (const name of ['NEW_DOC_ONLY', 'NEW_MD_ONLY', 'FOO_COMMENT_ONLY']) assert.match(flagged, new RegExp(`new env var[^;]*${name}`), name);
  assert.doesNotMatch(flagged, /KNOWN_|OTHER/);
});

test('2 IO: many new names resolve correctly across lookup batches', async () => {
  const known = Array.from({ length: 70 }, (_, i) => `export const k${i} = process.env.KNOWN_NAME_${i};`).join('\n');
  const repo = branchRepo({ 'lib/known.ts': `${known}\n` });
  const reads = [
    ...Array.from({ length: 70 }, (_, i) => `process.env.KNOWN_NAME_${i}`),
    ...Array.from({ length: 60 }, (_, i) => `process.env.FRESH_NAME_${i}`),
  ];
  repo.write('lib/new.ts', reads.map((r, i) => `export const n${i} = ${r};`).join('\n') + '\n');
  repo.commit('many');
  const hits = (await collect(repo)).filter((h) => h.rule === 'R3-secrets');
  assert.equal(hits.length, 60);
  assert.ok(hits.every((h) => /FRESH_NAME_/.test(h.detail)));
});

// ---- 3. env access forms ----------------------------------------------------------------------------------------

test('3 scanEnvLine: literal reads give names, anything else that touches the env object is dynamic', () => {
  const literal = {
    'process.env.NODE_ENV': 'NODE_ENV', "process.env['A_B']": 'A_B', 'process.env["A_B"]': 'A_B', 'process.env[`A_B`]': 'A_B',
    'import.meta.env.A_B': 'A_B', "Deno.env.get('A_B')": 'A_B', 'getenv("A_B")': 'A_B', 'os.getenv("A_B")': 'A_B', 'env("A_B")': 'A_B',
    'os.environ["A_B"]': 'A_B', "ENV['A_B']": 'A_B',
  };
  for (const [text, name] of Object.entries(literal)) {
    assert.deepEqual(scanEnvLine(text), { names: [name], dynamic: false }, text);
  }
  for (const text of [
    'process.env[name]', 'process.env[`KEY_${x}`]', 'process.env?.FOO', 'const all = { ...process.env };', 'const e = process.env;',
    'export const k = process.env', 'Object.keys(process.env)', 'import.meta.env', 'dict(os.environ)',
  ]) {
    assert.equal(scanEnvLine(text).dynamic, true, text);
  }
});

test('3 dynamic env access is an R3 hit even when no name can be read', () => {
  for (const text of ['export const k = (n: string) => process.env[n];', 'export const all = { ...process.env };', 'const e = process.env;', 'export const k = process.env?.FOO;']) {
    const hits = run([file('lib/e.ts', { added: [text] })]);
    assert.deepEqual(rulesOf(hits), ['R3-secrets'], text);
    assert.match(hits[0].detail, /dynamic env access/, text);
  }
  assert.deepEqual(flags([file('lib/e.ts', { added: ['x = process.env.NODE_ENV === "production"'] })], { baseEnvNames: ['NODE_ENV'] }), []);
});

test('3 a backtick-quoted literal key is a new env var; a read split over two lines flags on the first line', () => {
  const hits = run([file('lib/e.ts', { added: ['export const k = process.env[`NEW_BACKTICK_KEY`];'] })]);
  assert.match(hits[0].detail, /new env var NEW_BACKTICK_KEY/);
  assert.match(run([file('lib/e2.ts', { added: ['export const k = process.env', '  .NEW_SPLIT_KEY;'] })])[0].detail, /dynamic/);
});

test('3 Python getenv("X") without os. is a new env var', () => {
  const hits = run([A('scripts/job.py', 'k = getenv("NEW_PY_KEY")')]);
  assert.match(hits[0].detail, /new env var NEW_PY_KEY/);
});

test('3 pure: a NAME: / NAME, line in a file that deals with env is a possible new env var; elsewhere it is not', () => {
  const l = { added: ['  NEW_STRIPE_SECRET: z.string(),'] };
  const hits = run([file('lib/env.ts', l)], { envFiles: ['lib/env.ts'] });
  assert.deepEqual(rulesOf(hits), ['R3-secrets']);
  assert.match(hits[0].detail, /possible new env var NEW_STRIPE_SECRET/);
  assert.deepEqual(flags([file('lib/env.ts', l)], { envFiles: ['lib/env.ts'], baseEnvNames: ['NEW_STRIPE_SECRET'] }), []);
  assert.deepEqual(flags([file('lib/consts.ts', l)], { envFiles: ['lib/env.ts'] }), []);
  assert.deepEqual(flags([file('lib/consts.ts', { added: ['  MAX_RETRIES: 3,'] })]), []);
  // With no envFiles, the diff lines themselves decide.
  assert.deepEqual(flags([file('lib/env.ts', { added: ['const s = z.object({', '  NEW_STRIPE_SECRET: z.string(),'] })]), ['R3-secrets']);
});

test('3 IO: a new name added inside an EXISTING multi-line destructure or zod env schema is caught', async () => {
  const destructure = 'export const {\n  NEXT_PUBLIC_SUPABASE_URL,\n  OTHER,\n} = process.env;\n';
  const zod = "import { z } from 'zod';\nexport const env = z.object({\n  NEXT_PUBLIC_SUPABASE_URL: z.string(),\n}).parse(process.env);\n";
  for (const [content, anchor] of [[destructure, '  OTHER,\n'], [zod, '  NEXT_PUBLIC_SUPABASE_URL: z.string(),\n']]) {
    const repo = branchRepo({ 'lib/env.ts': content, 'lib/use.ts': 'export const u = process.env.NEXT_PUBLIC_SUPABASE_URL;\nexport const o = process.env.OTHER;\n' });
    repo.write('lib/env.ts', content.replace(anchor, `${anchor}  NEW_STRIPE_SECRET${anchor.includes('z.') ? ': z.string()' : ''},\n`));
    repo.commit('add var');
    const hits = await collect(repo);
    assert.ok(hits.some((h) => h.rule === 'R3-secrets' && /NEW_STRIPE_SECRET/.test(h.detail)), JSON.stringify(hits));
    assert.ok(!hits.some((h) => /OTHER|NEXT_PUBLIC/.test(h.detail)));
  }
});

// ---- 4. SQL that lives inside code ----------------------------------------------------------------------------

test('4 destructive / auth SQL inside strings of non-SQL code is caught (ts, py, go, supabase functions)', () => {
  const r1 = [
    ['lib/db.ts', 'await sql`DROP TABLE users`;'], ['lib/db.ts', "await q('truncate table audit')"], ['scripts/x.py', 'cur.execute("DELETE FROM users")'],
    ['db/x.go', 'db.Exec(`ALTER TABLE t RENAME COLUMN a TO b`)'], ['lib/db.ts', 'sql`update users set x = 1`'],
    ['supabase/functions/x/index.ts', "await db.query('drop table t')"], ['lib/db.ts', 'await sql`DROP POLICY p ON t`'],
  ];
  for (const [p, text] of r1) assert.ok(flags([file(p, { added: [text] })]).includes('R1-destructive'), `${p}: ${text}`);
  const r2 = [
    ['lib/db.ts', 'await sql`ALTER TABLE t DISABLE ROW LEVEL SECURITY`'], ['scripts/x.py', 'cur.execute("GRANT SELECT ON t TO anon")'],
    ['lib/db.ts', 'sql`CREATE POLICY p ON t USING (true)`'], ['lib/db.ts', 'sql`REVOKE ALL ON t FROM anon`'],
    ['lib/db.ts', 'sql`CREATE FUNCTION f() RETURNS int SECURITY DEFINER AS $$ select 1 $$`'],
  ];
  // A database authorization change is SQL whatever file carries it: R2-sql-statement, which can never be report-only.
  for (const [p, text] of r2) assert.ok(flags([file(p, { added: [text] })]).includes('R2-sql-statement'), `${p}: ${text}`);
});

test('4 ordinary prose and identifiers in code do not look like SQL', () => {
  for (const text of [
    'const title = "Drop down menu";', 'export const truncate = (s: string) => s.slice(0, 10);', 'const grant = await getGrant(id);',
    '// we grant access to the user', 'const revoke = () => {};', 'items.filter((i) => i.deleted_from)', 'function execute() {}',
    'const x = _.truncate(text, { length: 20 });', 'type Row = { drop: boolean };',
  ]) {
    assert.deepEqual(flags([file('lib/a.ts', { added: [text] })]), [], text);
  }
});

test('4 SQL-looking text in a comment line of code is not flagged', () => {
  assert.deepEqual(flags([file('lib/a.ts', { added: ['// DROP TABLE users; GRANT ALL ON t TO anon', ' * DELETE FROM users'] })]), []);
});

test('4 auth.admin.* and a Supabase .from(...).delete()/upsert() on one line', () => {
  for (const text of ['await supabase.auth.admin.deleteUser(id);', 'const { data } = await sb.auth.admin.listUsers();']) {
    const hits = run([file('app/actions/x.ts', { added: [text] })]);
    assert.deepEqual(rulesOf(hits), ['R2-auth'], text);
  }
  for (const text of ["await sb.from('t').delete().neq('id', 0);", "await sb.from('t').upsert(rows);"]) {
    assert.deepEqual(flags([file('app/x.ts', { added: [text] })]), ['R1-data-write'], text);
  }
  assert.deepEqual(flags([file('app/x.ts', { added: ['await cache.delete(key);', 'map.delete(k)', "await sb.from('t').select('*')"] })]), []);
});

// ---- 5. secrets by shape ---------------------------------------------------------------------------------------

const SECRETS = {
  'Stripe live key': 'sk_' + 'live_' + 'abcdefghij1234',
  'Stripe restricted key': 'rk_' + 'live_' + 'abcdefghij1234',
  'AWS access key id': 'AKIA' + 'ABCDEFGHIJKLMNOP',
  'private key block': '-----BEGIN ' + 'RSA PRIVATE KEY-----',
  JWT: 'eyJ' + 'hbGciOiJIUzI1NiIsInR5cCI6' + '.eyJ' + 'zdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6' + '.abcdefghij1234',
  'Slack token': 'xox' + 'b-1234567890-abcdef',
  'GitHub token': 'gh' + 'p_' + 'a'.repeat(36),
  'GitHub fine-grained token': 'github_' + 'pat_' + 'A'.repeat(22),
  'Google API key': 'AI' + 'za' + 'B'.repeat(35),
  'Vault secret': "select vault." + "create_secret('x', 'y');",
};

test('5 secret-shaped literals are R3 in production code, and the hit never repeats the secret', () => {
  for (const [kind, secret] of Object.entries(SECRETS)) {
    const hits = run([file('lib/pay.ts', { added: [`const key = "${secret}";`] })]);
    assert.deepEqual(rulesOf(hits), ['R3-secrets'], kind);
    assert.match(hits[0].detail, new RegExp(`secret-like literal \\(${kind}\\)`), kind);
    assert.equal(hits[0].excerpt, undefined, `${kind}: excerpt must not echo the secret`);
    assert.ok(!JSON.stringify(hits).includes(secret), kind);
  }
});

test('5 secret literals in SQL and workflows too; tests and docs are exempt; normal text is not a secret', () => {
  assert.ok(flags([A('supabase/migrations/5_a.sql', `select vault.create_secret('${SECRETS['Stripe live key']}', 'x');`)]).includes('R3-secrets'));
  assert.ok(flags([file('.github/workflows/x.yml', { added: [`  KEY: ${SECRETS['AWS access key id']}`] })]).includes('R3-secrets'));
  // Tests and docs keep ONE content rule (key-shaped secrets); see test/hardstops-exemptions.test.mjs.
  assert.deepEqual(flags([file('docs/pay.md', { added: [SECRETS['Stripe live key']] })]), ['R3-secrets']);
  assert.deepEqual(flags([file('lib/a.ts', { added: ['const a = "sk_live_"; const b = "AKIA"; // eyJ.eyJ.x'] })]), []);
});

// ---- 6. dependency structure -----------------------------------------------------------------------------------

const pk = (over = {}) => ({ name: 'x', scripts: { dev: 'next dev', build: 'next build', test: 'vitest run' }, dependencies: { next: '^15.0.0', react: '^19.0.0' }, devDependencies: { typescript: '^5.0.0' }, ...over });
const pkgHits = (base, head, extra = {}) => run([file('package.json')], { pkgPairs: [{ file: 'package.json', base, head }], ...extra });
const pkgRules = (base, head) => rulesOf(pkgHits(base, head));

test('6 package.json gate scripts: any change to a verify/build/install script is R4 (config if new and plain, pipeline if changed, removed or a lifecycle hook); unrelated scripts are not', () => {
  for (const name of ['test', 'verify', 'lint', 'build', 'prepare', 'postinstall', 'preinstall', 'install', 'merge', 'e2e', 'coverage', 'vercel-build', 'pretest', 'test:unit', 'prepublishOnly', 'typecheck', 'lint:date-math', 'pretest:run', 'dependencies']) {
    const base = pk();
    const head = pk({ scripts: { ...base.scripts, [name]: 'echo ok' } });
    const existed = name in base.scripts;
    assert.deepEqual(pkgRules(base, head), [existed || /^(?:pre|post)|^(?:install|dependencies)$/.test(name) ? 'R4-pipeline' : 'R4-config'], `add ${name}`);
  }
  assert.deepEqual(pkgRules(pk(), pk({ scripts: { dev: 'next dev -p 3001', build: 'next build', test: 'vitest run' } })), []);
  assert.deepEqual(pkgRules(pk(), pk({ scripts: { dev: 'next dev', build: 'next build', test: 'true' } })), ['R4-pipeline']);
  assert.deepEqual(pkgRules(pk(), pk({ scripts: { dev: 'next dev', build: 'next build' } })), ['R4-pipeline'], 'removing the test script');
});

test('6 package.json gate config blocks: husky, lint-staged, jest, nyc -> R4', () => {
  for (const key of ['husky', 'lint-staged', 'jest', 'nyc', 'vitest', 'eslintConfig']) {
    assert.deepEqual(pkgRules(pk(), pk({ [key]: { a: 1 } })), ['R4-pipeline'], key);
    assert.deepEqual(pkgRules(pk({ [key]: { a: 1 } }), pk({ [key]: { a: 2 } })), ['R4-pipeline'], `edit ${key}`);
  }
});

test('6 overrides / resolutions / pnpm.overrides: every added, removed or changed pin is R5', () => {
  assert.deepEqual(pkgRules(pk(), pk({ overrides: { react: '20.0.0' } })), ['R5-major-dep']);
  assert.deepEqual(pkgRules(pk({ overrides: { react: '19.0.0' } }), pk()), ['R5-major-dep']);
  assert.deepEqual(pkgRules(pk(), pk({ resolutions: { lodash: '4.17.21' } })), ['R5-major-dep']);
  assert.deepEqual(pkgRules(pk(), pk({ pnpm: { overrides: { lodash: '5.0.0' } } })), ['R5-major-dep']);
  assert.deepEqual(pkgRules(pk({ overrides: { a: '1' } }), pk({ overrides: { a: '1' } })), []);
});

test('6 packageManager: every change is R4 (guard core); a major bump is also R5', () => {
  assert.deepEqual(pkgRules(pk({ packageManager: 'pnpm@9.0.0' }), pk({ packageManager: 'pnpm@10.0.0' })), ['R4-pipeline', 'R5-major-dep']);
  assert.deepEqual(pkgRules(pk({ packageManager: 'pnpm@9.0.0' }), pk({ packageManager: 'pnpm@9.1.0' })), ['R4-pipeline']);
  assert.deepEqual(pkgRules(pk(), pk({ packageManager: 'pnpm@9.0.0' })), ['R4-pipeline']);
  assert.deepEqual(pkgRules(pk({ packageManager: 'pnpm@9.0.0' }), pk({ packageManager: 'pnpm@9.0.0' })), []);
});

test('6 a dependency moved between sections with a major change is R5; a plain move is not', () => {
  const moved = pkgHits(pk(), pk({ dependencies: { next: '^15.0.0', react: '^19.0.0', typescript: '^6.0.0' }, devDependencies: {} }));
  assert.deepEqual(rulesOf(moved), ['R5-major-dep']);
  assert.match(moved[0].detail, /moved from devDependencies to dependencies/);
  assert.deepEqual(pkgRules(pk(), pk({ dependencies: { next: '^15.0.0', react: '^19.0.0', typescript: '^5.0.0' }, devDependencies: {} })), []);
});

test('6 a range that WIDENS is R5 even when the first version number did not move', () => {
  const widened = ['>=15', '>=15.5.15', '^15.0.0 || ^16.0.0', '*', 'latest', 'x', '15.x || 16.x', '>=15 <17'];
  for (const to of widened) assert.deepEqual(pkgRules(pk(), pk({ dependencies: { next: to, react: '^19.0.0' } })), ['R5-major-dep'], to);
  const narrowOrSame = [['^15.0.0', '^15.1.0'], ['^15.0.0', '~15.0.0'], ['>=15 <17', '>=15 <16'], ['>=15 <17', '>=15.2 <17'], ['^15.0.0 || ^16.0.0', '^16.0.0']];
  for (const [from, to] of narrowOrSame) {
    assert.deepEqual(pkgRules(pk({ dependencies: { next: from } }), pk({ dependencies: { next: to } })), from === '^15.0.0 || ^16.0.0' ? ['R5-major-dep'] : [], `${from} -> ${to}`);
  }
});

test('6 engines.node: a major bump or a widened range is R5', () => {
  assert.deepEqual(pkgRules(pk({ engines: { node: '>=18 <21' } }), pk({ engines: { node: '>=18 <23' } })), ['R5-major-dep']);
  assert.deepEqual(pkgRules(pk({ engines: { node: '>=18' } }), pk({ engines: { node: '>=20' } })), ['R5-major-dep']);
  assert.deepEqual(pkgRules(pk({ engines: { node: '>=20' } }), pk({ engines: { node: '>=20.1' } })), []);
});

test('6 python: requirements/pyproject specifiers parse, and ==1.x -> ==2.x / widened >= are R5', () => {
  assert.deepEqual(parsePythonDeps('# c\nDjango==4.2.1\nrequests[security]>=2.0,<3  # pin\n-r base.txt\nflask\n'), { django: '==4.2.1', requests: '>=2.0,<3' });
  assert.deepEqual(parsePythonDeps('[project]\nname = "me"\ndependencies = [\n  "httpx>=0.27",\n  "pydantic[email]==2.5.0",\n]\n[tool.poetry.dependencies]\npython = "^3.10"\nfastapi = "^0.110"\nuvicorn = { version = "^0.29", extras = ["standard"] }\n'),
    { httpx: '>=0.27', pydantic: '==2.5.0', python: '^3.10', fastapi: '^0.110', uvicorn: '^0.29' });
  const py = (b, h) => rulesOf(run([file('requirements.txt')], { pkgPairs: [{ file: 'requirements.txt', kind: 'flat', base: b, head: h }] }));
  assert.deepEqual(py({ django: '==1.11' }, { django: '==2.0' }), ['R5-major-dep']);
  assert.deepEqual(py({ django: '==1.11' }, { django: '>=1.11' }), ['R5-major-dep']);
  assert.deepEqual(py({ django: '==1.11' }, { django: '==1.12' }), []);
  assert.deepEqual(py({ httpx: '>=0.27' }, { httpx: '>=0.28' }), ['R5-major-dep'], '0.x minor');
  assert.deepEqual(py({ a: '==1.0' }, { a: '==1.0', b: '==9.0' }), [], 'new deps are not hits');
});

test('6 IO: requirements.txt, pyproject.toml and a package.json structural change are read through git', async () => {
  const repo = branchRepo({
    'requirements.txt': 'django==1.11\nrequests==2.31.0\n',
    'services/api/pyproject.toml': '[project]\ndependencies = ["httpx>=0.27", "pydantic==2.5.0"]\n',
    'package.json': JSON.stringify(pk(), null, 2),
  });
  repo.write('requirements.txt', 'django==2.0\nrequests==2.32.0\n');
  repo.write('services/api/pyproject.toml', '[project]\ndependencies = ["httpx>=0.27", "pydantic>=2.5.0"]\n');
  repo.write('package.json', JSON.stringify(pk({ scripts: { dev: 'next dev', build: 'next build', test: 'true' } }), null, 2));
  repo.commit('bump');
  const hits = await collect(repo);
  assert.ok(hits.some((h) => h.rule === 'R5-major-dep' && h.file === 'requirements.txt' && /django/.test(h.detail)));
  assert.ok(!hits.some((h) => /requests/.test(h.detail)));
  assert.ok(hits.some((h) => h.rule === 'R5-major-dep' && h.file === 'services/api/pyproject.toml' && /pydantic/.test(h.detail)));
  assert.ok(hits.some((h) => h.rule === 'R4-pipeline' && h.file === 'package.json' && /scripts\.test/.test(h.detail)));
});

// ---- 7. more SQL -------------------------------------------------------------------------------------------------

test('7 SQL: each added statement shape is flagged', () => {
  const r2 = [
    'create or replace function public.can_see(uid uuid) returns boolean language sql stable as $$ select true $$;',
    'create function public.f() returns int language sql as $$ select 1 $$;',
    'create view public.pay_view as select * from public.employees;',
    "insert into storage.buckets (id, name, public) values ('payslips','payslips', true);",
    'update storage.buckets set public = true;',
    "create user reporter with password 'hunter2';", "alter user postgres password 'x';",
    'create trigger t after insert on auth.users for each row execute function public.h();',
    "insert into public.user_roles (user_id, role) values ('00000000-0000-0000-0000-000000000001','admin');",
    'alter publication supabase_realtime add table public.employees;',
    'alter table public.employees set schema archive;',
    'alter view v set (security_invoker = off);',
  ];
  for (const sql of r2) assert.ok(flags([A(MIG, sql)]).includes('R2-auth'), sql);
  const r1 = [
    'alter table public.employees alter name type varchar(5);', 'alter table t alter c set data type text;',
    'alter table t alter c drop not null;', 'update "My Long Table Name" set x = 1;', 'update public."My Table" u set x = 1;',
    "do $$ begin execute format('alter table %I disable row level security', 't'); end $$;",
  ];
  for (const sql of r1) assert.ok(flags([A(MIG, sql)]).includes('R1-destructive'), sql);
});

test('7 SQL: a view that sets security_invoker is not flagged by the view rule; EXECUTE FUNCTION / GRANT EXECUTE are not dynamic SQL', () => {
  assert.deepEqual(flags([A(MIG, 'create view v with (security_invoker = true) as select 1;')]), []);
  assert.deepEqual(flags([A(MIG, 'create trigger t before insert on public.notes for each row execute function public.h();')]), []);
  assert.ok(!flags([A(MIG, 'grant execute on function f() to authenticated;')]).includes('R1-destructive'));
  // The statement-level check sees a security_invoker option that sits on a later line of the same statement.
  assert.deepEqual(rulesOf(classify({
    files: [], config: cfg(), sqlStatements: [{ file: MIG, text: 'create view v\n  with (security_invoker = true)\n  as select 1;' }],
  })), []);
  assert.deepEqual(rulesOf(classify({
    files: [], config: cfg(), sqlStatements: [{ file: MIG, text: 'create view v\n  as select 1;' }],
  })), ['R2-sql-statement']);
});

test('7 SQL: a multi-line INSERT into a roles table with an admin value is caught at statement level', () => {
  const [stmt] = enclosingStatements("insert into public.user_roles\n  (user_id, role)\nvalues\n  ('u1', 'admin');\n", [3]);
  assert.deepEqual(rulesOf(classify({ files: [], config: cfg(), sqlStatements: [{ file: MIG, text: stmt }] })), ['R2-sql-statement']);
});

// ---- 8. auth paths and shapes ------------------------------------------------------------------------------------

test('8 auth path rules: session, jwt, login logic, any auth/oauth/authz segment; not author/authority or pure UI', () => {
  for (const p of ['lib/session.ts', 'lib/sessions/store.ts', 'lib/jwt.ts', 'lib/jwt/verify.ts', 'app/login/actions.ts', 'app/login/route.ts', 'app/signin/handler.ts', 'lib/oauth.ts', 'lib/authorize.ts', 'lib/useAuth.ts', 'app/(auth)/callback/x.ts', 'lib/authenticated.ts', 'lib/roles-map.ts', 'lib/rolesConfig.ts', 'lib/Roles/x.ts', 'middleware.tsx', 'src/middleware.mts', 'middleware.cts', 'middleware.jsx']) {
    assert.deepEqual(flags([file(p)]), ['R2-auth'], p);
  }
  for (const p of ['lib/author.ts', 'lib/authority.ts', 'lib/authors/list.ts', 'app/(public)/login/page.tsx', 'app/login/login-form.tsx', 'app/login/login.css', 'components/Author.tsx']) {
    assert.deepEqual(flags([file(p)]), [], p);
  }
});

test('8 a NEW server entry point (route handler, api page, edge function) is R2; editing an existing one is not', () => {
  for (const p of ['app/api/export/route.ts', 'src/app/api/x/y/route.js', 'app/(app)/health/route.ts', 'pages/api/hello.ts', 'supabase/functions/send/index.ts']) {
    const hits = run([A(p, 'export async function GET() {}')]);
    assert.ok(rulesOf(hits).includes('R2-auth'), p);
    assert.ok(hits.some((h) => /new server entry point/.test(h.detail)), p);
  }
  assert.deepEqual(flags([file('app/api/export/route.ts', { added: ['export async function GET() {}'] })]), []);
});

test("8 'use server' added to a file (new or existing) is R2", () => {
  assert.ok(flags([A('app/actions/danger.ts', "'use server';", 'export async function wipe() {}')]).includes('R2-auth'));
  assert.ok(flags([file('app/actions/x.ts', { added: ['  "use server";'] })]).includes('R2-auth'));
  assert.deepEqual(flags([file('app/actions/x.ts', { added: ['// the use server directive'] })]), []);
});

test('8 role literals and insecure cookies', () => {
  for (const text of ["await sb.from('profiles').update({ role: 'admin' });", 'const u = { userRole: "owner" };', "role = 'superadmin'", 'cookies().set(n, v, { httpOnly: false })', 'cookie: { secure: false }']) {
    assert.ok(flags([file('lib/x.ts', { added: [text] })]).includes('R2-auth'), text);
  }
  assert.deepEqual(flags([file('lib/x.ts', { added: ["role: 'viewer'", 'httpOnly: true', '// role: "admin" in the docs'] })]), []);
});

// ---- 9. sensitive data in content ---------------------------------------------------------------------------------

test('9 R6 content: sensitive terms in added production code (word-bounded; _ and camelCase separate words)', () => {
  for (const text of [
    'await sb.from("payroll_entries").select("*")', 'const payslip = build(emp);', 'SELECT salary FROM t', 'getPayroll()', 'salaryHistory',
    'alter table e add column sss_number text', 'const tin_number = x', 'biometric.enroll()', 'face_embedding vector', 'fingerprint_template',
    'bank_account text', 'const iban = x', 'routing_number', 'diagnosis', 'patient_id uuid', 'medical_record', 'philhealth', 'pag-ibig',
  ]) {
    assert.deepEqual(flags([file('lib/x.ts', { added: [text] })]), ['R6-sensitive'], text);
  }
  for (const text of ['const Liberian = 1;', 'diagnostics.log()', 'const salaryless = 0;', 'payrolling', '// payroll notes', ' * salary docs']) {
    assert.deepEqual(flags([file('lib/x.ts', { added: [text] })]), [], text);
  }
});

test('9 R6 content: tests and docs are exempt; SQL files are not; the hit carries the line', () => {
  assert.deepEqual(flags([file('lib/x.test.ts', { added: ['payroll()'] })]), []);
  assert.deepEqual(flags([file('docs/x.md', { added: ['payroll'] })]), []);
  const hits = run([A('supabase/migrations/9_a.sql', 'create table t (id int);', 'alter table t add column gov_id text, add column sss_number text;')]);
  assert.deepEqual(rulesOf(hits), ['R6-sensitive']);
  assert.equal(hits[0].line, 2);
});

test('9 R6 paths: face / bank are word-bounded', () => {
  for (const p of ['lib/face/enroll.ts', 'lib/faceEmbedding.ts', 'lib/faces.ts', 'lib/face-capture.ts', 'lib/bank/import.ts', 'lib/banking.ts', 'lib/bank-transfer.ts', 'lib/fingerprint/reader.ts', 'lib/selfie-capture.ts']) {
    assert.deepEqual(flags([file(p)]), ['R6-sensitive'], p);
  }
  for (const p of ['lib/interface.ts', 'lib/surface.ts', 'lib/typeface.ts', 'lib/bankruptcy.ts', 'lib/facet.ts']) assert.deepEqual(flags([file(p)]), [], p);
});

// ---- 10. paths -----------------------------------------------------------------------------------------------------

test('10 more config / credential / verify paths', () => {
  const expect = {
    'next.config.ts': 'R4-pipeline', 'next.config.mjs': 'R4-pipeline', 'apps/web/vite.config.ts': 'R4-pipeline', 'tsconfig.json': 'R4-pipeline',
    'tsconfig.build.json': 'R4-pipeline', 'packages/x/tsconfig.base.json': 'R4-pipeline', 'scripts/verify-quick.mjs': 'R4-pipeline',
    'scripts/verify/index.mjs': 'R4-pipeline', 'scripts/verify-all': 'R4-pipeline', '.envrc': 'R3-secrets', '.env-local': 'R3-secrets',
    'config/credentials.json': 'R3-secrets', 'credentials.prod.json': 'R3-secrets', 'config/service-account.json': 'R3-secrets',
    'gcp/service-account-key.json': 'R3-secrets', 'NEXT.CONFIG.TS': 'R4-pipeline',
  };
  for (const [p, rule] of Object.entries(expect)) assert.ok(flags([file(p)]).includes(rule), p);
});

test('10 pgTAP tests: deleting or moving one is R4; editing one is not (content rules skip tests)', () => {
  assert.ok(flags([file('supabase/tests/rls.test.sql', { status: 'D' })]).includes('R4-pipeline'));
  assert.ok(flags([file('supabase/tests/b.sql', { status: 'R', oldPath: 'supabase/tests/a.sql' })]).includes('R4-pipeline'));
  assert.deepEqual(flags([file('supabase/tests/rls.test.sql', { added: ['select ok(true);'] })]), []);
});

// ---- 11. false positives that were removed -----------------------------------------------------------------------

test('11 docs, markdown and test files are exempt from every content rule but key-shaped secrets', () => {
  const lines = [
    'service_role', 'createAdminClient()', 'DROP TABLE users;', 'GRANT ALL ON t TO anon;', 'process.env.BRAND_NEW', 'payroll', 'httpOnly: false',
    "role: 'admin'", "'use server'", 'supabase.auth.admin.deleteUser(1)', "sb.from('t').delete()",
  ];
  assert.deepEqual(flags([file('docs/setup.md', { added: [SECRETS['AWS access key id']] })]), ['R3-secrets']);
  for (const p of ['docs/setup.md', 'README.md', 'lib/x.test.ts', 'lib/x.spec.tsx', 'e2e/a.spec.ts', 'supabase/tests/rls.test.sql', 'lib/__tests__/a.ts']) {
    assert.deepEqual(flags([file(p, { added: lines })]), [], p);
  }
});

test('11 health endpoints and diagnostics are not sensitive data; pgTAP statements are not production SQL', () => {
  assert.deepEqual(flags([file('app/api/health/route.ts', { added: ['// bump'] })]), []);
  assert.deepEqual(flags([file('lib/diagnostics/logger.ts', { added: ['export const log = console.log;'] })]), []);
  const hits = classify({ files: [], config: cfg(), sqlStatements: [{ file: 'supabase/tests/rls.test.sql', text: 'set local role authenticated;' }] });
  assert.deepEqual(hits, []);
});

test('11 a markdown file under docs/migrations is not a migration', () => {
  for (const status of ['M', 'D']) assert.deepEqual(flags([file('docs/migrations/plan.md', { status, removed: ['x'] })]), [], status);
  assert.deepEqual(flags([file('docs/migrations/rollout.md', { status: 'R', oldPath: 'docs/migrations/plan.md' })]), []);
  assert.ok(flags([file('supabase/migrations/1_a.sql', { status: 'M' })]).includes('R1-migration-edited'));
});

test('11 R2-auth-removed ignores a deleted comment or bare string, not a deleted guard', () => {
  for (const text of [
    '// you can (and should) cache this', '  # requireRole(user) was here', '-- grant', ' * can (x) check', '/* getUser() */',
    "'Forbidden: you cannot (can) do this',", '"requireAuth()"', '`hasRole(x)`;',
  ]) {
    assert.deepEqual(flags([file('lib/x.ts', { removed: [text] })]), [], text);
  }
  for (const text of ['  requireRole(user);', 'const msg = requireAuth() && 1;', '#priv = requireAuth();']) {
    assert.deepEqual(flags([file('lib/x.ts', { removed: [text] })]), ['R2-auth-removed'], text);
  }
});

// ---- 13. ReDoS --------------------------------------------------------------------------------------------------------

test('13 a changed line over 20,000 chars skips every regex and flags the file; a 1 MB line is instant', () => {
  const big = 'alter table x '.repeat(75_000); // ~1 MB, no RENAME and no `;`: quadratic for a naive regex
  for (const f of [A(MIG, big), file('lib/a.ts', { removed: ['require'.padEnd(1_000_000, 'Auth')] }), A('public/vendor.min.js', 'function a(b){return b.require(c)}'.repeat(40_000))]) {
    const { value: hits, ms } = cpuMs(() => run([f]));
    assert.ok(ms < 1000, `took ${Math.round(ms)}ms of CPU`);
    assert.ok(rulesOf(hits).includes('R0-unscannable'), f.path);
  }
});

test('13 lines just under the cap with adversarial shapes stay fast for every rule family', () => {
  const shapes = [
    'alter table x '.repeat(1428), 'update a '.repeat(2200), 'on conflict (a) '.repeat(1200), 'create view v '.repeat(1400), 'insert into roles '.repeat(1100),
    'a'.repeat(19_999), '"'.repeat(19_999), "'".repeat(19_999), '{ a,'.repeat(5000), 'process.env'.repeat(1800), 'alter column c '.repeat(1300),
    'require'.padEnd(19_999, 'A'), '$a$ '.repeat(5000), '/*'.repeat(9000), 'grant '.repeat(3300),
  ];
  for (const text of shapes) {
    for (const f of [A(MIG, text), file('lib/a.ts', { added: [text], removed: [text] })]) {
      const { ms } = cpuMs(() => run([f]));
      assert.ok(ms < 1000, `${text.slice(0, 20)}... took ${Math.round(ms)}ms of CPU`);
    }
  }
});

test('13 a line stuffed with import specifiers stays fast (and is flagged as unreadable import list)', () => {
  const many = (n, f) => Array.from({ length: n }, (_, i) => f(i)).join(' ');
  for (const text of [many(1500, (i) => `from 'a${i}'`), many(600, (i) => `import('./x/y/z/w/v/u${i}')`), many(700, (i) => `require('a/b/c/d/e${i}');`)]) {
    const { value: hits, ms } = cpuMs(() => run([file('lib/a.ts', { added: [text] })]));
    assert.ok(ms < 500, `${text.slice(0, 20)}... took ${Math.round(ms)}ms of CPU`);
    assert.ok(rulesOf(hits).includes('R0-unscannable'), text.slice(0, 20));
  }
});

test('13 the whole-file import scan stays linear on a ~1.5 MB file of adversarial shapes', () => {
  // Linearity, not raw speed: CI's Node 20 runs these ~3x slower than a laptop, so an absolute budget flaked (2.1 s for the
  // backslash chain on ubuntu-latest). Doubling the input may at most ~double the CPU (ratio < 3; a quadratic shape gives ~4),
  // and a generous absolute ceiling still catches a pathological constant. Windows counts process CPU in ~15.6 ms ticks (15 ms ->
  // 47 ms once failed this test), so each sample repeats the scan enough times (calibrated on the high-resolution clock) to span
  // ~60 ms (4 ticks), and each size is the best of several samples (timing.mjs).
  const shapes = [[';from a import ', 100_000, 'a.py'], ['from' + ' ', 1_500_000, 'a.ts', true], ['require("', 190_000, 'a.ts'], [';import a, ', 100_000, 'a.py'], ['"""\n', 250_000, 'a.py'],
    ['from a import (\n', 90_000, 'a.py'], ['import a, \\\n', 120_000, 'a.py']];
  const once = (text, name) => run([file(`lib/${name}`, { added: ['x = 1'] })], { headFiles: new Map([[`lib/${name}`, text]]) });
  const cpu = (text, name, reps) => () => cpuMs(() => { for (let i = 0; i < reps; i++) once(text, name); }).ms;
  for (const [unit, n, name, padOnly] of shapes) {
    const make = (k) => (padOnly ? `from${' '.repeat(k)}` : unit.repeat(k));
    const halfText = make(n / 2), fullText = make(n);
    const t0 = performance.now();
    once(halfText, name);
    const reps = Math.min(50, Math.max(1, Math.ceil(60 / Math.max(performance.now() - t0, 1))));
    const label = `${unit.slice(0, 16)}...`;
    const { hi } = assertLinear(cpu(halfText, name, reps), cpu(fullText, name, reps), { label });
    assert.ok(hi / reps < 8000, `${label} took ${Math.round(hi / reps)}ms of CPU`);
  }
});

test('13 an oversized SQL statement is unscannable instead of regex-scanned', () => {
  const { value: hits, ms } = cpuMs(() => classify({ files: [], config: cfg(), sqlStatements: [{ file: MIG, text: 'alter table x '.repeat(75_000) }] }));
  assert.ok(ms < 1000, `took ${Math.round(ms)}ms of CPU`);
  assert.deepEqual(rulesOf(hits), ['R0-unscannable']);
});

test('13 a normal 5000-line diff stays linear', () => {
  const lines = Array.from({ length: 5000 }, (_, i) => `export const v${i} = (a: number) => a + ${i}; // helper ${i}`);
  const sql = Array.from({ length: 5000 }, (_, i) => `insert into public.t${i % 10} (a, b) values (${i}, 'row ${i}');`);
  const { ms } = cpuMs(() => run([A('lib/big.ts', ...lines), A(MIG, ...sql)], { sqlStatements: [] }));
  assert.ok(ms < 2000, `took ${Math.round(ms)}ms of CPU`);
});

// ---- 14. the pure classifier cannot silently lose coverage ----------------------------------------------------

test('14 classifyHardStops throws when the diff has SQL or package.json and the matching inputs are missing', () => {
  const sqlFile = file(MIG, { status: 'A', added: ['select 1;'] });
  assert.throws(() => classifyHardStops({ files: [sqlFile], config: cfg(), pkgPairs: [] }), /sqlStatements/);
  assert.doesNotThrow(() => classifyHardStops({ files: [sqlFile], config: cfg(), sqlStatements: [] }));
  const pkgFile = file('package.json', { added: ['  "x": 1'] });
  assert.throws(() => classifyHardStops({ files: [pkgFile], config: cfg(), sqlStatements: [] }), /package\.json/);
  assert.throws(() => classifyHardStops({ files: [file('apps/web/package.json')], config: cfg(), sqlStatements: [], pkgPairs: [{ file: 'package.json', base: {}, head: {} }] }), /apps\/web\/package\.json/);
  assert.doesNotThrow(() => classifyHardStops({ files: [pkgFile], config: cfg(), sqlStatements: [], basePkg: {}, headPkg: {} }));
  assert.doesNotThrow(() => classifyHardStops({ files: [file('apps/web/package.json')], config: cfg(), sqlStatements: [], pkgPairs: [{ file: 'apps/web/package.json', base: {}, head: {} }] }));
  // No SQL / package.json in the diff: nothing extra is required.
  assert.doesNotThrow(() => classifyHardStops({ files: [file('lib/a.ts', { added: ['x'] })], config: cfg() }));
  // A SQL file with no changed lines (pure rename / mode change) has nothing to scan.
  assert.doesNotThrow(() => classifyHardStops({ files: [file(MIG, { status: 'R', oldPath: 'supabase/migrations/0_x.sql' })], config: cfg() }));
});
