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
import { evaluateGitCommand } from '../pipeline/hooks/lib/git-policy.mjs';
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
  // a word list only known at run time: the variable is unknown, so a script or a guarded command it picks is refused
  for (const cmd of ['for f in $(ls); do bash $f; done', 'for n in 5 $M; do gh issue close $n; done']) denyGit(cmd, SPEC);
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
