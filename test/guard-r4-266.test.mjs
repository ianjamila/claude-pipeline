// PR #266 round 4:
//   R4-F1  test / [ with an operator only known at run time AND an operand whose `[` is also produced at run time stayed read-only (operatorUnknown needed a literal `[` in another word). The
//          operator is now read BY POSITION: 1 word = a literal word; 2 words = a literal unary operator that does not evaluate; 3 words = a literal binary operator that does not evaluate; any
//          other shape with a run-time word in it is no read-only call. Zsh 5.9: test with a run-time -v and an operand `path[` + `$(cmd)]` both printed at run time runs cmd; so does one unquoted
//          word that splits into `-v path[$(…)]`.
//   R4-F2  an assigning expansion inside a read-only command (an echo whose word holds a `y:=path[$(cmd)]` default) plants a subscript value that a later printf %d y / (( y )) / let y evaluates.
//          Probed with zsh 5.9: the `:=`, `::=`, `=` forms, a flag form (`(L)y:=`) and a single-quoted default word all run the substitution when the reader runs.
//          An echo of a plain-path default followed by echo $X stays allowed.
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
const SQ = "'";
const BSL = '\\';
// a word whose `[` and subscript are both produced at run time
const BR = `$(printf 'path${BSL}x5b'; echo '${D}(rm ${S})]')`;
const BRV = `$(printf 'path${BSL}x5b'; echo '${D}(rm "$T")]')`;
const PLANT = (op, quote) => `${OB}y${op}path[${quote === 'sq' ? SQ : BSL}${D}(rm ${S})${quote === 'sq' ? SQ : ''}]}`; // an assigning expansion whose default word holds a subscript

const DENY = [
  // R4-F1
  ['test: run-time operator and run-time operand, variable path', `T=${S}; test $(echo -v) "${BRV}"`],
  ['test: run-time operator and run-time operand (-t)', `test $(echo -t) "${BR}"`],
  ['[ : run-time operator and run-time operand', `[ $(echo -v) "${BR}" ]`],
  ['test: one unquoted word that splits into an operator and an operand', `test $(printf -- '-v path${BSL}x5b'; echo '${D}(rm${OB}IFS}${S})]')`],
  ['[ : run-time binary operator between two run-time words', `[ "${BR}" $(echo -eq) 1 ]`],
  ['test: literal operator that evaluates, run-time operand', `test -v "${BR}"`],
  ['test: three words, run-time middle operator beside a protected read', `test "$(cat ${S})" $(echo -eq) 1`],
  ['test: more words than any operator takes, one of them run-time', `test -n "$(cat ${S})" -a "${BR}"`],
  ['scanner spelling: run-time operator, an unresolved name and a protected read', `test $(echo -v) "$X" "$(cat ${S})"`],
  ['scanner spelling: run-time operator, an unresolved braced name and a protected read', `test $(echo -v) "${OB}X}" "$(cat ${S})"`],
  ['scanner spelling: [ with a run-time operator, an unresolved name and the protected file', `[ $(echo -v) "$X" ${S} ]`],
  ['an unquoted run-time operand that the shell splits into more words', `test -n $(printf 'x -a -v a${BSL}x5b'; echo '${D}(rm${OB}IFS}${S})]')`],
  ['an unquoted run-time right operand of a binary operator', `[ x = $(printf 'x -a -v a${BSL}x5b'; echo '${D}(rm${OB}IFS}${S})]') ]`],
  // R4-F2
  ['echo := then printf %d', `echo "${PLANT(':=')}"; printf '%d' y`],
  ['echo ::= then printf %d', `echo "${PLANT('::=')}"; printf '%d' y`],
  ['echo = then printf %d', `echo ${PLANT('=')}; printf '%d' y`],
  ['echo with a flag form then printf %d', `echo "${OB}(L)y:=path[${BSL}${D}(rm ${S})]}"; printf '%d' y`],
  ['echo := with a single-quoted default word then printf %d', `echo ${PLANT(':=', 'sq')}; printf '%d' y`],
  ['echo := then (( y ))', `echo "${PLANT(':=')}"; (( y ))`],
  ['echo := then let y', `echo "${PLANT(':=')}"; let y`],
  ['echo ::= then (( y ))', `echo "${PLANT('::=')}"; (( y ))`],
  ['cat with an assigning expansion that holds a subscript, then let y', `cat "${PLANT(':=')}"; let y`],
];
for (const [label, line] of DENY) {
  test(`#266 R4 denies: ${label}`, () => {
    const r = run(line);
    assert.equal(r.decision, 'deny', `${line} -> ${r.decision}`);
  });
}

const ALLOW = [
  ['[ = a command substitution, a name on the left', `[ "$a" = "$(cat ${S})" ]`],
  ['[ -n of a command substitution', `[ -n "$(cat ${S})" ]`],
  ['[ = between two command substitutions', `[ "$(cat a.txt)" = "$(jq -r '.x' ${S})" ]`],
  ['test = between two command substitutions', `test "$(cat a.txt)" = "$(jq -r '.x' ${S})"`],
  ['[ != of a command substitution', `[ "$(cat ${S})" != x ]`],
  ['test -f of a plain name', 'test -f data.txt'],
  ['[ ! -z of a command substitution', `[ ! -z "$(cat ${S})" ]`],
  ['[ -gt of a counted command substitution', `[ "$(wc -l < data.txt)" -gt 0 ]`],
  ['echo of a default that assigns a plain path, then echo', `echo ${OB}X:=./f.sh}; echo ${D}X`],
];
for (const [label, line] of ALLOW) {
  test(`#266 R4 still allows: ${label}`, () => {
    const r = run(line);
    assert.equal(r.decision, 'allow', `${line} -> ${r.decision}: ${r.reason}`);
  });
}
