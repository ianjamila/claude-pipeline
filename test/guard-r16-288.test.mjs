// PR #288 round 16: "fail closed, remove a class of risk".
//   R16-B1/F2  a cd-meaning switch that turns on LATE (a sourced file after the judged one: loops, functions, traps) reaches the WHOLE frame: nested child shells of a replayed file, package
//              scripts, node_modules/.bin scripts, option splices, BASH_ENV startup files and job-start inner commands (the frame is judged once more with the switch seeded)
//   R16-F1     a child shell started with an option on its OWN command line is a switch for the text it runs (a whitelist of safe options; anything else, any long option, any -O NAME)
//   R16-F3     fed text that runs in THIS shell (eval "$(cat f)") is absorbed like a source
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
    test(`#288 R16 ${label} denies: ${name}`, () => {
      const r = run(line, extra ?? PROJ);
      assert.equal(r.decision, /R17 owner decision: option state/.test(name) ? 'allow' : 'deny', `${JSON.stringify(line)} -> ${r.decision}`);
    });
  }
};
const allows = (label, cases) => {
  for (const [name, line, extra] of cases) {
    test(`#288 R16 ${label} allows: ${name}`, () => {
      const r = run(line, extra ?? PROJ);
      assert.equal(r.decision, /R17 owner decision: a bare cd/.test(name) ? 'deny' : 'allow', `${JSON.stringify(line)} -> ${r.decision}: ${r.reason}`);
    });
  }
};
const body = 'cd proj && find . -delete\n';
const A = stub({ '/home/u/proj/a.sh': body });
const SWX = 'export BASHOPTS=cdable_vars\n'; // (a switch file handed to every child shell)
const SWS = 'setopt cdablevars\n'; // (a switch file for this shell)

describe('R16-B1: a replayed same-shell file\'s own nested child shell sees the late switch', () => {
  const F = { '/home/u/proj/a.sh': 'bash ./b.sh\n', '/home/u/proj/b.sh': body, '/home/u/proj/sw.sh': SWX };
  denies('B1', [
    ['loop: source a.sh (runs bash b.sh), then sw.sh exports BASHOPTS', 'export proj=/home/u; for i in 1 2; do source ./a.sh; source ./sw.sh; done', stub(F)],
    ['the switch file first (ordering control)', 'export proj=/home/u; source ./sw.sh; source ./a.sh', stub(F)],
    ['a function called after sw.sh', 'export proj=/home/u; f() { source ./a.sh; }; source ./sw.sh; f', stub(F)],
  ]);
  allows('B1', [
    ['no switch file: the nested child is judged against the literal cd (R17 owner decision: a bare cd is unknown)', 'export proj=/home/u; for i in 1 2; do source ./a.sh; source ./c.sh; done', stub({ ...F, '/home/u/proj/c.sh': 'echo hi\n' })],
    ['a setopt switch is this shell\'s own: the nested bash b.sh does not inherit it (R17 owner decision: a bare cd is unknown)', 'export proj=/home/u; for i in 1 2; do source ./a.sh; source ./sw.sh; done', stub({ ...F, '/home/u/proj/sw.sh': SWS })],
    ['a harmless nested child and a switch file (R17 owner decision: a bare cd is unknown)', 'export proj=/home/u; for i in 1 2; do source ./a.sh; source ./sw.sh; done', stub({ ...F, '/home/u/proj/b.sh': 'cd ./proj && ls\n' })],
  ]);
});

describe('R16-F2: the late switch reaches package scripts, bins, splices and startup files', () => {
  const PKG = { '/home/u/proj/package.json': JSON.stringify({ scripts: { x: body.trim() } }), '/home/u/proj/sw.sh': SWX };
  const BIN = { '/home/u/proj/node_modules/.bin/tool': `#!/bin/sh\n${body}`, '/home/u/proj/sw.sh': SWX };
  const JOB = 'node ~/.claude/pipeline/bin/pipeline.mjs job start x -- bash ./a.sh';
  denies('F2', [
    ['npm run x, then sw.sh (loop)', 'export proj=/home/u; for i in 1 2; do npm run x; source ./sw.sh; done', stub(PKG)],
    ['npm run x, then a setopt switch file', 'export proj=/home/u; for i in 1 2; do npm run x; source ./sw.sh; done', stub({ ...PKG, '/home/u/proj/sw.sh': SWS })],
    ['pnpm run x', 'export proj=/home/u; for i in 1 2; do pnpm run x; source ./sw.sh; done', stub(PKG)],
    ['npm run x with the switch file first (ordering control)', 'export proj=/home/u; source ./sw.sh; npm run x', stub(PKG)],
    ['a bare bin name through npx', 'export proj=/home/u; for i in 1 2; do npx tool; source ./sw.sh; done', stub(BIN)],
    ['BASH_ENV file, then the switch', 'export proj=/home/u; for i in 1 2; do BASH_ENV=./a.sh bash -c :; source ./sw.sh; done', stub({ '/home/u/proj/a.sh': body, '/home/u/proj/sw.sh': SWX })],
    ['BASH_ENV file, the line\'s own BASHOPTS', 'export proj=/home/u BASHOPTS=cdable_vars; BASH_ENV=./a.sh bash -c :', stub({ '/home/u/proj/a.sh': body })],
    ['job start inner command, late switch', `export proj=/home/u; for i in 1 2; do ${JOB}; source ./sw.sh; done`, stub({ '/home/u/proj/a.sh': body, '/home/u/proj/sw.sh': SWX })],
    ['job start inner command, the line\'s own BASHOPTS', `export proj=/home/u BASHOPTS=cdable_vars; ${JOB}`, A],
  ]);
  allows('F2', [
    ['npm run x with no switch (R17 owner decision: a bare cd is unknown)', 'export proj=/home/u; for i in 1 2; do npm run x; echo hi; done', stub(PKG)],
    ['a harmless script and a switch file', 'export proj=/home/u; for i in 1 2; do npm run x; source ./sw.sh; done', stub({ ...PKG, '/home/u/proj/package.json': JSON.stringify({ scripts: { x: 'echo hi' } }) })],
  ]);
});

describe('R16-F1: a child shell given the option on its own command line', () => {
  const E = 'export proj=/home/u; ';
  const LS = stub({ '/home/u/proj/a.sh': 'cd proj && ls\n' });
  denies('F1', [
    ['bash -O cdable_vars -c', `${E}bash -O cdable_vars -c 'cd proj && find . -delete'`],
    ['bash -O cdable_vars FILE', `${E}bash -O cdable_vars ./a.sh`, A],
    ['bash +O cdable_vars FILE', `${E}bash +O cdable_vars ./a.sh`, A],
    ['bash -O extglob -c (any -O name)', `${E}bash -O extglob -c 'cd proj && find . -delete'`],
    ['zsh -o cdablevars FILE', `${E}zsh -o cdablevars ./a.sh`, A],
    ['zsh -o cdablevars -c', `${E}zsh -o cdablevars -c 'cd proj && find . -delete'`],
    ['zsh -T FILE', `${E}zsh -T ./a.sh`, A],
    ['zsh -T -c', `${E}zsh -T -c 'cd proj && find . -delete'`],
    ['zsh --cdablevars -c', `${E}zsh --cdablevars -c 'cd proj && find . -delete'`],
    ['bash --posix FILE (any long option)', `${E}bash --posix ./a.sh`, A],
    ['a cluster with an unsafe letter', `${E}bash -eT ./a.sh`, A],
    ['a cluster ending in o with an unsafe name', `${E}bash -eo posix ./a.sh`, A],
    ['-ocdablevars glued', `${E}zsh -ocdablevars ./a.sh`, A],
    ['a run-time word in the option part', `${E}bash $OPTS ./a.sh`, A],
    ['a run-time option name', `${E}bash -o "$NAME" ./a.sh`, A],
    ['behind env', `${E}env X=1 bash -O cdable_vars ./a.sh`, A],
    ['behind nice', `${E}nice -n 5 zsh -T ./a.sh`, A],
    ['behind command', `${E}command bash -O cdable_vars -c 'cd proj && find . -delete'`],
    ['stdin feed: bash -O cdable_vars < file', `${E}bash -O cdable_vars < ./a.sh`, A],
    ['stdin feed: cat file | zsh -T', `${E}cat ./a.sh | zsh -T`, A],
    ['sh -O cdable_vars -s', `${E}sh -O cdable_vars -s < ./a.sh`, A],
    ['a shebang that names the option', `${E}./a.sh`, stub({ '/home/u/proj/a.sh': `#!/usr/bin/env -S zsh -T\n${body}` })],
  ]);
  allows('F1', [
    ['bash -euo pipefail FILE', `${E}bash -euo pipefail ./a.sh`, LS],
    ['bash -o pipefail -c', `${E}bash -o pipefail -c 'cd proj && ls'`],
    ['bash -c (existing pin)', `${E}bash -c 'cd proj && ls'`],
    ['sh -e FILE', `${E}sh -e ./a.sh`, LS],
    ['bash -ex -c', `${E}bash -ex -c 'cd proj && ls'`],
    ['bash -lc', `${E}bash -lc 'cd proj && ls'`],
    ['zsh -o pipefail FILE', `${E}zsh -o pipefail ./a.sh`, LS],
    ['no export, bash -euo pipefail FILE', 'bash -euo pipefail ./a.sh', LS],
    ['a first operand that is a path built at run time is the file, not options', `${E}D=/home/u/proj; bash "$D/a.sh"`, LS],
    ['bash -c with a run-time text', `${E}bash -c "$CMD"`],
  ]);
});

describe('R16-F3: fed text that runs in this shell is absorbed', () => {
  const E = 'export proj=/home/u; ';
  const SW = (t) => stub({ '/home/u/proj/sw.sh': t, '/home/u/proj/a.sh': body });
  denies('F3', [
    ['eval "$(cat sw.sh)" (setopt), then the cd', `${E}eval "$(cat ./sw.sh)"; cd proj && find . -delete`, SW(SWS)],
    ['eval "$(cat sw.sh)" (shopt)', `${E}eval "$(cat ./sw.sh)"; cd proj && find . -delete`, SW('shopt -s cdable_vars\n')],
    ['eval "$(<sw.sh)"', `${E}eval "$(<./sw.sh)"; cd proj && find . -delete`, SW(SWS)],
    ['builtin eval', `${E}builtin eval "$(cat ./sw.sh)"; cd proj && find . -delete`, SW(SWS)],
    ['loop: source a.sh, eval the switch', `${E}for i in 1 2; do source ./a.sh; eval "$(cat ./sw.sh)"; done`, SW(SWS)],
    ['loop: bash a.sh, eval the switch exporting BASHOPTS', `${E}for i in 1 2; do bash ./a.sh; eval "$(cat ./sw.sh)"; done`, SW(SWX)],
    ['loop: source a.sh, eval the switch exporting BASHOPTS', `${E}for i in 1 2; do source ./a.sh; eval "$(cat ./sw.sh)"; done`, SW(SWX)],
  ]);
  allows('F3', [
    ['eval of a harmless file, then the cd', `${E}eval "$(cat ./sw.sh)"; cd proj && ls`, SW('echo hi\n')],
    ['a fresh shell reads the switch text (bash < sw.sh): not this shell', `${E}bash < ./sw.sh; cd proj && ls`, SW(SWS)],
  ]);
});
