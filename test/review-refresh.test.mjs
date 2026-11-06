// lib/review-refresh.mjs: after `P merge --owner-go` updated the PR from its base branch (a new head), the review state follows the head
// without a Codex run: a base-only round + review-complete, or nothing / review-complete alone when the state is already there.
// Unit tests inject `run` (and the PR's published marker); the end-to-end tests run the REAL codex-review / review-complete in process
// against real git (a bare origin whose main moves on), a stateful fake gh and a fake Codex that records every call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTmpRepo } from './helpers/tmprepo.mjs';
import { createCommentsGh, pipelineYml, REPO_VIEW } from './helpers/fakegh-env.mjs';
import { assertExit } from './helpers/assert-exit.mjs';
import { loadConfig } from '../pipeline/lib/config.mjs';
import { refreshReview } from '../pipeline/lib/review-refresh.mjs';
import { reviewContentHash } from '../pipeline/lib/review-publish.mjs';
import { REVIEW_COMPLETE_MARKER } from '../pipeline/lib/review-marker.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const bin = join(here, '..', 'pipeline', 'bin', 'pipeline.mjs');
const fakeCodex = join(here, 'fixtures', 'fake-codex.mjs');

const aFile = (changed) => Array.from({ length: 30 }, (_, i) => {
  const n = i + 1;
  return n === 12 && changed ? 'export const v12 = compute(x.y);' : `export const v${n} = ${n};`;
}).join('\n') + '\n';
const clean = { summary: 'Reviewed.', blocking: [], suggestions: [], worth_considering: [] };

const GH = [
  { match: '^pr view 7', stdoutJson: { title: 'Add compute', body: 'Adds compute()', headRefName: 'feat/x', baseRefName: 'main', isDraft: false, labels: [] } },
  { match: '^repo view', stdoutJson: REPO_VIEW },
  { match: '^pr edit 7 --remove-label awaiting-review', code: 0 },
];

// A PR repo (bare origin, feature branch off the light lane) with round 1 recorded clean. `ghFn` is the fake gh the in-process commands use.
function world(t) {
  const repo = createTmpRepo();
  t.after(() => repo.cleanup());
  const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), 'cp-refresh-')));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const originDir = join(scratch, 'origin.git');
  const git = (cwd, args) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
    return r.stdout;
  };
  repo.write('.claude/pipeline.yml', pipelineYml());
  repo.write('.gitignore', '.review/\n');
  repo.write('src/a.js', aFile(false));
  repo.commit('init');
  git(scratch, ['init', '-q', '--bare', '-b', 'main', originDir]);
  repo.git(['remote', 'add', 'origin', originDir]);
  repo.git(['push', '-q', 'origin', 'main']);
  repo.git(['fetch', '-q', 'origin']);
  repo.branch('feat/x');
  repo.write('src/a.js', aFile(true));
  repo.write('src/big.js', Array.from({ length: 60 }, (_, i) => `export const big${i} = ${i};`).join('\n') + '\n');
  const head = repo.commit('feature');

  const prView = (sha) => GH.map((e) => (e.match === '^pr view 7' ? { ...e, stdoutJson: { ...e.stdoutJson, headRefOid: sha } } : e));
  const fake = createCommentsGh(prView(head));
  const capture = join(scratch, 'codex-capture.jsonl');
  const env = {
    ...process.env, ...fake.env, PIPELINE_CODEX: `node "${fakeCodex}"`, FAKE_CODEX_CAPTURE: capture, PIPELINE_LOCK_DIR: join(scratch, 'locks'),
  };
  const w = {
    repo, head, scratch, fake, env, originDir,
    cli(args, extra = {}) {
      const r = spawnSync(process.execPath, [bin, ...args], { cwd: repo.dir, encoding: 'utf8', env: { ...env, ...extra } });
      let json = null;
      try { json = r.stdout ? JSON.parse(r.stdout) : null; } catch { /* the assertion on json will say so */ }
      return { code: r.status, json, stdout: r.stdout, stderr: r.stderr };
    },
    prHead: (sha) => fake.setScript(prView(sha)),
    state: () => JSON.parse(readFileSync(join(repo.dir, '.review', 'state.json'), 'utf8')),
    codexCalls: () => (existsSync(capture) ? readFileSync(capture, 'utf8').split('\n').filter(Boolean).length : 0),
    // "Someone else's PR merged into main", then "Update branch" + `git pull --ff-only`: the PR branch gets main's commit. -> the new head.
    updateFromMain() {
      const other = join(scratch, 'other');
      git(scratch, ['clone', '-q', originDir, other]);
      for (const [k, v] of [['user.name', 'Other'], ['user.email', 'other@example.invalid'], ['commit.gpgsign', 'false']]) git(other, ['config', k, v]);
      writeFileSync(join(other, 'from-main.js'), 'export const other = 1;\n');
      git(other, ['add', '-A']);
      git(other, ['commit', '-q', '-m', 'main moves on']);
      git(other, ['push', '-q', 'origin', 'main']);
      repo.git(['fetch', '-q', originDir, '+refs/heads/main:refs/tmp/main']);
      repo.git(['merge', '--no-ff', '-q', '-m', 'Merge branch main into feat/x', 'refs/tmp/main']);
      repo.git(['update-ref', '-d', 'refs/tmp/main']);
      return repo.git(['rev-parse', 'HEAD']).trim();
    },
    async config(over = {}) {
      const { config } = await loadConfig(repo.dir);
      return { ...config, ...over, ci: { ...config.ci, ...(over.ci ?? {}) } };
    },
  };
  const out = join(scratch, 'findings-1.json');
  writeFileSync(out, JSON.stringify(clean));
  const base = repo.git(['merge-base', 'origin/main', 'HEAD']).trim();
  assertExit(w.cli(['codex-review', '--pr', '7', '--round', '1', '--base', base, '--head', head, '--effort', 'high'], { FAKE_CODEX_OUTPUT: out }), 0);
  assert.equal(w.codexCalls(), 1);
  return w;
}

// ---- unit: the decision table, with an injected `run` ---------------------------------------------------------------------------

const recorder = (answers = {}) => {
  const calls = [];
  const run = async (name, argv) => {
    calls.push({ name, argv });
    const a = answers[name];
    if (a instanceof Error) throw a;
    return a ?? { exitCode: 0, output: { ok: true } };
  };
  return { calls, run };
};
const BASE_ONLY_OK = { exitCode: 0, output: { ok: true, round: 2, baseOnly: true, counts: { blocking: 0, suggestions: 0, worth_considering: 0 }, path: '/x' } };
const COMPLETE_OK = { exitCode: 0, output: { ok: true, posted: true, comment: { id: 1, url: 'u' }, review: { head: 'h', rounds: 2 }, recheck: 'triggered' } };

test('refreshReview: no review state and ci.review_check off is not-applicable, nothing is called (R15)', async (t) => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'cp-refresh-empty-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { calls, run } = recorder();
  const r = await refreshReview({ root: dir, config: { ci: { review_check: false }, review: { effort: { followup: 'medium' } } }, pr: 7, head: 'a'.repeat(40), run });
  assert.deepEqual(r, { ok: true, kind: 'not-applicable' });
  assert.deepEqual(calls, []);
});

test('refreshReview: no review state but ci.review_check on is no-review-state (nothing to carry), nothing is called', async (t) => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'cp-refresh-empty-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { calls, run } = recorder();
  const r = await refreshReview({ root: dir, config: { ci: { review_check: true }, review: { effort: { followup: 'medium' } } }, pr: 7, head: 'a'.repeat(40), run });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'no-review-state');
  assert.deepEqual(calls, []);
});

test('refreshReview: a head past the last round runs codex-review --base-only for the next round from the last toHead, then review-complete', async (t) => {
  const w = world(t);
  const newHead = 'b'.repeat(40);
  const { calls, run } = recorder({ 'codex-review': BASE_ONLY_OK, 'review-complete': COMPLETE_OK });
  const r = await refreshReview({ root: w.repo.dir, config: await w.config(), pr: 7, head: newHead, run });
  assert.deepEqual(calls.map((c) => c.name), ['codex-review', 'review-complete']);
  assert.deepEqual(calls[0].argv, [
    '--pr', '7', '--round', '2', '--base', w.head, '--head', newHead, '--effort', 'medium', '--base-only', '--repo', w.repo.dir,
  ]);
  assert.deepEqual(calls[1].argv, ['--pr', '7', '--repo', w.repo.dir]);
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'base-only');
  assert.deepEqual(r.codexReview, { round: 2, baseOnly: true, counts: BASE_ONLY_OK.output.counts, path: '/x' });
  assert.equal(r.reviewComplete.posted, true);
});

test('refreshReview: the followup effort comes from the config', async (t) => {
  const w = world(t);
  const config = await w.config();
  config.review = { ...config.review, effort: { ...config.review.effort, followup: 'xhigh' } };
  const { calls, run } = recorder({ 'codex-review': BASE_ONLY_OK, 'review-complete': COMPLETE_OK });
  await refreshReview({ root: w.repo.dir, config, pr: 7, head: 'b'.repeat(40), run });
  assert.equal(calls[0].argv[calls[0].argv.indexOf('--effort') + 1], 'xhigh');
});

test('refreshReview: state already at the head and the marker for it on the PR is already-current, nothing is called', async (t) => {
  const w = world(t);
  const { calls, run } = recorder();
  const published = () => ({ marker: { found: true, record: { head: w.head, stateHash: reviewContentHash(w.state()) } } });
  const r = await refreshReview({ root: w.repo.dir, config: await w.config(), pr: 7, head: w.head, run, published });
  assert.deepEqual(r, { ok: true, kind: 'already-current' });
  assert.deepEqual(calls, []);
});

test('refreshReview: state at the head but no marker (or a marker for another head / another state) runs review-complete only', async (t) => {
  const w = world(t);
  for (const marker of [{ found: false }, { found: true, record: { head: 'c'.repeat(40), stateHash: reviewContentHash(w.state()) } }, { found: true, record: { head: w.head, stateHash: 'old' } }, { found: true, record: null }]) {
    const { calls, run } = recorder({ 'review-complete': COMPLETE_OK });
    const r = await refreshReview({ root: w.repo.dir, config: await w.config(), pr: 7, head: w.head, run, published: () => ({ marker }) });
    assert.deepEqual(calls.map((c) => c.name), ['review-complete']);
    assert.equal(r.ok, true);
    assert.equal(r.kind, 'review-complete');
  }
});

test('refreshReview: a codex-review refusal is {ok:false} with its error code and reason, review-complete is never called, no fallback', async (t) => {
  const w = world(t);
  const refused = { exitCode: 1, output: { ok: false, error: 'not-base-only', reason: 'the PR changed since round 1', message: 'the PR changed since round 1' } };
  const { calls, run } = recorder({ 'codex-review': refused });
  const r = await refreshReview({ root: w.repo.dir, config: await w.config(), pr: 7, head: 'b'.repeat(40), run });
  assert.deepEqual(r, { ok: false, code: 'not-base-only', reason: 'the PR changed since round 1', command: 'codex-review', exitCode: 1 });
  assert.deepEqual(calls.map((c) => c.name), ['codex-review']);
});

test('refreshReview: an unavailable codex-review (exit 3) reports its reason as the code; a thrown error is code error', async (t) => {
  const w = world(t);
  const down = { exitCode: 3, output: { ok: false, unavailable: true, reason: 'github', message: 'gh failed' } };
  const a = await refreshReview({ root: w.repo.dir, config: await w.config(), pr: 7, head: 'b'.repeat(40), run: recorder({ 'codex-review': down }).run });
  assert.deepEqual([a.ok, a.code, a.reason], [false, 'github', 'github']);
  const b = await refreshReview({ root: w.repo.dir, config: await w.config(), pr: 7, head: 'b'.repeat(40), run: recorder({ 'codex-review': new Error('boom\nstack') }).run });
  assert.deepEqual([b.ok, b.code, b.reason], [false, 'error', 'boom']);
});

test('refreshReview: a review-complete refusal after the base-only round is {ok:false} carrying the round that was recorded', async (t) => {
  const w = world(t);
  const refused = { exitCode: 1, output: { ok: false, reason: 'items still waiting for a decision: R1-B1' } };
  const { calls, run } = recorder({ 'codex-review': BASE_ONLY_OK, 'review-complete': refused });
  const r = await refreshReview({ root: w.repo.dir, config: await w.config(), pr: 7, head: 'b'.repeat(40), run });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'review-complete-failed');
  assert.match(r.reason, /waiting for a decision/);
  assert.equal(r.codexReview.round, 2);
  assert.deepEqual(calls.map((c) => c.name), ['codex-review', 'review-complete']);
});

test('refreshReview: a codex-review that answers ok without a baseOnly round is not trusted', async (t) => {
  const w = world(t);
  const { calls, run } = recorder({ 'codex-review': { exitCode: 0, output: { ok: true, round: 2, counts: {} } } });
  const r = await refreshReview({ root: w.repo.dir, config: await w.config(), pr: 7, head: 'b'.repeat(40), run });
  assert.deepEqual([r.ok, r.code], [false, 'not-base-only']);
  assert.deepEqual(calls.map((c) => c.name), ['codex-review']);
});

// ---- end to end: the real commands, in process ----------------------------------------------------------------------------------

test('refreshReview end to end: main merged into a reviewed PR gives a baseOnly round and a review-complete for the new head, Codex never runs', async (t) => {
  const w = world(t);
  const merged = w.updateFromMain();
  w.prHead(merged);
  const r = await refreshReview({ root: w.repo.dir, config: await w.config(), pr: 7, head: merged, ctx: { env: w.env } });
  assert.deepEqual([r.ok, r.kind], [true, 'base-only'], JSON.stringify(r));
  assert.equal(w.codexCalls(), 1, 'only round 1 ran Codex');
  const rounds = w.state().rounds;
  assert.deepEqual([rounds.length, rounds[1].baseOnly, rounds[1].toHead, rounds[1].fromHead], [2, true, merged, w.head]);
  const marker = w.fake.comments().filter((c) => c.body.startsWith(REVIEW_COMPLETE_MARKER));
  assert.equal(marker.length, 1);
  assert.match(marker[0].body, new RegExp(`"head":"${merged}"`));

  // a second call (the merge job was restarted) finds everything in place
  const again = await refreshReview({ root: w.repo.dir, config: await w.config(), pr: 7, head: merged, ctx: { env: w.env } });
  assert.deepEqual(again, { ok: true, kind: 'already-current' });
  assert.equal(w.fake.comments().filter((c) => c.body.startsWith(REVIEW_COMPLETE_MARKER)).length, 1, 'no second marker');
});

test('refreshReview end to end: a PR change on top of the main merge is refused not-base-only: no round, no marker, no Codex', async (t) => {
  const w = world(t);
  w.updateFromMain();
  w.repo.write('src/extra.js', 'export const extra = 1;\n');
  const head = w.repo.commit('own change after the merge');
  w.prHead(head);
  const before = readFileSync(join(w.repo.dir, '.review', 'state.json'), 'utf8');
  const r = await refreshReview({ root: w.repo.dir, config: await w.config(), pr: 7, head, ctx: { env: w.env } });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'not-base-only');
  assert.match(r.reason, /round 1/);
  assert.equal(readFileSync(join(w.repo.dir, '.review', 'state.json'), 'utf8'), before);
  assert.equal(w.codexCalls(), 1);
  assert.equal(w.fake.comments().filter((c) => c.body.startsWith(REVIEW_COMPLETE_MARKER)).length, 0);
});
