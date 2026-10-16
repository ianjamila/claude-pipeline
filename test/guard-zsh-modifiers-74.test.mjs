// Why (issue #74): the hook does not know the shell, and on this Mac it is zsh. zsh applies to an UNBRACED `$NAME` a modifier after `:` (`$B:r` drops the
// extension, `:h :t :e :a :l :u :q :Q :P :s/…/…/ :gs… :&`, and the prefixes `:f :F :w :W :g`) and a subscript after `[` (`$B[1,6]` is characters 1 to 6).
// The guards expanded `$B` and kept the rest as text, so they judged a different word from the one the shell runs (probed with zsh 5.9):
//   B=run.sh.x; bash $B:r          runs run.sh        B=run.shXY; bash $B[1,6]       runs run.sh        B=run.sh.x; F=$B:r; bash $F     runs run.sh
//   B=main.x; git push origin $B:r pushes main        B=settings.json.x; cp x ~/.claude/$B:r      writes the protected file
// Such a reference is now a value only known at run time (left as written, like a variable assigned twice). A BRACED `${B}:r` is not a modifier in zsh
// (it is the value and the text `:r`), so it still expands. The harmless shapes (`$HOST:$PORT`, `HEAD:$B`, `echo $X:done`, `http://$H:8080/`) stay allowed
// because `:` is followed by no modifier letter. The file system is faked; guarded text only lives in fake file contents.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname, basename } from 'node:path';
import { evaluateGitCommand } from '../pipeline/hooks/lib/git-policy.mjs';
import { evaluateBashForFiles } from '../pipeline/hooks/lib/files-policy.mjs';

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
const DIRS = ['sub', 'src', 'd', 'x'];
function both(command, spec = {}) {
  const mk = (bad, ok) => Object.fromEntries(Object.entries(spec).map(([k, v]) => [k, v === 'bad' ? bad : v === 'ok' ? ok : v]));
  return {
    git: git(command, fakeFs(GIT_ROOT, mk(BAD_GIT, 'git status'), DIRS)),
    files: files(command, fakeFs(PROJ, mk(BAD_FILES, 'echo hi'), DIRS)),
  };
}
const allowBoth = (command, spec) => {
  const r = both(command, spec);
  assert.equal(r.git.decision, 'allow', `git: ${command} -> ${r.git.reason}`);
  assert.equal(r.files.decision, 'allow', `files: ${command} -> ${r.files.reason}`);
};
const denyBoth = (command, spec) => {
  const r = both(command, spec);
  assert.equal(r.git.decision, 'deny', `git: ${command} -> allowed`);
  assert.equal(r.files.decision, 'deny', `files: ${command} -> allowed`);
};
const denyGit = (command, spec) => assert.equal(both(command, spec).git.decision, 'deny', `git: ${command} -> allowed`);
const allowGit = (command, spec) => {
  const r = both(command, spec).git;
  assert.equal(r.decision, 'allow', `git: ${command} -> ${r.reason}`);
};
const denyFiles = (command, spec) => assert.equal(both(command, spec).files.decision, 'deny', `files: ${command} -> allowed`);
const allowFiles = (command, spec) => {
  const r = both(command, spec).files;
  assert.equal(r.decision, 'allow', `files: ${command} -> ${r.reason}`);
};
const SPEC = { 'run.sh': 'bad', 'ok.sh': 'ok', 'x/run.sh': 'bad', 'src/a.ts': 'export const a = 1\n' };

// ---- the three shapes of the issue, and the other modifiers ---------------------------------------------------------------------

test('#74: a modifier or a subscript after an unbraced $NAME makes the script only known at run time (both guards)', () => {
  for (const cmd of [
    'B=run.sh.x; bash $B:r', // (the issue's first line)
    'B=run.shXY; bash $B[1,6]', // (second)
    'B=run.sh.x; F=$B:r; bash $F', // (third: through an intermediate variable)
    'B=run.sh.x; F=$B:r; bash "$F"',
    'B=run.sh.x; bash "$B:r"',
    'B=run.shXY; bash "$B[1,6]"',
    'B=run.shXY; F=$B[1,6]; bash $F',
    'B=run.sh.x; source $B:r',
    'B=run.sh.x; . $B:r',
    'B=x/run.sh; bash $B:t', // (tail: run.sh in the current directory)
    'B=RUN.SH; bash $B:l',
    'B=run.shX; bash $B:s/X//',
    'B=run.shX; bash $B:gs/X//',
    'B=run.sh.x; bash $B:r:r', // (modifiers chain)
    'B=run.sh.x; bash ./$B:r',
    'BB=run.sh.x; bash $BB:r', // (the name takes every letter that follows)
  ]) denyBoth(cmd, SPEC);
});

test('#74: every modifier letter zsh reads (and the f F w W g prefixes) is a run-time value; a letter it does not read is not', () => {
  for (const m of 'aAcefFghlPqQrstuwWx') denyBoth(`B=run.sh; bash $B:${m}`, SPEC);
  denyBoth('B=run.sh; bash "$B:&"', SPEC); // (`:&` repeats the last substitution; unquoted it would be a shell operator)
  // (not modifiers in zsh 5.9: the text stays after the value, a file that does not exist; the value is still worked out)
  for (const m of 'bdijkmnopvyzBCDEGHIJKLMNORSTUVXYZ0123456789.,/-=@%+_') allowBoth(`B=run.sh; bash $B:${m}x`, SPEC);
  denyBoth('B=run.sh; bash ${B}', SPEC); // (the value itself is what the allowed cases above prove is worked out)
});

// ---- the same in the files guard, and in the git guard on a push -----------------------------------------------------------------

test('#74 files guard: a protected file written through a modifier or subscript is refused', () => {
  for (const cmd of [
    'B=settings.json.x; cp x ~/.claude/$B:r',
    'B=settings.jsonXY; cp x ~/.claude/$B[1,13]',
    'B=settings.json.x; F=$B:r; cp x ~/.claude/$F',
    'B=settings.json.x; echo x > ~/.claude/$B:r',
    'B=settings.json.x; echo x > "$HOME/.claude/$B:r"',
    'B=settings.jsonXY; F=$B[1,13]; echo x > ~/.claude/$F',
    'B=SETTINGS.JSON; cp x ~/.claude/$B:l',
  ]) denyFiles(cmd, SPEC);
  // the value written out, and the braced form (which zsh does not read as a modifier: the file settings.json.x:r), are what the guard has always judged
  denyFiles('B=settings.json; cp x ~/.claude/$B', SPEC);
  allowFiles('B=settings.json.x; cp x ~/.claude/${B}:r', SPEC);
});

test('#74 git guard: a push through a modifier or subscript is not judged as pushing a known ref', () => {
  for (const cmd of [
    'B=main.x; git push origin $B:r', // (zsh: push origin main)
    'B=main.x; git push origin HEAD:$B:r', // (zsh: HEAD:main)
    'B=mainXY; git push origin HEAD:$B[1,4]',
    'B=mainXY; git push origin $B[1,4]',
    'B=main.x; F=$B:r; git push origin $F',
    'B=main.x; F=$B:r; git push origin HEAD:$F',
    'B=agent/x; git push origin $B:refs/heads/x', // (zsh reads `:r` + `efs/heads/x`)
    'B=agent/x; git push origin HEAD:$B:refs/heads/x',
    'B=main; git push origin $B:refs/heads/main',
  ]) denyGit(cmd, SPEC);
});

// ---- braced forms are not modifiers --------------------------------------------------------------------------------------------

test('#74: a braced ${NAME} is the value and then text, as in zsh, so it is worked out as before', () => {
  allowBoth('B=run.sh; bash ${B}:r', SPEC); // (the file `run.sh:r`: nothing there)
  allowBoth('B=run.sh; bash "${B}[1,6]"', SPEC); // (the file `run.sh[1,6]`)
  denyBoth('B=run.sh; bash ${B}', SPEC);
  denyBoth('B=run.sh; bash "${B}"', SPEC);
  allowGit('B=agent/x.y; git push origin HEAD:${B}:r', SPEC); // (zsh: the branch `agent/x.y:r`)
  denyGit('B=main; git push origin HEAD:${B}', SPEC);
});

// ---- the common harmless shapes stay allowed ---------------------------------------------------------------------------------------

test('#74: `:` followed by no modifier letter, or a name in the middle of a word, is worked out as before', () => {
  for (const cmd of [
    'HOST=h; PORT=8080; echo $HOST:$PORT',
    'H=example.com; curl -s http://$H:8080/ -o /dev/null',
    'H=example.com; P=1; curl -s http://$H:$P/health',
    'X=a; echo $X:done',
    'SRC=src; DST=d; echo $SRC:$DST',
    'B=src/a.ts; git show HEAD:$B',
    'B=src/a.ts; git diff HEAD:$B HEAD~1:$B',
    'B=src/a.ts; echo ${B}:ref',
    'P=/usr/bin; echo $P: $P:/x',
    'N=3; echo $N:$N',
    'B=ok.sh; bash $B',
    'B=ok.sh; bash ./$B',
  ]) allowBoth(cmd, SPEC);
  // a push to a branch through the usual spelling is still judged on its value
  allowGit('B=agent/x; git push origin HEAD:$B', SPEC);
  allowGit('B=agent/x; git push origin $B', SPEC);
  denyGit('B=main; git push origin HEAD:$B', SPEC);
  denyGit('B=main; git push origin $B', SPEC);
  denyGit('B=main; git push origin $B:main', SPEC);
});

// ---- loops, and a script the line runs that reads the name -------------------------------------------------------------------------

test('#74: the same through a loop variable, and in a script that reads a name the line gave it', () => {
  for (const cmd of [
    'for B in run.sh.x; do bash $B:r; done',
    'for B in run.shXY; do bash $B[1,6]; done',
    'for B in run.sh.x ok.sh; do bash "$B:r"; done',
  ]) denyBoth(cmd, SPEC);
  denyFiles('for B in settings.json.x; do cp x ~/.claude/$B:r; done', SPEC);
  const nested = { ...SPEC, 'r1.sh': 'bash $B:r\n', 'r2.sh': 'bash $B[1,6]\n', 'r3.sh': 'F=$B:r; bash $F\n' };
  for (const cmd of ['export B=run.sh.x; bash r1.sh', 'B=run.sh.x bash r1.sh', 'export B=run.shXY; bash r2.sh', 'export B=run.sh.x; bash r3.sh']) denyGit(cmd, nested);
  const nestedFiles = { ...SPEC, 'w1.sh': 'cp x ~/.claude/$B:r\n', 'w2.sh': 'cp x ~/.claude/$B[1,13]\n' };
  for (const cmd of ['export B=settings.json.x; bash w1.sh', 'B=settings.json.x bash w1.sh', 'export B=settings.jsonXY; bash w2.sh']) denyFiles(cmd, nestedFiles);
  // (a script that reads the name without a modifier, or a loop word that holds no modifier, is judged by the value as before)
  denyBoth('for B in run.sh; do bash $B; done', SPEC);
  allowBoth('for B in ok.sh; do bash $B; done', SPEC);
  allowGit('export B=ok.sh; bash r0.sh', { ...SPEC, 'r0.sh': 'bash $B\n' });
});

test('#74: a name a sourced file gave, read here with a modifier or subscript', () => {
  const src = { ...SPEC, 'e1.sh': 'B=run.sh.x\n', 'e2.sh': 'B=run.shXY\n', 'e3.sh': 'B=settings.json.x\n' };
  for (const cmd of ['. e1.sh; bash $B:r', 'source e1.sh; bash "$B:r"', 'source e2.sh; bash $B[1,6]']) denyGit(cmd, src);
  for (const cmd of ['. e3.sh; cp x ~/.claude/$B:r', 'source e3.sh; echo x > ~/.claude/$B:r']) denyFiles(cmd, src);
});

test('#74: a longer name is not read as a shorter one followed by text', () => {
  denyGit('B=main; git push origin HEAD:$BB:r', SPEC); // ($BB is another name, with a modifier: run time; not `$B` + `B:r`)
  denyGit('B=main; git push origin HEAD:$BB[1]', SPEC);
  allowGit('B=agent/x; git push origin HEAD:$B', SPEC);
});
