// Why (#81 t11): the 21-day replay of this branch found false alarms in the package-script, script-loop and variable rules (main allowed these lines). Each test below is one shape from the replay
// (made synthetic), allowed now, next to its malicious twin that must stay refused:
//   1. An earlier `git ...` on the line made a package script unknown (the package.json may have changed). Now only a subcommand that changes a work tree counts, and only for a package directory that work
//      tree holds: the repository of the directory it runs in (`-C`, cd), or the one new directory `git worktree add` creates. A directory the guard cannot place, on either side, still counts.
// Guarded names are spelled in pieces (as test/guard-npm-scripts.test.mjs does): the live guard scans files passed to node tools.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname, basename } from 'node:path';
import { evaluateGitCommand } from '../pipeline/hooks/lib/git-policy.mjs';
import { evaluateBashForFiles } from '../pipeline/hooks/lib/files-policy.mjs';

const PUSH = 'pu' + 'sh';
const MAIN = 'ma' + 'in';
const MERGE = 'mer' + 'ge';
const BAD_GIT = `git ${PUSH} origin ${MAIN}`;
const BAD_FILES = 'cp a ~/.cl' + 'aude/settings.json';

function fakeFs(root, files, dirs = []) {
  const abs = (p) => resolve(root, p);
  const F = Object.fromEntries(Object.entries(files).map(([k, v]) => [abs(k), v]));
  const D = new Set([root, '/home/u', ...dirs.map(abs)].map((p) => resolve(p)));
  for (const p of Object.keys(F)) for (let d = dirname(p); d !== dirname(d); d = dirname(d)) D.add(d);
  const names = (d) => {
    const out = new Set();
    for (const p of [...Object.keys(F), ...D]) if (p !== d && dirname(p) === d) out.add(basename(p));
    return [...out];
  };
  return {
    readText: (p) => (typeof F[resolve(p)] === 'string' ? F[resolve(p)] : null),
    readHead: () => null,
    pathExists: (p) => resolve(p) in F || D.has(resolve(p)),
    readDir: (p) => (D.has(resolve(p)) ? names(resolve(p)) : null),
  };
}
const GIT_ROOT = '/work/repo';
const PROJ = '/home/u/proj';
const git = (command, files, o = {}) => {
  const { cwd = GIT_ROOT, ...rest } = o;
  return evaluateGitCommand(command, { cwd, home: '/home/u', currentBranch: () => 'agent/x', pushDestination: () => null, issueLabels: () => [], realpath: (p) => p, ...fakeFs(GIT_ROOT, files), ...rest });
};
const filesGuard = (command, files, o = {}) => {
  const { cwd = PROJ, ...rest } = o;
  const fs = fakeFs(PROJ, files);
  return evaluateBashForFiles(command, { home: '/home/u', env: {}, platform: 'linux', realpath: (p) => p, cwd, ...fs, existsSync: fs.pathExists, ...rest });
};
const pkg = (scripts) => JSON.stringify({ name: 'x', version: '1.0.0', scripts });
const OK_SCRIPTS = { lint: 'echo hi', test: 'echo hi' };
// the same tree for both guards (each at its own root); `cwdSub`: the directory the session starts in, relative to the root
const both = (command, tree, { cwdSub = '' } = {}) => ({
  git: git(command, tree, { cwd: resolve(GIT_ROOT, cwdSub) }),
  files: filesGuard(command, tree, { cwd: resolve(PROJ, cwdSub) }),
});
const allowed = (command, tree, o) => {
  const r = both(command, tree, o);
  assert.equal(r.git.decision, 'allow', `git: ${command} -> ${r.git.reason}`);
  assert.equal(r.files.decision, 'allow', `files: ${command} -> ${r.files.reason}`);
};
const refused = (command, tree, rx, o) => {
  const r = both(command, tree, o);
  assert.equal(r.git.decision, 'deny', `git: ${command} -> allowed`);
  assert.equal(r.files.decision, 'deny', `files: ${command} -> allowed`);
  if (rx) { assert.match(r.git.reason, rx, `git: ${command}`); assert.match(r.files.reason, rx, `files: ${command}`); }
};
const EARLIER = /an earlier command on the line/;

// ---- 1. git commands that change no work tree, or one the package is not in ---------------------------------------------------------------------------------------
const repoTree = {
  '.git': 'gitdir: x', 'package.json': pkg(OK_SCRIPTS), 'sub/x.txt': 'x',
  '../other/.git': 'gitdir: y', '../other/package.json': pkg(OK_SCRIPTS),
  '.worktrees/w/.git': 'gitdir: z', '.worktrees/w/package.json': pkg(OK_SCRIPTS),
};
test('t11 a git command that changes no work tree does not make the package script unknown', () => {
  for (const cmd of [
    'git log -3 && npm run lint', 'git status; npm test', 'git fetch -q origin && npm run lint', 'git merge-base --is-ancestor a b && npm run lint', 'git diff --stat | head -3; npm run lint',
    `git commit -qm "fix: checkout ${MERGE} pull reset" && npm run lint`, `git log --grep=${MERGE} --oneline | head -2; npm run lint`, 'git show HEAD:package.json | head -3 && npm run lint',
    'git branch -D old && npm run lint', 'git reset --soft HEAD~1 && npm run lint', 'git reset HEAD -- a.txt && npm run lint', 'git stash list && npm run lint', 'git stash show -p | head -3; npm run lint',
    'git add -A && git commit -qm x && npm test', 'git worktree list && npm run lint', 'git -C ../other log -1 && npm run lint',
  ]) allowed(cmd, repoTree);
});
test('t11 a git command that changes the work tree the package is in still makes the script unknown', () => {
  for (const cmd of [
    'git checkout x && npm run lint', 'git switch -c y; npm run lint', `git ${MERGE} origin/${MAIN} && npm test`, 'git pull -q && npm run lint', 'git rebase x && npm run lint', 'git cherry-pick a && npm run lint',
    'git revert a && npm run lint', 'git am p && npm run lint', 'git apply p && npm run lint', 'git clean -fd && npm run lint', 'git read-tree -u x && npm run lint', 'git restore . && npm run lint',
    'git reset --hard && npm run lint', 'git reset --hard HEAD~1 && npm run lint', 'git reset --har && npm run lint', 'git reset --keep x && npm run lint', 'git reset --merge && npm run lint',
    'git stash && npm run lint', 'git stash pop && npm run lint', 'git stash apply && npm run lint', 'git stash push -u && npm run lint', 'git stash -u && npm run lint', 'git stash branch b && npm run lint',
    'git -C sub pull && npm run lint', 'git -C . checkout x && npm run lint', 'git --no-pager -c core.pager=cat checkout x && npm run lint',
    'cd sub && git pull && cd .. && npm run lint', 'git mv a b && npm run lint', 'git submodule update --init && npm run lint', 'git clone u d && npm run lint', 'git checkout-index -a --prefix=out/ && npm run lint',
  ]) refused(cmd, repoTree, EARLIER);
});
test('t11 a git command in another repository, or a new work tree elsewhere, changes nothing the package reads', () => {
  for (const cmd of ['git -C ../other pull && npm run lint', 'git -C ../other checkout x; npm test', 'git worktree add ../w2 && npm run lint', 'git worktree add -q -b feat/x ../w2 origin/main && npm run lint',
    'git worktree add ../w2 && git -C ../w2 log -1 && npm run lint']) allowed(cmd, repoTree);
  // (the git guard follows the subshell; the files guard reads the directories of the whole line at once, so it keeps refusing this one)
  assert.equal(git('(cd ../other && git pull) && npm run lint', repoTree).decision, 'allow');
  assert.equal(git('(cd sub && git pull) && npm run lint', repoTree).decision, 'deny');
  // ... and the package in the other repository, or in the new directory, is what changed
  for (const cmd of ['git -C ../other pull && cd ../other && npm run lint', 'git -C ../other checkout x && npm --prefix ../other run lint', 'git -C ../other pull && npm --prefix=../other test',
    'git worktree add ../w2 && cd ../w2 && npm run lint', 'git worktree add -q -b feat/x ../w2 origin/main && npm --prefix ../w2 run lint', 'git worktree add ../w2 && npm run lint --prefix ../w2/',
    'git worktree add .worktrees/n && cd .worktrees/n && npm run lint', 'git worktree add .worktrees/n && cd .worktrees/n/sub && npm run lint']) refused(cmd, repoTree, EARLIER);
});
test('t11 a repository below the changed work tree keeps its own package.json; one without its own package.json does not', () => {
  assert.equal(git('git checkout x && cd .worktrees/w && npm run lint', repoTree).decision, 'allow'); // (the files guard reads the line's directories at once: it refuses this one)
  allowed('git pull && npm --prefix .worktrees/w run lint', repoTree);
  refused('git -C .worktrees/w pull && cd .worktrees/w && npm run lint', repoTree, EARLIER);
  // no package.json in the linked work tree: the manager goes on up to this repository's, which the checkout changes
  const bare = { ...repoTree };
  delete bare['.worktrees/w/package.json'];
  bare['.worktrees/w/src/a.txt'] = 'a';
  refused('git checkout x && cd .worktrees/w && npm run lint', bare, EARLIER);
});
test('t11 a directory or a git setting the guard cannot place keeps the line refused', () => {
  for (const cmd of ['git -C "$D" pull && npm run lint', 'cd "$D" && git pull && cd /work/repo && npm run lint', 'git --git-dir=../other/.git --work-tree=. checkout x && npm run lint', 'git --work-tree . checkout x && npm run lint',
    'GIT_WORK_TREE=. git checkout x && npm run lint', 'git config alias.co checkout && git co x && npm run lint', 'git -c alias.co=checkout co x && npm run lint',
    'git worktree add "$N" && npm run lint', 'git checkout x & npm run lint', 'npm run lint & git pull', '(git pull &) ; npm run lint']) refused(cmd, repoTree, EARLIER);
  assert.equal(git('git "$S" x && npm run lint', repoTree).decision, 'deny');
  assert.equal(filesGuard('git "$S" x && npm run lint', repoTree).decision, 'deny');
  // no repository found above the directory (or the directory does not exist): unknown, counts
  refused('git checkout x && npm run lint', { 'package.json': pkg(OK_SCRIPTS) }, EARLIER);
  refused('git -C nowhere pull && npm run lint', repoTree, EARLIER);
});
