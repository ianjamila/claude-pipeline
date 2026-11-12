// PR #266 round 6: the R5 class rules (an assigning expansion, a word that splits) had holes of their own, closed fail-closed again.
//   R6-B1/F3  a long or decoy-laden flag group (`${(j:aaaa…\}:)y:=…}`, `${(j:$(echo ')a=x}'):)y:=…}`) hid the real assignment from the loose patterns; now ANY `${(` flag group, `$((` or `$[`
//             in a word, env value, redirect word, own text or heredoc body of a would-be read-only command makes it no read-only call, and every `=` up to the last `}` of a text is judged.
//   R6-F1     the two assigning patterns backtracked quadratically (a hook past the host's 15 s is ALLOWED): one linear scan now; timing tests below.
//   R6-F2     a positional name (`${1:=w}`, `${9=w}`) is an assigning expansion too.
//   R6-F4     `"${=…}"` and `"$=x"` split even inside double quotes.
//   R6-F5     `echo "$((path[\$(rm S)]))"` and `echo "${(e):-\$(rm S)}"` evaluate with no assignment at all.
// Home is /home/u and the filesystem is faked. Protected paths are built from parts so this file does not spell them either.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateBashForFiles } from '../pipeline/hooks/lib/files-policy.mjs';

const PROJ = '/home/u/proj';
const CFG = ['~', '.claude'].join('/');
const S = `${CFG}/settings.json`; // a protected file
const files = { '/home/u/proj/data.txt': 'x\n', '/home/u/proj/a.txt': 'x\n' };
const BASE = { home: '/home/u', env: {}, platform: 'linux', realpath: (p) => p, existsSync: (p) => p in files, readText: (p) => (typeof files[p] === 'string' ? files[p] : null) };
const run = (command, extra = {}) => evaluateBashForFiles(command, { ...BASE, cwd: PROJ, ...extra });
const D = '$';
const OB = D + '{';
const BSL = '\\';
const DEF = `path[${BSL}${D}(rm ${S})]`; // a default word that holds a subscript evaluation
const P = `$(printf -- '-v\\npath${BSL}x5b'; echo '${D}(rm ${S})]')`;

const DENY = [
  // R6-B1: a flag group longer than the old 40-character window, holding an escaped closing brace
  ['B1 long flag group with an escaped }', `echo "${OB}(j:${'a'.repeat(50)}${BSL}}:)y:=${DEF}}"; printf '%d' y`],
  ['B1 very long flag group', `echo "${OB}(j:${'a'.repeat(5000)}${BSL}}:)y:=${DEF}}"; printf '%d' y`],
  // R6-F2: a positional parameter as the assigned name
  ['F2 ${1:=w}', `echo "${OB}1:=${DEF}}"; printf '%d' "${D}1"`],
  ['F2 ${9=w}', `echo "${OB}9=${DEF}}"; printf '%d' "${D}9"`],
  ['F2 ${12::=w}', `echo "${OB}12::=${DEF}}"; printf '%d' "${D}12"`],
  // R6-F3: a decoy name=plain} inside a quoted or substituted part of a short flag group
  ['F3 decoy in a command substitution, double-quoted', `echo "${OB}(j:${D}(echo ')a=x}'):)y:=${DEF}}"; printf '%d' y`],
  ['F3 decoy, unquoted variant', `echo ${OB}(j:')a=x}':)y:="${DEF}"}; printf '%d' y`],
  ['F3 decoy in a subscript', `echo "${OB}y[${D}(echo ']')a=x}]:=${DEF}}"; printf '%d' y`],
  ['F3 two assignments, the plain one first', `echo "${OB}a=x} ${OB}y:=${DEF}}"; printf '%d' y`],
  // R6-F4: ${=…} and $=… split inside double quotes
  ['F4 test "${=$(P)}"', `test "${OB}=${P}}"`],
  ['F4 [ x = "${=$(P)}" ]', `[ x = "${OB}=${P}}" ]`],
  ['F4 test -n "${=$(P)}"', `test -n "${OB}=${P}}"`],
  ['F4 test "$=x" beside the file', `test "${D}=x" ${S}`],
  // R6-F5: a read-only command's own word evaluates a subscript or runs a substitution
  ['F5 echo "$((path[$(rm S)]))"', `echo "${D}((path[${BSL}${D}(rm ${S})]))"`],
  ['F5 echo "${(e):-$(rm S)}"', `echo "${OB}(e):-${BSL}${D}(rm ${S})}"`],
  ['F5 echo $[path[$(rm S)]]', `echo ${D}[path[${BSL}${D}(rm ${S})]]`],
  ['F5 cat with an arithmetic word', `cat "${D}((path[${BSL}${D}(rm ${S})]))"`],
  ['F5 env value with an arithmetic word', `X="${D}((path[${BSL}${D}(rm ${S})]))" echo hi`],
  ['F5 redirect word with a flag group', `echo x < "${OB}(e):-${BSL}${D}(rm ${S})}"`],
  ['F5 heredoc body with a flag group', `cat <<EOF\n${OB}(e):-${BSL}${D}(rm ${S})}\nEOF`],
];
for (const [label, line] of DENY) {
  test(`#266 R6 denies: ${label}`, () => {
    const r = run(line);
    assert.equal(r.decision, 'deny', `${line.slice(0, 200)} -> ${r.decision}`);
  });
}

// R6-F1: a line that writes a protected file and holds `<<` is judged whole, before any write check; a hook past 15 s is ALLOWED, so the time is a security property.
const TIMED = [
  ['`${` then 190 kB of a (no } and no =)', `echo '{}' > ${S}; : '<<' '${OB}${'a'.repeat(190000)}'`],
  ['`${` repeated 100000 times', `echo '{}' > ${S}; : '<<' '${OB.repeat(100000)}'`],
  ['`${a=` repeated, never closed', `echo '{}' > ${S}; : '<<' '${(OB + 'a=').repeat(40000)}'`],
  ['`${(` flag group of 190 kB', `echo '{}' > ${S}; : '<<' '${OB}(j:${'a'.repeat(190000)}'`],
  ['a long run of = signs', `echo '{}' > ${S}; : '<<' '${OB}a${'='.repeat(190000)}'`],
];
for (const [label, line] of TIMED) {
  test(`#266 R6 timing: ${label} is denied in under 2 s`, () => {
    const t0 = performance.now();
    const r = run(line);
    const ms = performance.now() - t0;
    assert.equal(r.decision, 'deny', `${r.decision}`);
    assert.ok(ms < 2000, `took ${Math.round(ms)} ms`);
  });
}

const ALLOW = [
  ['echo "${HOME}"', `cat ${S}; echo "${OB}HOME}"`],
  ['echo "${X:-default}"', `cat ${S}; echo "${OB}X:-default}"`],
  ['cat "$1" on a judged line', `cat ${S} "${D}1"`],
  ['echo of a default that assigns a plain path', `echo ${OB}X:=./f.sh}; echo ${D}X`],
  ['two expansions around a plain = word', `[ "${OB}a}" = "${OB}b}" ] && cat ${S}`],
];
for (const [label, line] of ALLOW) {
  test(`#266 R6 still allows: ${label}`, () => {
    const r = run(line);
    assert.equal(r.decision, 'allow', `${line} -> ${r.decision}: ${r.reason}`);
  });
}

// PR #266 post-push security review of 010ac7c: two more holes in the same class, closed fail-closed.
//   PP-1  zsh also evaluates a subscript as arithmetic in a `${name:offset:length}` offset, in a subscript on a bare `$name[…]` and in `${x[…]}` with a nested subscript; any `${…}` or `$name[` whose
//         span holds a `[`, `$(` or a backtick is refused, and so is a `${name:` offset or length that is not plain digits (`${x: -1}` and the `:-` `:+` `:=` `:?` operators keep their handling).
//   PP-2  zsh with MULTIBYTE allows non-ASCII letters in a parameter name (`${é:=…}`): every `=` after a non-ASCII char counts as an assignment, not only one after `]` or an ASCII word char.
const SUB = `path[${BSL}${D}(rm ${S})]`; // a subscript that runs a substitution
const PP = [
  ['PP-1 offset holding a subscript', (q) => `echo ${q}${OB}x:${SUB}}${q}`],
  ['PP-1 length holding a subscript', (q) => `echo ${q}${OB}x:1:${SUB}}${q}`],
  ['PP-1 offset after a space holding a subscript', (q) => `echo ${q}${OB}x: ${SUB}}${q}`],
  ['PP-1 bare $name[ subscript', (q) => `echo ${q}${D}x[${SUB}]${q}`],
  ['PP-1 bare $1[ subscript', (q) => `echo ${q}${D}1[${SUB}]${q}`],
  ['PP-1 ${x[nested subscript]}', (q) => `echo ${q}${OB}x[${SUB}]}${q}`],
  ['PP-1 ${x}[subscript]', (q) => `echo ${q}${OB}x}[${SUB}]${q}`],
  ['PP-1 offset from a parameter', (q) => `echo ${S} ${q}${OB}x:${D}y}${q}`],
  ['PP-1 length from a parameter', (q) => `echo ${S} ${q}${OB}x:1:${D}y}${q}`],
  ['PP-1 offset from a substitution', (q) => `echo ${S} ${q}${OB}x:${BSL}${D}(echo 1)}${q}`],
  ['PP-1 offset from a backtick', (q) => `echo ${S} ${q}${OB}x:${BSL}\`echo 1${BSL}\`}${q}`],
  ['PP-1 offset hiding behind a decoy brace', (q) => `echo ${q}${OB}x:'}'${SUB}}${q}`],
  ['PP-2 non-ASCII name :=', (q) => `echo ${q}${OB}é:=${SUB}}${q}`],
  ['PP-2 non-ASCII name =', (q) => `echo ${q}${OB}é=${SUB}}${q}`],
  ['PP-2 non-ASCII name ::=', (q) => `echo ${q}${OB}日本::=${SUB}}${q}`],
  ['PP-2 combining mark in the name', (q) => `echo ${q}${OB}é:=${SUB}}${q}`],
];
for (const [label, mk] of PP) {
  for (const [qn, q] of [['double-quoted', '"'], ['unquoted', '']]) {
    test(`#266 post-push denies: ${label}, ${qn}`, () => {
      const line = mk(q);
      const r = run(line);
      assert.equal(r.decision, 'deny', `${line.slice(0, 200)} -> ${r.decision}`);
    });
  }
}
test('#266 post-push denies: an offset subscript in an env value, a redirect word and a heredoc body', () => {
  for (const line of [`X="${OB}x:${SUB}}" echo hi`, `echo x < "${D}x[${SUB}]"`, `cat <<EOF\n${OB}x:${SUB}}\nEOF`, `cat <<'EOF'\n${D}x[${SUB}]\nEOF`]) {
    const r = run(line);
    assert.equal(r.decision, 'deny', `${line.slice(0, 200)} -> ${r.decision}`);
  }
});

// the new checks stay linear: a hook past the host's 15 s is ALLOWED
const PP_TIMED = [
  ['`${x:` then 190 kB of digits and no }', `echo '{}' > ${S}; : '<<' '${OB}x:${'1'.repeat(190000)}'`],
  ['`${x:` repeated 40000 times, never closed', `echo '{}' > ${S}; : '<<' '${(OB + 'x:').repeat(40000)}'`],
  ['`${` repeated 100000 times then a [ at the end', `echo '{}' > ${S}; : '<<' '${OB.repeat(100000)}['`],
  ['`$a` repeated 60000 times then a [', `echo '{}' > ${S}; : '<<' '${(D + 'a').repeat(60000)}['`],
  ['`$` and 190 kB of name chars with no [', `echo '{}' > ${S}; : '<<' '${D}${'a'.repeat(190000)}'`],
  ['`${é` and a run of = after non-ASCII', `echo '{}' > ${S}; : '<<' '${OB}é${'='.repeat(190000)}'`],
];
for (const [label, line] of PP_TIMED) {
  test(`#266 post-push timing: ${label} is denied in under 2 s`, () => {
    const t0 = performance.now();
    const r = run(line);
    const ms = performance.now() - t0;
    assert.equal(r.decision, 'deny', `${r.decision}`);
    assert.ok(ms < 2000, `took ${Math.round(ms)} ms`);
  });
}

const PP_ALLOW = [
  ['echo "${HOME}"', `cat ${S} "${OB}HOME}"`],
  ['echo "${X:-default}"', `cat ${S} "${OB}X:-default}"`],
  ['echo "${x:1:2}"', `cat ${S} "${OB}x:1:2}"`],
  ['echo "${x: -1}"', `cat ${S} "${OB}x: -1}"`],
  ['echo "${x:+alt}"', `cat ${S} "${OB}x:+alt}"`],
  ['echo of a plain path default that assigns', `cat ${S} ${OB}X:=./f.sh}`],
  ['a [ test of two expansions', `cat ${S} "${OB}a}" = "${OB}b}"`],
  ['a non-ASCII word beside a plain = word', `cat ${S} "é" = "${OB}b}"`],
  ['echo "$HOME/x" with a [ elsewhere', `cat ${S} "${D}HOME/x" [a]`],
];
for (const [label, line] of PP_ALLOW) {
  test(`#266 post-push still allows: ${label}`, () => {
    const r = run(line);
    assert.equal(r.decision, 'allow', `${line} -> ${r.decision}: ${r.reason}`);
  });
}

// PR #266 round 7 (+ post-push review of c2c088f): the per-`${` judging still skipped heads it did not recognise.
//   R7-B1   EXPANSION_NAME had two overlapping `*` classes: `${` + 190,000 `!` backtracked quadratically. One hand-written depth-tracking scan now judges every `${…}` against its TRUE closing brace.
//   R7-F1 / PP3-a  a nested head (`${${x}:path[…]}`, `${${:-a}:1:path[…]}`, a decoy `'}'`) hid the offset and the risky chars from the old next-`}` span.
//   PP3-b   a combining mark (or any non-ASCII char) in the name skipped the offset check.   PP3-c  a nested `}` followed by `:` is refused (like `}[`).
//   R7-F2   a bare subscript on a one-character special parameter (`$@[…]`, `$*[…]`, `$#[…]`, `$?[…]`, `$$[…]`, `$![…]`, `$-[…]`) is evaluated as arithmetic; `${x::len}` is no operator.
//   R7-F3   a bare `_` read as arithmetic is the last word of the previous command: on a line that names a protected file an arithmetic context (`$((`, `$[`, `((`, `let`, a numeric test operator,
//           a lone `_` word) denies the line, since the reader names no protected file and is never judged.
// (zsh 5.9 could not be run from the guarded shell, so none of the spellings is probed.)
const R7_SUB = `path[${BSL}${D}(rm ${S})]`;
const R7 = [
  ['F1 ${${x}:path[$(cmd)]}', (q) => `echo ${q}${OB}${OB}x}:${R7_SUB}}${q}`],
  ['F1 ${${:-a}:1:path[$(cmd)]}', (q) => `echo ${q}${OB}${OB}:-a}:1:${R7_SUB}}${q}`],
  ['PP3-a a } decoy inside the inner expansion', (q) => `echo ${q}${OB}${OB}x:-'}'}:${R7_SUB}}${q}`],
  ['PP3-a a } decoy, then an offset parameter', (q) => `echo ${S} ${q}${OB}${OB}x:-'}'}:${D}y}${q}`],
  ['PP3-a nested head with a non-digit offset', (q) => `echo ${S} ${q}${OB}${OB}x}:y}${q}`],
  ['PP3-a nested head three deep', (q) => `echo ${S} ${q}${OB}${OB}${OB}x}}:y}${q}`],
  ['PP3-c ${x:-${y}:z} nested close then a colon', (q) => `echo ${S} ${q}${OB}x:-${OB}y}:z}${q}`],
  ['F1 ${x::path[$(cmd)]}', (q) => `echo ${q}${OB}x::${R7_SUB}}${q}`],
  ['F1 ${x::len} is no operator', (q) => `echo ${S} ${q}${OB}x::y}${q}`],
  ['F2 $@[…]', (q) => `echo ${q}${D}@[${R7_SUB}]${q}`],
  ['F2 $*[…]', (q) => `echo ${q}${D}*[${R7_SUB}]${q}`],
  ['F2 $#[…]', (q) => `echo ${q}${D}#[${R7_SUB}]${q}`],
  ['F2 $?[…]', (q) => `echo ${q}${D}?[${R7_SUB}]${q}`],
  ['F2 $$[…]', (q) => `echo ${q}${D}${D}[${R7_SUB}]${q}`],
  ['F2 $![…]', (q) => `echo ${q}${D}![${R7_SUB}]${q}`],
  ['F2 $-[…]', (q) => `echo ${q}${D}-[${R7_SUB}]${q}`],
  ['PP3-b combining mark in the name, arithmetic offset', (q) => `echo ${S} ${q}${OB}x́:y}${q}`],
  ['PP3-b non-ASCII name, offset from a parameter', (q) => `echo ${S} ${q}${OB}é:${D}y}${q}`],
  ['PP3-b non-ASCII name, subscript offset', (q) => `echo ${q}${OB}日本:${R7_SUB}}${q}`],
  ['PP3-c ${x}:… after a nested close', (q) => `echo ${S} ${q}${OB}${OB}x}:1}${q}`],
  ['a quote inside a span', (q) => `echo ${S} ${q}${OB}x:-'}'${D}y:path}${q}`],
];
for (const [label, mk] of R7) {
  for (const [qn, q] of [['double-quoted', '"'], ['unquoted', '']]) {
    test(`#266 R7 denies: ${label}, ${qn}`, () => {
      const line = mk(q);
      const r = run(line);
      assert.equal(r.decision, 'deny', `${line.slice(0, 200)} -> ${r.decision}`);
    });
  }
}
const PLANT = `echo 'path[${D}(rm ${S})]'`; // names the protected file, a plain echo of a literal
for (const [label, line] of [
  ['$((_))', `${PLANT}; echo ${D}((_))`], ['(( _ ))', `${PLANT}; (( _ ))`], ['let _', `${PLANT}; let _`], ['$[_]', `${PLANT}; echo ${D}[_]`],
  ['[ _ -eq 1 ]', `${PLANT}; [ _ -eq 1 ]`], ['[[ _ -gt 0 ]]', `${PLANT}; [[ _ -gt 0 ]]`], ['printf %d _', `${PLANT}; printf '%d' _`],
  ['echo ${x:_}', `${PLANT}; echo ${OB}x:_}`], ['echo $a[_]', `${PLANT}; echo ${D}a[_]`], ['reader first', `echo ${D}((_)); ${PLANT}`],
]) {
  test(`#266 R7-F3 denies: ${label} beside a line that names a protected file`, () => {
    const r = run(line);
    assert.equal(r.decision, 'deny', `${line} -> ${r.decision}`);
  });
}

const R7_TIMED = [
  ['`${` then 190,000 !', `echo '{}' > ${S}; : '<<' '${OB}${'!'.repeat(190000)}'`],
  ['`${` then 190,000 $', `echo '{}' > ${S}; : '<<' '${OB}${D.repeat(190000)}'`],
  ['190,000 $ then [', `echo '{}' > ${S}; : '<<' '${D.repeat(190000)}['`],
  ['`${${${` x 100k', `echo '{}' > ${S}; : '<<' '${OB.repeat(100000)}'`],
  ['`${x:` then 190k digits', `echo '{}' > ${S}; : '<<' '${OB}x:${'1'.repeat(190000)}'`],
  ['`${é` then 190k combining marks', `echo '{}' > ${S}; : '<<' '${OB}é${'́'.repeat(190000)}'`],
  ['`${x:-` then 90k of `}:`', `echo '{}' > ${S}; : '<<' '${OB}x:-${'}:'.repeat(90000)}'`],
  ['`${` then 190k flag chars #', `echo '{}' > ${S}; : '<<' '${OB}${'#'.repeat(190000)}'`],
  ['`$@` x 90k then [', `echo '{}' > ${S}; : '<<' '${(D + '@').repeat(90000)}['`],
];
for (const [label, line] of R7_TIMED) {
  test(`#266 R7 timing: ${label} is denied in under 2 s`, () => {
    const t0 = performance.now();
    const r = run(line);
    const ms = performance.now() - t0;
    assert.equal(r.decision, 'deny', `${r.decision}`);
    assert.ok(ms < 2000, `took ${Math.round(ms)} ms`);
  });
}

const R7_ALLOW = [
  ['echo "${HOME}"', `cat ${S} "${OB}HOME}"`],
  ['${X:-default}', `cat ${S} "${OB}X:-default}"`],
  ['${x:1:2}', `cat ${S} "${OB}x:1:2}"`],
  ['${x: -1}', `cat ${S} "${OB}x: -1}"`],
  ['${x:+alt}', `cat ${S} "${OB}x:+alt}"`],
  ['${X:=./f.sh}', `cat ${S} ${OB}X:=./f.sh}`],
  ['${#x} and ${!x} and ${@}', `cat ${S} "${OB}#x}" "${OB}!x}" "${OB}@}" "${OB}#}"`],
  ['${PATH#*:} pattern with a colon', `cat ${S} "${OB}PATH#*:}"`],
  ['${x%.txt} and ${x/a/b}', `cat ${S} "${OB}x%.txt}" "${OB}x/a/b}"`],
  ['two top-level expansions around a colon', `cat ${S} "${OB}HOME}:${OB}PATH}"`],
  ['${x:-${y}} nested default', `cat ${S} "${OB}x:-${OB}y}}"`],
  ['words with an underscore inside', `cat ${S} a_b _x`],
];
for (const [label, line] of R7_ALLOW) {
  test(`#266 R7 still allows: ${label}`, () => {
    const r = run(line);
    assert.equal(r.decision, 'allow', `${line} -> ${r.decision}: ${r.reason}`);
  });
}

// PR #288 post-push security review: the arithmetic gate (a) reads a lone `_` in ANY spelling (quoted, escaped, assigned) and `typeset -i` / `integer` / `declare -i` / `local -i` as arithmetic,
// and (b) is decided on the UNMASKED line, so a protected path inside a value the guard treats as prose (a quoted echo argument, a commit message) still counts.
describe('post-push 2', () => {
  const PLANT = `echo 'path[${D}(rm ${S})]';`;
  const DENY2 = [
    ['printf %d "_"', `${PLANT} printf %d "_"`],
    ["printf %d '_'", `${PLANT} printf %d '_'`],
    ['printf %d \\_', `${PLANT} printf %d ${BSL}_`],
    ['typeset -i n=_', `${PLANT} typeset -i n=_`],
    ['integer n=_', `${PLANT} integer n=_`],
    ['declare -i n=_', `${PLANT} declare -i n=_`],
    ['local -i n=_', `${PLANT} local -i n=_`],
    ['typeset -i n (no underscore)', `${PLANT} typeset -i n=3`],
    ['[ "_" -gt 0 ]', `${PLANT} [ "_" -gt 0 ]`],
    ['[ "_" = 0 ]', `${PLANT} [ "_" = 0 ]`],
    ['_ after =', `${PLANT} x=_`],
    ['(b) path only in a quoted echo argument + $((_))', `echo 'see ${S}'; echo ${D}((_))`],
    ['(b) path only in a quoted echo argument + (( ))', `echo "note: ${S}"; ((n=_))`],
    ['(b) path only in a quoted echo argument + let', `echo 'see ${S}'; let n=1`],
    ['(b) path only in a quoted echo argument + printf %d "_"', `echo 'see ${S}'; printf %d "_"`],
    ['(b) path only in a commit message + arithmetic', `git commit -m 'fix ${S}'; echo ${D}((_))`],
  ];
  for (const [label, line] of DENY2) {
    test(`denies: ${label}`, () => {
      const r = run(line);
      assert.equal(r.decision, 'deny', `${line} -> ${r.decision}`);
    });
  }
  const ALLOW2 = [
    ['no protected file: echo $((1+2))', 'echo $((1+2))'],
    ['no protected file: printf %d _', 'printf %d _'],
    ['no protected file: printf %d "_"', 'printf %d "_"'],
    ['no protected file: typeset -i n=_', 'typeset -i n=_'],
    ['no protected file: let', 'let n=1+2'],
    ['cat S a_b', `cat ${S} a_b`],
    ['cat S _x', `cat ${S} _x`],
    ['cat S x_', `cat ${S} x_`],
    ['cat S a_b _x x_ __init__', `cat ${S} a_b _x x_ __init__`],
    ['cat S under_score.txt', `cat ${S} under_score.txt`],
  ];
  for (const [label, line] of ALLOW2) {
    test(`allows: ${label}`, () => {
      const r = run(line);
      assert.equal(r.decision, 'allow', `${line} -> ${r.decision}: ${r.reason}`);
    });
  }
});

// PR #288 post-push security review, part 3: the gates for a name resolved at RUN TIME (a redirect to `$_` / `${_}`, a command that uses `$_`, a scan cut short) read the UNMASKED line too.
// A path inside a value the guard treats as prose (a commit message, a PR body) is masked out of the prose-exempt scan, but it becomes `$_` for the next command.
describe('post-push 3', () => {
  const MSG = `git commit -m "x ${S}"`;
  const DENY3 = [
    ['commit message, then > $_', `${MSG}; echo x > ${D}_`],
    ['commit message, then > ${_}', `${MSG}; echo x > ${OB}_}`],
    ['commit message, then >> $_', `${MSG}; echo x >> ${D}_`],
    ['commit message, then >> ${_}', `${MSG}; echo x >> ${OB}_}`],
    ['commit message, then cp /tmp/a $_', `${MSG}; cp /tmp/a ${D}_`],
    ['commit message, then cp /tmp/a ${_}', `${MSG}; cp /tmp/a ${OB}_}`],
    ['commit message, then printf x | tee $_', `${MSG}; printf x | tee ${D}_`],
    ['commit message, then tee $_ < file', `${MSG}; tee ${D}_ < /tmp/a`],
    ['PR body, then cp /tmp/a $_', `gh pr create --title t --body "see ${S}"; cp /tmp/a ${D}_`],
    ['PR body, then > $_', `gh pr create --title t --body "see ${S}"; echo x > ${D}_`],
    ['quoted echo argument, then > $_', `echo "${S}"; echo x > ${D}_`],
    ['quoted echo argument, then printf x | tee $_', `echo "${S}"; printf x | tee ${D}_`],
    ['quoted echo argument, then cp /tmp/a $_', `echo "${S}"; cp /tmp/a ${D}_`],
  ];
  for (const [label, line] of DENY3) {
    test(`denies: ${label}`, () => {
      const r = run(line);
      assert.equal(r.decision, 'deny', `${line} -> ${r.decision}`);
    });
  }
  const ALLOW3 = [
    ['a commit message that mentions the file, nothing reads $_', `git commit -m "docs: mention ${S}"`],
    ['a commit message that mentions the file, then push', `git commit -m "docs: mention ${S}" && git push`],
    ['a quoted echo of the file alone', `echo "${S}"`],
    ['a commit message that mentions the file, then a read-only reader of $_', `${MSG}; ls ${D}_`],
    ['no protected file anywhere: > $_', `echo hi; echo x > ${D}_`],
    ['no protected file anywhere: cp /tmp/a $_', 'git commit -m "docs: x"; cp /tmp/a $_'],
  ];
  for (const [label, line] of ALLOW3) {
    test(`allows: ${label}`, () => {
      const r = run(line);
      assert.equal(r.decision, 'allow', `${line} -> ${r.decision}: ${r.reason}`);
    });
  }
});

// PR #288 round 1 (R1-B1, R1-F1, R1-F2, R1-F3): three more quadratic scans (a hook past the host's 15 s is ALLOWED, so the time is a security property), a multi-word value judged as one word,
// and the class fix: the whole evaluation honours ONE wall-clock deadline (EVAL_DEADLINE_MS, a third of the hook timeout) and a line that outlasts it is denied.
describe('#288 R1', () => {
  const T = (label, line, extra = {}) => test(`timing: ${label} is denied in under 2 s`, () => {
    const t0 = performance.now();
    const r = run(line, extra);
    const ms = performance.now() - t0;
    assert.equal(r.decision, 'deny', `${r.decision}`);
    assert.ok(ms < 2000, `took ${Math.round(ms)} ms`);
  });
  // R1-B1: SUBSCRIPT_FORM rescanned to the end of the word from every `[`
  T('R1-B1 printf of 190000 [ then a write', `printf '%s' '${'['.repeat(190000)}'; echo x > ${S}`);
  T('R1-B1 test with 190000 [ then a write', `test '${'['.repeat(190000)}'; echo x > ${S}`);
  // R1-F1: LAST_WORD_RE's `${_` alternative backtracked on a repeated `${_:` with no `}`
  T('R1-F1 ${_: repeated, then a write through cp', `echo '${(OB + '_:').repeat(47000)}'; cp /tmp/p ${S}`);
  T('R1-F1 ${_: repeated in a redirect target', `echo x > ${OB}_:${(OB + '_:').repeat(47000)}`.replace('echo x', `cat ${S}; echo x`));
  // R1-F2: toolEnvTouched's declare pattern ran from every keyword, once per isReadOnly call
  T('R1-F2 long local-run line, many git status, then a write', `git status '${'local '.repeat(30000)}'; git status; git status; git status; echo x > ${S}`);
  T('R1-F2 long export-run line, many git status, then a write', `git status '${'export '.repeat(30000)}'; git status; git status; git status; echo x > ${S}`);
  T('R1-F2 many commands on a long local-run line', `${'git status; '.repeat(2000)}echo '${'local '.repeat(20000)}'; echo x > ${S}`);

  // R1-F3: an expanded multi-word value is several words (bash splits it, zsh splits an array)
  const F3 = [
    ['find with -true -delete', `D='-true -delete'; find ${S} $D`],
    ['find with -delete in a longer value', `D='-name x -delete'; find ${S} $D`],
    ['openssl dgst -sha256 -out', `O='-sha256 -out'; openssl dgst $O ${S} /tmp/x`],
    ['tree -a -o', `O='-a -o'; tree $O ${S}`],
    ['sort -o', `O='-o /tmp/x'; sort $O ${S}`],
    ['sed -i', `O='-i s/a/b/'; sed $O ${S}`],
    ['zsh array: find', `D=(-true -delete); find ${S} $D`],
    ['zsh array: tree', `O=(-a -o); tree $O ${S}`],
    ['zsh array: openssl', `O=(-sha256 -out); openssl dgst $O ${S} /tmp/x`],
    ['quoted use of a multi-word value', `D='-true -delete'; find ${S} "$D"`],
  ];
  for (const [label, line] of F3) {
    test(`denies: ${label}`, () => {
      const r = run(line);
      assert.equal(r.decision, 'deny', `${line} -> ${r.decision}`);
    });
  }
  for (const [label, line] of [
    ['a one-word option value', `D=-L; find ${S} $D`],
    ['a multi-word value that is no option for a reader', `W='a b'; cat ${S} $W`],
    ['a name value with a space for find -name', `N='x y'; find . -name "$N"`],
  ]) {
    test(`allows: ${label}`, () => {
      const r = run(line);
      assert.equal(r.decision, 'allow', `${line} -> ${r.decision}: ${r.reason}`);
    });
  }

  // The class fix: one deadline, checked at the heads of the per-command loops and in isReadOnly / mayChangeListing / plantsInText / evaluatesSubscript.
  const CHAIN = `${'git status; ls; cat data.txt; '.repeat(10)}echo done`;
  test('deadline: a line whose checks run past the deadline is denied with the "took too long" reason', () => {
    let t = 0;
    const r = run(CHAIN, { now: () => (t += 1000) });
    assert.equal(r.decision, 'deny', `${r.decision}: ${r.reason}`);
    assert.match(r.reason, /took too long/);
  });
  test('deadline: the same line is allowed while the clock stands still', () => {
    const r = run(CHAIN, { now: () => 0 });
    assert.equal(r.decision, 'allow', `${r.decision}: ${r.reason}`);
  });
  test('deadline: the clock is read at every command, not just at the top', () => {
    let n = 0;
    run(CHAIN, { now: () => { n++; return 0; } });
    assert.ok(n >= 30, `the clock was read ${n} times for 31 commands`);
  });
  test('deadline: a clock that runs out at any point never lets the line through after the read that saw it', () => {
    for (const stop of [1, 2, 3, 5, 8, 13, 21, 34, 55, 89]) {
      let n = 0;
      let seen = false;
      const r = run(CHAIN, { now: () => { n++; if (n > stop) { seen = true; return 1e9; } return 0; } });
      if (seen) assert.equal(r.decision, 'deny', `stop ${stop}: ${r.decision}`);
    }
  });
});

// #288 round 2: judgedWords split an expanded multi-word value (R1-F3) but only a word written without whitespace, only for the option tools, and without the whole reading; the class is closed
// by judging an expanded word BOTH whole (a quoted use) and split (an unquoted use), refusing a run-time part anywhere in a word, and refusing any expanded word where IFS may be set.
//   R2-B1  a written word with whitespace (quotes lost by the parser) skipped the split: `D=' -delete'; find S '/tmp/a b'$D`
//   R2-F1  the split alone let a piece become git's subcommand after -C / --git-dir / --work-tree / --namespace
//   R2-F2  a custom IFS splits elsewhere: `IFS=:; D='-true:-delete'; find S $D`
//   R2-F3  a run-time part in the middle of a word: `find S x${D[@]}`, `x$@`, `x$(…)`, zsh `x${=D}`
describe('#288 R2', () => {
  const DENIED = [
    ['R2-B1 written word with a space, then an expanded option', `D=' -delete'; find ${S} '/tmp/nonexistent space'$D`],
    ['R2-B1 tree', `O=' -a -o'; tree '/tmp/a b'$O ${S}`],
    ['R2-F1 git --namespace "$N" clean', `N='x status'; git --namespace "$N" clean -fdx .review`],
    ['R2-F1 git --git-dir "$G" checkout', `G='/tmp/r log'; git --git-dir "$G" --work-tree ~ checkout HEAD -- ${S}`],
    ['R2-F1 git -C "$C" clean', `C='/tmp/r status'; git -C "$C" clean -fdx .review`],
    ['R2-F1 git -C "$C" checkout', `C='/tmp/r log'; git -C "$C" checkout HEAD -- ${S}`],
    ['R2-F1 git --work-tree "$W" clean', `W='/tmp/r status'; git --work-tree "$W" clean -fdx .review`],
    ['R2-F2 IFS=: find', `IFS=:; D='-true:-delete'; find ${S} $D`],
    ['R2-F2 IFS=, tree', `IFS=,; O='-a,-o'; tree $O ${S}`],
    ['R2-F2 export IFS', `export IFS=:; D='-true:-delete'; find ${S} $D`],
    ['R2-F2 declare IFS', `declare IFS=:; D='-true:-delete'; find ${S} $D`],
    ['R2-F2 local IFS', `f() { local IFS=:; D='-true:-delete'; find ${S} $D; }; f`],
    ['R2-F2 read IFS', `read -r IFS <<< ':'; D='-true:-delete'; find ${S} $D`],
    ['R2-F2 printf -v IFS', `printf -v IFS ':'; D='-true:-delete'; find ${S} $D`],
    ['R2-F2 IFS with a one-word value', `IFS=x; D=-name; find ${S} $D y`],
    ['R2-F2 sed with IFS', `IFS=:; O='-i:s/a/b/'; sed $O ${S}`],
    ['R2-F3 zsh array element, mid-word', `D=(-true -delete); find ${S} x\${D[@]}`],
    ['R2-F3 positional $@', `set -- y -delete; find ${S} x$@`],
    ['R2-F3 positional $*', `set -- y -delete; find ${S} x$*`],
    ['R2-F3 command substitution mid-word', `find ${S} x$(printf ' -delete')`],
    ['R2-F3 backtick mid-word', `find ${S} x\`printf ' -delete'\``],
    ['R2-F3 zsh ${=D}', `D='-true -delete'; find ${S} x\${=D}`],
    ['R2-F3 unknown name mid-word, find', `find ${S} x$UNKNOWN`],
    ['R2-F3 unknown name mid-word, git', `git status x$UNKNOWN ${S}`],
    ['R2-F3 mid-word substitution, tree', `tree x$(printf ' -o') ${S}`],
  ];
  for (const [label, line] of DENIED) {
    test(`denies: ${label}`, () => {
      const r = run(line);
      assert.equal(r.decision, 'deny', `${line} -> ${r.decision}`);
    });
  }
  for (const [label, line] of [
    ['a same-line one-word option value (find .)', 'D=-name; find . $D x'],
    ['a same-line one-word option value on a protected path (as at 71a1e70)', `D=-name; find ${S} $D x`],
    ['a one-word option value, no IFS change', `D=-L; find ${S} $D`],
    ['git -C "$PWD" status', 'git -C "$PWD" status'],
    ['a quoted name value with a space for find -name', `N='x y'; find . -name "$N"`],
    ['IFS changed, no expanded word', `IFS=:; find . -name x; cat ${S}`],
    ['a regex ending in a dollar for rg', `rg 'foo$' ${S}`],
    ['an awk program with $1 and $NF', `awk '{print $1, $NF}' ${S}`],
  ]) {
    test(`allows: ${label}`, () => {
      const r = run(line);
      assert.equal(r.decision, 'allow', `${line} -> ${r.decision}: ${r.reason}`);
    });
  }
});
