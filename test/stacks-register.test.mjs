// Why: the register hook is the only thing that tells autostop "a live Claude process still needs this stack". A lease that
// is never written lets a stack be stopped under a running session, so once a private stack is named every failure (inventory,
// owner, lock, append, the deadline) must block the call with a reason, unless the pause file says otherwise; while an
// unrelated tool call must cost almost nothing and must never read the (possibly huge) ledger. Pure tests inject every
// dependency; the end-to-end tests spawn the real hook with fake docker / ps binaries and a throwaway state root.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { register, readTailLines, resolveSeams, DEFAULT_DEADLINE_MS } from '../pipeline/lib/stacks/register.mjs';
import { stackFiles, lockDirs } from '../pipeline/lib/stacks/paths.mjs';
import { parseLstart } from '../pipeline/lib/stacks/identity.mjs';
import { ok, unknown } from '../pipeline/lib/stacks/result.mjs';
import { tryAcquire, release } from '../pipeline/lib/locks.mjs';
import { HOOK_LOADER } from '../pipeline/lib/installer.mjs';
import { container } from './fixtures/fake-docker.mjs';

process.env.PIPELINE_MACHINE_ID ||= 'test-machine-id'; // lock owner records never create ~/.claude/pipeline-state/machine-id

const posixOnly = { skip: process.platform === 'win32' && 'POSIX only' };
const here = dirname(fileURLToPath(import.meta.url));
const HOOK = join(here, '..', 'pipeline', 'hooks', 'stack-register.mjs');
const FAKE_DOCKER = join(here, 'fixtures', 'fake-docker-bin.mjs');
const FAKE_PS = join(here, 'fixtures', 'fake-ps-bin.mjs');
const SPY = join(here, 'fixtures', 'fs-spy-preload.mjs');
const CPU_PROBE = join(here, 'fixtures', 'cpu-probe-preload.mjs');
const HOLD = join(here, 'fixtures', 'hold-lock.mjs');
const LSTART = 'Mon Oct 19 02:47:17 2026';
const OWNER = { pid: 4242, birth: 1000 };
const CFG = { status: 'ok', shared: new Set(['e2e-ci', 'drmed']), repos: [], memoryDirs: [], memoryExclude: [], transcriptDirs: [], devPorts: [3000] };

// ---- a throwaway world: state root + stack workdirs on disk ----
function stackOf(base, project, folder, ports, extra = {}) {
  const workdir = join(base, '.worktrees', folder);
  mkdirSync(join(workdir, 'supabase'), { recursive: true });
  writeFileSync(join(workdir, 'supabase', 'config.toml'), `project_id = "${project}"\n`);
  return {
    project,
    workdir,
    workdirExists: true,
    folder,
    shared: false,
    generation: { id: `db-${project}`, startedAt: '2026-10-19T01:00:00.000000000Z' },
    containers: ['kong', 'db'].map((s) => ({ id: `${s}-${project}`, name: `supabase_${s}_${project}`, running: true, startedAt: '' })),
    ports,
    volumes: [],
    dbVolume: null,
    ...extra,
  };
}

function world(projects) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'stacks-reg-')));
  const root = join(base, 'state');
  const files = stackFiles(root);
  mkdirSync(join(base, '.worktrees', 'sa-correction-requests'), { recursive: true });
  const specs = projects ?? [
    ['sa-corrections', 'sa-corrections.stack', [54420, 54421, 54422]],
    ['sub-detach', 'sub detach.stack', [54520, 54521]],
    ['e2e-ci', 'e2e-wt', [54321]],
  ];
  const stacks = specs.map(([p, f, ports]) => stackOf(base, p, f, ports));
  return { base, root, files, stacks, inv: { dockerDown: false, stacks }, wd: (f) => join(base, '.worktrees', f), wtCwd: join(base, '.worktrees', 'sa-correction-requests') };
}

const bash = (command, cwd, extra = {}) => ({ tool_name: 'Bash', tool_input: { command }, cwd, session_id: 's1', tool_use_id: 'tu1', ...extra });
const fileTool = (tool, file_path, cwd = '/') => ({ tool_name: tool, tool_input: { file_path }, cwd, session_id: 's1', tool_use_id: 'tu2' });
const lines = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const refreshForbidden = async () => { throw new Error('the inventory must not be refreshed here'); };

function deps(w, over = {}) {
  return {
    env: {},
    platform: 'linux',
    home: w.base,
    root: w.root,
    files: w.files,
    cfg: CFG,
    iso: { isDefault: false, only: null },
    seams: { docker: 'docker', ps: undefined, deadlineMs: 20000 },
    inventory: () => ({ inv: w.inv, fresh: true, at: Date.now() }),
    refreshInventory: refreshForbidden,
    owner: () => ok(OWNER),
    worktree: () => ok('none'),
    ...over,
  };
}

// ---- Task 4's table: one lease per named stack ----
const table = (w) => [
  [`supabase status -o env --workdir ../sa-corrections.stack > ../sa-corrections.stack/.status.env`, w.wtCwd, ['sa-corrections']],
  [`cd ${w.wtCwd} && supabase db reset --local --workdir ../sa-corrections.stack`, '/', ['sa-corrections']],
  [`npx supabase test db --workdir "../sub detach.stack"`, w.wtCwd, ['sub-detach']],
  ['docker exec -i supabase_db_sa-corrections psql -U postgres -c "select 1"', '/', ['sa-corrections']],
  ['SUPABASE_URL=http://127.0.0.1:54421 node scripts/seed.mjs', '/', ['sa-corrections']],
  [`true || supabase stop --workdir ../sa-corrections.stack`, w.wtCwd, ['sa-corrections']],
  ['echo "sa-corrections is done"', '/', ['sa-corrections']],
  ['psql -h 127.0.0.1 -p 54421 -p 54521 -c "select 1"', '/', ['sa-corrections', 'sub-detach']],
];

test('a lease is written for every case of the match table, one line per stack', async () => {
  const count = table(world()).length;
  for (let i = 0; i < count; i++) {
    const w = world();
    const [command, cwd, want] = table(w)[i];
    const r = await register(bash(command, cwd), deps(w));
    assert.equal(r.exit, 0, `case ${i}: ${command}`);
    const written = lines(w.files.ledger);
    assert.deepEqual(written.map((e) => e.project).sort(), [...want].sort(), `case ${i}: ${command}`);
    for (const e of written) {
      assert.equal(e.kind, 'use');
      assert.deepEqual(e.owner, OWNER);
      assert.equal(e.session_id, 's1');
      assert.equal(e.tool, 'Bash');
      assert.equal(e.worktree, 'none');
    }
    assert.deepEqual(r.events.map((e) => e.project).sort(), [...want].sort());
  }
});

test('file tools: a write inside the stack folder is a lease; reading it, or a path elsewhere, is not', async () => {
  const w = world();
  for (const tool of ['Edit', 'Write']) {
    const r = await register(fileTool(tool, join(w.wd('sa-corrections.stack'), 'supabase', 'config.toml')), deps(w));
    assert.equal(r.exit, 0, tool);
  }
  assert.equal(lines(w.files.ledger).length, 2);
  assert.ok(lines(w.files.ledger).every((e) => e.project === 'sa-corrections' && e.tool !== 'Bash'));
  for (const tool of ['Read', 'Grep', 'Glob']) {
    const r = await register(fileTool(tool, join(w.wd('sa-corrections.stack'), 'supabase', 'config.toml')), deps(w));
    assert.equal(r.exit, 0, tool);
  }
  assert.equal(lines(w.files.ledger).length, 2, 'reading a stack is inspection, not use');
  const none = await register(fileTool('Edit', join(w.base, 'notes.md')), deps(w));
  assert.equal(none.exit, 0);
  assert.equal(lines(w.files.ledger).length, 2);
});

test('a read-only Bash inspection of a stack writes no lease; the same stack used in the command still does', async () => {
  const w = world();
  const wd = w.wd('sa-corrections.stack');
  for (const command of [`docker ps --filter name=sa-corrections`, `ls ${wd}`, `cat ${wd}/supabase/config.toml | head -3`]) {
    const r = await register(bash(command, w.base), deps(w));
    assert.equal(r.exit, 0, command);
  }
  assert.equal(existsSync(w.files.ledger), false);
  const used = await register(bash(`docker ps --filter name=sa-corrections && supabase status --workdir ${wd}`, w.base), deps(w));
  assert.equal(used.exit, 0);
  assert.equal(lines(w.files.ledger).length, 1);
});

test('shared-only commands exit 0 and write no line (e2e-ci, a -pipeline id, a .verify workdir)', async () => {
  const w = world([['e2e-ci', 'e2e-wt', [54321]], ['eaglewatch-pipeline', 'ew-pipe.stack', [54621]], ['proj-x', '.verify/supabase-workdir', [54721]]]);
  w.stacks[2].shared = true;
  for (const command of [`supabase status --workdir ${w.wd('e2e-wt')}`, 'psql -h 127.0.0.1 -p 54621 -c "select 1"', `supabase status --workdir ${w.wd('.verify/supabase-workdir')}`]) {
    const r = await register(bash(command, w.base), deps(w));
    assert.equal(r.exit, 0, command);
    assert.deepEqual(r.events, []);
  }
  assert.equal(existsSync(w.files.ledger), false);
});

test('ids named like the global locks register without waiting on them (R3-3: ledger, sweep, dev-3000)', async () => {
  const w = world([['ledger', 'ledger.stack', [55001]], ['sweep', 'sweep.stack', [55002]], ['dev-3000', 'dev-3000.stack', [55003]]]);
  // the real global locks are held by someone else the whole time: a name collision would make register wait or fail
  const heldLedger = tryAcquire('ledger', { dir: lockDirs(w.root).ledger });
  const heldSweep = tryAcquire('sweep', { dir: lockDirs(w.root).sweep });
  assert.equal(heldLedger.acquired && heldSweep.acquired, true);
  try {
    const started = Date.now();
    const r = await register(bash('psql -p 55001 -p 55002 -p 55003 -c x', w.base), deps(w, { deadlineMs: 1500 }));
    // the ledger lock IS needed for the append, so it is the only wait; the project locks never collide
    assert.equal(r.exit, 2);
    assert.match(r.message, /ledger lock unavailable/);
    assert.ok(Date.now() - started < 4000);
  } finally {
    release(heldLedger.lock);
  }
  const r2 = await register(bash('psql -p 55001 -p 55002 -p 55003 -c x', w.base), deps(w));
  assert.equal(r2.exit, 0);
  assert.deepEqual(r2.events.map((e) => e.project).sort(), ['dev-3000', 'ledger', 'sweep']);
  assert.equal(existsSync(join(lockDirs(w.root).project, 'ledger.lock')), false, 'project locks are released');
  release(heldSweep.lock);
});

// ---- failures ----
// [name, deps, reason, stack named in the message]: with no inventory the targets are not known yet
const FAILURES = [
  ['inventory unknown', () => ({ inventory: () => ({ inv: null, fresh: false }), refreshInventory: async () => unknown('docker ps exit 1: boom') }), /inventory unavailable: docker ps exit 1: boom/, '(unknown)'],
  ['owner unknown', () => ({ owner: () => unknown('no Claude Code process above the hook') }), /owner not found: no Claude Code process/, 'sa-corrections'],
  ['append unknown', () => ({ appendEvent: async () => unknown('ledger append failed: EROFS') }), /ledger append failed: EROFS/, 'sa-corrections'],
  ['worktree unknown', () => ({ worktree: () => unknown('git timed out') }), /worktree lookup failed: git timed out/, 'sa-corrections'],
];

for (const [name, make, reason, stack] of FAILURES) {
  test(`failure: ${name} => exit 2 with the reason; paused => exit 0 and a log line`, async () => {
    const w = world();
    const command = `supabase status --workdir ${w.wd('sa-corrections.stack')}`;
    const r = await register(bash(command, w.base), deps(w, make(w)));
    assert.equal(r.exit, 2);
    assert.ok(r.message.startsWith(`autostop could not register use of stack ${stack} (`), r.message);
    assert.match(r.message, reason);
    assert.ok(r.message.endsWith(`retry; pause with: touch ${w.files.pause}`), r.message);
    assert.equal(existsSync(w.files.ledger), false);

    mkdirSync(w.root, { recursive: true });
    writeFileSync(w.files.pause, '');
    const p = await register(bash(command, w.base), deps(w, make(w)));
    assert.equal(p.exit, 0);
    assert.equal(p.message, undefined);
    assert.ok(readFileSync(w.files.log, 'utf8').includes(`paused, allowing: could not register use of stack ${stack}`));
  });
}

// R1-B6: a machine with no (or a broken) config gets no behaviour change: a failure to register is logged, never blocking.
for (const status of ['missing', 'invalid']) {
  for (const [name, make, reason, stack] of FAILURES) {
    test(`failure: ${name} with the machine config ${status} => exit 0 and a log line; config ok => still exit 2`, async () => {
      const w = world();
      const command = `supabase status --workdir ${w.wd('sa-corrections.stack')}`;
      const unconfigured = { ...CFG, status, shared: new Set(), error: status === 'invalid' ? 'not valid JSON' : undefined };
      const r = await register(bash(command, w.base), deps(w, { ...make(w), cfg: unconfigured }));
      assert.equal(r.exit, 0);
      assert.equal(r.message, undefined);
      assert.ok(readFileSync(w.files.log, 'utf8').includes(`not configured, allowing: could not register use of stack ${stack}`));
      const configured = await register(bash(command, w.base), deps(w, make(w)));
      assert.equal(configured.exit, 2, 'unchanged once the machine is configured');
      assert.match(configured.message, reason);
    });
  }
}

test('failure: the project lock is held past the deadline => exit 2 naming the lock path; paused => 0', posixOnly, async () => {
  const w = world();
  const held = tryAcquire('sa-corrections', { dir: lockDirs(w.root).project });
  assert.equal(held.acquired, true);
  try {
    const command = `supabase status --workdir ${w.wd('sa-corrections.stack')}`;
    const started = Date.now();
    const r = await register(bash(command, w.base), deps(w, { deadlineMs: 400 }));
    assert.equal(r.exit, 2);
    assert.match(r.message, /project lock unavailable/);
    assert.ok(r.message.includes(join(lockDirs(w.root).project, 'sa-corrections.lock')), r.message);
    assert.match(r.message, /deadline of 400 ms exceeded/);
    assert.ok(Date.now() - started < 3000);
    writeFileSync(w.files.pause, '');
    assert.equal((await register(bash(command, w.base), deps(w, { deadlineMs: 400 }))).exit, 0);
  } finally {
    release(held.lock);
  }
});

test('failure: the ledger lock is held past the deadline => exit 2 naming the ledger lock path', posixOnly, async () => {
  const w = world();
  const held = tryAcquire('ledger', { dir: lockDirs(w.root).ledger });
  try {
    const r = await register(bash(`supabase status --workdir ${w.wd('sa-corrections.stack')}`, w.base), deps(w, { deadlineMs: 400 }));
    assert.equal(r.exit, 2);
    assert.match(r.message, /ledger lock unavailable/);
    assert.ok(r.message.includes(join(lockDirs(w.root).ledger, 'ledger.lock')), r.message);
  } finally {
    release(held.lock);
  }
  assert.equal(existsSync(join(lockDirs(w.root).project, 'sa-corrections.lock')), false, 'the project lock is released on failure');
});

test('a live lock holder in another process: register waits, then registers once it is released', posixOnly, async () => {
  const w = world();
  const dir = lockDirs(w.root).project;
  mkdirSync(dir, { recursive: true });
  const child = spawn(process.execPath, [HOLD, dir, 'sa-corrections', '600'], { stdio: ['ignore', 'pipe', 'inherit'] });
  const closed = new Promise((resolve) => child.on('close', resolve));
  await new Promise((resolve) => child.stdout.once('data', resolve)); // "held"
  const started = Date.now();
  const r = await register(bash(`supabase status --workdir ${w.wd('sa-corrections.stack')}`, w.base), deps(w, { deadlineMs: 10000 }));
  const waited = Date.now() - started;
  await closed;
  assert.equal(r.exit, 0);
  assert.equal(lines(w.files.ledger).length, 1);
  assert.ok(waited >= 300, `waited only ${waited} ms`);
});

test('docker daemon down => exit 0 and a log line; a cached "down" answer is never trusted', async () => {
  const w = world();
  const command = `supabase status --workdir ${w.wd('sa-corrections.stack')}`;
  let refreshes = 0;
  const down = async () => { refreshes++; return ok({ dockerDown: true, stacks: [] }); };
  const r = await register(bash(command, w.base), deps(w, { inventory: () => ({ inv: null, fresh: false }), refreshInventory: down }));
  assert.equal(r.exit, 0);
  assert.match(readFileSync(w.files.log, 'utf8'), /docker daemon is not running/);
  const cached = await register(bash(command, w.base), deps(w, { inventory: () => ({ inv: { dockerDown: true, stacks: [] }, fresh: true, at: Date.now() }), refreshInventory: down }));
  assert.equal(cached.exit, 0);
  assert.equal(refreshes, 2, 'a fresh cache that says "docker down" is refreshed');
  assert.equal(existsSync(w.files.ledger), false);
});

test('a stale cache is refreshed after a prefilter hit only; an unrelated command never refreshes', async () => {
  const w = world();
  let refreshes = 0;
  const stale = { inventory: () => ({ inv: w.inv, fresh: false, at: 1 }), refreshInventory: async () => { refreshes++; return ok(w.inv); } };
  assert.equal((await register(bash('git status', w.base), deps(w, stale))).exit, 0);
  assert.equal(refreshes, 0);
  assert.equal((await register(bash(`supabase status --workdir ${w.wd('sa-corrections.stack')}`, w.base), deps(w, stale))).exit, 0);
  assert.equal(refreshes, 1);
  assert.equal(lines(w.files.ledger).length, 1);
});

test('an isolated run touches only the projects it names (PIPELINE_STACKS_ONLY)', async () => {
  const w = world();
  const iso = { isDefault: false, only: new Set(['sub-detach']) };
  const r = await register(bash('psql -p 54421 -p 54521 -c x', w.base), deps(w, { iso }));
  assert.equal(r.exit, 0);
  assert.deepEqual(r.events.map((e) => e.project), ['sub-detach']);
  const none = await register(bash('psql -p 54421 -c x', w.base), deps(w, { iso }));
  assert.deepEqual(none.events, []);
});

// ---- dev servers (F4, R2-3) ----
test('npm run dev writes a dev event although the stack prefilter misses (and never touches docker)', async () => {
  const w = world();
  const r = await register(bash('npm run dev', w.base), deps(w));
  assert.equal(r.exit, 0);
  const [e] = lines(w.files.ledger);
  assert.equal(e.kind, 'dev');
  assert.equal(e.port, 3000);
  assert.equal(e.tPre, e.t);
  assert.equal(e.tool_use_id, 'tu1');
  assert.deepEqual(e.owner, OWNER);
  const ports = [];
  for (const [cmd, port] of [['next dev -p 4000', 4000], ['PORT=4017 npm run dev', 4017], ['next start --port=4001', 4001]]) {
    await register(bash(cmd, w.base), deps(w));
    ports.push(port);
  }
  assert.deepEqual(lines(w.files.ledger).slice(1).map((x) => x.port), ports);
});

test('R2-3: the dev append failing only logs; the stack lease is still written', async () => {
  const w = world();
  const real = (await import('../pipeline/lib/stacks/ledger.mjs')).appendEvent;
  const failDev = async (file, event, opts) => (event.kind === 'dev' ? unknown('ledger append failed: disk full') : real(file, event, opts));
  const r = await register(bash('SUPABASE_URL=http://127.0.0.1:54421 npm run dev', w.base), deps(w, { appendEvent: failDev }));
  assert.equal(r.exit, 0);
  assert.deepEqual(lines(w.files.ledger).map((e) => [e.kind, e.project]), [['use', 'sa-corrections']]);
  assert.match(readFileSync(w.files.log, 'utf8'), /dev record for port 3000 failed: ledger append failed: disk full/);

  const failAll = async () => unknown('ledger append failed: disk full');
  const both = await register(bash('SUPABASE_URL=http://127.0.0.1:54421 npm run dev', w.base), deps(w, { appendEvent: failAll }));
  assert.equal(both.exit, 2);
  assert.match(both.message, /ledger append failed: disk full/);
});

test('a dev owner failure logs and the flow continues; a plain dev command exits 0', async () => {
  const w = world();
  const r = await register(bash('npm run dev', w.base), deps(w, { owner: () => unknown('no claude') }));
  assert.equal(r.exit, 0);
  assert.match(readFileSync(w.files.log, 'utf8'), /dev record skipped: owner unknown/);
});

// ---- just stopped ----
function stoppedWorld(stoppedAt) {
  const w = world();
  mkdirSync(w.root, { recursive: true });
  const rec = (project, action, t) => `${JSON.stringify({ t, source: 'session-end', project, generation: 'g', action, reasons: [] })}\n`;
  writeFileSync(w.files.actions, rec('sa-corrections', 'kept', '2026-10-19T01:00:00.000Z') + rec('sa-corrections', 'stopped', stoppedAt) + rec('sub-detach', 'kept', new Date(Date.now() + 5000).toISOString()));
  return w;
}
const snapshotNow = (w) => ({ inventory: () => ({ inv: w.inv, fresh: true, at: Date.now() - 1000 }) });

test('just stopped after the snapshot: Bash is blocked with the restart message; start and file tools are not', async () => {
  const w = stoppedWorld(new Date(Date.now()).toISOString());
  const wd = w.wd('sa-corrections.stack');
  const status = await register(bash(`supabase status --workdir ${wd}`, w.base), deps(w, snapshotNow(w)));
  assert.equal(status.exit, 2);
  assert.match(status.message, /was just stopped automatically/);
  assert.ok(status.message.includes('supabase start -x studio,imgproxy,edge-runtime,logflare,vector --workdir ' + wd), status.message);
  assert.equal(existsSync(w.files.ledger), false);

  let dropped = 0;
  const start = await register(bash(`supabase start -x studio,imgproxy,edge-runtime,logflare,vector --workdir ${wd}`, w.base), deps(w, { ...snapshotNow(w), invalidateCache: () => { dropped++; } }));
  assert.equal(start.exit, 0);
  assert.equal(lines(w.files.ledger).length, 1);
  assert.equal(dropped, 1, 'the stale inventory cache is dropped after a restart');

  const edit = await register(fileTool('Edit', join(wd, 'supabase', 'config.toml')), deps(w, snapshotNow(w)));
  assert.equal(edit.exit, 0);
  assert.equal(lines(w.files.ledger).length, 2);

  const read = await register(fileTool('Read', join(wd, 'supabase', 'config.toml')), deps(w, snapshotNow(w)));
  assert.equal(read.exit, 0);
  assert.equal(lines(w.files.ledger).length, 2, 'Read appends no lease');
});

test('just stopped: a read-only docker ps of the stack passes with no lease; docker ps && supabase status is still blocked', async () => {
  const w = stoppedWorld(new Date(Date.now()).toISOString());
  const wd = w.wd('sa-corrections.stack');
  const ps = await register(bash('docker ps --filter name=sa-corrections', w.base), deps(w, snapshotNow(w)));
  assert.equal(ps.exit, 0);
  assert.equal(existsSync(w.files.ledger), false);
  const both = await register(bash(`docker ps --filter name=sa-corrections && supabase status --workdir ${wd}`, w.base), deps(w, snapshotNow(w)));
  assert.equal(both.exit, 2);
  assert.match(both.message, /was just stopped automatically/);
  assert.equal(existsSync(w.files.ledger), false);
});

test('a stop older than the inventory snapshot, or of another project, does not block', async () => {
  const w = stoppedWorld(new Date(Date.now() - 60000).toISOString());
  const wd = w.wd('sa-corrections.stack');
  const older = await register(bash(`supabase status --workdir ${wd}`, w.base), deps(w, { inventory: () => ({ inv: w.inv, fresh: true, at: Date.now() }) }));
  assert.equal(older.exit, 0);
  const other = await register(bash(`supabase status --workdir ${w.wd('sub detach.stack')}`, w.base), deps(w, snapshotNow(w)));
  assert.equal(other.exit, 0, 'the latest record of sub-detach is `kept`');
});

test('only the last 64 KB of actions.jsonl is read: a stop older than that is invisible, a partial first line is dropped', () => {
  const w = world();
  mkdirSync(w.root, { recursive: true });
  const old = `${JSON.stringify({ t: '2026-10-19T00:00:00.000Z', project: 'p', action: 'stopped' })}\n`;
  const filler = `${JSON.stringify({ t: '2026-10-19T00:00:01.000Z', project: 'q', action: 'kept', pad: 'x'.repeat(200) })}\n`;
  writeFileSync(w.files.actions, old + filler.repeat(400));
  const r = readTailLines(w.files.actions, 64 * 1024);
  assert.equal(r.ok, true);
  assert.ok(r.value.every((l) => JSON.parse(l).project === 'q'));
  assert.deepEqual(readTailLines(join(w.root, 'nope.jsonl')), ok([]));
});

// ---- the worktree field ----
test('worktree: a cwd outside .worktrees and the configured repos is "none" without any git call', async () => {
  const w = world();
  const calls = [];
  const run = (...a) => { calls.push(a); return { code: 0, stdout: '/x\n', stderr: '', timedOut: false, signal: null }; };
  const r = await register(bash(`supabase status --workdir ${w.wd('sa-corrections.stack')}`, w.base), deps(w, { worktree: undefined, run }));
  assert.equal(r.events[0].worktree, 'none');
  assert.equal(calls.length, 0);
});

test('worktree: inside .worktrees or a configured repo => git rev-parse --show-toplevel of the cwd, bounded by the deadline', async () => {
  const w = world();
  const calls = [];
  const run = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { code: 0, stdout: `${w.wtCwd}\n`, stderr: '', timedOut: false, signal: null }; };
  const command = `supabase status --workdir ${w.wd('sa-corrections.stack')}`;
  const r = await register(bash(command, join(w.wtCwd, 'sub')), deps(w, { worktree: undefined, run, deadlineMs: 1200 }));
  assert.equal(r.events[0].worktree, w.wtCwd);
  assert.deepEqual([calls[0].cmd, calls[0].args], ['git', ['rev-parse', '--show-toplevel']]);
  assert.equal(calls[0].opts.cwd, join(w.wtCwd, 'sub'));
  assert.ok(calls[0].opts.timeoutMs <= 1200 && calls[0].opts.timeoutMs >= 1, `git timeout ${calls[0].opts.timeoutMs}`);

  const inRepo = await register(bash(command, join(w.base, 'repo', 'src')), deps(w, { worktree: undefined, run, cfg: { ...CFG, repos: [join(w.base, 'repo')] } }));
  assert.equal(inRepo.events[0].worktree, w.wtCwd);
  assert.equal(calls.length, 2);
});

test('worktree: git "not a repository" => none; a git timeout or signal => exit 2', async () => {
  const w = world();
  const command = `supabase status --workdir ${w.wd('sa-corrections.stack')}`;
  const notRepo = () => ({ code: 128, stdout: '', stderr: 'fatal: not a git repository (or any of the parent directories): .git', timedOut: false, signal: null });
  const r = await register(bash(command, w.wtCwd), deps(w, { worktree: undefined, run: notRepo }));
  assert.equal(r.events[0].worktree, 'none');
  for (const bad of [{ code: 1, stdout: '', stderr: '', timedOut: true, signal: null }, { code: 1, stdout: '', stderr: '', timedOut: false, signal: 'SIGKILL' }, { code: 1, stdout: '', stderr: 'boom', timedOut: false, signal: null }]) {
    const f = await register(bash(command, w.wtCwd), deps(w, { worktree: undefined, run: () => bad }));
    assert.equal(f.exit, 2);
    assert.match(f.message, /worktree lookup failed/);
  }
});

// ---- one deadline for everything (R2-2) ----
test('one deadline: the same deadlineAt reaches the inventory refresh, the owner lookup, the lock wait and the ledger append', async () => {
  const w = world();
  const seen = {};
  const before = Date.now();
  const r = await register(bash(`supabase status --workdir ${w.wd('sa-corrections.stack')}`, w.base), deps(w, {
    deadlineMs: 5000,
    inventory: () => ({ inv: null, fresh: false }),
    refreshInventory: async (o) => { seen.refresh = o.deadlineAt; return ok(w.inv); },
    owner: (o) => { seen.owner = o.deadlineAt; return ok(OWNER); },
    acquire: async (name, o) => { seen.lockWait = o.waitMs; return (await import('../pipeline/lib/locks.mjs')).acquire(name, o); },
    appendEvent: async (file, event, o) => { seen.append = o.deadlineAt; return ok(undefined); },
  }));
  assert.equal(r.exit, 0);
  assert.equal(seen.refresh, seen.owner);
  assert.equal(seen.owner, seen.append);
  assert.ok(seen.refresh >= before + 5000 && seen.refresh <= Date.now() + 5000);
  assert.ok(seen.lockWait <= 5000 && seen.lockWait > 3000, `lock wait ${seen.lockWait}`);
});

test('a failure after the deadline says so ("deadline")', async () => {
  const w = world();
  const r = await register(bash(`supabase status --workdir ${w.wd('sa-corrections.stack')}`, w.base), deps(w, {
    deadlineMs: 30,
    inventory: () => ({ inv: null, fresh: false }),
    refreshInventory: async () => { await new Promise((res) => setTimeout(res, 60)); return unknown('docker ps timed out'); },
  }));
  assert.equal(r.exit, 2);
  assert.match(r.message, /deadline of 30 ms exceeded: inventory unavailable: docker ps timed out/);
});

// ---- Review Focus 3: a big ledger is never read ----
function bigLedger(file, n = 100000) {
  mkdirSync(dirname(file), { recursive: true });
  const line = `${JSON.stringify({ t: '2026-10-01T00:00:00.000Z', kind: 'use', project: 'old-project', session_id: 's0', owner: { pid: 1, birth: 1 }, cwd: '/x', worktree: 'none', tool: 'Bash' })}\n`;
  writeFileSync(file, line.repeat(n));
}

test('Review Focus 3: with a 100 000-line ledger, an unrelated command and a matching command are fast and never read the ledger', async () => {
  const w = world();
  bigLedger(w.files.ledger);
  const before = readFileSync(w.files.ledger).length;
  const reads = [];
  const originals = {};
  for (const op of ['readFileSync', 'openSync', 'createReadStream']) {
    originals[op] = fs[op];
    fs[op] = function spied(target, ...rest) {
      reads.push([op, String(target), rest[0]]);
      return originals[op].call(this, target, ...rest);
    };
  }
  try {
    const t0 = performance.now();
    const unrelated = await register(bash('git status', w.base), deps(w));
    const unrelatedMs = performance.now() - t0;
    const t1 = performance.now();
    const matching = await register(bash(`supabase status --workdir ${w.wd('sa-corrections.stack')}`, w.base), deps(w));
    const matchingMs = performance.now() - t1;
    assert.equal(unrelated.exit, 0);
    assert.equal(matching.exit, 0);
    assert.ok(unrelatedMs < 1000, `unrelated took ${unrelatedMs} ms`);
    assert.ok(matchingMs < 1000, `matching took ${matchingMs} ms`);
    console.log(`# in-process, 100k-line ledger: unrelated ${unrelatedMs.toFixed(1)} ms, matching ${matchingMs.toFixed(1)} ms`);
  } finally {
    Object.assign(fs, originals);
  }
  const ledgerOps = reads.filter(([, file]) => file === w.files.ledger);
  assert.ok(ledgerOps.every(([op, , flags]) => op === 'openSync' && flags === 'a'), `the ledger was opened for something other than append: ${JSON.stringify(ledgerOps)}`);
  assert.ok(readFileSync(w.files.ledger).length > before, 'the lease was appended');
});

// ---- Windows ----
test('win32: exits 0 at once; no run, no fs call', async () => {
  const names = ['readFileSync', 'openSync', 'statSync', 'mkdirSync', 'appendFileSync', 'writeFileSync', 'existsSync', 'readdirSync'];
  const spies = names.map((n) => mock.method(fs, n, () => { throw new Error(`fs.${n} called on win32`); }));
  try {
    const run = () => { throw new Error('run called on win32'); };
    const fail = () => { throw new Error('dependency called on win32'); };
    const r = await register(bash('supabase status', 'C:\\w'), { platform: 'win32', run, owner: fail, acquire: fail, appendEvent: fail, refreshInventory: fail, inventory: fail });
    assert.deepEqual(r, { exit: 0, events: [] });
  } finally {
    for (const s of spies) s.mock.restore();
  }
});

// ---- seams (R3-2) ----
test('resolveSeams: PIPELINE_PS / PIPELINE_DOCKER / the deadline are honoured only for an isolated run in the checkout', () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'stacks-seam-')));
  const custom = join(home, 'custom');
  const overrides = { PIPELINE_PS: '/fake/ps', PIPELINE_DOCKER: '/fake/docker', PIPELINE_STACKS_DEADLINE_MS: '1500' };
  const honoured = resolveSeams({ env: { ...overrides, PIPELINE_STACKS_HOME: custom, PIPELINE_STACKS_ONLY: 'x' }, home });
  assert.deepEqual([honoured.ps, honoured.docker, honoured.deadlineMs], ['/fake/ps', '/fake/docker', 1500]);
  const noHome = resolveSeams({ env: overrides, home });
  assert.equal(noHome.ps, undefined);
  assert.notEqual(noHome.docker, '/fake/docker');
  assert.equal(noHome.deadlineMs, DEFAULT_DEADLINE_MS);
  const defaultRoot = resolveSeams({ env: { ...overrides, PIPELINE_STACKS_HOME: join(home, '.claude', 'pipeline-state', 'stacks'), PIPELINE_STACKS_ONLY: 'x' }, home });
  assert.equal(defaultRoot.ps, undefined);
  assert.equal(defaultRoot.deadlineMs, DEFAULT_DEADLINE_MS);
  const noOnly = resolveSeams({ env: { ...overrides, PIPELINE_STACKS_HOME: custom }, home });
  assert.equal(noOnly.ps, undefined);
});

test('resolveSeams: an installed copy ignores every override whatever else is set', () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'stacks-seam-')));
  const installed = join(home, 'pipeline-copy');
  mkdirSync(installed, { recursive: true });
  writeFileSync(join(installed, 'INSTALLED.json'), '{}');
  const overrides = { PIPELINE_PS: '/fake/ps', PIPELINE_DOCKER: '/fake/docker', PIPELINE_STACKS_DEADLINE_MS: '1500', PIPELINE_STACKS_ONLY: 'x' };
  const warn = () => {};
  for (const stateHome of [join(home, '.claude', 'pipeline-state', 'stacks'), join(home, 'custom')]) {
    const s = resolveSeams({ env: { ...overrides, PIPELINE_STACKS_HOME: stateHome }, home, root: installed, warn });
    assert.equal(s.ps, undefined, stateHome);
    assert.notEqual(s.docker, '/fake/docker', stateHome);
    assert.equal(s.deadlineMs, DEFAULT_DEADLINE_MS, stateHome);
  }
});

// ---- end to end: the real hook, fake docker / ps ----
// `configured` writes an (empty, valid) machine config: without one the feature is inert and a registration failure never blocks.
function e2e({ stacks, docker = {}, ps = {}, projects = 'sa-corrections', configured = true } = {}) {
  const w = world();
  if (configured) {
    mkdirSync(w.root, { recursive: true });
    writeFileSync(w.files.config, '{}');
  }
  const dir = join(w.base, 'fake');
  mkdirSync(dir, { recursive: true });
  const sa = w.stacks[0];
  const containers = [
    container({ id: 'k1', name: '/supabase_kong_sa-corrections', project: 'sa-corrections', workdir: sa.workdir, ports: { '8000/tcp': [{ HostPort: '54421' }] } }),
    container({ id: 'd1', name: '/supabase_db_sa-corrections', project: 'sa-corrections', workdir: sa.workdir, ports: { '5432/tcp': [{ HostPort: '54422' }] }, dbVolume: 'vol' }),
  ];
  const dockerScenario = join(dir, 'docker.json');
  const psScenario = join(dir, 'ps.json');
  writeFileSync(dockerScenario, JSON.stringify({ ps: 'k1\nd1\n', inspect: containers, log: join(dir, 'docker.log'), ...docker }));
  writeFileSync(psScenario, JSON.stringify({ procs: { [process.pid]: { ppid: 1, comm: 'claude', lstart: LSTART } }, log: join(dir, 'ps.log'), ...ps }));
  const env = {
    ...process.env,
    HOME: w.base,
    PIPELINE_STACKS_HOME: w.root,
    PIPELINE_STACKS_ONLY: projects,
    PIPELINE_DOCKER: FAKE_DOCKER,
    PIPELINE_PS: FAKE_PS,
    FAKE_DOCKER_SCENARIO: dockerScenario,
    FAKE_PS_SCENARIO: psScenario,
    PIPELINE_MACHINE_ID: 'test-machine-id',
    PIPELINE_STACKS_DEADLINE_MS: '1500',
  };
  const hook = (input, { nodeArgs = [], extraEnv = {}, entry } = {}) => {
    const started = performance.now();
    const r = spawnSync(process.execPath, [...nodeArgs, ...(entry ?? [HOOK])], { input: JSON.stringify(input), env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 25000 });
    return { status: r.status, stderr: r.stderr, stdout: r.stdout, ms: performance.now() - started };
  };
  return { w, dir, sa, env, hook, calls: (name) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), 'utf8').split('\n').filter(Boolean).length : 0), dockerScenario, psScenario };
}

test('e2e: a command naming a private stack => exit 0, one lease with the owner identity; ps is run in UTC', posixOnly, () => {
  const x = e2e();
  const r = x.hook(bash(`supabase status --workdir ${x.sa.workdir}`, x.w.base));
  assert.equal(r.status, 0, r.stderr);
  const [e] = lines(x.w.files.ledger);
  assert.deepEqual([e.kind, e.project, e.owner], ['use', 'sa-corrections', { pid: process.pid, birth: parseLstart(LSTART) }]);
  assert.ok(x.calls('docker.log') >= 2);
  assert.match(readFileSync(join(x.dir, 'ps.log'), 'utf8'), /"TZ":"UTC","LC_ALL":"C"/);
  // the second call is served from the 60 s cache: no new docker call
  const before = x.calls('docker.log');
  assert.equal(x.hook(bash(`supabase status --workdir ${x.sa.workdir}`, x.w.base)).status, 0);
  assert.equal(x.calls('docker.log'), before);
  assert.equal(lines(x.w.files.ledger).length, 2);
});

test('e2e: the same hook through the installer\'s fail-closed loader registers too', posixOnly, () => {
  const x = e2e();
  const r = x.hook(bash(`supabase status --workdir ${x.sa.workdir}`, x.w.base), { nodeArgs: ['--input-type=module', '-e', HOOK_LOADER], entry: [HOOK] });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(lines(x.w.files.ledger).length, 1);
});

test('e2e: a fake docker that hangs past the deadline => exit 2 "deadline" in well under 30 s; paused => exit 0', posixOnly, () => {
  const x = e2e({ docker: { sleepMs: 8000 } });
  const command = `supabase status --workdir ${x.sa.workdir}`;
  const r = x.hook(bash(command, x.w.base));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /deadline/);
  assert.match(r.stderr, /autostop could not register use of stack/);
  assert.ok(r.ms < 6000, `took ${r.ms} ms`);
  console.log(`# e2e docker hang, deadline 1500 ms: exit ${r.status} after ${r.ms.toFixed(0)} ms`);
  assert.equal(existsSync(x.w.files.ledger), false);
  mkdirSync(x.w.root, { recursive: true });
  writeFileSync(x.w.files.pause, '');
  const p = x.hook(bash(command, x.w.base));
  assert.equal(p.status, 0);
  assert.equal(p.stderr, '');
});

test('e2e: a fake ps that hangs past the deadline => exit 2 "deadline" in well under 30 s', posixOnly, () => {
  const x = e2e({ ps: { sleepMs: 8000 } });
  const r = x.hook(bash(`supabase status --workdir ${x.sa.workdir}`, x.w.base));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /deadline/);
  assert.match(r.stderr, /owner not found/);
  assert.ok(r.ms < 6000, `took ${r.ms} ms`);
  console.log(`# e2e ps hang, deadline 1500 ms: exit ${r.status} after ${r.ms.toFixed(0)} ms`);
});

test('e2e: docker daemon down => exit 0; owner not found => exit 2 (fake ps knows no process)', posixOnly, () => {
  const down = e2e({ docker: { down: true } });
  assert.equal(down.hook(bash(`supabase status --workdir ${down.sa.workdir}`, down.w.base)).status, 0);
  const lost = e2e({ ps: { procs: {} } });
  const r = lost.hook(bash(`supabase status --workdir ${lost.sa.workdir}`, lost.w.base));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /owner not found/);
  // R1-B6: the same failure on a machine with no config (the PC, hooks installed before any config) blocks nothing
  const bare = e2e({ ps: { procs: {} }, configured: false });
  const b = bare.hook(bash(`supabase status --workdir ${bare.sa.workdir}`, bare.w.base));
  assert.equal(b.status, 0, b.stderr);
  assert.match(readFileSync(bare.w.files.log, 'utf8'), /not configured, allowing: could not register use of stack/);
});

test('e2e: npm run dev writes a dev event without any docker call', posixOnly, () => {
  const x = e2e();
  const r = x.hook(bash('npm run dev', x.w.base));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(x.calls('docker.log'), 0);
  assert.deepEqual(lines(x.w.files.ledger).map((e) => [e.kind, e.port]), [['dev', 3000]]);
});

test('e2e: bad stdin fails closed (exit 2), or exits 0 while paused', posixOnly, () => {
  const x = e2e();
  const run = () => spawnSync(process.execPath, [HOOK], { input: 'not json', env: x.env, encoding: 'utf8' });
  const r = run();
  assert.equal(r.status, 2);
  assert.match(r.stderr, /autostop could not register use of stack/);
  mkdirSync(x.w.root, { recursive: true });
  writeFileSync(x.w.files.pause, '');
  assert.equal(run().status, 0);
});

test('e2e R3-2: with PIPELINE_STACKS_HOME unset the fake ps / docker and the deadline override are not used', posixOnly, () => {
  const x = e2e();
  const home = x.w.base;
  const defaultRoot = join(home, '.claude', 'pipeline-state', 'stacks');
  mkdirSync(defaultRoot, { recursive: true });
  // a fresh cache so no docker is needed at all; the owner lookup then runs the REAL ps, never the fake
  writeFileSync(join(defaultRoot, 'inventory.json'), JSON.stringify({ writtenAt: Date.now(), inventory: x.w.inv }));
  const env = { ...x.env };
  delete env.PIPELINE_STACKS_HOME;
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(bash(`supabase status --workdir ${x.sa.workdir}`, home)), env, encoding: 'utf8', timeout: 25000 });
  assert.equal(x.calls('ps.log'), 0, 'the PIPELINE_PS override must not be used');
  assert.equal(x.calls('docker.log'), 0, 'the PIPELINE_DOCKER override must not be used');
  assert.doesNotMatch(r.stderr, /deadline of 1500 ms/, 'PIPELINE_STACKS_DEADLINE_MS must not be used');
  // control: with the isolated root the fake ps IS used
  assert.equal(x.hook(bash(`supabase status --workdir ${x.sa.workdir}`, home)).status, 0);
  assert.ok(x.calls('ps.log') > 0);
});

test('e2e Review Focus 3: a 100 000-line ledger is never read; unrelated and matching calls each take < 1000 ms', posixOnly, () => {
  const x = e2e();
  bigLedger(x.w.files.ledger);
  const spyLog = join(x.dir, 'spy.log');
  // The child's own CPU time (user + system at exit, written by CPU_PROBE), not the clock: a busy machine (load 70+) failed the wall-clock form twice.
  // The hook's own deadline is the default 20 s here, not the harness's 1.5 s: at load 100+ the cache refresh through the fake docker outlasted
  // 1.5 s of clock and the hook failed closed (exit 2). The deadline has tests of its own (the docker / ps hang tests above).
  const run = (name, command) => {
    const cpuLog = join(x.dir, `cpu-${name}.log`);
    const r = x.hook(bash(command, x.w.base), { nodeArgs: ['--import', SPY, '--import', CPU_PROBE], extraEnv: { FS_SPY_LOG: spyLog, CPU_PROBE_LOG: cpuLog, PIPELINE_STACKS_DEADLINE_MS: '20000' } });
    return { ...r, cpu: Number(readFileSync(cpuLog, 'utf8')) };
  };
  const matchingCommand = `supabase status --workdir ${x.sa.workdir}`;
  const unrelated = run('unrelated', 'git status');
  assert.equal(unrelated.status, 0, unrelated.stderr);
  const first = run('first', matchingCommand); // refreshes the cache through the fake docker
  const matching = run('matching', matchingCommand); // cache hit: the steady state
  assert.equal(first.status, 0, first.stderr);
  assert.equal(matching.status, 0, matching.stderr);
  const both = (r) => `${r.cpu.toFixed(0)} ms CPU (${r.ms.toFixed(0)} ms clock)`;
  console.log(`# e2e, 100k-line ledger (whole process incl. node start): unrelated ${both(unrelated)}, matching (cache refresh) ${both(first)}, matching (cache hit) ${both(matching)}`);
  for (const [what, r] of [['unrelated', unrelated], ['matching', matching], ['matching with a refresh', first]]) {
    assert.ok(Number.isFinite(r.cpu) && r.cpu > 0, `${what}: no CPU reading from the child`);
    assert.ok(r.cpu < 1000, `${what} took ${r.cpu} ms of CPU (${r.ms} ms of clock)`);
  }
  const ops = readFileSync(spyLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const onLedger = ops.filter((o) => o.file === x.w.files.ledger);
  assert.ok(onLedger.every((o) => o.op === 'openSync' && o.flags === 'a'), `ledger opened other than for append: ${JSON.stringify(onLedger)}`);
  assert.ok(ops.length > 0, 'the spy saw the hook');
  assert.equal(lines(x.w.files.ledger).length, 100002);
});
