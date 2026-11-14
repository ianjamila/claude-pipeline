// scripts/click-spike.mjs re-records the click transcript fixtures (test/fixtures/click/<build>/) on the installed Claude Code build. Running it needs a logged-in `claude` and a real terminal,
// so this file tests only its pure parts: that importing it runs nothing, that trim() keeps the three entries a fixture holds, and that judge() accepts every committed fixture for the case
// the script defines for it (a build whose recordings the script itself would reject must never be in CLICK_BUILDS).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CASES, judge, trim } from '../scripts/click-spike.mjs';
import { CLICK_BUILDS, HUMAN_DECISION } from '../pipeline/hooks/lib/owner-go-click.mjs';

const FIX = new URL('./fixtures/click/', import.meta.url);
const SCRIPT = fileURLToPath(new URL('../scripts/click-spike.mjs', import.meta.url));
const load = (build, name) => readFileSync(new URL(`${build}/${name}.jsonl`, FIX), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const atLeast = (b, min) => { const [x, y] = [b, min].map((v) => v.split('.').map(Number)); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]; return true; };
const recorded = (build) => CASES.filter((c) => !c.headless && (c.since === undefined || atLeast(build, c.since)));

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
