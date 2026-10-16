// Why (issue #81, task t3): since #75 the git guard judges a literal loop variable one word at a time ("readings"), but three kinds of loop list were still refused
// although nothing about them is risky. Each test below is a shape from the replay of 21 days of transcripts, allowed now, next to its malicious twin that must stay refused:
//   1. A list that is a command substitution (`for l in $(node -e '…(…)…'); do npm run -s $l; done`) was recognised by a paren-counting pattern that gave up at the third
//      level of parentheses. The PARSER now says which word is exactly one substitution (cmd.subWords). Such a list is one value only known at run time, with the same limit as
//      `for p in $(lsof -t …)`: refused only when the line mentions a guarded operation. Beside literal words (`$(git branch …) x`) the literal words are read one by one.
//   2. A literal word the parser has unquoted is plain text: a space, parentheses, `#`, an empty word, a leading `~/` (the home directory).
//   3. (not done) A list that is a split variable (`L=$(echo a b); for f in ${=L}; do …`) stays refused: an existing test documents it, see the end of this file.
// The file system is faked; guarded text only lives in fake file contents. The files guard has loop handling of its own (unchanged here); these tests judge the git guard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname, basename } from 'node:path';
import { evaluateGitCommand } from '../pipeline/hooks/lib/git-policy.mjs';
import { simpleCommands } from '../pipeline/hooks/lib/shell-parse.mjs';

function fakeFs(root, files, dirs = []) {
  const abs = (p) => resolve(root, p);
  const F = Object.fromEntries(Object.entries(files).map(([k, v]) => [abs(k), v]));
  const D = new Set([root, '/home/u', ...dirs.map(abs)].map((p) => resolve(p)));
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
const BAD = 'git push origin main';
const git = (command, files) => evaluateGitCommand(command, {
  cwd: GIT_ROOT, home: '/home/u', currentBranch: () => 'agent/x', pushDestination: () => null, issueLabels: () => [], ...fakeFs(GIT_ROOT, files, ['src', 'd']),
});
const allow = (command, files = {}) => {
  const r = git(command, files);
  assert.equal(r.decision, 'allow', `${command} -> ${r.reason}`);
};
const deny = (command, files = {}) => {
  const r = git(command, files);
  assert.equal(r.decision, 'deny', `${command} -> allowed`);
  return r;
};
const PKG = { 'package.json': '{"scripts":{"lint:a":"node a.mjs","lint:b":"node b.mjs"}}' };
const SPEC = { 'run.sh': BAD, 'ok.sh': 'echo ok\n', 'a.mjs': 'console.log(1)\n', 'chk.mjs': 'console.log(1)\n', 'src/a.ts': 'export const a = 1\n', ...PKG };

// ---- 1. a list that is a command substitution ---------------------------------------------------------------------------------

test('#81 A1: a list that is one command substitution is recognised from the parser\'s word, whatever it holds', () => {
  for (const cmd of [
    // (the replay's case: quotes, and parentheses three levels deep)
    `for l in $(node -e 'console.log(Object.keys(require("./package.json").scripts).filter(k=>k.startsWith("lint:")).join(" "))'); do npm run -s $l; done`,
    'for l in $(node -e \'console.log((((1))))\'); do npm run -s $l; done',
    'for p in $(lsof -t -i :4000 | head -3); do ps -p $p; done',
    'for f in `ls src | grep "(a)"`; do node chk.mjs $f; done',
    'for f in "$(git branch -r --format=\'%(refname:short)\')"; do node chk.mjs $f; done',
    'for l in $(cat list.txt); do npm run -s $l; done',
    // a list of literal words and one substitution: the literal words are read one by one, the substitution is one run-time value
    "for f in $(git branch -r --format='%(refname:short)') x; do node chk.mjs $f; done",
    'for f in x $(git branch -r | head -3) y; do git show $f; done',
  ]) allow(cmd, SPEC);
});

test('#81 A1 twins: a computed list keeps its limit, and a word that is not exactly one substitution is no computed list', () => {
  // the substitution can print run.sh: refused when the line mentions a guarded operation (the known limit of `bash $(ls *.sh)`)
  deny(`for f in $(node -e 'console.log("run.sh")'); do bash $f; done; echo push`, SPEC);
  deny('for f in $(echo run.sh); do bash $f; echo push; done', SPEC);
  // what the substitution prints reaches git as a ref: a push to an unknown ref is refused as it was
  deny(`for b in $(node -e 'console.log("main")'); do git push origin $b; done`, SPEC);
  deny('for b in $(git branch -r | head -3); do git push origin $b; done', SPEC);
  // the literal words beside it are read one by one: run.sh is judged
  deny('for f in $(cat list.txt) run.sh; do bash $f; done', { ...SPEC, 'list.txt': 'ok.sh' });
  deny("for f in $(git branch -r --format='%(refname:short)') run.sh; do bash $f; done", SPEC);
  deny('for b in $(git branch -r | head -3) main; do git push origin $b; done', SPEC);
  // not exactly one substitution: text around it, or two of them (stay refused as before)
  deny('for f in $(echo a)x; do node chk.mjs $f; done', SPEC);
  deny('for f in $(echo a)$(echo b); do node chk.mjs $f; done', SPEC);
  deny('for f in x$(echo a); do node chk.mjs $f; done', SPEC);
});

test('#81 parser: subWords holds the words that are exactly one command substitution', () => {
  const one = (line) => [...(simpleCommands(line, {}).find((c) => c.argv[0] === 'for')?.subWords ?? [])];
  assert.deepEqual(one('for f in $(a (b (c (d)))) x; do :; done'), ['$(a (b (c (d))))']);
  assert.deepEqual(one('for f in "$(a b)"; do :; done'), ['$(a b)']);
  assert.deepEqual(one('for f in `a b`; do :; done'), ['`a b`']);
  assert.deepEqual(one('for f in $(a)x; do :; done'), []);
  assert.deepEqual(one('for f in "x$(a)"; do :; done'), []);
  assert.deepEqual(one('for f in "$(a)$(b)"; do :; done'), []);
  assert.deepEqual(one('for f in $(a)$(b); do :; done'), []);
  assert.deepEqual(one('for f in $"$(a)"; do :; done'), []);
  assert.deepEqual(one('for f in a b; do :; done'), []);
});

// ---- 2. a literal word the parser has unquoted --------------------------------------------------------------------------------

test('#81 A2: a quoted word with a space or parentheses, an empty word, a `#`, a leading `~/` are plain loop text', () => {
  for (const cmd of [
    'for f in "a b.ts" c.ts; do node chk.mjs "$f"; done',
    'for f in "ok file.sh" "ok 2.sh"; do bash "$f"; done',
    'for f in "src/app/(s)/a.ts" b.ts; do node chk.mjs "$f"; done',
    'for f in "src/(a)/ok.sh" ok.sh; do bash "$f"; done',
    "for f in '' x; do node chk.mjs \"$f\"; done",
    "for c in '#0ea5e9,#8b5cf6' x; do node chk.mjs \"$c\"; done",
    'for r in "abc123~1" "abc123^"; do git show "$r"; done',
    'for f in ~/a.ts ~/b.ts; do node chk.mjs $f; done',
    'for f in ~/ok.sh ~/ok2.sh; do bash $f; done',
  ]) allow(cmd, { ...SPEC, 'ok file.sh': 'echo ok\n', 'ok 2.sh': 'echo ok\n', 'src/(a)/ok.sh': 'echo ok\n', '/home/u/ok.sh': 'echo ok\n', '/home/u/ok2.sh': 'echo ok\n' });
});

test('#81 A2 twins: the word is still the script that runs, or not text at all', () => {
  const files = { ...SPEC, 'ok file.sh': 'echo ok\n', 'run file.sh': BAD, 'src/(a)/ok.sh': 'echo ok\n', 'src/(a)/run.sh': BAD, '/home/u/ok.sh': 'echo ok\n', '/home/u/run.sh': BAD, '~/ok.sh': BAD };
  deny('for f in "ok file.sh" run.sh; do bash "$f"; done', files);
  deny('for f in "run file.sh"; do bash "$f"; done', files);
  deny('for f in "run file.sh"; do bash $f; done', files);
  deny('for f in "src/(a)/ok.sh" run.sh; do bash "$f"; done', files);
  deny('for f in "src/(a)/run.sh"; do bash "$f"; done', files);
  deny('for f in ~/ok.sh ~/run.sh; do bash $f; done', files);
  deny('for f in ~/run.sh; do bash $f; done', files);
  // an empty word beside the script
  deny("for f in '' run.sh; do bash $f; done", files);
  deny("for f in '' ok.sh; do bash $f; done; for g in run.sh; do bash $g; done", files);
  // a quoted `~/` is the literal text (a directory named ~ here, holding the bad script), not the home directory: never read as the home
  deny('for f in "~/ok.sh"; do bash "$f"; done', files);
  // another user's home, or a tilde the shell expands, is not text
  deny('for f in ~root/run.sh; do bash $f; done', { ...files, '/root/run.sh': BAD });
  deny('for f in ~+/run.sh; do bash $f; done', files);
  // the word is a command: refused where it runs
  deny('for c in "git push origin main"; do eval "$c"; done', files);
  deny('for c in "git push origin main"; do bash -c "$c"; done', files);
  // an expansion, a substitution, braces, a backslash or a quote in the word is not text
  deny('for f in "$(echo run.sh)x" ok.sh; do bash "$f"; done', files);
  deny('for f in "{run,ok}.sh"; do bash "$f"; done', files);
  deny("for f in 'r\\un.sh'; do bash \"$f\"; done", files);
});

// ---- 3. a list that is a split variable: still refused -------------------------------------------------------------------------

// Decision (task t3): `F=$(cmd); for f in ${=F}; do …` is NOT loosened. test/guard-false-positives-56.test.mjs documents it as refused (`sed -i.bak … "$f"` over `${=F1}`), and the
// list names whatever a variable holds, a script among them (`L=$(cat list.txt); for f in ${=L}; do bash $f; done` runs run.sh when list.txt names it). These pin the refusals.
test('#81 A3: a loop over a split variable or an array stays refused', () => {
  const files = { ...SPEC, 'list.txt': 'ok.sh run.sh' };
  for (const cmd of [
    'L=$(echo a b); for f in ${=L}; do node chk.mjs $f; done',
    'L=$(cat list.txt); for f in ${=L}; do bash $f; done',
    "L='ok.sh run.sh'; for f in ${=L}; do bash $f; done",
    'scripts=(ok.sh run.sh); for s in "${scripts[@]}"; do bash "$s"; done',
    'L=main; for b in ${=L}; do git push origin $b; done',
    'F=$(cat list.txt); for f in ${(f)F}; do node chk.mjs $f; done',
    'f=$(echo a); for f in ${=f}; do node chk.mjs $f; done',
  ]) deny(cmd, files);
});
