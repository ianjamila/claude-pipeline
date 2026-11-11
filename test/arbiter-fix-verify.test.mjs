// Fix rounds get a narrow "verify these fixes" Fable brief at lower effort (plan 2026-11-11, "SIMPLER DESIGN"). Fable still reviews EVERY round of a
// medium/high-risk PR; only the brief (and the effort the proof expects) differs. `arbiter needed` picks the brief and stores it on the round;
// `arbiter apply` proves against the STORED brief. The real CLI runs from the checkout against a throwaway repo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertExit } from './helpers/assert-exit.mjs';
import { createTmpRepo } from './helpers/tmprepo.mjs';
import { SHARED_FLOOR_DIR, floorEnv } from './helpers/floor-env.mjs';
import { createFakeGh, pipelineYml, REPO_VIEW } from './helpers/fakegh-env.mjs';
import { BRIEFS, acceptedEfforts, effortsAtLeast, expectationOf, fixRoundCandidate, previousAccepts } from '../pipeline/lib/fix-verify.mjs';
import { proveModel } from '../pipeline/lib/transcript.mjs';
import { buildAgentLogLine, countArbiterCalls, countFixVerifyCalls } from '../pipeline/lib/agentlog.mjs';
import { agentLogLine } from '../pipeline/lib/render.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const bin = join(here, '..', 'pipeline', 'bin', 'pipeline.mjs');
const fakeCodex = join(here, 'fixtures', 'fake-codex.mjs');

const aFile = (changed) => Array.from({ length: 30 }, (_, i) => (i === 11 && changed ? 'export const v12 = compute(x.y);' : `export const v${i + 1} = ${i + 1};`)).join('\n') + '\n';
const bFile = (changed) => Array.from({ length: 8 }, (_, i) => (i === 2 && changed ? 'export const w3 = normalise(3);' : `export const w${i + 1} = ${i + 1};`)).join('\n') + '\n';
const finding = (over = {}) => ({
  title: 'Rename helper', file: 'src/b.js', line: 3, category: 'maintainability',
  detail: 'w3 says nothing about what it holds', reasoning: 'a vague name', testable: false, ...over,
});
const findingsOf = (suggestions = []) => ({ summary: 'Reviewed.', blocking: [], suggestions, worth_considering: [] });
const fenced = (obj) => `Done.\n\n\`\`\`json\n${JSON.stringify(obj)}\n\`\`\``;
const GH = [
  { match: '^pr view 7', stdoutJson: { title: 'Add compute', body: 'Adds compute() to a.js', headRefName: 'feat/x' } },
  { match: '^repo view', stdoutJson: REPO_VIEW },
];

// Every Fable round here comes from src/a.js being a path the config sends to Fable each round; src/b.js is the "fix" file.
const YML = (extra = '') => `${pipelineYml()}review:\n  arbiter_always_paths: [src/a.js]\n${extra}`;

function world(t, { yml = YML() } = {}) {
  const repo = createTmpRepo();
  t.after(() => repo.cleanup());
  repo.write('.claude/pipeline.yml', yml);
  repo.write('.gitignore', '.review/\n');
  repo.write('src/a.js', aFile(false));
  repo.write('src/b.js', bFile(false));
  const base = repo.commit('init');
  repo.branch('feat/x');
  repo.write('src/a.js', aFile(true));
  repo.write('src/big.js', Array.from({ length: 60 }, (_, i) => `export const big${i} = ${i};`).join('\n') + '\n');
  const head = repo.commit('feature');
  const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), 'cp-fixverify-')));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const withHead = (sha) => GH.map((e) => (e.match === '^pr view 7' ? { ...e, stdoutJson: { baseRefName: 'main', headRefOid: sha, ...e.stdoutJson } } : e));
  const fake = createFakeGh(withHead(head));
  const w = {
    repo, base, head, scratch, headNow: head,
    cli(args, env = {}) {
      const merged = { ...process.env, ...fake.env, PIPELINE_CODEX: `node "${fakeCodex}"`, PIPELINE_LOCK_DIR: join(scratch, 'locks'), ...floorEnv(SHARED_FLOOR_DIR), ...env };
      for (const k of ['PIPELINE_TEST_MODE', 'FAKE_CODEX_OUTPUT', 'AI_AGENT', 'CLAUDE_CODE_EXECPATH']) if (!(k in env)) delete merged[k];
      const r = spawnSync(process.execPath, [bin, ...args], { cwd: repo.dir, env: merged, encoding: 'utf8' });
      let json = null;
      try { json = r.stdout ? JSON.parse(r.stdout) : null; } catch { /* the assertion on json will say so */ }
      return { code: r.status, json, stdout: r.stdout, stderr: r.stderr };
    },
    file(name, content) {
      const p = join(scratch, name);
      writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content));
      return p;
    },
    codex(round, findings, { from, to } = {}) {
      return w.cli(['codex-review', '--pr', '7', '--round', String(round), '--base', from ?? base, '--head', to ?? head, '--effort', 'high'], { FAKE_CODEX_OUTPUT: w.file(`findings-${round}.json`, findings) });
    },
    state: () => JSON.parse(readFileSync(join(repo.dir, '.review', 'state.json'), 'utf8')),
    edit(fn) {
      const s = w.state();
      fn(s);
      writeFileSync(join(repo.dir, '.review', 'state.json'), JSON.stringify(s, null, 2));
    },
    inputText: (n) => readFileSync(join(repo.dir, '.review', `round-${n}`, 'arbiter-input.md'), 'utf8'),
    // A Fable answer to the last `needed` of round n. effort / model / agentType steer what the proof sees.
    apply(n, needed, { effort = 'high', model = 'claude-fable-5-2', agentType = 'arbiter', answer, args = [] } = {}) {
      const root = join(scratch, `projects-${Math.random().toString(36).slice(2, 8)}`);
      const dir = join(root, '-tmp-work', 'session-1', 'subagents');
      mkdirSync(dir, { recursive: true });
      const lines = [
        { type: 'user', isSidechain: true, agentId: 'a1', message: { role: 'user', content: `ROUND: ${n}\nINPUT-DIGEST: ${needed.digest}\nRead the input file.` }, uuid: 'u-1' },
        {
          type: 'assistant', isSidechain: true, agentId: 'a1', requestId: 'req_1', effort, perTurnEffort: effort, uuid: 'a-1',
          message: { model, id: 'msg_1', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: fenced(answer ?? { rulings: [], findings: [] }) }] },
        },
      ];
      writeFileSync(join(dir, 'agent-a1.jsonl'), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
      writeFileSync(join(dir, 'agent-a1.meta.json'), JSON.stringify({ toolUseId: 'toolu_01', spawnDepth: 1, agentType, description: needed.tag }));
      return w.cli(['arbiter', 'apply', '--round', String(n), '--projects-dir', root, ...args]);
    },
    // Round 1 through Codex (one suggestion) and a proven Fable pass whose ruling on it is `ruling`.
    round1(ruling = 'ACCEPT') {
      assertExit(w.codex(1, findingsOf([finding()])), 0);
      const needed = w.cli(['arbiter', 'needed', '--round', '1']);
      assertExit(needed, 0, needed.stdout + needed.stderr);
      const a = w.apply(1, needed.json, { answer: { rulings: [{ id: 'R1-S1', ruling, confidence: 'high', reasoning: 'src/b.js:3 is a vague name' }], findings: [] } });
      assertExit(a, 0, a.stdout);
      return needed.json;
    },
    // A fix commit touching `files` ({ path: content }), then Codex round 2 over it.
    round2(files = { 'src/b.js': bFile(true) }) {
      for (const [p, c] of Object.entries(files)) repo.write(p, c);
      const sha = repo.commit('fix round');
      fake.setScript(withHead(sha));
      w.headNow = sha;
      assertExit(w.codex(2, findingsOf(), { from: head, to: sha }), 0);
      return sha;
    },
    needed(n) { return w.cli(['arbiter', 'needed', '--round', String(n)]); },
  };
  return w;
}

// A world at the moment a fix round starts: round 1 proven with an ACCEPT, the fix committed, Codex round 2 done. `arbiter needed --round 2` is the test's step.
function fixWorld(t, opts = {}) {
  const w = world(t, opts);
  w.round1('ACCEPT');
  w.round2(opts.files);
  return w;
}

// ---- brief selection -------------------------------------------------------------------------------------------------------------------------

test('arbiter needed: round 1 (whole-PR scope) is the full brief: agent arbiter at effort high', (t) => {
  const w = world(t);
  assertExit(w.codex(1, findingsOf([finding()])), 0);
  const r = w.needed(1);
  assertExit(r, 0, r.stdout + r.stderr);
  assert.deepEqual([r.json.mode, r.json.scope, r.json.brief, r.json.effort, r.json.agent], ['review', 'whole-pr', 'full', 'high', 'arbiter']);
  assert.deepEqual([w.state().rounds[0].arbiter.brief, w.state().rounds[0].arbiter.effort, w.state().rounds[0].arbiter.agent], ['full', 'high', 'arbiter']);
  assert.doesNotMatch(w.inputText(1), /FIX-VERIFY/);
});

test('arbiter needed: a round-scoped Fable round after an ACCEPT round is fix-verify: agent arbiter-fix at effort medium, stored on the round', (t) => {
  const w = fixWorld(t);
  const r = w.needed(2);
  assertExit(r, 0, r.stdout + r.stderr);
  assert.deepEqual([r.json.mode, r.json.scope, r.json.brief, r.json.effort, r.json.agent], ['review', 'round', 'fix-verify', 'medium', 'arbiter-fix']);
  const stored = w.state().rounds[1].arbiter;
  assert.deepEqual([stored.brief, stored.effort, stored.agent, stored.mode, stored.scope], ['fix-verify', 'medium', 'arbiter-fix', 'review', 'round']);
  assert.match(r.json.tag, /^pipeline-arbiter R2 [0-9a-f]{8}$/);
});

test('arbiter needed: the fix-verify input lists the previous round\'s ACCEPT items and says what to do; the diff and JSON contract are the review ones', (t) => {
  const w = fixWorld(t);
  const r = w.needed(2);
  assertExit(r, 0, r.stdout + r.stderr);
  const text = w.inputText(2);
  assert.match(text, /^ROUND: 2\nINPUT-DIGEST: [0-9a-f]{64}\n\n# Fable review, round 2/);
  assert.match(text, /Mode: REVIEW/);
  assert.match(text, /Brief: FIX-VERIFY/);
  assert.match(text, /verify each fix is correct and complete/i);
  assert.match(text, /bugs or regressions the round diff introduces/i);
  assert.match(text, /do not re-review code outside the round diff unless a fix depends on it/i);
  assert.match(text, /findings/);
  // the ACCEPT item: id, title, file:line, detail, the ruling's reason
  assert.match(text, /R1-S1/);
  assert.match(text, /Rename helper/);
  assert.match(text, /src\/b\.js:3/);
  assert.match(text, /w3 says nothing about what it holds/);
  assert.match(text, /src\/b\.js:3 is a vague name/);
  assert.match(text, /only what changed in round 2/);
  assert.match(text, /# Items to rule on \(0\)/);
});

test('arbiter needed: the full brief for the same round is the input an older install wrote (no brief section at all)', (t) => {
  const w = fixWorld(t);
  w.edit((s) => { s.rounds[0].items[0].final.decision = 'REJECT'; }); // no ACCEPT in the previous round
  const r = w.needed(2);
  assertExit(r, 0, r.stdout + r.stderr);
  assert.deepEqual([r.json.brief, r.json.effort, r.json.agent], ['full', 'high', 'arbiter']);
  assert.doesNotMatch(w.inputText(2), /FIX-VERIFY|Brief:/);
});

// each of these flips fix-verify -> full
test('arbiter needed: whole-pr scope is the full brief (no earlier proven Fable pass to continue from)', (t) => {
  const w = fixWorld(t);
  w.edit((s) => { s.rounds[0].arbiter.proofOk = false; });
  const r = w.needed(2);
  assertExit(r, 0, r.stdout + r.stderr);
  assert.deepEqual([r.json.scope, r.json.brief, r.json.agent], ['whole-pr', 'full', 'arbiter']);
});

test('arbiter needed: a resolution-only round is the full brief', (t) => {
  const w = fixWorld(t);
  w.edit((s) => { Object.assign(s.rounds[1], { resolutionOnly: true, conflicted: [], conflictedCount: 0, blocks: [] }); });
  const r = w.needed(2);
  assertExit(r, 0, r.stdout + r.stderr);
  assert.deepEqual([r.json.scope, r.json.brief], ['round', 'full']);
});

test('arbiter needed: the previous counted round without an ACCEPT is the full brief (a FOLLOW-UP and a REJECT are not fixes)', (t) => {
  for (const decision of ['REJECT', 'FOLLOW-UP']) {
    const w = world(t);
    w.round1(decision);
    w.round2();
    const r = w.needed(2);
    assertExit(r, 0, r.stdout + r.stderr);
    assert.deepEqual([r.json.scope, r.json.brief, r.json.effort], ['round', 'full', 'high'], decision);
  }
});

test('arbiter needed: a hard-stop hit in the round range is the full brief', (t) => {
  const w = fixWorld(t, { yml: YML('hard_stops:\n  paths: [src/hard.js]\n'), files: { 'src/b.js': bFile(true), 'src/hard.js': 'export const h = 1;\n' } });
  const r = w.needed(2);
  assertExit(r, 0, r.stdout + r.stderr);
  assert.deepEqual([r.json.scope, r.json.brief, r.json.agent], ['round', 'full', 'arbiter']);
});

test('arbiter needed: a file matching review.arbiter_always_paths in the round range is the full brief', (t) => {
  const w = fixWorld(t, { files: { 'src/b.js': bFile(true), 'src/a.js': `${aFile(true)}export const more = 1;\n` } });
  const r = w.needed(2);
  assertExit(r, 0, r.stdout + r.stderr);
  assert.deepEqual([r.json.scope, r.json.brief], ['round', 'full']);
});

test('arbiter needed: a file matching risk.high_risk_paths in the round range is the full brief', (t) => {
  const w = fixWorld(t, { yml: YML(), files: { 'src/b.js': bFile(true) } });
  // the config the repo is at when `needed` runs is the one it reads: make src/b.js (the fix file) a high-risk path now
  writeFileSync(join(w.repo.dir, '.claude', 'pipeline.yml'), `${YML()}risk:\n  high_risk_paths: [src/b.js]\n`);
  const r = w.needed(2);
  assertExit(r, 0, r.stdout + r.stderr);
  assert.deepEqual([r.json.scope, r.json.brief], ['round', 'full']);
});

test('arbiter needed: a config that cannot be read is the full brief (fail closed)', (t) => {
  const w = fixWorld(t);
  writeFileSync(join(w.repo.dir, '.claude', 'pipeline.yml'), 'not: [valid');
  const r = w.needed(2);
  assertExit(r, 0, r.stdout + r.stderr);
  assert.deepEqual([r.json.scope, r.json.brief], ['round', 'full']);
});

// ---- eligibility: what the round was diffed against, the base-side config, size, --full ---------------------------------------------------------

test('arbiter needed: a round-scoped round whose review base is whole-pr (conflicting base merge fallback) is the full brief, with the reason', (t) => {
  const w = fixWorld(t);
  w.edit((s) => { s.rounds[1].reviewBaseKind = 'whole-pr'; });
  const r = w.needed(2);
  assertExit(r, 0, r.stdout + r.stderr);
  assert.deepEqual([r.json.scope, r.json.brief, r.json.agent], ['round', 'full', 'arbiter']);
  assert.match(r.json.briefReason, /review base kind "whole-pr"/);
  assert.match(w.state().rounds[1].arbiter.briefReason, /whole-pr/);
});

test('arbiter needed: a fix round whose base is a synthetic tree (base branch merged in cleanly) is the full brief, and says why', (t) => {
  const w = world(t);
  w.round1('ACCEPT');
  // main moves on (another PR's work), the branch takes it in with a clean merge, then the fix is committed
  w.repo.checkout('main');
  w.repo.write('src/other.js', 'export const other = 1;\n');
  w.repo.commit('other work on main');
  w.repo.checkout('feat/x');
  w.repo.git(['merge', '--no-edit', '-q', 'main']);
  w.round2();
  assert.equal(w.state().rounds[1].reviewBaseKind, 'synthetic');
  const r = w.needed(2);
  assertExit(r, 0, r.stdout + r.stderr);
  assert.deepEqual([r.json.scope, r.json.brief, r.json.effort, r.json.agent], ['round', 'full', 'high', 'arbiter']);
  assert.match(r.json.briefReason, /synthetic review base/);
  assert.equal(w.state().rounds[1].arbiter.briefReason, r.json.briefReason);
});

test('arbiter needed: a sensitive file the BASE side config lists is the full brief even when the working-tree config no longer lists it', (t) => {
  const w = fixWorld(t, { yml: YML('risk:\n  high_risk_paths: [src/b.js]\n'), files: { 'src/b.js': bFile(true) } });
  // clear the list in the working tree after the fact: the config committed at the fork point still has it
  writeFileSync(join(w.repo.dir, '.claude', 'pipeline.yml'), YML());
  const r = w.needed(2);
  assertExit(r, 0, r.stdout + r.stderr);
  assert.deepEqual([r.json.scope, r.json.brief], ['round', 'full']);
  assert.match(r.json.briefReason, /sensitive path .*base config/);
});

test('arbiter needed: a base-side hard-stop rule the working-tree config dropped is the full brief', (t) => {
  const w = fixWorld(t, { yml: YML('hard_stops:\n  paths: [src/hard.js]\n'), files: { 'src/b.js': bFile(true), 'src/hard.js': 'export const h = 1;\n' } });
  writeFileSync(join(w.repo.dir, '.claude', 'pipeline.yml'), YML());
  const r = w.needed(2);
  assertExit(r, 0, r.stdout + r.stderr);
  assert.deepEqual([r.json.scope, r.json.brief], ['round', 'full']);
  assert.match(r.json.briefReason, /hard-stop hit .*base config/);
});

test('arbiter needed: a base side config that cannot be read (no fork point, or one that holds no config) is the full brief, with the reason', (t) => {
  const w = fixWorld(t);
  w.edit((s) => { delete s.rounds[1].forkPoint; });
  let r = w.needed(2);
  assertExit(r, 0, r.stdout + r.stderr);
  assert.deepEqual([r.json.brief, r.json.briefReason], ['full', 'the round records no fork point']);
  w.edit((s) => { s.rounds[1].forkPoint = '0'.repeat(40); });
  r = w.needed(2);
  assertExit(r, 0, r.stdout + r.stderr);
  assert.equal(r.json.brief, 'full');
  assert.match(r.json.briefReason, /fork point/);
});

test('arbiter needed: a fix round that adds many lines in files nobody calls sensitive is the full brief (risk level is not low)', (t) => {
  const big = Array.from({ length: 200 }, (_, i) => `export const extra${i} = ${i};`).join('\n') + '\n';
  const w = fixWorld(t, { files: { 'src/b.js': bFile(true), 'src/extra.js': big } });
  const r = w.needed(2);
  assertExit(r, 0, r.stdout + r.stderr);
  assert.deepEqual([r.json.scope, r.json.brief, r.json.agent], ['round', 'full', 'arbiter']);
  assert.match(r.json.briefReason, /medium risk .*changed lines/);
});

test('arbiter needed: the fix-verify choice prints and stores its reason', (t) => {
  const w = fixWorld(t);
  const r = w.needed(2);
  assertExit(r, 0, r.stdout + r.stderr);
  assert.equal(r.json.brief, 'fix-verify');
  assert.match(r.json.briefReason, /^fix round: round 1 accepted 1 item\(s\)/);
  assert.equal(w.state().rounds[1].arbiter.briefReason, r.json.briefReason);
});

test('arbiter needed --full: forces the full brief (agent arbiter, effort high); the stored brief and the digest change, apply proves it as full', (t) => {
  const w = fixWorld(t);
  const auto = w.needed(2).json;
  assert.equal(auto.brief, 'fix-verify');
  const r = w.cli(['arbiter', 'needed', '--round', '2', '--full']);
  assertExit(r, 0, r.stdout + r.stderr);
  assert.deepEqual([r.json.brief, r.json.effort, r.json.agent, r.json.briefReason], ['full', 'high', 'arbiter', 'forced by --full']);
  assert.notEqual(r.json.digest, auto.digest);
  assert.notEqual(r.json.tag, auto.tag);
  assert.doesNotMatch(w.inputText(2), /FIX-VERIFY|Brief:/);
  const stored = w.state().rounds[1].arbiter;
  assert.deepEqual([stored.brief, stored.effort, stored.agent, stored.inputDigest], ['full', 'high', 'arbiter', r.json.digest]);
  const refused = w.apply(2, r.json, { effort: 'medium', agentType: 'arbiter-fix' });
  assert.notEqual(refused.code, 0);
  const a = w.apply(2, r.json, { effort: 'high', agentType: 'arbiter' });
  assertExit(a, 0, a.stdout);
  assert.equal(w.state().rounds[1].arbiter.proofOk, true);
});

test('arbiter needed --full is sticky: a plain needed afterwards (the retry paths) is still full / high / arbiter, forced by --full, until the round is proven', (t) => {
  const w = fixWorld(t);
  assert.equal(w.needed(2).json.brief, 'fix-verify');
  const forced = w.cli(['arbiter', 'needed', '--round', '2', '--full']);
  assertExit(forced, 0, forced.stdout + forced.stderr);
  assert.equal(w.state().rounds[1].arbiter.forcedFull, true);
  const again = w.needed(2);
  assertExit(again, 0, again.stdout + again.stderr);
  assert.deepEqual([again.json.brief, again.json.effort, again.json.agent, again.json.briefReason], ['full', 'high', 'arbiter', 'forced by --full']);
  assert.equal(again.json.digest, forced.json.digest, 'the same input as the forced one');
  assert.equal(w.state().rounds[1].arbiter.forcedFull, true);
  // an unproven pass (model-proof) and the retry: still full
  const bad = w.apply(2, again.json, { model: 'claude-sonnet-4-6', effort: 'high' });
  assert.notEqual(bad.code, 0);
  const retry = w.needed(2);
  assertExit(retry, 0, retry.stdout + retry.stderr);
  assert.deepEqual([retry.json.brief, retry.json.agent], ['full', 'arbiter']);
  // the proven pass at the forced brief ends it
  const ok = w.apply(2, retry.json, { effort: 'high', agentType: 'arbiter' });
  assertExit(ok, 0, ok.stdout);
  assert.equal(w.state().rounds[1].arbiter.proofOk, true);
});

test('arbiter needed without --full on a fresh fix round stores no forced choice', (t) => {
  const w = fixWorld(t);
  assert.equal(w.needed(2).json.brief, 'fix-verify');
  assert.equal(w.state().rounds[1].arbiter.forcedFull, undefined);
});

// ---- stored, not recomputed ------------------------------------------------------------------------------------------------------------------

test('arbiter needed re-run recomputes and re-stores the brief; the digest and tag change with it', (t) => {
  const w = fixWorld(t);
  const first = w.needed(2).json;
  assert.equal(first.brief, 'fix-verify');
  writeFileSync(join(w.repo.dir, '.claude', 'pipeline.yml'), YML('risk:\n  high_risk_paths: [src/b.js]\n'));
  const second = w.needed(2);
  assertExit(second, 0, second.stdout + second.stderr);
  assert.deepEqual([second.json.brief, second.json.effort, second.json.agent], ['full', 'high', 'arbiter']);
  assert.notEqual(second.json.digest, first.digest);
  assert.notEqual(second.json.tag, first.tag);
  const stored = w.state().rounds[1].arbiter;
  assert.deepEqual([stored.brief, stored.effort, stored.agent, stored.inputDigest], ['full', 'high', 'arbiter', second.json.digest]);
  // and back again
  writeFileSync(join(w.repo.dir, '.claude', 'pipeline.yml'), YML());
  const third = w.needed(2).json;
  assert.deepEqual([third.brief, third.digest, third.tag], ['fix-verify', first.digest, first.tag]);
});

test('arbiter apply proves against the STORED brief, not a recomputed one', (t) => {
  const w = fixWorld(t);
  const needed = w.needed(2).json;
  assert.equal(needed.brief, 'fix-verify');
  // the world changes after `needed` (the round would now be full): apply must not care
  writeFileSync(join(w.repo.dir, '.claude', 'pipeline.yml'), YML('risk:\n  high_risk_paths: [src/b.js]\n'));
  const r = w.apply(2, needed, { effort: 'medium', agentType: 'arbiter-fix' });
  assertExit(r, 0, r.stdout);
  assert.equal(r.json.ok, true);
  assert.equal(w.state().rounds[1].arbiter.proofOk, true);
  assert.deepEqual(w.state().rounds[1].modelProof.effort, 'medium');
});

// ---- apply: the proof ------------------------------------------------------------------------------------------------------------------------

test('arbiter apply: a fix-verify round is proven at medium, and at any higher effort; low and other agents are refused', (t) => {
  for (const [effort, agentType, ok] of [['medium', 'arbiter-fix', true], ['high', 'arbiter-fix', true], ['xhigh', 'arbiter-fix', true], ['low', 'arbiter-fix', false], ['medium', 'arbiter', false]]) {
    const w = fixWorld(t);
    const needed = w.needed(2).json;
    const r = w.apply(2, needed, { effort, agentType });
    assert.equal(r.code, ok ? 0 : 1, `${effort} / ${agentType}: ${r.stdout}`);
    assert.equal(r.json.ok, ok, `${effort} / ${agentType}`);
    assert.equal(w.state().rounds[1].arbiter.proofOk, ok);
    if (!ok) assert.match(r.json.errors.join('\n'), /unexpected (effort|agent type)/);
    if (ok) assert.equal(r.json.brief, 'fix-verify');
  }
});

test('arbiter apply: a full round refuses medium (and still takes high), and refuses the fix agent', (t) => {
  const w = world(t);
  assertExit(w.codex(1, findingsOf([finding()])), 0);
  const needed = w.needed(1).json;
  const medium = w.apply(1, needed, { effort: 'medium' });
  assertExit(medium, 1, medium.stdout);
  assert.match(medium.json.errors.join('\n'), /unexpected effort medium/);
  assert.equal(w.state().rounds[0].arbiter.proofOk, false);
  const fixAgent = w.apply(1, needed, { effort: 'high', agentType: 'arbiter-fix' });
  assertExit(fixAgent, 1, fixAgent.stdout);
  assert.match(fixAgent.json.errors.join('\n'), /unexpected agent type arbiter-fix/);
  const answer = { rulings: [{ id: 'R1-S1', ruling: 'REJECT', confidence: 'high', reasoning: 'src/b.js:3 is fine' }], findings: [] };
  const ok = w.apply(1, needed, { effort: 'high', answer });
  assertExit(ok, 0, ok.stdout);
  assert.equal(ok.json.brief, undefined, 'a full round\'s output is the one it always was');
});

test('arbiter apply: a non-Fable model is refused on either brief', (t) => {
  const full = world(t);
  assertExit(full.codex(1, findingsOf([finding()])), 0);
  const nf = full.needed(1).json;
  const r1 = full.apply(1, nf, { model: 'claude-sonnet-4-6', effort: 'high' });
  assertExit(r1, 1, r1.stdout);
  assert.match(r1.json.errors.join('\n'), /unexpected model claude-sonnet-4-6/);

  const fix = fixWorld(t);
  const nx = fix.needed(2).json;
  const r2 = fix.apply(2, nx, { model: 'claude-opus-4-6', effort: 'medium', agentType: 'arbiter-fix' });
  assertExit(r2, 1, r2.stdout);
  assert.match(r2.json.errors.join('\n'), /unexpected model claude-opus-4-6/);
  assert.equal(fix.state().rounds[1].arbiter.proofOk, false);
});

test('arbiter apply: round state from before this change (no brief fields) is the full brief at effort high', (t) => {
  const w = fixWorld(t);
  const needed = w.needed(2).json;
  assert.equal(needed.brief, 'fix-verify');
  w.edit((s) => { for (const k of ['brief', 'effort', 'agent']) delete s.rounds[1].arbiter[k]; });
  const medium = w.apply(2, needed, { effort: 'medium', agentType: 'arbiter-fix' });
  assertExit(medium, 1, medium.stdout);
  const high = w.apply(2, needed, { effort: 'high', agentType: 'arbiter' });
  assertExit(high, 0, high.stdout);
  assert.equal(w.state().rounds[1].arbiter.proofOk, true);
});

test('arbiter apply: the test-mode expectation flags still override the effort exactly, on either brief', (t) => {
  const w = fixWorld(t);
  const needed = w.needed(2).json;
  const r = w.apply(2, needed, { effort: 'low', agentType: 'arbiter-fix', args: ['--expect-effort', 'low'] });
  assert.equal(r.json.ok, false, 'without PIPELINE_TEST_MODE the flag is ignored');
  assert.match(r.json.note ?? '', /ignored/);
});

// ---- the pure parts --------------------------------------------------------------------------------------------------------------------------

test('fix-verify lib: expectations, accepted efforts and the state-only conditions', () => {
  assert.deepEqual(BRIEFS['fix-verify'], { brief: 'fix-verify', effort: 'medium', agent: 'arbiter-fix' });
  assert.deepEqual(BRIEFS.full, { brief: 'full', effort: 'high', agent: 'arbiter' });
  assert.deepEqual(effortsAtLeast('medium'), ['medium', 'high', 'xhigh', 'max']);
  assert.equal(acceptedEfforts(BRIEFS.full), 'high');
  assert.deepEqual(acceptedEfforts(BRIEFS['fix-verify']), ['medium', 'high', 'xhigh', 'max']);
  assert.equal(expectationOf(undefined).brief, 'full');
  assert.equal(expectationOf({}).brief, 'full');
  assert.equal(expectationOf({ brief: 'bogus', mode: 'review' }).brief, 'full');
  assert.equal(expectationOf({ brief: 'fix-verify', mode: 'dispute' }).brief, 'full', 'a dispute input is never a fix-verify one');
  assert.equal(expectationOf({ brief: 'fix-verify', mode: 'review' }).brief, 'fix-verify');

  const acc = { final: { decision: 'ACCEPT', needsHuman: false } };
  const rounds = [
    { n: 1, items: [acc] },
    { n: 2, baseOnly: true, items: [] },
    { n: 3, fableRefresh: true, items: [] },
    { n: 4, items: [] },
  ];
  const state = { rounds };
  assert.deepEqual(previousAccepts(state, 4)?.round, 1, 'uncounted rounds in between are skipped');
  assert.equal(previousAccepts(state, 4)?.accepted.length, 1);
  assert.equal(previousAccepts(state, 1), null);
  assert.equal(previousAccepts({ rounds: [{ n: 1, items: [{ final: { decision: 'ACCEPT', needsHuman: true } }] }] }, 2)?.accepted.length, 0, 'an ACCEPT still waiting for a human is not a fix');
  const next = { n: 4 };
  assert.equal(fixRoundCandidate(state, next, { scope: 'round' }).ok, true);
  assert.equal(fixRoundCandidate(state, next, { scope: 'whole-pr' }).ok, false);
  assert.equal(fixRoundCandidate(state, { n: 4, fableRefresh: true }, { scope: 'round' }).ok, false);
  assert.equal(fixRoundCandidate(state, { n: 4, resolutionOnly: true }, { scope: 'round' }).ok, false);
  // the review base kind is an allow-list: a plain previous-round slice, or a round stored before the kind existed
  assert.equal(fixRoundCandidate(state, { n: 4, reviewBaseKind: 'previous' }, { scope: 'round' }).ok, true);
  for (const kind of ['whole-pr', 'synthetic', 'resolution', 'bogus', null, '']) {
    assert.equal(fixRoundCandidate(state, { n: 4, reviewBaseKind: kind }, { scope: 'round' }).ok, false, String(kind));
  }
  assert.equal(fixRoundCandidate({ rounds: [{ n: 1, items: [] }] }, { n: 2 }, { scope: 'round' }).ok, false);
  assert.equal(fixRoundCandidate({ rounds: [] }, { n: 1 }, { scope: 'round' }).ok, false);
});

test('proveModel: a list of accepted efforts accepts any of them and refuses the rest; an empty or non-string list is an invalid expectation', () => {
  const line = (effort) => JSON.stringify({ type: 'assistant', effort, perTurnEffort: effort, message: { model: 'claude-fable-5-2', id: 'm', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: fenced({ rulings: [] }) }] } });
  const user = JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } });
  const run = (effort, expectEffort) => proveModel({ jsonlText: `${user}\n${line(effort)}\n`, metaText: '{}', expectModelPrefix: 'claude-fable-', expectEffort });
  assert.equal(run('medium', ['medium', 'high']).ok, true);
  assert.equal(run('high', ['medium', 'high']).ok, true);
  assert.match(run('low', ['medium', 'high']).errors.join('\n'), /unexpected effort low/);
  assert.match(run('high', []).errors.join('\n'), /invalid expectation: expectEffort/);
  assert.match(run('high', ['']).errors.join('\n'), /invalid expectation: expectEffort/);
  assert.equal(run('high', 'high').ok, true, 'a single string is still exact');
  assert.match(run('medium', 'high').errors.join('\n'), /unexpected effort medium/);
});

// ---- telemetry -------------------------------------------------------------------------------------------------------------------------------

test('telemetry: the agent-log line shows the Fable passes and how many were fix-verify; a run with none reads as before', () => {
  const state = {
    risk: 'high',
    rounds: [
      { n: 1, arbiter: { proofOk: true, brief: 'full' }, items: [] },
      { n: 2, arbiter: { proofOk: true, brief: 'fix-verify' }, items: [] },
      { n: 3, arbiter: { proofOk: true, brief: 'fix-verify' }, items: [{ id: 'R3-S1', arbiter: { ruling: 'ACCEPT' } }] },
      { n: 4, arbiter: { proofOk: false, brief: 'fix-verify' }, items: [] },
      { n: 5, items: [] },
    ],
  };
  assert.equal(countArbiterCalls(state), 3, 'a proven zero-item Fable round is a pass too');
  assert.equal(countFixVerifyCalls(state), 2, 'only proven fix-verify passes');
  assert.equal(countFixVerifyCalls(null), 0);
  assert.match(buildAgentLogLine({ state, pr: 9, title: 't', outcome: 'merged', now: new Date('2026-11-11T00:00:00Z') }), /rounds 5 · arbiter 3 \(fix-verify 2\) · merged$/);
  assert.equal(agentLogLine({ date: '2026-11-11', pr: 1, title: 't', risk: 'low', rounds: 2, arbiterCalls: 1, outcome: 'merged' }), '- 2026-11-11 · #1 · t · risk low · rounds 2 · arbiter 1 · merged');
  assert.equal(agentLogLine({ date: '2026-11-11', pr: 1, title: 't', risk: 'low', rounds: 2, arbiterCalls: 2, fixVerifyCalls: 1, outcome: 'merged' }), '- 2026-11-11 · #1 · t · risk low · rounds 2 · arbiter 2 (fix-verify 1) · merged');
});
