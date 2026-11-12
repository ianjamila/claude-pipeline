// A plain terminal's review lease (plan 2026-11-12 "Terminal leases + lease hardening", step 1 wiring: Lifecycle, R4-2 signals, R4-3 finally sweep, R4-5 (ii)
// installed identity, P3 settle after a throw). Everything runs the real CLI against throwaway repos and a scratch lease folder (PIPELINE_REVIEW_LEASE_DIR),
// as a PLAIN TERMINAL: no session marker and a `ps` that finds no Claude ancestor (helpers/no-claude-session.mjs). That fake ps does not answer `-o lstart=`,
// so the lease has no start time: while the command runs it is "uncertain" (live), and once the pid is gone the kill(pid, 0) evidence reads it dead, the same
// on every platform (Windows asks no ps at all: the ESRCH path). The library itself is covered by review-lease-process.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTmpRepo } from './helpers/tmprepo.mjs';
import { pipelineYml } from './helpers/fakegh-env.mjs';
import { LOCK_DIR, PR } from './helpers/gate-env.mjs';
import { addRound, emptyState, saveState } from '../pipeline/lib/state.mjs';
import { reviewLockName } from '../pipeline/lib/review-context.mjs';
import { acquireAdmission, releaseAdmission, scanLeases, sweepDeadLeases } from '../pipeline/lib/review-lease.mjs';
import { release, tryAcquire } from '../pipeline/lib/locks.mjs';
import { LEASED_COMMANDS, holdReviewLease, settleReviewLease } from '../pipeline/lib/review-lease-wiring.mjs';
import { AUTO_UPDATE_ARGS } from '../pipeline/lib/update-schedule.mjs';
import { QUEUE_SWEEP_NAME } from '../pipeline/lib/queue-sweep-schedule.mjs';
import { main } from '../pipeline/bin/pipeline.mjs';
import { noClaudeSession } from './helpers/no-claude-session.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const BIN = join(here, '..', 'pipeline', 'bin', 'pipeline.mjs');
const MACHINE = 'gate-env-test-machine';
const SESSION_VAR = ['CLAUDE', 'CODE'].join('');
const POSIX_ONLY = { skip: process.platform === 'win32' ? 'POSIX signals' : false };

const made = [];
process.on('exit', () => { for (const d of made) rmSync(d, { recursive: true, force: true }); });
function scratch(label = 'cp-lt') {
  const d = realpathSync.native(mkdtempSync(join(tmpdir(), `${label}-`)));
  made.push(d);
  return d;
}

// A plain terminal's machine: a home, a lease folder and the child's environment.
function terminal(extra = {}) {
  const root = scratch();
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  const dir = join(root, 'review-leases');
  const env = {
    ...process.env, ...noClaudeSession(), HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: undefined, PIPELINE_MACHINE_ID: MACHINE,
    PIPELINE_REVIEW_LEASE_DIR: dir, PIPELINE_LOCK_DIR: LOCK_DIR, [SESSION_VAR]: undefined, ...extra,
  };
  return { root, home, dir, env };
}
const files = (t) => (existsSync(t.dir) ? readdirSync(t.dir).filter((n) => n.endsWith('.json')).sort() : []);
const procFiles = (t) => files(t).filter((n) => n.startsWith('proc-'));
const readLease = (t, file) => JSON.parse(readFileSync(join(t.dir, file), 'utf8'));

function reviewRepo() {
  const repo = createTmpRepo();
  repo.write('.claude/pipeline.yml', pipelineYml());
  repo.write('.gitignore', '.review/\n.verify/\n');
  repo.write('src/app.js', 'export const a = 1;\n');
  repo.commit('init');
  repo.branch('agent/feature');
  saveState(repo.dir, addRound(emptyState({ repo: 'acme/widgets', pr: PR, branch: 'agent/feature', risk: 'low', maxRounds: 2 }), {
    n: 1, fromHead: 'a', toHead: 'b', contentHashAtToHead: 'h1', items: [],
  }));
  return repo;
}
const stateBytes = (repo) => readFileSync(join(repo.dir, '.review', 'state.json'), 'utf8');

function start(t, repo, args, env = {}) {
  const child = spawn(process.execPath, [BIN, ...args], { cwd: repo.dir, env: { ...t.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  const done = new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr })));
  return { child, done };
}
const run = (t, repo, args, env = {}) => {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd: repo.dir, env: { ...t.env, ...env }, encoding: 'utf8' });
  return { code: r.status, signal: r.signal, stdout: r.stdout, stderr: r.stderr };
};
async function until(cond, what, ms = 15_000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
// Holds a command open: it waits for the PR's state lock, which the test owns, AFTER it took its lease (the lease comes first, wiring header ORDER).
async function holdOpen(t, repo, args = ['state', 'set-outcome', '--outcome', 'needs-human']) {
  const lock = tryAcquire(reviewLockName(repo.dir, PR), { dir: LOCK_DIR, machineId: MACHINE });
  assert.equal(lock.acquired, true);
  const cmd = start(t, repo, args, { PIPELINE_LOCK_WAIT_MS: '30000' });
  await until(() => procFiles(t).length === 1, 'the lease of the waiting command');
  return { cmd, unlock: () => release(lock.lock) };
}

// ---- lifecycle ------------------------------------------------------------------------------------------------------------------------------

test('a plain terminal command holds a process lease while it runs (version 2, its own pid, the command name) and none once it has exited', async () => {
  const t = terminal();
  const repo = reviewRepo();
  const held = await holdOpen(t, repo);
  try {
    const [file] = procFiles(t);
    const rec = readLease(t, file);
    assert.equal(rec.version, 2);
    assert.equal(rec.holder, 'process');
    assert.equal(rec.pid, held.cmd.child.pid);
    assert.match(file, new RegExp(`^proc-${held.cmd.child.pid}-[0-9a-f]{8}\\.json$`));
    const [lease] = Object.values(rec.leases);
    assert.equal(lease.pr, PR);
    assert.equal(lease.command, 'state');
    const scan = scanLeases({ dir: t.dir, env: { [SESSION_VAR]: undefined }, machineId: MACHINE });
    assert.equal(scan.live.length, 1, 'the running command keeps the folder live');
  } finally {
    held.unlock();
  }
  const out = await held.cmd.done;
  assert.equal(out.code, 0, out.stderr);
  assert.deepEqual(files(t), [], 'closed after a normal exit');
});

test('a usage error closes the lease too (any result, not only summary / ended)', () => {
  const t = terminal();
  const repo = reviewRepo();
  const r = run(t, repo, ['state', 'set-outcome']);
  assert.equal(r.code, 2, r.stderr + r.stdout);
  assert.equal(JSON.parse(r.stdout).error, 'usage');
  assert.deepEqual(files(t), []);
});

test('a command that throws closes its lease (settle runs from a finally)', () => {
  const t = terminal();
  const repo = reviewRepo();
  writeFileSync(join(repo.dir, '.review', 'state.json'), '{ this is not json');
  const r = run(t, repo, ['state', 'show']);
  assert.notEqual(r.code, 0, r.stdout);
  assert.deepEqual(files(t), [], 'closed although the command failed');
});

test('settleReviewLease closes a process lease after a throw (no result at all)', async () => {
  const t = terminal();
  const repo = reviewRepo();
  const leaseOpts = { ancestorPid: null, processHolder: { sessionId: 'proc-4242-0a0b0c0d', pid: process.pid, pidStart: null }, machineId: MACHINE };
  const env = { ...t.env };
  const ctx = { env, cwd: repo.dir, leaseOpts };
  const lease = await holdReviewLease('state', ['show'], ctx);
  assert.ok(lease.held, JSON.stringify(lease));
  assert.deepEqual(files(t), ['proc-4242-0a0b0c0d.json']);
  await settleReviewLease('state', undefined, lease.held, ctx);
  assert.deepEqual(files(t), [], 'closed with result === undefined');
  await settleReviewLease('state', undefined, lease.held, ctx); // a second settle is a no-op, never a throw
});

test('process.exit inside the command still closes the lease (the exit handler), and the handlers are gone after a normal settle', async () => {
  const t = terminal();
  const repo = reviewRepo();
  const script = join(t.root, 'exits.mjs');
  const wiring = join(here, '..', 'pipeline', 'lib', 'review-lease-wiring.mjs');
  writeFileSync(script, [
    `import { holdReviewLease, settleReviewLease } from ${JSON.stringify(new URL(`file://${wiring.replace(/\\/g, '/')}`).href)};`,
    "const mode = process.argv[2];",
    "const ctx = { env: process.env, cwd: process.cwd() };",
    "const lease = await holdReviewLease('state', ['show'], ctx);",
    "if (!lease.held) { console.error(JSON.stringify(lease)); process.exit(9); }",
    "if (mode === 'settle') {",
    "  await settleReviewLease('state', { exitCode: 0, output: {} }, lease.held, ctx);",
    "  console.log(JSON.stringify({ exit: process.listenerCount('exit'), int: process.listenerCount('SIGINT'), term: process.listenerCount('SIGTERM'), hup: process.listenerCount('SIGHUP') }));",
    "} else process.exit(3);",
  ].join('\n'));
  const exited = spawnSync(process.execPath, [script, 'exit'], { cwd: repo.dir, env: t.env, encoding: 'utf8' });
  assert.equal(exited.status, 3, exited.stderr);
  assert.deepEqual(files(t), [], 'the exit handler closed it');

  const settled = spawnSync(process.execPath, [script, 'settle'], { cwd: repo.dir, env: t.env, encoding: 'utf8' });
  assert.equal(settled.status, 0, settled.stderr);
  assert.deepEqual(JSON.parse(settled.stdout), { exit: 0, int: 0, term: 0, hup: 0 }, 'every handler is unregistered after the successful close');
  assert.deepEqual(files(t), []);
});

test('SIGINT (Ctrl-C) closes the lease and the process still dies of SIGINT, exactly as without a lease', POSIX_ONLY, async () => {
  const t = terminal();
  const repo = reviewRepo();
  const held = await holdOpen(t, repo);
  held.cmd.child.kill('SIGINT');
  const out = await held.cmd.done;
  held.unlock();
  assert.equal(out.signal, 'SIGINT', `killed by the signal, not an exit code (${out.code})`);
  assert.deepEqual(files(t), [], 'the signal handler closed it before the default death');
});

test('SIGTERM closes the lease and the process dies of SIGTERM', POSIX_ONLY, async () => {
  const t = terminal();
  const repo = reviewRepo();
  const held = await holdOpen(t, repo);
  held.cmd.child.kill('SIGTERM');
  const out = await held.cmd.done;
  held.unlock();
  assert.equal(out.signal, 'SIGTERM');
  assert.deepEqual(files(t), []);
});

test('SIGKILL leaves the file; it is judged dead (pid gone, kill(pid, 0) says ESRCH even without ps) and sweepDeadLeases removes it', POSIX_ONLY, async () => {
  const t = terminal();
  const repo = reviewRepo();
  const held = await holdOpen(t, repo);
  held.cmd.child.kill('SIGKILL');
  const out = await held.cmd.done;
  held.unlock();
  assert.equal(out.signal, 'SIGKILL');
  assert.equal(procFiles(t).length, 1, 'nothing could close it');
  const opts = { dir: t.dir, env: { [SESSION_VAR]: undefined }, machineId: MACHINE, psRun: () => ({ status: 1, stdout: '' }) }; // ps answers nothing: the second evidence decides
  const scan = scanLeases(opts);
  assert.equal(scan.live.length, 0);
  assert.equal(scan.dead.length, 1);
  const swept = await sweepDeadLeases(opts);
  assert.equal(swept.removed.length, 1);
  assert.deepEqual(files(t), []);
});

test('a detached job still running at close moves the lease into the worktree\'s one job-<hash> file; no proc file is left', async () => {
  const t = terminal();
  const repo = reviewRepo();
  const stop = join(t.root, 'stop');
  const sleeper = join(t.root, 'sleeper.mjs');
  writeFileSync(sleeper, `import { existsSync } from 'node:fs'; while (!existsSync(${JSON.stringify(stop)})) await new Promise((r) => setTimeout(r, 50));\n`);
  const started = run(t, repo, ['job', 'start', 'sleeper', '--', process.execPath, sleeper]);
  assert.equal(started.code, 0, started.stdout + started.stderr);
  try {
    assert.deepEqual(files(t).filter((n) => n.startsWith('proc-')), [], 'the proc file is gone');
    const jobs = files(t).filter((n) => /^job-[0-9a-f]{16}\.json$/.test(n));
    assert.equal(jobs.length, 1, files(t).join());
    const rec = readLease(t, jobs[0]);
    assert.equal(rec.version, 2);
    assert.equal(rec.holder, 'job');
    assert.equal(scanLeases({ dir: t.dir, env: { [SESSION_VAR]: undefined }, machineId: MACHINE }).live.length, 1, 'live while the job runs');
  } finally {
    writeFileSync(stop, 'x');
  }
  await until(() => scanLeases({ dir: t.dir, env: { [SESSION_VAR]: undefined }, machineId: MACHINE }).live.length === 0, 'the job to end');
  const swept = await sweepDeadLeases({ dir: t.dir, env: { [SESSION_VAR]: undefined }, machineId: MACHINE });
  assert.equal(swept.removed.length, 1);
  assert.deepEqual(files(t), []);
});

test('the finally close also sweeps dead proc files of earlier SIGKILLed commands (best effort, only proc- / job- files)', POSIX_ONLY, async () => {
  const t = terminal();
  const repo = reviewRepo();
  const held = await holdOpen(t, repo);
  held.cmd.child.kill('SIGKILL');
  await held.cmd.done;
  held.unlock();
  assert.equal(procFiles(t).length, 1);
  const sessionFile = join(t.dir, 'sess-abc.json'); // a session holder's file is never judged by this sweep
  writeFileSync(sessionFile, 'not json');
  const r = run(t, repo, ['state', 'show']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(files(t), ['sess-abc.json'], 'the dead proc file went; the other file is untouched');
});

// ---- admission --------------------------------------------------------------------------------------------------------------------------------

test('an update holding admission stops a plain terminal\'s leased command: exit 2 update-in-progress, the command did not run', async () => {
  const t = terminal({ PIPELINE_ADMISSION_WAIT_MS: '300' });
  const repo = reviewRepo();
  const before = stateBytes(repo);
  process.env.PIPELINE_MACHINE_ID = MACHINE;
  const held = await acquireAdmission({ dir: t.dir, waitMs: 1000 });
  try {
    const r = run(t, repo, ['state', 'set-outcome', '--outcome', 'needs-human']);
    assert.equal(r.code, 2, r.stdout + r.stderr);
    const json = JSON.parse(r.stdout);
    assert.equal(json.error, 'update-in-progress');
    assert.match(json.message, /retry in a minute/);
    assert.equal(stateBytes(repo), before, 'the command did not run');
    assert.deepEqual(files(t), []);
  } finally {
    releaseAdmission(held);
  }
});

// ---- verify slot --run: a silent result instead of process.exit ---------------------------------------------------------------------------

const q = (p) => JSON.stringify(p);
function slotRepo(exit) {
  const repo = createTmpRepo();
  const child = join(here, 'fixtures', 'slot-child.mjs');
  const work = scratch();
  writeFileSync(join(work, 'release'), '');
  const full = [process.execPath, child, join(work, 'a.started'), join(work, 'release'), String(exit)].map(q).join(' ');
  repo.write('.claude/pipeline.yml', `version: 1\nproject: demo\nverify:\n  full: ${JSON.stringify(full)}\n  quick: node scripts/verify.mjs --quick\n  max_parallel_full: 1\n`);
  repo.commit('config');
  return repo;
}
for (const [label, exit] of [['pass', 0], ['fail', 7]]) {
  test(`verify slot --run (${label}): the verify's exit code is the CLI's, stdout stays empty, and the lease is closed`, () => {
    const t = terminal({ PIPELINE_SLOT_POLL_MS: '20' });
    const repo = slotRepo(exit);
    const r = run(t, repo, ['verify', 'slot', '--run']);
    assert.equal(r.code, exit, r.stderr);
    assert.equal(r.stdout, '', 'no JSON result on stdout');
    assert.equal(JSON.parse(r.stderr.trim().split('\n')[0]).slot.of, 1);
    assert.deepEqual(files(t), []);
  });
}

// ---- updated-while-starting (R4-5 ii) ---------------------------------------------------------------------------------------------------------

// main() in-process, output captured; the identity reader and the lease holder are injected (no real install, no real ps).
async function runMain(t, repo, args, stamps) {
  const out = [];
  const reads = [];
  const next = [...stamps];
  const leaseOpts = { ancestorPid: null, processHolder: { sessionId: 'proc-4243-0a0b0c0d', pid: process.pid, pidStart: null }, machineId: MACHINE };
  const code = await main(args, {
    env: { ...t.env }, cwd: repo.dir, leaseOpts, stdout: { write: (s) => { out.push(s); } },
    installedStamp: () => { reads.push(next[0]); return next.length > 1 ? next.shift() : next[0]; },
  });
  return { code, json: out.length ? JSON.parse(out.join('')) : null, reads };
}

test('updated-while-starting: an install that changed between the first read and the lease refuses with exit 2, nothing runs, the lease just taken is closed', async () => {
  const t = terminal();
  const repo = reviewRepo();
  const before = stateBytes(repo);
  const r = await runMain(t, repo, ['state', 'set-outcome', '--outcome', 'needs-human'], ['sha-A', 'sha-B']);
  assert.equal(r.code, 2);
  assert.deepEqual(r.json, {
    ok: false, error: 'updated-while-starting',
    message: 'the pipeline was updated while this command started; nothing was changed; retry',
  });
  assert.equal(stateBytes(repo), before, 'the command did not run');
  assert.deepEqual(files(t), [], 'and its lease is closed');
});

test('updated-while-starting: an unchanged install runs the command; a command that is not leased never reads the identity', async () => {
  const t = terminal();
  const repo = reviewRepo();
  const same = await runMain(t, repo, ['state', 'show'], ['sha-A', 'sha-A']);
  assert.equal(same.code, 0);
  assert.equal(same.json.ok ?? true, true);
  assert.equal(same.reads.length, 2, 'once before the module is imported, once after the lease is held');
  const unleased = await runMain(t, repo, ['config'], ['sha-A', 'sha-B']);
  assert.equal(unleased.code, 0);
  assert.equal(unleased.reads.length, 0);
  assert.deepEqual(files(t), []);
});

// ---- the installer never runs a leased command under admission -------------------------------------------------------------------------------

test('installer invariant: install.mjs and lib/installer.mjs spawn nothing, and no command the schedule helpers configure is a leased command', () => {
  const root = join(here, '..');
  for (const rel of ['install.mjs', join('pipeline', 'lib', 'installer.mjs')]) {
    const text = readFileSync(join(root, rel), 'utf8');
    assert.doesNotMatch(text, /\bchild_process\b/, `${rel} imports child_process`);
    assert.doesNotMatch(text, /\b(spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\s*\(/, `${rel} starts a process`);
  }
  for (const name of [AUTO_UPDATE_ARGS[0], QUEUE_SWEEP_NAME]) assert.equal(LEASED_COMMANDS.has(name), false, `${name} must not be leased (it would wait on admission)`);
});
