// Why (issue #81, after #75): a name assigned once, or a literal loop variable, is judged by its values ("readings"). A quick text scan in onceAssignedNames
// counts the mentions of the name; when it disagrees with the parser the name is "assigned more than once" and the line is refused. The 21-day replay found
// three kinds of false alarm, each allowed below next to a twin that must stay refused:
//   1. `awk -v n=$n …`: awk's own `-v NAME=` counted as a second shell assignment.
//   2. A bare letter in text the shell does not run as a command: a regex escape `\s` / `\n` in quoted text, an arithmetic read `$((n+6))`.
//   3. `withoutLiteralText` gave up (null) on `"$((n+6))"` inside double quotes, so the readings were off for the whole line.
// The file system is faked; guarded text only lives in fake file contents (as in guard-false-positives-56.test.mjs).
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
const git = (command, fsOpts, o = {}) => evaluateGitCommand(command, {
  cwd: GIT_ROOT, home: '/home/u', currentBranch: () => 'agent/x', pushDestination: () => null, issueLabels: () => [], ...fsOpts, ...o,
});
const files = (command, fsOpts, o = {}) => evaluateBashForFiles(command, {
  home: '/home/u', env: {}, platform: 'linux', realpath: (p) => p, cwd: PROJ, ...fsOpts, existsSync: fsOpts.pathExists, ...o,
});
const DIRS = ['sub', 'src', 'd', 'scripts'];
function both(command, spec = {}) {
  const mk = (bad, ok) => Object.fromEntries(Object.entries(spec).map(([k, v]) => [k, v === 'bad' ? bad : v === 'ok' ? ok : v]));
  return {
    git: git(command, fakeFs(GIT_ROOT, mk(BAD_GIT, 'git status'), DIRS)),
    files: files(command, fakeFs(PROJ, mk(BAD_FILES, 'echo hi'), DIRS)),
  };
}
const allowBoth = (command, spec) => {
  const r = both(command, spec);
  assert.equal(r.git.decision, 'allow', `git: ${command} -> ${r.git.reason}`);
  assert.equal(r.files.decision, 'allow', `files: ${command} -> ${r.files.reason}`);
};
// (the denial twins are judged by the git guard only: the scan lives in git-policy.mjs. The files guard has its own engine and allows `$((n+=6))`, `$((n++))` and
// `$(( n = 7 ))` before a script name today; that is a separate gap, out of this fix)
const denyGit = (command, spec) => {
  const r = both(command, spec);
  assert.equal(r.git.decision, 'deny', `git: ${command} -> allowed`);
};
// run.sh, s7.sh, s9.sh hold a guarded command; the others are clean
const SPEC = {
  'run.sh': 'bad', 'ok.sh': 'ok', 's1.sh': 'ok', 's2.sh': 'ok', 's7.sh': 'bad', 's9.sh': 'bad', 'a.mjs': 'console.log(1)\n', 'src/a.ts': 'export const a = 1\n', 'x.txt': 'x\n',
  'scripts/a.mjs': '// a\n', 'scripts/b.mjs': '// b\n',
};

// ---- 1. awk -v NAME= ------------------------------------------------------------------------------------------------------------

test('#81: awk -v NAME=… is awk\'s variable, not a second shell assignment', () => {
  for (const cmd of [
    "for f in a b; do awk -v f=$f '{print}' x.txt; done",
    "for f in a b; do awk -v f=\"$f\" '{print f}' x.txt; done",
    "for f in a b; do awk -F, -v g=1 -v f=$f '{print}' x.txt; done",
    "for f in a b; do cat x.txt | awk -v f=$f '{print}'; done",
    "F=ok.sh; awk -v F=1 '{print}' x.txt; bash $F",
  ]) allowBoth(cmd, SPEC);
});

test('#81: awk -v does not hide a shell assignment of the same name elsewhere on the line', () => {
  for (const cmd of [
    "true && f=ok.sh; awk -v f=1 '{print}' x.txt; : ${f:=run.sh}; bash $f", // (a default assigns it)
    "true && f=ok.sh; awk -v f=1 '{print}' x.txt; f=run.sh; bash $f", // (a second plain assignment)
    "true && f=ok.sh; awk -v f=1 '{print}' x.txt; f[0]=run.sh; bash $f", // (an array element)
    "true && f=ok.sh; awk -v g=1 '{print}' x.txt && f=run.sh; bash $f", // (after && : a new command, not awk's option)
    "true && f=ok.sh; awk -v g=1 '{print}' x.txt | f=run.sh; bash $f",
    "true && f=ok.sh; awk -v f=1 '{print}' x.txt; read f; bash $f",
    "true && f=ok.sh; sort -v f=1 x.txt; f=run.sh; bash $f", // (not awk)
    "true && f=ok.sh; : $((f=0)); awk -v f=1 '{print}' x.txt; bash $f.sh",
    "for f in ok.sh; do awk -v f=1 '{print}' x.txt; bash $f; done; f=run.sh; bash $f",
  ]) denyGit(cmd, SPEC);
});

// ---- 2. a bare letter that is no assignment ---------------------------------------------------------------------------------------

test('#81: a regex escape in quoted text is no mention of a shell name', () => {
  for (const cmd of [
    'for s in a b; do sed -n 1,40p scripts/$s.mjs | grep -E "^\\s*//"; done',
    'for n in a b; do sed -n 1,40p scripts/$n.mjs | grep -E "x\\n"; done',
    'for n in a b; do sed -n 1,40p scripts/$n.mjs | grep -E x\\n; done',
    "for s in a b; do sed -n 1,40p scripts/$s.mjs | grep -E '^\\s*//'; done",
    'for s in a b; do sed -n 1,40p scripts/$s.mjs | grep -E "\\s\\s"; done',
  ]) allowBoth(cmd, SPEC);
});

test('#81: a backslash does not hide a real assignment: only the letter it escapes is text', () => {
  for (const cmd of [
    'true && n=ok.sh; grep -E "a\\n" x.txt; : ${n:=run.sh}; bash $n', // (the \n is text; the default is the second assignment)
    'true && n=ok.sh; grep -E "a\\n" x.txt; (n=run.sh); bash $n',
    'true && n=ok.sh; grep -E "a\\n" x.txt; n=run.sh; bash $n',
    'true && n=ok.sh; grep -E a\\n x.txt; n[0]=run.sh; bash $n',
    'true && n=ok.sh; echo \\\nn=run.sh; bash $n', // (a backslash-newline joins lines: here n=run.sh is an argument word, yet the scan must not trust it)
    'true && n=ok.sh; echo "\\n"\nn=run.sh\nbash $n', // (a real newline after the text: n=run.sh is a command of its own)
    'true && n=ok.sh; echo "\\\\"; n=run.sh; bash $n', // (an escaped backslash ends nothing)
    'true && n=ok.sh; echo \\\\n=1; read n; bash $n',
  ]) denyGit(cmd, SPEC);
});

test('#81: an arithmetic read $((n+1)) is no assignment', () => {
  for (const cmd of [
    'for n in 1 2; do echo $((n+1)); done',
    'for n in 1 2; do echo $(( n + 1 )) $((2*n)) $((n<=2)) $((n==1)) $((n!=1)) $((n>1?n:3)); done',
    'for n in 1 2; do echo $(((n+1)*2)); done',
    'for n in 1 2; do echo $((n+1)) $((n-1)) $((1 - -n)) $((n<<2)) $((n>>1)) $((n&1)) $((n|1)) $((n^1)); done',
    'for n in 1 2; do sed -n "1,$((n+1))p" src/a.ts; done',
  ]) allowBoth(cmd, SPEC);
});

test('#81: an arithmetic assignment changes the name: every form stays refused', () => {
  // (s7.sh holds a guarded command: n=1 picks s1.sh, the arithmetic assignment makes it s7.sh)
  for (const cmd of [
    'true && n=1; : $((n=7)); bash s$n.sh',
    'true && n=1; : $(( n = 7 )); bash s$n.sh',
    'true && n=1; : $((n+=6)); bash s$n.sh',
    'true && n=1; : $(( n += 6 )); bash s$n.sh',
    'true && n=1; : $((n*=7)); bash s$n.sh',
    'true && n=1; : $((n**=7)); bash s$n.sh',
    'true && n=1; : $((n<<=3)); bash s$n.sh',
    'true && n=8; : $((n--)); bash s$n.sh',
    'true && n=6; : $((n++)); bash s$n.sh',
    'true && n=6; : $(( n ++ )); bash s$n.sh',
    'true && n=6; : $((++n)); bash s$n.sh',
    'true && n=6; : $(( ++ n )); bash s$n.sh',
    'true && n=8; : $((--n)); bash s$n.sh',
    'true && n=1; : $((1 + (n=6)+1)); bash s$n.sh',
    'true && n=1; : $((m=2, n=7)); bash s$n.sh',
    'true && n=1; : $((5 > 3 ? n=7 : 2)); bash s$n.sh',
    'true && n=1; : "$((n=7))"; bash s$n.sh', // (inside double quotes)
    'true && n=1; : "$n,$((n+=6))"; bash s$n.sh',
    'for n in 1; do : $((n=7)); bash s$n.sh; done',
    'true && n=1; : $((n[0]=7)); bash s$n.sh', // (an array element)
    'true && n=1; : $((n && n=7)); bash s$n.sh',
    'true && n=1; : $((n &&= 7)); bash s$n.sh',
    'true && n=8; : $((n-- - 1)); bash s$n.sh',
    'true && n=1; : $((0 || n||=7)); bash s$n.sh',
    'true && n=1; : $((n^^=7)); bash s$n.sh',
    'true && n=1; : $((n=7)) $((n+1)); bash s$n.sh', // (an assignment next to a read)
    'true && n=1; : $((n+1)) $((n=7)); bash s$n.sh',
    'true && n=1; : $((n+1)); : $((n=7)); bash s$n.sh', // (a read, then a separate assignment)
  ]) denyGit(cmd, SPEC);
});

test('#81: a name in text that merely looks like arithmetic keeps its denial', () => {
  for (const cmd of [
    'true && n=ok.sh; : $((true); read n); bash $n', // (a $( (…) …) command substitution, not arithmetic: read binds n)
    'true && n=ok.sh; : $((true); n=run.sh); bash $n',
  ]) denyGit(cmd, SPEC);
});

test('#81: a loop word equal to the loop name is a word, not a mention of the name', () => {
  for (const cmd of [
    'for f in b c d e f; do node a.mjs $f; done',
    'for f in f; do echo $f; done',
  ]) allowBoth(cmd, SPEC);
  // …but a loop word that really assigns, or a second `for` over the name, stays refused
  for (const cmd of [
    'for f in ok.sh f=run.sh; do bash $f; done',
    'for f in ok.sh; do bash $f; done; for f in run.sh; do bash $f; done',
    'for f in ok.sh f; do bash $f; f=run.sh; done',
    'for f in ok.sh f; do bash $f; : ${f:=run.sh}; done',
  ]) denyGit(cmd, SPEC);
});

// ---- 3. withoutLiteralText on "$((…))" inside double quotes ---------------------------------------------------------------------------

test('#81 scanner: arithmetic inside double quotes is followed, an unclear one still gives up', () => {
  // (kept as written: the caller judges the name in it)
  assert.equal(withoutLiteralText('sed -n "$n,$((n+6))p" a.ts'), 'sed -n "$n,$((n+6))p" a.ts');
  assert.equal(withoutLiteralText('echo "$((n+6))" \'x y\'', { dqData: true }), 'echo "$((n+6))"      ');
  assert.equal(withoutLiteralText('echo "$(((n+1)*2)) a $b"', { dqData: true }), 'echo "$(((n+1)*2))   $b"');
  assert.equal(withoutLiteralText("echo \"$((n+6)) $(gh pr view $n --jq '.x')\" 'q'"), 'echo "$((n+6)) $(gh pr view $n --jq     )"    ');
  // an arithmetic that cannot be told from a subshell, or holds a quote / backslash / backtick, or is not closed, gives up as before
  for (const t of ['echo "$((echo hi) )"', 'echo "$((true); echo hi)"', 'echo "$((n+\'1\'))"', 'echo "$((n+`x`))"', 'echo "$((n+6)"', 'echo "$((n+\\6))"']) {
    assert.equal(withoutLiteralText(t), null, t);
  }
});
