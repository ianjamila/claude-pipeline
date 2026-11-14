// PR #266 round 3: evaluatesSubscript (a `test` / `[` / printf call whose operand zsh reads as arithmetic runs an array subscript's `$(…)`) kept missing new spellings:
//   R3-B1  `--` ends printf's options (the next word is the format, even one that starts with `-`); the format search skipped every dash word.
//   R3-F1  the format was judged only as expanded; a same-line name rewrites a single-quoted format the shell passes unchanged (`d=.s; printf '%1$d' …`, `x=-; printf '$x%d' …`).
//   R3-F2  a test / `[` operator that is only known at run time (`test $(echo -v) 'a[$(…)]'`).
//   R3-F3  a `%` spelled as an escape in the format. Probed with zsh 5.9: `%d` is a live %d (prints 7 for `printf '%d\n' 7`); `\x25d`, `\45d`, `\045d` print a literal `%d`.
// The class rule closes them all: test, `[`, `[[` and printf are no read-only call when any word, as written or as expanded, holds a subscript-evaluation form (a `[` followed later in the
// same word by `$(`, `${`, `$[` or a backtick), whatever the operator or format. Probed with zsh 5.9 (an array `a` existing): `y='a[$(…)]'; printf '%d' y` evaluates the VALUE of the
// name y (so does `(( y ))`, `let y` and `[[ y -eq 1 ]]`), while `[ y -eq 1 ]` and `test -v y` do not. A same-line assignment whose value holds such a form is no harmless assignment.
// Home is /home/u and the filesystem is faked. Protected paths are built from parts so this file does not spell them either.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateBashForFiles } from '../pipeline/hooks/lib/files-policy.mjs';

const PROJ = '/home/u/proj';
const CFG = ['~', '.claude'].join('/');
const S = `${CFG}/settings.json`; // a protected file
const files = { '/home/u/proj/data.txt': 'x\n' };
const BASE = { home: '/home/u', env: {}, platform: 'linux', realpath: (p) => p, existsSync: (p) => p in files, readText: (p) => (typeof files[p] === 'string' ? files[p] : null) };
const run = (command, extra = {}) => evaluateBashForFiles(command, { ...BASE, cwd: PROJ, ...extra });
const SUB = `'path[$(rm ${S})]'`; // a subscript that runs rm of a protected file
const SUBV = `'path[$(rm "$T")]'`; // the same, through a variable

const DENY = [
  // R3-B1: `--` ends the options; the format is the next word, a dash word or not
  ['printf -- with a dash-led numeric format', `printf -- '-%d' ${SUB}`],
  ['printf -- with a dash-led numeric format, variable path', `T=${S}; printf -- '-%d' ${SUBV}`],
  ['printf -- -- (the second -- is the format)', `printf -- -- '-%d' ${SUB}`],
  ['printf - (a lone dash is the format)', `printf - '-%d' ${SUB}`],
  ['printf -- with only dash words and the payload', `printf -- -- ${SUB}`],
  ['printf -- numeric format of a command substitution', `printf -- '-%d\\n' "$(cat ${S})"`],
  // R3-F1: the format as written differs from the format as expanded
  ['printf format rewritten by a name to a plain one (%1$d)', `d=.s; printf '%1$d' ${SUB}`],
  ['printf format rewritten by a prefix name', `d=s printf '%1$d' ${SUB}`],
  ['printf format rewritten by a name to a dash (the $x%d form)', `x=-; printf '$x%d' ${SUB}`],
  ['printf format rewritten by a name, variable path', `T=${S}; d=.s; printf '%1$d' ${SUBV}`],
  ['printf %1$d of a command substitution', `d=.s; printf '%1$d' "$(cat ${S})"`],
  ['printf $x%d of a command substitution', `x=-; printf '$x%d' "$(cat ${S})"`],
  // R3-F2: the test / [ operator is only known at run time
  ['test with a command-substitution operator', `test $(echo -v) ${SUB}`],
  ['[ with a command-substitution operator', `[ $(echo -v) ${SUB} ]`],
  ['[ with a command-substitution comparison operator', `[ ${SUB} $(echo -eq) 1 ]`],
  ['test with an operator that is a dash plus a command substitution', `test -$(echo t) ${SUB}`],
  ['test with a variable operator, variable path', `T=${S}; test $(echo -v) ${SUBV}`],
  ['test with a run-time operator and a bracket word beside a protected read', `test $(echo -v) 'a[1]' "$(cat ${S})"`],
  ['[ with an unknown-name operator', `[ $OP ${SUB} ]`],
  // R3-F3: a % spelled as an escape in the format
  ['printf \\u0025d (live in zsh)', `printf '\\u0025d' ${SUB}`],
  ['printf \\x25d', `printf '\\x25d' ${SUB}`],
  ['printf \\45d', `printf '\\45d' ${SUB}`],
  ['printf \\045d', `printf '\\045d' ${SUB}`],
  ['printf \\x25d of a command substitution', `printf '\\x25d' "$(cat ${S})"`],
  // the class rule: a subscript-evaluation form anywhere, whatever the operator or format
  ['printf %s with a subscript word', `printf '%s' ${SUB}`],
  ['printf %s with a subscript word, variable path', `T=${S}; printf '%s\\n' ${SUBV}`],
  ['printf %s with a ${ subscript', `printf '%s' 'a[\${x:-$(rm ${S})}]'`],
  ['printf %s with a $[ subscript', `printf '%s' 'a[$[$(rm ${S})]]'`],
  ['printf %s with a backtick subscript', 'printf \'%s\' \'a[`rm ' + S + '`]\''],
  ['printf %s with a subscript in a later operand', `printf '%s %s\\n' ok ${SUB}`],
  ['test -n with a subscript word', `test -n ${SUB}`],
  ['[ -f with a subscript word', `[ -f ${SUB} ]`],
  ['[ = with a subscript word', `[ ${SUB} = x ]`],
  ['[ = through a variable', `T=${S}; [ ${SUBV} = x ]`],
  ['test -v with a subscript word held by a same-line name', `W='a[$(rm ${S})]'; test -v "$W"`],
  // an assignment whose value holds a subscript form: zsh evaluates the value of a name read as arithmetic (printf %d y, (( y )), let y, [[ y -eq 1 ]])
  ['printf %d of a name whose value is a subscript', `y='a[$(rm ${S})]'; printf '%d' y`],
  ['printf %d of a name whose value is a subscript, variable path', `T=${S}; y='a[$(rm "$T")]'; printf '%d\\n' y`],
  ['printf %d of a name whose double-quoted value is a subscript', `y="a[\\$(rm ${S})]"; printf '%d' y`],
  ['printf %d of an expanded name whose value is a subscript', `y='a[$(rm ${S})]'; printf '%d' $y`],
  ['[[ -eq of a name whose value is a subscript', `y='a[$(rm ${S})]'; [[ y -eq 1 ]]`],
  ['(( of a name whose value is a subscript', `y='a[$(rm ${S})]'; (( y ))`],
  ['let of a name whose value is a subscript', `y='a[$(rm ${S})]'; let y`],
];
for (const [label, line] of DENY) {
  test(`#266 R3 denies: ${label}`, () => {
    const r = run(line);
    assert.equal(r.decision, 'deny', `${line} -> ${r.decision}`);
  });
}

const ALLOW = [
  ['printf %s of a plain word', `printf '%s\\n' x`],
  ['printf %d of a number', `printf '%d\\n' 3`],
  ['printf -- with a plain format', `printf -- '%s\\n' x`],
  ['printf -- with a dash-led plain format', `printf -- '-%s\\n' "$(cat ${S})"`],
  ['printf %s of a command substitution', `printf '%s\\n' "$(cat ${S})"`],
  ['printf with a \\n escape and a command substitution', `printf '%s\\n' "$(cat ${S})"; printf '\\t%s\\n' "$(cat ${S})"`],
  ['[ -n of a command substitution', `[ -n "$(cat ${S})" ]`],
  ['[ = of a command substitution', `[ "$(cat ${S})" = x ]`],
  ['[ -gt of a counted command substitution', `[ "$(wc -l < data.txt)" -gt 0 ]`],
  ['test -v of a plain name', 'test -v HOME'],
  ['a plain cat of a protected file', `cat ${S}`],
];
for (const [label, line] of ALLOW) {
  test(`#266 R3 still allows: ${label}`, () => {
    const r = run(line);
    assert.equal(r.decision, 'allow', `${line} -> ${r.decision}: ${r.reason}`);
  });
}
