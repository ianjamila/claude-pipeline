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

// ---- 3. NODE_OPTIONS ---------------------------------------------------------------------------------------------------------------------------------------------
// It cannot move package.json or a configuration file, and the program it preloads is one the guards never judge: `NODE_OPTIONS=--max-old-space-size=6144 npx tsc` is a type check. The
// variables that DO move the manager's project or configuration (npm_*, INIT_CWD ...) stay refused.
test('t11 NODE_OPTIONS no longer makes a package script unknown; the families that move the project still do', () => {
  const tree = { 'package.json': pkg(OK_SCRIPTS) };
  for (const cmd of ['NODE_OPTIONS=--max-old-space-size=6144 npm run lint', 'export NODE_OPTIONS=--max-old-space-size=6144; npm test', '(NODE_OPTIONS=--max-old-space-size=6144 npm run lint > out.log 2>&1; echo done)', 'NODE_OPTIONS=--max-old-space-size=4096 npx tsc --noEmit']) allowed(cmd, tree);
  for (const cmd of ['npm_config_prefix=/elsewhere npm run lint', 'INIT_CWD=/elsewhere npm run lint', 'export npm_package_json=/e/package.json; npm test', 'NODE_OPTIONS=x npm_config_prefix=/e npm run lint']) refused(cmd, tree, /may point the package manager at another package\.json/);
});

// ---- 2. the guarded-word scan reads a JavaScript method call as a git subcommand --------------------------------------------------------------------------------
// `node -e '... mounts.rw.push(x) ... fs.writeFileSync(f, s)' file && npx vitest run file`: the program may write any file, so the runner's bin (not installed in this tree) "may have been written", and
// the line was refused because the program text holds the word of a guarded subcommand. A word between a dot and a parenthesis is a method call; every other mention still counts.
const WRITER = (extra) => `node -e 'const fs=require("fs");const f=process.argv[1];let s=fs.readFileSync(f,"utf8");${extra}fs.writeFileSync(f,s)' a.txt`;
test('t11 a JavaScript method call is not a mention of a guarded subcommand', () => {
  const tree = { '.git': 'x', 'package.json': pkg(OK_SCRIPTS), 'a.txt': 'a' };
  for (const extra of ['mounts.rw.' + PUSH + '(1);', `lodash.${MERGE}(a, b);`, `rows.${PUSH} (r);`, `a.b.${PUSH}(1);b.${PUSH}(2);`]) {
    const cmd = `${WRITER(extra)} && npx vitest run a.txt`;
    assert.equal(git(cmd, tree).decision, 'allow', `git: ${extra}`);
    assert.equal(filesGuard(cmd, tree).decision, 'allow', `files: ${extra}`);
  }
  // ... a mention that is not a method call is still one: the written bin may hold anything
  for (const extra of [`x = "git ${PUSH} origin ${MAIN}";`, `mounts.rw.${PUSH}(1);y = "${PUSH}";`, `cp.exec("git ${PUSH} origin");`, `${PUSH}(1);`, `z = a.${PUSH};`, `a.b.${MERGE} = 1;`, `// ${MERGE} the rows\n`]) {
    const cmd = `${WRITER(extra)} && npx vitest run a.txt`;
    const g = git(cmd, tree);
    assert.equal(g.decision, 'deny', `git: ${extra}`);
    assert.match(g.reason, /may have been written by an earlier command|guarded command|guarded operation/);
  }
  for (const tail of [`echo ${PUSH}`, `echo "pu"sh`, `echo ${MERGE}`, `G=git; $G ${PUSH} origin ${MAIN}`, `git -C x ${PUSH}`, `git "${PUSH}" origin`, `git config alias.p ${PUSH}`, `x.${PUSH}(1); echo ${PUSH}`]) {
    const cmd = `${WRITER('')} && npx vitest run a.txt; ${tail}`;
    assert.equal(git(cmd, tree).decision, 'deny', `git: ${tail}`);
  }
});

// ---- 4. a mention in a command that only reads ------------------------------------------------------------------------------------------------------------------
// `echo ... ; npx tsc ...; npm run lint`: a program the guard cannot see (tsc, vitest, node x.mjs) may write the configuration file the manager reads, and the line was refused because it
// "mentioned a guarded operation" in a grep pattern or a file name (`scripts/merge-pr.mjs`). The words of a command that only reads or lists are data. Others still count.
test('t11 a guarded word in the arguments of a command that only reads is no mention; in an echo, a git command or a program text it still is', () => {
  const tree = { '.git': 'x', 'package.json': pkg(OK_SCRIPTS), 'a.txt': 'a' };
  for (const pre of [`grep -rn "${MERGE.toUpperCase()}_X" app | head -2`, `cat scripts/${MERGE}-pr.mjs | head -3`, `grep -c ${PUSH} log.txt`, `ls ${PUSH}-*`, `tail -8 ${MERGE}.log`, `diff a.txt ${MERGE}.txt`]) {
    allowed(`${pre}; npx tsc --noEmit > log.txt 2>&1; npm run lint`, tree);
  }
  for (const pre of [`echo ${PUSH}`, `printf ${MERGE}`, `git log --oneline origin/${MAIN}..HEAD; echo ${PUSH}`, `node -e 'console.log("${PUSH}")'`, `sed -n 1p ${PUSH}.txt`, `awk 1 ${MERGE}.txt`]) {
    const g = git(`${pre}; npx tsc --noEmit > log.txt 2>&1; npm run lint`, tree);
    assert.equal(g.decision, 'deny', `git: ${pre}`);
  }
});

// ---- 5. JavaScript text is no `export $NAME` -------------------------------------------------------------------------------------------------------------------
// `node -e '... "export async function f(" ... `template ${x}` ...'`: the program text holds the word `export` and a `$` or a backtick. Only a parsed shell command binds a name.
test('t11 an export in the text of a program or a heredoc body is no name given at run time; a real one still is', () => {
  const tree = { '.git': 'x', 'package.json': pkg(OK_SCRIPTS), 'a.txt': 'a' };
  const js = "node -e 'let p=\"a.txt\",s=require(\"fs\").readFileSync(p,\"utf8\");s=s.replace(\"export async function f(\", `/** ${s} */ export async function g(`);'";
  allowed(`${js} && npm run lint`, tree);
  allowed(`cat > x.mjs <<'EOF'\nexport const a = \`\${b}\`;\nlocal $x\nEOF\nnpm run lint`, tree);
  for (const cmd of ['export $N=x && npm run lint', 'N=npm_config_prefix; export $N=/e; npm run lint', 'declare -x $N=1; npm run lint', 'readonly A$B=1; npm run lint', "eval 'export $N=x'; npm run lint", 'bash -c "export $N=x"; npm run lint', '(export $N=x; npm run lint)']) {
    const g = git(cmd, tree);
    assert.equal(g.decision, 'deny', `git: ${cmd}`);
    assert.equal(filesGuard(cmd, tree).decision, 'deny', `files: ${cmd}`);
  }
});

// ---- 6. a directory the guard lost track of ----------------------------------------------------------------------------------------------------------------------
// After `source env.sh` (or a cd it cannot follow) `npm run lint` was refused because the session's project has scripts. It is judged like a script named at run time (`bash $F`): refused
// when the line mentions a guarded operation.
test('t11 an unknown directory refuses a package script only when the line mentions a guarded operation', () => {
  const tree = { '.git': 'x', 'package.json': pkg(OK_SCRIPTS) };
  for (const cmd of ['source ./env.sh && npm run lint', 'cd "$UNSET_DIR" && npm test', '. ./env.sh; npm test -- --watch=false']) assert.equal(git(cmd, tree).decision, 'allow', cmd);
  for (const cmd of [`source ./env.sh && npm test; echo ${PUSH}`, `. ./env.sh; npm run lint && git ${PUSH} origin ${MAIN}`, `source ./env.sh && npm run lint; G=git; $G ${PUSH} x`]) {
    const g = git(cmd, tree);
    assert.equal(g.decision, 'deny', cmd);
  }
});

// ---- 7. a name of unknown value in a command that writes no local file ---------------------------------------------------------------------------------------------
// `M=$(gh pr view ...); SHA=${M#* }; gh api "repos/o/r/deployments?sha=$SHA"`: $SHA is part of a URL. A command that can write a local file (cp, gh run download ...) with that name still is refused.
test('t11 a name of unknown value in the words of gh api / gh pr view names no path; in a command that writes files it does', () => {
  const tree = { '.git': 'x', 'package.json': pkg(OK_SCRIPTS) };
  const M = 'M=$(gh pr view 296 --json state -q .state); SHA=${M#* }; ';
  for (const cmd of ['gh api "repos/o/r/deployments?sha=$SHA&environment=Production" -q ".[0].id"', 'gh pr view $SHA --json state', 'gh run view $SHA', 'gh -R o/r pr checks $SHA', 'gh issue list --search $SHA']) {
    assert.equal(filesGuard(M + cmd, tree).decision, 'allow', cmd);
  }
  for (const cmd of ['cp x $SHA', 'gh run download 5 -D $SHA', 'gh release download v1 -D $SHA', 'gh pr checkout $SHA', 'gh repo clone o/r $SHA', 'gh api repos/o/r --output $SHA', 'tee $SHA < x']) {
    assert.equal(filesGuard(M + cmd, tree).decision, 'deny', cmd);
  }
});

// ---- 8. files the manager's decisions rest on, which the same line may create, remove or rename first (both guards, one helper: markerPaths / pkgDirtyFor) ------------------------------------------
const markTree = { '.git': 'x', 'package.json': pkg(OK_SCRIPTS), 'sub/x.txt': 'x', 'logs/a.log': 'a' };
test('t11 a command that makes, removes or renames a package.json, node_modules, server.js, binding.gyp or rc file the manager reads makes the script unknown', () => {
  for (const cmd of ['rm package.json && npm run lint', 'mv package.json p.json; npm run lint', 'touch sub/package.json && cd sub && npm run lint', 'mkdir -p sub/node_modules && cd sub && npm run lint', 'touch server.js && npm start',
    'touch binding.gyp; npm install', 'ln -s other/.npmrc .npmrc && npm run lint', 'rm -rf .. && npm run lint', 'rm -rf * && npm run lint', 'mv sub/x.txt package.json && npm run lint', 'cp x.json package.json && npm run lint',
    'touch pnpm-workspace.yaml && pnpm -r run lint', 'rm -f "$F" && npm run lint', 'mkdir sub2 && cd sub2 && npm run lint', 'install -m 644 a .npmrc && npm run lint', 'dd if=a of=package.json 2>/dev/null; npm run lint', 'cp -t . a package.json && npm run lint', 'rm -rf $X/package.json && npm run lint', 'mkdir -p $X/node_modules/a && cd sub && npm run lint', 'touch $X/*.json && npm run lint', 'rm -rf $X/ && npm run lint']) {
    const r = both(cmd, markTree);
    assert.equal(r.git.decision, 'deny', `git: ${cmd}`);
    assert.equal(r.files.decision, 'deny', `files: ${cmd}`);
  }
  // (a directory only known at run time with the package directory's own name after it may be the package directory)
  assert.equal(git('rm -rf $X/repo && npm run lint', markTree).decision, 'deny');
  assert.equal(filesGuard('rm -rf $X/proj && npm run lint', markTree).decision, 'deny');
  // what they do elsewhere, or to other files, leaves it alone
  for (const cmd of ['mkdir -p out && npm run lint', 'touch logs/b.log && npm run lint', 'rm -f logs/a.log; npm test', 'rm -rf dist .next && npm run lint', 'cp package.json /tmp/p.json && npm run lint', 'mv logs/a.log logs/b.log && npm run lint',
    'rm -rf node_modules && npm run lint', 'cp package.json $TMPDIR/p.bak && npm run lint', 'mkdir -p $TMP/out/logs && npm run lint', 'rm -rf $X/dist && npm test', 'mkdir -p sub/out && npm run lint', 'cp src/*.txt out/ && npm run lint', 'ln -s a.log logs/c.log && npm test', 'touch /tmp/x && npm run lint']) allowed(cmd, markTree);
});

// ---- 9. a tool that runs a package script is no "plain tool" for the summed readings (t5) ----------------------------------------------------------------------------------------------------------
// Two loops whose product is over the allowance are judged by SUM (each name's values with the others at their first) when no command of the line can read both names. `npm run x` opens a script that reads
// any name the line exported: only the product (every pair) shows `git $a$b` is a push at one pair.
test('t11 a loop pair over the allowance with npm run is judged on every pair: the script reads both names', () => {
  const as = ['x1', 'x2', 'x3', 'x4', 'x5', 'x6', 'x7', 'x8', 'pu'].join(' ');
  const bs = ['y1', 'y2', 'y3', 'y4', 'y5', 'y6', 'y7', 'y8', 'sh'].join(' ');
  const mk = (script) => ({ '.git': 'x', 'package.json': pkg({ x: script }) });
  for (const run of ['npm run x', 'npx --no-install npm run x', 'pnpm run x', 'yarn run x', 'npm test']) {
    const cmd = `for a in ${as}; do export a; for b in ${bs}; do export b; ${run}; done; done`;
    const g = git(cmd, { '.git': 'x', 'package.json': pkg({ x: `git $a$b origin ${MAIN}`, test: `git $a$b origin ${MAIN}` }) });
    assert.equal(g.decision, 'deny', `git: ${run}`);
  }
  // the same loops over a script that pushes nothing stay allowed
  assert.equal(git(`for a in ${as}; do export a; for b in ${bs}; do export b; npm run x; done; done`, mk('echo $a$b')).decision, 'allow');
});

// ---- 10. workspace patterns: only a literal path and a single trailing /* are read, inside the project ---------------------------------------------------------------------------------------------
const wsTree = (patterns) => ({ '.git': 'x', 'package.json': JSON.stringify({ name: 'r', scripts: { lint: 'echo hi' }, workspaces: patterns }), 'packages/a/package.json': pkg(OK_SCRIPTS), '../outside/package.json': pkg(OK_SCRIPTS) });
test('t11 a workspace pattern that is not a plain path or one trailing /* inside the tree leaves the workspace set unknown', () => {
  for (const patterns of [['packages/*'], ['packages/a'], ['./packages/a'], ['*']]) {
    const t = wsTree(patterns);
    assert.equal(git('npm run lint -w packages/a', t).decision, 'allow', JSON.stringify(patterns));
  }
  for (const patterns of [['../outside'], ['packages/../../outside'], ['/home/u/outside'], ['/work/outside'], ['packages/**'], ['packages/*/x'], ['pack*/a'], ['packages/{a,b}'], ['packages/?'], ['packages/[ab]'], ['~/x'], ['']]) {
    const g = git('npm run lint -w packages/a', wsTree(patterns));
    assert.equal(g.decision, 'deny', JSON.stringify(patterns));
  }
});
