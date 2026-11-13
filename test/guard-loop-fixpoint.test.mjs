// Why (#352 R6): a loop body is judged to a FIXPOINT, not a fixed number of times. Every loop is its own range with its own entry state (adjacent loops, nested loops); what a body may leave for its
// next iteration is sampled after EVERY body command (`continue`, `break`, a command that may not run: the state in the middle of the body is one the next iteration can start in), the readings of a
// loop word are iterations of ONE loop (what one reading leaves is carried into every reading), and a start (a directory the body moves to) is judged again whenever the carry grew.
// A bound that is exceeded refuses. Changes made outside a loop are still never carried into its body (R5-F1): see guard-loop-carry.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname, basename } from 'node:path';
import { evaluateGitCommand } from '../pipeline/hooks/lib/git-policy.mjs';

const PUSH = 'pu' + 'sh';
const MAIN = 'ma' + 'in';
const GIT_ROOT = '/work/repo';
const PB = 'git ' + PUSH; // a bare push
const SHIP = PB + ' origin HEAD';
const SWITCH_MAIN = 'git switch ' + MAIN;
const RESET = 'git switch agent/x';

function fakeFs(root, files) {
  const abs = (p) => resolve(root, p);
  const F = Object.fromEntries(Object.entries(files).map(([k, v]) => [abs(k), v]));
  const D = new Set([root, '/home/u', '/work/other2', '/work/main'].map((p) => resolve(p)));
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
// (the repository at GIT_ROOT is on agent/x, so is /work/other2; any other directory is a repository on main, /work/main for one)
const run = (cmd, files = {}, cwd = GIT_ROOT) => evaluateGitCommand(cmd, {
  cwd, home: '/home/u', currentBranch: (d) => (String(d).startsWith(GIT_ROOT) || String(d).startsWith('/work/other2') ? 'agent/x' : MAIN), pushDestination: () => null, issueLabels: () => [], realpath: (p) => p, ...fakeFs(GIT_ROOT, files),
});
const pkgOf = (scripts) => ({ 'package.json': JSON.stringify({ name: 'x', scripts }) });
const SCRIPTS = pkgOf({ setup: SWITCH_MAIN, reset: RESET, ship: SHIP, other: 'echo hi' });
const NEXT = /cannot determine the current branch|pushing to main is blocked/; // (the push of the next iteration meets a branch that is unknown, or main)

function denies(what, cmd, files, reason = NEXT, cwd = GIT_ROOT) {
  const r = run(cmd, files, cwd);
  assert.equal(r.decision, 'deny', `${what}: allowed`);
  assert.match(r.reason, reason, `${what}: ${r.reason}`);
}
function allows(what, cmd, files, cwd = GIT_ROOT) {
  const r = run(cmd, files, cwd);
  assert.equal(r.decision, 'allow', `${what}: ${r.reason}`);
}

test('#352 R6-B1: the readings of a loop word are iterations of one loop: what one leaves is carried into every other (npm run $s, bash $s.sh)', () => {
  denies('setup then ship', 'for s in setup ship; do npm run $s; done', SCRIPTS);
  denies('ship then setup', 'for s in ship setup; do npm run $s; done', SCRIPTS);
  const sh = { 'setup.sh': `#!/bin/bash\n${SWITCH_MAIN}\n`, 'ship.sh': `#!/bin/bash\n${SHIP}\n` };
  denies('bash $s.sh', 'for s in setup ship; do bash ./$s.sh; done', sh);
  denies('bash $s.sh, ship first', 'for s in ship setup; do bash ./$s.sh; done', sh);
  denies('in a script', `bash ${GIT_ROOT}/run.sh`, { ...SCRIPTS, 'run.sh': '#!/bin/bash\nfor s in setup ship; do npm run $s; done\n' });
});

test('#352 R6-B2: a nested loop has its own entry state: an outer reset does not hide what the inner body leaves for its next iteration', () => {
  denies('nested', 'for i in 1 2; do npm run reset; for j in 1 2; do npm run ship; npm run setup; done; done', SCRIPTS);
  denies('nested while', 'for i in 1 2; do npm run reset; while true; do npm run ship; npm run setup; done; done', SCRIPTS);
  denies('nested three deep', 'for a in 1 2; do npm run reset; for b in 1 2; do npm run reset; for c in 1 2; do npm run ship; npm run setup; done; done; done', SCRIPTS);
  denies('in a script', `bash ${GIT_ROOT}/run.sh`, { ...SCRIPTS, 'run.sh': '#!/bin/bash\nfor i in 1 2; do npm run reset; for j in 1 2; do npm run ship; npm run setup; done; done\n' });
});

test('#352 R6-F1: two loops one after the other are two ranges: the first loop cannot hide what the second leaves for its next iteration', () => {
  denies('adjacent', 'for i in 1 2; do npm run reset; done; for j in 1 2; do npm run ship; npm run setup; done', SCRIPTS);
  denies('adjacent, while', 'while false; do npm run reset; done; until false; do npm run ship; npm run setup; done', SCRIPTS);
  denies('adjacent, no separator line', 'for i in 1 2; do npm run reset; done\nfor j in 1 2; do npm run ship; npm run setup; done', SCRIPTS);
  denies('adjacent, in a script', `bash ${GIT_ROOT}/run.sh`, { ...SCRIPTS, 'run.sh': '#!/bin/bash\nfor i in 1 2; do npm run reset; done; for j in 1 2; do npm run ship; npm run setup; done\n' });
});

test('#352 R6-F2: the carry is taken after every body command: an iteration that ends early (continue) or skips its reset leaves the state it was in', () => {
  denies('continue, test first', `git switch agent/x; for i in 1 2; do ${SHIP}; npm run setup; [ -f flag ] && continue; npm run reset; done`, SCRIPTS);
  denies('bare continue', `git switch agent/x; for i in 1 2; do ${SHIP}; npm run setup; continue; npm run reset; done`, SCRIPTS);
  denies('reset after &&', `git switch agent/x; for i in 1 2; do ${SHIP}; npm run setup; [ -f flag ] && npm run reset; done`, SCRIPTS);
  denies('reset in an if', `git switch agent/x; for i in 1 2; do ${SHIP}; npm run setup; if [ -f flag ]; then npm run reset; fi; done`, SCRIPTS);
  denies('reset after ||', `git switch agent/x; for i in 1 2; do ${SHIP}; npm run setup; [ -f flag ] || npm run reset; done`, SCRIPTS);
  denies('direct switch, continue', `git switch agent/x; for i in 1 2; do ${SHIP}; ${SWITCH_MAIN}; [ -f flag ] && continue; ${RESET}; done`, {});
  denies('in a script', `bash ${GIT_ROOT}/run.sh`, { ...SCRIPTS, 'run.sh': `#!/bin/bash\ngit switch agent/x; for i in 1 2; do ${SHIP}; npm run setup; [ -f flag ] && continue; npm run reset; done\n` });
});

test('#352 R6-F2 extras: break, a loop that exits early, until, a function in the loop, the state after the loop', () => {
  denies('break, then a push after the loop', `git switch agent/x; for i in 1 2; do npm run setup; [ -f flag ] && break; npm run reset; done; ${SHIP}`, SCRIPTS);
  denies('while true, early exit, a push after', `git switch agent/x; while true; do npm run setup; [ -f flag ] && break; npm run reset; done; ${SHIP}`, SCRIPTS);
  denies('until', `git switch agent/x; until [ -f stop ]; do ${SHIP}; npm run setup; [ -f flag ] && continue; npm run reset; done`, SCRIPTS);
  denies('function called in the loop', `f() { ${SHIP}; npm run setup; [ -f flag ] && return; npm run reset; }; git switch agent/x; for i in 1 2; do f; done`, SCRIPTS);
  denies('break in an inner loop, the outer carries on', `for i in 1 2; do ${SHIP}; for j in 1 2; do npm run setup; [ -f flag ] && break; npm run reset; done; done`, SCRIPTS);
  denies('the reset after || true', 'for s in ship setup; do npm run $s || true; done', SCRIPTS);
  denies('a loop word in a subshell', 'for s in ship setup; do (npm run $s); done', SCRIPTS);
  denies('a loop word in the background', 'for s in ship setup; do npm run $s & done', SCRIPTS);
  denies('break in an if, a push after the loop', 'while true; do if [ -f a ]; then npm run setup; break; fi; npm run ship; done', SCRIPTS);
  denies('three deep', 'for i in 1 2; do for j in 1 2; do for k in 1 2; do npm run ship; npm run setup; npm run reset; done; done; done', SCRIPTS);
  denies('the readings of a loop inside a loop', 'for a in x y; do for s in ship setup; do npm run $s; done; done; ' + SHIP, SCRIPTS);
  denies('continue 2', `git switch agent/x; for i in 1 2; do ${SHIP}; for j in 1 2; do npm run setup; [ -f flag ] && continue 2; npm run reset; done; done`, SCRIPTS);
});

test('#352 R6-F3: a start the body moves to is judged again whenever the carry grew, from entry + the new carry', () => {
  const two = { ...pkgOf({ setup: 'echo ok' }), 'sub/package.json': JSON.stringify({ name: 'y', scripts: { setup: SWITCH_MAIN } }) };
  denies('cd into a package that switches', `for i in 1 2 3; do ${SHIP}; npm run setup; cd ${GIT_ROOT}/sub; done`, two);
  denies('cd relative', `for i in 1 2 3; do ${SHIP}; npm run setup; cd sub; done`, two);
  denies('in a script', `bash ${GIT_ROOT}/run.sh`, { ...two, 'run.sh': `#!/bin/bash\nfor i in 1 2 3; do ${SHIP}; npm run setup; cd ${GIT_ROOT}/sub; done\n` });
  const other = { ...pkgOf({ setup: 'echo ok' }), '/work/other2/package.json': JSON.stringify({ name: 'z', scripts: { setup: SWITCH_MAIN } }) };
  denies('a second repository', `for i in 1 2 3; do ${SHIP}; npm run setup; cd /work/other2; done`, other);
  denies('a second repository, pushd', `for i in 1 2 3; do ${SHIP}; npm run setup; pushd /work/other2; done`, other);
});

test('#352 R6 allow twins: loops that leave nothing for their next iteration are not refused', () => {
  allows('adjacent loops, neither leaves anything', `for f in a b; do git add $f; ${SHIP}; done; for g in c d; do git commit -m $g; ${SHIP}; done`);
  allows('adjacent loops, a harmless script each', `for i in 1 2; do ${SHIP}; npm run other; done; for j in 1 2; do ${SHIP}; npm run other; done`, SCRIPTS);
  allows('nested loops, nothing left', `for i in 1 2; do for j in 1 2; do ${SHIP}; npm run other; done; done`, SCRIPTS);
  allows('readings that leave nothing', `for s in other other2; do ${SHIP}; npm run $s; done`, pkgOf({ other: 'echo a', other2: 'echo b' }));
  allows('continue with nothing left', `for i in 1 2; do ${SHIP}; [ -f flag ] && continue; npm run other; done`, SCRIPTS);
  allows('a switch before the loop, a push in it', `git switch agent/x; for i in 1 2; do ${SHIP}; npm run other; done`, SCRIPTS);
  allows('a switch after the loop', `for i in 1 2; do ${SHIP}; done; npm run setup`, SCRIPTS);
  allows('a switch before the loop', `npm run setup; for i in 1 2; do git add f; done`, SCRIPTS);
});

const MAIN_DIR = '/work/main';
const pk = (scripts) => JSON.stringify({ name: 'x', scripts });
const PUSH_MAIN = PB + ' origin ' + MAIN;

test('#352 R7-B1: the directories a loop starts an iteration in are shared by the readings of its loop word (iteration a moves, iteration b runs there)', () => {
  const at = (bScript) => ({ 'package.json': pk({ a: 'echo a', b: 'echo b' }), '/work/a/package.json': pk({ a: 'echo a', b: bScript }), '/work/b/package.json': pk({ a: 'echo a', b: 'echo b' }) });
  denies('b pushes in /work/a', 'for s in a b; do npm run $s; cd /work/$s; done', at(PUSH_MAIN), /pushing to main is blocked/);
  denies('pushd', 'for s in a b; do npm run $s; pushd /work/$s; done', at(PUSH_MAIN), /pushing to main is blocked/);
  denies('in a script', `bash ${GIT_ROOT}/run.sh`, { ...at(PUSH_MAIN), 'run.sh': '#!/bin/bash\nfor s in a b; do npm run $s; cd /work/$s; done\n' }, /pushing to main is blocked/);
  allows('twin: b is harmless in /work/a', 'for s in a b; do npm run $s; cd /work/$s; done', at('echo b'));
  allows('twin: nothing moves', 'for s in a b; do npm run $s; done', at(PUSH_MAIN));
});

test('#352 R7-F1: a loop frame holds the state the loop\'s first command really starts with, after the subshell of the same command is settled', () => {
  const sub = (a) => ({ 'package.json': pk({ a: 'echo a' }), 'sub/package.json': pk({ a }) });
  denies('a subshell before the loop', '(true); for i in 1 2; do npm run a; cd sub; done', sub(PUSH_MAIN), /pushing to main is blocked/);
  denies('a cd in a subshell before the loop', '(cd /tmp); for i in 1 2; do npm run a; cd sub; done', sub(PUSH_MAIN), /pushing to main is blocked/);
  allows('twin: harmless in sub', '(true); for i in 1 2; do npm run a; cd sub; done', sub('echo a'));
  allows('twin: cd in a subshell, harmless in sub', '(cd /tmp); for i in 1 2; do npm run a; cd sub; done', sub('echo a'));
  denies('a loop inside a subshell, the push after it', '( for i in 1 2; do git status; cd /work/other2; done ); ' + SHIP, {}, /pushing to main is blocked/, MAIN_DIR);
  allows('twin: the same from a directory on a feature branch', '( for i in 1 2; do git status; cd /work/other2; done ); ' + SHIP, {});
  allows('twin: a loop inside a subshell, the push before it', SHIP + '; ( for i in 1 2; do git status; cd /work/other2; done )', {});
});

test('#352 R7-F2: a state change inside an if / loop is not certain for a command chained with && after its closer', () => {
  denies('if false, switch, fi &&', 'if false; then git switch agent/x; fi && ' + SHIP, {}, /pushing to main is blocked|cannot determine the current branch/, MAIN_DIR);
  denies('while false, cd, done &&', 'while false; do cd /work/other2; done && ' + SHIP, {}, /pushing to main is blocked|cannot determine the current branch/, MAIN_DIR);
  denies('for, cd, done &&', 'for i in; do cd /work/other2; done && ' + SHIP, {}, /pushing to main is blocked|cannot determine the current branch/, MAIN_DIR);
  denies('until, cd, done &&', 'until true; do cd /work/other2; done && ' + SHIP, {}, /pushing to main is blocked|cannot determine the current branch/, MAIN_DIR);
  denies('case, switch, esac &&', 'case $x in a) git switch agent/x;; esac && ' + SHIP, {}, /pushing to main is blocked|cannot determine the current branch/, MAIN_DIR);
  denies('group, switch, } &&', '{ [ -f x ] && git switch agent/x; } && ' + SHIP, {}, /pushing to main is blocked|cannot determine the current branch/, MAIN_DIR);
  denies('if, switch, fi ||', 'if false; then git switch agent/x; fi || ' + SHIP, {}, /pushing to main is blocked|cannot determine the current branch/, MAIN_DIR);
  allows('twin: a feature branch, fi &&', 'if [ -f x ]; then git status; fi && ' + SHIP, {});
  allows('twin: a plain chain stays certain', 'git switch agent/x && ' + SHIP, {}, MAIN_DIR);
  allows('twin: a plain cd chain stays certain', 'cd /work/other2 && ' + SHIP, {}, MAIN_DIR);
  allows('twin: a loop that does not move, done &&', 'for i in 1 2; do git status; done && ' + SHIP, {});
});

test('#352 R7-F3: a loop whose carry keeps growing at every new place it moves to is refused after MAX_LOOP_PASSES, with the reason that names it', () => {
  // (a different git alias in the package of each directory the body moves to: every new start grows the carry, so the starts are judged again and again)
  const alias = (n) => pk({ a: `git config alias.s${n} x` });
  const deep = { 'package.json': alias(1), 'sub/package.json': alias(2), 'sub/sub/package.json': alias(3), 'sub/sub/sub/package.json': alias(4) };
  denies('four aliases in four places', 'for i in 1 2; do npm run a; cd sub; done', deep, /keeps leaving git state for its next iteration, or moves to ever new places/);
  allows('twin: the same body, one alias in every place', 'for i in 1 2; do npm run a; cd sub; done', { 'package.json': alias(1), 'sub/package.json': alias(1), 'sub/sub/package.json': alias(1), 'sub/sub/sub/package.json': alias(1) });
});
