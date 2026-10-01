import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, realpathSync, readFileSync, cpSync } from 'node:fs';
import { tmpdir, devNull } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateGitCommand } from '../pipeline/hooks/lib/git-policy.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = resolve(HERE, '../pipeline/hooks/guard-git.mjs');
const FAKE_GH = resolve(HERE, 'fixtures/fake-gh.mjs');

// Evaluate with injected branch / label lookups. `o.branch`: branch name, or null for detached.
// `o.byDir`: branch per directory. `o.labels`: labels of any issue, or an Error to throw.
// `o.pushDest`: what `git rev-parse @{push}` says (string), null when it fails, or an Error to throw.
// Paths go through resolve() so the table reads the same on Windows, where '/other' becomes 'C:\\other'.
function evaluate(command, o = {}) {
  const calls = { labels: [], branchDirs: [], pushDirs: [] };
  const byDir = o.byDir && Object.fromEntries(Object.entries(o.byDir).map(([k, v]) => [resolve(k), v]));
  const verdict = evaluateGitCommand(command, {
    cwd: o.cwd ?? '/work/repo',
    home: '/home/u',
    currentBranch: (dir, extra) => {
      calls.branchDirs.push({ dir, ...extra });
      if (byDir) return byDir[dir] ?? null;
      return o.branch === undefined ? 'agent/x' : o.branch;
    },
    pushDestination: (dir, extra) => {
      calls.pushDirs.push({ dir, ...extra });
      if (o.pushDest instanceof Error) throw o.pushDest;
      return o.pushDest ?? null;
    },
    issueLabels: (n, repoArgs, cwd) => {
      calls.labels.push({ n, repoArgs, cwd });
      if (o.labels instanceof Error) throw o.labels;
      return o.labels ?? [];
    },
    readText: o.readText ?? (() => null),
  });
  return Object.assign(verdict, { calls });
}

// [command, options]
const DENY = [
  ['git push origin main'],
  ['git push origin HEAD:main'],
  ['git push origin HEAD:refs/heads/main'],
  ['git push origin feature:master'],
  ['git push --force origin agent/x'],
  ['git push -f'],
  ['git push origin +agent/x'],
  ['git push --force-with-lease origin agent/x'],
  ['git push --force-with-lease=agent/x:abc origin agent/x'],
  ['git push --force-if-includes origin agent/x'],
  ['git push origin :main'],
  ['git push origin --delete main'],
  ['git push --all origin'],
  ['git push --mirror origin'],
  ['cd repo && git push origin main'],
  ['git -C /repo push origin main'],
  ['FOO=1 git push origin main'],
  ['bash -c "git push origin main"'],
  ["sh -c 'git push -f'"],
  ['echo hi; git push origin main'],
  ['git push origin main 2>&1 | tail -5'],
  ['git push', { branch: 'main' }],
  ['git push origin', { branch: 'master' }],
  ['git push origin HEAD', { branch: 'main' }],
  ['git push', { branch: null }],
  ['gh pr merge 12 --admin --squash'],
  ['gh api -X PUT repos/o/r/branches/main/protection --input p.json'],
  ['gh api --method DELETE repos/o/r/branches/main/protection'],
  ['gh api repos/o/r/rulesets -X POST --input r.json'],
  ['gh api -X PATCH repos/o/r -f allow_auto_merge=false'],
  ['gh repo edit --enable-auto-merge=false'],
  ['gh pr edit 12 --add-label human-approved'],
  ['gh pr edit 12 --add-label "bug,test-change-approved"'],
  ['gh issue edit 5 --remove-label pipeline-pause'],
  ['gh pr edit 12 --remove-label needs-human'],
  ['gh api repos/o/r/issues/12/labels -f "labels[]=human-approved"'],
  ['gh api -X DELETE repos/o/r/issues/12/labels/needs-human'],
  ['gh issue close 7', { labels: ['pipeline-pause'] }],
  ['gh issue close 7', { labels: new Error('gh: network down') }],
  ['eval "git push origin main"'],
  ['git push origin main --dry-run'],
  ['echo $(git push origin main)'],
  ['git push origin refs/heads/agent/x:refs/heads/main'],
  ['node ~/.claude/pipeline/bin/pipeline.mjs job start x -- gh pr edit 1 --add-label human-approved'],
  ['node /h/.claude/pipeline/bin/pipeline.mjs job start x -- git push origin main'],
  ['gh label delete needs-human --yes'],
];

const ALLOW = [
  ['git push -u origin agent/feature-x'],
  ['git push origin agent/x'],
  ['git push origin HEAD', { branch: 'agent/x' }],
  ['git push', { branch: 'agent/x' }],
  ['git status'],
  ['git log main..HEAD'],
  ['git checkout main'],
  ['git pull origin main'],
  ['git fetch origin main'],
  ['git merge origin/main'],
  ['echo "git push origin main"'],
  ['gh pr merge 12 --squash --auto --delete-branch'],
  ['gh api repos/o/r/branches/main/protection'],
  ['gh pr edit 12 --add-label needs-human'],
  ['gh pr edit 12 --remove-label run-e2e'],
  ['gh issue close 9', { labels: ['bug'] }],
  ['gh pr view 12 --json labels'],
  ['npm run merge -- 12'],
  ['git push origin agent/main-menu-fix'],
  ['git push origin feature/master-data'],
  ['git commit -m "push to main later"'],
  ['grep -r "git push origin main" docs/'],
  ['gh api repos/o/r/rulesets'],
  ['gh label create human-approved --color 0e8a16'],
  ['node ~/.claude/pipeline/bin/pipeline.mjs job start v -- node scripts/verify.mjs'],
];

const label = (command, o) => (o ? `${command}  ${JSON.stringify(o, (k, v) => (v instanceof Error ? `Error(${v.message})` : v))}` : command);

for (const [command, o] of DENY) {
  test(`DENY ${label(command, o)}`, () => {
    const v = evaluate(command, o);
    assert.equal(v.decision, 'deny', `expected deny, got allow for: ${command}`);
    assert.ok(typeof v.reason === 'string' && v.reason.length > 10, 'a denial explains itself');
  });
}

for (const [command, o] of ALLOW) {
  test(`ALLOW ${label(command, o)}`, () => {
    const v = evaluate(command, o);
    assert.equal(v.decision, 'allow', `expected allow, got deny (${v.reason}) for: ${command}`);
  });
}

// ---- beyond the published table: parsing details, edge cases, and same-intent routes -------------------

const MORE_DENY = [
  // push options and refspec forms
  ['git push -fu origin agent/x'],
  ['git push -u -f origin agent/x'],
  ['git push --force-w origin agent/x'], // git accepts unambiguous abbreviations
  ['git push --repo origin main'],
  ['git push --repo=origin main'],
  ['git push -o ci.skip origin main'],
  ['git push --push-option=x origin main'],
  ['git push origin refs/heads/*:refs/heads/*'],
  ['git push origin :'],
  ['git push +agent/x'],
  ['git push origin main:'],
  ['git push origin HEAD:', { branch: 'main' }],
  ['git push origin @', { branch: 'main' }],
  ['git push origin HEAD:heads/main'],
  ['git push origin HEAD:@', { branch: 'master' }],
  ['git push origin main:main'],
  // a bare push goes where git would send it (@{push}), not where the branch name suggests
  ['git push', { pushDest: 'origin/main' }],
  ['git push origin', { pushDest: 'origin/master' }],
  ['git push -u origin', { pushDest: 'origin/main' }],
  ['git push --dry-run', { pushDest: 'origin/main' }],
  ['git push', { pushDest: 'refs/heads/main' }],
  ['git push', { pushDest: 'refs/remotes/origin/master' }],
  ['git push', { pushDest: 'upstream/main' }],
  ['git push', { pushDest: 'main' }],
  ['git push', { pushDest: 'origin/main', branch: null }],
  ['git push', { pushDest: null, branch: 'main' }], // lookup failed: fall back to the current-branch rule
  ['git push', { pushDest: new Error('git: timed out'), branch: 'master' }],
  ['git push', { pushDest: null, branch: null }],
  ['cd /other && git push', { pushDest: 'origin/main', byDir: { '/other': 'agent/y' } }],
  ['git push origin agent/x main'],
  ['git push git@github.com:o/r.git main'],
  ['git push https://github.com/o/r.git HEAD:main'],
  ['git push HEAD:main'],
  ['git push origin -- main'],
  ['git push origin HEAD', { branch: null }],
  ['git push origin --branches'],
  ['git push --tags', { branch: 'main' }],
  ['git -c user.name=x push origin main'],
  ['git --no-pager push --force'],
  ['/usr/bin/git push origin main'],
  ['git.exe push origin main'],
  ['env GIT_TRACE=1 git push origin main'],
  ['sudo -u bot git push origin main'],
  ['git status && git push origin main'],
  ['(git push origin main)'],
  ['{ git push origin main; }'],
  ['git push origin agent/x && git push origin HEAD:main'],
  ['bash -c "cd /repo && git push -f"'],
  ["bash -c 'bash -c \"git push origin main\"'"],
  ['cat <<EOF | sh\ngit push origin main\nEOF'],
  ['find . -name x -exec git push origin main ;'],
  // cwd tracking
  ['cd /other && git push', { byDir: { '/work/repo': 'agent/x', '/other': 'main' } }],
  ['git -C /other push', { byDir: { '/work/repo': 'agent/x', '/other': 'master' } }],
  ['git -C ../other push', { cwd: '/work/repo', byDir: { '/work/other': 'main' } }],
  ['git -C a -C b push', { cwd: '/w', byDir: { '/w/a/b': 'main' } }],
  ['cd ~/proj && git push', { byDir: { '/home/u/proj': 'main' } }],
  ['cd "$REPO" && git push', { branch: 'agent/x' }], // unknown directory: cannot verify
  ['cd - && git push', { branch: 'agent/x' }],
  ['git -C "$(pwd)/x" push', { branch: 'agent/x' }],
  ['DIR=/other; cd $DIR && git push', { byDir: { '/other': 'main', '/work/repo': 'agent/x' } }],
  // variables assigned earlier on the line, and destinations computed at run time
  ['BRANCH=main; git push origin $BRANCH'],
  ['export B=master && git push origin "$B"'],
  ['B=main; git push origin HEAD:${B}'],
  ['git push origin "$(git rev-parse --abbrev-ref HEAD)"', { branch: 'main' }],
  ['git push origin "$(git branch --show-current)"', { branch: null }],
  ['git push origin $(echo main)'],
  ['git push origin HEAD:$(echo refs/heads/master)'],
  ['git push origin "$X"', { branch: 'master' }],
  // gh
  ['gh pr merge --admin 12'],
  ['gh pr merge 12 --admin=true --squash'],
  ['gh -R o/r pr merge 12 --admin'],
  ['gh pr edit 12 --add-label=Human-Approved'],
  ['gh pr edit 12 --add-label bug --add-label test-change-approved'],
  ['gh issue edit 5 --add-label human-approved'],
  ['gh issue edit 5 --remove-label=pipeline-rollback'],
  ['gh pr edit 12 --remove-label awaiting-review'],
  ['gh pr edit 12 --remove-label pipeline-blocked,bug'],
  ['gh pr create --title t --body b --label human-approved'],
  ['gh pr create -l bug -l test-change-approved'],
  ['gh pr create -dl human-approved --title t'],
  ['gh issue create --label=human-approved --title t'],
  ['gh label delete pipeline-pause'],
  ['gh label edit human-approved --name x'],
  ['gh repo delete o/r --yes'],
  ['gh repo rename new-name'],
  ['gh ruleset delete 1'],
  ['gh issue delete 7', { labels: ['pipeline-rollback'] }],
  ['gh issue transfer 7 o/other', { labels: ['pipeline-pause'] }],
  ['gh issue close 7 --comment "done"', { labels: ['pipeline-rollback', 'bug'] }],
  ['gh issue close 7', { labels: ['Pipeline-Pause'] }],
  ['GH_REPO=o/r gh issue close 7', { labels: ['pipeline-pause'] }],
  ['gh api https://api.github.com/repos/o/r/branches/main/protection -X PUT'],
  ['gh api /repos/o/r/branches/feature%2Fx/protection -X DELETE'],
  ['gh api repos/o/r/branches/feature/x/protection -X PUT -f a=b'],
  ['gh api /repos/o/r -X DELETE'],
  ['gh api repos/o/r/collaborators/bob -X PUT'],
  ['gh api repos/o/r/actions/permissions -X PUT -F enabled=true'],
  ['gh api orgs/o/rulesets -X POST -f name=x'],
  ['gh api repos/o/r/pulls/12/merge -X PUT'],
  ['gh api repos/o/r/merges -f base=main -f head=x'],
  ['gh api repos/o/r/git/refs/heads/main -X PATCH -F force=true -f sha=abc'],
  ['gh api repos/o/r/git/refs -f ref=refs/heads/master -f sha=abc'],
  ['gh api repos/o/r/issues/12/labels -X PUT -f "labels[]=bug"'],
  ['gh api repos/o/r/issues/12/labels -X DELETE'],
  ['gh api repos/o/r/issues/12/labels --input -'],
  ['gh api -X PATCH repos/o/r/labels/needs-human -f new_name=x'],
  ['gh api -X DELETE repos/o/r/labels/pipeline-pause'],
  ['gh api -X POST repos/o/r/issues/12/labels -f "labels[]=Test-Change-Approved"'],
  ['gh api -X POST repos/o/r/issues/12/labels --input l.json', { readText: () => '{"labels":["human-approved"]}' }],
  ['gh api -X POST repos/o/r/issues/12/labels --input l.json', { readText: () => null }],
  ['gh api -X POST repos/o/r/issues/12/labels -F "labels[]=@l.txt"', { readText: () => 'human-approved' }],
  ['echo \'{"labels":["human-approved"]}\' | gh api -X POST repos/o/r/issues/12/labels --input -'],
  ['gh api -X PATCH repos/o/r/issues/12 -f "labels[]=human-approved"'],
  ['gh api -X PATCH repos/o/r/issues/12 -f "labels[]=bug"'],
  ['gh api -X PATCH repos/o/r/issues/7 -f state=closed', { labels: ['pipeline-pause'] }],
  ['gh api -X PATCH repos/o/r/issues/7 -f state=closed', { labels: new Error('boom') }],
  ['gh api -X PATCH repos/o/r/issues/7 --input -'],
  ['gh api -X GET -X DELETE repos/o/r/rulesets/1'],
  ["gh api graphql -f query='mutation { mergePullRequest(input:{pullRequestId:\"x\"}) { clientMutationId } }'"],
  ["gh api graphql -f query='mutation { addLabelsToLabelable(input:{labelableId:\"x\",labelIds:[\"y\"]}) { clientMutationId } }'"],
  ["gh api graphql -f query='mutation { deleteBranchProtectionRule(input:{branchProtectionRuleId:\"x\"}) { clientMutationId } }'"],
  ['gh api graphql -F query=@m.graphql', { readText: () => 'mutation { closeIssue(input:{issueId:"x"}) { clientMutationId } }' }],
  ['gh api graphql -F query=@m.graphql', { readText: () => null }],
  // job runner nesting and quoting
  ['pipeline job start x -- git push origin main'],
  ['node ~/.claude/pipeline/bin/pipeline.mjs job start x --timeout 5 -- git push -f'],
  ['node ~/.claude/pipeline/bin/pipeline.mjs job start x -- "git push origin main"'],
  ['node ~/.claude/pipeline/bin/pipeline.mjs job start a -- node ~/.claude/pipeline/bin/pipeline.mjs job start b -- gh pr merge 1 --admin'],
  ['node ~/.claude/pipeline/bin/pipeline.mjs job start x -- bash -c "git push origin main"'],
  ['cd /other && node ~/.claude/pipeline/bin/pipeline.mjs job start x -- git push', { byDir: { '/other': 'main', '/work/repo': 'agent/x' } }],
];

const MORE_ALLOW = [
  ['git push --tags', { branch: 'agent/x' }],
  ['git push -o ci.skip origin agent/x'],
  ['git push --push-option=ci.skip origin agent/x'],
  ['git push --repo=origin agent/x'],
  ['git push origin --delete agent/x'],
  ['git push origin :agent/x'],
  ['git push origin v1.0'],
  ['git push origin refs/tags/main'],
  ['git push origin HEAD:agent/x', { branch: 'main' }], // the destination is explicit
  ['git push origin main:agent/x'],
  ['git push origin agent/*:agent/*'],
  ['git push', { pushDest: 'origin/agent/x' }],
  ['git push -u origin', { pushDest: 'origin/agent/x' }],
  ['git push', { pushDest: 'origin/agent/main-menu-fix' }],
  ['git push', { pushDest: 'origin/feature/master-data' }],
  ['git push', { pushDest: 'refs/remotes/origin/agent/x' }],
  ['git push', { pushDest: null, branch: 'agent/x' }],
  ['git push', { pushDest: new Error('boom'), branch: 'agent/x' }],
  ['git push origin agent/x', { pushDest: 'origin/main' }], // explicit refspec: @{push} is irrelevant
  ['git push origin HEAD:agent/x', { pushDest: 'origin/main' }],
  ['git push --no-verify -u origin agent/x'],
  ['git push --no-force-with-lease origin agent/x'],
  ['git push --follow-tags --atomic origin agent/x'],
  ['git push --dry-run origin agent/x'],
  ['git push git@github.com:o/r.git agent/x'],
  ['git push https://github.com/o/r.git agent/x'],
  ['git push --recurse-submodules check origin agent/x'],
  ['git push --receive-pack=x origin agent/x'],
  ['git -C /other push', { byDir: { '/other': 'agent/y' } }],
  ['cd /other && git push', { byDir: { '/other': 'agent/y', '/work/repo': 'main' } }],
  ['cd /repo/.worktrees/t && git push -u origin agent/t', { branch: 'main' }],
  ['cd /abs && git push', { byDir: { '/abs': 'agent/z' } }],
  ['DIR=/other; cd $DIR && git push', { byDir: { '/other': 'agent/y', '/work/repo': 'main' } }],
  ['B=agent/x; git push origin $B'],
  ['git push -u origin "$(git branch --show-current)"', { branch: 'agent/x' }],
  ['git push origin HEAD:$X', { branch: 'agent/x' }],
  ['git branch -d main'],
  ['git fetch origin main:agent/x'],
  ['git remote add origin git@github.com:o/r.git'],
  ['echo "gh pr edit 1 --add-label human-approved"'],
  ['gh pr merge 12 --squash --auto'],
  ['gh pr merge 12 --disable-auto'],
  ['gh pr edit 12 --add-label bug,needs-human'],
  ['gh pr edit 12 --remove-label human-approved'],
  ['gh pr edit 12 --body "mention --admin and human-approved"'],
  ['gh issue edit 5 --add-label pipeline-pause'],
  ['gh pr create --title t --body b --label agent-build'],
  ['gh issue create -l agent-suggestion --title t'],
  ['gh label create needs-human --color b60205'],
  ['gh label list'],
  ['gh issue close 9 --comment done', { labels: ['bug', 'agent-suggestion'] }],
  ['gh issue close 9 -R o/r', { labels: [] }],
  ['gh issue view 7 --json labels'],
  ['gh issue list --label pipeline-pause'],
  ['gh pr list --label human-approved'],
  ['gh repo view'],
  ['gh ruleset list'],
  ['gh api repos/o/r/issues/12/labels'],
  ['gh api repos/o/r/issues/12/comments -f body=hello'],
  ['gh api repos/o/r/issues/12/comments -X POST -f body="please add human-approved"'],
  ['gh api -X POST repos/o/r/issues/12/labels -f "labels[]=bug"'],
  ['gh api -X POST repos/o/r/issues/12/labels -f "labels[]=needs-human"'],
  ['gh api -X POST repos/o/r/issues/12/labels --input l.json', { readText: () => '{"labels":["bug"]}' }],
  ['gh api -X DELETE repos/o/r/issues/12/labels/human-approved'],
  ['gh api -X DELETE repos/o/r/issues/12/labels/run-e2e'],
  ['gh api -X PATCH repos/o/r/issues/7 -f title=new'],
  ['gh api -X PATCH repos/o/r/issues/7 -f state=closed', { labels: ['bug'] }],
  ['gh api repos/o/r/pulls/12/merge'],
  ['gh api repos/o/r/git/refs/heads/agent/x -X PATCH -f sha=abc'],
  ['gh api "repos/o/r/deployments?sha=abc&environment=prod"'],
  ['gh api repos/o/r/branches/main'],
  ['gh api -X GET repos/o/r -f per_page=1'],
  ['gh api graphql -f query=\'query { viewer { login } }\''],
  ["gh api graphql -f query='mutation { resolveReviewThread(input:{threadId:\"x\"}) { clientMutationId } }'"],
  ['gh api user'],
  ['pipeline job start x -- git push origin agent/x'],
  ['node ~/.claude/pipeline/bin/pipeline.mjs job start x -- git commit -m "git push origin main later"'],
  ['node ~/.claude/pipeline/bin/pipeline.mjs job wait x --timeout 540'],
  ['node ~/.claude/pipeline/bin/pipeline.mjs preflight'],
  ['echo pipeline.mjs job start x -- git push origin main'],
  [''],
  ['   '],
  ['# git push origin main'],
  ['ls -la && pwd'],
];

for (const [command, o] of MORE_DENY) {
  test(`DENY+ ${label(command, o).replace(/\n/g, '\\n')}`, () => {
    const v = evaluate(command, o);
    assert.equal(v.decision, 'deny', `expected deny, got allow for: ${command}`);
    assert.ok(v.reason.length > 10);
  });
}

for (const [command, o] of MORE_ALLOW) {
  test(`ALLOW+ ${label(command, o).replace(/\n/g, '\\n')}`, () => {
    const v = evaluate(command, o);
    assert.equal(v.decision, 'allow', `expected allow, got deny (${v.reason}) for: ${command}`);
  });
}

test('what the evaluator asks its collaborators', () => {
  let v = evaluate('git -C /other push', { byDir: { '/other': 'agent/y' } });
  assert.deepEqual(v.calls.branchDirs.map((c) => c.dir), [resolve('/other')]);
  v = evaluate('git --git-dir=/g/.git push');
  assert.equal(v.calls.branchDirs[0].gitDir, resolve('/g/.git'));
  v = evaluate('GIT_DIR=/e/.git git push');
  assert.equal(v.calls.branchDirs[0].gitDir, resolve('/e/.git'));
  v = evaluate('gh issue close 9 -R o/r', { labels: [] });
  assert.deepEqual(v.calls.labels, [{ n: '9', repoArgs: ['-R', 'o/r'], cwd: resolve('/work/repo') }]);
  v = evaluate('gh issue close 9 --repo=o/r', { labels: [] });
  assert.deepEqual(v.calls.labels[0].repoArgs, ['-R', 'o/r']);
  v = evaluate('GH_REPO=o/r gh issue close 9', { labels: [] });
  assert.deepEqual(v.calls.labels[0].repoArgs, ['-R', 'o/r']);
  v = evaluate('gh issue close 9', { labels: [] });
  assert.deepEqual(v.calls.labels[0].repoArgs, []);
  v = evaluate('gh issue close --reason "not planned" -R o/r 7 --comment x', { labels: [] });
  assert.deepEqual(v.calls.labels, [{ n: '7', repoArgs: ['-R', 'o/r'], cwd: resolve('/work/repo') }]);
  v = evaluate('cd /other && gh issue close 9', { labels: [] });
  assert.equal(v.calls.labels[0].cwd, resolve('/other'));
  v = evaluate('gh api -X PATCH repos/o/r/issues/7 -f state=closed', { labels: [] });
  assert.deepEqual(v.calls.labels[0], { n: '7', repoArgs: ['-R', 'o/r'], cwd: resolve('/work/repo') });
  v = evaluate('gh api -X PATCH "repos/{owner}/{repo}/issues/7" -f state=closed', { labels: [] });
  assert.deepEqual(v.calls.labels[0], { n: '7', repoArgs: [], cwd: resolve('/work/repo') });
  v = evaluate('git -C /other push', { pushDest: 'origin/agent/y' });
  assert.deepEqual(v.calls.pushDirs, [{ dir: resolve('/other'), gitDir: null }]);
  v = evaluate('git --git-dir=/g/.git push', { pushDest: 'origin/agent/y' });
  assert.equal(v.calls.pushDirs[0].gitDir, resolve('/g/.git'));
  v = evaluate('git push origin agent/x', { pushDest: 'origin/main' });
  assert.deepEqual(v.calls.pushDirs, []);
  v = evaluate('git status');
  assert.deepEqual([v.calls.branchDirs, v.calls.pushDirs, v.calls.labels], [[], [], []]);
});

test('an explicit destination does not need the current branch', () => {
  const v = evaluate('git push origin HEAD:agent/x', { branch: null });
  assert.equal(v.decision, 'allow');
  assert.equal(v.calls.branchDirs.length, 0);
});

test('defaults fail closed: no branch lookup means a bare push is denied, no label lookup means close is denied', () => {
  assert.equal(evaluateGitCommand('git push', { cwd: '/x' }).decision, 'deny');
  assert.equal(evaluateGitCommand('git push origin agent/x', { cwd: '/x' }).decision, 'allow');
  assert.equal(evaluateGitCommand('gh issue close 3', { cwd: '/x' }).decision, 'deny');
  assert.equal(evaluateGitCommand('git status').decision, 'allow');
  assert.equal(evaluateGitCommand(undefined, {}).decision, 'allow');
  assert.equal(evaluateGitCommand(42, {}).decision, 'allow');
});

test('a lookup that returns garbage or HEAD is treated as unknown', () => {
  const garbage = evaluateGitCommand('git push', { cwd: '/x', currentBranch: () => ({}) });
  assert.equal(garbage.decision, 'deny');
  assert.equal(evaluateGitCommand('git push', { cwd: '/x', currentBranch: () => 'HEAD' }).decision, 'deny');
  assert.equal(evaluateGitCommand('git push', { cwd: '/x', currentBranch: () => '' }).decision, 'deny');
  assert.equal(evaluateGitCommand('git push', { cwd: '/x', currentBranch: () => { throw new Error('x'); } }).decision, 'deny');
  assert.equal(evaluateGitCommand('gh issue close 3', { cwd: '/x', issueLabels: () => 'pipeline-pause' }).decision, 'deny');
  assert.equal(evaluateGitCommand('git push', { cwd: '/x', currentBranch: () => 'refs/heads/main' }).decision, 'deny');
});

test('a command the parser gives up on is denied when it mentions git/gh/pipeline, allowed otherwise', () => {
  const long = 'true; '.repeat(600);
  const v = evaluate(`${long}git status`);
  assert.equal(v.decision, 'deny');
  assert.match(v.reason, /too complex/);
  assert.equal(evaluate(`${long}gh pr view 1`).decision, 'deny');
  assert.equal(evaluate(`${long}node pipeline.mjs job start x -- ls`).decision, 'deny');
  assert.equal(evaluate(`${long}ls`).decision, 'allow');
});

test('job runner nesting is bounded and still fails closed', () => {
  let cmd = 'git push origin main';
  for (let i = 0; i < 12; i++) cmd = `pipeline job start j${i} -- ${cmd}`;
  assert.equal(evaluate(cmd).decision, 'deny');
});

// ---- the real hook, spawned exactly as Claude Code runs it ---------------------------------------------

function hook(stdin, { env = {}, cwd } = {}) {
  const r = spawnSync(process.execPath, [HOOK], {
    input: typeof stdin === 'string' ? stdin : JSON.stringify(stdin),
    encoding: 'utf8',
    cwd,
    env: { ...process.env, ...env },
  });
  return r;
}
const bashInput = (command, cwd, extra = {}) => ({
  session_id: 's', transcript_path: '/t', cwd, hook_event_name: 'PreToolUse', tool_name: 'Bash',
  tool_input: { command, description: 'x', timeout: 1000, run_in_background: false }, tool_use_id: 'u', ...extra,
});

const TMP = mkdtempSync(join(tmpdir(), 'guard-git-'));
test.after(() => rmSync(TMP, { recursive: true, force: true }));

function makeRepo(name, branch) {
  const dir = join(TMP, name);
  execFileSync('git', ['init', '-q', dir]);
  execFileSync('git', ['-C', dir, 'symbolic-ref', 'HEAD', `refs/heads/${branch}`]);
  return realpathSync(dir);
}

test('spawn: git push origin main prints a deny JSON and exits 0', () => {
  const r = hook(bashInput('git push origin main', TMP));
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /^\[claude-pipeline guard-git\] /);
});

test('spawn: git status prints nothing and exits 0', () => {
  const r = hook(bashInput('git status', TMP));
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

test('spawn: a non-Bash tool is allowed even when its input looks like a push', () => {
  const r = hook({ tool_name: 'Write', tool_input: { file_path: '/x', content: 'git push origin main' }, cwd: TMP });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

test('spawn: malformed stdin mentioning push is denied; without keywords it is allowed', () => {
  const bad = hook('{"tool_name":"Bash","tool_input":{"command":"git push origin main"');
  assert.equal(bad.status, 0);
  assert.equal(JSON.parse(bad.stdout).hookSpecificOutput.permissionDecision, 'deny');
  const harmless = hook('{"tool_name":"Bash","tool_input":{"command":"ls -la"');
  assert.equal(harmless.status, 0);
  assert.equal(harmless.stdout, '');
  const empty = hook('');
  assert.equal(empty.status, 0);
  assert.equal(empty.stdout, '');
});

test('spawn: a Bash call with no command is allowed', () => {
  const r = hook({ tool_name: 'Bash', tool_input: {}, cwd: TMP });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

test('spawn: bare git push in a real repo on main is denied, on an agent branch allowed', () => {
  const onMain = makeRepo('on-main', 'main');
  const denied = hook(bashInput('git push', onMain));
  assert.equal(denied.status, 0);
  assert.equal(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision, 'deny');
  assert.match(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecisionReason, /main/);

  const onAgent = makeRepo('on-agent', 'agent/x');
  const ok = hook(bashInput('git push', onAgent));
  assert.equal(ok.status, 0);
  assert.equal(ok.stdout, '');
});

test('spawn: git -C and cd resolve the repo they actually push from', () => {
  const onMain = makeRepo('c-main', 'main');
  const onAgent = makeRepo('c-agent', 'agent/y');
  const viaC = hook(bashInput(`git -C ${onMain} push`, onAgent));
  assert.equal(JSON.parse(viaC.stdout).hookSpecificOutput.permissionDecision, 'deny');
  const viaCd = hook(bashInput(`cd ${onMain} && git push -u origin HEAD`, onAgent));
  assert.equal(JSON.parse(viaCd.stdout).hookSpecificOutput.permissionDecision, 'deny');
  const fine = hook(bashInput(`git -C ${onAgent} push`, onMain));
  assert.equal(fine.stdout, '');
});

test('spawn: bare git push with a detached HEAD is denied', () => {
  const dir = makeRepo('detached', 'main');
  execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'x']);
  execFileSync('git', ['-C', dir, 'checkout', '-q', '--detach']);
  const r = hook(bashInput('git push', dir));
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny');
  assert.match(JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason, /current branch/);
});

// A working clone on main with a bare "origin", so @{push} resolves exactly as it does for a real checkout.
// Global/system git config is neutralised for both the setup commands and the spawned hook.
const GIT_ENV = { GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_SYSTEM: devNull, GIT_CONFIG_NOSYSTEM: '1' };
function makeClone(name) {
  const bare = join(TMP, name + '-origin.git');
  const work = join(TMP, name);
  const git = (...args) => execFileSync('git', ['-C', work, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { env: { ...process.env, ...GIT_ENV }, stdio: 'pipe' });
  execFileSync('git', ['init', '-q', '--bare', bare], { env: { ...process.env, ...GIT_ENV } });
  execFileSync('git', ['init', '-q', work], { env: { ...process.env, ...GIT_ENV } });
  git('symbolic-ref', 'HEAD', 'refs/heads/main');
  git('commit', '-q', '--allow-empty', '-m', 'init');
  git('remote', 'add', 'origin', bare);
  git('push', '-q', 'origin', 'main');
  git('fetch', '-q', 'origin');
  return { dir: realpathSync(work), git };
}
const verdictOf = (r) => (r.stdout ? JSON.parse(r.stdout).hookSpecificOutput : null);

test('spawn: bare git push follows @{push}: agent branch tracking origin/main with push.default=upstream is denied', () => {
  const { dir, git } = makeClone('pd-upstream');
  git('checkout', '-q', '--track', '-b', 'agent/x', 'origin/main');
  git('config', 'push.default', 'upstream');
  const r = hook(bashInput('git push', dir), { env: GIT_ENV });
  assert.equal(r.status, 0);
  assert.equal(verdictOf(r).permissionDecision, 'deny');
  assert.match(verdictOf(r).permissionDecisionReason, /origin\/main/);
  assert.equal(verdictOf(hook(bashInput('git push -u origin', dir), { env: GIT_ENV })).permissionDecision, 'deny');
  assert.equal(verdictOf(hook(bashInput('git push --dry-run', dir), { env: GIT_ENV })).permissionDecision, 'deny');
  // from another directory, -C and cd resolve the checkout the push really runs in
  const elsewhere = makeClone('pd-elsewhere').dir;
  assert.equal(verdictOf(hook(bashInput('git -C ' + dir + ' push', elsewhere), { env: GIT_ENV })).permissionDecision, 'deny');
  assert.equal(verdictOf(hook(bashInput('cd ' + dir + ' && git push', elsewhere), { env: GIT_ENV })).permissionDecision, 'deny');
  // an explicit destination is judged by itself, whatever @{push} says
  assert.equal(hook(bashInput('git push origin agent/x', dir), { env: GIT_ENV }).stdout, '');
});

test('spawn: with push.default=simple (git default) a mismatched upstream is refused by git itself, so @{push} fails and the branch rule allows', () => {
  const { dir, git } = makeClone('pd-simple');
  git('checkout', '-q', '--track', '-b', 'agent/x', 'origin/main');
  git('config', 'push.default', 'simple');
  assert.throws(() => git('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{push}')); // pins the git behaviour
  const r = hook(bashInput('git push', dir), { env: GIT_ENV });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

test('spawn: push.default=current sends agent/x to origin/agent/x even though it tracks origin/main, so it is allowed', () => {
  const { dir, git } = makeClone('pd-current');
  git('checkout', '-q', '--track', '-b', 'agent/x', 'origin/main');
  git('config', 'push.default', 'current');
  assert.equal(hook(bashInput('git push', dir), { env: GIT_ENV }).stdout, '');
});

test('spawn: a branch whose upstream has the same name resolves to origin/<branch> and is allowed', () => {
  const { dir, git } = makeClone('pd-same');
  git('checkout', '-q', '--no-track', '-b', 'agent/y', 'main');
  git('push', '-q', '-u', 'origin', 'agent/y');
  assert.equal(git('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{push}').toString().trim(), 'origin/agent/y');
  assert.equal(hook(bashInput('git push', dir), { env: GIT_ENV }).stdout, '');
});

test('spawn: no upstream (or no @{push}) falls back to the current-branch rule', () => {
  const { dir, git } = makeClone('pd-none');
  git('checkout', '-q', '--no-track', '-b', 'agent/z', 'main');
  assert.equal(hook(bashInput('git push', dir), { env: GIT_ENV }).stdout, '', 'agent branch without upstream is allowed');
  git('checkout', '-q', 'main');
  const onMain = hook(bashInput('git push', dir), { env: GIT_ENV });
  assert.equal(verdictOf(onMain).permissionDecision, 'deny'); // upstream origin/main resolves under push.default=simple
  git('checkout', '-q', '--detach');
  const detached = hook(bashInput('git push', dir), { env: GIT_ENV });
  assert.equal(verdictOf(detached).permissionDecision, 'deny');
  assert.match(verdictOf(detached).permissionDecisionReason, /current branch/);
});

test('spawn: gh issue close looks labels up through PIPELINE_GH (fake gh)', () => {
  const log = join(TMP, 'gh.log');
  const script = join(TMP, 'gh-script.json');
  const env = {
    PIPELINE_GH: `"${process.execPath}" "${FAKE_GH}"`,
    PIPELINE_FAKE_GH_SCRIPT: script,
    PIPELINE_FAKE_GH_LOG: log,
  };

  writeFileSync(script, JSON.stringify([{ match: '^issue view 7 ', stdout: 'bug\npipeline-pause\n' }]));
  const paused = hook(bashInput('gh issue close 7', TMP), { env });
  assert.equal(paused.status, 0);
  assert.equal(JSON.parse(paused.stdout).hookSpecificOutput.permissionDecision, 'deny');
  assert.match(JSON.parse(paused.stdout).hookSpecificOutput.permissionDecisionReason, /pipeline-pause/);
  const logged = JSON.parse(readFirstLine(log));
  assert.deepEqual(logged.argv, ['issue', 'view', '7', '--json', 'labels', '-q', '.labels[].name']);

  writeFileSync(script, JSON.stringify([{ match: '^issue view 9 ', stdout: 'bug\n' }]));
  const fine = hook(bashInput('gh issue close 9 -R o/r', TMP), { env: { ...env, PIPELINE_FAKE_GH_SCRIPT: script } });
  assert.equal(fine.stdout, '');
  const last = readLines(log).map((l) => JSON.parse(l)).at(-1);
  assert.deepEqual(last.argv, ['issue', 'view', '9', '-R', 'o/r', '--json', 'labels', '-q', '.labels[].name']);

  writeFileSync(script, JSON.stringify([{ match: '^issue view', stderr: 'HTTP 502', code: 1 }]));
  const failed = hook(bashInput('gh issue close 9', TMP), { env });
  assert.equal(JSON.parse(failed.stdout).hookSpecificOutput.permissionDecision, 'deny');
  assert.match(JSON.parse(failed.stdout).hookSpecificOutput.permissionDecisionReason, /could not verify/);

  writeFileSync(script, JSON.stringify([]));
  const noMatch = hook(bashInput('gh issue close 9', TMP), { env });
  assert.equal(JSON.parse(noMatch.stdout).hookSpecificOutput.permissionDecision, 'deny');
});

test('spawn: a missing gh binary makes close fail closed rather than crash', () => {
  const r = hook(bashInput('gh issue close 9', TMP), { env: { PIPELINE_GH: join(TMP, 'does-not-exist') } });
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny');
});

test('spawn: a policy module that fails to load fails closed for guarded input and open for the rest', () => {
  const root = join(TMP, 'broken-install');
  cpSync(resolve(HERE, '../pipeline/hooks'), join(root, 'pipeline/hooks'), { recursive: true });
  cpSync(resolve(HERE, '../pipeline/lib'), join(root, 'pipeline/lib'), { recursive: true });
  writeFileSync(join(root, 'pipeline/hooks/lib/git-policy.mjs'), 'export const broken = ;\n');
  const broken = join(root, 'pipeline/hooks/guard-git.mjs');
  const run = (command) => spawnSync(process.execPath, [broken], { input: JSON.stringify(bashInput(command, TMP)), encoding: 'utf8' });
  const guarded = run('git push origin agent/x');
  assert.equal(guarded.status, 0);
  assert.equal(JSON.parse(guarded.stdout).hookSpecificOutput.permissionDecision, 'deny');
  assert.match(JSON.parse(guarded.stdout).hookSpecificOutput.permissionDecisionReason, /internal error/);
  const harmless = run('ls -la');
  assert.equal(harmless.status, 0);
  assert.equal(harmless.stdout, '');
});

test('spawn: label rules need no gh at all', () => {
  const r = hook(bashInput('gh pr edit 1 --add-label human-approved', TMP), { env: { PIPELINE_GH: join(TMP, 'does-not-exist') } });
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny');
});

function readLines(file) { return readFileSync(file, 'utf8').split('\n').filter(Boolean); }
function readFirstLine(file) { return readLines(file)[0]; }
