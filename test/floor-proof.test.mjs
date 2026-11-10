// In-process tests for the Fable floor as the proof applies it (lib/floor-proof.mjs): the judgement, the advice, who may raise the floor, the
// installed copy (which ignores every test seam, so its enforcement is proven here with an injected home), and the suite-level registry check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fableModelsOf, floorAdvice, floorOutput, floorPauseSeam, judgeFloor, mayRaiseFloor } from '../pipeline/lib/floor-proof.mjs';
import { raiseFloor, readFloor, resetFloor } from '../pipeline/lib/model-floor.mjs';
import { proveModel } from '../pipeline/lib/transcript.mjs';
import { realRegistryFile, registryChange, snapshotRegistry } from '../scripts/lib/registry-snapshot.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
process.env.PIPELINE_MACHINE_ID ||= 'test-machine-id';
const MANIFEST = 'INSTALLED.json';
const tmp = (t) => {
  const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cp-fp-')));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};
const installedCopy = (dir) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, MANIFEST), '{}');
  return dir;
};
const OLD = 'claude-fable-5-1';
const FLOOR = 'claude-fable-5-2';
const NEWER = 'claude-fable-5-3';
const NO_ENV = {};

test('proveModel reports the distinct Claude Code builds seen on transcript lines (additive)', () => {
  const read = (n) => fs.readFileSync(path.join(here, 'fixtures', 'transcripts', n), 'utf8');
  const prove = (name, jsonl = read(`${name}.jsonl`)) => proveModel({ jsonlText: jsonl, metaText: read(`${name}.meta.json`), expectModelPrefix: 'claude-fable-', expectEffort: 'high' });
  assert.deepEqual(prove('fable-stale').claudeCodeVersions, ['2.1.318']);
  assert.deepEqual(prove('fable-stale').models, { [OLD]: 2 }, 'the intentional stale fixture stays on 5.1');
  assert.deepEqual(prove('fable-ok').claudeCodeVersions, [], 'none recorded');
  const two = ['2.1.318', '2.1.321', '2.1.318'].map((version, i) => JSON.stringify({ type: 'user', version, message: { role: 'user', content: `p${i}` } })).join('\n');
  assert.deepEqual(prove('fable-ok', two).claudeCodeVersions, ['2.1.318', '2.1.321']);
});

test('judgeFloor: no Fable means the floor does not apply; older, equal, newer, unparseable and unreadable are judged', (t) => {
  const dir = path.join(tmp(t), 'model-floor');
  const judge = (models, extra = {}) => judgeFloor({ models, env: NO_ENV, floorOpts: { dir }, ...extra });
  assert.deepEqual(judge({ 'claude-opus-5-5': 3 }), { applies: false });
  assert.deepEqual(fableModelsOf({ [FLOOR]: 1, 'claude-opus-5-5': 1, '<synthetic>': 1 }), [FLOOR]);

  const stale = judge({ [OLD]: 1, [FLOOR]: 2 }, { claudeCodeVersions: ['2.1.318'] });
  assert.equal(stale.ok, false);
  assert.equal(stale.error, 'stale-model');
  assert.equal(stale.restartRequired, true);
  assert.deepEqual(stale.older, [OLD]);
  assert.deepEqual(floorOutput(stale), { error: 'stale-model', restartRequired: true, floor: { newest: FLOOR, seen: [OLD, FLOOR] }, advice: stale.advice });
  assert.equal(judge({ [FLOOR]: 1 }).ok, true);
  assert.equal(judge({ [NEWER]: 1 }).ok, true);
  assert.deepEqual(floorOutput(judge({ [FLOOR]: 1 })), {});

  const odd = judge({ 'claude-fable-x': 1 });
  assert.equal(odd.ok, false);
  assert.equal(odd.error, 'unrecognised-fable');
  assert.equal(odd.restartRequired, false);
  assert.deepEqual(odd.errors, ['unrecognised Fable version id claude-fable-x: update the pipeline']);

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'fable.json'), 'garbage');
  const bad = judge({ [FLOOR]: 1 });
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'model-floor-unreadable');
  assert.match(bad.errors[0], /fable\.json.*pipeline model-floor reset/);
});

test('floorAdvice: restart when the transcript\'s build is older than the installed one, otherwise update or ask the owner', (t) => {
  const pkg = tmp(t);
  fs.mkdirSync(path.join(pkg, 'bin'));
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ version: '2.1.330' }));
  const env = { CLAUDE_CODE_EXECPATH: path.join(pkg, 'bin', 'claude.exe') };
  assert.match(floorAdvice({ claudeCodeVersions: ['2.1.318'], env }), /^restart this terminal/);
  assert.match(floorAdvice({ claudeCodeVersions: ['2.1.318', '2.1.330'], env }), /^update Claude Code, or the owner runs `pipeline model-floor reset`/, 'the newest build seen counts');
  assert.match(floorAdvice({ claudeCodeVersions: ['2.1.330'], env }), /^update Claude Code/);
  assert.match(floorAdvice({ claudeCodeVersions: [], env }), /^update Claude Code/, 'no build recorded: not "older"');
  assert.match(floorAdvice({ claudeCodeVersions: ['2.1.318'], env: NO_ENV }), /^update Claude Code/, 'no installed build known');
});

test('mayRaiseFloor: only the installed copy at <home>/.claude/pipeline, or a checkout with the floor folder redirected; never with --projects-dir or outside the projects root', (t) => {
  const home = tmp(t);
  const projects = path.join(home, '.claude', 'projects');
  const own = path.join(projects, '-w', 's', 'subagents', 'agent-a.jsonl');
  const outside = path.join(tmp(t), 'agent-a.jsonl');
  for (const f of [own, outside]) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, '{}\n'); }
  const checkout = tmp(t); // no manifest: a repo checkout
  const installed = installedCopy(path.join(home, '.claude', 'pipeline'));
  const stray = installedCopy(path.join(tmp(t), 'pipeline')); // an installed copy somewhere else
  const seam = { PIPELINE_MODEL_FLOOR_DIR: path.join(home, 'scratch-floor'), PIPELINE_ACCOUNT_PROJECTS_DIR: projects };
  const may = (o) => mayRaiseFloor({ transcript: own, projectsDirGiven: false, env: NO_ENV, home, root: installed, ...o });

  assert.equal(may({}).ok, true, 'the installed copy, a transcript under the account projects folder');
  assert.equal(may({ projectsDirGiven: true }).ok, false, '--projects-dir');
  assert.equal(may({ transcript: outside }).ok, false, 'outside the projects root');
  assert.equal(may({ root: stray }).ok, false, 'an installed copy that is not <home>/.claude/pipeline');
  assert.equal(may({ env: { PIPELINE_ACCOUNT_PROJECTS_DIR: path.dirname(outside) }, transcript: outside }).ok, false, 'an installed copy ignores the projects seam');

  assert.equal(may({ root: checkout }).ok, false, 'a checkout without the floor seam');
  assert.equal(may({ root: checkout, env: seam }).ok, true, 'a checkout with the floor folder redirected');
  assert.equal(may({ root: checkout, env: seam, projectsDirGiven: true }).ok, false);
  assert.equal(may({ root: checkout, env: seam, transcript: outside }).ok, false);

  // a symlink under the projects root that leads outside it is outside (realpath compare)
  fs.symlinkSync(path.dirname(outside), path.join(projects, 'link'));
  assert.equal(may({ transcript: path.join(projects, 'link', 'agent-a.jsonl') }).ok, false, 'symlink');
  assert.equal(may({ transcript: path.join(projects, 'missing.jsonl') }).ok, false, 'a transcript that does not exist');
});

test('an installed copy ignores the floor-folder override and every test seam: its floor enforcement is proven here with an injected home', async (t) => {
  const home = tmp(t);
  const installed = installedCopy(path.join(home, '.claude', 'pipeline'));
  const scratch = path.join(tmp(t), 'model-floor');
  raiseFloor({ dir: scratch, model: 'claude-fable-9-9' }); // a scratch registry that would refuse everything below 9.9
  const warnings = [];
  const j = judgeFloor({
    models: { [FLOOR]: 1 }, env: { PIPELINE_MODEL_FLOOR_DIR: scratch }, floorOpts: { home, root: installed, warn: (m) => warnings.push(m) },
  });
  assert.equal(j.ok, true, 'the override was ignored: the floor is the code constant in the injected home');
  assert.equal(j.floor, FLOOR);
  assert.match(warnings.join(''), /ignoring PIPELINE_MODEL_FLOOR_DIR/);
  // and the installed copy enforces the same floor: an older Fable is refused there
  assert.equal(judgeFloor({ models: { [OLD]: 1 }, env: NO_ENV, floorOpts: { home, root: installed } }).error, 'stale-model');
  // the pause seam is a no-op there, even with test mode and the pause variable set
  const paused = await floorPauseSeam({ PIPELINE_TEST_MODE: '1', PIPELINE_TEST_FLOOR_PAUSE: path.join(home, 'p') }, { root: installed, maxMs: 50 });
  assert.equal(paused, false);
  assert.equal(fs.existsSync(path.join(home, 'p.reached')), false);
});

test('floorPauseSeam: a checkout in test mode writes <base>.reached and waits for <base>.go; without test mode it does nothing', async (t) => {
  const base = path.join(tmp(t), 'pause');
  const checkout = tmp(t);
  assert.equal(await floorPauseSeam({ PIPELINE_TEST_FLOOR_PAUSE: base }, { root: checkout, maxMs: 50 }), false, 'no test mode');
  const waiting = floorPauseSeam({ PIPELINE_TEST_MODE: '1', PIPELINE_TEST_FLOOR_PAUSE: base }, { root: checkout, maxMs: 5000, pollMs: 5 });
  while (!fs.existsSync(`${base}.reached`)) await new Promise((r) => setTimeout(r, 5));
  fs.writeFileSync(`${base}.go`, '');
  assert.equal(await waiting, true);
});

test('no test that runs an installed copy of the CLI presents a Fable transcript that could pass', () => {
  // The installed copy ignores PIPELINE_MODEL_FLOOR_DIR, so such a run would read the account's real registry. The installed-copy tests keep their
  // non-Fable / failing transcripts (the enforcement itself is proven above with an injected home).
  for (const name of fs.readdirSync(here).filter((f) => f.endsWith('.test.mjs') && f !== 'floor-proof.test.mjs')) {
    const text = fs.readFileSync(path.join(here, name), 'utf8');
    for (const block of text.split(/^test\(/m).filter((b) => b.includes(MANIFEST) && b.includes('TEST_BIN'))) {
      assert.doesNotMatch(block, /claude-fable-\d/, `${name}: an installed-copy test mentions a Fable model id`);
    }
  }
});

test('the suite-level registry check: absent stays absent; a created, removed or modified registry is reported', (t) => {
  const file = path.join(tmp(t), 'fable.json');
  const absent = snapshotRegistry(file);
  assert.equal(registryChange(absent, snapshotRegistry(file), file), null);
  fs.writeFileSync(file, '{"a":1}');
  const present = snapshotRegistry(file);
  assert.match(registryChange(absent, present, file), /was created/);
  assert.equal(registryChange(present, snapshotRegistry(file), file), null);
  fs.writeFileSync(file, '{"a":2}');
  assert.match(registryChange(present, snapshotRegistry(file), file), /was modified/);
  fs.rmSync(file);
  assert.match(registryChange(present, snapshotRegistry(file), file), /was removed/);
  assert.equal(realRegistryFile('/home/x'), path.join('/home/x', '.claude', 'pipeline-state', 'owner-go', 'model-floor', 'fable.json'));
});

// ---- review round 1: R1-F1 (the owner's exact-id allowance) and R1-F2 (every floor failure carries advice) ----
test('judgeFloor: an unparseable claude-fable-* id is refused until the owner allows that exact id; an allowed id never raises or fails the floor', async (t) => {
  const dir = path.join(tmp(t), 'model-floor');
  const judge = (models) => judgeFloor({ models, env: NO_ENV, floorOpts: { dir } });
  const NEW_ID = 'claude-fable-6-preview';
  assert.equal(judge({ [NEW_ID]: 1 }).error, 'unrecognised-fable');
  await resetFloor({ dir, hold: OLD }); // a hold does not admit it
  assert.equal(judge({ [NEW_ID]: 1 }).error, 'unrecognised-fable', '--hold does not unblock an unparseable id');
  await resetFloor({ dir, allowId: [NEW_ID] });
  const ok = judge({ [NEW_ID]: 1, [OLD]: 1 });
  assert.equal(ok.ok, true, 'allowed (and 5.1 is the held floor)');
  assert.deepEqual(ok.allowed, [NEW_ID]);
  assert.equal(judge({ 'claude-fable-6-other': 1 }).error, 'unrecognised-fable', 'only the exact id');
  assert.equal(readFloor({ dir }).floor, OLD, 'the floor stayed where the hold put it');
  await resetFloor({ dir, clearAllow: true });
  assert.equal(judge({ [NEW_ID]: 1 }).error, 'unrecognised-fable', 'cleared: refused again');
});

test('every floor failure carries advice, in judgeFloor and in floorOutput (stale, unrecognised, unreadable)', (t) => {
  const dir = path.join(tmp(t), 'model-floor');
  const judge = (models) => judgeFloor({ models, env: NO_ENV, floorOpts: { dir } });
  const stale = judge({ [OLD]: 1 });
  const odd = judge({ 'claude-fable-x': 1 });
  assert.match(stale.advice, /update Claude Code|restart this terminal/);
  assert.match(odd.advice, /^do not run the review again yet: update the pipeline, or the owner runs `pipeline model-floor reset --allow-id /);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'fable.json'), 'garbage');
  const bad = judge({ [FLOOR]: 1 });
  assert.match(bad.advice, /pipeline model-floor reset/);
  for (const [j, error] of [[stale, 'stale-model'], [odd, 'unrecognised-fable'], [bad, 'model-floor-unreadable']]) {
    const out = floorOutput(j);
    assert.equal(out.error, error);
    assert.equal(typeof out.advice, 'string', error);
    assert.notEqual(out.advice, '', error);
  }
});

// ---- review round 2: R2-F2 (a standing bypass is visible; an allowance never admits an id the parser reads below the floor) ----
test('judgeFloor: allowed lists only the ids that pass solely through the allowance; an allowed id the parser reads below the floor is refused', async (t) => {
  const dir = path.join(tmp(t), 'model-floor');
  const judge = (models) => judgeFloor({ models, env: NO_ENV, floorOpts: { dir } });
  const NEW_ID = 'claude-fable-6-preview';
  await resetFloor({ dir, allowId: [NEW_ID, OLD, NEWER] });
  const unreadable = judge({ [NEW_ID]: 1, [FLOOR]: 1 });
  assert.equal(unreadable.ok, true);
  assert.deepEqual([unreadable.allowed, unreadable.heldBelowMin], [[NEW_ID], null]);
  const atFloor = judge({ [NEWER]: 1, [FLOOR]: 1 });
  assert.equal(atFloor.ok, true, 'at or above the floor passes on its own');
  assert.deepEqual(atFloor.allowed, [], 'it did not need the allowance: it is judged by its own version, which is what lets it raise the floor');
  const below = judge({ [OLD]: 1 });
  assert.equal(below.ok, false, 'the allowance does not cover an id the parser reads below the floor');
  assert.equal(below.error, 'stale-model');
  assert.deepEqual(below.older, [OLD]);
  assert.equal(readFloor({ dir }).floor, FLOOR);
});

test('judgeFloor: heldBelowMin names the hold only when a seen id is below MIN_FABLE and passes through it', async (t) => {
  const dir = path.join(tmp(t), 'model-floor');
  const judge = (models) => judgeFloor({ models, env: NO_ENV, floorOpts: { dir } });
  assert.equal(judge({ [FLOOR]: 1 }).heldBelowMin, null, 'no registry');
  await resetFloor({ dir, hold: OLD });
  assert.equal(judge({ [OLD]: 1 }).ok, true);
  assert.equal(judge({ [OLD]: 1 }).heldBelowMin, OLD);
  assert.equal(judge({ [FLOOR]: 1 }).heldBelowMin, null, 'a current Fable needed no hold');
  assert.equal(judge({ 'claude-fable-5': 1 }).heldBelowMin, null, 'a model below the hold is refused, not held');
  assert.equal(judge({ 'claude-fable-5': 1 }).ok, false);
  await resetFloor({ dir, hold: 'claude-fable-5-4' });
  assert.equal(judge({ [FLOOR]: 1 }).heldBelowMin, null, 'a hold at or above MIN_FABLE lowers nothing');
});

test('floorOutput: a passed floor adds floor {newest, allowed, heldBelowMin} only when an allowance or a hold below MIN_FABLE let it pass; nothing otherwise', async (t) => {
  const dir = path.join(tmp(t), 'model-floor');
  const judge = (models) => judgeFloor({ models, env: NO_ENV, floorOpts: { dir } });
  const NEW_ID = 'claude-fable-6-preview';
  assert.deepEqual(floorOutput(judge({ [FLOOR]: 1 })), {}, 'a plain pass says nothing');
  assert.deepEqual(floorOutput({ applies: false }), {});
  await resetFloor({ dir, allowId: [NEW_ID] });
  assert.deepEqual(floorOutput(judge({ [FLOOR]: 1 })), {}, 'an allowance that was not needed says nothing');
  assert.deepEqual(floorOutput(judge({ [NEW_ID]: 1 })), { floor: { newest: FLOOR, allowed: [NEW_ID], heldBelowMin: null } });
  await resetFloor({ dir, hold: OLD });
  assert.deepEqual(floorOutput(judge({ [NEW_ID]: 1, [OLD]: 1 })), { floor: { newest: OLD, allowed: [NEW_ID], heldBelowMin: OLD } });
  await resetFloor({ dir, clearAllow: true });
  assert.deepEqual(floorOutput(judge({ [OLD]: 1 })), { floor: { newest: OLD, allowed: [], heldBelowMin: OLD } });
  // a failed floor keeps its old shape (no allowed / heldBelowMin)
  assert.deepEqual(floorOutput(judge({ 'claude-fable-5': 1 })).floor, { newest: OLD, seen: ['claude-fable-5'] });
});
