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
  allows('twin: then cd d && ( ) 2>&1; push', `if false; then cd /work/other2 && (true) 2>&1; ${SHIP}; fi`);
});

test('#352 R13-F2: the command in front of a ( ) glued after its words is still a stage of the pipeline that follows', () => {
  denies('cd d (N) | cat; push', `cd /work/other2 (N) | cat; ${SHIP}`);
  denies('cd d (true) | cat && push', `cd /work/other2 (true) | cat && ${SHIP}`);
  denies('switch (N) | cat; push', `${RESET} (N) | cat; ${SHIP}`);
  allows('twin: (cd d && push) | cat', `(cd /work/other2 && ${SHIP}) | cat`);
  allows('twin: cd d && npm test 2>&1 | tail, push in its own line', `cd /work/other2 && echo hi 2>&1 | tail && ${SHIP}`);
});
