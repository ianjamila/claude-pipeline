// Why (issue #81, tasks t5 + t6): the git guard judges a once-assigned name and a literal loop variable one value at a time ("readings"). Two shapes of the 21-day replay
// were still refused although nothing about them is risky:
//   t5 (bucket E, over the cap of 64 readings): the readings of independent names were MULTIPLIED, so three nested loops over 5, 9 and 3 words (135 readings) were
//       refused though no command reads two of the names. Names that cannot meet are now counted by SUM. They can meet when a command reads both, when the line holds
//       any command that could run a script, write a file or change the state the others are judged in (the script may read the line's names; a write may be the script
//       a later command runs), and always when a name is built from another. A line with such a command keeps the product, as before. The cap still bites on one
//       name's own count (64 words plus a bad script is 65) and on the sum.
//   t6 (bucket C): one name used by two or three `for` loops one after another (`for n in 1 2; do node a.mjs $n; done; for n in 3 4; do node b.mjs $n; done`) was
//       "assigned more than once". The name now takes every word of every one of the loops (and stays unset where a loop may not run): a use anywhere sees one of them,
//       so a bad word in ANY of the loops is found at every use. A nested loop that reuses the name, a second binder (`read n`, `n=x`), a loop in a subshell or pipe
//       and a use before the first loop keep the denial.
// Each shape is allowed now, next to its malicious twins (a fake script that holds a guarded command), which must stay refused. The file system is faked; guarded text only
// lives in fake file contents.
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
const BAD_FILES = 'echo x > ~/.claude/settings.json';
const git = (command, fsOpts, o = {}) => evaluateGitCommand(command, {
  cwd: GIT_ROOT, home: '/home/u', currentBranch: () => 'agent/x', pushDestination: () => null, issueLabels: () => [], ...fsOpts, ...o,
});
const files = (command, fsOpts, o = {}) => evaluateBashForFiles(command, {
  home: '/home/u', env: {}, platform: 'linux', realpath: (p) => p, cwd: PROJ, ...fsOpts, existsSync: fsOpts.pathExists, ...o,
});
const DIRS = ['sub', 'src', 'd'];
function both(command, spec = {}) {
  const mk = (bad, ok) => Object.fromEntries(Object.entries(spec).map(([k, v]) => [k, v === 'bad' ? bad : v === 'ok' ? ok : v]));
  return {
    git: git(command, fakeFs(GIT_ROOT, mk(BAD_GIT, 'git status'), DIRS)),
    files: files(command, fakeFs(PROJ, mk(BAD_FILES, 'echo hi'), DIRS)),
  };
}
const allowGit = (command, spec) => {
  const r = both(command, spec);
  assert.equal(r.git.decision, 'allow', `git: ${command} -> ${r.git.reason}`);
};
const denyGit = (command, spec) => {
  const r = both(command, spec);
  assert.equal(r.git.decision, 'deny', `git: ${command} -> allowed`);
  return r.git;
};
const SPEC = { 'run.sh': 'bad', 'ok.sh': 'ok', 'a.mjs': 'console.log(1)\n', 'b.mjs': 'console.log(2)\n', 'sub/run.sh': 'bad' };

// ---- t6: the same name in loops one after another -----------------------------------------------------------------------------

test('t6: the same loop name used by loops one after another reads each word once and is allowed when every word is harmless', () => {
  for (const cmd of [
    'for n in 1 2; do node a.mjs $n; done; for n in 3 4; do node b.mjs $n; done', // (the replay's shape)
    'for n in 1 2; do node a.mjs $n; done; for n in 3 4; do node b.mjs $n; done; for n in 5; do node a.mjs $n; done',
    'for n in 1 2; do bash ok.sh $n; done; for n in 3 4; do bash ok.sh $n; done',
    'for n in 1 2; do :; done; for n in 3 4; do :; done; echo $n', // (a use after the loops sees the last word of the last)
    'B=app; for f in $B/a $B/b; do cat $f; done; for f in $B/c; do wc -l $f; done', // (words built from another name)
    'for n in 1 2; do [ $n = 1 ] && continue; node a.mjs $n; done; for n in 3 4; do [ $n = 3 ] && break; node b.mjs $n; done',
    'for f in a.mjs b.mjs; do node $f; done; for f in b.mjs a.mjs; do node $f; done; node $f',
    'true && for n in 1 2; do node a.mjs $n; done; for n in 3 4; do node b.mjs $n; done', // (the first loop may not run: the name may also be unset)
  ]) allowGit(cmd, SPEC);
});

test('t6 twins: a bad word in any of the loops, a second binder, a nested or hidden loop and a use before the first loop stay refused', () => {
  for (const cmd of [
    'for n in 1 2; do node a.mjs $n; done; for n in ok run; do bash $n.sh; done', // (the second loop's words include run.sh)
    'for n in ok run; do bash $n.sh; done; for n in 1 2; do node a.mjs $n; done', // (the first loop's)
    'for n in ok; do :; done; for n in 1; do :; done; for n in run; do :; done; bash $n.sh', // (a use after the loops; the last loop holds run)
    'for n in run; do :; done; for n in ok; do :; done; bash $n.sh', // (…a bad word in the first loop, a use after both)
    'for n in ok; do bash $n.sh; done; bash $n.sh; for n in run; do :; done', // (a use between the loops)
    'for n in a; do n=run; bash $n.sh; done; for n in b; do :; done', // (the body assigns the name too)
    'for n in a; do :; done; n=run; for n in b; do bash $n.sh; done',
    'for n in ok; do :; done; read n; for n in 1; do bash $n.sh; done', // (read binds it)
    'for n in ok; do :; done; for n in 1; do :; done; : ${n:=run}; bash $n.sh', // (a default assigns it)
    'for n in a b; do for n in c d; do node a.mjs $n; done; done', // (a nested loop that reuses the name: refused as before)
    'for n in ok; do :; done; (for n in run; do :; done); bash $n.sh', // (the second loop is in a subshell)
    'for n in ok; do :; done; for n in run; do :; done | cat; bash $n.sh', // (…in a pipe)
    'for n in ok; do :; done; for n in run; do :; done & bash $n.sh', // (…in the background)
    'bash $n.sh; for n in ok; do :; done; for n in 1; do :; done', // (a use before the first loop sees the old value)
    'for n in ok; do :; done; for n in $n.sh run; do :; done; bash $n.sh', // (a loop word reads the name itself)
    'for n in ok run; do break; done; for n in 1; do :; done; bash $n.sh',
  ]) denyGit(cmd, SPEC);
});

// ---- t5: independent names are counted by sum ---------------------------------------------------------------------------------

const words = (n, p = 'w') => Array.from({ length: n }, (_, i) => `${p}${i + 1}`).join(' ');

test('t5: names that cannot meet are counted by sum, not product', () => {
  for (const cmd of [
    // three nested loops over 5, 9 and 3 words (135 readings multiplied), each command reads its own name
    `for a in ${words(5)}; do echo $a; for b in ${words(9)}; do echo $b; for c in x y z; do echo $c; done; done; done`,
    // two loops one after another over 6 and 19 words, a command substitution of reading tools in each (the replay's ps / lsof row)
    `for p in ${words(6, '1')}; do echo "$p: $(ps -o ppid=,etime= -p $p | cut -c1-80)"; done; for c in ${words(19, '2')}; do echo "claude $c $(lsof -a -p $c -d cwd -Fn | grep ^n | cut -c2-)"; done`,
    // seven names that may or may not have been assigned (2 readings each: 128 multiplied)
    'true && A=a; true && B=b; true && C=c; true && D=d; true && E=e; true && F=f; true && G=g; echo $A; echo $B; echo $C; echo $D; echo $E; echo $F; echo $G',
    // three loops one after another with their own names
    `for a in ${words(10)}; do echo $a; done; for b in ${words(10, 'v')}; do echo $b; done; for c in ${words(10, 'q')}; do echo $c; done`,
  ]) allowGit(cmd, SPEC);
});

test('t5 twins: the cap still bites on one name and on the sum, names that meet are multiplied, and a line that can run a script keeps the product', () => {
  // one name: 64 harmless words and run.sh are 65 readings
  denyGit(`for f in ${words(64)} run.sh; do bash $f; done`, SPEC);
  denyGit(`for f in ${words(65)} run.sh; do echo $f; done; bash run.sh`, SPEC);
  // two names meet in one command: the one pair that gives run.sh is found
  denyGit('for a in r x; do for b in un.sh y; do bash $a$b; done; done', SPEC);
  denyGit('for a in r x; do echo $a; for b in un.sh y; do bash $a$b; done; done', SPEC);
  denyGit('for a in r x; do for b in un y; do bash $a$b.sh; done; done', SPEC);
  // a name built from another is judged with it
  denyGit('for a in r x; do for b in un y; do c=$a$b; bash $c.sh; done; done', SPEC);
  // the sum is capped too
  denyGit(`for a in ${words(40)}; do ps -p $a; done; for b in ${words(40, 'v')}; do ps -p $b; done`, SPEC); // (80 readings, nothing risky: refused for the count alone)
  allowGit(`for a in ${words(30)}; do ps -p $a; done; for b in ${words(30, 'v')}; do ps -p $b; done`, SPEC); // (…and 60 are fine)
  // a command that may run a script reads the line's names (a name the script shares), so the names are not independent: 64 and 2 words, product 128
  denyGit(`for a in ${words(40)}; do echo $a; done; for b in ok.sh run.sh; do bash $b; done`, SPEC);
  denyGit(`for a in ${words(8)}; do echo $a; done; for b in ${words(8, 'v')}; do echo $b; done; for c in ok.sh run.sh; do bash $c; done`, SPEC);
  // a write may be the script a later command runs (the file's name and text are built from the names)
  denyGit(`for a in ${words(10)}; do echo $a > f$a.sh; done; for b in ${words(10, 'v')}; do echo $b; done; for c in ${words(2, 'q')}; do bash f$c.sh; done`, SPEC);
  // a script that reads TWO of the line's names (the only bad pair is a=r, b=un.sh, which the first values of each never give): the line keeps the product
  const PAIR = { ...SPEC, 's.sh': 'bash $a$b\n' };
  const two = `for a in x r ${words(10)}; do ps -p $a; done; for b in y un.sh ${words(10, 'v')}; do ps -p $b; done`;
  allowGit(two, PAIR); // (without the script the two groups are counted by sum: 12 + 12 readings)
  denyGit(`${two}; bash s.sh`, PAIR);
  denyGit(`${two}; echo s.sh | xargs bash`, PAIR); // (a tool that is no plain reader and no script the guard opens by name: not split either)
  // a 3-deep count over the cap whose names meet at the innermost command
  denyGit(`for a in ${words(5)}; do for b in ${words(9)}; do for c in x y z; do ps -p $a$b$c; done; done; done`, SPEC);
});
