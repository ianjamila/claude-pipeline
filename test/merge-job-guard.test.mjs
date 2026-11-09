// merge-carry C11: while a live `P merge --owner-go` job owns a checkout, the git guard refuses branch / index / worktree
// mutating git commands there (and only there), and `pipeline job start` gets the same answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { evaluateGitCommand } from '../pipeline/hooks/lib/git-policy.mjs';
import { realGitWiring } from '../pipeline/hooks/lib/git-wiring.mjs';
import { guardVerdict } from '../pipeline/lib/command-guard.mjs';

const fwd = (p) => p.replace(/\\/g, '/'); // forward slashes in command text: backslashes are shell escapes
const fakeRepo = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mj-guard-')));
  mkdirSync(join(root, '.git')); // the lookup only needs the checkout root marker, not a real repository
  mkdirSync(join(root, 'src'));
  return root;
};
const mark = (root, pid, pr = 12) => {
  mkdirSync(join(root, '.review'), { recursive: true });
  writeFileSync(join(root, '.review', 'merge-job.json'), JSON.stringify({ pr, pid, branch: 'agent/x', expectedHead: 'a'.repeat(40), startedAt: '2026-11-06T10:00:00.000Z' }));
};
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid;
const wiring = realGitWiring();
const decide = (command, cwd) => evaluateGitCommand(command, { cwd, ...wiring });

test('a live job blocks mutating git in its checkout: cwd, -C and cd', () => {
  const root = fakeRepo();
  const other = fakeRepo();
  mark(root, process.pid, 12);
  for (const [command, cwd] of [
    ['git checkout other', root],
    ['git switch -c y', root],
    ['git reset --hard', root],
    [`git -C ${fwd(root)} reset --hard`, other],
    [`cd ${fwd(root)} && git commit -m x`, other],
    ['git commit -am x', join(root, 'src')], // a subfolder is still the same checkout
    ['git merge main', root],
    ['git rebase main', root],
    ['git cherry-pick abc', root],
    ['git revert HEAD', root],
    ['git stash', root],
    ['git stash pop', root],
    ['git pull', root],
    ['git restore a.txt', root],
    ['git am x.patch', root],
    [`git worktree remove ${fwd(root)}`, other],
    [`git -C ${fwd(other)} worktree remove ${fwd(root)}`, other],
    [`git worktree move ${fwd(root)} ${fwd(root)}-2`, other],
    ['git worktree remove .', root],
  ]) {
    const v = decide(command, cwd);
    assert.equal(v.decision, 'deny', command);
    assert.match(v.reason, /P merge --owner-go.*job \(pid \d+, PR #12\) owns this checkout until it ends.*wait for it or stop it/s, command);
  }
});

test('read-only git, P commands and other checkouts are not affected', () => {
  const root = fakeRepo();
  const other = fakeRepo();
  mark(root, process.pid);
  for (const command of ['git status', 'git log --oneline', 'git diff', 'git fetch origin', 'git show HEAD', 'git rev-parse HEAD', 'git stash list', 'git branch --show-current', 'git worktree list', 'git worktree add ../x -b agent/y', 'P review status', 'node pipeline/bin/pipeline.mjs review status']) {
    assert.equal(decide(command, root).decision, 'allow', command);
  }
  assert.equal(decide('git checkout x', other).decision, 'allow'); // another checkout
  assert.equal(decide(`git -C ${fwd(other)} reset --hard`, root).decision, 'allow');
  assert.equal(decide(`git worktree remove ${fwd(other)}`, root).decision, 'allow'); // removing a different checkout
});

test('a dead pid, a garbled marker or no marker blocks nothing', () => {
  const root = fakeRepo();
  assert.equal(decide('git checkout x', root).decision, 'allow'); // no marker
  mark(root, deadPid());
  assert.equal(decide('git checkout x', root).decision, 'allow'); // stale
  writeFileSync(join(root, '.review', 'merge-job.json'), '{ nope');
  assert.equal(decide('git checkout x', root).decision, 'allow'); // garbled
  writeFileSync(join(root, '.review', 'merge-job.json'), JSON.stringify({ pid: process.pid }));
  assert.equal(decide('git checkout x', root).decision, 'allow'); // wrong shape
});

test('a git alias to a blocked verb is blocked too', () => {
  const root = fakeRepo();
  mark(root, process.pid);
  assert.equal(decide('git -c alias.co=checkout co x', root).decision, 'deny');
});

test('job start consults the same policy', () => {
  const root = fakeRepo();
  mark(root, process.pid, 31);
  const blocked = guardVerdict('git checkout x', { cwd: root, env: process.env });
  assert.equal(blocked.allow, false);
  assert.match(blocked.reason, /job \(pid \d+, PR #31\)/);
  assert.equal(guardVerdict('git status', { cwd: root, env: process.env }).allow, true);
});

// ---- review round 1 (R1-B3): the plumbing and porcelain that move a ref, HEAD, the index or the worktree without the verbs above ----
test('R1-B3: update-ref, symbolic-ref with a target, branch -f/-m/-d/-C, clean, read-tree, checkout-index, apply, add, rm and mv are refused in a job\'s checkout', () => {
  const root = fakeRepo();
  mark(root, process.pid, 12);
  for (const command of [
    'git update-ref refs/heads/other HEAD',
    'git update-ref -d refs/heads/other',
    'git symbolic-ref HEAD refs/heads/other',
    'git symbolic-ref -d HEAD',
    'git branch -f other HEAD',
    'git branch --force other HEAD',
    'git branch -m other',
    'git branch -M agent/x other',
    'git branch --move other',
    'git branch -d other',
    'git branch -D other',
    'git branch --delete other',
    'git branch -fd other',
    'git branch -C a b',
    'git clean -fd',
    'git read-tree HEAD',
    'git checkout-index -a -f',
    'git apply fix.patch',
    'git apply --index fix.patch',
    'git apply --cached fix.patch',
    'git apply --check --apply fix.patch',
    'git add .',
    'git add -- -n',
    'git rm a.txt',
    'git rm -r --cached src',
    'git mv a b',
  ]) {
    const v = decide(command, root);
    assert.equal(v.decision, 'deny', command);
    assert.match(v.reason, /P merge --owner-go.*job \(pid \d+, PR #12\) owns this checkout until it ends/s, command);
  }
});

test('R1-B3: the read-only forms of those verbs stay allowed in a job\'s checkout', () => {
  const root = fakeRepo();
  const other = fakeRepo();
  mark(root, process.pid, 12);
  for (const command of [
    'git symbolic-ref HEAD',
    'git symbolic-ref -q HEAD',
    'git symbolic-ref --short HEAD',
    'git branch',
    'git branch --list',
    'git branch -a',
    'git branch -vv',
    'git branch -r --list "origin/*"',
    'git branch --show-current',
    'git branch --contains HEAD',
    'git branch --sort=-committerdate',
    'git branch -c a b', // a copy never overwrites
    'git branch newname', // a new ref, nothing moved
    'git apply --check fix.patch',
    'git apply --stat fix.patch',
    'git apply --numstat fix.patch',
    'git add -n .',
    'git add --dry-run .',
    'git clean -n',
    'git clean -nd',
    'git clean --dry-run',
    'git rm -n a.txt',
    'git mv -n a b',
  ]) {
    assert.equal(decide(command, root).decision, 'allow', command);
  }
  assert.equal(decide('git update-ref refs/heads/other HEAD', other).decision, 'allow'); // another checkout
  assert.equal(decide('git add .', other).decision, 'allow');
});

// ---- review round 2 (R2-B1, R2-F1): the read-only forms are resolved by real option parsing, not by option presence ----
test('R2-B1: a negated or abbreviated-negated dry run / check / stat still mutates, so it is refused in a job\'s checkout', () => {
  const root = fakeRepo();
  mark(root, process.pid, 12);
  for (const command of [
    'git clean -nd --no-dry-run',
    'git clean -nd --no-dry',
    'git clean --dry-run --no-dry-run -d',
    'git add -n --no-dry-run .',
    'git rm -n --no-dry-run a.txt',
    'git mv -n --no-dry-run a b',
    'git apply --stat --no-stat fix.patch',
    'git apply --check --no-check fix.patch',
    'git apply --stat --apply fix.patch',
    'git apply --check --app fix.patch', // unambiguous abbreviation of --apply
    'git apply --check --reject fix.patch', // --reject writes the hunks that do apply
    'git branch --del other', // abbreviations of --delete / --force / --move
    'git branch --forc other HEAD',
    'git branch --mov other',
    'git symbolic-ref --del HEAD',
  ]) {
    const v = decide(command, root);
    assert.equal(v.decision, 'deny', command);
    assert.match(v.reason, /owns this checkout until it ends/, command);
  }
});

test('R2-F1: value-taking short options and --end-of-options do not hide the real flags', () => {
  const root = fakeRepo();
  mark(root, process.pid, 12);
  for (const command of [
    'git clean -fen .', // -f, -e <pattern "n">: not a dry run
    'git clean -f -e n',
    'git clean -en .',
    'git clean -f --end-of-options -n',
    'git add --end-of-options -n .',
    'git rm --end-of-options -n a.txt',
    'git add --pathspec-from-file -n', // -n is the file name
    'git apply -p1 --end-of-options --check fix.patch',
  ]) {
    const v = decide(command, root);
    assert.equal(v.decision, 'deny', command);
  }
  for (const command of [
    'git clean -ne "*.log"', // -n and -e <pattern>
    'git clean -n -e keep',
    'git clean -nde keep',
    'git apply --check -p1 fix.patch',
    'git apply --stat --whitespace=nowarn fix.patch',
    'git add -n -- .',
    'git add -nv .',
  ]) {
    assert.equal(decide(command, root).decision, 'allow', command);
  }
});

// ---- review round 2 (R2-F2, #205): more verbs that move HEAD, a branch ref or the index ----
test('R2-F2: bisect, update-index, fast-import, filter-branch and a fetch that can rewrite a local branch are refused in a job\'s checkout', () => {
  const root = fakeRepo();
  mark(root, process.pid, 12);
  for (const command of [
    'git bisect start HEAD HEAD~5',
    'git bisect good',
    'git bisect bad',
    'git bisect reset',
    'git bisect run ./t.sh',
    'git bisect skip',
    'git bisect replay log.txt',
    'git update-index --add f',
    'git update-index --remove f',
    'git update-index --refresh',
    'git fast-import',
    'git filter-branch --env-filter true',
    'git fetch -u origin +main:refs/heads/x',
    'git fetch --update-head-ok origin +main:refs/heads/agent/x',
    'git fetch --update-head origin main',
    'git fetch origin +main:refs/heads/x',
    'git fetch origin main:x', // an unqualified destination is guessed to be a branch
    'git fetch -pu origin',
    'git fetch origin -- main:refs/heads/x',
  ]) {
    const v = decide(command, root);
    assert.equal(v.decision, 'deny', command);
    assert.match(v.reason, /owns this checkout until it ends/, command);
  }
});

test('R2-F2: plain fetch, a remote-tracking or tag destination and bisect log / view stay allowed in a job\'s checkout', () => {
  const root = fakeRepo();
  const other = fakeRepo();
  mark(root, process.pid, 12);
  for (const command of [
    'git fetch',
    'git fetch origin',
    'git fetch origin main',
    'git fetch --all --prune',
    'git fetch -p origin',
    'git fetch --depth 1 origin main',
    'git fetch origin +refs/heads/*:refs/remotes/origin/*',
    'git fetch origin refs/tags/v1:refs/tags/v1',
    'git fetch git@github.com:o/r.git main',
    'git bisect log',
    'git bisect visualize',
    'git bisect view',
  ]) {
    assert.equal(decide(command, root).decision, 'allow', command);
  }
  assert.equal(decide('git bisect start HEAD HEAD~5', other).decision, 'allow'); // another checkout
  assert.equal(decide('git update-index --add f', other).decision, 'allow');
});

// ---- review round 3 (R3-B1): --git-dir / GIT_DIR / --work-tree / GIT_WORK_TREE and an unknown directory name the checkout too ----

const linkedWorktree = (main, name) => { // a linked worktree of `main`: its git dir lives in <main>/.git/worktrees/<name>, and says where the checkout is
  const wt = realpathSync(mkdtempSync(join(tmpdir(), 'mj-linked-')));
  const gitDir = join(main, '.git', 'worktrees', name);
  mkdirSync(gitDir, { recursive: true });
  writeFileSync(join(gitDir, 'gitdir'), `${join(wt, '.git')}\n`);
  writeFileSync(join(wt, '.git'), `gitdir: ${gitDir}\n`);
  return { wt, gitDir };
};

test('R3-B1: --git-dir, GIT_DIR, --work-tree and GIT_WORK_TREE aimed at a job\'s checkout are refused wherever git is run from', () => {
  const root = fakeRepo();
  const other = fakeRepo();
  mark(root, process.pid, 12);
  for (const command of [
    `git -C ${fwd(other)} --git-dir=${fwd(root)}/.git update-ref HEAD ${'b'.repeat(40)}`,
    `git -C ${fwd(other)} --git-dir ${fwd(root)}/.git checkout x`,
    `git --git-dir=${fwd(root)}/.git reset --hard`,
    `GIT_DIR=${fwd(root)}/.git git checkout x`,
    `export GIT_DIR=${fwd(root)}/.git && git checkout x`,
    `git -C ${fwd(other)} --work-tree=${fwd(root)} checkout x`,
    `git --work-tree ${fwd(root)} reset --hard`,
    `GIT_WORK_TREE=${fwd(root)} git checkout x`,
    `git -C ${fwd(other)} -c core.worktree=${fwd(root)} checkout x`,
    `git --git-dir=${fwd(root)}/.git --work-tree=${fwd(root)} commit -m x`,
  ]) {
    const v = decide(command, other);
    assert.equal(v.decision, 'deny', command);
    assert.match(v.reason, /job \(pid \d+, PR #12\) owns this checkout/, command);
  }
});

test('R3-B1: the git dir of a linked worktree resolves to that worktree\'s checkout', () => {
  const main = fakeRepo();
  const other = fakeRepo();
  const { wt, gitDir } = linkedWorktree(main, 'feat');
  mark(wt, process.pid, 13);
  assert.equal(decide(`git -C ${fwd(other)} --git-dir=${fwd(gitDir)} update-ref HEAD ${'b'.repeat(40)}`, other).decision, 'deny');
  assert.equal(decide(`GIT_DIR=${fwd(gitDir)} git checkout x`, other).decision, 'deny');
  assert.equal(decide(`git -C ${fwd(other)} --git-dir=${fwd(gitDir)} status`, other).decision, 'allow'); // read-only
});

test('R3-B1: a target that cannot be resolved is refused while the session\'s own checkout is a job\'s', () => {
  const root = fakeRepo();
  mark(root, process.pid, 12);
  for (const command of [
    'git -C $TARGET reset --hard',
    'git -C "$(pwd)/.." checkout x',
    'git --git-dir=$G checkout x',
    'GIT_DIR=$G git checkout x',
    'cd $TARGET && git checkout x',
    'export GIT_DIR=/a/.git; export GIT_DIR=/b/.git; git checkout x',
    'GIT_WORK_TREE=$W git checkout x',
  ]) {
    const v = decide(command, root);
    assert.equal(v.decision, 'deny', command);
    assert.match(v.reason, /job \(pid \d+, PR #12\) owns this checkout/, command);
  }
});

test('R3-B1: the same commands are allowed with no marker, a dead marker, or when read-only', () => {
  const root = fakeRepo();
  const other = fakeRepo();
  const cmds = [
    `git -C ${fwd(other)} --git-dir=${fwd(root)}/.git update-ref HEAD ${'b'.repeat(40)}`,
    `GIT_DIR=${fwd(root)}/.git git checkout x`,
    `git -C ${fwd(other)} --work-tree=${fwd(root)} checkout x`,
    `GIT_WORK_TREE=${fwd(root)} git checkout x`,
    'git -C $TARGET reset --hard',
    'GIT_DIR=$G git checkout x',
  ];
  for (const c of cmds) assert.equal(decide(c, other).decision, 'allow', `no marker: ${c}`);
  mark(root, deadPid());
  for (const c of cmds) assert.equal(decide(c, other).decision, 'allow', `dead marker: ${c}`);
  mark(root, process.pid);
  for (const c of [`git --git-dir=${fwd(root)}/.git status`, `git -C ${fwd(other)} --git-dir=${fwd(root)}/.git log --oneline`, `GIT_DIR=${fwd(root)}/.git git diff`, `git --work-tree=${fwd(root)} show HEAD`, 'git -C $TARGET status']) {
    assert.equal(decide(c, other).decision, 'allow', `read-only: ${c}`);
  }
  // another session's own checkout is still free, even for an unresolved target
  assert.equal(decide('git -C $TARGET reset --hard', other).decision, 'allow');
});

// ---- review round 4 (R4-B1): a relative --git-dir / --work-tree / GIT_DIR / GIT_WORK_TREE is relative to the directory ALL the -C options produce ----

test('R4-B1: a relative --git-dir / --work-tree / GIT_DIR / GIT_WORK_TREE before a later -C names the checkout git acts on', () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'mj-rel-')));
  const free = join(base, 'free');
  const group = join(base, 'group');
  const owned = join(group, 'owned');
  mkdirSync(free, { recursive: true });
  mkdirSync(join(owned, '.git'), { recursive: true });
  mark(owned, process.pid, 12);
  // git's reading of `git --work-tree=../owned -C <group>/free` is <group>/owned; the guard used to read <base>/owned
  const inner = join(group, 'free');
  mkdirSync(inner, { recursive: true });
  for (const command of [
    `git --work-tree=../owned -C ${fwd(inner)} reset --hard`,
    `git --work-tree ../owned -C ${fwd(inner)} reset --hard`,
    `git --git-dir=../owned/.git -C ${fwd(inner)} update-ref HEAD ${'b'.repeat(40)}`,
    `git --git-dir ../owned/.git --work-tree=../owned -C ${fwd(inner)} reset --hard`,
    `git --work-tree=../owned -C ${fwd(group)} -C free reset --hard`,
    `GIT_WORK_TREE=../owned git -C ${fwd(inner)} reset --hard`,
    `GIT_DIR=../owned/.git git -C ${fwd(inner)} checkout x`,
    `export GIT_WORK_TREE=../owned && git -C ${fwd(inner)} reset --hard`,
  ]) {
    const v = decide(command, free);
    assert.equal(v.decision, 'deny', command);
    assert.match(v.reason, /job \(pid \d+, PR #12\) owns this checkout/, command);
  }
});

test('R4-B1: the same relative commands are allowed with no marker, a dead marker, or when read-only', () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'mj-rel-')));
  const group = join(base, 'group');
  const owned = join(group, 'owned');
  const inner = join(group, 'free');
  mkdirSync(inner, { recursive: true });
  mkdirSync(join(owned, '.git'), { recursive: true });
  const cmds = [
    `git --work-tree=../owned -C ${fwd(inner)} reset --hard`,
    `git --git-dir=../owned/.git -C ${fwd(inner)} update-ref HEAD ${'b'.repeat(40)}`,
    `GIT_WORK_TREE=../owned git -C ${fwd(inner)} reset --hard`,
  ];
  for (const c of cmds) assert.equal(decide(c, base).decision, 'allow', `no marker: ${c}`);
  mark(owned, deadPid());
  for (const c of cmds) assert.equal(decide(c, base).decision, 'allow', `dead marker: ${c}`);
  mark(owned, process.pid);
  for (const c of [`git --work-tree=../owned -C ${fwd(inner)} status`, `git --git-dir=../owned/.git -C ${fwd(inner)} log --oneline`, `GIT_DIR=../owned/.git git -C ${fwd(inner)} diff`]) {
    assert.equal(decide(c, base).decision, 'allow', `read-only: ${c}`);
  }
  // a relative value that, with -C applied, does NOT reach the owned checkout is not refused
  assert.equal(decide(`git --work-tree=../elsewhere -C ${fwd(inner)} reset --hard`, base).decision, 'allow');
});

// ---- review round 4 (R4-F1): core.worktree is relative to the .git directory; an unresolvable or env-supplied one is an unknown target ----

// the real layout: an unowned container checkout holding the job's checkout at <container>/.worktrees/<slug>
const containerWithJob = () => {
  const container = fakeRepo();
  const job = join(container, '.worktrees', 'slug');
  mkdirSync(join(job, '.git'), { recursive: true });
  return { container, job };
};

test('R4-F1: a relative core.worktree is resolved against the git dir, so the container root can reach the job\'s checkout', () => {
  const { container, job } = containerWithJob();
  const other = fakeRepo();
  mark(job, process.pid, 12);
  for (const command of [
    `git -C ${fwd(container)} -c core.worktree=../.worktrees/slug reset --hard`,
    `git -C ${fwd(container)} -c core.worktree=../.worktrees/slug checkout x`,
    `git -c core.worktree=../.worktrees/slug -C ${fwd(container)} reset --hard`,
    `git --git-dir=${fwd(container)}/.git -c core.worktree=../.worktrees/slug reset --hard`,
    `GIT_DIR=${fwd(container)}/.git git -c core.worktree=../.worktrees/slug reset --hard`,
  ]) {
    const v = decide(command, other);
    assert.equal(v.decision, 'deny', command);
    assert.match(v.reason, /job \(pid \d+, PR #12\) owns this checkout/, command);
  }
  // from a subfolder of the container the git dir is still the container's
  mkdirSync(join(container, 'src'), { recursive: true });
  assert.equal(decide('git -c core.worktree=../.worktrees/slug reset --hard', join(container, 'src')).decision, 'deny');
  // a linked worktree: its .git file names the git dir the value is relative to
  const { wt, gitDir } = linkedWorktree(container, 'feat');
  writeFileSync(join(gitDir, 'x'), '');
  assert.equal(decide(`git -C ${fwd(wt)} -c core.worktree=${fwd(job)} reset --hard`, other).decision, 'deny'); // (absolute: unchanged)
});

test('R4-F1: a core.worktree that cannot be resolved, --config-env and GIT_CONFIG_* naming it are unknown targets: refused while the session\'s checkout is a job\'s', () => {
  const root = fakeRepo();
  const other = fakeRepo();
  const norepo = realpathSync(mkdtempSync(join(tmpdir(), 'mj-norepo-')));
  mark(root, process.pid, 12);
  const at = fwd(other);
  for (const command of [
    `git -C ${at} -c core.worktree=$W reset --hard`,
    `git -C ${at} -c "core.worktree=$(pwd)/.." checkout x`,
    `git -C ${fwd(norepo)} -c core.worktree=../x reset --hard`, // relative, and no git dir can be found from a directory outside any repository
    `git -C ${at} --config-env=core.worktree=WT reset --hard`,
    `git -C ${at} --config-env core.worktree=WT reset --hard`,
    `git -C ${at} --config-env=Core.WorkTree=WT checkout x`,
    `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.worktree GIT_CONFIG_VALUE_0=/elsewhere git -C ${at} reset --hard`,
    `export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.worktree GIT_CONFIG_VALUE_0=/elsewhere && git -C ${at} reset --hard`,
    `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=$K GIT_CONFIG_VALUE_0=/elsewhere git -C ${at} reset --hard`,
    `GIT_CONFIG_PARAMETERS="'core.worktree=/elsewhere'" git -C ${at} reset --hard`,
  ]) {
    const v = decide(command, root);
    assert.equal(v.decision, 'deny', command);
    assert.match(v.reason, /job \(pid \d+, PR #12\) owns this checkout/, command);
  }
});

test('R4-F1: the same commands are allowed with no marker, a dead marker, when read-only, or when the value reaches an unowned directory', () => {
  const { container, job } = containerWithJob();
  const other = fakeRepo();
  const cmds = [
    `git -C ${fwd(container)} -c core.worktree=../.worktrees/slug reset --hard`,
    'git -c core.worktree=$W reset --hard',
    'git --config-env=core.worktree=WT reset --hard',
    'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.worktree GIT_CONFIG_VALUE_0=/elsewhere git reset --hard',
  ]; // (run from a checkout no job owns, so an unknown target has nothing to fall back on)
  for (const c of cmds) assert.equal(decide(c, other).decision, 'allow', `no marker: ${c}`);
  mark(job, deadPid());
  for (const c of cmds) assert.equal(decide(c, other).decision, 'allow', `dead marker: ${c}`);
  mark(job, process.pid);
  for (const c of [`git -C ${fwd(container)} -c core.worktree=../.worktrees/slug status`, 'git -c core.worktree=$W status', 'git --config-env=core.worktree=WT diff', 'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.worktree GIT_CONFIG_VALUE_0=/elsewhere git log --oneline']) {
    assert.equal(decide(c, other).decision, 'allow', `read-only: ${c}`);
  }
  // relative to the git dir, `..` is the container itself, not the job's checkout
  assert.equal(decide(`git -C ${fwd(container)} -c core.worktree=.. reset --hard`, other).decision, 'allow');
  assert.equal(decide(`git -C ${fwd(container)} -c core.worktree=../../elsewhere reset --hard`, other).decision, 'allow');
  // other config keys are not core.worktree
  assert.equal(decide('GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=user.name GIT_CONFIG_VALUE_0=x git reset --hard', other).decision, 'allow');
});
