// Why (#352 R5-B1, R5-F1, R5-F2): a loop's body runs again after it ran, so a command early in the body meets what the body itself left behind (a branch, an alias, a push.default change): the
// second iteration of `for i in 1 2; do git push origin HEAD; npm run setup; done` pushes the branch `setup` switched to. The guard walked a body once, forward only, and its first fix for loop words
// replayed the WHOLE text from the whole line's differences, which lost a switch made before the loop (R5-B1) and refused changes made before or after it (R5-F1).
// Rule held here: every loop (for / while / until, with or without an unsure variable, on a line or in a script) is judged once from its entry state; what the BODY left relative to entry is
// the carry; when something was left the BODY alone is judged once more from entry + carry; changes outside the loop are never part of it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname, basename } from 'node:path';
import { evaluateGitCommand } from '../pipeline/hooks/lib/git-policy.mjs';

const PUSH = 'pu' + 'sh';
const MAIN = 'ma' + 'in';
const GIT_ROOT = '/work/repo';
const PB = 'git ' + PUSH; // a bare push
const SWITCH_MAIN = 'git switch ' + MAIN;
const SHIP = 'git config alias.ship "' + PUSH + ' origin ' + MAIN + '"';

function fakeFs(root, files) {
  const abs = (p) => resolve(root, p);
  const F = Object.fromEntries(Object.entries(files).map(([k, v]) => [abs(k), v]));
  const D = new Set([root, '/home/u'].map((p) => resolve(p)));
  for (const p of Object.keys(F)) for (let d = dirname(p); d !== dirname(d); d = dirname(d)) D.add(d);
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
// (the repository at GIT_ROOT is on agent/x; any other directory, /work/other for one, is a repository on main)
const run = (cmd, files = {}) => evaluateGitCommand(cmd, {
  cwd: GIT_ROOT, home: '/home/u', currentBranch: (d) => (String(d).startsWith(GIT_ROOT) ? 'agent/x' : MAIN), pushDestination: () => null, issueLabels: () => [], realpath: (p) => p, ...fakeFs(GIT_ROOT, files),
});
// package.json whose `setup` script is `setup`; `other` is harmless
const pkg = (setup) => ({ 'package.json': JSON.stringify({ name: 'x', scripts: { setup, other: 'echo hi' } }) });
const script = (setup, text) => ({ ...pkg(setup), 'run.sh': `#!/bin/bash\n${text}\n` });
const RUN_SH = `bash ${GIT_ROOT}/run.sh`;
const BRANCH = /cannot determine the current branch/;
const ALIAS = /the git alias "ship" may have been \(re\)defined/;
const DIRS = /cannot determine the current branch|pushing to main is blocked/; // (the next iteration's directory is a repository on main, or is not known)
const CONFIG = /changes upstream\/push configuration/;

function denies(what, cmd, files, reason) {
  const r = run(cmd, files);
  assert.equal(r.decision, 'deny', `${what}: allowed`);
  assert.match(r.reason, reason, `${what}: ${r.reason}`);
}
function allows(what, cmd, files) {
  const r = run(cmd, files);
  assert.equal(r.decision, 'allow', `${what}: ${r.reason}`);
}

test('#352 R5-B1: a branch switched BEFORE the loop does not hide what the loop body leaves for its next iteration', () => {
  denies('line', `git switch agent/x; for s in setup other; do ${PB} origin HEAD; npm run $s; done`, pkg(SWITCH_MAIN), BRANCH);
  denies('script', RUN_SH, script(SWITCH_MAIN, `git switch agent/x; for s in setup other; do ${PB} origin HEAD; npm run $s; done`), BRANCH);
  denies('prefix alias', `git config alias.st status; for s in setup other; do git ship; npm run $s; done`, pkg(SHIP), ALIAS);
});

test('#352 R5-F2: a loop with no variable that reaches a command is judged for its next iteration too (for / while / until, on the line or in a script)', () => {
  const body = `${PB} origin HEAD; npm run setup`;
  for (const [what, loop] of [['for', `for i in 1 2; do ${body}; done`], ['while', `while [ ! -f stop ]; do ${body}; done`], ['until', `until [ -f stop ]; do ${body}; done`]]) {
    denies(`${what} on the line`, loop, pkg(SWITCH_MAIN), BRANCH);
    denies(`${what} in a script`, RUN_SH, script(SWITCH_MAIN, loop), BRANCH);
  }
  denies('nested loops', `for i in 1 2; do for j in a b; do ${PB} origin HEAD; done; npm run setup; done`, pkg(SWITCH_MAIN), BRANCH);
  denies('a loop in a function body', `f() { for i in 1 2; do ${body}; done; }; f`, pkg(SWITCH_MAIN), BRANCH);
});

test('#352 R5-F2: a state change made directly late in the body reaches the early commands of the next iteration', () => {
  denies('switch', `for i in 1 2; do ${PB} origin HEAD; git switch ${MAIN}; done`, {}, BRANCH);
  denies('checkout', `while true; do ${PB} origin HEAD; git checkout ${MAIN}; done`, {}, BRANCH);
  denies('alias', `for i in 1 2; do git ship; ${SHIP}; done`, {}, ALIAS);
  denies('alias, in a script', RUN_SH, script('echo', `while true; do git ship; ${SHIP}; done`), ALIAS);
  denies('push.default', `for i in 1 2; do ${PB}; git config push.default upstream; done`, {}, CONFIG);
  denies('branch -u', `for i in 1 2; do ${PB}; git branch -u origin/${MAIN}; done`, {}, CONFIG);
  denies('alias through a package script', `for i in 1 2; do git ship; npm run setup; done`, pkg(SHIP), ALIAS);
  denies('push.default through a package script', `until false; do ${PB}; npm run setup; done`, pkg('git config push.default upstream'), CONFIG);
});

test('#352 R5-F1 allow twins: a change made before or after the loop is not carried into its body', () => {
  allows('alias made before the loop, used in it', 'git config alias.st status; for f in a b; do git st $f; done');
  allows('branch switched after the loop', `for f in a b; do git add $f; git commit -m $f; ${PB} origin HEAD; done; git switch ${MAIN}`);
  allows('push.default after the loop', `for f in a b; do git add $f; ${PB}; done; git config push.default upstream`);
  allows('branch -u after the loop', `for f in a b; do git add $f; ${PB}; done; git branch -u origin/${MAIN}`);
  allows('alias made after the loop', `for f in a b; do git ship; done; ${SHIP}`);
  allows('in a script', RUN_SH, script('echo', `git config alias.st status; for f in a b; do git st $f; done; git switch ${MAIN}`));
});

test('#352 R5 allow twins: a branch made before the loop, a switch inside it, or a loop that leaves no git state is not refused', () => {
  allows('checkout -b before, push after', `git checkout -b agent/x; for f in a b; do git add $f; done; ${PB} -u origin HEAD`);
  allows('switch and push in the body', `for b in agent/a agent/b; do git switch $b && ${PB} origin HEAD; done`);
  allows('switch and push in the body, then a switch after', `for b in agent/a agent/b; do git switch $b && ${PB} origin HEAD; done; git switch ${MAIN}`);
  allows('no git state', 'for f in a b; do echo $f; done');
  allows('no git state, a push after', `for i in 1 2; do echo $i; git status; done; ${PB} origin HEAD`);
  allows('while read, a push after', `while read l; do echo $l; done < f; ${PB} origin HEAD`);
  allows('two loops one after the other', 'for f in a b; do git add $f; done; for g in c d; do git commit -m $g; done');
  allows('a harmless package script in a loop', `for i in 1 2; do ${PB} origin HEAD; npm run other; done`, pkg(SWITCH_MAIN));
  allows('a harmless setup script', `while true; do ${PB} origin HEAD; npm run setup; done`, pkg('echo setup'));
  allows('a harmless alias in a loop', 'for i in 1 2; do git ship; git config alias.st status; done');
});

// Why (#352 R5, directory loop-back): a body that moves to another directory starts its next iteration THERE: `git push origin HEAD; cd /work/other` pushes /work/other's branch the second time round.
// The body is judged again from the directory it ended in (unknown when it cannot be named), then from an unknown one when that moves again (`cd ..` goes up every time).
test('#352 R5: a directory the body changes to is where its next iteration starts', () => {
  for (const [what, loop] of [
    ['absolute cd', `for i in 1 2; do ${PB} origin HEAD; cd /work/other; done`],
    ['relative cd', `for i in 1 2; do ${PB} origin HEAD; cd ../other; done`],
    ['cd to a variable', `X=/work/other; for i in 1 2; do ${PB} origin HEAD; cd "$X"; done`],
    ['pushd', `for i in 1 2; do ${PB} origin HEAD; pushd /work/other; done`],
    ['cd up every time', `while true; do ${PB} origin HEAD; cd ..; done`],
    ['cd chained', `for i in 1 2; do ${PB} origin HEAD; cd ../other && echo; done`],
    ['cd to a place not named', `for i in 1 2; do ${PB} origin HEAD; cd "$(mktemp -d)"; done`],
  ]) {
    denies(what, loop, {}, DIRS);
    denies(`${what}, in a script`, RUN_SH, script('echo', loop), DIRS);
  }
});
test('#352 R5 allow twins: a body that stays in the repository, or moves only in a subshell, is not refused', () => {
  allows('cd into a subdirectory and push, then back', `for i in 1 2; do cd sub && ${PB} origin HEAD; cd ..; done`);
  allows('cd into a subdirectory of the repository by its full path', `for i in 1 2; do cd ${GIT_ROOT}/sub && ${PB} origin HEAD; done`);
  allows('push, then cd into a subdirectory by its full path', `for i in 1 2; do ${PB} origin HEAD; cd ${GIT_ROOT}/sub; done`);
  allows('subshell cd before the push', `for i in 1 2; do (cd sub && make); ${PB} origin HEAD; done`);
  allows('subshell cd to another repository after the push', `for i in 1 2; do ${PB} origin HEAD; (cd /work/other && make); done`);
  allows('command substitution cd', `for i in 1 2; do ${PB} origin HEAD; echo $(cd /work/other && pwd); done`);
  allows('cd and back', `for i in 1 2; do ${PB} origin HEAD; cd sub && cd ..; done`);
  allows('cd to the repository itself', `for i in 1 2; do ${PB} origin HEAD; cd ${GIT_ROOT}; done`);
  allows('cd into another repository, no push in the loop', 'for i in 1 2; do cd /work/other; git status; done');
  allows('in a script', RUN_SH, script('echo', `for i in 1 2; do (cd sub && make); ${PB} origin HEAD; cd ${GIT_ROOT}/sub; done`));
});
