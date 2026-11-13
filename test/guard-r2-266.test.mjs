// PR #266 round 2: evaluatesSubscript (the R1-B2 check that a `test` / `printf` operand which zsh or bash reads as an arithmetic expression can run an array subscript's
// substitution) judged `printf -v` by the words as written only (R2-B1), and knew no other evaluating form: zsh also reads a numeric conversion's argument (%d %i %u %o %x %X
// %e %E %f %g %G) and a `*` width / precision of printf, and the operand of `test -t`, as arithmetic (R2-F1; probed with zsh 5.9 when an array of that name exists).
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

const DENY = [
  // R2-B1: the option word is a name that expands to -v, or is not known until run time
  ['printf with -v named by a same-line variable', `V=-v; printf $V 'a[$(rm ${S})]' x`],
  ['printf with -v named by a variable, rm of a variable path', `V=-v; T=${S}; printf $V 'a[$(rm "$T")]' x; cat data.txt`],
  ['printf whose option word is only known at run time', `printf $V 'a[$(rm ${S})]' x`],
  ['printf whose option word is a command substitution', `printf $(echo -v) 'a[$(rm ${S})]' x`],
  // R2-F1: numeric conversions and * widths evaluate their argument, no -v needed
  ['printf %d with a subscript argument', `printf '%d' 'a[$(rm ${S})]'`],
  ['printf %d with a subscript argument through a variable (the assignment exemption)', `T=${S}; printf '%d\\n' 'a[$(rm "$T")]'`],
  ['printf %x with a subscript argument', `printf '%x\\n' 'a[$(rm ${S})]'`],
  ['printf %f after a literal', `printf 'n=%s v=%f\\n' ok 'a[$(rm ${S})]'`],
  ['printf with a * width', `printf '%*s' 'a[$(rm ${S})]' x`],
  ['printf with a * precision', `printf '%.*f' 'a[$(rm ${S})]' 1`],
  ['printf with a format only known at run time', `printf "$F" 'a[$(rm ${S})]'`],
  ['printf %d with a backtick subscript', 'printf \'%d\' \'a[`rm ' + S + '`]\''],
  ['test -t with a subscript argument', `test -t 'a[$(rm ${S})]'`],
  ['[ -t with a subscript argument', `[ -t 'a[$(rm ${S})]' ]`],
  ['[ -t through a variable', `T=${S}; [ -t 'a[$(rm "$T")]' ]`],
];
for (const [label, line] of DENY) {
  test(`#266 R2 denies: ${label}`, () => {
    const r = run(line);
    assert.equal(r.decision, 'deny', `${line} -> ${r.decision}`);
  });
}

const ALLOW = [
  ['printf %s of a plain word', `printf '%s\\n' x`],
  ['printf %d of a number', `printf '%d\\n' 3`],
  ['printf %s with a protected path as a plain argument', `printf '%s\\n' ${S}`],
  ['printf %s of a command substitution of a read-only command', `printf '%s\\n' "$(cat data.txt)"`],
  ['printf with -v of a plain name', `printf -v x '%s' y; cat data.txt`],
  ['test -t of a descriptor number', 'test -t 1 || echo no'],
  ['[ -t of a descriptor number', '[ -t 1 ] || echo no'],
];
for (const [label, line] of ALLOW) {
  test(`#266 R2 still allows: ${label}`, () => {
    const r = run(line);
    assert.equal(r.decision, 'allow', `${line} -> ${r.decision}: ${r.reason}`);
  });
}
