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
import { resolve, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { evaluateGitCommand } from '../pipeline/hooks/lib/git-policy.mjs';
import { evaluateBashForFiles } from '../pipeline/hooks/lib/files-policy.mjs';
import { scriptFileOf } from '../pipeline/hooks/lib/shell-parse.mjs';
import { defaultReadDir } from '../pipeline/hooks/lib/script-candidates.mjs';

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

test('guard-git: a quoted variable holding a path with a space is judged whole as well as split', () => {
  const sp = gitFs({ 'sp ace.sh': 'git push origin main' });
  assert.equal(git('X="sp ace.sh"; bash "$X"', sp).decision, 'deny');
  assert.equal(git('X="sp ace.sh"; source $X', sp).decision, 'deny');
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
  // dotfiles are matched too (bash dotglob / zsh GLOB_DOTS may be on): extra candidates only cost judging
  assert.equal(git('bash *', fakeFs(GIT_ROOT, { '.hidden.sh': 'git push origin main', 'ok.sh': 'git status' })).decision, 'deny');
  // ** needs a recursive walk we do not do: refuse rather than guess
  assert.equal(git('bash **/f.sh').decision, 'deny');
  // a glob that matches a lot is refused outright
  const many = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`m${i}.sh`, 'git status']));
  assert.equal(git('bash m*.sh', gitFs(many)).decision, 'deny');
  assert.match(git('bash m*.sh', gitFs(many)).reason, /too many|matches/);
});

test('guard-git: globs honour ~, ** and the directory the line changed to', () => {
  const home = fakeFs(GIT_ROOT, { '/home/u/h.sh': 'git push origin main' }, ['/home/u']);
  assert.equal(git('bash ~/*.sh', home).decision, 'deny');
  assert.equal(git('bash ~/h.sh', home).decision, 'deny');
  const deep = fakeFs(GIT_ROOT, { 'deep/x/ok.sh': 'git status', 'only.sh': 'git status', 'sub/bad.sh': 'git push origin main' }, ['deep', 'deep/x', 'sub']);
  assert.equal(git('bash **/ok.sh', deep).decision, 'deny'); // refused, not guessed
  assert.equal(git('cd sub && bash *.sh', deep).decision, 'deny');
  assert.equal(git('bash *.sh', deep).decision, 'allow');
});

test('guard-git: a glob over a directory too big to scan is refused', () => {
  const big = gitFs(Object.fromEntries(Array.from({ length: 5100 }, (_, i) => [`n${i}.txt`, 'x'])));
  assert.equal(git('bash zz*.sh', big).decision, 'deny');
  assert.match(git('bash zz*.sh', big).reason, /too many/);
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

test('guard-files: a quoted variable holding a path with a space is judged whole as well as split', () => {
  const sp = filesFs({ 'sp ace.sh': 'echo x > ~/.claude/settings.json' });
  assert.equal(files('X="sp ace.sh"; bash "$X"', sp).decision, 'deny');
  assert.equal(files('X="sp ace.sh"; source $X', sp).decision, 'deny');
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

test('guard-files: globs honour ~, ** and the directory the line changed to', () => {
  const home = fakeFs(PROJ, { '/home/u/h.sh': 'echo x > ~/.claude/settings.json' }, ['/home/u']);
  assert.equal(files('bash ~/*.sh', home).decision, 'deny');
  assert.equal(files('bash ~/h.sh', home).decision, 'deny');
  const deep = fakeFs(PROJ, { 'deep/x/ok.sh': 'echo hi', 'only.sh': 'echo hi', 'sub/bad.sh': 'rm ~/.claude/pipeline/VERSION' }, ['deep', 'deep/x', 'sub']);
  assert.equal(files('bash **/ok.sh', deep).decision, 'deny'); // refused, not guessed
  assert.equal(files('cd sub && bash *.sh', deep).decision, 'deny');
  assert.equal(files('bash *.sh', deep).decision, 'allow');
});

test('guard-files: a glob over a directory too big to scan is refused', () => {
  const big = filesFs(Object.fromEntries(Array.from({ length: 5100 }, (_, i) => [`n${i}.txt`, 'x'])));
  assert.equal(files('bash zz*.sh', big).decision, 'deny');
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

// ---- round 2: parser differentials (controller review) ----------------------------------------------------------------
// One table drives both guards: [guard-git bad text, guard-files bad text] are the contents of the fixture that must be
// judged; every row is a command that must be denied for BOTH, so the pairs below carry both spellings of the fixture.

const BAD_GIT = 'git push origin main';
const BAD_FILES = 'echo x > ~/.claude/settings.json';
// Builds both fake file systems from { name: 'bad' | 'ok' | null } and runs a command through each guard.
function both(command, spec = {}, extra = {}) {
  const mk = (bad, ok) => Object.fromEntries(Object.entries(spec).map(([k, v]) => [k, v === 'bad' ? bad : v === 'ok' ? ok : v]));
  const gfs = fakeFs(GIT_ROOT, mk(BAD_GIT, 'git status'), ['sub', ...(extra.dirs ?? [])]);
  const ffs = fakeFs(PROJ, mk(BAD_FILES, 'echo hi'), ['sub', ...(extra.dirs ?? [])]);
  return { git: git(command, gfs, extra.gitOpts), files: files(command, ffs, extra.filesOpts) };
}
const denyBoth = (command, spec, extra) => {
  const r = both(command, spec, extra);
  assert.equal(r.git.decision, 'deny', `git: ${command} -> ${r.git.reason}`);
  assert.equal(r.files.decision, 'deny', `files: ${command} -> ${r.files.reason}`);
  return r;
};
const allowBoth = (command, spec, extra) => {
  const r = both(command, spec, extra);
  assert.equal(r.git.decision, 'allow', `git: ${command} -> ${r.git.reason}`);
  assert.equal(r.files.decision, 'allow', `files: ${command} -> ${r.files.reason}`);
};

test('A: an unmatched glob (or a quoted name that looks like one) still runs the literal word, which is judged', () => {
  const spec = { 'f[1].sh': 'bad', 'f[1].mjs': 'bad', 'ok.sh': 'ok' };
  for (const c of ["bash 'f[1].sh'", 'bash f[1].sh', "X='f[1].sh'; bash $X", "source 'f[1].sh'", "node 'f[1].mjs'", 'node f[1].mjs', "bash $X 'f[1].sh'"]) denyBoth(c, spec);
  allowBoth("bash 'g[1].sh'", spec);
  // when the glob does match, both the matches and the literal are judged
  denyBoth('bash f[1].sh', { 'f1.sh': 'ok', 'f[1].sh': 'bad' });
  denyBoth('bash f[1].sh', { 'f1.sh': 'bad', 'f[1].sh': 'ok' });
});

test('B: glob syntax we cannot resolve is refused, not matched against nothing', () => {
  const spec = { 'fa.sh': 'ok', 'f.sh': 'ok' };
  for (const c of [
    'bash f[[:alpha:]].sh', 'bash f[[=a=]].sh', 'bash f[[.a.]].sh', "bash 'f*(a).sh'", "bash 'f?(a).sh'", "bash 'a|b*.sh'", "bash 'f(a)*.sh'",
    "bash '@(f|fa).sh'", "bash '!(x).sh'", 'bash ^foo.sh', "bash 'a#b.sh'", 'bash f#.sh', "bash 'a~b'", "bash '*.sh~f.sh'", "bash -x ^foo.sh",
    "source '^foo.sh'", 'node ^foo.mjs', 'X=1; bash ^f.sh $X',
  ]) {
    const r = denyBoth(c, spec);
    assert.match(r.git.reason, /name the file|Name the (?:script )?file|literally/i, c);
  }
  // what the shell parser turns into redirects and subshells: the raw text is what shows the pattern
  for (const c of ['bash f<1-2>.sh', 'bash *(N)', 'bash +(f|fa).sh', 'bash @(f|fa).sh', 'bash ?(f).sh', 'bash a(#i)f.sh', 'node f<1-2>.mjs']) denyBoth(c, spec);
  // not patterns: Windows 8.3 names, trailing ~, a = before ~, characters after the operand, plain parens in quotes
  allowBoth('node C:/PROGRA~1/x.mjs', spec);
  allowBoth('bash ok.sh~', spec);
  allowBoth('bash --rcfile=~/x ok.sh', spec);
  allowBoth('bash ok.sh "x*(y)" ^z', spec);
  allowBoth('python3 x.py "f(x)" "a#b"', spec);
  allowBoth("bash 'a(b).sh'", spec);
  allowBoth('echo hi | bash', spec);
});

test('H: a harmless copy of the command text earlier on the line does not hide the real one', () => {
  const spec = { 'f.sh': 'ok', 'a.sh': 'ok' };
  for (const c of ["echo 'bash *'; bash *(N)", "echo 'bash f<1-2>'; bash f<1-2>.sh", 'echo bash +; bash +(f|a).sh', "echo 'node f'; node f<1-2>.mjs"]) denyBoth(c, spec);
  allowBoth("echo 'bash ok.sh'; bash ok.sh", { 'ok.sh': 'ok' });
  // unresolvable syntax inside a variable's value is refused by the glob rules, not by the text rules
  denyBoth("X='f<1-2>*.sh'; bash $X", spec);
});

test('C: globs match case-insensitively and always include dotfiles', () => {
  denyBoth('bash F*.SH', { 'f.sh': 'bad' });
  denyBoth('bash f[A].sh', { 'fa.sh': 'bad' });
  denyBoth('bash ?hidden.sh', { '.hidden.sh': 'bad' });
  denyBoth('bash *hidden.sh', { '.hidden.sh': 'bad' });
  denyBoth('bash sub/*', { 'sub/.x.sh': 'bad' });
  allowBoth('bash F*.SH', { 'g.sh': 'bad', 'f.txt': 'bad' });
});

test('D: IFS assigned on the line widens how a known variable is split', () => {
  const spec = { 'f.sh': 'bad', 'ok.sh': 'ok' };
  for (const c of ['IFS=,; X=+n,f.sh; bash $X', 'IFS=,; X=ok.sh,f.sh; source $X', 'IFS=:; X=ok.sh:f.sh; . $X', 'export IFS=,; X=-x,f.sh; bash $X', 'IFS=", "; X="ok.sh f.sh"; bash $X'])
    denyBoth(c, spec);
  denyBoth('IFS=,; X=-x,f.mjs; node $X', { 'f.mjs': 'bad' });
  allowBoth('IFS=,; X=ok.sh,a.sh; bash $X', spec);
  // an IFS we cannot read makes every expanding word unknown: judged like $UNSET
  assert.equal(git('IFS=$Z; X=ok.sh; bash $X && git push origin agent/x').decision, 'deny');
  assert.equal(git('X=ok.sh; bash $X && git push origin agent/x').decision, 'allow');
  assert.equal(files('IFS=$Z; X=a.sh; node $X; cat ~/.claude/settings.json').decision, 'deny');
  assert.equal(files('X=a.mjs; node $X; cat ~/.claude/settings.json').decision, 'allow');
  // the assignment inside the script being judged counts too
  denyBoth('bash setup.sh', { 'setup.sh': 'IFS=,; X=+n,f.sh; bash $X', 'f.sh': 'bad' });
});

test('E: source -p PATH file (bash 5.3): every word is a candidate', () => {
  const spec = { 'f.sh': 'bad', 'ok.sh': 'ok' };
  for (const c of ['source -p /x f.sh', '. -p /x f.sh', 'source -p /x ok.sh f.sh', 'source --foo f.sh']) denyBoth(c, spec);
  allowBoth('source -p /x ok.sh', spec);
  allowBoth('source ok.sh -p f.sh', spec); // after the operand: arguments to the sourced file
  allowBoth('source - < /dev/null', spec);
});

test('F: a total budget of candidate-script judgments stops nested fan-out', () => {
  const tree = (width, levels, bad) => {
    const spec = {};
    const names = (k) => Array.from({ length: width }, (_, j) => `l${k}_${j}.sh`);
    for (let k = 0; k < levels; k++) for (const n of names(k)) spec[n] = k === levels - 1 ? 'ok' : { text: `bash $X ${names(k + 1).join(' ')}` };
    if (bad) spec[`l${levels - 1}_0.sh`] = 'bad';
    return { spec, top: names(0).join(' ') };
  };
  const make = (width, levels, bad) => {
    const t = tree(width, levels, bad);
    const mk = (b, ok) => Object.fromEntries(Object.entries(t.spec).map(([k, v]) => [k, v === 'bad' ? b : v === 'ok' ? ok : v.text]));
    return { top: t.top, gfs: fakeFs(GIT_ROOT, mk(BAD_GIT, 'git status')), ffs: fakeFs(PROJ, mk(BAD_FILES, 'echo hi')) };
  };
  // 10 + 100 + 1000 judgments would be needed
  const big = make(10, 3, false);
  const g = git(`bash $X ${big.top}`, big.gfs);
  const f = files(`bash $X ${big.top}`, big.ffs);
  assert.equal(g.decision, 'deny');
  assert.equal(f.decision, 'deny');
  assert.match(g.reason, /too many/);
  assert.match(f.reason, /too many/);
  // a modest tree is judged to the bottom (the bad leaf is found at depth 3)
  const small = make(3, 3, true);
  assert.equal(git(`bash $X ${small.top}`, small.gfs).decision, 'deny');
  assert.equal(files(`bash $X ${small.top}`, small.ffs).decision, 'deny');
  const smallOk = make(3, 3, false);
  assert.equal(git(`bash $X ${smallOk.top}`, smallOk.gfs).decision, 'allow');
  assert.equal(files(`bash $X ${smallOk.top}`, smallOk.ffs).decision, 'allow');
  // the budget is per evaluation: the same fixture twice in a row behaves the same
  assert.equal(git(`bash $X ${smallOk.top}`, smallOk.gfs).decision, 'allow');
  assert.equal(files(`bash $X ${smallOk.top}`, smallOk.ffs).decision, 'allow');
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

test('scriptFileOf: round 2 shapes (source options, zsh operators, pattern syntax cut out by the parser)', () => {
  assert.deepEqual(scriptFileOf(['source', '-p', '/x', 'f.sh']), { kind: 'shell', file: '-p', ambiguous: true, words: ['-p', '/x', 'f.sh'] });
  assert.deepEqual(scriptFileOf(['bash', '^f.sh']), { kind: 'shell', file: '^f.sh', ambiguous: true, words: ['^f.sh'] });
  assert.deepEqual(scriptFileOf(['bash', 'a#b']), { kind: 'shell', file: 'a#b', ambiguous: true, words: ['a#b'] });
  assert.deepEqual(scriptFileOf(['bash', 'a~b']), { kind: 'shell', file: 'a~b', ambiguous: true, words: ['a~b'] });
  for (const w of ['PROGRA~1', 'a.sh~', 'x=~/y', '~/a.sh']) assert.deepEqual(scriptFileOf(['bash', w]), { kind: 'shell', file: w }, w);
  // the parser cut the word at `<1-2>` / `(`: the text of the line shows what was there
  assert.deepEqual(scriptFileOf(['bash', 'f'], 'bash f', 'bash f<1-2>.sh'), { kind: 'shell', file: 'f', ambiguous: true, unresolvable: true, words: ['f'] });
  assert.deepEqual(scriptFileOf(['bash', 'f'], 'bash f<1-2>.sh'), { kind: 'shell', file: 'f', ambiguous: true, unresolvable: true, words: ['f'] });
  assert.equal(scriptFileOf(['bash', '+'], 'bash +', 'bash +(a|b).sh').unresolvable, true);
  assert.equal(scriptFileOf(['bash', '*'], 'bash *', 'bash *(N)').unresolvable, true);
  assert.equal(scriptFileOf(['node', 'a'], 'node a', 'node a(#i)b.mjs').unresolvable, true);
  assert.equal(scriptFileOf(['bash', 'ok.sh'], 'bash ok.sh', 'bash ok.sh; echo "x*(y)"').unresolvable, undefined);
  assert.equal(scriptFileOf(['bash', 'ok.sh', '*(N)'], 'bash ok.sh', 'bash ok.sh *(N)').unresolvable, undefined); // after the operand
  assert.deepEqual(scriptFileOf(['./f'], './f', './f<1-2>'), { kind: 'exec', file: './f', ambiguous: true, unresolvable: true, words: [] }); // a program run by path too (round 3)
  // H: the command is located by its text, so every occurrence is checked, never just the first or last
  assert.equal(scriptFileOf(['bash', 'x'], 'bash x', 'echo bash x; bash x(#i)y').unresolvable, true); // decoy first
  assert.equal(scriptFileOf(['bash', 'x'], 'bash x', 'bash x(#i)y; echo bash x').unresolvable, true); // decoy last
  assert.equal(scriptFileOf(['bash', 'a'], 'bash a', 'bash a(#i)b').unresolvable, true); // the operand text also sits inside "bash"
  assert.equal(scriptFileOf(['bash', 'x'], 'bash x', 'echo bash x; bash x').unresolvable, undefined);
  assert.equal(scriptFileOf(['bash', 'a'], 'bash a', 'bash a;'.repeat(40)).unresolvable, true); // too many places to check: refuse
  assert.equal(scriptFileOf(['bash', 'a'], 'bash a', 'bash a;'.repeat(5)).unresolvable, undefined);
});

// ---- round 3: the operand is not located by text; programs run by path; bracket expressions ---------------------------
// Each shape below was verified in real bash/zsh: the hidden script ran while the guard said allow.

test('G1: a pattern written next to quotes, backslashes or braces is found whatever the operand looks like once dequoted', () => {
  const spec = { 'ab1.sh': 'bad', 'xy1.sh': 'bad', 'ok.sh': 'ok' };
  for (const c of ['bash a""b<1-9>.sh', 'bash a\\b<1-9>.sh', 'bash x{y,z}<1-2>.sh', 'bash --rcfile ab a""b<1-9>.sh', "bash a''b<1-9>.sh", 'bash "a"<1-2>.sh', "bash $'a'b<1-9>.sh", 'source a""b<1-9>.sh', 'node a""b<1-9>.mjs']) denyBoth(c, spec);
  // a decoy that spells the operand out before the real one
  denyBoth('echo bash ab; bash a""b<1-9>.sh', spec);
  // the operand is not named at all (bash -$X may be `bash -x f.sh`): the pattern is still in the command's text
  for (const c of ['bash -$X a""b<1-9>.sh', 'bash -$X *(a)']) denyBoth(c, spec);
  assert.equal(scriptFileOf(['bash', '-$X'], 'bash -$X', 'bash -$X<1-2>').unresolvable, true);
  assert.equal(scriptFileOf(['bash', '-$X'], 'bash -$X', 'bash -$X').unresolvable, undefined);
  assert.equal(scriptFileOf(['bash', 'ab'], 'bash a""b<1-9>.sh').unresolvable, true);
});

test('G1: quoted, escaped or later-line text after the script is not a pattern', () => {
  const spec = { 'ok.sh': 'ok', 'x.mjs': 'ok', 'app.js': 'ok' };
  for (const c of ['node x.mjs --body "[a](b)"', "node x.mjs --body '[a](b)'", 'node x.mjs --body \\[a\\]\\(b\\)', 'node app.js --title "#1"','bash ok.sh "a*(b)" "c<1-2>"', "bash ok.sh $'a*(b)\\'*(c)'", 'bash ok.sh "q \\" *(a)"'])
    allowBoth(c, spec);
  // a newline that is not escaped or quoted ends the command: a heredoc body is not part of it
  assert.equal(scriptFileOf(['bash', 'ok.sh'], 'bash ok.sh\n*(a)').unresolvable, undefined);
  assert.equal(scriptFileOf(['bash', 'ok.sh'], 'bash ok.sh "a\n" *(b)').unresolvable, true); // newline inside quotes: same command
  assert.equal(scriptFileOf(['bash', 'ok.sh'], 'bash ok.sh \\\n *(b)').unresolvable, true); // escaped newline: same command
  assert.equal(scriptFileOf(['bash', 'ok.sh'], 'bash ok.sh "a\n*(b)"').unresolvable, undefined);
  // unquoted pattern syntax anywhere in the command's own text is refused (accepted: it may be a harmless argument)
  denyBoth('bash ok.sh *(N)', spec);
  denyBoth('node x.mjs ?(a)', spec);
});

test('G2: a program run by path goes through the same pattern check and expands like any other candidate', () => {
  const spec = { 'evil.sh': 'bad', 'ab1.sh': 'bad', 'ok.sh': 'ok' };
  for (const c of ['./ev*.sh', './ab<1-2>.sh', './ev?l.sh', './e[v]il.sh', './ev""*.sh', './ev\\*.sh', 'sub/../ev*.sh', './@(evil).sh']) denyBoth(c, spec);
  // a variable as the program, with or without a path
  for (const c of ['X=./evil.sh; $X', 'X=./evil.sh; "$X"', 'D=.; $D/evil.sh', 'X=./ev; $X*.sh', 'X=ok.sh; Y=./evil.sh; $Y']) denyBoth(c, spec);
  denyBoth('X=./ab1.sh; $X --flag', spec);
  // unchanged: a plain path, a missing file, a clean glob, system programs
  denyBoth('./evil.sh', spec);
  denyBoth('./evil.sh --flag "a*(b)"', spec);
  allowBoth('./ok.sh', spec);
  allowBoth('./missing.sh', spec);
  allowBoth('./ok*.sh', spec);
  allowBoth('./nomatch*.sh', spec);
  allowBoth('./su*', spec); // matches the directory only: nothing runs
  allowBoth('/usr/bin/ev*', spec);
  allowBoth('/bin/ls -la', spec);
  allowBoth('X=ok.sh; $X', spec);
  allowBoth('$X', spec);
  allowBoth('echo $X', spec);
  assert.deepEqual(scriptFileOf(['./x.sh'], './x.sh'), { kind: 'exec', file: './x.sh' });
  assert.deepEqual(scriptFileOf(['./ev*.sh'], './ev*.sh'), { kind: 'exec', file: './ev*.sh', ambiguous: true, words: ['./ev*.sh'] });
  assert.deepEqual(scriptFileOf(['$X'], '$X'), { kind: 'exec', file: '$X', ambiguous: true, words: ['$X'] });
  assert.equal(scriptFileOf(['./ab'], './ab<1-2>.sh').unresolvable, true);
  assert.equal(scriptFileOf(['/usr/bin/x*'], '/usr/bin/x*'), null);
  assert.equal(scriptFileOf(['ls'], 'ls'), null);
  // a glob that matches a lot is refused, and the judgment budget applies to exec candidates
  const many = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`m${i}.sh`, 'ok']));
  const r = denyBoth('./m*.sh', many);
  assert.match(r.git.reason, /too many|matches/);
});

test('G2: a program found by a glob is judged by its shebang like a program named directly', () => {
  const g = fakeFs(GIT_ROOT, { 'ev.mjs': "#!/usr/bin/env node\nexecSync('git push origin main');", 'ok.mjs': '#!/usr/bin/env node\nconsole.log(1)' });
  assert.equal(git('./ev*.mjs', g).decision, 'deny');
  assert.equal(git('./ok*.mjs', g).decision, 'allow');
  const bin = fakeFs(GIT_ROOT, { 'tool': 'ELF\u0000git push origin main' });
  assert.equal(git('./to*', bin).decision, 'allow'); // a binary
});

test('G3: a ] right after [ or [! / [^ is a member of the bracket expression', () => {
  const spec = { 'a.sh': 'bad', 'x.sh': 'bad', 'ok.sh': 'ok' };
  for (const c of ['bash [!]x].sh', 'bash [^]x].sh', 'bash []x].sh', 'bash [!]].sh', 'bash [a-c].sh', 'bash [!x].sh', 'source [!]x].sh', 'node [!]x].mjs']) {
    if (c.startsWith('node')) denyBoth(c, { 'a.mjs': 'bad' });
    else denyBoth(c, spec);
  }
  // a [ that is never closed is an ordinary character, and a ] is never a member outside a bracket
  denyBoth('bash f[.sh', { 'f[.sh': 'bad' });
  denyBoth('bash [!].sh', { '[!].sh': 'bad' });
  denyBoth('bash a].sh', { 'a].sh': 'bad' });
  allowBoth('bash [!]x', { 'ok.sh': 'ok' });
});

test('G3: a directory that cannot be listed for another reason than "it is not there" is refused', () => {
  const spec = { 'ok.sh': 'ok' };
  for (const c of ['bash *.sh', 'bash sub/*.sh', 'bash [o]k.sh']) {
    const r = both(c, spec, { gitOpts: { readDir: () => false }, filesOpts: { readDir: () => false } });
    assert.equal(r.git.decision, 'deny', `git: ${c}`);
    assert.equal(r.files.decision, 'deny', `files: ${c}`);
  }
  // a missing or unreadable (EACCES) directory matches nothing in the shell either
  const none = { readDir: () => null };
  assert.equal(both('bash *.sh', spec, { gitOpts: none, filesOpts: none }).git.decision, 'allow');
  assert.equal(both('bash *.sh', spec, { gitOpts: none, filesOpts: none }).files.decision, 'allow');
  // an unreadable directory is no directory: a candidate that is one is read (and denied) as before
  assert.equal(defaultReadDir(join(tmpdir(), 'no-such-dir-g3')), null); // ENOENT
  assert.equal(defaultReadDir(fileURLToPath(import.meta.url)), null); // ENOTDIR
  assert.equal(defaultReadDir(join(tmpdir(), 'x'.repeat(300))), false); // ENAMETOOLONG
  assert.ok(Array.isArray(defaultReadDir(dirname(fileURLToPath(import.meta.url)))));
});

// ---- round 4: backslash in a program path; a ] that was escaped or quoted inside a bracket --------------------------

test('G4: a backslash is an ordinary file name character: a program path holding one is judged', () => {
  const spec = { 'a\\b.sh': 'bad', 'ok.sh': 'ok' };
  for (const c of ["'./a\\b.sh'", './a\\\\b.sh', './a\\\\b.s*', "X=./a; $X'\\b.sh'", "D=.; $D/'a\\b.sh'", "bash 'a\\b.sh'", "source a\\\\b.sh"]) denyBoth(c, spec);
  allowBoth("'./c\\d.sh'", spec); // missing: nothing runs
  assert.deepEqual(scriptFileOf(['./a\\b.sh'], "'./a\\b.sh'"), { kind: 'exec', file: './a\\b.sh' });
  assert.equal(scriptFileOf(['$X\\b.sh'], '$X\\\\b.sh').ambiguous, true);
});

test('G5: a ] that was escaped or quoted inside a bracket reaches the guard as a plain ]: every close is tried', () => {
  const spec = { 'q.sh': 'bad', 'ok.sh': 'ok' };
  for (const c of ['bash [q\\]x].sh', 'bash [q"]"x].sh', "bash [q']'x].sh", './[q\\]x].sh', 'source [q\\]x].sh', 'bash sub/../[q\\]x].sh']) denyBoth(c, spec);
  // the reading with a literal [ (an escaped one) is matched too, and so is the POSIX reading
  denyBoth('bash \\[q].sh', { '[q].sh': 'bad' });
  denyBoth('bash \\[q]*.sh', { '[q]x.sh': 'bad' });
  denyBoth('bash [!]x].sh', { 'a.sh': 'bad' });
  denyBoth('bash [!]x]*', { 'a.sh': 'bad' });
  denyBoth('bash [a]x]*.sh', { 'ax]y.sh': 'bad' });
  allowBoth('bash [q\\]x].sh', { 'ok.sh': 'ok', 'qq.sh': 'bad' }); // no name has the shape of any reading
});

test('G5: many brackets in one segment stay cheap and fail closed', () => {
  const seg = '[a]b]'.repeat(30);
  const t0 = Date.now();
  denyBoth(`bash ${seg}.sh`, { [`${'x'.repeat(30)}.sh`]: 'bad' }); // matched through the 30 "one char" readings
  allowBoth(`bash ${seg}.sh`, { 'zz.sh': 'ok', [`${'x'.repeat(31)}.sh`]: 'ok' });
  const names = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`${'a'.repeat(40)}${i}.sh`, 'ok']));
  allowBoth(`bash ${'[a]*]'.repeat(30)}z.sh`, names);
  assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0} ms`);
});
