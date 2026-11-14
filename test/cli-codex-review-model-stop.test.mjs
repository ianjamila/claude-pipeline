// A refused Codex model (cp #431) through the real codex-review CLI: the captured stream (test/helpers/model-stop.mjs), synthetic rollouts under a private CODEX_HOME, a fake gh and the fake Codex.
// The same world as test/cli-codex-review-route.test.mjs (a PR at round 1, a private Codex record folder).
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { roundWorld } from './helpers/round-world.mjs';
import { assertExit } from './helpers/assert-exit.mjs';
import { readStatus } from '../pipeline/lib/codex-usage.mjs';
import { DEFAULTS } from '../pipeline/lib/config.mjs';
import { CONFIRM_THREAD, MAIN_THREAD, PROBE_MODEL, modelStopEnv } from './helpers/model-stop.mjs';

const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const MODEL = DEFAULTS.review.codex_model; // the trusted model of a world with no review.codex_model of its own

function world(t, opts = {}) {
  const w = roundWorld(t, { max: 3, ...opts });
  const status = join(realpathSync.native(mkdtempSync(join(tmpdir(), 'cp-model-status-'))), 'codex');
  t.after(() => rmSync(join(status, '..'), { recursive: true, force: true }));
  w.status = status;
  w.run = (round, env = {}) => w.cli(['codex-review', '--pr', '7', '--round', String(round), '--base', w.base, '--head', w.head, '--effort', 'high'], { PIPELINE_CODEX_STATUS_DIR: status, ...env });
  w.route = (round = 1) => JSON.parse(readFileSync(join(w.repo.dir, '.review', `round-${round}`, 'route.json'), 'utf8'));
  w.record = () => readStatus({ dir: status });
  w.stop = (opts = {}) => modelStopEnv(w.scratch, { model: MODEL, status, ...opts });
  return w;
}

test('a proven refused model is exit 3 reason model, substitute eligible (why model), and route.json holds the model evidence with the TRUSTED model string; no quota outage is recorded', (t) => {
  const w = world(t);
  const r = w.run(1, w.stop());
  assertExit(r, 3, r.stdout + r.stderr);
  assert.equal(r.json.reason, 'model');
  assert.deepEqual([r.json.substitute.eligible, r.json.substitute.why, r.json.substitute.agent, r.json.substitute.resetAt], [true, 'model', 'substitute-opus', null]);
  assert.deepEqual(r.json.modelStop, { proven: true, proof: 'session-log', model: MODEL });
  assert.ok(r.json.message.includes(`Codex refused the configured model ${MODEL} (model_not_found`), r.json.message);
  assert.match(r.json.message, /fix it on main/);
  assert.ok(r.json.message.includes('A substitute (substitute-opus) may stand in: `pipeline substitute prepare`'), r.json.message);
  assert.equal('quota' in r.json, false);
  const route = w.route();
  const dir = join(w.repo.dir, '.review', 'round-1');
  assert.deepEqual([route.evidence, route.outcome, route.reason, route.model, route.provider, route.proof], ['model', 'failed', 'model', MODEL, 'openai', 'session-log']);
  assert.deepEqual([route.threadId, route.confirm], [MAIN_THREAD, { threadId: CONFIRM_THREAD }]);
  assert.equal(route.errorEvent.type, 'turn.failed');
  assert.equal(route.promptSha256, sha(readFileSync(join(dir, 'prompt.md'))), 'bound to the prompt Codex was sent');
  assert.ok(!JSON.stringify(route).includes(PROBE_MODEL), 'the probe model name never appears: only the trusted string is recorded');
  assert.equal(w.record().lastOutage, null, 'a refused model is not a quota outage');
  assert.deepEqual(w.record().waiting, []);
});

test('a refused model on a high-risk PR gets substitute-fable; the model stop is never retried (one main run plus the one confirmation run, both asking for the trusted model)', (t) => {
  const w = world(t, { yml: 'risk:\n  high_risk_paths: ["src/big.js"]\n' });
  const capture = join(w.scratch, 'capture.jsonl');
  const r = w.run(1, { ...w.stop(), FAKE_CODEX_CAPTURE: capture });
  assertExit(r, 3, r.stdout);
  assert.deepEqual([r.json.substitute.eligible, r.json.substitute.agent], [true, 'substitute-fable']);
  const runs = readFileSync(capture, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(runs.length, 2);
  assert.ok(runs.every((x) => x.argv.includes(`model="${MODEL}"`)));
  assert.equal(runs[1].stdin, 'Reply OK');
});

test('an unproven refused model (the log disagrees, another model ran, no confirmation log, another provider) is exit 3 eligible false model-unproven, with the evidence kind none and a message that says it could not be proven', (t) => {
  for (const [name, opts] of [
    ['log disagrees', { main: { error: 'unexpected status 401 Unauthorized' } }],
    ['log ran another model', { main: { model: 'gpt-other-1' } }],
    ['no confirmation log', { confirm: { missing: true } }],
    ['another provider', { confirm: { provider: 'nosuchprov' } }],
  ]) {
    const w = world(t);
    const r = w.run(1, w.stop(opts));
    assertExit(r, 3, `${name}: ${r.stdout}`);
    assert.equal(r.json.reason, 'model', name);
    assert.deepEqual([r.json.substitute.eligible, r.json.substitute.why], [false, 'model-unproven'], name);
    assert.equal(r.json.modelStop.proven, false, name);
    assert.ok(r.json.modelStop.unproven, name);
    assert.match(r.json.message, /could not be proven/, name);
    assert.deepEqual([w.route().evidence, w.route().reason], ['none', 'model'], name);
  }
});

test('a refused model with review.substitute.mode off (working tree, or an unreadable base) is eligible false mode-off, and the message says where the off came from (R3-4: repair the base with an owner commit)', (t) => {
  const off = world(t, { review: '  substitute:\n    mode: off\n' });
  const a = off.run(1, off.stop());
  assertExit(a, 3, a.stdout);
  assert.deepEqual([a.json.substitute.eligible, a.json.substitute.why], [false, 'mode-off']);
  assert.match(a.json.message, /No substitute may stand in: the working-tree pipeline.yml sets review.substitute.mode off/);

  // a base config that is not valid at the fork point (a malformed codex_model committed there): the working tree is repaired, the base reads as unreadable
  const w = world(t, { review: '  codex_model: gpt 5\n' });
  w.config({ review: '' });
  const b = w.run(1, w.stop());
  assertExit(b, 3, b.stdout + b.stderr);
  assert.deepEqual([b.json.substitute.eligible, b.json.substitute.why], [false, 'mode-off']);
  assert.match(b.json.message, /the pipeline.yml at main's fork point is not a valid config \(.+\): repair .claude\/pipeline.yml on main with an owner commit; no PR can get a substitute until then/);
});
