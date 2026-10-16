// Why (issue #81, security follow-up after t7): a security review flagged a parser differential in the readings: places where the SHELL assigns or changes a variable but the
// guard does not see it, so a script choice (`bash s$n.sh`) was judged with the wrong value. Probed against real bash and zsh (every shape below was run in both; a shape only one
// shell honours says so), each is a bypass in BOTH guards unless noted, and most were already open on main (3651520); t7's text scan only knew `((` `$[` `let` and only for a name the
// line had given a value first. Each shape runs the script s7.sh (the fake file holds a guarded command) while the name still reads 2 (s2.sh is harmless) to the guard:
//   - arithmetic contexts that are no `$(( ))`: a `[[ x -eq n=7 ]]` operand (bash and zsh evaluate -eq -ne -lt -le -gt -ge operands; `[ ]` and `test` do not), an array subscript
//     (`${a[n=7]}`, `a[n=7]=x`, `${a[n++]}`, `${#a[n=7]}`, zsh `$x[n=7]`), a substring offset (`${x:n=3:1}`, `${a[@]:n=1}`);
//   - blanks and `++` the git guard never read (`$(( n = 7 ))`, `((n++))`, `$((n++))`, `while ((n++ < 7))`, `$[n=7]`: the files guard had them since t7, the git guard had none);
//   - `n+=7.sh` (append): the parser keeps `n` = `7.sh` (the files guard judged the new text, not old + new), and `export n+=` / `declare n+=` were not read at all;
//   - a name nothing set before (`(( n += 7 )); bash s$n.sh`, `let n+=7`): t7 marked only a name the line had given, so the guard read the empty value;
//   - zsh `integer n` / `float n` / `typeset -F n` (the integer / float attribute makes `n=2+5` arithmetic; the git guard refused the binder, the files guard did not);
//   - an unquoted heredoc / here-string body expands `$(( ))` in the current shell (`: <<EOF` + `$((n+=5))`): scanned as command text. A QUOTED delimiter does not expand: its body is data
//     (t7 made the files guard refuse a quoted body that merely shows `$((n=7))`; that is a new false alarm and is allowed again).
// Each deny has a harmless twin that must stay allowed. The file system is faked; guarded text only lives in fake file contents.
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
function both(command, spec) {
  const mk = (bad, ok) => Object.fromEntries(Object.entries(spec).map(([k, v]) => [k, v === 'bad' ? bad : v === 'ok' ? ok : v]));
  return {
    git: git(command, fakeFs(GIT_ROOT, mk(BAD_GIT, 'git status'))),
    files: files(command, fakeFs(PROJ, mk(BAD_FILES, 'echo hi'))),
  };
}
// s7 / s1 / s3 / s8 hold the guarded command; s2 / s0 and a missing name are harmless. Every case starts with the name at a harmless value (2 or 0, or unset).
const SPEC = { 's7.sh': 'bad', 's1.sh': 'bad', 's3.sh': 'bad', 's8.sh': 'bad', 's2.sh': 'ok', 's0.sh': 'ok', 's.sh': 'ok' };
const allow = (cmd, spec = SPEC) => {
  const r = both(cmd, spec);
  assert.equal(r.git.decision, 'allow', `git: ${cmd} -> ${r.git.reason}`);
  assert.equal(r.files.decision, 'allow', `files: ${cmd} -> ${r.files.reason}`);
};
const deny = (cmd, spec = SPEC) => {
  const r = both(cmd, spec);
  assert.equal(r.git.decision, 'deny', `git allowed: ${cmd}`);
  assert.equal(r.files.decision, 'deny', `files allowed: ${cmd}`);
};
const denyEach = (cmds) => { for (const c of cmds) deny(c); };

test('a [[ ]] operand of -eq / -ne / -lt / -le / -gt / -ge is arithmetic: an assignment there changes the name', () => {
  denyEach([
    '[[ n=7 -eq 7 ]]; bash s$n.sh', // (the name was never set: the guard read the empty value)
    'n=2; [[ n=7 -eq 7 ]]; bash s$n.sh',
    'n=2; [[ $x -eq n=7 ]]; bash s$n.sh',
    'n=2; [[ n=7 -eq 7 ]] && bash s$n.sh',
    'n=2; if [[ n=7 -eq 7 ]]; then :; fi; bash s$n.sh',
    'n=2; [[ 1 -lt n=7 ]]; bash s$n.sh',
    'n=2; [[ "n = 7" -ge 7 ]]; bash s$n.sh',
    'n=2; [[ -z $q && n+=5 -ne 0 ]]; bash s$n.sh',
  ]);
});

test('a [[ ]] without an arithmetic operator, and [ ] / test, assign nothing', () => {
  for (const c of [
    'n=2; [ n=7 -eq 7 ]; bash s$n.sh',
    'n=2; test n=7 -eq 7; bash s$n.sh',
    'n=2; [[ n=7 == n=7 ]]; bash s$n.sh',
    'n=2; [[ $n -eq 2 ]] && bash s$n.sh',
    'n=2; [[ $n -gt 1 && -n $x ]]; bash s$n.sh',
    'n=2; [[ $x = b=1 ]]; bash s$n.sh',
  ]) allow(c);
});

test('an array subscript is arithmetic: an assignment in it changes the name', () => {
  denyEach([
    'a=(1 2 3 4 5 6 7 8); n=2; echo ${a[n=7]}; bash s$n.sh',
    'n=2; echo "${a[n=7]}"; bash s$n.sh',
    'n=2; a[n=7]=x; bash s$n.sh',
    'n=0; a=(1 2 3); echo ${a[n++]}; bash s$n.sh', // (runs s1.sh)
    'n=2; a=(1 2); echo ${#a[n=7]}; bash s$n.sh',
    'n=2; declare a[n=7]=x; bash s$n.sh',
    'n=2; a=(1); printf "%s" ${a[n=7]}; bash s$n.sh',
    'n=2; [ ${a[n=7]:-0} -eq 0 ]; bash s$n.sh',
    'n=2; x=abcdef; echo ${x[n=3]}; bash s$n.sh', // (zsh and bash)
    'n=2; x=abcdef; echo $x[n=3]; bash s$n.sh', // (zsh reads the bare subscript)
    'n=2; x=abcdef; echo ${a[ n = 7 ]}; bash s$n.sh',
  ]);
});

test('a subscript that only reads, and a glob class, assign nothing', () => {
  for (const c of [
    'n=2; a=(1 2); echo ${a[1]} ${a[n]} ${#a[@]}; bash s$n.sh',
    'n=2; ls f[ab] g[0-9]; bash s$n.sh',
    'n=2; a[1]=x; echo ${a[1]}; bash s$n.sh',
    'n=2; echo ${a[$n]}; bash s$n.sh',
  ]) allow(c);
});

test('a substring offset is arithmetic: an assignment in it changes the name', () => {
  denyEach([
    'n=2; x=abcdefgh; echo ${x:n=3:1}; bash s$n.sh', // (bash)
    'n=2; x=abcdef; echo ${x:n=3}; bash s$n.sh',
    'n=2; x=abcdef; echo ${x: n=3 : 1}; bash s$n.sh',
    'n=2; a=(1 2 3 4); echo ${a[@]:n=1}; bash s$n.sh',
  ]);
});

test('${x:-default}, ${x:+alt}, ${x:?msg} and a harmless offset assign nothing', () => {
  for (const c of [
    'n=2; x=abcdef; echo ${x:1:2} ${x: -2} ${x:-n=7} ${x:+n=7}; bash s$n.sh',
    'n=2; echo ${x:-a=b}; bash s$n.sh',
  ]) allow(c);
});

test('blanks and ++ in an arithmetic the git guard did not read', () => {
  denyEach([
    'n=2; echo $(( n = 7 )); bash s$n.sh',
    'n=0; ((n++)); bash s$n.sh', // (runs s1.sh)
    'n=0; echo $((n++)); bash s$n.sh',
    'n=2; while ((n++ < 7)); do :; done; bash s$n.sh', // (runs s8.sh)
    'n=2; echo $[n=7]; bash s$n.sh',
    'n=2; : $((n+=5)); bash s$n.sh',
    '(( n += 7 )); bash s$n.sh', // (the name was never set)
    'let n+=7; bash s$n.sh',
    'n=2; for ((n=0; n<7; n++)); do :; done; bash s$n.sh',
    'for ((n=0; n<7; n++)); do :; done; bash s$n.sh',
  ]);
});

test('arithmetic that only reads a name, or assigns another one, changes nothing for the script choice', () => {
  for (const c of [
    'n=2; echo $((n+5)); bash s$n.sh',
    'n=2; (( n > 1 )); bash s$n.sh',
    'n=2; i=0; ((i++)); echo $i; bash s$n.sh',
    'n=2; for ((i=0; i<3; i++)); do :; done; bash s$n.sh',
    'n=2; m=$((n*2)); bash s$n.sh',
  ]) allow(c);
});

test('n+= appends: the name is no longer the text it was given', () => {
  denyEach([
    'n=s; n+=7.sh; bash $n',
    'n=s; n+=7; bash ${n}.sh',
    'n=s; export n+=7; bash ${n}.sh', // (bash)
    'n=s; declare n+=7; bash ${n}.sh', // (bash)
    'n=s; readonly n+=7; bash ${n}.sh',
    'f() { local n=s; n+=7; bash ${n}.sh; }; f',
  ]);
});

test('an append to a name that picks nothing is no problem', () => {
  for (const c of [
    'args=a; args+=b; echo $args; bash s2.sh',
    'n=2; out=x; out+=y; echo $out; bash s$n.sh',
  ]) allow(c);
});

test('a name with the integer or float attribute holds the value of an arithmetic', () => {
  denyEach([
    'declare -i n; n=2+5; bash s$n.sh',
    'integer n; n=2+5; bash s$n.sh', // (zsh)
    'float n; n=2+5; bash s${n%.*}.sh', // (zsh: 7.0000)
    'typeset -F n; n=2+5; bash s${n%.*}.sh', // (zsh)
    'typeset -E n; n=2+5; bash s${n%.*}.sh', // (zsh)
  ]);
  for (const c of [
    'declare -i m; m=2+5; n=2; bash s$n.sh', // (another name)
  ]) allow(c);
  // (the git guard refuses every zsh binder of names it does not read: `integer m` binds any name for it, as before)
  const r = both('integer m; m=2+5; n=2; bash s$n.sh', SPEC);
  assert.equal(r.files.decision, 'allow', r.files.reason);
});

test('an unquoted heredoc or here-string expands $(( )) in the current shell: its body is scanned like command text', () => {
  denyEach([
    'n=2; : <<EOF\n$(( n = 7 ))\nEOF\nbash s$n.sh',
    'n=2; : <<EOF\n$((n+=5))\nEOF\nbash s$n.sh',
    'n=2; : <<EOF\n${a[n=7]}\nEOF\nbash s$n.sh',
    'n=2; : <<-EOF\n\t$(( n = 7 ))\n\tEOF\nbash s$n.sh',
    'n=2; { cat >/dev/null; } <<EOF\n$((n+=5))\nEOF\nbash s$n.sh',
    'n=0; : <<< "$(( n++ ))"; bash s$n.sh', // (runs s1.sh)
    'n=2; : <<< $(( n += 5 )); bash s$n.sh',
    'n=; : <<EOF\n${n:=7}\nEOF\nbash s$n.sh',
    'n=; : <<< "${n:=7}"; bash s$n.sh',
  ]);
});

test('a QUOTED heredoc delimiter makes the body data: arithmetic written in it assigns nothing (also on main)', () => {
  for (const c of [
    "n=2; : <<'EOF'\n$((n=7))\nEOF\nbash s$n.sh",
    'n=2; : <<\\EOF\n$(( n += 7 ))\nEOF\nbash s$n.sh',
    'n=2; : <<"EOF"\n${a[n=7]}\n[[ n=7 -eq 7 ]]\nEOF\nbash s$n.sh',
    "n=2; cat <<'EOF'\n$((n++)) n+=5 let n=7\nEOF\nbash s$n.sh",
  ]) allow(c);
});

test('the change is found in a script the line runs, too', () => {
  const nested = { 'run.sh': 'n=2\n[[ n=7 -eq 7 ]]\nbash s$n.sh\n', 'run2.sh': 'declare n=2\n(( n += 5 ))\nbash s$n.sh\n', 'run3.sh': 'n=2; : <<EOF\n$((n+=5))\nEOF\nbash s$n.sh\n', ...SPEC };
  deny('bash run.sh', nested);
  deny('bash run2.sh', nested);
  deny('bash run3.sh', nested);
  allow('bash ok.sh', { 'ok.sh': 'n=2\n[[ $n -eq 2 ]]\nbash s$n.sh\n', ...SPEC });
});

test('a name assigned through another name ((( $m = 7 )), m holding n) may be any name', () => {
  denyEach([
    'm=n; n=2; (( $m = 7 )); bash s$n.sh',
    'm=n; n=2; echo $(( $m += 5 )); bash s$n.sh',
  ]);
});

// ---- the readings of nested scripts share one allowance ------------------------------------------------------------------------
// Why: t7 judges a text once per value of a name it assigns twice (16 readings) and the loop words (64) -- and again for every script it runs, so three nested scripts that each assign
// four names twice and loop over eight words were 1024^3 evaluations and ended at the 5 s deadline (main: 0.45 s, allowed). The readings of a whole evaluation share one allowance and
// the check is refused when it is spent (about 0.5 s); the same chain with little to read is still allowed.
const chain = (twice, depth, words, names = 4) => {
  const out = {};
  for (let i = 1; i <= depth; i++) {
    const n = ['a', 'b', 'c', 'd'].map((x) => x + i);
    n.length = 4; // (the call passes all four; the assignments below are for the first `names`)
    const asg = n.slice(0, names).map((x) => (twice ? `${x}=x1; ${x}=x2` : `${x}=x1`)).join('; ');
    const next = i < depth ? `bash F${i + 1}.sh $${n[0]} $${n[1]} $${n[2]} $${n[3]}` : `echo $${n[0]} $${n[1]} $${n[2]} $${n[3]}`;
    out[`F${i}.sh`] = `${asg}\nfor f in ${words}; do echo $${n[0]} $f; done\n${next}\n`;
  }
  return out;
};
test('three nested scripts that each assign four names twice and loop over eight words are refused at once, not at the deadline', () => {
  const t0 = Date.now();
  const r = files('bash F1.sh', fakeFs(PROJ, chain(true, 3, 'w1 w2 w3 w4 w5 w6 w7 w8')));
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /too many readings/, r.reason);
  assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0} ms`);
});
test('a chain with a few readings is still allowed', () => {
  assert.equal(files('bash F1.sh', fakeFs(PROJ, chain(true, 2, 'w1 w2', 2))).decision, 'allow'); // (two names twice, two words: 8 readings a level)
  assert.equal(files('bash F1.sh', fakeFs(PROJ, chain(false, 3, 'w1 w2 w3 w4 w5 w6 w7 w8'))).decision, 'allow'); // (once-assigned names: only the 8 words of each level)
  assert.equal(git('bash F1.sh', fakeFs(GIT_ROOT, chain(false, 3, 'w1 w2 w3 w4 w5 w6 w7 w8'))).decision, 'allow');
});
