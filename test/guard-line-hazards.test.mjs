// Why (issue #81 t8): two groups of lines.
// A. Line-level hazards that switched the git guard's readings off for the whole line (a name assigned once and read many times is judged once per value, see onceAssignedNames):
//    - a `name()` inside a QUOTED argument (`psql -c "select now()"` handed to `docker exec`) was taken for a function definition: the parser knows the real definitions (cmds.fns);
//    - a command named by a variable (`$PSQL -At -c ...`, `$S/run.sh $S/m$n.sql`) is resolved per reading, from names with literal values, and judged like the command it is.
//    A real definition, a name that cannot be resolved, and a head that resolves to a binder / eval / source keep the hazard. `.` / `source` stay a hazard (a sourced file can set anything).
// B. Computed script names (found by the security pass, on main too): both guards left the parameter-expansion operators in an ASSIGNMENT value as literal text, so `G=${U:-run.sh}; bash $G`
//    ran run.sh while the guards judged a word they could not resolve. Each assigned value now yields its candidate words (defaults, replace / trim / case operators on a known value) and an
//    array's every element is a candidate for any subscript or `[@]` use, `+=` and `F[1]=` included.
// Guarded text only lives in fake file contents or is spelled split.
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
const BAD_GIT = 'git ' + 'push origin main'; // (split so a hook that scans this file for a guarded command does not take the fixture for one)
const BAD_FILES = 'echo x > ~/.' + 'claude/settings.json';
const git = (command, fsOpts, o = {}) => evaluateGitCommand(command, {
  cwd: GIT_ROOT, home: '/home/u', currentBranch: () => 'agent/x', pushDestination: () => null, issueLabels: () => [], ...fsOpts, ...o,
});
const files = (command, fsOpts, o = {}) => evaluateBashForFiles(command, {
  home: '/home/u', env: {}, platform: 'linux', realpath: (p) => p, cwd: PROJ, ...fsOpts, existsSync: fsOpts.pathExists, ...o,
});
function both(command, spec, dirs = ['scripts']) {
  const mk = (bad, ok) => Object.fromEntries(Object.entries(spec).map(([k, v]) => [k, v === 'bad' ? bad : v === 'ok' ? ok : v]));
  return {
    git: git(command, fakeFs(GIT_ROOT, mk(BAD_GIT, 'git status'), dirs)),
    files: files(command, fakeFs(PROJ, mk(BAD_FILES, 'echo hi'), dirs)),
  };
}
// run.sh / run2.sh / scripts/run2.sh hold the guarded command; ok.sh / run1.sh / scripts/run1.sh are harmless
const SPEC = { 'run.sh': 'bad', 'run2.sh': 'bad', 'ok.sh': 'ok', 'run1.sh': 'ok', 'scripts/run2.sh': 'bad', 'scripts/run1.sh': 'ok' };
const allow = (cmd, spec = SPEC) => {
  const r = both(cmd, spec);
  assert.equal(r.git.decision, 'allow', `git: ${cmd} -> ${r.git.reason}`);
  assert.equal(r.files.decision, 'allow', `files: ${cmd} -> ${r.files.reason}`);
};
const denyBoth = (cmd, spec = SPEC) => {
  const r = both(cmd, spec);
  assert.equal(r.git.decision, 'deny', `git allowed: ${cmd}`);
  assert.equal(r.files.decision, 'deny', `files allowed: ${cmd}`);
};
const none = fakeFs(GIT_ROOT, {});
const gitAllow = (cmd) => { const r = git(cmd, none); assert.equal(r.decision, 'allow', `git: ${cmd} -> ${r.reason}`); };
const gitDeny = (cmd, fsOpts = none) => { const r = git(cmd, fsOpts); assert.equal(r.decision, 'deny', `git allowed: ${cmd}`); return r; };
const PUSH = 'pu' + 'sh';

// ---- A. line-level hazards ------------------------------------------------------------------------------------------------------------------------------
test('A1 a name() in a quoted argument of an external program is data, not a function definition', () => {
  gitAllow('for t in a b; do docker exec db psql -tAc "select now()"; git show $t; done');
  gitAllow("for t in a b; do docker exec db psql -tAc 'select now()'; git show $t; done");
  gitAllow('for t in a b; do docker exec db psql -tAc "select count(*) from f(1)"; git log -1 $t; done');
});
test('A1 a real function definition on the line keeps the hazard (also next to a quoted name())', () => {
  gitDeny(`f() { git ${PUSH} origin main; }; f`);
  gitDeny('for t in a b; do docker exec db psql -tAc "select now()"; git show $t; done; f() { :; }');
  gitDeny('for t in a b; do git show $t; done; function g { :; }');
  gitDeny('for t in a b; do docker exec db psql -tAc "select now()"; git show $t; done; eval "f() { :; }"');
  gitDeny('for t in a b; do eval "select now()"; git show $t; done');
  gitDeny('for t in a b; do trap "now()" EXIT; git show $t; done');
  gitDeny('for t in a b; do alias q="now()"; git show $t; done');
});

test('A2 a command named by a name with a literal value is resolved per reading and judged as the command it is', () => {
  gitAllow('PSQL=/usr/bin/psql; for f in a b; do $PSQL -At -c "select 1" $f; done');
  gitAllow('S=/x; for n in 1 2; do $S/run.sh $S/m$n.sql; done');
  gitAllow('PSQL=psql; for f in a b; do $PSQL -At -c "select 1" $f; done');
  gitAllow('for p in ls cat; do $p x; git show $p; done');
});
test('A2 a resolved script is still judged: the guarded script is found in the reading that picks it', () => {
  const fs = fakeFs(GIT_ROOT, { 'run.sh': BAD_GIT, 'run1.sh': 'git status', 'scripts/run2.sh': BAD_GIT, 'scripts/run1.sh': 'git status' }, ['scripts']);
  gitDeny('PSQL=bash; for f in a run.sh; do $PSQL $f; done', fs);
  gitDeny('S=scripts; for n in 1 2; do $S/run$n.sh; done', fs);
  gitDeny('S=bash; for n in 1 2; do $S run$n.sh; git show $n; done', fakeFs(GIT_ROOT, { 'run2.sh': BAD_GIT, 'run1.sh': 'git status' }));
  gitDeny(`C=git; $C ${PUSH} origin main`);
  gitDeny(`C=git; for n in 1 2; do $C ${PUSH} origin main; done`);
});
test('A2 a head that resolves to a binder, eval or source, or cannot be resolved, keeps the hazard', () => {
  gitDeny('X=read; for f in a b; do $X $f; git show $f; done');
  gitDeny('X=eval; for f in a b; do $X "git show $f"; done');
  gitDeny('for p in eval ls; do $p x; git show $p; done');
  gitDeny('for p in a b; do $q x; git show $p; done'); // ($q is not given by the line)
  gitDeny('X=$(echo ls); for f in a b; do $X $f; git show $f; done');
  gitDeny('X=ls; for f in a b; do $X < in.txt; git show $f; done'.replace('X=ls', "X='ls -l'"));
});
test('A3 source / . stay a hazard (a sourced file can set any name)', () => {
  gitDeny('set -a; . ~/env.sh; for f in a b; do git show $f; done');
  gitDeny('source ~/env.sh; for f in a b; do git show $f; done');
});

// ---- B. computed script names -------------------------------------------------------------------------------------------------------------------------
test('B1 default operators in an assigned value: every candidate word is judged', () => {
  denyBoth('G=${U:-run.sh}; bash $G');
  denyBoth('G=${U:=run.sh}; bash $G');
  denyBoth('G=${U-run.sh}; bash $G');
  denyBoth('G=${U=run.sh}; bash $G');
  denyBoth('G=${U:+run.sh}; bash $G');
  denyBoth('G="${U:-run.sh}"; bash "$G"');
  denyBoth('export G=${U:-run.sh}; bash $G');
  denyBoth('G=${U:-run}.sh; bash $G');
  denyBoth('G=${U:-bash}; $G run.sh');
  denyBoth('A=${U:-run.sh}; B=${A:-x.sh}; bash $B'); // (a default built from another computed name)
  allow('G=${U:-ok.sh}; bash $G');
  allow('G=${U:-ok.sh}; bash ${G}');
  allow('G=${U:-bash}; $G ok.sh');
});
test('B2 replace, trim, case and substring operators on a known value', () => {
  denyBoth('F=ok.sh; G=${F/ok/run}; bash $G');
  denyBoth('F=ok.sh; G=${F//ok/run}; bash $G');
  denyBoth('F=run2.sh; G=${F%2.sh}.sh; bash $G');
  denyBoth('F=xrun.sh; G=${F#x}; bash $G');
  denyBoth('F=RUN.SH; G=${F,,}; bash $G');
  denyBoth('F=run.sh.bak; G=${F%.bak}; bash $G');
  denyBoth('F=xxrun.sh; G=${F:2}; bash $G');
  allow('F=ok.sh; G=${F/ok/run1}; bash $G');
  allow('F=run1.sh.bak; G=${F%.bak}; bash $G');
  allow('F=ok.sh; G=${F%.sh}.sh; bash $G');
});
test('B3 arrays: every element is a candidate for any subscript, [@] or bare use', () => {
  denyBoth('F=(ok.sh run.sh); bash ${F[1]}');
  denyBoth('F=(ok.sh run.sh); bash "${F[@]}"');
  denyBoth('F=(ok.sh run.sh); bash ${F[@]}');
  denyBoth('F=(ok.sh run.sh); bash $F[2]');
  denyBoth('F=(ok.sh run.sh); bash ${F[$i]}');
  denyBoth('F=(ok.sh run.sh); bash ${F[-1]}');
  denyBoth('F=(ok.sh); F+=(run.sh); bash ${F[1]}');
  denyBoth('F=(ok.sh); F[3]=run.sh; bash ${F[3]}');
  denyBoth('typeset -a F=(ok.sh run.sh); bash ${F[1]}');
  denyBoth('F=(ok.sh run.sh); G=${F[1]}; bash $G');
  denyBoth('F=(ok.sh ${U:-run.sh}); bash ${F[1]}');
  allow('F=(ok.sh run1.sh); bash ${F[1]}');
  allow('F=(ok.sh run1.sh); bash "${F[@]}"');
  allow('F=(ok.sh run1.sh); echo "${F[@]}"');
});
test('B4 harmless values stay allowed', () => {
  allow('OUT=${OUT:-out}; echo x > $OUT/log');
  allow('OUT=${OUT:-out}; mkdir -p $OUT');
  allow('D=${HOME}/x; echo hi > $D');
  allow('ROOT=${0%/*}; echo $ROOT');
  allow('N=${1:-3}; echo $N');
  allow('F=(a b c); echo ${F[1]}');
});
