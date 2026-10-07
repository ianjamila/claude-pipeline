// Why (issue #9): the guards judge a script a command runs (`bash f.sh`, `source f`, `node f.mjs`) by reading the file.
// They used to take the first non-option word as the script, so a word that expands at run time (`$X`, `$(..)`,
// backticks, a glob) hid which word really is the script: `X=+n; bash $X f.sh` runs f.sh although the guard looked
// for a file called `+n`. Now, when any word up to the chosen operand expands, EVERY word from argv[1] on is judged as
// a possible script (known variables expanded whole and split on whitespace); a word that is still unknown is denied
// when the line mentions a guarded operation (guard-git) or a protected pipeline file (guard-files).
// The file system is faked (like test/guard-git.test.mjs and test/guard-files-bypass.test.mjs); the guarded text only
// ever lives in fake file contents.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { evaluateGitCommand } from '../pipeline/hooks/lib/git-policy.mjs';
import { evaluateBashForFiles } from '../pipeline/hooks/lib/files-policy.mjs';
import { scriptFileOf } from '../pipeline/hooks/lib/shell-parse.mjs';

// A fake file system. `files`: path -> text (null = exists but cannot be read); `dirs`: directory paths.
// Paths are relative to `root` unless absolute. readDir answers like fs.readdirSync (null when not a directory).
function fakeFs(root, files, dirs = []) {
  const abs = (p) => (p.startsWith('/') ? p : resolve(root, p));
  const F = Object.fromEntries(Object.entries(files).map(([k, v]) => [abs(k), v]));
  const D = new Set([root, ...dirs.map(abs)].map((p) => resolve(p)));
  const names = (d) => {
    const out = new Set();
    for (const p of [...Object.keys(F), ...D]) if (p !== d && dirname(p) === d) out.add(p.slice(d.length + (d.endsWith('/') ? 0 : 1)));
    return [...out];
  };
  return {
    readText: (p) => (typeof F[resolve(p)] === 'string' ? F[resolve(p)] : null),
    pathExists: (p) => resolve(p) in F || D.has(resolve(p)),
    readDir: (p) => (D.has(resolve(p)) ? names(resolve(p)) : null),
  };
}

// ---- guard-git -------------------------------------------------------------------------------------------------------

const GIT_ROOT = resolve('/work/repo');
const GIT_FILES = {
  'f.sh': 'git push origin main',
  'ok.sh': 'git status',
  'a.sh': 'git status',
  'f.mjs': "import { execSync } from 'node:child_process';\nexecSync('git push origin main');",
  'ok.mjs': "console.log('hi')",
  'f.py': 'import subprocess\nsubprocess.run(["git", "push", "origin", "main"])',
  'unreadable.sh': null,
  'sub/f.sh': 'git push origin main',
  'sub/ok.sh': 'git status',
};
const gitFs = (extraFiles = {}, extraDirs = []) => fakeFs(GIT_ROOT, { ...GIT_FILES, ...extraFiles }, ['sub', 'd', ...extraDirs]);
const git = (command, fsOpts = gitFs(), o = {}) => evaluateGitCommand(command, {
  cwd: GIT_ROOT, home: '/home/u', currentBranch: () => 'agent/x', pushDestination: () => null, issueLabels: () => [], ...fsOpts, ...o,
});

test('guard-git: a known variable that is an option (or several) no longer hides the script', () => {
  for (const c of [
    'X=+n; bash $X f.sh', 'X=-x; bash $X f.sh', 'X="-o posix"; bash $X f.sh', 'X="-o posix"; bash "$X" f.sh', 'X=-c; bash $X ./f.sh',
    'X=--norc; sh ${X} f.sh', 'X=-x; zsh $X f.sh', 'X=-x Y=-e; bash $X $Y f.sh',
  ]) assert.equal(git(c).decision, 'deny', c);
  assert.match(git('X=+n; bash $X f.sh').reason, /f\.sh/);
});

test('guard-git: an unknown variable, a substitution or backticks before the script no longer hide it', () => {
  for (const c of ['bash $X f.sh', 'bash "$X" f.sh', 'bash $(echo -x) f.sh', 'bash `echo -x` f.sh', 'bash -$Y f.sh', 'bash ${X:-} f.sh', 'bash -o $X f.sh'])
    assert.equal(git(c).decision, 'deny', c);
  for (const c of ['bash $X ok.sh', 'bash $(echo -x) ok.sh', 'bash `echo -x` ok.sh', 'bash $X']) assert.equal(git(c).decision, 'allow', c);
});

test('guard-git: source and . judge every word when the operand is a variable', () => {
  // the split matters: "ok.sh f.sh" as ONE word is a missing file
  for (const c of ['X="ok.sh f.sh"; source $X', 'X="ok.sh f.sh"; . $X', 'X="a.sh f.sh"; source $X', 'source $X f.sh', 'source $(echo ok.sh) f.sh'])
    assert.equal(git(c).decision, 'deny', c);
  for (const c of ['X=ok.sh; source $X', 'X="ok.sh a.sh"; source $X', 'X=missing.sh; source $X', 'source $X']) assert.equal(git(c).decision, 'allow', c);
});

test('guard-git: interpreters judge every word too', () => {
  for (const c of ['X=--require; node $X f.mjs', 'X=--require; node $X ./f.mjs', 'X="--require x"; node $X f.mjs', 'node $X f.mjs', 'X=-u; python3 $X f.py', 'X=-B; python $X f.py'])
    assert.equal(git(c).decision, 'deny', c);
  // a python-like interpreter only runs a file with a script extension: a data word is not judged
  assert.equal(git('X=-u; python3 $X data.txt', gitFs({ 'data.txt': 'git push origin main' })).decision, 'allow');
  for (const c of ['X=--require; node $X ok.mjs', 'node $X ok.mjs', 'node --require $X ok.mjs']) assert.equal(git(c).decision, 'allow', c);
});

test('guard-git: a glob in the script position is resolved against the directory and its matches judged', () => {
  for (const c of ['bash *.sh', 'bash f*.sh', 'bash ?.sh', 'bash [f].sh', 'bash sub/*.sh', 'bash ./sub/f.s?', 'bash -x *.sh', 'source *.sh', 'node *.mjs', 'bash $X *.sh'])
    assert.equal(git(c).decision, 'deny', c);
  const clean = gitFs({ 'f.sh': 'git status', 'sub/f.sh': 'git status', 'f.mjs': 'x', 'unreadable.sh': 'git status' });
  for (const c of ['bash *.sh', 'bash sub/*.sh', 'bash nomatch*.sh', 'bash sub/*/x.sh', 'bash .*.sh']) assert.equal(git(c, clean).decision, 'allow', c);
  // a dotfile is not matched by a bare *
  assert.equal(git('bash *', gitFs({ '.hidden.sh': 'git push origin main' }, [])).decision, 'deny'); // f.sh is still matched
  assert.equal(git('bash *', fakeFs(GIT_ROOT, { '.hidden.sh': 'git push origin main', 'ok.sh': 'git status' })).decision, 'allow');
  // ** needs a recursive walk we do not do: refuse rather than guess
  assert.equal(git('bash **/f.sh').decision, 'deny');
  // a glob that matches a lot is refused outright
  const many = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`m${i}.sh`, 'git status']));
  assert.equal(git('bash m*.sh', gitFs(many)).decision, 'deny');
  assert.match(git('bash m*.sh', gitFs(many)).reason, /too many|matches/);
});

test('guard-git: a word that is still unknown is denied when the line mentions a guarded operation', () => {
  for (const c of ['bash $X ok.sh && git push origin agent/x', 'source "$F" && git merge-base a b', 'bash $(echo -x) ok.sh; gh pr merge 5', 'node $X ok.mjs && git push origin agent/x'])
    assert.equal(git(c).decision, 'deny', c);
  assert.match(git('bash $X ok.sh && git push origin agent/x').reason, /run time/);
  // a known variable is judged, not guessed: the line mentioning push does not matter if every candidate is clean
  assert.equal(git('X=ok.sh; bash $X && git push origin agent/x').decision, 'allow');
  assert.equal(git('bash $X ok.sh && git status').decision, 'allow');
});

test('guard-git: candidates that are directories are skipped, unreadable files are denied, missing ones run nothing', () => {
  assert.equal(git('X=d; bash $X').decision, 'allow');
  assert.equal(git('X=-x; bash $X d').decision, 'allow');
  assert.equal(git('bash $X d ok.sh').decision, 'allow');
  assert.equal(git('X=-x; bash $X nothing.sh').decision, 'allow');
  assert.equal(git('X=-x; bash $X unreadable.sh').decision, 'deny');
  assert.match(git('X=-x; bash $X unreadable.sh').reason, /cannot read/);
  // naming a directory directly keeps its old answer (a shell cannot run it: read error, so denied as unverifiable)
  assert.equal(git('bash d').decision, 'deny');
});

test('guard-git: more than 32 candidate words are refused', () => {
  const words = Array.from({ length: 33 }, (_, i) => `w${i}.sh`).join(' ');
  assert.equal(git(`bash $X ${words}`).decision, 'deny');
  assert.match(git(`bash $X ${words}`).reason, /too many/);
  const ok = Array.from({ length: 30 }, (_, i) => `w${i}.sh`).join(' ');
  assert.equal(git(`bash $X ${ok}`).decision, 'allow');
  // a variable holding many words counts as many
  assert.equal(git(`X="${words}"; source $X`).decision, 'deny');
});

test('guard-git: a script in a directory the line changed to is judged against that directory', () => {
  assert.equal(git('cd sub && bash $X f.sh').decision, 'deny');
  assert.equal(git('cd sub && bash $X ok.sh').decision, 'allow');
  assert.equal(git('cd sub && bash *.sh').decision, 'deny');
});

test('guard-git: HOME and ~ in the operand are still resolved', () => {
  const files = { '/home/u/f.sh': 'git push origin main', '/home/u/ok.sh': 'git status' };
  const h = fakeFs(GIT_ROOT, files);
  assert.equal(git('bash $HOME/f.sh', h).decision, 'deny');
  assert.equal(git('bash ${HOME}/f.sh', h).decision, 'deny');
  assert.equal(git('bash ~/f.sh', h).decision, 'deny');
  assert.equal(git('source $HOME/f.sh', h).decision, 'deny');
  assert.equal(git('bash $HOME/ok.sh', h).decision, 'allow');
  assert.equal(git('bash ~/ok.sh', h).decision, 'allow');
});

test('guard-git: behaviour that must not change', () => {
  for (const c of ['bash f.sh', 'sh ./f.sh', 'source f.sh', '. f.sh', 'bash -x -e f.sh a b', 'node f.mjs', 'python3 f.py', 'F=f.sh; bash $F', 'F=f.sh; source $F', 'F=f.sh; . ${F}'])
    assert.equal(git(c).decision, 'deny', c);
  for (const c of ['bash ok.sh', 'bash ok.sh $Y', 'bash ok.sh *.sh', 'source ok.sh f.sh', 'F=ok.sh; bash $F', 'F=ok.sh; source $F', 'bash missing.sh', 'node ok.mjs --glob "*.js"', 'node --test test/*.test.mjs', 'bash -c "echo $X *.sh"', 'bash -c "$X"', 'bash <(echo hi)', 'echo hi | bash', 'bash -s', 'node -e "console.log(1)"'])
    assert.equal(git(c).decision, 'allow', c);
  // existing run-time-name rule: an unresolvable operand on a line that mentions a guarded operation
  assert.equal(git('bash "$SCRIPT" && git push origin x').decision, 'deny');
  assert.equal(git('bash "$SCRIPT"').decision, 'allow');
  // the pipeline's own installed files and node_modules are still not judged
  const pkg = fakeFs(GIT_ROOT, { 'node_modules/x/cli.mjs': "execSync('git push origin main')", '/home/u/.claude/pipeline/bin/pipeline.mjs': "execSync('git push origin main')" });
  assert.equal(git('node node_modules/x/cli.mjs', pkg).decision, 'allow');
  assert.equal(git('X=-x; node $X node_modules/x/cli.mjs', pkg).decision, 'allow');
  assert.equal(git('node $X node_modules/x/cli.mjs', pkg).decision, 'allow');
  assert.equal(git('node $HOME/.claude/pipeline/bin/pipeline.mjs preflight', pkg).decision, 'allow');
});

test('guard-git: nesting is still limited and a nested script is judged', () => {
  const nested = gitFs({ 'n1.sh': 'bash $X f.sh', 'n2.sh': 'X=-x; bash $X n1.sh' });
  assert.equal(git('bash n1.sh', nested).decision, 'deny');
  assert.equal(git('bash $X n2.sh', nested).decision, 'deny');
  const loop = gitFs({ 'loop.sh': 'X=-x; bash $X loop.sh' });
  assert.equal(git('bash loop.sh', loop).decision, 'deny');
});

// ---- guard-files -----------------------------------------------------------------------------------------------------

const PROJ = '/home/u/proj';
const FILES_FILES = {
  'w.sh': 'echo x > ~/.claude/settings.json',
  'ok.sh': 'ls ~/.claude/pipeline',
  'a.sh': 'echo hi',
  'w.mjs': "import fs from 'node:fs';\nfs.writeFileSync(`${process.env.HOME}/.claude/settings.json`, '{}');",
  'ok.mjs': "console.log('hi')",
  'w.py': "import os\nopen(os.path.expanduser('~/.claude/pipeline/x'), 'w').write('x')",
  'unreadable.sh': null,
  'sub/w.sh': 'rm ~/.claude/pipeline/VERSION',
  'sub/ok.sh': 'echo hi',
};
const filesFs = (extraFiles = {}, extraDirs = []) => fakeFs(PROJ, { ...FILES_FILES, ...extraFiles }, ['sub', 'd', ...extraDirs]);
const files = (command, fsOpts = filesFs(), o = {}) => {
  const f = { ...fsOpts, existsSync: fsOpts.pathExists };
  return evaluateBashForFiles(command, { home: '/home/u', env: {}, platform: 'linux', realpath: (p) => p, cwd: PROJ, ...f, ...o });
};

test('guard-files: a known variable that is an option (or several) no longer hides the script', () => {
  for (const c of ['X=+n; bash $X w.sh', 'X=-x; bash $X w.sh', 'X="-o posix"; bash $X w.sh', 'X="-o posix"; bash "$X" w.sh', 'X=-c; bash $X ./w.sh', 'X=-x; zsh ${X} w.sh', 'X=-x Y=-e; bash $X $Y w.sh'])
    assert.equal(files(c).decision, 'deny', c);
  assert.match(files('X=+n; bash $X w.sh').reason, /w\.sh/);
});

test('guard-files: an unknown variable, a substitution or backticks before the script no longer hide it', () => {
  for (const c of ['bash $X w.sh', 'bash "$X" w.sh', 'bash $(echo -x) w.sh', 'bash `echo -x` w.sh', 'bash -$Y w.sh', 'bash -o $X w.sh'])
    assert.equal(files(c).decision, 'deny', c);
  for (const c of ['bash $X ok.sh', 'bash $(echo -x) ok.sh', 'bash `echo -x` ok.sh', 'bash $X']) assert.equal(files(c).decision, 'allow', c);
});

test('guard-files: source and . judge every word when the operand is a variable', () => {
  for (const c of ['X="ok.sh w.sh"; source $X', 'X="a.sh w.sh"; . $X', 'source $X w.sh', 'source $(echo a.sh) w.sh']) assert.equal(files(c).decision, 'deny', c);
  for (const c of ['X=a.sh; source $X', 'X="ok.sh a.sh"; source $X', 'X=missing.sh; source $X', 'source $X']) assert.equal(files(c).decision, 'allow', c);
});

test('guard-files: interpreters judge every word too', () => {
  for (const c of ['X=--require; node $X w.mjs', 'X="--require x"; node $X ./w.mjs', 'node $X w.mjs', 'X=-u; python3 $X w.py']) assert.equal(files(c).decision, 'deny', c);
  assert.equal(files('X=-u; python3 $X data.txt', filesFs({ 'data.txt': 'rm ~/.claude/pipeline/VERSION > ~/.claude/settings.json' })).decision, 'allow');
  for (const c of ['X=--require; node $X ok.mjs', 'node $X ok.mjs', 'node --require $X ok.mjs']) assert.equal(files(c).decision, 'allow', c);
});

test('guard-files: a glob in the script position is resolved against the directory and its matches judged', () => {
  for (const c of ['bash w*.sh', 'bash ?.sh', 'bash [w].sh', 'bash sub/*.sh', 'bash -x *.sh', 'source w*', 'node *.mjs', 'bash $X *.sh', 'cd sub && bash *.sh'])
    assert.equal(files(c).decision, 'deny', c);
  const clean = filesFs({ 'w.sh': 'echo hi', 'sub/w.sh': 'echo hi', 'w.mjs': 'x', 'w.py': 'x', 'unreadable.sh': 'echo hi' });
  for (const c of ['bash *.sh', 'bash sub/*.sh', 'bash nomatch*.sh', 'bash .*.sh']) assert.equal(files(c, clean).decision, 'allow', c);
  assert.equal(files('bash **/w.sh').decision, 'deny');
  const many = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`m${i}.sh`, 'echo hi']));
  assert.equal(files('bash m*.sh', filesFs(many)).decision, 'deny');
  assert.match(files('bash m*.sh', filesFs(many)).reason, /too many|matches/);
});

test('guard-files: a word that is still unknown is denied when the line names a protected pipeline file', () => {
  // `cat` is read-only and `node` is no shell, so only the run-time rule can deny these
  for (const c of ['node $X ok.mjs; cat ~/.claude/settings.json', 'node $(echo -r) ok.mjs; ls ~/.claude/pipeline', 'python3 "$F" ok.py; cat ~/.claude/settings.json', 'source "$F"; cat ~/.claude/settings.json'])
    assert.equal(files(c).decision, 'deny', c);
  assert.match(files('node $X ok.mjs; cat ~/.claude/settings.json').reason, /run time/);
  assert.equal(files('X=ok.mjs; node $X; cat ~/.claude/settings.json').decision, 'allow');
  assert.equal(files('node $X ok.mjs; echo hi').decision, 'allow');
});

test('guard-files: candidates that are directories are skipped, unreadable files are denied, missing ones run nothing', () => {
  assert.equal(files('X=d; bash $X').decision, 'allow');
  assert.equal(files('X=-x; bash $X d').decision, 'allow');
  assert.equal(files('X=-x; bash $X nothing.sh').decision, 'allow');
  assert.equal(files('X=-x; bash $X unreadable.sh').decision, 'deny');
  assert.match(files('X=-x; bash $X unreadable.sh').reason, /cannot read/);
  assert.equal(files('bash d').decision, 'deny');
});

test('guard-files: more than 32 candidate words are refused', () => {
  const words = Array.from({ length: 33 }, (_, i) => `w${i}.sh`).join(' ');
  assert.equal(files(`bash $X ${words}`).decision, 'deny');
  assert.match(files(`bash $X ${words}`).reason, /too many/);
  const ok = Array.from({ length: 30 }, (_, i) => `w${i}.sh`).join(' ');
  assert.equal(files(`bash $X ${ok}`).decision, 'allow');
  assert.equal(files(`X="${words}"; source $X`).decision, 'deny');
});

test('guard-files: HOME and ~ in the operand are still resolved', () => {
  const h = fakeFs(PROJ, { '/home/u/w.sh': 'echo x > ~/.claude/settings.json', '/home/u/a.sh': 'echo hi' });
  assert.equal(files('bash $HOME/w.sh', h).decision, 'deny');
  assert.equal(files('bash ~/w.sh', h).decision, 'deny');
  assert.equal(files('source ${HOME}/w.sh', h).decision, 'deny');
  assert.equal(files('bash $HOME/a.sh', h).decision, 'allow');
  assert.equal(files('bash ~/a.sh', h).decision, 'allow');
});

test('guard-files: behaviour that must not change', () => {
  for (const c of ['bash w.sh', 'sh ./w.sh', 'source w.sh', '. w.sh', 'node w.mjs', 'python3 w.py', 'F=w.sh; bash $F', 'F=w.sh; source $F', 'F=w.sh; . ${F}'])
    assert.equal(files(c).decision, 'deny', c);
  for (const c of ['bash a.sh', 'bash a.sh $Y', 'bash a.sh *.sh', 'F=a.sh; bash $F', 'F=a.sh; source $F', 'bash missing.sh', 'node ok.mjs --glob "*.js"', 'node --test test/*.test.mjs', 'bash -c "echo $X *.sh"', 'bash -c "$X"', 'echo hi | bash', 'bash -s', 'node -e "console.log(1)"'])
    assert.equal(files(c).decision, 'allow', c);
  const pkg = fakeFs(PROJ, { 'node_modules/x/cli.mjs': "fs.writeFileSync(os.homedir() + '/.claude/settings.json', '')" });
  assert.equal(files('node node_modules/x/cli.mjs', pkg).decision, 'allow');
  assert.equal(files('node $X node_modules/x/cli.mjs', pkg).decision, 'allow');
});

test('guard-files: nesting is still limited and a nested script is judged', () => {
  const nested = filesFs({ 'n1.sh': 'bash $X w.sh', 'n2.sh': 'X=-x; bash $X n1.sh' });
  assert.equal(files('bash n1.sh', nested).decision, 'deny');
  assert.equal(files('bash $X n2.sh', nested).decision, 'deny');
  const loop = filesFs({ 'loop.sh': 'X=-x; bash $X loop.sh' });
  assert.equal(files('bash loop.sh', loop).decision, 'deny');
  assert.match(files('bash loop.sh', loop).reason, /too deeply/);
});

// ---- scriptFileOf stays pure ----------------------------------------------------------------------------------------

test('scriptFileOf reports an expansion among the words it scanned instead of guessing the operand', () => {
  assert.deepEqual(scriptFileOf(['bash', '$X', 'f.sh']), { kind: 'shell', file: '$X', ambiguous: true, words: ['$X', 'f.sh'] });
  assert.deepEqual(scriptFileOf(['bash', '-x', 'f.sh', '$Y']), { kind: 'shell', file: 'f.sh' });
  assert.deepEqual(scriptFileOf(['bash', '-$Y']), { kind: 'shell', file: undefined, ambiguous: true, words: ['-$Y'] });
  assert.deepEqual(scriptFileOf(['bash', 'a*.sh']), { kind: 'shell', file: 'a*.sh', ambiguous: true, words: ['a*.sh'] });
  assert.deepEqual(scriptFileOf(['source', '$X', 'b']), { kind: 'shell', file: '$X', ambiguous: true, words: ['$X', 'b'] });
  assert.deepEqual(scriptFileOf(['source', 'a.sh', '$X']), { kind: 'shell', file: 'a.sh' });
  assert.deepEqual(scriptFileOf(['node', '--require', '$X', 'f.mjs']), { kind: 'interp', file: 'f.mjs', ambiguous: true, words: ['--require', '$X', 'f.mjs'], needExt: false });
  assert.deepEqual(scriptFileOf(['python3', '$X']), { kind: 'interp', file: '$X', ambiguous: true, words: ['$X'], needExt: true });
  assert.equal(scriptFileOf(['bash', '-c', '$X']), null);
  assert.equal(scriptFileOf(['bash']), null);
  assert.equal(scriptFileOf(['node', '-e', 'a*b']), null);
});
