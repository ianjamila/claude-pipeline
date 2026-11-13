// PR #288 round 15: "fail closed, remove a class of risk".
//   R15-F1  "this shell" (source / . / eval) is read from the word AFTER the wrappers (`builtin source`, `command .`, zsh `- source`), and a text a feed hands to source / `.` runs in this
//           shell too (`source /dev/stdin < f`, `. <(cat f)`, `cat f | source /dev/stdin`): the line's cd-meaning switch reaches it
//   R15-F2  a switch in a LATER sourced file reaches a same-shell file judged earlier in text order (loops, functions and traps run in another order)
//   R15-F3  BASHOPTS / SHELLOPTS assigned anywhere (or set in the hook's environment) turns shopt options on in every child bash: a cd-meaning switch handed to every child frame
// Home is /home/u; the cwd is /home/u/proj unless a case says otherwise.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateBashForFiles } from '../pipeline/hooks/lib/files-policy.mjs';

const HOME = '/home/u';
const BASE = { home: HOME, env: {}, platform: 'linux', cwd: HOME, realpath: (p) => p, existsSync: () => false, readText: () => null };
const run = (command, extra = {}) => evaluateBashForFiles(command, { ...BASE, ...extra });
const PROJ = { cwd: `${HOME}/proj` };
const stub = (files, extra = {}) => ({ cwd: `${HOME}/proj`, readText: (p) => files[p] ?? null, existsSync: (p) => Object.hasOwn(files, p), ...extra });

const denies = (label, cases) => {
  for (const [name, line, extra] of cases) {
    test(`#288 R15 ${label} denies: ${name}`, () => {
      const r = run(line, extra ?? PROJ);
      assert.equal(r.decision, 'deny', `${JSON.stringify(line)} -> ${r.decision}`);
    });
  }
};
const allows = (label, cases) => {
  for (const [name, line, extra] of cases) {
    test(`#288 R15 ${label} allows: ${name}`, () => {
      const r = run(line, extra ?? PROJ);
      assert.equal(r.decision, 'allow', `${JSON.stringify(line)} -> ${r.decision}: ${r.reason}`);
    });
  }
};
const body = 'cd proj && find . -delete\n';
const A = stub({ '/home/u/proj/a.sh': body });

describe('R15-F1: wrappers and feeds reach the same shell', () => {
  denies('F1', [
    ['builtin source', 'set -T; export proj=/home/u; builtin source ./a.sh', A],
    ['command .', 'setopt cdablevars; export proj=/home/u; command . ./a.sh', A],
    ['command -p source', 'setopt cdablevars; export proj=/home/u; command -p source ./a.sh', A],
    ['zsh - source', 'setopt cdablevars; export proj=/home/u; - source ./a.sh', A],
    ['noglob source', 'set -T; export proj=/home/u; noglob source ./a.sh', A],
    ['builtin eval of the file text', 'set -T; export proj=/home/u; builtin eval "$(cat ./a.sh)"', A],
    ['source /dev/stdin < file (setopt cdablevars)', 'setopt cdablevars; export proj=/home/u; source /dev/stdin < ./a.sh', A],
    ['source /dev/stdin < file (set -T)', 'set -T; export proj=/home/u; source /dev/stdin < ./a.sh', A],
    ['. /dev/stdin < file', 'set -T; export proj=/home/u; . /dev/stdin < ./a.sh', A],
    ['. <(cat file)', 'setopt cdablevars; export proj=/home/u; . <(cat ./a.sh)', A],
    ['source <(cat file)', 'set -T; export proj=/home/u; source <(cat ./a.sh)', A],
    ['cat file | source /dev/stdin', 'setopt cdablevars; export proj=/home/u; cat ./a.sh | source /dev/stdin', A],
    ['cat file | . /dev/stdin', 'set -T; export proj=/home/u; cat ./a.sh | . /dev/stdin', A],
    ['bash shopt -s cdable_vars, source /dev/stdin < file', 'shopt -s cdable_vars; export proj=/home/u; source /dev/stdin < ./a.sh', A],
    ['bash shopt -s cdable_vars, builtin source', 'shopt -s cdable_vars; export proj=/home/u; builtin source ./a.sh', A],
    ['builtin source /dev/stdin < file', 'set -T; export proj=/home/u; builtin source /dev/stdin < ./a.sh', A],
    ['command . <(cat file)', 'set -T; export proj=/home/u; command . <(cat ./a.sh)', A],
    ['source /dev/stdin < the switch file, then the line\'s own cd', 'export proj=/home/u; source /dev/stdin < ./sw.sh; cd proj && find . -delete', stub({ '/home/u/proj/sw.sh': 'setopt cdablevars\n' })],
    ['eval "$(cat file)" (the pinned reading)', 'set -T; export proj=/home/u; eval "$(cat ./a.sh)"', A],
  ]);
  allows('F1', [
    ['no switch: builtin source of the same file', 'export proj=/home/u; builtin source ./a.sh', A],
    ['no switch: source /dev/stdin < file', 'export proj=/home/u; source /dev/stdin < ./a.sh', A],
    ['no switch: . <(cat file)', 'export proj=/home/u; . <(cat ./a.sh)', A],
    ['no switch: cat file | source /dev/stdin', 'export proj=/home/u; cat ./a.sh | source /dev/stdin', A],
    ['a switch, but a fresh shell reads the stream (bash < file)', 'set -T; export proj=/home/u; bash < ./a.sh', A],
    ['a switch, but a fresh shell reads the stream (cat file | bash)', 'set -T; export proj=/home/u; cat ./a.sh | bash', A],
    ['a switch, but a fresh shell runs the file (command bash FILE)', 'set -T; export proj=/home/u; command bash ./a.sh', A],
    ['a switch and a harmless file', 'set -T; builtin source ./a.sh', stub({ '/home/u/proj/a.sh': 'echo hi\n' })],
  ]);
});

describe('R15-F2: a switch in a later sourced file reaches a same-shell file judged earlier', () => {
  const SW = { '/home/u/proj/a.sh': body, '/home/u/proj/sw.sh': 'setopt cdablevars\n' };
  denies('F2', [
    ['a loop: source a.sh then sw.sh', 'export proj=/home/u; for i in 1 2; do source ./a.sh; source ./sw.sh; done', stub(SW)],
    ['a function called after sw.sh', 'export proj=/home/u; f() { source ./a.sh; }; source ./sw.sh; f', stub(SW)],
    ['a trap', 'export proj=/home/u; trap "source ./a.sh" EXIT; source ./sw.sh', stub(SW)],
    ['a while loop with the switch file second', 'export proj=/home/u; while true; do source ./a.sh; source ./sw.sh; done', stub(SW)],
    ['a nested switch (sw.sh sources the switch)', 'export proj=/home/u; for i in 1 2; do source ./a.sh; source ./sw2.sh; done', stub({ ...SW, '/home/u/proj/sw2.sh': 'source /home/u/proj/sw.sh\n' })],
    ['eval of the file text, then a later switch file', 'export proj=/home/u; for i in 1 2; do eval "$(cat ./a.sh)"; source ./sw.sh; done', stub(SW)],
  ]);
  allows('F2', [
    ['plain order, a harmless a.sh, a later switch file', 'source ./a.sh; source ./sw.sh', stub({ '/home/u/proj/a.sh': 'cd proj && ls\n', '/home/u/proj/sw.sh': 'setopt cdablevars\n' })],
    ['no switch file at all: a.sh judged against the literal cd', 'export proj=/home/u; for i in 1 2; do source ./a.sh; source ./b.sh; done', stub({ '/home/u/proj/a.sh': body, '/home/u/proj/b.sh': 'echo hi\n' })],
    ['a harmless a.sh and a loop', 'export proj=/home/u; for i in 1 2; do source ./a.sh; source ./sw.sh; done', stub({ '/home/u/proj/a.sh': 'echo hi\n', '/home/u/proj/sw.sh': 'setopt cdablevars\n' })],
  ]);
});

describe('R15-F3: BASHOPTS / SHELLOPTS reach every child shell', () => {
  denies('F3', [
    ['env prefix on bash -c', 'proj=/home/u BASHOPTS=cdable_vars bash -c \'cd proj && find . -delete\''],
    ['env NAME=value bash FILE', 'env BASHOPTS=cdable_vars proj=/home/u bash ./a.sh', A],
    ['shopt, export BASHOPTS, then bash FILE', 'shopt -s cdable_vars; export BASHOPTS; export proj=/home/u; bash ./a.sh', A],
    ['plain assignment, then bash -c', 'BASHOPTS=cdable_vars; export BASHOPTS proj=/home/u; bash -c \'cd proj && find . -delete\''],
    ['export BASHOPTS=value', 'export BASHOPTS=cdable_vars proj=/home/u; bash -c \'cd proj && find . -delete\''],
    ['declare -x BASHOPTS=value', 'declare -x BASHOPTS=cdable_vars; export proj=/home/u; bash -c \'cd proj && find . -delete\''],
    ['typeset -x BASHOPTS', 'typeset -x BASHOPTS=cdable_vars; export proj=/home/u; bash ./a.sh', A],
    ['SHELLOPTS prefix on bash FILE', 'proj=/home/u SHELLOPTS=posix bash ./a.sh', A],
    ['any value counts (BASHOPTS=)', 'proj=/home/u BASHOPTS= bash -c \'cd proj && find . -delete\''],
    ['sh -c with the env prefix', 'proj=/home/u BASHOPTS=cdable_vars sh -c \'cd proj && find . -delete\''],
    ['the hook environment holds BASHOPTS with cdable_vars', 'export proj=/home/u; bash -c \'cd proj && find . -delete\'', { cwd: `${HOME}/proj`, env: { BASHOPTS: 'cmdhist:cdable_vars:extglob' } }],
    ['a sourced file exports BASHOPTS, a child bash judged earlier in a loop', 'export proj=/home/u; for i in 1 2; do bash ./a.sh; source ./sw.sh; done', stub({ '/home/u/proj/a.sh': body, '/home/u/proj/sw.sh': 'export BASHOPTS=cdable_vars\n' })],
    ['a name built at run time on export', 'N=BASHOPTS; export $N=cdable_vars proj=/home/u; bash ./a.sh', A],
    ['the hook environment holds BASHOPTS, bash FILE', 'export proj=/home/u; bash ./a.sh', stub({ '/home/u/proj/a.sh': body }, { env: { BASHOPTS: 'cdable_vars' } })],
  ]);
  allows('F3', [
    ['reading BASHOPTS is no switch', 'echo "$BASHOPTS"; export proj=/home/u; bash ./a.sh', A],
    ['a hook environment without BASHOPTS: bash FILE', 'export proj=/home/u; bash ./a.sh', A],
    ['no BASHOPTS: a separate shell (bash FILE) does not inherit the line\'s switch', 'set -T; export proj=/home/u; bash ./a.sh', A],
    ['a hook environment BASHOPTS without cdable_vars', 'export proj=/home/u; bash -c \'cd proj && find . -delete\'', { cwd: `${HOME}/proj`, env: { BASHOPTS: 'cmdhist:extglob' } }],
    ['a harmless child with BASHOPTS set', 'BASHOPTS=cdable_vars bash -c \'echo hi\''],
  ]);
});
