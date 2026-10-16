// Why (issue #81, task t4): since #75 the git guard judges a once-assigned name and a literal loop variable one value at a time ("readings"), but only for the line
// itself. A script the guard opens (`bash scripts/run.sh`, `./run.sh`, a script the line writes with a heredoc) never got readings, so these were refused although nothing
// about them is risky (replay of 21 days of transcripts, "bucket F"):
//   F1. a script with its own loop: `for f in a b; do node chk.mjs $f; done`, run by `bash scripts/run.sh`.
//   F2. the same script written by the line (`cat > x.sh <<'EOF' … EOF`) and then run.
//   F3. a name collision: the line's loop name flows into the script (`for n in 1 2; do bash scripts/brief.sh plan $n; done` with `n=$2` in brief.sh; superpowers' task-brief pattern).
//       The script's own assignment is read both ways like a line's, so the collision needs no rule about which names a child shell inherits; the twins below pin what must
//       still reach the script (exported names, a prefix assignment, `set -a`, a sourced file's shared variables).
// Each shape is allowed now, next to its malicious twins (a fake script that holds a guarded command), which must stay refused. The file system is faked; guarded text only lives
// in fake file contents. The files guard has loop handling of its own (unchanged here): these tests judge the git guard, and the twins are also checked against the files guard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname, basename } from 'node:path';
import { evaluateGitCommand } from '../pipeline/hooks/lib/git-policy.mjs';
import { evaluateBashForFiles } from '../pipeline/hooks/lib/files-policy.mjs';

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
const PROJ = '/home/u/proj';
const BAD_GIT = 'git push origin main';
const BAD_FILES = 'echo x > ~/.claude/settings.json';
const DIRS = ['scripts', 'sub'];
const git = (command, files, o = {}) => evaluateGitCommand(command, {
  cwd: GIT_ROOT, home: '/home/u', currentBranch: () => 'agent/x', pushDestination: () => null, issueLabels: () => [], realpath: (p) => p, ...fakeFs(GIT_ROOT, files, DIRS), ...o,
});
const filesGuard = (command, files) => {
  const fs = fakeFs(PROJ, files, DIRS);
  return evaluateBashForFiles(command, { home: '/home/u', env: {}, platform: 'linux', realpath: (p) => p, cwd: PROJ, ...fs, existsSync: fs.pathExists });
};
// spec values: 'bad' (a guarded command), 'ok', or the text itself
const mk = (spec, bad) => Object.fromEntries(Object.entries(spec).map(([k, v]) => [k, v === 'bad' ? bad : v === 'ok' ? (bad === BAD_GIT ? 'git status' : 'echo hi') : v]));
const allow = (command, spec, o) => {
  const r = git(command, mk(spec, BAD_GIT), o);
  assert.equal(r.decision, 'allow', `git: ${command} -> ${r.reason}`);
};
// a twin: refused by the git guard, and by the files guard too
const deny = (command, spec, o) => {
  const r = git(command, mk(spec, BAD_GIT), o);
  assert.equal(r.decision, 'deny', `git: ${command} -> allowed`);
  const f = filesGuard(command, mk(spec, BAD_FILES));
  assert.equal(f.decision, 'deny', `files: ${command} -> allowed`);
  return r;
};
const denyGit = (command, spec, o) => {
  const r = git(command, mk(spec, BAD_GIT), o);
  assert.equal(r.decision, 'deny', `git: ${command} -> allowed`);
  return r;
};

const CHK = { 'chk.mjs': 'console.log(1)\n', 'a': 'x', 'b': 'x', 'ok.sh': 'ok', 'ok2.sh': 'ok', 'run.sh': 'bad' };

// ---- F1. a script with a loop of its own ---------------------------------------------------------------------------------------

test('F1: a script that loops over literal words is read word by word', () => {
  const loop = 'set -e\nfor f in a b; do node chk.mjs $f; done\n';
  for (const cmd of ['bash scripts/run.sh', 'sh scripts/run.sh', 'zsh scripts/run.sh', './scripts/run.sh', 'cd scripts && bash run.sh', 'bash scripts/run.sh --flag']) {
    allow(cmd, { ...CHK, 'scripts/run.sh': loop });
  }
  // the loop reaches a script of its own
  allow('bash scripts/loop.sh', { ...CHK, 'scripts/loop.sh': 'for f in ok.sh ok2.sh; do bash $f; done\n' });
  // a once-assigned name in a script (the assignment may not run)
  allow('bash scripts/once.sh', { ...CHK, 'scripts/once.sh': 'true && S=ok.sh\nbash $S\n' });
  // a loop word built from a name the script assigns (worked out where the loop runs)
  allow('bash scripts/words.sh', { ...CHK, 'sub/a.sh': 'ok', 'sub/ok.sh': 'ok', 'scripts/words.sh': 'B=sub\nfor f in $B/a.sh $B/ok.sh; do bash $f; done\n' });
  // under a reading of the line itself (the script takes readings of its own)
  allow('for g in 1 2; do bash scripts/run.sh $g; done', { ...CHK, 'scripts/run.sh': loop });
  allow('for g in 1 2; do bash scripts/run.sh; node chk.mjs $g; done', { ...CHK, 'scripts/run.sh': loop });
  // a script that runs a script with a loop (readings at the second level)
  allow('bash scripts/outer.sh', { ...CHK, 'scripts/outer.sh': 'bash scripts/run.sh\n', 'scripts/run.sh': loop });
});

test('F1 twins: a loop in the script that reaches a bad script, or a name the readings cannot follow, stays refused', () => {
  const S = (text) => ({ ...CHK, 'scripts/s.sh': text });
  for (const body of [
    'for f in ok.sh run.sh; do bash $f; done\n', // (the second word is the bad script)
    'for f in run.sh; do bash $f; done\n',
    'for f in ok.sh run.sh; do (bash $f); done\n',
    'f=ok.sh; f=run.sh; bash $f\n', // (two assignments)
    'f=ok.sh\nf=run.sh\nbash $f\n',
    'true && f=run.sh; bash $f\n', // (the reading where the assignment ran)
    'for f in ok.sh; do f=run.sh; bash $f; done\n', // (the loop name is assigned again)
    'for f in ok.sh run.sh; do read f; bash $f; done\n', // (read binds it)
    'for f in ok.sh run.sh; do eval "f=run.sh"; bash $f; done\n',
  ]) {
    deny('bash scripts/s.sh', S(body));
    deny('./scripts/s.sh', S(body));
  }
  deny('bash scripts/words.sh', { ...CHK, 'sub/a.sh': 'ok', 'sub/run.sh': 'bad', 'scripts/words.sh': 'B=sub\nfor f in $B/a.sh $B/run.sh; do bash $f; done\n' });
  // a name the script assigns where the assignment may not run is unknown in one of its readings
  denyGit(`bash scripts/s.sh; echo ${BAD_GIT}`, S('true && S=ok.sh\nbash $S\n'));
  // the line's own readings are still there after the script's: a name assigned once after it may not have been assigned
  denyGit('for g in 1 2; do bash scripts/run.sh; done; true && B=agent/x; git push origin HEAD:$B', { ...CHK, 'scripts/run.sh': 'for f in a b; do node chk.mjs $f; done\n' });
  denyGit('true && A=agent/x; for g in 1 2; do bash scripts/run.sh; done; git push origin HEAD:$A', { ...CHK, 'scripts/run.sh': 'for f in a b; do node chk.mjs $f; done\n' });
  // a loop over a bad script in a script run from a loop of the line
  deny('for g in 1 2; do bash scripts/s.sh; done', S('for f in ok.sh run.sh; do bash $f; done\n'));
  // the bad script is only reached at the second level
  deny('bash scripts/outer.sh', { ...CHK, 'scripts/outer.sh': 'bash scripts/s.sh\n', 'scripts/s.sh': 'for f in ok.sh run.sh; do bash $f; done\n' });
  // the git commands of the script are judged one word at a time too
  denyGit('bash scripts/s.sh', S('for b in agent/x main; do git push origin HEAD:$b; done\n'));
  allow('bash scripts/s.sh', S('for b in agent/x agent/y; do git status $b; done\n'));
});

// ---- F2. a script the line writes, then runs -----------------------------------------------------------------------------------

test('F2: a script written by the line with a heredoc is read like a file on disk', () => {
  const loop = 'for f in a b; do node chk.mjs $f; done';
  for (const cmd of [
    `cat > x.sh <<'EOF'\n${loop}\nEOF\nbash x.sh`,
    `cat > x.sh <<'EOF'\n${loop}\nEOF\nchmod +x x.sh && ./x.sh`,
    `cat > scripts/x.sh <<'EOF'\n${loop}\nEOF\nsh scripts/x.sh`,
    `cat > x.sh <<'EOF'\nfor f in ok.sh ok2.sh; do bash $f; done\nEOF\nbash x.sh`,
    `cat > x.sh <<'EOF'\ntrue && S=ok.sh\nbash $S\nEOF\nbash x.sh`,
  ]) allow(cmd, CHK);
});

test('F2 twins: a written script with a loop over a bad script stays refused', () => {
  for (const cmd of [
    "cat > x.sh <<'EOF'\nfor f in ok.sh run.sh; do bash $f; done\nEOF\nbash x.sh",
    "cat > x.sh <<'EOF'\nfor f in ok.sh run.sh; do bash $f; done\nEOF\nchmod +x x.sh && ./x.sh",
    "cat > x.sh <<'EOF'\nf=ok.sh; f=run.sh; bash $f\nEOF\nbash x.sh",
    "cat > x.sh <<'EOF'\ntrue && f=run.sh\nbash $f\nEOF\nbash x.sh",
  ]) deny(cmd, CHK);
});

// ---- F3. the line's loop name and the script's own variable of the same name ---------------------------------------------------

const BRIEF = 'set -euo pipefail\nn=$2\nawk -v n="$n" \'BEGIN { print n }\' plan.md\n';

test('F3: the line\'s loop name and a name the script assigns once are both read (brief.sh: n=$2)', () => {
  const fs = { ...CHK, 'scripts/brief.sh': BRIEF, 'plan.md': 'x' };
  for (const cmd of [
    'bash scripts/brief.sh plan 1', // (the same script run once is allowed)
    'for n in 1 2; do bash scripts/brief.sh plan $n; done',
    'for n in 1 2 3; do ./scripts/brief.sh plan $n; done',
    'for n in 1 2; do sh scripts/brief.sh plan $n; done',
    'N=3; for n in 1 2; do bash scripts/brief.sh plan $n; done',
    'n=5; bash scripts/brief.sh plan $n; echo $n',
    'for n in 1 2; do bash scripts/brief.sh plan $n | head -3; done',
  ]) allow(cmd, fs);
});

test('F3 twins: what the line exports (or hands to the child) reaches the script, and a sourced file shares every variable', () => {
  const S = (text) => ({ ...CHK, 'scripts/s.sh': text });
  const use = 'bash $f\n';
  for (const cmd of [
    'export f=run.sh; bash scripts/s.sh',
    'f=run.sh; export f; bash scripts/s.sh',
    'f=run.sh bash scripts/s.sh', // (a prefix assignment is in the child\'s environment)
    'f=run.sh ./scripts/s.sh',
    'env f=run.sh bash scripts/s.sh',
    'set -a; f=run.sh; bash scripts/s.sh',
    'set -ea; f=run.sh; bash scripts/s.sh',
    'set -o allexport; f=run.sh; bash scripts/s.sh',
    'setopt allexport; f=run.sh; bash scripts/s.sh',
    'declare -x f=run.sh; bash scripts/s.sh',
    'typeset -x f=run.sh; bash scripts/s.sh',
    'declare -gx f=run.sh; bash scripts/s.sh',
    'for f in ok.sh run.sh; do export f; bash scripts/s.sh; done',
    'for f in ok.sh run.sh; do f=$f bash scripts/s.sh; done',
    'for f in ok.sh run.sh; do env f=$f bash scripts/s.sh; done',
    'for f in ok.sh run.sh; do source scripts/s.sh; done', // (source shares the variables: as before)
    'for f in ok.sh run.sh; do . scripts/s.sh; done',
    'f=run.sh; source scripts/s.sh',
    'f=run.sh; eval "$(cat scripts/s.sh)"',
  ]) deny(cmd, S(use));
  // an exported name in a script reaches the scripts it runs
  deny('bash scripts/s.sh', { ...CHK, 'scripts/s.sh': 'export f=run.sh\nbash scripts/t.sh\n', 'scripts/t.sh': use });
  deny('bash scripts/s.sh', { ...CHK, 'scripts/s.sh': 'for f in ok.sh run.sh; do export f; bash scripts/t.sh; done\n', 'scripts/t.sh': use });
  deny('bash scripts/s.sh', { ...CHK, 'scripts/s.sh': 'f=run.sh bash scripts/t.sh\n', 'scripts/t.sh': use });
  // a name the hook's own environment holds is exported already: assigning it on the line keeps it exported
  denyGit('f=run.sh; bash scripts/s.sh', S(use), { env: { f: 'ok.sh' } });
  denyGit('for f in ok.sh run.sh; do bash scripts/s.sh; done', S(use), { env: { f: 'ok.sh' } });
});

// Why (security review of t4): judgeReadings compared only the LAST reading's end state with the state the script started in. A branch or alias an EARLIER reading changed
// but the last did not was left known: `git checkout main` in one reading of the script, nothing in the other, and the outer line's `git push` was judged on a branch
// the run may no longer be on. The states of all readings are joined: whatever any reading changed is unknown afterwards.
test('t4 state-union: a branch or alias changed by an earlier reading of a script is unknown afterwards, whichever reading comes last', () => {
  // The line is on agent/x (an earlier checkout). The script reads two ways; its LAST reading leaves the branch where it started, the first moves it to main.
  const first = 'git checkout agent/x; bash scripts/s.sh';
  const MOVE = { 'scripts/s.sh': 'for b in main agent/x; do git checkout $b; done\n' };
  for (const tail of ['git push origin HEAD', 'git push']) assert.equal(git(`${first}; ${tail}`, mk(MOVE, BAD_GIT)).decision, 'deny', tail);
  // (the same with the move in the last reading was refused before: kept so)
  assert.equal(git(`${first}; git push origin HEAD`, mk({ 'scripts/s.sh': 'for b in agent/x main; do git checkout $b; done\n' }, BAD_GIT)).decision, 'deny');
  // control: no reading moves the branch -> it is still the one the line is on, and a push of it is allowed
  const STAY = { 'scripts/s.sh': 'for b in agent/x agent/x; do git checkout $b; done\n' };
  assert.equal(git(`${first}; git push origin HEAD`, mk(STAY, BAD_GIT)).decision, 'allow');
  // a push that names its branch does not depend on where the line is
  assert.equal(git(`${first}; git push origin agent/x`, mk(MOVE, BAD_GIT)).decision, 'allow');
  // an alias the first reading redefines and the last puts back: the alias is unknown afterwards
  const AL = { 'scripts/s.sh': "for v in 'push -f' status; do git config alias.pp \"$v\"; done\n" };
  assert.equal(git('git config alias.pp status; bash scripts/s.sh; git pp origin agent/x', mk(AL, BAD_GIT)).decision, 'deny');
});
