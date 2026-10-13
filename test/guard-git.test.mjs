import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, realpathSync, readFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateGitCommand } from '../pipeline/hooks/lib/git-policy.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = resolve(HERE, '../pipeline/hooks/guard-git.mjs');
const FAKE_GH = resolve(HERE, 'fixtures/fake-gh.mjs');

// Evaluate with injected branch / label lookups. `o.branch`: branch name, or null for detached.
// `o.byDir`: branch per directory. `o.labels`: labels of any issue, or an Error to throw.
// `o.labelsByNum`: labels per issue number. `o.pathExists`: stat() answer for `git checkout <path>`.
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
      if (typeof o.pushDest === 'function') return o.pushDest(dir, extra);
      return o.pushDest ?? null;
    },
    issueLabels: (n, repoArgs, cwd) => {
      calls.labels.push({ n, repoArgs, cwd });
      if (o.labels instanceof Error) throw o.labels;
      if (o.labelsByNum) return o.labelsByNum[n] ?? [];
      return o.labels ?? [];
    },
    readText: o.readText ?? (() => null),
    pathExists: o.pathExists ?? (() => false),
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
  // a gh / git subcommand still holding a run-time expansion after known variables are substituted
  ['X=merge-base; gh pr ${X%-base} 5 --admin'],
  ['gh pr "$(printf merge)" 5 --admin'],
  ['gh pr \`echo merge\` 5 --admin'],
  ['gh ${G:-pr} merge 5 --admin'],
  ['X=pu; git ${X}${Y:-sh} origin main'],
  ['git "$(printf push)" origin main'],
  ['X=push; git $X origin main'], // a variable known on the line is still not a literal subcommand
  ['X=diff; git $X HEAD~1'],
  ['X=merge; true || X=view; gh pr $X 5 --admin'],
  // a variable assigned twice is unknown: which assignment ran depends on control flow
  ['B=main; false && B=agent/x; git push origin $B'],
  ['L=human-approved; false && L=ok; gh pr edit 1 --add-label $L'],
  ['X=push; X=diff git $X origin main'],
  // a push destination with a parameter expansion is ONE run-time word: the `:` of ${B:-x} is not a refspec separator
  ['B=main; git push origin ${B:-x}'],
  ['B=main; git push origin ${B:+main}'],
  ['git push origin ${B:-main}'],
  ['B=main; git push origin ${B:0}'],
  ['git push origin ${B:=main}'],
  ['git push origin ${B:-agent/x}'],
  ['git push origin HEAD:${B:-x}'],
  ['git push origin +HEAD:${B:-x}'],
  ['git push origin ${B:-x}:${C:-y}'],
  ['git push origin :${B:-x}'],
  ['git push origin --delete ${B:-x}'],
  ['git push origin $(echo a:b)'],
  ['git push origin "$(echo x:main)"'],
  ['git push origin `echo a:b`'],
  ['git push origin HEAD:${B:-"}:main"}'],
  ['git push origin ${B:-x'],
  ['git push --repo=${R:-o} ${B:-agent/x}'],
  // a run-time SOURCE can add a force prefix or more refspecs: any part of a refspec built at run time is unresolvable
  ['git push origin ${B:-x}:agent/x'],
  ['git push origin ${B:-${C:-+HEAD}}:agent/x'],
  ['git push origin "${B:-${C:-+HEAD}}:agent/x"'],
  ['git push origin ${B:-${C:-HEAD:main HEAD}}:agent/x'],
  ['git push origin "${B:-${C:-HEAD:main HEAD}}:agent/x"'],
  ['git push origin $(echo +HEAD):agent/x'],
  ['git push origin `echo +HEAD`:agent/x'],
  ['git push origin $X:agent/x'],
  ['git push origin ${B:-x}:'],
  // the -c VALUE is never expanded with the line's variables: an alias body assigns and pushes in its own shell
  ['V=agent/x; git -c alias.p=\'!V=main; git push origin $V\' p'],
  ['V=agent/x; git -c alias.p=\'!V=+HEAD:agent/x; git push origin $V\' p'],
  ['V=agent/x; git config alias.p \'!V=main; git push origin $V\'; git p'],
  // an option or remote built at run time can be any option; so is a known value that splits into several words
  ['git push origin --${F:-mirror}'],
  ['git push origin -${F:-f} agent/x'],
  ['git push origin ${F:---force} agent/x'],
  ['git push origin --force-with-lease=${F:-x} agent/x'],
  ['git push origin --${X:-all}'],
  ['git push origin --${X:-delete} agent/x'],
  ['git push "$R" HEAD:agent/x'],
  ['git push $R HEAD:agent/x'],
  ['git push -o ${B:-x} origin agent/x'],
  ['R="x HEAD:main"; git push origin $R'],
  ['R="agent/x HEAD:main"; git push origin "$R"'],
  ['R="agent/*"; git push origin $R'],
  ['R=--mirror; git push origin $R'],
  ['R=-f; git push origin $R agent/x'],
  ['R=+HEAD:agent/x; git push origin $R'],
  // word splitting follows IFS, not only blanks; an empty unquoted value drops the word
  ['IFS=,; R="x,HEAD:main"; git push origin $R'],
  ['IFS=,; R="agent/x,main"; git push origin $R'],
  ['IFS=,; R="agent/x"; git push origin $R'],
  ['export IFS=:; R=agent/x; git push origin $R'],
  ['read IFS <<< ","; R="x,HEAD:main"; git push origin $R'],
  ['IFS=; R=agent/x; git push origin $R'],
  ['IFS=x git push origin agent/x; R=agent/x; IFS=a; git push origin $R'],
  ['E=; git push origin $E'],
  ['E=""; git push origin "$E"'],
  ['E=; git push $E agent/x'],
  // IFS assigned without the letters IFS in a row, or by a computed name
  ['eval "I""FS=,"; R="agent/x,main"; git push origin $R'],
  ['N=IFS; printf -v $N ,; R="agent/x,main"; git push origin $R'],
  ['N=IFS; read $N <<< ","; R="agent/x,main"; git push origin $R'],
  ['declare I""FS=,; R="agent/x,main"; git push origin $R'],
  ['f() { local I""FS=,; R="agent/x,main"; git push origin $R; }; f'],
  ['N=IFS; export "$N=,"; R="agent/x,main"; git push origin $R'],
  ['source ./env.sh; R=agent/x; git push origin $R'],
  ['. ./env.sh; R=agent/x; git push origin $R'],
  ['IFS+=,; R="agent/x,main"; git push origin $R'],
  ['IFS=, git push origin agent/x; R=agent/x,main; git push origin $R'],
  ['R="agent/x,main"; git push origin ${=R}'],
  ['setopt shwordsplit; R="agent/x main"; git push origin $R'],
  // quote removal hides whether '$O' was a literal name or a variable: a push is judged under both readings
  ['O=-o; git push origin \'$O\' HEAD:main'],
  ['O=--push-option; git push origin \'$O\' HEAD:main'],
  ['O=--repo; git push origin \'$O\' HEAD:main'],
  ['O=--receive-pack; git push origin \'$O\' HEAD:main'],
  ['O=--exec; git push origin \'$O\' HEAD:main'],
  ['O=-o; git branch \'$O\'; git push origin \'$O\' HEAD:main'],
  // IFS named through an attached binder option with a quoted name
  ['printf -vI""FS ,; R=agent/x,main; git push origin $R'],
  ['read -aI""FS <<< x; R=agent/x,main; git push origin $R'],
  // a -c word that is (or may be) several git arguments
  ['KV="user.name=x -C /other"; git -c $KV push origin agent/x'],
  ['git -c $KV push origin agent/x'],
  ['git -c user.name=$N push origin agent/x'],
  ['git -c core.pager=${P:-cat} push origin agent/x'],
  // a push is judged for EVERY mix of literal / expanded `$` words (the quoting of each is lost), not only all-or-none
  ['O=-o; B=main; git push origin \'$O\' $B'],
  ['O=-o; B=main; git branch \'$O\'; git push origin \'$O\' $B'],
  ['O=-o; P=-f; B=main; git push origin \'$O\' \'$P\' $B'],
  ['O=--repo; B=main; git push origin \'$O\' $B'],
  ['O=-o; B=main; git push origin $O \'$B\' $B'],
  ['A=agent/x; git push origin $A $A $A $A $A $A $A $A $A'],
  // a config key / push.default value built at run time can be remote.*.push or upstream
  ['git -c $K=HEAD:agent/x push'],
  ['K=remote.origin.push; git -c $K=HEAD:agent/x push'],
  ['git -c ${K:-remote.origin.push}=HEAD push'],
  ['git -c push.default=$V push'],
  ['git -c push.default=${V:-up}stream push'],
  ['git config $K v; git push'],
  ['git config ${K:-remote.origin.push} v; git push'],
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
  // run-time ARGUMENTS stay fine; only the subcommand position must be literal (or a variable assigned on the line)
  ['gh pr view $N --json title'],
  ['gh -R $REPO pr view 5'],
  ['git diff "$BASE"..HEAD'],
  ['git -C "$DIR" log --oneline -3'],
  ['B=agent/x; git push origin $B'], // assigned once on the line: still known
  ['git push origin HEAD:$(git branch --show-current)'],
  ['git push origin HEAD:agent/x'], // a literal source with a literal destination is unchanged
  ['O=-o; B=agent/y; git push origin \'$O\' $B'],
  ['A=agent/x; git push origin $A $A $A $A $A $A $A $A'],
  ['export B=agent/x; git push origin $B'],
  ['B=agent/x; git push origin ${B}'],
  ['git -c alias.p=\'!V=agent/y; git push origin $V\' p'], // the value is judged as written, in the alias's own shell
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
  // update-branch is allowed (below); merging through nearby endpoints still is not
  ['gh api -X PUT repos/o/r/pulls/12/merge --input -'],
  ['gh api -X PUT repos/o/r/pulls/12/update-branch/../merge --input -'],
  ['gh api -X PUT repositories/123/pulls/12/merge --input -'],
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
  // GraphQL equivalents of approval-label edits, branch protection and pause-issue closing (not on the mutation allowlist)
  ["gh api graphql -f query='mutation { removeLabelsFromLabelable(input:{labelableId:\"x\",labelIds:[\"y\"]}) { clientMutationId } }'"],
  ["gh api graphql -f query='mutation { updateBranchProtectionRule(input:{branchProtectionRuleId:\"x\",isAdminEnforced:false}) { clientMutationId } }'"],
  ["gh api graphql -f query='mutation { createBranchProtectionRule(input:{repositoryId:\"x\",pattern:\"main\"}) { clientMutationId } }'"],
  ["gh api graphql -f query='mutation { closeIssue(input:{issueId:\"x\"}) { clientMutationId } }'"],
  ["gh api graphql -f query='mutation { updateIssue(input:{id:\"x\",state:CLOSED}) { clientMutationId } }'"],
  ['gh api graphql -F query=@m.graphql', { readText: () => 'mutation { addLabelsToLabelable(input:{labelableId:"x",labelIds:["y"]}) { clientMutationId } }' }],
  ['gh api graphql --input q.json', { readText: () => null }],
  ['cat q.json | gh api graphql --input -'],
  // an agent posting its own guard status or approval receipt, or a check run
  ['gh api repos/o/r/statuses/abc123 -f state=success -f context="Hard-stop scan"'],
  ['gh api repos/o/r/statuses/abc123 -f state=success -f "context=Test integrity" -f description=ok'],
  ['gh api -X POST repos/o/r/statuses/0123456789012345678901234567890123456789 -f state=success -f "context=pipeline-approval: x"'],
  ['gh api --method POST /repos/o/r/statuses/abc123 -f state=failure -f context=ci'],
  ['gh api repos/o/r/statuses/abc123 --input status.json'],
  ['gh api repos/o/r/statuses/abc123 -X PATCH -f state=success'],
  ['gh api https://api.github.com/repos/o/r/statuses/abc123 -f state=success -f context=x'],
  ['gh api repos/{owner}/{repo}/statuses/$(git rev-parse HEAD) -f state=success -f context="Hard-stop scan"'],
  ['gh api repos/o/r/check-runs -f name="Hard-stop scan" -f head_sha=abc -f conclusion=success'],
  ['gh api -X PATCH repos/o/r/check-runs/9 -f conclusion=success'],
  // GitHub serves every repos/{owner}/{repo}/... resource under repositories/{id}/... too: same rules must apply
  ['gh api repositories/123/statuses/abc123 -f state=success -f context="Hard-stop scan"'],
  ['gh api -X POST /repositories/123/statuses/abc123 -f state=success -f context=x'],
  ['gh api https://api.github.com/repositories/123/statuses/abc123 -f state=success -f context=x'],
  ['gh api Repositories/123/statuses/abc123 -f state=success -f context=x'],
  ['gh api repositories/123/statuses/abc123 --input status.json'],
  ['gh api -X POST repositories/123/check-runs -f name="Hard-stop scan" -f head_sha=abc -f conclusion=success'],
  ['gh api -X PATCH repositories/123/check-runs/9 -f conclusion=success'],
  ['gh api -X POST repositories/123/check-suites -f head_sha=abc'],
  ['gh api -X PATCH repositories/123 -f allow_auto_merge=false'],
  ['gh api -X PATCH repositories/123 -f default_branch=agent/x'],
  ['gh api -X PUT repositories/123/pulls/5/merge'],
  ['gh api -X PUT repositories/123/issues/5/labels -f "labels[]=bug"'],
  ['gh api -X DELETE repositories/123/issues/5/labels'],
  ['gh api -X POST repositories/123/issues/5/labels -f "labels[]=human-approved"'],
  ['gh api -X PATCH repositories/123/issues/5 -f "labels[]=human-approved"'],
  ['gh api -X PATCH repositories/123/issues/5 -f "labels[]=bug"'],
  ['gh api -X PATCH repositories/123/issues/7 -f state=closed', { labels: ['pipeline-pause'] }],
  ['gh api -X PATCH repositories/123/issues/7 -f state=closed', { labels: new Error('boom') }],
  ['gh api -X DELETE repositories/123/issues/5/labels/needs-human'],
  ['gh api -X PUT repositories/123/branches/main/protection --input p.json'],
  ['gh api -X POST repositories/123/rulesets --input r.json'],
  ['gh api -X POST repositories/123/merges -f base=main -f head=x'],
  ['gh api -X POST repositories/123/contents/a.txt -f message=m'],
  // repeated slashes and dot segments must not dodge the anchors
  ['gh api repos//o/r/statuses/abc123 -f state=success -f context=x'],
  ['gh api repos/o//r/statuses/abc123 -f state=success -f context=x'],
  ['gh api repos/o/r//statuses//abc123 -f state=success -f context=x'],
  ['gh api repos/o/r/x/../statuses/abc123 -f state=success -f context=x'],
  ['gh api repos/o/r/./statuses/abc123 -f state=success -f context=x'],
  ['gh api repos/o/r/x/%2e%2e/statuses/abc123 -f state=success -f context=x'],
  ['gh api repos/o/r/x/..%2fstatuses/abc123 -f state=success -f context=x'],
  ['gh api repos/o/r/x/%2E%2E/check-runs -f name=x -f head_sha=abc'],
  ['gh api -X PATCH repos/o/x/../r -f allow_auto_merge=false'],
  ['gh api -X PATCH repositories//123 -f allow_auto_merge=false'],
  ['gh api -X PATCH repositories/9/../123 -f allow_auto_merge=false'],
  ['gh api repositories/123/x/../statuses/abc123 -f state=success -f context=x'],
  ['gh api -X PUT repos/o/r/pulls/5/x/../merge'],
  ['gh api -X PUT repos/o/r/issues/5/./labels -f "labels[]=bug"'],
  ['gh api -X PATCH repos/o/r/issues/7/. -f state=closed', { labels: ['pipeline-pause'] }],
  ['gh api -X PATCH repos/o/r/x/../issues/5 -f "labels[]=human-approved"'],
  ['gh api -X PUT repos/o/r/x/../branches/main/protection --input p.json'],
  // no check-run / status / commit-on-branch graphql mutation is on the allowlist
  ["gh api graphql -f query='mutation { createCheckRun(input:{repositoryId:\"x\",name:\"Hard-stop scan\",headSha:\"abc\",conclusion:SUCCESS}) { clientMutationId } }'"],
  ["gh api graphql -f query='mutation { updateCheckRun(input:{repositoryId:\"x\",checkRunId:\"y\",conclusion:SUCCESS}) { clientMutationId } }'"],
  ["gh api graphql -f query='mutation { createCommitOnBranch(input:{branch:{repositoryNameWithOwner:\"o/r\",branchName:\"main\"},message:{headline:\"x\"},expectedHeadOid:\"abc\"}) { clientMutationId } }'"],
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
  // bringing a PR branch up to date with main is not a merge into main (GitHub also checks expected_head_sha)
  ['gh api -X PUT repos/o/r/pulls/12/update-branch --input -'],
  ['gh api -X PUT repos/o/r/pulls/12/update-branch -f expected_head_sha=abc123'],
  ['gh api --method PUT repos/{owner}/{repo}/pulls/12/update-branch --input -'],
  ['gh api -X PUT repositories/123/pulls/12/update-branch --input -'],
  ['gh pr update-branch 12'],
  ['gh api repos/o/r/git/refs/heads/agent/x -X PATCH -f sha=abc'],
  ['gh api "repos/o/r/deployments?sha=abc&environment=prod"'],
  ['gh api repos/o/r/branches/main'],
  ['gh api -X GET repos/o/r -f per_page=1'],
  ['gh api graphql -f query=\'query { viewer { login } }\''],
  ["gh api graphql -f query='query($n:Int!) { repository(owner:\"o\", name:\"r\") { pullRequest(number:$n) { reviewDecision labels(first:10) { nodes { name } } } } }' -F n=12"],
  ['gh api graphql -F query=@read.graphql', { readText: () => 'query { viewer { login } }' }],
  // reading statuses and check runs is fine; only writes are blocked
  ['gh api repos/o/r/commits/abc123/statuses'],
  ['gh api repos/o/r/commits/abc123/status --jq .state'],
  ['gh api repos/o/r/commits/abc123/check-runs'],
  ['gh api -X GET repos/o/r/statuses/abc123'],
  // the repositories/{id} form: reads and unrelated writes stay allowed
  ['gh api repositories/123'],
  ['gh api -X GET repositories/123/statuses/abc123'],
  ['gh api repositories/123/commits/abc123/statuses'],
  ['gh api repositories/123/commits/abc123/check-runs'],
  ['gh api -X POST repositories/123/issues/5/comments -f body=hi'],
  ['gh api -X POST repositories/123/issues/5/labels -f "labels[]=bug"'],
  ['gh api -X PATCH repositories/123/issues/5 -f title=new'],
  ['gh api -X PATCH repositories/123/issues/7 -f state=closed', { labels: ['bug'] }],
  ['gh api -X POST repos//o/r/issues/5/comments -f body=hi'],
  ['gh api -X POST repos/o/r/x/../issues/5/comments -f body=hi'],
  ['gh api repos/o/r/x/../commits/abc123/statuses'],
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
  // a numeric repositories/{id} endpoint has no owner/name to hand to gh: use the current repo, never a bogus -R
  v = evaluate('gh api -X PATCH repositories/123/issues/7 -f state=closed', { labels: [] });
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

test('a command the parser gives up on is denied outright, even when git is spelled with quotes', () => {
  const long = 'true; '.repeat(600);
  const v = evaluate(`${long}git status`);
  assert.equal(v.decision, 'deny');
  assert.match(v.reason, /too complex/);
  assert.equal(evaluate(`${long}gh pr view 1`).decision, 'deny');
  assert.equal(evaluate(`${long}node pipeline.mjs job start x -- ls`).decision, 'deny');
  assert.equal(evaluate(`${long}ls`).decision, 'deny', 'a truncated parse cannot prove anything harmless');
  assert.equal(evaluate(`${long}g''it push origin main`).decision, 'deny');
  assert.equal(evaluate(`${long}\\g\\h pr merge 1 --admin`).decision, 'deny');
});

test('job runner nesting is bounded and still fails closed', () => {
  let cmd = 'git push origin main';
  for (let i = 0; i < 12; i++) cmd = `pipeline job start j${i} -- ${cmd}`;
  assert.equal(evaluate(cmd).decision, 'deny');
});


// ---- adversarial-review bypasses: state changed earlier on the same line, graphql, variables, wrappers -------

const BYPASS_DENY = [
  // 1. the branch changes earlier on the line, so a bare/HEAD push is judged against the new branch
  ['git checkout main && git merge agent/x && git push'],
  ['git checkout main; git push'],
  ['git switch main; git push origin HEAD'],
  ['git switch main && git pull && git merge agent/x && git push origin HEAD'],
  ['git checkout main && git push origin'],
  ['git stash; git checkout master; git push'],
  ['git checkout -B main origin/main && git push'],
  ['git checkout -b main && git push'],
  ['git switch -c main && git push'],
  ['git switch -C master origin/master && git push'],
  ['git branch -M main && git push'],
  ['git branch -m main && git push'],
  ['git branch -m agent/x main && git push'],
  ['git -C . checkout main && git -C . push', { cwd: '/work/repo' }],
  ['git checkout - && git push'],
  ['git switch - && git push'],
  ['git checkout --detach && git push'],
  ['git checkout $B && git push'],
  ['git rebase origin/main main && git push'],
  ['git symbolic-ref HEAD refs/heads/main && git push'],
  ['git worktree add ../wt main && cd ../wt && git push'],
  ['git worktree add -b main ../wt && cd ../wt && git push'],
  ['git checkout -b agent/z origin/main && git push'], // tracks origin/main: push.default=upstream would push main
  ['git checkout -- src/a.ts && git push', { branch: 'main' }], // a path checkout leaves the real branch in force
  ['git worktree add ../main && cd ../main && git push'], // no -b: git names the branch after the directory
  ['P=~/.claude/pipeline/bin/pipeline.mjs; node $P job start x git push origin main'],
  ['C="git push origin main"; node ~/.claude/pipeline/bin/pipeline.mjs job start x -- $C'],
  ["gh api graphql -f query='mutation { ...addComment } fragment addComment on Mutation { mergePullRequest(input:{pullRequestId:\"X\"}) { clientMutationId } }'"],
  ['git switch -c agent/z origin/master && git push'],
  ['git checkout agent/y && git push', { pushDest: (dir, x) => (x.branch === 'agent/y' ? 'origin/main' : null) }],
  ['git push origin HEAD:refs/heads/Main'],
  ['git push origin Main'],
  ['git checkout MAIN && git push'],
  // pushes whose destination depends on config changed on the same line (or passed with -c)
  ['git branch --set-upstream-to=origin/main && git push'],
  ['git branch -u origin/main && git push'],
  ['git config push.default upstream && git push'],
  ['git config remote.origin.push "refs/heads/*:refs/heads/main" && git push'],
  ['git -c push.default=upstream push'],
  ['git -c remote.origin.push=+HEAD:main push'],
  ['git -c branch.agent/x.merge=refs/heads/main push'],
  // in-line aliases
  ['git config alias.p push && git p origin main'],
  ['git -c alias.p=push p origin main'],
  ["git -c alias.pp='!git push origin main' pp"],
  ['gh alias set m "pr merge --admin" && gh m 5'],
  ['gh alias set e "pr edit 1 --add-label human-approved"'],
  ['gh alias set m "pr merge" && gh m 5 --admin'],
  // arguments arriving on stdin cannot be seen
  ['xargs git push origin < /dev/null'],
  ['printf main | xargs -I{} git push origin {}'],
  ["gh issue list --json number -q '.[].number' | xargs -n1 gh issue close"],
  // 2. graphql: only an allowlist of mutations passes
  ["gh api graphql -f query='mutation { updateIssue(input:{id:\"X\", labelIds:[\"Y\"]}) { clientMutationId } }'"],
  ["gh api graphql -f query='mutation { clearLabelsFromLabelable(input:{labelableId:\"X\"}) { clientMutationId } }'"],
  ["gh api graphql -f query='mutation { updateIssue(input:{id:\"X\", state: CLOSED}) { clientMutationId } }'"],
  ["gh api graphql -f query='mutation { updatePullRequest(input:{pullRequestId:\"X\", labelIds:[\"Y\"]}) { clientMutationId } }'"],
  ["gh api graphql -f query='mutation { createRef(input:{repositoryId:\"X\", name:\"refs/heads/main\", oid:\"abc\"}) { clientMutationId } }'"],
  ["gh api graphql -f query='mutation { mergeBranch(input:{repositoryId:\"X\", base:\"main\", head:\"feat\"}) { mergeCommit { oid } } }'"],
  ["gh api graphql -f query='mutation { a: addComment(input:{subjectId:\"X\", body:\"y\"}) { clientMutationId } b: mergePullRequest(input:{pullRequestId:\"X\"}) { clientMutationId } }'"],
  ["gh api graphql -f query='mutation { x: mergePullRequest(input:{pullRequestId:\"X\"}) { clientMutationId } }'"],
  ["gh api graphql -f query='mutation Merge($id: ID!) { mergePullRequest(input:{pullRequestId:$id}) { clientMutationId } }' -f id=X"],
  ["gh api graphql -f query='# addComment\nmutation { mergePullRequest(input:{pullRequestId:\"X\"}) { clientMutationId } }'"],
  ["gh api graphql -f query='mutation { ...F } fragment F on Mutation { mergePullRequest(input:{pullRequestId:\"X\"}) { clientMutationId } }'"],
  ["gh api graphql -f query='mutation'"],
  ["gh api graphql -f query='mutation {'"],
  ["Q='mutation { mergePullRequest(input:{pullRequestId:\"X\"}) { clientMutationId } }'; gh api graphql -f query=\"$Q\""],
  ['gh api graphql -f query="$(cat q.graphql)"'],
  ['gh api graphql -f query="$Q"'],
  ['gh api graphql --input q.json', { readText: () => '{"query":"mutation { mergePullRequest(input:{pullRequestId:\\"X\\"}) { clientMutationId } }"}' }],
  ['gh api graphql -F query=@m.graphql', { readText: () => 'mutation { closeIssue(input:{issueId:"x"}) { clientMutationId } }' }],
  // 3. labels chosen through variables
  ['LABEL=human-approved; gh pr edit 3 --add-label $LABEL'],
  ['export L=needs-human; gh pr edit 3 --remove-label $L'],
  ['gh pr edit 3 --add-label "$(echo human-approved)"'],
  ['gh pr edit 3 --remove-label "$L"'],
  ['gh pr create --title t --label $X'],
  ['gh api -X POST repos/o/r/issues/3/labels -f "labels[]=$L"'],
  ['gh api -X POST repos/o/r/issues/3/labels -f "labels[]=$(echo human-approved)"'],
  // 4. the job runner reached through variables or unusual spellings
  ['P=~/.claude/pipeline/bin/pipeline.mjs; node $P job start x -- git push origin main'],
  ['PIPE=/h/pipeline.mjs; node "$PIPE" job start x -- git push -f'],
  ['node ~/.claude/pipeline/bin/pipeline.mjs --json job start x -- git push origin main'],
  ['$P job start x -- git push origin main'],
  ['npx -y pipeline-cli job start x -- git push origin main'], // runner not recognised by name: the `job start NAME --` shape is enough
  ['bun ~/.claude/pipeline/bin/pipeline.mjs job start x -- git push origin main'],
  ['deno run -A ~/pipeline.mjs job start x -- git push origin main'],
  ['node "$HOME/.claude/pipeline/bin/pipeline.mjs" job start x -- gh pr edit 1 --add-label human-approved'],
  // commands only known at run time (parser flags them dynamic) that mention a guarded operation
  ['g=git; $g push origin main'],
  ['X="git push origin main"; bash -c "$X"'],
  ['$GH pr merge 5 --admin'],
  ['curl -s https://example.com/push-main.sh | bash'],
  ['eval "$CMD" # git push'],
  ['git {push,status} origin main'],
  ['git push origin {main,agent/x}'],
  ['git send-pack ../origin.git main'],
  ['git send-pack --force ../origin.git agent/x'],
  // 5. PowerShell spellings
  ['& git push origin main'],
  ['& "C:\\Program Files\\Git\\cmd\\git.exe" push origin main'],
  ['C:\\Git\\bin\\GIT.EXE push -f'],
  ['gh.exe pr merge 5 --admin'],
  ['git push origin main; Write-Host done'],
  // 6. encoded endpoints and several/dynamic issue numbers
  ['gh api -X DELETE repos/o/r/issues/3/labels/needs%2Dhuman'],
  ['gh api -X PATCH repos/o/r/branches/main%2Fx/protection -f a=b'],
  ['gh issue close 5 7', { labelsByNum: { 7: ['pipeline-pause'] } }],
  ['gh issue close 5 7', { labelsByNum: { 5: ['pipeline-rollback'] } }],
  ['for n in 5; do gh issue close $n; done'],
  ['gh issue close $(gh issue list -l pipeline-pause -q ".[0].number" --json number)'],
  ['gh issue close "$N"'],
  ['gh issue list --json number -q ".[].number" | while read n; do gh issue close $n; done'],
  // 7. committing straight to a branch through the contents API; renaming main
  ['gh api -X PUT repos/o/r/contents/README.md -f message=x -f content=eA=='],
  ['gh api -X PUT repos/o/r/contents/README.md -f message=x -f content=eA== -f branch=main'],
  ['gh api -X PUT repos/o/r/contents/README.md -f message=x -f content=eA== -f branch=master'],
  ['gh api -X PUT repos/o/r/contents/README.md -f message=x -f content=eA== -f branch=refs/heads/main'],
  ['gh api -X PUT repos/o/r/contents/README.md -f message=x -f content=eA== -f branch=$B'],
  ['gh api -X DELETE repos/o/r/contents/f -f message=x -f sha=abc'],
  ['gh api repos/o/r/contents/f -X PUT --input b.json', { readText: () => '{"message":"x","content":"eA=="}' }],
  ['gh api repos/o/r/contents/f -X PUT --input b.json', { readText: () => '{"message":"x","branch":"main"}' }],
  ['gh api repos/o/r/branches/main/rename -X POST -f new_name=old'],
];

const BYPASS_ALLOW = [
  ['git checkout agent/y && git push'],
  ['git checkout main && git checkout agent/y && git push'],
  ['git switch -c agent/z && git push'],
  ['git checkout -b agent/z --no-track origin/main && git push'],
  ['git checkout -b agent/z main && git push'],
  ['git switch -c agent/z --no-track origin/main && git push'],
  ['git branch -m agent/renamed && git push'],
  ['git branch -m main agent/old && git push'],
  ['cd /other && git checkout main && cd /work/repo && git push'],
  ['git checkout agent/y && git push', { branch: 'main', pushDest: (dir, x) => (x.branch ? 'origin/agent/y' : 'origin/main') }],
  ['git checkout src/file.ts && git push', { pathExists: () => true }],
  ['git checkout -- src/a.ts && git push'],
  ['git checkout HEAD && git push'],
  ['git checkout origin/main -- file && git push'],
  ['git checkout -p && git push'],
  ['git rebase origin/main && git push'],
  ['git worktree add .worktrees/x -b agent/x && cd .worktrees/x && git push'],
  ['git config user.name x && git push'],
  ['git worktree add ../feat && cd ../feat && git push'],
  ['P=~/.claude/pipeline/bin/pipeline.mjs; node $P job start v npm test'],
  ['git config --get remote.origin.url && git push'],
  ['git config remote.origin.url && git push'],
  ['git -c user.name=x push'],
  ['git -c push.default=simple push'],
  ['git -c push.followTags=true push'],
  ['git config alias.st status && git st'],
  ['gh alias set pv "pr view" && gh pv 5'],
  ['LABEL=bug; gh pr edit 3 --add-label $LABEL'],
  ['gh api graphql -f query=\'mutation { addComment(input:{subjectId:"X", body:"y"}) { clientMutationId } }\''],
  ['gh api graphql -f query=\'mutation($id: ID!) { enablePullRequestAutoMerge(input:{pullRequestId:$id}) { clientMutationId } }\' -f id=X'],
  ['gh api graphql -f query=\'mutation { disablePullRequestAutoMerge(input:{pullRequestId:"X"}) { clientMutationId } }\''],
  ['gh api graphql -f query=\'mutation { resolveReviewThread(input:{threadId:"X"}) { clientMutationId } minimizeComment(input:{subjectId:"Y", classifier: RESOLVED}) { clientMutationId } }\''],
  ['gh api graphql -f query=\'mutation { markPullRequestReadyForReview(input:{pullRequestId:"X"}) { clientMutationId } }\''],
  ['gh api graphql -f query=\'mutation { createPullRequest(input:{repositoryId:"X", baseRefName:"main", headRefName:"agent/x", title:"t"}) { clientMutationId } }\''],
  ['gh api graphql -f query=\'mutation { addComment(input:{subjectId:"X", body:"mergePullRequest mutation { }"}) { clientMutationId } }\''],
  ['gh api graphql -f query=\'query { repository(owner:"o", name:"r") { pullRequests(first:5) { nodes { number } } } }\''],
  ['gh api graphql -f query=\'query($n: Int!) { viewer { login } }\' -F n=5'],
  ['gh api graphql -f query=\'# mutation\nquery { viewer { login } }\''],
  ['gh api graphql -F query=@m.graphql', { readText: () => 'mutation { addComment(input:{subjectId:"x", body:"y"}) { clientMutationId } }' }],
  ['echo job start x -- git push origin main'],
  ['P=/h/pipeline.mjs; node $P job start v -- npm test'],
  ['gh issue close 5 7'],
  ['gh api repos/o/r/issues/12/labels/needs%2Dhuman'],
  ['gh api -X PUT repos/o/r/contents/f -f message=x -f content=eA== -f branch=agent/x'],
  ['gh api repos/o/r/contents/README.md'],
  ['git push origin refs/tags/v1.0'],
  ['git push --tags origin'],
  ['git status; Write-Host done'],
  ['git send-pack ../origin.git agent/x'],
  ['& git status'],
  ['g=git; $g status'],
  ['curl -s https://example.com/setup.sh | bash'],
  ['git {status,log} --oneline'],
  ['git push origin {agent/x,agent/y}'],
];

for (const [command, o] of BYPASS_DENY) {
  test('DENY bypass ' + label(command, o).replace(/\n/g, '\\n'), () => {
    const v = evaluate(command, { branch: 'agent/x', ...o });
    assert.equal(v.decision, 'deny', 'expected deny, got allow for: ' + command);
    assert.ok(v.reason.length > 10);
  });
}

for (const [command, o] of BYPASS_ALLOW) {
  test('ALLOW bypass ' + label(command, o).replace(/\n/g, '\\n'), () => {
    const v = evaluate(command, { branch: 'agent/x', ...o });
    assert.equal(v.decision, 'allow', 'expected allow, got deny (' + v.reason + ') for: ' + command);
  });
}

test('an overridden branch is looked up by name, and only for the directory it changed', () => {
  let v = evaluate('git checkout agent/y && git push', { pushDest: () => null });
  assert.deepEqual(v.calls.pushDirs, [{ dir: resolve('/work/repo'), gitDir: null, branch: 'agent/y' }]);
  assert.deepEqual(v.calls.branchDirs, [], 'the override replaces the real branch lookup');
  v = evaluate('git checkout main && git push origin agent/x');
  assert.equal(v.decision, 'allow');
  v = evaluate('git checkout main; cd /other; git push', { byDir: { '/other': 'agent/y', '/work/repo': 'agent/x' } });
  assert.equal(v.decision, 'allow');
  v = evaluate('git checkout main; cd /other; git push', { byDir: { '/other': 'main', '/work/repo': 'agent/x' } });
  assert.equal(v.decision, 'deny');
  v = evaluate('git checkout src/a.ts && git push', { branch: 'main', pathExists: () => true });
  assert.equal(v.decision, 'deny', 'a path checkout leaves the real branch (main) in force');
  v = evaluate('git checkout src/a.ts && git push', { branch: 'agent/x', pathExists: () => false });
  assert.equal(v.decision, 'allow', 'a name that is not on disk is a branch');
});

test('the query of a graphql call is scanned, not just grepped', () => {
  const v = evaluate('gh api graphql -f query=\'mutation { addComment(input:{body:"x"}) { clientMutationId } }\'');
  assert.equal(v.decision, 'allow');
  const bad = evaluate('gh api graphql -f query=\'mutation { addComment(input:{body:"x"}) { clientMutationId } deleteIssue(input:{issueId:"i"}) { clientMutationId } }\'');
  assert.equal(bad.decision, 'deny');
  assert.match(bad.reason, /deleteIssue/);
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
  return realpathSync.native(dir);
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

// Fail-closed change (#21): the keyword condition is gone, so malformed or empty stdin is refused whatever it mentions.
test('spawn: malformed or empty stdin is denied, whether or not it mentions a guarded word', () => {
  for (const raw of ['{"tool_name":"Bash","tool_input":{"command":"git push origin main"', '{"tool_name":"Bash","tool_input":{"command":"ls -la"', '', '[]', 'null']) {
    const r = hook(raw);
    assert.equal(r.status, 0, raw);
    const out = JSON.parse(r.stdout).hookSpecificOutput;
    assert.equal(out.permissionDecision, 'deny', raw);
    assert.match(out.permissionDecisionReason, /internal error/, raw);
  }
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
  const viaC = hook(bashInput(`git -C '${onMain}' push`, onAgent)); // quoted: Windows paths carry backslashes
  assert.equal(JSON.parse(viaC.stdout).hookSpecificOutput.permissionDecision, 'deny');
  const viaCd = hook(bashInput(`cd '${onMain}' && git push -u origin HEAD`, onAgent));
  assert.equal(JSON.parse(viaCd.stdout).hookSpecificOutput.permissionDecision, 'deny');
  const fine = hook(bashInput(`git -C '${onAgent}' push`, onMain));
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
// An empty file, not os.devNull: Git for Windows cannot open \\.\nul as a config file.
const NO_CONFIG = join(TMP, 'empty.gitconfig');
writeFileSync(NO_CONFIG, '');
const GIT_ENV = { GIT_CONFIG_GLOBAL: NO_CONFIG, GIT_CONFIG_SYSTEM: NO_CONFIG, GIT_CONFIG_NOSYSTEM: '1' };
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
  return { dir: realpathSync.native(work), git };
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

test('spawn: the PowerShell tool is judged like Bash', () => {
  const ps = (command) => hook({ ...bashInput(command, TMP), tool_name: 'PowerShell' });
  assert.equal(verdictOf(ps('git push origin main')).permissionDecision, 'deny');
  assert.equal(verdictOf(ps('& git push --force')).permissionDecision, 'deny');
  assert.equal(verdictOf(ps('& "C:\\Program Files\\Git\\cmd\\git.exe" push origin main')).permissionDecision, 'deny');
  assert.equal(ps('git status').stdout, '');
  const other = hook({ ...bashInput('git push origin main', TMP), tool_name: 'Read' });
  assert.equal(other.stdout, '');
});

test('spawn: a branch switched earlier on the line is looked up as <branch>@{push} in the real repo', () => {
  const { dir, git } = makeClone('pd-switch');
  git('checkout', '-q', '--track', '-b', 'agent/y', 'origin/main');
  git('config', 'push.default', 'upstream');
  git('checkout', '-q', '--no-track', '-b', 'agent/x', 'main');
  git('push', '-q', '-u', 'origin', 'agent/x'); // agent/x: upstream origin/agent/x
  const bare = (c) => hook(bashInput(c, dir), { env: GIT_ENV });
  assert.equal(bare('git push').stdout, '', 'current branch agent/x pushes to origin/agent/x');
  assert.equal(verdictOf(bare('git checkout agent/y && git push')).permissionDecision, 'deny'); // agent/y@{push} = origin/main
  assert.equal(verdictOf(bare('git checkout main && git push')).permissionDecision, 'deny');
  assert.equal(verdictOf(bare('git switch main; git push origin HEAD')).permissionDecision, 'deny');
  assert.equal(verdictOf(bare('git checkout -B main origin/main && git push')).permissionDecision, 'deny');
  assert.equal(verdictOf(bare('git branch -M main && git push')).permissionDecision, 'deny');
  assert.equal(bare('git checkout -b agent/new --no-track main && git push').stdout, '');
  assert.equal(bare('git checkout agent/x && git push').stdout, '');
  git('checkout', '-q', 'main');
  assert.equal(bare('git checkout agent/x && git push').stdout, '', 'switching away from main makes the push safe');
  assert.equal(verdictOf(bare('git push')).permissionDecision, 'deny');
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

test('spawn: a policy module that fails to load fails closed for every command it is asked about', () => {
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
  const harmless = run('ls -la'); // formerly allowed (no guarded word): the keyword rule is gone
  assert.equal(harmless.status, 0);
  assert.equal(JSON.parse(harmless.stdout).hookSpecificOutput.permissionDecision, 'deny');
  assert.match(JSON.parse(harmless.stdout).hookSpecificOutput.permissionDecisionReason, /internal error/);
});

test('spawn: when hook-io.mjs itself is missing the hook still denies (a crash would allow)', () => {
  const root = join(TMP, 'no-hook-io');
  cpSync(resolve(HERE, '../pipeline/hooks'), join(root, 'pipeline/hooks'), { recursive: true });
  rmSync(join(root, 'pipeline/hooks/lib/hook-io.mjs'));
  const r = spawnSync(process.execPath, [join(root, 'pipeline/hooks/guard-git.mjs')], { input: JSON.stringify(bashInput('ls -la', TMP)), encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny');
  assert.match(JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason, /^\[claude-pipeline guard-git\] internal error/);
});

test('spawn: label rules need no gh at all', () => {
  const r = hook(bashInput('gh pr edit 1 --add-label human-approved', TMP), { env: { PIPELINE_GH: join(TMP, 'does-not-exist') } });
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny');
});

function readLines(file) { return readFileSync(file, 'utf8').split('\n').filter(Boolean); }
function readFirstLine(file) { return readLines(file)[0]; }

// ---- Monitor and MCP command tools (review finding 1) ---------------------------------------------------

const toolInput = (tool_name, tool_input, cwd = TMP) => ({ session_id: 's', cwd, hook_event_name: 'PreToolUse', tool_name, tool_input });
const denied = (r) => r.status === 0 && r.stdout !== '' && JSON.parse(r.stdout).hookSpecificOutput.permissionDecision === 'deny';

test('spawn: the Monitor tool is judged like Bash', () => {
  assert.ok(denied(hook(toolInput('Monitor', { command: 'git push origin main' }))));
  assert.ok(denied(hook(toolInput('Monitor', { command: 'gh pr merge 1 --admin' }))));
  const ok = hook(toolInput('Monitor', { command: 'git push -u origin agent/x' }));
  assert.equal(ok.stdout, '');
});

test('spawn: an MCP tool string field named command / cmd / script is judged like a Bash command', () => {
  assert.ok(denied(hook(toolInput('mcp__shell__run', { command: 'git push origin main' }))));
  assert.ok(denied(hook(toolInput('mcp__shell__run', { options: { cmd: 'git push -f' } }))));
  assert.ok(denied(hook(toolInput('mcp__ide__exec', { script: 'gh pr edit 1 --add-label human-approved' }))));
  assert.equal(hook(toolInput('mcp__shell__run', { command: 'git status' })).stdout, '');
  // text that merely sits in a differently named field (a Notion page body) is not a command
  assert.equal(hook(toolInput('mcp__notion__create_page', { body: 'git push origin main' })).stdout, '');
});

test('the installed matchers cover Monitor and MCP tools for guard-git', async () => {
  const { GUARD_GIT_MATCHER, GUARD_FILES_MATCHER } = await import('../pipeline/lib/installer.mjs');
  for (const m of [GUARD_GIT_MATCHER, GUARD_FILES_MATCHER]) {
    const re = new RegExp(`^(?:${m})$`);
    for (const tool of ['Bash', 'PowerShell', 'Monitor', 'mcp__x__run']) assert.ok(re.test(tool), `${m} must match ${tool}`);
  }
});

// ---- time budget (review finding 12) ----------------------------------------------------------------------

test('an oversized command line is not parsed: denied when it mentions a guarded word (quotes stripped), allowed otherwise', () => {
  const spam = '{a,b}'.repeat(60_000); // 300 KB
  const t0 = Date.now();
  assert.equal(evaluate(`echo ${spam}`).decision, 'allow');
  assert.equal(evaluate(`echo ${spam}; git push origin main`).decision, 'deny');
  assert.equal(evaluate(`echo ${spam}; g''it pu"sh" origin main`).decision, 'deny');
  assert.equal(evaluate(`echo ${spam}; gh pr edit 1 --add-label human-""approved`).decision, 'deny');
  assert.ok(Date.now() - t0 < 3000, 'the size cap must keep the hook far below its 15 s timeout');
});

test('brace spam just under the size cap is cut off by the expansion budget, not by the clock', () => {
  const spam = Array.from({ length: 12_000 }, () => '{a,b,c}').join(' ');
  const t0 = Date.now();
  evaluate(`echo ${spam}`);
  assert.ok(Date.now() - t0 < 3000);
});

// ---- dynamic push destinations and env-supplied git config (review findings 3 and 4) -------------------

test('a push destination built at run time is allowed only for the current-branch idioms or a literal variable', () => {
  const dynamicDeny = [
    'git push origin HEAD:${B:-main}',
    'for b in main; do git push origin HEAD:$b; done',
    'f(){ git push origin HEAD:$1; }; f main',
    'git push origin HEAD:$(cat .branch)',
    'git push origin HEAD:m${x}ain',
    'git push origin HEAD:"$(echo bWFpbg== | base64 -d)"',
    'git push origin HEAD:`cat .branch`',
    'git push origin "$BRANCH"',
    'git push origin HEAD:agent/$(date +%s)',
    'git push origin HEAD:"$(git branch --show-current)-main"',
    'git push origin HEAD:"$(git -C /other branch --show-current)"',
    'B=main; git push origin HEAD:$B',
    'B=$(cat .branch); git push origin HEAD:$B',
  ];
  for (const c of dynamicDeny) assert.equal(evaluate(c).decision, 'deny', c);
  const ok = [
    'git push origin HEAD:$(git branch --show-current)',
    'git push origin "$(git branch --show-current)"',
    'git push origin HEAD:"$(git rev-parse --abbrev-ref HEAD)"',
    'git push origin HEAD:`git branch --show-current`',
    'git push origin `git rev-parse --abbrev-ref HEAD`',
    'git push -u origin "$(git  branch   --show-current)"',
    'B=agent/y; git push origin HEAD:$B',
    'B=agent/y && git push origin HEAD:${B}',
    'export B=agent/y; git push -u origin $B',
    'B=$(git branch --show-current); git push origin HEAD:$B',
  ];
  for (const c of ok) assert.equal(evaluate(c, { branch: 'agent/x' }).decision, 'allow', c);
  // the idiom still resolves to the current branch, so on main it is a push to main
  assert.equal(evaluate('git push origin HEAD:$(git branch --show-current)', { branch: 'main' }).decision, 'deny');
  assert.equal(evaluate('git push origin HEAD:$(git branch --show-current)', { branch: null }).decision, 'deny');
});

test('git config supplied through the environment counts as changed push configuration for a bare push', () => {
  const envDeny = [
    'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=remote.origin.push GIT_CONFIG_VALUE_0=HEAD:main git push',
    'GIT_CONFIG_PARAMETERS="\'remote.origin.push=HEAD:main\'" git push',
    'env GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=remote.origin.push GIT_CONFIG_VALUE_0=HEAD:main git push',
    'export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=remote.origin.push GIT_CONFIG_VALUE_0=HEAD:main; git push',
    'GIT_CONFIG_COUNT=1; GIT_CONFIG_KEY_0=push.default; GIT_CONFIG_VALUE_0=upstream; git push',
    'GIT_CONFIG_GLOBAL=/tmp/evil.gitconfig git push',
    'GIT_CONFIG_SYSTEM=/tmp/evil.gitconfig git push origin',
    '$env:GIT_CONFIG_COUNT=1; git push',
  ];
  for (const c of envDeny) assert.equal(evaluate(c, { branch: 'agent/x' }).decision, 'deny', c);
  // an explicit refspec is not redirected by config
  assert.equal(evaluate('GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.editor GIT_CONFIG_VALUE_0=true git push origin HEAD:agent/x', { branch: 'agent/x' }).decision, 'allow');
  assert.equal(evaluate('GIT_AUTHOR_NAME=x git push', { branch: 'agent/x' }).decision, 'allow');
});

// PR #7 security-scan findings 1 and 2: a variable assigned twice is "unsure" (not in ctx.vars) but was still assigned,
// so every check that looks at assigned variable NAMES must see it too.
test('git config from the environment still counts when the variable was assigned more than once', () => {
  const exp = 'export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=remote.origin.push GIT_CONFIG_VALUE_0=HEAD:main';
  const envDeny = [
    // finding 1: exported twice
    `${exp}; ${exp}; git push`,
    `${exp} GIT_CONFIG_COUNT=1; git push`, // twice in one export
    `${exp}; export GIT_CONFIG_COUNT=1; git push`,
    // finding 2: plain assignments, twice
    'GIT_CONFIG_COUNT=1; GIT_CONFIG_COUNT=1; GIT_CONFIG_KEY_0=remote.origin.push; GIT_CONFIG_VALUE_0=HEAD:main; git push',
    'GIT_CONFIG_COUNT=1; GIT_CONFIG_KEY_0=remote.origin.push; GIT_CONFIG_KEY_0=remote.origin.push; GIT_CONFIG_VALUE_0=HEAD:main; git push',
    'GIT_CONFIG_PARAMETERS=x; GIT_CONFIG_PARAMETERS="\'remote.origin.push=HEAD:main\'"; git push',
    'GIT_CONFIG_GLOBAL=/a; GIT_CONFIG_GLOBAL=/tmp/evil.gitconfig; git push',
    'GIT_CONFIG_SYSTEM=/a; false && GIT_CONFIG_SYSTEM=/b; git push origin',
    // assigned twice, then git runs through send-pack or an alias defined on the line
    'GIT_CONFIG_COUNT=1; GIT_CONFIG_COUNT=1; git send-pack',
    'GIT_CONFIG_COUNT=1; GIT_CONFIG_COUNT=1; git -c alias.p=push p',
  ];
  for (const c of envDeny) assert.equal(evaluate(c, { branch: 'agent/x' }).decision, 'deny', c);
  // unrelated variables assigned twice, and an explicit refspec, stay fine
  assert.equal(evaluate('A=1; A=2; git push', { branch: 'agent/x' }).decision, 'allow');
  assert.equal(evaluate('GIT_CONFIG_COUNT=1; GIT_CONFIG_COUNT=1; git push origin HEAD:agent/x', { branch: 'agent/x' }).decision, 'allow');
});

// PR #7 security-scan finding 3: the subcommand has to be literal before the alias lookup, the push dispatch and
// branch tracking see it, so a variable that expands to push can never route around checkPush.
test('a git subcommand built from a variable never reaches the push / alias / tracking dispatch unchecked', () => {
  const denyCmds = [
    'X=push; git $X origin main',
    'X=pu; git ${X}sh -f origin main',
    'X=push; X=push; git $X origin main',
    'X=pu; git ${X}sh origin main',
    'export X=push; git "$X" origin main',
    'X=send-pack; git $X ../origin.git main',
    'X=push; git -C /work/repo $X origin main',
    'X=push; git -c user.name=a $X origin main',
    'X=p; git config alias.p push; git $X origin main',
    'X=checkout; git $X main; git push',
    'X=push; env git $X origin main',
  ];
  for (const c of denyCmds) assert.equal(evaluate(c, { branch: 'agent/x' }).decision, 'deny', c);
});

// Siblings of findings 1 and 2: GIT_DIR and GH_REPO select the repository. Only the command's own prefix
// (`GIT_DIR=x git push`) is certain to reach it; an earlier assignment or export may never run (`false && export …`) or
// may not be exported at all, so the repository is unknown and the protected operation is denied.
test('GIT_DIR and GH_REPO set before the command are unknown; only a command prefix or an explicit flag is trusted', () => {
  const gitDeny = [
    'export GIT_DIR=/e/.git; git push',
    'GIT_DIR=/e/.git; git push',
    'false && export GIT_DIR=/safe/.git; git push',
    'GIT_DIR=/a/.git; GIT_DIR=/b/.git; git push',
    'export GIT_DIR=/a/.git; false && export GIT_DIR=/b/.git; git push',
    'GIT_DIR=/a/.git; GIT_DIR=/b/.git; git send-pack',
    'export GIT_DIR=/e/.git; git branch -m x',
    'false && export GIT_DIR=/safe/.git; git -c alias.p=push p',
  ];
  for (const c of gitDeny) assert.equal(evaluate(c, { branch: 'agent/x' }).decision, 'deny', c);
  // a prefix on the command itself, or an explicit flag, is certain
  let v = evaluate('GIT_DIR=/a/.git; GIT_DIR=/b/.git git push');
  assert.equal(v.calls.branchDirs[0].gitDir, resolve('/b/.git'));
  v = evaluate('false && export GIT_DIR=/safe/.git; git --git-dir=/real/.git push');
  assert.equal(v.calls.branchDirs[0].gitDir, resolve('/real/.git'));
  assert.equal(evaluate('export GIT_DIR=/e/.git; git status').decision, 'allow');

  const ghDeny = [
    'export GH_REPO=o/r; gh issue close 9',
    'GH_REPO=o/r; gh issue close 9',
    'false && export GH_REPO=o/safe; gh issue close 9',
    'GH_REPO=o/r; GH_REPO=p/q; gh issue close 9',
    'export GH_REPO=o/r; false && export GH_REPO=p/q; gh issue close 9',
    'false && export GH_REPO=o/safe; gh issue delete 9',
    'false && export GH_REPO=o/safe; gh issue transfer 9 o/other',
  ];
  for (const c of ghDeny) assert.equal(evaluate(c, { labels: [] }).decision, 'deny', c);
  v = evaluate('GH_REPO=o/r gh issue close 9', { labels: [] });
  assert.deepEqual(v.calls.labels[0].repoArgs, ['-R', 'o/r']);
  v = evaluate('false && export GH_REPO=o/safe; gh issue close 9 -R o/real', { labels: [] });
  assert.deepEqual(v.calls.labels[0].repoArgs, ['-R', 'o/real']);
  // other gh commands do not look at the repository, so the same variable is harmless there
  assert.equal(evaluate('GH_REPO=o/r; GH_REPO=p/q; gh pr view 9').decision, 'allow');
});

// Codex round on PR #7: a variable assigned twice is dropped from the known values, so its $NAME text survives expansion.
// That must never be recorded as a branch name, nor slip past a pattern that only matches the expanded text.
test('an unresolved expansion is unknown branch state, never a branch name', () => {
  const denyCmds = [
    'B=agent/x; B=main; git switch -C "$B"; git push origin HEAD',
    'B=agent/x; B=main; git checkout -b "$B"; git push',
    'B=agent/x; B=main; git checkout -B $B; git push origin HEAD',
    'B=agent/x; B=main; git branch -m "$B"; git push',
    'B=agent/x; B=main; git worktree add -b "$B" ../w; git -C ../w push',
    'B=agent/x; B=main; git worktree add ../w "$B"; git -C ../w push',
    'B=agent/x; B=main; git rebase origin/x "$B"; git push',
    'B=agent/x; B=main; git symbolic-ref HEAD "refs/heads/$B"; git push',
    // never assigned at all: still run-time, still unknown
    'git switch -C "$NEW"; git push origin HEAD',
    'git checkout -b "$NEW"; git push',
    'git branch -m "$NEW"; git push',
  ];
  for (const c of denyCmds) assert.equal(evaluate(c, { branch: 'agent/x' }).decision, 'deny', c);
  assert.equal(evaluate('B=agent/y; git switch -C "$B"; git push origin HEAD', { branch: 'main' }).decision, 'allow');
});

test('a protected argument built from a variable assigned twice fails closed', () => {
  const denyCmds = [
    'E=unused; E=repos/o/r/pulls/5/merge; gh api -X PUT "$E"',
    'E=unused; E=repos/o/r/pulls/5/merge; gh api "$E" -X PUT',
    'E=unused; E=repos/o/r/statuses/abc; gh api -X POST "$E" -f state=success',
    'E=unused; E=repos/o/r/git/refs; gh api -X POST "$E" -f ref=refs/heads/main',
    'E=unused; E=repos/o/r/issues/3/labels/needs-human; gh api -X DELETE "$E"',
    'E=unused; E=repos/o/r/rulesets/1; gh api -X DELETE "$E"',
    'M=GET; M=DELETE; gh api -X "$M" repos/o/r/issues/3/labels/needs-human',
    'F=x; F=branch=main; gh api -X PUT repos/o/r/contents/f -f message=m -f content=eA== -f "$F"',
    'L=unused; L=human-approved; gh label delete "$L" --yes',
    'L=unused; L=human-approved; gh label edit "$L" --name x',
    'L=unused; L=human-approved; gh pr edit 1 --add-label "$L"',
    'L=unused; L=needs-human; gh issue edit 1 --remove-label "$L"',
    'N=1; N=7; gh issue close "$N"',
    'N=1; N=7; gh pr merge "$N" --admin',
    'R=o/a; R=o/b; gh issue close 9 -R "$R"',
    'T=x; T=main; gh repo edit --default-branch "$T"',
    'B=x; B=main; git push origin "$B"',
    'B=x; B=main; git push origin HEAD:"$B"',
    'B=x; B=main; git push origin HEAD:refs/heads/${B}',
    'D=/a; D=/b; git -C "$D" push',
    'P=x; P=main; bash -c "git push origin $P"',
    'P=x; P=main; node ~/.claude/pipeline/bin/pipeline.mjs job start j -- git push origin $P',
  ];
  for (const c of denyCmds) assert.equal(evaluate(c, { branch: 'agent/x', labels: [] }).decision, 'deny', c);
  // a run-time value that was never assigned on the line is still fine in a non-protected position
  assert.equal(evaluate('gh pr view $N --json title').decision, 'allow');
  assert.equal(evaluate('A=1; A=2; git status').decision, 'allow'); // assigned twice but never used
});

// ---- script files and string-running wrappers (review findings 2 and 11) ------------------------------------

// A fake file system: { 'push.sh': 'git push origin main' } relative to the cwd (/work/repo).
const withFiles = (files, o = {}) => {
  const abs = Object.fromEntries(Object.entries(files).map(([k, v]) => [resolve(o.cwd ?? '/work/repo', k), v]));
  return { ...o, readText: (p) => (typeof abs[p] === 'string' ? abs[p] : null), pathExists: (p) => p in abs };
};

test('a script file is read and judged by what it runs', () => {
  const files = {
    'push.sh': 'echo hi\ngit push origin main\n',
    'merge.sh': '#!/bin/bash\ngh pr merge 1 --admin\n',
    'label.sh': 'gh pr edit 1 --add-label human-approved',
    'ok.sh': 'git status\ngit push -u origin agent/x\n',
    'nested.sh': 'bash push.sh',
    'deep.sh': 'git push \\\n  origin \\\n  main',
    'ok.mjs': "console.log('hello')",
    'push.mjs': "import { execSync } from 'node:child_process';\nexecSync('git push origin main');",
    'push.py': 'import subprocess\nsubprocess.run(["git", "push", "origin", "main"])',
    'force.rb': '`git push --force origin agent/x`',
  };
  const ev = (c) => evaluate(c, withFiles(files));
  for (const c of [
    'bash push.sh', 'sh ./push.sh', './push.sh', 'source push.sh', '. push.sh', '. ./push.sh', 'env bash push.sh', 'zsh -x push.sh',
    'bash merge.sh', 'bash label.sh', 'bash nested.sh', 'bash deep.sh', 'cd /work/repo && bash push.sh',
    'node push.mjs', 'python3 push.py', 'ruby force.rb', 'pipeline job start c -- bash push.sh',
    'node /x/pipeline.mjs job start c -- bash push.sh', 'time bash push.sh', 'sudo bash push.sh', 'bash -x -e push.sh a b',
  ]) assert.equal(ev(c).decision, 'deny', c);
  for (const c of ['bash ok.sh', './ok.sh', 'source ok.sh', 'node ok.mjs', 'bash missing.sh', 'node missing.mjs', './missing.sh', 'pipeline job start c -- bash ok.sh']) {
    assert.equal(ev(c).decision, 'allow', c);
  }
  // the file is resolved against the directory the command runs in
  const dirFiles = { sub: null, [resolve('/work/repo/sub/push.sh')]: 'git push origin main' }; // D:\\work\\... on Windows
  const v = evaluate('cd sub && bash push.sh', { readText: (p) => dirFiles[p] ?? null, pathExists: (p) => p in dirFiles });
  assert.equal(v.decision, 'deny');
});

test('a shell script that exists but cannot be read is denied; one that does not exist is not', () => {
  const unreadable = { readText: () => null, pathExists: () => true };
  assert.equal(evaluate('bash big.sh', unreadable).decision, 'deny');
  assert.equal(evaluate('source big.sh', unreadable).decision, 'deny');
  assert.match(evaluate('bash big.sh', unreadable).reason, /cannot read/);
  // a program run by path may just be a binary or a huge generated file: not judged
  assert.equal(evaluate('./tool', unreadable).decision, 'allow');
  assert.equal(evaluate('node big.mjs', unreadable).decision, 'allow');
  assert.equal(evaluate('bash big.sh', { readText: () => null, pathExists: () => false }).decision, 'allow');
});

test('a script whose name is only known at run time is denied only when the line mentions a guarded operation', () => {
  assert.equal(evaluate('bash "$SCRIPT"').decision, 'allow');
  assert.equal(evaluate('bash "$SCRIPT" && git push origin x').decision, 'deny');
  assert.equal(evaluate('F=push.sh; bash $F', withFiles({ 'push.sh': 'git push origin main' })).decision, 'deny');
});

test('script content is judged with the same rules, including truncation and size', () => {
  const huge = `${'true; '.repeat(600)}ls`;
  assert.equal(evaluate('bash t.sh', withFiles({ 't.sh': huge })).decision, 'deny');
  const big = `# ${'x'.repeat(250_000)}\ngit push origin main`;
  assert.equal(evaluate('bash t.sh', withFiles({ 't.sh': big })).decision, 'deny');
  assert.equal(evaluate('bash t.sh', withFiles({ 't.sh': `# ${'x'.repeat(250_000)}\nls` })).decision, 'allow');
  assert.equal(evaluate('bash a.sh', withFiles({ 'a.sh': 'bash a.sh' })).decision, 'deny', 'a script that runs itself is cut off by the nesting limit, fail closed');
});

test('a program run by path is read: a shebang picks shell or program text; binaries and node_modules are skipped', () => {
  const files = {
    'go.sh': '#!/bin/sh\ngit push origin main',
    'go.js': "#!/usr/bin/env node\nrequire('child_process').execSync('git push origin main')",
    'plain': 'git push origin main',
    'bin': 'MZ\u0000\u0000git push origin main',
    'node_modules/.bin/tool': "#!/usr/bin/env node\nexecSync('git push origin main')",
  };
  const ev = (c) => evaluate(c, withFiles(files)).decision;
  assert.equal(ev('./go.sh'), 'deny');
  assert.equal(ev('./go.js'), 'deny');
  assert.equal(ev('./plain'), 'deny');
  assert.equal(ev('./bin'), 'allow');
  assert.equal(ev('./node_modules/.bin/tool'), 'allow');
  assert.equal(ev('/usr/bin/true'), 'allow');
});

test('string-running wrappers are unwrapped or scanned', () => {
  const deny = [
    'unbuffer git push origin main',
    'taskset -c 0 git push origin main',
    'sandbox-exec -f p.sb git push origin main',
    "ssh host 'git push origin main'",
    "script -c 'git push origin main' /dev/null",
    'screen -dmS j git push origin main',
    "parallel 'git push origin HEAD:{}' ::: main",
    "wsl bash -c 'git push origin main'",
    "npx -c 'git push origin main'",
    "npm exec -c 'git push origin main'",
    'pnpm exec git push origin main',
    'bunx git push origin main',
    "node -e \"require('child_process').execSync('git push origin main')\"",
    "python3 -c 'import os; os.system(\"git push -f origin x\")'",
    "perl -e 'system(\"git push --force origin x\")'",
    "ruby -e 'system(\"gh pr merge 1 --admin\")'",
    "osascript -e 'do shell script \"git push origin main\"'",
    "node -e \"spawnSync('git',['push','origin','main'])\"",
    "node -e \"x('gh pr edit 1 --add-label human-approved')\"",
    "node -e \"x('gh pr edit 1 --remove-label needs-human')\"",
    "node -e \"x('pipeline protect --apply')\"",
    'make release CMD="git push origin main"',
  ];
  for (const c of deny) assert.equal(evaluate(c).decision, 'deny', c);
  const allow = [
    "ssh host 'git status'",
    "node -e \"console.log('hi')\"",
    "python3 -c 'print(1)'",
    'npx vitest run -t "git push origin main is denied"',
    'npm test -- --grep "git push origin main"',
    'echo "git push origin main"',
    "grep -rn 'git push origin main' docs",
    'cat docs/guide.md',
    'node ~/.claude/pipeline/bin/pipeline.mjs preflight',
    'node ~/.claude/pipeline/bin/pipeline.mjs job start v -- node scripts/verify.mjs',
    'ssh host',
    'npm install',
    'taskset -p 1234',
  ];
  for (const c of allow) assert.equal(evaluate(c, { branch: 'agent/x' }).decision, 'allow', c);
});

test('spawn: a script file in the real working directory is read by the hook', () => {
  const dir = join(TMP, 'scripts');
  execFileSync('mkdir', ['-p', dir]);
  writeFileSync(join(dir, 'push.sh'), 'git push origin main\n');
  writeFileSync(join(dir, 'ok.sh'), 'ls\n');
  assert.ok(denied(hook(bashInput('bash push.sh', dir))));
  assert.ok(denied(hook(bashInput('./push.sh', dir))));
  assert.ok(denied(hook(bashInput('source push.sh', dir))));
  assert.ok(denied(hook(bashInput('env bash push.sh', dir))));
  assert.equal(hook(bashInput('bash ok.sh', dir)).stdout, '');
});

test('everyday flows stay allowed after the script, wrapper and destination rules', () => {
  const commit = "git commit -m \"$(cat <<'EOF'\nfix: handle git push origin main in docs\n\nBody mentioning gh pr merge 1 --admin\nEOF\n)\"";
  const flows = [
    commit,
    'git push -u origin agent/x',
    'git push origin HEAD:agent/x',
    'git push',
    'node ~/.claude/pipeline/bin/pipeline.mjs preflight',
    'node ~/.claude/pipeline/bin/pipeline.mjs merge 12',
    'node ~/.claude/pipeline/bin/pipeline.mjs job start v -- node ~/.claude/pipeline/bin/pipeline.mjs merge 12',
    'gh pr create --title "x" --body "never git push origin main"',
    'gh pr comment 3 --body "gh pr merge 1 --admin is blocked"',
    'npm test && npm run build',
    'cat ~/.claude/settings.json',
    'bash -c "git status && git push -u origin agent/x"',
    'ls ~/.claude/skills',
  ];
  for (const c of flows) assert.equal(evaluate(c, { branch: 'agent/x' }).decision, 'allow', c);
});

// PR #7 round 3/4: an unsure variable (assigned more than once, or where it may not run: after && / ||, in a pipeline,
// subshell, if / loop / case) denies the line when it reaches a git / gh command, a command that runs other code or
// changes what runs (shells, source, eval, env, xargs, interpreters, a path or dynamic command name), cd / pushd /
// popd, or the command name itself. Variables tainted by an unsure one are unsure too. Plain text tools stay usable.
test('a line that passes an unsure variable to something that runs code or picks the repository is denied', () => {
  const files = { 'run.sh': 'git push origin main', 'run.js': 'x', 'run.py': 'x' };
  const denyCmds = [
    'F=run.sh; F=run.sh; bash "$F"',
    'F=run.sh; F=run.sh; sh $F',
    'F=run.sh; F=run.sh; zsh "$F"',
    'F=run.sh; F=run.sh; source "$F"',
    'F=run.sh; F=run.sh; . "$F"',
    'F=run.js; F=run.js; node "$F"',
    'F=run.py; F=run.py; python3 $F',
    'F=./run.sh; F=./run.sh; "$F"',
    'D=/work/repo; D=/other; cd "$D"; gh issue close 9',
    'D=/work/repo; D=/other; pushd "$D"; gh issue close 9',
    'E=a; E=b; env "$E" git status',
    'A=a; A=b; echo x | xargs $A',
    'A=a; A=b; eval "$A"',
    'A=a; A=b; $A status', // the command name itself
    'F=a; F=b; bash -c "echo $F"',
    // assigned where it may not run, then handed to something that runs code or picks the repository
    'false && X=agent/x; git push origin $X',
    'true || X=a; bash $X',
    'cd /work/repo && X=agent/x && git push origin $X',
    'if true; then X=a; fi; bash $X',
    'for i in 1 2; do X=$i; done; node $X',
    'while true; do X=a; done; python $X',
    'case a in a) X=1;; esac; source $X',
    '(X=a); cd $X',
    'echo $(X=a); sh $X',
    'X=a | cat; gh pr view $X',
    // taint: a value built from an unsure variable is unsure itself
    'F=a; F=b; X=$F; bash "$X"',
    'F=a; F=b; X=${F}.sh; Y=$X; source "$Y"',
    'F=a; F=b; export X=$F; git push origin $X',
    'F=a; F=b; X=$(echo $F); bash "$X"',
    // command-substitution bodies are commands of their own
    'D=a; D=b; s=$(git push origin "$D")',
    'D=a; D=b; echo "$(gh issue close "$D")"',
    'D=a; D=b; s=`git push origin $D`',
    'D=a; D=b; r=$(bash "$D"); echo $r',
    // round 4: anything outside the text-tool ALLOWLIST is sensitive — a list of runners is never complete
    'F=a; F=b; awk "BEGIN{system(\"$F\")}"', // awk runs commands
    'F=a; F=b; sed "e $F" x', // so does sed's e command
    'F=a; F=b; docker run "$F"',
    'F=a; F=b; cp "$F" run.sh', // the hook reads run.sh as it is NOW
    'F=a; F=b; /bin/echo $F', // a path names whatever is there, not the builtin
    // …and the value reaches it through a redirect or a pipe, not only its arguments
    'F=a; F=b; tee x <<< "$F"',
    'F=a; F=b; echo "$F" | node',
    'F=a; F=b; echo "$F" | xargs git push origin',
    'F=a; F=b; echo "$F" |& sh',
    'F=a; F=b; printf "%s" "$F" | grep . | python3',
  ];
  for (const c of denyCmds) assert.equal(evaluate(c, withFiles(files, { branch: 'agent/x', labels: [] })).decision, 'deny', c);
  const allowCmds = [
    'A=1; A=2; git status', // assigned twice, never referenced
    'false && X=agent/x; git status',
    'B=agent/y; git push origin $B', // one assignment, referenced: unchanged
    'B=agent/y && git push -u origin ${B}',
    'export B=agent/y; echo $B',
    'echo $UNSET_ANYWHERE',
    // unsure variables that only reach text tools
    'A=1; A=2; echo $A',
    'A=1; A=2; ls ${A}',
    'echo $F; F=a; F=b',
    'B=$B; B=x; true',
    'A=a; A=b; echo hi > $A',
    'if true; then X=a; fi; echo $X',
    'for i in 1 2; do X=$i; done; echo $X',
    'X=a | cat; echo $X',
    'for i in $(seq 1 55); do s=$(gh pr view 15 --json x --jq y); n=$(echo "$s" | grep -c Z); [ "$n" -ge 2 ] && break; sleep 10; done',
    'for f in a b; do x=$f; echo "$x"; done',
    'if [ -n "$Y" ]; then Z=1; fi; echo $Z',
    'r=$(gh pr checks 5); case "$r" in *fail*) echo bad;; esac',
    'n=1; n=2; printf "%s\\n" "$n" | wc -l; sleep $n; seq 1 $n | tail -1',
    // round 4: a pipeline of text tools, a here-string into one, and the usual CI polling loops
    'F=a; F=b; echo "$F" | grep x | wc -l',
    'F=a; F=b; cat <<< "$F"',
    'x=1; x=2; echo $x |& cat',
    'F=a; F=b; printf "%s" "$F" > out.txt',
    'n=0; while [ $n -lt 3 ]; do n=$((n+1)); sleep 1; done; echo $n',
    'for i in 1 2 3; do r=$(gh run view 5 --json status --jq .status); [ "$r" = completed ] && break; sleep 30; done; echo "$r"',
    'until gh pr checks 15; do sleep 60; done',
  ];
  for (const c of allowCmds) assert.equal(evaluate(c, withFiles(files, { branch: 'agent/x', labels: [] })).decision, 'allow', c);
});

// Background-scan findings on fcb708c: state set by a command that may not have run (after && / ||, in the background,
// a pipeline stage, a subshell, a substitution) must not be trusted by the commands after it, and builtins that assign
// variables without a NAME=value word make the variable unsure.
test('directory / branch / variable state from a command that may not have run is unknown', () => {
  const o = { byDir: { '/work/repo': 'main', '/safe': 'agent/x' }, labels: [] };
  const denyCmds = [
    'false && cd /safe; git push',
    'cd /safe & git push',
    'cd /safe &\ngit push',
    '(cd /safe); git push',
    'echo $(cd /safe); git push',
    'cd /safe | cat; git push',
    'cd /safe || git push',
    'false && pushd /safe; git push',
    'false && git checkout agent/y; git push',
    'git checkout agent/y & git push',
    '(git checkout agent/y); git push',
    'git checkout agent/y || true; git push',
    'echo $(git checkout agent/y); git push',
    'git checkout agent/y | cat; git push',
    // a variable bound by a builtin that has no NAME=value word
    'B=agent/x; read B <<< main; git push origin HEAD:$B',
    'B=agent/x; printf -v B main; git push origin HEAD:$B',
    'B=agent/x; unset B; git push origin HEAD:$B',
    'B=agent/x; let B=5; git push origin HEAD:$B',
    'B=agent/x; getopts a B -a; git push origin HEAD:$B',
    'B=agent/x; mapfile B <<< main; git push origin HEAD:$B',
    'B=agent/x & git push origin HEAD:$B',
  ];
  for (const c of denyCmds) assert.equal(evaluate(c, o).decision, 'deny', c);
  const allowCmds = [
    'cd /safe && git push',
    'true && cd /safe && git push',
    'git checkout agent/y && git push',
    'cd /safe; git push',
    'git checkout agent/y; git push',
    'cd /safe > /dev/null 2>&1 && git push', // redirects and &> are not a background job
    'cd /safe &>/dev/null; git status',
  ];
  for (const c of allowCmds) assert.equal(evaluate(c, o).decision, 'allow', c);
});

// Background-scan finding on 4789b20 (state tracking): constructs that change where a later command runs, or what a
// variable holds, without anything the walk follows. Each deny below pushes from the `main` checkout in a real shell.
test('namerefs, function / alias / trap definitions, shell options and sourced files make the state unknown', () => {
  const files = {
    '/safe/go.sh': 'cd /work/repo\n',
    '/safe/vars.sh': 'B=main\n',
    '/safe/env.sh': 'export NODE_ENV=test\n',
  };
  const o = {
    byDir: { '/work/repo': 'main', '/safe': 'agent/x' },
    labels: [],
    readText: (p) => files[p] ?? null,
    pathExists: (p) => p in files,
  };
  const denyCmds = [
    // a nameref reads ANOTHER variable at run time; the text only names it
    ['F=main; declare -n X=F; cd /safe && git push origin HEAD:$X', '/work/repo'],
    ['cd /safe && F=main; typeset -n X=F; git push origin HEAD:$X', '/work/repo'],
    ['F=main; declare -n X; X=F; cd /safe && git push origin HEAD:$X', '/work/repo'],
    // a function body is parsed as if it ran; it never does unless called
    ['f(){ cd /safe; }; git push', '/work/repo'],
    ['f () { cd /safe; }; git push', '/work/repo'],
    ['function f { cd /safe; }; git push', '/work/repo'],
    // aliases, traps and options change what a later `cd` does, or run a cd of their own
    ['alias cd=true; cd /safe; git push', '/work/repo'],
    ['trap "cd /work/repo" DEBUG; cd /safe; git push', '/work/repo'],
    ['setopt autocd; /work/repo; git push', '/safe'],
    ['set -o autocd; cd /safe && git push', '/work/repo'],
    ['enable -n cd; cd /safe; git push', '/work/repo'],
    // a sourced file runs in this shell: it may cd, or reassign a variable the line already set
    ['source ./go.sh; git push', '/safe'],
    ['. ./go.sh && git push', '/safe'],
    ['B=agent/x; source ./vars.sh; git push origin HEAD:$B', '/safe'],
  ];
  for (const [c, cwd] of denyCmds) assert.equal(evaluate(c, { ...o, cwd }).decision, 'deny', c);
  const allowCmds = [
    ['set -e; cd /safe && git push', '/work/repo'],
    ['set -euo pipefail; cd /safe && git push', '/work/repo'],
    ['arr=(); cd /safe && git push', '/work/repo'], // an empty array is not a function definition
    ['alias ll="ls -l"; ll', '/safe'], // no git / gh on the line
    ['source ./env.sh && npm test', '/safe'],
    ['declare -r B=agent/x; git push origin HEAD:$B', '/safe'], // -r is not -n
  ];
  for (const [c, cwd] of allowCmds) assert.equal(evaluate(c, { ...o, cwd }).decision, 'allow', c);
});

// Codex round 4 on 5730f1f: state that becomes unknown mid-line is enforced for what follows, an unknown directory never
// falls back to the starting one, and control flow is judged from where it starts (not from a word in a commit message).
test('state that becomes unknown mid-line stays enforced; control flow counts from where it starts', () => {
  const files = {
    '/work/repo/env.sh': 'export NODE_ENV=test\n',
    '/work/repo/run.sh': 'git push origin main\n',
    '/other/run.sh': 'git push origin main\n',
    '/work/repo/ok.sh': 'echo hi\n',
    // harmless where the line starts, a push to main where the cd may have gone
    '/work/repo/step.sh': 'echo hi\n',
    '/other/step.sh': 'git push origin main\n',
  };
  const o = {
    byDir: { '/work/repo': 'agent/x', '/other': 'agent/y' },
    labelsByNum: {},
    readText: (p) => files[p] ?? null,
    pathExists: (p) => p in files,
  };
  const denyCmds = [
    // a variable known when the line was first checked, unknown after `source`
    'F=run.sh; source env.sh; bash "$F"',
    'F=run.sh; source env.sh; source "$F"',
    'F=run.sh; . ./env.sh && node "$F"',
    // a directory that may have changed: the script that runs is not the starting directory's
    'true && cd /other; bash step.sh',
    'false || cd /other; ./step.sh',
    'cd /other || exit 1 & git push', // `|| exit` does not help a backgrounded cd
    // a ( subshell is still found in the text
    '(B=main); git push origin HEAD:$B',
  ];
  for (const c of denyCmds) assert.equal(evaluate(c, o).decision, 'deny', c);
  // the issue lives in the repository of a directory that may have changed: never looked up in the starting one
  const v = evaluate('true && cd /other; gh issue close 9', { ...o, labels: [] });
  assert.equal(v.decision, 'deny');
  assert.match(v.reason, /which directory/);
  assert.equal(v.calls.labels.length, 0);
  assert.equal(evaluate('true && cd /other; gh issue close 9 -R o/r', { ...o, labels: [] }).decision, 'allow');
  const allowCmds = [
    'PR=7; while ! gh pr checks "$PR"; do sleep 30; done',
    'B=agent/x; git commit -m "fix for loop"; git push origin "$B"',
    'git commit -m "fix (again)"; B=agent/x; git push origin HEAD:$B',
    'cd /other || exit 1; git push',
    'cd /other || return; git push',
    'cd /other; bash ok.sh',
    'source env.sh && npm test',
  ];
  for (const c of allowCmds) assert.equal(evaluate(c, o).decision, 'allow', c);
});

// Scan finding on ce847fb: the ( subshell check stripped quoted strings with a regex that did not read quotes the way a
// shell does, so an escaped quote or a $'…' string paired with a later quote and hid a real subshell. The parser now
// reports the subshell itself. The cd inside ( ) does not change the directory the script runs in.
test('a ( subshell hidden behind escaped quotes or a $\'…\' string is still found', () => {
  const files = {
    '/work/repo/step.sh': 'echo hi\n',
    '/other/step.sh': 'git push origin main\n',
  };
  const o = {
    byDir: { '/work/repo': 'agent/x', '/other': 'agent/y' },
    labelsByNum: {},
    readText: (p) => files[p] ?? null,
    pathExists: (p) => p in files,
    cwd: '/other',
  };
  const denyCmds = [
    'echo \\"; (cd /work/repo); bash step.sh; echo "x"',
    "echo \\'; (cd /work/repo); bash step.sh; echo 'x'",
    "echo $'it\\'s'; (cd /work/repo); bash step.sh; echo 'x'",
    'echo a\\"b; (cd /work/repo); bash step.sh; echo "c"',
    'echo \\" ;(cd /work/repo) ;bash step.sh ;echo "x"',
  ];
  for (const c of denyCmds) assert.equal(evaluate(c, o).decision, 'deny', c);
  const allowCmds = [
    'cd /work/repo && bash step.sh',
    'echo "a \\" (b)"; cd /work/repo && bash step.sh',
    "git commit -m $'fix (again)\\n'; cd /work/repo && bash step.sh",
    "echo $'it\\'s (fine)'; cd /work/repo && bash step.sh",
  ];
  for (const c of allowCmds) assert.equal(evaluate(c, o).decision, 'allow', c);
});

// ---- the literal / expanded mixes of a push obey the deadline and reuse lookups ------------------------------------------------

test('a push with many $ words: the mixes are bounded by the evaluation deadline (injected clock) and reuse each lookup', () => {
  const sevenA = ' --recurse-submodules=$A'.repeat(7);
  const base = { cwd: '/work/repo', home: '/home/u', pushDestination: () => null, issueLabels: () => [], readText: () => null, pathExists: () => false };
  // 400 ms per clock read: the 128 mixes cannot all be judged inside the 5 s deadline, so the line is denied as too slow
  let t = 1_000_000;
  const slow = evaluateGitCommand(`A=no; git push${sevenA} origin agent/x`, { ...base, currentBranch: () => 'agent/x', now: () => (t += 400) });
  assert.equal(slow.decision, 'deny');
  assert.match(slow.reason, /took too long/);
  // with time to spare the same line is judged, and the branch is looked up once however many mixes there are
  let calls = 0;
  let clock = 0;
  const fast = evaluateGitCommand(`A=no; git push${sevenA} origin`, { ...base, currentBranch: () => { calls++; clock += 100; return 'agent/x'; }, now: () => clock });
  assert.equal(fast.decision, 'allow');
  assert.equal(calls, 1, 'one lookup for all 128 mixes');
  // 100 ms per lookup, 256 mixes of a push that is denied only by its literal reading: still denied, and quickly
  calls = 0;
  clock = 0;
  const dflt = ['ma', 'in'].join('');
  const probe = evaluateGitCommand(`O=-o; A=no; git push${sevenA} origin '$O' HEAD:${dflt}`, { ...base, currentBranch: () => { calls++; clock += 100; return 'agent/x'; }, now: () => clock });
  assert.equal(probe.decision, 'deny');
  assert.ok(calls <= 2 && clock <= 1000, `${calls} lookups, ${clock} ms of injected time`);
});
