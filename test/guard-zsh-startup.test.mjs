// Why (issues #18 + #19): the guards judged the script a shell runs but not what the shell runs BEFORE it, nor zsh-only syntax
// that runs code.
//   A. A non-interactive bash runs the file named by BASH_ENV first; sh/dash/ksh run ENV; zsh runs $ZDOTDIR/.zshenv always
//      (.zprofile/.zlogin with -l, .zshrc with -i). `BASH_ENV=f.sh bash x.sh` ran f.sh unjudged.
//   B. zsh glob qualifiers `*(e:'cmd':)` / `*(+func)` run code per match; the parser read `(e:cmd:)` as a subshell holding one word.
//   C. zsh EQUALS: `=git push` runs the git found in PATH, `bash =tool` runs the file `tool` resolves to, `=(cmd)` is a temp-file
//      process substitution.
// The file system is faked (like test/guard-script-expansion.test.mjs); the guarded text only lives in fake file contents.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname, basename } from 'node:path';
import { evaluateGitCommand } from '../pipeline/hooks/lib/git-policy.mjs';
import { evaluateBashForFiles } from '../pipeline/hooks/lib/files-policy.mjs';
import { startupFilesOf, simpleCommands, commandName } from '../pipeline/hooks/lib/shell-parse.mjs';

// `files`: path -> text (null = exists but cannot be read). Every key is resolved, absolute ones too: lookups go through resolve(),
// which on Windows turns `/home/u` into `D:\home\u`.
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

// spec: { name: 'bad' | 'ok' | <text> }; the same names are written into both fake file systems. `o`: { env } is the hook's environment.
const DIRS = ['sub', 'd', 'zd', 'zd2', 'zdl', 'bin', 'bin2'];
function both(command, spec = {}, o = {}) {
  const mk = (bad, ok) => Object.fromEntries(Object.entries(spec).map(([k, v]) => [k, v === 'bad' ? bad : v === 'ok' ? ok : v]));
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

const SPEC = {
  'f.sh': 'bad', 'ok.sh': 'ok', 'x.sh': 'ok', 'sub/f.sh': 'bad',
  'zd/.zshenv': 'bad', 'zd2/.zshenv': 'ok', 'zdl/.zshenv': 'ok', 'zdl/.zprofile': 'bad', 'zdl/.zlogin': 'bad', 'zdl/.zshrc': 'bad',
};

// ---- A: startup files -------------------------------------------------------------------------------------------------------

test('#18: a variable set in the command prefix names a startup file the shell runs first', () => {
  for (const c of [
    'BASH_ENV=f.sh bash x.sh', 'ENV=f.sh sh x.sh', 'BASH_ENV=f.sh bash -c "echo hi"', "BASH_ENV=f.sh bash -c 'echo hi'", 'BASH_ENV=f.sh bash -s', 'BASH_ENV=f.sh bash',
    'BASH_ENV=./f.sh bash x.sh', 'BASH_ENV=sub/f.sh bash x.sh', 'BASH_ENV="f.sh" bash x.sh', "BASH_ENV='f.sh' zsh x.sh", 'ENV=f.sh dash x.sh', 'ENV=f.sh ash x.sh', 'ENV=f.sh ksh x.sh',
    'BASH_ENV=f.sh /bin/bash x.sh', 'BASH_ENV=f.sh bash -l -c "echo hi"', 'BASH_ENV=f.sh bash -xe x.sh', 'BASH_ENV=f.sh bash < x.sh', 'BASH_ENV=f.sh bash -o pipefail -c "echo hi"',
    'BASH_ENV=f.sh sudo bash x.sh', 'BASH_ENV=f.sh nohup bash x.sh', 'BASH_ENV=f.sh timeout 5 bash x.sh', 'BASH_ENV=f.sh time bash x.sh',
  ]) denyBoth(c, SPEC);
});

test('#18: an env wrapper, an export or an earlier assignment on the line counts, exported or not', () => {
  for (const c of [
    'env BASH_ENV=f.sh bash x.sh', 'env -i BASH_ENV=f.sh bash x.sh', 'env -S "BASH_ENV=f.sh bash x.sh"', "env -S 'ENV=f.sh sh x.sh'", 'env A=1 BASH_ENV=f.sh bash x.sh',
    'export BASH_ENV=f.sh; bash x.sh', 'export BASH_ENV=f.sh && bash x.sh', 'BASH_ENV=f.sh; bash x.sh', 'declare -x BASH_ENV=f.sh; bash x.sh', 'typeset -x ENV=f.sh; sh x.sh',
    'readonly BASH_ENV=f.sh; bash x.sh', 'export ENV=f.sh; sh -c "echo hi"', 'F=f.sh; BASH_ENV=$F bash x.sh', 'F=f.sh; export BASH_ENV="$F"; bash x.sh', 'F=f.sh; BASH_ENV=${F} bash x.sh',
    '(export BASH_ENV=f.sh; bash x.sh)', 'if true; then export BASH_ENV=f.sh; fi; bash x.sh', 'f() { bash x.sh; }; BASH_ENV=f.sh; f', 'echo a | { export BASH_ENV=f.sh; bash x.sh; }',
    "bash -c 'BASH_ENV=f.sh bash x.sh'", "bash -c 'export BASH_ENV=f.sh; bash x.sh'", 'echo "BASH_ENV=f.sh bash x.sh" | bash',
  ]) denyBoth(c, SPEC);
  // a script that sets it for the shells it starts
  denyBoth('bash outer.sh', { ...SPEC, 'outer.sh': 'BASH_ENV=f.sh bash x.sh' });
  denyBoth('bash outer.sh', { ...SPEC, 'outer.sh': 'export BASH_ENV=f.sh\nbash x.sh' });
});

test('#18: a value assigned on the line reaches the shells a sourced script starts', () => {
  const spec = { ...SPEC, 'outer.sh': 'bash x.sh', 'zouter.sh': 'zsh -c "echo hi"' };
  for (const c of ['BASH_ENV=f.sh; source outer.sh', 'export BASH_ENV=f.sh; . ./outer.sh', 'export ENV=f.sh; source outer.sh', 'export ZDOTDIR=zd; source zouter.sh', 'HOME=zd; source zouter.sh']) denyBoth(c, spec);
  allowBoth('BASH_ENV=ok.sh; source outer.sh', spec);
  allowBoth('source outer.sh', spec);
  // the hook environment reaches a nested script too
  denyBoth('source outer.sh', spec, { env: { BASH_ENV: 'f.sh' } });
});

test('#18: the hook process environment names a startup file too', () => {
  for (const c of ['bash x.sh', "bash -c 'echo hi'", 'sh x.sh', 'bash < x.sh', 'cd sub && bash ../x.sh']) {
    denyBoth(c, SPEC, { env: { BASH_ENV: 'f.sh' } });
  }
  denyBoth('sh x.sh', SPEC, { env: { ENV: 'f.sh' } });
  denyBoth('bash x.sh', { ...SPEC, '/tmp/hook/f.sh': 'bad' }, { env: { BASH_ENV: '/tmp/hook/f.sh' } });
  denyBoth('bash x.sh', SPEC, { env: { BASH_ENV: 'f.sh', PATH: '/usr/bin' } });
  // the command's own prefix overrides the inherited value
  allowBoth('BASH_ENV=ok.sh bash x.sh', SPEC, { env: { BASH_ENV: 'f.sh' } });
  // no shell, no startup file
  allowBoth('echo hi', SPEC, { env: { BASH_ENV: 'f.sh' } });
  allowBoth('ls', SPEC, { env: { BASH_ENV: 'f.sh', ENV: 'f.sh' } });
  // an empty value names nothing
  allowBoth('bash x.sh', SPEC, { env: { BASH_ENV: '' } });
});

test('#18: a startup file value known only at run time is refused when the line names a guarded operation / protected path', () => {
  for (const c of ['BASH_ENV=$Q bash x.sh', 'BASH_ENV=$(echo f.sh) bash x.sh', 'BASH_ENV=`echo f.sh` bash x.sh', 'export BASH_ENV=$Q; bash x.sh']) {
    assert.equal(git(`${c}; git push origin agent/x`, fakeFs(GIT_ROOT, { 'x.sh': 'git status' }, DIRS)).decision, 'deny', c);
    assert.match(git(`${c}; git push origin agent/x`, fakeFs(GIT_ROOT, { 'x.sh': 'git status' }, DIRS)).reason, /run time/, c);
    assert.equal(files(`${c}; ls ~/.claude/pipeline`, fakeFs(PROJ, { 'x.sh': 'echo hi' }, DIRS)).decision, 'deny', c);
    // nothing guarded on the line: the same rule as for a script named at run time lets it through
    assert.equal(git(c, fakeFs(GIT_ROOT, { 'x.sh': 'git status' }, DIRS)).decision, 'allow', c);
    assert.equal(files(c, fakeFs(PROJ, { 'x.sh': 'echo hi' }, DIRS)).decision, 'allow', c);
  }
  // an assignment that may not run leaves the value unknown to the git policy
  const g = fakeFs(GIT_ROOT, { 'x.sh': 'git status', 'ok.sh': 'git status' }, DIRS);
  assert.equal(git('BASH_ENV=ok.sh; false && BASH_ENV=$Q; bash x.sh; git push origin agent/x', g).decision, 'deny');
});

test('#18: ZDOTDIR names the directory of the zsh startup files; .zshenv always, .zprofile/.zlogin with -l, .zshrc with -i', () => {
  for (const c of [
    "ZDOTDIR=zd zsh -c 'echo hi'", 'ZDOTDIR=zd zsh x.sh', 'ZDOTDIR=zd zsh', 'ZDOTDIR=zd zsh -s', 'ZDOTDIR=zd/ zsh -c "echo hi"', 'env ZDOTDIR=zd zsh -c "echo hi"', 'export ZDOTDIR=zd; zsh -c "echo hi"',
    'ZDOTDIR=zd /bin/zsh -fc "echo hi"', 'ZDOTDIR=./zd zsh -c "echo hi"', 'ZDOTDIR=zd zsh < x.sh', 'ZDOTDIR=zd sudo zsh -c "echo hi"',
    'ZDOTDIR=zdl zsh -l -c "echo hi"', 'ZDOTDIR=zdl zsh -lc "echo hi"', 'ZDOTDIR=zdl zsh --login -c "echo hi"', 'ZDOTDIR=zdl zsh -i -c "echo hi"', 'ZDOTDIR=zdl zsh -ic "echo hi"',
    'ZDOTDIR=zdl zsh --interactive -c "echo hi"', 'ZDOTDIR=zdl zsh -l', 'ZDOTDIR=zdl zsh -o login -c "echo hi"', 'ZDOTDIR=zdl zsh $X -c "echo hi"', 'ZDOTDIR=zdl zsh -$X -c "echo hi"',
  ]) denyBoth(c, SPEC);
});

test('#18: HOME is where zsh looks when ZDOTDIR is unset', () => {
  denyBoth("HOME=zd zsh -c 'echo hi'", SPEC);
  denyBoth("zsh -c 'echo hi'", { ...SPEC, '/home/u/.zshenv': 'bad' });
  denyBoth('zsh x.sh', { ...SPEC, '/home/u/.zshenv': 'bad' });
  allowBoth("zsh -c 'echo hi'", { ...SPEC, '/home/u/.zshenv': 'ok' });
  allowBoth("zsh -c 'echo hi'", SPEC);
  // ZDOTDIR in the command's own prefix replaces HOME's
  allowBoth("ZDOTDIR=zd2 zsh -c 'echo hi'", { ...SPEC, '/home/u/.zshenv': 'bad' });
});

test('#18: --rcfile / --init-file name a file an interactive bash runs', () => {
  for (const c of ['bash --rcfile f.sh -i', 'bash --init-file f.sh -i -c "echo hi"', 'bash --rcfile=f.sh -i', 'bash -i --rcfile f.sh']) denyBoth(c, SPEC);
  allowBoth('bash --rcfile ok.sh -i', SPEC);
});

test('#18: a program run by path may be a shell script: its startup file is judged', () => {
  denyBoth('BASH_ENV=f.sh ./x.sh', SPEC);
  denyBoth('export BASH_ENV=f.sh; ./x.sh', SPEC);
  allowBoth('./x.sh', SPEC);
  allowBoth('BASH_ENV=ok.sh ./x.sh', SPEC);
});

test('#18: controls stay allowed', () => {
  for (const c of [
    'bash x.sh', 'BASH_ENV=ok.sh bash x.sh', 'ENV=ok.sh sh x.sh', "ZDOTDIR=zd2 zsh -c 'echo hi'", "zsh -c 'echo hi'", "bash -c 'echo hi'", 'ZDOTDIR=nonexistent zsh -c "echo hi"', 'BASH_ENV=nonexistent.sh bash x.sh',
    'env BASH_ENV=ok.sh bash x.sh', 'export BASH_ENV=ok.sh; bash x.sh', 'BASH_ENV=f.sh true', 'BASH_ENV=f.sh echo hi', 'export BASH_ENV=f.sh', 'echo BASH_ENV=f.sh bash x.sh', 'echo "bash x.sh"',
    'BASH_ENV=f.sh; BASH_ENV=ok.sh bash x.sh', // the command's own prefix wins over an earlier assignment
    "ZDOTDIR=zdl zsh -c 'echo hi'", // .zprofile / .zlogin / .zshrc only run for login / interactive shells
    'ZDOTDIR=zdl zsh -c "echo hi" -x', 'ZDOTDIR=zdl zsh x.sh -l', // an option after the script is the script's
    "BASH_ENV=f.sh git status", 'BASH_ENV=f.sh node x.mjs', 'BASH_ENV=f.sh cat x.sh', 'BASH_ENV=f.sh ls',
  ]) allowBoth(c, SPEC);
});

test('#18: startupFilesOf lists the files (pure parser API)', () => {
  const of = (line, opts = {}) => {
    const cmds = simpleCommands(line);
    const c = cmds.find((x) => ['bash', 'sh', 'zsh', 'dash'].includes(commandName(x.argv[0])) || x.argv[0]?.startsWith('./'));
    return startupFilesOf(c, cmds, opts);
  };
  assert.deepEqual(of('BASH_ENV=f.sh bash x.sh').map((f) => f.file), ['f.sh']);
  assert.deepEqual(of('BASH_ENV=f.sh bash x.sh').map((f) => f.kind), ['shell']);
  assert.deepEqual(of('bash x.sh'), []);
  assert.deepEqual(of('BASH_ENV=$Q bash x.sh'), [{ kind: 'shell', file: '$Q', ambiguous: true, words: ['$Q'] }]);
  assert.deepEqual(of('bash x.sh', { env: { BASH_ENV: 'h.sh', ENV: 'e.sh' } }).map((f) => f.file), ['h.sh', 'e.sh']);
  assert.deepEqual(of('ZDOTDIR=z zsh -c x').map((f) => f.file), ['z/.zshenv']);
  assert.deepEqual(of('ZDOTDIR=z zsh -l -c x').map((f) => f.file), ['z/.zshenv', 'z/.zprofile', 'z/.zlogin', 'z/.zlogout']);
  assert.deepEqual(of('zsh -c x').map((f) => f.file), ['~/.zshenv']);
  assert.deepEqual(of('ZDOTDIR=z zsh -i -c x').map((f) => f.file), ['z/.zshenv', 'z/.zshrc']);
  // a name that is not a shell has none
  const cmds = simpleCommands('BASH_ENV=f.sh git status');
  assert.deepEqual(startupFilesOf(cmds[0], cmds), []);
  assert.deepEqual(startupFilesOf(undefined, []), []);
});
