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
