// Why (PR A2, batch S5d): the replays passed `env: {}` but the real hook passes process.env (HOME, ZDOTDIR ...). With them the hook's own home
// startup files became explicit "followed" files: a missing $HOME/.zshenv counted as possibly written by the script's unknown `> "$out"`, which made
// every name unknown and refused the real SDD helper scripts. Each test pins the workflow that must pass next to its nearest dangerous twin.
// Fake file system like guard-a2-shell-s5c.test.mjs; guarded text only lives in fake file contents or command strings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname, basename } from 'node:path';
import { evaluateGitCommand } from '../pipeline/hooks/lib/git-policy.mjs';
import { evaluateBashForFiles } from '../pipeline/hooks/lib/files-policy.mjs';
import { simpleCommands } from '../pipeline/hooks/lib/shell-parse.mjs';

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
const BAD_GIT = 'git push origin main';
const BAD_WRITE = 'echo x > /home/u/.claude/settings.json';
// the hook's real environment: HOME (and ZDOTDIR) are always present
const REAL_ENV = { HOME: '/home/u', ZDOTDIR: '/home/u' };

// `spec`: name -> 'bad' | 'ok' | text, written into both fake file systems (git: under /work/repo, files: under /home/u/proj)
const DIRS = ['sub', '/home/u'];
function both(command, spec, o = {}) {
  const mk = (bad, ok) => Object.fromEntries(Object.entries(spec).map(([k, v]) => [k, v === 'bad' ? bad : v === 'ok' ? ok : v]));
  return {
    git: git(command, fakeFs(GIT_ROOT, mk(BAD_GIT, 'git status'), DIRS), o),
    files: files(command, fakeFs(PROJ, mk(BAD_WRITE, 'echo hi'), DIRS), o),
  };
}
const allowBoth = (command, spec, o) => {
  const r = both(command, spec, o);
  assert.equal(r.git.decision, 'allow', `git: ${command} -> ${r.git.reason}`);
  assert.equal(r.files.decision, 'allow', `files: ${command} -> ${r.files.reason}`);
};
const denyBoth = (command, spec, o) => {
  const r = both(command, spec, o);
  assert.equal(r.git.decision, 'deny', `git: ${command} -> ${r.git.reason}`);
  assert.equal(r.files.decision, 'deny', `files: ${command} -> ${r.files.reason}`);
};

// ---- 1: HOME / ZDOTDIR in the hook's environment --------------------------------------------------------------------------------------------------------------

// the shape of superpowers' task-brief: a helper run through `"${BASH:-bash}"`, its answer used to build a name, and a redirect to that name
const HELPER = '/home/u/proj/scripts/sdd-workspace';
const BRIEF = (helper = HELPER) => [
  '#!/usr/bin/env bash',
  'set -euo pipefail',
  'plan=$1',
  'n=$2',
  'if [ $# -eq 3 ]; then',
  '  out=$3',
  'else',
  `  dir=$("\${BASH:-bash}" ${helper} "$plan")`,
  '  out="$dir/task-${n}-brief.md"',
  'fi',
  "awk -v n=\"$n\" '$0 ~ (\"^## Task \" n) { print }' \"$plan\" > \"$out\"",
  'echo "wrote ${out}"',
  '',
].join('\n');

const filesDecision = (command, spec, o) => files(command, fakeFs(PROJ, spec, DIRS), o);
const ENVS = [{}, { HOME: '/home/u' }, REAL_ENV];

test('S5d 1: a script that runs a helper through ${BASH:-bash} and redirects to a name built from its answer is allowed with HOME / ZDOTDIR in the hook environment', () => {
  const spec = { 'scripts/task-brief': BRIEF(), 'scripts/sdd-workspace': 'echo hi' };
  for (const env of ENVS) {
    for (const cmd of ['bash scripts/task-brief plan.md 1', 'bash /home/u/proj/scripts/task-brief plan.md 1']) {
      const d = filesDecision(cmd, spec, { env });
      assert.equal(d.decision, 'allow', `${JSON.stringify(env)} ${cmd} -> ${d.reason}`);
    }
  }
});

test('S5d 1: ... and refused when the helper ${BASH:-bash} runs holds a guarded write (the word names bash, so its script operand is judged)', () => {
  const spec = { 'scripts/task-brief': BRIEF(), 'scripts/sdd-workspace': BAD_WRITE };
  for (const env of ENVS) {
    const d = filesDecision('bash scripts/task-brief plan.md 1', spec, { env });
    assert.equal(d.decision, 'deny', JSON.stringify(env));
  }
  // (and for the other spellings of the word)
  for (const w of ['$BASH', '"$BASH"', '${BASH}', '${BASH:-sh}', '${BASH-bash}']) {
    const d = filesDecision('bash /home/u/proj/scripts/t', { 'scripts/t': `${w} ${HELPER} x\n`, 'scripts/sdd-workspace': BAD_WRITE }, { env: REAL_ENV });
    assert.equal(d.decision, 'deny', w);
  }
});

// the commands of `text` that run h.sh: [the head words]
const heads = (text, o = { env: {} }) => simpleCommands(text, o).filter((c) => c.argv.includes('h.sh')).map((c) => c.argv[0]);
const DYN = '${BASH:-bash}';

test('S5d 1: ... the default word is read as bash only while nothing can bind the name BASH; otherwise the head stays run-time AND a bash reading is added', () => {
  assert.deepEqual(heads(`"${DYN}" h.sh`), ['bash']);
  assert.deepEqual(heads(`echo $BASH_SOURCE; "${DYN}" h.sh`), ['bash']);
  assert.deepEqual(heads(`"\${BASH-bash}" h.sh`), ['bash']);
  // the other spellings are never replaced: the run-time head stays, a bash (and an sh) reading is judged next to it
  for (const w of ['$BASH', '"$BASH"', '${BASH}', '${BASH:-sh}', '${BASH-sh}']) {
    const h = heads(`${w} h.sh`);
    assert.ok(h.includes('bash') && h.some((x) => x !== 'bash'), `${w} -> ${JSON.stringify(h)}`);
  }
  // an environment that names BASH (zsh does not reset it)
  const h = heads(`"${DYN}" h.sh`, { env: { BASH: '/usr/bin/python3' } });
  assert.ok(h.includes('bash') && h.includes(DYN), JSON.stringify(h));
});

test('S5d 1: ... every way to bind BASH (literal, quoted apart, constructed, indirect, sourced) keeps the run-time head and adds the bash reading', () => {
  const BINDS = [
    'BASH=/usr/bin/python3', 'declare BASH=x', 'declare -g BASH=x', 'typeset BASH=x', 'local BASH=x', 'export BASH=x', 'readonly BASH=x', 'read BASH', 'read -r BASH',
    'printf -v BASH %s x', 'mapfile BASH < f', 'readarray -t BASH < f', 'BASH+=x', 'BASH=x true', 'for BASH in a; do :; done', 'unset BASH', 'declare -n r=BASH',
    'echo ${BASH:=x}', 'echo ${BASH::=x}', 'select BASH in a; do :; done', 'vared BASH', 'print -v BASH x', 'zparseopts -D -E -A BASH', 'getopts a BASH', '(( BASH = 1 ))', 'let BASH=1',
    // a name spelled in pieces
    'read B""ASH', 'read BA\\SH', "read B'A'SH", 'declare B"A"SH=x', 'read $\'\\x42ASH\'', 'read BA{SH,}',
    'n=BA; declare "${n}SH=x"', 'n=BASH; read "$n"', 'v=BASH; printf -v "$v" x', 'v=BASH; read -r "$v"', 'n=BASH; export $n=x', 'n=BASH; typeset -g "$n"=x', 'n=BASH; (( $n = 1 ))',
    'n=BASH; let "$n=1"', 'n=BA; (( ${n}SH = 1 ))', "n=$'\\x42ASH'; (( $n = 1 ))", 'n=BASH; mapfile "$n" < f', 'n=BASH; declare -n r=$n; r=x', 'eval "BA""SH=x"', 'eval "$s"', 'source rc', '. ./rc', 'if true; then . rc; fi', 'builtin source rc',
    'f() { read "$1"; }; f BASH', 'coproc B""ASH { :; }', "n=$'\\x42ASH'; declare -n r=$n; r=x", 'getopts ab "$n"',
  ];
  for (const bind of BINDS) {
    const h = heads(`${bind}\n"${DYN}" h.sh\n`);
    assert.ok(h.includes('bash') && h.includes(DYN), `${bind} -> ${JSON.stringify(h)}`);
  }
  // (the same line without the binder keeps the replacement; plain names that are not BASH do not count)
  for (const calm of ['set -euo pipefail', 'plan=$1', 'BASHER=1', 'echo $BASH_VERSION', 'local out="$dir/x"', 'read -r line < "$f"', 'export PATH="$PATH:/x"', 'if (( n == 1 )); then :; fi']) {
    assert.deepEqual(heads(`${calm}\n"${DYN}" h.sh\n`), ['bash'], calm);
  }
});

test('S5d 1: ... a script that binds BASH to another program is judged as if its helper were a bash script', () => {
  for (const bind of ['BASH=zsh', 'n=BA; declare "${n}SH=sh"', 'eval "BA""SH=sh"', 'read -r "$v"', 'source rc']) {
    const spec = { 'scripts/t': `${bind}\n"${DYN}" ${HELPER} x\n`, 'scripts/sdd-workspace': BAD_WRITE };
    for (const env of ENVS) assert.equal(filesDecision('bash scripts/t', spec, { env }).decision, 'deny', `${bind} ${JSON.stringify(env)}`);
  }
});

test('S5d 1: a bash named through BASH reads BASH_ENV like bash does', () => {
  const spec = { rc: 'bad', 'x.sh': 'ok' };
  denyBoth('BASH_ENV=rc "${BASH:-bash}" x.sh', spec);
});

test('S5d 1: ... both policies judge the helper of a ${BASH:-bash} head: allowed when harmless, refused when guarded, also when the environment names BASH or the script binds it', () => {
  const run = (bind) => `${bind}"\${BASH:-bash}" h.sh\n`;
  allowBoth('bash t.sh', { 't.sh': run(''), 'h.sh': 'ok' });
  denyBoth('bash t.sh', { 't.sh': run(''), 'h.sh': 'bad' });
  denyBoth('bash t.sh', { 't.sh': run('n=BA; declare "${n}SH=sh"\n'), 'h.sh': 'bad' });
  denyBoth('bash t.sh', { 't.sh': run('BASH=zsh\n'), 'h.sh': 'bad' });
  assert.equal(filesDecision('bash t.sh', { 't.sh': run(''), 'h.sh': BAD_WRITE }, { env: { ...REAL_ENV, BASH: '/usr/bin/zsh' } }).decision, 'deny');
});

test('S5d 1: a head that is a real run-time unknown ($TOOL) in the same script stays refused with HOME / ZDOTDIR in the environment (only the BASH default is believed)', () => {
  const spec = { 'scripts/task-brief': BRIEF().replace('"${BASH:-bash}"', '"$TOOL"'), 'scripts/sdd-workspace': 'echo hi' };
  const d = filesDecision('bash scripts/task-brief plan.md 1', spec, { env: REAL_ENV });
  assert.equal(d.decision, 'deny', d.reason);
});
