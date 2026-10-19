// Why (issue #76 + #81 t7): the protected-files guard judged a shell variable by the LAST value the line gave it, and did not see an arithmetic assignment as an assignment.
//   1. `F=settings.json; printf x > ~/.claude/$F; F=safe` was allowed: the write was judged as ~/.claude/safe. Now each use is judged with every value the name is given
//      on the line ("readings"): the line is allowed only when every one is. The harmless shape `if …; then out=$3; else out="$dir/x"; fi; awk … > "$out"` (every value
//      harmless) stays allowed, and so do two writes whose values are both harmless.
//   2. `n=1; : $((n+=6)); bash s$n.sh` ran s7.sh while the guard read s1.sh. An assignment form inside `$(( ))`, `(( ))` or `let` (`=`, `op=`, `++`, `--`, before or after
//      the name, with or without blanks) now makes the name only known at run time: a script or a writer it picks is refused. `$((n+1))` only reads and stays allowed.
// The file system is faked; the guarded path is spelled split so a hook that scans this file does not take it for a command.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname, basename } from 'node:path';
import { evaluateBashForFiles } from '../pipeline/hooks/lib/files-policy.mjs';

const PROJ = '/home/u/proj';
const CL = '.cl' + 'aude';
const BAD = `echo x > ~/${CL}/settings.json`; // (a script that writes a protected file)
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
const run = (command, spec = {}) => {
  const fsOpts = fakeFs(PROJ, spec, ['d']);
  return evaluateBashForFiles(command, { home: '/home/u', env: {}, platform: 'linux', realpath: (p) => p, cwd: PROJ, ...fsOpts, existsSync: fsOpts.pathExists });
};
const SCRIPTS = { 's1.sh': 'echo hi', 's7.sh': BAD, 's6.sh': 'echo hi', 's8.sh': 'echo hi' };
const deny = (command, spec) => test(`DENY ${command}`, () => { const r = run(command, spec); assert.equal(r.decision, 'deny', `${command} -> ${r.reason}`); });
const allow = (command, spec) => test(`ALLOW ${command}`, () => { const r = run(command, spec); assert.equal(r.decision, 'allow', `${command} -> ${r.reason}`); });

// ---- 1. the value at the use, not the last value ----------------------------------------------------------------------------
deny(`F=settings.json; printf x > ~/${CL}/$F; F=safe`);
deny(`F=settings.json; printf x >> ~/${CL}/$F; F=safe`);
deny(`F=settings.json; cp x ~/${CL}/$F; F=safe`);
deny(`F=settings.json; echo x | tee ~/${CL}/$F; F=safe`);
deny(`F=settings.json; printf x > ~/${CL}/\${F}; F=safe`);
deny(`F=settings.json; printf x > "$HOME/${CL}/$F"; F=safe.txt`);
deny(`export F=settings.json; printf x > ~/${CL}/$F; export F=safe`);
deny(`F=settings.json; printf x > ~/${CL}/$F; F=safe; F=other`);
// the value changes in a loop after the write, or the write is in a loop that changes it
deny(`F=settings.json; printf x > ~/${CL}/$F; for F in safe other; do :; done`);
deny(`F=safe; for i in 1 2; do printf x > ~/${CL}/$F; F=settings.json; done`);
deny(`F=settings.json; while true; do printf x > ~/${CL}/$F; F=safe; break; done`);
// a function body runs when it is called, with the value then
deny(`F=settings.json; f() { printf x > ~/${CL}/$F; }; f; F=safe`);
deny(`F=safe; f() { printf x > ~/${CL}/$F; }; F=settings.json; f; F=safe`);
// the value is built from another name that changes
deny(`D=${CL}; F=settings.json; printf x > ~/$D/$F; F=safe`);
deny(`F=settings.json; G=$F; printf x > ~/${CL}/$G; G=safe`);
// a script picked by the name
deny('S=s7.sh; bash $S; S=s1.sh', SCRIPTS);
deny('S=s7.sh; bash $S; for S in s1.sh; do :; done', SCRIPTS);

// ---- 2. harmless shapes stay allowed ----------------------------------------------------------------------------------------
allow('if [ $# -eq 3 ]; then out=$3; else out="$dir/task-${n}-brief.md"; fi; awk \'{print}\' in.md > "$out"');
allow('if [ $# -eq 3 ]; then out=$3; else out="$dir/task-${n}-brief.md"; fi; awk \'{print}\' in.md >> "$out"');
allow('F=a.txt; printf x > $F; F=b.txt; printf y > $F');
allow('F=a.txt; printf x > $F; F=b.txt');
allow('F=safe; printf x > ~/notes/$F; F=other; printf y > ~/notes/$F');
allow('S=s1.sh; bash $S; S=s6.sh; bash $S', SCRIPTS);
allow('F=a.txt; F=b.txt; printf y > /tmp/$F');

// ---- 3. arithmetic assignments make the name unknown ------------------------------------------------------------------------
deny('true && n=1; : $((n+=6)); bash s$n.sh', SCRIPTS);
deny('n=6; : $((n++)); bash s$n.sh', SCRIPTS);
deny('n=8; : $((n--)); bash s$n.sh', SCRIPTS);
deny('n=6; : $((++n)); bash s$n.sh', SCRIPTS);
deny('n=8; : $((--n)); bash s$n.sh', SCRIPTS);
deny('n=1; : $(( n = 7 )); bash s$n.sh', SCRIPTS);
deny('n=1; : $((n=7)); bash s$n.sh', SCRIPTS);
deny('n=1; : $(( n += 6 )); bash s$n.sh', SCRIPTS);
deny('n=1; : $(( n ++ )); bash s$n.sh', SCRIPTS);
deny('n=1; : $(( n *= 7 )); bash s$n.sh', SCRIPTS);
deny('n=1; echo $((n = 7)); bash s$n.sh', SCRIPTS);
deny('n=1; x=$((n+=6)); bash s$n.sh', SCRIPTS);
deny('n=1; ((n+=6)); bash s$n.sh', SCRIPTS);
deny('n=1; (( n = 7 )); bash s$n.sh', SCRIPTS);
deny('n=6; ((n++)); bash s$n.sh', SCRIPTS);
deny('n=6; (( ++n )); bash s$n.sh', SCRIPTS);
deny('n=1; let n+=6; bash s$n.sh', SCRIPTS);
deny('n=1; let "n=7"; bash s$n.sh', SCRIPTS);
deny('n=6; let n++; bash s$n.sh', SCRIPTS);
deny('n=1; let m=2 n=7; bash s$n.sh', SCRIPTS);
deny('n=1; : $((m=2, n=7)); bash s$n.sh', SCRIPTS);
deny('n=1; : $((m=n+1, n+=6)); bash s$n.sh', SCRIPTS);
// the name is then used to build a write target
deny(`n=1; : $((n+=6)); printf x > ~/${CL}/f$n`);
deny(`n=1; : $((n=7)); cp x ~/${CL}/settings$n.json`);
// a name built from the arithmetic-assigned one
deny('n=1; : $((n+=6)); S=s$n.sh; bash $S', SCRIPTS);
// a use of the name before the assignment is still judged with the value it has there... and the later script is judged unknown
deny('n=7; bash s$n.sh; : $((n=1))', SCRIPTS);

// arithmetic that only reads
allow('n=1; : $((n+1)); bash s$n.sh', SCRIPTS);
allow('n=1; x=$((n * 2 + 1)); bash s$n.sh', SCRIPTS);
allow('n=1; echo $((n == 1)); bash s$n.sh', SCRIPTS);
allow('n=1; echo $((n <= 7)) $((n >= 0)) $((n != 3)); bash s$n.sh', SCRIPTS);
allow('n=1; (( n > 0 )) && bash s$n.sh', SCRIPTS);
allow('n=1; (( n == 1 )); bash s$n.sh', SCRIPTS);
allow('n=1; let "m = n + 1"; bash s$n.sh', SCRIPTS);
allow('n=1; : $((m = n + 1)); bash s$n.sh', SCRIPTS);

// an indirect target (`$n` is the name of the variable that is assigned), a subscript, a nested and a long form
deny('n=1; m=n; : $(( $m = 7 )); bash s$n.sh', SCRIPTS);
deny('n=1; m=n; : $(( ${m} += 6 )); bash s$n.sh', SCRIPTS);
deny('n=1; : $(( (n=7) + 0 )); bash s$n.sh', SCRIPTS);
deny('n=1; for ((n=7; n<8; n++)); do :; done; bash s$n.sh', SCRIPTS);
deny('n=1; echo "$[n=7]"; bash s$n.sh', SCRIPTS);
deny('n=1; : $(( n[0] = 7 )); bash s$n.sh', SCRIPTS);
deny(`n=1; : $(( n<<=1, n+=5 )); printf x > ~/${CL}/f$n`);
allow('n=1; : $(( n << 1 )) $(( n >> 1 )) $(( n < 2 )); bash s$n.sh', SCRIPTS);
allow('n=1; echo $(( (n + 1) * 2 )); n=1; bash s$n.sh', SCRIPTS);

// too many readings (5 names with 2 values each and the target's 2 = 64 > 16): the target name is then only known at run time, not read as its last value
deny(`A=1; A=2; B=1; B=2; C=1; C=2; D=1; D=2; E=1; E=2; F=settings.json; printf x > ~/${CL}/$F; F=safe`);
deny('A=1; A=2; B=1; B=2; C=1; C=2; D=1; D=2; E=1; E=2; S=s7.sh; bash $S; S=s1.sh', SCRIPTS);
// a subscript too long to be told from a read is still taken for an assignment
deny(`n=1; : $(( n[${'a'.repeat(80)}] = 7 )); bash s$n.sh`, SCRIPTS);

// the body ends at its own closer: parentheses inside it are balanced, and an arithmetic with no closer takes the rest of the text
allow('n=1; : $(( (1+2) * 3 )); n=2; bash s$n.sh', SCRIPTS);
allow('n=1; : $(( (1+2) * 3 )); : $((4)); n=2; bash s$n.sh', SCRIPTS);
deny('n=1; : $(( n += 6 ; bash s$n.sh', SCRIPTS);
deny('n=1; echo "$[ n += 6 "; bash s$n.sh', SCRIPTS);
deny('n=1; : $(( (1) , (2) , n += 6 )); bash s$n.sh', SCRIPTS);
deny('n=1; : $(( (1) + (2) + (n += 6) )); bash s$n.sh', SCRIPTS);
