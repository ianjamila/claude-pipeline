// Follow-ups from PR #453 for the guards: #452 (the git guard reads the `cd X || { …; exit 1; }` group form), #457 (cp / install -T), #464 (rsync -R / --relative),
// #465 (rsync long value options by abbreviation), #460 (the unsplit reading of an option word that holds a blank).
// Home is /home/u and the cwd is /home/u/proj for the files guard; the filesystem is faked. Protected paths are built from parts so this file does not spell them either.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { evaluateBashForFiles } from '../pipeline/hooks/lib/files-policy.mjs';
import { evaluateGitCommand } from '../pipeline/hooks/lib/git-policy.mjs';

const HOME = '/home/u';
const BASE = { home: HOME, env: {}, platform: 'linux', cwd: `${HOME}/proj`, realpath: (p) => p, existsSync: () => false, readText: () => null };
const run = (command, extra = {}) => evaluateBashForFiles(command, { ...BASE, ...extra });
const decide = (decision, cases, extra = {}) => {
  for (const [name, line] of cases) {
    test(`${decision}: ${name}`, () => {
      const r = run(line, extra);
      assert.equal(r.decision, decision, `${JSON.stringify(line)} -> ${r.decision}: ${r.reason}`);
    });
  }
};

// ---- #452: the git guard's group form ----
// cwd /work/repo is on agent/x, /other on agent/y: a push is allowed where the directory is known, and denied ("cannot tell which directory") where the cd may not have taken effect.
const gitRun = (command) => evaluateGitCommand(command, {
  cwd: '/work/repo',
  home: HOME,
  currentBranch: (dir) => ({ [resolve('/work/repo')]: 'agent/x', [resolve('/other')]: 'agent/y' })[dir] ?? null,
  pushDestination: () => null,
  issueLabels: () => [],
  readText: () => null,
  pathExists: () => false,
});
describe('#452: the git guard reads `cd X || { …; exit 1; }` like the files guard (a plain exit as the last command, no redirection on the closer)', () => {
  const NOT = (name, line) => test(`not narrowed: ${name}`, () => {
    const v = gitRun(line);
    assert.equal(v.decision, 'deny', line);
    assert.match(v.reason, /cannot tell which directory/);
  });
  const NARROWED = (name, line) => test(`narrowed: ${name}`, () => assert.equal(gitRun(line).decision, 'allow', line));
  NARROWED('the everyday group', 'cd /other || { echo "no dir" >&2; exit 1; }; git push');
  NARROWED('two commands before the exit', 'cd /other || { echo a; echo b >&2; exit 2; }; git push');
  NARROWED('the group, then && push', 'cd /other || { echo no; exit 1; } && git push');
  NARROWED('the group, then push on the next line', 'cd /other || { echo no; exit 1; }\ngit push');
  NARROWED('a command substitution before the group does not shift the reading', 'X=$(echo a); cd /other || { echo no; exit 1; }; git push');
  NOT('a redirection on the closer', 'cd /other || { echo no; exit 1; } 2>/dev/null; git push');
  NOT('a redirection on the closer (an input that may fail)', 'cd /other || { echo no; exit 1; } < /missing; git push');
  NOT('the last command is not an exit', 'cd /other || { echo no; true; }; git push');
  NOT('the last command is a return', 'cd /other || { echo no; return 1; }; git push');
  NOT('a redirection on the exit inside the group', 'cd /other || { echo no; exit 1 < /missing; }; git push');
  NOT('an exit with extra words', 'cd /other || { echo no; exit 1 2; }; git push');
  NOT('a command of the group joined by && (the exit may not run)', 'cd /other || { echo no && exit 1; }; git push');
  NOT('the group is entered by | not ||', 'cd /other | { echo no; exit 1; }; git push');
  NOT('the group is a background job', 'cd /other || { echo no; exit 1; } &\ngit push');
  NOT('the push is joined by ||', 'cd /other || { echo no; exit 1; } || git push');
});

// ---- #457: cp / install with -T (--no-target-directory) copy a folder's CONTENTS onto the destination ----
describe('#457: cp -T / -rT / --no-target-directory into home or a parent of a protected path is a contents merge', () => {
  decide('deny', [
    ['cp -rT /tmp/x ~', 'cp -rT /tmp/x ~'],
    ['cp -T /tmp/x ~/', 'cp -T /tmp/x ~/'],
    ['cp -aT /tmp/x $HOME', 'cp -aT /tmp/x $HOME'],
    ['cp -Tr /tmp/x /home/u', 'cp -Tr /tmp/x /home/u'],
    ['cp -r -T /tmp/x ~', 'cp -r -T /tmp/x ~'],
    ['cp --no-target-directory -r /tmp/x ~', 'cp --no-target-directory -r /tmp/x ~'],
    ['cp -rT after a cd out of home', 'cd /tmp && cp -rT stage ~'],
    ['install -T /tmp/x ~', 'install -T /tmp/x ~'],
    ['sudo cp -rT /tmp/x ~', 'sudo cp -rT /tmp/x ~'],
  ]);
  decide('allow', [
    ['cp -T a b in a project dir', 'cp -T a b'],
    ['cp -rT /tmp/x ./build', 'cp -rT /tmp/x ./build'],
    ['cp -aT src dist', 'cp -aT src dist'],
    ['cp --no-target-directory a b', 'cp --no-target-directory a b'],
    ['cp -T into a folder of home that holds no protected path', 'cp -rT /tmp/x ~/projects/site'],
    ['cp -r /tmp/x ./build (no T)', 'cp -r /tmp/x ./build'],
    ['cp a ~/notes.txt (no T: a file)', 'cp a ~/notes.txt'],
    ['a T after -- is a file name', 'cp -r -- -T ./build'],
  ]);
});

// ---- #464: rsync -R / --relative lands the source's own path below the destination ----
const SF = ['.claude', ['settings', 'json'].join('.')].join('/'); // (the staged file, spelled from parts)
describe('#464: rsync -R / --relative into home is a contents merge (the source path is recreated below the destination)', () => {
  decide('deny', [
    ['a staged path after /./', `rsync -aR /tmp/stage/./${SF} ~/`],
    ['after a cd into the stage', `cd /tmp/stage && rsync -aR ${SF} ~/`],
    ['a glob of the dot folder', 'cd /backup && rsync -aR .claude/* ~/'],
    ['--relative', `cd /tmp/stage && rsync -a --relative ${SF} ~/`],
    ['--rel (an abbreviation of 3+ letters)', `cd /tmp/stage && rsync -a --rel ${SF} ~/`],
    ['-R as its own word', `cd /tmp/stage && rsync -a -R ${SF} ~/`],
    ['-R after the operands', `cd /tmp/stage && rsync -a ${SF} ~/ -R`],
    ['--no-relative before --relative', `cd /tmp/stage && rsync -a --no-relative --relative ${SF} ~/`],
    ['-R beside an unrelated --no- option', `cd /tmp/stage && rsync -aR --no-perms ${SF} ~/`],
    ['-R beside -e (a value letter after R)', `cd /tmp/stage && rsync -aR -e ssh ${SF} ~/`],
    ['-Re (R before the value letter)', `cd /tmp/stage && rsync -Re ssh ${SF} ~/`],
    ['a literal home path', `cd /tmp/stage && rsync -aR ${SF} /home/u`],
  ]);
  decide('allow', [
    ['-aR src/ ./out/ in a project', 'rsync -aR src/ ./out/'],
    ['-R into a project folder', `cd /tmp/stage && rsync -aR ${SF} ./out`],
    ['--relative into a project folder', 'rsync -a --relative src/a.js ./out/'],
    ['--no-relative clears an earlier --relative', `cd /tmp/stage && rsync -a --relative --no-relative ${SF} ~/projects/x`],
    ['--no-R clears an earlier -R', `cd /tmp/stage && rsync -aR --no-R ${SF} ~/projects/x`],
    ['-R into a folder of home that holds no protected path', 'cd /tmp/stage && rsync -aR src/a.js ~/projects/x'],
    ['an -R inside a value is no option', 'rsync -a --exclude=-R src/ ./out/'],
    ['-e R is a value (the remote shell)', 'rsync -a -e R src/ ./out/'],
    ['-eR is a value too', 'rsync -a -eR src/ ./out/'],
  ]);
});

// ---- #465: rsync takes any unambiguous abbreviation of a long option, a value option included ----
describe('#465: an abbreviated long value option takes its value (the value is no operand and no dry-run flag)', () => {
  decide('deny', [
    ['--exclud x after the operands', 'rsync -a --files-from=/tmp/l /tmp/stage ~/ --exclud x'],
    ['--timeo 30 after the operands', 'rsync -a /tmp/stage/ ~/ --timeo 30'],
    ['--exclud -n: the pattern -n is no dry run', 'rsync -a --exclud -n /tmp/stage/ ~/'],
    ['--bwl 100 after the operands', 'rsync -a /tmp/stage/ ~/ --bwl 100'],
    ['--exclude-f F after the operands', 'rsync -a /tmp/stage/ ~/ --exclude-f F'],
    ['an unknown option then a value-looking word after the operands (it may be an operand)', 'rsync -a /tmp/stage/ ~/ --zzzz x'],
    ['an unknown option then -n (it may be its value: no dry run)', 'rsync -a --zzzz -n /tmp/stage/ ~/'],
    ['an ambiguous abbreviation of a value option and a flag, then -n', 'rsync -a --ex -n /tmp/stage/ ~/'],
    ['an ambiguous abbreviation, then a word after the operands', 'rsync -a /tmp/stage/ ~/ --ex x'],
    ['two abbreviated values after the operands', 'rsync -a /tmp/stage/ ~/ --timeo 30 --bwl 5'],
  ]);
  decide('allow', [
    ['the everyday --exclude with its value', 'rsync -av --exclude node_modules src/ dest/'],
    ['an abbreviated value option before the operands, into a project', 'rsync -a --exclud node_modules src/ ./out/'],
    ['--timeo 30 into a project', 'rsync -a /tmp/stage/ ./out/ --timeo 30'],
    ['a real -n after a known flag option is still a dry run', 'rsync -a --progress -n /tmp/stage/ ~/'],
    ['a real -n after a known flag option (--delete) is still a dry run', 'rsync -a --delete -n /tmp/stage/ ~/'],
    ['-n after an exact value option is its value, but a separate -n is still read', 'rsync -a -n --exclude x /tmp/stage/ ~/'],
    ['an unknown option, a project destination', 'rsync -a --zzzz x src/ ./out/'],
  ]);
});

// ---- #460: the unsplit (zsh) reading of an option word that holds a blank ----
// zsh passes `-a -n` as ONE word; rsync reads it as a cluster, meets the blank (no option letter) and refuses with a usage error, so nothing is written. bash splits it and -n is a real dry run: both write nothing.
describe('#460: a single-dash word that reaches a blank before a value letter is a usage error (nothing is written), in either reading', () => {
  decide('allow', [
    ['-a -n', "OPTS='-a -n'; rsync $OPTS /tmp/x/ ~/"],
    ['-avz --exclude=.git -n', "OPTS='-avz --exclude=.git -n'; rsync $OPTS /tmp/x/ ~/"],
    ['-a --delete -n', "OPTS='-a --delete -n'; rsync $OPTS /tmp/x/ ~/"],
    ['-a -n, quoted (one word in both shells)', "OPTS='-a -n'; rsync \"$OPTS\" /tmp/x/ ~/"],
    ['a tab between the letters', "OPTS=$'-a\\t-n'; rsync $OPTS /tmp/x/ ~/"],
    ['-av --dry-run (still allowed)', "OPTS='-av --dry-run'; rsync $OPTS /tmp/x/ ~/"],
  ]);
  decide('deny', [
    ['-a --delete: bash passes a real --delete, so it writes', "OPTS='-a --delete'; rsync $OPTS /tmp/x/ ~/"],
    ['-a --exclude=x (bash: a real run)', "OPTS='-a --exclude=x'; rsync $OPTS /tmp/x/ ~/"],
    ['-ae ssh -n: -e takes the rest as its value, the -n is not a flag in the unsplit reading', "OPTS='-ae ssh -n'; rsync $OPTS /tmp/x/ ~/"],
    ['--exclude=a -n (a double-dash word is a pattern, not a cluster)', "OPTS='--exclude=a -n'; rsync -a $OPTS /tmp/x/ ~/"],
    ['a no-break space is no blank (existing pin)', "OPTS='-a -n'; rsync $OPTS /tmp/x/ ~/"],
    ['-a -n with a substitution is only known at run time', "OPTS=\"-a -n $(echo x)\"; rsync $OPTS /tmp/x/ ~/"],
  ]);
});

// ---- PR #478 round 1 ----
// R1-B1: the commands INSIDE the failure group of `cd X || { …; exit 1; }` run only when the cd (or a `git checkout` / `switch`) FAILED, so they run in the old directory / on the old branch, not the new one.
describe('#478 R1-B1: a command inside the failure group is not judged in the directory or on the branch the cd / checkout would have moved to', () => {
  const DENY = (name, line) => test(`deny: ${name}`, () => {
    const v = gitRun(line);
    assert.equal(v.decision, 'deny', line);
  });
  const ALLOW = (name, line) => test(`allow: ${name}`, () => assert.equal(gitRun(line).decision, 'allow', line));
  DENY('a push in the group after a cd whose input file is missing', 'cd /other < /missing || { git push; exit 1; }; true');
  DENY('a push in the group after an ordinary cd', 'cd /other || { git push; exit 1; }; true');
  DENY('a push in the group, then the push after it', 'cd /other || { git push; exit 1; }; git push');
  DENY('a push in the group after a git checkout that may fail', 'git checkout agent/y || { git push; exit 1; }; true');
  DENY('a git switch with a push in the group', 'git switch agent/y || { git push; exit 1; }; git status');
  DENY('a push after echo, inside the group', 'cd /other || { echo no >&2; git push; exit 1; }; true');
  // the state after the group is still the moved one
  ALLOW('the push after the group is judged in /other', 'cd /other || { echo no; exit 1; }; git push');
  ALLOW('a git checkout group, then a push on the new branch', 'git checkout agent/y || { echo no; exit 1; }; git push');
  ALLOW('a command substitution in the group keeps the later push in /other', 'cd /other || { echo $(date); exit 1; }; git push');
});

// R1-B2 / R1-F2: no dry-run exemption for --delete when rsyncFlags cannot tell the words (a custom IFS, a run-time word in front of the -n).
// R1-F1: nor when the dry-run flag comes from an assignment that may not run.
describe('#478 R1-B2 / R1-F1 / R1-F2: the --delete dry-run exemption trusts only a dry-run flag that is surely there', () => {
  decide('deny', [
    ['a custom IFS makes $OPTS split on the n (R1-B2)', "bash -c 'IFS=n; OPTS=-an; rsync --delete $OPTS /tmp/x/ ~/'"],
    ['a run-time word before the -n (R1-F2)', 'rsync $X -n --delete /tmp/x/ ~/'],
    ['a run-time word before --dry-run (R1-F2)', 'rsync $X --dry-run --delete /tmp/x/ ~/'],
    ['the flag is set in an if (R1-F1)', 'if [ "$DRY" = 1 ]; then N=-n; fi; rsync -a --delete $N /tmp/x/ ~/'],
    ['the flag is set after a && (R1-F1)', '[ -n "$DRY" ] && N=-n; rsync -a --delete $N /tmp/x/ ~/'],
    ['the flag is set after a || (R1-F1)', 'true || N=-n; rsync -a --delete $N /tmp/x/ ~/'],
    ['the flag is set in a && group (R1-F1)', '[ -n "$DRY" ] && { A=1; N=-n; }; rsync -a --delete $N /tmp/x/ ~/'],
    ['the flag is set in a subshell (R1-F1)', '(N=-n); rsync -a --delete $N /tmp/x/ ~/'],
    ['the flag is set in a pipe stage (R1-F1)', 'N=-n | cat; rsync -a --delete $N /tmp/x/ ~/'],
    ['the flag is set in a background job (R1-F1)', 'N=-n &\nrsync -a --delete $N /tmp/x/ ~/'],
    ['the flag is set in a loop (R1-F1)', 'for i in 1 2; do N=-n; done; rsync -a --delete $N /tmp/x/ ~/'],
    ['the flag is assigned twice (R1-F1)', 'N=-n; N=; rsync -a --delete $N /tmp/x/ ~/'],
    ['the flag is given only as the rsync command\'s own prefix (the shell expands $N before the prefix applies)', 'N=-n rsync -a --delete $N /tmp/x/ ~/'],
  ]);
  decide('allow', [
    ['a literal -n', 'rsync -a --delete -n /tmp/x/ ~/'],
    ['a plain assignment, once, before the line', "OPTS='-a --delete -n'; rsync $OPTS /tmp/x/ ~/"],
    ['a plain assignment on its own line', "N=-n\nrsync -a --delete $N /tmp/x/ ~/"],
    ['an exported assignment', 'export N=-n; rsync -a --delete $N /tmp/x/ ~/'],
    ['a plain assignment after a && chain that ended', 'true && true; N=-n; rsync -a --delete $N /tmp/x/ ~/'],
  ]);
});

// ---- PR #478 round 2 ----
// R2-F1 / R2-B1: the restore after a failure group puts back the state the cd / checkout left, but not when the cd / checkout itself may not have run, and it drops every branch entry the group created.
describe('#478 R2-F1 / R2-B1: the state after a failure group is forgotten when the cd / checkout was itself uncertain, and the group leaves no branch entry behind', () => {
  const gitRun2 = (command) => evaluateGitCommand(command, {
    cwd: '/work/repo',
    home: HOME,
    currentBranch: (dir) => ({ [resolve('/work/repo')]: 'agent/x', [resolve('/other')]: 'agent/y', [resolve('/protected')]: 'main' })[dir] ?? null,
    pushDestination: () => null,
    issueLabels: () => [],
    readText: () => null,
    pathExists: () => false,
  });
  const DENY = (name, line) => test(`deny: ${name}`, () => assert.equal(gitRun2(line).decision, 'deny', line));
  const ALLOW = (name, line) => test(`allow: ${name}`, () => assert.equal(gitRun2(line).decision, 'allow', line));
  DENY('a checkout after a || that may skip it (R2-F1 1)', 'true || git checkout agent/y || { echo no; exit 1; }; git push');
  DENY('a second cd after a || (R2-F1 2)', 'cd /other || cd /work/repo || { echo no; exit 1; }; git push');
  DENY('a cd in an if (R2-F1 3)', 'if [ -d /other ]; then cd /other || exit 1; echo in; fi; git push');
  DENY('a branch entry first made in the group (R2-B1)', 'cd /other || { echo no; git -C /protected checkout agent/y; exit 1; }; git -C /protected push');
  ALLOW('the plain group form is still narrowed', 'cd /other || { echo no; exit 1; }; git push');
  ALLOW('the checkout group is still narrowed', 'git checkout agent/y || { echo no; exit 1; }; git push');
});

// R2-B2 / R2-B3 / R2-F2: the --delete dry-run exemption fails closed: a name with a value that no recognised site gave, or a value that holds a name that is not itself sure, is no sure dry-run flag.
describe('#478 R2-B2 / R2-B3 / R2-F2: the dry-run exemption is refused for a value the line gives in a way it does not read', () => {
  const SYNC = `${HOME}/proj/sync.sh`;
  const withScript = { existsSync: (p) => p === SYNC, readText: (p) => (p === SYNC ? 'rsync -a --delete $N /tmp/x/ ~/\n' : null) };
  decide('deny', [
    ['a conditional local (R2-B3)', '[ -n "$DRY" ] && local N=-n; rsync -a --delete $N /tmp/x/ ~/'],
    ['a local inside a function body is no sure site (R2-B3)', 'f() { local N=-n; rsync -a --delete $N /tmp/x/ ~/; }; f'],
    ['a plain local outside a function (R2-B3)', 'local N=-n; rsync -a --delete $N /tmp/x/ ~/'],
    ['integer (R2-B3)', '[ -n "$DRY" ] && integer N=-n; rsync -a --delete $N /tmp/x/ ~/'],
    ['float (R2-B3)', '[ -n "$DRY" ] && float N=-n; rsync -a --delete $N /tmp/x/ ~/'],
    ['a flag the dependency of a sure assignment may not set (R2-B2)', '[ -n "$DRY" ] && N=-n; OPTS="-a --delete $N"; rsync $OPTS /tmp/x/ ~/'],
    ['a flag the dependency of a skipped assignment (R2-B2)', 'false && N=-n; OPTS=$N; rsync -a --delete $OPTS /tmp/x/ ~/'],
  ]);
  decide('allow', [
    ['a plain assignment, once, before the line (existing #460)', "OPTS='-a --delete -n'; rsync $OPTS /tmp/x/ ~/"],
    ['a literal -n (existing)', 'rsync -a --delete -n /tmp/x/ ~/'],
    ['a sure dependency of a sure assignment', 'N=-n; OPTS="-a --delete $N"; rsync $OPTS /tmp/x/ ~/'],
  ]);
  decide('deny', [
    ['a flag an outer line may have set, in the script it reaches (R2-F2)', '[ -n "$DRY" ] && export N=-n; bash sync.sh'],
  ], withScript);
});
