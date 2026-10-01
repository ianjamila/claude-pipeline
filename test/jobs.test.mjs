import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
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

test('a finished job reports done, exit code 0 and the output tail', async (t) => {
  const cwd = scratch(t);
  const started = startJob('ok', node("console.log('hello')"), { cwd });
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
  startJob('bad', node('process.exit(3)'), { cwd });
  const r = await waitJob('bad', { cwd, timeoutMs: 15_000, ...FAST });
  assert.equal(r.state, 'done');
  assert.equal(r.exitCode, 3);
});

test('a slow job reports running on a short wait and done on a longer one', async (t) => {
  const cwd = scratch(t);
  startJob('slow', node('setTimeout(()=>{},2500)'), { cwd });
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
  startJob('dup', node("console.log('first-run'); setTimeout(()=>{},1500)"), { cwd });
  assert.throws(() => startJob('dup', node("console.log('x')"), { cwd }), /job already running/);
  const first = await waitJob('dup', { cwd, timeoutMs: 20_000, ...FAST });
  assert.equal(first.state, 'done');
  assert.match(first.tail, /first-run/);

  startJob('dup', node("console.log('second-run')"), { cwd });
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
  assert.throws(() => startJob('refused', command, { cwd, policy }), /job refused: nope, not that/);
  assert.deepEqual(seen, [command]);
  assert.equal(existsSync(join(cwd, '.review')), false, 'no job dir may be created');
  await sleep(400);
  assert.equal(existsSync(join(cwd, 'marker')), false, 'the command must not have run');
});

test('an allowing policy lets the job start', async (t) => {
  const cwd = scratch(t);
  startJob('allowed', node("console.log('fine')"), { cwd, policy: () => ({ allow: true }) });
  const r = await waitJob('allowed', { cwd, timeoutMs: 15_000, ...FAST });
  assert.equal(r.exitCode, 0);
});

test('stderr is captured in the log too', async (t) => {
  const cwd = scratch(t);
  startJob('err', node("console.log('to-out'); console.error('to-err')"), { cwd });
  const r = await waitJob('err', { cwd, timeoutMs: 15_000, ...FAST });
  assert.equal(r.state, 'done');
  assert.match(r.tail, /to-out/);
  assert.match(r.tail, /to-err/);
  assert.match(readFileSync(join(jobDirOf(cwd, 'err'), 'log'), 'utf8'), /to-err/);
});

test('the tail is the last 40 lines of the log', async (t) => {
  const cwd = scratch(t);
  startJob('many', node("for(let i=0;i<100;i++)console.log('line '+i)"), { cwd });
  const r = await waitJob('many', { cwd, timeoutMs: 15_000, ...FAST });
  const lines = r.tail.split('\n');
  assert.equal(lines.length, 40);
  assert.equal(lines[0], 'line 60');
  assert.equal(lines[39], 'line 99');
});

test('the command runs in the given cwd with the extra env', async (t) => {
  const cwd = scratch(t);
  startJob('where', node("console.log(process.cwd()); console.log('X=' + process.env.JOB_TEST_X)"), {
    cwd, env: { JOB_TEST_X: 'xyz' },
  });
  const r = await waitJob('where', { cwd, timeoutMs: 15_000, ...FAST });
  assert.equal(r.state, 'done');
  assert.ok(r.tail.split('\n').map((l) => l.trim()).includes(realpathSync(cwd)) || r.tail.includes(cwd));
  assert.match(r.tail, /X=xyz/);
});

test('readJob is the synchronous, non-waiting view', async (t) => {
  const cwd = scratch(t);
  startJob('peek', node("console.log('peeked'); setTimeout(()=>{},1200)"), { cwd });
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
  startJob('quick-return', node('setTimeout(()=>{},3000)'), { cwd });
  assert.ok(Date.now() - t0 < 1000, `startJob blocked for ${Date.now() - t0}ms`);
  assert.equal(readJob('quick-return', { cwd }).state, 'running');
  const r = await waitJob('quick-return', { cwd, timeoutMs: 20_000, ...FAST });
  assert.equal(r.state, 'done');
});

test('the job outlives the process that started it', async (t) => {
  const cwd = scratch(t);
  const script = `import(${JSON.stringify(jobsUrl)}).then((m) => {
    m.startJob('orphan', ${JSON.stringify(node("setTimeout(()=>console.log('late-output'),1500)"))}, { cwd: ${JSON.stringify(cwd)} });
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
  for (const bad of ['', 'a b', 'a/b', 'a\\b', '..', '.', '...', 'trailing.', 'semi;colon', 'ünï', undefined, 7]) {
    assert.throws(() => startJob(bad, node('1'), { cwd }), /invalid job name/, `name ${String(bad)}`);
  }
  assert.equal(existsSync(join(cwd, '.review')), false);
  for (const ok of ['a', 'A-b_c.1', 'verify.full', '.hidden']) {
    assert.doesNotThrow(() => readJob(ok, { cwd }));
  }
  assert.throws(() => readJob('a/b', { cwd }), /invalid job name/);
});

test('a custom dir is honoured', async (t) => {
  const cwd = scratch(t);
  const started = startJob('custom', node("console.log('c')"), { cwd, dir: 'out/jobs' });
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
  startJob('ghost', node("console.log('reborn')"), { cwd });
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
  const { jobDir } = startJob('killed', node('setTimeout(()=>{},4000)'), { cwd });
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
  const { jobDir, pid } = startJob('termed', node('setTimeout(()=>{},4000)'), { cwd });
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
  const { jobDir } = startJob('pidfile', node('setTimeout(()=>{},800)'), { cwd });
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
  assert.throws(() => startJob('nocwd', node('1'), { cwd: join(cwd, 'missing-dir') }), /cwd does not exist/);
  assert.equal(existsSync(join(cwd, 'missing-dir')), false);
});
