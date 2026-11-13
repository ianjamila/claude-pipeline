// review-complete releases a merge hold left on a DRAFT PR (a redraft whose release was not confirmed), for a repo with ci.draft_while_iterating and the merge.hold_* keys,
// before the PR is marked ready; the pipeline's own update-branch successor keeps its hold; a release still unconfirmed after one retry is exit 1 hold-unreleased.
// A ready PR and a repo without the flags are never touched. Same world as review-complete-behind-base.test.mjs plus the fake hold provider.
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
import { FAKE_HOLD, HOLD_KEYS, holdCalls } from './helpers/merge-hold-env.mjs';
import { RELEASE_REASONS, recordSuccessor } from '../pipeline/lib/merge-hold.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const bin = join(here, '..', 'pipeline', 'bin', 'pipeline.mjs');
const fakeCodex = join(here, 'fixtures', 'fake-codex.mjs');

// The release exits 1 the first FAKE_HOLD_RELEASE_FAILS times it is called, then 0.
const FLAKY_HOLD = FAKE_HOLD.replace("if (verb === 'release') { console.log('hold released'); exit('FAKE_HOLD_RELEASE_EXIT'); }",
  "if (verb === 'release') { const n = readFileSync(log, 'utf8').split('\\n').filter((l) => l.startsWith('release')).length; console.log('hold released'); process.exit(n <= Number(process.env.FAKE_HOLD_RELEASE_FAILS ?? 0) ? 1 : 0); }");
const FROM = 'a'.repeat(40);
const BASE = '9'.repeat(40);

const aFile = (changed) => Array.from({ length: 30 }, (_, i) => {
  const n = i + 1;
  return n === 12 && changed ? 'export const v12 = compute(x.y);' : `export const v${n} = ${n};`;
}).join('\n') + '\n';

const queueReply = (enabled) => ({ match: 'QueueState', stdoutJson: { data: { repository: { pullRequest: { id: 'PR_node7', state: 'OPEN', headRefOid: 'x', isMergeQueueEnabled: enabled, mergeCommit: null, mergeQueueEntry: null } } } } });

// A PR repo whose "origin" is a bare repository, on feat/x (src/a.js changed, one 60-line file), with round 1 recorded clean.
// `view` overrides what `gh pr view 7` answers (isDraft, mergeable); `disjoint` puts merge.behind_base: disjoint in the base's config.
function world(t, { view = {}, queue = false, iterating = true, holds = true } = {}) {
  const repo = createTmpRepo();
  t.after(() => repo.cleanup());
  const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), 'cp-rcbehind-')));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const originDir = join(scratch, 'origin.git');
  const git = (cwd, args) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
    return r.stdout;
  };
  repo.write('.claude/pipeline.yml', pipelineYml().replace('  guard_checks: false\n', `  guard_checks: false\n  draft_while_iterating: ${iterating}\n`) + `merge:\n  command: node scripts/fake-merge.mjs {pr} {sha}\n  wait_minutes: 1\n${holds ? `${HOLD_KEYS}\n` : ''}`);
  repo.write('scripts/fake-hold.mjs', FLAKY_HOLD);
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
    { match: `commits/${prHead} --jq`, stdoutJson: [FROM, BASE] },
  ];
  const fake = createFakeGh(script(head, view));
  const lockDir = join(scratch, 'locks');
  const w = {
    repo, head, fake,
    prHead: (sha) => fake.setScript(script(sha, view)),
    cli(args, env = {}) {
      const r = spawnSync(process.execPath, [bin, ...args], {
        cwd: repo.dir, encoding: 'utf8',
        env: { ...process.env, ...fake.env, PIPELINE_CODEX: `node "${fakeCodex}"`, PIPELINE_LOCK_DIR: lockDir, PIPELINE_REDRAFT_PAUSE_MS: '1', ...env },
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


const released = (w) => holdCalls({ repo: w.repo });
const posted = (w) => w.fake.lines().filter((l) => /^api -X POST .*issues\/7\/comments /.test(l));

test('review-complete: a draft with a leftover hold has it released (reason redraft) before the marker is posted', (t) => {
  const w = world(t);
  const r = w.cli(['review-complete', '--pr', '7']);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.equal(r.json.holdRelease.confirmed, true);
  assert.equal(r.json.holdRelease.attempts, 1);
  assert.deepEqual(released(w), [`release 7 ${RELEASE_REASONS.redraft}`]);
  assert.equal(r.json.posted, true, "the marker is posted after the release");
});

test('review-complete: a draft on the pipeline\'s own update-branch successor keeps its hold (no release call)', (t) => {
  const w = world(t);
  recordSuccessor(w.repo.dir, 7, { from: FROM, to: w.head, baseSha: BASE });
  const r = w.cli(['review-complete', '--pr', '7']);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.equal('holdRelease' in r.json, false);
  assert.deepEqual(released(w), []);
  assert.equal(r.json.posted, true, "the marker is posted after the release");
});

test('review-complete: a release that fails once is retried and confirmed; one unconfirmed twice is exit 1 hold-unreleased and nothing is posted', (t) => {
  const once = world(t);
  const a = once.cli(['review-complete', '--pr', '7'], { FAKE_HOLD_RELEASE_FAILS: '1' });
  assertExit(a, 0, a.stderr + a.stdout);
  assert.equal(a.json.holdRelease.attempts, 2);
  assert.equal(released(once).length, 2);

  const twice = world(t);
  const b = twice.cli(['review-complete', '--pr', '7'], { FAKE_HOLD_RELEASE_FAILS: '2' });
  assertExit(b, 1, b.stderr + b.stdout);
  assert.equal(b.json.ok, false);
  assert.equal(b.json.error, 'hold-unreleased');
  assert.match(b.json.reason, /NOT released/);
  assert.match(b.json.reason, /merge-hold --pr 7 --release --reason redraft` again/);
  assert.equal(b.json.holdRelease.confirmed, false);
  assert.equal(b.json.holdRelease.attempts, 2);
  assert.deepEqual(posted(twice), []);
  assert.deepEqual(twice.fake.lines().filter((l) => l.startsWith('pr edit ')), []);
});

test('review-complete: a READY PR, a repo that does not iterate in draft and a repo without hold keys release nothing', (t) => {
  const ready = world(t, { view: { isDraft: false } });
  assertExit(ready.cli(['review-complete', '--pr', '7']), 0);
  assert.deepEqual(released(ready), [], 'ready PR');

  const off = world(t, { iterating: false });
  assertExit(off.cli(['review-complete', '--pr', '7']), 0);
  assert.deepEqual(released(off), [], 'draft_while_iterating off');

  const none = world(t, { holds: false });
  assertExit(none.cli(['review-complete', '--pr', '7']), 0);
  assert.deepEqual(released(none), [], 'no merge.hold_* keys');
});
