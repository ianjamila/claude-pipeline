import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import {
  REASON_PREFIX, denyPayload, deny, allow, readHookInput, readStdinText, runHook,
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

// Fail-closed policy (#21): ANY internal error denies, with the error in the reason. It used to deny only when the raw stdin
// held a guarded keyword ("push", "merge", ...), so a bug or a timeout on a command spelled another way was allowed.
// Deliberate behaviour change: the keyword tests that asserted the open path now assert the denial.
const COMMANDS = ['x push y', 'git merge x', 'GIT PUSH origin MAIN', 'gh Issue Close 7', 'ls -la', "g''it status", 'bash f.sh', ''];
for (const command of COMMANDS) {
  test(`runHook: evaluator crash denies and names the error (command ${JSON.stringify(command)})`, async () => {
    const { result, out } = await run(() => { throw new Error('boom'); }, JSON.stringify({ tool_input: { command } }));
    assert.equal(result, 'deny');
    assert.match(denyJson(out).permissionDecisionReason, /internal error while checking this command \(boom\)/);
  });
  test(`runHook: malformed stdin denies (command ${JSON.stringify(command)})`, async () => {
    const { result } = await run(() => ({ decision: 'allow' }), `{ not json ${command}`);
    assert.equal(result, 'deny');
  });
}

test('runHook: empty stdin and non-object JSON deny', async () => {
  for (const stdin of ['', '   ', 'null', '[]', '42', '"x"']) {
    const { result, out } = await run(() => ({ decision: 'allow' }), stdin);
    assert.equal(result, 'deny', JSON.stringify(stdin));
    assert.match(denyJson(out).permissionDecisionReason, /internal error/, JSON.stringify(stdin));
  }
});

test('runHook: an evaluator that returns nothing, or a decision it does not know, is an internal error', async () => {
  for (const verdict of [undefined, null, {}, { decision: 'maybe' }, 'allow']) {
    const { result, out } = await run(() => verdict, '{"command":"ls"}');
    assert.equal(result, 'deny', JSON.stringify(verdict));
    assert.match(denyJson(out).permissionDecisionReason, /no decision/);
  }
});

test('runHook: a rejected promise from the evaluator denies', async () => {
  const { result, out } = await run(async () => { throw new Error('async boom'); }, '{"command":"ls"}');
  assert.equal(result, 'deny');
  assert.match(denyJson(out).permissionDecisionReason, /async boom/);
});

test('runHook: a thrown non-Error value is named too, and an unwritable stdout cannot make it throw', async () => {
  const { out } = await run(() => { throw 'plain string'; }, '{"command":"ls"}'); // eslint-disable-line no-throw-literal
  assert.match(denyJson(out).permissionDecisionReason, /plain string/);
  const gone = { write() { throw new Error('EPIPE'); } };
  assert.equal(await runHook(() => { throw new Error('x'); }, { stdin: '{"command":"ls"}', stdout: gone }), 'allow'); // nothing more can be done
});

test('runHook never rejects even when the evaluator rejects asynchronously', async () => {
  const { result } = await run(async () => { throw new Error('async boom'); }, '{"command":"git merge x"}');
  assert.equal(result, 'deny');
});
