// End-to-end tests for the Fable floor in the model proof (plan 2026-11-10, A2/A6): `arbiter apply` and `model-proof` spawn the real CLI from the
// checkout against a real throwaway repo. Every run gets a scratch floor folder (PIPELINE_MODEL_FLOOR_DIR is honoured by a checkout only), and a
// scratch HOME + PIPELINE_ACCOUNT_PROJECTS_DIR where a test needs a transcript the CLI treats as the account's own (the only kind that may raise
// the floor). The world below is a trimmed copy of cli-review-handback's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertExit } from './helpers/assert-exit.mjs';
import { createTmpRepo } from './helpers/tmprepo.mjs';
import { scratchFloorDir } from './helpers/floor-env.mjs';
import { createFakeGh, NO_COMMENTS, pipelineYml, REPO_VIEW } from './helpers/fakegh-env.mjs';
import { raiseFloor, readFloor, resetFloor, withFloorLock } from '../pipeline/lib/model-floor.mjs';

process.env.PIPELINE_MACHINE_ID ||= 'test-machine-id'; // the in-process floor lock must not create a machine-id file in the real pipeline state folder
const here = dirname(fileURLToPath(import.meta.url));
const bin = join(here, '..', 'pipeline', 'bin', 'pipeline.mjs');
const fakeCodex = join(here, 'fixtures', 'fake-codex.mjs');

const aFile = (changed) => Array.from({ length: 30 }, (_, i) => {
  const n = i + 1;
  return n === 12 && changed ? 'export const v12 = compute(x.y);' : `export const v${n} = ${n};`;
}).join('\n') + '\n';
const bFile = Array.from({ length: 8 }, (_, i) => `export const w${i + 1} = ${i + 1};`).join('\n') + '\n';
const finding = (over = {}) => ({
  title: 'Missing null check', file: 'src/a.js', line: 12, category: 'bug',
  detail: 'x is dereferenced before it is checked', reasoning: 'compute(x.y) throws when x is undefined', testable: true, ...over,
});
const FINDINGS = {
  summary: 'Reviewed.',
  blocking: [finding()],
  suggestions: [
    finding({ title: 'Rename helper', file: 'src/b.js', line: 3, category: 'maintainability' }),
    finding({ title: 'Extract constant', file: 'src/b.js', line: 5, category: 'design' }),
  ],
  worth_considering: [finding({ title: 'Consider caching', file: 'src/a.js', line: 20, category: 'performance', testable: false })],
};
const GH = [
  { match: '^pr view 7', stdoutJson: { title: 'Add compute', body: 'Adds compute() to a.js', headRefName: 'feat/x' } },
  { match: '^repo view', stdoutJson: REPO_VIEW },
  ...NO_COMMENTS,
];
const JUDGE = {
  items: Object.entries({ 'R1-B1': ['ACCEPT'], 'R1-S1': ['REJECT', 'high'], 'R1-S2': ['REJECT', 'low'], 'R1-W1': ['FOLLOW-UP'] }).map(([id, [decision, confidence = 'high']]) => ({
    id, decision, confidence, reason: `judge: ${decision} ${id}`, disputedBug: false, settleTest: { possible: false, plan: '' },
  })),
};
const RULINGS = {
  rulings: [
    { id: 'R1-S1', ruling: 'REJECT', confidence: 'high', reasoning: 'src/b.js:3 already covers this.' },
    { id: 'R1-S2', ruling: 'ACCEPT', confidence: 'high', reasoning: 'src/b.js:5 really is duplicated.' },
  ],
};
const fenced = (obj) => `Done.\n\n\`\`\`json\n${JSON.stringify(obj)}\n\`\`\``;

const OLD = 'claude-fable-5-1';
const FLOOR = 'claude-fable-5-2';
const NEWER = 'claude-fable-5-3';
// Never inherit the real Claude Code identity of the session that runs the suite: the advice depends on it.
const SCRUBBED = ['AI_AGENT', 'CLAUDE_CODE_EXECPATH', 'PIPELINE_TEST_MODE', 'PIPELINE_TEST_FLOOR_PAUSE', 'PIPELINE_TEST_FLOOR_WAIT_MS', 'PIPELINE_ACCOUNT_PROJECTS_DIR', 'NODE_OPTIONS'];

function world(t) {
  const repo = createTmpRepo();
  t.after(() => repo.cleanup());
  repo.write('.claude/pipeline.yml', pipelineYml());
  repo.write('.gitignore', '.review/\n');
  repo.write('src/a.js', aFile(false));
  repo.write('src/b.js', bFile);
  const base = repo.commit('init');
  repo.branch('feat/x');
  repo.write('src/a.js', aFile(true));
  repo.write('src/big.js', Array.from({ length: 60 }, (_, i) => `export const big${i} = ${i};`).join('\n') + '\n');
  const head = repo.commit('feature');
  const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), 'cp-floor-w-')));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const fake = createFakeGh(GH.map((e) => (e.match === '^pr view 7' ? { ...e, stdoutJson: { baseRefName: 'main', headRefOid: head, ...e.stdoutJson } } : e)));
  const w = {
    repo, base, head, scratch,
    floor: scratchFloorDir(),
    // One scratch "account" per world: HOME and the projects folder the CLI treats as <accountHome>/.claude/projects.
    home: join(scratch, 'home'),
    env(extra = {}) {
      const env = {
        ...process.env, ...fake.env, PIPELINE_CODEX: `node "${fakeCodex}"`, FAKE_CODEX_CAPTURE: join(scratch, 'codex-capture.jsonl'),
        PIPELINE_LOCK_DIR: join(scratch, 'locks'), PIPELINE_MODEL_FLOOR_DIR: w.floor, PIPELINE_MACHINE_ID: process.env.PIPELINE_MACHINE_ID || 'test-machine-id',
      };
      for (const k of [...SCRUBBED, 'FAKE_CODEX_OUTPUT']) delete env[k];
      return { ...env, ...extra };
    },
    cli(args, extra = {}) {
      const r = spawnSync(process.execPath, [bin, ...args], { cwd: repo.dir, env: w.env(extra), encoding: 'utf8' });
      let json = null;
      try { json = r.stdout ? JSON.parse(r.stdout) : null; } catch { /* the assertion on json will say so */ }
      return { code: r.status, json, stdout: r.stdout, stderr: r.stderr };
    },
    // The same, as a child the test can wait on later: { done: Promise<result>, child, exited: () => boolean }.
    spawnCli(args, extra = {}) {
      const child = spawn(process.execPath, [bin, ...args], { cwd: repo.dir, env: w.env(extra), stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      let exited = false;
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { err += d; });
      const done = new Promise((resolve) => child.on('close', (code) => {
        exited = true;
        let json = null;
        try { json = out ? JSON.parse(out) : null; } catch { /* leave null */ }
        resolve({ code, json, stdout: out, stderr: err });
      }));
      return { child, done, exited: () => exited };
    },
    file(name, content) {
      const p = join(scratch, name);
      writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content));
      return p;
    },
    state: () => JSON.parse(w.stateText()),
    stateText: () => readFileSync(join(repo.dir, '.review', 'state.json'), 'utf8'),
    item: (id) => w.state().rounds.flatMap((r) => r.items).find((i) => i.id === id),
    registry: () => readFloor({ dir: w.floor }),
    // A round-1 dispute with two items for the arbiter (codex -> judge -> needed).
    prepare() {
      assertExit(w.cli(['codex-review', '--pr', '7', '--round', '1', '--base', base, '--head', head, '--effort', 'high'], { FAKE_CODEX_OUTPUT: w.file('findings-1.json', FINDINGS) }), 0);
      assertExit(w.cli(['triage', 'validate', '--round', '1', '--file', w.file('judge-1.json', JUDGE)]), 0);
      const needed = w.cli(['arbiter', 'needed', '--round', '1']);
      assertExit(needed, 0);
      w.needed = needed.json;
      return w;
    },
    // Claude Code's layout under `projects`: <projects>/<cwd>/<session>/subagents/agent-<id>.{jsonl,meta.json}
    install(projects, { models = [FLOOR], effort = 'high', version, agentId = 'a1', text = fenced(RULINGS) } = {}) {
      const dir = join(projects, '-tmp-work', 'session-1', 'subagents');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `agent-${agentId}.jsonl`), transcript({ prompt: `ROUND: 1\nINPUT-DIGEST: ${w.needed.digest}\nRule on every item.`, models, effort, version, text }));
      writeFileSync(join(dir, `agent-${agentId}.meta.json`), JSON.stringify({ toolUseId: 'toolu_01', spawnDepth: 1, agentType: 'arbiter', description: w.needed.tag }));
      return projects;
    },
    // A transcript the CLI treats as the account's own: under <HOME>/.claude/projects, found without --projects-dir.
    installOwn(opts = {}) {
      const home = opts.home ?? w.home;
      const projects = join(home, '.claude', 'projects');
      w.install(projects, opts);
      // (os.homedir() reads $HOME on POSIX but %USERPROFILE% on Windows, so the scratch account sets both)
      return { HOME: home, USERPROFILE: home, PIPELINE_ACCOUNT_PROJECTS_DIR: projects };
    },
    // An arbitrary folder passed by --projects-dir.
    installLoose(opts = {}) {
      return w.install(join(scratch, `loose-${Math.random().toString(36).slice(2, 8)}`), opts);
    },
  };
  return w;
}

// One assistant line per model (the last carries the answer), each line stamped with the Claude Code build when given.
function transcript({ prompt, models, effort, version, text }) {
  const stamp = version ? { version } : {};
  const lines = [{ type: 'user', isSidechain: true, agentId: 'a1', message: { role: 'user', content: prompt }, uuid: 'u-1', ...stamp }];
  models.forEach((model, i) => {
    const last = i === models.length - 1;
    lines.push({
      type: 'assistant', isSidechain: true, agentId: 'a1', requestId: `req_${i}`, effort, perTurnEffort: effort, ...stamp,
      message: {
        model, id: `msg_${i}`, role: 'assistant', stop_reason: last ? 'end_turn' : 'tool_use',
        content: last ? [{ type: 'text', text }] : [{ type: 'thinking', thinking: 'weighing', signature: 'sig' }],
      },
      uuid: `a-${i}`,
    });
  });
  return `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`;
}

const apply = (w, args = [], extra = {}) => w.cli(['arbiter', 'apply', '--round', '1', ...args], extra);
// The state without the round's arbiter.failure record (written when an apply stops on the floor lock or the registry; nothing else is saved then).
const minusFailure = (state) => { const copy = structuredClone(state); delete copy.rounds[0].arbiter.failure; return copy; };
const registryExists = (w) => existsSync(join(w.floor, 'fable.json'));
const itemCauses = (w) => ['R1-S1', 'R1-S2'].map((id) => w.item(id).final?.cause);

// ---- older than the floor ------------------------------------------------------------------------------------------------------------

test('arbiter apply: an older Fable is refused as stale-model (exit 1, restartRequired, advice) and the items wait with that cause', (t) => {
  const w = world(t).prepare();
  const projects = w.installLoose({ models: [OLD], version: '2.1.318' });
  const r = apply(w, ['--projects-dir', projects], { AI_AGENT: 'claude-code_2-1-318_agent' });
  assertExit(r, 1, r.stdout);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.error, 'stale-model');
  assert.equal(r.json.restartRequired, true);
  assert.deepEqual(r.json.floor, { newest: FLOOR, seen: [OLD] });
  assert.equal(r.json.errors.length, 1);
  assert.equal(r.json.errors[0], `older Fable ${OLD} (this machine's floor: ${FLOOR}). This terminal runs Claude Code 2.1.318: restart it (or update Claude Code), then run the review again.`);
  assert.match(r.json.advice, /^update Claude Code, or the owner runs `pipeline model-floor reset`/, 'no installed build is known, so not "restart"');
  assert.deepEqual(r.json.claudeCodeVersions, ['2.1.318']);
  assert.deepEqual(itemCauses(w), ['stale-model', 'stale-model']);
  assert.equal(w.item('R1-S1').final.needsHuman, true);
  assert.equal(w.state().rounds[0].arbiter.proofOk, false);
  assert.equal(registryExists(w), false, 'a refused proof never writes the registry');
});

test('arbiter apply: mixed Fable versions in one transcript are refused; so are an exact and a broad --expect-model with an old Fable', (t) => {
  const w = world(t).prepare();
  const mixed = apply(w, ['--projects-dir', w.installLoose({ models: [FLOOR, OLD] })]);
  assertExit(mixed, 1, mixed.stdout);
  assert.equal(mixed.json.error, 'stale-model');
  assert.deepEqual(mixed.json.floor.seen, [OLD, FLOOR]);
  assert.match(mixed.json.errors.join('|'), /older Fable claude-fable-5-1 /);

  // --expect-model is a test switch (PIPELINE_TEST_MODE); even when it names the old model exactly, or any model at all, the floor still judges.
  for (const expect of [OLD, 'claude-']) {
    const w2 = world(t).prepare();
    const r = apply(w2, ['--projects-dir', w2.installLoose({ models: [OLD] }), '--expect-model', expect], { PIPELINE_TEST_MODE: '1' });
    assertExit(r, 1, r.stdout);
    assert.equal(r.json.error, 'stale-model', `--expect-model ${expect}`);
    assert.equal(r.json.restartRequired, true);
    assert.deepEqual(itemCauses(w2), ['stale-model', 'stale-model']);
  }
});

test('arbiter apply: restartRequired is set next to other errors, and then the items keep the plain model-proof cause', (t) => {
  const w = world(t).prepare();
  const r = apply(w, ['--projects-dir', w.installLoose({ models: [OLD], effort: 'low' })]);
  assertExit(r, 1, r.stdout);
  assert.equal(r.json.restartRequired, true);
  assert.equal(r.json.error, 'stale-model');
  assert.ok(r.json.errors.some((e) => /unexpected effort low/.test(e)), r.json.errors.join('|'));
  assert.ok(r.json.errors.some((e) => /older Fable/.test(e)), r.json.errors.join('|'));
  assert.deepEqual(itemCauses(w), ['model-proof', 'model-proof'], 'the floor was not the only failure');
});

test('arbiter apply: an unparseable claude-fable-* id fails closed; an unreadable registry fails closed and names the file and the reset', (t) => {
  const w = world(t).prepare();
  const odd = apply(w, ['--projects-dir', w.installLoose({ models: ['claude-fable-x'] })], { PIPELINE_TEST_MODE: '1' });
  assertExit(odd, 1, odd.stdout);
  assert.equal(odd.json.error, 'unrecognised-fable');
  assert.ok(odd.json.errors.includes('unrecognised Fable version id claude-fable-x: update the pipeline'), odd.json.errors.join('|'));
  assert.equal(odd.json.restartRequired, undefined, 'not "below the floor": a restart does not help');
  assert.match(odd.json.advice, /^do not run the review again yet: update the pipeline, or the owner runs `pipeline model-floor reset --allow-id /, 'R1-F2: the output carries advice');
  assert.equal(w.state().rounds[0].arbiter.failure.advice, odd.json.advice);

  const w2 = world(t).prepare();
  mkdirSync(w2.floor, { recursive: true });
  writeFileSync(join(w2.floor, 'fable.json'), '{ not json');
  const r = apply(w2, ['--projects-dir', w2.installLoose({ models: [FLOOR] })]);
  assertExit(r, 1, r.stdout);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.error, 'model-floor-unreadable');
  assert.match(r.json.errors.join('|'), /fable\.json.*unreadable.*pipeline model-floor reset/s);
  assert.match(r.json.advice, /^the owner runs `pipeline model-floor reset` in a plain terminal$/, 'R1-F2: the output carries advice');
  assert.equal(readFileSync(join(w2.floor, 'fable.json'), 'utf8'), '{ not json', 'nothing overwrote the corrupt registry');
});

test('arbiter apply: a test-mode run whose transcript has no Fable at all skips the floor (even with an unreadable registry)', (t) => {
  const w = world(t).prepare();
  mkdirSync(w.floor, { recursive: true });
  writeFileSync(join(w.floor, 'fable.json'), '{ not json');
  const r = apply(w, ['--projects-dir', w.installLoose({ models: ['claude-opus-5-5'] }), '--expect-model', 'claude-opus-'], { PIPELINE_TEST_MODE: '1' });
  assertExit(r, 0, r.stdout);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.restartRequired, undefined);
});

// ---- equal and newer -----------------------------------------------------------------------------------------------------------------

test('arbiter apply: a Fable equal to the floor proves and publishes, and writes nothing', (t) => {
  const w = world(t).prepare();
  const r = apply(w, [], w.installOwn({ models: [FLOOR] }));
  assertExit(r, 0, r.stdout);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.restartRequired, undefined);
  assert.deepEqual(r.json.errors, []);
  assert.equal(w.state().rounds[0].arbiter.proofOk, true);
  assert.equal(registryExists(w), false);
});

test('arbiter apply: a newer Fable from the account\'s own projects folder proves and raises the floor, recording the build and the transcript', (t) => {
  const w = world(t).prepare();
  const r = apply(w, [], w.installOwn({ models: [NEWER], version: '2.1.321' }));
  assertExit(r, 0, r.stdout);
  assert.equal(r.json.ok, true);
  const reg = w.registry();
  assert.equal(reg.floor, NEWER);
  assert.equal(reg.registry.newest, NEWER);
  assert.equal(reg.registry.claudeCode, '2.1.321');
  assert.equal(reg.registry.transcript, r.json.transcript);
  assert.equal(w.state().rounds[0].arbiter.proofOk, true);
  // the raised floor now refuses the previous Fable
  const w2 = world(t);
  w2.floor = w.floor;
  w2.prepare();
  const old = apply(w2, ['--projects-dir', w2.installLoose({ models: [FLOOR] })]);
  assertExit(old, 1, old.stdout);
  assert.equal(old.json.error, 'stale-model');
  assert.deepEqual(old.json.floor, { newest: NEWER, seen: [FLOOR] });
});

test('arbiter apply: a newer Fable never raises the floor with --projects-dir, nor from a transcript outside the account\'s projects folder', (t) => {
  const w = world(t).prepare();
  const viaDir = apply(w, ['--projects-dir', w.installLoose({ models: [NEWER] })]);
  assertExit(viaDir, 0, viaDir.stdout);
  assert.equal(registryExists(w), false, '--projects-dir');

  const w2 = world(t).prepare();
  // found without --projects-dir (under $HOME), but the account's projects folder is somewhere else
  const own = w2.installOwn({ models: [NEWER] });
  mkdirSync(join(w2.scratch, 'elsewhere'), { recursive: true });
  const outside = apply(w2, [], { ...own, PIPELINE_ACCOUNT_PROJECTS_DIR: join(w2.scratch, 'elsewhere') });
  assertExit(outside, 0, outside.stdout);
  assert.equal(registryExists(w2), false, 'outside the account projects root');

});

test('arbiter apply: a failed proof never raises the floor', (t) => {
  const w = world(t).prepare();
  const r = apply(w, [], w.installOwn({ models: [NEWER], effort: 'low' }));
  assertExit(r, 1, r.stdout);
  assert.equal(r.json.ok, false);
  assert.equal(registryExists(w), false);
  // nor does a pass whose answer does not rule on every item
  const w2 = world(t).prepare();
  const bad = apply(w2, [], w2.installOwn({ models: [NEWER], text: fenced({ rulings: [RULINGS.rulings[0]] }) }));
  assertExit(bad, 1, bad.stdout);
  assert.equal(registryExists(w2), false);
});

test('arbiter apply: a registry write failure fails the proof (model-floor-unwritable) and nothing is published or saved', (t) => {
  const w = world(t).prepare();
  const own = w.installOwn({ models: [NEWER] });
  const before = w.stateText();
  const r = apply(w, [], { ...own, NODE_OPTIONS: `--import ${pathToFileURL(join(here, 'fixtures', 'fail-floor-write-preload.mjs')).href}` });
  assertExit(r, 1, r.stdout + r.stderr);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.error, 'model-floor-unwritable');
  assert.match(r.json.message, /cannot write the model floor registry/);
  assert.match(r.json.advice, /^the owner runs `pipeline model-floor reset` in a plain terminal$/, 'R1-F2: the output carries advice');
  assert.equal(r.json.advice, w.state().rounds[0].arbiter.failure.advice);
  assert.deepEqual(minusFailure(w.state()), JSON.parse(before), 'nothing was saved but the failure record');
  assert.equal(w.state().rounds[0].arbiter.failure.cause, 'model-floor-unwritable');
  assert.equal(existsSync(join(w.repo.dir, '.review', 'round-1', 'rulings.json')), false);
  assert.equal(existsSync(join(w.repo.dir, '.review', 'round-1', 'model-proof.json')), false);
  assert.equal(registryExists(w), false);
  // the retry (a disk with room again) proves and publishes
  const again = apply(w, [], own);
  assertExit(again, 0, again.stdout);
  assert.equal(w.registry().floor, NEWER);
});

test('arbiter apply: a floor lock held by another process is a named error (model-floor-busy, exit 1) and nothing is published', async (t) => {
  const w = world(t).prepare();
  const own = w.installOwn({ models: [FLOOR] });
  const before = w.stateText();
  const r = await withFloorLock({ dir: w.floor }, async () => {
    const run = w.spawnCli(['arbiter', 'apply', '--round', '1'], { ...own, PIPELINE_TEST_MODE: '1', PIPELINE_TEST_FLOOR_WAIT_MS: '400' });
    return run.done;
  });
  assertExit(r, 1, r.stdout + r.stderr);
  assert.equal(r.json.error, 'model-floor-busy');
  assert.match(r.json.message, /another review is updating the model floor/);
  assert.match(r.json.advice, /^another review holds the machine-wide floor lock: run `arbiter apply` again in a minute/, 'R1-F2: the output carries advice');
  assert.equal(r.json.advice, w.state().rounds[0].arbiter.failure.advice);
  assert.equal(r.json.advice, 'another review holds the machine-wide floor lock: run `arbiter apply` again in a minute; if it persists, the owner runs `pipeline model-floor reset --clear-lock --keep-floor` in a plain terminal (it keeps the learned floor; a bare `--clear-lock` resets it to the shipped minimum)', 'R4-F1: the saved advice carries the keep-the-floor command');
  assert.deepEqual(minusFailure(w.state()), JSON.parse(before), 'nothing was saved but the failure record');
  assert.equal(w.state().rounds[0].arbiter.failure.cause, 'model-floor-busy');
  const retry = apply(w, [], own);
  assertExit(retry, 0, retry.stdout);
});

// ---- the owner's exact-id allowance (review round 1: R1-F1) ----------------------------------------------------------------------------

test('arbiter apply: an unparseable claude-fable-* id is refused, then proves once the owner allows that exact id (never raising the floor); --clear-allow refuses it again', async (t) => {
  const NEW_ID = 'claude-fable-6-preview';
  const w = world(t).prepare();
  const projects = w.installLoose({ models: [NEW_ID] });
  const refused = apply(w, ['--projects-dir', projects], { PIPELINE_TEST_MODE: '1' });
  assertExit(refused, 1, refused.stdout);
  assert.equal(refused.json.error, 'unrecognised-fable');
  await resetFloor({ dir: w.floor, hold: OLD }); // a hold alone does not help
  assert.equal(apply(w, ['--projects-dir', projects], { PIPELINE_TEST_MODE: '1' }).json.error, 'unrecognised-fable');
  await resetFloor({ dir: w.floor, allowId: [NEW_ID] });
  const own = w.installOwn({ models: [NEW_ID] });
  const proven = apply(w, [], own);
  assertExit(proven, 0, proven.stdout + proven.stderr);
  assert.equal(w.state().rounds[0].arbiter.proofOk, true);
  assert.equal(w.registry().floor, OLD, 'an unreadable allowed id, even from the account\'s own folder, never raises the floor');
  assert.deepEqual(w.registry().registry.allow, [NEW_ID]);
  await resetFloor({ dir: w.floor, clearAllow: true });
  const again = apply(w, ['--projects-dir', projects], { PIPELINE_TEST_MODE: '1' });
  assertExit(again, 1, again.stdout);
  assert.equal(again.json.error, 'unrecognised-fable');
});

test('R3-F2: a readable allowed id is judged by its version and raises the floor like any other id (an allowance never blocks the learning)', async (t) => {
  const w = world(t).prepare();
  await resetFloor({ dir: w.floor, allowId: [NEWER] });
  const proven = apply(w, [], w.installOwn({ models: [NEWER] }));
  assertExit(proven, 0, proven.stdout + proven.stderr);
  assert.equal(w.registry().floor, NEWER, 'the readable allowed id raised the floor');
  assert.deepEqual(w.registry().registry.allow, [NEWER], 'the allowance itself is left for the owner to clear');
});

// ---- retry and advice ----------------------------------------------------------------------------------------------------------------

test('arbiter needed clears a stale-model refusal so the arbiter answers again; the retry with a current Fable proves', (t) => {
  const w = world(t).prepare();
  const stale = apply(w, ['--projects-dir', w.installLoose({ models: [OLD] })]);
  assertExit(stale, 1, stale.stdout);
  assert.deepEqual(itemCauses(w), ['stale-model', 'stale-model']);
  const again = w.cli(['arbiter', 'needed', '--round', '1']);
  assertExit(again, 0, again.stdout);
  assert.equal(again.json.needed, true);
  assert.deepEqual(again.json.items, ['R1-S1', 'R1-S2'], 'the stale-model finals were cleared like model-proof ones');
  assert.equal(w.item('R1-S1').final, undefined);
  w.needed = again.json;
  const ok = apply(w, ['--projects-dir', w.installLoose({ models: [FLOOR], agentId: 'a2' })]);
  assertExit(ok, 0, ok.stdout);
  assert.deepEqual(ok.json.items.map((i) => [i.id, i.needsHuman]), [['R1-S1', false], ['R1-S2', false]]);
});

test('arbiter apply: the advice is stateless - restart when the transcript\'s build is older than the installed one, else update', (t) => {
  const w = world(t).prepare();
  const pkg = join(w.scratch, 'claude-pkg');
  mkdirSync(join(pkg, 'bin'), { recursive: true });
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ version: '2.1.330' }));
  const exec = join(pkg, 'bin', 'claude.exe');

  const old = apply(w, ['--projects-dir', w.installLoose({ models: [OLD], version: '2.1.318' })], { CLAUDE_CODE_EXECPATH: exec, AI_AGENT: 'claude-code_2-1-318_agent' });
  assert.match(old.json.advice, /^restart this terminal \(it runs Claude Code 2\.1\.318, the installed build is 2\.1\.330\)/);

  const w2 = world(t).prepare();
  const same = apply(w2, ['--projects-dir', w2.installLoose({ models: [OLD], version: '2.1.330' })], { CLAUDE_CODE_EXECPATH: exec });
  assert.match(same.json.advice, /^update Claude Code, or the owner runs `pipeline model-floor reset`/);

  const w3 = world(t).prepare();
  const unknown = apply(w3, ['--projects-dir', w3.installLoose({ models: [OLD] })], { CLAUDE_CODE_EXECPATH: exec });
  assert.match(unknown.json.advice, /^update Claude Code/, 'a transcript with no build recorded is not "older"');
});

// ---- model-proof is read-only --------------------------------------------------------------------------------------------------------

test('model-proof: an older Fable is refused with the same fields; a newer one passes and never raises the floor', (t) => {
  const w = world(t).prepare();
  const oldProjects = w.installLoose({ models: [OLD], version: '2.1.318' });
  const stale = w.cli(['model-proof', '--tag', w.needed.tag, '--projects-dir', oldProjects]);
  assertExit(stale, 1, stale.stdout);
  assert.equal(stale.json.ok, false);
  assert.equal(stale.json.error, 'stale-model');
  assert.equal(stale.json.restartRequired, true);
  assert.deepEqual(stale.json.floor, { newest: FLOOR, seen: [OLD] });
  assert.ok(stale.json.advice);
  assert.deepEqual(stale.json.claudeCodeVersions, ['2.1.318']);
  assert.match(stale.json.errors.join('|'), /older Fable claude-fable-5-1/);

  // an exact --expect-model does not hide it
  const exact = w.cli(['model-proof', '--tag', w.needed.tag, '--projects-dir', oldProjects, '--expect-model', OLD]);
  assertExit(exact, 1, exact.stdout);
  assert.equal(exact.json.error, 'stale-model');

  const w2 = world(t).prepare();
  const own = w2.installOwn({ models: [NEWER] });
  const fresh = w2.cli(['model-proof', '--tag', w2.needed.tag], own);
  assertExit(fresh, 0, fresh.stdout);
  assert.equal(fresh.json.ok, true);
  assert.equal(registryExists(w2), false, 'model-proof is read-only against the floor, even for an eligible transcript');
});

// ---- two processes, two HOME values, one lock and one registry -----------------------------------------------------------------------

const until = async (cond, ms, what) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
};

test('interleaving: a 5.3 proof in another process (another HOME) cannot raise the floor between a 5.2 proof\'s floor compare and its publish', async (t) => {
  const a = world(t).prepare();
  const b = world(t).prepare();
  b.floor = a.floor; // two accounts\' HOMEs, one registry and one lock
  const pause = join(a.scratch, 'pause');
  const ownA = a.installOwn({ models: [FLOOR] });
  const ownB = b.installOwn({ models: [NEWER] });
  assert.notEqual(ownA.HOME, ownB.HOME);

  const runA = a.spawnCli(['arbiter', 'apply', '--round', '1'], { ...ownA, PIPELINE_TEST_MODE: '1', PIPELINE_TEST_FLOOR_PAUSE: pause });
  await until(() => existsSync(`${pause}.reached`), 20_000, 'process A to reach the pause');
  assert.equal(a.registry().floor, FLOOR);

  const runB = b.spawnCli(['arbiter', 'apply', '--round', '1'], ownB);
  // B has everything it needs and takes well under this to finish when nothing holds it back.
  await Promise.race([runB.done, new Promise((r) => setTimeout(r, 3000))]);
  assert.equal(runB.exited(), false, 'B waits for A\'s floor lock');
  assert.equal(a.registry().floor, FLOOR, 'the floor does not move while A sits between its compare and its publish');

  writeFileSync(`${pause}.go`, '');
  const [resA, resB] = await Promise.all([runA.done, runB.done]);
  assertExit(resA, 0, resA.stdout + resA.stderr);
  assertExit(resB, 0, resB.stdout + resB.stderr);
  assert.deepEqual(a.state().rounds[0].modelProof.models, { [FLOOR]: 1 });
  assert.deepEqual(b.state().rounds[0].modelProof.models, { [NEWER]: 1 });
  assert.equal(a.registry().floor, NEWER, 'then B raised it');
  assert.ok(statSync(join(a.repo.dir, '.review', 'state.json')).mtimeMs <= statSync(join(a.floor, 'fable.json')).mtimeMs, 'A published before B raised');
});

// ---- review round 1: R1-B2 (a lock removed from under a running apply fences its publish) -------------------------------------------------

// A pauses after its compare (the seam); the floor moves while it waits; when it resumes it must save nothing: no proofOk, no ok model-proof.json.
const pausedApply = async (t) => {
  const a = world(t).prepare();
  const pause = join(a.scratch, 'pause');
  const ownA = a.installOwn({ models: [FLOOR] });
  const before = a.state();
  const runA = a.spawnCli(['arbiter', 'apply', '--round', '1'], { ...ownA, PIPELINE_TEST_MODE: '1', PIPELINE_TEST_FLOOR_PAUSE: pause });
  await until(() => existsSync(`${pause}.reached`), 20_000, 'process A to reach the pause');
  return { a, before, runA, go: () => writeFileSync(`${pause}.go`, '') };
};
const assertNothingSaved = (a, before, cause) => {
  const round = a.state().rounds[0];
  assert.equal(Object.hasOwn(round.arbiter, 'proofOk'), false, 'no proofOk was persisted');
  assert.equal(round.arbiter.failure.cause, cause);
  assert.equal(round.modelProof, undefined);
  assert.deepEqual(minusFailure(a.state()), before, 'nothing was saved but the failure record');
  let proof = null;
  try { proof = proofFile(a); } catch { /* never written: also fine */ }
  assert.notEqual(proof?.ok, true, 'the proof file does not say ok');
  assert.equal(existsSync(join(a.repo.dir, '.review', 'round-1', 'rulings.json')), false, 'no rulings were published');
};

test('R1-B2: a floor lock removed from under a paused apply, then a 5.3 proof by another process: the 5.2 apply fails model-floor-busy and saves nothing', async (t) => {
  const { a, before, runA, go } = await pausedApply(t);
  const b = world(t).prepare();
  b.floor = a.floor; // two accounts' HOMEs, one registry and one lock
  rmSync(join(a.floor, 'model-floor.lock'), { recursive: true, force: true }); // an older pipeline, or a manual rm
  const resB = b.cli(['arbiter', 'apply', '--round', '1'], b.installOwn({ models: [NEWER] }));
  assertExit(resB, 0, resB.stdout + resB.stderr);
  assert.equal(a.registry().floor, NEWER, 'B raised the floor while A sat between its compare and its publish');

  go();
  const resA = await runA.done;
  assertExit(resA, 1, resA.stdout + resA.stderr);
  assert.equal(resA.json.error, 'model-floor-busy');
  assert.match(resA.json.advice, /^another review holds the machine-wide floor lock/);
  assertNothingSaved(a, before, 'model-floor-busy');
  assert.equal(a.registry().floor, NEWER, 'A raised nothing');
});

test('R1-B2: the floor moved above the proof while the lock is still held (a registry written by hand): the apply fails stale-model after re-reading it and saves nothing', async (t) => {
  const { a, before, runA, go } = await pausedApply(t);
  raiseFloor({ dir: a.floor, model: NEWER });
  go();
  const resA = await runA.done;
  assertExit(resA, 1, resA.stdout + resA.stderr);
  assert.equal(resA.json.error, 'stale-model');
  assert.equal(resA.json.restartRequired, true);
  assert.deepEqual(resA.json.floor, { newest: NEWER, seen: [FLOOR] });
  assert.ok(resA.json.advice);
  assertNothingSaved(a, before, 'stale-model');
  assert.equal(existsSync(join(a.floor, 'model-floor.lock')), false, 'the lock was released');
});

// ---- review round 2: R2-F2 (a standing bypass is visible; an allowance never admits an id the parser reads below the floor) --------------

const proofFile = (w) => JSON.parse(readFileSync(join(w.repo.dir, '.review', 'round-1', 'model-proof.json'), 'utf8'));

test('R2-F2 (a): arbiter apply, model-proof.json and the stored modelProof name the ids that passed only through the allowance; a plain pass carries none of it', async (t) => {
  const NEW_ID = 'claude-fable-6-preview';
  const plain = world(t).prepare();
  const ok = apply(plain, ['--projects-dir', plain.installLoose({ models: [FLOOR] })]);
  assertExit(ok, 0, ok.stdout);
  assert.equal(Object.hasOwn(ok.json, 'floor'), false, 'a plain proof adds no floor field');
  assert.equal(Object.hasOwn(proofFile(plain), 'allowed') || Object.hasOwn(proofFile(plain), 'heldBelowMin'), false);
  assert.deepEqual(Object.keys(plain.state().rounds[0].modelProof ?? {}).filter((k) => k === 'allowed' || k === 'heldBelowMin'), []);

  const w = world(t).prepare();
  await resetFloor({ dir: w.floor, allowId: [NEW_ID] });
  const r = apply(w, ['--projects-dir', w.installLoose({ models: [NEW_ID] })], { PIPELINE_TEST_MODE: '1' });
  assertExit(r, 0, r.stdout);
  assert.deepEqual(r.json.floor, { newest: FLOOR, allowed: [NEW_ID], heldBelowMin: null });
  assert.deepEqual(proofFile(w).allowed, [NEW_ID]);
  assert.equal(Object.hasOwn(proofFile(w), 'heldBelowMin'), false, 'absent when null');
  assert.deepEqual(w.state().rounds[0].modelProof.allowed, [NEW_ID]);
  assert.equal(w.state().rounds[0].arbiter.proofOk, true);
});

test('R2-F2 (a): a hold below MIN_FABLE that let the proof pass is named as heldBelowMin (apply and model-proof)', async (t) => {
  const w = world(t).prepare();
  await resetFloor({ dir: w.floor, hold: OLD });
  const mp = w.cli(['model-proof', '--tag', w.needed.tag, '--projects-dir', w.installLoose({ models: [OLD] })]);
  assertExit(mp, 0, mp.stdout);
  assert.deepEqual(mp.json.floor, { newest: OLD, allowed: [], heldBelowMin: OLD });
  const r = apply(w, ['--projects-dir', w.installLoose({ models: [OLD], agentId: 'a2' })]);
  assertExit(r, 0, r.stdout);
  assert.deepEqual(r.json.floor, { newest: OLD, allowed: [], heldBelowMin: OLD });
  assert.equal(Object.hasOwn(proofFile(w), 'allowed'), false, 'no allowance involved: the field is absent');
  assert.equal(proofFile(w).heldBelowMin, OLD);
  assert.equal(w.state().rounds[0].modelProof.heldBelowMin, OLD);
  assert.equal(Object.hasOwn(w.state().rounds[0].modelProof, 'allowed'), false);
});

test('R2-F2 (a): model-proof prints the allowance too; an allowed id the parser reads below the floor is refused (R2-F2 d)', async (t) => {
  const NEW_ID = 'claude-fable-6-preview';
  const w = world(t).prepare();
  await resetFloor({ dir: w.floor, allowId: [NEW_ID, OLD] });
  const mp = w.cli(['model-proof', '--tag', w.needed.tag, '--projects-dir', w.installLoose({ models: [NEW_ID] })]);
  assertExit(mp, 0, mp.stdout);
  assert.deepEqual(mp.json.floor, { newest: FLOOR, allowed: [NEW_ID], heldBelowMin: null });
  // the forgotten allowance of 5.1, which the floor (5.2) has passed
  const stale = apply(w, ['--projects-dir', w.installLoose({ models: [OLD], agentId: 'a2' })]);
  assertExit(stale, 1, stale.stdout);
  assert.equal(stale.json.error, 'stale-model');
  assert.deepEqual(stale.json.floor, { newest: FLOOR, seen: [OLD] });
  assert.equal(w.cli(['model-proof', '--tag', w.needed.tag, '--projects-dir', w.installLoose({ models: [OLD], agentId: 'a3' })]).json.error, 'stale-model');
});
