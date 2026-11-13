// Why (#352 R8): "may this command not run, and did it change state?" is ONE rule. A command that may not run (in an if / loop body, after && or ||, after the closer of a construct that may have skipped
// its body, in a subshell, behind ||) and that changed git state (a branch, an alias, config, a directory: judged by comparing the state before and after, so a package script or a script file that switches
// the branch counts as well as `git switch`) leaves that state UNKNOWN for every later command, whatever the separator, except for the trusted chain `cd d && x`. The flags of that rule (uncertain, orChanged)
// are saved and restored together by every subshell and loop frame, and a subshell snapshot holds the state AFTER the rule was applied for the command that opens it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname, basename } from 'node:path';
import { evaluateGitCommand } from '../pipeline/hooks/lib/git-policy.mjs';

const PUSH = 'pu' + 'sh';
const MAIN = 'ma' + 'in';
const GIT_ROOT = '/work/repo';
const MAIN_DIR = '/work/main';
const SHIP = 'git ' + PUSH + ' origin HEAD';
const RESET = 'git switch agent/x';
const BAD = /pushing to main is blocked|cannot determine the current branch/;

function fakeFs(files) {
  const F = Object.fromEntries(Object.entries(files).map(([k, v]) => [resolve(GIT_ROOT, k), v]));
  const D = new Set([GIT_ROOT, '/home/u', '/work/other2', MAIN_DIR, '/safe'].map((p) => resolve(p)));
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
// (the repository at GIT_ROOT is on agent/x, so is /work/other2; any other directory (/work/main, /safe) is a repository on main)
const run = (cmd, files = {}, cwd = MAIN_DIR) => evaluateGitCommand(cmd, {
  cwd, home: '/home/u', currentBranch: (d) => (String(d).startsWith(GIT_ROOT) || String(d).startsWith('/work/other2') ? 'agent/x' : MAIN), pushDestination: () => null, issueLabels: () => [], realpath: (p) => p, ...fakeFs(files),
});
const denies = (what, cmd, files = {}, cwd = MAIN_DIR) => { const r = run(cmd, files, cwd); assert.equal(r.decision, 'deny', `${what}: allowed`); assert.match(r.reason, BAD, `${what}: ${r.reason}`); };
const allows = (what, cmd, files = {}, cwd = MAIN_DIR) => { const r = run(cmd, files, cwd); assert.equal(r.decision, 'allow', `${what}: ${r.reason}`); };

// (the repository the line runs in is on main; its package script `reset` and its file reset.sh switch it to agent/x)
const HERE = {
  [MAIN_DIR + '/package.json']: JSON.stringify({ name: 'x', scripts: { reset: RESET, other: 'echo hi' } }),
  [MAIN_DIR + '/reset.sh']: `#!/bin/bash\n${RESET}\n`,
};

test('#352 R8-B1: a package script or script file that switches the branch, where it may not run, leaves the branch unknown', () => {
  denies('if false, npm run, fi &&', 'if false; then npm run reset; fi && ' + SHIP, HERE);
  denies('true || npm run &&', 'true || npm run reset && ' + SHIP, HERE);
  denies('if false, npm run, fi ;', 'if false; then npm run reset; fi; ' + SHIP, HERE);
  denies('true || npm run ;', 'true || npm run reset; ' + SHIP, HERE);
  denies('false && npm run ;', 'false && npm run reset; ' + SHIP, HERE);
  denies('[ ] && npm run ;', '[ -f x ] && npm run reset; ' + SHIP, HERE);
  denies('while false, npm run, done &&', 'while false; do npm run reset; done && ' + SHIP, HERE);
  denies('case, npm run, esac &&', 'case $x in a) npm run reset;; esac && ' + SHIP, HERE);
  denies('npm run in the background', 'npm run reset & ' + SHIP, HERE);
  denies('bash reset.sh in an if, fi &&', 'if false; then bash ./reset.sh; fi && ' + SHIP, HERE);
  denies('true || bash reset.sh &&', 'true || bash ./reset.sh && ' + SHIP, HERE);
  denies('false && bash reset.sh ;', 'false && bash ./reset.sh; ' + SHIP, HERE);
  denies('in a script', `bash ${MAIN_DIR}/run.sh`, { ...HERE, [MAIN_DIR + '/run.sh']: '#!/bin/bash\nif false; then npm run reset; fi && ' + SHIP + '\n' });
  // twins: the script runs for sure, or is chained to the push with &&
  allows('twin: npm run, then push', 'npm run reset; ' + SHIP, HERE);
  allows('twin: npm run &&', 'npm run reset && ' + SHIP, HERE);
  allows('twin: true && npm run &&', 'true && npm run reset && ' + SHIP, HERE);
  allows('twin: bash reset.sh &&', 'bash ./reset.sh && ' + SHIP, HERE);
  allows('twin: a script that changes nothing, in an if', 'if false; then npm run other; fi && ' + SHIP, { ...HERE, [MAIN_DIR + '/package.json']: JSON.stringify({ name: 'x', scripts: { other: 'echo hi' } }) }, GIT_ROOT);
});

test('#352 R8-B2: the OR flag is saved and restored with the subshell and the loop frame', () => {
  allows('a cd behind || in a subshell, then a switch and a push', '(true || cd /safe); ' + RESET + ' && ' + SHIP);
  allows('twin: the same in a group chained with ;', '(true || cd /safe); git status; ' + RESET + ' && ' + SHIP);
  allows('a loop that restarts after a cd behind ||', 'for i in 1 2; do ' + RESET + ' && ' + SHIP + '; true || cd /work/other2; done');
  allows('a loop with a subshell', 'for i in 1 2; do (true || cd /safe); ' + RESET + ' && ' + SHIP + '; done');
});

test('#352 R8-F1: a NAME=value segment after the closer of a construct that may have skipped its body does not make the next && command trusted', () => {
  denies('fi && A=1 &&', 'if false; then cd /work/other2; fi && A=1 && ' + SHIP);
  denies('done && A=1 &&', 'while false; do cd /work/other2; done && A=1 && ' + SHIP);
  denies('for done && A=1 &&', 'for i in; do cd /work/other2; done && A=1 && ' + SHIP);
  denies('esac && A=1 &&', 'case $x in a) cd /work/other2;; esac && A=1 && ' + SHIP);
  denies('} && A=1 &&', '{ [ -f x ] || cd /work/other2; } && A=1 && ' + SHIP);
  denies('fi && A=1 B=2 &&', 'if false; then cd /work/other2; fi && A=1 B=2 && ' + SHIP);
  denies('a switch: fi && A=1 &&', 'if false; then ' + RESET + '; fi && A=1 && ' + SHIP);
  denies('fi && A=1 && B=2 &&', 'if false; then cd /work/other2; fi && A=1 && B=2 && ' + SHIP);
  allows('twin: a plain chain with an assignment', 'cd /work/other2 && A=1 && ' + SHIP);
  allows('twin: a construct that cannot skip, then an assignment', '{ cd /work/other2; } && A=1 && ' + SHIP);
});

test('#352 R8-F2: a subshell between an uncertain change and && does not give the change back as certain', () => {
  denies('fi && (true) &&', 'if false; then cd /work/other2; fi && (true) && ' + SHIP);
  denies('true || cd && (true) &&', 'true || cd /work/other2 && (true) && ' + SHIP);
  denies('false && cd ; (true) &&', 'false && cd /work/other2; (true) && ' + SHIP);
  denies('a switch: fi && (true) &&', 'if false; then ' + RESET + '; fi && (true) && ' + SHIP);
  denies('done && (true) &&', 'while false; do cd /work/other2; done && (true) && ' + SHIP);
  denies('a nested subshell', 'if false; then cd /work/other2; fi && ((true)) && ' + SHIP);
  denies('a command substitution', 'if false; then cd /work/other2; fi && echo $(true) && ' + SHIP);
  denies('a backtick substitution', 'if false; then cd /work/other2; fi && echo `true` && ' + SHIP);
  denies('a cd in the subshell', 'if false; then cd /work/other2; fi && (cd /safe) && ' + SHIP);
  allows('twin: cd d && (true) &&', 'cd /work/other2 && (true) && ' + SHIP);
  allows('twin: cd d && (true) && (true) &&', 'cd /work/other2 && (true) && (true) && ' + SHIP);
  allows('twin: cd d && echo $(true) &&', 'cd /work/other2 && echo $(true) && ' + SHIP);
  denies('as before: a switch && (true) && (the subshell forgets a branch the line switched)', RESET + ' && (true) && ' + SHIP);
});

test('#352 R8 adjacent shapes: negation, a text run by bash -c under ||, a pipeline stage, a subshell around a script keep or gain the right verdict', () => {
  denies('! cd && (the push runs when the cd failed)', '! cd /work/other2 && ' + SHIP);
  denies('! npm run && ', '! npm run reset && ' + SHIP, HERE);
  denies('fi && ! A=1 &&', 'if false; then cd /work/other2; fi && ! A=1 && ' + SHIP);
  denies('true || bash -c switch &&', "true || bash -c 'git switch agent/x' && " + SHIP);
  denies('true || bash -c npm run &&', "true || bash -c 'npm run reset' && " + SHIP, HERE);
  denies('case, esac && (true) &&', 'case $x in a) cd /work/other2;; esac && (true) && ' + SHIP);
  denies('case, esac && A=1 &&', 'case $x in a) cd /work/other2;; esac && A=1 && ' + SHIP);
  denies('a script in a subshell, ;', '(npm run reset); ' + SHIP, HERE);
  allows('twin: bash -c switch &&', "bash -c 'git switch agent/x' && " + SHIP);
  allows('twin: a script in a pipeline stage still switched the branch', 'npm run reset | cat; ' + SHIP, HERE);
  allows('twin: a nested subshell with a cd behind ||, then a switch', '( (true || cd /safe) ); ' + RESET + ' && ' + SHIP);
  allows('twin: cd d && A=$(true) &&', 'cd /work/other2 && A=$(true) && ' + SHIP);
});
