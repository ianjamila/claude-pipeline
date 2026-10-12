// Why (PR A2, batch S5c): the S5b replay still refused real workflows (zsh scripts that find their own directory with ${0:A:h}, a cd inside a subshell, relative files after a
// `cd X && ...; psql -f q.sql`). Each test pins the workflow that must pass next to its nearest dangerous twin that must stay refused. Fake file system like
// guard-a2-shell-s5b.test.mjs; guarded text only lives in fake file contents or command strings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname, basename } from 'node:path';
import { evaluateGitCommand } from '../pipeline/hooks/lib/git-policy.mjs';
import { evaluateBashForFiles } from '../pipeline/hooks/lib/files-policy.mjs';

function fakeFs(root, files, dirs = []) {
  const abs = (p) => resolve(root, p);
  const F = Object.fromEntries(Object.entries(files).map(([k, v]) => [abs(k), v]));
  const D = new Set([root, ...dirs.map(abs)].map((p) => resolve(p)));
  for (const p of Object.keys(F)) for (let d = dirname(p); dirname(d) !== d; d = dirname(d)) D.add(d);
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
const git = (command, fsOpts, o = {}) => evaluateGitCommand(command, {
  cwd: GIT_ROOT, home: '/home/u', currentBranch: () => 'agent/x', pushDestination: () => null, issueLabels: () => [], ...fsOpts, ...o,
});
const files = (command, fsOpts, o = {}) => evaluateBashForFiles(command, {
  home: '/home/u', env: {}, platform: 'linux', realpath: (p) => p, cwd: PROJ, ...fsOpts, existsSync: fsOpts.pathExists, ...o,
});
const DIRS = ['bin', 'sub', '/home/u', '/tmp'];
const BAD_WRITE = 'echo x > /home/u/.claude/settings.json';

// ---- 1: zsh script-directory modifiers ------------------------------------------------------------------------------------------------------------------------

const CC = '/home/u/cc';
const ccFs = (over = {}) => fakeFs(CC, {
  'scripts/restart.sh': '#!/bin/zsh\nHERE="${0:A:h}"\nDIR="${HERE:h}"\nsource "$HERE/lib.sh"\n"$HERE/build.sh" "$DIR"\n',
  'scripts/lib.sh': 'live_slot() { print -r -- ".next"; }\n',
  'scripts/build.sh': '#!/bin/zsh\necho built\n',
  ...over,
}, [...DIRS, CC, `${CC}/scripts`]);

// Why: `${0:A:h}` is the (symlink-resolved) directory of the zsh script itself; with it known, `source "$HERE/lib.sh"` is a file the guard can read, so the line's variables stay known.
test('S5c: a zsh script that sources a sibling by ${0:A:h} is judged (variables stay known)', () => {
  const fs = ccFs();
  for (const c of [`${CC}/scripts/restart.sh`, `cd ${CC} && scripts/restart.sh`, `cd ${CC} && zsh scripts/restart.sh`, `zsh ${CC}/scripts/restart.sh`]) {
    assert.equal(files(c, fs).decision, 'allow', c);
  }
});

test('S5c: the modifier forms ${0:a:h}, ${0:h} (absolute run), ${0:A:h:h} and ${${(%):-%x}:A:h} name the script directory', () => {
  const bodies = [
    'HERE="${0:a:h}"\nsource "$HERE/lib.sh"\n"$HERE/build.sh"', 'HERE="${0:h}"\nsource "$HERE/lib.sh"\n"$HERE/build.sh"', 'DIR="${0:A:h:h}"\nsource "$DIR/scripts/lib.sh"\n"$DIR/scripts/build.sh"',
    'source "${0:A:h}/lib.sh"\nHERE=/home/u/cc/scripts\n"$HERE/build.sh"', 'HERE="${${(%):-%x}:A:h}"\nsource "$HERE/lib.sh"\n"$HERE/build.sh"', 'HERE="${${(%):-%N}:A:h}"\nsource "$HERE/lib.sh"\n"$HERE/build.sh"',
  ];
  for (const b of bodies) {
    const ok = ccFs({ 'scripts/restart.sh': `#!/bin/zsh\n${b}\n` });
    assert.equal(files(`${CC}/scripts/restart.sh`, ok).decision, 'allow', b);
    // (the twin: what the sourced / run sibling does is judged, so the model really points at the sibling)
    assert.equal(files(`${CC}/scripts/restart.sh`, ccFs({ 'scripts/restart.sh': `#!/bin/zsh\n${b}\n`, 'scripts/build.sh': `#!/bin/zsh\n${BAD_WRITE}\n` })).decision, 'deny', `${b} (build.sh)`);
    assert.equal(files(`${CC}/scripts/restart.sh`, ccFs({ 'scripts/restart.sh': `#!/bin/zsh\n${b}\n`, 'scripts/lib.sh': `${BAD_WRITE}\n` })).decision, 'deny', `${b} (lib.sh)`);
  }
});

// Why: the model holds only when $0 is surely the script's own path; a name the script sets itself, code run by source / eval, a cd before a relative $0 or a file the shell is not zsh for moves it.
test('S5c: ${0:A:h} stays unknown when $0 may have changed, or the shell is not zsh', () => {
  const hereBuild = (pre) => ccFs({ 'scripts/restart.sh': `#!/bin/zsh\n${pre}\nHERE="\${0:A:h}"\nsource "$HERE/lib.sh"\n"$HERE/build.sh"\n` });
  assert.equal(files(`${CC}/scripts/restart.sh`, hereBuild('')).decision, 'allow');
  for (const pre of ['0=/home/u/.claude/pipeline/x', 'BASH_ARGV0=/home/u/.claude/pipeline/x', 'eval "$X"', 'source "$Y"']) {
    assert.equal(files(`${CC}/scripts/restart.sh`, hereBuild(pre)).decision, 'deny', pre);
  }
  // (a relative $0 is read from the cwd at expansion time: a cd before it moves it; an absolute one does not move)
  const afterCd = ccFs({ 'scripts/restart.sh': '#!/bin/zsh\ncd /tmp\nHERE="${0:A:h}"\nsource "$HERE/lib.sh"\n"$HERE/build.sh"\n' });
  assert.equal(files(`${CC}/scripts/restart.sh`, afterCd).decision, 'allow');
  assert.equal(files(`cd ${CC} && scripts/restart.sh`, afterCd).decision, 'deny');
  // (bash reads ${0:A:h} as a substring expansion, not a directory)
  assert.equal(files(`bash ${CC}/scripts/restart.sh`, ccFs()).decision, 'deny');
  assert.equal(files(`sh ${CC}/scripts/restart.sh`, ccFs()).decision, 'deny');
  // (a function body gets its own $0 in zsh: its name, not the script)
  const inFn = ccFs({ 'scripts/restart.sh': '#!/bin/zsh\nf() { HERE="${0:A:h}"; }\nf\nsource "$HERE/lib.sh"\n"$HERE/build.sh"\n' });
  assert.equal(files(`${CC}/scripts/restart.sh`, inFn).decision, 'deny');
  // (a sourced file's $0 is not the script's: only the judged script file has one)
  assert.equal(files(`source ${CC}/scripts/restart.sh`, ccFs()).decision, 'deny');
});

// Why: the sourced file runs in the script's shell: a name it sets is its value afterwards, and a sibling it names is judged where the modelled directory puts it.
test('S5c: a modelled sourced file still changes what the script sees (the twin of the modelled source)', () => {
  const lib = (t) => ccFs({ 'scripts/lib.sh': t });
  assert.equal(files(`${CC}/scripts/restart.sh`, ccFs({ 'scripts/lib.sh': 'HERE=/home/u/.claude/pipeline\n', '/home/u/.claude/pipeline/build.sh': BAD_WRITE })).decision, 'deny');
  assert.equal(files(`${CC}/scripts/restart.sh`, lib('. "$MISSING_TOOL"\n')).decision, 'deny'); // an unfollowable source inside it still poisons
});

// Why: HERE="${0:A:h}" and `${HERE:h}` are rewritten from literal values only when nothing on the script can rebind the name (read, mapfile, getopts, printf -v, unset, let, declare family, a loop,
// (( )), `${HERE:=x}`) or has run code (source / eval) since: otherwise the directory the next cd goes to is a run-time value, and a relative write after it is refused.
test('S5c: a script-directory name is believed only when nothing can rebind it', () => {
  const withBinder = (b) => ccFs({ 'scripts/restart.sh': `#!/bin/zsh\nHERE="\${0:A:h}"\n${b}\ncd "\${HERE:h}"\necho x > settings.json\n` });
  assert.equal(files(`${CC}/scripts/restart.sh`, withBinder(':')).decision, 'allow');
  assert.equal(files(`${CC}/scripts/restart.sh`, ccFs({ 'scripts/restart.sh': '#!/bin/zsh\nHERE="${0:A:h}"\ncd "${HERE:h:h:h}"\necho x > settings.json\n' }, )).decision, 'allow'); // (a known directory, outside the protected ones)
  const binders = ['read HERE', 'read -r HERE', 'mapfile HERE', 'readarray -t HERE', 'getopts ab HERE', 'printf -v HERE x', 'unset HERE', 'let HERE+=1', 'declare HERE=$X', 'typeset -g HERE=$X', 'local HERE=$X',
    'export HERE=$X', 'for HERE in $X; do :; done', 'select HERE in $X; do break; done', ': ${HERE:=$X}', '(( HERE = 1 ))', 'source "$X"', 'eval "$X"'];
  for (const b of binders) assert.equal(files(`${CC}/scripts/restart.sh`, withBinder(b)).decision, 'deny', b);
  // (the same for the name a modifier builds)
  const dirBinder = (b) => ccFs({ 'scripts/restart.sh': `#!/bin/zsh\nHERE="\${0:A:h}"\nDIR="\${HERE:h}"\n${b}\ncd "$DIR"\necho x > settings.json\n` });
  assert.equal(files(`${CC}/scripts/restart.sh`, dirBinder(':')).decision, 'allow');
  for (const b of ['read DIR', 'mapfile DIR', 'printf -v DIR x', 'unset DIR', 'for DIR in $X; do :; done']) assert.equal(files(`${CC}/scripts/restart.sh`, dirBinder(b)).decision, 'deny', b);
});

// Why: zsh gives $0 another value inside a function (its name), anonymous `() { }` and `function { }` ones included: a self-directory word in any function body stays a run-time value.
test('S5c: a self-directory word inside a function (named or anonymous) is not modelled', () => {
  const body = (b) => ccFs({ 'scripts/restart.sh': `#!/bin/zsh\n${b}\ncd "$HERE"\necho x > settings.json\n` });
  assert.equal(files(`${CC}/scripts/restart.sh`, body('HERE="${0:A:h}"')).decision, 'allow');
  for (const b of ['() { HERE="${0:A:h}"; }', 'function { HERE="${0:A:h}"; }', 'f() { HERE="${0:A:h}"; }; f', 'function f { HERE="${0:A:h}"; }; f', 'function f() ( HERE="${0:A:h}" ); f', 'HERE=$(); HERE="${0:A:h}"']) {
    assert.equal(files(`${CC}/scripts/restart.sh`, body(b)).decision, 'deny', b);
  }
});

// Why: observable form of the $0 rules: `cd "${0:A:h}"` is a known directory only while $0 is surely the script's own path; otherwise the relative write after it is refused.
test('S5c: $0 rules seen through a cd (assigned $0, code run before, relative :h, a literal name that may be rebound)', () => {
  const cdWrite = (pre, word = '${0:A:h}') => ccFs({ 'scripts/restart.sh': `#!/bin/zsh\n${pre}\ncd "${word}"\necho x > settings.json\n` });
  const run = `${CC}/scripts/restart.sh`;
  assert.equal(files(run, cdWrite(':')).decision, 'allow');
  for (const pre of ['0=/home/u/other', 'BASH_ARGV0=/home/u/other', 'typeset 0=/home/u/other', 'source /home/u/cc/scripts/lib.sh', '. /home/u/cc/scripts/lib.sh', 'eval true']) {
    assert.equal(files(run, cdWrite(pre)).decision, 'deny', pre);
  }
  // (`${0:h}` of a relative $0 is relative; only an absolute run makes it the script's directory)
  assert.equal(files(run, cdWrite(':', '${0:h}')).decision, 'allow');
  assert.equal(files(`cd ${CC} && scripts/restart.sh`, cdWrite(':', '${0:h}')).decision, 'deny');
  assert.equal(files(`cd ${CC} && scripts/restart.sh`, cdWrite(':', '${0:A:h}')).decision, 'allow');
  // (a name set to a literal directory and then read / looped over is no longer that directory)
  const lit = (pre) => ccFs({ 'scripts/restart.sh': `#!/bin/zsh\nHERE=/home/u/cc/scripts\n${pre}\ncd "\${HERE:h}"\necho x > settings.json\n` });
  assert.equal(files(run, lit(':')).decision, 'allow');
  for (const pre of ['read HERE', 'for HERE in $X; do :; done']) assert.equal(files(run, lit(pre)).decision, 'deny', pre);
});
