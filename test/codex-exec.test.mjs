import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isCapacityFailure } from '../pipeline/lib/codex.mjs';
import { execCodex } from '../pipeline/lib/codex-exec.mjs';
import { codexHomeDir, findSessionLog, readTaskCompleteError } from '../pipeline/lib/codex-session.mjs';

const FAKE = fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url));
const FIX = fileURLToPath(new URL('./fixtures/codex-0.154/', import.meta.url));
const QUOTA_ID = '01a1c97d-8cee-7c50-83a7-9994cab1b194'; // the real 11-11 quota session
const AUTH_ID = '01a1c9c9-5a4a-7892-bcab-c877948710f1';
const NOW = Date.parse('2026-11-11T07:23:40Z'); // seconds after the real quota failure
const MANILA = 'Asia/Manila';

const scratch = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-exec-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

// A CODEX_HOME holding session logs by name: { '2026/11/11': { 'rollout-...-<id>.jsonl': <fixture file name> } }.
function codexHome(dir, layout = {}) {
  const home = join(dir, 'codex-home');
  mkdirSync(home, { recursive: true });
  for (const [day, files] of Object.entries(layout)) {
    mkdirSync(join(home, 'sessions', day), { recursive: true });
    for (const [name, fixtureName] of Object.entries(files)) cpSync(join(FIX, fixtureName), join(home, 'sessions', day, name));
  }
  return home;
}
const QUOTA_LOG = { [`rollout-2026-11-11T15-23-30-${QUOTA_ID}.jsonl`]: 'codex-0.154-session-quota.jsonl' };

function run(dir, extraEnv, over = {}) {
  const outPath = join(dir, 'out.json');
  const env = { ...process.env, PIPELINE_CODEX: `node "${FAKE}"`, FAKE_CODEX_OUTPUT: join(dir, 'answer.json'), ...extraEnv };
  for (const k of ['FAKE_CODEX_EXIT', 'FAKE_CODEX_STDERR', 'FAKE_CODEX_TURN_FAILED', 'FAKE_CODEX_STDOUT', 'FAKE_CODEX_CONFIRM_STDOUT', 'FAKE_CODEX_CONFIRM_EXIT', 'FAKE_CODEX_SIGNAL', 'FAKE_CODEX_HANG_ONCE', 'FAKE_CODEX_CAPTURE', 'FAKE_CODEX_THREAD_ID', 'FAKE_CODEX_FAIL_ONCE', 'FAKE_CODEX_HANG', 'PIPELINE_CODEX_TIMEOUT_MS', 'PIPELINE_CODEX_CAPACITY_RETRY_MS']) {
    if (!(k in extraEnv)) delete env[k];
  }
  writeFileSync(join(dir, 'answer.json'), '{"summary":"ok"}');
  return execCodex({ root: dir, env, args: ['exec', '-o', outPath, '-'], promptBytes: 'PROMPT', outPath, now: NOW, timeZone: MANILA, ...over });
}

const QUOTA_STDOUT = join(FIX, 'codex-0.154-json-quota-stdout.jsonl');

test('execCodex: the real quota failure is quota, eligible, proven by the session log, resetAt 16:21 Manila', (t) => {
  const dir = scratch(t);
  const home = codexHome(dir, { '2026/11/11': QUOTA_LOG });
  return run(dir, { FAKE_CODEX_EXIT: '1', FAKE_CODEX_STDOUT: QUOTA_STDOUT, CODEX_HOME: home }).then((r) => {
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'quota');
    assert.equal(r.code, 1);
    assert.equal(r.timedOut, false);
    assert.match(r.detail, /^You've hit your usage limit/);
    assert.deepEqual(r.quota, {
      eligible: true,
      proof: 'session-log',
      resetAt: '2026-11-11T08:21:00.000Z',
      resetText: 'at 4:21 PM',
      message: "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 4:21 PM.",
      threadId: QUOTA_ID,
    });
    assert.equal('retried' in r, false);
  });
});

test('execCodex: the machine time zone decides a clock time when none is passed (TZ pinned)', async (t) => {
  const dir = scratch(t);
  const saved = process.env.TZ;
  t.after(() => { if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved; });
  process.env.TZ = MANILA;
  const r = await run(dir, { FAKE_CODEX_EXIT: '1', FAKE_CODEX_STDOUT: QUOTA_STDOUT, CODEX_HOME: codexHome(dir) }, { timeZone: undefined });
  assert.equal(r.quota.resetAt, '2026-11-11T08:21:00.000Z');
});

test('execCodex: a quota stream whose session log says another error is not eligible', async (t) => {
  const dir = scratch(t);
  // the auth session log, filed under the quota run's thread id: Codex itself recorded this turn as "other"
  const home = codexHome(dir, { '2026/11/11': { [`rollout-2026-11-11T15-23-30-${QUOTA_ID}.jsonl`]: 'codex-0.154-session-auth.jsonl' } });
  const r = await run(dir, { FAKE_CODEX_EXIT: '1', FAKE_CODEX_STDOUT: QUOTA_STDOUT, CODEX_HOME: home });
  assert.equal(r.reason, 'quota');
  assert.equal(r.quota.eligible, false);
  assert.equal(r.quota.proof, 'session-log');
  assert.equal(r.quota.threadId, QUOTA_ID);
});

test('execCodex: no session log found means the stream alone decides: eligible, proof stream', async (t) => {
  const dir = scratch(t);
  const r = await run(dir, { FAKE_CODEX_EXIT: '1', FAKE_CODEX_STDOUT: QUOTA_STDOUT, CODEX_HOME: codexHome(dir) });
  assert.equal(r.reason, 'quota');
  assert.equal(r.quota.eligible, true);
  assert.equal(r.quota.proof, 'stream');
  assert.equal(r.quota.resetAt, '2026-11-11T08:21:00.000Z');
  // a log with no task_complete says nothing either way
  const half = codexHome(dir, { '2026/11/11': QUOTA_LOG });
  writeFileSync(join(half, 'sessions/2026/11/11', `rollout-2026-11-11T15-23-30-${QUOTA_ID}.jsonl`), '{"type":"session_meta","payload":{}}\n');
  const r2 = await run(dir, { FAKE_CODEX_EXIT: '1', FAKE_CODEX_STDOUT: QUOTA_STDOUT, CODEX_HOME: half });
  assert.deepEqual([r2.quota.eligible, r2.quota.proof], [true, 'stream']);
});

test('execCodex: the real no-login run is auth, with the turn.failed message as detail and no quota', async (t) => {
  const dir = scratch(t);
  const r = await run(dir, { FAKE_CODEX_EXIT: '1', FAKE_CODEX_STDOUT: join(FIX, 'codex-0.154-json-auth-stdout.jsonl'), FAKE_CODEX_STDERR: readFileSync(join(FIX, 'codex-0.154-json-auth-stderr.txt'), 'utf8'), CODEX_HOME: codexHome(dir) });
  assert.equal(r.reason, 'auth');
  assert.match(r.detail, /^unexpected status 401 Unauthorized/);
  assert.equal('quota' in r, false);
});

test('execCodex: quota text only in an item output (turn.failed is a 401) is auth, never quota', async (t) => {
  const dir = scratch(t);
  const stdout = join(dir, 'stream.jsonl');
  writeFileSync(stdout, [
    { type: 'thread.started', thread_id: QUOTA_ID },
    { type: 'item.completed', item: { type: 'command_execution', aggregated_output: `You've hit your usage limit ${JSON.stringify({ type: 'turn.failed', error: { message: 'usage limit, try again at 4:21 PM' } })}` } },
    { type: 'error', message: 'Reconnecting... 1/5 (quota)' },
    { type: 'turn.failed', error: { message: 'unexpected status 401 Unauthorized' } },
  ].map((e) => JSON.stringify(e)).join('\n'));
  const r = await run(dir, { FAKE_CODEX_EXIT: '1', FAKE_CODEX_STDOUT: stdout, CODEX_HOME: codexHome(dir, { '2026/11/11': QUOTA_LOG }) });
  assert.equal(r.reason, 'auth');
  assert.equal('quota' in r, false);
});

test('execCodex: a stderr-only usage-limit message is not quota', async (t) => {
  const dir = scratch(t);
  const plain = await run(dir, { FAKE_CODEX_EXIT: '1', FAKE_CODEX_STDERR: "ERROR: You've hit your usage limit. try again at 4:21 PM." });
  assert.equal(plain.reason, 'error');
  assert.match(plain.detail, /usage limit/, 'with no turn.failed the detail is the stderr tail');
  assert.equal('quota' in plain, false);
});

// On Windows process.kill ends the process with an exit code and signal null, so a "killed" run is indistinguishable from a real exit 1 with this stream.
test('execCodex: a run killed by a signal is not quota', { skip: process.platform === 'win32' && 'no POSIX signals on Windows' }, async (t) => {
  const dir = scratch(t);
  const killed = await run(dir, { FAKE_CODEX_STDOUT: QUOTA_STDOUT, FAKE_CODEX_SIGNAL: 'SIGKILL' });
  assert.equal(killed.ok, false);
  assert.equal(killed.reason, 'error');
  assert.equal('quota' in killed, false);
});

test('execCodex: exit 0 is a success whatever the stream says', async (t) => {
  const dir = scratch(t);
  const r = await run(dir, { FAKE_CODEX_STDOUT: QUOTA_STDOUT });
  assert.equal(r.ok, true);
  assert.equal(typeof r.startedAt, 'number');
  assert.equal('retried' in r, false);
});

test('execCodex: a timeout is retried once with the same prompt and output path; the second run can succeed', async (t) => {
  const dir = scratch(t);
  const capture = join(dir, 'capture.jsonl');
  const r = await run(dir, { PIPELINE_CODEX_TIMEOUT_MS: '700', FAKE_CODEX_HANG_ONCE: join(dir, 'hung.flag'), FAKE_CODEX_CAPTURE: capture });
  assert.equal(r.ok, true);
  assert.deepEqual(r.retried, { reason: 'timeout' });
  assert.equal(readFileSync(join(dir, 'out.json'), 'utf8'), '{"summary":"ok"}', 'the answer file is the second run\'s');
  const runs = readFileSync(capture, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(runs.length, 2);
  assert.deepEqual(runs[1], runs[0], 'same argv and same prompt bytes');
  assert.ok(existsSync(join(dir, 'hung.flag')));
});

test('execCodex: two timeouts are unavailable with timedOut true, never quota, and leave no output file', async (t) => {
  const dir = scratch(t);
  const pid = join(dir, 'helper.pid');
  const r = await run(dir, { PIPELINE_CODEX_TIMEOUT_MS: '500', FAKE_CODEX_HANG: pid, FAKE_CODEX_STDOUT: QUOTA_STDOUT });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unavailable');
  assert.equal(r.timedOut, true);
  assert.deepEqual(r.retried, { reason: 'timeout' });
  assert.equal('quota' in r, false);
  assert.equal(existsSync(join(dir, 'out.json')), false);
});

const CAPACITY = 'Selected model is at capacity. Please try a different model.';
const captured = (file) => (existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);

test('isCapacityFailure: only the LAST turn.failed message of a failed, un-timed-out, un-signalled run', () => {
  const ev = (...es) => es.map((e) => JSON.stringify(e)).join('\n');
  const failed = (message) => ({ type: 'turn.failed', error: { message } });
  assert.equal(isCapacityFailure({ code: 1, stdout: ev(failed(CAPACITY)) }), true);
  assert.equal(isCapacityFailure({ code: 1, stdout: ev(failed('server_overloaded')) }), true);
  assert.equal(isCapacityFailure({ code: 1, stdout: ev(failed('Server overloaded, retry')) }), true);
  assert.equal(isCapacityFailure({ code: 1, stdout: ev(failed(CAPACITY), failed('unexpected status 401 Unauthorized')) }), false, 'the LAST turn.failed decides');
  assert.equal(isCapacityFailure({ code: 1, stdout: ev(failed('x'), failed(CAPACITY)) }), true);
  assert.equal(isCapacityFailure({ code: 0, stdout: ev(failed(CAPACITY)) }), false, 'exit 0');
  assert.equal(isCapacityFailure({ code: 1, timedOut: true, stdout: ev(failed(CAPACITY)) }), false, 'timed out');
  assert.equal(isCapacityFailure({ code: null, signal: 'SIGKILL', stdout: ev(failed(CAPACITY)) }), false, 'killed by a signal');
  assert.equal(isCapacityFailure({ code: 1, stdout: ev({ type: 'item.completed', item: { aggregated_output: CAPACITY } }, failed('boom')) }), false, 'item events are never read');
  assert.equal(isCapacityFailure({ code: 1, stdout: ev({ type: 'error', message: CAPACITY }) }), false, 'top-level error events are not the verdict');
  assert.equal(isCapacityFailure({ code: 1, stderr: CAPACITY, stdout: '' }), false, 'stderr is never read');
});

test('execCodex: model at capacity is retried once with the same prompt and output path; the second run can succeed', async (t) => {
  const dir = scratch(t);
  const capture = join(dir, 'capture.jsonl');
  const r = await run(dir, { PIPELINE_CODEX_CAPACITY_RETRY_MS: '0', FAKE_CODEX_FAIL_ONCE: join(dir, 'failed.flag'), FAKE_CODEX_TURN_FAILED: CAPACITY, FAKE_CODEX_CAPTURE: capture });
  assert.equal(r.ok, true);
  assert.deepEqual(r.retried, { reason: 'capacity' });
  assert.equal(readFileSync(join(dir, 'out.json'), 'utf8'), '{"summary":"ok"}', "the answer file is the second run's");
  const runs = captured(capture);
  assert.equal(runs.length, 2);
  assert.deepEqual(runs[1], runs[0], 'same argv and same prompt bytes');
});

test('execCodex: the capacity retry waits PIPELINE_CODEX_CAPACITY_RETRY_MS first', async (t) => {
  const dir = scratch(t);
  const t0 = Date.now();
  const r = await run(dir, { PIPELINE_CODEX_CAPACITY_RETRY_MS: '1500', FAKE_CODEX_FAIL_ONCE: join(dir, 'failed.flag'), FAKE_CODEX_TURN_FAILED: CAPACITY });
  assert.equal(r.ok, true);
  assert.ok(Date.now() - t0 >= 1400, 'waited before the second run');
});

test("execCodex: capacity twice keeps today's outcome (error), with retried capacity and no output file", async (t) => {
  const dir = scratch(t);
  const capture = join(dir, 'capture.jsonl');
  const r = await run(dir, { PIPELINE_CODEX_CAPACITY_RETRY_MS: '0', FAKE_CODEX_EXIT: '1', FAKE_CODEX_TURN_FAILED: CAPACITY, FAKE_CODEX_CAPTURE: capture });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'error');
  assert.equal(r.timedOut, false);
  assert.equal(r.detail, CAPACITY);
  assert.deepEqual(r.retried, { reason: 'capacity' });
  assert.equal('quota' in r, false);
  assert.equal(existsSync(join(dir, 'out.json')), false);
  assert.equal(captured(capture).length, 2, 'exactly one retry');
});

test('execCodex: only one retry in total: a timeout then capacity, or capacity then a timeout, is not retried again', async (t) => {
  const dir = scratch(t);
  const capture = join(dir, 'capture.jsonl');
  const a = await run(dir, { PIPELINE_CODEX_TIMEOUT_MS: '700', PIPELINE_CODEX_CAPACITY_RETRY_MS: '0', FAKE_CODEX_HANG_ONCE: join(dir, 'hung.flag'), FAKE_CODEX_EXIT: '1', FAKE_CODEX_TURN_FAILED: CAPACITY, FAKE_CODEX_CAPTURE: capture });
  assert.equal(a.ok, false);
  assert.equal(a.reason, 'error');
  assert.deepEqual(a.retried, { reason: 'timeout' });
  assert.equal(captured(capture).length, 2, 'timeout then capacity: two runs, no third');

  const dir2 = scratch(t);
  const capture2 = join(dir2, 'capture.jsonl');
  const b = await run(dir2, { PIPELINE_CODEX_TIMEOUT_MS: '500', PIPELINE_CODEX_CAPACITY_RETRY_MS: '0', FAKE_CODEX_FAIL_ONCE: join(dir2, 'failed.flag'), FAKE_CODEX_TURN_FAILED: CAPACITY, FAKE_CODEX_HANG: join(dir2, 'helper.pid'), FAKE_CODEX_CAPTURE: capture2 });
  assert.equal(b.ok, false);
  assert.equal(b.reason, 'unavailable');
  assert.equal(b.timedOut, true);
  assert.deepEqual(b.retried, { reason: 'capacity' });
  assert.equal(captured(capture2).length, 2, 'capacity then timeout: two runs, no third');
  assert.equal(existsSync(join(dir2, 'out.json')), false);
});

test('execCodex: the capacity phrase only in an item event or on stderr is not a capacity failure and is not retried', async (t) => {
  const dir = scratch(t);
  const stdout = join(dir, 'stream.jsonl');
  writeFileSync(stdout, [
    { type: 'thread.started', thread_id: QUOTA_ID },
    { type: 'item.completed', item: { type: 'command_execution', aggregated_output: `${CAPACITY} server_overloaded` } },
    { type: 'turn.failed', error: { message: 'something else broke' } },
  ].map((e) => JSON.stringify(e)).join('\n'));
  const capture = join(dir, 'capture.jsonl');
  const viaItem = await run(dir, { PIPELINE_CODEX_CAPACITY_RETRY_MS: '0', FAKE_CODEX_EXIT: '1', FAKE_CODEX_STDOUT: stdout, FAKE_CODEX_CAPTURE: capture });
  assert.equal(viaItem.reason, 'error');
  assert.equal('retried' in viaItem, false);
  const viaStderr = await run(dir, { PIPELINE_CODEX_CAPACITY_RETRY_MS: '0', FAKE_CODEX_EXIT: '1', FAKE_CODEX_STDERR: CAPACITY, FAKE_CODEX_CAPTURE: capture });
  assert.equal(viaStderr.reason, 'error');
  assert.equal('retried' in viaStderr, false);
  assert.equal(captured(capture).length, 2, 'one run each, no retry');
});

test('execCodex: a quota stop is never retried', async (t) => {
  const dir = scratch(t);
  const capture = join(dir, 'capture.jsonl');
  const r = await run(dir, { PIPELINE_CODEX_CAPACITY_RETRY_MS: '0', FAKE_CODEX_EXIT: '1', FAKE_CODEX_STDOUT: QUOTA_STDOUT, FAKE_CODEX_CAPTURE: capture, CODEX_HOME: codexHome(dir, { '2026/11/11': QUOTA_LOG }) });
  assert.equal(r.reason, 'quota');
  assert.equal('retried' in r, false);
  assert.equal(captured(capture).length, 1);
});

test('execCodex: a missing binary is unavailable and is not retried', async (t) => {
  const dir = scratch(t);
  const r = await run(dir, { PIPELINE_CODEX: join(dir, 'no-such-codex-binary') });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unavailable');
  assert.equal(r.timedOut, false);
  assert.equal('retried' in r, false);
});

// ---------- codex-session ----------

test('codexHomeDir: CODEX_HOME, else ~/.codex', () => {
  assert.equal(codexHomeDir({ CODEX_HOME: '/x/codex' }), '/x/codex');
  assert.equal(codexHomeDir({ HOME: '/home/u' }), join('/home/u', '.codex'));
  assert.equal(codexHomeDir({ CODEX_HOME: '  ', HOME: '/home/u' }), join('/home/u', '.codex'));
});

test('findSessionLog: finds the file by thread id in today\'s or yesterday\'s folder, local or UTC date', (t) => {
  const dir = scratch(t);
  const name = `rollout-2026-11-10T23-59-59-${QUOTA_ID}.jsonl`;
  const home = codexHome(dir, { '2026/11/10': { [name]: 'codex-0.154-session-quota.jsonl' } });
  const env = { CODEX_HOME: home };
  assert.equal(findSessionLog(QUOTA_ID, { env, now: NOW }), join(home, 'sessions/2026/11/10', name));
  assert.equal(findSessionLog(AUTH_ID, { env, now: NOW }), null, 'another thread');
  assert.equal(findSessionLog(QUOTA_ID, { env, now: NOW + 3 * 86400000 }), null, 'too old to be looked for');
  assert.equal(findSessionLog(QUOTA_ID, { env: { CODEX_HOME: join(dir, 'missing') }, now: NOW }), null);
});

test('findSessionLog: a thread id with path characters or the wrong shape is refused, never looked up', (t) => {
  const dir = scratch(t);
  const home = codexHome(dir, { '2026/11/11': QUOTA_LOG });
  for (const bad of ['../../x', `${QUOTA_ID}/../x`, '*', '', null, undefined, 42, `${QUOTA_ID}.jsonl`, 'abc']) {
    assert.equal(findSessionLog(bad, { env: { CODEX_HOME: home }, now: NOW }), null, String(bad));
  }
});

test('readTaskCompleteError: the last task_complete; null for no event, a bad file or a missing one', (t) => {
  assert.deepEqual(readTaskCompleteError(join(FIX, 'codex-0.154-session-quota.jsonl')), {
    message: "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 4:21 PM.",
    codexErrorInfo: 'usage_limit_exceeded',
  });
  assert.equal(readTaskCompleteError(join(FIX, 'codex-0.154-session-auth.jsonl')).codexErrorInfo, 'other');
  const dir = scratch(t);
  const two = join(dir, 'two.jsonl');
  const done = (info) => JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', error: info ? { message: 'm', codex_error_info: info } : null } });
  writeFileSync(two, `${done('usage_limit_exceeded')}\n${done(null)}\ngarbage\n`);
  assert.deepEqual(readTaskCompleteError(two), { message: null, codexErrorInfo: null }, 'the LAST one, here with no error');
  const none = join(dir, 'none.jsonl');
  writeFileSync(none, '{"type":"session_meta"}\n');
  assert.equal(readTaskCompleteError(none), null);
  assert.equal(readTaskCompleteError(join(dir, 'missing.jsonl')), null);
  assert.equal(readTaskCompleteError(dir), null, 'a directory');
});

test('readTaskCompleteError: reads only the tail of a big log', (t) => {
  const dir = scratch(t);
  const big = join(dir, 'big.jsonl');
  const filler = `${JSON.stringify({ type: 'response_item', payload: { text: 'x'.repeat(1000) } })}\n`.repeat(2000);
  writeFileSync(big, `${JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', error: { message: 'old', codex_error_info: 'other' } } })}\n${filler}${readFileSync(join(FIX, 'codex-0.154-session-quota.jsonl'), 'utf8')}`);
  assert.equal(readTaskCompleteError(big).codexErrorInfo, 'usage_limit_exceeded');
});

// ---------- a refused model (cp #431): the stream, the session log and the confirmation run ----------

const MODEL_ID = '01a1daf1-a944-7733-a4cb-3e6c343b8044'; // the real probe's thread id
const CONFIRM_ID = '01a1daf1-a944-7733-a4cb-3e6c343b8055';
const REQ = 'gpt-retired-zz9';
const MODEL_STDOUT = join(FIX, 'codex-0.154-json-model-not-found-stdout.jsonl');
const MODEL_BODY = JSON.parse(readFileSync(MODEL_STDOUT, 'utf8').trim().split('\n').pop()).error.message;

// A minimal synthetic rollout shaped like the real one (session_meta, turn_context, task_complete with the error and codex_error_info "other").
function rollout({ id, model = REQ, provider = 'openai', error = MODEL_BODY, complete = true }) {
  const lines = [
    { timestamp: '2026-11-15T01:00:00.000Z', type: 'session_meta', payload: { id, session_id: id, originator: 'codex_exec', cli_version: '0.154.0', source: 'exec', model_provider: provider } },
    { timestamp: '2026-11-15T01:00:00.100Z', type: 'turn_context', payload: { turn_id: 't1', model, effort: 'high' } },
  ];
  if (complete) lines.push({ timestamp: '2026-11-15T01:00:01.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1', last_agent_message: null, error: { message: error, codex_error_info: 'other' } } });
  return `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`;
}
function sessionsHome(dir, logs) {
  const home = join(dir, 'codex-home');
  const day = join(home, 'sessions', '2026', '11', '11');
  mkdirSync(day, { recursive: true });
  for (const [id, text] of Object.entries(logs)) writeFileSync(join(day, `rollout-2026-11-11T15-23-30-${id}.jsonl`), text);
  return home;
}
// the captured stream, but for the thread the confirmation run is given
function confirmStream(dir, body = readFileSync(MODEL_STDOUT, 'utf8')) {
  const file = join(dir, 'confirm-stdout.jsonl');
  writeFileSync(file, body.replaceAll(MODEL_ID, CONFIRM_ID));
  return file;
}
// execCodex over the captured refused-model stream: argv carries -C and -o like the real one, requestedModel is the model it asks for
// beforeRun(dir): runs once the scratch dir exists, just before execCodex (the temp-dir failure test breaks the machine's temp dir only from there on)
async function runModel(t, { logs, confirm, requestedModel = REQ, env = {}, stdout = MODEL_STDOUT, beforeRun } = {}) {
  const dir = scratch(t);
  const capture = join(dir, 'capture.jsonl');
  const home = sessionsHome(dir, logs ?? { [MODEL_ID]: rollout({ id: MODEL_ID }), [CONFIRM_ID]: rollout({ id: CONFIRM_ID }) });
  const outPath = join(dir, 'out.json');
  if (beforeRun) beforeRun(dir);
  const r = await run(dir, {
    FAKE_CODEX_EXIT: '1', FAKE_CODEX_STDOUT: stdout, FAKE_CODEX_CONFIRM_STDOUT: confirm ?? confirmStream(dir), FAKE_CODEX_CAPTURE: capture, CODEX_HOME: home, ...env,
  }, { args: ['exec', '-C', dir, '-o', outPath, '-c', `model="${REQ}"`, '-'], requestedModel });
  const runs = existsSync(capture) ? readFileSync(capture, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
  return { r, runs, dir };
}

test('execCodex: the real refused-model stream, a log that agrees and a confirmation run in an empty temp dir is a proven model stop (session-log, provider openai, confirm thread)', async (t) => {
  const { r, runs, dir } = await runModel(t);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'model');
  assert.equal(r.code, 1);
  assert.equal('quota' in r, false);
  assert.deepEqual(r.modelStop, { eligible: true, proof: 'session-log', model: REQ, provider: 'openai', message: MODEL_BODY, threadId: MODEL_ID, confirm: { threadId: CONFIRM_ID } });
  assert.equal(runs.length, 2, 'the main run and the one confirmation run: a model stop is never retried');
  const [main, confirm] = runs;
  assert.equal(main.stdin, 'PROMPT');
  assert.equal(confirm.stdin, 'Reply OK');
  const at = (argv, flag) => argv[argv.indexOf(flag) + 1];
  assert.equal(at(main.argv, '-C'), dir);
  assert.notEqual(at(confirm.argv, '-C'), dir, 'the confirmation run is in a fresh directory of its own');
  assert.notEqual(at(confirm.argv, '-o'), join(dir, 'out.json'));
  assert.equal(at(confirm.argv, '-o'), join(at(confirm.argv, '-C'), 'out.json'));
  assert.deepEqual(main.argv.filter((a) => a.startsWith('model=')), confirm.argv.filter((a) => a.startsWith('model=')), 'the same -c model');
  assert.equal(existsSync(at(confirm.argv, '-C')), false, 'the temp directory is removed afterwards');
});

test('execCodex: a refused-model stream with no session log is not proof (stream only): ineligible, no confirmation run', async (t) => {
  const { r, runs } = await runModel(t, { logs: {} });
  assert.equal(r.reason, 'model');
  assert.deepEqual([r.modelStop.eligible, r.modelStop.proof, r.modelStop.unproven], [false, 'stream', 'no-session-log']);
  assert.equal(runs.length, 1);
  // a log without a task_complete says nothing either
  const half = await runModel(t, { logs: { [MODEL_ID]: rollout({ id: MODEL_ID, complete: false }) } });
  assert.deepEqual([half.r.modelStop.eligible, half.r.modelStop.unproven], [false, 'log-disagrees']);
  assert.equal(half.runs.length, 1);
});

test('execCodex: a session log whose task_complete is not model_not_found disagrees: ineligible', async (t) => {
  const { r, runs } = await runModel(t, { logs: { [MODEL_ID]: rollout({ id: MODEL_ID, error: 'unexpected status 401 Unauthorized' }) } });
  assert.deepEqual([r.modelStop.eligible, r.modelStop.proof, r.modelStop.unproven], [false, 'session-log', 'log-disagrees']);
  assert.equal(runs.length, 1);
});

test('execCodex: the refusal naming another model than the one asked for, or a log whose turn_context ran another model, is ineligible', async (t) => {
  const named = await runModel(t, { requestedModel: 'gpt-other-1' });
  assert.deepEqual([named.r.modelStop.eligible, named.r.modelStop.unproven], [false, 'model-differs']);
  assert.equal(named.runs.length, 1);
  const ran = await runModel(t, { logs: { [MODEL_ID]: rollout({ id: MODEL_ID, model: 'gpt-other-1' }), [CONFIRM_ID]: rollout({ id: CONFIRM_ID }) } });
  assert.deepEqual([ran.r.modelStop.eligible, ran.r.modelStop.unproven], [false, 'model-differs']);
  const none = await runModel(t, { requestedModel: null });
  assert.deepEqual([none.r.modelStop.eligible, none.r.modelStop.unproven], [false, 'no-requested-model']);
  const noProvider = await runModel(t, { logs: { [MODEL_ID]: rollout({ id: MODEL_ID }).replace('"model_provider":"openai"', '"x":1') } });
  assert.deepEqual([noProvider.r.modelStop.eligible, noProvider.r.modelStop.unproven], [false, 'no-provider']);
});

test('execCodex: a stream whose top-level error says model_not_found but whose final turn.failed says something else is not a model stop', async (t) => {
  const dir = scratch(t);
  const stdout = join(dir, 'stream.jsonl');
  const lines = readFileSync(MODEL_STDOUT, 'utf8').trim().split('\n');
  lines[lines.length - 1] = JSON.stringify({ type: 'turn.failed', error: { message: 'stream disconnected before completion' } });
  writeFileSync(stdout, `${lines.join('\n')}\n`);
  const { r } = await runModel(t, { stdout });
  assert.equal(r.reason, 'error');
  assert.equal('modelStop' in r, false);
});

test('execCodex: the confirmation run must be refused too, with its own log, the same model and the same provider', async (t) => {
  // it succeeds (exit 0), or fails some other way
  const ok = await runModel(t, { env: { FAKE_CODEX_CONFIRM_EXIT: '0', FAKE_CODEX_CONFIRM_STDOUT: join(FIX, 'codex-0.154-json-auth-stdout.jsonl') } });
  assert.deepEqual([ok.r.modelStop.eligible, ok.r.modelStop.proof, ok.r.modelStop.unproven, ok.r.modelStop.confirm], [false, 'session-log', 'confirm-failed', null]);
  const auth = await runModel(t, { env: { FAKE_CODEX_CONFIRM_EXIT: '1', FAKE_CODEX_CONFIRM_STDOUT: join(FIX, 'codex-0.154-json-auth-stdout.jsonl') } });
  assert.equal(auth.r.modelStop.unproven, 'confirm-failed');
  // refused, but its rollout is missing / names another model / another provider
  const missing = await runModel(t, { logs: { [MODEL_ID]: rollout({ id: MODEL_ID }) } });
  assert.deepEqual([missing.r.modelStop.eligible, missing.r.modelStop.unproven], [false, 'confirm-unproven']);
  const other = await runModel(t, { logs: { [MODEL_ID]: rollout({ id: MODEL_ID }), [CONFIRM_ID]: rollout({ id: CONFIRM_ID, model: 'gpt-other-1' }) } });
  assert.equal(other.r.modelStop.unproven, 'confirm-unproven');
  const provider = await runModel(t, { logs: { [MODEL_ID]: rollout({ id: MODEL_ID }), [CONFIRM_ID]: rollout({ id: CONFIRM_ID, provider: 'nosuchprov' }) } });
  assert.deepEqual([provider.r.modelStop.eligible, provider.r.modelStop.proof, provider.r.modelStop.provider, provider.r.modelStop.unproven], [false, 'session-log', 'openai', 'provider-differs']);
});

test('execCodex: a confirmation run whose temp directory cannot be made (R1-F2) still resolves: a model stop, ineligible, confirm-failed, the main run\'s proof and provider kept', async (t) => {
  // os.tmpdir() reads TMPDIR (POSIX) / TEMP and TMP (Windows) from this process; a folder that does not exist makes mkdtempSync throw. Tests in a file run one at a time, so restoring it afterwards is safe.
  const saved = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP };
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  const { r, runs } = await runModel(t, { beforeRun: (dir) => { for (const k of Object.keys(saved)) process.env[k] = join(dir, 'no-such-folder', 'tmp'); } });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'model');
  assert.deepEqual([r.modelStop.eligible, r.modelStop.proof, r.modelStop.provider, r.modelStop.unproven, r.modelStop.confirm], [false, 'session-log', 'openai', 'confirm-failed', null]);
  assert.equal(runs.length, 1, 'no confirmation run without a directory to run it in');
});
