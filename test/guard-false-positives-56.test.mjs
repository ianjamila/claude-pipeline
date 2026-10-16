// Why (issue #56): the Bash guards' false alarms went from ~20 to 180-330 a day. Each test below is one repro from the issue (or a group the 21-day replay
// found), allowed now, next to its malicious twin that must stay refused:
//   1. A variable assigned once where the assignment may not run (`cd /wt && F=src/a.ts; sed -n 1,9p $F`) is judged both ways ("readings": it ran, or not).
//   2. A loop variable takes every word of its literal list (one reading per word). It used to be read as a value from the environment: a live bypass
//      (`for f in run.sh; do bash $f; done`), closed in both guards.
//   3. A value built from another variable is worked out when it is assigned (`S=run; F=$S.sh; bash $F`): also a live bypass, closed.
//   4. A heredoc body is data: a JavaScript `function rep(a, b)` in `cat > fix.mjs <<'EOF'` is no shell function definition (it made the directory unknown).
//   5. `bash -n f.sh` only checks the syntax: f.sh is not run.
//   6. Writes by programs whose words may name a script (`node s1.mjs --a=$X1`) add no text to it: forty of them were "built from pieces" (a regression of A2).
// The file system is faked; guarded text only lives in fake file contents.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname, basename } from 'node:path';
import { evaluateGitCommand, withoutLiteralText } from '../pipeline/hooks/lib/git-policy.mjs';
import { evaluateBashForFiles } from '../pipeline/hooks/lib/files-policy.mjs';

function fakeFs(root, files, dirs = []) {
  const abs = (p) => resolve(root, p);
  const F = Object.fromEntries(Object.entries(files).map(([k, v]) => [abs(k), v]));
  const D = new Set([root, ...dirs.map(abs)].map((p) => resolve(p)));
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

const GIT_ROOT = resolve('/work/repo');
const PROJ = '/home/u/proj';
const BAD_GIT = 'git push origin main';
const BAD_FILES = 'echo x > ~/.claude/settings.json';
// interpreter programs: the git guard scans their text for a guarded command, the files guard for a protected file
const BAD_JS_GIT = "require('child_process').execSync('git push origin main')\n";
const BAD_JS_FILES = "require('fs').writeFileSync('/home/u/.claude/settings.json', 'x')\n";
const git = (command, fsOpts, o = {}) => evaluateGitCommand(command, {
  cwd: GIT_ROOT, home: '/home/u', currentBranch: () => 'agent/x', pushDestination: () => null, issueLabels: () => [], ...fsOpts, ...o,
});
const files = (command, fsOpts, o = {}) => evaluateBashForFiles(command, {
  home: '/home/u', env: {}, platform: 'linux', realpath: (p) => p, cwd: PROJ, ...fsOpts, existsSync: fsOpts.pathExists, ...o,
});
// spec: { name: 'bad' | 'ok' | 'badjs' | <text> }, the same names in both fake trees (relative to each guard's cwd)
const DIRS = ['sub', 'src', 'd'];
function both(command, spec = {}) {
  const mk = (bad, ok, badjs) => Object.fromEntries(Object.entries(spec).map(([k, v]) => [k, v === 'bad' ? bad : v === 'ok' ? ok : v === 'badjs' ? badjs : v]));
  return {
    git: git(command, fakeFs(GIT_ROOT, mk(BAD_GIT, 'git status', BAD_JS_GIT), DIRS)),
    files: files(command, fakeFs(PROJ, mk(BAD_FILES, 'echo hi', BAD_JS_FILES), DIRS)),
  };
}
const allowBoth = (command, spec) => {
  const r = both(command, spec);
  assert.equal(r.git.decision, 'allow', `git: ${command} -> ${r.git.reason}`);
  assert.equal(r.files.decision, 'allow', `files: ${command} -> ${r.files.reason}`);
};
const denyBoth = (command, spec) => {
  const r = both(command, spec);
  assert.equal(r.git.decision, 'deny', `git: ${command} -> allowed`);
  assert.equal(r.files.decision, 'deny', `files: ${command} -> allowed`);
  return r;
};
const denyGit = (command, spec) => {
  const r = both(command, spec);
  assert.equal(r.git.decision, 'deny', `git: ${command} -> allowed`);
  return r.git;
};
const allowGit = (command, spec) => {
  const r = both(command, spec);
  assert.equal(r.git.decision, 'allow', `git: ${command} -> ${r.git.reason}`);
};
const SPEC = { 'run.sh': 'bad', 'ok.sh': 'ok', 'a.mjs': 'console.log(1)\n', '/tmp/a.mjs': 'console.log(1)\n', '/opt/x/run.sh': 'bad', 'bad.mjs': 'badjs', 'src/a.ts': 'export const a = 1\n' };

// ---- 1. a variable assigned once, where it may not run ------------------------------------------------------------------------

test('#56 repro 5/6 and the chained shapes: one assignment that may not run is judged both ways and allowed when both are clean', () => {
  for (const cmd of [
    'cd $W && S=abc; node /tmp/a.mjs $S', // (repro 5)
    'for f in a b; do F=/tmp/$f; node a.mjs $F; done', // (repro 6)
    'cd sub && F=src/a.ts; sed -n 1,9p $F',
    'true && P=src/a.ts && node -e "console.log(1)" $P',
    'if true; then S=src; fi; node a.mjs $S/a.ts',
    'cd d && SK=src; bash $SK/../ok.sh',
    'true || X=a; bash $X',
    'cd src && T=a.ts; cp $T /tmp/a.bak && sed -i.bak s/a/b/ $T',
  ]) allowBoth(cmd, SPEC);
});

test('#56: the same shapes with a value that names a bad script stay refused (the reading where the assignment ran)', () => {
  for (const cmd of [
    'cd $W && S=bad.mjs; node $S',
    'true && X=run.sh; bash $X',
    'true || X=run.sh; bash $X',
    'if true; then S=run; fi; bash $S.sh',
    'cd sub && SK=..; bash $SK/run.sh',
    'while true; do X=run.sh; done; bash $X',
  ]) denyBoth(cmd, SPEC);
  // git / gh read the value too: the reading where it did not run leaves an unknown push argument
  for (const cmd of [
    'true || B=agent/x; git push origin HEAD:$B',
    'cd /work/repo && B=main && git push origin HEAD:$B',
    'true && B=main; git push origin HEAD:$B',
  ]) denyGit(cmd, SPEC);
});

test('#56: a name the readings cannot follow keeps the denial', () => {
  // (the bad script lives outside the directory, so no listing of it can find it: only the value the shell really gives F does)
  for (const cmd of [
    'true && F=/opt/x/ok.sh; read F < /tmp/x; bash $F', // (read binds it too)
    'true && F=ok.sh; : ${F:=/opt/x/run.sh}; bash $F', // (a default assigns it)
    'echo "${F:=/opt/x/run.sh}"; true && F=ok.sh; bash $F', // (…also inside double quotes)
    'true && F=ok.sh; eval "F=/opt/x/run.sh"; bash $F', // (eval)
    'bash $F; true && F=ok.sh', // (a use before the assignment sees the old value)
    '(F=ok.sh); bash $F', // (assigned in a subshell: the use outside does not see it)
    'echo $(F=ok.sh); bash $F',
    'F=ok.sh | cat; bash $F',
    'true && F=ok.sh; F=/opt/x/run.sh; bash $F', // (two assignments)
    'true && F=ok.sh; F[0]=/opt/x/run.sh; bash $F', // (an array element)
    'G=/opt/x/run.sh; true && F=ok.sh; declare -n F=G; bash $F', // (a nameref)
    'true && F=ok.sh; f() { F=/opt/x/run.sh; }; f; bash $F', // (a function body)
    'true && F=$F/ok.sh; bash $F', // (the value reads the name itself)
    'cat <<EOF\n${F:=/opt/x/run.sh}\nEOF\ntrue && F=ok.sh; bash $F', // (an unquoted heredoc body expands when its command runs)
    'true && F=ok.sh; source ./env.sh; bash $F', // (a sourced file may set it)
  ]) {
    const r = denyGit(cmd, SPEC);
    assert.ok(r.reason.length > 10, cmd);
  }
  // the denial names the one-line rewrite
  const r = denyGit('true && F=ok.sh; F=run.sh; bash $F', SPEC);
  assert.match(r.reason, /\$F is assigned more than once/);
  assert.match(r.reason, /Rewrite: assign it once, as the first command of the line \(`F=value; …`\)/);
});

// ---- 2. loop variables (a live bypass) --------------------------------------------------------------------------------------

test('#56 bypass: a loop variable is each word of its list, in the git and the files guard', () => {
  for (const cmd of [
    'for f in run.sh; do bash $f; done',
    'for f in ok run; do bash $f.sh; done',
    'for f in ok.sh run.sh; do bash $f; done',
    'for i in 1 run.sh; do X=$i; done; bash $X',
    'for f in bad.mjs; do node $f; done',
  ]) denyBoth(cmd, SPEC);
  // a protected file reached through a loop word (the words alone name nothing protected)
  const r = files('for f in settings.json; do cp /tmp/a /home/u/.claude/$f; done', fakeFs(PROJ, {}, DIRS));
  assert.equal(r.decision, 'deny', r.reason);
  assert.equal(files('for f in pipeline; do rm -rf /home/u/.claude/$f; done', fakeFs(PROJ, {}, DIRS)).decision, 'deny');
  // a word list only known at run time: a guarded command it picks is refused. (`for f in $(ls); do bash $f; done` is judged like `F=$(ls); bash $F`:
  // a script named only at run time is refused when the line mentions a guarded operation; see the replay test below and the PR's known limits)
  for (const cmd of ['for n in 5 $M; do gh issue close $n; done']) denyGit(cmd, SPEC);
  // and the loops people write every day still pass
  for (const cmd of [
    'for f in src/a.ts a.mjs; do sed -n 1,5p $f; done',
    'for f in a b c; do echo == $f; node a.mjs $f; done',
    'for f in ok.sh; do bash $f; done',
    'for f in src/a.ts; do cp $f /tmp/x.bak && sed -i.bak s/a/b/ $f; done',
    'for f in *.mjs; do node --check $f; done',
  ]) allowBoth(cmd, SPEC);
  // each issue a loop names is looked up, like a literal list
  const labels = (n) => (n === '7' ? ['pipeline-pause'] : []);
  const fsx = fakeFs(GIT_ROOT, {}, DIRS);
  assert.equal(git('for n in 5; do gh issue close $n; done', fsx, { issueLabels: labels }).decision, 'allow');
  assert.equal(git('for n in 5 7; do gh issue close $n; done', fsx, { issueLabels: labels }).decision, 'deny');
});

test('#56 replay: a loop over one command substitution holds one value only known at run time, judged where it lands like F=$(cmd)', () => {
  // ~660 lines in 21 days: the loop variable only reached commands that print, signal or read
  for (const cmd of [
    'for p in $(lsof -t -i :4000); do ps -o pid= -p $p; done',
    'for p in $(cat /tmp/x.pids); do kill $p; done',
    "for n in $(gh pr list --json number --jq '.[].number'); do gh pr view $n --json labels; done",
    "for b in $(git branch --format='%(refname:short)'); do git log --oneline -3 $b; done",
    'for f in $(grep -l x /tmp/*.md); do cp "$f" /tmp/b/; done',
    'for f in `ls /tmp`; do wc -l $f; done',
  ]) allowBoth(cmd, SPEC);
  // malicious twins: where the value picks a ref, an issue, a directory, a command or a repository it is still refused
  const labels = () => ['pipeline-pause'];
  const fsx = fakeFs(GIT_ROOT, {}, DIRS);
  for (const cmd of [
    "for b in $(git branch --format='%(refname:short)'); do git push origin $b; done",
    'for r in $(echo HEAD:main); do git push origin $r; done',
    'for d in $(ls -d /work/*/); do git -C $d push; done',
    'for d in $(ls -d /work/*/); do cd $d && git push; done',
    'for d in $(echo /work/repo); do cd $d; bash run.sh; done',
    'for g in $(echo git); do $g push origin main; done',
    "for n in $(gh pr list --json number --jq '.[].number'); do gh pr merge $n --admin; done",
    'for d in $(echo /x/.git); do export GIT_DIR=$d; done; git push origin agent/x',
    'for f in $(ls *.sh); do bash $f; done',
    'for f in $(ls *.sh); do source $f; done',
  ]) assert.equal(git(cmd, fakeFs(GIT_ROOT, { 'run.sh': BAD_GIT }, DIRS)).decision, 'deny', cmd);
  assert.equal(git("for n in $(gh issue list --json number --jq '.[].number'); do gh issue close $n; done", fsx, { issueLabels: labels }).decision, 'deny');
  // the files guard: a protected place reached through the value
  for (const cmd of [
    'for f in $(echo settings.json); do echo x > ~/.claude/$f; done',
    'for d in $(echo ~/.claude); do cp /tmp/x $d/settings.json; done',
  ]) assert.equal(files(cmd, fakeFs(PROJ, {}, DIRS)).decision, 'deny', cmd);
  // still refused: a variable as the list (its value is known and splits), several words, the positional parameters, a second loop over the name,
  // select, and a name also assigned elsewhere
  for (const cmd of [
    'L=run.sh; for f in $L; do bash $f; done',
    'L="ok.sh run.sh"; for f in ${L}; do bash $f; done',
    'for f in $(true) run.sh; do bash $f; done',
    'for f in run.sh $(true); do bash $f; done',
    'set -- run.sh; for f; do bash $f; done',
    'for f in $(ls x); do :; done; for f in $(ls *.sh); do bash $f; done',
    'for f in $(ls x); do :; done; f=run.sh; bash $f',
    'select f in $(ls *.sh); do bash $f; done',
  ]) assert.equal(git(cmd, fakeFs(GIT_ROOT, { 'run.sh': BAD_GIT, 'ok.sh': 'git status' }, DIRS)).decision, 'deny', cmd);
});

test('#56 replay: a literal loop reading survives an option or path word equal to the name, and an export whose value expands', () => {
  for (const cmd of [
    'for p in 58051 68251; do echo "== $p"; ps -o command= -p $p | tail -5; done',
    'for p in 1 2; do ps -p $p; done; git status',
    'export PATH="/opt/homebrew/bin:$PATH"; for n in 1422 1417; do gh pr view $n --repo a/b --json labels; done',
    'for f in src/a.ts; do sed -n 1,5p $f; done; cat /tmp/f',
    'for w in a b; do printf "%s %s\\n" $w "$(grep -c $w src/a.ts)"; done',
  ]) allowBoth(cmd, SPEC);
  // twins: a real second binding of the name, or a binder whose NAME is only known at run time, keeps the denial
  for (const cmd of [
    'for p in ok.sh; do read -p x p; bash $p; done',
    'for p in ok.sh; do getopts ab p; bash $p; done',
    'for f in ok.sh; do printf -v f run.sh; bash $f; done',
    'F=ok.sh; true && printf -v $N run.sh; bash $F',
    'export $X=run.sh; for f in ok.sh; do bash $f; done',
    'for p in ok.sh; do true && p=run.sh; bash $p; done',
    'for f in ok.sh; do (( f = 1 )); bash $f; done',
    'export PATH="/x:$PATH"; F=ok.sh; true && F=run.sh; bash $F',
  ]) denyGit(cmd, SPEC);
});

test('#56 bypass: a binder whose NAME is only known at run time may set any variable, in the git and the files guard', () => {
  // git: N may hold F, so F may be run.sh
  for (const cmd of [
    'F=ok.sh; export $N=run.sh; bash $F',
    'F=ok.sh; declare "$N=run.sh"; bash $F',
    'F=ok.sh; printf -v $N run.sh; bash $F',
    'F=ok.sh; read $N < list; bash $F',
    'F=ok.sh; typeset ${N}=run.sh; bash $F',
  ]) denyGit(cmd, SPEC);
  // files: N may hold F or HOME
  for (const cmd of [
    'F=/tmp/x; export $N=/home/u/.claude/settings.json; echo x > $F',
    'F=/tmp/x; printf -v $N /home/u/.claude/settings.json; cp /tmp/a $F',
    'declare "$N=/home/u/.claude"; cp /tmp/a $HOME/settings.json',
  ]) assert.equal(files(cmd, fakeFs(PROJ, {}, DIRS)).decision, 'deny', cmd);
  // controls: a literal name, a value that expands and printf without -v keep their meaning
  for (const cmd of [
    'F=ok.sh; export G=$F; bash $F',
    'export PATH="/x:$PATH"; F=ok.sh; bash $F',
    'F=ok.sh; printf "%s\\n" "$N"; bash $F',
    'F=ok.sh; read -r line < list; bash $F',
  ]) allowGit(cmd, SPEC);
});

test('#56 replay: quotes inside a $( … ) inside double quotes are followed (a loop reading survives them)', () => {
  for (const cmd of [
    `for n in 1 2; do echo "$n $(gh pr view $n --jq '[.labels[].name]|join(",")')"; done`,
    `for n in 1 2; do echo "$(gh pr checks $n 2>&1 | grep -i 'hard-stop')"; done`,
  ]) allowGit(cmd, SPEC);
  // twins: a reassignment next to, or behind, nested quotes is still seen
  for (const cmd of [
    `for f in ok.sh; do echo "$(echo "'")"; f=run.sh; bash $f; echo "'"; done`,
    `for f in ok.sh; do echo "'"; f=run.sh; bash $f; echo "'"; done`,
    `for f in ok.sh; do echo "'"; f[0]=run.sh; bash $f; echo "'"; done`,
    `for f in ok.sh; do echo "$(echo x) '"; f=run.sh; bash $f; echo "'"; done`,
    `for f in ok.sh; do echo "$(echo ')' )"; f=run.sh; bash $f; done`,
    `for f in ok.sh; do echo "$(case x in x) :;; esac)"; f=run.sh; bash $f; done`,
    `for f in ok.sh; do echo "\`echo 'x'\`"; f=run.sh; bash $f; done`,
  ]) denyGit(cmd, SPEC);
});

test('#56 replay: `npx tsx` reads a heredoc as data like node; `set -a` changes no directory', () => {
  for (const cmd of [
    "cat > s.mjs <<'EOF'\nconst ROOT = process.cwd()\nEOF\nnpx tsx s.mjs",
    "cat > s.mjs <<'EOF'\nconst ROOT = process.cwd()\nEOF\ntsx s.mjs && node a.mjs",
    'set -a; X=1; set +a; bash ok.sh',
    'grep -n "a\\|function base\\b" src/a.ts | head; for f in *.mjs; do node --check $f || echo BAD $f; done',
    'if grep -q "f()" src/a.ts; then node a.mjs; fi',
  ]) allowGit(cmd, SPEC);
  for (const cmd of [
    "cat > s.mjs <<'EOF'\nconst ROOT = process.cwd()\nEOF\nf() { cd /elsewhere; }; npx tsx s.mjs; bash run.sh",
    "cat > s.mjs <<'EOF'\nconst ROOT = process.cwd()\nEOF\nnpx tsx s.mjs; bash run.sh",
    'set -k; bash ok.sh',
    'f() { cd /elsewhere; }; for g in a; do f; done; bash ok.sh',
    'if true; then g() { cd /elsewhere; }; fi; g; bash ok.sh',
    'set -a; . ./env.sh; set +a; bash ok.sh',
  ]) denyGit(cmd, { ...SPEC, 'env.sh': 'cd /elsewhere' });
});

// ---- 3. values built from other variables (a live bypass) -------------------------------------------------------------------

test('#56 bypass: a value built from another variable is worked out when it is assigned', () => {
  for (const cmd of ['S=run; F=$S.sh; bash $F', 'S=run; F="$S.sh"; bash "$F"', 'D=.; S=run; F=${D}/${S}.sh; bash $F', 'A=run B=$A.sh; bash $B']) denyBoth(cmd, SPEC);
  for (const cmd of ['S=src; F=$S/a.ts; sed -n 1,5p $F', 'S=a; F=$S.mjs; node $F', 'S=ok; F=$S.sh; bash $F']) allowBoth(cmd, SPEC);
  // a quoted or escaped `$` stays as written: the value is then only known at run time, as before (refused where a guarded word is on the line)
  denyGit("S=run; F='$S.sh'; bash $F # push", SPEC);
});

// ---- 4. heredoc bodies are data ---------------------------------------------------------------------------------------------

test('#56: a function definition inside a heredoc body is data; one outside it still makes the directory unknown', () => {
  const opts = (o = {}) => ({
    cwd: '/work/repo', home: '/home/u', pushDestination: () => null, issueLabels: () => [],
    currentBranch: (dir) => ({ [resolve('/work/repo')]: 'main', [resolve('/safe')]: 'agent/x' })[resolve(dir)] ?? null,
    readText: () => null, pathExists: () => false, ...o,
  });
  const JS = "import fs from 'node:fs'\nfunction rep(a, b) { return a } // it's a helper\nconst x = () => 1\n";
  const ok = [
    `cat > .tmp-edit.mjs <<'EOF'\n${JS}EOF\nnode .tmp-edit.mjs && rm .tmp-edit.mjs`,
    `cd /work/repo && cat > fix.mjs <<'EOF'\n${JS}EOF\nnode fix.mjs`,
    `cat > a.sh <<EOF\nfunction x() { :; }\nEOF\nnode -e 'console.log(1)'`,
  ];
  for (const cmd of ok) assert.equal(evaluateGitCommand(cmd, opts()).decision, 'allow', cmd);
  // a bare `git push` here pushes main unless the cd really ran; a function body never runs unless called
  const bad = [
    `cat > x.mjs <<'EOF'\n${JS}EOF\nf(){ cd /safe; }; git push`,
    `cat > x.mjs <<'EOF'\nit's open\nEOF\nf(){ cd /safe; }; git push`, // (an apostrophe in the body must not hide the definition after it)
    `echo \`cat <<'E'\nit's\nE\n\`; f(){ cd /safe; }; echo 'x'; git push`, // (a heredoc read out of backticks is not located: the old answer, else its apostrophe and the next quote hide the definition)
    `eval "$(cat <<'EOF'\nf(){ cd /safe; }\nEOF\n)"; f; git push`,
    `bash <<'EOF'\nf(){ :; }\nEOF\nf(){ cd /safe; }; git push`,
  ];
  for (const cmd of bad) assert.equal(evaluateGitCommand(cmd, opts()).decision, 'deny', cmd);
});

// ---- 5. bash -n -------------------------------------------------------------------------------------------------------------

test('#56 repro 3: `bash -n f.sh` checks the syntax and runs nothing; every other spelling still runs it', () => {
  for (const cmd of ['bash -n run.sh', 'sh -n run.sh', 'zsh -n run.sh', 'bash -n -- run.sh', 'bash -nv run.sh', 'dash -n run.sh']) allowBoth(cmd, SPEC);
  for (const cmd of [
    'bash run.sh',
    'bash -n +n run.sh', // (+n turns it off again)
    'bash -n -i run.sh', // (bash ignores -n in an interactive shell)
    'bash -ni run.sh',
    'bash $O -n run.sh', // (a word that expands may be any option)
    'bash -n $F run.sh',
    'zsh -n -o exec run.sh', // (an -o name we do not read)
    'bash --noprofile -n run.sh', // (a long option: not read)
    'bash -nc "bash run.sh"', // (-c: the script text is judged as before)
  ]) denyBoth(cmd, SPEC);
});

test('#56 repro 4: a script that runs "$@" through a wrapper is still refused (documented: what it runs is only known at run time)', () => {
  const APPLY = 'run() { "$@"; }\nrun git push origin main\n';
  denyGit('bash apply.sh --dry', { 'apply.sh': APPLY });
  allowGit('bash -n apply.sh', { 'apply.sh': APPLY });
});

// ---- 6. many program writes ---------------------------------------------------------------------------------------------------

test('#56 repro 7: forty `echo … && node /tmp/sN.mjs --a=$XN` are not "built from pieces"; a script really built from pieces still is', () => {
  const parts = [];
  for (let n = 1; n <= 20; n++) parts.push(`echo step${n}`, `node /tmp/s${n}.mjs --a=$X${n}`);
  const line = parts.join(' && ');
  const spec = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`/tmp/s${i + 1}.mjs`, 'console.log(1)\n']));
  allowBoth(line, spec);
  // pieces of a guarded command / a protected path, put together after the same forty commands
  denyGit(`${line}; printf 'git pu' > n.sh; printf 'sh origin main' >> n.sh; bash n.sh`, spec);
  assert.equal(files(`${line}; printf 'echo x > ~/.cla' > n.sh; printf 'ude/settings.json' >> n.sh; bash n.sh`, fakeFs(PROJ, spec, DIRS)).decision, 'deny');
  // a script one of those programs may write is unknown content: refused where the line mentions a guarded operation
  denyGit(`${line} && bash /tmp/w.sh && echo then merge`, spec);
});

// ---- 1 (repro 1/2): directories and lone assignments ----------------------------------------------------------------------------

test('#56 repro 1/2: a literal cd chained with && and a lone assignment before { … } / ( … ) & are known', () => {
  allowBoth('cd /work/repo && node a.mjs > out.txt 2>&1', SPEC);
  allowBoth("S=/tmp/s; { cat <<'EOF'\nhello brief\nEOF\n} > $S/brief.md; wc -l $S/brief.md; ( node a.mjs > \"$S/x.log\" 2>&1 ) &", SPEC);
  denyBoth("S=/tmp/s; { cat <<'EOF'\nhello\nEOF\n} > $S/brief.md; ( bash run.sh > \"$S/x.log\" 2>&1 ) &", SPEC);
  denyBoth('cd /work/repo && node bad.mjs > out.txt 2>&1', SPEC);
});

test("#56 scanner: a case inside a $( … ) gives up (its pattern ) would end the $( … ) early), the shapes it follows still read", () => {
  // (null keeps the denial: the readings need the scanner, so a line it cannot follow is judged as before #56)
  for (const t of [
    `echo "$(case a in a) echo x;; esac)"`,
    `echo "$(echo y; case $n in 1) :;; esac)" z`,
    `X="$(case a in a) echo;; esac)"; echo $X`,
  ]) assert.equal(withoutLiteralText(t), null, t);
  // a word that only contains "case" is no keyword; top-level case is outside any $( … ) and never confuses the frames
  for (const t of [
    `echo "$(cat showcase.txt)"`,
    `echo "$(cases)"`,
    "case a in a) echo x;; esac",
    `echo "$(gh pr view 1 --jq .x)"`,
  ]) assert.notEqual(withoutLiteralText(t), null, t);
});

// ---- replay of the branch head against main (2026-10-16): loop shapes the readings refused that main allowed -----------------------------

test('#56 replay 2: loop words from a known variable, quoted [ ] words, code in double quotes and printf without -v keep their readings', () => {
  for (const cmd of [
    'B=src && for f in $B/a.ts ${B}/x.ts; do echo "== $f"; sed -n 1,16p $f; done',
    'for f in "src/[id]/a.ts" src/a.ts; do echo "=== $f"; git diff HEAD -- "$f" | head -60; done',
    `for f in src/a.ts a.mjs; do node -e "const fs=require('fs');const f='$f';let s=fs.readFileSync(f,'utf8');fs.writeFileSync(f,s)"; done`,
    "for p in vitest postcss; do printf '%-22s ' $p; npm view $p version 2>/dev/null | tail -1; done",
  ]) allowBoth(cmd, SPEC);
  // malicious twins: the word is worked out before it is judged, and what may rebind the name keeps the denial
  for (const cmd of [
    'S=run; for f in $S.sh; do bash $f; done', // (worked out to run.sh)
    'B=.; for f in ok.sh ${B}/run.sh; do bash $f; done',
    'for f in [r]un.sh; do bash $f; done', // (a glob class: judged as the files it matches)
    'for f in $UNSET/run.sh; do bash $f; done', // (a name not known on the line)
    'B=ok; true && B=run; for f in $B.sh; do bash $f; done', // (a name with two values)
    "B=ok; for f in '$B'.sh; do bash $f; done", // (single quotes: the argv no longer shows that $B is text)
    'IFS=.; B=run; for f in $B.sh; do bash $f; done', // (IFS on the line)
    'for p in ok.sh; do printf -v p %s run.sh; bash $p; done', // (printf -v binds)
    'for f in ok.sh; do declare -n R=f; R=run.sh; bash $f; done', // (a nameref to it)
    'for f in ok.sh; do echo "${f::=run.sh}"; bash $f; done', // (zsh ::= assigns, inside double quotes…)
    'for f in ok.sh; do : ${f::=run.sh}; bash $f; done', // (…and outside)
    'for f in ok.sh; do echo "${f:=x} $f"; f=run.sh; bash $f; done',
    // zsh reads a subscript or a modifier after the name, and `=cmd` as a command path (commit security review of 6b19a21)
    'B=run.sh.x; for f in $B:r; do bash $f; done',
    'B=run.shXY; for f in $B[1,6]; do bash $f; done',
    'B=run.shXY; for f in ${B}[1,6]; do bash $f; done',
    'for f in =run.sh; do bash $f; done',
    // (a longer name: the pattern must not read `$BB:r` as `$B` + text; Codex probe of ede8872)
    'BB=run.sh.x; for f in $BB:r; do bash $f; done',
    'BB=run.shXY; for f in $BB[1,6]; do bash $f; done',
    'B=ok; for f in $B.sh; do bash $f; B=run; done', // (the name the word reads is set twice)
  ]) denyGit(cmd, SPEC);
  // still refused (documented): two loops over the same name, and a loop over a variable holding command output
  for (const cmd of [
    'for f in src/a.ts; do sed -n 1,9p "$f"; done; for f in a.mjs; do sed -n 1,9p "$f"; done',
    'F1=$(grep -rl x src); for f in ${=F1}; do sed -i.bak s/a/b/ "$f"; done',
  ]) denyGit(cmd, SPEC);
});

test('#56 scanner dqData: inside double quotes only the shell\'s own text is kept', () => {
  assert.equal(withoutLiteralText(`"const f=1; g(f)" $f`, { dqData: true }), `"       = ;  ( )" $f`);
  assert.equal(withoutLiteralText(`"$f \${f:=x} \${g}"`, { dqData: true }), `"$f \${f:=x} \${g}"`);
  assert.equal(withoutLiteralText(`"$[f=1]"`, { dqData: true }), null); // (arithmetic can assign)
  // a ${…} the blanking does not follow ends it: the rest is kept as written
  assert.equal(withoutLiteralText(`"\${g:-$h} f=1"`, { dqData: true }), `"\${g:-$h} f=1"`);
  // without the option nothing changes
  assert.equal(withoutLiteralText(`"const f=1"`), `"const f=1"`);
});

test('#56 Codex review of 8b86e2b: a later loop, a loop that may not run and an indirect expansion do not hide the value a use sees', () => {
  // (files guard) the value a write sees is not the last one the line gives the name; a skipped loop leaves the old value
  for (const cmd of [
    'F=settings.json; printf x > ~/.claude/$F; for F in safe; do :; done',
    'F=settings.json; false && for F in safe; do :; done; printf x > ~/.claude/$F',
    'F=settings.json; (for F in safe; do :; done); printf x > ~/.claude/$F',
    'F=safe; : "${(P)N::=settings.json}"; printf x > ~/.claude/$F', // (zsh: assigns the name N holds; on main too)
    'F=safe; : "${(%)F::=settings.json}"; printf x > ~/.claude/$F', // (a name after the prompt flag: assigns it)
    'F=safe; : ${F::=settings.json}; printf x > ~/.claude/$F', // (zsh ::= assigns)
    'for F in safe; do : "${(P)N::=settings.json}"; printf x > ~/.claude/$F; done',
  ]) assert.equal(files(cmd, fakeFs(PROJ, {}, DIRS)).decision, 'deny', cmd);
  // (git guard)
  for (const cmd of [
    'N="b"; for b in agent/x; do : "${(P)N::=main}"; git push origin $b; done',
    'B=agent/x; : "${(P)N::=main}"; git push origin $B', // (on main too)
    'B=agent/x; : "${!N}"; git push origin $B',
    'B=agent/x; : "${(e)X}"; git push origin $B', // (zsh e flag: X may hold ${B::=main})
    'B=agent/x; : "${(Pe)X}"; git push origin $B',
    'B=agent/x; : "${(AA)X::=a b}"; git push origin $B', // (any flags: fail closed)
    'false && for b in agent/x; do :; done; git push origin $b', // (the loop is skipped: b keeps the value it had)
    'true || for b in agent/x; do :; done; git push origin $b',
    'if false; then for b in agent/x; do :; done; fi; git push origin $b',
    'for a in x; do for b in agent/x; do :; done; done; git push origin $b',
    'for b in agent/nomatch*; do :; done; git push origin $b', // (a glob may match nothing)
  ]) denyGit(cmd, SPEC);
  // still allowed: a loop that surely runs, and loops over files
  for (const cmd of [
    'for b in agent/x; do git push origin $b; done',
    'for b in agent/x agent/y; do git push origin $b; done; git status',
  ]) allowGit(cmd, SPEC);
  for (const cmd of ['for f in src/a.ts a.mjs; do cp $f /tmp/x/; done']) allowBoth(cmd, SPEC);
});

test('#56 Codex recheck of d925d42: a builtin that sets a name it is not given (read REPLY, getopts OPTARG, mapfile MAPFILE, zsh =~ MATCH) is no single binding site', () => {
  const labels = (n) => (n === '7' ? ['pipeline-pause'] : []);
  const fsx = fakeFs(GIT_ROOT, {}, DIRS);
  for (const cmd of [
    'for REPLY in 5; do read <<< 7; gh issue close $REPLY; done',
    'for REPLY in 5; do select x in a; do break; done <<< 7; gh issue close $REPLY; done',
    'for OPTARG in 5; do getopts n: o -n 7; gh issue close $OPTARG; done',
    'for OPTIND in 5; do getopts n: o -n 7; gh issue close $OPTIND; done',
    'for MAPFILE in 5; do mapfile <<< 7; gh issue close $MAPFILE; done',
    'for reply in 5; do read -A <<< 7; gh issue close $reply; done',
    'for MATCH in 5; do [[ 7 =~ 7 ]]; gh issue close $MATCH; done',
    'for match in 5; do [[ 7 =~ (7) ]]; gh issue close $match; done',
    'REPLY=5; read <<< 7; gh issue close $REPLY',
  ]) assert.equal(git(cmd, fsx, { issueLabels: labels }).decision, 'deny', cmd);
  // the same shapes in a push and a write: both guards
  for (const cmd of [
    'for REPLY in agent/x; do read <<< main; git push origin $REPLY; done',
    'for OPTARG in agent/x; do getopts b: o -b main; git push origin $OPTARG; done',
  ]) denyGit(cmd, SPEC);
  for (const cmd of [
    'for REPLY in safe; do read <<< settings.json; printf x > ~/.claude/$REPLY; done',
    'for MAPFILE in safe; do mapfile <<< settings.json; printf x > ~/.claude/$MAPFILE; done',
    'for OPTARG in safe; do getopts f: o -f settings.json; printf x > ~/.claude/$OPTARG; done',
    'for reply in safe; do read -A <<< settings.json; printf x > ~/.claude/$reply; done', // (zsh read -A sets reply; on main too)
    'reply=safe; read -A <<< settings.json; printf x > ~/.claude/$reply',
    'for MATCH in safe; do [[ settings.json =~ settings.json ]]; printf x > ~/.claude/$MATCH; done', // (zsh =~ sets MATCH / match)
    'MATCH=safe; [[ settings.json =~ settings.json ]]; printf x > ~/.claude/$MATCH',
    'match=safe; [[ settings.json =~ (settings.json) ]]; printf x > ~/.claude/$match',
    'setopt extendedglob; MATCH=safe; w=settings.json; : ${w//(#m)*/x}; printf x > ~/.claude/$MATCH', // (the (#m) glob flag)
    'F=safe; zparseopts -D -a F f; printf x > ~/.claude/$F', // (zsh binders: any name)
    'F=safe; vared F; printf x > ~/.claude/$F',
    'F=safe; strftime -s F %s 1; printf x > ~/.claude/$F',
    'F=safe; print -v F settings.json; printf x > ~/.claude/$F',
    'F=safe; integer F=1; printf x > ~/.claude/$F',
    'F=safe; zformat -f F settings.json; printf x > ~/.claude/$F',
    'REPLY=safe; ztcp localhost 1; printf x > ~/.claude/$REPLY', // (ztcp sets REPLY)
    'F=safe; zsystem flock -f F /tmp/l; printf x > ~/.claude/$F',
  ]) assert.equal(files(cmd, fakeFs(PROJ, {}, DIRS)).decision, 'deny', cmd);
  for (const cmd of [
    'B=agent/x; zparseopts -D -a B b; git push origin $B',
    'B=agent/x; zparseopts -D b:=B; git push origin $B', // (the spec names B after =)
    'B=agent/x; strftime -s B %s 1; git push origin $B',
    'B=agent/x; zformat -f B main; git push origin $B',
    'REPLY=agent/x; ztcp localhost 1; git push origin $REPLY',
    'B=agent/x; print -v B main; git push origin $B',
    'B=agent/x; vared B; git push origin $B',
    'MATCH=agent/x; [[ main =~ main ]]; git push origin $MATCH',
  ]) denyGit(cmd, SPEC);
  // still judged one by one: an ordinary name next to a read that names its own target
  assert.equal(git('for n in 5; do read -r x <<< 7; gh issue close $n; done', fsx, { issueLabels: labels }).decision, 'allow');
});

test('#56 Fable review of 2edea61: a zsh precommand modifier, an option carrying the name, an array element, a named fd, coproc and $_ rebind the name', () => {
  const labels = (n) => (n === '7' || n === '10' ? ['pipeline-pause'] : []);
  const fsx = fakeFs(GIT_ROOT, {}, DIRS);
  for (const cmd of [
    'k=5; noglob read k <<< 7; gh issue close $k',
    'k=5; nocorrect read k <<< 7; gh issue close $k',
    'k=5; printf -vk 7; gh issue close $k',
    'k=5; wait -p k; gh issue close $k',
    'k=5; wait -pk; gh issue close $k',
    'k=5; k[0]=7; gh issue close $k',
    'k=5; exec {k}>/dev/null; gh issue close $k',
    'k=5; coproc k { cat; }; gh issue close $k',
    '_=5; echo 7; gh issue close $_',
    'for k in 5; do noglob read k <<< 7; gh issue close $k; done',
    'for k in 5; do k[0]=7; gh issue close $k; done',
  ]) assert.equal(git(cmd, fsx, { issueLabels: labels }).decision, 'deny', cmd);
  for (const cmd of [
    'F=safe; noglob read F <<< settings.json; printf x > ~/.claude/$F',
    'F=safe; F[0]=settings.json; printf x > ~/.claude/$F',
    'F=safe; printf -vF settings.json; printf x > ~/.claude/$F',
    'for F in safe; do F[0]=settings.json; printf x > ~/.claude/$F; done',
  ]) assert.equal(files(cmd, fakeFs(PROJ, {}, DIRS)).decision, 'deny', cmd);
  // unchanged: a line that neither assigns nor reads the names the shell sets by itself
  assert.equal(git('k=5; echo hi; gh issue close $k', fsx, { issueLabels: labels }).decision, 'allow');
  assert.equal(git('for n in 5; do noglob echo x; gh issue close $n; done', fsx, { issueLabels: labels }).decision, 'allow');
  allowBoth('for f in src/a.ts a.mjs; do cp $f /tmp/x/; done', SPEC);
});

test('#56 replay of 96848c2: template text the shell never expands, and zsh flags that cannot assign, are no indirect expansion', () => {
  const D = fakeFs(PROJ, {}, DIRS);
  for (const cmd of [
    "D=/tmp/x; cat > $D/a.mjs <<'EOF'\nconst m = `${(e.stderr || e.message)}`\nEOF\necho ok > $D/b.txt", // (a quoted heredoc body is data)
    "D=/tmp/x; node -e 'const m = `${(e.stderr)}`' > $D/b.txt", // (single quotes)
    'D=/tmp/x; node -e "const m = \\`\\${(e as X)}\\`" > $D/b.txt', // (an escaped dollar)
    'D=/tmp/x; FILES=("${(@f)$(git diff --name-only)}"); echo ${(@u)FILES} > $D/b.txt',
    'D=/tmp/x; for f in ${(f)"$(ls)"}; do wc -l "$f"; done > $D/b.txt',
  ]) assert.equal(files(cmd, D).decision, 'allow', cmd);
  for (const cmd of [
    'F=safe; : "${(P)N::=settings.json}"; printf x > ~/.claude/$F',
    'F=safe; : ${(f)F::=settings.json}; printf x > ~/.claude/$F', // (flags, then an assignment)
    'F=safe; : ${(f)F:=x}${(e)X}; printf x > ~/.claude/$F',
    'F=safe; : ${(#)X}; printf x > ~/.claude/$F', // (# evaluates arithmetic: X may hold F=…)
    'F=safe; : ${(s:$X:)Y}; printf x > ~/.claude/$F',
    'F=safe; : "\\\\${(P)N::=settings.json}"; printf x > ~/.claude/$F', // (an escaped backslash: the expansion is real)
    "F=safe; cat <<EOF\n${(P)N::=settings.json}\nEOF\nprintf x > ~/.claude/$F", // (an unquoted heredoc body expands)
    "F=safe; : \"$(echo '\"')${(P)N::=settings.json}\"; echo \"'\"; printf x > ~/.claude/$F", // (a quote inside $( ) inside double quotes: the scanner must not lose its place)
    "F=safe; : \"`echo '\"'`${(P)N::=settings.json}\"; echo \"'\"; printf x > ~/.claude/$F",
    "F=safe # it's\n: ${(P)N::=settings.json}\nprintf x > ~/.claude/$F # '",
    "F=safe; cat <<EOF\n'${(P)N::=settings.json}'\nEOF\nprintf x > ~/.claude/$F", // (single quotes in an unquoted heredoc body are text: the expansion is real)
    "F=safe; cat <<EOF\nit's\nEOF\n: ${(P)N::=settings.json}; echo \"'\"; printf x > ~/.claude/$F", // (a quote in a body must not shift the scan of the lines after it)
    "for F in safe; do cat <<EOF\n'${(P)N::=settings.json}'\nEOF\nprintf x > ~/.claude/$F; done",
    "F=safe; : $'\\'' ${(P)N::=settings.json} $'\\''; printf x > ~/.claude/$F", // ($'…' takes a backslash-escaped quote: a plain quote scanner would blank the expansion)
    'F=safe; : ${(P)N}; printf x > ~/.claude/$F', // ((P) alone: N may hold `F[$(…)]` or an arithmetic subscript that assigns)
    'F=safe; : ${(f)G:=x}${(f)F::=settings.json}; printf x > ~/.claude/$F',
  ]) assert.equal(files(cmd, D).decision, 'deny', cmd);
  assert.equal(files('D=/tmp/x; echo ${(@u)FILES} > $D/b.txt', D).decision, 'allow'); // (flags that only shape the value, outside double quotes)
  // a script the git guard opens has no line text: an unquoted heredoc in it counts as an indirect expansion
  const SX = fakeFs(GIT_ROOT, { 'run.sh': "B=agent/x\ncat <<EOF\n'${(P)N::=main}'\nEOF\ngit push origin $B\n", 'ok.sh': "B=agent/x\ncat <<'EOF'\n${(e.x)}\nEOF\ngit push origin $B\n" }, DIRS);
  assert.equal(git('bash run.sh', SX).decision, 'deny');
  assert.equal(git('bash ok.sh', SX).decision, 'allow');
  for (const body of ["'${(P)N::=main}'", '${(P)N::=main}']) assert.equal(git('bash r2.sh', fakeFs(GIT_ROOT, { 'r2.sh': `B=agent/x\ncat <<EOF\n${body}\nEOF\ngit push origin $B\n` }, DIRS)).decision, 'deny', body);
  const FX = (body) => fakeFs(PROJ, { 'run.sh': `F=safe\ncat <<EOF\n${body}\nEOF\nprintf x > ~/.claude/$F\n` }, DIRS);
  for (const body of ["'${(P)N::=settings.json}'", '${(P)N::=settings.json}']) assert.equal(files('bash run.sh', FX(body)).decision, 'deny', body);
  assert.equal(files('bash run.sh', fakeFs(PROJ, { 'run.sh': "F=safe\ncat <<'EOF'\n${(e.x)}\nEOF\nprintf x > /tmp/$F\n" }, DIRS)).decision, 'allow');
  for (const cmd of [
    'B=agent/x; : ${(f)B::=main}; git push origin $B',
    "B=agent/x; cat <<EOF\n${(P)N::=main}\nEOF\ngit push origin $B",
    "B=agent/x; : \"$(echo '\"')${(P)N::=main}\"; echo \"'\"; git push origin $B",
    "B=agent/x # it's\n: ${(P)N::=main}\ngit push origin $B # '", // (a quote inside a comment is no quote)
    "B=agent/x; cat <<EOF\n'${(P)N::=main}'\nEOF\ngit push origin $B", // (single quotes in an unquoted heredoc body are text)
    "for B in agent/x; do cat <<EOF\n'${(P)N::=main}'\nEOF\ngit push origin $B; done",
  ]) denyGit(cmd, SPEC);
  allowGit("B=agent/x; node -e 'const m = `${(e.stderr)}`'; git push origin $B", SPEC);
});
