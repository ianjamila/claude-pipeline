// Full stdout capture and `job wait --until-done` (plan C §2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startJob, waitJob, readJob } from '../pipeline/lib/jobs.mjs';
import { STDOUT_CAP_BYTES } from '../pipeline/lib/job-output.mjs';
import { createTmpRepo } from './helpers/tmprepo.mjs';
import { floorEnv } from './helpers/floor-env.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const bin = join(here, '..', 'pipeline', 'bin', 'pipeline.mjs');
const ENV = { ...process.env, ...floorEnv() };
delete ENV.PIPELINE_ADMIN;

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'cp-jobout-'));
  t.after(() => { try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* ignore */ } });
  return dir;
}
const allow = () => ({ allow: true });
const start = (name, command, opts = {}) => startJob(name, command, { policy: allow, ...opts });
const node = (js) => `node -e "${js}"`;
const jobDirOf = (cwd, name) => join(cwd, '.review', 'jobs', name);
const FAST = { pollMs: 25 };

test('the full stdout is on disk before the job reads as done', async (t) => {
  const cwd = scratch(t);
  const started = start('out', node("process.stdout.write('A'.repeat(300000)+'END')"), { cwd });
  const r = await waitJob('out', { cwd, timeoutMs: 15_000, full: true, ...FAST });
  assert.equal(r.state, 'done');
  assert.equal(r.output.length, 300003);
  assert.ok(r.output.endsWith('END'));
  assert.equal(r.outputTruncated, false);
  // the file exists and is complete at the moment exit.json does
  const dir = started.jobDir;
  assert.equal(statSync(join(dir, 'stdout')).size, 300003);
  assert.equal(JSON.parse(readFileSync(join(dir, 'exit.json'), 'utf8')).outputBytes, 300003);
});

test('stdout alone is captured; stderr stays out of it but is in the log', async (t) => {
  const cwd = scratch(t);
  start('mix', node("console.log('to-out');console.error('to-err')"), { cwd });
  const r = await waitJob('mix', { cwd, timeoutMs: 15_000, full: true, ...FAST });
  assert.equal(r.output, 'to-out\n');
  assert.match(r.tail, /to-out/);
  assert.match(r.tail, /to-err/);
});

test('output over 4 MiB is cut at the cap and flagged outputTruncated', async (t) => {
  const cwd = scratch(t);
  start('big', node("const c='x'.repeat(65536);for(let i=0;i<80;i++)process.stdout.write(c)"), { cwd });
  const r = await waitJob('big', { cwd, timeoutMs: 30_000, full: true, ...FAST });
  assert.equal(r.state, 'done');
  assert.equal(r.outputTruncated, true);
  assert.equal(r.output.length, STDOUT_CAP_BYTES);
  assert.equal(statSync(join(jobDirOf(cwd, 'big'), 'stdout')).size, STDOUT_CAP_BYTES);
});

test('without full the snapshot carries no output; a running job has none', async (t) => {
  const cwd = scratch(t);
  start('plain', node("console.log('hi')"), { cwd });
  const r = await waitJob('plain', { cwd, timeoutMs: 15_000, ...FAST });
  assert.equal('output' in r, false);
  start('run', node('setTimeout(()=>{},1500)'), { cwd });
  const running = readJob('run', { cwd, full: true });
  assert.equal(running.state, 'running');
  assert.equal('output' in running, false);
  await waitJob('run', { cwd, timeoutMs: 15_000, ...FAST });
});

test('a job started by an older runner (no stdout file, no outputBytes) reads with output null', (t) => {
  const cwd = scratch(t);
  const dir = jobDirOf(cwd, 'old');
  spawnSync('mkdir', ['-p', dir]);
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({ name: 'old', command: 'x', cwd, tag: 't', runId: 'r1', startedAt: new Date(Date.now() - 5000).toISOString(), runnerPid: 2 ** 22 }));
  writeFileSync(join(dir, 'exit.json'), JSON.stringify({ code: 0, signal: null, finishedAt: new Date().toISOString() }));
  writeFileSync(join(dir, 'log'), 'legacy\n');
  const r = readJob('old', { cwd, full: true });
  assert.equal(r.state, 'done');
  assert.equal(r.output, null);
  assert.equal(r.outputTruncated, false);
  assert.match(r.tail, /legacy/);
});

test('a command that exits while a grandchild still holds stdout open does not hang the job', { skip: process.platform === 'win32' }, async (t) => {
  const cwd = scratch(t);
  start('gc', "sh -c 'echo first; (sleep 8 &) ; exit 0'", { cwd });
  const t0 = Date.now();
  const r = await waitJob('gc', { cwd, timeoutMs: 15_000, full: true, ...FAST });
  assert.equal(r.state, 'done');
  assert.equal(r.output, 'first\n');
  assert.ok(Date.now() - t0 < 7000);
});

test('a process the command leaves logging past the drain deadline keeps logging; the capture is flagged drainTimedOut, not outputTruncated', { skip: process.platform === 'win32' }, async (t) => {
  const cwd = scratch(t);
  const pidFile = join(cwd, 'loop.pid');
  t.after(() => {
    try { process.kill(Number(readFileSync(pidFile, 'utf8').trim()), 'SIGKILL'); } catch { /* already gone */ }
  });
  start('tick', `sh -c 'echo ready; (while :; do echo tick; sleep 1; done) & echo $! > ${pidFile}; exit 0'`, { cwd });
  const r = await waitJob('tick', { cwd, timeoutMs: 20_000, full: true, ...FAST });
  assert.equal(r.state, 'done');
  assert.match(r.output, /^ready\n/);
  assert.equal(r.outputTruncated, false);
  assert.equal(r.drainTimedOut, true);
  const exit = JSON.parse(readFileSync(join(jobDirOf(cwd, 'tick'), 'exit.json'), 'utf8'));
  assert.equal(exit.drainTimedOut, true);
  assert.equal(exit.outputTruncated, false);
  const ticks = () => (readFileSync(join(jobDirOf(cwd, 'tick'), 'log'), 'utf8').match(/tick/g) ?? []).length;
  const before = ticks();
  await new Promise((resolve) => setTimeout(resolve, 2600));
  assert.ok(ticks() > before, 'the leftover process must still be logging after the job read done');
  process.kill(Number(readFileSync(pidFile, 'utf8').trim()), 0); // not killed by SIGPIPE
});

test('a normal job carries no drainTimedOut marker', async (t) => {
  const cwd = scratch(t);
  start('plain2', node("console.log('x')"), { cwd });
  const r = await waitJob('plain2', { cwd, timeoutMs: 15_000, full: true, ...FAST });
  assert.equal('drainTimedOut' in r, false);
});

test('after a normal job reads done its runner process is gone within ~1 s (the drain grace timer does not hold it for 3 s)', { skip: process.platform === 'win32' }, async (t) => {
  const cwd = scratch(t);
  const started = start('prompt', node("console.log('x')"), { cwd });
  const r = await waitJob('prompt', { cwd, timeoutMs: 15_000, full: true, ...FAST });
  assert.equal(r.state, 'done');
  const { runnerPid } = JSON.parse(readFileSync(join(started.jobDir, 'meta.json'), 'utf8'));
  assert.ok(Number.isInteger(runnerPid) && runnerPid > 0, 'meta.json records the runner pid');
  const alive = () => { try { process.kill(runnerPid, 0); return true; } catch { return false; } };
  const t0 = Date.now();
  while (alive() && Date.now() - t0 < 1000) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(alive(), false, 'the runner must exit once exit.json is written, not after the 3 s drain grace');
});

function cliSync(cwd, args) {
  const r = spawnSync(process.execPath, [bin, ...args], { cwd, encoding: 'utf8', env: ENV });
  let json = null;
  try { json = r.stdout ? JSON.parse(r.stdout) : null; } catch { /* leave null */ }
  return { code: r.status, json, stdout: r.stdout, stderr: r.stderr };
}
function repoWith() {
  const repo = createTmpRepo();
  repo.write('README.md', 'x\n');
  repo.commit('base');
  return repo;
}

test('job read --full returns the whole stdout; job wait --full too', (t) => {
  const repo = repoWith();
  t.after(() => repo.cleanup());
  assert.equal(cliSync(repo.dir, ['job', 'start', 'f', '--', 'node', '-e', 'console.log(JSON.stringify({a:1}))']).code, 0);
  const w = cliSync(repo.dir, ['job', 'wait', 'f', '--timeout', '30', '--full']);
  assert.equal(w.code, 0, w.stdout + w.stderr);
  assert.equal(w.json.output, '{"a":1}\n');
  const r = cliSync(repo.dir, ['job', 'read', 'f', '--full']);
  assert.equal(r.json.output, '{"a":1}\n');
  assert.equal(r.json.outputTruncated, false);
  assert.equal('output' in cliSync(repo.dir, ['job', 'read', 'f']).json, false);
});

test('job wait --until-done waits past the foreground cap value and returns done; --max-minutes ends it with running (exit 0)', (t) => {
  const repo = repoWith();
  t.after(() => repo.cleanup());
  assert.equal(cliSync(repo.dir, ['job', 'start', 'slow', '--', 'node', '-e', 'setTimeout(()=>{},1500)']).code, 0);
  const done = cliSync(repo.dir, ['job', 'wait', 'slow', '--until-done', '--max-minutes', '1']);
  assert.equal(done.code, 0, done.stdout + done.stderr);
  assert.equal(done.json.state, 'done');
  assert.equal(done.json.exitCode, 0);
  // default max-minutes is accepted too
  assert.equal(cliSync(repo.dir, ['job', 'start', 'slow2', '--', 'node', '-e', '0']).code, 0);
  assert.equal(cliSync(repo.dir, ['job', 'wait', 'slow2', '--until-done']).json.state, 'done');
});

test('job wait --until-done: limits are validated; --max-minutes alone and --timeout together are usage errors', (t) => {
  const repo = repoWith();
  t.after(() => repo.cleanup());
  for (const args of [
    ['job', 'wait', 'x', '--until-done', '--max-minutes', '121'],
    ['job', 'wait', 'x', '--until-done', '--max-minutes', '0'],
    ['job', 'wait', 'x', '--max-minutes', '5'],
    ['job', 'wait', 'x', '--until-done', '--timeout', '5'],
  ]) {
    const r = cliSync(repo.dir, args);
    assert.equal(r.code, 2, args.join(' '));
    assert.equal(r.json.error, 'usage');
  }
});

test('foreground cap unchanged: --timeout above 570 is still a usage error, 570 is accepted', (t) => {
  const repo = repoWith();
  t.after(() => repo.cleanup());
  assert.equal(cliSync(repo.dir, ['job', 'wait', 'x', '--timeout', '571']).code, 2);
  const missing = cliSync(repo.dir, ['job', 'wait', 'x', '--timeout', '570']);
  assert.equal(missing.json.error, 'not-found'); // passed validation, then no such job
});

test('killing a waiting `job wait --until-done` leaves the job intact; a rerun adopts it', { skip: process.platform === 'win32' }, async (t) => {
  const repo = repoWith();
  t.after(() => repo.cleanup());
  const started = cliSync(repo.dir, ['job', 'start', 'k', '--', 'node', '-e', 'setTimeout(function(){console.log(1)},3000)']);
  assert.equal(started.code, 0);
  const waiter = spawn(process.execPath, [bin, 'job', 'wait', 'k', '--until-done', '--run-id', started.json.runId], { cwd: repo.dir, env: ENV, stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 400));
  waiter.kill('SIGKILL');
  await new Promise((r) => waiter.on('exit', r));
  const mid = cliSync(repo.dir, ['job', 'read', 'k', '--run-id', started.json.runId]);
  assert.equal(mid.json.state, 'running');
  const again = cliSync(repo.dir, ['job', 'wait', 'k', '--until-done', '--full', '--run-id', started.json.runId]);
  assert.equal(again.json.state, 'done');
  assert.equal(again.json.output, '1\n');
  assert.ok(existsSync(join(repo.dir, '.review', 'jobs', 'k', 'stdout')));
});
