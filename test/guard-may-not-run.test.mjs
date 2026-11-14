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
// (a line the parser gives up on, truncated: denied whatever the reason)
const refuses = (what, cmd, files = {}, cwd = MAIN_DIR) => { const r = run(cmd, files, cwd); assert.equal(r.decision, 'deny', `${what}: allowed`); };
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
  allows('twin: a construct that cannot skip, then an assignment (R10: a { } group the line surely enters hands its certain change on)', '{ cd /work/other2; } && A=1 && ' + SHIP);
  allows('twin: the cd outside the group', 'cd /work/other2 && { A=1; } && A=1 && ' + SHIP);
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
  allows('R10: a switch at the top of the line, && (true) &&: the switch is certain, and a subshell that changes nothing gives nothing back', RESET + ' && (true) && ' + SHIP);
  denies('a switch in the subshell is unknown after it', '(' + RESET + ') && ' + SHIP);
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
  denies('R10: a switch in a bash -c text is unknown after it (the text is a process of its own)', "bash -c 'git switch agent/x' && " + SHIP);
  denies('R10: a change in a pipeline stage is unknown after it', 'npm run reset | cat; ' + SHIP, HERE);
  allows('twin: a nested subshell with a cd behind ||, then a switch', '( (true || cd /safe) ); ' + RESET + ' && ' + SHIP);
  allows('twin: cd d && A=$(true) &&', 'cd /work/other2 && A=$(true) && ' + SHIP);
});

// #352 R9: the may-not-run rule reads the command's OWN operator and negation, and those of EVERY level that holds it (a `bash -c` / eval text, a substitution), not one of them.
test('#352 R9-B1 R9-F1: a text run by bash -c / eval / $( ) keeps its own || and !, and takes those of every level that holds it', () => {
  denies('bash -c with || inside', `bash -c 'true || git switch agent/x && ${SHIP}'`);
  denies('bash -c with ! inside', `bash -c '! git switch agent/x && ${SHIP}'`);
  denies('two levels of bash -c behind ||', `true || bash -c "bash -c 'git switch agent/x'" && ${SHIP}`);
  denies('two levels of eval behind ||', `true || eval "eval 'git switch agent/x'" && ${SHIP}`);
  denies('bash -c behind ! (the push runs when the text failed)', `! bash -c "bash -c 'git switch agent/x'" && ${SHIP}`);
  denies('a substitution with || inside, after another command', `git status; echo $(true || git switch agent/x && ${SHIP})`);
  denies('a substitution behind ||', `true || echo $(git switch agent/x) && ${SHIP}`);
  denies('a substitution holder with a bash -c inside', `git status; echo $(bash -c 'true || git switch agent/x && ${SHIP}')`);
  denies('R10: two levels of bash -c: unknown after them', `bash -c "bash -c 'git switch agent/x'" && ${SHIP}`);
  denies('R10: two levels of eval: unknown after them', `eval "eval 'git switch agent/x'" && ${SHIP}`);
  allows('twin: a text with && inside', `bash -c 'git switch agent/x && ${SHIP}'`);
});

test('#352 R9-F2: a keyword-only segment (!) before a subshell does not lose the may-skip mark of the construct before it', () => {
  denies('fi && ! (false) &&', `if false; then cd /work/other2; fi && ! (false) && ${SHIP}`);
  denies('done && ! (false) &&', `while false; do cd /work/other2; done && ! (false) && ${SHIP}`);
  denies('fi && ! ((0)) &&', `if false; then cd /work/other2; fi && ! ((0)) && ${SHIP}`);
  denies('a switch: fi && ! (false) &&', `if false; then ${RESET}; fi && ! (false) && ${SHIP}`);
  allows('twin: cd d && ! (false) &&', `cd /work/other2 && ! (false) && ${SHIP}`);
});

test('#352 R9-F3: a negation covers the whole negated pipeline or group', () => {
  denies('! { switch; } &&', `! { git switch agent/x; } && ${SHIP}`);
  denies('! true | switch &&', `! true | git switch agent/x && ${SHIP}`);
  denies('! { cd; } &&', `! { cd /work/other2; } && ${SHIP}`);
  denies('! { a; switch; } &&', `! { git status; git switch agent/x; } && ${SHIP}`);
  denies('! (switch) &&', `! (git switch agent/x) && ${SHIP}`);
  denies('! cd | cat &&', `! cd /work/other2 | cat && ${SHIP}`);
  allows('twin: { cd; } && (R10: a { } group the line surely enters hands its certain change on)', `{ cd /work/other2; } && ${SHIP}`);
  denies('R10: a { } group behind ||', `true || { cd /work/other2; } && ${SHIP}`);
});

test('#352 R9-F4: a pipeline that ends in & is a background job, whichever stage the change is in', () => {
  denies('npm run | cat &', `npm run reset | cat & ${SHIP}`, HERE);
  denies('switch | cat &', `git switch agent/x | cat & ${SHIP}`);
  denies('cat | npm run &', `cat x | npm run reset & ${SHIP}`, HERE);
  denies('R10: npm run | cat ; (a change in a pipeline stage is unknown after it)', `npm run reset | cat; ${SHIP}`, HERE);
});

test('#352 R9 scan (ii): an alias defined where it may not run is unsure for every later use', () => {
  const ALIAS = 'git config alias.ship "' + PUSH + ' origin main"';
  const HARMLESS = 'git config alias.ship status';
  const reason = (cmd) => { const v = run(cmd); assert.equal(v.decision, 'deny', cmd); return v.reason; };
  assert.match(reason(`true || ${ALIAS}; git ship`), /may have been \(re\)defined/);
  assert.match(reason(`if false; then ${ALIAS}; fi && git ship`), /may have been \(re\)defined/);
  assert.match(reason(`false && ${ALIAS}; git ship`), /may have been \(re\)defined/);
  // the alias was a push to main already; the redefinition may not have run
  assert.match(reason(`${ALIAS}; true || ${HARMLESS}; git ship`), /may have been \(re\)defined|pushing to main is blocked/);
  assert.match(reason(`${ALIAS}; true || ${HARMLESS} && git ship`), /may have been \(re\)defined|pushing to main is blocked/);
  assert.match(reason(`${ALIAS}; if false; then ${HARMLESS}; fi && git ship`), /may have been \(re\)defined|pushing to main is blocked/);
  allows('twin: a certain redefinition', `${ALIAS}; ${HARMLESS} && git ship`);
});

// (#400: shapes the generated differential test found, test/guard-may-not-run-differential.test.mjs)
test('#400 differential: a failure that && passes on reaches a later ||; a cd in a child process, a pipeline stage or a background list is lost; a group behind || is skipped as a whole', () => {
  denies('change && x || push', `${RESET} && A=1 || ${SHIP}`);
  denies('a group: { cd && x; } || push', `{ cd /work/other2 && A=1; } || ${SHIP}`);
  denies('cd || a substitution that pushes', `cd /work/other2 || echo $(cat; ${SHIP})`);
  denies('a cd in the last stage of a pipeline, then &&', `false | cd /work/other2 && ${SHIP}`);
  denies('bash -c cd, then &&', `bash -c 'cd /work/other2' && ${SHIP}`);
  denies('a text with a change in an if, then &&', `bash -c 'if false; then npm run reset; fi' && ${SHIP}`, HERE);
  denies('a && list in the background', `cd /work/other2 && true & ${SHIP}`);
  denies('a group after && in the background', `false & { cd /work/other2; } && false & ${SHIP}`);
  denies('a later command of a group behind ||', `false || { cat; ${RESET}; }; ${SHIP}`);
  denies('a pipeline stage behind &&', `A=1 && false | npm run reset; ${SHIP}`, HERE);
  denies('a bash -c cd in a loop, then &&', `while false; do bash -c 'cd /work/other2; false'; done && ${SHIP}`);
  allows('twin: the cd and the push in one bash -c text', `bash -c 'cd /work/other2 && ${SHIP}'`);
  denies('R10: eval: a change in a text is unknown after it', `eval 'cd /work/other2' && ${SHIP}`);
});

// (#352 R10: the rule is an ALLOWLIST. A change counts as certain for the commands after it only when it is at the top of the line (or of the text it is in), not in a group / branch / loop /
// function body, not negated, not a pipeline stage, not in the background, not run by a wrapper that starts a process, and only `&&` / `;` follow it before the later command)
test('#352 R10-B1: a loop inside a bash -c text carries the text\'s own cd to its next iteration', () => {
  denies('for in bash -c: the push, then a cd to main', `bash -c 'for x in a b; do ${SHIP}; cd ${MAIN_DIR}; done'`, {}, '/work/other2');
  denies('while in sh -c: the push, then a cd to main', `sh -c 'while true; do ${SHIP}; cd ${MAIN_DIR}; done'`, {}, '/work/other2');
  allows('twin: the loop in the text never leaves its directory', `bash -c 'for x in a b; do ${SHIP}; cd /work/other2; done'`, {}, '/work/other2');
});
test('#352 R10-F1: a script a shell reads from stdin, a here-string, a heredoc or a process substitution is a new process', () => {
  denies('bash <<<', `bash <<< 'cd /work/other2' && ${SHIP}`);
  denies('piped into bash', `echo 'cd /work/other2' | bash && ${SHIP}`);
  denies('sh -s <<<', `sh -s <<< 'cd /work/other2' && ${SHIP}`);
  denies('bash <( )', `bash <(echo cd /work/other2) && ${SHIP}`);
  denies('a heredoc', `bash <<EOF && ${SHIP}\ncd /work/other2\nEOF`);
  denies('a switch in a here-string', `bash <<< '${RESET}' && ${SHIP}`);
  allows('twin: the here-string text holds both', `bash <<< 'cd /work/other2 && ${SHIP}'`);
});
test('#352 R10-F2: a { } group or an if chained with && does not hide the || after it', () => {
  denies('{ a; b; } || push', `${RESET} && { echo a; echo b; } || ${SHIP}`);
  denies('if, fi || push', `${RESET} && if true; then echo; fi || ${SHIP}`);
  denies('cd && { a; b; } || push', `cd /work/other2 && { echo a; echo b; } || ${SHIP}`);
  allows('twin: && after the group', `cd /work/other2 && { echo a; echo b; } && ${SHIP}`);
});
test('#352 R10-F3: a { } group that is the first stage of a pipeline keeps the operator before the pipeline', () => {
  denies('false && { a; b; } | npm run reset', `false && { echo a; echo b; } | npm run reset; ${SHIP}`, HERE);
  denies('true || { a; b; } | npm run reset', `true || { echo a; echo b; } | npm run reset; ${SHIP}`, HERE);
  denies('a group stage, then &&', `{ echo a; echo b; } | npm run reset && ${SHIP}`, HERE);
});
test('#352 R10-F4: a background pipeline whose first stage waits for a heredoc is a background job', () => {
  denies('npm run <<EOF | cat &', `npm run reset <<EOF | cat & ${SHIP}\nx\nEOF`, HERE);
  denies('npm run reset | cat <<EOF &', `npm run reset | cat <<EOF & ${SHIP}\nx\nEOF`, HERE);
});
test('#352 R10-F5: a cd in a subshell is lost when it ends, whatever a text inside it did', () => {
  allows('( cd && bash -c ); push', `(cd /work/other2 && bash -c 'echo hi'); ${SHIP}`, {}, '/work/other2');
  allows('( cd && bash -c ) && push', `(cd /work/other2 && bash -c 'echo hi') && ${SHIP}`, {}, '/work/other2');
  denies('twin: the same line from main', `(cd /work/other2 && bash -c 'echo hi'); ${SHIP}`);
});
test('#403 (R10-F6): a cd run through a wrapper that starts a process is that process\'s, not this shell\'s', () => {
  denies('nohup cd', `nohup cd /work/other2; ${SHIP}`);
  denies('env cd &&', `env cd /work/other2 && ${SHIP}`);
  denies('nice cd &&', `nice cd /work/other2 && ${SHIP}`);
  denies('timeout cd &&', `timeout 5 cd /work/other2 && ${SHIP}`);
  denies('sudo cd &&', `sudo cd /work/other2 && ${SHIP}`);
  denies('xargs cd', `echo /work/other2 | xargs cd && ${SHIP}`);
  denies('find -exec cd', `find . -exec cd /work/other2 ';' && ${SHIP}`);
  denies('a wrapped switch', `nohup ${RESET} && ${SHIP}`);
  allows('twin: command / builtin / exec stay transparent', `command cd /work/other2 && builtin cd /work/other2 && ${SHIP}`);
});

// (#352 R11: a level that ends gives its alias changes back as unsure; a stage before a `|` is marked when the `|` is read; the operator before a pipeline reaches every later stage; a text lexed while an earlier
// command still waits for its heredoc is refused)
const ANY_DENY = (what, cmd, files = {}, cwd = MAIN_DIR) => { const r = run(cmd, files, cwd); assert.equal(r.decision, 'deny', `${what}: allowed`); };
test('#352 R11-B1: an alias changed inside an ended subshell / bash -c / eval text is unsure after it', () => {
  const ALIAS = 'git config alias.ship "' + PUSH + ' origin ' + MAIN + '"';
  const HARMLESS = 'git config alias.ship status';
  const unsure = (what, cmd) => { const v = run(cmd); assert.equal(v.decision, 'deny', `${what}: allowed`); assert.match(v.reason, /may have been \(re\)defined|pushing to main is blocked/, what); };
  unsure('true || bash -c', `${ALIAS}; true || bash -c '${HARMLESS}'; git ship`);
  unsure('true || ( )', `${ALIAS}; true || (${HARMLESS}); git ship`);
  unsure('( false && )', `${ALIAS}; (false && ${HARMLESS}); git ship`);
  unsure('true || eval', `${ALIAS}; true || eval '${HARMLESS}'; git ship`);
  unsure('bash -c ;', `${ALIAS}; bash -c '${HARMLESS}'; git ship`);
  unsure('( ) &&', `${ALIAS}; (${HARMLESS}) && git ship`);
  unsure('eval &&', `${ALIAS}; eval '${HARMLESS}' && git ship`);
  allows('twin: the redefinition and its use in one bash -c text', `${ALIAS}; bash -c '${HARMLESS} && git ship'`);
  allows('twin: a certain redefinition', `${ALIAS}; ${HARMLESS} && git ship`);
  allows('twin: a subshell that changes no alias', `${ALIAS}; ${HARMLESS}; (true || echo hi); git ship`);
});

test('#352 R11-F1: a cd in a pipeline stage followed by a ( ) / (( )) stage is the stage\'s own', () => {
  denies('cd | ( ) ;', `cd /work/other2 | (cat); ${SHIP}`);
  denies('cd | ( ) &&', `cd /work/other2 | (cat) && ${SHIP}`);
  denies('{ cd; } | ( ) &&', `{ cd /work/other2; } | (cat) && ${SHIP}`);
  denies('cd | (( )) &&', `cd /work/other2 | (( 1 )) && ${SHIP}`);
  denies('cd | cat | ( ) &&', `cd /work/other2 | cat | (cat) && ${SHIP}`);
  denies('a switch | ( ) ;', `${RESET} | (cat); ${SHIP}`);
  denies('a cd in the ( ) stage', `cat | (cd /work/other2) && ${SHIP}`);
  allows('twin: the cd before the pipeline', `cd /work/other2 && echo a | (cat) && ${SHIP}`);
  allows('twin: the cd before a pipeline of two ( ) stages', `cd /work/other2; (cat) | (cat); ${SHIP}`);
  allows('twin: the pipeline first', `echo a | (cat); cd /work/other2 && ${SHIP}`);
  // (a stage that waits for its heredoc body when the | is read: it alone is the pipeline's, the cd before it stays certain)
  denies('a cd waiting for its heredoc, | ( )', `cd /work/other2 <<'EOF' | (cat) && ${SHIP}\nx\nEOF`);
  denies('a cd waiting for its heredoc, | a command', `cd /work/other2 <<'EOF' | cat && ${SHIP}\nx\nEOF`);
  allows('twin: a cd, then a heredoc stage | a command, then the push', `cd /work/other2 && cat <<'EOF' | wc -l && ${SHIP}\na\nEOF`);
  allows('twin: a cd, then a heredoc stage | a command, the push on the next line', `cd /work/other2 && cat <<'EOF' | wc -l\na\nEOF\n${SHIP}`);
  allows('twin: a cd, then a heredoc stage | ( )', `cd /work/other2 && cat <<'EOF' | (cat) && ${SHIP}\na\nEOF`);
});

test('#352 R11-F2: the operator before a pipeline reaches every later stage, the levels they open included', () => {
  denies('an empty group stage, then the push', `false && cd /work/other2; { } | ${SHIP}`);
  denies('an empty group stage, then a subshell push', `false && cd /work/other2; { } | (${SHIP})`);
  ANY_DENY('a heredoc stage, then a backtick push (refused by R11-F3 as well)', `false && cd /work/other2; cat <<EOF | echo \`${SHIP}\`\nx\nEOF`);
  denies('a heredoc stage, then a $( ) push', `false && cd /work/other2; cat <<EOF | echo $(${SHIP})\nx\nEOF`);
  denies('after ||', `true || cd /work/other2; { } | ${SHIP}`);
  allows('twin: the cd before a pipeline of simple stages', `cd /work/other2 && cat | echo \`${SHIP}\``);
  allows('twin: a certain cd before an empty group stage', `cd /work/other2 && { } | ${SHIP}`);
  allows('twin: a cd after ; (it surely ran) before a pipeline', `cd /work/other2; cat | ${SHIP}`);
});

test('#352 R11-F3: a backtick text lexed while an earlier command still waits for its heredoc is refused', () => {
  ANY_DENY('cd <<EOF; echo `push`', `cd ${MAIN_DIR} <<EOF; echo \`${SHIP}\`\nEOF`, {}, GIT_ROOT);
  ANY_DENY('cd <<EOF && echo `push`', `cd ${MAIN_DIR} <<EOF && echo \`${SHIP}\`\nEOF`, {}, GIT_ROOT);
  ANY_DENY('cd <<EOF | echo `push`', `cd ${MAIN_DIR} <<EOF | echo \`${SHIP}\`\nEOF`, {}, GIT_ROOT);
  allows('twin: the backtick first', `echo \`date\`; cat <<EOF\nx\nEOF`, {}, GIT_ROOT);
  allows('twin: a backtick in a later line', `cat <<EOF\nx\nEOF\necho \`date\``, {}, GIT_ROOT);
  allows('twin: a $( ) after the heredoc command keeps its order', `cd /work/other2 <<EOF; echo $(${SHIP})\nEOF`, {}, GIT_ROOT);
});

// (#352 R12: a ( ) stage of a pipeline keeps its own commands' certainty; a text scanned out of a heredoc body / $[ ] is not emitted before an earlier command still waiting in the queue; a redirect after
// `)` continues the subshell's command; a redirect-only command carries its own operator)
test('#352 R12-B1: the commands inside a ( ) stage of a pipeline keep their own directory', () => {
  allows('(cd d && push) | (cat)', `(cd /work/other2 && ${SHIP}) | (cat)`);
  allows('(cd d && push) | cat', `(cd /work/other2 && ${SHIP}) | cat`);
  allows('cat | (cd d && push)', `cat | (cd /work/other2 && ${SHIP})`);
  allows('(cd d && push) 2>&1 | (cat)', `(cd /work/other2 && ${SHIP}) 2>&1 | (cat)`);
  denies('cd | ( ) && push', `cd /work/other2 | (cat) && ${SHIP}`);
  denies('cat | ( cd ) && push', `cat | (cd /work/other2) && ${SHIP}`);
  denies('( switch ) | push', `(${RESET}) | ${SHIP}`);
  denies('( cd ) | cat && push', `(cd /work/other2) | cat && ${SHIP}`);
});

test('#352 R12-F1: a text scanned out of a heredoc body or $[ ] is not emitted before an earlier command that still waits for its body', () => {
  ANY_DENY('cat <<A; cd main; cat <<B, $( push ) in B', `cat <<A; cd ${MAIN_DIR}; cat <<B\nx\nA\n$(${SHIP})\nB`, {}, GIT_ROOT);
  ANY_DENY('cd main <<A; cat <<B, $( push ) in B', `cd ${MAIN_DIR} <<A; cat <<B\nx\nA\n$(${SHIP})\nB`, {}, GIT_ROOT);
  ANY_DENY('cd main <<EOF; echo $[ $( push ) ]', `cd ${MAIN_DIR} <<EOF; echo $[ $(${SHIP}) ]\nEOF`, {}, GIT_ROOT);
  ANY_DENY('cat <<A; cd main; cat <<B, a backtick push in B', `cat <<A; cd ${MAIN_DIR}; cat <<B\nx\nA\n\`${SHIP}\`\nB`, {}, GIT_ROOT);
  allows('twin: one heredoc whose body has a $( )', `cat <<EOF\n$(${SHIP})\nEOF`, {}, GIT_ROOT);
  allows('twin: two heredocs, nothing changes state between', `cat <<A; cat <<B\nx\nA\n$(${SHIP})\nB`, {}, GIT_ROOT);
  allows('twin: a cd waiting for its heredoc, the $( ) push in its own body', `cd /work/other2 <<EOF; echo hi\n$(${SHIP})\nEOF`, {}, GIT_ROOT);
  allows('twin: a $[ ] with no heredoc waiting', `cd /work/other2; echo $[ $(${SHIP}) ]`, {}, GIT_ROOT);
  allows('twin: a $[ ] after a heredoc whose body is read', `cat <<EOF\nx\nEOF\necho $[ $(${SHIP}) ]`, {}, GIT_ROOT);
});

test('#352 R12-F2: a redirect right after ) continues that subshell\'s command: pipeline and background bookkeeping reach the part before it', () => {
  denies('cd d && ( ) 2>&1 & push', `cd /work/other2 && (true) 2>&1 & ${SHIP}`);
  denies('cd d && ( ) > log 2>&1 & push', `cd /work/other2 && (sleep 5) > /tmp/log 2>&1 & ${SHIP}`);
  denies('cd d && ( ) 2>&1 | cat & push', `cd /work/other2 && (true) 2>&1 | cat & ${SHIP}`);
  denies('cd d && ( ) 2>&1 && b & push', `cd /work/other2 && (true) 2>&1 && echo b & ${SHIP}`);
  denies('switch || ( ) 2>&1 | push', `${RESET} || ( ) 2>&1 | ${SHIP}`);
  denies('switch || ( ) 2>&1 | cat; push', `${RESET} || (true) 2>&1 | cat; ${SHIP}`);
  allows('twin: cd d && ( ) 2>&1 && push', `cd /work/other2 && (true) 2>&1 && ${SHIP}`);
  allows('twin: cd d && ( ) > log 2>&1; push', `cd /work/other2 && (sleep 5) > /tmp/log 2>&1; ${SHIP}`);
  allows('twin: cd d; ( ) 2>&1 | cat; push', `cd /work/other2; (true) 2>&1 | cat; ${SHIP}`);
  allows('twin: cd d && ( ) 2>&1 | cat && push (the stage is the subshell\'s)', `cd /work/other2 && (true) 2>&1 | cat && ${SHIP}`);
});

test('#352 R12-F3: a redirect-only command carries the operator before it', () => {
  denies('switch || >/dev/null && push', `${RESET} || >/dev/null && ${SHIP}`);
  denies('cd d || >x && push', `cd /work/other2 || >x && ${SHIP}`);
  denies('switch || >x ; push', `${RESET} || >x; ${SHIP}`);
  denies('cd d || >x ; push', `cd /work/other2 || >x; ${SHIP}`);
  denies('switch | >x && push', `${RESET} | >x && ${SHIP}`);
  allows('twin: switch && >x && push', `${RESET} && >x && ${SHIP}`);
  allows('twin: cd d && >x && push', `cd /work/other2 && >x && ${SHIP}`);
  allows('twin: cd d; >x; push', `cd /work/other2; >x; ${SHIP}`);
});

// (found by the generator once it drew redirect-only commands: a text expanded out of a heredoc body or a $[ ] runs under the operator of the command that holds it, as a $( ) in a word does)
test('#352 R12-F1b: a $( ) in a heredoc body or in $[ ] takes the operator before the command that holds it', () => {
  denies('switch || cat <<EOF, $( push ) in the body', `${RESET} || cat <<EOF\n$(${SHIP})\nEOF`);
  denies('npm run || bash <<EOF, $( push ) in the body', `npm run reset || bash <<EOF\necho $(${SHIP})\nEOF`, HERE);
  denies('switch || echo $[ $( push ) ]', `${RESET} || echo $[ $(${SHIP}) ]`);
  denies('cd d || cat <<EOF, a backtick push in the body', `cd /work/other2 || cat <<EOF\n\`${SHIP}\`\nEOF`);
  ANY_DENY('a body read to the end of the text, behind ||', `${RESET} || cat <<EOF\n$(${SHIP})`);
  allows('twin: switch && cat <<EOF, $( push ) in the body', `${RESET} && cat <<EOF\n$(${SHIP})\nEOF`);
  allows('twin: switch; cat <<EOF, $( push ) in the body', `${RESET}; cat <<EOF\n$(${SHIP})\nEOF`);
  allows('twin: switch && echo $[ $( push ) ]', `${RESET} && echo $[ $(${SHIP}) ]`);
});

// (#352 R13: the tail after a subshell's `)` is decided from what the lexer read since it, not from the raw text; a reserved word after `)` is no redirect list; the `paren` mark covers only the group's own commands)
test('#352 R13-B1: a line continuation between ) and its redirect keeps the redirect part of the subshell command', () => {
  denies('cd d && ( ) \\<nl> 2>&1 & push', `cd /work/other2 && (true) \\\n 2>&1 & ${SHIP}`);
  denies('cd d && ( ) \\<nl>\\<nl> > log & push', `cd /work/other2 && (true) \\\n\\\n > /tmp/log & ${SHIP}`);
  denies('switch || ( ) \\<nl> 2>&1 | cat; push', `${RESET} || (true) \\\n 2>&1 | cat; ${SHIP}`);
  allows('twin: cd d && ( ) \\<nl> 2>&1 && push', `cd /work/other2 && (true) \\\n 2>&1 && ${SHIP}`);
  allows('twin: cd d && ( ) \\<nl> 2>&1; push', `cd /work/other2 && (true) \\\n 2>&1; ${SHIP}`);
});

test('#352 R13-F1: a reserved word right after ) is not the subshell\'s redirect: it does not inherit the operator before the (', () => {
  denies('then cd d && ( ) else push', `if false; then cd /work/other2 && (true) else ${SHIP}; fi`);
  denies('then cd d && ( ) elif push', `if false; then cd /work/other2 && (true) elif ${SHIP}; then true; fi`);
  denies('then switch && ( ) else push', `if false; then ${RESET} && (true) else ${SHIP}; fi`);
  denies('then cd d && ( ) \\<nl> else push', `if false; then cd /work/other2 && (true) \\\n else ${SHIP}; fi`);
  allows('twin: then cd d && ( ) 2>&1 && push', `if false; then cd /work/other2 && (true) 2>&1 && ${SHIP}; fi`);
  allows('twin: then cd d && ( ) 2>&1 && push, newline continuation', `if false; then cd /work/other2 && (true) \\\n 2>&1 && ${SHIP}; fi`);
});

test('#352 R13-F2: the command in front of a ( ) glued after its words is still a stage of the pipeline that follows', () => {
  denies('cd d (N) | cat; push', `cd /work/other2 (N) | cat; ${SHIP}`);
  denies('cd d (true) | cat && push', `cd /work/other2 (true) | cat && ${SHIP}`);
  denies('switch (N) | cat; push', `${RESET} (N) | cat; ${SHIP}`);
  allows('twin: (cd d && push) | cat', `(cd /work/other2 && ${SHIP}) | cat`);
  allows('twin: cd d && npm test 2>&1 | tail, push in its own line', `cd /work/other2 && echo hi 2>&1 | tail && ${SHIP}`);
});

// (#352 R14: only an unquoted reserved word that can follow `)` gives the subshell's tail back; a `{fd}>` redirect, a zsh anonymous function or a short-form body keeps the list going)
test('#352 R14-B1: a named-descriptor redirect after ) is part of the subshell command: a & after it still backgrounds the cd', () => {
  denies('cd d && ( ) {fd}>/dev/null & push', `cd /work/other2 && (true) {fd}>/dev/null & ${SHIP}`);
  denies('switch && ( ) {fd}>/dev/null & push', `${RESET} && (true) {fd}>/dev/null & ${SHIP}`);
  allows('twin: cd d && ( ) {fd}>/dev/null && push', `cd /work/other2 && (true) {fd}>/dev/null && ${SHIP}`);
  allows('twin: cd d && ( ) {fd}>/dev/null; push', `cd /work/other2 && (true) {fd}>/dev/null; ${SHIP}`);
});

test('#352 R14-F1: a zsh anonymous function or short-form body after ) still continues the list that began before the (', () => {
  denies('cd d && () { true; } & push', `cd /work/other2 && () { true; } & ${SHIP}`);
  denies('switch || () { push; }', `${RESET} || () { ${SHIP}; }`);
  denies('cd d && if (true) echo hi & push', `cd /work/other2 && if (true) echo hi & ${SHIP}`);
  allows('twin: cd d && () { true; } && push', `cd /work/other2 && () { true; } && ${SHIP}`);
  allows('twin: cd d && () { true; }; push', `cd /work/other2 && () { true; }; ${SHIP}`);
  allows('twin: switch; () { push; }', `${RESET}; () { ${SHIP}; }`);
  // (R16: an `if (true) echo hi` has no `then`: a zsh short form the parser does not follow, so the line is refused wholesale: was an allow)
  denies('twin: cd d && if (true) echo hi && push (short form, R16)', `cd /work/other2 && if (true) echo hi && ${SHIP}`);
});

// (#352 R15-F1: after a `( )` that ends the condition of if / while / until in zsh, the next word is the BODY, which runs when the condition FAILED: it must not keep the `&&` that stood before the `(`)
test('#352 R15-F1: the body after a ( ) that ends a zsh if / until condition is not on the && list of the condition', () => {
  denies('until cd d && (true) { push; break; }', `until cd /work/other2 && (true) { ${SHIP}; break; }`);
  denies('until switch && (true) { push; break; }', `until ${RESET} && (true) { ${SHIP}; break; }`);
  denies('if cd d && (true) { : } else { push }', `if cd /work/other2 && (true) { : } else { ${SHIP} }`);
  denies('until cd d && ((1)) push', `until cd /work/other2 && ((1)) ${SHIP}`);
  // (R16: a condition-then-body form is not followed, so these two former allows are refusals)
  denies('twin: cd d && until (false) { push; break; } (R16)', `cd /work/other2 && until (false) { ${SHIP}; break; }`);
  denies('twin: cd d && if (true) { push } (R16)', `cd /work/other2 && if (true) { ${SHIP} }`);
});

test('#352 R15-F1: the } of a zsh alternate-form body ends its until / if, so a later || runs when the change failed', () => {
  denies('switch && until (true) { true; } || push', `${RESET} && until (true) { true; } || ${SHIP}`);
  denies('switch && until C && (true) { true; break; } || push', `${RESET} && until true && (true) { true; break; } || ${SHIP}`);
  denies('switch && if (true) { true; } || push', `${RESET} && if (true) { true; } || ${SHIP}`);
  denies('switch && if (true) { true; } else { true; } || push', `${RESET} && if (true) { true; } else { true; } || ${SHIP}`);
  // (R16: a condition-then-body form is not followed, so these two former allows are refusals)
  denies('twin: switch; until (true) { push; break; } (R16)', `${RESET}; until (true) { ${SHIP}; break; }`);
  denies('twin: switch && until (true) { true; } && push (R16)', `${RESET} && until (true) { true; } && ${SHIP}`);
});

// (#352 R16: the zsh "condition then body" forms (`if C (sub) { B }`, `until C [[ x ]] B`, `if C { } else { }`, `repeat N { }`, `for x in a b { }`) are not followed: while an if / while / until condition is open, a WORD after the ) / )) / ]] that ends it
// (or a `}` straight followed by else / elif without a `then`) makes the whole line's directory and branch unknown, so a later push is refused)
test('#352 R16-B1/F3: a zsh `if C { } else { }` whose else comes after blanks, a long gap or a line continuation is not followed: the push is refused', () => {
  denies('R16-B1: 40+ blanks before else', `if (true) { :; }${' '.repeat(45)}else { :; ${RESET}; }; ${SHIP}`);
  denies('R16-B1: 40+ blanks before else, switch without ;', `if (true) { :; }${' '.repeat(45)}else { :; ${RESET} }; ${SHIP}`);
  denies('R16-F3: backslash-newline before else', `if (true) { :; } \\\nelse { :; ${RESET} }; ${SHIP}`);
  denies('R16-F3: backslash-newline, switch with ;', `if (true) { :; } \\\nelse { :; ${RESET}; }; ${SHIP}`);
});

test('#352 R16-F1: a plain POSIX if / then / else with a brace group in the else branch keeps the if open until fi', () => {
  denies('R16-F1: else { :; }; switch; { :; } fi', `if true; then :; else { :; }; ${RESET}; { :; } fi; ${SHIP}`);
  denies('R16-F1 twin: else { switch; }; fi', `if true; then :; else { ${RESET}; }; fi; ${SHIP}`);
  denies('R16-F1 twin: else { :; }; switch; fi', `if true; then :; else { :; }; ${RESET}; fi; ${SHIP}`);
  allows('twin: then cd d; else { :; }; D; fi; push in its own line', `if true; then :; else { :; }; fi; cd /work/other2 && ${SHIP}`);
});

test('#352 R16-F2: a redirect, a {fd} redirect or a blank-only ( ) before the { of a zsh condition-then-body form is not followed', () => {
  denies('R16-F2: until C && (true) >/dev/null { push; break; }', `until cd /work/other2 && (true) >/dev/null { ${SHIP}; break; }`);
  denies('R16-F2: until C && (true) 2>&1 { push; break; }', `until cd /work/other2 && (true) 2>&1 { ${SHIP}; break; }`);
  denies('R16-F2: if C && (true) >/dev/null { : } else { push }', `if cd /work/other2 && (true) >/dev/null { : } else { ${SHIP} }`);
  denies('R16-F2: until C && (true) {fd}>/dev/null { push; break; }', `until cd /work/other2 && (true) {fd}>/dev/null { ${SHIP}; break; }`);
  denies('R16-F2: until C && ( ) { push; break; }', `until cd /work/other2 && ( ) { ${SHIP}; break; }`);
});

test('#352 R16-F4: a zsh `} else {` or a brace body the parser does not open is not followed, so its } cannot close an outer function or group', () => {
  denies('R16-F4: f() { if (true) { :; } else { :; }; switch; : }; push', `f() { if (true) { :; } else { :; }; ${RESET}; : }; ${SHIP}`);
  denies('R16-F4: false && { if (true) { :; } else { :; }; switch; : }; push', `false && { if (true) { :; } else { :; }; ${RESET}; : }; ${SHIP}`);
  denies('R16-F4: f() { repeat 1 { :; }; switch; : }; push', `f() { repeat 1 { :; }; ${RESET}; : }; ${SHIP}`);
  denies('R16-F4: f() { for x in a b { :; }; switch; : }; push', `f() { for x in a b { :; }; ${RESET}; : }; ${SHIP}`);
  denies('repeat 1 { switch; }; push', `repeat 1 { ${RESET}; }; ${SHIP}`);
  denies('for x in a b { switch; }; push', `for x in a b { ${RESET}; }; ${SHIP}`);
});

test('#352 R16-#432: a [[ ]] ending a zsh condition followed by a brace body is not followed', () => {
  denies('until C && [[ ]] { push }', `until cd /work/other2 && [[ -n x ]] { ${SHIP} }`);
  denies('if C && [[ ]] { : } else { push }', `if cd /work/other2 && [[ -n x ]] { : } else { ${SHIP} }`);
  denies('until C && [[ ]] { push; break; }', `until cd /work/other2 && [[ -n x ]] { ${SHIP}; break; }`);
  denies('while C && (( 1 )) short body', `while cd /work/other2 && ((1)) ${SHIP}`);
  // lines that use no condition-then-body form keep their verdict
  allows('twin: cd d && (npm test) && push', `cd /work/other2 && (npm test) && ${SHIP}`);
  allows('twin: if [ -f x ]; then cd d && push; fi', `if [ -f x ]; then cd /work/other2 && ${SHIP}; fi`);
  allows('twin: if [ -f x ]; then :; fi; push', `if [ -f x ]; then :; fi; ${SHIP}`, {}, '/work/other2');
  allows('twin: cd d && if (true); then echo hi; fi && push', `cd /work/other2 && if (true); then echo hi; fi && ${SHIP}`);
  allows('twin: cd d && if [[ -n x ]]; then echo hi; fi && push', `cd /work/other2 && if [[ -n x ]]; then echo hi; fi && ${SHIP}`);
  allows('twin: cd d && () { push; } (anonymous function)', `cd /work/other2 && () { ${SHIP}; }`);
  allows('twin: cd d && if ((1)); then :; fi && push', `cd /work/other2 && if ((1)); then :; fi && ${SHIP}`);
});

// (#352 R17: the R16 rule was keyed on the segment, but `[[ a && b ]]` is split by the && into two; a `{ }` group closed in argument position (zsh) ends a condition too; a word after `]]` / `repeat N` hides
// the body in the argv of `[[` / `repeat`; `case W { pat) cmd }` ends the case at the `{`. None of these is followed: the line is refused)
test('#352 R17-F1: a && inside [[ ]] does not hide the ]] that ends the condition of a zsh condition-then-body form', () => {
  denies('R17-F1: until C && [[ a && b ]] { push; break }', `until cd /work/other2 && [[ -n a && -n b ]] { ${SHIP}; break }`);
  denies('R17-F1: if C && [[ a && b ]] { : } else { push }', `if false && cd /work/other2 && [[ -n a && -n b ]] { : } else { ${SHIP} }`);
  denies('R17-F1: while C && [[ a || b ]] { push; break }', `while cd /work/other2 && [[ -n a || -n b ]] { ${SHIP}; break }`);
  denies('R17-F1: until C && [[ a && b && c ]] { push; break }', `until cd /work/other2 && [[ -n a && -n b && -n c ]] { ${SHIP}; break }`);
  allows('twin: cd d && if [[ a && b ]]; then :; fi && push', `cd /work/other2 && if [[ -n a && -n b ]]; then :; fi && ${SHIP}`);
  allows('twin: cd d && [[ a && b ]] && push', `cd /work/other2 && [[ -n a && -n b ]] && ${SHIP}`);
});

test('#352 R17-F2/F4: an unquoted { or } word in argument position (a zsh group ending a condition, a case body) is not followed', () => {
  denies('R17-F2: until C && { true } { push; break }', `until cd /work/other2 && { true } { ${SHIP}; break }`);
  denies('R17-F2: until { false && cd } { push; break }', `until { false && cd /work/other2 } { ${SHIP}; break }`);
  denies('R17-F2: if { false && cd } { : } else { push }', `if { false && cd /work/other2 } { : } else { ${SHIP} }`);
  denies('R17-F2: while C && { true } short body', `while cd /work/other2 && { true } ${SHIP}`);
  denies('R17-F4: case x { y) switch }; push', `case x { y) ${RESET} }; ${SHIP}`);
  denies('R17-F4: case x { y) cd d }; push (from the other worktree)', `case x { y) cd /work/main }; ${SHIP}`, {}, '/work/other2');
  denies('R17-F4: case x { y) : ;; } ; push after a switch', `${RESET}; case x { y) : }; ${SHIP}`, {}, MAIN_DIR);
  // everyday lines that carry a { or } as an argument keep their verdict
  allows('twin: find . -exec rm {} + ; push', `find . -exec rm {} + && ${SHIP}`, {}, '/work/other2');
  allows('twin: find . -exec echo {} \; ; push', `find . -exec echo {} \\; && ${SHIP}`, {}, '/work/other2');
  allows('twin: git log --format={} ; push', `git log --format={} && ${SHIP}`, {}, '/work/other2');
  allows('twin: echo $\{HOME} {a,b} x{1..3} ; push', `echo \${HOME} {a,b} x{1..3} && ${SHIP}`, {}, '/work/other2');
  allows('twin: echo "{" "}" ; push', `echo "{" "}" && ${SHIP}`, {}, '/work/other2');
});

test('#352 R17-F3: a word after the ]] that ends a condition, or after repeat N, hides the body in an argv: the line is refused', () => {
  refuses('R17-F3: if [[ ]] push (main)', `if [[ -n x ]] ${SHIP}`);
  refuses('R17-F3: until C && [[ ]] push', `until cd /work/other2 && [[ -n x ]] ${SHIP}`);
  refuses('R17-F3: if [[ ]] cd main; push (from the other worktree)', `if [[ -n x ]] cd /work/main; ${SHIP}`, {}, '/work/other2');
  refuses('R17-F3: repeat 1 push', `repeat 1 ${SHIP}`);
  refuses('R17-F3: repeat 1 cd main; push (from the other worktree)', `repeat 1 cd /work/main; ${SHIP}`, {}, '/work/other2');
  refuses('R17-F3: cd d && repeat 1 push', `cd /work/other2 && repeat 1 ${SHIP}`);
  allows('twin: if [[ ]]; then :; fi; push', `if [[ -n x ]]; then :; fi; ${SHIP}`, {}, '/work/other2');
});

// (#352 R18: the R17-F3 refusal held only when the `]]` armed the watch itself; a `]]` that follows a `( )` inside [[ ]], a `$( [[ ]] )` in the argv of the outer [[ ]] and a `{ }` group before the [[ ]] hid the
// body again. Any plain word after an unquoted `]]` of a [[ ]] command now refuses the line, however the watch was armed)
test('#352 R18-F1..F3: a word after a ]] that closes a [[ ]] command is a short-form body in an argv, however the condition was written: the line is refused', () => {
  refuses('R18-F1: if [[ ( -n x ) ]] push', `if [[ ( -n x ) ]] ${SHIP}`);
  refuses('R18-F1: if [[ $x == (a) ]] push', `if [[ $x == (a) ]] ${SHIP}`);
  refuses('R18-F1: if [[ ( -n x ) ]] cd main; push (from the other worktree)', `if [[ ( -n x ) ]] cd /work/main; ${SHIP}`, {}, '/work/other2');
  refuses('R18-F2: if [[ -n $([[ -n y ]] && echo x) ]] push', `if [[ -n $([[ -n y ]] && echo x) ]] ${SHIP}`);
  refuses('R18-F2: if [[ -n "$([[ -n y ]] && echo x)" ]] push', `if [[ -n "$([[ -n y ]] && echo x)" ]] ${SHIP}`);
  refuses('R18-F2: if [[ -n <([[ -n y ]] && echo x) ]] push', `if [[ -n <([[ -n y ]] && echo x) ]] ${SHIP}`);
  refuses('R18-F3: if { true } && [[ -n x ]] push', `if { true } && [[ -n x ]] ${SHIP}`);
  refuses('R18-F3: while { true } && [[ -n x ]] push', `while { true } && [[ -n x ]] ${SHIP}`);
  refuses('R18-F3: until { true } && [[ -n x ]] push', `until { true } && [[ -n x ]] ${SHIP}`);
  refuses('#352 R19-F2b: X=1 {fd}>/dev/null push (main)', `X=1 {fd}>/dev/null ${SHIP}`, {}, MAIN_DIR);
  refuses('#352 R19-F2b: command {fd}>/dev/null push (main)', `command {fd}>/dev/null ${SHIP}`, {}, MAIN_DIR);
  refuses('#352 R19-F2b: git {fd}>/dev/null push (main)', `git {fd}>/dev/null ${PUSH} origin HEAD`, {}, MAIN_DIR);
  refuses('(R22: leading {fd} + word is refused) #352 R19-F2b: {fd}>/dev/null X=1 push (main)', `{fd}>/dev/null X=1 ${SHIP}`, {}, MAIN_DIR);
  refuses('twin (R20: a {fd} word that is not leading is refused): cd other && X=1 {fd}>/dev/null push', `cd /work/other2 && X=1 {fd}>/dev/null ${SHIP}`, {}, MAIN_DIR);
  refuses('twin (R20: a {fd} word that is not leading is refused): cd other && command {fd}>/dev/null push', `cd /work/other2 && command {fd}>/dev/null ${SHIP}`, {}, MAIN_DIR);
  refuses('twin (R20: a {fd} word that is not leading is refused): cd other && git {fd}>/dev/null push', `cd /work/other2 && git {fd}>/dev/null ${PUSH} origin HEAD`, {}, MAIN_DIR);
  refuses('(R22: leading {fd} + word is refused) twin (R20: a {fd} word makes the cd of the line uncertain): cd other && {fd}>/dev/null X=1 push', `cd /work/other2 && {fd}>/dev/null X=1 ${SHIP}`, {}, MAIN_DIR);
  // lines that use [[ ]] as an ordinary command keep their verdict
  allows('twin: [[ ]] && push', `[[ -n x ]] && ${SHIP}`, {}, '/work/other2');
  allows('twin: [[ ]] || exit; push', `[[ -n x ]] || exit; ${SHIP}`, {}, '/work/other2');
  allows('twin: if [[ ]]; then push; fi', `if [[ -n x ]]; then ${SHIP}; fi`, {}, '/work/other2');
  allows('twin: if [[ ]] then push fi (newline form)', `if [[ -n x ]]\nthen ${SHIP}\nfi`, {}, '/work/other2');
  allows('twin: [[ ]] 2>/dev/null && push', `[[ -n x ]] 2>/dev/null && ${SHIP}`, {}, '/work/other2');
  allows('twin: [[ ( ) ]] && push', `[[ ( -n x ) ]] && ${SHIP}`, {}, '/work/other2');
  allows('twin: [[ $( [[ ]] ) ]] && push', `[[ -n $([[ -n y ]] && echo x) ]] && ${SHIP}`, {}, '/work/other2');
  allows('twin: { true } && [[ ]] && push', `{ true } && [[ -n x ]] && ${SHIP}`, {}, '/work/other2');
  allows('twin: [[ "a ]] b" ]] && push', `[[ -n "a ]] b" ]] && ${SHIP}`, {}, '/work/other2');
  allows("twin: echo ']]' foo; push", `echo ']]' foo; ${SHIP}`, {}, '/work/other2');
  allows('twin: echo ]] foo; push', `echo ]] foo; ${SHIP}`, {}, '/work/other2');
  allows('twin: while [[ ]]; do push; done', `while [[ -n x ]]; do ${SHIP}; break; done`, {}, '/work/other2');
});

// (#352 push security review of 5f7cdd12: `exec {fd}>f CMD` is zsh / bash >= 4.1's exec of CMD with a new descriptor, and sh / bash 3.2's exec of a command named {fd}: the two readings run different
// commands, so only a pure `exec {fd}>f [{fd2}>g …]` (it opens descriptors and runs nothing) keeps the exemption; any word after it refuses the line. Was allowed on main too.)
test('#352 push security review: exec {fd}>f followed by a command is refused; a pure exec {fd}>f is not', () => {
  refuses('exec {fd}>/dev/null push (main)', `exec {fd}>/dev/null ${SHIP}`, {}, MAIN_DIR);
  refuses('exec {fd}>/dev/null {g}>/dev/null push (main)', `exec {fd}>/dev/null {g}>/dev/null ${SHIP}`, {}, MAIN_DIR);
  refuses('X=1 exec {fd}>/dev/null push (main)', `X=1 exec {fd}>/dev/null ${SHIP}`, {}, MAIN_DIR);
  refuses('cd other && exec {fd}>/dev/null push (main)', `cd /work/other2 && exec {fd}>/dev/null ${SHIP}`, {}, MAIN_DIR);
  refuses('exec {fd}>/dev/null push HEAD:main (agent branch)', `exec {fd}>/dev/null ${SHIP}:${MAIN}`, {}, GIT_ROOT);
  // a pure exec that only opens descriptors keeps its verdict
  allows('twin: exec {fd}>/dev/null; push', `exec {fd}>/dev/null; ${SHIP}`, {}, GIT_ROOT);
  allows('twin: exec {fd}>/dev/null {g}>/dev/null; push', `exec {fd}>/dev/null {g}>/dev/null; ${SHIP}`, {}, GIT_ROOT);
  denies('twin: exec {fd}>/dev/null; push (main)', `exec {fd}>/dev/null; ${SHIP}`, {}, MAIN_DIR);
});

// (#352 R21-F2: a `{x}>f` word that is not the first word of its command is a redirect in zsh / bash >= 4.1 and an operand in sh / bash 3.2, so the two readings differ by one operand for ANY command
// (`git push origin {x}>f` pushes the current branch in zsh; `… | bash {x}>f` runs stdin), whatever wraps or quotes the head: every such word refuses the line, except a pure `exec {fd}>f …`)
test('#352 R21-F2: a non-leading {fd}>f word refuses the line whatever the command, wrapper or quoting', () => {
  for (const [what, cmd] of [
    ['command git push origin {x}>f', `command git ${PUSH} origin {x}>/dev/null`],
    ['env git push origin {x}>f', `env git ${PUSH} origin {x}>/dev/null`],
    ['exec git push origin {x}>f', `exec git ${PUSH} origin {x}>/dev/null`],
    ['\\git push origin {x}>f', `\\git ${PUSH} origin {x}>/dev/null`],
    ["'git' push origin {x}>f", `'git' ${PUSH} origin {x}>/dev/null`],
    ['git push origin {x}>f', `git ${PUSH} origin {x}>/dev/null`],
  ]) refuses(what, cmd, {}, MAIN_DIR);
  refuses('echo text | bash {x}>f', `echo 'git ${PUSH} origin HEAD:${MAIN}' | bash {x}>/dev/null`, {}, GIT_ROOT);
  refuses('echo text | sh {x}>f', `echo 'git ${PUSH} origin HEAD:${MAIN}' | sh {x}>/dev/null`, {}, GIT_ROOT);
  refuses('ls {x}>f; push', `ls {x}>/dev/null; ${SHIP}`, {}, GIT_ROOT);
  // unchanged: no {fd} word, a pure exec, a lone {fd}>f after a subshell
  allows('twin: exec {fd}>/dev/null; push', `exec {fd}>/dev/null; ${SHIP}`, {}, GIT_ROOT);
  allows('twin: ls >/dev/null; push', `ls >/dev/null; ${SHIP}`, {}, GIT_ROOT);
  allows('twin: (true) {fd}>/dev/null; push', `(true) {fd}>/dev/null; ${SHIP}`, {}, GIT_ROOT);
});

// (#352 R22: a subscripted descriptor name `{a[0]}>f` (bash >= 4.3) is a named-descriptor word like `{a}>f`; a leading one followed by any word refuses the line)
test('#352 R22: {a[0]}>f is a named-descriptor word, and a leading {fd}>f followed by a word refuses the line', () => {
  refuses('{a[0]}>f push HEAD:main', `{a[0]}>/dev/null ${SHIP}:${MAIN}`, {}, GIT_ROOT);
  refuses('git push origin {a[0]}>f (main)', `git ${PUSH} origin {a[0]}>/dev/null`, {}, MAIN_DIR);
  refuses('echo text | bash {a[0]}>f', `echo 'git ${PUSH} origin HEAD:${MAIN}' | bash {a[0]}>/dev/null`, {}, GIT_ROOT);
  refuses('{fd}>f X=1 push (main)', `{fd}>/dev/null X=1 ${SHIP}`, {}, MAIN_DIR);
  refuses('{fd}>f push (agent branch)', `{fd}>/dev/null ${SHIP}`, {}, GIT_ROOT);
  // unchanged: a lone leading {fd}>f, a pure exec
  allows('twin: {fd}>/dev/null; push', `{fd}>/dev/null; ${SHIP}`, {}, GIT_ROOT);
  allows('twin: exec {a[0]}>/dev/null; push', `exec {a[0]}>/dev/null; ${SHIP}`, {}, GIT_ROOT);
});

// (#352 R23-B1, R23-F1: bash takes any subscript of an array element as the descriptor name, a nested one (`{a[b[0]]}>f`) and a quoted one (`{a['0']}>f`, `{a[$'0']}>f`: quoting does not make the
// word a plain argument); either is a named-descriptor word like `{a[0]}>f`)
test('#352 R23-B1, R23-F1: a nested or quoted subscript in a named descriptor is a named-descriptor word', () => {
  for (const w of ['{a[b[0]]}', "{a['0']}", '{a["0"]}', "{a[$'0']}", "{a[b['0']]}"]) {
    refuses(`echo text | bash ${w}>f`, `echo 'git ${PUSH} origin HEAD:${MAIN}' | bash ${w}>/dev/null`, {}, GIT_ROOT);
    refuses(`ls ${w}>f; push`, `ls ${w}>/dev/null; ${SHIP}`, {}, GIT_ROOT);
    refuses(`${w}>f push HEAD:main`, `${w}>/dev/null ${SHIP}:${MAIN}`, {}, GIT_ROOT);
    refuses(`git push origin ${w}>f (main)`, `git ${PUSH} origin ${w}>/dev/null`, {}, MAIN_DIR);
    refuses(`if [[ ]] ${w}>f push`, `if [[ -n x ]] ${w}>/dev/null ${SHIP}`, {}, GIT_ROOT);
    refuses(`(R24-F2, R25-B1: a subscript that is no plain number refuses) exec ${w}>/dev/null; push`, `exec ${w}>/dev/null; ${SHIP}`, {}, GIT_ROOT);
  }
  // (#352 R24-F2: the subscript is arithmetic (quotes removed), so it may assign any name: only a plain number is followed)
  for (const w of ['{a["x=5"]}', '{a[x=5]}', '{a[x+=1]}', "{a['0']}", '{a[$i]}', '{a[i++]}']) refuses(`exec ${w}>f; push`, `exec ${w}>/dev/null; ${SHIP}`, {}, GIT_ROOT);
  // (#352 R25-B1: a plain name's value is evaluated as arithmetic too: only a plain number is followed)
  refuses('R25-B1: exec {a[i]}>/dev/null; push', `exec {a[i]}>/dev/null; ${SHIP}`, {}, GIT_ROOT);
  allows('twin: exec {a[12]}>/dev/null; push', `exec {a[12]}>/dev/null; ${SHIP}`, {}, GIT_ROOT);
  // (#352 R24-B1: a newline inside a quoted subscript; R24-F1: a line continuation around a quoted one, which the shell removes before it reads the word)
  for (const w of ["{a['x\ny']}", '{a["x\ny"]}', "{a\\\n['0']}", "{\\\na['0']}", "{a['0']\\\n}", "{a['0']}\\\n", '{a[$(\necho 0)]}']) {
    refuses(`git ${JSON.stringify(w)}>f push HEAD:main`, `git ${w}>/dev/null ${PUSH} origin HEAD:${MAIN}`, {}, GIT_ROOT);
    refuses(`echo text | bash ${JSON.stringify(w)}>f`, `echo 'git ${PUSH} origin HEAD:${MAIN}' | bash ${w}>/dev/null`, {}, GIT_ROOT);
  }
  // unchanged: a quoted word that is no named descriptor stays an argument
  allows("twin: echo '{a}' >/dev/null; push", `echo '{a}' >/dev/null; ${SHIP}`, {}, GIT_ROOT);
  allows("twin: echo '{a[0]}'x >/dev/null; push", `echo '{a[0]}'x >/dev/null; ${SHIP}`, {}, GIT_ROOT);
});

// (#352 R19: the R18 watch for a word after `]]` was tied to one segment and to the single next word: an inner && of the [[ ]] split the segment (B1), a reserved word right after `]]` hid the same-line body in
// the argv of `[[` (F1), and a `{fd}` redirect prefix disarmed it (F2))
test('#352 R19-B1, R19-F1, R19-F2: the ]] watch survives a && inside [[ ]], a same-line body after ]] then / ]] do is refused, a {fd} redirect does not disarm it', () => {
  refuses('R19-B1: if { true } && [[ -n a && -n b ]] push', `if { true } && [[ -n a && -n b ]] ${SHIP}`);
  refuses('R19-B1: while { true } && [[ -n a || -n b ]] push', `while { true } && [[ -n a || -n b ]] ${SHIP}`);
  refuses('R19-F1: if [[ ]] then push; fi', `if [[ -n x ]] then ${SHIP}; fi`);
  refuses('R19-F1: while [[ ]] do push; break; done', `while [[ -n x ]] do ${SHIP}; break; done`);
  refuses('R19-F1: if [[ ]] then cd main; fi; push (from the other worktree)', `if [[ -n x ]] then cd /work/main; fi; ${SHIP}`, {}, '/work/other2');
  refuses('R19-F1: if [[ a && b ]] then push; fi', `if [[ -n a && -n b ]] then ${SHIP}; fi`);
  refuses('R19-F2: if { true } && [[ ]] {fd}>/dev/null push', `if { true } && [[ -n x ]] {fd}>/dev/null ${SHIP}`);
  refuses('R19-F2: if [[ ( ) ]] {fd}>/dev/null push', `if [[ ( -n x ) ]] {fd}>/dev/null ${SHIP}`);
  refuses('(R22: leading {fd} + word is refused) R19-F2: a {fd}>file redirect prefix is no command word: {fd}>/dev/null push (main)', `{fd}>/dev/null ${SHIP}`, {}, MAIN_DIR);
  refuses('(R22: leading {fd} + word is refused) R19-F2: true && {fd}>/dev/null push (main)', `true && {fd}>/dev/null ${SHIP}`, {}, MAIN_DIR);
  // lines that use [[ ]] as an ordinary command keep their verdict
  allows('twin: if [[ ]]; then push; fi', `if [[ -n x ]]; then ${SHIP}; fi`, {}, '/work/other2');
  allows('twin: [[ a && b ]] && push', `[[ -n a && -n b ]] && ${SHIP}`, {}, '/work/other2');
  allows('twin: { true } && [[ a && b ]] && push', `{ true } && [[ -n a && -n b ]] && ${SHIP}`, {}, '/work/other2');
  allows('twin: while [[ ]]; do push; done', `while [[ -n x ]]; do ${SHIP}; break; done`, {}, '/work/other2');
  allows('twin: while [[ ]] newline do push done', `while [[ -n x ]]\ndo ${SHIP}; break\ndone`, {}, '/work/other2');
  allows('twin: [[ ]] {fd}>/dev/null && push', `[[ -n x ]] {fd}>/dev/null && ${SHIP}`, {}, '/work/other2');
  allows('twin: [[ ]] 2>/dev/null && push', `[[ -n x ]] 2>/dev/null && ${SHIP}`, {}, '/work/other2');
});

// (#352 R20: dropping every {fd}> word (R19-F2b) made the parser read what no shell reads. F1: a reserved word after a leading {fd}> word is a plain command word in zsh / bash >= 4.1 (not found), so the cd after it
// never runs; F2: in sh / dash / macOS bash 3.2 `{x}>f` is the word {x}, so dropping it shifts option values and lets a cd look certain. The rule now: any {fd} word makes the line's cd / branch switch uncertain,
// a {fd} word that is not leading (and not before exec) or a leading one followed by a reserved word refuses the line)
test('#352 R20-F1, R20-F2: a {fd} redirect word before a reserved word, in sh / dash / bash 3.2 reading, or mid-command never makes a cd certain', () => {
  for (const kw of ['then', 'else', 'elif', 'do', 'fi', 'done', 'while', 'until', '!', 'esac', 'if']) {
    refuses(`R20-F1: {fd}>/dev/null ${kw} cd other; push (main)`, `{fd}>/dev/null ${kw} cd /work/other2; ${SHIP}`, {}, MAIN_DIR);
  }
  refuses('R20-F1: {fd}>/dev/null function f cd other; push (main)', `{fd}>/dev/null function f cd /work/other2; ${SHIP}`, {}, MAIN_DIR);
  refuses('(R22: leading {fd} + word is refused) R20-F2: sh -c {fd}>/dev/null cd other; push (main)', `sh -c '{fd}>/dev/null cd /work/other2; ${SHIP}'`, {}, MAIN_DIR);
  refuses('(R22: leading {fd} + word is refused) R20-F2: bash -c {fd}>/dev/null cd other; push (main)', `bash -c '{fd}>/dev/null cd /work/other2; ${SHIP}'`, {}, MAIN_DIR);
  refuses('(R22: leading {fd} + word is refused) R20-F2: {fd}>/dev/null cd other; push (main)', `{fd}>/dev/null cd /work/other2; ${SHIP}`, {}, MAIN_DIR);
  refuses('R20-F2: sh -c git --namespace {x}>/dev/null push (main)', `sh -c 'git --namespace {x}>/dev/null ${PUSH} origin HEAD:${MAIN}'`, {}, MAIN_DIR);
  refuses('R20-F2: bash -c git --namespace {x}>/dev/null push (main)', `bash -c 'git --namespace {x}>/dev/null ${PUSH} origin HEAD:${MAIN}'`, {}, MAIN_DIR);
  refuses('R20-F2: git --work-tree {x}>/dev/null push (main)', `git --work-tree {x}>/dev/null ${PUSH} origin HEAD:${MAIN}`, {}, MAIN_DIR);
  refuses('R20-F2: git --namespace {x}>/dev/null push (main)', `git --namespace {x}>/dev/null ${PUSH} origin HEAD:${MAIN}`, {}, MAIN_DIR);
});

// (#352 R17-F5: the zsh condition-then-body forms are not followed, so EVERY line of this cross product that holds a push is refused. No shell model is needed: the generator of the differential test has no
// "unknown" verdict to compare with, so the forms are enumerated here instead. The condition enders and the bodies are those the rounds 15..17 found by hand, one spelling at a time)
test('#352 R17-F5: every zsh condition-then-body line (if / until / while + condition ender + redirect + body, case W { }, repeat N) that holds a push is refused', () => {
  const ENDERS = ['(true)', '((1))', '[[ -n x ]]', '[[ -n a && -n b ]]', '{ true }', '[[ ( -n x ) ]]', '[[ -n $([[ -n y ]] && echo x) ]]', '{ true } && [[ -n x ]]', '{ true } && [[ -n a && -n b ]]'];
  const REDIRS = ['', ' >/dev/null', ' 2>&1', ' {fd}>/dev/null'];
  const BODIES = [`{ ${SHIP}; break }`, `{ ${SHIP} }`, `{ ${SHIP}; }`, SHIP, `{ : } else { ${SHIP} }`, `{ : } else { ${SHIP}; }`, `{ : }; ${SHIP}`];
  const PREFIXES = ['cd /work/other2 && ', 'cd /work/other2; ', 'false && cd /work/other2 && '];
  const seen = { enders: new Set(), bodies: new Set(), kinds: new Set(), n: 0 };
  const check = (kind, ender, body, line) => { refuses(`${kind} ${ender} / ${body}: ${line}`, line); seen.n++; seen.kinds.add(kind); if (ender) seen.enders.add(ender); seen.bodies.add(body); };
  for (const pre of PREFIXES) {
    for (const head of ['if', 'until', 'while']) {
      for (const ender of ENDERS) for (const redir of REDIRS) for (const body of BODIES) {
        // (an if / elif keeps its else only for the if: the loops take the other bodies)
        if (head !== 'if' && body.includes('else')) continue;
        check(head, ender + redir, body, `${pre}${head} ${pre.startsWith('false') ? 'true && ' : ''}${ender}${redir} ${body}`);
      }
    }
    for (const arm of [`y) ${SHIP} }`, `y) ${SHIP}; }`, `y) ${SHIP} ;; }`, `y) ${RESET} }; ${SHIP}`]) check('case', '', arm, `${pre}case x { ${arm}`);
    for (const body of [SHIP, `{ ${SHIP} }`, `{ ${SHIP}; }`, `${RESET}; ${SHIP}`]) check('repeat', '', body, `${pre}repeat 1 ${body}`);
  }
  // (coverage: the node was drawn: every kind, every ender and every body of the table appears in at least one checked line)
  assert.deepEqual([...seen.kinds].sort(), ['case', 'if', 'repeat', 'until', 'while']);
  assert.equal(seen.enders.size, ENDERS.length * REDIRS.length, 'every ender x redirect was drawn');
  assert.ok(BODIES.every((b) => seen.bodies.has(b)), 'every body was drawn');
  assert.ok(seen.n >= 600, `only ${seen.n} lines were checked`);
});
