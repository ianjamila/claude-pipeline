import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync, utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startJob, waitJob, readJob } from '../pipeline/lib/jobs.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const jobsUrl = pathToFileURL(join(here, '..', 'pipeline', 'lib', 'jobs.mjs')).href;
const runnerPath = join(here, '..', 'pipeline', 'lib', 'job-runner.mjs');

// A scratch cwd per test; removed afterwards (best effort: a Windows file may still be open).
function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'cp-jobs-'));
  t.after(() => { try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* ignore */ } });
  return dir;
}

// A shell command line that runs a one-liner with node; `js` must not contain double quotes.
const node = (js) => `node -e "${js}"`;
const jobDirOf = (cwd, name) => join(cwd, '.review', 'jobs', name);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('until: timed out');
    await sleep(20);
  }
}

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const FAST = { pollMs: 25 };
const allow = () => ({ allow: true });
// startJob has no default policy, so the tests that are not about policy go through this.
const start = (name, command, opts = {}) => startJob(name, command, { policy: allow, ...opts });

test('a finished job reports done, exit code 0 and the output tail', async (t) => {
  const cwd = scratch(t);
  const started = start('ok', node("console.log('hello')"), { cwd });
  assert.equal(started.name, 'ok');
  assert.equal(started.jobDir, jobDirOf(cwd, 'ok'));
  assert.equal(typeof started.pid, 'number');
  const r = await waitJob('ok', { cwd, timeoutMs: 15_000, ...FAST });
  assert.equal(r.state, 'done');
  assert.equal(r.exitCode, 0);
  assert.match(r.tail, /hello/);
  assert.equal(typeof r.startedAt, 'string');
  assert.equal(typeof r.finishedAt, 'string');
  assert.ok(r.elapsedMs >= 0);
  const meta = readJson(join(started.jobDir, 'meta.json'));
  assert.equal(meta.name, 'ok');
  assert.equal(meta.cwd, cwd);
  assert.equal(meta.runnerPid, started.pid);
  assert.equal(meta.command, node("console.log('hello')"));
});

test('a failing command reports its exit code', async (t) => {
  const cwd = scratch(t);
  start('bad', node('process.exit(3)'), { cwd });
  const r = await waitJob('bad', { cwd, timeoutMs: 15_000, ...FAST });
  assert.equal(r.state, 'done');
  assert.equal(r.exitCode, 3);
});

test('a slow job reports running on a short wait and done on a longer one', async (t) => {
  const cwd = scratch(t);
  start('slow', node('setTimeout(()=>{},2500)'), { cwd });
  const first = await waitJob('slow', { cwd, timeoutMs: 300, ...FAST });
  assert.equal(first.state, 'running');
  assert.ok(first.elapsedMs >= 0);
  assert.equal(typeof first.tail, 'string');
  const second = await waitJob('slow', { cwd, timeoutMs: 20_000, ...FAST });
  assert.equal(second.state, 'done');
  assert.equal(second.exitCode, 0);
});

test('a job that was never started is missing', async (t) => {
  const cwd = scratch(t);
  assert.deepEqual(await waitJob('nope', { cwd, timeoutMs: 0 }), { state: 'missing' });
  assert.deepEqual(await waitJob('nope', { cwd, timeoutMs: 5000, ...FAST }), { state: 'missing' });
  assert.deepEqual(readJob('nope', { cwd }), { state: 'missing' });
});

test('the same name cannot start twice while running; after it finishes it restarts with a fresh log', async (t) => {
  const cwd = scratch(t);
  start('dup', node("console.log('first-run'); setTimeout(()=>{},1500)"), { cwd });
  assert.throws(() => start('dup', node("console.log('x')"), { cwd }), /job already running/);
  const first = await waitJob('dup', { cwd, timeoutMs: 20_000, ...FAST });
  assert.equal(first.state, 'done');
  assert.match(first.tail, /first-run/);

  start('dup', node("console.log('second-run')"), { cwd });
  const second = await waitJob('dup', { cwd, timeoutMs: 15_000, ...FAST });
  assert.equal(second.state, 'done');
  assert.match(second.tail, /second-run/);
  assert.doesNotMatch(second.tail, /first-run/);
  assert.doesNotMatch(readFileSync(join(jobDirOf(cwd, 'dup'), 'log'), 'utf8'), /first-run/);
});

test('a policy refusal throws and starts nothing', async (t) => {
  const cwd = scratch(t);
  const seen = [];
  const policy = (command) => { seen.push(command); return { allow: false, reason: 'nope, not that' }; };
  const command = node("require('fs').writeFileSync('marker','x')");
  assert.throws(() => start('refused', command, { cwd, policy }), /job refused: nope, not that/);
  assert.deepEqual(seen, [command]);
  assert.equal(existsSync(join(cwd, '.review')), false, 'no job dir may be created');
  await sleep(400);
  assert.equal(existsSync(join(cwd, 'marker')), false, 'the command must not have run');
});

test('an allowing policy lets the job start', async (t) => {
  const cwd = scratch(t);
  start('allowed', node("console.log('fine')"), { cwd, policy: () => ({ allow: true }) });
  const r = await waitJob('allowed', { cwd, timeoutMs: 15_000, ...FAST });
  assert.equal(r.exitCode, 0);
});

test('stderr is captured in the log too', async (t) => {
  const cwd = scratch(t);
  start('err', node("console.log('to-out'); console.error('to-err')"), { cwd });
  const r = await waitJob('err', { cwd, timeoutMs: 15_000, ...FAST });
  assert.equal(r.state, 'done');
  assert.match(r.tail, /to-out/);
  assert.match(r.tail, /to-err/);
  assert.match(readFileSync(join(jobDirOf(cwd, 'err'), 'log'), 'utf8'), /to-err/);
});

test('the tail is the last 40 lines of the log', async (t) => {
  const cwd = scratch(t);
  start('many', node("for(let i=0;i<100;i++)console.log('line '+i)"), { cwd });
  const r = await waitJob('many', { cwd, timeoutMs: 15_000, ...FAST });
  const lines = r.tail.split('\n');
  assert.equal(lines.length, 40);
  assert.equal(lines[0], 'line 60');
  assert.equal(lines[39], 'line 99');
});

test('the command runs in the given cwd with the extra env', async (t) => {
  const cwd = scratch(t);
  start('where', node("console.log(process.cwd()); console.log('X=' + process.env.JOB_TEST_X)"), {
    cwd, env: { JOB_TEST_X: 'xyz' },
  });
  const r = await waitJob('where', { cwd, timeoutMs: 15_000, ...FAST });
  assert.equal(r.state, 'done');
  assert.ok(r.tail.split('\n').map((l) => l.trim()).includes(realpathSync(cwd)) || r.tail.includes(cwd));
  assert.match(r.tail, /X=xyz/);
});

test('readJob is the synchronous, non-waiting view', async (t) => {
  const cwd = scratch(t);
  start('peek', node("console.log('peeked'); setTimeout(()=>{},1200)"), { cwd });
  const running = readJob('peek', { cwd });
  assert.equal(running.state, 'running');
  await waitJob('peek', { cwd, timeoutMs: 20_000, ...FAST });
  const done = readJob('peek', { cwd });
  assert.equal(done.state, 'done');
  assert.equal(done.exitCode, 0);
  assert.match(done.tail, /peeked/);
});

test('startJob returns without waiting for the command', async (t) => {
  const cwd = scratch(t);
  const t0 = Date.now();
  start('quick-return', node('setTimeout(()=>{},3000)'), { cwd });
  assert.ok(Date.now() - t0 < 1000, `startJob blocked for ${Date.now() - t0}ms`);
  assert.equal(readJob('quick-return', { cwd }).state, 'running');
  const r = await waitJob('quick-return', { cwd, timeoutMs: 20_000, ...FAST });
  assert.equal(r.state, 'done');
});

test('the job outlives the process that started it', async (t) => {
  const cwd = scratch(t);
  const script = `import(${JSON.stringify(jobsUrl)}).then((m) => {
    m.startJob('orphan', ${JSON.stringify(node("setTimeout(()=>console.log('late-output'),1500)"))}, { cwd: ${JSON.stringify(cwd)}, policy: () => ({ allow: true }) });
  });`;
  const starter = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 20_000 });
  assert.equal(starter.status, 0, starter.stderr);
  assert.equal(readJob('orphan', { cwd }).state, 'running', 'starter exited but the job must keep running');
  const r = await waitJob('orphan', { cwd, timeoutMs: 20_000, ...FAST });
  assert.equal(r.state, 'done');
  assert.match(r.tail, /late-output/);
});

test('invalid names throw before anything is created', (t) => {
  const cwd = scratch(t);
  for (const bad of ['', 'a b', 'a/b', 'a\\b', '..', '.', '...', 'trailing.', 'x.starting', 'semi;colon', 'ünï', undefined, 7]) {
    assert.throws(() => start(bad, node('1'), { cwd }), /invalid job name/, `name ${String(bad)}`);
  }
  assert.equal(existsSync(join(cwd, '.review')), false);
  for (const ok of ['a', 'A-b_c.1', 'verify.full', '.hidden']) {
    assert.doesNotThrow(() => readJob(ok, { cwd }));
  }
  assert.throws(() => readJob('a/b', { cwd }), /invalid job name/);
});

test('a custom dir is honoured', async (t) => {
  const cwd = scratch(t);
  const started = start('custom', node("console.log('c')"), { cwd, dir: 'out/jobs' });
  assert.equal(started.jobDir, join(cwd, 'out', 'jobs', 'custom'));
  const r = await waitJob('custom', { cwd, dir: 'out/jobs', timeoutMs: 15_000, ...FAST });
  assert.equal(r.state, 'done');
  assert.deepEqual(readJob('custom', { cwd }), { state: 'missing' }, 'default dir must not see it');
});

test('a runner that dies without an exit.json (meta with a dead pid) is lost', async (t) => {
  const cwd = scratch(t);
  const dead = spawnSync(process.execPath, ['-e', '']);
  const jobDir = jobDirOf(cwd, 'ghost');
  mkdirSync(jobDir, { recursive: true });
  writeFileSync(join(jobDir, 'log'), 'partial output\nthen it died\n');
  writeFileSync(join(jobDir, 'meta.json'), JSON.stringify({
    name: 'ghost', command: 'whatever', cwd, startedAt: new Date(Date.now() - 5000).toISOString(), runnerPid: dead.pid,
  }));
  const r = await waitJob('ghost', { cwd, timeoutMs: 5000, ...FAST });
  assert.equal(r.state, 'lost');
  assert.match(r.tail, /then it died/);
  assert.ok(r.elapsedMs >= 5000);
  assert.equal(readJob('ghost', { cwd }).state, 'lost');
  // a lost job is not "running": the name can be reused
  start('ghost', node("console.log('reborn')"), { cwd });
  const again = await waitJob('ghost', { cwd, timeoutMs: 15_000, ...FAST });
  assert.equal(again.state, 'done');
  assert.match(again.tail, /reborn/);
});

test('meta written before the runner pid is known counts as running only briefly', (t) => {
  const cwd = scratch(t);
  const jobDir = jobDirOf(cwd, 'booting');
  mkdirSync(jobDir, { recursive: true });
  writeFileSync(join(jobDir, 'meta.json'), JSON.stringify({
    name: 'booting', command: 'x', cwd, startedAt: new Date().toISOString(), runnerPid: null,
  }));
  assert.equal(readJob('booting', { cwd }).state, 'running');
  writeFileSync(join(jobDir, 'meta.json'), JSON.stringify({
    name: 'booting', command: 'x', cwd, startedAt: new Date(Date.now() - 10 * 60_000).toISOString(), runnerPid: null,
  }));
  assert.equal(readJob('booting', { cwd }).state, 'lost');
});

test('killing the runner and its child with SIGKILL makes the job lost', { skip: process.platform === 'win32' }, async (t) => {
  const cwd = scratch(t);
  const { jobDir } = start('killed', node('setTimeout(()=>{},4000)'), { cwd });
  await until(() => existsSync(join(jobDir, 'child.json')));
  const { runnerPid } = readJson(join(jobDir, 'meta.json'));
  const { pid: childPid } = readJson(join(jobDir, 'child.json'));
  for (const pid of [runnerPid, childPid]) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
  const r = await waitJob('killed', { cwd, timeoutMs: 5000, ...FAST });
  assert.equal(r.state, 'lost');
  assert.equal(typeof r.tail, 'string');
  assert.equal(existsSync(join(jobDir, 'exit.json')), false);
});

test('SIGTERM to the runner is forwarded to the command', { skip: process.platform === 'win32' }, async (t) => {
  const cwd = scratch(t);
  const { jobDir, pid } = start('termed', node('setTimeout(()=>{},4000)'), { cwd });
  await until(() => existsSync(join(jobDir, 'child.json')));
  process.kill(pid, 'SIGTERM');
  const r = await waitJob('termed', { cwd, timeoutMs: 3000, ...FAST });
  assert.equal(r.state, 'done');
  assert.equal(r.exitCode, 143, 'killed by SIGTERM reports 128 + 15 like a shell');
  assert.equal(r.signal, 'SIGTERM');
  assert.equal(readJson(join(jobDir, 'exit.json')).signal, 'SIGTERM');
});

test('child.json records the command pid', async (t) => {
  const cwd = scratch(t);
  const { jobDir } = start('pidfile', node('setTimeout(()=>{},800)'), { cwd });
  const child = await until(() => existsSync(join(jobDir, 'child.json')) && readJson(join(jobDir, 'child.json')));
  assert.equal(typeof child.pid, 'number');
  await waitJob('pidfile', { cwd, timeoutMs: 15_000, ...FAST });
});

test('the runner records exit code 127 and the reason when the command cannot be spawned', (t) => {
  const cwd = scratch(t);
  const jobDir = jobDirOf(cwd, 'unspawnable');
  mkdirSync(jobDir, { recursive: true });
  writeFileSync(join(jobDir, 'meta.json'), JSON.stringify({
    name: 'unspawnable', command: 'echo hi', cwd: join(cwd, 'does', 'not', 'exist'),
    startedAt: new Date().toISOString(), runnerPid: null,
  }));
  const r = spawnSync(process.execPath, [runnerPath, jobDir, 'echo hi'], { encoding: 'utf8', timeout: 20_000 });
  assert.equal(r.status, 0, r.stderr);
  const exit = readJson(join(jobDir, 'exit.json'));
  assert.equal(exit.code, 127);
  assert.equal(exit.signal, null);
  assert.equal(typeof exit.finishedAt, 'string');
  assert.match(readFileSync(join(jobDir, 'log'), 'utf8'), /ENOENT|failed to start/i);
  assert.equal(existsSync(join(jobDir, 'child.json')), false);
  const view = readJob('unspawnable', { cwd });
  assert.equal(view.state, 'done');
  assert.equal(view.exitCode, 127);
});

test('startJob refuses a cwd that does not exist and creates nothing', (t) => {
  const cwd = scratch(t);
  assert.throws(() => start('nocwd', node('1'), { cwd: join(cwd, 'missing-dir') }), /cwd does not exist/);
  assert.equal(existsSync(join(cwd, 'missing-dir')), false);
});

// ---- identity: tag + runId -------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const identityOf = (r) => ({ name: r.name, command: r.command, cwd: r.cwd, tag: r.tag, runId: r.runId });

// A job directory written by hand: lets a test pin exactly what readJob/waitJob make of its files.
function manualJob(cwd, name, { meta = {}, exit, log } = {}) {
  const jobDir = jobDirOf(cwd, name);
  mkdirSync(jobDir, { recursive: true });
  writeFileSync(join(jobDir, 'meta.json'), JSON.stringify({
    name, command: 'x', cwd, tag: null, runId: 'run-1',
    startedAt: new Date(Date.now() - 1000).toISOString(), runnerPid: process.pid, ...meta,
  }));
  if (exit) writeFileSync(join(jobDir, 'exit.json'), JSON.stringify(exit));
  if (log !== undefined) writeFileSync(join(jobDir, 'log'), log);
  return jobDir;
}

test('every snapshot carries the job identity: name, command, cwd, tag and a fresh runId', async (t) => {
  const cwd = scratch(t);
  const command = node("console.log('id'); setTimeout(()=>{},800)");
  const s = start('ident', command, { cwd, tag: 'sha-1234' });
  assert.match(s.runId, UUID_RE);
  assert.equal(s.tag, 'sha-1234');
  const meta = readJson(join(s.jobDir, 'meta.json'));
  assert.deepEqual(Object.keys(meta).sort(), ['command', 'cwd', 'name', 'runId', 'runnerPid', 'startedAt', 'tag']);
  const identity = { name: 'ident', command, cwd, tag: 'sha-1234', runId: s.runId };
  assert.deepEqual(identityOf(meta), identity);
  assert.deepEqual(identityOf(readJob('ident', { cwd })), identity, 'running');
  const done = await waitJob('ident', { cwd, timeoutMs: 20_000, ...FAST });
  assert.equal(done.state, 'done');
  assert.deepEqual(identityOf(done), identity, 'done');

  const again = start('ident', command, { cwd });
  assert.notEqual(again.runId, s.runId, 'every start is a new run');
  assert.equal(readJob('ident', { cwd }).tag, null, 'no tag given means null');
  await waitJob('ident', { cwd, timeoutMs: 20_000, ...FAST });
});

test('a lost snapshot carries the identity too', (t) => {
  const cwd = scratch(t);
  const dead = spawnSync(process.execPath, ['-e', '']);
  manualJob(cwd, 'gone', { meta: { runnerPid: dead.pid, tag: 'T', runId: 'r-9', command: 'cmd-9' } });
  const r = readJob('gone', { cwd });
  assert.equal(r.state, 'lost');
  assert.deepEqual(identityOf(r), { name: 'gone', command: 'cmd-9', cwd, tag: 'T', runId: 'r-9' });
});

test('a tag must be a string', (t) => {
  const cwd = scratch(t);
  assert.throws(() => start('t', node('1'), { cwd, tag: 5 }), /tag must be a string/);
  assert.equal(existsSync(join(cwd, '.review')), false);
});

test('expectRunId: a job replaced by a newer run reports replaced, on waitJob and readJob', async (t) => {
  const cwd = scratch(t);
  const first = start('swap', node("console.log('one')"), { cwd });
  await waitJob('swap', { cwd, timeoutMs: 15_000, ...FAST });
  const second = start('swap', node("console.log('two')"), { cwd });
  assert.notEqual(first.runId, second.runId);

  assert.deepEqual(await waitJob('swap', { cwd, expectRunId: first.runId, timeoutMs: 5000, ...FAST }), { state: 'replaced' });
  assert.deepEqual(readJob('swap', { cwd, expectRunId: first.runId }), { state: 'replaced' });
  const mine = await waitJob('swap', { cwd, expectRunId: second.runId, timeoutMs: 15_000, ...FAST });
  assert.equal(mine.state, 'done');
  assert.match(mine.tail, /two/);
  assert.equal(readJob('swap', { cwd, expectRunId: second.runId }).state, 'done');
  // without expectRunId nothing changes, and a job that does not exist is still missing
  assert.equal(readJob('swap', { cwd }).state, 'done');
  assert.deepEqual(readJob('nothing', { cwd, expectRunId: 'whatever' }), { state: 'missing' });
});

test('expectRunId: replacement is noticed while waiting', async (t) => {
  const cwd = scratch(t);
  manualJob(cwd, 'mid', { meta: { runId: 'run-A' } }); // "running": its runner pid is this live process
  const waiting = waitJob('mid', { cwd, expectRunId: 'run-A', timeoutMs: 15_000, pollMs: 20 });
  await sleep(120);
  manualJob(cwd, 'mid', { meta: { runId: 'run-B' } });
  assert.deepEqual(await waiting, { state: 'replaced' });
});

test('a job directory without any runId is replaced for a caller that expects one', (t) => {
  const cwd = scratch(t);
  manualJob(cwd, 'old', { meta: { runId: undefined } });
  assert.deepEqual(readJob('old', { cwd, expectRunId: 'run-1' }), { state: 'replaced' });
});

// ---- policy is required ----------------------------------------------------------------------

test('startJob requires a policy function: there is no allow-all default', (t) => {
  const cwd = scratch(t);
  assert.throws(() => startJob('p', node('1'), { cwd }), /policy/);
  assert.throws(() => startJob('p', node('1')), /policy/);
  for (const bad of [null, 'allow', true, { allow: true }]) {
    assert.throws(() => startJob('p', node('1'), { cwd, policy: bad }), /policy/, `policy ${JSON.stringify(bad)}`);
  }
  assert.throws(() => startJob('p', node('1'), { cwd, policy: () => undefined }), /job refused/);
  assert.equal(existsSync(join(cwd, '.review')), false);
});

test('startJob rejects a command that is not a non-empty string', (t) => {
  const cwd = scratch(t);
  for (const bad of ['', undefined, 5, ['node', '-v']]) {
    assert.throws(() => start('c', bad, { cwd }), /command must be a non-empty string/);
  }
  assert.equal(existsSync(join(cwd, '.review')), false);
});

// ---- the start race ---------------------------------------------------------------------------

test('four concurrent starts of the same name from separate processes: exactly one wins', async (t) => {
  const cwd = scratch(t);
  const at = Date.now() + 2500; // every starter busy-waits until this instant so they collide
  const script = `import(${JSON.stringify(jobsUrl)}).then((m) => {
    while (Date.now() < ${at}) { /* line up with the other starters */ }
    try {
      m.startJob('race', ${JSON.stringify(node('setTimeout(()=>{},1500)'))}, { cwd: ${JSON.stringify(cwd)}, policy: () => ({ allow: true }) });
      console.log('STARTED');
    } catch (err) { console.log('REFUSED ' + err.message); }
  });`;
  const starter = () => new Promise((resolve) => {
    const p = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('close', () => resolve(out.trim()));
  });
  const outs = await Promise.all([starter(), starter(), starter(), starter()]);
  assert.equal(outs.filter((o) => o === 'STARTED').length, 1, outs.join(' | '));
  for (const o of outs.filter((x) => x !== 'STARTED')) assert.match(o, /^REFUSED job already (starting|running)$/);
  const r = await waitJob('race', { cwd, timeoutMs: 20_000, ...FAST });
  assert.equal(r.state, 'done');
  assert.equal(existsSync(join(cwd, '.review', 'jobs', 'race.starting')), false, 'the lock is released');
});

test('a fresh <name>.starting lock means another start is in progress', (t) => {
  const cwd = scratch(t);
  const lock = join(cwd, '.review', 'jobs', 'busy.starting');
  mkdirSync(lock, { recursive: true });
  assert.throws(() => start('busy', node('1'), { cwd }), /job already starting/);
  assert.equal(existsSync(lock), true, "someone else's lock is left alone");
  assert.equal(existsSync(jobDirOf(cwd, 'busy')), false);
});

test('a <name>.starting lock older than 60 s is stale and is taken over', async (t) => {
  const cwd = scratch(t);
  const lock = join(cwd, '.review', 'jobs', 'stale.starting');
  mkdirSync(lock, { recursive: true });
  const old = new Date(Date.now() - 120_000);
  utimesSync(lock, old, old);
  start('stale', node("console.log('took over')"), { cwd });
  assert.equal(existsSync(lock), false);
  const r = await waitJob('stale', { cwd, timeoutMs: 15_000, ...FAST });
  assert.match(r.tail, /took over/);
});

test('the lock is released after a success and after every kind of refusal', async (t) => {
  const cwd = scratch(t);
  const lock = join(cwd, '.review', 'jobs', 'lk.starting');
  start('lk', node('setTimeout(()=>{},1200)'), { cwd });
  assert.equal(existsSync(lock), false, 'after success');
  assert.throws(() => start('lk', node('1'), { cwd }), /job already running/);
  assert.equal(existsSync(lock), false, 'after already running');
  await waitJob('lk', { cwd, timeoutMs: 15_000, ...FAST });

  mkdirSync(join(cwd, 'keep'));
  writeFileSync(join(cwd, 'keep', 'f.txt'), 'x');
  assert.throws(() => start('keep', node('1'), { cwd, dir: '.' }), /not a job directory/);
  assert.equal(existsSync(join(cwd, 'keep.starting')), false, 'after refusing a non-job dir');
});

// ---- rmSync safety ----------------------------------------------------------------------------

test('an existing directory that is not a job dir is refused, never deleted', (t) => {
  const cwd = scratch(t);
  mkdirSync(join(cwd, 'src'));
  writeFileSync(join(cwd, 'src', 'precious.txt'), 'do not delete');
  assert.throws(() => start('src', node('1'), { cwd, dir: '.' }), /not a job directory/);
  assert.equal(readFileSync(join(cwd, 'src', 'precious.txt'), 'utf8'), 'do not delete');

  writeFileSync(join(cwd, 'afile'), 'x');
  assert.throws(() => start('afile', node('1'), { cwd, dir: '.' }), /not a job directory/);
  assert.equal(readFileSync(join(cwd, 'afile'), 'utf8'), 'x');

  // a meta.json that names another job does not make it this job's directory either
  const other = manualJob(cwd, 'b', { meta: { name: 'a', runnerPid: null, startedAt: new Date(0).toISOString() } });
  writeFileSync(join(other, 'keep.txt'), 'k');
  assert.throws(() => start('b', node('1'), { cwd }), /not a job directory/);
  assert.equal(readFileSync(join(other, 'keep.txt'), 'utf8'), 'k');
});

test('an empty leftover directory (a starter that crashed) is replaced', async (t) => {
  const cwd = scratch(t);
  mkdirSync(jobDirOf(cwd, 'crashed'), { recursive: true });
  start('crashed', node("console.log('recovered')"), { cwd });
  const r = await waitJob('crashed', { cwd, timeoutMs: 15_000, ...FAST });
  assert.match(r.tail, /recovered/);
});

test('a dir option that resolves outside cwd is rejected, on start and on read', (t) => {
  const cwd = scratch(t);
  const outside = scratch(t);
  for (const dir of ['..', '../elsewhere', join('a', '..', '..', 'x'), outside]) {
    assert.throws(() => start('esc', node('1'), { cwd, dir }), /inside cwd/, `dir ${dir}`);
    assert.throws(() => readJob('esc', { cwd, dir }), /inside cwd/, `read dir ${dir}`);
  }
  assert.equal(existsSync(join(outside, 'esc')), false);
});

test('an absolute dir inside cwd and a name starting with two dots are fine', async (t) => {
  const cwd = scratch(t);
  const dir = join(cwd, 'abs', 'jobs');
  const s = start('..ok', node("console.log('abs')"), { cwd, dir });
  assert.equal(s.jobDir, join(dir, '..ok'));
  const r = await waitJob('..ok', { cwd, dir, timeoutMs: 15_000, ...FAST });
  assert.equal(r.state, 'done');
});

// ---- no pipefail ------------------------------------------------------------------------------

test('a pipeline reports the LAST command status: sh has no pipefail', async (t) => {
  const cwd = scratch(t);
  start('pipe-hides', `${node('process.exit(5)')} | ${node('process.exit(0)')}`, { cwd });
  const hidden = await waitJob('pipe-hides', { cwd, timeoutMs: 15_000, ...FAST });
  assert.equal(hidden.exitCode, 0, 'a failing first stage is invisible');
  start('pipe-last', `${node('process.exit(0)')} | ${node('process.exit(4)')}`, { cwd });
  const last = await waitJob('pipe-last', { cwd, timeoutMs: 15_000, ...FAST });
  assert.equal(last.exitCode, 4);
});

// ---- exit.json and log parsing ----------------------------------------------------------------

test('exit.json fields map to exitCode the way a shell reports them', (t) => {
  const cwd = scratch(t);
  const finishedAt = new Date().toISOString();
  const cases = [
    ['no-code', { finishedAt }, 1, false],
    ['null-null', { code: null, signal: null, finishedAt }, 1, false],
    ['bad-signal', { code: null, signal: 'SIGWHATEVER', finishedAt }, 1, 'SIGWHATEVER'],
    ['sigkill', { code: null, signal: 'SIGKILL', finishedAt }, 137, 'SIGKILL'],
    ['zero', { code: 0, signal: null, finishedAt }, 0, false],
    ['seven', { code: 7, signal: null, finishedAt }, 7, false],
  ];
  for (const [name, exit, expected, signal] of cases) {
    manualJob(cwd, name, { exit });
    const r = readJob(name, { cwd });
    assert.equal(r.state, 'done', name);
    assert.equal(r.exitCode, expected, name);
    if (signal) assert.equal(r.signal, signal, name);
    else assert.equal('signal' in r, false, `${name} has no signal field`);
  }
});

test('a done snapshot echoes startedAt/finishedAt and measures elapsedMs between them', (t) => {
  const cwd = scratch(t);
  manualJob(cwd, 'timed', {
    meta: { startedAt: '2026-01-01T00:00:00.000Z' },
    exit: { code: 0, signal: null, finishedAt: '2026-01-01T00:00:05.250Z' },
  });
  const r = readJob('timed', { cwd });
  assert.equal(r.startedAt, '2026-01-01T00:00:00.000Z');
  assert.equal(r.finishedAt, '2026-01-01T00:00:05.250Z');
  assert.equal(r.elapsedMs, 5250);
});

test('a running snapshot measures elapsedMs from startedAt', (t) => {
  const cwd = scratch(t);
  manualJob(cwd, 'hour', { meta: { startedAt: new Date(Date.now() - 3_600_000).toISOString() } });
  const r = readJob('hour', { cwd });
  assert.equal(r.state, 'running');
  assert.ok(r.elapsedMs >= 3_600_000 && r.elapsedMs < 3_700_000, String(r.elapsedMs));
});

test('the tail of a log over 256 KB drops the partial first line', (t) => {
  const cwd = scratch(t);
  const a = 'A'.repeat(200_000);
  const b = 'B'.repeat(200_000);
  const c = 'C'.repeat(200_000);
  manualJob(cwd, 'big', { exit: { code: 0, finishedAt: new Date().toISOString() }, log: `${a}\n${b}\n${c}\n` });
  // the 256 KB window starts inside the B line, so only the complete C line may come back
  assert.equal(readJob('big', { cwd }).tail, c);
});

test('the tail of a huge single-line log keeps the end of that line', (t) => {
  const cwd = scratch(t);
  manualJob(cwd, 'oneline', { exit: { code: 0, finishedAt: new Date().toISOString() }, log: `${'Z'.repeat(300_000)}\n` });
  const { tail } = readJob('oneline', { cwd });
  assert.match(tail, /^Z+$/);
  assert.ok(tail.length > 100_000 && tail.length < 300_000, String(tail.length));
});

test('the last 40 lines of a log over 256 KB are returned intact', (t) => {
  const cwd = scratch(t);
  const rows = Array.from({ length: 30_000 }, (_, i) => `row ${String(i).padStart(6, '0')} ${'x'.repeat(20)}`);
  manualJob(cwd, 'rows', { exit: { code: 0, finishedAt: new Date().toISOString() }, log: `${rows.join('\n')}\n` });
  assert.equal(readJob('rows', { cwd }).tail, rows.slice(-40).join('\n'));
});

test('CRLF log lines come back without carriage returns', (t) => {
  const cwd = scratch(t);
  manualJob(cwd, 'crlf', { exit: { code: 0, finishedAt: new Date().toISOString() }, log: 'one\r\ntwo\r\nthree\r\n' });
  assert.equal(readJob('crlf', { cwd }).tail, 'one\ntwo\nthree');
});

test('tail edge cases: no trailing newline, empty log, no log', (t) => {
  const cwd = scratch(t);
  const exit = { code: 0, finishedAt: new Date().toISOString() };
  manualJob(cwd, 'nonl', { exit, log: 'a\nb' });
  manualJob(cwd, 'empty', { exit, log: '' });
  manualJob(cwd, 'nolog', { exit });
  assert.equal(readJob('nonl', { cwd }).tail, 'a\nb');
  assert.equal(readJob('empty', { cwd }).tail, '');
  assert.equal(readJob('nolog', { cwd }).tail, '');
});
