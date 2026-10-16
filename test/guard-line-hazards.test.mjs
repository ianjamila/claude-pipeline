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
import { assigningDefaults } from '../pipeline/hooks/lib/script-candidates.mjs';

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
const SPEC = { 'RUN.SH': 'bad', 'run.sh': 'bad', 'run2.sh': 'bad', 'ok.sh': 'ok', 'run1.sh': 'ok', 'scripts/run2.sh': 'bad', 'scripts/run1.sh': 'ok' };
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
  gitAllow("X='ls -l'; for f in a b; do $X < in.txt; git show $f; done");
  gitDeny('X=bash; for f in a b; do $X < run.sh; git show $f; done', fakeFs(GIT_ROOT, { 'run.sh': BAD_GIT })); // (the shell reads its script from stdin: judged in the reading)
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

// ---- B5. quoting and brace structure the scan cannot follow exactly is an unknown word (fail closed), never a truncated or half-unquoted one -------------------------
test('B5 quotes, backslashes and $\'..\' in a default word, or braces it cannot follow: refused like any word only known at run time', () => {
  for (const v of ['${U:-"run.sh"}', "${U:-'run.sh'}", '${U:-r"un".sh}', "${U:-$'run.sh'}", '${U:-\\run.sh}', '${U:-"}"run.sh}', '${U:-$(echo })}', '${U:-`echo }`}']) {
    denyBoth(`G=${v}; bash $G`);
  }
  denyBoth('G="${U:-"run.sh"}"; bash $G');
  denyBoth('F=("a b" ${U:-"run.sh"}); bash ${F[1]}');
  // the shell unquotes these exactly as the scan does
  denyBoth('G="${U:-run.sh}"; bash $G');
  denyBoth("G='run.sh'${U:+x}; bash $G");
  allow('G="${U:-ok.sh}"; bash "$G"');
  allow('F=("a b" ok.sh); bash ${F[1]}'.replace('"a b" ', ''));
});
test('B5 a name nothing on the line sets is no looser than before: the reading of the name itself stays, so a guarded operation on the line still refuses it', () => {
  allow('G=${U:-ok.sh}; bash $G');
  const r = both(`G=\${U:-ok.sh}; bash $G; git ${PUSH} origin main`, SPEC);
  assert.equal(r.git.decision, 'deny');
  const e = both('F=${U:-x}; G=${F/ok/run}; bash $G', SPEC); // (F is the environment's here: no word to judge, as for any name the line does not set)
  assert.equal(e.git.decision, 'allow');
});

// ---- B6. crafted long inputs finish quickly in both guards (a hook past its deadline is ALLOWED by the host) -------------------------------------------------------
test('B6 adversarial 200 kB lines and glob patterns are answered quickly', () => {
  const cases = [
    'a=${a}'.repeat(30000),
    '${'.repeat(8000), // (100000 of them takes the parser itself 13 s, on main too: not this reading's cost; assigningDefaults answers it in 0 ms)
    'a['.repeat(20000), // (90000 of them takes the parser 2-3 s, on main too)
    'F=(' + 'a '.repeat(90000) + '); bash ${F[1]}',
    'bash ' + '$F['.repeat(40000),
    'F=' + 'a'.repeat(5000) + '.sh; G=${F#*a*a*a*a*a*a*a*a*a*b}; bash $G',
    'F=' + 'a'.repeat(300) + '.sh; G=${F#*a*a*a*a*a*a*a*a*a*b}; bash $G',
    'F=' + 'a'.repeat(300) + '.sh; G=${F//*a*a*a*a*a*a*a*a*b/x}; bash $G',
    'F=' + 'a'.repeat(300) + '.sh; G=${F%%*a*a*a*a*a*a*a*a*a*b}; bash $G',
    'F=(' + 'x'.repeat(100000) + '); G=${F[1]%*a*a*a*a*a*a*a*b}; bash $G',
    '${U:-' + 'x'.repeat(190000) + '}',
    'G="' + '${U:-"'.repeat(30000),
  ];
  for (const c of cases) {
    // (this reading's own work, then the guards; the parser alone takes 2-3 s on some of these on main too, so the guards get the deadline's third)
    const cpu = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1000; }; // (CPU time, not the clock: a busy machine must not fail the test)
    const t0 = cpu();
    assigningDefaults(c);
    const own = cpu() - t0;
    assert.ok(own < 500, `${own} ms in assigningDefaults for ${c.slice(0, 40)}...`);
    both(c, SPEC);
    const ms = cpu() - t0;
    assert.ok(ms < 8000, `${ms} ms for ${c.slice(0, 40)}...`);
  }
});
test('B6 a glob with many stars on a long value is an unknown word, not a long search', () => {
  denyBoth('F=' + 'a'.repeat(200) + '.sh; G=${F#*a*a*a*a*a*a*a*a*a*b}; bash $G');
  denyBoth('F=run.sh; G=${F#*a*a*a*a*a*a*a*a*a*b}; bash $G'.replace('#*a*a*a*a*a*a*a*a*a*b', '%.sh*q*q*q*q*q*q*q*q*q'));
  denyBoth('F=xrun.sh; G=${F#?}; bash $G');
  denyBoth('F=run.shx; G=${F%?}; bash $G');
});

test('B7 a backslash or $\'..\' in the assigned word, an operator not worked out and a default nested past the steps allowed are unknown words', () => {
  denyBoth('G=\\run.sh${U:+x}; bash $G');
  denyBoth("G=$'run.sh'${U:+x}; bash $G");
  denyBoth('G=`echo run.sh`${U:+x}; bash $G');
  denyBoth('F=ok.sh; G=${F:abc}; bash $G');
  denyBoth('F=ok.sh; G=${F/[a-z]/x}; bash $G');
  denyBoth('F=ok.sh; G=${F^^pat}x; bash $G'.replace('^^pat', '@U'));
  denyBoth(`G=${'${U:-'.repeat(20)}run.sh${'}'.repeat(20)}; bash $G`);
});

// ---- B8. every cap, give-up or structure not followed makes the name's candidate set UNKNOWN (refused when the name is used as a script), never a shorter list --------
test('B8 an array longer than the words kept, or with more elements than the scan reads, is unknown for any subscript', () => {
  const els = (n) => Array.from({ length: n }, (_, i) => `e${i}.sh`).join(' ');
  denyBoth(`F=(${els(40)} run.sh); bash \${F[40]}`);
  denyBoth(`F=(${els(300)} run.sh); bash \${F[300]}`);
  denyBoth(`F=(${els(300)} run.sh); bash "\${F[@]}"`);
  denyBoth(`F=(${els(20)} run.sh); bash \${F[20]} `.replace('bash', 'bash -x'));
  allow(`F=(${els(20)} ok.sh); bash \${F[20]}`);
});
test('B8 a default built from too many alternatives is unknown', () => {
  denyBoth('G=${A:-1}${B:-2}${C:-3}${D:-4}${E:-5}${H:-6}run.sh; bash $G');
  denyBoth('G=${A:-${B:-x}}${C:-${D:-y}}${E:-${H:-z}}${I:-${J:-w}}run.sh; bash $G');
});
test('B8 an operator the scan does not work out is unknown, on a name the text gives or not', () => {
  for (const v of ['${U@Q}', '${!U}', '${#U}', '${(P)U}', '${U:#pat}', '${${U}:-x}', '${(U)U}', '${U[1]@Q}', '${F@U}', '${F:#x}', '${(L)F}', '${!F[@]}']) {
    denyBoth(`F=ok.sh; G=${v}; bash $G`);
  }
});
test('B8 a name built from an unknown or computed one is that unknown or computed set', () => {
  denyBoth('A=${U:-run.sh}; B=$A; bash $B');
  denyBoth('A=${U:-run.sh}; B=${A}; bash $B');
  denyBoth('A=${U:-run.sh}; B=x${A}; C=${B#x}; bash $C');
  denyBoth('F=(ok.sh run.sh); G=$F[2]; bash $G');
  denyBoth('F=(ok.sh run.sh); G=$F; bash $G');
  denyBoth('F=(ok.sh run.sh); G=${F[@]}; bash $G');
  allow('A=${U:-ok.sh}; B=$A; bash $B');
  allow('ROOT=${0%/*}; bash $ROOT/ok.sh');
});
test('B8 more entries than the scan follows makes every name used as a script unknown', () => {
  const many = Array.from({ length: 300 }, (_, i) => `A${i}=(x)`).join('; ');
  denyBoth(`${many}; Z=ok.sh; bash $Z`);
  const plain = Array.from({ length: 5000 }, (_, i) => `P${i}=${i}`).join('; ');
  denyBoth(`${plain}; F=(ok.sh); Z=ok.sh; bash $Z`);
});
test('B8 a quoted head the scan does not read, and a loop that may not run, keep the hazard', () => {
  gitDeny("S=scripts; for n in 1 2; do '$S/run1.sh' $n; git show $n; done", fakeFs(GIT_ROOT, { 'scripts/run1.sh': 'git status' }, ['scripts']));
  gitDeny('[ -d x ] && for p in ls cat; do $p x; git show $p; done');
  gitAllow('for p in ls cat; do $p x; git show $p; done');
});

test('B8 assigningDefaults itself: a cap or a give-up leaves an unknown word in the set, never a shorter list', () => {
  const U = '$(?)';
  const els = (n) => Array.from({ length: n }, (_, i) => `e${i}.sh`).join(' ');
  assert.ok(assigningDefaults(`F=(${els(40)})`).get('F[]').includes(U), '40 elements');
  assert.ok(assigningDefaults(`F=(${els(300)})`).get('F[]').includes(U), '300 elements');
  assert.ok(assigningDefaults('F=(a b c').get('F[]').includes(U), 'no closing parenthesis');
  assert.ok(!assigningDefaults(`F=(${els(5)})`).get('F[]').includes(U), 'a short array is complete');
  assert.deepEqual(assigningDefaults('x=${U:-a}${U:-' + 'b'.repeat(250_000) + '}').get('*'), [U], 'text over the cap: every name unknown');
  assert.deepEqual(assigningDefaults(`${Array.from({ length: 300 }, (_, i) => `A${i}=(x)`).join('; ')}`).get('*'), [U], 'more arrays than followed');
  assert.deepEqual(assigningDefaults(`${Array.from({ length: 5000 }, (_, i) => `P${i}=1`).join('; ')}; F=(x)`).get('*'), [U], 'more assignments than followed');
  assert.ok(assigningDefaults('G=${U:-"a"}').get('G').includes(U), 'quote in braces');
  assert.ok(assigningDefaults('G=${U:-a').get('G').includes(U), 'brace never closes');
  assert.ok(assigningDefaults('F=a; G=${F@Q}').get('G').includes(U), 'transform');
  assert.ok(assigningDefaults('F=a; G=${F:#x}').get('G').includes(U), 'pattern after colon');
  assert.ok(assigningDefaults('A=${U:-run.sh}; B=$A').get('B').includes('run.sh'), 'a name built from a computed one');
  assert.equal(assigningDefaults('F=ok.sh; G=${F}').size, 0, 'a plain reference is the guard\'s own expansion');
});

test('B8 case, element-index and long-array forms', () => {
  denyBoth('F=run.sh; G=${F^^}; bash $G');
  denyBoth('F=(ok.sh [5]=run.sh); bash ${F[5]}');
  const els = Array.from({ length: 70 }, (_, i) => `e${i}.sh`).join(' ');
  denyBoth(`F=(${els}); G=\${F[1]%%*}; bash $G`); // (70 words are more than kept: whatever an operator makes of them is unknown)
});
