import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { symlinkSync, rmSync, cpSync } from 'node:fs';
import {
  git, GitError, mergeBase, headSha, currentBranch, isClean, revParse, diffFiles, showFile, grepAtRef,
  commitTime, contentHash, treeFingerprint,
} from '../pipeline/lib/git.mjs';
import { createTmpRepo } from './helpers/tmprepo.mjs';

// A repo with `main` holding a few files, plus helpers bound to it.
function baseRepo() {
  const repo = createTmpRepo();
  repo.write('src/a.js', 'one\ntwo\nthree\n');
  repo.write('src/keep.js', 'keep\n');
  repo.write('docs/agent-log.md', '# log\n');
  const base = repo.commit('base');
  return { repo, base, o: { cwd: repo.dir } };
}

test('diffFiles: added/removed lines with line numbers, and a rename detected as R', () => {
  const { repo, o } = baseRepo();
  repo.write('big.txt', Array.from({ length: 30 }, (_, i) => `line ${i + 1}\n`).join(''));
  repo.commit('add big');
  repo.branch('feat');
  repo.write('src/a.js', 'one\nTWO\nthree\nfour\n');
  repo.git(['mv', 'src/keep.js', 'src/kept.js']);
  repo.write('fresh.txt', 'new\n');
  repo.rm('big.txt');
  repo.commit('change');

  const files = diffFiles('main', 'feat', o);
  const by = Object.fromEntries(files.map((f) => [f.path, f]));
  assert.deepEqual(Object.keys(by).sort(), ['big.txt', 'fresh.txt', 'src/a.js', 'src/kept.js']);

  assert.equal(by['src/a.js'].status, 'M');
  assert.deepEqual(by['src/a.js'].removed, [{ line: 2, text: 'two' }]);
  assert.deepEqual(by['src/a.js'].added, [{ line: 2, text: 'TWO' }, { line: 4, text: 'four' }]);

  assert.equal(by['fresh.txt'].status, 'A');
  assert.deepEqual(by['fresh.txt'].added, [{ line: 1, text: 'new' }]);

  assert.equal(by['big.txt'].status, 'D');
  assert.equal(by['big.txt'].removed.length, 30);
  assert.deepEqual(by['big.txt'].removed[29], { line: 30, text: 'line 30' });

  assert.equal(by['src/kept.js'].status, 'R');
  assert.equal(by['src/kept.js'].oldPath, 'src/keep.js');
  assert.equal(by['src/kept.js'].similarity, 100);
});

test('diffFiles uses the merge-base: unrelated commits that landed on main are not in the branch diff', () => {
  const { repo, o } = baseRepo();
  repo.branch('feat');
  repo.write('src/feature.js', 'feature\n');
  repo.commit('feature');
  repo.checkout('main');
  repo.write('unrelated.txt', 'main moved on\n');
  repo.commit('main advances');

  const files = diffFiles('main', 'feat', o);
  assert.deepEqual(files.map((f) => f.path), ['src/feature.js']);
  // a plain two-dot diff would have shown the unrelated file as DELETED; make sure that is what we avoided
  const twoDot = repo.git(['diff', '--name-status', 'main', 'feat']);
  assert.match(twoDot, /D\tunrelated\.txt/);
});

test('diffFiles survives hostile user config (noprefix, mnemonicPrefix, quotePath, renames, color, autocrlf)', () => {
  const { repo, o } = baseRepo();
  repo.write('with space.txt', 'spaced\n');
  repo.write('café.txt', 'accent\n');
  repo.write('old name.txt', Array.from({ length: 12 }, (_, i) => `row ${i}\n`).join(''));
  repo.commit('more files');
  repo.branch('feat');
  repo.write('src/a.js', 'one\ntwo\nthree\nfour\n');
  repo.write('with space.txt', 'spaced!\n');
  repo.write('café.txt', 'accent!\n');
  repo.git(['mv', 'old name.txt', 'renamed ñ.txt']);
  repo.write('new file.txt', 'n\n');
  repo.rm('src/keep.js');
  repo.commit('edits');

  for (const [k, v] of [
    ['diff.noprefix', 'true'], ['diff.mnemonicPrefix', 'true'], ['core.quotePath', 'false'],
    ['diff.renames', 'false'], ['color.ui', 'always'], ['color.diff', 'always'], ['core.autocrlf', 'true'],
  ]) repo.git(['config', k, v]);

  const files = diffFiles('main', 'feat', o);
  const by = Object.fromEntries(files.map((f) => [f.path, f]));
  assert.deepEqual(Object.keys(by).sort(), ['café.txt', 'new file.txt', 'renamed ñ.txt', 'src/a.js', 'src/keep.js', 'with space.txt']);
  assert.equal(by['src/a.js'].status, 'M');
  assert.deepEqual(by['src/a.js'].added, [{ line: 4, text: 'four' }]);
  assert.equal(by['café.txt'].status, 'M');
  assert.equal(by['with space.txt'].status, 'M');
  assert.equal(by['new file.txt'].status, 'A');
  assert.equal(by['src/keep.js'].status, 'D');
  assert.equal(by['renamed ñ.txt'].status, 'R');
  assert.equal(by['renamed ñ.txt'].oldPath, 'old name.txt');
});

test('showFile: content at an old ref, null when the path is absent there, GitError for a bad ref', () => {
  const { repo, base, o } = baseRepo();
  repo.write('src/a.js', 'changed\n');
  repo.write('later.txt', 'later\n');
  repo.commit('second');

  assert.equal(showFile(base, 'src/a.js', o), 'one\ntwo\nthree\n');
  assert.equal(showFile('HEAD', 'src/a.js', o), 'changed\n');
  assert.equal(showFile(base, 'later.txt', o), null); // not in the tree at that ref
  assert.equal(showFile('HEAD', 'later.txt', o), 'later\n');

  repo.write('only-on-disk.txt', 'x\n'); // "exists on disk, but not in 'HEAD'"
  assert.equal(showFile('HEAD', 'only-on-disk.txt', o), null);

  assert.throws(() => showFile('no-such-ref', 'src/a.js', o), (e) => e instanceof GitError && /invalid object name/.test(e.stderr));
});

test('grepAtRef: true when the string is in the tree at the ref, false when it is not', () => {
  const { repo, base, o } = baseRepo();
  repo.write('src/a.js', 'it.skip("later", () => {})\n');
  repo.commit('add skip');

  assert.equal(grepAtRef('HEAD', 'it.skip(', o), true);
  assert.equal(grepAtRef(base, 'it.skip(', o), false);
  assert.equal(grepAtRef('HEAD', 'two', o), false);
  assert.equal(grepAtRef(base, 'two', o), true);
  assert.equal(grepAtRef('HEAD', 'it.skip(.*)', o), false); // fixed string, never a regex
  assert.throws(() => grepAtRef('no-such-ref', 'x', o), GitError); // only exit 1 means "no match"
  assert.throws(() => grepAtRef('HEAD', 'a\nb', o), /single line/); // newline would silently become OR
});

test('contentHash: stable across a base update (merge of main), even when main edits the same file', () => {
  const { repo, o } = baseRepo();
  repo.write('src/long.js', Array.from({ length: 40 }, (_, i) => `const v${i + 1} = ${i + 1};\n`).join(''));
  repo.commit('long file on main');
  repo.branch('feat');
  repo.write('src/new-feature.js', 'export const f = 1;\n');
  repo.write('src/long.js', Array.from({ length: 40 }, (_, i) => (i === 29 ? 'const v30 = "changed";\n' : `const v${i + 1} = ${i + 1};\n`)).join(''));
  repo.commit('feature');
  const before = contentHash('main', 'feat', o);

  repo.checkout('main');
  repo.write('unrelated.txt', 'unrelated\n');
  repo.write('src/long.js', `// header added on main\n${repo.git(['show', 'main:src/long.js'])}`); // shifts every line of the file the branch edits
  repo.commit('main advances');
  repo.checkout('feat');
  repo.git(['merge', '--no-ff', '-q', '-m', 'merge main', 'main']);

  // the diff really did change shape: line numbers moved and the file is now based on main's new blob
  const shifted = repo.git(['diff', '-U0', 'main..feat', '--', 'src/long.js']);
  assert.match(shifted, /^@@ -31 \+31 @@/m);
  assert.equal(contentHash('main', 'feat', o), before);
});

test('contentHash: changes when "a b" becomes "ab" in a changed line', () => {
  const { repo, o } = baseRepo();
  repo.branch('with-space');
  repo.write('src/a.js', 'one\ntwo\nconst x = "a b";\n');
  repo.commit('with space');
  repo.checkout('main');
  repo.branch('no-space');
  repo.write('src/a.js', 'one\ntwo\nconst x = "ab";\n');
  repo.commit('no space');
  assert.notEqual(contentHash('main', 'with-space', o), contentHash('main', 'no-space', o));
});

test('contentHash: changes when only the indentation of a changed line changes', () => {
  const { repo, o } = baseRepo();
  repo.branch('two-spaces');
  repo.write('src/a.js', 'one\ntwo\n  return 1;\n');
  repo.commit('two spaces');
  repo.checkout('main');
  repo.branch('four-spaces');
  repo.write('src/a.js', 'one\ntwo\n    return 1;\n');
  repo.commit('four spaces');
  assert.notEqual(contentHash('main', 'two-spaces', o), contentHash('main', 'four-spaces', o));
});

test('contentHash: exclude drops a path from the hash, other paths still count', () => {
  const { repo, o } = baseRepo();
  repo.branch('feat');
  repo.write('src/a.js', 'one\ntwo\nthree\nfour\n');
  repo.write('docs/agent-log.md', '# log\nentry 1\n');
  repo.commit('feature + log');
  const exclude = ['docs/agent-log.md'];
  const withLog = contentHash('main', 'feat', o);
  const base = contentHash('main', 'feat', { ...o, exclude });
  assert.notEqual(withLog, base); // the exclude really removed something

  repo.write('docs/agent-log.md', '# log\nentry 1\nentry 2\n');
  repo.commit('log only');
  assert.equal(contentHash('main', 'feat', { ...o, exclude }), base); // (d) log edits do not matter
  assert.notEqual(contentHash('main', 'feat', o), withLog);

  repo.write('src/keep.js', 'keep\nmore\n');
  repo.commit('other file');
  assert.notEqual(contentHash('main', 'feat', { ...o, exclude }), base); // (e) any other file does
});

test('contentHash covers binary changes and is a sha256 hex string', () => {
  const { repo, o } = baseRepo();
  repo.branch('feat');
  repo.write('img.bin', Buffer.from([0, 1, 2, 3, 255, 254]));
  repo.commit('bin 1');
  const h1 = contentHash('main', 'feat', o);
  assert.match(h1, /^[0-9a-f]{64}$/);
  repo.write('img.bin', Buffer.from([0, 1, 2, 3, 255, 253]));
  repo.commit('bin 2');
  assert.notEqual(contentHash('main', 'feat', o), h1);
});

test('contentHash from a subdirectory still covers the whole repo, and exclude paths are repo-relative', () => {
  const { repo, o } = baseRepo();
  repo.branch('feat');
  repo.write('src/a.js', 'one\ntwo\nthree\nfour\n');
  repo.write('docs/agent-log.md', '# log\nentry\n');
  repo.commit('feature + log');
  const sub = { cwd: join(repo.dir, 'docs') };
  assert.equal(contentHash('main', 'feat', sub), contentHash('main', 'feat', o));
  assert.equal(
    contentHash('main', 'feat', { ...sub, exclude: ['docs/agent-log.md'] }),
    contentHash('main', 'feat', { ...o, exclude: ['docs/agent-log.md'] }),
  );
});

test('treeFingerprint: changes with tracked edits, new untracked files and untracked edits; stable otherwise; ignores .gitignore', () => {
  const { repo, o } = baseRepo();
  repo.write('.gitignore', 'ignored.log\nbuild/\n');
  repo.commit('ignore rules');

  const f0 = treeFingerprint(o);
  assert.match(f0, /^[0-9a-f]{64}$/);
  assert.equal(treeFingerprint(o), f0); // nothing changed

  repo.write('src/a.js', 'edited\n');
  const f1 = treeFingerprint(o);
  assert.notEqual(f1, f0); // tracked edit
  assert.equal(treeFingerprint(o), f1);

  repo.write('scratch.txt', 'untracked\n');
  const f2 = treeFingerprint(o);
  assert.notEqual(f2, f1); // new untracked file

  repo.write('scratch.txt', 'untracked, edited\n');
  const f3 = treeFingerprint(o);
  assert.notEqual(f3, f2); // edited untracked file

  repo.write('ignored.log', 'noise\n');
  repo.write('build/out.js', 'noise\n');
  assert.equal(treeFingerprint(o), f3); // ignored files do not count

  repo.rm('scratch.txt');
  assert.equal(treeFingerprint(o), f1); // same tree as before the untracked file existed
});

test('treeFingerprint: staged vs unstaged, new HEAD, and subdirectory cwd', () => {
  const { repo, o } = baseRepo();
  repo.write('deep/dir/new.txt', 'untracked in a subdir\n');
  const fromRoot = treeFingerprint(o);
  assert.equal(treeFingerprint({ cwd: join(repo.dir, 'src') }), fromRoot); // sees the whole repo from anywhere

  repo.write('src/a.js', 'edited\n');
  const unstaged = treeFingerprint(o);
  repo.git(['add', 'src/a.js']);
  assert.equal(treeFingerprint(o), unstaged); // `git diff HEAD` spans index + worktree, so staging changes nothing
  repo.commit('commit it'); // HEAD moves, tree content is the same as far as the worktree goes
  assert.notEqual(treeFingerprint(o), unstaged);
});

test('treeFingerprint hashes untracked bytes exactly (whitespace, CRLF, binary)', () => {
  const { repo, o } = baseRepo();
  repo.write('u.txt', 'a b\n');
  const f1 = treeFingerprint(o);
  repo.write('u.txt', 'ab\n');
  const f2 = treeFingerprint(o);
  repo.write('u.txt', 'ab\r\n');
  const f3 = treeFingerprint(o);
  assert.equal(new Set([f1, f2, f3]).size, 3);
  repo.write('u.bin', Buffer.from([0, 255, 0]));
  const f4 = treeFingerprint(o);
  assert.notEqual(f4, f3);
  repo.write('u.bin', Buffer.from([0, 254, 0]));
  assert.notEqual(treeFingerprint(o), f4);
});

test('treeFingerprint copes with untracked symlinks (even dangling) and nested repos, and notices their changes', (t) => {
  const { repo, o } = baseRepo();
  try {
    symlinkSync('does-not-exist', join(repo.dir, 'dangling'));
  } catch (e) {
    t.skip(`cannot create symlinks here: ${e.code}`); // Windows without developer mode
    return;
  }
  const f1 = treeFingerprint(o); // must not throw on the dangling link
  rmSync(join(repo.dir, 'dangling'));
  symlinkSync('elsewhere', join(repo.dir, 'dangling'));
  assert.notEqual(treeFingerprint(o), f1); // the link target is part of the fingerprint

  const nested = createTmpRepo(); // an untracked directory that is itself a repo shows up as "dir/"
  nested.write('n.txt', 'n\n');
  nested.commit('n');
  cpSync(nested.dir, join(repo.dir, 'vendored'), { recursive: true });
  nested.cleanup();
  assert.match(treeFingerprint(o), /^[0-9a-f]{64}$/); // a directory entry is hashed, not read as a file
});

test('commitTime returns epoch ms close to now for a fresh commit', () => {
  const { repo, o } = baseRepo();
  const sha = repo.commit('fresh', { allowEmpty: true });
  const t = commitTime(sha, o);
  assert.equal(typeof t, 'number');
  assert.ok(Math.abs(Date.now() - t) < 60_000, `commit time ${t} is not near ${Date.now()}`);
  assert.equal(t % 1000, 0); // %ct is whole seconds
  repo.git(['tag', '-a', 'v1', '-m', 'annotated']);
  assert.equal(commitTime('v1', o), t); // peels annotated tags to the commit
});

test('currentBranch: branch name, and "HEAD" when detached', () => {
  const { repo, o } = baseRepo();
  assert.equal(currentBranch(o), 'main');
  repo.branch('feat/nested-name');
  assert.equal(currentBranch(o), 'feat/nested-name');
  repo.git(['tag', 'feat/nested-name-tag']);
  repo.git(['tag', 'main']); // a tag sharing a branch name must not turn this into "heads/..."
  repo.checkout('main');
  assert.equal(currentBranch(o), 'main');
  repo.git(['checkout', '-q', '--detach']);
  assert.equal(currentBranch(o), 'HEAD');
});

test('mergeBase, headSha, revParse, isClean', () => {
  const { repo, base, o } = baseRepo();
  repo.branch('feat');
  repo.write('x.txt', 'x\n');
  const tip = repo.commit('x');
  repo.checkout('main');
  repo.write('y.txt', 'y\n');
  const mainTip = repo.commit('y');

  assert.equal(mergeBase('main', 'feat', o), base);
  assert.equal(headSha(o), mainTip);
  assert.equal(revParse('feat', o), tip);
  assert.equal(revParse('HEAD~1', o), base);
  assert.throws(() => revParse('no-such-ref', o), GitError);

  assert.equal(isClean(o), true);
  repo.write('z.txt', 'untracked\n');
  assert.equal(isClean(o), false); // untracked counts
  repo.rm('z.txt');
  assert.equal(isClean(o), true);
  repo.write('y.txt', 'edited\n');
  assert.equal(isClean(o), false);
});

test('mergeBase explains itself when there is no common ancestor', () => {
  const { repo, o } = baseRepo();
  repo.git(['checkout', '-q', '--orphan', 'island']);
  repo.git(['rm', '-rfq', '.']);
  repo.write('lonely.txt', 'x\n');
  repo.commit('island root');
  assert.throws(() => mergeBase('main', 'island', o), (e) => e instanceof GitError && /no common ancestor/.test(e.stderr));
});

test('git() throws GitError carrying args, exit code and stderr', () => {
  const { o } = baseRepo();
  assert.throws(
    () => git(['rev-parse', '--verify', 'definitely-not-a-ref'], o),
    (e) => {
      assert.ok(e instanceof GitError);
      assert.equal(e.name, 'GitError');
      assert.deepEqual(e.args, ['rev-parse', '--verify', 'definitely-not-a-ref']);
      assert.notEqual(e.code, 0);
      assert.match(e.stderr, /definitely-not-a-ref|Needed a single revision/);
      assert.match(e.message, /rev-parse --verify definitely-not-a-ref/);
      assert.ok(e.message.includes(e.stderr.trim()));
      return true;
    },
  );
});

test('git() forces its config and environment through an injected runner, and returns stdout untouched', () => {
  const calls = [];
  const fake = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return { code: 0, stdout: '  raw out \n', stderr: '', timedOut: false };
  };
  const out = git(['status', '--short'], { cwd: '/somewhere', run: fake, input: 'piped' });
  assert.equal(out, '  raw out \n');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'git');
  assert.deepEqual(calls[0].args, [
    '-c', 'core.quotePath=true', '-c', 'diff.noprefix=false', '-c', 'diff.mnemonicPrefix=false',
    '-c', 'diff.renames=true', '-c', 'color.ui=false', '-c', 'core.autocrlf=false', 'status', '--short',
  ]);
  assert.equal(calls[0].opts.cwd, '/somewhere');
  assert.equal(calls[0].opts.input, 'piped');
  assert.equal(calls[0].opts.env.LC_ALL, 'C'); // stderr is matched by text, so it must not be translated

  const failing = () => ({ code: 128, stdout: '', stderr: 'fatal: boom\n', timedOut: false });
  assert.throws(() => git(['log'], { run: failing }), (e) => e instanceof GitError && e.code === 128 && e.stderr === 'fatal: boom\n');
});

test('refs that look like options or are empty are rejected before git sees them', () => {
  const { o } = baseRepo();
  for (const bad of ['--output=/tmp/pwned', '-1', '']) {
    assert.throws(() => showFile(bad, 'src/a.js', o), GitError);
    assert.throws(() => revParse(bad, o), GitError);
    assert.throws(() => diffFiles('main', bad, o), GitError);
    assert.throws(() => contentHash(bad, 'main', o), GitError);
    assert.throws(() => grepAtRef(bad, 'x', o), GitError);
    assert.throws(() => commitTime(bad, o), GitError);
  }
});
