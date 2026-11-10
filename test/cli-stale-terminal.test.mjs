// A terminal running an older Claude Code than the installed one is stopped BEFORE the Fable pass (plan 2026-11-10, A3), and every arbiter step that
// stops is saved on the round as `arbiter.failure` (A4). The real CLI runs from the checkout against a throwaway repo. Both Claude Code versions come
// from the test's own env (AI_AGENT and a scratch package.json behind CLAUDE_CODE_EXECPATH): the suite itself runs inside Claude Code, so nothing
// here may depend on the machine's real versions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertExit } from './helpers/assert-exit.mjs';
import { createTmpRepo } from './helpers/tmprepo.mjs';
import { scratchFloorDir } from './helpers/floor-env.mjs';
import { createFakeGh, pipelineYml, REPO_VIEW } from './helpers/fakegh-env.mjs';
import { withFloorLock } from '../pipeline/lib/model-floor.mjs';
import { arbiterFailures, roundOutcome } from '../pipeline/lib/triage.mjs';
import { triageComment } from '../pipeline/lib/render.mjs';

process.env.PIPELINE_MACHINE_ID ||= 'test-machine-id';
const here = dirname(fileURLToPath(import.meta.url));
const bin = join(here, '..', 'pipeline', 'bin', 'pipeline.mjs');
const fakeCodex = join(here, 'fixtures', 'fake-codex.mjs');

const aFile = (changed) => Array.from({ length: 30 }, (_, i) => (i === 11 && changed ? 'export const v12 = compute(x.y);' : `export const v${i + 1} = ${i + 1};`)).join('\n') + '\n';
const finding = (over = {}) => ({
  title: 'Missing null check', file: 'src/a.js', line: 12, category: 'bug',
  detail: 'x is dereferenced before it is checked', reasoning: 'compute(x.y) throws when x is undefined', testable: true, ...over,
});
const NO_FINDINGS = { summary: 'Reviewed.', blocking: [], suggestions: [], worth_considering: [] };
const ONE_FINDING = { ...NO_FINDINGS, suggestions: [finding({ title: 'Rename helper', category: 'maintainability' })] };
const GH = [
  { match: '^pr view 7', stdoutJson: { title: 'Add compute', body: 'Adds compute() to a.js', headRefName: 'feat/x' } },
  { match: '^repo view', stdoutJson: REPO_VIEW },
];
const fenced = (obj) => `Done.\n\n\`\`\`json\n${JSON.stringify(obj)}\n\`\`\``;

const OLD = 'claude-fable-5-1';
const FLOOR = 'claude-fable-5-2';
const SCRUBBED = ['AI_AGENT', 'CLAUDE_CODE_EXECPATH', 'PIPELINE_TEST_MODE', 'PIPELINE_TEST_FLOOR_PAUSE', 'PIPELINE_TEST_FLOOR_WAIT_MS', 'PIPELINE_ACCOUNT_PROJECTS_DIR', 'NODE_OPTIONS', 'FAKE_CODEX_OUTPUT'];
const SENSITIVE_YML = `${pipelineYml()}review:\n  arbiter_always_paths: [src/a.js]\n`;

// <scratch>/claude-code/{package.json,bin/claude.exe}: the install CLAUDE_CODE_EXECPATH points at; `running` is the AI_AGENT string.
function claudeCode(scratch, { running, installed }) {
  const env = {};
  if (running !== null) env.AI_AGENT = `claude-code_${running.replaceAll('.', '-')}_agent`;
  if (installed !== null) {
    const root = join(scratch, `claude-code-${installed}`);
    mkdirSync(join(root, 'bin'), { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-code', version: installed }));
    env.CLAUDE_CODE_EXECPATH = join(root, 'bin', 'claude.exe');
  }
  return env;
}
const STALE = { running: '2.1.318', installed: '2.1.322' };
const FRESH = { running: '2.1.322', installed: '2.1.322' };

// fable: the only changed path is one the config sends to Fable every round (a Fable round with the given Codex findings); else a plain dispute round.
function world(t, { fable = true, findings = NO_FINDINGS } = {}) {
  const repo = createTmpRepo();
  t.after(() => repo.cleanup());
  repo.write('.claude/pipeline.yml', fable ? SENSITIVE_YML : pipelineYml());
  repo.write('.gitignore', '.review/\n');
  repo.write('src/a.js', aFile(false));
  const base = repo.commit('init');
  repo.branch('feat/x');
  repo.write('src/a.js', aFile(true));
  repo.write('src/big.js', Array.from({ length: 60 }, (_, i) => `export const big${i} = ${i};`).join('\n') + '\n'); // not a light-lane change
  const head = repo.commit('feature');
  const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), 'cp-stale-')));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const fake = createFakeGh(GH.map((e) => (e.match === '^pr view 7' ? { ...e, stdoutJson: { baseRefName: 'main', headRefOid: head, ...e.stdoutJson } } : e)));
  const w = {
    repo, base, head, scratch, floor: scratchFloorDir(),
    env(extra = {}) {
      const env = {
        ...process.env, ...fake.env, PIPELINE_CODEX: `node "${fakeCodex}"`, PIPELINE_LOCK_DIR: join(scratch, 'locks'),
        PIPELINE_MODEL_FLOOR_DIR: w.floor, PIPELINE_MACHINE_ID: process.env.PIPELINE_MACHINE_ID,
      };
      for (const k of SCRUBBED) delete env[k];
      return { ...env, ...extra };
    },
    cli(args, extra = {}) {
      const r = spawnSync(process.execPath, [bin, ...args], { cwd: repo.dir, env: w.env(extra), encoding: 'utf8' });
      let json = null;
      try { json = r.stdout ? JSON.parse(r.stdout) : null; } catch { /* the assertion on json will say so */ }
      return { code: r.status, json, stdout: r.stdout, stderr: r.stderr };
    },
    file(name, content) {
      const p = join(scratch, name);
      writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content));
      return p;
    },
    state: () => JSON.parse(readFileSync(join(repo.dir, '.review', 'state.json'), 'utf8')),
    stateText: () => readFileSync(join(repo.dir, '.review', 'state.json'), 'utf8'),
    roundFile: (name) => join(repo.dir, '.review', 'round-1', name),
    // Round 1 through Codex (and, for a dispute round, the judge); `arbiter needed` is each test's own step.
    prepare() {
      assertExit(w.cli(['codex-review', '--pr', '7', '--round', '1', '--base', base, '--head', head, '--effort', 'high'], { FAKE_CODEX_OUTPUT: w.file('findings-1.json', findings) }), 0);
      if (!fable) {
        const judge = { items: [{ id: 'R1-S1', decision: 'REJECT', confidence: 'low', reason: 'judge: unsure', disputedBug: false, settleTest: { possible: false, plan: '' } }] };
        assertExit(w.cli(['triage', 'validate', '--round', '1', '--file', w.file('judge-1.json', judge)]), 0);
      }
      return w;
    },
    needed(extra = {}) { return w.cli(['arbiter', 'needed', '--round', '1'], extra); },
    // A Fable transcript under a loose folder (found with --projects-dir) that answers the input of the last successful `needed`.
    install(needed, { models = [FLOOR], version, agentId = 'a1', answer, projects = join(scratch, `projects-${agentId}`) } = {}) {
      const dir = join(projects, '-tmp-work', 'session-1', 'subagents');
      mkdirSync(dir, { recursive: true });
      const text = fenced(answer ?? (fable ? { rulings: [], findings: [] } : { rulings: [{ id: 'R1-S1', ruling: 'ACCEPT', confidence: 'high', reasoning: 'src/a.js:12 really is wrong.' }] }));
      const stamp = version ? { version } : {};
      const lines = [{ type: 'user', isSidechain: true, agentId: 'a1', message: { role: 'user', content: `ROUND: 1\nINPUT-DIGEST: ${needed.digest}\nRule on every item.` }, uuid: 'u-1', ...stamp }];
      models.forEach((model, i) => {
        const last = i === models.length - 1;
        lines.push({
          type: 'assistant', isSidechain: true, agentId: 'a1', requestId: `req_${i}`, effort: 'high', perTurnEffort: 'high', ...stamp,
          message: { model, id: `msg_${i}`, role: 'assistant', stop_reason: last ? 'end_turn' : 'tool_use', content: last ? [{ type: 'text', text }] : [{ type: 'thinking', thinking: 'weighing', signature: 'sig' }] },
          uuid: `a-${i}`,
        });
      });
      writeFileSync(join(dir, `agent-${agentId}.jsonl`), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
      writeFileSync(join(dir, `agent-${agentId}.meta.json`), JSON.stringify({ toolUseId: 'toolu_01', spawnDepth: 1, agentType: 'arbiter', description: needed.tag }));
      return projects;
    },
    apply(projects, extra = {}) { return w.cli(['arbiter', 'apply', '--round', '1', '--projects-dir', projects], extra); },
  };
  return w;
}

const STALE_ADVICE = 'this terminal runs Claude Code 2.1.318 but 2.1.322 is installed: restart this terminal, then run `arbiter needed` again';

// ---- the stop ------------------------------------------------------------------------------------------------------------------------

test('arbiter needed on a Fable round in a stale terminal stops with stale-terminal BEFORE writing any input, diff or tag', (t) => {
  const w = world(t).prepare();
  const stateBefore = w.state();
  const r = w.needed(claudeCode(w.scratch, STALE));
  assertExit(r, 1, r.stdout + r.stderr);
  assert.deepEqual(r.json, {
    ok: false, error: 'stale-terminal', restartRequired: true, claudeCode: { running: '2.1.318', installed: '2.1.322', stale: true }, advice: STALE_ADVICE,
  });
  assert.equal(existsSync(w.roundFile('arbiter-input.md')), false, 'no arbiter input was written');
  assert.equal(existsSync(w.roundFile('fable-diff.patch')), false, 'no diff was written');
  const round = w.state().rounds[0];
  assert.equal(round.arbiter.tag, undefined, 'no tag was minted');
  assert.equal(round.arbiter.inputDigest, undefined);
  assert.deepEqual([round.arbiter.failure.cause, round.arbiter.failure.advice], ['stale-terminal', STALE_ADVICE]);
  assert.match(round.arbiter.failure.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.deepEqual({ ...w.state(), rounds: [{ ...round, arbiter: undefined }] }, { ...stateBefore, rounds: [{ ...stateBefore.rounds[0], arbiter: undefined }] }, 'nothing else in the state changed');
  // the round is not clean, and the outcome names why
  const outcome = w.cli(['state', 'outcome']);
  assertExit(outcome, 0, outcome.stdout);
  assert.equal(outcome.json.clean, false);
  assert.deepEqual(outcome.json.fablePending, [1]);
  assert.deepEqual(outcome.json.arbiterFailures, [{ round: 1, cause: 'stale-terminal', advice: STALE_ADVICE }]);
});

test('arbiter needed: a terminal that is not stale (same or newer build) goes ahead', (t) => {
  for (const [name, cc] of [['same', FRESH], ['newer', { running: '2.1.400', installed: '2.1.322' }]]) {
    const w = world(t).prepare();
    const r = w.needed(claudeCode(w.scratch, cc));
    assertExit(r, 0, `${name}: ${r.stdout}`);
    assert.deepEqual([r.json.needed, r.json.mode], [true, 'review']);
    assert.equal(w.state().rounds[0].arbiter.failure, undefined);
  }
});

test('arbiter needed: an unknown version on either side (stale null) does not stop the pass', (t) => {
  const w = world(t).prepare();
  for (const [name, cc] of [
    ['neither known', { running: null, installed: null }],
    ['running unknown', { running: null, installed: '2.1.322' }],
    ['installed unknown', { running: '2.1.318', installed: null }],
  ]) {
    const r = w.needed(claudeCode(w.scratch, cc));
    assertExit(r, 0, `${name}: ${r.stdout}`);
    assert.equal(r.json.needed, true, name);
  }
  assert.equal(w.state().rounds[0].arbiter.failure, undefined);
});

test('arbiter needed: a dispute (non-Fable) round is not stopped by a stale terminal', (t) => {
  const w = world(t, { fable: false, findings: ONE_FINDING }).prepare();
  // (the one low-confidence item sits in the light lane: force it to the arbiter so the dispute path is the one under test)
  const r = w.needed({ ...claudeCode(w.scratch, STALE), PIPELINE_TEST_FORCE_ARBITER: '1' });
  assertExit(r, 0, r.stdout + r.stderr);
  assert.deepEqual([r.json.needed, r.json.mode, r.json.items], [true, 'dispute', ['R1-S1']]);
  assert.equal(w.state().rounds[0].arbiter.failure, undefined);
});

test('arbiter needed: a proven Fable round answers done even from a stale terminal (nothing is spent)', (t) => {
  const w = world(t).prepare();
  const needed = w.needed(claudeCode(w.scratch, FRESH));
  assertExit(w.apply(w.install(needed.json)), 0);
  const again = w.needed(claudeCode(w.scratch, STALE));
  assertExit(again, 0, again.stdout);
  assert.deepEqual(again.json, { needed: false, items: [], mode: 'review', done: true });
});

// ---- round.arbiter.failure -------------------------------------------------------------------------------------------------------------

test('a zero-item Fable round keeps its apply failure on the round, and a later apply that proves clears it', (t) => {
  const w = world(t).prepare();
  const needed = w.needed();
  assertExit(needed, 0, needed.stdout);
  assert.deepEqual(needed.json.items, [], 'no item can carry a cause');
  const stale = w.apply(w.install(needed.json, { models: [OLD], version: '2.1.318' }), claudeCode(w.scratch, { running: '2.1.318', installed: '2.1.322' }));
  assertExit(stale, 1, stale.stdout);
  assert.equal(stale.json.error, 'stale-model');
  const failure = w.state().rounds[0].arbiter.failure;
  assert.equal(failure.cause, 'stale-model');
  assert.match(failure.advice, /^restart this terminal \(it runs Claude Code 2\.1\.318, the installed build is 2\.1\.322\), then run the review again$/);
  assert.match(failure.at, /^\d{4}-/);
  assert.deepEqual(w.cli(['state', 'outcome']).json.arbiterFailures, [{ round: 1, cause: 'stale-model', advice: failure.advice }]);
  // `needed` again (a restarted terminal) keeps the record until a pass proves
  const again = w.needed(claudeCode(w.scratch, FRESH));
  assertExit(again, 0, again.stdout);
  assert.equal(w.state().rounds[0].arbiter.failure.cause, 'stale-model');
  const ok = w.apply(w.install(again.json, { models: [FLOOR], agentId: 'a2' }), claudeCode(w.scratch, FRESH));
  assertExit(ok, 0, ok.stdout);
  assert.equal(w.state().rounds[0].arbiter.proofOk, true);
  assert.equal(w.state().rounds[0].arbiter.failure, undefined, 'a proven apply clears the failure');
  assert.deepEqual(w.cli(['state', 'outcome']).json.arbiterFailures, []);
  assert.equal(w.cli(['state', 'outcome']).json.fablePending.length, 0);
});

test('a stale-terminal stop is cleared by the proving apply that follows the restart', (t) => {
  const w = world(t).prepare();
  assertExit(w.needed(claudeCode(w.scratch, STALE)), 1);
  assert.equal(w.state().rounds[0].arbiter.failure.cause, 'stale-terminal');
  const needed = w.needed(claudeCode(w.scratch, FRESH));
  assertExit(needed, 0);
  assertExit(w.apply(w.install(needed.json)), 0);
  assert.equal(w.state().rounds[0].arbiter.failure, undefined);
});

test('arbiter apply: an unreadable Fable id, an unreadable registry and a lock/disk failure each save the failure on the round', async (t) => {
  // unrecognised-fable
  const a = world(t).prepare();
  const na = a.needed();
  const unparsed = a.apply(a.install(na.json, { models: ['claude-fable-x'] }));
  assertExit(unparsed, 1, unparsed.stdout);
  assert.deepEqual([unparsed.json.error, a.state().rounds[0].arbiter.failure.cause], ['unrecognised-fable', 'unrecognised-fable']);
  assert.match(a.state().rounds[0].arbiter.failure.advice, /update the pipeline/);
  // model-floor-unreadable
  const b = world(t).prepare();
  const nb = b.needed();
  mkdirSync(b.floor, { recursive: true });
  writeFileSync(join(b.floor, 'fable.json'), '{not json');
  const unreadable = b.apply(b.install(nb.json));
  assertExit(unreadable, 1, unreadable.stdout);
  assert.deepEqual([unreadable.json.error, b.state().rounds[0].arbiter.failure.cause], ['model-floor-unreadable', 'model-floor-unreadable']);
  // model-floor-busy
  const c = world(t).prepare();
  const nc = c.needed();
  const projects = c.install(nc.json);
  const busy = await withFloorLock({ dir: c.floor }, async () => c.cli(['arbiter', 'apply', '--round', '1', '--projects-dir', projects], { PIPELINE_TEST_MODE: '1', PIPELINE_TEST_FLOOR_WAIT_MS: '300' }));
  assertExit(busy, 1, busy.stdout + busy.stderr);
  assert.equal(busy.json.error, 'model-floor-busy');
  assert.equal(c.state().rounds[0].arbiter.failure.cause, 'model-floor-busy');
  assert.match(c.state().rounds[0].arbiter.failure.advice, /arbiter apply` again in a minute/);
  assertExit(c.apply(projects), 0);
  assert.equal(c.state().rounds[0].arbiter.failure, undefined, 'the retry proves and clears it');
});

test('arbiter apply: a floor registry that cannot be written (model-floor-unwritable) saves the failure; the retry proves and clears it', (t) => {
  const w = world(t).prepare();
  const needed = w.needed();
  const home = join(w.scratch, 'home');
  const projects = join(home, '.claude', 'projects');
  w.install(needed.json, { models: ['claude-fable-5-3'], projects });
  const own = { HOME: home, PIPELINE_ACCOUNT_PROJECTS_DIR: projects };
  const preload = new URL('./fixtures/fail-floor-write-preload.mjs', import.meta.url).href;
  const r = w.cli(['arbiter', 'apply', '--round', '1'], { ...own, NODE_OPTIONS: `--import ${preload}` });
  assertExit(r, 1, r.stdout + r.stderr);
  assert.equal(r.json.error, 'model-floor-unwritable');
  const failure = w.state().rounds[0].arbiter.failure;
  assert.equal(failure.cause, 'model-floor-unwritable');
  assert.match(failure.advice, /model-floor reset/);
  assert.equal(w.state().rounds[0].arbiter.proofOk, undefined, 'nothing else was published');
  assertExit(w.cli(['arbiter', 'apply', '--round', '1'], own), 0);
  assert.equal(w.state().rounds[0].arbiter.failure, undefined);
});

test('a non-floor failure of the apply (the proof itself) clears an earlier floor failure instead of keeping a stale one', (t) => {
  const w = world(t).prepare();
  const needed = w.needed();
  assertExit(w.apply(w.install(needed.json, { models: [OLD] })), 1);
  assert.equal(w.state().rounds[0].arbiter.failure.cause, 'stale-model');
  const again = w.needed();
  const notFable = w.cli(['arbiter', 'apply', '--round', '1', '--projects-dir', w.install(again.json, { models: ['claude-opus-5-5'], agentId: 'a3' })]);
  assertExit(notFable, 1, notFable.stdout);
  assert.equal(w.state().rounds[0].arbiter.failure, undefined);
});

test('arbiter apply: an older build with an acceptable model proves (the floor decides, not the build)', (t) => {
  const w = world(t).prepare();
  const needed = w.needed(claudeCode(w.scratch, FRESH));
  const r = w.apply(w.install(needed.json, { models: [FLOOR], version: '2.1.318' }), claudeCode(w.scratch, STALE));
  assertExit(r, 0, r.stdout + r.stderr);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.error, undefined);
  assert.equal(w.state().rounds[0].arbiter.proofOk, true);
});

// ---- what the state, the outcome and the comment say --------------------------------------------------------------------------------------

const fableState = (arbiter) => ({
  version: 1, pr: 7, repo: 'acme/widgets', maxRounds: 3, currentContentHash: 'a'.repeat(64),
  rounds: [{ n: 1, toHead: 'b'.repeat(40), contentHashAtToHead: 'a'.repeat(64), fableRequired: true, fableReasons: ['sensitive path: src/a.js'], sensitivePaths: ['src/a.js'], items: [], arbiter }],
});

test('roundOutcome: a Fable round with an arbiter failure and no proof is not clean and names the failure; a proof ends the failure', () => {
  const failure = { cause: 'stale-terminal', advice: 'restart', at: '2026-11-10T00:00:00.000Z' };
  const stopped = roundOutcome(fableState({ failure }));
  assert.equal(stopped.clean, false);
  assert.deepEqual(stopped.fablePending, [1]);
  assert.deepEqual(arbiterFailures(fableState({ failure })), [{ round: 1, cause: 'stale-terminal', advice: 'restart' }]);
  const proven = roundOutcome(fableState({ proofOk: true }));
  assert.equal(proven.clean, true);
  assert.deepEqual(arbiterFailures(fableState({ proofOk: true, failure })), [], 'a proof ends the failure');
  assert.deepEqual(arbiterFailures({ rounds: [] }), []);
});

test('the triage comment says, in one line, that a round\'s arbiter stopped and why; nothing when there is no failure or it was proven', () => {
  const failure = { cause: 'stale-model', advice: 'restart this terminal', at: '2026-11-10T00:00:00.000Z' };
  const lines = triageComment(fableState({ failure })).split('\n').filter((l) => l.startsWith('Round '));
  assert.deepEqual(lines, ['Round 1 arbiter stopped: stale-model — restart this terminal']);
  assert.doesNotMatch(triageComment(fableState({ inputDigest: 'x' })), /arbiter stopped/);
  assert.doesNotMatch(triageComment(fableState({ proofOk: true, failure })), /arbiter stopped/);
  // an advice-less failure still renders its cause; markup in the advice is defused like every other line
  assert.match(triageComment(fableState({ failure: { cause: 'model-floor-busy' } })), /^Round 1 arbiter stopped: model-floor-busy$/m);
});
