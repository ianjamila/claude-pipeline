import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import {
  REASON_PREFIX, FAIL_CLOSED_KEYWORDS, denyPayload, deny, allow, readHookInput, readStdinText, runHook,
} from '../pipeline/hooks/lib/hook-io.mjs';

const sink = () => ({ out: '', write(s) { this.out += s; } });
const run = async (evaluate, stdin) => {
  const stdout = sink();
  const result = await runHook(evaluate, { stdin, stdout });
  return { result, out: stdout.out };
};
const denyJson = (out) => JSON.parse(out).hookSpecificOutput;

test('denyPayload has the exact shape Claude Code reads and prefixes the reason', () => {
  const parsed = JSON.parse(denyPayload('nope'));
  assert.deepEqual(parsed, {
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `${REASON_PREFIX}nope` },
  });
  assert.equal(REASON_PREFIX, '[claude-pipeline guard-git] ');
});

test('denyPayload does not double the prefix and never emits an empty reason', () => {
  assert.equal(JSON.parse(denyPayload(`${REASON_PREFIX}x`)).hookSpecificOutput.permissionDecisionReason, `${REASON_PREFIX}x`);
  assert.match(JSON.parse(denyPayload('')).hookSpecificOutput.permissionDecisionReason, /^\[claude-pipeline guard-git\] \S/);
});

test('deny writes one JSON line; allow writes nothing', () => {
  const s = sink();
  deny('why', { stdout: s });
  assert.equal(s.out.endsWith('\n'), true);
  assert.equal(denyJson(s.out).permissionDecision, 'deny');
  assert.equal(allow(), undefined);
});

test('readStdinText / readHookInput read a whole stream, including multi-chunk and BOM input', async () => {
  const chunks = Readable.from(['{"a":', '1,"b":"é"}']);
  assert.deepEqual(await readHookInput(chunks), { a: 1, b: 'é' });
  assert.deepEqual(await readHookInput('﻿{"x":true}'), { x: true });
  assert.equal(await readStdinText(Readable.from([])), '');
  assert.equal(await readStdinText({ isTTY: true }), '');
});

test('readHookInput rejects malformed JSON and non-objects', async () => {
  await assert.rejects(readHookInput('{nope'));
  await assert.rejects(readHookInput('null'));
  await assert.rejects(readHookInput('[1]'));
  await assert.rejects(readHookInput('42'));
});

test('runHook: deny verdict prints the deny JSON', async () => {
  const { result, out } = await run(() => ({ decision: 'deny', reason: 'blocked' }), '{"tool_name":"Bash"}');
  assert.equal(result, 'deny');
  assert.equal(denyJson(out).permissionDecision, 'deny');
  assert.equal(denyJson(out).permissionDecisionReason, `${REASON_PREFIX}blocked`);
});

test('runHook: allow verdict prints nothing, and async evaluators work', async () => {
  const { result, out } = await run(async () => ({ decision: 'allow', reason: '' }), '{"tool_name":"Bash"}');
  assert.equal(result, 'allow');
  assert.equal(out, '');
});

test('runHook: the evaluator receives the parsed input', async () => {
  let seen;
  await run((input) => { seen = input; return { decision: 'allow' }; }, '{"tool_name":"Bash","tool_input":{"command":"ls"},"cwd":"/x"}');
  assert.equal(seen.tool_input.command, 'ls');
  assert.equal(seen.cwd, '/x');
});

// Fail-closed policy: an internal error denies only when the raw stdin looks guarded.
for (const kw of FAIL_CLOSED_KEYWORDS) {
  test(`runHook: evaluator crash + stdin containing "${kw}" denies`, async () => {
    const { result, out } = await run(() => { throw new Error('boom'); }, `{"tool_input":{"command":"x ${kw} y"}}`);
    assert.equal(result, 'deny');
    assert.match(denyJson(out).permissionDecisionReason, /boom/);
  });
  test(`runHook: malformed stdin containing "${kw}" denies`, async () => {
    const { result } = await run(() => ({ decision: 'allow' }), `{ not json ${kw}`);
    assert.equal(result, 'deny');
  });
}

test('runHook: the keyword match is case-insensitive', async () => {
  assert.equal((await run(() => { throw new Error('x'); }, '{"command":"GIT PUSH origin MAIN"}')).result, 'deny');
  assert.equal((await run(() => { throw new Error('x'); }, '{"command":"gh Issue Close 7"}')).result, 'deny');
});

test('runHook: evaluator crash on an unrelated command allows silently', async () => {
  const { result, out } = await run(() => { throw new Error('boom'); }, '{"tool_input":{"command":"ls -la"}}');
  assert.equal(result, 'allow');
  assert.equal(out, '');
});

test('runHook: malformed stdin without keywords allows silently', async () => {
  const { result, out } = await run(() => ({ decision: 'deny', reason: 'unreachable' }), '{ garbage');
  assert.equal(result, 'allow');
  assert.equal(out, '');
});

test('runHook: empty stdin allows', async () => {
  assert.equal((await run(() => ({ decision: 'deny', reason: 'x' }), '')).result, 'allow');
});

test('runHook: an evaluator that returns nothing is an internal error (fails closed on guarded input)', async () => {
  assert.equal((await run(() => undefined, '{"command":"git push"}')).result, 'deny');
  assert.equal((await run(() => ({ decision: 'maybe' }), '{"command":"ls"}')).result, 'allow');
});

test('runHook never rejects even when the evaluator rejects asynchronously', async () => {
  const { result } = await run(async () => { throw new Error('async boom'); }, '{"command":"git merge x"}');
  assert.equal(result, 'deny');
});
