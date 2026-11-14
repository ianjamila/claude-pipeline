// scripts/click-spike.mjs re-records the click transcript fixtures (test/fixtures/click/<build>/) on the installed Claude Code build. Running it needs a logged-in `claude` and a real terminal,
// so this file tests only its pure parts: that importing it runs nothing, that trim() keeps the three entries a fixture holds, and that judge() accepts every committed fixture for the case
// the script defines for it (a build whose recordings the script itself would reject must never be in CLICK_BUILDS).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CASES, DOWN, ENTER, HOOK, PARTIAL_EXIT, PREFILL_LABEL, headlessVerdict, judge, selectCases, trim, verdict } from '../scripts/click-spike.mjs';
import { CLICK_BUILDS, HUMAN_DECISION } from '../pipeline/hooks/lib/owner-go-click.mjs';

const FIX = new URL('./fixtures/click/', import.meta.url);
const SCRIPT = fileURLToPath(new URL('../scripts/click-spike.mjs', import.meta.url));
const load = (build, name) => readFileSync(new URL(`${build}/${name}.jsonl`, FIX), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const atLeast = (b, min) => { const [x, y] = [b, min].map((v) => v.split('.').map(Number)); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]; return true; };
const recorded = (build) => CASES.filter((c) => !c.headless && (c.since === undefined || atLeast(build, c.since)));
const fixtureExists = (build, name) => existsSync(new URL(`${build}/${name}.jsonl`, FIX));
const byName = (name) => CASES.find((c) => c.name === name);

test('importing the script does not run main() (this file is not a script run)', () => {
  assert.ok(Array.isArray(CASES) && CASES.length > 0);
  assert.equal(typeof judge, 'function');
  assert.equal(typeof trim, 'function');
});

test('judge accepts every committed fixture of every allowlisted build for the case the script defines', () => {
  for (const build of CLICK_BUILDS) {
    const cases = recorded(build);
    assert.ok(cases.length >= 6, `${build}: the script defines the six core cases (and pretooluse-ask-prefill from 2.1.323)`);
    for (const c of cases) {
      const j = judge(c, load(build, c.name));
      assert.equal(j.ok, true, `${build}/${c.name}: expected ${c.expect}, saw ${JSON.stringify(j.seen)}`);
    }
  }
  // a case newer than the build may still have a fixture (an owner re-record of an older build): it is judged when present
  for (const build of CLICK_BUILDS) for (const c of CASES.filter((x) => !x.headless && !recorded(build).includes(x) && fixtureExists(build, x.name))) assert.equal(judge(c, load(build, c.name)).ok, true, `${build}/${c.name}`);
  assert.ok(recorded('2.1.323').some((c) => c.name === 'pretooluse-ask-prefill'));
  assert.ok(!recorded('2.1.322').some((c) => c.name === 'pretooluse-ask-prefill'));
});

test('judge: the human stamp is the whole permissionDecision (a hook auto-submit with source user_temporary is not human)', () => {
  const human = CASES.find((c) => c.name === 'genuine-click');
  const fixture = load('2.1.323', 'genuine-click');
  assert.equal(judge(human, fixture).ok, true);
  assert.deepEqual(fixture[2].permissionDecision, HUMAN_DECISION);
  const forged = structuredClone(fixture);
  forged[2].permissionDecision = { ...HUMAN_DECISION, reasonCode: 'hook:PreToolUse' };
  assert.equal(judge(human, forged).ok, false);
  assert.equal(judge(CASES.find((c) => c.name === 'pretooluse-ask-prefill'), forged).ok, true, 'and the case that expects it passes on it');
  assert.equal(judge(CASES.find((c) => c.name === 'pretooluse-ask-prefill'), fixture).ok, false, 'a real click is not what that case expects');
});

test('trim keeps the prompt, the AskUserQuestion tool_use and its result; neutral cwd; drops usage; null without a result', () => {
  const [prompt, use, result] = load('2.1.323', 'genuine-click');
  const noisy = structuredClone([prompt, { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }, use, { type: 'user', message: { content: 'x' } }, result]);
  noisy[2].cwd = '/private/tmp/scratch-1';
  noisy[2].message.usage = { input_tokens: 1 };
  noisy[2].serverClassifierRequest = {};
  const out = trim(noisy, '/private/tmp/scratch-1');
  assert.equal(out.length, 3);
  assert.deepEqual(out.map((e) => e.type), ['user', 'assistant', 'user']);
  assert.equal(out[1].cwd, '/work/spike');
  assert.ok(!('usage' in out[1].message) && !('serverClassifierRequest' in out[1]));
  assert.equal(trim([prompt, use], '/x'), null);
});

test('run inside a Claude Code session the script refuses to start (exit 2, says to use your own terminal)', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--claude', 'definitely-not-installed'], { env: { ...process.env, ['CLAUDE' + 'CODE']: '1' }, encoding: 'utf8' });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /run this from your own terminal, not inside a Claude Code session/);
});

const iso = (base, plusMs) => new Date(Date.parse(base) + plusMs).toISOString();

test('R1-B1: judge refuses a noncanonical tool_use input for every case that does not expect one (the recorder refuses any key beyond questions/metadata)', () => {
  const prefilledFixture = load('2.1.323', 'model-prefilled-answers');
  assert.equal(judge(byName('genuine-click'), prefilledFixture).ok, false, 'the 2.1.323 model-prefilled recording carries the exact human stamp; as a genuine click it must fail');
  assert.equal(judge(byName('model-prefilled-answers'), prefilledFixture).ok, true, 'and it is exactly what the prefilled case expects');
  for (const [name, fixture] of [['genuine-click', 'genuine-click'], ['preview-annotations', 'preview-annotations'], ['multiselect-click', 'multiselect-click'], ['pretooluse-hook-answer', 'pretooluse-hook-answer'], ['pretooluse-ask-prefill', 'pretooluse-ask-prefill']]) {
    const c = byName(name);
    assert.equal(judge(c, load('2.1.323', fixture)).ok, true, name);
    for (const extra of ['answers', 'surprise']) {
      const bad = load('2.1.323', fixture);
      bad[1].message.content.find((b) => b.type === 'tool_use').input[extra] = { x: 'y' };
      assert.equal(judge(c, bad).ok, false, `${name} with an input ${extra} key`);
    }
    const meta = load('2.1.323', fixture);
    meta[1].message.content.find((b) => b.type === 'tool_use').input.metadata = { source: 'x' };
    assert.equal(judge(c, meta).ok, true, `${name}: a metadata key is allowed (as the recorder allows it)`);
  }
});

test('R1-B2: the headless probe passes only when the run exited 0 on its own and no AskUserQuestion was produced', () => {
  const clean = { code: 0, signal: null, timedOut: false, fixture: null };
  assert.equal(headlessVerdict(clean).ok, true);
  assert.equal(headlessVerdict({ ...clean, code: 1 }).ok, false, 'a nonzero exit (crash, auth failure) is not a verification');
  assert.equal(headlessVerdict({ ...clean, code: null, signal: 'SIGTERM', timedOut: true }).ok, false, 'a timeout killed by the script');
  assert.equal(headlessVerdict({ ...clean, code: null, signal: 'SIGKILL' }).ok, false, 'killed by a signal that was not ours');
  assert.equal(headlessVerdict({ ...clean, error: 'spawn claude ENOENT', code: null }).ok, false, 'could not start');
  const answered = load('2.1.323', 'genuine-click');
  assert.equal(headlessVerdict({ ...clean, fixture: answered }).ok, false, 'an AskUserQuestion was produced headless');
  assert.equal(headlessVerdict({ ...clean, fixture: structuredClone(answered).map((e) => ({ ...e, entrypoint: 'sdk-cli' })) }).ok, false, 'even one the recorder would refuse by entrypoint: the case is "not offered"');
  assert.match(headlessVerdict({ ...clean, code: 3 }).text, /exit/);
});

test('R1-F1: judge fails a keys:[] case when a key was sent after the tool_use, and a key case answered before its own Enter', () => {
  const noKeys = byName('pretooluse-ask-prefill');
  assert.deepEqual(noKeys.keys, []);
  const fx = load('2.1.323', 'pretooluse-ask-prefill');
  const useAt = Date.parse(fx[1].timestamp);
  assert.equal(judge(noKeys, fx, { sent: [] }).ok, true, 'no keys at all');
  assert.equal(judge(noKeys, fx, { sent: [{ key: DOWN, at: useAt - 5000, phase: 'dismiss' }] }).ok, true, 'a trust screen dismissed before the tool_use is fine');
  const stray = judge(noKeys, fx, { sent: [{ key: DOWN, at: useAt + 500, phase: 'dismiss' }, { key: ENTER, at: useAt + 1200, phase: 'dismiss' }] });
  assert.equal(stray.ok, false, 'DOWN+ENTER into the dialog is what the old trust handler could send');
  assert.match(JSON.stringify(stray.seen), /key/);
  assert.equal(judge(noKeys, fx, { sent: [{ key: '\x1b', at: Date.parse(fx[2].timestamp) + 100, phase: 'exit' }] }).ok, true, 'the exit keys sent after the answer are cleanup, not input');
  assert.equal(judge(noKeys, fx).ok, true, 'a committed fixture has no key log: nothing to check');

  const click = byName('genuine-click');
  const gc = load('2.1.323', 'genuine-click');
  const gcRes = Date.parse(gc[2].timestamp);
  const keys = (enterAt) => [{ key: DOWN, at: enterAt - 700, phase: 'case' }, { key: ENTER, at: enterAt, phase: 'case' }];
  assert.equal(judge(click, gc, { sent: keys(gcRes - 50) }).ok, true, 'Enter, then the result');
  const early = judge(click, gc, { sent: keys(gcRes + 900) });
  assert.equal(early.ok, false, 'the result is recorded before the script pressed Enter: someone else answered');
  assert.equal(judge(click, gc, { sent: [] }).ok, false, 'a key case with no Enter logged is not a click the script made');
});

test('R1-F1: the prefilled answer is a label no script key sequence selects, in the scratch hook and in the model prompt', () => {
  const simple = byName('genuine-click').prompt;
  const prefilled = byName('model-prefilled-answers').prompt;
  assert.ok(simple.includes(PREFILL_LABEL) && prefilled.includes(PREFILL_LABEL), 'the label is an option of the dialog the cases use');
  const options = [...simple.matchAll(/label:"([^"]+)"/g)].map((m) => m[1]);
  const at = options.indexOf(PREFILL_LABEL);
  assert.ok(at >= 2, 'a third option or later');
  assert.match(prefilled, new RegExp('"answers" = \\{"[^"]+":"' + PREFILL_LABEL + '"\\}'));
  for (const c of CASES.filter((x) => x.prompt === simple)) assert.ok(c.keys.filter((k) => k === DOWN).length < at, `${c.name}: its keys never move the cursor onto the prefilled option`);
  for (const name of ['pretooluse-hook-answer', 'permissionrequest-hook-answer']) {
    assert.ok(byName(name).answer.test(PREFILL_LABEL), `${name}: a re-recorded hook answer is the prefill label`);
    assert.ok(byName(name).answer.test('Merge'), `${name}: the older recordings (hook prefilled Merge) still pass`);
    assert.ok(!byName(name).answer.test('Not yet'));
  }
});

test('R1-F1/F3: the scratch hook prefills the non-navigable label; mode fill returns ONLY updatedInput (no permissionDecision)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'spike-hook-'));
  const file = join(dir, 'hook.mjs');
  writeFileSync(file, HOOK);
  const input = (ev) => JSON.stringify({ hook_event_name: ev, tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Q?', header: 'h', multiSelect: false, options: [{ label: 'Not yet', description: 'a' }, { label: 'Merge', description: 'b' }, { label: PREFILL_LABEL, description: 'c' }] }] } });
  const run = (mode, ev) => { const r = spawnSync(process.execPath, [file], { input: input(ev), env: { ...process.env, SPIKE_MODE: mode }, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput : null; };
  const fill = run('fill', 'PreToolUse');
  assert.deepEqual(Object.keys(fill).sort(), ['hookEventName', 'updatedInput'], 'no permissionDecision, no reason: only the input');
  assert.deepEqual(fill.updatedInput.answers, { 'Q?': PREFILL_LABEL });
  assert.equal(run('fill', 'PermissionRequest'), null);
  assert.equal(run('askfill', 'PreToolUse').permissionDecision, 'ask');
  assert.deepEqual(run('answer', 'PreToolUse').updatedInput.answers, { 'Q?': PREFILL_LABEL });
  assert.deepEqual(run('permreq', 'PermissionRequest').decision.updatedInput.answers, { 'Q?': PREFILL_LABEL });
  assert.equal(run('none', 'PreToolUse'), null);
});

test('R1-F3: the matrix has the PreToolUse updatedInput-only case, expected not-human', () => {
  const c = byName('pretooluse-fill-no-decision');
  assert.ok(c);
  assert.equal(c.mode, 'fill');
  assert.equal(c.expect, 'not-human');
  assert.deepEqual(c.keys, []);
});

test('R1-F2: a partial run (--only) is not a verdict: distinct exit code, no CLICK_BUILDS recommendation', () => {
  const all = verdict({ build: '2.1.324', ran: CASES.length, total: CASES.length, bad: 0 });
  assert.equal(all.code, 0);
  assert.match(all.text, /add '2\.1\.324' to CLICK_BUILDS/);
  const some = verdict({ build: '2.1.324', ran: 1, total: CASES.length, bad: 0 });
  assert.equal(some.code, PARTIAL_EXIT);
  assert.ok(PARTIAL_EXIT > 2, 'distinct from 0 (all passed), 1 (a case failed) and 2 (usage)');
  assert.ok(!/add '/.test(some.text) && /partial/i.test(some.text), some.text);
  const failed = verdict({ build: '2.1.324', ran: 1, total: CASES.length, bad: 1 });
  assert.equal(failed.code, 1);
  assert.ok(!/add '/.test(failed.text));
  assert.equal(verdict({ build: '2.1.324', ran: 0, total: CASES.length, bad: 0 }).code, PARTIAL_EXIT, 'no case at all is not a pass');
  assert.equal(verdict({ build: '2.1.324', ran: CASES.length, total: CASES.length, bad: 2 }).code, 1);
});

test('R1-F2: --only names are checked against the matrix', () => {
  assert.deepEqual(selectCases(null).cases, CASES);
  assert.deepEqual(selectCases(new Set(['genuine-click'])).cases.map((c) => c.name), ['genuine-click']);
  assert.deepEqual(selectCases(new Set(['genuine-click', 'typo'])).unknown, ['typo']);
});

test('R2-B1: a not-human case needs a real answered result; a dialog the script cancelled (ESC, error result, no answer) is inconclusive, never not-human', () => {
  const notHuman = ['pretooluse-ask-prefill', 'pretooluse-fill-no-decision'].map(byName);
  const answered = load('2.1.323', 'pretooluse-ask-prefill');
  // the committed 2.1.322 recording of the model-prefilled case: the dialog stayed open and the result is the rejection error with no permissionDecision and no answers
  const cancelled = load('2.1.322', 'model-prefilled-answers');
  // the same rejection with the canonical tool_use input a script-cancelled dialog really has (the committed 2.1.322 input carries prefilled answers, which fails for another reason)
  const scriptCancelled = [answered[0], answered[1], cancelled[2]];
  scriptCancelled[2].message.content[0].tool_use_id = answered[1].message.content.find((b) => b.type === 'tool_use').id;
  for (const c of notHuman) {
    assert.equal(judge(c, cancelled).inconclusive, true, `${c.name}: the committed 2.1.322 rejection is inconclusive as a not-human recording`);
    const j = judge(c, scriptCancelled);
    assert.equal(j.ok, false, `${c.name}: an error result with no answer is not a not-human verdict`);
    assert.equal(j.inconclusive, true, `${c.name}: and it is reported as inconclusive`);
    assert.equal(j.seen.answer, null);
    // the same shape produced by the script's own ESC: the result is recorded after an exit key
    const esc = judge(c, answered, { sent: [{ key: '\x1b', at: Date.parse(answered[2].timestamp) - 1000, phase: 'exit' }] });
    assert.equal(esc.ok, false, `${c.name}: ESC from the script before the result`);
    assert.equal(esc.seen.endedByScriptKey, true);
  }
  // an answered result with an exit key sent before it was recorded was also ended by the script, so it does not count either
  const early = judge(byName('pretooluse-ask-prefill'), answered, { sent: [{ key: '\x1b', at: Date.parse(answered[2].timestamp) - 10, phase: 'exit' }] });
  assert.equal(early.ok, false);
  assert.equal(early.inconclusive, true);
  // the committed answered recording still passes, with and without exit keys sent after the result
  assert.equal(judge(byName('pretooluse-ask-prefill'), answered).ok, true);
  assert.equal(judge(byName('pretooluse-ask-prefill'), answered, { sent: [{ key: '\x1b', at: Date.parse(answered[2].timestamp) + 100, phase: 'exit' }] }).ok, true);
  // an answered result with an is_error tool_result does not count (answers present but the tool_result was an error)
  const errored = structuredClone(answered);
  errored[2].message.content.find((b) => b.type === 'tool_result').is_error = true;
  assert.equal(judge(byName('pretooluse-ask-prefill'), errored).ok, false);
  // other expectations are unchanged: the 2.1.322 prefilled case is judged on the tool_use input, not on an answer
  assert.equal(judge(byName('model-prefilled-answers'), cancelled).ok, true);
});
