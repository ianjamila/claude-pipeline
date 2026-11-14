// review-complete refuses a DRAFT PR whose head lacks commits of origin/<default_branch>, so the review skill catches the PR up to its base
// BEFORE it is marked ready and CI runs once, on current main (cp #254 ran its ~20 min CI twice: the merge dry run only sees behind-base after CI).
// A ready PR is never refused (the merge flow handles it); an offline refresh, a merge queue and an unreadable ancestry only warn.
// Real git (a bare "origin" and a second clone that moves main), the real CLI, a scripted fake gh and fake codex (as review-complete-fetch.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTmpRepo } from './helpers/tmprepo.mjs';
import { createFakeGh, pipelineYml, REPO_VIEW } from './helpers/fakegh-env.mjs';
import { assertExit } from './helpers/assert-exit.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const bin = join(here, '..', 'pipeline', 'bin', 'pipeline.mjs');
const fakeCodex = join(here, 'fixtures', 'fake-codex.mjs');

const aFile = (changed) => Array.from({ length: 30 }, (_, i) => {
  const n = i + 1;
  return n === 12 && changed ? 'export const v12 = compute(x.y);' : `export const v${n} = ${n};`;
}).join('\n') + '\n';

const queueReply = (enabled) => ({ match: 'QueueState', stdoutJson: { data: { repository: { pullRequest: { id: 'PR_node7', state: 'OPEN', headRefOid: 'x', isMergeQueueEnabled: enabled, mergeCommit: null, mergeQueueEntry: null } } } } });

// A PR repo whose "origin" is a bare repository, on feat/x (src/a.js changed, one 60-line file), with round 1 recorded clean.
// `view` overrides what `gh pr view 7` answers (isDraft, mergeable); `disjoint` puts merge.behind_base: disjoint in the base's config.
function world(t, { view = {}, queue = false, disjoint = false } = {}) {
  const repo = createTmpRepo({ highEffort: true });
  t.after(() => repo.cleanup());
  const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), 'cp-rcbehind-')));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const originDir = join(scratch, 'origin.git');
  const git = (cwd, args) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
    return r.stdout;
  };
  repo.write('.claude/pipeline.yml', pipelineYml() + (disjoint ? 'merge:\n  behind_base: disjoint\n' : ''));
  repo.write('.gitignore', '.review/\n');
  repo.write('src/a.js', aFile(false));
  const base = repo.commit('init');
  git(scratch, ['init', '-q', '--bare', '-b', 'main', originDir]);
  repo.git(['remote', 'add', 'origin', originDir]);
  repo.git(['push', '-q', 'origin', 'main']);
  repo.git(['fetch', '-q', 'origin']);
  repo.branch('feat/x');
  repo.write('src/a.js', aFile(true));
  repo.write('src/big.js', Array.from({ length: 60 }, (_, i) => `export const big${i} = ${i};`).join('\n') + '\n');
  const head = repo.commit('feature');

  const script = (prHead, v) => [
    { match: '^pr view 7', stdoutJson: { title: 'Add compute', body: 'Adds compute()', headRefName: 'feat/x', baseRefName: 'main', headRefOid: prHead, isDraft: true, mergeable: 'MERGEABLE', ...v } },
    { match: '^repo view', stdoutJson: REPO_VIEW },
    { match: '^pr edit 7 --remove-label awaiting-review', code: 0 },
    { match: '^api user', stdout: 'me\n' },
    { match: 'issues/7/comments --paginate', stdoutJson: [] },
    { match: '^api -X POST repos/acme/widgets/issues/7/comments ', stdoutJson: { id: 77, html_url: 'https://github.com/acme/widgets/pull/7#issuecomment-77' } },
    queueReply(queue),
  ];
  const fake = createFakeGh(script(head, view));
  const lockDir = join(scratch, 'locks');
  const w = {
    repo, head, fake,
    prHead: (sha) => fake.setScript(script(sha, view)),
    cli(args) {
      const r = spawnSync(process.execPath, [bin, ...args], {
        cwd: repo.dir, encoding: 'utf8',
        env: { ...process.env, ...fake.env, PIPELINE_CODEX: `node "${fakeCodex}"`, PIPELINE_LOCK_DIR: lockDir },
      });
      let json = null;
      try { json = r.stdout ? JSON.parse(r.stdout) : null; } catch { /* the assertion on json will say so */ }
      return { code: r.status, json, stdout: r.stdout, stderr: r.stderr };
    },
    mainMovesOn(file = 'src/from-main.js') {
      const other = join(scratch, `other-${Math.random().toString(36).slice(2, 8)}`);
      git(scratch, ['clone', '-q', originDir, other]);
      for (const [k, v] of [['user.name', 'Other'], ['user.email', 'other@example.invalid'], ['commit.gpgsign', 'false']]) git(other, ['config', k, v]);
      writeFileSync(join(other, file), 'export const other = 1;\n');
      git(other, ['add', '-A']);
      git(other, ['commit', '-q', '-m', 'main moves on']);
      git(other, ['push', '-q', 'origin', 'main']);
    },
    // "Update branch" + `git pull --ff-only`: the PR branch gets main's new commit (fetched by URL so origin/main is not refreshed).
    updateBranch() {
      repo.git(['fetch', '-q', originDir, '+refs/heads/main:refs/tmp/main']);
      repo.git(['merge', '--no-ff', '-q', '-m', 'Merge branch main into feat/x', 'refs/tmp/main']);
      repo.git(['update-ref', '-d', 'refs/tmp/main']);
      return repo.git(['rev-parse', 'HEAD']).trim();
    },
    posted: () => fake.lines().filter((l) => /^api -X POST .*issues\/7\/comments /.test(l)),
    edits: () => fake.lines().filter((l) => l.startsWith('pr edit ')),
  };
  const out = join(scratch, 'findings-1.json');
  writeFileSync(out, JSON.stringify({ summary: 'Reviewed.', blocking: [], suggestions: [], worth_considering: [] }));
  const r = spawnSync(process.execPath, [bin, 'codex-review', '--pr', '7', '--round', '1', '--base', base, '--head', head, '--effort', 'high'], {
    cwd: repo.dir, encoding: 'utf8',
    env: { ...process.env, ...fake.env, PIPELINE_CODEX: `node "${fakeCodex}"`, PIPELINE_LOCK_DIR: lockDir, FAKE_CODEX_OUTPUT: out },
  });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  return w;
}

test('review-complete: a draft that lacks commits of main is refused (behind-base), nothing is posted, labels stay', (t) => {
  const w = world(t);
  w.mainMovesOn();
  const r = w.cli(['review-complete', '--pr', '7']);
  assertExit(r, 1, r.stderr + r.stdout);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.reason, 'behind-base');
  assert.equal(r.json.error, 'behind-base');
  assert.equal(r.json.base, 'main');
  assert.equal(r.json.behindBy, 1);
  assert.match(r.json.remedy, /update-branch --pr 7/);
  assert.match(r.json.remedy, /git pull --ff-only/);
  assert.match(r.json.remedy, /codex-review/);
  assert.match(r.json.remedy, /review-complete/);
  assert.deepEqual(w.posted(), []);
  assert.deepEqual(w.edits(), []);
});

test('review-complete: a draft that is up to date with main posts as before', (t) => {
  const w = world(t);
  w.mainMovesOn();
  w.prHead(w.updateBranch());
  const r = w.cli(['review-complete', '--pr', '7']);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.equal(r.json.posted, true);
  assert.equal(r.json.warnings, undefined);
  assert.ok(w.posted().length >= 1, 'the marker comment was posted');
});

test('review-complete: a READY PR that lacks commits of main still posts (the merge flow handles behind-base)', (t) => {
  const w = world(t, { view: { isDraft: false } });
  w.mainMovesOn();
  const r = w.cli(['review-complete', '--pr', '7']);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.equal(r.json.posted, true);
  assert.equal(r.json.warnings, undefined);
});

test('review-complete: a behind draft whose base has a merge queue posts, with a warning', (t) => {
  const w = world(t, { queue: true });
  w.mainMovesOn();
  const r = w.cli(['review-complete', '--pr', '7']);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.equal(r.json.posted, true);
  assert.equal(r.json.warnings.length, 1);
  assert.match(r.json.warnings[0], /merge queue/);
});

test('review-complete: a behind draft whose queue state cannot be read posts, with a warning (never blocks)', (t) => {
  const w = world(t);
  w.mainMovesOn();
  w.fake.setScript([
    { match: '^pr view 7', stdoutJson: { title: 't', body: 'b', headRefName: 'feat/x', baseRefName: 'main', headRefOid: w.head, isDraft: true, mergeable: 'MERGEABLE' } },
    { match: '^repo view', stdoutJson: REPO_VIEW },
    { match: '^pr edit 7 --remove-label awaiting-review', code: 0 },
    { match: '^api user', stdout: 'me\n' },
    { match: 'issues/7/comments --paginate', stdoutJson: [] },
    { match: '^api -X POST repos/acme/widgets/issues/7/comments ', stdoutJson: { id: 77, html_url: 'https://github.com/acme/widgets/pull/7#issuecomment-77' } },
    { match: 'QueueState', code: 1, stderr: 'gh: Server Error (HTTP 502)' },
  ]);
  const r = w.cli(['review-complete', '--pr', '7']);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.equal(r.json.posted, true);
  assert.match(r.json.warnings[0], /merge queue/);
});

test('review-complete: a behind draft whose base ref could not be refreshed (offline) posts, with a warning', (t) => {
  const w = world(t);
  w.mainMovesOn();
  w.repo.git(['fetch', '-q', 'origin']); // the cached origin/main is already behind-making ...
  // A real clone has origin/HEAD (git clone sets it); this hand-made fixture does not. Without that cached anchor an offline run
  // cannot anchor the default branch at all, and the PR needs the Fable pass (#377, S1: covered in review-complete-fetch.test.mjs).
  w.repo.git(['remote', 'set-head', 'origin', 'main']);
  w.repo.git(['remote', 'set-url', 'origin', join(tmpdir(), 'cp-rcbehind-does-not-exist.git')]); // ... and the refresh fails
  const r = w.cli(['review-complete', '--pr', '7']);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.equal(r.json.posted, true);
  assert.equal(r.json.warnings.length, 1);
  assert.match(r.json.warnings[0], /could not be refreshed/);
});

// ---- merge.behind_base: disjoint (the base's own config; the helper is finalgate.behindFreshEnough, the one the merge path uses) ----

test('review-complete (behind_base: disjoint): a draft behind only by files the PR does not touch posts', (t) => {
  const w = world(t, { disjoint: true });
  w.mainMovesOn('src/from-main.js');
  const r = w.cli(['review-complete', '--pr', '7']);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.equal(r.json.posted, true);
});

test('review-complete (behind_base: disjoint): a draft behind by a file the PR also touches is refused', (t) => {
  const w = world(t, { disjoint: true });
  w.mainMovesOn('src/a.js');
  const r = w.cli(['review-complete', '--pr', '7']);
  assertExit(r, 1, r.stderr + r.stdout);
  assert.equal(r.json.error, 'behind-base');
  assert.deepEqual(w.posted(), []);
});

test('review-complete (behind_base: disjoint): a refusal carries the helper\'s reason as detail', (t) => {
  const w = world(t, { disjoint: true });
  w.mainMovesOn('src/a.js');
  const r = w.cli(['review-complete', '--pr', '7']);
  assertExit(r, 1, r.stderr + r.stdout);
  assert.equal(r.json.error, 'behind-base');
  assert.match(r.json.detail, /changed 1 file\(s\) this PR also touches \(src\/a\.js\)/);
});

test('review-complete (behind_base: disjoint): mergeable UNKNOWN (GitHub has not recomputed yet) on a disjoint draft posts, with a warning', (t) => {
  const w = world(t, { disjoint: true, view: { mergeable: 'UNKNOWN' } });
  w.mainMovesOn('src/from-main.js');
  const r = w.cli(['review-complete', '--pr', '7']);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.equal(r.json.posted, true);
  assert.equal(r.json.warnings.length, 1);
  assert.match(r.json.warnings[0], /behind-base check skipped/);
  assert.match(r.json.warnings[0], /mergeability/);
});

test('review-complete (behind_base: disjoint): mergeable UNKNOWN does not hide a real overlap: still refused, with the overlap as detail', (t) => {
  const w = world(t, { disjoint: true, view: { mergeable: 'UNKNOWN' } });
  w.mainMovesOn('src/a.js');
  const r = w.cli(['review-complete', '--pr', '7']);
  assertExit(r, 1, r.stderr + r.stdout);
  assert.equal(r.json.error, 'behind-base');
  assert.match(r.json.detail, /also touches/);
  assert.deepEqual(w.posted(), []);
});

test('review-complete (behind_base: disjoint): mergeable CONFLICTING is refused (behind-base), with GitHub\'s answer as detail', (t) => {
  const w = world(t, { disjoint: true, view: { mergeable: 'CONFLICTING' } });
  w.mainMovesOn('src/from-main.js');
  const r = w.cli(['review-complete', '--pr', '7']);
  assertExit(r, 1, r.stderr + r.stdout);
  assert.equal(r.json.error, 'behind-base');
  assert.match(r.json.detail, /"CONFLICTING", not MERGEABLE/);
  assert.deepEqual(w.posted(), []);
});

test('review-complete (default behind_base: update): mergeable UNKNOWN still refuses a behind draft (the warning is only for a check that could not be made)', (t) => {
  const w = world(t, { view: { mergeable: 'UNKNOWN' } });
  w.mainMovesOn();
  const r = w.cli(['review-complete', '--pr', '7']);
  assertExit(r, 1, r.stderr + r.stdout);
  assert.equal(r.json.error, 'behind-base');
  assert.ok(r.json.detail, 'the helper reason is carried');
  assert.deepEqual(w.posted(), []);
});
