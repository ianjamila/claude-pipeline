// `pipeline round codex` (plan C §1): the real CLI against a throwaway repo, a fake gh and a scripted fake Codex (test/helpers/round-world.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, openSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { roundWorld, findingsOf, low } from './helpers/round-world.mjs';
import { assertExit } from './helpers/assert-exit.mjs';
import { REPO_VIEW } from './helpers/fakegh-env.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const bin = join(here, '..', 'pipeline', 'bin', 'pipeline.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FAST = { PIPELINE_ROUND_POLL_MS: '100' };
const ok = (w, findings = findingsOf([], [low()]), name = 'f.json') => ({ FAKE_CODEX_OUTPUT: w.file(name, findings) });
const rc = (w, extra = [], env = {}, round = '1') => w.cli(['round', 'codex', '--pr', '7', '--round', round, ...extra], { ...FAST, ...env });
const jobsDir = (w) => join(w.repo.dir, '.review', 'jobs');
const tagOf = (w, base, head, round = 1) => `7:${round}:${base}:${head}`;
// A job that prints `json` and exits `code` after `ms`, standing in for a codex-review run (the file is a plain script: no quotes for the guard to read).
function emitter(w) {
  const file = w.file('emit.mjs', 'const [code, json, ms] = process.argv.slice(2);\nsetTimeout(() => { if (json) console.log(json); process.exit(Number(code)); }, Number(ms || 0));\n');
  return (code, json, ms = 0) => ['node', file, String(code), json, String(ms)];
}
const startJob = (w, tag, cmd, env = {}) => assertExit(w.cli(['job', 'start', '--tag', tag, 'codex-r1', '--', ...cmd], env), 0);
const untilExists = async (file, ms = 15_000) => {
  const end = Date.now() + ms;
  while (!existsSync(file)) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${file}`);
    await sleep(50);
  }
};
// Run `round codex` in the background of the test: -> { done: Promise<{code, json}> }.
function startRound(w, extra = [], env = {}) {
  const merged = { ...process.env, ...w.fake.env, PIPELINE_CODEX: `node "${join(here, 'fixtures', 'fake-codex.mjs')}"`, PIPELINE_LOCK_DIR: join(w.scratch, 'locks'), ...FAST, ...env };
  const child = spawn(process.execPath, [bin, 'round', 'codex', '--pr', '7', '--round', '1', ...extra], { cwd: w.repo.dir, env: merged, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  const done = new Promise((resolve) => child.on('close', (code) => { let json = null; try { json = JSON.parse(out); } catch { /* leave null */ } resolve({ code, json, out }); }));
  return { child, done };
}
const slowCodex = (w, ms = 4) => ({ ...ok(w), FAKE_CODEX_DURING: `sleep ${ms}` });
const metaOf = (w) => JSON.parse(readFileSync(join(jobsDir(w), 'codex-r1', 'meta.json'), 'utf8'));

test('round 1 with no state runs plan, job and wait and reports counts, path and reviewer', (t) => {
  const w = roundWorld(t, { max: 3 });
  const r = rc(w, [], ok(w));
  assertExit(r, 0, r.stdout + r.stderr);
  assert.equal(r.json.ok, true);
  assert.deepEqual(r.json.codex.counts, { blocking: 0, suggestions: 1, worth_considering: 0 });
  assert.match(r.json.codex.codexPath, /round-1$/);
  assert.equal(r.json.reviewer, 'judge');
  assert.equal('arbiter' in r.json, false, 'a judge round asks nothing of the arbiter');
  assert.equal(w.state().rounds.length, 1);
  assert.equal(w.state().rounds[0].fromHead, w.base);
  assert.equal(metaOf(w).tag, tagOf(w, w.base, w.head), 'the job is tagged pr:round:base:head');
});

test('identity: another PR\'s state, a wrong round, or an already recorded round is refused before any child runs', (t) => {
  const w = roundWorld(t, { max: 3 });
  assertExit(w.codex(1, findingsOf([], [low()])), 0);
  rmSync(jobsDir(w), { recursive: true, force: true });
  const capture = join(w.scratch, 'capture.jsonl');
  const env = { FAKE_CODEX_CAPTURE: capture, ...ok(w) };
  const refused = (r) => {
    assertExit(r, 1, r.stdout + r.stderr);
    assert.equal(r.json.error, 'identity-mismatch');
    assert.equal(existsSync(jobsDir(w)), false, 'no job was started');
    assert.equal(existsSync(capture), false, 'Codex did not run');
  };
  refused(rc(w, [], env, '3'));
  refused(rc(w, [], env, '1')); // recorded, and no job of this round to pick up
  w.edit((s) => { s.pr = 8; });
  refused(rc(w, [], env, '2'));
});

test('base default is what admission demands: round 2 starts at round 1\'s toHead', (t) => {
  const w = roundWorld(t, { max: 3 });
  assertExit(rc(w, [], ok(w)), 0);
  w.repo.write('src/fix.js', 'export const fix = 1;\n');
  const h2 = w.repo.commit('fix');
  w.prHead(h2);
  const r = rc(w, [], ok(w, findingsOf(), 'g.json'), '2');
  assertExit(r, 0, r.stdout + r.stderr);
  assert.equal(w.state().rounds[1].fromHead, w.head);
  assert.equal(w.state().rounds[1].toHead, h2);
});

test('base default for a stacked PR is the merge base with the PR\'s real base branch, not the default branch', (t) => {
  const w = roundWorld(t, { max: 3 });
  w.repo.git(['branch', 'stack-base']); // the parent PR's branch at the feature commit
  w.repo.write('src/s.js', 'export const s = 1;\n');
  const h2 = w.repo.commit('stacked work');
  w.fake.setScript([
    { match: '^pr view 7', stdoutJson: { title: 'Stacked', body: 'b', headRefName: 'feat/x', baseRefName: 'stack-base', headRefOid: h2 } },
    { match: '^repo view', stdoutJson: { ...REPO_VIEW, nameWithOwner: w.slug, url: `https://github.com/${w.slug}` } },
  ]);
  const r = rc(w, [], ok(w));
  assertExit(r, 0, r.stdout + r.stderr);
  assert.equal(w.state().rounds[0].fromHead, w.head, 'round 1 starts at the stack parent\'s tip');
  assert.notEqual(w.state().rounds[0].fromHead, w.base);
});

test('a tag or branch named main / origin/main does not move the default base', (t) => {
  const w = roundWorld(t, { max: 3 });
  w.repo.git(['tag', 'main', w.head]);
  w.repo.git(['tag', 'origin/main', w.head]);
  w.repo.git(['branch', 'origin/main', w.head]);
  const r = rc(w, [], ok(w));
  assertExit(r, 0, r.stdout + r.stderr);
  assert.equal(w.state().rounds[0].fromHead, w.base);
});

test('explicit --base/--head pass through unchanged (a wrong base is codex-review\'s own base-mismatch, JSON unchanged)', (t) => {
  const w = roundWorld(t, { max: 3 });
  const r = rc(w, ['--base', w.head, '--head', w.head], ok(w));
  assertExit(r, 2, r.stdout + r.stderr);
  assert.equal(r.json.error, 'base-mismatch');
  assert.equal(r.json.ok, false);
  assert.equal(existsSync(jobsDir(w)), false);
});

test('a running job with the SAME tag is adopted: Codex runs once', (t) => {
  const w = roundWorld(t, { max: 3 });
  const capture = join(w.scratch, 'capture.jsonl');
  const env = { FAKE_CODEX_CAPTURE: capture, ...slowCodex(w, 2) };
  startJob(w, tagOf(w, w.base, w.head), ['node', bin, 'codex-review', '--pr', '7', '--round', '1', '--base', w.base, '--head', w.head, '--effort', 'high'], env);
  const r = rc(w, [], env);
  assertExit(r, 0, r.stdout + r.stderr);
  assert.deepEqual(r.json.codex.counts, { blocking: 0, suggestions: 1, worth_considering: 0 });
  assert.equal(readFileSync(capture, 'utf8').trim().split('\n').length, 1, 'one Codex run, not two');
});

test('a running job with ANOTHER tag is a job-conflict and nothing is started', (t) => {
  const w = roundWorld(t, { max: 3 });
  const emit = emitter(w);
  startJob(w, 'something-else', emit(0, '{}', 2500));
  const r = rc(w, [], ok(w));
  assertExit(r, 1, r.stdout + r.stderr);
  assert.equal(r.json.error, 'job-conflict');
  assert.equal(r.json.tag, 'something-else');
  assert.equal(existsSync(join(w.repo.dir, '.review', 'state.json')), false);
});

test('still running at the limit: exit 0 state running, next rerun round codex; the rerun adopts the same job', (t) => {
  const w = roundWorld(t, { max: 3 });
  const env = { ...slowCodex(w, 4), PIPELINE_ROUND_WAIT_MS: '800' };
  const first = rc(w, [], env);
  assertExit(first, 0, first.stdout + first.stderr);
  assert.deepEqual([first.json.state, first.json.next], ['running', 'rerun round codex']);
  const again = rc(w, [], { ...slowCodex(w, 4), PIPELINE_ROUND_WAIT_MS: '60000' });
  assertExit(again, 0, again.stdout + again.stderr);
  assert.equal(again.json.codex.counts.suggestions, 1);
  assert.equal(again.json.state, undefined);
});

test('exit 3 (Codex unavailable) and exit 2 (head moved while Codex ran) are Codex\'s JSON, unchanged, with its exit code', (t) => {
  const w = roundWorld(t, { max: 3 });
  const down = rc(w, [], { FAKE_CODEX_EXIT: '2', FAKE_CODEX_STDERR: 'segfault' });
  assertExit(down, 3, down.stdout + down.stderr);
  assert.equal(down.json.unavailable, true);
  assert.equal(down.json.ok, false);
  const moved = rc(w, [], { ...ok(w), FAKE_CODEX_DURING: 'git commit --allow-empty -q -m moved' });
  assertExit(moved, 2, moved.stdout + moved.stderr);
  assert.equal(moved.json.error, 'head-moved');
});

test('empty-range from the plan step is codex-review\'s JSON unchanged (exit 2) and no job starts', (t) => {
  const w = roundWorld(t, { max: 3 });
  assertExit(w.codex(1, findingsOf([], [low()])), 0);
  assertExit(w.judge(1, { 'R1-S1': ['ACCEPT'] }), 0);
  rmSync(jobsDir(w), { recursive: true, force: true });
  const r = rc(w, [], ok(w), '2');
  assertExit(r, 2, r.stdout + r.stderr);
  assert.equal(r.json.error, 'empty-range');
  assert.equal(existsSync(jobsDir(w)), false);
});

test('exit-2 variants of the job are keyed on the JSON error: update-in-progress reruns, the rest stop unchanged, no JSON is codex-no-json', (t) => {
  const w = roundWorld(t, { max: 3 });
  const emit = emitter(w);
  const tag = tagOf(w, w.base, w.head);
  const via = (code, json) => { startJob(w, tag, emit(code, json, 400)); return rc(w, []); };
  const upd = via(2, '{"ok":false,"error":"update-in-progress","message":"an update is running"}');
  assertExit(upd, 2, upd.stdout);
  assert.deepEqual([upd.json.error, upd.json.next], ['update-in-progress', 'rerun in a minute']);
  for (const error of ['already-applied', 'not-found', 'usage']) {
    const r = via(2, `{"ok":false,"error":"${error}","message":"m"}`);
    assertExit(r, 2, r.stdout);
    assert.equal(r.json.error, error);
    assert.equal('next' in r.json, false);
  }
  const crash = via(2, '');
  assertExit(crash, 2, crash.stdout);
  assert.deepEqual([crash.json.error, crash.json.next], ['codex-no-json', 'job read']);
});

test('job lost (the runner was killed) stops with the job JSON; never a discard', { skip: process.platform === 'win32' }, async (t) => {
  const w = roundWorld(t, { max: 3 });
  const run = startRound(w, [], slowCodex(w, 6));
  await untilExists(join(jobsDir(w), 'codex-r1', 'child.json'));
  process.kill(-metaOf(w).runnerPid, 'SIGKILL');
  const r = await run.done;
  assert.equal(r.code, 1, r.out);
  assert.equal(r.json.state, 'lost');
  assert.equal(r.json.ok, false);
  assert.equal(existsSync(join(w.repo.dir, '.review', 'state.json')), false);
});

test('job missing (its folder is gone) stops with the job JSON, exit 2', { skip: process.platform === 'win32' }, async (t) => {
  const w = roundWorld(t, { max: 3 });
  const run = startRound(w, [], slowCodex(w, 3));
  await untilExists(join(jobsDir(w), 'codex-r1', 'child.json'));
  rmSync(join(jobsDir(w), 'codex-r1'), { recursive: true, force: true });
  const r = await run.done;
  assert.equal(r.code, 2, r.out);
  assert.equal(r.json.state, 'missing');
});

test('job replaced by another run: next reconcile, exit 1, nothing discarded', { skip: process.platform === 'win32' }, async (t) => {
  const w = roundWorld(t, { max: 3 });
  const run = startRound(w, [], slowCodex(w, 3));
  const metaFile = join(jobsDir(w), 'codex-r1', 'meta.json');
  await untilExists(join(jobsDir(w), 'codex-r1', 'child.json'));
  writeFileSync(metaFile, JSON.stringify({ ...metaOf(w), runId: 'another-sessions-run' }));
  const r = await run.done;
  assert.equal(r.code, 1, r.out);
  assert.deepEqual([r.json.state, r.json.next], ['replaced', 'reconcile']);
  assert.doesNotMatch(r.out, /discard-round/);
  await sleep(4000); // let the orphaned fake Codex finish before the world is removed
});

test('a finished job with no stdout capture (an older runner) or a cut one: the report comes from the state when round R is recorded', (t) => {
  const w = roundWorld(t, { max: 3 });
  assertExit(rc(w, [], ok(w)), 0);
  const dir = join(jobsDir(w), 'codex-r1');
  const exitFile = join(dir, 'exit.json');
  const exit = JSON.parse(readFileSync(exitFile, 'utf8'));
  // 1. an older runner: no stdout file, no outputBytes
  rmSync(join(dir, 'stdout'));
  const { outputBytes: _b, outputTruncated: _t, ...old } = exit;
  writeFileSync(exitFile, JSON.stringify(old));
  const fromOld = rc(w, [], ok(w));
  assertExit(fromOld, 0, fromOld.stdout + fromOld.stderr);
  assert.equal(fromOld.json.codex.fromState, true);
  assert.deepEqual(fromOld.json.codex.counts, { blocking: 0, suggestions: 1, worth_considering: 0 });
  assert.equal(fromOld.json.reviewer, 'judge');
  // 2. a cut capture
  writeFileSync(join(dir, 'stdout'), '{"ok":true');
  writeFileSync(exitFile, JSON.stringify({ ...exit, outputTruncated: true }));
  const cut = rc(w, [], ok(w));
  assertExit(cut, 0, cut.stdout + cut.stderr);
  assert.equal(cut.json.codex.fromState, true);
  assert.equal(w.state().rounds.length, 1, 'nothing was run or discarded');
});

test('a done job left by a discarded round is not picked up for the same round recorded again at another head (the tag\'s base:head must be the recorded range)', (t) => {
  const w = roundWorld(t, { max: 3 });
  assertExit(rc(w, [], ok(w)), 0);
  assertExit(w.cli(['state', 'discard-round', '--round', '1', '--pr', '7']), 0);
  assert.equal(existsSync(join(jobsDir(w), 'codex-r1', 'exit.json')), true, 'discard-round leaves the old job behind');
  w.repo.write('src/fix.js', 'export const fix = 1;\n');
  const h2 = w.repo.commit('fix');
  w.prHead(h2);
  assertExit(w.codex(1, findingsOf([], [low()]), { from: w.base, to: h2 }), 0); // round 1 again, no codex-r1 job for it
  const r = rc(w, [], ok(w));
  assertExit(r, 1, r.stdout + r.stderr);
  assert.equal(r.json.error, 'identity-mismatch');
  assert.equal('codex' in r.json, false, 'the old job\'s output was not reported');
  assert.equal(w.state().rounds.length, 1, 'nothing was run or discarded');
});

test('a failed job (exit 3) while the state already records round R (the substitute path) reports from the state, not the failure JSON', (t) => {
  const w = roundWorld(t, { max: 3 });
  const emit = emitter(w);
  assertExit(w.codex(1, findingsOf([], [low()])), 0); // round 1 recorded another way, same range
  startJob(w, tagOf(w, w.base, w.head), emit(3, '{"ok":false,"unavailable":true,"error":"codex-unavailable","substitute":{"eligible":true}}', 0));
  const r = rc(w, []);
  assertExit(r, 0, r.stdout + r.stderr);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.codex.fromState, true);
  assert.equal('unavailable' in r.json, false);
  assert.deepEqual(r.json.codex.counts, { blocking: 0, suggestions: 1, worth_considering: 0 });
});

test('a failed arbiter needed is ok:false, step arbiter-needed, the child\'s error and JSON as result, the child\'s exit code', (t) => {
  const w = roundWorld(t, { max: 3, yml: 'risk:\n  high_risk_paths: ["src/a.js"]\n' });
  const cc = join(w.scratch, 'claude-code-2.1.322');
  mkdirSync(join(cc, 'bin'), { recursive: true });
  writeFileSync(join(cc, 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-code', version: '2.1.322' }));
  const stale = { AI_AGENT: 'claude-code_2-1-318_agent', CLAUDE_CODE_EXECPATH: join(cc, 'bin', 'claude.exe') };
  const r = rc(w, [], { ...ok(w), ...stale });
  assertExit(r, 1, r.stdout + r.stderr);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.step, 'arbiter-needed');
  assert.equal(r.json.error, 'stale-terminal');
  assert.equal(r.json.result.restartRequired, true);
  assert.equal(r.json.reviewer, 'fable');
  assert.deepEqual(r.json.codex.counts, { blocking: 0, suggestions: 1, worth_considering: 0 });
  assert.equal('arbiter' in r.json, false);
});

test('exit 0 with no usable output and no recorded round: result-unavailable, next job read', (t) => {
  const w = roundWorld(t, { max: 3 });
  const emit = emitter(w);
  startJob(w, tagOf(w, w.base, w.head), emit(0, '', 500));
  const r = rc(w, []);
  assertExit(r, 1, r.stdout + r.stderr);
  assert.deepEqual([r.json.error, r.json.next], ['result-unavailable', 'job read']);
});

test('reviewer fable with no arbiter record: arbiter needed runs once and its JSON is returned verbatim', (t) => {
  const w = roundWorld(t, { max: 3, yml: 'risk:\n  high_risk_paths: ["src/a.js"]\n' });
  const r = rc(w, [], ok(w));
  assertExit(r, 0, r.stdout + r.stderr);
  assert.equal(r.json.reviewer, 'fable');
  const direct = w.cli(['arbiter', 'needed', '--pr', '7', '--round', '1']);
  assert.equal(r.json.arbiter.needed, true);
  assert.equal(r.json.arbiter.agent, direct.json.agent);
  assert.equal(r.json.arbiter.tag, direct.json.tag);
  assert.equal(r.json.arbiter.inputPath, direct.json.inputPath);
  assert.equal(typeof r.json.arbiter.promptHeader, 'string');
});

test('reviewer fable WITH an arbiter record: arbiter needed is not called (the record is untouched) and the state is reported', (t) => {
  const w = roundWorld(t, { max: 3, yml: 'risk:\n  high_risk_paths: ["src/a.js"]\n' });
  assertExit(rc(w, [], ok(w)), 0);
  w.edit((s) => { s.rounds[0].arbiter = { proofOk: false, marker: 'untouched' }; });
  const before = w.stateText();
  const r = rc(w, [], ok(w)); // round 1 is recorded: its finished job is picked up
  assertExit(r, 0, r.stdout + r.stderr);
  assert.equal('arbiter' in r.json, false);
  assert.deepEqual(r.json.arbiterState, { recorded: true, proofOk: false });
  assert.equal(w.stateText(), before, 'needed would have rewritten the round');
});

// Starts `round codex` from a launcher that exits once the round command has REACHED a known point (`readyFile` exists), never after a fixed time:
// under load the command's first steps can take longer than any fixed delay. -> { out } (the file the orphan prints its JSON to).
function orphanedRound(w, readyFile, env) {
  const out = join(w.scratch, 'orphan.out');
  const launcher = w.file('launch.mjs', [
    "import { spawn } from 'node:child_process';",
    "import { existsSync, openSync } from 'node:fs';",
    'const fd = openSync(process.env.ORPHAN_OUT, "w");',
    `const c = spawn(process.execPath, [${JSON.stringify(bin)}, "round", "codex", "--pr", "7", "--round", "1"], { cwd: process.cwd(), env: process.env, detached: true, stdio: ["ignore", fd, fd] });`,
    'c.unref();',
    'const end = Date.now() + 90000;',
    'const poll = () => { if (existsSync(process.env.ORPHAN_READY) || Date.now() > end) process.exit(0); else setTimeout(poll, 50); };',
    'poll();',
  ].join('\n'));
  const full = { ...process.env, ...w.fake.env, PIPELINE_CODEX: `node "${join(here, 'fixtures', 'fake-codex.mjs')}"`, PIPELINE_LOCK_DIR: join(w.scratch, 'locks'), ...FAST, ...env, ORPHAN_OUT: out, ORPHAN_READY: readyFile };
  const started = spawnSync(process.execPath, [launcher], { cwd: w.repo.dir, env: full, encoding: 'utf8' });
  assert.equal(started.status, 0, started.stderr);
  assert.equal(existsSync(readyFile), true, 'the round command reached the point the launcher waits for');
  return { out };
}
async function orphanJson(out) {
  const end = Date.now() + 60_000;
  while (Date.now() < end) {
    await sleep(100);
    try { return JSON.parse(readFileSync(out, 'utf8')); } catch { /* not yet */ }
  }
  assert.fail('the orphaned command printed no result');
}

test('the command ends when its parent process is gone; the job keeps running', { skip: process.platform === 'win32' }, async (t) => {
  const w = roundWorld(t, { max: 3 });
  // the parent ends once the job's runner has started the command (child.json), however long the steps before took
  const { out } = orphanedRound(w, join(jobsDir(w), 'codex-r1', 'child.json'), slowCodex(w, 8));
  const json = await orphanJson(out);
  assert.deepEqual([json.error, json.next, json.state], ['parent-gone', 'rerun round codex', 'running']);
  const job = w.cli(['job', 'read', 'codex-r1']);
  assert.equal(job.json.state === 'running' || job.json.state === 'done', true);
  const finished = w.cli(['job', 'wait', 'codex-r1', '--timeout', '60']);
  assert.equal(finished.json.state, 'done');
  assert.equal(finished.json.exitCode, 0);
});

test('the parent gone BEFORE the job starts: parent-gone, no job is started', { skip: process.platform === 'win32' }, async (t) => {
  const w = roundWorld(t, { max: 3 });
  const hold = join(w.scratch, 'hold');
  // PIPELINE_ROUND_HOLD_AFTER_PLAN: the command writes hold.reached after the plan step, then waits for hold; the parent ends in between
  const { out } = orphanedRound(w, `${hold}.reached`, { ...ok(w), PIPELINE_ROUND_HOLD_AFTER_PLAN: hold });
  writeFileSync(hold, 'go\n');
  const json = await orphanJson(out);
  assert.deepEqual([json.ok, json.error, json.next], [false, 'parent-gone', 'rerun round codex']);
  assert.equal('state' in json, false);
  assert.equal(existsSync(jobsDir(w)), false, 'no job was started');
});

test('usage: --max-minutes is bounded 1..120', (t) => {
  const w = roundWorld(t, { max: 3 });
  for (const v of ['0', '121', 'x']) assertExit(rc(w, ['--max-minutes', v], ok(w)), 2);
  assert.equal(existsSync(jobsDir(w)), false);
});
