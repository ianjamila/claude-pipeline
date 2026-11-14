// review-complete / state outcome / state mark-implemented refresh origin/<default_branch> before they hash the content.
// The scenario (EW #1658): `update-branch` merges main into the PR on GitHub, and `git pull --ff-only` fetches the PR branch only, so
// the local origin/main is OLDER than the main that was merged in. The content hash is the PR's diff against merge-base(origin/main,
// HEAD): with the stale ref it includes main's new commits and differs from the round's, so review-complete refused ("no review round
// covers the current content") until some other command refreshed the ref. mark-implemented fails CLOSED when it cannot refresh.
// Real git (a bare "origin" and a second clone that moves main), the real CLI, a scripted fake gh and fake codex.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTmpRepo } from './helpers/tmprepo.mjs';
import { createFakeGh, pipelineYml, REPO_VIEW } from './helpers/fakegh-env.mjs';
import { assertExit } from './helpers/assert-exit.mjs';
import { floorEnv } from './helpers/floor-env.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const bin = join(here, '..', 'pipeline', 'bin', 'pipeline.mjs');
const fakeCodex = join(here, 'fixtures', 'fake-codex.mjs');

const aFile = (changed) => Array.from({ length: 30 }, (_, i) => {
  const n = i + 1;
  return n === 12 && changed ? 'export const v12 = compute(x.y);' : `export const v${n} = ${n};`;
}).join('\n') + '\n';
const finding = () => ({
  title: 'Missing null check', file: 'src/a.js', line: 12, category: 'bug',
  detail: 'x is dereferenced before it is checked', reasoning: 'compute(x.y) throws when x is undefined', testable: true,
});
const findingsOf = (blocking = []) => ({ summary: 'Reviewed.', blocking, suggestions: [], worth_considering: [] });

const GH = [
  { match: '^pr view 7', stdoutJson: { title: 'Add compute', body: 'Adds compute()', headRefName: 'feat/x', baseRefName: 'main' } },
  { match: '^repo view', stdoutJson: REPO_VIEW },
  { match: '^pr edit 7 --remove-label awaiting-review', code: 0 },
  { match: '^api user', stdout: 'me\n' },
  { match: 'issues/7/comments --paginate', stdoutJson: [] },
  { match: '^api -X POST repos/acme/widgets/issues/7/comments ', stdoutJson: { id: 77, html_url: 'https://github.com/acme/widgets/pull/7#issuecomment-77' } },
];

// A PR repo whose "origin" is a bare repository, on feat/x (one 60-line file off the light lane, a change in src/a.js), with
// round 1 already recorded. `withOrigin: false` is a repo that never had a remote.
function world(t, { withOrigin = true, accept = false } = {}) {
  const repo = createTmpRepo({ highEffort: true });
  t.after(() => repo.cleanup());
  const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), 'cp-rcfetch-')));
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
  const base = repo.commit('init');
  if (withOrigin) {
    git(scratch, ['init', '-q', '--bare', '-b', 'main', originDir]);
    repo.git(['remote', 'add', 'origin', originDir]);
    repo.git(['push', '-q', 'origin', 'main']);
    repo.git(['fetch', '-q', 'origin']);
  }
  repo.branch('feat/x');
  repo.write('src/a.js', aFile(true));
  repo.write('src/big.js', Array.from({ length: 60 }, (_, i) => `export const big${i} = ${i};`).join('\n') + '\n');
  const head = repo.commit('feature');

  const fake = createFakeGh(GH.map((e) => (e.match === '^pr view 7' ? { ...e, stdoutJson: { ...e.stdoutJson, headRefOid: head } } : e)));
  const lockDir = join(scratch, 'locks');
  const w = {
    repo, base, head, scratch, fake, originDir,
    prHead: (sha) => fake.setScript(GH.map((e) => (e.match === '^pr view 7' ? { ...e, stdoutJson: { ...e.stdoutJson, headRefOid: sha } } : e))),
    cli(args, env = {}) {
      const r = spawnSync(process.execPath, [bin, ...args], {
        cwd: repo.dir, encoding: 'utf8',
        env: { ...process.env, ...fake.env, PIPELINE_CODEX: `node "${fakeCodex}"`, PIPELINE_LOCK_DIR: lockDir, ...floorEnv(), ...env },
      });
      let json = null;
      try { json = r.stdout ? JSON.parse(r.stdout) : null; } catch { /* the assertion on json will say so */ }
      return { code: r.status, json, stdout: r.stdout, stderr: r.stderr };
    },
    codex(round, findings, { from = base, to = head } = {}) {
      const out = join(scratch, `findings-${round}.json`);
      writeFileSync(out, JSON.stringify(findings));
      return w.cli(['codex-review', '--pr', '7', '--round', String(round), '--base', from, '--head', to, '--effort', 'high'], { FAKE_CODEX_OUTPUT: out });
    },
    state: () => JSON.parse(readFileSync(join(repo.dir, '.review', 'state.json'), 'utf8')),
    // "Someone else's PR merged into main": a second clone pushes a commit to origin. The PR repo's origin/main is NOT updated.
    mainMovesOn(file = 'src/from-main.js') {
      const other = join(scratch, `other-${Math.random().toString(36).slice(2, 8)}`);
      git(scratch, ['clone', '-q', originDir, other]);
      for (const [k, v] of [['user.name', 'Other'], ['user.email', 'other@example.invalid'], ['commit.gpgsign', 'false']]) git(other, ['config', k, v]);
      writeFileSync(join(other, file), 'export const other = 1;\n');
      git(other, ['add', '-A']);
      git(other, ['commit', '-q', '-m', 'main moves on']);
      git(other, ['push', '-q', 'origin', 'main']);
    },
    // "Update branch" + `git pull --ff-only`: the PR branch gets main's new commit, the local origin/main stays where it was.
    // (fetching by URL, not by remote name, so git's opportunistic remote-tracking update does not refresh origin/main)
    updateBranch() {
      repo.git(['fetch', '-q', originDir, '+refs/heads/main:refs/tmp/main']);
      repo.git(['merge', '--no-ff', '-q', '-m', 'Merge branch main into feat/x', 'refs/tmp/main']);
      repo.git(['update-ref', '-d', 'refs/tmp/main']);
      return repo.git(['rev-parse', 'HEAD']).trim();
    },
    localOriginMain: () => repo.git(['rev-parse', 'origin/main']).trim(),
    judgeAccept() {
      const file = join(scratch, 'judge-1.json');
      writeFileSync(file, JSON.stringify({ items: [{ id: 'R1-B1', decision: 'ACCEPT', confidence: 'high', reason: 'judge: ACCEPT', disputedBug: false, settleTest: { possible: false, plan: '' } }] }));
      return w.cli(['triage', 'validate', '--round', '1', '--file', file]);
    },
    item: () => w.state().rounds.flatMap((r) => r.items).find((i) => i.id === 'R1-B1'),
  };
  assertExit(w.codex(1, findingsOf(accept ? [finding()] : [])), 0);
  if (accept) assertExit(w.judgeAccept(), 0);
  return w;
}

// ---- the stale origin/main after update-branch + pull ---------------------------------------------

test('review-complete: after update-branch + a plain pull (stale origin/main) it refreshes the ref and passes', (t) => {
  const w = world(t);
  w.mainMovesOn();
  const merged = w.updateBranch();
  const stale = w.localOriginMain();
  w.prHead(merged);

  const r = w.cli(['review-complete', '--pr', '7']);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.equal(r.json.ok, true);
  assert.notEqual(w.localOriginMain(), stale, 'review-complete fetched origin/main');
  assert.equal(r.json.review.base, w.localOriginMain(), 'the recorded base is the fresh merge base');
});

test('state outcome: coverageValid is true after update-branch + a plain pull (it refreshes origin/main first)', (t) => {
  const w = world(t);
  w.mainMovesOn();
  w.updateBranch();
  const o = w.cli(['state', 'outcome']);
  assertExit(o, 0, o.stderr + o.stdout);
  assert.deepEqual([o.json.coverageValid, o.json.clean], [true, true], JSON.stringify(o.json));
});

test('state mark-implemented: after update-branch + a plain pull an unfixed accept is no-code-change (main\'s commit is not the fix)', (t) => {
  const w = world(t, { accept: true });
  w.mainMovesOn();
  w.updateBranch();
  const r = w.cli(['state', 'mark-implemented', '--ids', 'R1-B1']);
  assertExit(r, 2, r.stderr + r.stdout);
  assert.equal(r.json.error, 'no-code-change');
  assert.match(r.json.message, /identical to what round 1 reviewed/, 'judged on a fresh base, not on main\'s new commits');
  assert.ok(!w.item().implemented);
});

// ---- no remote / unreachable remote ---------------------------------------------------------------

test('no origin remote at all: review-complete and mark-implemented run on the cached (local) base as before', (t) => {
  const w = world(t, { withOrigin: false, accept: true });
  const nope = w.cli(['state', 'mark-implemented', '--ids', 'R1-B1']);
  assertExit(nope, 2, nope.stdout);
  assert.equal(nope.json.error, 'no-code-change');

  w.repo.write('src/a.js', aFile(true).replace('compute(x.y)', 'compute(x?.y)'));
  const fixed = w.repo.commit('fix');
  assertExit(w.cli(['state', 'mark-implemented', '--ids', 'R1-B1']), 0);
  assert.ok(w.item().implemented);
  assertExit(w.codex(2, findingsOf(), { from: w.head, to: fixed }), 0);
  w.prHead(fixed);
  const r = w.cli(['review-complete', '--pr', '7']);
  assertExit(r, 0, r.stderr + r.stdout);
});

test('origin is unreachable: review-complete still answers from the cached ref, mark-implemented exits 3 base-refresh and marks nothing', (t) => {
  const w = world(t, { accept: true });
  w.repo.git(['remote', 'set-url', 'origin', join(w.scratch, 'does-not-exist.git')]);

  // best effort: the cached origin/main is the very base the round was hashed against. (the accept is unfixed, so it stays refused
  // on the item, not on the coverage; a clean state would pass)
  const o = w.cli(['state', 'outcome']);
  assertExit(o, 0, o.stderr + o.stdout);
  assert.equal(o.json.coverageValid, true);

  const before = readFileSync(join(w.repo.dir, '.review', 'state.json'), 'utf8');
  const r = w.cli(['state', 'mark-implemented', '--ids', 'R1-B1']);
  assertExit(r, 3, r.stderr + r.stdout);
  assert.deepEqual([r.json.ok, r.json.unavailable, r.json.reason], [false, true, 'base-refresh']);
  assert.match(r.json.message, /origin\/main could not be refreshed/);
  assert.equal(readFileSync(join(w.repo.dir, '.review', 'state.json'), 'utf8'), before, 'nothing marked');
  assert.ok(!w.item().implemented);
});

test('origin is unreachable and the content has no covering round: review-complete says origin/main could not be refreshed; with a covering round it passes', (t) => {
  const w = world(t);
  w.repo.git(['remote', 'set-url', 'origin', join(w.scratch, 'does-not-exist.git')]);
  w.prHead(w.head);
  // A fixture clone made by hand has no refs/remotes/origin/HEAD, so with the remote unreachable nothing anchors the default branch except the working tree's own config, which a PR can edit (#377, S1):
  // the base config is untrusted, the PR needs the Fable pass and the substitute is off. That is intended, not a regression of the cached-ref behaviour.
  const unanchored = w.cli(['review-complete', '--pr', '7']);
  assertExit(unanchored, 1, unanchored.stderr + unanchored.stdout);
  assert.match(unanchored.json.reason, /needs the Fable review pass.*could not be anchored on the remote/);
  // A real clone has origin/HEAD (git clone sets it): that cached anchor is a source a PR cannot edit, so the cached-ref behaviour below holds offline.
  w.repo.git(['remote', 'set-head', 'origin', 'main']);
  const ok = w.cli(['review-complete', '--pr', '7']);
  assertExit(ok, 0, ok.stderr + ok.stdout);

  w.repo.write('src/b.js', 'export const b = 1;\n');
  w.prHead(w.repo.commit('unreviewed change'));
  const r = w.cli(['review-complete', '--pr', '7']);
  assertExit(r, 1, r.stderr + r.stdout);
  assert.match(r.json.reason, /no review round covers the current content/);
  assert.match(r.json.reason, /origin\/main could not be refreshed: /);
});

test('no origin remote but a leftover origin/main ref and a newer main merged in: mark-implemented exits 3 base-refresh, the unfixed item stays unmarked', (t) => {
  const w = world(t, { accept: true });
  w.mainMovesOn();
  w.updateBranch(); // local origin/main is stale
  w.repo.git(['config', '--remove-section', 'remote.origin']); // the remote is gone, refs/remotes/origin/main is left over
  assert.ok(w.repo.git(['rev-parse', '--verify', 'refs/remotes/origin/main']).trim());

  const r = w.cli(['state', 'mark-implemented', '--ids', 'R1-B1']);
  assertExit(r, 3, r.stderr + r.stdout);
  assert.equal(r.json.reason, 'base-refresh');
  assert.ok(!w.item().implemented);
  assert.equal(existsSync(join(w.repo.dir, '.review', 'state.json')), true);
});
