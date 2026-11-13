// The review lane (judge or Fable) as codex-review and review-complete decide it: a PR that is medium only for its size goes to the judge, and nothing
// that edits the rating config, adds a hit, or is stacked can slip through to it. Runs the real CLI against a throwaway repo, a scripted gh and codex.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTmpRepo } from './helpers/tmprepo.mjs';
import { createFakeGh, pipelineYml, REPO_VIEW } from './helpers/fakegh-env.mjs';
import { floorEnv } from './helpers/floor-env.mjs';
import { assertExit } from './helpers/assert-exit.mjs';
import { loadConfig } from '../pipeline/lib/config.mjs';
import { laneProblem } from '../pipeline/commands/review-complete.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const bin = join(here, '..', 'pipeline', 'bin', 'pipeline.mjs');
const fakeCodex = join(here, 'fixtures', 'fake-codex.mjs');

const lines = (n, tag = 'big') => Array.from({ length: n }, (_, i) => `export const ${tag}${i} = ${i};`).join('\n') + '\n';
const CLEAN = { summary: 'Reviewed.', blocking: [], suggestions: [], worth_considering: [] };
const REMOVE_LABEL = { match: '^pr edit 7 --remove-label awaiting-review', code: 0 };
const REVIEW_COMMENT = [
  { match: '^api user', stdout: 'me\n' },
  { match: 'issues/7/comments --paginate', stdoutJson: [] },
  { match: '^api -X POST repos/acme/widgets/issues/7/comments ', stdoutJson: { id: 77, html_url: 'https://github.com/acme/widgets/pull/7#issuecomment-77' } },
];

// A repo on main with a.js committed, then feature/x with `feature(repo)` committed. `baseYml`: the config committed at the fork point (null = none there),
// `workingYml`: written to the working tree afterwards (uncommitted) when given. `prBase`: what gh reports as the PR's base branch.
function world(t, { baseYml = pipelineYml(), feature = (r) => r.write('src/big.js', lines(200)), workingYml, prBase = 'main' } = {}) {
  const repo = createTmpRepo();
  t.after(() => repo.cleanup());
  if (baseYml !== null) repo.write('.claude/pipeline.yml', baseYml);
  repo.write('.gitignore', '.review/\n');
  repo.write('src/a.js', lines(30, 'a'));
  const base = repo.commit('init');
  repo.git(['branch', 'stack-base']);
  repo.branch('feat/x');
  feature(repo);
  const head = repo.commit('feature');
  if (workingYml !== undefined) repo.write('.claude/pipeline.yml', workingYml);
  const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), 'cp-lane-')));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const gh = (sha) => [
    { match: '^pr view 7', stdoutJson: { title: 'T', body: 'B', headRefName: 'feat/x', baseRefName: prBase, headRefOid: sha } },
    { match: '^repo view', stdoutJson: REPO_VIEW },
    REMOVE_LABEL, ...REVIEW_COMMENT,
  ];
  const fake = createFakeGh(gh(head));
  const w = {
    repo, base, head, scratch, fake,
    prHead: (sha) => fake.setScript(gh(sha)),
    cli(args, env = {}) {
      const merged = {
        ...process.env, ...fake.env, PIPELINE_CODEX: `node "${fakeCodex}"`, FAKE_CODEX_CAPTURE: join(scratch, 'capture.jsonl'),
        PIPELINE_LOCK_DIR: join(scratch, 'locks'), ...floorEnv(), ...env,
      };
      for (const k of ['PIPELINE_TEST_FORCE_ARBITER', 'PIPELINE_TEST_MODE', 'FAKE_CODEX_EXIT', 'FAKE_CODEX_OUTPUT', 'AI_AGENT', 'CLAUDE_CODE_EXECPATH']) if (!(k in env)) delete merged[k];
      const r = spawnSync(process.execPath, [bin, ...args], { cwd: repo.dir, env: merged, encoding: 'utf8' });
      let json = null;
      try { json = r.stdout ? JSON.parse(r.stdout) : null; } catch { /* the assertion on json says so */ }
      return { code: r.status, json, stdout: r.stdout, stderr: r.stderr };
    },
    codex(round, { from = base, to = head, findings = CLEAN } = {}) {
      const out = join(scratch, `findings-${round}.json`);
      writeFileSync(out, JSON.stringify(findings));
      // The command refuses an --effort that is not the configured one for the round (review.effort), so ask the plan for it.
      const args = ['codex-review', '--pr', '7', '--round', String(round), '--base', from, '--head', to];
      const effort = w.cli([...args, '--plan'], { FAKE_CODEX_OUTPUT: out }).json?.expectedEffort ?? 'high';
      return w.cli([...args, '--effort', effort], { FAKE_CODEX_OUTPUT: out });
    },
    state: () => JSON.parse(readFileSync(join(repo.dir, '.review', 'state.json'), 'utf8')),
    saveState(st) { writeFileSync(join(repo.dir, '.review', 'state.json'), JSON.stringify(st)); },
    commitMore(file, content) {
      repo.write(file, content);
      const sha = repo.commit(`change ${file}`);
      w.prHead(sha);
      return sha;
    },
  };
  return w;
}

const withBlocks = (extra) => `${pipelineYml()}${extra}`;

// ---- codex-review ----------------------------------------------------------------------------------------------------------

test('codex-review: a PR that is medium only for its size is reviewed by the judge (state.risk stays medium, no fableRequired); the opt-out keeps Fable', (t) => {
  const w = world(t);
  const r = w.codex(1);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.deepEqual([r.json.reviewer, r.json.sizeOnly, r.json.reviewerReasons, r.json.lightLane], ['judge', true, [], false]);
  assert.match(r.json.laneNote, /medium for size only: Sonnet judge/);
  assert.equal(w.state().risk, 'medium');
  assert.equal(w.state().rounds[0].fableRequired, undefined);

  const o = world(t, { baseYml: withBlocks('review:\n  size_only_medium_reviewer: fable\n') });
  const ro = o.codex(1);
  assertExit(ro, 0, ro.stderr + ro.stdout);
  assert.deepEqual([ro.json.reviewer, ro.json.reviewerReasons], ['fable', ['medium risk']]);
  assert.equal(o.state().rounds[0].fableRequired, true);
});

test('codex-review: size-only medium with a hard-stop hit, a sensitive path or a stacked base never gets the judge', (t) => {
  const hit = world(t, { baseYml: withBlocks('hard_stops:\n  paths: [src/big.js]\n') });
  assert.equal(hit.codex(1).json.reviewer, 'fable', 'a P-path hit');
  const sensitive = world(t, { baseYml: withBlocks('review:\n  arbiter_always_paths: [src/big.js]\n') });
  assert.equal(sensitive.codex(1).json.reviewer, 'fable', 'a sensitive path');
  const stacked = world(t, { prBase: 'stack-base' });
  const r = stacked.codex(1);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.equal(r.json.reviewer, 'fable', 'a stacked PR');
});

test('codex-review: the judge PR that gains a hit in round 2 escalates, and that round reviews the WHOLE PR (kind whole-pr from the fork point)', (t) => {
  const w = world(t, { baseYml: withBlocks('hard_stops:\n  paths: [src/secret/**]\n') });
  assert.equal(w.codex(1).json.reviewer, 'judge');
  w.commitMore('src/secret/x.js', lines(3, 's'));
  const r2 = w.codex(2, { from: w.head, to: w.repo.git(['rev-parse', 'HEAD']).trim() });
  assertExit(r2, 0, r2.stderr + r2.stdout);
  assert.equal(r2.json.reviewer, 'fable');
  const round = w.state().rounds[1];
  assert.equal(round.fableRequired, true);
  assert.deepEqual([round.reviewBase, round.reviewBaseKind], [w.base, 'whole-pr']);
});

test('codex-review: a PR once on Fable stays on Fable, whatever a later round rates', (t) => {
  const w = world(t, { baseYml: withBlocks('review:\n  arbiter_always_paths: [src/a.js]\n'), feature: (r) => { r.write('src/a.js', lines(31, 'a')); } });
  assert.equal(w.codex(1).json.reviewer, 'fable');
  // the sensitive file goes back to the base content: the PR no longer touches a sensitive path
  w.repo.write('src/a.js', lines(30, 'a'));
  w.repo.write('src/other.js', lines(3, 'o'));
  const sha = w.repo.commit('revert a.js, add other.js');
  w.prHead(sha);
  const r2 = w.codex(2, { from: w.head, to: sha });
  assertExit(r2, 0, r2.stderr + r2.stdout);
  assert.equal(r2.json.reviewer, 'fable');
});

test('codex-review: an uncommitted edit of the rating config never lowers the result; an unreadable base config is Fable even for a tiny change', (t) => {
  const strict = withBlocks('review:\n  size_only_medium_reviewer: fable\n');
  const w = world(t, { baseYml: strict, workingYml: withBlocks('review:\n  size_only_medium_reviewer: judge\n') });
  assert.equal(w.codex(1).json.reviewer, 'fable', 'working tree says judge, the fork point says fable');
  const w2 = world(t, { baseYml: withBlocks('hard_stops:\n  paths: [src/big.js]\n'), workingYml: pipelineYml() });
  assert.equal(w2.codex(1).json.reviewer, 'fable', 'working tree dropped the hard-stop path the fork point has');
  const none = world(t, { baseYml: null, feature: (r) => r.write('src/tiny.js', lines(2, 't')), workingYml: pipelineYml() });
  const rn = none.codex(1);
  assertExit(rn, 0, rn.stderr + rn.stdout);
  assert.deepEqual([rn.json.reviewer, rn.json.reviewerReasons.some((x) => /trusted base config unreadable/.test(x)), rn.json.lightLane], ['fable', true, false]);
});

// ---- review-complete -------------------------------------------------------------------------------------------------------

test('review-complete: a judge-only size-only medium PR completes; the same state on a hit, a stack or a recorded high does not', (t) => {
  const w = world(t);
  assertExit(w.codex(1), 0);
  const ok = w.cli(['review-complete', '--pr', '7']);
  assertExit(ok, 0, ok.stderr + ok.stdout);
  assert.equal(ok.json.ok, true);

  // a recorded high risk (the state is a local file) with only judge rounds is refused
  const hi = world(t);
  assertExit(hi.codex(1), 0);
  hi.saveState({ ...hi.state(), risk: 'high' });
  const rh = hi.cli(['review-complete', '--pr', '7']);
  assertExit(rh, 1);
  assert.match(rh.json.reason, /needs the Fable review pass \(high risk\)/);

  // a medium recorded for a PR whose fresh scan finds a hit: the judge-only state is refused
  const hit = world(t, { baseYml: withBlocks('hard_stops:\n  paths: [src/big.js]\n') });
  assertExit(hit.codex(1), 0);
  const st = hit.state();
  st.reviewer = 'judge';
  st.rounds = st.rounds.map(({ fableRequired, fableReasons, sensitivePaths, ...rest }) => rest);
  hit.saveState(st);
  const rhit = hit.cli(['review-complete', '--pr', '7']);
  assertExit(rhit, 1);
  assert.match(rhit.json.reason, /needs the Fable review pass/);

  // stacked: the PR targets another branch, so the size-only judge is not available
  const stacked = world(t);
  assertExit(stacked.codex(1), 0);
  stacked.fake.setScript([
    { match: '^pr view 7', stdoutJson: { title: 'T', body: 'B', headRefName: 'feat/x', baseRefName: 'stack-base', headRefOid: stacked.head } },
    { match: '^repo view', stdoutJson: REPO_VIEW }, REMOVE_LABEL, ...REVIEW_COMMENT,
  ]);
  const rs = stacked.cli(['review-complete', '--pr', '7']);
  assertExit(rs, 1);
  assert.match(rs.json.reason, /needs the Fable review pass/);
});

test('review-complete: a recorded medium with a fresh low rating needs Fable (the medium came from something else)', (t) => {
  const w = world(t, { feature: (r) => r.write('src/tiny.js', lines(3, 't')) });
  assertExit(w.codex(1), 0);
  w.saveState({ ...w.state(), risk: 'medium' });
  const r = w.cli(['review-complete', '--pr', '7']);
  assertExit(r, 1);
  assert.match(r.json.reason, /recorded medium risk/);
});

test('laneProblem: a scan that throws forces Fable whatever the recorded level; a proven Fable round clears it', async (t) => {
  const repo = createTmpRepo();
  t.after(() => repo.cleanup());
  repo.write('.claude/pipeline.yml', pipelineYml());
  repo.commit('init');
  const { config } = await loadConfig(repo.dir);
  const boom = async () => { throw new Error('git diff exploded'); };
  for (const risk of ['low', 'medium']) {
    const state = { risk, rounds: [{ n: 1, reviewer: 'judge' }] };
    const why = await laneProblem(state, repo.dir, config, 'main', { rate: boom });
    assert.match(why, /hard stops could not be collected: git diff exploded/, risk);
  }
  const proven = { risk: 'low', rounds: [{ n: 1, fableRequired: true, arbiter: { proofOk: true } }] };
  assert.equal(await laneProblem(proven, repo.dir, config, 'main', { rate: boom }), null);
  // a throwing scan under a recorded high is Fable without scanning at all
  assert.match(await laneProblem({ risk: 'high', rounds: [] }, repo.dir, config, 'main', { rate: boom }), /high risk/);
});

test('codex-review: review.size_only_medium_reviewer: fable set ONLY in the uncommitted working tree still means Fable', (t) => {
  const w = world(t, { workingYml: withBlocks('review:\n  size_only_medium_reviewer: fable\n') });
  const r = w.codex(1);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.deepEqual([r.json.reviewer, r.json.reviewerReasons], ['fable', ['medium risk']]);
});

test('P risk: a size-only medium PR reports sizeOnly, drivers, reviewer judge and the note; a PR with a hit reports fable and no note', (t) => {
  const w = world(t);
  const r = w.cli(['risk', '--base', w.base, '--head', w.head]);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.deepEqual([r.json.level, r.json.sizeOnly, r.json.reviewer, r.json.hardStops], ['medium', true, 'judge', []]);
  assert.deepEqual(r.json.drivers, { hardStop: false, advisory: false, path: false, size: true });
  assert.match(r.json.note, /medium for size only: Sonnet judge/);

  const hit = world(t, { baseYml: withBlocks('hard_stops:\n  paths: [src/big.js]\n') });
  const rh = hit.cli(['risk', '--base', hit.base, '--head', hit.head]);
  assertExit(rh, 0, rh.stderr + rh.stdout);
  assert.deepEqual([rh.json.sizeOnly, rh.json.reviewer, rh.json.note], [false, 'fable', undefined]);
  assert.ok(rh.json.hardStops.length > 0);
  assert.equal(rh.json.drivers.hardStop, true);
});

test('codex-review + review-complete: an uncommitted medium_lines that rates the PR low next to the fork point config (medium for size) records judge rounds that review-complete accepts', (t) => {
  const w = world(t, { workingYml: withBlocks('risk:\n  medium_lines: 300\n') });
  const r = w.codex(1);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.deepEqual([r.json.reviewer, r.json.sizeOnly, r.json.reviewerReasons], ['judge', true, []]);
  assert.match(r.json.laneNote, /medium for size only: Sonnet judge/);
  assert.equal(w.state().risk, 'medium');
  const done = w.cli(['review-complete', '--pr', '7']);
  assertExit(done, 0, done.stderr + done.stdout);
  assert.equal(done.json.ok, true);
});

test('codex-review + review-complete: the same disagreement where the lenient config still holds a (discounted) hit demands Fable on both sides', (t) => {
  // fork point: medium_lines 300 (low) with an ignored P-path hit; working tree: defaults (medium for size, no hit). The hit is more than size.
  const base = withBlocks('owner_approval: chat\nrisk:\n  medium_lines: 300\n  ignore_hard_stop_rules: [P-path]\nhard_stops:\n  paths: [src/big.js]\n');
  const w = world(t, { baseYml: base, workingYml: pipelineYml() });
  const r = w.codex(1);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.deepEqual([r.json.reviewer, r.json.sizeOnly, r.json.laneNote], ['fable', undefined, undefined]);
  assert.equal(w.state().rounds[0].fableRequired, true);
  const st = w.state();
  st.reviewer = 'judge';
  st.rounds = st.rounds.map(({ fableRequired, fableReasons, sensitivePaths, ...rest }) => rest);
  w.saveState(st);
  const done = w.cli(['review-complete', '--pr', '7']);
  assertExit(done, 1);
  assert.match(done.json.reason, /needs the Fable review pass/);
});
