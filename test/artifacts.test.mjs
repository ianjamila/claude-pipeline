// artifacts push: real git with a bare origin, so the orphan-branch creation, the temp worktree, the push target and the
// "caller's checkout is never touched" promise are all proven against actual git, not a mock.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, symlinkSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTmpRepo } from './helpers/tmprepo.mjs';
import { createFakeGh, REPO_VIEW } from './helpers/fakegh-env.mjs';
import { git as gitRun } from '../pipeline/lib/git.mjs';
import { run as procRun } from '../pipeline/lib/proc.mjs';
import {
  ARTIFACTS_BRANCH, MAX_BYTES, MAX_FILES, assertSafeTarget, markdownFor, publishArtifacts, selectImages,
} from '../pipeline/commands/artifacts.mjs';

const bin = join(dirname(fileURLToPath(import.meta.url)), '..', 'pipeline', 'bin', 'pipeline.mjs');

const scratch = [];
const tmp = (prefix = 'cp-artifacts-test-') => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(d);
  return d;
};
after(() => scratch.forEach((d) => rmSync(d, { recursive: true, force: true, maxRetries: 3 })));

const PNG = Buffer.from('89504e470d0a1a0a', 'hex');
const raw = (args, cwd) => {
  const r = procRun('git', args, { cwd, env: { GIT_DIR: undefined, GIT_INDEX_FILE: undefined } });
  if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
};

function world() {
  const repo = createTmpRepo();
  const bare = tmp('cp-origin-');
  raw(['init', '--bare', '-q', '-b', 'main', bare], repo.dir);
  repo.write('app.txt', 'v1\n');
  repo.commit('init');
  repo.git(['remote', 'add', 'origin', bare]);
  repo.git(['push', '-q', '-u', 'origin', 'main']);
  const images = tmp('cp-images-');
  const put = (name, content = PNG) => writeFileSync(join(images, name), content);
  const fake = createFakeGh([{ match: '^repo view', stdoutJson: REPO_VIEW }]);
  const cli = (args, { cwd = repo.dir } = {}) => {
    const r = spawnSync(process.execPath, [bin, 'artifacts', ...args], { cwd, env: { ...process.env, ...fake.env }, encoding: 'utf8' });
    return { code: r.status, json: r.stdout ? JSON.parse(r.stdout) : null, stderr: r.stderr };
  };
  const onOrigin = (...args) => repo.git(['--git-dir', bare, ...args]);
  const tree = () => onOrigin('ls-tree', '-r', '--name-only', ARTIFACTS_BRANCH).split('\n').filter(Boolean);
  // Everything about the caller's checkout that a push must not change.
  const snapshot = () => ({
    head: repo.git(['rev-parse', 'HEAD']),
    branch: repo.git(['symbolic-ref', 'HEAD']),
    index: repo.git(['ls-files', '-s']),
    status: repo.git(['status', '--porcelain']),
    refs: repo.git(['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads']),
    worktrees: repo.git(['worktree', 'list', '--porcelain']),
  });
  return { repo, bare, images, put, fake, cli, onOrigin, tree, snapshot };
}

test('first push creates the orphan branch with pr-7/a.png, returns the markdown, and leaves the caller\'s checkout untouched', () => {
  const w = world();
  w.put('a.png');
  w.put('notes.txt', 'not an image');
  const mainBefore = w.onOrigin('rev-parse', 'main');
  const before = w.snapshot();

  const r = w.cli(['push', '--pr', '7', '--dir', w.images]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.ok, true);
  assert.deepEqual(r.json.files, [{ name: 'a.png', markdown: '![a.png](https://github.com/acme/widgets/blob/pipeline-artifacts/pr-7/a.png?raw=true)' }]);
  assert.deepEqual(r.json.skipped, [{ name: 'notes.txt', reason: 'not an image (png, jpg, jpeg, webp, gif)' }]);
  assert.equal(r.json.pushed, true);

  assert.deepEqual(w.tree(), ['pr-7/a.png']);
  assert.equal(w.onOrigin('log', '-1', '--format=%s', ARTIFACTS_BRANCH).trim(), 'artifacts for #7');
  const tip = w.onOrigin('rev-parse', ARTIFACTS_BRANCH).trim();
  assert.equal(w.onOrigin('rev-list', '--max-parents=0', ARTIFACTS_BRANCH).trim(), tip, 'an orphan: the first commit has no parent');
  assert.equal(r.json.commit, tip);
  assert.equal(w.onOrigin('rev-parse', 'main'), mainBefore, 'the default branch is never written');

  assert.deepEqual(w.snapshot(), before, 'HEAD, index, status, local branches and worktrees are all unchanged');
  assert.equal(w.repo.git(['branch', '--list', 'pipeline-artifacts*']).trim(), '', 'no stray local branch');
});

test('the published bytes are the file bytes', () => {
  const w = world();
  const bytes = Buffer.from([0, 1, 2, 3, 250, 251, 252, 253, 254, 255]);
  w.put('bin.png', bytes);
  assert.equal(w.cli(['push', '--pr', '3', '--dir', w.images]).code, 0);
  const out = spawnSync('git', ['--git-dir', w.bare, 'cat-file', 'blob', `${ARTIFACTS_BRANCH}:pr-3/bin.png`]);
  assert.deepEqual(out.stdout, bytes);
});

test('a second push adds files on top of the first (and other PRs live side by side); an identical re-push is a no-op', () => {
  const w = world();
  w.put('a.png');
  assert.equal(w.cli(['push', '--pr', '7', '--dir', w.images]).code, 0);
  const first = w.onOrigin('rev-parse', ARTIFACTS_BRANCH).trim();
  const before = w.snapshot();

  w.put('b.jpg');
  const second = w.cli(['push', '--pr', '7', '--dir', w.images]);
  assert.equal(second.code, 0, second.stderr);
  assert.deepEqual(second.json.files.map((f) => f.name), ['a.png', 'b.jpg']);
  assert.deepEqual(w.tree(), ['pr-7/a.png', 'pr-7/b.jpg']);
  assert.equal(w.onOrigin('rev-parse', `${ARTIFACTS_BRANCH}~1`).trim(), first, 'a normal fast-forward commit, history kept');
  assert.equal(w.onOrigin('rev-list', '--count', ARTIFACTS_BRANCH).trim(), '2');

  const other = tmp('cp-images-');
  writeFileSync(join(other, 'c.webp'), PNG);
  assert.equal(w.cli(['push', '--pr', '8', '--dir', other]).code, 0);
  assert.deepEqual(w.tree(), ['pr-7/a.png', 'pr-7/b.jpg', 'pr-8/c.webp']);

  const again = w.cli(['push', '--pr', '8', '--dir', other]);
  assert.equal(again.json.pushed, false);
  assert.equal(w.onOrigin('rev-list', '--count', ARTIFACTS_BRANCH).trim(), '3', 'nothing new, nothing committed');
  assert.deepEqual(w.snapshot(), before);
});

test('only images are published: other files, dotfiles, directories and symlinks are skipped (and reported)', { skip: process.platform === 'win32' }, () => {
  const w = world();
  for (const name of ['ok.png', 'ok2.JPG', 'ok3.jpeg', 'ok4.webp', 'ok5.gif']) w.put(name);
  for (const name of ['data.json', 'README.md', 'shot.png.bak', '.hidden.png', 'png']) w.put(name, 'x');
  mkdirSync(join(w.images, 'dir.png'));
  writeFileSync(join(w.repo.dir, 'secret.txt'), 'do not publish');
  symlinkSync(join(w.repo.dir, 'secret.txt'), join(w.images, 'link.png'));

  const r = w.cli(['push', '--pr', '5', '--dir', w.images]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.json.files.map((f) => f.name), ['ok.png', 'ok2.JPG', 'ok3.jpeg', 'ok4.webp', 'ok5.gif']);
  assert.deepEqual(w.tree(), ['pr-5/ok.png', 'pr-5/ok2.JPG', 'pr-5/ok3.jpeg', 'pr-5/ok4.webp', 'pr-5/ok5.gif']);
  const reasons = Object.fromEntries(r.json.skipped.map((s) => [s.name, s.reason]));
  assert.match(reasons['link.png'], /not a regular file/);
  assert.match(reasons['dir.png'], /not a regular file/);
  assert.match(reasons['.hidden.png'], /not an image/);
  assert.match(reasons['data.json'], /not an image/);
});

test('size and count caps: a file over 5 MB is skipped, exactly 5 MB is kept, at most 20 files are published', () => {
  const dir = tmp('cp-images-');
  writeFileSync(join(dir, 'big.png'), Buffer.alloc(MAX_BYTES + 1));
  writeFileSync(join(dir, 'edge.png'), Buffer.alloc(MAX_BYTES));
  const small = selectImages(dir);
  assert.deepEqual(small.files.map((f) => f.name), ['edge.png']);
  assert.match(small.skipped[0].reason, /larger than 5 MB/);

  const many = tmp('cp-images-');
  for (let i = 0; i < 22; i += 1) writeFileSync(join(many, `s${String(i).padStart(2, '0')}.png`), PNG);
  const capped = selectImages(many);
  assert.equal(capped.files.length, MAX_FILES);
  assert.deepEqual(capped.skipped.map((s) => s.name), ['s20.png', 's21.png']);
  assert.match(capped.skipped[0].reason, /20-file limit/);
});

test('size cap, end to end: the oversize file never reaches origin', () => {
  const w = world();
  w.put('big.png', Buffer.alloc(MAX_BYTES + 1));
  w.put('small.png');
  const r = w.cli(['push', '--pr', '2', '--dir', w.images]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(w.tree(), ['pr-2/small.png']);
  assert.equal(r.json.skipped.length, 1);
});

test('the push target is asserted: only refs/heads/pipeline-artifacts, never main or master', () => {
  assert.equal(assertSafeTarget('refs/heads/pipeline-artifacts'), 'refs/heads/pipeline-artifacts');
  for (const bad of ['refs/heads/main', 'refs/heads/master', 'main', 'refs/heads/pipeline-artifacts2', 'pipeline-artifacts', '', undefined]) {
    assert.throws(() => assertSafeTarget(bad), /refusing to push artifacts/, String(bad));
  }
});

test('the real push is HEAD:refs/heads/pipeline-artifacts and nothing else, from a temp worktree that is cleaned up', () => {
  const w = world();
  w.put('a.png');
  const seen = [];
  const base = tmp('cp-tmpbase-');
  const gitFn = (args, o) => { seen.push({ args, cwd: o.cwd }); return gitRun(args, o); };
  const r = publishArtifacts({ root: w.repo.dir, pr: 7, files: selectImages(w.images).files, gitFn, tmpBase: base });
  assert.equal(r.pushed, true);

  const pushes = seen.filter((c) => c.args[0] === 'push');
  assert.equal(pushes.length, 1);
  assert.deepEqual(pushes[0].args, ['push', '--no-verify', 'origin', 'HEAD:refs/heads/pipeline-artifacts']);
  assert.notEqual(pushes[0].cwd, w.repo.dir, 'pushed from the temp worktree, not the caller\'s checkout');
  assert.ok(!seen.some((c) => c.cwd === w.repo.dir && ['commit', 'add', 'checkout', 'reset', 'rm'].includes(c.args[0])), 'the caller\'s checkout is never written');
  assert.deepEqual(readdirSync(base), [], 'the temp directory is removed');
  assert.equal(w.repo.git(['worktree', 'list', '--porcelain']).match(/^worktree /gm).length, 1);
});

test('no images: {ok:true, files:[]} without touching git or GitHub', () => {
  const w = world();
  w.put('notes.txt', 'x');
  const r = w.cli(['push', '--pr', '7', '--dir', w.images]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.ok, true);
  assert.deepEqual(r.json.files, []);
  assert.deepEqual(w.fake.calls(), []);
  assert.equal(w.onOrigin('branch', '--list', ARTIFACTS_BRANCH).trim(), '');

  const empty = tmp('cp-images-');
  assert.deepEqual(w.cli(['push', '--pr', '7', '--dir', empty]).json.files, []);
  const missing = w.cli(['push', '--pr', '7', '--dir', join(empty, 'nope')]);
  assert.equal(missing.code, 0);
  assert.deepEqual(missing.json.files, []);
  assert.match(missing.json.warning, /no such directory/);
});

test('a lost push race (another pipeline pushed first) is retried on top of the new tip, keeping their files', () => {
  const w = world();
  w.put('a.png');
  const competitor = tmp('cp-competitor-');
  const compete = (name, { first }) => {
    const c = join(competitor, name);
    raw(['clone', '-q', w.bare, c], competitor);
    raw(['config', 'user.name', 'Other'], c);
    raw(['config', 'user.email', 'other@example.invalid'], c);
    raw(['config', 'commit.gpgsign', 'false'], c);
    raw(first ? ['checkout', '-q', '--orphan', ARTIFACTS_BRANCH] : ['checkout', '-q', ARTIFACTS_BRANCH], c);
    if (first) raw(['rm', '-rf', '--quiet', '--ignore-unmatch', '.'], c);
    mkdirSync(join(c, 'pr-1'), { recursive: true });
    writeFileSync(join(c, 'pr-1', `${name}.png`), PNG);
    raw(['add', '.'], c);
    raw(['commit', '-q', '-m', `competing ${name}`], c);
    raw(['push', '-q', 'origin', `HEAD:refs/heads/${ARTIFACTS_BRANCH}`], c);
  };

  // Race 1: the branch does not exist when we look, and another run creates it before our push.
  let raced = false;
  const gitFn = (args, o) => {
    if (args[0] === 'push' && !raced) { raced = true; compete('one', { first: true }); }
    return gitRun(args, o);
  };
  const files = selectImages(w.images).files;
  const r = publishArtifacts({ root: w.repo.dir, pr: 7, files, gitFn, tmpBase: tmp('cp-tmpbase-') });
  assert.equal(r.pushed, true);
  assert.equal(raced, true);
  assert.deepEqual(w.tree(), ['pr-1/one.png', 'pr-7/a.png']);

  // Race 2: the branch exists, and another run adds a commit between our fetch and our push.
  w.put('b.png');
  raced = false;
  const gitFn2 = (args, o) => {
    if (args[0] === 'push' && !raced) { raced = true; compete('two', { first: false }); }
    return gitRun(args, o);
  };
  publishArtifacts({ root: w.repo.dir, pr: 7, files: selectImages(w.images).files, gitFn: gitFn2, tmpBase: tmp('cp-tmpbase-') });
  assert.deepEqual(w.tree(), ['pr-1/one.png', 'pr-1/two.png', 'pr-7/a.png', 'pr-7/b.png']);
  assert.equal(w.snapshot().refs.includes('pipeline-artifacts'), false);
});

test('a non-race git failure (unreachable origin) is exit 2, with nothing left behind', () => {
  const w = world();
  w.put('a.png');
  w.repo.git(['remote', 'set-url', 'origin', join(tmpdir(), 'cp-definitely-not-a-repo')]);
  const before = w.snapshot();
  const r = w.cli(['push', '--pr', '7', '--dir', w.images]);
  assert.equal(r.code, 2);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.error, 'git');
  assert.deepEqual(w.snapshot(), before);
});

test('markdown: names are URL-encoded in the link and escaped in the alt text', () => {
  assert.equal(
    markdownFor({ slug: 'acme/widgets', pr: 3, name: 'my shot [1] (2).png' }),
    '![my shot \\[1\\] (2).png](https://github.com/acme/widgets/blob/pipeline-artifacts/pr-3/my%20shot%20%5B1%5D%20(2).png?raw=true)',
  );
});

test('usage errors exit 2: missing --pr or --dir, a bad PR number, an unknown subcommand', () => {
  const w = world();
  assert.equal(w.cli(['push', '--dir', w.images]).code, 2);
  assert.equal(w.cli(['push', '--pr', '7']).code, 2);
  assert.equal(w.cli(['push', '--pr', 'x', '--dir', w.images]).code, 2);
  assert.equal(w.cli(['push', '--pr', '0', '--dir', w.images]).code, 2);
  assert.equal(w.cli(['publish', '--pr', '7', '--dir', w.images]).code, 2);
  assert.equal(w.cli([]).code, 2);
});

test('a relative --dir is resolved from where the command was run', () => {
  const w = world();
  mkdirSync(join(w.repo.dir, 'shots'));
  writeFileSync(join(w.repo.dir, 'shots', 'rel.png'), PNG);
  const r = w.cli(['push', '--pr', '9', '--dir', 'shots']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(w.tree(), ['pr-9/rel.png']);
  assert.ok(readFileSync(join(w.repo.dir, 'shots', 'rel.png')).equals(PNG));
});
