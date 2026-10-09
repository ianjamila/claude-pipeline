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
const DIRS = ['sub', 'd', 'zd', 'zd2', 'zdl', 'bin', 'bin2', 'hb', 'hb2', 'hz'];
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

// a home directory whose every startup file holds the guarded text, and one whose files are all harmless
const HOMES = {
  ...SPEC,
  'hb/.bash_profile': 'bad', 'hb/.bash_login': 'bad', 'hb/.profile': 'bad', 'hb/.bashrc': 'bad', 'hz/.zshenv': 'bad', 'hz/.zprofile': 'bad', 'hz/.zshrc': 'bad',
  'hb2/.bash_profile': 'ok', 'hb2/.profile': 'ok', 'hb2/.bashrc': 'ok', 'hb2/.zshenv': 'ok', 'hb2/.zprofile': 'ok', 'hb2/.zshrc': 'ok',
};

test('#18: the HOME the child sees (prefix, env wrapper, earlier assignment, hook environment) decides where zsh reads its files', () => {
  for (const c of [
    "HOME=hz zsh -c 'echo hi'", 'HOME=hz zsh x.sh', 'env HOME=hz zsh -c "echo hi"', 'export HOME=hz; zsh x.sh', 'HOME=hz; zsh -c "echo hi"', 'declare -x HOME=hz; zsh -c "echo hi"',
    'HOME=hz zsh -l -c "echo hi"', 'HOME=hz zsh -i -c "echo hi"', 'HOME=hz zsh -ic "echo hi"', 'HOME=hz zsh --login -c "echo hi"',
  ]) denyBoth(c, HOMES);
  denyBoth('zsh x.sh', HOMES, { env: { HOME: 'hz' } });
  // .zprofile / .zlogin only for a login shell, .zshrc only for an interactive one; here only those hold the text
  const only = { 'hq/.zprofile': 'bad', 'hq/.zshrc': 'bad', 'hq/.zshenv': 'ok' };
  allowBoth('HOME=hq zsh -c "echo hi"', only);
  denyBoth('HOME=hq zsh -l -c "echo hi"', only);
  denyBoth('HOME=hq zsh -i -c "echo hi"', only);
  // the prefix replaces every other HOME, and the real home is not read when HOME points elsewhere
  allowBoth('HOME=hb2 zsh -c "echo hi"', { ...HOMES, '/home/u/.zshenv': 'bad' });
  allowBoth('export HOME=hz; HOME=hb2 zsh -c "echo hi"', HOMES);
});

test('#18: a bash login shell reads the profile files, an interactive one ~/.bashrc, under the HOME the child sees', () => {
  for (const c of [
    'HOME=hb bash -l -c "echo hi"', 'HOME=hb bash --login -c "echo hi"', 'HOME=hb bash -i -c "echo hi"', 'HOME=hb bash -ilc "echo hi"', 'HOME=hb bash --login x.sh', 'env HOME=hb bash -l -c "echo hi"',
    'export HOME=hb; bash -l -c "echo hi"', 'export HOME=hb; bash -i', 'HOME=hb; bash -i -c "echo hi"', 'HOME=hb bash -$X -c "echo hi"', 'HOME=hb sh -l -c "echo hi"', 'HOME=hb dash -l -c "echo hi"',
    'HOME=hb ksh -l -c "echo hi"', 'HOME=hb sh -i -c "echo hi"', 'HOME=hb sudo bash -l -c "echo hi"', 'HOME=hb bash -l',
  ]) denyBoth(c, HOMES);
  denyBoth('bash -l -c "echo hi"', HOMES, { env: { HOME: 'hb' } });
  // each file alone is enough
  for (const f of ['.bash_profile', '.bash_login', '.profile']) denyBoth('HOME=hp bash -l -c "echo hi"', { [`hp/${f}`]: 'bad' });
  denyBoth('HOME=hp bash -i -c "echo hi"', { 'hp/.bashrc': 'bad' });
  denyBoth('HOME=hp bash -$X -c "echo hi"', { 'hp/.profile': 'bad' }); // an option that expands may be -l
  // not login / not interactive: none of them is read
  for (const c of ['HOME=hb bash -c "echo hi"', 'HOME=hb bash x.sh', 'HOME=hb sh -c "echo hi"', 'HOME=hb bash -x -c "echo hi"']) allowBoth(c, HOMES);
  allowBoth('HOME=hp bash -i -c "echo hi"', { 'hp/.bash_profile': 'bad', 'hp/.profile': 'bad' });
  allowBoth('HOME=hp bash -l -c "echo hi"', { 'hp/.bashrc': 'bad' });
  allowBoth('HOME=hb2 bash -l -c "echo hi"', HOMES);
  allowBoth('HOME=hb2 bash -ilc "echo hi"', HOMES);
});

test('#18: ENV is what an interactive POSIX shell reads; --rcfile what an interactive bash reads', () => {
  for (const c of ["ENV=f.sh sh -i -c 'echo hi'", 'ENV=f.sh dash -i', 'ENV=f.sh ksh -i -c "echo hi"', 'ENV=f.sh bash -i -c "echo hi"', "bash --rcfile f.sh -i -c 'echo hi'", 'bash --init-file f.sh -i -c "echo hi"']) denyBoth(c, SPEC);
});

test('#18: the real home startup files are judged for the invocations that read them', () => {
  const real = (name) => ({ ...SPEC, [`/home/u/${name}`]: 'bad' });
  denyBoth('bash -i -c "echo hi"', real('.bashrc'));
  denyBoth('bash -l -c "echo hi"', real('.bash_profile'));
  denyBoth('bash --login x.sh', real('.profile'));
  denyBoth('sh -l -c "echo hi"', real('.profile'));
  denyBoth('zsh -l -c "echo hi"', real('.zprofile'));
  denyBoth('zsh -i -c "echo hi"', real('.zshrc'));
  denyBoth('zsh x.sh', real('.zshenv'));
  denyBoth('export HOME=hb2; zsh x.sh', real('.zshenv')); // the assignment may not apply: the real home too
  allowBoth('bash x.sh', real('.bashrc'));
  allowBoth('bash -c "echo hi"', { ...real('.bashrc'), ...real('.bash_profile'), ...real('.profile') });
  allowBoth('zsh -c "echo hi"', real('.zshrc'));
  allowBoth('zsh -c "echo hi"', real('.zprofile'));
  allowBoth('bash -l -c "echo hi"', { ...SPEC, '/home/u/.bashrc': 'bad' });
  // a harmless one is read but allowed
  allowBoth('bash -l -c "echo hi"', { ...SPEC, '/home/u/.profile': 'ok', '/home/u/.bash_profile': 'ok' });
});

test('#18: at the nesting limit the real home startup files are still judged (a chain of scripts ends in a zsh)', () => {
  const chain = (last) => ({ ...SPEC, 'a0.sh': 'bash a1.sh', 'a1.sh': 'bash a2.sh', 'a2.sh': 'bash a3.sh', 'a3.sh': last, 'a4.sh': 'ok' });
  denyBoth('bash a0.sh', { ...chain('zsh -c "echo hi"'), '/home/u/.zshenv': 'bad' });
  allowBoth('bash a0.sh', { ...chain('zsh -c "echo hi"'), '/home/u/.zshenv': 'ok' });
  allowBoth('bash a0.sh', chain('zsh -c "echo hi"'));
  // a startup file the line names, and a script named there, are refused as before
  denyBoth('bash a0.sh', chain('BASH_ENV=f.sh bash -c "echo hi"'));
  assert.match(both('bash a0.sh', chain('bash a4.sh')).files.reason, /too deeply/); // (guard-git follows one more level)
  allowBoth('bash a0.sh', chain('echo hi'));
  // the real home's file is read once, however deep the shells that need it are
  denyBoth('bash a0.sh', { ...chain('zsh -c "echo hi"; zsh -c "echo hi"'), '/home/u/.zshenv': 'bad' });
});

test('#18: a startup file judged clean early on the line is judged again once the state it depends on has changed (guard-git)', () => {
  // g.sh pushes the current branch: fine on agent/x, not after the line has checked out main
  const g = fakeFs(GIT_ROOT, { 'g.sh': 'git push', 'x.sh': 'git status' }, DIRS);
  assert.equal(git('BASH_ENV=g.sh bash x.sh', g).decision, 'allow');
  assert.equal(git('BASH_ENV=g.sh bash x.sh && git checkout main && BASH_ENV=g.sh bash x.sh', g).decision, 'deny');
  assert.equal(git('BASH_ENV=g.sh bash x.sh; git checkout main; bash x.sh', fakeFs(GIT_ROOT, { 'g.sh': 'git push', 'x.sh': 'git status' }, DIRS), { env: { BASH_ENV: 'g.sh' } }).decision, 'deny');
  // the same file and state twice is read once (200 shells do not exhaust the script budget)
  const many = Array.from({ length: 200 }, () => 'BASH_ENV=g.sh bash -c "echo hi"').join('; ');
  assert.equal(git(many, g).decision, 'allow');
});

test('#18: a HOME known only at run time is refused when the line names a guarded operation / protected path', () => {
  for (const c of ['HOME=$Q zsh -c "echo hi"', 'HOME=$(pwd) bash -l -c "echo hi"', 'export HOME=$Q; zsh x.sh']) {
    assert.equal(git(`${c}; git push origin agent/x`, fakeFs(GIT_ROOT, { 'x.sh': 'git status' }, DIRS)).decision, 'deny', c);
    assert.equal(files(`${c}; ls ~/.claude/pipeline`, fakeFs(PROJ, { 'x.sh': 'echo hi' }, DIRS)).decision, 'deny', c);
    assert.equal(git(c, fakeFs(GIT_ROOT, { 'x.sh': 'git status' }, DIRS)).decision, 'allow', c);
    assert.equal(files(c, fakeFs(PROJ, { 'x.sh': 'echo hi' }, DIRS)).decision, 'allow', c);
  }
});

test('#18: one startup file is read once per evaluation, however many shells the line starts', () => {
  const many = Array.from({ length: 200 }, () => "zsh -c 'echo hi'").join('; ');
  allowBoth(many, { ...SPEC, '/home/u/.zshenv': 'ok' });
  denyBoth(many, { ...SPEC, '/home/u/.zshenv': 'bad' });
});

test('#18: --rcfile / --init-file name a file an interactive bash runs', () => {
  for (const c of ['bash --rcfile f.sh -i', 'bash --init-file f.sh -i -c "echo hi"', 'bash --rcfile=f.sh -i', 'bash -i --rcfile f.sh']) denyBoth(c, SPEC);
  allowBoth('bash --rcfile ok.sh -i', SPEC);
});

test('#18: a program run by path may be a shell script: its startup file is judged', () => {
  denyBoth('BASH_ENV=f.sh ./x.sh', SPEC);
  denyBoth('export BASH_ENV=f.sh; ./x.sh', SPEC);
  allowBoth('./x.sh', SPEC);
  denyBoth('HOME=hz ./x.sh', HOMES);
  denyBoth('ZDOTDIR=zd ./x.sh', SPEC);
  allowBoth('HOME=hb2 ./x.sh', HOMES);
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

// ---- B: zsh glob qualifiers -------------------------------------------------------------------------------------------------

test('#19: a glob qualifier that runs code is judged: e:string:, e{string}, #q, +name, with any delimiter', () => {
  for (const c of [
    "ls *(e:'bash f.sh':)", 'ls *(e:"bash f.sh":)', 'ls *(e{bash f.sh})', 'ls *(e{echo {x}; bash f.sh})', 'ls *(e[bash f.sh])', 'ls *(e<bash f.sh>)', 'ls *(e(bash f.sh))', "ls *(e|bash f.sh|)", "ls *(e,bash f.sh,)", "ls *(e/bash f.sh/)",
    "ls foo(e:'bash f.sh':)", "ls *(#qe:'bash f.sh':)", "ls *(#q.e:'bash f.sh':)", "echo **/*(e'[[ -n $(bash f.sh) ]]')", "ls *(.e:'bash f.sh':om)", "ls *(om[1,3]e:'bash f.sh':)",
    "ls *(oe:'bash f.sh':)", "ls *(^e:'bash f.sh':)", "ls *(-.e:'bash f.sh':)", "ls *(.,e:'bash f.sh':)", "ls *(e:'bash f.sh':,/)", "ls a*b(e:'bash f.sh':)c", "print -l *(e:'bash f.sh':)",
    "*(e:'bash f.sh':)", "ls *(\\e:'bash f.sh':)", "ls *(e:'cat f.sh | bash':)", "ls *(e:'bash < f.sh':)", "ls *(e:'eval \"$(cat f.sh)\"':)", "ls *(e:'bash -c \"bash f.sh\"':)",
    "ls *(e:'BASH_ENV=f.sh bash x.sh':)", "ls *(e:'source f.sh':)", "ls ~/*(e:'bash f.sh':)", "for f in *(e:'bash f.sh':); do :; done", "x=$(ls *(e:'bash f.sh':))",
    "bash -c \"ls *(e:'bash f.sh':)\"", "ls *(e:\"ls *(e:'bash f.sh':)\":)",
  ]) denyBoth(c, SPEC);
  denyBoth('bash outer.sh', { ...SPEC, 'outer.sh': "ls *(e:'bash f.sh':)" });
  denyBoth('f() { bash f.sh; }; ls *(+f)', SPEC);
  denyBoth('f() { bash f.sh; }; ls *(+f)', SPEC);
  denyBoth('f() { bash f.sh; }; ls *(o+f)', SPEC);
  denyBoth('f() { bash f.sh; }; ls foo(+f)', SPEC);
  denyBoth('f() { bash f.sh; }; ls *(.+f)', SPEC);
  denyBoth('ls *(+bash)', { ...SPEC }, { env: { BASH_ENV: 'f.sh' } }); // `+name` runs the command `name`, a shell here
});

test('#19: a subshell glued to a word is judged too: no body between parentheses is ever dropped', () => {
  for (const c of [
    '{(bash f.sh); }', '{ (bash f.sh); }', '{(bash f.sh)}', 'foo(bash f.sh)', 'ls foo(bash f.sh)', 'ls a(bash f.sh)b', 'time(bash f.sh)', '[[(bash f.sh)]]', 'x=1 foo(bash f.sh)', 'ls *(bash f.sh)',
    'echo hi&&{(bash f.sh);}', '{(cd d; bash f.sh); }', 'ls *.(jpg|$(bash f.sh))', 'ls (a|bash f.sh)', 'ls *(a;bash f.sh)', 'ls *(a|bash f.sh|b)', "ls foo(bash\tf.sh)",
    'ls foo(bash f.sh', 'echo ${(f)$(bash f.sh)}', 'echo ${x:-(bash f.sh)}', 'ls foo(cat f.sh | bash)', 'ls foo(bash < f.sh)', 'ls foo(eval "$(cat f.sh)")', 'ls foo(bash -c "bash f.sh")',
  ]) denyBoth(c, SPEC);
  for (const c of ['{ (bash ok.sh); }', 'foo(bash ok.sh)', '{(echo hi); }', 'ls foo(echo hi)', 'f(){ :; }; f', 'x=(a b); echo $x']) allowBoth(c, SPEC);
});

test('#19: the guarded text itself inside the qualifier is judged by each policy', () => {
  const g = fakeFs(GIT_ROOT, { 'ok.sh': 'git status' }, DIRS);
  const f = fakeFs(PROJ, { 'ok.sh': 'echo hi' }, DIRS);
  for (const c of ["ls *(e:'git push origin main':)", "ls foo(e'git push origin main')", "ls *(e{git push origin main})", "ls *(#qe:'git push origin main':)"]) assert.equal(git(c, g).decision, 'deny', c);
  for (const c of ["ls *(e:'echo x > ~/.claude/settings.json':)", "ls *(e:'bash evil.sh':)"]) {
    const r = files(c, fakeFs(PROJ, { 'evil.sh': BAD_FILES, 'ok.sh': 'echo hi' }, DIRS));
    assert.equal(r.decision, 'deny', c);
  }
  assert.equal(git("ls *(e:'git status':)", g).decision, 'allow');
});

test('#19: harmless glob qualifiers and every construct next to a parenthesis keep their meaning (controls)', () => {
  for (const c of [
    'ls *(.)', 'ls *(om[1,3])', 'ls -d *(/)', 'print -l **/*(.)', 'a=(1 2); echo $a', 'f() { :; }; f', 'echo $((1+2))', '(cd sub && ls)', '[[ x =~ (a|b) ]]', 'case x in (a) :;; esac', 'ls *(N)',
    "ls *(e:'echo hi':)", "ls *(e:'bash ok.sh':)", 'f() { :; }; ls *(+f)', 'ls *(u:peter:)', 'ls *(.u:me:)', 'ls *.(jpg|png)', 'ls (a|b).txt', 'ls *(.L+10)', 'ls *(mh-1)', 'ls *(^/)', 'ls *(#qN)', 'ls *(#i)README',
    'ls *(.N)', 'arr=(a b c); echo ${arr[1]}', 'echo ${(f)x}', 'echo ${(@f)"$(cat ok.sh)"}', 'f(){ :; }; f', 'function g { :; }; g', 'x=(1 2); x+=(3); echo $x', 'for ((i=0;i<3;i++)); do :; done',
    'for((i=0;i<3;i++)); do :; done', 'echo a;(echo b)', 'true&&(echo b)', 'if true; then (echo b); fi', 'if(true); then :; fi', '! (false)', 'ls *(e)', 'ls *(+)', '[[ $x =~ ^(see|push)$ ]]', 'echo foo(bar)',
    'ls *(Oc[1])', 'ls *(om[1,3]N)', 'ls *(@)', 'ls *(*)', 'echo "*(e:\'bash f.sh\':)"', "echo '*(e:bash f.sh:)'", 'echo \\*\\(e:x:\\)',
  ]) allowBoth(c, SPEC);
});

test('#19: the qualifier code is parsed as commands one level deeper (pure parser API)', () => {
  const argvs = (line) => simpleCommands(line).map((c) => c.argv.join(" "));
  const cmds = simpleCommands("ls *(e:'bash f.sh':)");
  assert.ok(argvs("ls *(e:'bash f.sh':)").includes("bash f.sh"));
  assert.ok(cmds.find((c) => c.argv[0] === "bash").depth > cmds.find((c) => c.argv[0] === "ls").depth);
  assert.deepEqual(cmds.find((c) => c.argv[0] === "ls").argv, ["ls", "*(e:bash f.sh:)"]);
  assert.ok(argvs("ls *(+f)").includes("f"));
  assert.deepEqual(simpleCommands("ls *(.)").map((c) => c.argv), [["ls", "*(.)"]]);
  assert.ok(argvs("ls *(e{bash f.sh})").includes("bash f.sh"));
  // a group is part of the word: no brace expansion, no pipeline, no redirect inside it
  assert.deepEqual(simpleCommands('ls *.(jpg|png) a(<1-3>)').find((c) => c.argv[0] === 'ls').argv, ['ls', '*.(jpg|png)', 'a(<1-3>)']);
  assert.deepEqual(simpleCommands('ls *(.) *(^/) *(om[1,3])').map((c) => c.argv), [['ls', '*(.)', '*(^/)', '*(om[1,3])']]); // qualifier-only bodies are not read as commands too
  assert.deepEqual(simpleCommands('ls *(e{a,b})').find((c) => c.argv[0] === 'ls').argv, ['ls', '*(e{a,b})']); // no brace expansion inside the group
  assert.equal(simpleCommands('ls *(e:x:)').dynamic, false);
  // more code strings than a word may carry: the parse is cut short (the policies deny a truncated parse)
  assert.equal(simpleCommands(`ls *(${Array.from({ length: 40 }, (_, i) => `e:c${i}:`).join(',')})`).truncated, true);
  assert.equal(simpleCommands(`ls *(${Array.from({ length: 5 }, (_, i) => `e:c${i}:`).join(',')})`).truncated, false);
  // a group that is never closed cannot be delimited: dynamic
  assert.equal(simpleCommands("ls *(e:'bash f.sh':").dynamic, true);
  assert.equal(simpleCommands('ls foo(').dynamic, true);
  // code that is only known at run time makes the parse dynamic like any `-c` string
  assert.equal(simpleCommands("ls *(e:'$X':)").dynamic, true);
});

test('#19: a qualifier group that cannot be delimited is refused when the line names a guarded operation', () => {
  const g = fakeFs(GIT_ROOT, { 'ok.sh': 'git status' }, DIRS);
  assert.equal(git("ls *(e:'bash f.sh':", g).decision, 'allow'); // nothing guarded named: a syntax error runs nothing
  assert.equal(git("ls *(e:'bash f.sh':; git push origin agent/x", g).decision, 'deny');
  assert.equal(git("ls *(e:'$X':); git push origin agent/x", g).decision, 'deny');
  const f = fakeFs(PROJ, { 'ok.sh': 'echo hi' }, DIRS);
  assert.equal(files("ls *(e:'$X':); ls ~/.claude/pipeline", f).decision, 'deny');
  assert.equal(files("ls *(e:'$X':)", f).decision, 'allow');
});
