import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { symlinkSync, rmSync, cpSync, writeFileSync, mkdtempSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  git, GitError, mergeBase, headSha, currentBranch, isClean, revParse, diffFiles, showFile, grepAtRef,
  commitTime, contentHash, treeFingerprint,
} from '../pipeline/lib/git.mjs';
import { run } from '../pipeline/lib/proc.mjs';
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

const REDIRECTING_ENV = [
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR', 'GIT_NAMESPACE', 'GIT_CEILING_DIRECTORIES',
];

// Sets process.env for the duration of fn (sync) and restores it, even on failure.
function withProcessEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// A runner that behaves like proc.run but with the result tampered by `patch` (what a killed/missing git looks like).
const fakeRun = (result) => () => ({ code: 0, stdout: '', stderr: '', timedOut: false, signal: null, ...result });

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
    '-c', 'diff.renames=true', '-c', 'color.ui=false',
    '-c', 'diff.interHunkContext=0', '-c', 'diff.algorithm=myers', '-c', 'diff.indentHeuristic=true', 'status', '--short',
  ]);
  assert.equal(calls[0].opts.cwd, '/somewhere');
  assert.equal(calls[0].opts.input, 'piped');
  assert.equal(calls[0].opts.env.LC_ALL, 'C'); // stderr is matched by text, so it must not be translated
  for (const k of REDIRECTING_ENV) {
    assert.ok(k in calls[0].opts.env && calls[0].opts.env[k] === undefined, `${k} must be scrubbed from the child env`);
  }
  git(['fetch'], { run: fake, timeoutMs: 5000 });
  assert.equal(calls.at(-1).opts.timeoutMs, 5000, 'a timeout reaches the runner');
  assert.equal('timeoutMs' in calls[0].opts, false, 'and is absent when not asked for');
  calls.pop();
  git(['status'], { run: fake, env: { GIT_DIR: '/explicit' } });
  assert.equal(calls[1].opts.env.GIT_DIR, '/explicit'); // unless the caller asks for it
  assert.equal(calls[1].opts.env.GIT_WORK_TREE, undefined);

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

// ---------------------------------------------------------------------------------------------------------------
// Review hardening
// ---------------------------------------------------------------------------------------------------------------

const dupSource = (aReturn, bReturn) => [
  'function a() {', '  const first = 1;', '  const second = 2;', '  const third = 3;', `  return ${aReturn};`, '}', '',
  'function b() {', "  const alpha = 'a';", "  const beta = 'b';", "  const gamma = 'c';", `  return ${bReturn};`, '}', '',
].join('\n');

test('contentHash: the identical edit relocated to a different function changes the hash', () => {
  const { repo, o } = baseRepo();
  repo.write('src/dup.js', dupSource('false', 'false'));
  repo.commit('two functions');
  repo.branch('edit-a');
  repo.write('src/dup.js', dupSource('true', 'false'));
  repo.commit('flip a');
  repo.checkout('main');
  repo.branch('edit-b');
  repo.write('src/dup.js', dupSource('false', 'true'));
  repo.commit('flip b');
  // the changed lines are byte-identical (`-  return false;` / `+  return true;`); only the context tells them apart
  assert.notEqual(contentHash('main', 'edit-a', o), contentHash('main', 'edit-b', o));
  // and the same edit in the same place is still the same hash
  repo.checkout('main');
  repo.branch('edit-a-again');
  repo.write('src/dup.js', dupSource('true', 'false'));
  repo.commit('flip a, different message');
  assert.equal(contentHash('main', 'edit-a-again', o), contentHash('main', 'edit-a', o));
});

// 40-line file; `over` replaces numbered lines.
const longFile = (over = {}) => Array.from({ length: 40 }, (_, i) => over[i + 1] ?? `const v${i + 1} = ${i + 1};`).join('\n') + '\n';

// The branch edits line 30; then main edits `mainLine` of the same file and the branch merges main.
function hashAcrossBaseEdit(mainLine) {
  const { repo, o } = baseRepo();
  repo.write('src/long.js', longFile());
  repo.commit('long file');
  repo.branch('feat');
  repo.write('src/long.js', longFile({ 30: 'const v30 = "changed";' }));
  repo.commit('feature');
  const before = contentHash('main', 'feat', o);
  repo.checkout('main');
  repo.write('src/long.js', longFile({ [mainLine]: `const v${mainLine} = "main edit";` }));
  repo.commit('main edits the same file');
  repo.checkout('feat');
  repo.git(['merge', '--no-ff', '-q', '-m', 'merge main', 'main']);
  return { before, after: contentHash('main', 'feat', o) };
}

test('contentHash: a base edit more than 3 lines from the PR hunk keeps the hash; within 3 lines changes it (forces re-review)', () => {
  for (const line of [5, 26, 34]) { // 26 and 34 are the first lines OUTSIDE the 3-line context of the edit at 30
    const { before, after } = hashAcrossBaseEdit(line);
    assert.equal(after, before, `base edit at line ${line} must not change the hash`);
  }
  for (const line of [27, 33]) { // the last lines INSIDE the context
    const { before, after } = hashAcrossBaseEdit(line);
    assert.notEqual(after, before, `base edit at line ${line} sits in the hunk's context and must change the hash`);
  }
});

test('diffFiles still returns lines for files git would call binary (NUL byte, -diff attribute)', () => {
  const { repo, o } = baseRepo();
  repo.write('.gitattributes', '*.ts -diff\n');
  repo.write('src/x.test.ts', 'it("keeps", () => {});\nit("drops", () => {});\n');
  repo.write('src/y.test.js', 'it("keeps", () => {});\nit("drops", () => {});\n');
  repo.commit('test files');
  repo.branch('feat');
  repo.write('src/x.test.ts', 'it("keeps", () => {});\nit.skip("drops", () => {});\n');
  repo.write('src/y.test.js', 'it("keeps", () => {});\nit.skip("drops", () => {}); // note:\0 nul\n');
  repo.commit('skip them');

  // precondition: plain git really does hide both
  assert.equal(repo.git(['diff', '-U0', 'main..feat']).match(/Binary files/g).length, 2);

  const by = Object.fromEntries(diffFiles('main', 'feat', o).map((f) => [f.path, f]));
  for (const p of ['src/x.test.ts', 'src/y.test.js']) {
    assert.equal(by[p].binary, false, p);
    assert.deepEqual(by[p].removed, [{ line: 2, text: 'it("drops", () => {});' }], p);
    assert.equal(by[p].added.length, 1, p);
    assert.match(by[p].added[0].text, /^it\.skip\("drops", \(\) => \{\}\);/, p);
  }
  assert.ok(by['src/y.test.js'].added[0].text.includes('\0'));
});

test('contentHash and treeFingerprint stay byte-exact for NUL and -diff files, even for invalid UTF-8 bytes', () => {
  const { repo, o } = baseRepo();
  repo.write('.gitattributes', '*.dat -diff\n');
  repo.write('legacy.dat', Buffer.from('caf\xe9 one\n', 'latin1'));
  repo.commit('latin-1 data file');
  repo.branch('e9');
  repo.write('legacy.dat', Buffer.from('caf\xe9 two\n', 'latin1'));
  repo.commit('e9');
  repo.checkout('main');
  repo.branch('ea');
  repo.write('legacy.dat', Buffer.from('caf\xea two\n', 'latin1'));
  repo.commit('ea');
  // 0xE9 and 0xEA are both invalid UTF-8: decoded as text they would collapse to the same U+FFFD
  assert.notEqual(contentHash('main', 'e9', o), contentHash('main', 'ea', o));

  repo.checkout('main');
  const f0 = treeFingerprint(o);
  repo.write('legacy.dat', Buffer.from('caf\xe9 one!\n', 'latin1'));
  const f1 = treeFingerprint(o);
  repo.write('legacy.dat', Buffer.from('caf\xea one!\n', 'latin1'));
  const f2 = treeFingerprint(o);
  assert.equal(new Set([f0, f1, f2]).size, 3);
});

test('a textconv driver configured in the repo cannot change contentHash or treeFingerprint', () => {
  const { repo, o } = baseRepo();
  // a converter whose output differs on every call: if git ever applies it, nothing is reproducible
  const script = join(repo.dir, '.git', 'textconv.mjs');
  writeFileSync(script, 'process.stdout.write(`${process.hrtime.bigint()}-${Math.random()}\\n`);\n');
  repo.git(['config', 'diff.noisy.textconv', `node "${script.replaceAll('\\', '/')}"`]);
  repo.write('.gitattributes', '*.txt diff=noisy\n');
  repo.write('notes.txt', 'v1\n');
  repo.commit('notes');
  repo.branch('feat');
  repo.write('notes.txt', 'v2\n');
  repo.commit('change notes');

  // precondition: the driver is live, so plain `git diff` is not reproducible here
  assert.notEqual(repo.git(['diff', '-U0', 'main..feat']), repo.git(['diff', '-U0', 'main..feat']));

  const h = contentHash('main', 'feat', o);
  assert.equal(contentHash('main', 'feat', o), h);
  repo.write('notes.txt', 'v3 uncommitted\n');
  assert.notEqual(repo.git(['diff', 'HEAD']), repo.git(['diff', 'HEAD']));
  const f = treeFingerprint(o);
  assert.equal(treeFingerprint(o), f);
});

test('git() ignores repo-redirecting variables from the process env, unless the caller passes them explicitly', () => {
  const a = baseRepo();
  const b = createTmpRepo();
  b.write('only-b.txt', 'b\n');
  const bSha = b.commit('b root');
  const redirect = {
    GIT_DIR: join(a.repo.dir, '.git'),
    GIT_WORK_TREE: a.repo.dir,
    GIT_INDEX_FILE: join(a.repo.dir, '.git', 'index'),
    GIT_OBJECT_DIRECTORY: join(a.repo.dir, '.git', 'objects'),
    GIT_COMMON_DIR: join(a.repo.dir, '.git'),
    GIT_NAMESPACE: 'elsewhere',
    GIT_CEILING_DIRECTORIES: tmpdir(),
    GIT_ALTERNATE_OBJECT_DIRECTORIES: join(a.repo.dir, '.git', 'objects'),
  };
  assert.deepEqual(Object.keys(redirect).sort(), [...REDIRECTING_ENV].sort());
  withProcessEnv(redirect, () => {
    assert.notEqual(a.base, bSha);
    assert.equal(headSha({ cwd: b.dir }), bSha);
    assert.equal(currentBranch({ cwd: b.dir }), 'main');
    assert.equal(isClean({ cwd: b.dir }), true);
    assert.equal(showFile('HEAD', 'only-b.txt', { cwd: b.dir }), 'b\n'); // B's tree, not A's
    // an explicit env option is the one way to point git elsewhere
    assert.equal(git(['rev-parse', 'HEAD'], { cwd: b.dir, env: { GIT_DIR: join(a.repo.dir, '.git') } }).trim(), a.base);
  });
});

test('fail closed: a git that failed to run is never read as "no match", "not found" or "detached"', (t) => {
  const { o } = baseRepo();

  // real failures
  const missingCwd = { cwd: join(tmpdir(), `cp-git-missing-dir-${process.pid}`) };
  for (const call of [
    () => grepAtRef('HEAD', 'x', missingCwd), () => currentBranch(missingCwd), () => mergeBase('HEAD', 'HEAD', missingCwd),
    () => showFile('HEAD', 'a.txt', missingCwd), () => isClean(missingCwd), () => headSha(missingCwd),
  ]) assert.throws(call, GitError);

  const notRepo = mkdtempSync(join(tmpdir(), 'cp-git-norepo-'));
  try {
    const nr = { cwd: notRepo, env: { GIT_CEILING_DIRECTORIES: tmpdir() } }; // never walk up into some enclosing repo
    assert.throws(() => grepAtRef('HEAD', 'x', nr), GitError);
    assert.throws(() => currentBranch(nr), GitError);
    assert.throws(() => showFile('HEAD', 'a.txt', nr), GitError);
  } finally {
    rmSync(notRepo, { recursive: true, force: true });
  }

  if (process.platform !== 'win32') {
    const noGit = { ...o, env: { PATH: join(tmpdir(), 'cp-git-no-such-bin-dir') } }; // git cannot be found
    assert.throws(() => grepAtRef('HEAD', 'x', noGit), (e) => e instanceof GitError && /ENOENT/.test(e.stderr));
    assert.throws(() => currentBranch(noGit), (e) => e instanceof GitError && /ENOENT/.test(e.stderr));
    const killed = { ...o, run: (cmd, args, opts) => run(process.execPath, ['-e', "process.kill(process.pid, 'SIGKILL')"], { cwd: opts.cwd }) };
    assert.throws(() => grepAtRef('HEAD', 'x', killed), (e) => e instanceof GitError && /SIGKILL/.test(e.stderr));
    assert.throws(() => currentBranch(killed), (e) => e instanceof GitError && /SIGKILL/.test(e.stderr));
  } else {
    t.diagnostic('real missing-git and signal cases skipped on win32; the injected cases below cover the logic');
  }

  // injected runners: git's documented answers vs everything else
  const noMatch = fakeRun({ code: 1 });
  assert.equal(grepAtRef('HEAD', 'x', { run: noMatch }), false); // exit 1, nothing on stderr: git says "no match"
  assert.equal(currentBranch({ run: noMatch }), 'HEAD'); // exit 1 with -q: HEAD is not a symbolic ref
  assert.throws(() => mergeBase('a', 'b', { run: noMatch }), (e) => e instanceof GitError && /no common ancestor/.test(e.stderr));

  for (const [label, patch] of [
    ['exit 1 with stderr (spawn failure)', { code: 1, stderr: 'spawnSync git ENOENT' }],
    ['killed by a signal', { code: 1, signal: 'SIGKILL' }],
    ['timed out', { code: 1, timedOut: true }],
    ['exit 2', { code: 2 }],
    ['exit 128', { code: 128, stderr: 'fatal: not a git repository' }],
    ['exit 129', { code: 129, stderr: 'usage: git grep' }],
  ]) {
    const r = { run: fakeRun(patch) };
    assert.throws(() => grepAtRef('HEAD', 'x', r), GitError, `grepAtRef: ${label}`);
    assert.throws(() => currentBranch(r), GitError, `currentBranch: ${label}`);
    assert.throws(() => mergeBase('a', 'b', r), (e) => e instanceof GitError && !/no common ancestor/.test(e.stderr), `mergeBase: ${label}`);
    assert.throws(() => showFile('HEAD', 'p', r), GitError, `showFile: ${label}`);
    assert.throws(() => isClean(r), GitError, `isClean: ${label}`);
  }
  // a signal or timeout wins even over a zero exit code with output
  assert.throws(() => headSha({ run: fakeRun({ code: 0, stdout: 'abc\n', signal: 'SIGTERM' }) }), GitError);
  assert.throws(() => headSha({ run: fakeRun({ code: 0, stdout: 'abc\n', timedOut: true }) }), GitError);

  // showFile: null only for git's two documented "not in the tree" messages, with exit 128
  const missing = (stderr, code = 128) => ({ run: fakeRun({ code, stderr }) });
  assert.equal(showFile('HEAD', 'p', missing("fatal: path 'p' does not exist in 'HEAD'")), null);
  assert.equal(showFile('HEAD', 'p', missing("fatal: path 'p' exists on disk, but not in 'HEAD'")), null);
  assert.throws(() => showFile('HEAD', 'p', missing("fatal: path 'p' does not exist in 'HEAD'", 1)), GitError);
  assert.throws(() => showFile('HEAD', 'p', missing("fatal: bad object HEAD")), GitError);
});

test('contentHash exclude is literal and anchored at the repo root', () => {
  const { repo, o } = baseRepo();
  repo.write('docs/other.md', 'other\n');
  repo.write('sub/docs/agent-log.md', 'nested\n');
  repo.commit('more files');
  const ex = { ...o, exclude: ['docs/agent-log.md'] };
  const emptyHash = contentHash('main', 'main', o);

  repo.branch('log-only');
  repo.write('docs/agent-log.md', '# log\nentry\n');
  repo.commit('log');
  assert.equal(contentHash('main', 'log-only', ex), emptyHash); // the excluded file is the only change

  for (const [i, p] of ['docs/other.md', 'sub/docs/agent-log.md', 'agent-log.md', 'docs/agent-log.md.bak', 'src/a.js'].entries()) {
    repo.checkout('main');
    repo.branch(`edit-${i}`);
    repo.write(p, 'edited\n');
    repo.commit(`edit ${p}`);
    assert.notEqual(contentHash('main', `edit-${i}`, ex), emptyHash, `${p} must not be excluded`);
  }

  // `*` is not a wildcard: nothing is called `*.js`, so nothing is excluded
  repo.checkout('main');
  repo.branch('js');
  repo.write('src/a.js', 'changed\n');
  repo.write('src/keep.js', 'changed too\n');
  repo.commit('js changes');
  const plain = contentHash('main', 'js', o);
  for (const glob of ['*.js', 'src/*', 'src/**', 'src/?.js', ':(glob)src/*']) {
    assert.equal(contentHash('main', 'js', { ...o, exclude: [glob] }), plain, glob);
  }
});

test('treeFingerprint: a tracked binary file changing, even between invalid-UTF-8 byte values', () => {
  const { repo, o } = baseRepo();
  repo.write('img.bin', Buffer.from([0, 1, 255, 254]));
  repo.commit('binary');
  const f0 = treeFingerprint(o);
  repo.write('img.bin', Buffer.from([0, 1, 255, 253]));
  const f1 = treeFingerprint(o);
  assert.notEqual(f1, f0);
  repo.write('img.bin', Buffer.from([0, 1, 255, 254]));
  assert.equal(treeFingerprint(o), f0); // back to the committed bytes
});

test('treeFingerprint: renaming an untracked file changes it, content unchanged', () => {
  const { repo, o } = baseRepo();
  repo.write('first.txt', 'same bytes\n');
  const f1 = treeFingerprint(o);
  repo.write('second.txt', 'same bytes\n');
  repo.rm('first.txt');
  const f2 = treeFingerprint(o);
  assert.notEqual(f2, f1);
  repo.write('dir/second.txt', 'same bytes\n');
  repo.rm('second.txt');
  assert.notEqual(treeFingerprint(o), f2); // moving it into a directory counts too
});

// Flips the exec bit in the index and on disk (with core.fileMode on, an index-only flip leaves the worktree dirty).
function makeExecutable(repo, rel) {
  repo.git(['update-index', '--chmod=+x', rel]);
  chmodSync(join(repo.dir, rel), 0o755);
}

test('contentHash: a mode-only change (chmod +x) changes the hash', () => {
  const { repo, o } = baseRepo();
  repo.branch('mode');
  makeExecutable(repo, 'src/keep.js');
  repo.git(['commit', '-q', '-m', 'make executable']);
  // precondition: the diff really is mode-only
  assert.match(repo.git(['diff', 'main..mode']), /old mode 100644\nnew mode 100755/);
  assert.doesNotMatch(repo.git(['diff', 'main..mode']), /^@@/m);
  assert.notEqual(contentHash('main', 'mode', o), contentHash('main', 'main', o));
  // and the mode bit is part of the hash, not just "some change": +x vs a different file made +x
  repo.checkout('main');
  repo.branch('mode-other');
  makeExecutable(repo, 'src/a.js');
  repo.git(['commit', '-q', '-m', 'make a executable']);
  assert.notEqual(contentHash('main', 'mode', o), contentHash('main', 'mode-other', o));
});

test('autocrlf=true (Git for Windows default): touching a CRLF working file neither dirties isClean nor moves treeFingerprint', () => {
  const { repo, o } = baseRepo();
  repo.git(['config', 'core.autocrlf', 'true']);
  // Re-checkout so the working copy has CRLF endings and a fresh index entry, as a Git for Windows checkout does.
  repo.rm('src/a.js');
  repo.git(['checkout', '--', 'src/a.js']);
  const f0 = treeFingerprint(o);
  assert.equal(isClean(o), true);
  // An editor saving the same text again (CRLF) is not a change.
  repo.write('src/a.js', 'one\r\ntwo\r\nthree\r\n');
  assert.equal(isClean(o), true, 'a CRLF working copy of an LF blob is not a change under autocrlf=true');
  assert.equal(treeFingerprint(o), f0, 'and must not change the tree fingerprint');
  repo.write('src/a.js', 'one\r\ntwo\r\nthree!\r\n');
  assert.equal(isClean(o), false);
  assert.notEqual(treeFingerprint(o), f0);
});

test('contentHash and diffFiles stay byte-stable between commits whatever the user\'s autocrlf', () => {
  const { repo, o } = baseRepo();
  repo.branch('feat');
  repo.write('src/a.js', 'one\r\ntwo\r\nthree\r\nfour\r\n');
  repo.git(['config', 'core.autocrlf', 'false']);
  repo.commit('crlf edit');
  const off = contentHash('main', 'feat', o);
  repo.git(['config', 'core.autocrlf', 'true']);
  assert.equal(contentHash('main', 'feat', o), off);
  assert.deepEqual(diffFiles('main', 'feat', o).map((f) => f.path), ['src/a.js']);
});
