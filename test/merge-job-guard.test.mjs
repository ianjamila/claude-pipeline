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

