// PR #288 round 18 (owner rule: fail closed, remove whole classes of risk, whitelists over spelling lists).
//   R18-B1/F1/F7  a frame that can repeat (loop, function, trap, and a file sourced from one): ANY relative cd (incl. `..`, `../x`, `./x`) leaves the directory UNKNOWN; a rerun that finds
//                 an unknown directory runs the assumed-directory pass; a rerun cap hit while directories were still gained is unknown too
//   R18-F2  chdir is a cd again (same whitelist)          R18-F3  zsh: `-O` is a plain flag, only lowercase `-o` takes a name
//   R18-F4  startup options: the union of the bash and the zsh reading     R18-F5  tilde words (`~h`, `~u`, `~-`, `~+`, `~N`) as an AUTO_CD command word
//   R18-F6  a command word may be lone when its arguments may vanish; a sourced file's own assignments decide its `$D` command word
//   R18-F8  AUTO_CD fires for a command with no surviving argument only (`test -f x`, `supabase db reset`, `docs build` are not directory words)
// Home is /home/u; the cwd is /home/u/proj unless a case says otherwise.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateBashForFiles } from '../pipeline/hooks/lib/files-policy.mjs';

const HOME = '/home/u';
const BASE = { home: HOME, env: {}, platform: 'linux', cwd: HOME, realpath: (p) => p, existsSync: () => false, readText: () => null };
const run = (command, extra = {}) => evaluateBashForFiles(command, { ...BASE, ...extra });
const PROJ = { cwd: `${HOME}/proj` };
// files: path -> text; extra.dirs: directories that exist (listed empty)
const fsx = (files, extra = {}) => {
  const dirs = new Set(extra.dirs ?? []);
  const { dirs: _d, ...rest } = extra;
  return { cwd: `${HOME}/proj`, readText: (p) => files[p] ?? null, existsSync: (p) => Object.hasOwn(files, p) || dirs.has(p), readDir: (p) => (dirs.has(p) ? [] : null), ...rest };
};
const EVIL = 'rm -f /home/u/.claude/settings.json\n'; // (a protected write: the settings file)
const OK = 'echo hi\n';

const denies = (label, cases) => {
  for (const [name, line, extra] of cases) {
    test(`#288 R18 ${label} denies: ${name}`, () => {
      const r = run(line, extra ?? PROJ);
      assert.equal(r.decision, 'deny', `${JSON.stringify(line)} -> ${r.decision}`);
    });
  }
};
const allows = (label, cases) => {
  for (const [name, line, extra] of cases) {
    test(`#288 R18 ${label} allows: ${name}`, () => {
      const r = run(line, extra ?? PROJ);
      assert.equal(r.decision, 'allow', `${JSON.stringify(line)} -> ${r.decision}: ${r.reason}`);
    });
  }
};

const DEEP = `${HOME}/a/b/c/d/e`; // (five levels below home: the cwd + 2 parents never reach home)

describe('R18-B1: a sourced `cd ..` in a loop climbs one level per iteration', () => {
  const up = (extra = {}) => fsx({ [`${DEEP}/up.sh`]: 'cd ..\n', [`${HOME}/write.sh`]: 'rm -f .claude/settings.json\n', ...extra }, { cwd: DEEP });
  denies('B1', [
    ['for: source up.sh (absolute), bash ./write.sh', `for i in 1 2 3 4 5; do source ${DEEP}/up.sh; bash ./write.sh; done`, up()],
    ['while: the same', `while true; do source ${DEEP}/up.sh; bash ./write.sh; done`, up()],
    ['for: cd ../x in the sourced file', `for i in 1 2 3 4 5; do source ${DEEP}/up.sh; bash ./write.sh; done`, up({ [`${DEEP}/up.sh`]: 'cd ../x\n' })],
    ['for: cd ./x in the sourced file', `for i in 1 2 3 4 5; do source ${DEEP}/up.sh; bash ./write.sh; done`, up({ [`${DEEP}/up.sh`]: 'cd ./x\n' })],
    ['a function called several times', `f() { source ${DEEP}/up.sh; bash ./write.sh; }; f; f; f; f; f`, up()],
    ['a file that sources the climbing file', `for i in 1 2 3 4 5; do source ${DEEP}/wrap.sh; bash ./write.sh; done`, up({ [`${DEEP}/wrap.sh`]: `. ${DEEP}/up.sh\n` })],
    ['a loop inside the sourced file', `source ${DEEP}/loop.sh; bash ./write.sh`, up({ [`${DEEP}/loop.sh`]: 'for i in 1 2 3 4 5; do cd ..; done\n' })],
  ]);
  allows('B1', [
    ['a straight-line source of a relative cd', `source ${DEEP}/up.sh; bash ./ok.sh`, up({ [`${DEEP}/ok.sh`]: OK, [`${DEEP.replace(/\/e$/, '')}/ok.sh`]: OK })],
    ['a loop that sources a file with an absolute cd outside the protected set', `for i in 1 2; do source ${DEEP}/abs.sh; bash ./ok.sh; done`, up({ [`${DEEP}/abs.sh`]: 'cd /tmp/x\n', '/tmp/x/ok.sh': OK, [`${DEEP}/ok.sh`]: OK })],
    ['a loop of files that do not move', `for i in 1 2; do source ${DEEP}/ok.sh; done`, up({ [`${DEEP}/ok.sh`]: OK })],
  ]);
});

describe('R18-F1: an unknown cd first found in a RERUN gets the assumed-directory pass', () => {
  const P = `${HOME}/proj`;
  const mv = (first, second) => fsx({ [`${P}/a/b/mv.sh`]: first, [`${P}/a/mv.sh`]: second }, { cwd: `${P}/a/b`, dirs: [`${P}/a`, `${P}/a/b`] });
  denies('F1', [
    ['b/mv.sh = cd .., a/mv.sh = cd "$(cat /tmp/where)"', 'for i in 1 2 3; do rm -f settings.json; source ./mv.sh; done', mv('cd ..\n', 'cd "$(cat /tmp/where)"\n')],
    ['b/mv.sh = cd /abs/a (a known gain), a/mv.sh = unknown cd', 'for i in 1 2 3; do rm -f settings.json; source ./mv.sh; done', mv(`cd ${P}/a\n`, 'cd "$(cat /tmp/where)"\n')],
    ['b/mv.sh = cd /abs/a, a/mv.sh = eval of run-time text', 'for i in 1 2 3; do rm -f settings.json; source ./mv.sh; done', mv(`cd ${P}/a\n`, 'eval "$CMD"\n')],
  ]);
  const chain = (last) => fsx({
    [`${P}/m1.sh`]: `cd ${P}/d1\n`, [`${P}/d1/m1.sh`]: `cd ${P}/d2\n`, [`${P}/d2/m1.sh`]: `cd ${P}/d3\n`, [`${P}/d3/m1.sh`]: last,
  }, { dirs: [`${P}/d1`, `${P}/d2`, `${P}/d3`] });
  denies('F1 cap', [
    ['a chain of absolute cds longer than the rerun cap, the last one protected', 'for i in 1 2 3 4 5; do rm -f settings.json; source ./m1.sh; done', chain(`cd ${HOME}/.claude\n`)],
  ]);
  allows('F1', [
    ['a rerun that stays known', 'for i in 1 2 3; do rm -f build.tmp; source ./mv.sh; done', mv(`cd ${P}/a\n`, 'echo hi\n')],
  ]);
});

describe('R18-F7: the line\'s own repeat frames', () => {
  const D = { cwd: DEEP };
  denies('F7', [
    ['for ...; do cd ..; done; find . -delete', 'for i in 1 2 3 4 5; do cd ..; done; find . -delete', D],
    ['while :; do find . -delete; cd ..; done', 'while :; do find . -delete; cd ..; done', D],
    ['until: cd ..', 'until false; do find . -delete; cd ..; done', D],
    ['a function that climbs, called several times', 'f() { cd ..; }; f; f; f; f; find . -delete', D],
    ['cd ../x in a loop', 'for i in 1 2 3 4 5; do cd ../x; done; find . -delete', D],
    ['cd ./x in a loop', 'for i in 1 2 3 4 5; do cd ./x; done; find . -delete', D],
    ['pushd .. in a loop', 'for i in 1 2 3 4 5; do pushd ..; done; find . -delete', D],
    ['chdir .. in a loop', 'for i in 1 2 3 4 5; do chdir ..; done; find . -delete', D],
    ['a climb in a trap action', "trap 'cd ..' DEBUG; true; true; true; true; find . -delete", D],
  ]);
  allows('F7', [
    ['for f in *.md; do cat "$f"; done', 'for f in *.md; do cat "$f"; done'],
    ['a relative cd OUTSIDE the loop narrows', 'cd ./sub && for f in *; do rm -f "$f.tmp"; done'],
    ['a loop with absolute cd targets that are not protected', 'for i in 1 2; do cd /tmp/x; rm -f a.tmp; done'],
    ['a loop with cd . (no move)', 'for i in 1 2; do cd .; rm -f a.tmp; done'],
    ['cd .. outside a loop (one level: not protected)', 'cd .. && ls && for f in *.md; do cat "$f"; done'],
    ['a subshell with a cd in a straight line', '(cd ./sub && rm -f a.tmp)'],
  ]);
});

describe('R18-F2: chdir is a cd (the same whitelist)', () => {
  denies('F2', [
    ['chdir proj (a bare name)', 'chdir proj && find . -delete'],
    ['chdir proj after cdablevars is on', 'export proj=/home/u && setopt cdablevars && chdir proj && find . -delete'],
    ['chdir /home/u', 'chdir /home/u && find . -delete'],
    ['chdir .. twice', 'chdir ..; chdir ..; find . -delete', { cwd: `${HOME}/a/b` }],
    ['chdir -', 'chdir - && find . -delete'],
  ]);
  allows('F2', [
    ['chdir ./proj', 'chdir ./proj && rm -rf build'],
    ['chdir /home/u/proj/sub', 'chdir /home/u/proj/sub && find . -delete'],
  ]);
});

describe('R18-F3: zsh -O is a plain flag (only lowercase -o takes a name)', () => {
  const F = fsx({ '/home/u/proj/evil.sh': EVIL, '/home/u/proj/ok.sh': OK });
  denies('F3', [
    ['zsh -Oc TEXT', "zsh -Oc 'cd /home/u; find . -delete'"],
    ['zsh -O -c TEXT', "zsh -O -c 'cd /home/u; find . -delete'"],
    ['zsh -cO TEXT', "zsh -cO 'cd /home/u; find . -delete'"],
    ['zsh -Oc TEXT (a script file)', "zsh -Oc 'bash ./evil.sh'", F],
    ['zsh -O -c TEXT (a script file)', "zsh -O -c 'bash ./evil.sh'", F],
    ['zsh -cO TEXT (a script file)', "zsh -cO 'bash ./evil.sh'", F],
  ]);
  allows('F3', [
    ['zsh -Oc harmless', "zsh -Oc 'echo hi'"],
    ['zsh -O -c harmless', "zsh -O -c 'bash ./ok.sh'", F],
    ['bash -O extglob -c harmless', "bash -O extglob -c 'echo hi'"],
    ['bash -Oc extglob harmless', "bash -Oc extglob 'echo hi'"],
  ]);
});

describe('R18-F4: startup options: both readings', () => {
  const RC = (text) => fsx({ '/home/u/proj/d/.zshrc': text, '/home/u/proj/d/.zshenv': OK });
  denies('F4', [
    ['-oextendedglob then -i', 'ZDOTDIR=./d zsh -oextendedglob -i -c true', RC(EVIL)],
    ['-oextendedglob -c: the readings differ on login, both rc files are judged', 'ZDOTDIR=./d zsh -oextendedglob -c true', RC(EVIL)],
    ['-O then -i', 'ZDOTDIR=./d zsh -O -i -c true', RC(EVIL)],
  ]);
  allows('F4', [
    ['-o pipefail -c', 'ZDOTDIR=./d zsh -o pipefail -c true', RC(EVIL)],
    ['-obeep -c (both readings agree: not interactive)', 'ZDOTDIR=./d zsh -obeep -c true', RC(EVIL)],
    ['-oextendedglob -c with a harmless rc', 'ZDOTDIR=./d zsh -oextendedglob -c true', RC(OK)],
    ['-o pipefail -i with a harmless rc', 'ZDOTDIR=./d zsh -o pipefail -i -c true', RC(OK)],
  ]);
});

describe('R18-F5: a tilde command word may be a directory (AUTO_CD)', () => {
  denies('F5', [
    ['~h (zsh named directory)', 'setopt autocd; h=/home/u; ~h; find . -delete'],
    ['~u', '~u; find . -delete'],
    ['~-', '~-; find . -delete'],
    ['~+', '~+; find . -delete'],
    ['~1', '~1; find . -delete'],
  ]);
  allows('F5', [
    ['echo ~u (not a command word)', "echo ~u; find . -name '*.tmp' -delete"],
    ['~h with an argument', "~h build; find . -name '*.tmp' -delete"],
  ]);
});

describe('R18-F6: arguments that may vanish', () => {
  denies('F6a', [
    ['$CLAUDE_CONFIG_DIR $EMPTY; rm -f settings.json', '$CLAUDE_CONFIG_DIR $EMPTY; rm -f settings.json'],
    ['$D $(true)', '$D $(true); rm -f settings.json'],
    ['$D $@', '$D $@; rm -f settings.json'],
    ['$D ${X}', '$D ${X}; rm -f settings.json'],
    ['$D *.nomatch (a glob)', '$D *.nomatch; rm -f settings.json'],
    ['"$D" $EMPTY', '"$D" $EMPTY; rm -f settings.json'],
  ]);
  allows('F6a', [
    ['$D build (a surviving argument)', '$D build; rm -f build.tmp'],
    ['$D -v', '$D -v; rm -f build.tmp'],
  ]);
  denies('F6b', [
    ['a sourced file assigns the name its command word uses', 'D=git; source ./f.sh; find . -delete', fsx({ '/home/u/proj/f.sh': 'D=/home/u\n$D\n' })],
    ['a sourced file with a command-substitution word', 'source ./f.sh; find . -delete', fsx({ '/home/u/proj/f.sh': '$(pick)\n' })],
    ['a sourced file with a backtick word', 'source ./f.sh; find . -delete', fsx({ '/home/u/proj/f.sh': '`pick`\n' })],
  ]);
  allows('F6b', [
    ['a sourced file with a literal command and an argument', 'source ./f.sh; rm -f build.tmp', fsx({ '/home/u/proj/f.sh': 'echo build\n' })],
  ]);
});

describe('R18-F8: AUTO_CD needs a command with no surviving argument', () => {
  const dirs = [`${HOME}/proj/test`, `${HOME}/proj/supabase`, `${HOME}/proj/docs`];
  const X = fsx({}, { dirs });
  allows('F8', [
    ['test -f x && find . -name *.tmp -delete (test/ present)', "test -f x && find . -name '*.tmp' -delete", X],
    ['supabase db reset && find (supabase/ present)', "supabase db reset && find . -name '*.tmp' -delete", X],
    ['docs build (docs/ present)', 'docs build', X],
    ['docs build then a relative delete', 'docs build; rm -f out.tmp', X],
  ]);
  denies('F8', [
    ['a lone directory word still denies', 'docs; find . -delete', X],
    ['a directory word whose argument may vanish', 'docs $EMPTY; find . -delete', X],
  ]);
});
