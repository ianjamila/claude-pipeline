// PR #266 round 6: the R5 class rules (an assigning expansion, a word that splits) had holes of their own, closed fail-closed again.
//   R6-B1/F3  a long or decoy-laden flag group (`${(j:aaaa…\}:)y:=…}`, `${(j:$(echo ')a=x}'):)y:=…}`) hid the real assignment from the loose patterns; now ANY `${(` flag group, `$((` or `$[`
//             in a word, env value, redirect word, own text or heredoc body of a would-be read-only command makes it no read-only call, and every `=` up to the last `}` of a text is judged.
//   R6-F1     the two assigning patterns backtracked quadratically (a hook past the host's 15 s is ALLOWED): one linear scan now; timing tests below.
//   R6-F2     a positional name (`${1:=w}`, `${9=w}`) is an assigning expansion too.
//   R6-F4     `"${=…}"` and `"$=x"` split even inside double quotes.
//   R6-F5     `echo "$((path[\$(rm S)]))"` and `echo "${(e):-\$(rm S)}"` evaluate with no assignment at all.
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
