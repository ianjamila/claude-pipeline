// Session end: the hook that starts a detached worker, and the worker that decides what to stop once the session's Claude
// process is gone. Pure tests inject every dependency (clock, sleep, process liveness, probes, a scriptable Docker/Supabase
// "world" that records every call); the end-to-end tests spawn the real hook / CLI with fake binaries and a throwaway state root.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runSessionEnd, sessionEndHook, observedUses, readWorkerFile, workerFilePath, WAIT_MS } from '../pipeline/lib/stacks/session-end.mjs';
import { register } from '../pipeline/lib/stacks/register.mjs';
import { readInventory } from '../pipeline/lib/stacks/inventory.mjs';
import { stopArgs } from '../pipeline/lib/stacks/act.mjs';
import { appendEvent } from '../pipeline/lib/stacks/ledger.mjs';
import { readDecisions, outcomeSummary, appendDecision, WINDOW_MS } from '../pipeline/lib/stacks/outcomes.mjs';
import { stackFiles, lockDirs } from '../pipeline/lib/stacks/paths.mjs';
import { parseLstart } from '../pipeline/lib/stacks/identity.mjs';
import { ok, unknown } from '../pipeline/lib/stacks/result.mjs';
import { acquire as realAcquire } from '../pipeline/lib/locks.mjs';
import { parseOwner, run as runStacksCommand } from '../pipeline/commands/stacks.mjs';
import { UsageError } from '../pipeline/lib/cli.mjs';
import { fakeDocker, container } from './fixtures/fake-docker.mjs';

process.env.PIPELINE_MACHINE_ID ||= 'test-machine-id'; // lock owner records never create ~/.claude/pipeline-state/machine-id

const posixOnly = { skip: process.platform === 'win32' && 'POSIX only' };
const here = dirname(fileURLToPath(import.meta.url));
const HOOK = join(here, '..', 'pipeline', 'hooks', 'stack-session-end.mjs');
const CLI = join(here, '..', 'pipeline', 'bin', 'pipeline.mjs');
const FAKE_DOCKER = join(here, 'fixtures', 'fake-docker-bin.mjs');
const FAKE_PS = join(here, 'fixtures', 'fake-ps-bin.mjs');
const SUPA = '/fake/bin/supabase';
const DB_VOLUME = 'supabase_db_alpha';
const GEN_ID = 'dbid0001';
const LSTART = 'Mon Oct 19 02:47:17 2026';
const T0 = Date.UTC(2026, 9, 19, 12, 0, 0);
const OWNER = { pid: 100, birth: 1000 };
const OWNER_B = { pid: 101, birth: 1001 };
const OTHER = { pid: 222, birth: 2000 };
const key = (o) => `${o.pid}:${o.birth}`;

// ---- a fake clock: sleep advances it, nothing really waits ----
function clock(start = T0) {
  const c = { t: start, sleeps: [], now: () => c.t };
  c.sleep = async (ms) => {
    c.sleeps.push(ms);
    c.t += ms;
  };
  return c;
}

// ---- a throwaway world: state root, a real workdir, a Docker whose containers change when `supabase stop` runs ----
function makeWorld({ mode = 'apply', config = true, devMode = 'report' } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'stacks-se-')));
  const root = join(base, 'state');
  mkdirSync(root, { recursive: true });
  const files = stackFiles(root);
  if (config) writeFileSync(files.config, '{}');
  writeFileSync(files.mode, JSON.stringify({ sessionEnd: mode, sweeper: mode, devServers: devMode }));
  const workdir = join(base, 'alpha.stack');
  mkdirSync(join(workdir, 'supabase'), { recursive: true });
  writeFileSync(join(workdir, 'supabase', 'config.toml'), 'project_id = "alpha"\n');
  const w = { base, root, files, workdir, alive: new Set(), supabaseCalls: [], dockerCalls: [], present: true, volumes: [DB_VOLUME], devCalls: [] };
  w.container = () => container({ id: GEN_ID, name: '/supabase_db_alpha', project: 'alpha', workdir, running: true, ports: { '5432/tcp': [{ HostPort: '54322' }] }, dbVolume: DB_VOLUME });
  w.run = (cmd, args = [], opts = {}) => {
    if (cmd === SUPA) {
      w.supabaseCalls.push([...args]);
      w.present = false; // the Supabase CLI removes its containers on stop
      return { code: 0, stdout: '', stderr: '', timedOut: false, signal: null, pid: 1 };
    }
    const d = fakeDocker({ ps: w.present ? `${GEN_ID}\n` : '', inspect: w.present ? [w.container()] : [], volumes: w.volumes });
    const r = d(cmd, args, opts);
    w.dockerCalls.push(...d.calls);
    return r;
  };
  w.lease = (owner, over = {}) => appendEvent(files.ledger, { t: new Date(T0 - 60_000).toISOString(), kind: 'use', owner, project: 'alpha', workdir, worktree: 'none', tool: 'Bash', via: 'test', ...over }, { lockDir: lockDirs(root).ledger });
  w.actions = () => (existsSync(files.actions) ? readFileSync(files.actions, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  w.workerFile = join(root, 'workers', 'self.json');
  w.cleanup = () => rmSync(base, { recursive: true, force: true });
  return w;
}

const quiet = { connections: () => ok([]), processRefs: () => ok([]), cwdInside: () => ok([]), consumerWorktrees: () => ok([]) };

function depsFor(w, c, over = {}) {
  return {
    env: {}, platform: 'linux', home: w.base, root: w.root, files: w.files, now: c.now, sleep: c.sleep, run: w.run, docker: 'docker', supabaseBin: SUPA,
    bins: { lsof: 'LSOF', ps: 'PS' }, isAlive: (o) => ok(w.alive.has(key(o))), iso: { isDefault: false, only: null }, evidence: quiet,
    memoryOfProject: () => ok(2 * 1024 ** 3), workerFile: w.workerFile, lockWaitMs: 1500, lockPollMs: 10,
    devSessionEnd: async (owner, events, d) => { w.devCalls.push({ owner, events, d }); return []; },
    ...over,
  };
}

async function withWorld(opts, fn) {
  const w = makeWorld(opts);
  try {
    return await fn(w, clock());
  } finally {
    w.cleanup();
  }
}

// every supabase call in every test is exactly the one safe argv
function assertSafe(w) {
  for (const argv of w.supabaseCalls) assert.deepEqual(argv, stopArgs(w.workdir));
  for (const c of w.dockerCalls) assert.ok(!c.args.includes('rm') && !c.args.includes('stop') && !(c.args[0] === 'volume' && c.args[1] === 'rm'), `forbidden docker call ${c.args.join(' ')}`);
}

// ======================================================================= the hook (lib)

function hookWorld() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'stacks-hook-')));
  const root = join(base, 'state');
  const files = stackFiles(root);
  const spawned = [];
  const logs = [];
  const child = { pid: 4321, unrefd: false, unref() { this.unrefd = true; }, on() {} };
  const deps = {
    env: {}, platform: 'linux', home: base, root, files, now: () => T0, log: (l) => logs.push(l),
    findOwner: () => ok(OWNER), pipelineBin: '/pipeline/bin/pipeline.mjs', execPath: '/node',
    spawn: (cmd, args, opts) => { spawned.push({ cmd, args, opts }); return child; },
  };
  return { base, root, files, spawned, logs, child, deps, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

test('hook: reason clear => no spawn, nothing written', async () => {
  const h = hookWorld();
  try {
    const r = await sessionEndHook({ reason: 'clear', session_id: 's' }, h.deps);
    assert.equal(r.exit, 0);
    assert.equal(r.spawned, false);
    assert.equal(h.spawned.length, 0);
    assert.equal(existsSync(h.root), false);
  } finally {
    h.cleanup();
  }
});

test('hook: prompt_input_exit => exactly one detached, unref\'d spawn with the owner argument, logged to the log file, worker file written', async () => {
  const h = hookWorld();
  try {
    const t0 = Date.now();
    const r = await sessionEndHook({ reason: 'prompt_input_exit', session_id: 's', cwd: h.base }, h.deps);
    assert.ok(Date.now() - t0 < 2000);
    assert.equal(r.exit, 0);
    assert.equal(r.spawned, true);
    assert.equal(h.spawned.length, 1);
    const { cmd, args, opts } = h.spawned[0];
    assert.equal(cmd, '/node');
    assert.deepEqual(args, ['/pipeline/bin/pipeline.mjs', 'stacks', 'session-end', '--owner', '100:1000']);
    assert.equal(opts.detached, true);
    assert.equal(opts.stdio[0], 'ignore');
    assert.ok(Number.isInteger(opts.stdio[1]) && opts.stdio[1] === opts.stdio[2], 'stdout and stderr go to the log file descriptor');
    assert.equal(h.child.unrefd, true);
    assert.equal(opts.cwd, h.root, 'the worker does not start inside a session worktree');
    assert.deepEqual(JSON.parse(readFileSync(workerFilePath(h.files, 4321), 'utf8')), {
      pid: 4321, owner: OWNER, startedAt: new Date(T0).toISOString(), phase: 'waiting', decidedAt: null, decisions: 0,
    });
  } finally {
    h.cleanup();
  }
});

test('hook: every reason but clear starts a worker (exit, logout, other, none given)', async () => {
  for (const input of [{ reason: 'logout' }, { reason: 'other' }, { reason: 'bypass_permissions_disabled' }, {}]) {
    const h = hookWorld();
    try {
      await sessionEndHook(input, h.deps);
      assert.equal(h.spawned.length, 1, JSON.stringify(input));
    } finally {
      h.cleanup();
    }
  }
});

test('hook: owner unknown => log, exit 0, no spawn', async () => {
  const h = hookWorld();
  try {
    const r = await sessionEndHook({ reason: 'other' }, { ...h.deps, findOwner: () => unknown('no Claude Code process above the hook') });
    assert.equal(r.exit, 0);
    assert.equal(r.why, 'owner unknown');
    assert.equal(h.spawned.length, 0);
    assert.match(h.logs.join('\n'), /owner not found \(no Claude Code process above the hook\)/);
  } finally {
    h.cleanup();
  }
});

test('hook: a spawn that throws or yields no pid is only a log line; Windows touches nothing', async () => {
  let h = hookWorld();
  try {
    const r = await sessionEndHook({ reason: 'other' }, { ...h.deps, spawn: () => { throw new Error('EAGAIN'); } });
    assert.deepEqual([r.exit, r.spawned], [0, false]);
    assert.match(h.logs.join('\n'), /failed: EAGAIN/);
    const r2 = await sessionEndHook({ reason: 'other' }, { ...h.deps, spawn: () => ({ unref() {}, on() {} }) });
    assert.equal(r2.spawned, false);
    assert.match(h.logs.join('\n'), /no pid/);
  } finally {
    h.cleanup();
  }
  h = hookWorld();
  try {
    const boom = () => { throw new Error('must not be called on Windows'); };
    const r = await sessionEndHook({ reason: 'other' }, { ...h.deps, platform: 'win32', findOwner: boom, spawn: boom, run: boom });
    assert.deepEqual([r.exit, r.spawned], [0, false]);
    assert.equal(existsSync(h.root), false);
  } finally {
    h.cleanup();
  }
});

// ======================================================================= the hook (end to end)

function e2e() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'stacks-se-e2e-')));
  const root = join(base, 'state');
  mkdirSync(root, { recursive: true });
  const psScenario = join(base, 'ps.json');
  const dockerScenario = join(base, 'docker.json');
  writeFileSync(psScenario, JSON.stringify({ procs: { [process.pid]: { ppid: 1, comm: 'claude', lstart: LSTART } } }));
  writeFileSync(dockerScenario, JSON.stringify({ down: true }));
  const env = {
    ...process.env, HOME: base, PIPELINE_STACKS_HOME: root, PIPELINE_STACKS_ONLY: 'alpha', PIPELINE_PS: FAKE_PS, PIPELINE_DOCKER: FAKE_DOCKER,
    FAKE_PS_SCENARIO: psScenario, FAKE_DOCKER_SCENARIO: dockerScenario, PIPELINE_MACHINE_ID: 'test-machine-id',
  };
  const hook = (input, over = {}) => {
    const t0 = performance.now();
    const r = spawnSync(process.execPath, [HOOK], { input: typeof input === 'string' ? input : JSON.stringify(input), env: { ...env, ...over }, encoding: 'utf8', timeout: 20000 });
    return { status: r.status, stderr: r.stderr, ms: performance.now() - t0 };
  };
  return { base, root, env, psScenario, hook, files: stackFiles(root), cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

test('e2e hook: a real detached worker is started for the owner and survives the hook; /clear starts nothing', posixOnly, () => {
  const e = e2e();
  let workerPid = null;
  try {
    writeFileSync(e.files.config, '{}'); // configured, so the worker keeps waiting for the owner (which the fake ps says is alive)
    const cleared = e.hook({ reason: 'clear' });
    assert.equal(cleared.status, 0);
    assert.equal(existsSync(e.files.workers), false);

    const r = e.hook({ reason: 'prompt_input_exit', session_id: 's1', cwd: e.base });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.ms < 2500, `the hook took ${Math.round(r.ms)} ms`);
    const names = readdirSync(e.files.workers).filter((n) => n.endsWith('.json'));
    assert.equal(names.length, 1);
    workerPid = Number(names[0].replace('.json', ''));
    const wf = readWorkerFile(join(e.files.workers, names[0])).value;
    assert.equal(wf.pid, workerPid);
    assert.deepEqual(wf.owner, { pid: process.pid, birth: parseLstart(LSTART) });
    assert.equal(wf.phase, 'waiting');
    assert.doesNotThrow(() => process.kill(workerPid, 0), 'the worker outlives the hook');
    const cmd = execFileSync('/bin/ps', ['-o', 'command=', '-p', String(workerPid)], { encoding: 'utf8' });
    assert.match(cmd, new RegExp(`stacks session-end --owner ${process.pid}:${parseLstart(LSTART)}`));
    const pgid = Number(execFileSync('/bin/ps', ['-o', 'pgid=', '-p', String(workerPid)], { encoding: 'utf8' }).trim());
    assert.equal(pgid, workerPid, 'detached: the worker leads its own process group');
    assert.ok(existsSync(e.files.log), 'the worker log file exists (stdio goes there)');
  } finally {
    if (workerPid) {
      try { process.kill(workerPid, 'SIGKILL'); } catch { /* already gone */ }
    }
    e.cleanup();
  }
});

test('e2e hook: no Claude above the hook, a hung ps, garbage stdin => exit 0 within 2.5 s, no worker', posixOnly, () => {
  const e = e2e();
  try {
    writeFileSync(e.psScenario, JSON.stringify({ procs: {} }));
    let r = e.hook({ reason: 'other' });
    assert.equal(r.status, 0);
    assert.equal(existsSync(e.files.workers), false);
    assert.match(readFileSync(e.files.log, 'utf8'), /session-end hook owner not found/);
    writeFileSync(e.psScenario, JSON.stringify({ procs: { [process.pid]: { ppid: 1, comm: 'claude', lstart: LSTART } }, sleepMs: 6000 }));
    r = e.hook({ reason: 'other' });
    assert.equal(r.status, 0);
    assert.ok(r.ms < 2500, `a hung ps held the hook for ${Math.round(r.ms)} ms`);
    assert.equal(existsSync(e.files.workers), false);
    r = e.hook('this is not json');
    assert.equal(r.status, 0);
    assert.match(readFileSync(e.files.log, 'utf8'), /session-end hook failed/);
  } finally {
    e.cleanup();
  }
});

test('e2e worker through the CLI: not configured => records it and decides nothing; configured + docker down => decided, nothing stopped', posixOnly, () => {
  const e = e2e();
  try {
    const gone = 4194301; // no such process: the fake ps answers "gone" and kill(pid, 0) says ESRCH
    const run = () => spawnSync(process.execPath, [CLI, 'stacks', 'session-end', '--owner', `${gone}:${parseLstart(LSTART)}`], { env: e.env, encoding: 'utf8', timeout: 30000 });
    let r = run();
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).status, 'not configured');
    assert.match(readFileSync(e.files.log, 'utf8'), /session-end not configured/);
    writeFileSync(e.files.config, '{}');
    r = run();
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, true);
    assert.equal(out.status, 'decided');
    assert.deepEqual(out.stacks, []);
    assert.equal(existsSync(e.files.actions), false);
  } finally {
    e.cleanup();
  }
});

// ======================================================================= the stacks command

test('stacks session-end: --owner is required and must be PID:BIRTH; an unknown subcommand is a usage error', async () => {
  assert.deepEqual(parseOwner('123:1792378037'), { pid: 123, birth: 1792378037 });
  for (const bad of [undefined, '', '123', '123:', ':5', 'a:b', '0:5', '-1:5', '1:2:3', '12 :5']) assert.throws(() => parseOwner(bad), UsageError, String(bad));
  if (process.platform === 'win32') return;
  await assert.rejects(() => runStacksCommand(['session-end']), UsageError);
  await assert.rejects(() => runStacksCommand(['session-end', '--owner', 'x']), UsageError);
  await assert.rejects(() => runStacksCommand(['session-end', '--owner', '1:2', '--bogus']), UsageError);
  await assert.rejects(() => runStacksCommand(['bogus']), UsageError);
  await assert.rejects(() => runStacksCommand([]), UsageError);
});

// ======================================================================= the worker

test('config missing => "not configured" recorded, no stack or dev decisions, nothing probed', () => withWorld({ config: false }, async (w, c) => {
  await w.lease(OWNER);
  const r = await runSessionEnd({ owner: OWNER, deps: depsFor(w, c) });
  assert.equal(r.status, 'not configured');
  assert.deepEqual(r.stacks, []);
  assert.equal(w.devCalls.length, 0);
  assert.equal(w.supabaseCalls.length, 0);
  assert.equal(w.dockerCalls.length, 0);
  assert.equal(w.actions().length, 0);
  assert.equal(c.sleeps.length, 0);
  assert.equal(existsSync(w.workerFile), false, 'the worker file is removed');
  assert.match(readFileSync(w.files.log, 'utf8'), /session-end not configured/);
}));

test('config invalid is also "not configured"', () => withWorld({}, async (w, c) => {
  writeFileSync(w.files.config, '{ not json');
  const r = await runSessionEnd({ owner: OWNER, deps: depsFor(w, c) });
  assert.equal(r.status, 'not configured');
  assert.equal(w.devCalls.length, 0);
}));

test('owner still alive after 10 minutes => "session still running", no decisions, nothing touched', () => withWorld({}, async (w, c) => {
  await w.lease(OWNER);
  w.alive.add(key(OWNER));
  const r = await runSessionEnd({ owner: OWNER, deps: depsFor(w, c) });
  assert.equal(r.status, 'session still running');
  assert.ok(r.waited >= WAIT_MS && r.waited < WAIT_MS + 5000, `waited ${r.waited}`);
  assert.ok(c.sleeps.every((ms) => ms === 2000), 'polls every 2 s');
  assert.ok(c.sleeps.length >= 299);
  assert.equal(w.devCalls.length, 0);
  assert.equal(w.supabaseCalls.length, 0);
  assert.equal(w.actions().length, 0);
  assert.match(readFileSync(w.files.log, 'utf8'), /session still running/);
}));

test('owner liveness unknown for 10 minutes is not "gone": nothing is decided', () => withWorld({}, async (w, c) => {
  await w.lease(OWNER);
  const r = await runSessionEnd({ owner: OWNER, deps: depsFor(w, c, { isAlive: () => unknown('ps timed out') }) });
  assert.equal(r.status, 'owner liveness unknown');
  assert.equal(w.supabaseCalls.length, 0);
  assert.equal(w.actions().length, 0);
}));

test('owner exits after a few polls => dev servers first (told when the owner exited), then the stack is stopped and recorded', () => withWorld({}, async (w, c) => {
  await w.lease(OWNER);
  w.alive.add(key(OWNER));
  let polls = 0;
  const isAlive = (o) => { polls += 1; if (polls === 4) w.alive.delete(key(o)); return ok(w.alive.has(key(o))); };
  const r = await runSessionEnd({ owner: OWNER, deps: depsFor(w, c, { isAlive, observeAtMs: [] }) });
  assert.equal(r.status, 'decided');
  assert.equal(r.waited, 6000);
  assert.equal(w.devCalls.length, 1);
  assert.deepEqual(w.devCalls[0].owner, OWNER);
  assert.equal(w.devCalls[0].d.ownerExitedAt, T0 + 6000);
  assert.equal(w.devCalls[0].d.mode, 'report');
  assert.deepEqual(r.stacks.map((s) => [s.project, s.action]), [['alpha', 'stopped']]);
  assert.equal(w.supabaseCalls.length, 1);
  assert.deepEqual(w.supabaseCalls[0], stopArgs(w.workdir));
  const rec = w.actions();
  assert.equal(rec.length, 1);
  assert.equal(rec[0].action, 'stopped');
  assert.equal(rec[0].source, 'session-end');
  assert.equal(rec[0].project, 'alpha');
  assert.deepEqual(rec[0].generation, { id: GEN_ID, startedAt: '2026-10-19T01:00:00.000000000Z' });
  assert.equal(rec[0].memBytes, 2 * 1024 ** 3);
  assert.equal(rec[0].evidence.otherLiveLeases, 0);
  assert.equal(rec[0].t, new Date(T0 + 6000).toISOString());
  assertSafe(w);
}));

test('mode report: the decision is would-stop and supabase is never called', () => withWorld({ mode: 'report' }, async (w, c) => {
  await w.lease(OWNER);
  const r = await runSessionEnd({ owner: OWNER, deps: depsFor(w, c, { observeAtMs: [] }) });
  assert.equal(r.stacks[0].action, 'would-stop');
  assert.equal(w.supabaseCalls.length, 0);
  assert.equal(w.actions()[0].action, 'would-stop');
  assertSafe(w);
}));

test('another LIVE owner also leased the stack => kept, naming that owner; no stop attempted', () => withWorld({}, async (w, c) => {
  await w.lease(OWNER);
  await w.lease(OTHER, { t: new Date(T0 - 30_000).toISOString() });
  w.alive.add(key(OTHER));
  const r = await runSessionEnd({ owner: OWNER, deps: depsFor(w, c, { observeAtMs: [] }) });
  assert.equal(r.stacks[0].action, 'kept');
  assert.match(r.stacks[0].reasons.join('\n'), /otherLiveLeases: 1 live lease\(s\) \(pid 222\)/);
  assert.equal(w.supabaseCalls.length, 0);
  const rec = w.actions();
  assert.equal(rec[0].action, 'kept');
  assert.match(rec[0].reasons.join('\n'), /pid 222/);
}));

test('a surviving process of the exiting session holding a connection => kept (no exemption)', () => withWorld({}, async (w, c) => {
  await w.lease(OWNER);
  const survivor = { pid: 555, birth: T0 / 1000 - 3600, command: 'psql -h 127.0.0.1 -p 54322', port: 54322 };
  const r = await runSessionEnd({ owner: OWNER, deps: depsFor(w, c, { evidence: { ...quiet, connections: () => ok([survivor]) }, observeAtMs: [] }) });
  assert.equal(r.stacks[0].action, 'kept');
  assert.match(r.stacks[0].reasons.join('\n'), /connections: 1 live connection\(s\) \(555 psql/);
  assert.equal(w.supabaseCalls.length, 0);
}));

test('a process with cwd in the stack folder, or a process reference, or an unknown probe => kept', () => withWorld({}, async (w, c) => {
  await w.lease(OWNER);
  const cases = [
    { ...quiet, cwdInside: () => ok([{ pid: 9, birth: 1, dir: w.workdir }]) },
    { ...quiet, processRefs: () => ok([{ pid: 8, birth: 1, command: 'node x --workdir alpha.stack', field: 'cmdline' }]) },
    { ...quiet, processRefs: () => unknown('ps timed out') },
    { ...quiet, consumerWorktrees: () => unknown('cannot read /wt') },
  ];
  for (const evidence of cases) {
    const r = await runSessionEnd({ owner: OWNER, deps: depsFor(w, c, { evidence, observeAtMs: [] }) });
    assert.equal(r.stacks[0].action, 'kept');
  }
  assert.equal(w.supabaseCalls.length, 0);
}));

test('a shared stack, or one outside an isolated run\'s allow list, is never decided about', () => withWorld({}, async (w, c) => {
  await w.lease(OWNER);
  writeFileSync(w.files.config, JSON.stringify({ shared: ['ALPHA'] }));
  let r = await runSessionEnd({ owner: OWNER, deps: depsFor(w, c, { observeAtMs: [] }) });
  assert.deepEqual(r.stacks, []);
  writeFileSync(w.files.config, '{}');
  r = await runSessionEnd({ owner: OWNER, deps: depsFor(w, c, { iso: { isDefault: false, only: new Set(['somethingelse']) }, observeAtMs: [] }) });
  assert.deepEqual(r.stacks, []);
  assert.equal(w.supabaseCalls.length, 0);
  assert.equal(w.actions().length, 0);
}));

test('a stack this owner never leased is not decided about', () => withWorld({}, async (w, c) => {
  await w.lease(OTHER);
  const r = await runSessionEnd({ owner: OWNER, deps: depsFor(w, c, { observeAtMs: [] }) });
  assert.deepEqual(r.stacks, []);
  assert.equal(w.supabaseCalls.length, 0);
}));

test('damaged ledger => "ledger damaged" recorded, zero stops, dev servers untouched, no decisions (R2-14)', () => withWorld({}, async (w, c) => {
  await w.lease(OWNER);
  writeFileSync(w.files.ledger, `${readFileSync(w.files.ledger, 'utf8')}this line is damaged\n`);
  const r = await runSessionEnd({ owner: OWNER, deps: depsFor(w, c, { observeAtMs: [] }) });
  assert.equal(r.status, 'ledger damaged');
  assert.equal(w.supabaseCalls.length, 0);
  assert.equal(w.devCalls.length, 0);
  assert.equal(w.actions().length, 0);
  assert.match(readFileSync(w.files.log, 'utf8'), /ledger damaged/);
}));

// ---- fresh gates right before the mutation (R2-6) ----

test('pause created / config deleted / mode flipped to report between assessment and the stop => no supabase call', () => withWorld({}, async (w, c) => {
  const cases = {
    paused: { change: () => writeFileSync(w.files.pause, ''), undo: () => rmSync(w.files.pause), reason: 'paused' },
    'not configured': { change: () => rmSync(w.files.config), undo: () => writeFileSync(w.files.config, '{}'), reason: 'not configured' },
    'mode report': { change: () => writeFileSync(w.files.mode, JSON.stringify({ sessionEnd: 'report', sweeper: 'report', devServers: 'report' })), undo: () => writeFileSync(w.files.mode, JSON.stringify({ sessionEnd: 'apply', sweeper: 'apply', devServers: 'report' })), reason: 'mode report' },
  };
  await w.lease(OWNER);
  for (const [name, { change, undo, reason }] of Object.entries(cases)) {
    // deps.cfg is not supplied, so the gate really re-reads the config file; the first assessment ran before `change`
    const r = await runSessionEnd({ owner: OWNER, deps: depsFor(w, c, { beforeMutate: change, observeAtMs: [] }) });
    assert.equal(r.stacks[0].action, 'kept', name);
    assert.deepEqual(r.stacks[0].reasons, [reason], name);
    assert.equal(w.supabaseCalls.length, 0, name);
    undo();
  }
  assert.deepEqual(w.actions().map((a) => a.action), ['kept', 'kept', 'kept']);
}));

test('config deleted while the worker waits for the owner => nothing decided, dev untouched', () => withWorld({}, async (w, c) => {
  await w.lease(OWNER);
  w.alive.add(key(OWNER));
  let polls = 0;
  const isAlive = (o) => { polls += 1; if (polls === 3) { w.alive.delete(key(o)); rmSync(w.files.config); } return ok(w.alive.has(key(o))); };
  const r = await runSessionEnd({ owner: OWNER, deps: depsFor(w, c, { isAlive, observeAtMs: [], cfg: undefined }) });
  // the config was read at the start (ok), deleted during the wait: the stop gate refuses
  assert.equal(r.stacks[0].action, 'kept');
  assert.deepEqual(r.stacks[0].reasons, ['not configured']);
  assert.equal(w.supabaseCalls.length, 0);
}));

// ---- concurrency, both orders (spec Testing) ----

function registerDeps(w, inv, over = {}) {
  return {
    env: {}, platform: 'linux', home: w.base, root: w.root, files: w.files, cfg: { status: 'ok', shared: new Set(), repos: [], memoryDirs: [], memoryExclude: [], transcriptDirs: [], devPorts: [3000] },
    iso: { isDefault: false, only: null }, seams: { docker: 'docker', ps: undefined, deadlineMs: 6000 }, inventory: () => ({ inv, fresh: true, at: Date.now() - 5000 }),
    refreshInventory: async () => { throw new Error('the inventory must not be refreshed here'); }, owner: () => ok(OTHER), worktree: () => ok('none'), ...over,
  };
}
const bash = (w, command) => ({ tool_name: 'Bash', tool_input: { command }, cwd: w.base, session_id: 's2', tool_use_id: 'tu' });
const settleFlag = (p) => { const f = { done: false }; p.then(() => { f.done = true; }, () => { f.done = true; }); return f; };
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

test('concurrency (a): the stopper holds the lock; a register() for the same project waits, then sees "stopped" and exits 2 with the restart message', () => withWorld({}, async (w) => {
  await w.lease(OWNER);
  const inv = readInventory({ run: w.run, cfg: { shared: new Set() }, docker: 'docker' }).value;
  let paused;
  const inside = new Promise((r) => { paused = r; });
  let open;
  const gate = new Promise((r) => { open = r; });
  const stopper = runSessionEnd({ owner: OWNER, deps: depsFor(w, clock(), { now: Date.now, sleep: async () => {}, observeAtMs: [], afterLock: async () => { paused(); await gate; },
    // a slow decisions log: the record must still be on disk before the lock is released (stopStack awaits it)
    appendDecision: async (file, rec, o) => { await sleepMs(250); return appendDecision(file, rec, o); } }) });
  await inside; // the stopper holds the project lock and is paused inside it
  const reg = register(bash(w, `supabase status --workdir ${w.workdir}`), registerDeps(w, inv));
  const flag = settleFlag(reg);
  await sleepMs(200);
  assert.equal(flag.done, false, 'register waits for the lock');
  assert.equal(w.actions().length, 0);
  open();
  const [res, verdict] = await Promise.all([stopper, reg]);
  assert.equal(res.stacks[0].action, 'stopped');
  assert.equal(verdict.exit, 2);
  assert.match(verdict.message, /stack alpha was just stopped automatically \(data kept\)/);
  assert.match(verdict.message, /supabase start -x studio,imgproxy,edge-runtime,logflare,vector --workdir/);
  assert.equal(w.supabaseCalls.length, 1);
  assertSafe(w);
}));

test('concurrency (b): register holds the lock first; the stopper waits, its re-check sees the new lease => kept, no stop', () => withWorld({}, async (w) => {
  await w.lease(OWNER);
  const inv = readInventory({ run: w.run, cfg: { shared: new Set() }, docker: 'docker' }).value;
  w.alive.add(key(OTHER)); // the registering session is alive
  let held;
  const inside = new Promise((r) => { held = r; });
  let open;
  const gate = new Promise((r) => { open = r; });
  const acquire = async (name, opts) => {
    const lock = await realAcquire(name, opts);
    held();
    await gate; // register is paused holding the project lock, before it appends its lease
    return lock;
  };
  const reg = register(bash(w, `supabase status --workdir ${w.workdir}`), registerDeps(w, inv, { acquire }));
  await inside;
  const stopper = runSessionEnd({ owner: OWNER, deps: depsFor(w, clock(), { now: Date.now, sleep: async () => {}, observeAtMs: [], lockWaitMs: 5000 }) });
  const flag = settleFlag(stopper);
  await sleepMs(300);
  assert.equal(flag.done, false, 'the stopper waits for the project lock');
  assert.equal(w.supabaseCalls.length, 0);
  open();
  const [verdict, res] = await Promise.all([reg, stopper]);
  assert.equal(verdict.exit, 0, 'register wrote its lease');
  assert.equal(res.stacks[0].action, 'kept');
  assert.match(res.stacks[0].reasons.join('\n'), /otherLiveLeases: 1 live lease\(s\) \(pid 222\)/);
  assert.equal(w.supabaseCalls.length, 0);
  assert.equal(w.actions().at(-1).action, 'kept');
}));

test('Review Focus 5: two owners exit at once, both leased the stack => exactly one supabase stop; the other records already-stopped', () => withWorld({}, async (w) => {
  await w.lease(OWNER);
  await w.lease(OWNER_B);
  // both workers read their first inventory (stack running) before either may stop: the first one into the lock waits for that
  let firstReads = 0;
  let bothRead;
  const barrier = new Promise((r) => { bothRead = r; });
  const worker = (owner) => {
    let mine = true;
    return runSessionEnd({
      owner, deps: depsFor(w, clock(), {
        now: Date.now, sleep: async () => {}, observeAtMs: [], workerFile: join(w.root, 'workers', `${owner.pid}.json`), lockWaitMs: 5000,
        readInventory: (o) => { const r = readInventory(o); if (mine) { mine = false; firstReads += 1; if (firstReads === 2) bothRead(); } return r; },
        afterLock: () => barrier,
      }),
    });
  };
  const both = await Promise.all([worker(OWNER), worker(OWNER_B)]);
  assert.equal(firstReads, 2);
  assert.equal(w.supabaseCalls.length, 1, 'one stop call');
  assert.deepEqual(both.map((r) => r.stacks[0].action).sort(), ['already-stopped', 'stopped']);
  assert.deepEqual(w.actions().map((a) => a.action).sort(), ['already-stopped', 'stopped']);
  assertSafe(w);
}));

// ---- the worker file (R3-4) ----

test('worker file: waiting while the owner lives, then decided + observing; decidedAt is durable and the decision record is on disk before it is set', () => withWorld({ mode: 'report' }, async (w, c) => {
  await w.lease(OWNER);
  w.alive.add(key(OWNER));
  const snaps = [];
  const sleep = async (ms) => {
    const f = readWorkerFile(w.workerFile);
    snaps.push({ ms, ...f.value, records: w.actions().length });
    if (snaps.length === 2) w.alive.delete(key(OWNER)); // the owner is gone after two polls
    await c.sleep(ms);
  };
  const r = await runSessionEnd({ owner: OWNER, deps: depsFor(w, c, { sleep }) });
  assert.equal(r.status, 'decided');
  const waiting = snaps.filter((s) => s.phase === 'waiting');
  assert.equal(waiting.length, 2);
  assert.ok(waiting.every((s) => s.decidedAt === null && s.decisions === 0));
  assert.deepEqual(waiting[0].owner, OWNER);
  assert.equal(waiting[0].pid, process.pid);
  // the worker has passed `decided` and `observing` by the time a poller first reads (the first sleep after the decision)
  const observing = snaps.filter((s) => s.phase === 'observing');
  assert.equal(observing.length, 2, 'both observation sleeps');
  for (const s of observing) {
    assert.equal(s.decidedAt, new Date(T0 + 4000).toISOString(), 'decidedAt never changes');
    assert.equal(s.decisions, 1);
    assert.equal(s.records, 1, 'the matching record is already in actions.jsonl');
    assert.equal(s.owner.pid, OWNER.pid);
  }
  assert.equal(observing[0].ms, 30 * 60_000);
  assert.equal(observing[1].ms, 90 * 60_000, 'the second re-probe is +120 min after the decision');
  assert.equal(existsSync(w.workerFile), false, 'removed when the worker is done');
  assert.equal(w.actions()[0].t, new Date(T0 + 4000).toISOString());
}));

test('worker file: decidedAt is set once even with zero decisions, and a file the hook wrote first is kept (never overwritten)', () => withWorld({}, async (w, c) => {
  mkdirSync(dirname(w.workerFile), { recursive: true });
  writeFileSync(w.workerFile, JSON.stringify({ pid: 4321, owner: OWNER, startedAt: 'hook-wrote-this', phase: 'waiting', decidedAt: null, decisions: 0 }));
  let seen;
  const r = await runSessionEnd({ owner: OWNER, deps: depsFor(w, c, { devSessionEnd: async () => { seen = readWorkerFile(w.workerFile).value; return []; } }) });
  assert.equal(r.status, 'decided');
  assert.equal(seen.startedAt, 'hook-wrote-this');
  assert.equal(seen.pid, 4321);
}));

// ---- re-probes and outcomes (R2-9) ----

function outcomes(w, now) {
  const decisions = readDecisions(w.files.actions).value;
  return { decisions, summary: outcomeSummary(decisions, observedUses(decisions), now) };
}

test('re-probe at +30 min sees a use by a process born BEFORE the decision => MISS recorded and counted', () => withWorld({ mode: 'report' }, async (w, c) => {
  await w.lease(OWNER);
  const decisionSec = Math.floor((T0 + 2000 * 0) / 1000);
  let hits = [];
  const evidence = { ...quiet, processRefs: () => ok(hits) };
  const sleep = async (ms) => {
    await c.sleep(ms);
    if (c.sleeps.length === 1) hits = [{ pid: 777, birth: decisionSec - 3600, command: 'psql -p 54322 -c "select 1" # alpha.stack', field: 'cmdline' }]; // after the +30 sleep
  };
  const r = await runSessionEnd({ owner: OWNER, deps: depsFor(w, c, { evidence, sleep }) });
  assert.equal(r.uses.length, 1, 'seen at +30 and again at +120, recorded once');
  assert.deepEqual({ ...r.uses[0], t: undefined }, { t: undefined, project: 'alpha', pid: 777, birth: decisionSec - 3600, check: 'C3', command: 'psql -p 54322 -c "select 1" # alpha.stack' });
  assert.equal(r.uses[0].t, new Date(T0 + 30 * 60_000).toISOString());
  const { decisions, summary } = outcomes(w, c.now());
  assert.deepEqual(decisions.map((d) => d.action), ['would-stop', 'use-observed']);
  assert.equal(summary.miss, 1);
  assert.equal(summary.restart, 0);
  assert.equal(summary.rows[0].outcome, 'MISS');
}));

test('re-probe: a use by a process born AFTER the decision is a RESTART; a hidden client or unknown birth is UNKNOWN; none is CLEAN', () => withWorld({ mode: 'report' }, async (w, c) => {
  await w.lease(OWNER);
  const decisionSec = Math.floor(T0 / 1000);
  let conn = [];
  let refs = [];
  const evidence = { ...quiet, connections: () => ok(conn), processRefs: () => ok(refs) };
  const sleep = async (ms) => {
    await c.sleep(ms);
    if (c.sleeps.length === 1) {
      refs = [{ pid: 780, birth: decisionSec + 600, command: 'supabase status', field: 'cmdline' }];
      conn = [{ pid: null, birth: null, command: 'hidden client', port: 54322 }];
    }
  };
  const r = await runSessionEnd({ owner: OWNER, deps: depsFor(w, c, { evidence, sleep, observeAtMs: [30 * 60_000] }) });
  assert.deepEqual(r.uses.map((u) => [u.check, u.pid, u.birth]).sort(), [['C2', null, null], ['C3', 780, decisionSec + 600]]);
  const { summary } = outcomes(w, c.now());
  assert.equal(summary.restart, 0, 'the decision has one worst outcome: UNKNOWN outranks RESTART');
  assert.equal(summary.unknown, 1);
  assert.equal(summary.miss, 0);
}));

test('re-probe: a lease registered after the decision by a process born before it counts too (C1)', () => withWorld({ mode: 'report' }, async (w, c) => {
  await w.lease(OWNER);
  const sleep = async (ms) => {
    await c.sleep(ms);
    if (c.sleeps.length === 1) await w.lease(OTHER, { t: new Date(c.now() - 60_000).toISOString(), via: 'bash' });
  };
  const r = await runSessionEnd({ owner: OWNER, deps: depsFor(w, c, { sleep, observeAtMs: [30 * 60_000] }) });
  assert.equal(r.uses.length, 1);
  assert.equal(r.uses[0].check, 'C1');
  assert.equal(r.uses[0].pid, OTHER.pid);
  assert.equal(r.uses[0].birth, OTHER.birth);
  assert.equal(outcomes(w, c.now()).summary.miss, 1, 'birth 2000 s is long before the decision');
}));

test('re-probe: nothing seen => CLEAN after 2 h; a probe that cannot run (no listener on a stopped stack) is a note, not a use', () => withWorld({}, async (w, c) => {
  await w.lease(OWNER);
  const evidence = { ...quiet, connections: (s, o) => (w.supabaseCalls.length ? unknown('port 54322 listener not visible') : ok([])) };
  const r = await runSessionEnd({ owner: OWNER, deps: depsFor(w, c, { evidence }) });
  assert.equal(r.stacks[0].action, 'stopped');
  assert.deepEqual(r.uses, []);
  assert.ok(r.notes.some((n) => /C2 re-probe unavailable \(port 54322 listener not visible\)/.test(n)));
  assert.equal(r.notes.filter((n) => /C2 re-probe unavailable/.test(n)).length, 1, 'noted once, not at every re-probe');
  const { summary } = outcomes(w, c.now() + 1);
  assert.equal(summary.clean, 1);
  assert.equal(summary.miss + summary.restart + summary.unknown, 0);
}));

test('a kept stack is not re-probed; only would-stop / stopped projects are', () => withWorld({}, async (w, c) => {
  await w.lease(OWNER);
  await w.lease(OTHER);
  w.alive.add(key(OTHER));
  const r = await runSessionEnd({ owner: OWNER, deps: depsFor(w, c) });
  assert.equal(r.stacks[0].action, 'kept');
  assert.equal(c.sleeps.length, 0, 'no observation sleeps for a kept stack');
}));

test('observedUses extracts the use objects, ignores everything else', () => {
  assert.deepEqual(observedUses([{ action: 'stopped' }, { action: 'use-observed', use: { t: 'x', project: 'p', pid: 1, birth: 2, check: 'C3' } }, { action: 'use-observed' }, null]), [{ t: 'x', project: 'p', pid: 1, birth: 2, check: 'C3' }]);
  assert.deepEqual(observedUses(undefined), []);
});

// ---- misc ----

test('the worker never signals the hook-level cwd: the dirs checked include the stack folder and exclude the worker pid', () => withWorld({}, async (w, c) => {
  await w.lease(OWNER);
  let dirs;
  let excluded;
  const evidence = { ...quiet, cwdInside: (d, o) => { dirs = d; excluded = o.excludePids; return ok([]); } };
  await runSessionEnd({ owner: OWNER, deps: depsFor(w, c, { evidence, observeAtMs: [] }) });
  assert.ok(dirs.includes(w.workdir));
  assert.ok(excluded.has(process.pid));
}));

test('Windows: nothing runs, nothing is written', async () => {
  const boom = () => { throw new Error('must not run on Windows'); };
  const r = await runSessionEnd({ owner: OWNER, deps: { platform: 'win32', run: boom, sleep: boom, isAlive: boom, root: '/nonexistent-root-for-test' } });
  assert.equal(r.status, 'unsupported');
  assert.equal(existsSync('/nonexistent-root-for-test'), false);
});

test('an assessment that throws keeps the stack (fail closed) and the worker goes on', () => withWorld({}, async (w, c) => {
  await w.lease(OWNER);
  const evidence = { ...quiet, consumerWorktrees: () => { throw new Error('boom'); } };
  const r = await runSessionEnd({ owner: OWNER, deps: depsFor(w, c, { evidence, observeAtMs: [] }) });
  assert.equal(r.stacks[0].action, 'kept');
  assert.equal(w.supabaseCalls.length, 0);
}));

// ---- the feature's own processes are never consumers (observed on the real Mac: pid 36371, the worker itself, was a MISS) ----

const putWorker = (w, name, body) => {
  mkdirSync(w.files.workers, { recursive: true });
  writeFileSync(join(w.files.workers, name), JSON.stringify(body));
};

test('re-probe: registered workers, a reused worker pid aside, and the observer itself are never recorded as uses; the probes are told to skip them', () => withWorld({ mode: 'report' }, async (w, c) => {
  await w.lease(OWNER);
  putWorker(w, '9001.json', { pid: 9001, birth: 77, phase: 'waiting' }); // a sibling worker, alive
  putWorker(w, '9002.json', { pid: 9002, birth: 88, phase: 'waiting' }); // its pid has been reused by something else
  w.alive.add(key({ pid: 9001, birth: 77 }));
  const decisionSec = Math.floor(T0 / 1000);
  let hits = [];
  const seenExclude = [];
  const evidence = {
    ...quiet,
    connections: (s, o) => { seenExclude.push(o.excludePids); return ok(hits.filter((h) => h.port)); },
    processRefs: (s, o) => { seenExclude.push(o.excludePids); return ok(hits.filter((h) => !h.port)); },
  };
  const sleep = async (ms) => {
    await c.sleep(ms);
    if (c.sleeps.length === 1) {
      hits = [
        { pid: 9001, birth: 77, command: 'node pipeline.mjs stacks session-end --owner 101:1001 # alpha', field: 'env' },
        { pid: process.pid, birth: decisionSec - 5, command: 'node worker # alpha', field: 'env' },
        { pid: 9001, birth: 77, command: 'node worker', port: 54322 },
        { pid: 9002, birth: decisionSec - 3600, command: 'psql alpha', field: 'cmdline' },
      ];
    }
  };
  const r = await runSessionEnd({ owner: OWNER, deps: depsFor(w, c, { evidence, sleep, observeAtMs: [30 * 60_000] }) });
  assert.deepEqual(r.uses.map((u) => u.pid), [9002], 'only the process that is not ours');
  assert.equal(outcomes(w, c.now()).summary.miss, 1);
  assert.equal(outcomes(w, c.now()).decisions.filter((d) => d.action === 'use-observed').length, 1);
  const reprobe = seenExclude.slice(-2);
  for (const ex of reprobe) assert.ok(ex.has(9001) && ex.has(process.pid) && !ex.has(9002), 'the re-probe skips the live worker and itself, not a reused pid');
}));

test('re-probe: nothing but the worker itself in view => CLEAN, no use, no MISS', () => withWorld({ mode: 'report' }, async (w, c) => {
  await w.lease(OWNER);
  const evidence = { ...quiet, processRefs: () => (w.supabaseCalls.length || c.sleeps.length ? ok([{ pid: process.pid, birth: 1, command: 'node pipeline.mjs stacks session-end', field: 'env' }]) : ok([])) };
  const r = await runSessionEnd({ owner: OWNER, deps: depsFor(w, c, { evidence }) });
  assert.deepEqual(r.uses, []);
  assert.equal(outcomes(w, c.now() + 1).summary.miss, 0);
  assert.equal(outcomes(w, c.now() + 1).summary.clean, 1);
}));

test('worker file: the worker records its own birth (so a reused pid is not mistaken for it); a ps that cannot tell leaves it out', () => withWorld({}, async (w, c) => {
  let seen;
  await runSessionEnd({ owner: OWNER, deps: depsFor(w, c, { procIdentity: (pid) => ok({ pid, birth: 4242 }), devSessionEnd: async () => { seen = readWorkerFile(w.workerFile).value; return []; } }) });
  assert.equal(seen.birth, 4242);
  seen = undefined;
  const w2 = makeWorld({});
  try {
    await runSessionEnd({ owner: OWNER, deps: depsFor(w2, c, { procIdentity: () => unknown('ps timed out'), devSessionEnd: async () => { seen = readWorkerFile(w2.workerFile).value; return []; } }) });
    assert.equal(seen.birth, undefined);
  } finally {
    w2.cleanup();
  }
}));

// ---- R1-B5: the +30/+120 re-probes are measured from the decision time, so the last one stays inside the outcome window ----

// Logging a decision takes 5 simulated minutes, so `now()` after all decisions is later than the decision's own time.
const slowAppend = (c) => async (file, rec, o) => { c.t += 5 * 60_000; return appendDecision(file, rec, o); };

test('re-probe: a use first seen at +120 min is still inside the outcome window when logging the decision took time (MISS, not CLEAN)', () => withWorld({ mode: 'report' }, async (w, c) => {
  await w.lease(OWNER);
  const decisionSec = Math.floor(T0 / 1000);
  let hits = [];
  const evidence = { ...quiet, processRefs: () => ok(hits) };
  const sleep = async (ms) => {
    await c.sleep(ms);
    if (c.sleeps.length === 2) hits = [{ pid: 777, birth: decisionSec - 3600, command: 'psql alpha.stack', field: 'cmdline' }]; // only the last probe sees it
  };
  const r = await runSessionEnd({ owner: OWNER, deps: depsFor(w, c, { evidence, sleep, appendDecision: slowAppend(c) }) });
  assert.equal(r.uses.length, 1);
  const decided = outcomes(w, c.now()).decisions.find((d) => d.action === 'would-stop');
  assert.ok(Date.parse(r.uses[0].t) - Date.parse(decided.t) <= WINDOW_MS, 'the last re-probe is at most 2 h after the decision');
  assert.deepEqual(c.sleeps, [25 * 60_000, 90 * 60_000], 'scheduled from the decision time, not from after the decisions');
  const { summary } = outcomes(w, c.now());
  assert.equal(summary.miss, 1);
  assert.equal(summary.rows[0].outcome, 'MISS');
}));

test('re-probe: a timer that fires a little late still stamps the +120 use inside the window', () => withWorld({ mode: 'report' }, async (w, c) => {
  await w.lease(OWNER);
  const decisionSec = Math.floor(T0 / 1000);
  let hits = [];
  const evidence = { ...quiet, processRefs: () => ok(hits) };
  const sleep = async (ms) => {
    await c.sleep(ms + (c.sleeps.length === 1 ? 1500 : 0)); // the last real timer overshoots
    if (c.sleeps.length === 2) hits = [{ pid: 777, birth: decisionSec - 3600, command: 'psql alpha.stack', field: 'cmdline' }];
  };
  await runSessionEnd({ owner: OWNER, deps: depsFor(w, c, { evidence, sleep }) });
  assert.equal(outcomes(w, c.now()).summary.miss, 1);
}));
