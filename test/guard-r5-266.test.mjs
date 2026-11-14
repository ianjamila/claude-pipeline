// PR #266 round 5: two bug CLASSES, closed fail-closed (rounds 1-4 kept finding one more spelling of each).
//   CLASS A  a command is no read-only call when ANY of its words, env values, redirect targets (here-string, `<`, `>`) or the heredoc bodies of its line holds an assigning expansion
//            (`${y=w}`, `${y:=w}`, `${y::=w}`, with any prefix or flag group before the name) whose default word is not plain path characters: the value it plants in y is read as arithmetic by a later
//            `printf '%d' y`. R5-B1 the zero-colon `=` form, R5-F1 a default produced at run time, R5-F2 prefixes (`=` `~` `^`, flags, a flag that holds `)`), R5-F3 here-string / `<` / heredoc.
//            Probed with zsh 5.9: `${=y:=w}`, `${(L)=y:=w}`, `${(j:):)y:=w}`, `${y=w}`, `${^y:=w}`, `${~y:=w}` all assign; a here-string or `<` word and a heredoc body assign in the current
//            shell for a builtin (for an external command the forked child assigns, so only the builtin persists).
//   CLASS B  R5-F4: a double-quoted `"${(@f)$(cmd)}"`, `"$@"`, `"${arr[@]}"` still splits into several words (so no position can be trusted), as do `$=x`, `$~x`, `$^x`, `$+x`.
//            Probed with zsh 5.9: `test "${(@f)$(cat f)}"` hands test the two words `-v` and `zz[$(…)]` and runs the substitution; `test "$@"` and `test "${arr[@]}"` do the same.
// Home is /home/u and the filesystem is faked. Protected paths are built from parts so this file does not spell them either.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateBashForFiles } from '../pipeline/hooks/lib/files-policy.mjs';

const PROJ = '/home/u/proj';
const CFG = ['~', '.claude'].join('/');
const S = `${CFG}/settings.json`; // a protected file
const files = { '/home/u/proj/data.txt': 'x\n', '/home/u/proj/a.txt': 'x\n' };
const BASE = { home: '/home/u', env: {}, platform: 'linux', realpath: (p) => p, existsSync: (p) => p in files, readText: (p) => (typeof files[p] === 'string' ? files[p] : null) };
const run = (command, extra = {}) => evaluateBashForFiles(command, { ...BASE, cwd: PROJ, ...extra });
const D = '$';
const OB = D + '{'; // a parameter-expansion opener
const BSL = '\\';
const DEF = `path[${BSL}${D}(rm ${S})]`; // a default word that holds a subscript evaluation
const BR = `$(printf 'path${BSL}x5b'; echo '${D}(rm ${S})]')`; // a word whose `[` and subscript are both produced at run time
const P = `$(printf -- '-v\\npath${BSL}x5b'; echo '${D}(rm ${S})]')`; // prints an operator and a subscript operand on two lines

const DENY = [
  // R5-B1: the zero-colon form, double-quoted
  ['B1 double-quoted zero-colon =', `echo "${OB}y=${DEF}}"; printf '%d' y`],
  ['B1 via a variable name for the file', `T=${S}; echo "${OB}y=path[${BSL}${D}(rm "$T")]}"; printf '%d' y`],
  // R5-F1: the bracket is produced at run time inside the default
  ['F1 run-time bracket in a := default', `echo "${OB}y:=${BR}}"; printf '%d' y`],
  ['F1 run-time bracket in a = default', `echo "${OB}y=${BR}}"; printf '%d' y`],
  ['F1 unquoted run-time default', `echo ${OB}y:=${BR}}; printf '%d' y`],
  ['F1 a quote break between $ and (', `echo "${OB}y:=path[${D}''(rm ${S})]}"; printf '%d' y`],
  // R5-F2: prefixes and flag groups before the name
  ['F2 = prefix', `echo "${OB}=y:=${DEF}}"; printf '%d' y`],
  ['F2 ~ prefix', `echo "${OB}~y:=${DEF}}"; printf '%d' y`],
  ['F2 ^ prefix', `echo "${OB}^y:=${DEF}}"; printf '%d' y`],
  ['F2 doubled ^ prefix', `echo "${OB}^^y:=${DEF}}"; printf '%d' y`],
  ['F2 flag and = prefix', `echo "${OB}(L)=y:=${DEF}}"; printf '%d' y`],
  ['F2 flag group that holds )', `echo "${OB}(j:):)y:=${DEF}}"; printf '%d' y`],
  ['F2 zero-colon with = prefix', `echo "${OB}=y=${DEF}}"; printf '%d' y`],
  ['F2 subscripted name', `echo "${OB}y[1]:=${DEF}}"; printf '%d' y`],
  // R5-F3: the expansion sits in a redirect word or a heredoc body
  ['F3 here-string', `echo x <<< "${OB}y:=${DEF}}"; printf '%d' y`],
  ['F3 here-string, test builtin', `test -n x <<< "${OB}y:=${DEF}}"; printf '%d' y`],
  ['F3 < redirect', `echo x < "${OB}y:=${DEF}}"; printf '%d' y`],
  ['F3 > redirect target', `echo x > "${OB}y:=${DEF}}"; printf '%d' y`],
  ['F3 unquoted heredoc body', `cat <<EOF\n${OB}y:=${DEF}}\nEOF\nprintf '%d' y`],
  ['F3 unquoted heredoc body, builtin reader', `: <<EOF\n${OB}y:=${DEF}}\nEOF\nprintf '%d' y`],
  ['F3 quoted heredoc body (refused too: fail closed)', `cat <<'EOF'\n${OB}y:=${DEF}}\nEOF\nprintf '%d' y`],
  ['F3 heredoc body with a run-time default', `cat <<EOF\n${OB}y:=${BR}}\nEOF\nprintf '%d' y`],
  // R5-F4: words that split inside double quotes (the file is named in the test command so it is judged)
  ['F4 test "${(@f)$(P)}"', `test "${OB}(@f)${P}}"`],
  ['F4 test -n "${(@f)$(P)}"', `test -n "${OB}(@f)${P}}"`],
  ['F4 [ x = "${(@s:,:)$(P)}" ]', `[ x = "${OB}(@s:,:)${P}}" ]`],
  ['F4 test "$@" with the file as an operand', `test "${D}@" -a -r ${S}`],
  ['F4 [ "$@" = file ]', `[ "${D}@" = ${S} ]`],
  ['F4 [ "$*" = file ]', `[ "${D}*" = ${S} ]`],
  ['F4 [ "${arr[@]}" = file ]', `[ "${OB}arr[@]}" = ${S} ]`],
  ['F4 [ "${arr[*]}" = file ]', `[ "${OB}arr[*]}" = ${S} ]`],
  ['F4 [ "${@}" = file ]', `[ "${OB}@}" = ${S} ]`],
  ['F4 [ $=x = file ]', `[ ${D}=x = ${S} ]`],
  ['F4 [ $~x = file ]', `[ ${D}~x = ${S} ]`],
  ['F4 [ $^x = file ]', `[ ${D}^x = ${S} ]`],
  ['F4 [ $+x = file ]', `[ ${D}+x = ${S} ]`],
  ['F4 test $=x beside the file', `test ${D}=x ${S}`],
  ['F4 test with a flag expansion that is no command substitution', `test "${OB}(@)arr}" ${S}`],
];
for (const [label, line] of DENY) {
  test(`#266 R5 denies: ${label}`, () => {
    const r = run(line);
    assert.equal(r.decision, 'deny', `${line} -> ${r.decision}`);
  });
}

const ALLOW = [
  ['[ = a command substitution, a name on the left', `[ "$a" = "$(cat ${S})" ]`],
  ['[ -n of a command substitution', `[ -n "$(cat ${S})" ]`],
  ['printf of a command substitution', `printf '%s\\n' "$(cat ${S})"`],
  ['echo of a default that assigns a plain path, then echo', `echo ${OB}X:=./f.sh}; echo ${D}X`],
  ['echo of a default that assigns a plain word (zero colon), then echo', `echo "${OB}X=plain-word_1}"; echo ${D}X`],
  ['cat of the file', `cat ${S}`],
];
for (const [label, line] of ALLOW) {
  test(`#266 R5 still allows: ${label}`, () => {
    const r = run(line);
    assert.equal(r.decision, 'allow', `${line} -> ${r.decision}: ${r.reason}`);
  });
}
