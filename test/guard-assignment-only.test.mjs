// #190 case 4: `T=<transcript>; wc -l "$T"` was refused ("(assignment) ... is not a read-only command"), although nothing on the line can write through $T.
// The refusal is lifted ONLY for a plain, non-exported `NAME=value` at the top level of the line where
//   (i)   NAME is not in the hook's own environment and is no special name (PATH, TMPDIR, TMPPREFIX, IFS, GIT_*, NODE_* ...),
//   (ii)  the value, after expansion, is ONE path-shaped token (starts with / ~ or ., no leading -, no =, no space, no glob, no $( or backtick),
//   (iii) the line has no export / declare -x / typeset / set -a / setopt / function / alias / eval / trap / source / `.`,
//   (iv)  every other command is an env-inert reader (cat head tail wc ls stat grep cut echo printf test [ shasum cmp),
// and never inside a recursive evaluation (a sourced or startup file, a script run by path, a `bash -c` string). Later uses stay judged: the
// redirect and writer rules expand the name. The guard stays strict: no comment or literal exemption (PR #162 was refused for that).
// Home is /home/u and the filesystem is faked. Protected paths are built from parts so this file does not spell them either.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateBashForFiles } from '../pipeline/hooks/lib/files-policy.mjs';

const PROJ = '/home/u/proj';
const CFG = ['~', '.claude'].join('/');
const S = `${CFG}/settings.json`; // a protected file
const TR = `${CFG}/projects/x/s.jsonl`; // a transcript
const CLI = `${CFG}/pipeline/bin/pipeline.mjs`; // the trusted pipeline CLI
const files = {};
const BASE = { home: '/home/u', env: {}, platform: 'linux', realpath: (p) => p, existsSync: (p) => p in files, readText: (p) => (typeof files[p] === 'string' ? files[p] : null) };
const run = (command, extra = {}) => evaluateBashForFiles(command, { ...BASE, cwd: PROJ, ...extra });

const ALLOW = [
  ['wc a transcript through a variable', `T=${CFG}/projects/x.jsonl; wc -l "$T"`],
  ['cat a transcript through a variable', `T=${TR}; cat "$T"`],
  ['a path assignment, then an unrelated echo', `T=${TR}; echo done`],
  ['an absolute path', `T=/home/u/.claude/projects/x/s.jsonl; head -3 "$T"`],
  ['a $HOME path', `T=$HOME/.claude/projects/x/s.jsonl; tail -5 "$T"`],
  ['two assignments and several readers', `A=${TR}; B=${CFG}/projects/y.jsonl; wc -l "$A" "$B"; grep -c x "$A"`],
  ['a reader in a test', `T=${TR}; test -f "$T" && echo yes`],
  ['a reader with a redirect to a plain file', `T=${TR}; cat "$T" > /tmp/copy.txt`],
  ['a reader piped to another reader', `T=${TR}; cat "$T" | wc -l`],
];
for (const [label, line] of ALLOW) {
  test(`T1.1 allows: ${label}`, () => {
    const r = run(line);
    assert.equal(r.decision, 'allow', `${line} -> ${r.decision}: ${r.reason}`);
  });
}

const FILES = { '/home/u/proj/values.sh': `export T=${S}\n` };
const DENY = [
  // export forms and every consumer that is no env-inert reader
  ['export, then a reader', `export T=${TR}; wc -l "$T"`],
  ['a redirect through the variable', `T=${S}; echo x > "$T"`],
  ['a program given the variable', `T=${TR}; node x.mjs "$T"`],
  ['export T=S; a program that reads its environment', `export T=${S}; node evil.mjs`],
  ['export after the assignment', `T=${S}; export T; node x.mjs`],
  ['declare -x', `declare -x T=${S}; python3 x.py`],
  ['set -a', `set -a; T=${S}; node x.mjs`],
  ['env at the end of a pipe', `T=${S}; env | cat`],
  ['a command substitution as the value', `T=$(cat ${S}); echo`],
  ['a command substitution that deletes', `T=$(rm ${S})`],
  ['a backtick substitution as the value', 'T=`cat ' + S + '`; echo'],
  ['a backtick substitution that deletes', 'T=`rm ' + S + '`'],
  ['a prefix assignment on a real command', `T=${S} bash -c 'echo x'`],
  // the value is not one path-shaped token (F1)
  ['an option as the value, sort -o', `O=-o${S}; sort $O p`],
  ['an option as the value, git --output', `O=--output=${S}; git diff $O`],
  ['an option as the value, find -delete', `D=-delete; find ${S} $D`],
  ['a sed program as the value', `W='w ${S}'; echo x | sed -n "$W"`],
  ['a value with a space', `T='${S} x'; cat "$T"`],
  ['a value with a glob', `T=${S}*; cat "$T"`],
  ['a value that is an array', `T=(${S} b); cat "\${T[@]}"`],
  // special names (F3)
  ['TMPDIR', `TMPDIR=${CFG}/pipeline-state/owner-go; sort big`],
  ['TMPPREFIX', `TMPPREFIX=${CFG}/pipeline-state/owner-go/x; cat <<< hi`],
  ['PATH with a protected directory', `PATH=${CFG}/pipeline:$PATH; cat x`],
  ['IFS', `IFS=/; T=${TR}; cat $T`],
  ['GIT_TRACE', `GIT_TRACE=${S}; git status`],
  ['LESSHISTFILE', `LESSHISTFILE=${S}; less x`],
  ['NODE_OPTIONS', `NODE_OPTIONS=${S}; node x.mjs`],
  ['a name the hook\'s environment already holds', `HOMEDIR2=${TR}; cat "$HOMEDIR2"`, { env: { HOMEDIR2: '/x' } }],
  // a sourced file, a startup file, a nested shell: the exemption is top-level only
  ['source, then a program', `source values.sh; node evil.mjs`],
  ['dot, then a program', `. values.sh; node evil.mjs`],
  ['BASH_ENV startup file', 'BASH_ENV=values.sh bash x.sh'],
  ['bash --rcfile', `bash --rcfile values.sh -c 'node evil.mjs'`],
  ['bash -c with an export', `bash -c 'export T=${S}; node evil.mjs'`],
  ['bash -c with a plain assignment and a program', `bash -c 'T=${S}; node evil.mjs'`],
  // a program, function, alias, eval or trap on the line
  ['a function on the line', `T=${TR}; f() { cat "$T"; }; f`],
  ['eval on the line', `T=${TR}; eval 'cat "$T"'`],
  ['trap on the line', `T=${TR}; trap 'cat "$T"' EXIT; cat x`],
  ['an alias on the line', `T=${TR}; alias c=cat; c "$T"`],
  ['a ${NAME:=word} default that assigns another name', `T=${TR}; echo \${TMPPREFIX:=${CFG}/pipeline-state/owner-go/x}; cat <<< hi`],
  ['an arithmetic expression on the line', `T=${TR}; echo $((1+1)); cat "$T"`],
  ['printf -v assigns a shell variable', `T=${TR}; printf -v TMPPREFIX ${CFG}/pipeline-state/owner-go/x; cat "$T"`],
  ['a second assignment whose value is an option', `T=${TR}; cat "$T"; X=-delete`],
  ['a command substitution that runs a program', `T=${TR}; echo $(node evil.mjs "$T")`],
  ['a process substitution that writes', `T=${S}; echo x > >(tee "$T")`],
  // cases 4 and 5 together: a program after the assignment keeps the refusal (the message suggests the literal path)
  ['the pipeline CLI and verify with the path in a variable', `T=${TR}; node ${CLI} cost "$T"; node scripts/verify.mjs --quick`],
];
for (const [label, line, extra] of DENY) {
  test(`T1.1 denies: ${label}`, () => {
    Object.assign(files, FILES);
    const r = run(line, extra);
    assert.equal(r.decision, 'deny', `${line} -> ${r.decision}`);
  });
}

test('T1.1: the refusal of the assignment-plus-program shape says to pass the path literally', () => {
  const r = run(`T=${TR}; node x.mjs "$T"`);
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /literally/);
});

test('T1.1: a plain assignment of a protected path is judged as before when a later use writes through it', () => {
  for (const line of [`T=${S}; echo x > "$T"`, `T=${S}; echo x >> "$T"`, `T=${S}; echo x | tee "$T"`, `T=${S}; cp /tmp/payload "$T"`]) {
    assert.equal(run(line).decision, 'deny', line);
  }
});
