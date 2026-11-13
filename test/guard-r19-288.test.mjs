// PR #288 round 19 (owner decisions 2026-11-13: the guard defends against accidental mistakes and casual one-step disguise; constructed tricks go to issue #373).
//   R19-B1  a bare `chdir` is a bare `cd` (it goes home), and chdir narrows like cd
//   owner   a plain `cd NAME` narrows again (like `./NAME`), unless CDPATH is set in the hook's environment or assigned on the line / in a sourced file
//   R19-F1  the repeat-frame rule (loop / function / trap) is for a `..` target outside a subshell only
//   R19-F2  a double-quoted argument never vanishes (`"$PYTHON" "$SCRIPT"; rm -f out.tmp`)
// Home is /home/u; the cwd is /home/u/proj unless a case says otherwise.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateBashForFiles } from '../pipeline/hooks/lib/files-policy.mjs';

const HOME = '/home/u';
const BASE = { home: HOME, env: {}, platform: 'linux', cwd: HOME, realpath: (p) => p, existsSync: () => false, readText: () => null };
const run = (command, extra = {}) => evaluateBashForFiles(command, { ...BASE, ...extra });
const PROJ = { cwd: `${HOME}/proj` };
const DEEP = { cwd: `${HOME}/a/b/c/d/proj` };
const HOMECWD = { cwd: HOME };
const fsx = (files, extra = {}) => ({ cwd: `${HOME}/proj`, readText: (p) => files[p] ?? null, existsSync: (p) => Object.hasOwn(files, p), ...extra });

const denies = (label, cases) => {
  for (const [name, line, extra] of cases) {
    test(`#288 R19 ${label} denies: ${name}`, () => {
      const r = run(line, extra ?? PROJ);
      assert.equal(r.decision, 'deny', `${JSON.stringify(line)} -> ${r.decision}`);
    });
  }
};
const allows = (label, cases) => {
  for (const [name, line, extra] of cases) {
    test(`#288 R19 ${label} allows: ${name}`, () => {
      const r = run(line, extra ?? PROJ);
      assert.equal(r.decision, 'allow', `${JSON.stringify(line)} -> ${r.decision}: ${r.reason}`);
    });
  }
};

describe('R19-B1: a bare chdir goes home like a bare cd', () => {
  denies('B1', [
    ['chdir; find . -delete', 'chdir; find . -delete'],
    ['chdir --; find . -delete', 'chdir --; find . -delete'],
    ['chdir && find . -delete', 'chdir && find . -delete'],
  ]);
  test('#288 R19 B1 parity: chdir behaves like cd', () => {
    for (const tail of ['; find . -delete', ' && rm -rf dist', ' ./x && rm -rf dist', ' proj && rm -rf dist', ' /home/u && find . -delete']) {
      for (const extra of [PROJ, DEEP, HOMECWD]) {
        const a = run(`cd${tail}`, extra);
        const b = run(`chdir${tail}`, extra);
        assert.equal(b.decision, a.decision, `${JSON.stringify(tail)} from ${extra.cwd}: cd -> ${a.decision}, chdir -> ${b.decision}`);
      }
    }
  });
  allows('B1', [
    ['chdir ./x && rm -rf dist (parity with cd ./x)', 'chdir ./x && rm -rf dist'],
    ['cd ./x && rm -rf dist', 'cd ./x && rm -rf dist'],
  ]);
});

describe('owner (R19): a plain `cd NAME` narrows like `./NAME` unless CDPATH is set', () => {
  const EVERYDAY = [
    ['cd proj && rm -rf dist', 'cd proj && rm -rf dist'],
    ['cd proj && git stash -u', 'cd proj && git stash -u'],
    ['cd proj && git reset --hard', 'cd proj && git reset --hard'],
    ['cd proj && git checkout -- .', 'cd proj && git checkout -- .'],
    ['cd proj && git add .', 'cd proj && git add .'],
    ['cd web/app && rm -rf dist', 'cd web/app && rm -rf dist'],
    ['mkdir -p out && cd out && rm -rf *.tmp', 'mkdir -p out && cd out && rm -rf *.tmp'],
  ];
  for (const [label, cwd] of [['deep cwd', DEEP], ['home cwd', HOMECWD]]) allows(`plain name (${label})`, EVERYDAY.map(([n, l]) => [n, l, cwd]));
  // (a bare `*` from the cwd /home/u itself is denied by main for ANY cd target, `cd /home/u/out && rm -rf *` included: not part of this rule)
  allows('plain name (deep cwd)', [['mkdir -p out && cd out && rm -rf *', 'mkdir -p out && cd out && rm -rf *', DEEP]]);
  denies('CDPATH in the hook environment', [
    ['cd proj && rm -rf dist', 'cd proj && rm -rf dist', { ...PROJ, env: { CDPATH: '.:/home/u' } }],
    ['cd proj && git reset --hard (home cwd)', 'cd proj && find . -delete', { ...HOMECWD, env: { CDPATH: '/home/u/.claude' } }],
  ]);
  allows('an empty CDPATH', [['cd proj && rm -rf dist', 'cd proj && rm -rf dist', { ...PROJ, env: { CDPATH: '' } }]]);
  denies('CDPATH on the line', [
    ['export CDPATH', 'export CDPATH=/home/u/.claude; cd proj && find . -delete', HOMECWD],
    ['an inline assignment', 'CDPATH=/home/u/.claude cd proj && find . -delete', HOMECWD],
    ['a sourced file assigns it', 'source ./env.sh; cd proj && find . -delete', fsx({ [`${HOME}/env.sh`]: 'export CDPATH=/home/u/.claude\n' }, HOMECWD)],
  ]);
  denies('a plain name that leads somewhere protected', [
    ['cd .claude && rm -f settings.json (from home)', 'cd .claude && rm -f settings.json', HOMECWD],
    ['cd .claude/skills && rm -rf x (from home)', 'cd .claude/skills && rm -rf x', HOMECWD],
  ]);
  denies('a bare cd with no target still goes home', [['cd; find . -delete', 'cd; find . -delete']]);
});

describe('R19-F1: a relative cd in a loop / function narrows unless it climbs (`..`) outside a subshell', () => {
  allows('F1', [
    ['a subshell cd ./web inside a loop', 'for i in 1 2 3; do (cd ./web && rm -rf dist && npm run build) && break; done'],
    ['a function with cd ./web', 'build() { cd ./web && rm -rf dist; }; build'],
    ['a function with cd web', 'build() { cd web && rm -rf dist; }; build'],
    ['a loop with cd web/app', 'for d in a b; do cd web/app && rm -rf dist; done'],
    ['a subshell with cd ../web in a loop', 'for i in 1 2 3; do (cd ../web && rm -rf dist); done'],
  ]);
  denies('F1', [
    ['for i in 1..5; do cd ..; done; find . -delete', 'for i in 1 2 3 4 5; do cd ..; done; find . -delete', DEEP],
    ['a function that climbs, called several times', 'f() { cd ..; }; f; f; f; f; find . -delete', DEEP],
    ['cd ../x in a loop', 'for i in 1 2 3 4 5; do cd ../x; done; find . -delete', DEEP],
  ]);
});

describe('R19-F2: a double-quoted argument never vanishes', () => {
  allows('F2', [
    ['"$PYTHON" "$SCRIPT"; rm -f out.tmp', '"$PYTHON" "$SCRIPT"; rm -f out.tmp'],
    ['$RUNNER "$f"; rm -f out.tmp', '$RUNNER "$f"; rm -f out.tmp'],
    ['$RUNNER "$@"; rm -f out.tmp', '$RUNNER "$@"; rm -f out.tmp'],
  ]);
  denies('F2', [
    ['$D $EMPTY (unquoted)', '$D $EMPTY; rm -f settings.json'],
    ['"$D" $EMPTY (the argument is unquoted)', '"$D" $EMPTY; rm -f settings.json'],
    ['$D *.nomatch (a glob)', '$D *.nomatch; rm -f settings.json'],
  ]);
});

// ---- R20: a CDPATH learned from a sourced file reaches child frames and later cds ----
describe('R20: a CDPATH set by a sourced file is seen by what runs after it', () => {
  const SKILLS = `${HOME}/.claude/skills`;
  const withFs = (files) => ({ ...fsx(files), existsSync: (p) => Object.hasOwn(files, p) || p === SKILLS });
  const CD_FILES = {
    [`${HOME}/proj/env.sh`]: 'export CDPATH=/home/u/lib\n',
    [`${HOME}/proj/clean.sh`]: 'cd skills && find . -delete\n',
  };
  denies('R20-B2', [
    ['source env.sh then bash ./clean.sh', 'source ./env.sh; bash ./clean.sh', withFs(CD_FILES)],
    ['source env.sh then bash -c', "source ./env.sh; bash -c 'cd skills && find . -delete'", withFs(CD_FILES)],
  ]);
  denies('R20-F1', [
    ['a nested `. /abs/env.sh` sets CDPATH before a later plain cd',
      'source ./outer.sh; find . -delete',
      withFs({ [`${HOME}/proj/outer.sh`]: '. /home/u/proj/env.sh\ncd skills\n', [`${HOME}/proj/env.sh`]: 'export CDPATH=/home/u/lib\n' })],
  ]);
  allows('R20 (no CDPATH anywhere)', [
    ['source env-plain.sh then bash ./clean.sh with a plain cd build',
      'source ./env-plain.sh; bash ./clean.sh',
      withFs({ [`${HOME}/proj/env-plain.sh`]: 'export FOO=1\n', [`${HOME}/proj/clean.sh`]: 'cd build && rm -rf out\n', [`${HOME}/proj/build`]: '' })],
  ]);
});

// ---- R21: the real home's startup file is judged with the CDPATH a sourced file set ----
describe('R21: ~/.zshenv sees a CDPATH learned from a sourced file', () => {
  const SKILLS = `${HOME}/.claude/skills`;
  const withFs = (files) => ({ ...fsx(files), existsSync: (p) => Object.hasOwn(files, p) || p === SKILLS });
  denies('R21-F1', [
    ['source env.sh then zsh -c : with ~/.zshenv doing a plain cd',
      'source ./env.sh; zsh -c :',
      withFs({ [`${HOME}/proj/env.sh`]: 'export CDPATH=/home/u/lib\n', [`${HOME}/.zshenv`]: 'cd skills && find . -delete\n' })],
  ]);
  allows('R21 (no CDPATH anywhere)', [
    ['source env-plain.sh then zsh -c : with ~/.zshenv doing a plain cd into a project folder',
      'source ./env-plain.sh; zsh -c :',
      withFs({ [`${HOME}/proj/env-plain.sh`]: 'export FOO=1\n', [`${HOME}/.zshenv`]: 'cd build && rm -rf out\n', [`${HOME}/proj/build`]: '' })],
  ]);
});
