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
  const D = new Set([root, '/home/u', '/work/other2'].map((p) => resolve(p)));
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
// (the repository at GIT_ROOT is on agent/x, so is /work/other2; any other directory is a repository on main)
const run = (cmd, files = {}) => evaluateGitCommand(cmd, {
  cwd: GIT_ROOT, home: '/home/u', currentBranch: (d) => (String(d).startsWith(GIT_ROOT) || String(d).startsWith('/work/other2') ? 'agent/x' : MAIN), pushDestination: () => null, issueLabels: () => [], realpath: (p) => p, ...fakeFs(GIT_ROOT, files),
});
const pkgOf = (scripts) => ({ 'package.json': JSON.stringify({ name: 'x', scripts }) });
const SCRIPTS = pkgOf({ setup: SWITCH_MAIN, reset: RESET, ship: SHIP, other: 'echo hi' });
const NEXT = /cannot determine the current branch|pushing to main is blocked/; // (the push of the next iteration meets a branch that is unknown, or main)

function denies(what, cmd, files, reason = NEXT) {
  const r = run(cmd, files);
  assert.equal(r.decision, 'deny', `${what}: allowed`);
  assert.match(r.reason, reason, `${what}: ${r.reason}`);
}
function allows(what, cmd, files) {
  const r = run(cmd, files);
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
