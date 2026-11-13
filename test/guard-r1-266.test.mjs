// PR #266 round 1: the assignment exemption and isReadOnly judge the words the shell will pass, so a name a quoted program text or a test subscript reads must not make a
// command look read-only (R1-B1 awk system() / GNU sed e through a same-line name, R1-B2 `test -v` / numeric comparison / `printf -v` evaluating an array subscript), and the
// top-level-only clause of the exemption is pinned for a nested shell, a script file and a sourced file (R1-F3).
// Home is /home/u and the filesystem is faked. Protected paths are built from parts so this file does not spell them either.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateBashForFiles } from '../pipeline/hooks/lib/files-policy.mjs';

const PROJ = '/home/u/proj';
const CFG = ['~', '.claude'].join('/');
const S = `${CFG}/settings.json`; // a protected file
const files = {
  '/home/u/proj/script.sh': `T=${S}\ncat "$T"\n`,
  '/home/u/proj/values.sh': `T=${S}; cat "$T"\n`,
  '/home/u/proj/plain.sh': `T=${S}\n`,
  '/home/u/proj/data.txt': 'x\n',
};
const BASE = { home: '/home/u', env: {}, platform: 'linux', realpath: (p) => p, existsSync: (p) => p in files, readText: (p) => (typeof files[p] === 'string' ? files[p] : null) };
const run = (command, extra = {}) => evaluateBashForFiles(command, { ...BASE, cwd: PROJ, ...extra });

const DENY = [
  // R1-B1
  ['awk system() named by a same-line variable', `system=length; awk 'BEGIN { $system("rm ${S}") }'`],
  ['awk system() through a variable, rm of a variable path', `T=${S}; system=length; awk 'BEGIN { $system("rm " "$T") }'`],
  ['GNU sed e command through a same-line variable', `e=p; sed -n '$e rm ${S}' data.txt`],
  ['GNU sed e command in its plain form', `sed -n '1e rm ${S}' data.txt`],
  ['GNU sed e command with no address', `sed 'e rm ${S}' data.txt`],
  ['GNU sed s///e flag', `sed 's/x/rm ${S}/e' data.txt`],
  // R1-B2
  ['test -v with a subscript command substitution through a variable', `T=${S}; test -v "a[\\$(rm \\"\\$T\\")]"`],
  ['test -v with a literal protected path', `test -v 'path[$(rm ${S})]'`],
  ['[ -v with a subscript command substitution', `[ -v 'a[$(rm ${S})]' ]`],
  ['test -v with a backtick subscript', 'test -v \'a[`rm ' + S + '`]\''],
  ['numeric comparison with a subscript command substitution', `test 'a[$(rm ${S})]' -eq 1`],
  ['numeric comparison through a variable', `T=${S}; [ 1 -lt 'a[$(rm "$T")]' ]`],
  ['printf -v with a subscript name', `printf -v 'a[$(rm ${S})]' x`],
  ['printf -v with a subscript name through a variable', `T=${S}; printf -v 'a[$(rm "$T")]' x; cat data.txt`],
  // R1-F3: the exemption is top level only
  ['bash -c with an assignment and a reader', `bash -c 'T=${S}; cat "$T"'`],
  ['a script file with an assignment and a reader', `bash script.sh`],
  ['source of a file with an assignment and an inert reader on the line', `source values.sh`],
  ['source of a plain assignment file, then an inert reader', `source plain.sh; cat "$T"`],
];
for (const [label, line] of DENY) {
  test(`#266 R1 denies: ${label}`, () => {
    const r = run(line);
    assert.equal(r.decision, 'deny', `${line} -> ${r.decision}`);
  });
}

const ALLOW = [
  ['test -v of a plain name', 'test -v HOME && echo yes'],
  ['numeric comparison of plain operands', 'test 1 -eq 1 && echo yes'],
  ['sed -n p on a file', "sed -n '1,3p' data.txt"],
];
for (const [label, line] of ALLOW) {
  test(`#266 R1 still allows: ${label}`, () => {
    const r = run(line);
    assert.equal(r.decision, 'allow', `${line} -> ${r.decision}: ${r.reason}`);
  });
}

// R1-F5: the owner-go recorder refusal read "refused;<NAME>=1" (no space after the semicolon)
test('#266 R1: the owner-go recorder refusal has a space after the semicolon', () => {
  const r = run(`node -e "require('fs').writeFileSync('pipeline/hooks/lib/owner-go.mjs', 'x')"`);
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /owner-go recorder/);
  assert.doesNotMatch(r.reason, /;\S/);
});
