import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  for (const k of ['FAKE_CODEX_EXIT', 'FAKE_CODEX_STDERR', 'FAKE_CODEX_TURN_FAILED', 'FAKE_CODEX_STDOUT', 'FAKE_CODEX_SIGNAL', 'FAKE_CODEX_HANG_ONCE', 'FAKE_CODEX_CAPTURE', 'FAKE_CODEX_THREAD_ID', 'PIPELINE_CODEX_TIMEOUT_MS']) {
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

test('execCodex: a stderr-only usage-limit message, or a run killed by a signal, is not quota', async (t) => {
  const dir = scratch(t);
  const plain = await run(dir, { FAKE_CODEX_EXIT: '1', FAKE_CODEX_STDERR: "ERROR: You've hit your usage limit. try again at 4:21 PM." });
  assert.equal(plain.reason, 'error');
  assert.match(plain.detail, /usage limit/, 'with no turn.failed the detail is the stderr tail');
  assert.equal('quota' in plain, false);
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
