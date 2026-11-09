// merge-carry C11: while a live `P merge --owner-go` job owns a checkout, the git guard refuses branch / index / worktree
// mutating git commands there (and only there), and `pipeline job start` gets the same answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { evaluateGitCommand, resolvePrefixEnv } from '../pipeline/hooks/lib/git-policy.mjs';
import { simpleCommands } from '../pipeline/hooks/lib/shell-parse.mjs';
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
// R9: a mutating verb whose git dir / work tree value is not fully resolved is refused outright ("cannot be read one way", r8Refused below); one that is
// resolved and reaches a job's checkout gets the job's own message (jobDenied). Each test names which group a command belongs to, so a resolver that
// refuses a value it can read (or reads one it must refuse) fails the test.
const jobDenied = (command, cwd) => {
  const v = decide(command, cwd);
  assert.equal(v.decision, 'deny', command);
  assert.match(v.reason, /job \(pid \d+, PR #12\) owns this checkout/, command);
};

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
    'cd $TARGET && git checkout x',
  ]) {
    const v = decide(command, root);
    assert.equal(v.decision, 'deny', command);
    assert.match(v.reason, /job \(pid \d+, PR #12\) owns this checkout/, command);
  }
  // (R9: a --git-dir / GIT_DIR / GIT_WORK_TREE value that is not resolved is not the "unknown -> cwd" check any more: refused outright, see R9)
  for (const command of ['git --git-dir=$G checkout x', 'GIT_DIR=$G git checkout x', 'GIT_WORK_TREE=$W git checkout x']) r8Refused(command, root);
  // (R8-F2: a selector exported twice has no value to read: refused outright, whoever owns the session's checkout; it used to be an "unknown" cwd check)
  const twice = decide('export GIT_DIR=/a/.git; export GIT_DIR=/b/.git; git checkout x', root);
  assert.equal(twice.decision, 'deny');
  assert.match(twice.reason, /cannot be read one way/);
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
  ];
  for (const c of cmds) assert.equal(decide(c, other).decision, 'allow', `no marker: ${c}`);
  r8Refused('GIT_DIR=$G git checkout x', other); // (R9: was allowed with no marker; an unresolved GIT_DIR is refused for a mutating verb, marker or not)
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
  // (a value or key the line does not resolve is refused outright, whoever owns the cwd)
  for (const command of [
    `git -C ${at} -c core.worktree=$W reset --hard`,
    `git -C ${at} -c "core.worktree=$(pwd)/.." checkout x`,
    `git -C ${at} --config-env=core.worktree=WT reset --hard`,
    `git -C ${at} --config-env core.worktree=WT reset --hard`,
    `git -C ${at} --config-env=Core.WorkTree=WT checkout x`,
    `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=$K GIT_CONFIG_VALUE_0=/elsewhere git -C ${at} reset --hard`,
  ]) {
    r8Refused(command, root);
  }
  // (a value that is fully resolved and unknowable only as a target keeps the unknown -> cwd check, and the cwd is the job's)
  for (const command of [
    `git -C ${fwd(norepo)} -c core.worktree=../x reset --hard`, // relative, and no git dir can be found from a directory outside any repository
    `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.worktree GIT_CONFIG_VALUE_0=/elsewhere git -C ${at} reset --hard`,
    `export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.worktree GIT_CONFIG_VALUE_0=/elsewhere && git -C ${at} reset --hard`,
    `GIT_CONFIG_PARAMETERS="'core.worktree=/elsewhere'" git -C ${at} reset --hard`,
  ]) {
    jobDenied(command, root);
  }
});

test('R4-F1: the same commands are allowed with no marker, a dead marker, when read-only, or when the value reaches an unowned directory', () => {
  const { container, job } = containerWithJob();
  const other = fakeRepo();
  const cmds = [
    `git -C ${fwd(container)} -c core.worktree=../.worktrees/slug reset --hard`,
    'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.worktree GIT_CONFIG_VALUE_0=/elsewhere git reset --hard',
  ]; // (run from a checkout no job owns, so an unknown target has nothing to fall back on)
  // (R9: a core.worktree value / --config-env variable that is not resolved is refused for a mutating verb, with a marker or without one)
  const unresolved = ['git -c core.worktree=$W reset --hard', 'git --config-env=core.worktree=WT reset --hard'];
  for (const c of cmds) assert.equal(decide(c, other).decision, 'allow', `no marker: ${c}`);
  for (const c of unresolved) r8Refused(c, other);
  mark(job, deadPid());
  for (const c of cmds) assert.equal(decide(c, other).decision, 'allow', `dead marker: ${c}`);
  for (const c of unresolved) r8Refused(c, other);
  mark(job, process.pid);
  for (const c of unresolved) r8Refused(c, other);
  for (const c of [`git -C ${fwd(container)} -c core.worktree=../.worktrees/slug status`, 'git -c core.worktree=$W status', 'git --config-env=core.worktree=WT diff', 'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.worktree GIT_CONFIG_VALUE_0=/elsewhere git log --oneline']) {
    assert.equal(decide(c, other).decision, 'allow', `read-only: ${c}`);
  }
  // relative to the git dir, `..` is the container itself, not the job's checkout
  assert.equal(decide(`git -C ${fwd(container)} -c core.worktree=.. reset --hard`, other).decision, 'allow');
  assert.equal(decide(`git -C ${fwd(container)} -c core.worktree=../../elsewhere reset --hard`, other).decision, 'allow');
  // other config keys are not core.worktree
  assert.equal(decide('GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=user.name GIT_CONFIG_VALUE_0=x git reset --hard', other).decision, 'allow');
});

// ---- review round 5 (R5-B1, R5-F1): an environment-supplied core.worktree VALUE is a target; a dynamic config KEY may be core.worktree ----

test('R5-B1: GIT_CONFIG_KEY_n / GIT_CONFIG_PARAMETERS / --config-env naming core.worktree with a value that reaches the job are refused from an unowned container', () => {
  const { container, job } = containerWithJob();
  mark(job, process.pid, 12);
  const wt = fwd(job);
  const at = fwd(container);
  for (const command of [
    `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.worktree GIT_CONFIG_VALUE_0=${wt} git reset --hard`,
    `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.worktree GIT_CONFIG_VALUE_0=${wt} git -C ${at} checkout x`,
    `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=Core.WorkTree GIT_CONFIG_VALUE_0=${wt} git reset --hard`,
    `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.worktree GIT_CONFIG_VALUE_0=../.worktrees/slug git reset --hard`, // relative: to the git dir
    `export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.worktree GIT_CONFIG_VALUE_0=${wt} && git reset --hard`,
    `export GIT_CONFIG_COUNT=1; export GIT_CONFIG_KEY_0=core.worktree; export GIT_CONFIG_VALUE_0=${wt}; git reset --hard`,
    `GIT_CONFIG_COUNT=2 GIT_CONFIG_KEY_0=user.name GIT_CONFIG_VALUE_0=x GIT_CONFIG_KEY_1=core.worktree GIT_CONFIG_VALUE_1=${wt} git reset --hard`,
    `GIT_CONFIG_PARAMETERS="'core.worktree=${wt}'" git reset --hard`,
    `GIT_CONFIG_PARAMETERS="'user.name=x' 'core.worktree'='${wt}'" git reset --hard`,
    `git --config-env=core.worktree=WT reset --hard`.replace('git ', `WT=${wt} git `),
    `WT=${wt} git --config-env core.worktree=WT reset --hard`,
    `export WT=${wt}; git --config-env=core.worktree=WT reset --hard`,
    `WT=${wt} git --config-env=CORE.WORKTREE=WT checkout x`,
  ]) {
    const v = decide(command, container);
    assert.equal(v.decision, 'deny', command);
    assert.match(v.reason, /job \(pid \d+, PR #12\) owns this checkout/, command);
  }
});

test('R5-F1: a -c / --config-env KEY that is dynamic may be core.worktree: its value is a target', () => {
  const { container, job } = containerWithJob();
  mark(job, process.pid, 12);
  const wt = fwd(job);
  for (const command of [
    `git -c "$(printf core.worktree)=${wt}" reset --hard`,
    `git -c "$(printf core.worktree)=../.worktrees/slug" reset --hard`,
    `git -c core.work\${X:-}tree=${wt} reset --hard`,
    'git -c "`printf core.worktree`=' + wt + '" checkout x',
    `git -c $K=${wt} reset --hard`,
    `git -C ${fwd(container)} -c "$(printf core.worktree)=${wt}" reset --hard`,
    `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=$(printf core.worktree) GIT_CONFIG_VALUE_0=${wt} git reset --hard`,
    `WT=${wt} git --config-env=$K=WT reset --hard`,
    `WT=${wt} git --config-env "$(printf core.worktree)=WT" reset --hard`,
  ]) {
    r8Refused(command, container); // (R9: a key that is dynamic may be core.worktree and is not resolved: refused before the job lookup)
  }
});

test('R5-F1: a dynamic key whose value is hidden in the substitution is an unknown target: refused only where the session\'s own checkout is a job\'s', () => {
  const { container, job } = containerWithJob();
  mark(job, process.pid, 12);
  const command = `git -c "$(printf core.worktree=${fwd(job)})" reset --hard`;
  assert.equal(decide(command, job).decision, 'deny');
  r8Refused(command, container); // (R9: was allowed "nothing there to fall back on"; a key that is not resolved is refused for a mutating verb, not left to the cwd check)
  assert.equal(decide(command.replace('reset --hard', 'status'), container).decision, 'allow');
});

test('R5-B1 / R5-F1: the same commands are allowed with no marker, a dead marker, when read-only, or when the value does not reach the job', () => {
  const { container, job } = containerWithJob();
  const wt = fwd(job);
  const cmds = [
    `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.worktree GIT_CONFIG_VALUE_0=${wt} git reset --hard`,
    `GIT_CONFIG_COUNT=2 GIT_CONFIG_KEY_0=user.name GIT_CONFIG_VALUE_0=x GIT_CONFIG_KEY_1=core.worktree GIT_CONFIG_VALUE_1=${wt} git reset --hard`,
    `GIT_CONFIG_PARAMETERS="'core.worktree=${wt}'" git reset --hard`,
    `WT=${wt} git --config-env=core.worktree=WT reset --hard`,
  ];
  // (R9: a key that may be core.worktree and is not resolved is refused for a mutating verb, whatever the marker says)
  const dynamicKeys = [
    `git -c "$(printf core.worktree)=${wt}" reset --hard`,
    `git -c core.work\${X:-}tree=${wt} reset --hard`,
    `WT=${wt} git --config-env=$K=WT reset --hard`,
  ];
  for (const c of cmds) assert.equal(decide(c, container).decision, 'allow', `no marker: ${c}`);
  for (const c of dynamicKeys) r8Refused(c, container);
  mark(job, deadPid());
  for (const c of cmds) assert.equal(decide(c, container).decision, 'allow', `dead marker: ${c}`);
  for (const c of dynamicKeys) r8Refused(c, container);
  mark(job, process.pid);
  for (const c of [
    `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.worktree GIT_CONFIG_VALUE_0=${wt} git status`,
    `GIT_CONFIG_PARAMETERS="'core.worktree=${wt}'" git log --oneline`,
    `WT=${wt} git --config-env=core.worktree=WT diff`,
    `git -c "$(printf core.worktree)=${wt}" status`,
  ]) assert.equal(decide(c, container).decision, 'allow', `read-only: ${c}`);
  // a literal value that does not reach the job's checkout (from a checkout no job owns), and keys that are not core.worktree
  const elsewhere = fwd(fakeRepo());
  for (const c of [
    `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.worktree GIT_CONFIG_VALUE_0=${elsewhere} git reset --hard`,
    `GIT_CONFIG_PARAMETERS="'core.worktree=${elsewhere}'" git reset --hard`,
    `WT=${elsewhere} git --config-env=core.worktree=WT reset --hard`,
    `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=user.name GIT_CONFIG_VALUE_0=${wt} git reset --hard`,
    `GIT_CONFIG_PARAMETERS="'user.name=${wt}'" git reset --hard`,
    `WT=${wt} git --config-env=user.name=WT reset --hard`,
  ]) assert.equal(decide(c, container).decision, 'allow', `elsewhere: ${c}`);
});

// ---- review round 6 (R6-B1, R6-B2): a prefix value reads the prefix assignments before it; a dynamic GIT_CONFIG_PARAMETERS entry hides no literal one ----

test('R6-B1: a GIT_CONFIG_VALUE_n / GIT_CONFIG_KEY_n / GIT_CONFIG_PARAMETERS / --config-env value that reads an earlier assignment of the same command is that value', () => {
  const { container, job } = containerWithJob();
  mark(job, process.pid, 12);
  const wt = fwd(job);
  const at = fwd(container);
  for (const command of [
    `WT=${wt} GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.worktree GIT_CONFIG_VALUE_0=$WT git reset --hard`,
    `WT=${wt} GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.worktree GIT_CONFIG_VALUE_0=\${WT} git reset --hard`,
    `WT=${wt} GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.worktree GIT_CONFIG_VALUE_0="$WT" git -C ${at} checkout x`,
    `A=${wt} B=$A GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.worktree GIT_CONFIG_VALUE_0=$B git reset --hard`,
    `K=core.worktree WT=${wt} GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=$K GIT_CONFIG_VALUE_0=$WT git reset --hard`,
    `WT=${wt} GIT_CONFIG_PARAMETERS="'core.worktree=$WT'" git reset --hard`,
    `WT=${wt} GIT_CONFIG_PARAMETERS="'user.name=x' 'core.worktree'='\${WT}'" git reset --hard`,
    `WT=${wt} TARGET=$WT git --config-env=core.worktree=TARGET reset --hard`,
    `WT=${wt} TARGET=\${WT} git --config-env core.worktree=TARGET reset --hard`,
    `A=${wt} B=$A git --config-env=core.worktree=B checkout x`,
  ]) {
    jobDenied(command, container);
  }
  // (an `env` word is expanded by the shell before env runs: its `$WT` is the shell's own, which the line never set)
  r8Refused(`env WT=${wt} GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.worktree GIT_CONFIG_VALUE_0=$WT git reset --hard`, container);
});

test('R6-B2: a literal core.worktree entry in GIT_CONFIG_PARAMETERS is a target beside a dynamic entry', () => {
  const { container, job } = containerWithJob();
  mark(job, process.pid, 12);
  const wt = fwd(job);
  for (const command of [
    `GIT_CONFIG_PARAMETERS="'user.name=$USER' 'core.worktree=${wt}'" git reset --hard`,
    `GIT_CONFIG_PARAMETERS="'core.worktree=${wt}' 'user.name=$USER'" git reset --hard`,
    `GIT_CONFIG_PARAMETERS="'user.name'='$USER' 'core.worktree'='${wt}'" git reset --hard`,
    `GIT_CONFIG_PARAMETERS="'user.\${K}=x' 'core.worktree=${wt}'" git checkout x`,
    `GIT_CONFIG_PARAMETERS="'user.name=$USER' 'core.worktree=../.worktrees/slug'" git reset --hard`,
  ]) {
    r8Refused(command, container); // (R9: the `$USER` entry leaves the list not fully resolved)
  }
});

test('R6-B1 / R6-B2: the same commands are allowed with no marker, a dead marker, when read-only, or when the value does not reach the job', () => {
  const { container, job } = containerWithJob();
  const wt = fwd(job);
  const cmds = [
    `WT=${wt} GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.worktree GIT_CONFIG_VALUE_0=$WT git reset --hard`,
    `A=${wt} B=$A GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.worktree GIT_CONFIG_VALUE_0=\${B} git reset --hard`,
    `WT=${wt} GIT_CONFIG_PARAMETERS="'core.worktree=$WT'" git reset --hard`,
    `WT=${wt} TARGET=$WT git --config-env=core.worktree=TARGET reset --hard`,
  ];
  // (R9: a dynamic entry beside the literal core.worktree one leaves the list not fully resolved: refused, marker or not)
  const dynamicEntry = `GIT_CONFIG_PARAMETERS="'user.name=$USER' 'core.worktree=${wt}'" git reset --hard`;
  for (const c of cmds) assert.equal(decide(c, container).decision, 'allow', `no marker: ${c}`);
  r8Refused(dynamicEntry, container);
  mark(job, deadPid());
  for (const c of cmds) assert.equal(decide(c, container).decision, 'allow', `dead marker: ${c}`);
  r8Refused(dynamicEntry, container);
  mark(job, process.pid);
  for (const c of [
    `WT=${wt} GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.worktree GIT_CONFIG_VALUE_0=$WT git status`,
    `WT=${wt} GIT_CONFIG_PARAMETERS="'core.worktree=$WT'" git log --oneline`,
    `WT=${wt} TARGET=$WT git --config-env=core.worktree=TARGET diff`,
    `GIT_CONFIG_PARAMETERS="'user.name=$USER' 'core.worktree=${wt}'" git status`,
  ]) assert.equal(decide(c, container).decision, 'allow', `read-only: ${c}`);
  // a value that does not reach the job's checkout (from a checkout no job owns), another key, or a name nothing assigned
  const elsewhere = fwd(fakeRepo());
  for (const c of [
    `WT=${elsewhere} GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.worktree GIT_CONFIG_VALUE_0=$WT git reset --hard`,
    `WT=${elsewhere} GIT_CONFIG_PARAMETERS="'core.worktree=$WT'" git reset --hard`,
    `WT=${elsewhere} TARGET=$WT git --config-env=core.worktree=TARGET reset --hard`,
    `WT=${wt} GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=user.name GIT_CONFIG_VALUE_0=$WT git reset --hard`,
    `WT=${wt} GIT_CONFIG_PARAMETERS="'user.name=$WT'" git reset --hard`,
    `WT=${wt} TARGET=$WT git --config-env=user.name=TARGET reset --hard`,
  ]) assert.equal(decide(c, container).decision, 'allow', `elsewhere: ${c}`);
  // (R9: any `$` left in the list, even in an entry that is not core.worktree, leaves it not fully resolved: refused for a mutating verb)
  r8Refused(`GIT_CONFIG_PARAMETERS="'user.name=${wt}' 'user.email=$USER'" git reset --hard`, container);
});

test('R6-B1: GIT_WORK_TREE / GIT_DIR prefix values read the prefix assignments before them', () => {
  const { container, job } = containerWithJob();
  mark(job, process.pid, 12);
  const wt = fwd(job);
  const at = fwd(container);
  for (const command of [
    `WT=${wt} GIT_WORK_TREE=$WT git reset --hard`,
    `WT=${wt} GIT_WORK_TREE=\${WT} git checkout x`,
    `WT=${wt} GIT_WORK_TREE="$WT" git -C ${at} reset --hard`,
    `A=${wt} B=$A GIT_WORK_TREE=$B git reset --hard`,
    `G=${wt}/.git GIT_DIR=$G git reset --hard`,
    `G=${wt}/.git GIT_DIR=\${G} git checkout x`,
    `A=${wt}/.git B=$A GIT_DIR=$B git reset --hard`,
    `G=${wt}/.git GIT_DIR=$G git -C ${at} commit -m x`,
    `WT=${wt} GIT_WORK_TREE=$WT git -C ${at} reset --hard`,
  ]) {
    jobDenied(command, container);
  }
  // (an `env` word is expanded by the shell before env runs: its `$WT` / `$G` is the shell's own, which the line never set)
  for (const command of [`env WT=${wt} GIT_WORK_TREE=$WT git reset --hard`, `env G=${wt}/.git GIT_DIR=$G git reset --hard`]) r8Refused(command, container);
  // R4-B1 ordering: a relative value is resolved against the directory the -C options produce
  assert.equal(decide(`W=.worktrees/slug GIT_WORK_TREE=$W git reset --hard`, container).decision, 'deny');
  assert.equal(decide(`W=slug GIT_WORK_TREE=$W git -C ${at}/.worktrees reset --hard`, container).decision, 'deny');
});

test('R6-B1: the same GIT_WORK_TREE / GIT_DIR commands are allowed with no marker, a dead marker, when read-only, or pointing elsewhere', () => {
  const { container, job } = containerWithJob();
  const wt = fwd(job);
  const cmds = [
    `WT=${wt} GIT_WORK_TREE=$WT git reset --hard`,
    `A=${wt} B=$A GIT_WORK_TREE=\${B} git checkout x`,
    `G=${wt}/.git GIT_DIR=$G git reset --hard`,
  ];
  // (R9: the `$G` of an env word is the shell's own, which the line never set: the value is not fully resolved, so it is refused, marker or not)
  const envWord = `env G=${wt}/.git GIT_DIR=$G git reset --hard`;
  for (const c of cmds) assert.equal(decide(c, container).decision, 'allow', `no marker: ${c}`);
  r8Refused(envWord, container);
  mark(job, deadPid());
  for (const c of cmds) assert.equal(decide(c, container).decision, 'allow', `dead marker: ${c}`);
  r8Refused(envWord, container);
  mark(job, process.pid);
  for (const c of [
    `WT=${wt} GIT_WORK_TREE=$WT git status`,
    `G=${wt}/.git GIT_DIR=$G git log --oneline`,
  ]) assert.equal(decide(c, container).decision, 'allow', `read-only: ${c}`);
  const elsewhere = fwd(fakeRepo());
  for (const c of [
    `WT=${elsewhere} GIT_WORK_TREE=$WT git reset --hard`,
    `G=${elsewhere}/.git GIT_DIR=$G git reset --hard`,
    `WT=${wt} OTHER=$WT GIT_WORK_TREE=${elsewhere} git reset --hard`,
  ]) assert.equal(decide(c, container).decision, 'allow', `elsewhere: ${c}`);
});

// ---- review round 7 (R7-B1, R7-F1, R7-F2): a value that could be read more than one way is every one of them (a candidate set), never one confident guess ----
// R7-B1: a name assigned twice in the prefix. R7-F1: `env NAME=v …` words are expanded by the shell BEFORE env runs, so `$NAME` there is the shell's own
// variable (an earlier assignment on the line, or an earlier call), not the wrapper's. R7-F2: `'$WT'` / `\$WT` reach git as the literal text (a relative path).

// the three ways a prefix reaches a checkout: GIT_WORK_TREE, GIT_DIR, and a core.worktree given as GIT_CONFIG_VALUE_0; `use(v)` is the assignment text
const R7_KINDS = [
  { name: 'GIT_WORK_TREE', v: 'WT', target: (p) => p, use: (v) => `GIT_WORK_TREE=${v}`, before: () => '' },
  { name: 'GIT_DIR', v: 'G', target: (p) => `${p}/.git`, use: (v) => `GIT_DIR=${v}`, before: () => '' },
  { name: 'GIT_CONFIG_VALUE_0', v: 'WT', target: (p) => p, use: (v) => `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.worktree GIT_CONFIG_VALUE_0=${v}`, before: (at) => `GIT_DIR=${at}/gd ` },
];
const r7Setup = () => {
  const { container, job } = containerWithJob();
  mkdirSync(join(container, 'gd'));
  // checkouts named by the literal text `$WT` / `$G`: what git finds when the shell hands it the unexpanded word
  symlinkSync(job, join(container, '$WT'));
  symlinkSync(join(job, '.git'), join(container, '$G'));
  symlinkSync(job, join(container, 'gd', '$WT'));
  return { container, job, at: fwd(container), wt: fwd(job), elsewhere: fwd(fakeRepo()), elsewhere2: fwd(fakeRepo()) };
};
const r7Verbs = ['git reset --hard', 'git checkout x'];

test('R7-B1: a name assigned twice in the prefix is both values, whichever comes last', () => {
  const { container, job, at, wt, elsewhere } = r7Setup();
  mark(job, process.pid, 12);
  for (const k of R7_KINDS) {
    for (const [a, b] of [[k.target(wt), k.target(elsewhere)], [k.target(elsewhere), k.target(wt)]]) {
      for (const verb of r7Verbs) jobDenied(`${k.before(at)}${k.v}=${a} ${k.use(`$${k.v}`)} ${k.v}=${b} ${verb}`, container);
    }
  }
});

test('R7-F1: `env NAME=v … $NAME` reads the shell\'s NAME as well as the wrapper\'s: either one reaching the job is refused', () => {
  const { container, job, at, wt, elsewhere } = r7Setup();
  mark(job, process.pid, 12);
  for (const k of R7_KINDS) {
    const n = k.v;
    for (const verb of r7Verbs) {
      // the shell's variable is the job's (set earlier on the line, or exported): the "assigned more than once" gate refuses it first (another message)
      for (const command of [
        `${n}=${k.target(wt)}; ${k.before(at)}env ${n}=${k.target(elsewhere)} ${k.use(`$${n}`)} ${verb}`,
        `export ${n}=${k.target(wt)}; ${k.before(at)}env ${n}=${k.target(elsewhere)} ${k.use(`$${n}`)} ${verb}`,
        `${n}=${k.target(elsewhere)}; ${k.before(at)}env ${n}=${k.target(wt)} ${k.use(`$${n}`)} ${verb}`,
      ]) assert.equal(decide(command, container).decision, 'deny', command);
      for (const command of [
        `${k.before(at)}env ${n}=${k.target(wt)} ${k.use(`$${n}`)} ${verb}`,
        `${k.before(at)}env ${n}=${k.target(elsewhere)} ${n}=${k.target(wt)} ${k.use(`\${${n}}`)} ${verb}`,
      ]) r8Refused(command, container); // (R9: the `$NAME` of an env word is the shell's own, which the line never set: not fully resolved)
    }
  }
});

test('R7-F2: a quoted or escaped `$` reaches git as the literal word: a relative path, which can be a link to the job\'s checkout', () => {
  const { container, job, at, elsewhere } = r7Setup();
  mark(job, process.pid, 12);
  for (const k of R7_KINDS) {
    const n = k.v;
    for (const lit of [`'$${n}'`, `"\\$${n}"`, `\\$${n}`]) {
      for (const verb of r7Verbs) jobDenied(`${k.before(at)}${n}=${k.target(elsewhere)} ${k.use(lit)} ${verb}`, container);
    }
  }
});

test('R7: the same commands are allowed with no marker, a dead marker, when read-only, or when every candidate points elsewhere', () => {
  const { container, job, at, wt, elsewhere, elsewhere2 } = r7Setup();
  const shapes = (k, a, b, dir) => [
    `${k.before(dir)}${k.v}=${a} ${k.use(`$${k.v}`)} ${k.v}=${b} git reset --hard`,
    `${k.before(dir)}env ${k.v}=${b} ${k.use(`$${k.v}`)} git reset --hard`,
    `${k.before(dir)}${k.v}=${a} ${k.use(`'$${k.v}'`)} git reset --hard`,
  ];
  const all = R7_KINDS.flatMap((k) => shapes(k, k.target(wt), k.target(elsewhere), at));
  // (R9: the `$NAME` of an env word is the shell's own, which the line never set: not fully resolved, so refused for a mutating verb, marker or not)
  const isEnv = (c) => / env [A-Z]/.test(c) || c.startsWith('env ');
  const cmds = all.filter((c) => !isEnv(c));
  assert.ok(all.length > cmds.length && cmds.length > 0);
  for (const c of cmds) assert.equal(decide(c, container).decision, 'allow', `no marker: ${c}`);
  for (const c of all.filter(isEnv)) r8Refused(c, container);
  mark(job, deadPid());
  for (const c of cmds) assert.equal(decide(c, container).decision, 'allow', `dead marker: ${c}`);
  for (const c of all.filter(isEnv)) r8Refused(c, container);
  mark(job, process.pid);
  for (const c of cmds) {
    assert.equal(decide(c.replace('git reset --hard', 'git status'), container).decision, 'allow', `read-only: ${c}`);
    assert.equal(decide(c.replace('git reset --hard', 'git log --oneline'), container).decision, 'allow', `read-only: ${c}`);
  }
  // every candidate elsewhere (a container with a live job in it, but no link and nothing assigned that reaches it)
  const { container: plain, job: plainJob } = containerWithJob();
  mkdirSync(join(plain, 'gd'));
  mark(plainJob, process.pid, 12);
  for (const k of R7_KINDS) {
    for (const c of shapes(k, k.target(elsewhere), k.target(elsewhere2), fwd(plain))) {
      if (isEnv(c)) r8Refused(c, plain); else assert.equal(decide(c, plain).decision, 'allow', `elsewhere: ${c}`);
    }
  }
});

test('R7-F1: the candidates of `$NAME` in an env wrapper word are the wrapper\'s values, the line\'s own value, and (nothing shows the shell\'s) an unknown', () => {
  const ctxWith = (vars) => ({ vars: Object.assign(Object.create(null), vars), unsureVars: new Set(), tainted: new Set() });
  const resolve = (command, vars) => resolvePrefixEnv(simpleCommands(command, {})[0].env, ctxWith(vars), command);
  const values = (r, k) => r.get(k).list.map((c) => c.v).sort();
  // the shell's WT is /owned, the wrapper's is /elsewhere: git gets the shell's, so both are candidates and nothing is unknown
  let r = resolve('env WT=/elsewhere GIT_WORK_TREE=$WT git reset --hard', { WT: '/owned' });
  assert.deepEqual(values(r, 'GIT_WORK_TREE'), ['/elsewhere', '/owned']);
  assert.equal(r.get('GIT_WORK_TREE').unknown, false);
  // an earlier call may have set it: the line shows no value, so the target is unknown (the wrapper's value is still a candidate)
  r = resolve('env WT=/elsewhere GIT_WORK_TREE=$WT git reset --hard', {});
  assert.deepEqual(values(r, 'GIT_WORK_TREE'), ['/elsewhere']);
  assert.equal(r.get('GIT_WORK_TREE').unknown, true);
  // a prefix word reads the prefix assignments before it: nothing unknown; (B1) a later assignment of the name is a candidate too
  r = resolve('WT=/a GIT_WORK_TREE=$WT WT=/b git reset --hard', {});
  assert.deepEqual(values(r, 'GIT_WORK_TREE'), ['/a', '/b']);
  assert.equal(r.get('GIT_WORK_TREE').unknown, false);
  // F2: a quoted `$` is also the literal word
  r = resolve("WT=/a GIT_WORK_TREE='$WT' git reset", {});
  assert.deepEqual(r.get('GIT_WORK_TREE').list, [{ v: '$WT', lit: true }, { v: '/a', lit: false }]);
  // nothing known: unknown, and no value to read
  r = resolve('GIT_WORK_TREE=$WT git reset', {});
  assert.equal(r.get('GIT_WORK_TREE').unknown, true);
  assert.deepEqual(r.get('GIT_WORK_TREE').list, []);
});

// R7-F2 (command line): `--work-tree='$WT'` / `--git-dir=\$G` / `-c core.worktree='$WT'` reach git as the literal word, a relative path (r7Setup has
// real links named `$WT` / `$G` in the unowned container, and `gd/$WT` for core.worktree, that lead to the job's checkout)
const r7Cli = (at, vars = '') => [
  `${vars}git --work-tree='$WT' VERB`,
  `${vars}git --work-tree=\\$WT VERB`,
  `${vars}git --work-tree "\\$WT" VERB`,
  `${vars}git --work-tree '$WT' VERB`,
  `${vars}git --git-dir='$G' VERB`,
  `${vars}git --git-dir=\\$G VERB`,
  `${vars}git --git-dir "\\$G" VERB`,
  `${vars}git --git-dir=${at}/gd -c core.worktree='$WT' VERB`,
  `${vars}git --git-dir=${at}/gd -c 'core.worktree=$WT' VERB`,
  `${vars}git --git-dir=${at}/gd -c core.worktree=\\$WT VERB`,
];

test('R7-F2: command-line --work-tree / --git-dir / -c core.worktree values with a quoted $ are candidates too', () => {
  const { container, job, at, elsewhere } = r7Setup();
  mark(job, process.pid, 12);
  // (the line sets WT / G, so the quoted word is a relative path git finds as a link to the job's checkout; with no such assignment the `$` is not resolved: refused)
  for (const verb of r7Verbs) {
    for (const t of r7Cli(at, `WT=${elsewhere}; G=${elsewhere}/.git; `)) jobDenied(t.replace('VERB', verb.slice(4)), container);
    for (const t of r7Cli(at, '')) r8Refused(t.replace('VERB', verb.slice(4)), container);
  }
});

test('R7-F2: the same command-line forms are allowed with no marker, a dead marker, when read-only, or when every candidate points elsewhere', () => {
  const { container, job, at, elsewhere } = r7Setup();
  const cmds = r7Cli(at, `WT=${elsewhere}; G=${elsewhere}/.git; `).map((t) => t.replace('VERB', 'reset --hard'));
  for (const c of cmds) assert.equal(decide(c, container).decision, 'allow', `no marker: ${c}`);
  mark(job, deadPid());
  for (const c of cmds) assert.equal(decide(c, container).decision, 'allow', `dead marker: ${c}`);
  mark(job, process.pid);
  for (const t of r7Cli(at)) assert.equal(decide(t.replace('VERB', 'status'), container).decision, 'allow', `read-only: ${t}`);
  // a container with a live job but no link: the literal word is a path nothing owns, the expansion is elsewhere
  const { container: plain, job: plainJob } = containerWithJob();
  mkdirSync(join(plain, 'gd'));
  mark(plainJob, process.pid, 12);
  for (const t of r7Cli(fwd(plain), `WT=${elsewhere}; G=${elsewhere}/.git; `)) assert.equal(decide(t.replace('VERB', 'reset --hard'), plain).decision, 'allow', `elsewhere: ${t}`);
  // plain unquoted literals are what they were
  assert.equal(decide(`git --work-tree=${fwd(job)} reset --hard`, container).decision, 'deny');
  assert.equal(decide(`git --work-tree=${elsewhere} reset --hard`, container).decision, 'allow');
});

// ---- review round 8 (R8-B1, R8-B2, R8-F1, R8-F2): a value the resolver cannot read one way is REFUSED for a mutating verb, never dropped to a cwd-only check ----
// R8-B1: a depth / work / candidate-count limit. R8-B2: a quoted word with two or more `$` pieces (the shell's per-piece mix is not in the set). R8-F1: an
// unset name in a product (`$WT$X`) must not erase the resolved siblings. R8-F2: a `$` that arrives through a substituted value is literal text, not an expansion.
const REFUSED = /cannot be read one way/;
const r8Setup = () => {
  const s = r7Setup();
  symlinkSync(s.job, join(s.container, '$Y')); // the literal word `$Y`, as git finds it from the container
  symlinkSync(s.job, join(s.container, 'gd', '$Y'));
  return s;
};
const r8Refused = (command, cwd) => {
  const v = decide(command, cwd);
  assert.equal(v.decision, 'deny', command);
  assert.match(v.reason, REFUSED, command);
};
const R8_USES = [ // the places the resolver feeds, with the value written as `v`
  { use: (v) => `GIT_WORK_TREE=${v}`, tgt: (p) => p },
  { use: (v) => `GIT_DIR=${v}`, tgt: (p) => `${p}/.git` },
];

test('R8-B1: a depth chain, 64+ candidate values or a runaway product is refused, not dropped to the raw text', () => {
  const { container, job, wt } = r8Setup();
  mark(job, process.pid, 12);
  for (const k of R8_USES) {
    for (const verb of r7Verbs) {
      r8Refused(`A=${k.tgt(wt)} B=$A C=$B D=$C E=$D F=$E G=$F H=$G ${k.use('$H')} ${verb}`, container);
      const many = Array.from({ length: 64 }, (_, i) => `WT=/safe/${i}`).join(' ');
      r8Refused(`${many} WT=${k.tgt(wt)} ${k.use('$WT')} ${verb}`, container);
      // a product of several names that is more than 64 candidates
      const names = ['P', 'Q', 'R'].map((n) => Array.from({ length: 5 }, (_, i) => `${n}=/s${i}`).join(' ')).join(' ');
      r8Refused(`${names} P=${k.tgt(wt)} ${k.use('$P$Q$R')} ${verb}`, container);
    }
  }
  // the config-value place and the command line
  r8Refused(`GIT_DIR=${fwd(container)}/gd GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.worktree A=${wt} B=$A C=$B D=$C E=$D F=$E G=$F H=$G GIT_CONFIG_VALUE_0=$H git reset --hard`, container);
});

test('R8-B2: a quoted word with two or more `$` pieces is refused (the shell\'s per-piece mix is not in the candidate set)', () => {
  const base = fakeRepo();
  const owned = join(base, '$literal', 'owned');
  mkdirSync(join(owned, '.git'), { recursive: true });
  mark(owned, process.pid, 12);
  const b = fwd(base);
  for (const verb of r7Verbs) {
    r8Refused(`TAIL=/owned GIT_WORK_TREE='${b}/$literal'\${TAIL} ${verb}`, base);
    r8Refused(`TAIL=/owned GIT_WORK_TREE="${b}/\\$literal"\${TAIL} ${verb}`, base);
    r8Refused(`TAIL=/.git GIT_DIR='${b}/$literal/owned'\${TAIL} ${verb}`, base);
    r8Refused(`T=/owned git --work-tree='${b}/$literal'\${T} ${verb.slice(4)}`, base);
    r8Refused(`T=/owned git --git-dir='${b}/$literal'\${T} ${verb.slice(4)}`, base);
    r8Refused(`T=/owned git -c core.worktree='${b}/$literal'\${T} ${verb.slice(4)}`, base);
  }
});

test('R8-F1: an unset name in a product contributes the empty string: `$WT$X` and `$WT/$X` keep the resolved value', () => {
  const { container, job, at, wt } = r8Setup();
  mark(job, process.pid, 12);
  for (const k of R8_USES) {
    for (const verb of r7Verbs) {
      for (const v of ['$WT$X', '$WT/$X', '${WT}${X}', '$X$WT', '$WT$X$Z']) r8Refused(`WT=${k.tgt(wt)} ${k.use(v)} ${verb}`, container); // (R9: $X is unset on the line)
    }
  }
  for (const verb of r7Verbs) r8Refused(`GIT_DIR=${at}/gd GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.worktree WT=${wt} GIT_CONFIG_VALUE_0=$WT$X ${verb}`, container);
});

test('R8-F2: a `$` that arrives through a substituted value is literal text (a relative path), not an expansion to drop', () => {
  const { container, job, at } = r8Setup();
  mark(job, process.pid, 12);
  for (const verb of r7Verbs) {
    for (const c of [
      `WT='$Y' GIT_WORK_TREE=$WT ${verb}`,
      `X='$Y'; GIT_WORK_TREE=$X ${verb}`,
      `X='$Y'; GIT_DIR=$X ${verb}`,
      `X='$Y'; git --work-tree=$X ${verb.slice(4)}`,
      `X='$Y'; git --git-dir=$X ${verb.slice(4)}`,
      `X='$Y'; git --git-dir=${at}/gd -c core.worktree=$X ${verb.slice(4)}`,
      `X='$Y'; git --git-dir=${at}/gd --config-env=core.worktree=X ${verb.slice(4)}`,
      `X='$Y'; GIT_DIR=${at}/gd GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.worktree GIT_CONFIG_VALUE_0=$X ${verb}`,
    ]) r8Refused(c, container);
  }
});

test('R8: refusal applies to a mutating verb only, and plain or single-piece values are not refused', () => {
  const { container, job, at, wt, elsewhere } = r8Setup();
  mark(job, process.pid, 12);
  const hard = [
    `A=${wt} B=$A C=$B D=$C E=$D F=$E G=$F H=$G GIT_WORK_TREE=$H git %`,
    `WT='$Y' GIT_WORK_TREE=$WT git %`,
    `X='$Y'; GIT_WORK_TREE=$X git %`,
    `X='$Y'; git --work-tree=$X %`,
    `WT=${wt} GIT_WORK_TREE=$WT$X git %`,
    `TAIL=/owned GIT_WORK_TREE='${at}/$literal'\${TAIL} git %`,
  ];
  for (const t of hard) for (const ro of ['status', 'log --oneline', 'diff', 'fetch']) {
    const c = t.replace('%', ro);
    // (`git --work-tree=$X git status` is not a shape; the command-line forms carry the verb after the option)
    const v = decide(c.replace('git git', 'git'), container);
    assert.equal(v.decision, 'allow', `read-only: ${c}`);
  }
  // single-piece or plain values that point elsewhere are allowed (no marker for them), as before
  const { container: plain, job: plainJob } = containerWithJob();
  mark(plainJob, process.pid, 12);
  for (const c of [
    `GIT_WORK_TREE=${elsewhere} git reset --hard`,
    `WT=${elsewhere} GIT_WORK_TREE=$WT git reset --hard`,
    `WT=${elsewhere} GIT_WORK_TREE='$WT' git reset --hard`,
    `git --work-tree=${elsewhere} reset --hard`,
    `A=${elsewhere} B=$A C=$B GIT_WORK_TREE=$C git reset --hard`,
  ]) assert.equal(decide(c, plain).decision, 'allow', c);
  // (R9: `$X` is a name the line never set, so the product is not fully resolved: refused for a mutating verb even where it points elsewhere)
  r8Refused(`WT=${elsewhere} GIT_WORK_TREE=$WT$X git reset --hard`, plain);
  // no marker: a plain command is allowed, whatever it holds
  const { container: free } = containerWithJob();
  assert.equal(decide(`GIT_WORK_TREE=${elsewhere} git reset --hard`, free).decision, 'allow');
});

test('R8: the candidate sets say when they are refused, for each trigger', () => {
  const ctxWith = (vars, extra = {}) => ({ vars: Object.assign(Object.create(null), vars), unsureVars: new Set(), tainted: new Set(), ...extra });
  const resolve = (command, vars) => resolvePrefixEnv(simpleCommands(command, {})[0].env, ctxWith(vars), command);
  const refused = (command, vars = {}) => resolve(command, vars).get('GIT_WORK_TREE').refused;
  // (1) a depth chain, the candidate-count cap, the work cap
  assert.equal(refused('A=/owned B=$A C=$B D=$C E=$D F=$E G=$F H=$G GIT_WORK_TREE=$H git reset --hard'), true);
  assert.equal(refused(`${Array.from({ length: 64 }, (_, i) => `WT=/s${i}`).join(' ')} WT=/owned GIT_WORK_TREE=$WT git reset`), true);
  assert.equal(refused(`${['P', 'Q', 'R'].map((n) => Array.from({ length: 5 }, (_, i) => `${n}=/s${i}`).join(' ')).join(' ')} GIT_WORK_TREE=$P$Q$R git reset`), true);
  assert.equal(refused(`${Array.from({ length: 40 }, (_, i) => `A=$B B=$A C${i}=$A`).join(' ')} GIT_WORK_TREE=$A git reset`), true);
  // (3) a quoted word with two `$` pieces
  assert.equal(refused("TAIL=/owned GIT_WORK_TREE='/repo/$literal'${TAIL} git reset"), true);
  assert.equal(refused('TAIL=/owned GIT_WORK_TREE="/repo/\\$literal"${TAIL} git reset'), true);
  // (4) a substituted value that still holds `$` or a backtick: from a prefix assignment, an env word, the line's own variable
  assert.equal(refused("WT='$Y' GIT_WORK_TREE=$WT git reset"), true);
  assert.equal(refused("env WT='$Y' GIT_WORK_TREE=$WT git reset"), true);
  assert.equal(refused('GIT_WORK_TREE=$X git reset', { X: '$Y' }), true);
  assert.equal(refused('GIT_WORK_TREE=$X git reset', { X: '`pwd`' }), true);
  // not refused: a plain literal, one piece (quoted or not), an unset name (the empty string: `$WT$X` keeps `/owned`)
  assert.equal(refused('GIT_WORK_TREE=/owned git reset'), false);
  assert.equal(refused("GIT_WORK_TREE='/repo/$literal' git reset"), false);
  assert.equal(refused('WT=/a GIT_WORK_TREE=$WT git reset'), false);
  assert.equal(refused('GIT_WORK_TREE=$WT git reset'), false);
  assert.equal(refused('WT=/a B=$WT GIT_WORK_TREE=$B git reset'), false);
  const r = resolve('WT=/owned GIT_WORK_TREE=$WT$X git reset', {}).get('GIT_WORK_TREE');
  assert.deepEqual(r.list.map((c) => c.v), ['/owned']);
  assert.equal(r.unknown, true);
  assert.equal(r.refused, false);
  assert.deepEqual(resolve('WT=/owned GIT_WORK_TREE=$WT/$X git reset', {}).get('GIT_WORK_TREE').list.map((c) => c.v), ['/owned/']);
});

// R8-F2 (exported values): a GIT_* name an earlier `export` / assignment on the line gave a value reaches git too (hint()/ctx.vars); one still holding
// `$` or a backtick is the literal text of a relative path (or something the line never resolved), so a mutating verb is refused like a prefix value
test('R8-F2: an exported GIT_DIR / GIT_WORK_TREE / GIT_CONFIG_* value holding `$` or a backtick is refused for a mutating verb', () => {
  const { container, job, at, wt, elsewhere } = r8Setup();
  const shapes = (verb) => [
    `export GIT_WORK_TREE='$Y'; git ${verb}`,
    `export GIT_DIR=\\$G; git ${verb}`,
    `export GIT_DIR='$G'; git ${verb}`,
    `GIT_WORK_TREE='$Y'; export GIT_WORK_TREE; git ${verb}`,
    `export GIT_WORK_TREE=\`pwd\`; git ${verb}`,
    `export GIT_WORK_TREE=$(pwd); git ${verb}`,
    `export GIT_WORK_TREE='${at}/$lit'\${T}; git ${verb}`,
    `export GIT_CONFIG_PARAMETERS="'core.worktree=\\$Y'"; git ${verb}`,
    `export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.worktree GIT_CONFIG_VALUE_0='$Y'; GIT_DIR=${at}/gd git ${verb}`,
    `export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0='core.$k' GIT_CONFIG_VALUE_0=${wt}; GIT_DIR=${at}/gd git ${verb}`,
  ];
  mark(job, process.pid, 12);
  for (const verb of ['reset --hard', 'checkout x']) for (const c of shapes(verb)) r8Refused(c, container);
  // marker or not: the verdict does not depend on one
  const { container: free } = containerWithJob();
  r8Refused("export GIT_WORK_TREE='$Y'; git reset --hard", free);
  // read-only verbs are unaffected; so are plain literal exports pointing elsewhere 
  for (const verb of ['status', 'log --oneline', 'diff']) for (const c of shapes(verb)) assert.equal(decide(c, container).decision, 'allow', `read-only: ${c}`);
  for (const c of [
    `export GIT_WORK_TREE=${elsewhere}; git reset --hard`,
    `export GIT_DIR=${elsewhere}/.git; git checkout x`,
    `GIT_WORK_TREE=${elsewhere}; export GIT_WORK_TREE; git reset --hard`,
  ]) assert.equal(decide(c, container).decision, 'allow', c);
});

// R8-F2 (assigned more than once): a GIT_* selector the line assigned or exported more than once is "unsure" (which assignment ran is unknown), so the value
// git gets cannot be read at all: refused for a mutating verb, unless this command's own prefix sets the name to a value that is not itself refused
test('R8-F2: a GIT_* selector assigned or exported more than once on the line is refused for a mutating verb', () => {
  const { container, job, wt, at, elsewhere } = r8Setup();
  const twice = (verb) => [
    `export GIT_WORK_TREE=${elsewhere}; export GIT_WORK_TREE=${wt}; git ${verb}`,
    `export GIT_WORK_TREE=${wt}; export GIT_WORK_TREE=${elsewhere}; git ${verb}`,
    `GIT_DIR=${elsewhere}/.git; GIT_DIR=${wt}/.git; export GIT_DIR; git ${verb}`,
    `export GIT_DIR=${wt}/.git; GIT_DIR=${elsewhere}/.git; git ${verb}`,
    `export GIT_CONFIG_PARAMETERS="'a.b=c'"; export GIT_CONFIG_PARAMETERS="'core.worktree=${wt}'"; git ${verb}`,
    `export GIT_CONFIG_KEY_0=x.y; export GIT_CONFIG_KEY_0=core.worktree; GIT_DIR=${at}/gd git ${verb}`,
    `GIT_CONFIG_VALUE_0=${elsewhere}; export GIT_CONFIG_VALUE_0=${wt}; GIT_DIR=${at}/gd git ${verb}`,
    `export GIT_WORK_TREE=${elsewhere}; export GIT_WORK_TREE=${wt}; GIT_DIR='$G' git ${verb}`, // (a prefix value that is itself refused does not win)
  ];
  mark(job, process.pid, 12);
  for (const verb of ['reset --hard', 'checkout x']) for (const c of twice(verb)) r8Refused(c, container);
  const { container: free } = containerWithJob();
  r8Refused(`export GIT_WORK_TREE=/a; export GIT_WORK_TREE=/b; git reset --hard`, free);
  for (const verb of ['status', 'log --oneline', 'diff']) for (const c of twice(verb)) assert.equal(decide(c, container).decision, 'allow', `read-only: ${c}`);
  // a single plain export is unchanged, and this command's own (not refused) prefix wins over the doubly assigned one
  for (const c of [
    `export GIT_WORK_TREE=${elsewhere}; git reset --hard`,
    `export GIT_WORK_TREE=/a; export GIT_WORK_TREE=/b; GIT_WORK_TREE=${elsewhere} git reset --hard`,
    `export GIT_DIR=/a/.git; GIT_DIR=/b/.git; GIT_DIR=${elsewhere}/.git git checkout x`,
  ]) assert.equal(decide(c, container).decision, 'allow', c);
  assert.equal(decide(`export GIT_WORK_TREE=/a; export GIT_WORK_TREE=/b; GIT_WORK_TREE=${wt} git reset --hard`, container).decision, 'deny');
});

// ---- review round 9 (R9-B1, R9-F1): a git dir / work tree / core.worktree value that is not FULLY resolved is refused for a mutating verb ----
// Bash expands the words of a command before its own prefix assignments apply (`X=1 echo $X` prints nothing) and an unset name is the empty string,
// so a value that holds a name the line shows as unset or set later is not one the resolver can read; only `-C` / `cd` keep the "unknown -> cwd" check.

const r9Layout = () => {
  const { container, job } = containerWithJob(); // the unowned container; the job owns <container>/.worktrees/slug
  const wt = fwd(job);
  mark(job, process.pid, 12);
  return { container, job, wt, safe: `${wt}-safe` };
};
// the mutating forms of every selector, each with `$X` (unset on the line, or set only by the command's own prefix) inside the value
const r9Shapes = (wt, verb = 'reset --hard') => [
  `GIT_WORK_TREE=${wt}$X X=-safe git ${verb}`, // R9-B1
  `GIT_WORK_TREE=${wt}$X git ${verb}`,
  `GIT_DIR=${wt}$X/.git X=-safe git ${verb}`,
  `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.worktree GIT_CONFIG_VALUE_0=${wt}$X X=-safe git ${verb}`,
  `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.worktree GIT_CONFIG_VALUE_0=${wt}$X git ${verb}`,
  `GIT_CONFIG_PARAMETERS="'core.worktree=${wt}$X'" X=-safe git ${verb}`,
  `env GIT_WORK_TREE=${wt}$X X=-safe git ${verb}`,
  `X=-safe git --work-tree=${wt}$X ${verb}`, // R9-F1
  `X=-safe git --work-tree ${wt}$X ${verb}`,
  `X=-safe git --git-dir=${wt}$X/.git ${verb}`,
  `X=-safe git --git-dir ${wt}$X/.git ${verb}`,
  `X=-safe git -c core.worktree=${wt}$X ${verb}`,
  `X=-safe git --config-env=core.worktree=WT ${verb}`,
  `git --work-tree=${wt}$X ${verb}`,
  `git -c core.worktree=${wt}$X ${verb}`,
  // `${X:-…}` forms the expander does not handle
  `GIT_WORK_TREE=\${X:-${wt}} git ${verb}`,
  `GIT_DIR=\${X:-${wt}/.git} git ${verb}`,
  `git --work-tree=\${X:-${wt}} ${verb}`,
  `git --git-dir=\${X:-${wt}/.git} ${verb}`,
  `git -c core.worktree=\${X:-${wt}} ${verb}`,
  // a substitution as the selector, from an unowned cwd
  `GIT_DIR=$(git rev-parse --git-dir) git ${verb}`,
  `GIT_WORK_TREE=$(pwd) git ${verb}`,
  `git --git-dir="$(git rev-parse --git-dir)" ${verb}`,
  `git --work-tree "$(pwd)" ${verb}`,
];

test('R9-B1 / R9-F1: a selector value not fully resolved is refused for a mutating verb, with a marker or without one', () => {
  const { container, job, wt, safe } = r9Layout();
  const { container: free } = containerWithJob(); // no marker anywhere
  for (const verb of ['reset --hard', 'checkout x', 'commit -m x']) {
    for (const c of r9Shapes(wt, verb)) {
      r8Refused(c, container); // (unowned cwd: the owned checkout is named only through the unresolved value)
      r8Refused(c, job);
      r8Refused(c, free);
    }
  }
  // the unset reading is a candidate of its own: `/owned` beside `/owned-safe` (R9-B1, in the candidate set itself)
  const ctx = { vars: Object.create(null), unsureVars: new Set(), tainted: new Set() };
  const cmd = `GIT_WORK_TREE=${wt}$X X=-safe git reset --hard`;
  const cands = resolvePrefixEnv(simpleCommands(cmd, {})[0].env, ctx, cmd).get('GIT_WORK_TREE');
  assert.deepEqual(cands.list.map((c) => c.v).sort(), [wt, safe].sort());
  assert.equal(cands.unknown, true);
});

test('R9: read-only verbs, the -C / cd fallback and fully resolved line-local forms are not refused', () => {
  const { container, job, wt } = r9Layout();
  const other = fakeRepo();
  for (const c of r9Shapes(wt, 'status')) assert.equal(decide(c, container).decision, 'allow', `read-only: ${c}`);
  for (const c of r9Shapes(wt, 'log --oneline')) assert.equal(decide(c, job).decision, 'allow', `read-only (owned cwd): ${c}`);
  // -C with a substitution keeps the unknown -> cwd check: read-only always, a mutating verb only where the cwd is the owned checkout
  assert.equal(decide('git -C "$(git rev-parse --show-toplevel)" status', container).decision, 'allow');
  assert.equal(decide('git -C "$(git rev-parse --show-toplevel)" checkout x', container).decision, 'allow'); // unowned cwd, no marker there
  assert.equal(decide('git -C "$(git rev-parse --show-toplevel)" checkout x', other).decision, 'allow');
  assert.equal(decide('cd "$(git rev-parse --show-toplevel)" && git checkout x', container).decision, 'allow');
  const owned = decide('git -C "$(git rev-parse --show-toplevel)" checkout x', job);
  assert.equal(owned.decision, 'deny'); // (the session sits in the owned checkout: the cwd check, not the refusal)
  assert.match(owned.reason, /job \(pid \d+, PR #12\) owns this checkout/);
  // fully resolved line-local forms: unchanged
  const elsewhere = fwd(other);
  for (const c of [
    `WT=${elsewhere} GIT_WORK_TREE=$WT git reset --hard`,
    `W=${elsewhere}; git --work-tree=$W reset --hard`,
    `W=${elsewhere}; git --git-dir=$W/.git checkout x`,
    `W=${elsewhere}; git -c core.worktree=$W reset --hard`,
    `W=${elsewhere}; X=-safe git --work-tree=$W reset --hard`,
    `GIT_WORK_TREE=${elsewhere} git reset --hard`,
    `GIT_DIR=${elsewhere}/.git git checkout x`,
    `git -C ${elsewhere} reset --hard`,
  ]) assert.equal(decide(c, container).decision, 'allow', c);
  // and a resolved one that does reach the owned checkout is still the job's deny
  for (const c of [`W=${wt}; git --work-tree=$W reset --hard`, `WT=${wt} GIT_WORK_TREE=$WT git reset --hard`, `git --work-tree=${wt} reset --hard`]) jobDenied(c, container);
});

test('R9-F1: an earlier assignment on the line is what a command-line word reads, not the git command\'s own prefix', () => {
  const { container, wt } = r9Layout();
  // X=a on the line first: `$X` is `a` in the argument word (another name in the prefix changes nothing), so the target is /…/sluga: fully resolved, not the job's
  assert.equal(decide(`X=a; Z=-safe git --work-tree=${wt}$X reset --hard`, container).decision, 'allow');
  // the name set on the line only by the command's own prefix is unset when the word expands: refused
  r8Refused(`X=-safe git --work-tree=${wt}$X reset --hard`, container);
});

// ---- review round 10 (R10-B1): a GIT_CONFIG_VALUE_n is a path only when its paired key may be core.worktree ----

test('R10-B1: a GIT_CONFIG_VALUE_n whose key is not core.worktree is never a path, however it reads (same as -c)', () => {
  const { container, job } = containerWithJob();
  const free = containerWithJob().container;
  const cfg = (key, value, verb) => `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=${key} GIT_CONFIG_VALUE_0=${value} git ${verb}`;
  const commands = [
    cfg('core.commentChar', '-', 'add file.txt'),
    cfg('user.name', '$USER', 'commit -m x'),
    cfg('user.name', '~someone', 'commit -m x'),
    cfg('user.email', '${X:-a@b.c}', 'commit -m x'),
    cfg('core.commentChar', '$(printf "#")', 'commit -m x'),
    `export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.commentChar GIT_CONFIG_VALUE_0=- && git add file.txt`,
    'export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=user.name GIT_CONFIG_VALUE_0=$USER; git commit -m x',
    'git -c core.commentChar=- add file.txt', // the -c path: allowed
  ];
  const check = (cwd, label) => { for (const c of commands) assert.equal(decide(c, cwd).decision, 'allow', `${label}: ${c}`); };
  check(free, 'no marker');
  check(container, 'unowned cwd, live job elsewhere');
  mark(job, process.pid, 12);
  check(container, 'live job in a sibling');
  check(free, 'live job elsewhere');
});

test('R10-B1: a GIT_CONFIG_VALUE_n whose key may be core.worktree (or cannot be read) is refused when the value is not resolved', () => {
  const { container, job } = containerWithJob();
  const free = containerWithJob().container;
  const wt = fwd(job);
  const cfg = (key, value, verb = 'reset --hard') => `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=${key} GIT_CONFIG_VALUE_0=${value} git ${verb}`;
  const commands = [
    cfg('core.worktree', `${wt}$X`),
    cfg('core.worktree', '$X'),
    cfg('core.worktree', '-'),
    cfg('Core.WorkTree', `${wt}$X`),
    cfg('CORE.WORKTREE', '~someone'),
    cfg('$K', '$X'), // a key that cannot be read stays fail closed
    cfg('$K', '-'),
    cfg('$(printf core.worktree)', '$X'),
    `GIT_CONFIG_COUNT=2 GIT_CONFIG_KEY_0=user.name GIT_CONFIG_VALUE_0=x GIT_CONFIG_KEY_1=core.worktree GIT_CONFIG_VALUE_1=${wt}$X git reset --hard`,
  ];
  mark(job, process.pid, 12);
  for (const cwd of [container, free, job]) for (const c of commands) r8Refused(c, cwd);
  mark(job, deadPid());
  for (const cwd of [container, free]) for (const c of commands) r8Refused(c, cwd);
  // read-only verbs stay allowed
  assert.equal(decide(cfg('core.worktree', `${wt}$X`, 'status'), container).decision, 'allow');
});

// the selector work (R1-R10) reads a -c / --config-env key after expansion: the variable may hold `core.worktree=<path>` (key and value in one word)
test('R12 follow-through: a -c / --config-env key read after expansion may be core.worktree (the variable holds key and value)', () => {
  const { job } = containerWithJob();
  const free = containerWithJob().container;
  const at = fwd(job);
  mark(job, process.pid, 12);
  for (const c of [
    `KV=core.worktree=${at}; git -c $KV reset --hard`,
    `KV=core.worktree=${at}; git -c $KV add f`,
    `X=core.worktree=V; V=${at}; git --config-env=$X reset --hard`,
  ]) assert.equal(decide(c, free).decision, 'deny', c);
  // a `$` in the VALUE of a literal key, or a prefix variable that is no key, changes nothing
  for (const c of ['git -c user.name=$USER commit -m x', 'WT=x git -c core.commentChar=- add f', `git -C ${at} -c user.name=$USER status`]) {
    assert.equal(decide(c, free).decision, 'allow', c);
  }
  assert.equal(decide('git -c user.name=$USER commit -m x', job).decision, 'deny'); // (commit in the job's own checkout: the job's, as before)
});
