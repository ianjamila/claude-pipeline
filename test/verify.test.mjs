// Tests for the generic verify runner template (scripts/verify.mjs). In-process tests import the template as a project
// would have it (copied to scripts/verify.mjs beside the vendored scripts/pipeline/lib) and pass their own steps; the CLI
// tests patch the STEPS block the way pipeline-setup's per-project edit does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { project, runNode, scratchDir, importVendored } from './helpers/project.mjs';

const template = join(dirname(fileURLToPath(import.meta.url)), '..', 'pipeline', 'templates', 'scripts', 'verify.mjs');
const PROBE = `import { inspect } from './pipeline/lib/locks.mjs';
import { writeFileSync } from 'node:fs';
writeFileSync(process.argv[2], JSON.stringify(inspect('db-demo-app', { dir: process.env.LOCK_DIR })));
`;
const nodeCmd = (js) => `node -e "${js}"`;
const touch = (name) => nodeCmd(`require('fs').writeFileSync('${name}','1')`);
const sink = () => { const lines = []; return { write: (s) => { lines.push(s); return true; }, text: () => lines.join('') }; };

// A repo with scripts/verify.mjs (the unmodified template) and a probe script, committed on top of the project base.
async function setup(projectOpts) {
  const repo = await project(projectOpts);
  copyFileSync(template, join(repo.dir, 'scripts', 'verify.mjs'));
  repo.write('scripts/probe.mjs', PROBE);
  repo.commit('verify runner');
  repo.lockDir = scratchDir();
  return repo;
}
const load = (repo) => import(pathToFileURL(join(repo.dir, 'scripts', 'verify.mjs')).href);
const reportOf = (repo) => JSON.parse(readFileSync(join(repo.dir, '.verify', 'report.json'), 'utf8'));
async function verify(repo, argv, steps, extra = {}) {
  const { runVerify } = await load(repo);
  const out = sink();
  const err = sink();
  const r = await runVerify({ argv, cwd: repo.dir, steps, lockDir: repo.lockDir, out, err, ...extra });
  return { ...r, out: out.text(), err: err.text() };
}
const pass = (name, extra = {}) => ({ name, cmd: nodeCmd('process.exit(0)'), quick: false, ...extra });

test('fail-fast: the failing step stops the run, later steps are not-run, and the report says why', async () => {
  const repo = await setup();
  const steps = [
    pass('one', { quick: true }),
    { name: 'two', cmd: nodeCmd("console.error('boom happened');process.exit(3)"), quick: true },
    { name: 'three', cmd: touch('ran-three'), quick: true },
  ];
  const r = await verify(repo, [], steps);
  assert.equal(r.exitCode, 1);
  assert.ok(!existsSync(join(repo.dir, 'ran-three')), 'a later step must not run');
  const rep = reportOf(repo);
  assert.equal(rep.version, 1);
  assert.equal(rep.mode, 'full');
  assert.equal(rep.ok, false);
  assert.deepEqual(rep.expectedSteps, ['one', 'two', 'three']);
  assert.deepEqual(rep.steps.map((s) => [s.name, s.status]), [['one', 'pass'], ['two', 'fail'], ['three', 'not-run']]);
  assert.equal(rep.steps[1].exitCode, 3);
  assert.match(rep.steps[1].errorExcerpt, /boom happened/);
  assert.equal(rep.steps[1].command, steps[1].cmd);
  assert.ok(Number.isInteger(rep.steps[0].durationMs) && rep.steps[0].durationMs >= 0);
  assert.deepEqual([rep.steps[2].exitCode, rep.steps[2].errorExcerpt, rep.steps[2].durationMs], [null, '', 0]);
  assert.ok(Date.parse(rep.startedAt) <= Date.parse(rep.finishedAt));
  assert.match(r.out, /\[FAIL\] two \(exit 3/);
  assert.match(r.out, /verify \(full\): FAIL at two - 1\/3 steps passed/);
});

test('logs: each step that ran has its combined output in .verify/logs/<step>.log; stale logs are cleared', async () => {
  const repo = await setup();
  mkdirSync(join(repo.dir, '.verify', 'logs'), { recursive: true });
  writeFileSync(join(repo.dir, '.verify', 'logs', 'three.log'), 'STALE from an earlier run');
  const steps = [
    { name: 'one', cmd: nodeCmd("console.log('out-line');console.error('err-line')"), quick: false },
    { name: 'two', cmd: nodeCmd('process.exit(1)'), quick: false },
    { name: 'three', cmd: nodeCmd('process.exit(0)'), quick: false },
  ];
  await verify(repo, [], steps);
  const log = readFileSync(join(repo.dir, '.verify', 'logs', 'one.log'), 'utf8');
  assert.match(log, /out-line/);
  assert.match(log, /err-line/);
  assert.deepEqual(readdirSync(join(repo.dir, '.verify', 'logs')).sort(), ['one.log', 'two.log']);
});

test('a passing run exits 0 with ok:true and every step passed', async () => {
  const repo = await setup();
  const r = await verify(repo, [], [pass('a'), pass('b')]);
  assert.equal(r.exitCode, 0);
  const rep = reportOf(repo);
  assert.equal(rep.ok, true);
  assert.deepEqual(rep.steps.map((s) => s.status), ['pass', 'pass']);
  assert.ok(!('error' in rep));
  assert.deepEqual(readdirSync(join(repo.dir, '.verify')).filter((n) => n.includes('.tmp-')), [], 'report is renamed into place');
});

test('--quick runs only quick steps, using quickCmd when given, and reports mode quick', async () => {
  const repo = await setup();
  const steps = [
    { name: 'install', cmd: touch('ran-install'), quick: false },
    { name: 'types', cmd: touch('ran-full-types'), quick: true, quickCmd: touch('ran-quick-types') },
    { name: 'lint', cmd: touch('ran-lint'), quick: true },
    { name: 'build', cmd: touch('ran-build'), quick: false },
  ];
  const r = await verify(repo, ['--quick'], steps);
  assert.equal(r.exitCode, 0);
  const rep = reportOf(repo);
  assert.equal(rep.mode, 'quick');
  assert.deepEqual(rep.expectedSteps, ['types', 'lint']);
  assert.deepEqual(rep.steps.map((s) => s.command), [steps[1].quickCmd, steps[2].cmd]);
  for (const f of ['ran-quick-types', 'ran-lint']) assert.ok(existsSync(join(repo.dir, f)), f);
  for (const f of ['ran-install', 'ran-full-types', 'ran-build']) assert.ok(!existsSync(join(repo.dir, f)), f);
});

test('a full run ignores quickCmd', async () => {
  const repo = await setup();
  const steps = [{ name: 'types', cmd: touch('ran-full'), quick: true, quickCmd: touch('ran-quick') }];
  await verify(repo, [], steps);
  assert.ok(existsSync(join(repo.dir, 'ran-full')));
  assert.ok(!existsSync(join(repo.dir, 'ran-quick')));
});

test('--only runs just those steps (in STEPS order) and reports mode partial', async () => {
  const repo = await setup();
  const steps = [pass('a'), pass('b'), pass('c'), pass('d')];
  const r = await verify(repo, ['--only', 'd,b'], steps);
  assert.equal(r.exitCode, 0);
  const rep = reportOf(repo);
  assert.equal(rep.mode, 'partial');
  assert.deepEqual(rep.expectedSteps, ['b', 'd']);
  assert.deepEqual(rep.steps.map((s) => s.name), ['b', 'd']);
});

test('--only with an unknown step, or bad arguments, is a usage error (exit 2, no report)', async () => {
  const repo = await setup();
  const steps = [pass('a')];
  const unknown = await verify(repo, ['--only', 'a,nope'], steps);
  assert.equal(unknown.exitCode, 2);
  assert.match(unknown.err, /unknown step\(s\): nope\. Steps: a/);
  assert.equal((await verify(repo, ['--bogus'], steps)).exitCode, 2);
  assert.equal((await verify(repo, ['--only', ''], steps)).exitCode, 2);
  assert.equal((await verify(repo, ['--quick'], steps)).exitCode, 2, 'no step is quick: nothing to run is an error, not a pass');
  assert.ok(!existsSync(join(repo.dir, '.verify', 'report.json')));
});

test('--list prints the steps without running or reporting anything', async () => {
  const repo = await setup();
  const r = await verify(repo, ['--list'], [{ name: 'a', cmd: touch('ran-a'), quick: true, quickCmd: 'echo q' }, pass('b', { lockGroup: 'db' })]);
  assert.equal(r.exitCode, 0);
  assert.match(r.out, /^a\s+quick\s+.*ran-a.*\(quick: echo q\)$/m);
  assert.match(r.out, /^b\s+lock:db/m);
  assert.ok(!existsSync(join(repo.dir, 'ran-a')));
  assert.ok(!existsSync(join(repo.dir, '.verify', 'report.json')));
});

test('invalid step definitions are rejected up front', async () => {
  const repo = await setup();
  assert.equal((await verify(repo, [], [pass('a'), pass('a')])).exitCode, 2);
  assert.equal((await verify(repo, [], [pass('bad name!')])).exitCode, 2);
  assert.equal((await verify(repo, [], [{ name: 'x', cmd: '' }])).exitCode, 2);
  assert.equal((await verify(repo, [], [])).exitCode, 2);
  assert.equal((await verify(repo, [], [pass('a', { lockGroup: 'no spaces' })])).exitCode, 2);
});

test('consecutive lockGroup steps hold ONE lock across both; other steps and later groups do not share it', async () => {
  const repo = await setup();
  const env = { LOCK_DIR: repo.lockDir };
  const probe = (name, group) => ({ name, cmd: `node scripts/probe.mjs seen-${name}.json`, quick: false, env, ...(group ? { lockGroup: group } : {}) });
  const steps = [probe('pre'), probe('dba', 'db'), probe('dbb', 'db'), probe('mid'), probe('dbc', 'db')];
  const r = await verify(repo, [], steps);
  assert.equal(r.exitCode, 0, r.err + r.out);
  const seen = Object.fromEntries(['pre', 'dba', 'dbb', 'mid', 'dbc'].map((n) => [n, JSON.parse(readFileSync(join(repo.dir, `seen-${n}.json`), 'utf8'))]));
  assert.equal(seen.pre, null, 'no lock before the group');
  assert.equal(seen.mid, null, 'no lock between groups');
  assert.equal(seen.dba.name, 'db-demo-app', 'named <group>-<project>');
  assert.equal(seen.dba.pid, process.pid, 'held by the verify process');
  assert.equal(seen.dbb.runId, seen.dba.runId, 'the second step is under the SAME lock acquisition');
  assert.notEqual(seen.dbc.runId, seen.dba.runId, 'a later, separate group re-acquires');
  const { inspect } = await import(pathToFileURL(join(repo.dir, 'scripts', 'pipeline', 'lib', 'locks.mjs')).href);
  assert.equal(inspect('db-demo-app', { dir: repo.lockDir }), null, 'released at the end');
});

test('the lock is released when a step in the group fails', async () => {
  const repo = await setup();
  const steps = [pass('a', { lockGroup: 'db' }), { name: 'b', cmd: nodeCmd('process.exit(1)'), quick: false, lockGroup: 'db' }, pass('c', { lockGroup: 'db' })];
  const r = await verify(repo, [], steps);
  assert.equal(r.exitCode, 1);
  assert.deepEqual(reportOf(repo).steps.map((s) => s.status), ['pass', 'fail', 'not-run']);
  const { inspect } = await import(pathToFileURL(join(repo.dir, 'scripts', 'pipeline', 'lib', 'locks.mjs')).href);
  assert.equal(inspect('db-demo-app', { dir: repo.lockDir }), null);
});

test('a lock held by someone else fails the group instead of running unprotected', async () => {
  const repo = await setup();
  const { acquire, release, inspect } = await import(pathToFileURL(join(repo.dir, 'scripts', 'pipeline', 'lib', 'locks.mjs')).href);
  const held = await acquire('db-demo-app', { dir: repo.lockDir, waitMs: 0 });
  try {
    const steps = [pass('before'), { name: 'db', cmd: touch('ran-db'), quick: false, lockGroup: 'db' }, pass('after', { lockGroup: 'db' })];
    const r = await verify(repo, [], steps, { lockWaitMs: 300 });
    assert.equal(r.exitCode, 1);
    assert.ok(!existsSync(join(repo.dir, 'ran-db')), 'the protected step must not run');
    const rep = reportOf(repo);
    assert.deepEqual(rep.steps.map((s) => s.status), ['pass', 'fail', 'not-run']);
    assert.match(rep.steps[1].errorExcerpt, /timed out .* waiting for lock "db-demo-app"/);
    assert.match(r.err, /waiting for lock db-demo-app held by pid/);
    assert.equal(inspect('db-demo-app', { dir: repo.lockDir }).runId, held.runId, 'the other holder keeps its lock');
  } finally {
    release(held);
  }
});

test('the report binds to the tree at START: head, dirty, merge-base and tree fingerprint', async () => {
  const repo = await setup();
  const { treeFingerprint } = await import(pathToFileURL(join(repo.dir, 'scripts', 'pipeline', 'lib', 'git.mjs')).href);
  const head = repo.git(['rev-parse', 'HEAD']).trim();
  const expected = treeFingerprint({ cwd: repo.dir });
  // The step edits a tracked file: the report must still carry the tree from before it ran.
  const steps = [{ name: 'edit', cmd: nodeCmd("require('fs').appendFileSync('src/app.js','// changed by a step\\\\n')"), quick: false }];
  await verify(repo, [], steps);
  const g = reportOf(repo).git;
  assert.equal(g.head, head);
  assert.equal(g.tree, expected);
  assert.notEqual(treeFingerprint({ cwd: repo.dir }), expected, 'the tree really did change during the run');
  assert.equal(g.dirty, false, 'dirty describes the start too');
  assert.equal(g.base, null, 'no origin/main in a repo without a remote');
  assert.equal(g.mergeBase, null);
});

test('base and mergeBase come from origin/<default_branch>; dirty is true with uncommitted changes', async () => {
  const repo = await setup();
  const base = repo.git(['rev-parse', 'HEAD']).trim();
  repo.git(['update-ref', 'refs/remotes/origin/main', base]);
  repo.branch('feature');
  repo.write('src/new.js', 'x\n');
  repo.commit('feature work');
  repo.write('src/dirty.js', 'y\n');
  await verify(repo, [], [pass('a')]);
  const g = reportOf(repo).git;
  assert.equal(g.base, base);
  assert.equal(g.mergeBase, base);
  assert.equal(g.head, repo.git(['rev-parse', 'HEAD']).trim());
  assert.equal(g.dirty, true);
  assert.match(g.tree, /^[0-9a-f]{64}$/);
});

test('outside a git repository the git fields are null instead of failing the run', async () => {
  const repo = await setup();
  const { runVerify } = await load(repo);
  const dir = scratchDir();
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  const r = await runVerify({ argv: [], cwd: dir, steps: [pass('a')], lockDir: repo.lockDir, out: sink(), err: sink() });
  assert.equal(r.exitCode, 0);
  assert.deepEqual(r.report.git, { head: null, base: null, mergeBase: null, dirty: null, tree: null });
});

const REMOTE_DB = 'postgresql://postgres:s3cr3t-pass@db.abcdefgh.supabase.co:5432/postgres';
for (const [name, value] of [
  ['DATABASE_URL', REMOTE_DB],
  ['NEXT_PUBLIC_SUPABASE_URL', 'https://abcdefgh.supabase.co'],
  ['SUPABASE_URL', 'https://abcdefgh.supabase.co'],
  ['DATABASE_URL', 'not a url at all'],
]) {
  test(`refuses (exit 2, report ok:false, nothing runs) when ${name} is ${value.slice(0, 24)}...`, async () => {
    const repo = await setup();
    const steps = [{ name: 'a', cmd: touch('ran-a'), quick: false }, pass('b')];
    const r = await verify(repo, [], steps, { env: { ...process.env, [name]: value } });
    assert.equal(r.exitCode, 2);
    assert.ok(!existsSync(join(repo.dir, 'ran-a')), 'no step may run');
    const rep = reportOf(repo);
    assert.equal(rep.ok, false);
    assert.deepEqual(rep.steps.map((s) => s.status), ['not-run', 'not-run']);
    assert.match(rep.error, new RegExp(`^refusing to run: ${name} points at non-local host`));
    assert.doesNotMatch(JSON.stringify(rep) + r.err + r.out, /s3cr3t-pass/, 'a password never reaches the report or the console');
  });
}

// libpq honours host=/hostaddr= over the URL's own host, and every common Postgres variable counts, not just three.
for (const [name, value] of [
  ['DATABASE_URL', 'postgresql://localhost/db?host=db.prod.supabase.co'],
  ['DATABASE_URL', 'postgresql://localhost/db?hostaddr=203.0.113.9'],
  ['DATABASE_URL', 'postgresql://localhost:5432,db.prod.supabase.co:5432/db'],
  ['DATABASE_URL', 'host=db.prod.supabase.co dbname=postgres user=u'],
  ['DATABASE_URL', "hostaddr='203.0.113.9' dbname=postgres"],
  ['POSTGRES_URL', REMOTE_DB],
  ['POSTGRES_URL_NON_POOLING', REMOTE_DB],
  ['POSTGRES_PRISMA_URL', REMOTE_DB],
  ['DIRECT_URL', REMOTE_DB],
  ['SUPABASE_DB_URL', REMOTE_DB],
  ['PGHOST', 'db.prod.supabase.co'],
  ['PGHOST', 'localhost,db.prod.supabase.co'],
  ['PGHOSTADDR', '203.0.113.9'],
]) {
  test(`refuses ${name}=${value.slice(0, 40)}`, async () => {
    const repo = await setup();
    const r = await verify(repo, [], [{ name: 'a', cmd: touch('ran-a'), quick: false }], { env: { ...process.env, [name]: value } });
    assert.equal(r.exitCode, 2);
    assert.ok(!existsSync(join(repo.dir, 'ran-a')));
    assert.match(reportOf(repo).error, new RegExp(`^refusing to run: ${name} points at non-local host`));
    assert.doesNotMatch(JSON.stringify(reportOf(repo)) + r.err, /s3cr3t-pass/);
  });
}

test('local variants of those variables are accepted (socket directories, localhost lists, host= pointing at localhost)', async () => {
  const repo = await setup();
  for (const [name, value] of [
    ['DATABASE_URL', 'postgresql://postgres@localhost/db?host=127.0.0.1'],
    ['DATABASE_URL', 'postgresql:///db?host=/var/run/postgresql'],
    ['DATABASE_URL', 'host=localhost dbname=postgres'],
    ['DATABASE_URL', 'dbname=postgres user=u'],
    ['PGHOST', 'localhost'],
    ['PGHOST', '/var/run/postgresql'],
    ['PGHOST', '127.0.0.1,::1'],
    ['PGHOSTADDR', '127.0.0.1'],
    ['POSTGRES_URL', 'postgresql://postgres:postgres@127.0.0.1:55322/postgres'],
  ]) {
    const r = await verify(repo, [], [pass('a')], { env: { ...process.env, [name]: value } });
    assert.equal(r.exitCode, 0, `${name}=${value}: ${r.err}`);
  }
});

// The repo's own .env files reach the db steps even when the shell never exported the variable.
for (const file of ['.env', '.env.local', '.env.test', '.env.development', '.env.test.local', '.env.development.local']) {
  test(`refuses a remote database URL in ${file} (exit 2, file named, password not echoed)`, async () => {
    const repo = await setup({ files: { [file]: `# comment\nFOO=bar\nexport DATABASE_URL="${REMOTE_DB}"\n` } });
    const r = await verify(repo, [], [{ name: 'a', cmd: touch('ran-a'), quick: false }], { env: { ...process.env, DATABASE_URL: undefined } });
    assert.equal(r.exitCode, 2, r.err);
    assert.ok(!existsSync(join(repo.dir, 'ran-a')));
    const error = reportOf(repo).error;
    assert.ok(error.includes(`DATABASE_URL points at non-local host "db.abcdefgh.supabase.co" (in ${file})`), error);
    assert.doesNotMatch(JSON.stringify(reportOf(repo)) + r.err + r.out, /s3cr3t-pass/);
  });
}

test('.env files: local values pass, quotes/comments/export are understood, and a process value (or step env) that sets the variable wins over the file', async () => {
  const local = await setup({ files: { '.env.local': "DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55322/postgres' # local\nSUPABASE_URL=http://localhost:55321\n", '.env.test': 'PGHOST=localhost\n' } });
  assert.equal((await verify(local, [], [pass('a')], { env: { ...process.env, DATABASE_URL: undefined } })).exitCode, 0);

  const remoteFile = await setup({ files: { '.env.local': `DATABASE_URL=${REMOTE_DB}\nPOSTGRES_URL=${REMOTE_DB}\n` } });
  const shadowed = await verify(remoteFile, [], [pass('a')], {
    env: { ...process.env, DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:55322/postgres', POSTGRES_URL: 'postgresql://postgres:postgres@127.0.0.1:55322/postgres' },
  });
  assert.equal(shadowed.exitCode, 0, shadowed.err);
  const viaStepEnv = await verify(remoteFile, [], [pass('a', { env: () => ({ DATABASE_URL: 'http://127.0.0.1:1', POSTGRES_URL: 'http://127.0.0.1:1' }) })], { env: { ...process.env, DATABASE_URL: undefined, POSTGRES_URL: undefined } });
  assert.equal(viaStepEnv.exitCode, 0, viaStepEnv.err);
  const partial = await verify(remoteFile, [], [pass('a')], { env: { ...process.env, DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:55322/postgres', POSTGRES_URL: undefined } });
  assert.equal(partial.exitCode, 2, 'POSTGRES_URL is still only defined by the remote file');
  assert.match(reportOf(remoteFile).error, /POSTGRES_URL points at non-local host/);
});

test('local database URLs are accepted', async () => {
  const repo = await setup();
  const env = {
    ...process.env,
    NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:55321',
    SUPABASE_URL: 'http://localhost:55321',
    DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:55322/postgres',
  };
  assert.equal((await verify(repo, [], [pass('a')], { env })).exitCode, 0);
  assert.equal((await verify(repo, [], [pass('a')], { env: { ...env, DATABASE_URL: 'postgresql://postgres:postgres@[::1]:55322/postgres' } })).exitCode, 0);
  assert.equal((await verify(repo, [], [pass('a')], { env: { ...env, DATABASE_URL: '' } })).exitCode, 0, 'empty = unset');
});

test('refuses when a step\'s own env points at a remote database', async () => {
  const repo = await setup();
  const steps = [
    { name: 'first', cmd: touch('ran-first'), quick: false },
    { name: 'a', cmd: touch('ran-a'), quick: false, env: { DATABASE_URL: REMOTE_DB } },
  ];
  const r = await verify(repo, [], steps);
  assert.equal(r.exitCode, 2);
  assert.ok(!existsSync(join(repo.dir, 'ran-first')), 'refused before ANY step runs, not just before the offending one');
  assert.ok(!existsSync(join(repo.dir, 'ran-a')));
  assert.match(reportOf(repo).error, /DATABASE_URL points at non-local host "db\.abcdefgh\.supabase\.co" \(in step a's env\)/);
});

test('an env function that resolves to a remote database stops the run before that step', async () => {
  const repo = await setup();
  const steps = [pass('first'), { name: 'second', cmd: touch('ran-second'), quick: false, env: () => ({ SUPABASE_URL: 'https://x.supabase.co' }) }];
  const r = await verify(repo, [], steps);
  assert.equal(r.exitCode, 2);
  assert.ok(!existsSync(join(repo.dir, 'ran-second')));
  assert.deepEqual(reportOf(repo).steps.map((s) => s.status), ['pass', 'not-run']);
  assert.equal(reportOf(repo).ok, false);
});

test('an env function that throws is an internal error (exit 2) and the report says so', async () => {
  const repo = await setup();
  const r = await verify(repo, [], [{ name: 'a', cmd: touch('ran-a'), quick: false, env: () => { throw new Error('supabase is down'); } }]);
  assert.equal(r.exitCode, 2);
  assert.match(reportOf(repo).error, /^internal error: supabase is down/);
});

test('step env (object or function) reaches the step', async () => {
  const repo = await setup();
  const check = (v) => nodeCmd(`process.exit(process.env.FOO==='${v}'?0:1)`);
  const steps = [
    { name: 'object', cmd: check('bar'), quick: false, env: { FOO: 'bar' } },
    { name: 'func', cmd: check('baz'), quick: false, env: async () => ({ FOO: 'baz' }) },
  ];
  assert.equal((await verify(repo, [], steps)).exitCode, 0);
});

test('errorExcerpt is the last 40 lines with ANSI codes and progress redraws removed', async () => {
  const repo = await setup();
  // No backslashes in the snippet: bash turns \\ into \ inside double quotes but cmd.exe passes both through to node.
  const js = "const E=String.fromCharCode(27),R=String.fromCharCode(13),N=String.fromCharCode(10);for(let i=1;i<=100;i++)console.log(E+'[31mline '+i+E+'[0m');process.stdout.write('10%'+R+'50%'+R+'100% done'+N);process.stderr.write(E+'[1;31mFATAL'+E+'[0m'+N);process.exit(1)";
  await verify(repo, [], [{ name: 'noisy', cmd: nodeCmd(js), quick: false }]);
  const ex = reportOf(repo).steps[0].errorExcerpt;
  assert.doesNotMatch(ex, /\x1b|\[31m|\[0m/);
  const lines = ex.split('\n');
  assert.equal(lines.length, 40);
  assert.equal(lines[lines.length - 1], 'FATAL');
  assert.equal(lines[lines.length - 2], '100% done', 'a progress bar shows only its final state');
  assert.equal(lines[0], 'line 63');
  assert.ok(readFileSync(join(repo.dir, '.verify', 'logs', 'noisy.log'), 'utf8').includes('\x1b[31mline 1\x1b[0m'), 'the log itself is kept raw');
});

test('excerpt(): trailing blank lines are dropped and short output is returned whole', async () => {
  const { excerpt } = await load(await setup());
  assert.equal(excerpt('a\nb\n\n\n'), 'a\nb');
  assert.equal(excerpt(''), '');
  assert.equal(excerpt('x\r\ny\r\n'), 'x\ny');
  assert.equal(excerpt('1\n2\n3\n4', 2), '3\n4');
});

test('a step that exceeds its timeout fails with a timed-out excerpt', async () => {
  const repo = await setup();
  const steps = [{ name: 'hang', cmd: nodeCmd('setTimeout(()=>{},60000)'), quick: false, timeoutMs: 400 }, pass('after')];
  const r = await verify(repo, [], steps);
  assert.equal(r.exitCode, 1);
  const rep = reportOf(repo);
  assert.equal(rep.steps[0].status, 'fail');
  assert.match(rep.steps[0].errorExcerpt, /^\[timed out after 400ms\]/);
  assert.equal(rep.steps[1].status, 'not-run');
});

test('an unusable pipeline.yml does not stop verify: it warns and uses the default report path', async () => {
  const repo = await setup({ config: 'version: 1\nproject: x\nbogus_key: 1\n' });
  const r = await verify(repo, [], [pass('a')]);
  assert.equal(r.exitCode, 0);
  assert.match(r.err, /ignoring unusable \.claude\/pipeline\.yml/);
  assert.equal(reportOf(repo).ok, true);
});

test('the report goes where pipeline.yml says (verify.report)', async () => {
  const repo = await setup({ config: 'version: 1\nproject: demo-app\nverify:\n  full: a\n  quick: b\n  report: out/verify.json\n' });
  await verify(repo, [], [pass('a')]);
  assert.equal(JSON.parse(readFileSync(join(repo.dir, 'out', 'verify.json'), 'utf8')).ok, true);
});

// ---- the CLI, with STEPS patched the way pipeline-setup's per-project edit does ----------------------------------

function patchSteps(repo, stepsSource) {
  const text = readFileSync(join(repo.dir, 'scripts', 'verify.mjs'), 'utf8');
  const a = text.indexOf('// ---- EDIT THIS');
  const b = text.indexOf('// ---- end of the project-specific part');
  assert.ok(a > 0 && b > a, 'the template keeps its EDIT markers');
  writeFileSync(join(repo.dir, 'scripts', 'verify.mjs'), `${text.slice(0, a)}const STEPS = ${stepsSource};\n${text.slice(b)}`);
}
const cli = (repo, args) => runNode(['scripts/verify.mjs', ...args], { cwd: repo.dir, env: { HOME: repo.lockDir, USERPROFILE: repo.lockDir } });

test('CLI: exit codes, report location and progress output end to end', async () => {
  const repo = await setup();
  patchSteps(repo, `[
    { name: 'ok', cmd: 'node -e "process.exit(0)"', quick: true },
    { name: 'db', cmd: 'node -e "process.exit(0)"', quick: false, lockGroup: 'db' },
    { name: 'bad', cmd: 'node -e "console.error(\\'cli boom\\');process.exit(1)"', quick: false },
  ]`);
  const quick = await cli(repo, ['--quick']);
  assert.equal(quick.code, 0, quick.stderr);
  assert.equal(reportOf(repo).mode, 'quick');
  assert.match(quick.stdout, /\[pass\] ok/);

  const full = await cli(repo, []);
  assert.equal(full.code, 1);
  assert.match(full.stdout, /\[FAIL\] bad/);
  assert.match(full.stdout, /cli boom/);
  assert.deepEqual(reportOf(repo).steps.map((s) => s.status), ['pass', 'pass', 'fail']);
  assert.ok(existsSync(join(repo.lockDir, '.claude', 'pipeline-state', 'locks')), 'default lock dir lives under the home directory');

  const list = await cli(repo, ['--list']);
  assert.equal(list.code, 0);
  assert.match(list.stdout, /^db\s+/m);
  assert.equal((await cli(repo, ['--only', 'nope'])).code, 2);
});

test('CLI: refuses a remote DATABASE_URL from the real environment with exit 2', async () => {
  const repo = await setup();
  patchSteps(repo, `[{ name: 'a', cmd: 'node -e "process.exit(0)"', quick: false }]`);
  const r = await runNode(['scripts/verify.mjs'], { cwd: repo.dir, env: { DATABASE_URL: REMOTE_DB, HOME: repo.lockDir, USERPROFILE: repo.lockDir } });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /refusing to run/);
  assert.doesNotMatch(r.stdout + r.stderr, /s3cr3t-pass/);
  assert.equal(reportOf(repo).ok, false);
});

test('the template ships a documented example STEPS block and vendored imports only', () => {
  const text = readFileSync(template, 'utf8');
  assert.match(text, /^\/\/ Generic verify runner/);
  for (const name of ['install', 'typecheck', 'lint', 'unit', 'db', 'build', 'e2e']) assert.match(text, new RegExp(`name: '${name}'`));
  assert.match(text, /lockGroup: 'db'/);
  assert.match(text, /quickCmd:/);
  // Playwright only autoloads playwright.config.*: the smoke config has to be named, and its port comes from the env step.
  assert.match(text, /name: 'e2e', cmd: 'npx playwright test -c playwright\.smoke\.config\.ts --project=smoke'/);
  assert.match(readFileSync(join(dirname(template), '..', 'e2e', 'playwright.smoke.config.ts'), 'utf8'), /process\.env\.PIPELINE_SMOKE_PORT/);
  for (const m of text.matchAll(/from '(\.[^']+)'/g)) assert.match(m[1], /^\.\/pipeline\/lib\//, `${m[1]} must come from scripts/pipeline/lib`);
});

test('importVendored still resolves scripts/pipeline entries next to verify.mjs', async () => {
  const repo = await setup();
  const mod = await importVendored(repo.dir, 'supabase-local');
  assert.equal(typeof mod.ensureDedicatedInstance, 'function');
});

// ---- skipIf: a full run may skip a step for a stated reason ------------------------------------------------------------

test('skipIf: a positive answer skips the step in a full run; the row says skipped and why, and the run still passes', async () => {
  const repo = await setup();
  const seen = [];
  const steps = [
    pass('one'),
    { name: 'two', cmd: touch('ran-two'), quick: false, skipIf: (ctx) => { seen.push(ctx); return { run: false, reason: 'nothing under db/ changed', log: 'custom log line\n' }; } },
    { name: 'three', cmd: touch('ran-three'), quick: false },
  ];
  const r = await verify(repo, [], steps);
  assert.equal(r.exitCode, 0);
  assert.ok(!existsSync(join(repo.dir, 'ran-two')), 'a skipped step must not run');
  assert.ok(existsSync(join(repo.dir, 'ran-three')), 'later steps still run');
  const rep = reportOf(repo);
  assert.equal(rep.ok, true);
  assert.deepEqual(rep.steps.map((s) => s.status), ['pass', 'skipped', 'pass']);
  assert.equal(rep.steps[1].skipReason, 'nothing under db/ changed');
  assert.deepEqual([rep.steps[1].exitCode, rep.steps[1].errorExcerpt, rep.steps[1].durationMs >= 0], [null, '', true]);
  assert.equal(rep.steps[1].skipped, undefined, 'the legacy flag is not written');
  assert.equal(readFileSync(join(repo.dir, '.verify', 'logs', 'two.log'), 'utf8'), 'custom log line\n');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].mode, 'full');
  assert.equal(seen[0].cwd, repo.dir);
  assert.equal(seen[0].git.head, rep.git.head);
  assert.match(r.out, /\[skip\] two \(nothing under db\/ changed\)/);
  assert.match(r.out, /verify \(full\): PASS - 2 passed, 1 skipped \(3 steps\)/);
});

test('skipIf: without a log the reason is written to the step log; a run with no skips keeps the old tally', async () => {
  const repo = await setup();
  await verify(repo, [], [{ name: 'two', cmd: touch('ran-two'), quick: false, skipIf: () => ({ run: false, reason: 'because' }) }, pass('one')]);
  assert.match(readFileSync(join(repo.dir, '.verify', 'logs', 'two.log'), 'utf8'), /skipped: because/);
  const plain = await verify(repo, [], [pass('one'), { ...pass('two'), skipIf: () => null }]);
  assert.match(plain.out, /verify \(full\): PASS - 2\/2 steps passed/);
  assert.deepEqual(reportOf(repo).steps.map((s) => [s.status, s.skipReason, s.skipCheck]), [['pass', undefined, undefined], ['pass', undefined, undefined]]);
});

test('skipIf: only consulted in a full run, never in --quick or --only', async () => {
  const repo = await setup();
  let calls = 0;
  const steps = [{ name: 'one', cmd: touch('ran-one'), quick: true, skipIf: () => { calls += 1; return { run: false, reason: 'x' }; } }];
  for (const argv of [['--quick'], ['--only', 'one']]) {
    const r = await verify(repo, argv, steps);
    assert.equal(r.exitCode, 0, argv.join(' '));
    assert.equal(reportOf(repo).steps[0].status, 'pass', argv.join(' '));
    assert.ok(existsSync(join(repo.dir, 'ran-one')), argv.join(' '));
    rmSync(join(repo.dir, 'ran-one'));
  }
  assert.equal(calls, 0);
});

test('skipIf: fails closed. A throw or a junk answer runs the step and records why', async () => {
  const repo = await setup();
  const answers = [
    ['throws', () => { throw new Error('probe broke'); }, /probe broke/],
    ['true', () => true, /skipIf must return/],
    ['a string', () => 'skip', /skipIf must return/],
    ['skip without a reason', () => ({ run: false }), /skipIf must return/],
    ['an empty reason', () => ({ run: false, reason: '  ' }), /skipIf must return/],
    ['run not literally false', () => ({ run: 0, reason: 'x' }), /skipIf must return/],
    ['a non-string log', () => ({ run: false, reason: 'x', log: 5 }), /skipIf must return/],
    ['a promise', () => Promise.resolve({ run: false, reason: 'x' }), /skipIf must return/],
  ];
  for (const [label, skipIf, why] of answers) {
    rmSync(join(repo.dir, 'ran-s'), { force: true });
    const r = await verify(repo, [], [{ name: 's', cmd: touch('ran-s'), quick: false, skipIf }]);
    assert.equal(r.exitCode, 0, label);
    assert.ok(existsSync(join(repo.dir, 'ran-s')), `${label}: the step must run`);
    const row = reportOf(repo).steps[0];
    assert.equal(row.status, 'pass', label);
    assert.match(row.skipCheck, /^skip check failed: /, label);
    assert.match(row.skipCheck, why, label);
    assert.match(r.out, /\(runs: skip check failed: /, label);
  }
});

test('skipIf: a promise that later rejects is consumed, so verify fails closed instead of crashing (R1-B1)', async () => {
  const repo = await setup();
  const r = await verify(repo, [], [{ name: 's', cmd: touch('ran-s'), quick: false, skipIf: () => Promise.reject(new Error('probe failed')) }]);
  assert.equal(r.exitCode, 0, r.err);
  assert.ok(existsSync(join(repo.dir, 'ran-s')), 'the step must run');
  const row = reportOf(repo).steps[0];
  assert.equal(row.status, 'pass');
  assert.match(row.skipCheck, /^skip check failed/);
});

test('skipIf: { run: true, reason } runs the step and says why; skipIf must be a function', async () => {
  const repo = await setup();
  const r = await verify(repo, [], [{ name: 's', cmd: touch('ran-s'), quick: false, skipIf: () => ({ run: true, reason: 'src/ changed' }) }]);
  assert.equal(r.exitCode, 0);
  assert.ok(existsSync(join(repo.dir, 'ran-s')));
  assert.equal(reportOf(repo).steps[0].skipCheck, 'src/ changed');
  assert.match(r.out, /\[run \] s: .*\(runs: src\/ changed\)/);
  const bad = await verify(repo, [], [{ name: 's', cmd: touch('x'), quick: false, skipIf: 'yes' }]);
  assert.equal(bad.exitCode, 2);
  assert.match(bad.err, /skipIf must be a function/);
});

test('skipIf: a skipped step does not hide a later failure, and the failing step still stops the run', async () => {
  const repo = await setup();
  const steps = [
    { name: 'one', cmd: touch('ran-one'), quick: false, skipIf: () => ({ run: false, reason: 'unchanged' }) },
    { name: 'two', cmd: nodeCmd('process.exit(4)'), quick: false },
    { name: 'three', cmd: touch('ran-three'), quick: false },
  ];
  const r = await verify(repo, [], steps);
  assert.equal(r.exitCode, 1);
  assert.deepEqual(reportOf(repo).steps.map((s) => s.status), ['skipped', 'fail', 'not-run']);
  assert.equal(reportOf(repo).ok, false);
  assert.match(r.out, /verify \(full\): FAIL at two - 0 passed, 1 skipped \(3 steps\)/);
});
