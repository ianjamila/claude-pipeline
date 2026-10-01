// Tests for scripts/pipeline/supabase-local.mjs (the dedicated local Supabase for verify). No docker and no real
// supabase CLI: a scripted fake (test/fixtures/fake-supabase.mjs) answers start/status/reset/test, and the config
// rewrite and directory sync are checked directly against fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { project, importVendored, runNode, scratchDir } from './helpers/project.mjs';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const CONFIG_TOML = readFileSync(join(fixtures, 'supabase-config.toml'), 'utf8');
const fakeBin = `node ${join(fixtures, 'fake-supabase.mjs')}`;

const lib = async () => importVendored((await project()).dir, 'supabase-local');
const lineOf = (text, re) => text.split('\n').find((l) => re.test(l));

// A project repo with a supabase/ directory; returns the repo.
async function withSupabase(files = {}) {
  const repo = await project();
  repo.write('supabase/config.toml', CONFIG_TOML);
  repo.write('supabase/migrations/20260101000000_init.sql', 'create table a(id int);\n');
  repo.write('supabase/migrations/20260102000000_more.sql', 'create table b(id int);\n');
  repo.write('supabase/tests/rls.test.sql', 'select plan(1);\n');
  repo.write('supabase/seed.sql', 'insert into a values (1);\n');
  for (const [rel, content] of Object.entries(files)) repo.write(rel, content);
  return repo;
}

// Environment + log for one fake-supabase scenario.
function fake(extra = {}) {
  const dir = scratchDir();
  return {
    dir,
    log: join(dir, 'log.jsonl'),
    env: { FAKE_SB_STATE: dir, FAKE_SB_LOG: join(dir, 'log.jsonl'), ...extra },
    calls: () => (existsSync(join(dir, 'log.jsonl')) ? readFileSync(join(dir, 'log.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []),
  };
}
// The in-process fake: supabaseBin runs in THIS process's environment, so set it for the duration of a call.
function withEnv(env, fn) {
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

// ---- config rewrite ----------------------------------------------------------------------------------------------

test('rewriteConfigToml sets project_id and shifts every local port by the offset', async () => {
  const { rewriteConfigToml } = await lib();
  const out = rewriteConfigToml(CONFIG_TOML, { project: 'drmed', portOffset: 1000 });
  assert.match(out, /^project_id = "drmed-pipeline"   # trailing comment survives$/m);
  assert.match(out, /^port = 55321$/m, 'api');
  assert.match(out, /^port = 55322$/m, 'db');
  assert.match(out, /^shadow_port = 55320$/m);
  assert.match(out, /^port = 55329 # pooler$/m, 'trailing comment kept');
  assert.match(out, /^port = 55323$/m, 'studio');
  assert.match(out, /^port = 55324$/m, 'inbucket');
  assert.match(out, /^pop3_port = 55326$/m);
  assert.match(out, /^inspector_port = 9083$/m);
  assert.match(out, /^port = 55327$/m, 'analytics');
});

test('rewriteConfigToml leaves comments, URLs, other settings and the outbound SMTP port alone', async () => {
  const { rewriteConfigToml } = await lib();
  const out = rewriteConfigToml(CONFIG_TOML, { project: 'drmed' });
  assert.match(out, /^# smtp_port = 54325$/m, 'commented example untouched');
  assert.match(out, /^# port = 9999$/m);
  assert.match(out, /^site_url = "http:\/\/127\.0\.0\.1:3000"$/m, 'the app URL is not a supabase port');
  assert.match(out, /^additional_redirect_urls = \["https:\/\/127\.0\.0\.1:3000"\]$/m);
  assert.match(out, /^api_url = "http:\/\/127\.0\.0\.1"$/m);
  assert.match(out, /^major_version = 17$/m);
  assert.match(out, /^default_pool_size = 20$/m);
  const smtp = out.slice(out.indexOf('[auth.email.smtp]'));
  assert.match(smtp, /^port = 587$/m, 'port of a remote mail server must not move');
  // Nothing but the intended lines differ.
  const before = CONFIG_TOML.split('\n');
  const after = out.split('\n');
  assert.equal(after.length, before.length);
  const changed = after.filter((l, i) => l !== before[i]);
  assert.equal(changed.length, 10, `changed lines: ${changed.join(' | ')}`);
});

test('rewriteConfigToml honours a custom offset, CRLF files, and refuses bad input', async () => {
  const { rewriteConfigToml, slug } = await lib();
  assert.match(rewriteConfigToml(CONFIG_TOML, { project: 'x', portOffset: 10 }), /^port = 54331$/m);
  assert.match(rewriteConfigToml(CONFIG_TOML, { project: 'x', portOffset: 0 }), /^port = 54321$/m);
  const crlf = rewriteConfigToml(CONFIG_TOML.replace(/\n/g, '\r\n'), { project: 'x' });
  assert.match(crlf, /^port = 55321\r$/m);
  assert.match(crlf, /^port = 55329 # pooler\r$/m, 'a trailing comment on a CRLF line');
  assert.match(crlf, /^project_id = "x-pipeline"   # trailing comment survives\r$/m);
  assert.throws(() => rewriteConfigToml(CONFIG_TOML, { project: 'x', portOffset: 20000 }), /above 65535/);
  assert.throws(() => rewriteConfigToml(CONFIG_TOML, { project: 'x', portOffset: -1 }), /portOffset/);
  assert.throws(() => rewriteConfigToml(CONFIG_TOML, { project: 'x', portOffset: 1.5 }), /portOffset/);
  assert.throws(() => rewriteConfigToml(CONFIG_TOML, { project: '   ' }), /project name is required/);
  assert.equal(slug('@acme/my app'), 'acme-my-app');
  assert.equal(slug('good_name-1.2'), 'good_name-1.2');
});

test('rewriteConfigToml adds project_id when the file has none', async () => {
  const { rewriteConfigToml } = await lib();
  const out = rewriteConfigToml('[api]\nport = 54321\n', { project: 'p' });
  assert.equal(out, 'project_id = "p-pipeline"\n[api]\nport = 55321\n');
});

test('only a top-level project_id is rewritten (not one inside a section)', async () => {
  const { rewriteConfigToml } = await lib();
  const out = rewriteConfigToml('project_id = "a"\n[remotes.staging]\nproject_id = "b"\n', { project: 'p' });
  assert.equal(out, 'project_id = "p-pipeline"\n[remotes.staging]\nproject_id = "b"\n');
});

// ---- directory sync ----------------------------------------------------------------------------------------------

test('syncSupabaseDir mirrors the project, rewrites config.toml, and never copies secrets or CLI state', async () => {
  const { syncSupabaseDir } = await lib();
  const src = join(scratchDir(), 'supabase');
  const dest = join(scratchDir(), 'wd', 'supabase');
  mkdirSync(join(src, 'migrations'), { recursive: true });
  mkdirSync(join(src, '.temp'), { recursive: true });
  mkdirSync(join(src, 'functions', 'f', 'node_modules'), { recursive: true });
  writeFileSync(join(src, 'config.toml'), CONFIG_TOML);
  writeFileSync(join(src, 'migrations', '001.sql'), 'a');
  writeFileSync(join(src, 'seed.sql'), 's');
  writeFileSync(join(src, '.env'), 'SECRET=1');
  writeFileSync(join(src, '.env.local'), 'SECRET=2');
  writeFileSync(join(src, '.temp', 'project-ref'), 'REMOTEREF');
  writeFileSync(join(src, 'functions', 'f', 'index.ts'), 'x');
  writeFileSync(join(src, 'functions', 'f', 'node_modules', 'big.js'), 'x');
  syncSupabaseDir(src, dest, { project: 'demo', portOffset: 1000 });

  assert.deepEqual(readdirSync(dest).sort(), ['config.toml', 'functions', 'migrations', 'seed.sql']);
  assert.equal(readFileSync(join(dest, 'migrations', '001.sql'), 'utf8'), 'a');
  assert.ok(existsSync(join(dest, 'functions', 'f', 'index.ts')));
  assert.ok(!existsSync(join(dest, 'functions', 'f', 'node_modules')));
  assert.match(readFileSync(join(dest, 'config.toml'), 'utf8'), /^project_id = "demo-pipeline"/m);
  assert.equal(readFileSync(join(src, 'config.toml'), 'utf8'), CONFIG_TOML, 'the project\'s own config is never modified');
});

test('syncSupabaseDir removes migrations and tests that no longer exist in the project, keeps CLI state', async () => {
  const { syncSupabaseDir } = await lib();
  const src = join(scratchDir(), 'supabase');
  const dest = join(scratchDir(), 'wd', 'supabase');
  mkdirSync(join(src, 'migrations'), { recursive: true });
  mkdirSync(join(src, 'tests', 'deep'), { recursive: true });
  writeFileSync(join(src, 'config.toml'), CONFIG_TOML);
  writeFileSync(join(src, 'migrations', '001.sql'), 'one');
  writeFileSync(join(src, 'migrations', '002.sql'), 'two');
  writeFileSync(join(src, 'tests', 'a.test.sql'), 'a');
  writeFileSync(join(src, 'tests', 'deep', 'b.test.sql'), 'b');
  syncSupabaseDir(src, dest, { project: 'demo' });

  // The CLI keeps its own state in the workdir; sync must leave it alone.
  mkdirSync(join(dest, '.temp'), { recursive: true });
  writeFileSync(join(dest, '.temp', 'cli-latest'), 'v1');

  // The project deletes migration 002 and a nested test, renames 001, and edits a test.
  rmSync(join(src, 'migrations', '002.sql'));
  rmSync(join(src, 'migrations', '001.sql'));
  rmSync(join(src, 'tests', 'deep', 'b.test.sql'));
  writeFileSync(join(src, 'migrations', '001_renamed.sql'), 'one');
  writeFileSync(join(src, 'tests', 'a.test.sql'), 'a2');
  syncSupabaseDir(src, dest, { project: 'demo' });

  assert.deepEqual(readdirSync(join(dest, 'migrations')), ['001_renamed.sql']);
  assert.deepEqual(readdirSync(join(dest, 'tests')), ['a.test.sql'], 'the emptied nested directory is gone too');
  assert.equal(readFileSync(join(dest, 'tests', 'a.test.sql'), 'utf8'), 'a2');
  assert.equal(readFileSync(join(dest, '.temp', 'cli-latest'), 'utf8'), 'v1');
});


test('syncSupabaseDir refuses a directory that is not a supabase project', async () => {
  const { syncSupabaseDir } = await lib();
  const empty = scratchDir();
  assert.throws(() => syncSupabaseDir(empty, join(scratchDir(), 'd'), { project: 'x' }), /config\.toml not found/);
});

// ---- instance management -----------------------------------------------------------------------------------------

test('ensureDedicatedInstance syncs, starts the stack with the trimmed service list, and reports the URLs', async () => {
  const repo = await withSupabase();
  const { ensureDedicatedInstance } = await importVendored(repo.dir, 'supabase-local');
  const f = fake();
  const info = withEnv(f.env, () => ensureDedicatedInstance({ repoRoot: repo.dir, project: 'demo', supabaseBin: fakeBin }));
  const wd = join(repo.dir, '.verify', 'supabase-workdir');
  assert.deepEqual(info, {
    workdir: wd,
    apiUrl: 'http://127.0.0.1:55321',
    dbUrl: 'postgresql://postgres:postgres@127.0.0.1:55322/postgres',
    anonKey: 'anon-key',
    serviceRoleKey: 'service-key',
  });
  const argvs = f.calls().map((c) => c.argv);
  assert.deepEqual(argvs.map((a) => a[0]), ['status', 'start', 'start', 'status']);
  assert.deepEqual(argvs[0], ['status', '--workdir', wd, '-o', 'json']);
  assert.deepEqual(argvs[2], ['start', '--workdir', wd, '-x', 'studio,imgproxy,edge-runtime,logflare,vector,mailpit']);
  assert.match(readFileSync(join(wd, 'supabase', 'config.toml'), 'utf8'), /^project_id = "demo-pipeline"/m);
  assert.deepEqual(readdirSync(join(wd, 'supabase', 'migrations')).sort(), ['20260101000000_init.sql', '20260102000000_more.sql']);
  assert.equal(readFileSync(join(repo.dir, 'supabase', 'config.toml'), 'utf8'), CONFIG_TOML);
  assert.ok(f.calls().every((c) => c.argv.every((a) => !['--linked', '--db-url', '--project-ref'].includes(a))), 'never a remote target');
});

test('ensureDedicatedInstance is idempotent: a running stack is not started again', async () => {
  const repo = await withSupabase();
  const { ensureDedicatedInstance } = await importVendored(repo.dir, 'supabase-local');
  const f = fake();
  withEnv(f.env, () => ensureDedicatedInstance({ repoRoot: repo.dir, project: 'demo', supabaseBin: fakeBin }));
  const before = f.calls().length;
  const again = withEnv(f.env, () => ensureDedicatedInstance({ repoRoot: repo.dir, project: 'demo', supabaseBin: fakeBin }));
  assert.equal(again.apiUrl, 'http://127.0.0.1:55321');
  assert.deepEqual(f.calls().slice(before).map((c) => c.argv[0]), ['status']);
});

test('ensureDedicatedInstance picks container names the installed CLI knows (inbucket vs mailpit vs unknown)', async () => {
  const { ensureDedicatedInstance } = await importVendored((await project()).dir, 'supabase-local');
  const startArgs = async (help) => {
    const repo = await withSupabase();
    const f = fake({ FAKE_SB_HELP: help });
    withEnv(f.env, () => ensureDedicatedInstance({ repoRoot: repo.dir, project: 'demo', supabaseBin: fakeBin }));
    const start = f.calls().find((c) => c.argv[0] === 'start' && !c.argv.includes('--help'));
    return start.argv[start.argv.indexOf('-x') + 1];
  };
  assert.equal(await startArgs('new'), 'studio,imgproxy,edge-runtime,logflare,vector,mailpit');
  assert.equal(await startArgs('old'), 'studio,imgproxy,edge-runtime,logflare,vector,inbucket');
  assert.equal(await startArgs('none'), 'studio,imgproxy,edge-runtime,logflare,vector,inbucket', 'unparseable help falls back to the documented list');
  assert.equal(await startArgs('fail'), 'studio,imgproxy,edge-runtime,logflare,vector,inbucket');
});

test('ensureDedicatedInstance reports a failed start with the CLI output', async () => {
  const repo = await withSupabase();
  const { ensureDedicatedInstance } = await importVendored(repo.dir, 'supabase-local');
  const f = fake({ FAKE_SB_START_CODE: '1' });
  assert.throws(
    () => withEnv(f.env, () => ensureDedicatedInstance({ repoRoot: repo.dir, project: 'demo', supabaseBin: fakeBin })),
    /supabase start failed \(exit 1\):[\s\S]*port is already allocated/,
  );
});

test('ensureDedicatedInstance honours portOffset', async () => {
  const repo = await withSupabase();
  const { ensureDedicatedInstance } = await importVendored(repo.dir, 'supabase-local');
  withEnv(fake().env, () => ensureDedicatedInstance({ repoRoot: repo.dir, project: 'demo', portOffset: 2000, supabaseBin: fakeBin }));
  assert.match(readFileSync(join(repo.dir, '.verify', 'supabase-workdir', 'supabase', 'config.toml'), 'utf8'), /^port = 56321$/m);
});

test('resetAndTest runs reset then pgTAP against the dedicated workdir only', async () => {
  const { resetAndTest } = await lib();
  const f = fake();
  const wd = join(scratchDir(), 'wd');
  const r = withEnv(f.env, () => resetAndTest({ workdir: wd, supabaseBin: fakeBin }));
  assert.equal(r.ok, true);
  assert.deepEqual(f.calls().map((c) => c.argv), [
    ['db', 'reset', '--local', '--workdir', wd],
    ['test', 'db', '--local', '--workdir', wd],
  ]);
});

test('resetAndTest stops at a failed reset, and reports a failed test', async () => {
  const { resetAndTest } = await lib();
  const wd = join(scratchDir(), 'wd');
  const a = fake({ FAKE_SB_RESET_CODE: '1' });
  const r1 = withEnv(a.env, () => resetAndTest({ workdir: wd, supabaseBin: fakeBin }));
  assert.deepEqual([r1.ok, r1.failedStep, r1.test], [false, 'reset', null]);
  assert.equal(a.calls().length, 1, 'pgTAP never runs against a half-reset database');

  const b = fake({ FAKE_SB_TEST_CODE: '1' });
  const r2 = withEnv(b.env, () => resetAndTest({ workdir: wd, supabaseBin: fakeBin }));
  assert.deepEqual([r2.ok, r2.failedStep], [false, 'test']);
});

test('envLines prints the variables the build and e2e steps need', async () => {
  const { envLines } = await lib();
  assert.deepEqual(envLines({ apiUrl: 'http://127.0.0.1:55321', dbUrl: 'postgresql://x@127.0.0.1:55322/postgres', anonKey: 'a', serviceRoleKey: 's' }), [
    'NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:55321',
    'SUPABASE_URL=http://127.0.0.1:55321',
    'NEXT_PUBLIC_SUPABASE_ANON_KEY=a',
    'SUPABASE_ANON_KEY=a',
    'SUPABASE_SERVICE_ROLE_KEY=s',
    'DATABASE_URL=postgresql://x@127.0.0.1:55322/postgres',
  ]);
  assert.deepEqual(envLines({ apiUrl: 'u', dbUrl: 'd', anonKey: null, serviceRoleKey: null }), ['NEXT_PUBLIC_SUPABASE_URL=u', 'SUPABASE_URL=u', 'DATABASE_URL=d']);
});

// ---- CLI ---------------------------------------------------------------------------------------------------------

const cliRun = (repo, args, extraEnv = {}) =>
  runNode(['scripts/pipeline/supabase-local.mjs', ...args], { cwd: repo.dir, env: { PIPELINE_SUPABASE: fakeBin, ...extraEnv } });

test('CLI env prints KEY=value lines for the dedicated instance', async () => {
  const repo = await withSupabase();
  const f = fake();
  const r = await cliRun(repo, ['env', '--project', 'demo'], f.env);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split('\n'), [
    'NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:55321',
    'SUPABASE_URL=http://127.0.0.1:55321',
    'NEXT_PUBLIC_SUPABASE_ANON_KEY=anon-key',
    'SUPABASE_ANON_KEY=anon-key',
    'SUPABASE_SERVICE_ROLE_KEY=service-key',
    'DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55322/postgres',
  ]);
});

test('CLI reset-and-test exits 0 on success and 1 when reset or tests fail, printing the CLI output', async () => {
  const repo = await withSupabase();
  const ok = await cliRun(repo, ['reset-and-test', '--project', 'demo'], fake().env);
  assert.equal(ok.code, 0, ok.stderr);
  assert.match(ok.stdout, /Resetting local database/);
  assert.match(ok.stdout, /All tests successful/);

  const badReset = await cliRun(repo, ['reset-and-test', '--project', 'demo'], fake({ FAKE_SB_RESET_CODE: '1' }).env);
  assert.equal(badReset.code, 1);
  assert.doesNotMatch(badReset.stdout, /All tests successful/);

  const badTest = await cliRun(repo, ['reset-and-test', '--project', 'demo'], fake({ FAKE_SB_TEST_CODE: '1' }).env);
  assert.equal(badTest.code, 1);
});

test('CLI honours --repo and --port-offset', async () => {
  const repo = await withSupabase();
  const other = await project();
  const r = await runNode(['scripts/pipeline/supabase-local.mjs', 'env', '--project', 'demo', '--repo', repo.dir, '--port-offset', '2000'], {
    cwd: other.dir, env: { PIPELINE_SUPABASE: fakeBin, ...fake().env },
  });
  assert.equal(r.code, 0, r.stderr);
  assert.match(readFileSync(join(repo.dir, '.verify', 'supabase-workdir', 'supabase', 'config.toml'), 'utf8'), /^port = 56321$/m);
  assert.ok(!existsSync(join(other.dir, '.verify', 'supabase-workdir')));
});

test('CLI usage errors and a missing supabase directory exit 2', async () => {
  const repo = await withSupabase();
  assert.equal((await cliRun(repo, ['env'])).code, 2, 'missing --project');
  assert.equal((await cliRun(repo, ['bogus', '--project', 'x'])).code, 2, 'unknown command');
  assert.equal((await cliRun(repo, [])).code, 2);
  assert.equal((await cliRun(repo, ['env', '--project', 'x', '--port-offset', 'abc'])).code, 2);
  assert.equal((await cliRun(repo, ['env', '--project', 'x', '--nope'])).code, 2);
  const bare = await project();
  const r = await cliRun(bare, ['env', '--project', 'x'], fake().env);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /config\.toml not found/);
});

test('a failing supabase start is reported by the CLI with exit 2', async () => {
  const repo = await withSupabase();
  const r = await cliRun(repo, ['env', '--project', 'demo'], fake({ FAKE_SB_START_CODE: '1' }).env);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /supabase start failed/);
});
