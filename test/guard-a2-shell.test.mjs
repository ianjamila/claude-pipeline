// Why (PR A2, batch S1): zsh/startup shapes that ran code the guards did not judge.
//   1. zsh EQUALS: a leading `=` on the command word runs the PATH command (`=git push origin main` is `git push ...`), and an `=name`
//      operand is the PATH lookup of `name` (`bash =tool` runs the file `tool` resolves to).
//   2. zsh alternation globs `(a|b)` (also `name(a|b).sh`) as script operands: refused, like the ksh `@(a|b)` forms.
//   3. A script run by path starts the shell its shebang names: `#!/bin/bash -l` reads the profile files, `#!/bin/zsh` ~/.zshenv.
// The file system is faked (like test/guard-script-expansion.test.mjs); the guarded text only lives in fake file contents or in
// command strings (never in a shell command of the session).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname, basename } from 'node:path';
import { evaluateGitCommand } from '../pipeline/hooks/lib/git-policy.mjs';
import { evaluateBashForFiles } from '../pipeline/hooks/lib/files-policy.mjs';
import { simpleCommands, commandName, scriptFileOf, shebangShell } from '../pipeline/hooks/lib/shell-parse.mjs';

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

const DIRS = ['bin', 'bin2', 'sub', 'hb', 'hz'];
// spec: { name: 'bad' | 'ok' | <text> }; the same names are written into both fake file systems. `o`: { env } is the hook's environment.
function both(command, spec = {}, o = {}) {
  const mk = (bad, ok) => Object.fromEntries(Object.entries(spec).map(([k, v]) => [k, v === 'bad' ? bad : v === 'ok' ? ok : typeof v === 'function' ? v(bad, ok) : v]));
  return {
    git: git(command, fakeFs(GIT_ROOT, mk(BAD_GIT, 'git status'), DIRS), o),
    files: files(command, fakeFs(PROJ, mk(BAD_FILES, 'echo hi'), DIRS), o),
  };
}
const denyBoth = (command, spec, o) => {
  const r = both(command, spec, o);
  assert.equal(r.git.decision, 'deny', `git: ${command} -> ${r.git.reason}`);
  assert.equal(r.files.decision, 'deny', `files: ${command} -> ${r.files.reason}`);
  return r;
};
const allowBoth = (command, spec, o) => {
  const r = both(command, spec, o);
  assert.equal(r.git.decision, 'allow', `git: ${command} -> ${r.git.reason}`);
  assert.equal(r.files.decision, 'allow', `files: ${command} -> ${r.files.reason}`);
};

const SPEC = { 'f.sh': 'bad', 'ok.sh': 'ok', 'x.sh': 'ok', 'bin/tool': 'bad', 'bin2/tool': 'ok' };

// ---- 1a: `=cmd` as the command word -----------------------------------------------------------------------------------------

test('S1: a leading = on the command word runs the PATH command (git-policy)', () => {
  for (const c of [
    '=git push origin main', '=git push origin master', '=git push --force origin agent/x main', '=gh pr merge 5 --admin', '=sudo git push origin main', '=env git push origin main',
    'FOO=1 =git push origin main', 'cd /work/repo && =git push origin main', '=command git push origin main', '=nohup =git push origin main',
  ]) assert.equal(git(c, fakeFs(GIT_ROOT, {}, DIRS)).decision, 'deny', c);
  for (const c of ['=git status', '=git push origin agent/x', '=gh pr list', 'echo =git push origin main', 'echo =x a==b', 'git push origin agent/x', '[ a =~ b ]', 'echo a =b']) {
    assert.equal(git(c, fakeFs(GIT_ROOT, {}, DIRS)).decision, 'allow', c);
  }
});

test('S1: a leading = on a writer or a shell runs it too (files-policy)', () => {
  for (const c of [
    '=cp ok.sh ~/.claude/settings.json', '=tee ~/.claude/settings.json', '=sed -i s/a/b/ ~/.claude/settings.json', '=mv ok.sh ~/.claude/settings.json', '=bash f.sh', '=sh f.sh',
    '=env bash f.sh', 'echo x | =tee ~/.claude/settings.json', '=install ok.sh ~/.claude/settings.json',
  ]) assert.equal(files(c, fakeFs(PROJ, { 'f.sh': BAD_FILES, 'ok.sh': 'echo hi' }, DIRS)).decision, 'deny', c);
  for (const c of ['=cp ok.sh /tmp/out.txt', '=ls ~/.claude/pipeline', 'echo =cp ok.sh ~/.claude/settings.json', '=bash ok.sh', 'echo =tee']) {
    assert.equal(files(c, fakeFs(PROJ, { 'f.sh': BAD_FILES, 'ok.sh': 'echo hi' }, DIRS)).decision, 'allow', c);
  }
});

test('S1: commandName strips one leading = (pure parser API)', () => {
  assert.equal(commandName('=git'), 'git');
  assert.equal(commandName('=GIT'), 'git');
  assert.equal(commandName('git'), 'git');
  assert.equal(commandName('='), '=');
  assert.equal(commandName('==x'), '==x');
});

// ---- 1b: `=name` as an operand ----------------------------------------------------------------------------------------------

test('S1: bash =tool runs the file tool resolves to on PATH: a PATH the line sets', () => {
  for (const c of [
    'PATH=bin:$PATH; bash =tool', 'PATH=bin:$PATH bash =tool', 'export PATH=bin:$PATH; bash =tool', 'PATH=bin bash =tool', 'PATH=$PWD:bin:/usr/bin; source =tool',
    'PATH=/usr/bin:bin; sh =tool', 'PATH=bin:$PATH; bash -x =tool', 'PATH=bin:$PATH; zsh =tool', 'env PATH=bin bash =tool', 'PATH=bin2:bin; bash =tool',
  ]) denyBoth(c, SPEC);
  denyBoth('bash =tool', SPEC, { env: { PATH: '/usr/bin:bin' } }); // the hook's own PATH
  allowBoth('PATH=bin2:$PATH; bash =tool', SPEC);
  allowBoth('PATH=bin2 bash =tool', SPEC);
  allowBoth('bash =tool', SPEC); // no PATH known: zsh finds nothing to run
  allowBoth('bash =nothing', SPEC, { env: { PATH: 'bin' } });
  // a prefix value replaces the other sources unless it refers to $PATH
  denyBoth('PATH=bin2:$PATH bash =tool', SPEC, { env: { PATH: 'bin' } });
  allowBoth('PATH=bin2 bash =tool', SPEC, { env: { PATH: 'bin' } });
  allowBoth('export PATH=bin; PATH=bin2 bash =tool', SPEC);
  denyBoth('export PATH=bin; PATH=bin2:$PATH bash =tool', SPEC);
  allowBoth('echo =tool', SPEC, { env: { PATH: 'bin' } });
});

test('S1: =tool as the command word runs the script it resolves to', () => {
  denyBoth('PATH=bin:$PATH; =tool', { ...SPEC, 'bin/tool': (bad) => `#!/bin/sh\n${bad}` });
  denyBoth('=tool', { ...SPEC, 'bin/tool': (bad) => `#!/bin/sh\n${bad}` }, { env: { PATH: 'bin' } });
  allowBoth('PATH=bin2:$PATH; =tool', { ...SPEC, 'bin/tool': (bad) => `#!/bin/sh\n${bad}` });
});

test('S1: =tool with a PATH known only at run time is refused when the line names a guarded operation / protected path', () => {
  assert.equal(git('PATH=$Q:$PATH; bash =tool; git push origin agent/x', fakeFs(GIT_ROOT, SPEC, DIRS)).decision, 'deny');
  assert.equal(files('PATH=$Q:$PATH; bash =tool; ls ~/.claude/pipeline', fakeFs(PROJ, SPEC, DIRS)).decision, 'deny');
  assert.equal(git('PATH=$Q:$PATH; bash =tool', fakeFs(GIT_ROOT, SPEC, DIRS)).decision, 'allow');
  assert.equal(files('PATH=$Q:$PATH; bash =tool', fakeFs(PROJ, SPEC, DIRS)).decision, 'allow');
});

test('S1: a quoted =tool is the literal file name (and an =tool word is only an operand where the shell reads one)', () => {
  denyBoth("bash '=tool'", { ...SPEC, '=tool': 'bad' });
  allowBoth('bash x.sh =tool', SPEC, { env: { PATH: 'bin' } }); // an argument of the script, not the script
});

test('S1: scriptFileOf marks an =name operand ambiguous (pure parser API)', () => {
  const sf = (line) => { const cmds = simpleCommands(line); return scriptFileOf(cmds[0].argv, cmds[0].raw, line); };
  assert.equal(sf('bash =tool').ambiguous, true);
  assert.deepEqual(sf('bash =tool').words, ['=tool']);
  assert.equal(sf('=tool').ambiguous, true);
  assert.equal(sf('bash x.sh').ambiguous, undefined);
  assert.equal(sf('bash x.sh =tool').ambiguous, undefined);
});

// ---- 2: alternation globs ----------------------------------------------------------------------------------------------------

test('S1: a zsh (a|b) alternation as a script operand is refused, glued to a word or on its own', () => {
  for (const c of [
    'bash (f|x).sh', 'bash name(f|x).sh', 'bash ./(f|x).sh', 'source (f|x).sh', 'source a(f|x).sh', 'node (f|x).mjs', 'bash (f|zz).sh a', 'bash ((f|x)|zz).sh',
    'bash (f|x).sh | cat', 'bash (f|x).sh && echo done', 'bash -x (f|x).sh', 'bash f(.sh|.txt)', 'bash (f|x)', 'sh (f|x).sh; echo done',
  ]) denyBoth(c, SPEC);
  for (const c of [
    'bash x.sh', 'bash x.sh | (cat|wc)', '(bash x.sh|cat)', 'bash x.sh "(a|b)"', "bash x.sh '(a|b).sh'", 'bash x.sh $(echo a|cat)', 'echo (f|x).sh', 'if true; then (cd sub|cat); fi',
    'case x in (a|b) bash x.sh;; esac', 'for f in a b; do (bash x.sh); done',
  ]) allowBoth(c, SPEC);
});

// ---- 3: the shell a shebang names reads its startup files --------------------------------------------------------------------

const HOME_BAD = (name) => ({ [`/home/u/${name}`]: 'bad' });
test('S1: a script run by path whose shebang asks for a login shell reads the profile files', () => {
  const sc = (shebang) => ({ 'x.sh': `${shebang}\necho hi`, ...HOME_BAD('.bash_profile') });
  for (const sb of ['#!/bin/bash -l', '#!/usr/bin/env -S bash -l', '#!/bin/bash --login', '#!/usr/bin/env -S bash --login -e', '#!/bin/bash -le', '#!/usr/bin/env -S -i bash -l', '#!/usr/bin/env bash -l']) denyBoth('./x.sh', sc(sb));
  denyBoth('./x.sh', { 'x.sh': '#!/bin/sh -l\necho hi', ...HOME_BAD('.profile') });
  denyBoth('./x.sh', { 'x.sh': '#!/bin/bash -i\necho hi', ...HOME_BAD('.bashrc') });
  denyBoth('./x.sh', { 'x.sh': '#!/usr/bin/env -S zsh -l\necho hi', ...HOME_BAD('.zprofile') });
  denyBoth('./x.sh', { 'x.sh': '#!/bin/zsh -i\necho hi', ...HOME_BAD('.zshrc') });
  // the startup file is judged under the HOME the command gives the script
  denyBoth('HOME=hz ./x.sh', { 'x.sh': '#!/bin/bash -l\necho hi', 'hz/.bash_profile': 'bad' });
  allowBoth('HOME=hb ./x.sh', { 'x.sh': '#!/bin/bash -l\necho hi', 'hz/.bash_profile': 'bad', 'hb/.bash_profile': 'ok' });
  // a harmless profile is read and allowed
  allowBoth('./x.sh', { 'x.sh': '#!/bin/bash -l\necho hi', '/home/u/.bash_profile': 'ok' });
});

test('S1: a script run by path whose shebang names zsh reads ~/.zshenv, like zsh x.sh', () => {
  for (const sb of ['#!/bin/zsh', '#!/usr/bin/env zsh', '#!/usr/bin/env -S zsh -f', '#!/usr/local/bin/zsh -e']) denyBoth('./x.sh', { 'x.sh': `${sb}\necho hi`, ...HOME_BAD('.zshenv') });
  denyBoth('ZDOTDIR=hz ./x.sh', { 'x.sh': '#!/bin/zsh\necho hi', 'hz/.zshenv': 'bad' });
  allowBoth('./x.sh', { 'x.sh': '#!/bin/zsh\necho hi', '/home/u/.zshenv': 'ok' });
});

test('S1: a shebang that asks for no startup file adds none (controls)', () => {
  const bad = { ...HOME_BAD('.bash_profile'), ...HOME_BAD('.bashrc'), ...HOME_BAD('.profile'), ...HOME_BAD('.zshenv'), ...HOME_BAD('.zprofile'), ...HOME_BAD('.zshrc') };
  for (const sb of ['#!/bin/bash', '#!/usr/bin/env bash', '#!/bin/sh', '#!/usr/bin/env -S bash -e', '#!/usr/bin/env node', '#!/usr/bin/python3 -l', '', '# a comment, not a shebang -l']) {
    allowBoth('./x.sh', { 'x.sh': `${sb}\necho hi`, ...bad });
  }
  allowBoth('bash x.sh', { 'x.sh': '#!/bin/bash -l\necho hi', ...bad }); // bash x.sh ignores the shebang
  allowBoth('./x.sh', { 'x.sh': '\u0000\u0001#!/bin/bash -l', ...bad }); // a binary
});

test('S1: the shebang startup holds for candidates, written scripts and scripts reached through scripts', () => {
  const spec = { 'h1.sh': '#!/bin/bash -l\necho hi', 'h2.sh': '#!/bin/bash\necho hi', ...HOME_BAD('.bash_profile') };
  denyBoth('./h*.sh', spec);
  denyBoth('X=./h1.sh; $X', spec);
  denyBoth('./h[12].sh', spec);
  denyBoth('bash outer.sh', { ...spec, 'outer.sh': './h1.sh' });
  denyBoth('printf "#!/bin/bash -l\\necho hi\\n" > n.sh; chmod +x n.sh; ./n.sh', { ...HOME_BAD('.bash_profile') });
  allowBoth('./h2.sh', spec);
  allowBoth('bash outer.sh', { ...spec, 'outer.sh': './h2.sh' });
});

test('S1: shebangShell reads the shell a script starts (pure parser API)', () => {
  assert.deepEqual(shebangShell('#!/bin/bash -l\nx'), ['/bin/bash', '-l']);
  assert.deepEqual(shebangShell('#!/usr/bin/env -S bash -l -x\nx'), ['bash', '-l', '-x']);
  assert.deepEqual(shebangShell('#!/usr/bin/env bash\nx'), ['bash']);
  assert.deepEqual(shebangShell('#! /bin/zsh\nx'), ['/bin/zsh']);
  assert.deepEqual(shebangShell('#!/usr/bin/env -i FOO=1 sh\nx'), ['sh']);
  assert.deepEqual(shebangShell('#!/usr/bin/env -Sbash -l\nx'), ['bash', '-l']);
  assert.deepEqual(shebangShell('#!/usr/bin/env -u HOME zsh\nx'), ['zsh']);
  assert.equal(shebangShell('#!/usr/bin/env node\nx'), null);
  assert.equal(shebangShell('echo hi\n#!/bin/bash -l'), null);
  assert.equal(shebangShell(''), null);
  assert.equal(shebangShell('#!/usr/bin/env\n'), null);
});

// ---- S2: script text fed from a file reaches a program or shell by a route the first feed work did not model -------------------

import { scriptFeedsOf } from '../pipeline/hooks/lib/shell-parse.mjs';
const FEED = { 'f.sh': 'bad', 'x.sh': 'ok', 'ok.sh': 'ok' };
const feedsOf = (line) => simpleCommands(line).flatMap((c) => scriptFeedsOf(c, line));

test('S2: an interpreter with no script operand reads its program from stdin: the fed file is judged like `node f.mjs`', () => {
  for (const c of ['node < f.sh', 'deno < f.sh', 'bun < f.sh', 'python3 < f.sh', 'python < f.sh', 'ruby < f.sh', 'perl < f.sh', 'php < f.sh', 'cat f.sh | node', 'node - < f.sh', 'node /dev/stdin < f.sh', 'tsx < f.sh', 'node --no-warnings < f.sh', 'node < <(cat f.sh)', 'python3 -u < f.sh']) denyBoth(c, FEED);
  for (const c of ['node < x.sh', 'cat x.sh | node', 'node -e "console.log(1)" < f.sh', 'node x.sh < f.sh', "python3 -c 'print(1)' < f.sh", 'node --version < f.sh']) allowBoth(c, FEED);
});

test('S2: the fed file of an interpreter is a program, not a shell script (judged as program text)', () => {
  const kinds = feedsOf('node < f.sh').map((r) => r.kind);
  assert.deepEqual(kinds, ['interp']);
  assert.deepEqual(feedsOf('bash < f.sh').map((r) => r.kind), ['shell']);
});

test('S2: a variable that holds the text of a file, then run as code', () => {
  for (const c of [
    'X=$(cat f.sh); eval "$X"', 'X=$(cat f.sh); $X', 'X=$(cat f.sh); bash -c "$X"', 'X=`cat f.sh`; eval $X', 'X=$(<f.sh); eval "$X"', 'export X=$(cat f.sh); eval "$X"',
    'X=$(cat f.sh); echo "$X" | bash', 'X=$(cat f.sh); bash <<< "$X"', 'X=$(cat f.sh); eval "${X}"', 'X=$(cat f.sh); Y=$X; eval "$X"', 'X=$(cat f.sh); sh -c "$X"',
    'X=$(cat f.sh); if true; then eval "$X"; fi', 'declare X=$(cat f.sh); eval "$X"', 'X=$(cat f.sh) && eval "$X"',
  ]) denyBoth(c, FEED);
  for (const c of [
    'X=$(cat x.sh); eval "$X"', 'X=$(cat f.sh); echo "$X"', 'X=$(cat f.sh); eval "echo hi"', 'X=$(cat f.sh); Y=ok; eval "$Y"', 'X=$(cat x.sh); bash -c "$X"', 'X=$(cat f.sh); echo $X | wc -c',
  ]) allowBoth(c, FEED);
});

test('S2: a file descriptor opened from a file earlier on the line feeds the shell that reads it', () => {
  for (const c of [
    'exec 3< f.sh; bash <&3', 'exec 3< f.sh; bash /dev/fd/3', 'exec 3< f.sh; source /dev/fd/3', 'exec 3< f.sh; . /dev/fd/3', 'exec 3< f.sh; cat <&3 | bash', 'bash /dev/fd/3 3< f.sh',
    'exec 4< f.sh; bash 0<&4', 'exec 3<> f.sh; bash <&3', 'exec 3< f.sh; bash /proc/self/fd/3', 'exec 3< f.sh && bash <&3', 'exec 3< f.sh; node <&3', 'exec 5< ok.sh; exec 3< f.sh; bash <&3',
  ]) denyBoth(c, FEED);
  for (const c of ['exec 3< x.sh; bash <&3', 'exec 3< f.sh; echo hi >&3', 'exec 3< f.sh; cat <&3', 'exec 3< x.sh; bash /dev/fd/3', 'exec 3< f.sh; exec 3<&-; bash x.sh']) allowBoth(c, FEED);
});

test('S2: a process substitution that runs a shell receives the stream of the command it is an operand of', () => {
  for (const c of [
    'tee >(bash) < f.sh', 'cat f.sh | tee >(bash)', 'cat f.sh > >(bash)', 'cat f.sh | tee >(sh -s)', 'cat f.sh | tee >(cat | bash)', 'cat f.sh | tee out.txt >(zsh)', 'tee >(bash) >/dev/null < f.sh',
  ]) denyBoth(c, FEED);
  for (const c of ['cat x.sh | tee >(bash)', 'cat f.sh | tee >(wc -l)', 'tee >(bash) < x.sh', 'cat f.sh | tee >(cat > out.txt)']) allowBoth(c, FEED);
});

test('S2: xargs builds shell code from the text it is fed', () => {
  for (const c of [
    "xargs -I{} sh -c '{}' < f.sh", 'xargs bash -c < f.sh', 'cat f.sh | xargs -0 sh -c', "xargs -a f.sh -I{} bash -c '{}'", "xargs -I% sh -c '%' < f.sh", "xargs --arg-file=f.sh -I{} sh -c '{}'",
    "cat f.sh | xargs -L1 sh -c 'echo; {}'", "xargs -I{} bash -lc '{}' < f.sh",
  ]) denyBoth(c, FEED);
  for (const c of ["xargs -I{} sh -c '{}' < x.sh", "xargs sh -c 'echo hi' < f.sh", 'xargs -n1 echo < f.sh', 'cat f.sh | xargs echo', 'cat f.sh | xargs wc -l', "xargs -I{} sh -c 'echo {}' < x.sh"]) allowBoth(c, FEED);
});

test('S2: only option-less cat (and cat -u) is an exact copy of a file: everything else that reads it is scanned', () => {
  assert.deepEqual(feedsOf('cat f.sh | bash').map((r) => r.kind), ['shell']);
  assert.deepEqual(feedsOf('cat -u f.sh | bash').map((r) => r.kind), ['shell']);
  assert.deepEqual(feedsOf('cat -- f.sh | bash').map((r) => r.kind), ['shell']);
  for (const c of ['cat -n f.sh | bash', 'cat -s f.sh | bash', 'cat -A f.sh | bash', 'cat -b f.sh | bash', 'less f.sh | bash', 'more f.sh | bash', 'bat f.sh | bash', 'batcat f.sh | bash', 'head -c 999 f.sh | bash', 'tail -c 9 f.sh | bash', 'tac f.sh | bash']) {
    assert.deepEqual(feedsOf(c).map((r) => r.kind), ['scan'], c);
    denyBoth(c, FEED);
  }
  // a scanned file is refused for any guarded word, an exact one only for a command that is really guarded
  const safe = { 'p.sh': 'git push origin agent/x' };
  assert.equal(git('cat p.sh | bash', fakeFs(GIT_ROOT, safe, DIRS)).decision, 'allow');
  assert.equal(git('cat -n p.sh | bash', fakeFs(GIT_ROOT, safe, DIRS)).decision, 'deny');
  assert.equal(git('bat p.sh | bash', fakeFs(GIT_ROOT, safe, DIRS)).decision, 'deny');
});

test('S2: several producers of one feed are judged joined when every one of them is a file that can be named', () => {
  for (const c of ['{ cat f.sh; cat ok.sh; } | bash', '{ cat x.sh; cat f.sh; } | bash', '{ cat x.sh; cat $Z; } | bash', '{ cat x.sh; cat *.sh; } | bash', '{ cat x.sh; tail -c 9 f.sh; } | bash', '{ cat x.sh; cat ~root/a.sh; } | bash']) denyBoth(c, FEED);
  for (const c of ['{ cat x.sh; cat ok.sh; } | bash', '{ cat x.sh; cat ok.sh; cat x.sh; } | sh', '{ cat x.sh; echo hi; } | bash', '(cat x.sh; cat ok.sh) | bash']) allowBoth(c, FEED);
  // the texts are one program: a guarded command split between two producers is one command
  const split = { 'a1.sh': 'git pu', 'a2.sh': 'sh origin main' };
  assert.equal(git('{ cat a1.sh; cat a2.sh; } | bash', fakeFs(GIT_ROOT, split, DIRS)).decision, 'deny');
  assert.equal(git('{ cat a2.sh; cat a1.sh; } | bash', fakeFs(GIT_ROOT, split, DIRS)).decision, 'allow');
});

test('S2: the program text of an inline interpreter run is not a file name', () => {
  for (const c of [
    `bash -c "$(node -e 'console.log([1,2].map((x)=>x*2)[0] === 2)')"`, `eval "$(node -e 'console.log(a[0] === 2)')"`, "bash -c \"$(node -e 'a=`x`')\"",
    `node -e 'console.log(a[0] === 2)' | $PSQL $DB`, `node -e 'console.log(a[0] === 2)' | bash`, `python3 -c 'print(a[0])' | bash`, `bash -c "$(python3 -c 'print([1][0])')"`, `perl -e 'print $a[0]' | sh`,
    `node --eval='console.log(a[0])' | bash`,
  ]) allowBoth(c, FEED);
  // the other words of the run are still files it may print
  for (const c of [`node -e 'console.log(1)' f.sh | bash`, `bash -c "$(node -e 'x[0]' f.sh)"`, `python3 -c 'print(1)' f.sh | bash`]) denyBoth(c, FEED);
});

test('S2: several files fed to an interpreter are one program', () => {
  const split = { 'p1.js': 'git pu', 'p2.js': 'sh origin main' };
  assert.equal(git('cat p1.js p2.js | node', fakeFs(GIT_ROOT, split, DIRS)).decision, 'deny');
  assert.equal(git('{ cat p1.js; cat p2.js; } | node', fakeFs(GIT_ROOT, split, DIRS)).decision, 'deny');
  assert.equal(git('cat p2.js p1.js | node', fakeFs(GIT_ROOT, split, DIRS)).decision, 'allow');
  const fsplit = { 'p1.js': 'echo x > ~/.cla', 'p2.js': 'ude/settings.json' };
  assert.equal(files('cat p1.js p2.js | node', fakeFs(PROJ, fsplit, DIRS)).decision, 'deny');
  assert.equal(files('cat p2.js p1.js | node', fakeFs(PROJ, fsplit, DIRS)).decision, 'allow');
});

test('S2: the joined program text of an interpreter is judged as program text, not as shell commands', () => {
  const g = { 'p1.js': "spawnSync('git', ['pu", 'p2.js': "sh', 'origin', 'main'])" };
  assert.equal(git('cat p1.js p2.js | node', fakeFs(GIT_ROOT, g, DIRS)).decision, 'deny');
  assert.equal(git('cat p2.js p1.js | node', fakeFs(GIT_ROOT, g, DIRS)).decision, 'allow');
  const fl = { 'p1.js': "require('fs').writeFileSync('/home/u/.cla", 'p2.js': "ude/settings.json', 'x')" };
  assert.equal(files('cat p1.js p2.js | node', fakeFs(PROJ, fl, DIRS)).decision, 'deny');
  assert.equal(files('cat p2.js p1.js | node', fakeFs(PROJ, fl, DIRS)).decision, 'allow');
});

// ---- S3: variables ---------------------------------------------------------------------------------------------------------
// Why (PR A2, batch S3): the value a variable holds at run time differs from the text assigned to it, or comes from a file the line runs.
//   1. Attributes transform the value: `declare -l` / `-u` lower / upper case it; zsh `typeset -L4` / `-R4` / `-Z4` pad or cut it to a width; `-i` evaluates it as arithmetic.
//      The attribute may come before the assignment (`declare -l B; B=MAIN`).
//   2. `local` outside a function fails in bash: the variable keeps the value it had.
//   3. A sourced file (and a startup file that runs before a script) sets variables and cds that the rest of the line sees.
//   4. A command name that is a known data program (`$PSQL < q.sql`) does not read its stdin as a script.

test('S3: a width or integer attribute makes the value unknown (git-policy)', () => {
  const fs = fakeFs(GIT_ROOT, {}, DIRS);
  for (const c of [
    'typeset -L4 B=mainxx; git push origin $B', 'typeset -R4 B=xxmain; git push origin $B', 'typeset -Z4 B=mainx; git push origin $B', 'declare -L4 B=mainxx; git push origin $B',
    'typeset -L B; B=mainxx; git push origin $B', 'B=agent/x; typeset -L4 B; git push origin $B', 'typeset -i B=main; git push origin $B', 'typeset -L4 B=mainxx; echo x | xargs git push origin $B',
    'declare -l B; B=agent/x; git push origin $B', 'B=agent/x; declare -u B; git push origin $B',
  ]) assert.equal(git(c, fs).decision, 'deny', c);
  // not on the way to a command that runs something
  for (const c of ['typeset -L4 N=abcdef; echo $N', 'declare -x B=agent/x; git push origin $B', 'declare -l B=AGENT/X; git push origin $B', 'declare -u B=agent/x; git push origin $B', 'typeset -r B=agent/x; git push origin $B']) {
    assert.equal(git(c, fs).decision, 'allow', c);
  }
});

test('S3: declare -l / -u transform the value, before or after the assignment (files-policy)', () => {
  const fs = fakeFs(PROJ, { 'ok.sh': 'echo hi' }, DIRS);
  for (const c of [
    'declare -l D=$HOME/.CLAUDE; echo x > $D/settings.json', 'typeset -l D=$HOME/.CLAUDE; echo x > $D/settings.json', 'declare -l D; D=$HOME/.CLAUDE; echo x > $D/settings.json',
    'D=$HOME/.CLAUDE; declare -l D; echo x > $D/settings.json',
    'typeset -L40 D=$HOME/.claude; echo x > $D/settings.json', 'typeset -L4 D=/home/u/.claude; echo x > $D/settings.json',
  ]) assert.equal(files(c, fs).decision, 'deny', c);
  for (const c of ['declare -l D=$HOME/.CLAUDEX; echo x > $D/a.txt', 'declare -l N=ABC; echo $N > a.txt', 'typeset -L4 N=abcdef; echo $N']) assert.equal(files(c, fs).decision, 'allow', c);
  // a width cut may leave a protected path the text does not show (-R15 keeps the last 15 characters): a writer or redirection that uses the name is refused, a reader is not
  for (const c of ['typeset -R15 D=/tmp/a/home/u/.claude; echo x > $D/settings.json', 'typeset -R15 D=/tmp/a/home/u/.claude; cp ok.sh $D/settings.json', 'typeset -i D=3; echo x > $D/settings.json']) assert.equal(files(c, fs).decision, 'deny', c);
  assert.equal(files('typeset -R15 D=/tmp/a/home/u/.claude; cat $D/settings.json', fs).decision, 'allow');
});

test('S3: local outside a function does not take effect, so the variable is unknown (git-policy)', () => {
  // the script is judged at level 1; B may come from the environment of the shell that runs it
  const fs = fakeFs(GIT_ROOT, { 's.sh': 'local B=agent/x; git push origin $B', 'ok.sh': 'echo hi' }, DIRS);
  assert.equal(git('bash s.sh', fs).decision, 'deny');
  assert.equal(git('B=main; bash s.sh', fs).decision, 'deny');
  assert.equal(git('local B=agent/x; git push origin $B', fs).decision, 'deny');
  // what it sets is only unknown where it reaches a command that runs something
  assert.equal(git('local N=3; echo $N', fs).decision, 'allow');
});

test('S3: arithmetic runs the command substitutions inside it', () => {
  for (const c of [
    'echo $((1 + $(bash f.sh)))', 'echo $(( $(cat f.sh) ))', '(( x = $(bash f.sh) ))', 'let x=$(bash f.sh)', 'echo ${a[$(bash f.sh)]}', 'a[$(bash f.sh)]=1', 'echo $[ 1 + $(bash f.sh) ]',
    'echo $(( 1 + ${a[$(bash f.sh)]} ))', 'for ((i = $(bash f.sh); i < 3; i++)); do :; done', '[[ $(bash f.sh) -gt 1 ]]', 'echo $((`bash f.sh`))',
  ]) denyBoth(c, SPEC);
  for (const c of ['echo $((1 + $(bash x.sh)))', 'echo $(( $(cat x.sh) ))', '(( x = $(bash x.sh) ))', 'let x=$(bash ok.sh)', 'echo ${a[$(bash x.sh)]}', 'echo $((1 + 2))']) allowBoth(c, SPEC);
});

test('S3: variables a sourced file sets are known (or unknown) for the rest of the line (files-policy)', () => {
  const fs = fakeFs(PROJ, { 'set.sh': 'F=evil.sh', 'evil.sh': BAD_FILES, 'ok.sh': 'echo ok', 'okset.sh': 'F=ok.sh', 'cond.sh': 'true && F=ok.sh', 'dyn.sh': 'F=$(pick)', 'ev.sh': 'eval "$X"', 'rd.sh': 'read F' }, DIRS);
  for (const c of [
    'F=ok.sh; source set.sh; bash $F', 'F=ok.sh; . ./set.sh; bash "$F"', 'F=ok.sh; source s*.sh; bash $F', 'source set.sh; bash $F', 'F=ok.sh; source set.sh && bash ${F}',
    // a file we cannot model: any variable may be set, so one that picks the script is refused
    'F=ok.sh; source cond.sh; bash $F', 'F=ok.sh; source dyn.sh; bash $F', 'F=ok.sh; source ev.sh; bash $F', 'F=ok.sh; source rd.sh; bash $F', 'F=ok.sh; source $Z; bash $F',
    'echo F=evil.sh > w.sh; F=ok.sh; source w.sh; bash $F',
  ]) assert.equal(files(c, fs).decision, 'deny', c);
  // (a name the file sets to a run-time value is unknown for a script it picks and for a write target alike, see the S4 test below; a reader may use it)
  assert.equal(files('source dyn.sh; echo $F', fs).decision, 'allow');
  for (const c of [
    'F=evil.sh; source okset.sh; bash $F', 'source okset.sh; bash $F', 'source missing.sh; bash ok.sh', 'source cond.sh; echo hi', 'F=ok.sh; source set.sh; F=ok.sh; bash $F',
  ]) assert.equal(files(c, fs).decision, 'allow', c);
});

test('S3: a sourced or startup file that cds carries the directory to what follows (files-policy)', () => {
  const fs = fakeFs(PROJ, { 'rc.sh': 'cd ~/.claude', 'rc2.sh': 'cd sub', 'run.sh': 'echo x > settings.json', 'run2.sh': 'echo hi > a.txt', 'sub/t.sh': 'echo hi' }, DIRS);
  for (const c of [
    '. ./rc.sh; echo x > settings.json', 'source rc.sh && echo x > settings.json', 'BASH_ENV=rc.sh bash run.sh', 'export BASH_ENV=rc.sh; bash run.sh',
  ]) assert.equal(files(c, fs).decision, 'deny', c);
  for (const c of ['. ./rc2.sh; echo x > settings.json', 'BASH_ENV=rc2.sh bash run2.sh', 'source rc2.sh; bash t.sh']) assert.equal(files(c, fs).decision, 'allow', c);
});

test('S3: variables an explicit startup file exports reach the script judged next (git-policy)', () => {
  const g = (rc) => fakeFs(GIT_ROOT, { 'rc.sh': rc, 's.sh': 'bash $F', 'f.sh': BAD_GIT, 'ok.sh': 'echo ok' }, DIRS);
  assert.equal(git('BASH_ENV=rc.sh bash s.sh', g('export F=f.sh')).decision, 'deny');
  assert.equal(git('BASH_ENV=rc.sh bash s.sh', g('F=f.sh')).decision, 'deny');
  assert.equal(git('F=ok.sh BASH_ENV=rc.sh bash s.sh', g('export F=f.sh')).decision, 'deny');
  assert.equal(git('export BASH_ENV=rc.sh; bash s.sh', g('export F=f.sh')).decision, 'deny');
  assert.equal(git('BASH_ENV=rc.sh bash s.sh', g('export F=ok.sh')).decision, 'allow');
  // only the shell that reads the startup file sees what it sets
  assert.equal(git('BASH_ENV=rc.sh bash ok.sh; bash $F', g('export F=f.sh')).decision, 'allow');
});

test('S3: a known data program fed a file is not a shell reading a script', () => {
  const sql = '-- push to main, then merge and git push origin main';
  for (const c of [
    'Q=psql; $Q < q.sql', 'PSQL="psql -h localhost"; $PSQL $DB -q < q.sql', 'PSQL=/opt/homebrew/opt/libpq/bin/psql; $PSQL $DB -v ON_ERROR_STOP=1 -q < q.sql', 'Q=jq; cat q.sql | $Q .', 'Q=sqlite3; $Q db.sqlite < q.sql',
  ]) {
    assert.equal(git(c, fakeFs(GIT_ROOT, { 'q.sql': sql }, DIRS)).decision, 'allow', c);
    assert.equal(files(c, fakeFs(PROJ, { 'q.sql': '-- ' + BAD_FILES }, DIRS)).decision, 'allow', c);
  }
  // unknown, a shell or a wrapper that may start one: still a script feed
  for (const c of ['$Q < f.sh', 'Q=bash; $Q < f.sh', 'Q="sh -x"; $Q < f.sh', 'Q="env bash"; $Q < f.sh', 'Q=$(pick); $Q < f.sh', 'Q="psql; bash"; $Q < f.sh', 'Q=./psql; $Q < f.sh']) denyBoth(c, SPEC);
});

// ---- S4 D: a name an unfollowable sourced file may have changed is unknown for write targets too -----------------------------

test('S4: a write through a name a sourced file may have changed is refused whatever the rest of the path (files-policy)', () => {
  const fs = fakeFs(PROJ, { 'dyn.sh': 'F=$(pick)', 'ev.sh': 'eval "$X"', 'ok.sh': 'echo ok', 'w.sh': 'cp ok.sh $E/settings.json' }, DIRS);
  for (const c of [
    // (a followable file leaves only F unknown: the taint travels from it)
    'source dyn.sh; W=$F; echo x > $W/settings.json', 'source dyn.sh; export W=$F; cp ok.sh $W', 'source dyn.sh; Y=$F; W="$Y/sub"; cp ok.sh $W', 'source dyn.sh; E=$F bash w.sh', 'source dyn.sh; export E=$F; bash w.sh', 'source dyn.sh; E=$F; export E; bash w.sh', 'source dyn.sh; E="$F/x" bash w.sh',
    // (the taint travels: an assignment from a changed name, an export, a prefix value that reaches a script)
    'D=/tmp; source $X; W=$D; echo x > $W/settings.json', 'D=/tmp; source $X; export W=$D; echo x > $W/a.txt', 'D=/tmp; source $X; Y=$D; W="$Y/sub"; cp ok.sh $W', 'D=/tmp; source $X; E=$D bash w.sh', 'D=/tmp; source $X; E="$D" bash w.sh', 'D=/tmp; source $X; FOO=$D/x bash ok.sh',
    'D=/tmp; source $X; echo x > $D/settings.json', 'D=/tmp; source $X; cp ok.sh $D/settings.json', 'D=/tmp; source ev.sh; echo x > ${D}/settings.json', 'D=/tmp; source $X; tee $D/pipeline/hooks/x < ok.sh',
    'D=/tmp; source $X; echo x >> "$D/skills/ship/SKILL.md"', 'D=/tmp; . $X; echo x > $D/.claude/settings.json', 'source $X; echo x > $D/settings.json', 'F=a; source dyn.sh; echo x > $F/settings.json',
    'D=/tmp; source $X; sed -i s/a/b/ $D/agents/judge.md', 'D=/tmp; source $X; mv ok.sh $D/../settings.json',
    // (the name may hold the protected path itself, its start, or be folded by `..`: no tail is matched, any use as a target is refused)
    'D=/tmp; source $X; echo x > $D', 'D=/tmp; source $X; echo x > "$D"', 'D=/tmp; source $X; echo x > ${D}tings.json', 'D=/tmp; source $X; echo x > ${D}x', 'D=/tmp; source $X; cp ok.sh $D',
    'D=/tmp; source $X; echo x > $D/a/../settings.json', 'D=/tmp; source $X; echo x > $D/./settings.json', 'D=/tmp; source $X; tee ${D}eline/hooks/x < ok.sh',
    // (names are the line's own choice: none is exempt)
    'MYPATH=/tmp; source $X; echo x > $MYPATH/settings.json', 'PATH2=/tmp; source $X; cp ok.sh $PATH2/settings.json', 'source $X; echo x > $MYPATH/settings.json',
    'D=/tmp; source $X; echo x > $D/a.txt', 'D=/tmp; source $X; mkdir -p $D/build', 'source dyn.sh; cp ok.sh $F.bak', 'D=/tmp; source $X; FOO=$D/x tool',
    // (a program or wrapper that writes through its arguments: only the script operand of a shell / interpreter / source is exempt)
    'D=/tmp; source $X; node w.mjs $D/settings.json', 'D=/tmp; source $X; python3 w.py $D/settings.json', "D=/tmp; source $X; bash -c 'echo x > $D/settings.json'", 'D=/tmp; source $X; eval "echo x > $D/settings.json"',
    'D=/tmp; source $X; exec cp ok.sh $D/settings.json', 'D=/tmp; source $X; env cp ok.sh $D/settings.json', 'D=/tmp; source $X; nice cp ok.sh $D/settings.json', 'D=/tmp; source $X; command cp ok.sh $D/settings.json',
    'D=/tmp; source $X; sudo cp ok.sh $D/settings.json', 'D=/tmp; source $X; source ok.sh $D/settings.json', 'D=/tmp; source $X; xargs -I{} cp ok.sh $D/{}', 'D=/tmp; source $X; time cp ok.sh $D/settings.json', 'D=/tmp; source $X; MYPATH=$D/x tool',
  ]) assert.equal(files(c, fs).decision, 'deny', c);
  // (a reader, cd, a declaration, a path list's element, and a value the line sets again after the source are not write targets)
  for (const c of [
    'D=/tmp; source $X; export PATH=$D:$PATH', 'D=/tmp; source $X; cat $D/settings.json', 'D=/tmp; source $X; D=/tmp; echo x > $D/settings.json', 'D=/tmp; source $X; PATH=$D:$PATH ls', 'D=/tmp; source $X; PATH=$D:$PATH npm test',
    'D=/tmp; source $X; echo $D', 'D=/tmp; source $X; W=/tmp; echo x > $W/settings.json', 'source dyn.sh; echo $F', 'D=/tmp; source $X; export OUT=$D/x', 'source $X', 'source "$NVM_DIR/nvm.sh"; nvm use 20',
  ]) assert.equal(files(c, fs).decision, 'allow', c);
});

// ---- S4 A: data programs that run shell commands from their input ------------------------------------------------------------

// Why: psql (`\!`, `\o |cmd`, `\g |cmd`, `\copy ... program 'cmd'`, backticks), mysql (`\!`, `system`) and sqlite3 (`.shell`, `.system`, `.output |cmd`, `.once |cmd`) run
// shell commands that sit in the text they read, so a file / heredoc / argument fed to them is judged for those commands like a shell line.
// `{BAD}` / `{OK}` stand for a guarded / harmless command of each policy; the same template is used for the file contents and the command.
const sqlBoth = (template, fileTemplates, expect) => {
  const fill = (s, bad, ok) => s.replaceAll('{BAD}', bad).replaceAll('{OK}', ok);
  const one = (tag, run, bad, ok, root) => {
    const fsOf = (b, o) => fakeFs(root, Object.fromEntries(Object.entries(fileTemplates).map(([k, v]) => [k, fill(v, b, o)])), DIRS);
    const r = run(fill(template, bad, ok), fsOf(bad, ok));
    assert.equal(r.decision, expect, `${tag}: ${template} -> ${r.reason}`);
  };
  one('git', (c, f) => git(c, f), BAD_GIT, 'git status', GIT_ROOT);
  one('files', (c, f) => files(c, f), BAD_FILES, 'echo hi', PROJ);
};
const SQL_FILES = {
  'p.sql': 'select 1;\n\\! {BAD}\nselect 2;', 'po.sql': 'select 1 \\g |{BAD}', 'pw.sql': '\\o |{BAD}\nselect 1;', 'pc.sql': "\\copy t to program '{BAD}'", 'pb.sql': '\\set x `{BAD}`',
  'm.sql': 'select 1;\n\\! {BAD}', 'ms.sql': 'system {BAD}', 's.sql': '.mode csv\n.shell {BAD}', 'ss.sql': '.system {BAD}', 'so.sql': '.output |{BAD}', 'sn.sql': '.once |{BAD}',
  'inc.sql': 'select 1;\n\\i p.sql', 'inc2.sql': '.read s.sql', 'data.sql': "-- git push origin main is a comment\ninsert into t values ('git push origin main');\nselect '\\\\!';",
};
test('S4: a data program fed a file that holds a shell escape runs it (psql, mysql, sqlite3)', () => {
  for (const t of [
    'psql < p.sql', 'psql -q mydb < po.sql', 'psql < pw.sql', 'psql < pc.sql', 'psql < pb.sql', 'psql -f p.sql', 'psql --file=p.sql', 'cat p.sql | psql', 'mysql < m.sql', 'mariadb db < ms.sql',
    'sqlite3 < s.sql', 'sqlite3 db.sqlite < ss.sql', 'sqlite3 db < so.sql', 'sqlite3 < sn.sql', 'sqlite3 db -init s.sql', 'psql < inc.sql', 'sqlite3 < inc2.sql',
    'Q=psql; $Q < p.sql', 'PSQL="psql -h localhost"; $PSQL $DB -q < p.sql', 'Q=sqlite3; $Q db < s.sql', 'Q=/usr/bin/psql; $Q < po.sql', 'cat p.sql p.sql | psql',
  ]) sqlBoth(t, SQL_FILES, 'deny');
  // the same shapes with a harmless command, and data that only mentions the words
  for (const t of ['psql < p.sql', 'psql < po.sql', 'psql < pc.sql', 'mysql < m.sql', 'sqlite3 < s.sql', 'sqlite3 < so.sql', 'psql < inc.sql', 'Q=psql; $Q < p.sql', 'psql < data.sql', 'Q=psql; $Q < data.sql', 'sqlite3 db < data.sql']) {
    sqlBoth(t, Object.fromEntries(Object.entries(SQL_FILES).map(([k, v]) => [k, v.replaceAll('{BAD}', '{OK}')])), 'allow');
  }
  sqlBoth('psql < data.sql', SQL_FILES, 'allow');
  sqlBoth('Q=psql; $Q < data.sql', SQL_FILES, 'allow');
});

test('S4: a data program fed a heredoc, a here-string or an argument that holds a shell escape runs it', () => {
  for (const t of [
    "psql <<'EOF'\nselect 1;\n\\! {BAD}\nEOF", "psql <<< '\\! {BAD}'", "psql -c '\\! {BAD}'", "psql --command='select 1 \\g |{BAD}'", "mysql -e '\\! {BAD}'", "mysql --execute='system {BAD}'",
    "sqlite3 db '.shell {BAD}'", "sqlite3 db -cmd '.system {BAD}'", "sqlite3 <<'EOF'\n.shell {BAD}\nEOF", "Q=psql; $Q <<'EOF'\n\\! {BAD}\nEOF", "echo '\\! {BAD}' | psql", "printf '.shell {BAD}\\n' | sqlite3 db",
  ]) sqlBoth(t, {}, 'deny');
  for (const t of ["psql <<'EOF'\nselect 1;\n\\! {OK}\nEOF", "psql -c '\\! {OK}'", "sqlite3 db '.shell {OK}'", "mysql -e 'select 1'", "Q=psql; $Q <<'EOF'\n\\! {OK}\nEOF"]) sqlBoth(t, {}, 'allow');
});

test('S4: a reader named by a variable cannot launder a feed to a shell', () => {
  for (const c of ['Q=cat; $Q < f.sh | bash', 'Q=cat; $Q f.sh | bash', 'Q=cat; $Q f.sh | sh -s', 'Q=head; $Q -c 9999 f.sh | bash', 'Q=cat; bash < <($Q f.sh)', 'Q=cat; $Q < f.sh | xargs -I{} sh -c "{}"']) denyBoth(c, SPEC);
  for (const c of ['Q=cat; $Q < x.sh | bash', 'Q=cat; $Q x.sh | bash', 'Q=cat; $Q f.sh | wc -l', 'Q=cat; $Q < f.sh | grep x']) allowBoth(c, SPEC);
});

// ---- S4b: taint propagation through assignments (files-policy) -------------------------------------------------------------

test('S4b: a name set from a maybe-changed name is changed too (namerefs, read, printf -v, mapfile, eval, indirection, unset names)', () => {
  const fs = fakeFs(PROJ, { 'dyn.sh': 'F=$(pick)', 'ev.sh': 'eval "$X"', 'w.sh': 'cp ok.sh $E/settings.json', 'w2.sh': 'cp ok.sh $X/a.txt', 'ok.sh': 'echo ok' }, DIRS);
  for (const c of [
    // (an assignment from a changed name taints its target for the script the line starts, and a later assignment from an unset name taints a name the line set before)
    'source dyn.sh; X=$F; bash w2.sh', 'source ev.sh; Y=/tmp; Y=$NEWVAR; echo x > $Y/a.txt', 'source ev.sh; Y=/tmp; Y=$NEWVAR; cp ok.sh $Y',
    // (an unset name after a source nothing could follow may have come from it: what is set from it is changed)
    'source ev.sh; Y=$NEWVAR; echo x > $Y/a.txt', 'source ev.sh; E=$NEWVAR bash w.sh', 'source ev.sh; export Y=$NEWVAR; cp ok.sh $Y', 'source ev.sh; Y=$NEWVAR; Z="$Y/x"; cp ok.sh $Z',
    'source dyn.sh; echo x > ${!F}/a.txt', 'R=a; source dyn.sh; declare -n R=F; echo x > $R/a.txt', 'R=a; source dyn.sh; typeset -n R=F; cp ok.sh $R',
    'W=a; source dyn.sh; printf -v W %s $F; echo x > $W/a.txt', 'W=a; source dyn.sh; read W <<< "$F"; echo x > $W/a.txt', 'B=a; source dyn.sh; read -r A B <<< "$F"; cp ok.sh $B',
    'W=a; source dyn.sh; mapfile W <<< "$F"; cp ok.sh $W', 'W=a; source dyn.sh; readarray -t W <<< "$F"; cp ok.sh $W', 'W=a; source dyn.sh; eval "W=\\$F"; echo x > $W/a.txt', 'MAPFILE=a; source dyn.sh; mapfile <<< "$F"; cp ok.sh $MAPFILE',
    // (a search list is no write target, go writes under GOPATH)
    'source dyn.sh; GOPATH=$F go install x', 'source dyn.sh; GOBIN=$F go install x',
  ]) assert.equal(files(c, fs).decision, 'deny', c);
  for (const c of [
    'source dyn.sh; PATH=$F:$PATH go install x', 'source dyn.sh; PYTHONPATH=$F python3 -c pass', 'read W; echo x > $W/a.txt', 'printf -v W %s hi; echo x > ./a.txt',
    'source dyn.sh; W=/tmp; read V; echo x > $W/a.txt',
  ]) assert.equal(files(c, fs).decision, 'allow', c);
});

// ---- S4b: a cd into a directory only known at run time (files-policy) --------------------------------------------------------

// Why: `cd $D` (D maybe-changed / unset / a substitution) may land in ~/.claude, so a relative write to one of its protected files is refused; other relative names stay allowed.
test('S4b: a relative write to a protected name after a cd into an unknown directory is refused', () => {
  const fs = fakeFs(PROJ, { 'dyn.sh': 'F=$(pick)', 'ok.sh': 'echo ok', 'w.sh': 'echo x > settings.json', 'n.sh': 'echo hi' }, DIRS);
  const cds = ['source $X; cd $D', 'D=/tmp; source $X; cd $D', 'cd $UNSET', 'cd "$UNSET/sub"', 'cd $(pick)', 'cd `pick`', 'cd -', 'source dyn.sh; cd $F', 'pushd $(pick)', 'cd ${!N}', 'cd ~/.cl*', 'cd ~/.{claude,x}', 'cd ~/.claude/pi?eline'];
  for (const cd of cds) {
    for (const w of ['echo x > settings.json', 'echo x >> ./settings.json', 'cp ok.sh settings.json', 'tee settings.json < ok.sh', 'mv ok.sh agents/judge.md', 'echo x > skills/ship/SKILL.md', 'echo x > pipeline/hooks/guard-git.mjs', 'sed -i s/a/b/ settings.json', 'rm -rf pipeline',
      // (the name comes from the source, the URL or the archive: the written path does not spell it)
      'cp /tmp/x/settings.json .', 'cp /tmp/x/settings.json ./', 'cp -t . /tmp/x/settings.json', 'cp --target-directory=. /tmp/x/judge.md', 'mv /tmp/x/settings.json .', 'curl -O https://h/x/settings.json', 'tar -xf a.tar', 'tar xzf a.tgz', 'unzip a.zip', 'git checkout main', 'git -C r restore .', 'git stash pop',
      // (a pattern, a variable or braces that can spell the name; a directory source; git global options with a value; the child frames of the line)
      'F=settings.json; echo x > $F', 'echo x > settings.{json,x}', 'echo x > set*.json', 'echo x > `echo settings.json`', 'cp ok.sh $OUT', 'rm $NAME', 'cp /tmp/*.json .', 'cp -r /tmp/pipeline .', 'cp -r /tmp/x/.claude .', 'cp -r /tmp/x/. .', 'cp -r /tmp/x/$N .', 'dd if=ok.sh of=settings.json',
      'git --work-tree . checkout x', 'git --git-dir g --work-tree w checkout x', 'git -c alias.x=!sh x', 'git frobnicate',
      'bash -c "echo x > settings.json"', 'eval "cp ok.sh settings.json"', 'bash w.sh', 'source w.sh', 'sh < w.sh',
      "node -e \"require('fs').writeFileSync('settings.json','x')\"", "python3 -c \"open('skills/ship/SKILL.md','w').write('x')\""]) {
      assert.equal(files(`${cd} && ${w}`, fs).decision, 'deny', `${cd} && ${w}`);
    }
  }
  for (const cd of ['cd $UNSET']) { // (S4d: a `cd $(pick)` runs `pick` itself, which the rerun cannot tell from a command run in the directory)
    // (S4d: the rest of the line is judged in each protected directory, so only reads stay allowed; the writes and commands this list once allowed are in the S4d test as refused)
    for (const w of ['cat settings.json', 'ls pipeline', 'grep x settings.json', 'git --git-dir g status', 'git status', 'git log']) {
      assert.equal(files(`${cd} && ${w}`, fs).decision, 'allow', `${cd} && ${w}`);
    }
  }
  // (a brace list in a redirection target is several targets, also in a known protected directory)
  for (const c of ['cd ~/.claude && echo x > settings.{json,x}', 'echo x > ~/.claude/settings.{json,x}']) assert.equal(files(c, fs).decision, 'deny', c);
  // (a known directory keeps relative writes to ordinary and protected-looking names alike, as before)
  for (const c of ['cd sub && echo x > settings.json', 'D=sub; cd $D && cp ok.sh settings.json', 'cd ~ && echo x > notes.txt']) assert.equal(files(c, fs).decision, 'allow', c);
});

// ---- S4c: one SQL client model (psql, mysql, sqlite3) for the direct path, the variable-named path and the files they read -------------------------------------------

const OK_SQL = { 'q.sql': "-- a comment\nselect 1;\ninsert into t values ('x');\n\\set ON_ERROR_STOP on\n\\timing\n\\x\n.mode csv\n.headers on\n" };
const EVIL = (line) => ({ 'evil.sql': line, 'ok.sql': 'select 1;' });

test('S4c: a client named by a variable is the same client (files, -c text, options)', () => {
  const F = { 'x.sql': '\\! {BAD}\nselect 1;', 'm.sql': 'system {BAD}', 's.sql': '.shell {BAD}' };
  for (const t of [
    'Q=psql; $Q -f x.sql', 'Q=psql; $Q -qf x.sql', 'Q=psql; $Q --file=x.sql', 'Q=psql; $Q < x.sql', "Q=psql; $Q -c '\\! {BAD}'", "PSQL='psql -h localhost'; $PSQL -f x.sql", "PSQL='psql -h localhost'; $PSQL $DB -c '\\! {BAD}'",
    'Q=mysql; $Q < m.sql', "Q=mysql; $Q -e 'system {BAD}'", "Q=sqlite3; $Q db '.shell {BAD}'", 'Q=sqlite3; $Q db -init s.sql', "Q=psql; $Q -o '|{BAD}'",
  ]) sqlBoth(t, F, 'deny');
  for (const t of ['Q=psql; $Q -f x.sql', "Q=psql; $Q -c '\\! {OK}'", 'Q=mysql; $Q < m.sql', "Q=sqlite3; $Q db '.shell {OK}'", "Q=psql; $Q -o '|{OK}'"]) sqlBoth(t, Object.fromEntries(Object.entries(F).map(([k, v]) => [k, v.replaceAll('{BAD}', '{OK}')])), 'allow');
  for (const t of ['Q=psql; $Q -f q.sql', 'Q=psql; $Q $DB -q < q.sql', "Q=psql; $Q -c 'select 1'", 'Q=sqlite3; $Q db < q.sql', 'Q=mysql; $Q -e "select 1"']) sqlBoth(t, OK_SQL, 'allow');
});

test('S4c: includes are judged recursively (psql \\i \\ir, mysql source and \\., sqlite .read)', () => {
  const F = { 'evil.sql': '\\! {BAD}', 'm.sql': 'system {BAD}', 's.sql': '.shell {BAD}', 'sub/inc.sql': '\\ir p.sql', 'sub/p.sql': '\\! {BAD}', 'sub/mi.sql': 'source p.sql' };
  for (const t of [
    "mysql -e 'source m.sql'", "mysql -e '\\. m.sql'", "psql -c '\\i evil.sql'", "sqlite3 db '.read s.sql'", 'sqlite3 db ".rea s.sql"', "psql <<'EOF'\n\\include evil.sql\nEOF", "mysql <<'EOF'\nsource m.sql\nEOF",
    // (\ir is relative to the directory of the file being read: `psql -f sub/inc.sql` reads sub/p.sql)
    'psql -f sub/inc.sql', 'psql < sub/inc.sql', 'Q=psql; $Q -f sub/inc.sql', 'cat sub/inc.sql | psql',
  ]) sqlBoth(t, F, 'deny');
  // (an include of a harmless file, and one of a missing file, run nothing)
  sqlBoth("psql -c '\\i evil.sql'", { 'evil.sql': 'select 1;' }, 'allow');
  sqlBoth("mysql -e 'source nowhere.sql'", {}, 'allow');
});

test('S4c: a meta-command outside the known-safe set is an unknown shell line (refused with guarded text around)', () => {
  const F = {
    'a.sql': '\\gfoo {BAD}', 'b.sql': '\\e {BAD}', 'c.sql': 'pager {BAD}', 'd.sql': '\\P {BAD}', 'e.sql': 'edit {BAD}', 'f.sql': '.load {BAD}', 'g.sql': '.sh {BAD}', 'h.sql': ".sys {BAD}", 'i.sql': '.o |{BAD}',
    'j.sql': "select load_extension('{BAD}');", 'k.sql': "select edit('{BAD}');", 'l.sql': '\\setenv PAGER {BAD}', 'm.sql': '\\cd {BAD}', 'n.sql': '.excel {BAD}',
  };
  for (const [k, c] of Object.entries({ a: 'psql', b: 'psql', c: 'mysql', d: 'mysql', e: 'mysql', f: 'sqlite3', g: 'sqlite3', h: 'sqlite3', i: 'sqlite3', j: 'sqlite3', k: 'sqlite3', l: 'psql', m: 'psql', n: 'sqlite3' })) sqlBoth(`${c} < ${k}.sql`, F, 'deny');
  // the same files with nothing guarded around, and the known-safe commands, are data
  const calm = Object.fromEntries(Object.entries(F).map(([k, v]) => [k, v.replaceAll('{BAD}', 'ls')]));
  for (const [k, c] of Object.entries({ a: 'psql', b: 'psql', c: 'mysql', f: 'sqlite3', n: 'sqlite3' })) sqlBoth(`${c} < ${k}.sql`, calm, 'allow');
  for (const c of ['psql < q.sql', 'mysql < q.sql', 'sqlite3 db < q.sql', "psql <<'EOF'\n\\x\n\\timing\n\\set a 1\nselect 1;\nEOF", "sqlite3 db <<'EOF'\n.mode csv\n.headers on\nselect 1;\nEOF"]) sqlBoth(c, OK_SQL, 'allow');
});

test('S4c: the escape text is the rest of the line, unsplit; a stream spanning files is read joined', () => {
  assert.equal(git("psql -c '\\! git push origin ma\\in'", fakeFs(GIT_ROOT, {}, DIRS)).decision, 'deny');
  assert.equal(git('psql < w.sql', fakeFs(GIT_ROOT, { 'w.sql': '\\! git push origin ma\\in' }, DIRS)).decision, 'deny');
  assert.equal(files('psql < w.sql', fakeFs(PROJ, { 'w.sql': '\\! echo x > ~/.cla\\ude/settings.json' }, DIRS)).decision, 'deny');
  // (a backslash at the end of one file and `! cmd` at the start of the next is one `\\! cmd`)
  sqlBoth('cat a.sql b.sql | psql', { 'a.sql': 'select 1 \\', 'b.sql': '! {BAD}' }, 'deny');
  sqlBoth('cat a.sql b.sql | psql', { 'a.sql': 'select 1 \\', 'b.sql': '! {OK}' }, 'allow');
});

test('S4c: client options by allowlist (bundled short options, abbreviations, pagers and editors leave the client unmodelled)', () => {
  const F = { 'x.sql': '\\! {BAD}', 'sx.sql': '.shell {BAD}', 'bad.sql': '{BAD}', 'ok.sql': 'select 1;' };
  for (const t of [
    'psql -Xf x.sql', 'psql -qXf x.sql', 'psql -f x.sql -d db', 'psql --fil=x.sql', 'psql --file x.sql', "psql --command='\\! {BAD}'", "psql -XqAtc '\\! {BAD}'", "psql --out='|{BAD}'", "mysql -u root -e 'system {BAD}'", "mysql --execute='system {BAD}'",
    "mysql -uroot -pSECRET -e 'system {BAD}'", 'sqlite3 -batch db -init sx.sql', "sqlite3 -cmd '.shell {BAD}' db", "sqlite3 -csv db '.shell {BAD}'", "psql --fi='\\! {BAD}'",
    // (outside the allowlist the client may be anything: its stdin is a script, a plain command line in it runs)
    'PAGER=less psql < bad.sql', 'PSQL_PAGER=less psql < bad.sql', 'EDITOR=vi psql < bad.sql', 'PSQLRC=rc psql < bad.sql', 'psql -P pager=less < bad.sql', 'psql --pset=pager=less < bad.sql', 'psql -v PAGER=less < bad.sql',
    'mysql --pager=less < bad.sql', 'mysql --init-command=x < bad.sql', 'psql --no-such-option < bad.sql', 'mysql -Q < bad.sql', 'Q=psql; $Q -P pager=less < bad.sql', 'Q=mysql; $Q --pager=less < bad.sql', 'Q=psql; $Q --weird < x.sql', 'psql --weird < x.sql', 'PAGER=less psql < x.sql', 'sqlite3 -weird db < sx.sql',
  ]) sqlBoth(t, F, 'deny');
  for (const t of ['psql -Xf ok.sql', 'psql -qAt < ok.sql', 'psql -h localhost -U u -d db < bad.sql', 'mysql -u root -pSECRET db < bad.sql', 'sqlite3 -csv db < bad.sql', 'Q=psql; $Q -q < bad.sql', 'psql -f ok.sql']) sqlBoth(t, F, 'allow');
});

test('S4c: rc files run before the input (judged like input; -X, -init and --no-defaults skip them)', () => {
  const home = (name, text) => ({ ['/home/u/' + name]: text, 'ok.sql': 'select 1;' });
  sqlBoth("psql -c 'select 1'", home('.psqlrc', '\\! {BAD}'), 'deny');
  sqlBoth('psql -f ok.sql', home('.psqlrc', '\\! {BAD}'), 'deny');
  sqlBoth("Q=psql; $Q -c 'select 1'", home('.psqlrc', '\\! {BAD}'), 'deny');
  sqlBoth("psql -X -c 'select 1'", home('.psqlrc', '\\! {BAD}'), 'allow');
  sqlBoth("psql --no-psqlrc -c 'select 1'", home('.psqlrc', '\\! {BAD}'), 'allow');
  sqlBoth("psql -c 'select 1'", home('.psqlrc', '\\timing'), 'allow');
  // (the version-suffixed psqlrc is found by listing the home directory)
  assert.equal(git("psql -c 'select 1'", fakeFs(GIT_ROOT, { '/home/u/.psqlrc-16.1': '\\! ' + BAD_GIT }, [...DIRS, '/home/u'])).decision, 'deny');
  assert.equal(files("psql -c 'select 1'", fakeFs(PROJ, { '/home/u/.psqlrc-16.1': '\\! ' + BAD_FILES }, [...DIRS, '/home/u'])).decision, 'deny');
  sqlBoth("sqlite3 db 'select 1'", home('.sqliterc', '.shell {BAD}'), 'deny');
  sqlBoth("sqlite3 -init ok.sql db 'select 1'", home('.sqliterc', '.shell {BAD}'), 'allow');
  sqlBoth("mysql -e 'select 1'", home('.my.cnf', '[client]\npager = {BAD}'), 'deny');
  sqlBoth("mysql --no-defaults -e 'select 1'", home('.my.cnf', '[client]\npager = {BAD}'), 'allow');
  sqlBoth("mysql -e 'select 1'", home('.my.cnf', '[client]\nuser = root'), 'allow');
  // (a variable that moves the rc files makes the client unmodelled)
  for (const e of ['PGSYSCONFDIR=/x', 'XDG_CONFIG_HOME=/x', 'MYSQL_HOME=/x', 'HOME=/x', 'PGSERVICEFILE=/x']) sqlBoth(`${e} psql < bad.sql`, { 'bad.sql': '{BAD}' }, 'deny');
});

test('S4c: a client writes files without any escape (files-policy)', () => {
  const P = '/home/u/.claude/settings.json';
  const w = (c, file = 'w.sql', text = '') => files(c, fakeFs(PROJ, text ? { [file]: text } : {}, DIRS)).decision;
  for (const [c, text] of [
    ['psql < w.sql', `\\o ${P}\nselect 1;`], ['psql < w.sql', `select 1 \\g ${P}`], ['psql < w.sql', `\\w ${P}`], ['psql < w.sql', `\\s ${P}`], ['psql < w.sql', `\\copy t to '${P}'`], ['psql < w.sql', `\\gx ${P}`],
    ['psql < w.sql', `\\lo_export 1 ${P}`], ['psql < w.sql', `\\out ${P}`], ['psql < w.sql', `\\set f ${P}\n\\o :f`], ['psql < w.sql', `\\set f ${P}\n\\i :f`], ['psql < w.sql', `\\set f ${P}\n\\g :'f'`],
    ['sqlite3 db < w.sql', `.output ${P}`], ['sqlite3 db < w.sql', `.once ${P}`], ['sqlite3 db < w.sql', `.save ${P}`], ['sqlite3 db < w.sql', `.backup ${P}`], ['sqlite3 db < w.sql', `.log ${P}`], ['sqlite3 db < w.sql', `.open ${P}`],
    ['sqlite3 db < w.sql', `attach '${P}' as d;`], ['sqlite3 db < w.sql', `vacuum into '${P}';`], ['sqlite3 db < w.sql', `select writefile('${P}', 'x');`], ['sqlite3 db < w.sql', `select writefile('${P.slice(0, 15)}' || '${P.slice(15)}', 'x');`],
    ['sqlite3 db < w.sql', `attach ('${P}') as d;`], ['sqlite3 db < w.sql', `select writefile('/x' /* c */ || '${P}', 'x');`],
    ['mysql < w.sql', `tee ${P}`], ['mysql < w.sql', `\\T ${P}`],
    [`psql -o ${P} < w.sql`, 'select 1;'], [`psql -L ${P} < w.sql`, 'select 1;'], [`psql --output=${P} < w.sql`, 'select 1;'], [`psql --log-file ${P} < w.sql`, 'select 1;'], [`mysql --tee=${P} < w.sql`, 'select 1;'],
    [`sqlite3 ${P} 'select 1'`, ''], [`sqlite3 db ".output ${P}"`, ''], [`sqlite3 db ".once ${P}"`, ''], [`psql -c '\\o ${P}'`, ''], [`Q=psql; $Q -o ${P} < w.sql`, 'select 1;'], [`Q=sqlite3; $Q ${P} 'select 1'`, ''],
  ]) assert.equal(w(c, 'w.sql', text), 'deny', `${c} / ${text}`);
  for (const [c, text] of [
    ['psql < w.sql', '\\o out.txt\nselect 1;'], ['psql < w.sql', "\\copy t to 'out.csv' csv"], ['psql < w.sql', "\\copy t to stdout"], ['sqlite3 db < w.sql', '.output out.txt'], ['sqlite3 db < w.sql', "select writefile('out.bin', 'x');"],
    ['psql -o out.txt < w.sql', 'select 1;'], ['mysql < w.sql', 'tee out.txt'], ['sqlite3 db.sqlite < w.sql', 'select 1;'], ['psql < w.sql', '\\o\nselect 1;'], ['psql < w.sql', '\\g\nselect 1;'], ['sqlite3 db < w.sql', '.output stdout'],
  ]) assert.equal(w(c, 'w.sql', text), 'allow', `${c} / ${text}`);
});

test('S4c: the client\'s own writes are judged in every directory the command may run in (files-policy)', () => {
  const fs = fakeFs(PROJ, { 'ok.sql': 'select 1;' }, [...DIRS, '/tmp', '/home/u/.claude']);
  for (const cd of ['[ -n "$X" ] && cd /home/u/.claude', 'if [ -n "$X" ]; then cd /home/u/.claude; fi', 'cd /home/u/.claude', 'cd /tmp; cd /home/u/.claude', 'cd /tmp || cd /home/u/.claude', 'cd /home/u/.claude || cd /tmp', 'if [ -n "$X" ]; then cd /tmp; else cd /home/u/.claude; fi']) {
    for (const c of ["psql -o settings.json -c 'select 1'", "sqlite3 db '.output settings.json'", 'Q=psql; $Q -o settings.json -c "select 1"']) assert.equal(files(`${cd}; ${c}`, fs).decision, 'deny', `${cd}; ${c}`);
  }
  assert.equal(files("cd sub; psql -o settings.json -c 'select 1'", fs).decision, 'allow');
});

test('S4c: \\g (options) is skipped before the target; sqlite SQL functions are read per statement, across lines', () => {
  sqlBoth("psql <<'EOF'\nselect 1 \\g (format=csv) |{BAD}\nEOF", {}, 'deny');
  sqlBoth("psql <<'EOF'\nselect 1 \\gx (expanded=on) |{BAD}\nEOF", {}, 'deny');
  sqlBoth("psql <<'EOF'\nselect 1 \\g (format=csv {BAD}\nEOF", {}, 'deny'); // (unbalanced: the whole input is unknown)
  sqlBoth("psql <<'EOF'\nselect 1 \\g (format=csv) |{OK}\nEOF", {}, 'allow');
  const P = '/home/u/.claude/settings.json';
  const w = (text) => files('psql < w.sql', fakeFs(PROJ, { 'w.sql': text }, DIRS)).decision;
  assert.equal(w(`select 1 \\g (format=csv) ${P}`), 'deny');
  assert.equal(w('select 1 \\g (format=csv) out.csv'), 'allow');
  assert.equal(w('select 1 \\g (format=csv)'), 'allow');
  const s = (text) => files('sqlite3 db < w.sql', fakeFs(PROJ, { 'w.sql': text }, DIRS)).decision;
  assert.equal(s(`select writefile(\n'${P}',\n 'x');`), 'deny');
  assert.equal(s(`select writefile( -- c\n'${P}'\n, 'x');`), 'deny');
  assert.equal(s(`vacuum\ninto\n'${P}';`), 'deny');
  assert.equal(s(`attach\n'${P}'\nas d;`), 'deny');
  assert.equal(s(`select writefile(\n'/home/u/.cl' /* c */ ||\n'aude/settings.json', 'x');`), 'deny');
  assert.equal(s("select writefile(\n'out.bin',\n 'x');"), 'allow');
});

// Why: a declared attribute (`declare -u D`, `typeset -L4 D`, -i, -n) stays with the name across later plain assignments (they are converted too).
test('S4c: a declared attribute persists across later plain assignments (files-policy)', () => {
  const fs = fakeFs(PROJ, { 'dyn.sh': 'F=$(pick)', 'ok.sh': 'echo ok' }, DIRS);
  for (const c of [
    'declare -l D; D=/home/u/.CLAUDE; echo x > $D/settings.json', 'declare -l D; D=/HOME/U/.CLAUDE; echo x > $D/settings.json', 'declare -l D; D=/home/u/.CLAUDE; cp ok.sh $D/settings.json',
    'typeset -L4 B; B=/home/u/.claude; echo x > $B/settings.json', 'declare -i B; B=/home/u/.claude; echo x > $B/settings.json', 'declare -n B; B=ok; echo x > $B/settings.json',
    'source dyn.sh; declare -l D; D=/home/u/.CLAUDE; echo x > $D/settings.json', 'declare -l D; D=/x; D=/home/u/.CLAUDE; echo x > $D/settings.json',
  ]) assert.equal(files(c, fs).decision, 'deny', c);
  for (const c of ['D=/home/u/.claude; echo x > $D/a.txt', 'declare -u D; D=build; echo x > $D/a.txt']) assert.equal(files(c, fs).decision, 'allow', c);
});

// ---- S4d: a cd into an unknown directory is judged as if the cwd were each protected directory (files-policy) ------------------------------------------------

// Why: after `cd $UNSET` the line works in some directory nobody can name: the rest of it is judged with the ordinary write checks as if the cwd were each protected directory and each
// directory above one (so every writer model applies, not a list of names), and inline interpreter code (names built at run time) is refused.
test('S4d: the rest of a line after an unknown cd is judged as if the cwd were each protected directory', () => {
  const fs = fakeFs(PROJ, { 'ok.sh': 'echo ok', 'c.sh': 'cp /tmp/x/notes .', 'cc.sh': 'cd $Q\ncp /tmp/x/notes .' }, DIRS);
  for (const cd of ['cd $UNSET', 'cd $(pick)']) {
    for (const w of [
      // (writers the name lists did not know: the destination is the directory itself)
      'rsync -a /tmp/x/ .', 'ditto /tmp/x .', 'cp -T /tmp/x/notes .', 'cp -rT /tmp/x .', 'install -m 644 /tmp/x/notes .', 'curl -osettings.json https://h/x', 'curl -o settings.json https://h/x', 'wget -Osettings.json https://h/x',
      'touch notes.txt', 'echo x > notes.txt', 'mkdir -p build && cp ok.sh build/out.js', 'ln -sf /tmp/x settings.json', 'echo x > $OUT',
      // (inline interpreter code can build the name at run time)
      "node -e 1", "node -e'1'", "node --eval=1", "node -pe 1", "python3 -cprint(1)", "python3 -c pass", "perl -E 'say 1'", "perl -Esay", "perl -pi -e s/a/b/ f", "env node -e 1", "node -r x.js -e 1", "perl -I lib -e 1", "python3 -W ignore -c pass", "python3 -X dev -c 1", "node --some-flag x.js", "python3 -W ignore x.py", "node x.js -p 1", "node <<< 1", "python3 -", "awk 'BEGIN{print 1 > \"x\"}'", 'perl -e 1', "ruby -e 1", "php -r 1", "node -e \"require('fs').writeFileSync('sett'+'ings.json','x')\"", "python3 -c \"open('sett'+'ings.json','w')\"",
      // (child frames inherit the unknown directory)
      'bash c.sh', 'bash -c "cp /tmp/x/notes ."', 'bash cc.sh',
      // (what the S4b name heuristics allowed: any relative write or command that is not read-only may land in a protected directory)
      "echo x > notes.txt", "cp ok.sh build/out.js", "git commit -m settings.json", "cp /tmp/x/notes.txt .", "cp -r /tmp/x/build .", "sed -i \"s/a.*/b/\" notes.txt", "echo x > notes.{txt,md}", "echo x > n*.txt", "git add notes.txt", "git commit -m x", "npm run $S", "bash n.sh", "node -e 'console.log(1)'", "cp /tmp/x/settings.json /tmp/y/", "cp /tmp/x/notes /tmp/y/", "tar -tf a.tar", "unzip -l a.zip", "curl -O https://h/x/a.txt",
    ]) assert.equal(files(`${cd} && ${w}`, fs).decision, 'deny', `${cd} && ${w}`);
  }
  // (reads, absolute targets outside the protected set and a known directory stay allowed)
  for (const w of ['cat settings.json', 'ls', 'git status', 'git log', 'grep x settings.json', 'echo x > /tmp/out.txt', 'echo hi | cat']) assert.equal(files(`cd $UNSET && ${w}`, fs).decision, 'allow', w);
  assert.equal(files('cd sub && echo x > notes.txt', fs).decision, 'allow');
  // (a script named relative to the unknown directory is a file nobody can read)
  for (const w of ['node scripts/x.mjs', 'bash x.sh', 'source x.sh', './x.sh', 'python3 build/x.py', 'bash ~+/x.sh', 'bash ~-/x.sh', 'bash ~root/x.sh']) assert.match(files(`cd $(git rev-parse --show-toplevel) && ${w}`, fs).reason ?? '', /relative to a directory known only at run time/, w);
  assert.notEqual(files('cd $UNSET && node /tmp/x.mjs', fs).decision, 'allow'); // (an absolute script path is read and judged; a missing file leaves the line refused by the rerun)
  // (the reason says why)
  assert.match(files('cd $UNSET && touch notes.txt', fs).reason, /known only at run time/);
});

test('S4d: the rerun is bounded (a long line after an unknown cd is judged in time)', () => {
  const fs = fakeFs(PROJ, {}, DIRS);
  const long = `cd $UNSET && ${Array.from({ length: 60 }, (_, i) => `echo ${i} > /tmp/o${i}`).join(' && ')}`;
  const t0 = Date.now();
  assert.equal(files(long, fs).decision, 'allow');
  assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0} ms`);
  // (nested unknown cds multiply the reruns: past the budget the line is refused, not slow)
  const nested = Array.from({ length: 9 }, (_, i) => `cd $U${i}`).join(' && ') + ' && echo x > /tmp/o';
  const r = files(nested, fs);
  assert.ok(r.decision === 'allow' || /too many|too long|took too long|run time/.test(r.reason), r.reason);
});

// ---- S4d: more ways to leave the directory unknown ----------------------------------------------------------------------------------------------------------

test('S4d: cd ~- / ~+ / CDPATH / a changed HOME / a cd inside a sourced file make the directory unknown', () => {
  const W = 'echo x > settings.json';
  const sh = { 'set.sh': 'cd $X', 'set2.sh': 'cd -', 'set3.sh': 'cd /tmp/a/b', 'set4.sh': 'cd $(pick)', 'set5.sh': 'cd ~/.cl*', 'set6.sh': 'popd', 'set7.sh': 'pushd', 'set8.sh': 'cd a b', 'set9.sh': 'cd ~-' };
  const fs = fakeFs(PROJ, sh, DIRS);
  for (const c of [
    'cd ~- && W', 'cd ~+/x && W', 'cd ~+ && W', 'cd ~-/x && W', 'cd ~root && W',
    'CDPATH=/x cd sub && W', 'CDPATH=/x; cd sub && W', 'export CDPATH=/x; cd sub && W', 'declare -x CDPATH=/x; cd sub && W', 'CDPATH=$X; cd sub && W', 
    'HOME=/x; source $X; cd && W', 'HOME=/x; source $X; cd ~ && W', 'HOME=/x; source $X; cd ~/sub && W', 'HOME=/x; cd && W', 'export HOME=/x; cd && W',
    '. ./set.sh; W', 'source set.sh && W', '. ./set2.sh; W', '. ./set4.sh; W', '. ./set5.sh; W', '. ./set6.sh; W', '. ./set7.sh; W', '. ./set8.sh; W', '. ./set9.sh; W',
  ]) assert.equal(files(c.replace('W', W), fs).decision, 'deny', c);
  // (CDPATH inside a sourced file: set on the line, in the file, in the hook's environment)
  const cp = fakeFs(PROJ, { 'a.sh': 'cd sub', 'b.sh': 'CDPATH=/x\ncd sub', 'c.sh': 'cd ./sub', 'd.sh': 'export CDPATH=/y; cd sub' }, DIRS);
  for (const c of ['CDPATH=/x; . ./a.sh; W', 'export CDPATH=/x; source a.sh; W', '. ./b.sh; W', '. ./d.sh; W', 'CDPATH=/x . ./a.sh; W']) assert.equal(files(c.replace('W', W), cp).decision, 'deny', c);
  assert.equal(files('. ./a.sh; ' + W, cp, { env: { CDPATH: '/x' } }).decision, 'deny');
  for (const c of ['. ./a.sh; W', 'CDPATH=/x; . ./c.sh; W']) assert.equal(files(c.replace('W', W), cp).decision, 'allow', c);
  // (CDPATH only matters for a relative name; a name that starts with / ./ ../ is not searched; the environment's CDPATH counts too)
  assert.equal(files('cd sub && ' + W, fakeFs(PROJ, sh, DIRS), { env: { CDPATH: '/x' } }).decision, 'deny');
  assert.equal(files('cd ./sub && ' + W, fakeFs(PROJ, sh, DIRS), { env: { CDPATH: '/x' } }).decision, 'allow');
  assert.equal(files('cd /tmp/sub && ' + W, fakeFs(PROJ, sh, DIRS), { env: { CDPATH: '/x' } }).decision, 'allow');
  for (const c of ['cd sub && W', 'CDPATH= cd sub && W', 'cd ~ && W', 'cd && W', '. ./set3.sh; W', 'HOME=/x; cd /tmp && W', 'cd ~root2 && echo x > /tmp/o']) assert.equal(files(c.replace('W', W), fs).decision, 'allow', c);
});

// Why: a redirect target built at run time (a substitution, an unset name) inside a known protected directory can be any file there.
test('S4d: a run-time redirect target in a known protected directory is refused', () => {
  const fs = fakeFs(PROJ, {}, DIRS);
  for (const c of [
    'cd ~/.claude && echo x > `echo settings.json`', 'cd ~/.claude && echo x > $(pick)', 'cd ~/.claude && echo x > $OUT', 'cd ~/.claude/skills && echo x > $(pick)', 'cd ~/.claude/pipeline && echo x >> "$LOG"',
    'cd ~/.claude && echo x >& `pick`', 'cd ~/.claude && echo x &> $OUT',
  ]) assert.equal(files(c, fs).decision, 'deny', c);
  for (const c of ['cd sub && echo x > $OUT', 'echo x > $OUT', 'cd ~/.claude && echo x > ~/.claude/notes.txt', 'D=out; cd ~ && echo x > $D', 'cd ~/.claude && echo x 2>&1']) assert.equal(files(c, fs).decision, 'allow', c);
});

// Why: only `&N` / `&-` are descriptor duplications; `>&FILE` (and a target the parser keeps with a leading &) writes the file.
test('S4d: a redirect target with a leading & is a file unless it is a descriptor', () => {
  const fs = fakeFs(PROJ, {}, DIRS);
  for (const c of ['cd ~/.claude && echo x >&settings.json', 'echo x >&~/.claude/settings.json', 'cd ~/.claude && echo x >&"&"settings.json', 'cd ~/.claude && echo x 2>&"&"settings.json', 'cd $U && echo x >&settings.json']) assert.equal(files(c, fs).decision, 'deny', c);
  for (const c of ['cd ~/.claude && echo x 2>&1', 'cd ~/.claude && echo x >&2', 'cd ~/.claude && echo x >&-', 'cd ~/.claude && echo x 2>&1-', 'echo x >&"&"settings.json', 'cd ~/.claude && echo x <&3']) assert.equal(files(c, fs).decision, 'allow', c);
});

// Why: a startup file (BASH_ENV / ENV) runs in the CHILD shell: what it sets is the child script's, not the parent line's (only `source` / `.` change the current shell).
test('S4d: the effects of a startup file apply to the child script only, not to the rest of the parent line', () => {
  const fs = fakeFs(PROJ, { 'rc': 'D=/tmp', 'rcd': 'cd /tmp', 'x.sh': 'echo hi', 'src.sh': 'D=/tmp' }, DIRS);
  for (const c of [
    'D=/home/u/.claude; BASH_ENV=rc bash x.sh; echo y > $D/settings.json',
    'D=/home/u/.claude; export BASH_ENV=rc; bash x.sh; echo y > $D/settings.json',
    'cd /home/u/.claude; BASH_ENV=rcd bash x.sh; echo y > settings.json',
  ]) assert.equal(files(c, fs).decision, 'deny', c);
  // (a sourced file does change the current shell)
  assert.equal(files('D=/home/u/.claude; source src.sh; echo y > $D/settings.json', fs).decision, 'allow');
  assert.equal(files('D=/home/u/.claude; BASH_ENV=rc bash x.sh', fs).decision, 'allow');
});
