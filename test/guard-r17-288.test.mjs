// PR #288 round 17: "one whitelist instead of chasing option spellings" (owner decision 11-13).
//   A cd / pushd target narrows the working directory ONLY when, after the line's known variable expansion, it is `.` / `..` or starts with `/`, `./` or `../` (and the home forms keep their handling).
//   Every other target (`cd proj`, `cd proj/sub`, `~user`, `-`, a run-time value) leaves the directory UNKNOWN, so cdable_vars / CDPATH / their spellings no longer matter.
//   R17-B1  a startup file with the launching shell's -O                 R17-F2  a copied file run with and without the option
//   R17-F1  (parser) every o / O in an option cluster takes a word       R17-F3  a bin whose shebang is `zsh -T`           R17-F4  a shebang `env -S BASHOPTS=.. bash`
//   R17-F5  a run-time option word                                      R17-F6  eval of a wrapper that sources a switch   R17-F7  a loop: a later sourced file moves the directory the earlier one was judged in
// Home is /home/u; the cwd is /home/u/proj unless a case says otherwise.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateBashForFiles } from '../pipeline/hooks/lib/files-policy.mjs';
import { scriptFileOf } from '../pipeline/hooks/lib/shell-parse.mjs';

const HOME = '/home/u';
const BASE = { home: HOME, env: {}, platform: 'linux', cwd: HOME, realpath: (p) => p, existsSync: () => false, readText: () => null };
const run = (command, extra = {}) => evaluateBashForFiles(command, { ...BASE, ...extra });
const PROJ = { cwd: `${HOME}/proj` };
const stub = (files, extra = {}) => ({ cwd: `${HOME}/proj`, readText: (p) => files[p] ?? null, existsSync: (p) => Object.hasOwn(files, p), ...extra });

const denies = (label, cases) => {
  for (const [name, line, extra] of cases) {
    test(`#288 R17 ${label} denies: ${name}`, () => {
      const r = run(line, extra ?? PROJ);
      assert.equal(r.decision, /R19 owner decision|R19-F1|R19-B1/.test(name) ? 'allow' : 'deny', `${JSON.stringify(line)} -> ${r.decision}`);
    });
  }
};
const allows = (label, cases) => {
  for (const [name, line, extra] of cases) {
    test(`#288 R17 ${label} allows: ${name}`, () => {
      const r = run(line, extra ?? PROJ);
      assert.equal(r.decision, 'allow', `${JSON.stringify(line)} -> ${r.decision}: ${r.reason}`);
    });
  }
};
const body = 'cd proj && find . -delete\n';
const A = stub({ '/home/u/proj/a.sh': body });
const E = 'export proj=/home/u; ';
const SWX = 'export BASHOPTS=cdable_vars\n';
const SWS = 'setopt cdablevars\n';
const EVIL = 'rm -f /home/u/.claude/settings.json\n'; // (a protected write: the settings file)
const OK = 'echo hi\n';

describe('R17 owner decision: a cd target narrows only when it is . or .. or starts with /, ./ or ../', () => {
  denies('cd rule', [
    ['bare name, no export (R19 owner decision: a plain cd name narrows unless CDPATH is set)', 'cd proj && find . -delete'],
    ['bare name with a sub path (R19 owner decision: a plain cd name narrows unless CDPATH is set)', 'cd proj/sub && find . -delete'],
    ['bare name that is a variable name (cdable_vars) (R19 owner decision: a plain cd name narrows unless CDPATH is set)', `${E}cd proj && find . -delete`],
    ['bare name, CDPATH in the environment', 'export CDPATH=/home/u; cd proj && find . -delete'],
    ['pushd with a bare name (R19 owner decision: a plain cd name narrows unless CDPATH is set)', 'pushd proj && find . -delete'],
    ['cd -- NAME (R19 owner decision: a plain cd name narrows unless CDPATH is set)', 'cd -- proj && find . -delete'],
    ['cd ~user', 'cd ~root && find . -delete'],
    ['cd -', 'cd - && find . -delete'],
    ['a name held in a variable (R19 owner decision: a plain cd name narrows unless CDPATH is set)', 'D=proj; cd $D && find . -delete'],
    ['a bare name inside a sourced file (R19 owner decision: a plain cd name narrows unless CDPATH is set)', `source ./a.sh`, A],
    ['a bare name in a file bash runs (R19 owner decision: a plain cd name narrows unless CDPATH is set)', `bash ./a.sh`, A],
    ['a bare name in a -c text (R19 owner decision: a plain cd name narrows unless CDPATH is set)', `bash -c 'cd proj && find . -delete'`],
  ]);
  allows('cd rule', [
    ['cd ./proj and a delete of a build folder', 'cd ./proj && rm -rf build'],
    ['cd ./proj then find . -delete (a folder below the project)', 'cd ./proj && find . -delete'],
    ['absolute below the project', 'cd /home/u/proj/sub && find . -delete'],
    ['cd .. then a read', 'cd .. && ls'],
    ['cd ../x', 'cd ../x && ls'],
    ['cd . then find . -delete (the project itself)', 'cd . && find . -delete'],
    ['pushd ./proj', 'pushd ./proj && rm -rf build'],
    ['CDPATH does not apply to ./NAME', 'export CDPATH=/home/u; cd ./proj && find . -delete'],
    ['cdable_vars does not apply to ./NAME', `${E}setopt cdablevars; cd ./proj && find . -delete`],
    ['a bare name with a read-only command only', 'cd proj && ls'],
    ['a variable that holds an absolute path', 'D=/home/u/proj/sub; cd $D && find . -delete'],
    ['a file with ./NAME', 'bash ./a.sh', stub({ '/home/u/proj/a.sh': 'cd ./proj && rm -rf build\n' })],
    ['set -euo pipefail does not matter', 'set -euo pipefail; cd ./proj && rm -rf build'],
  ]);
  test('#288 R17 the deny reason for a bare cd names the fix (R19 owner decision: with CDPATH set)', () => {
    const r = run('cd proj && find . -delete', { ...PROJ, env: { CDPATH: '/home/u' } });
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /\.\/NAME/);
    assert.match(r.reason, /absolute path/);
  });
});

describe('R17 AUTO_CD (a command word that is a directory runs a cd): the word decides, not the option', () => {
  // (/home/u/proj/proj and /home/u/proj/x are directories; build.sh is a file)
  const DIRSET = new Set(['/home/u/proj/proj', '/home/u/proj/x']);
  const fsx = (files = {}) => ({ cwd: '/home/u/proj', readText: (p) => files[p] ?? null, existsSync: (p) => Object.hasOwn(files, p) || DIRSET.has(p), readDir: (p) => (DIRSET.has(p) ? [] : null) });
  const FB = fsx({ '/home/u/proj/build.sh': 'echo build\n' });
  denies('autocd', [
    ['setopt autocd, .. runs a cd', 'setopt autocd; ..; find . -delete'],
    ['options[autocd]=on, ..', 'options[autocd]=on; ..; find . -delete'],
    ['shopt -s autocd, a directory word', 'shopt -s autocd; proj; find . -delete', FB],
    ['BASHOPTS=autocd, a directory word', 'export BASHOPTS=autocd; bash -c "proj; find . -delete"', FB],
    ['bash -O autocd -c', "bash -O autocd -c 'proj && find . -delete'", FB],
    ['zsh -o autocd -c', "zsh -o autocd -c 'proj && find . -delete'", FB],
    ['zsh -J -c', "zsh -J -c 'proj && find . -delete'", FB],
    ['no option at all: the word is enough', 'proj; find . -delete', FB],
    ['a word ending in a slash', 'proj/; find . -delete', FB],
    ['a lone dot-dot', '..; find . -delete'],
    ['an absolute directory word', '/home/u/proj/x; find . -delete', FB],
    ['a directory made earlier on the line (mkdir)', 'mkdir x; x; find . -delete'],
    ['a directory made earlier on the line (mkdir -p a/b, word a)', 'mkdir -p a/b; a; find . -delete'],
    ['a directory made earlier on the line (cp -r / mv / git clone)', 'git clone https://h/r.git y; y; find . -delete'],
    ['a directory made earlier on the line (tar / unzip operand)', 'unzip a.zip z; z; find . -delete'],
    ['a run-time command word', '$D; find . -delete'],
    ['a command-substitution word', '$(pick); find . -delete'],
    ['a quoted run-time word', '"$D"; find . -delete'],
    ['a directory word in a sourced file', 'source ./sw.sh; find . -delete', stub({ '/home/u/proj/sw.sh': 'proj\n' }, { existsSync: (p) => DIRSET.has(p) || p === '/home/u/proj/sw.sh', readDir: (p) => (DIRSET.has(p) ? [] : null) })],
    ['a directory word in eval text run by bash -c', "bash -c 'eval proj; find . -delete'", FB],
  ]);
  allows('autocd', [
    ['git status', 'git status', FB],
    ['ls && ./build.sh (a file)', 'ls && ./build.sh', FB],
    ['npm test', 'npm test', FB],
    ['setopt of another option', 'setopt extendedglob; cd ./proj && rm -rf build', FB],
    ['no switch at all', 'echo hi; rm -rf build', FB],
    ['a known variable that holds a plain command name', 'G=git; $G status', FB],
  ]);
});

describe('R17-B1: the startup file of a shell started with -O cdable_vars', () => {
  const RC = stub({ '/home/u/proj/rc.sh': body });
  denies('B1', [
    ['BASH_ENV file, bash -O cdable_vars -c (R19 owner decision: a plain cd name narrows unless CDPATH is set)', `${E}BASH_ENV=./rc.sh bash -O cdable_vars -c :`, RC],
    ['BASH_ENV file, plain bash -c (R19 owner decision: a plain cd name narrows unless CDPATH is set)', `${E}BASH_ENV=./rc.sh bash -c :`, RC],
  ]);
  allows('B1', [
    ['BASH_ENV file with ./NAME', `${E}BASH_ENV=./rc.sh bash -O cdable_vars -c :`, stub({ '/home/u/proj/rc.sh': 'cd ./proj && rm -rf build\n' })],
  ]);
});

describe('R17-F1: every o / O in an option cluster takes the next word', () => {
  const F = stub({ '/home/u/proj/evil.sh': EVIL, '/home/u/proj/ok.sh': OK });
  denies('F1', [
    ['-oe pipefail FILE', 'bash -oe pipefail ./evil.sh', F],
    ['-ox pipefail FILE', 'bash -ox pipefail ./evil.sh', F],
    ['-Oe extglob FILE', 'bash -Oe extglob ./evil.sh', F],
    ['-oo pipefail errexit FILE', 'bash -oo pipefail errexit ./evil.sh', F],
    ['-abouo emacs ignoreeof FILE', 'bash -abouo emacs ignoreeof ./evil.sh', F],
    ['-oe pipefail then another option cluster', 'bash -oe pipefail -x ./evil.sh', F],
    ['sh -oe pipefail FILE', 'sh -oe pipefail ./evil.sh', F],
    ['-oc pipefail TEXT (the -c text is the word after the option name)', `bash -oc pipefail './evil.sh'`, F],
    ['-co pipefail TEXT', `bash -co pipefail './evil.sh'`, F],
    ['-oc pipefail TEXT (a text that writes through a variable)', `bash -oc pipefail 'bash ./evil.sh'`, F],
    ['a trailing cluster still skips its word: -eo pipefail FILE', 'bash -eo pipefail ./evil.sh', F],
  ]);
  allows('F1', [
    ['-o pipefail FILE', 'bash -o pipefail ./ok.sh', F],
    ['-euo pipefail FILE', 'bash -euo pipefail ./ok.sh', F],
    ['-oe pipefail FILE (harmless)', 'bash -oe pipefail ./ok.sh', F],
    ['-oo pipefail errexit FILE (harmless)', 'bash -oo pipefail errexit ./ok.sh', F],
    ['-o pipefail -c with a harmless text', `bash -o pipefail -c 'echo hi'`, F],
    ['-oc pipefail with a harmless text', `bash -oc pipefail 'echo hi'`, F],
  ]);
  test('#288 R17-F1 the parser: the bash reading and the zsh reading are both candidates', () => {
    const rec = scriptFileOf(['bash', '-oe', 'pipefail', './evil.sh']);
    assert.equal(rec.kind, 'shell');
    assert.equal(rec.ambiguous, true);
    assert.ok(rec.words.includes('./evil.sh'));
    const plain = scriptFileOf(['bash', '-euo', 'pipefail', './ok.sh']);
    assert.equal(plain.file, './ok.sh');
    assert.notEqual(plain.ambiguous, true);
  });
});

describe('R17-F2: a file copied and run with and without the option', () => {
  const F = { '/home/u/proj/a.sh': body, '/home/u/proj/sw.sh': SWS };
  denies('F2', [
    ['cp, run, run with -O cdable_vars (R19 owner decision: a plain cd name narrows unless CDPATH is set)', `${E}cp ./a.sh ./n.sh; bash ./n.sh; bash -O cdable_vars ./n.sh`, stub(F)],
    ['cp, loop: run, then the switch file', `${E}cp ./a.sh ./n.sh; for i in 1 2; do bash ./n.sh; source ./sw.sh; done`, stub(F)],
    ['cp, loop: run n.sh both ways (R19 owner decision: a plain cd name narrows unless CDPATH is set)', `${E}cp ./a.sh ./n.sh; for o in -O; do bash ./n.sh; bash $o cdable_vars ./n.sh; done`, stub(F)],
  ]);
});

describe('R17-F3 / F4: a shebang that names the option', () => {
  denies('F3', [
    ['node_modules/.bin/tool = #!/bin/zsh -T, npx tool (R19 owner decision: a plain cd name narrows unless CDPATH is set)', `${E}npx tool`, stub({ '/home/u/proj/node_modules/.bin/tool': `#!/bin/zsh -T\n${body}` })],
    ['npx tool, plain sh shebang (bare cd is unknown on its own) (R19 owner decision: a plain cd name narrows unless CDPATH is set)', `${E}npx tool`, stub({ '/home/u/proj/node_modules/.bin/tool': `#!/bin/sh\n${body}` })],
  ]);
  denies('F4', [
    ['#!/usr/bin/env -S BASHOPTS=cdable_vars bash (R19 owner decision: a plain cd name narrows unless CDPATH is set)', `${E}./a.sh`, stub({ '/home/u/proj/a.sh': `#!/usr/bin/env -S BASHOPTS=cdable_vars bash\n${body}` })],
  ]);
  allows('F3', [
    ['npx tool with ./NAME', `${E}npx tool`, stub({ '/home/u/proj/node_modules/.bin/tool': '#!/bin/zsh -T\ncd ./proj && rm -rf build\n' })],
  ]);
});

describe('R17-F5: options held in a run-time word', () => {
  denies('F5', [
    ['O=\'-O cdable_vars .\'; bash $O/a.sh (R19 owner decision: a plain cd name narrows unless CDPATH is set)', `${E}O='-O cdable_vars .'; bash $O/a.sh`, A],
  ]);
});

describe('R17-F6: eval of a wrapper that sources a switch', () => {
  denies('F6', [
    ['eval "$(cat wrap.sh)" (wrap.sh sources sw.sh), then the cd (R19 owner decision: a plain cd name narrows unless CDPATH is set)', `${E}eval "$(cat ./wrap.sh)"; cd proj && find . -delete`, stub({ '/home/u/proj/wrap.sh': '. ./sw.sh\n', '/home/u/proj/sw.sh': SWS })],
  ]);
  allows('F6', [
    ['the same with ./NAME', `${E}eval "$(cat ./wrap.sh)"; cd ./proj && rm -rf build`, stub({ '/home/u/proj/wrap.sh': '. ./sw.sh\n', '/home/u/proj/sw.sh': SWS })],
  ]);
});

describe('R17-F7: a loop that runs an earlier file again after a later file moved the directory', () => {
  const F = { '/home/u/proj/a.sh': body, '/home/u/proj/wrap.sh': '. ./sw.sh\n', '/home/u/proj/sw.sh': SWS, '/home/u/proj/b.sh': 'find . -delete\n' };
  denies('F7a', [
    ['for: source a.sh, source wrap.sh', `${E}for i in 1 2; do source ./a.sh; source ./wrap.sh; done`, stub(F)],
  ]);
  denies('F7b', [
    ['for: source b.sh, source mv.sh (cd /home/u)', 'for i in 1 2; do source ./b.sh; source ./mv.sh; done', stub({ ...F, '/home/u/proj/mv.sh': 'cd /home/u\n' })],
    ['for: source b.sh, source mv.sh (cd ./..)', 'for i in 1 2; do source ./b.sh; source ./mv.sh; done', stub({ ...F, '/home/u/proj/mv.sh': 'cd ./..\n' })],
    ['for: source b.sh, source mv.sh (cd ..)', 'for i in 1 2; do source ./b.sh; source ./mv.sh; done', stub({ ...F, '/home/u/proj/mv.sh': 'cd ..\n' })],
    ['for: mv.sh poisons (a file the guard cannot follow)', 'for i in 1 2; do source ./b.sh; source ./mv.sh; done', stub({ ...F, '/home/u/proj/mv.sh': 'eval "$CMD"\n' })],
    ['for: absolute source of b.sh, then mv.sh (cd /home/u)', 'for i in 1 2; do source /home/u/proj/b.sh; source ./mv.sh; done', stub({ ...F, '/home/u/proj/mv.sh': 'cd /home/u\n' })],
    ['for: absolute source of b.sh, then mv.sh (cd ..)', 'for i in 1 2; do source /home/u/proj/b.sh; source ./mv.sh; done', stub({ ...F, '/home/u/proj/mv.sh': 'cd ..\n' })],
    ['for: the b.sh of the new directory (cd .. then ./b.sh is /home/u/b.sh)', 'for i in 1 2; do source ./b.sh; source ./mv.sh; done', stub({ ...F, '/home/u/b.sh': 'find . -delete\n', '/home/u/proj/b.sh': 'echo hi\n', '/home/u/proj/mv.sh': 'cd ..\n' })],
    ['for: mv.sh is missing', 'for i in 1 2; do source ./b.sh; source ./mv.sh; done', stub(F)],
    ['while: source b.sh, source mv.sh', 'while true; do source ./b.sh; source ./mv.sh; done', stub({ ...F, '/home/u/proj/mv.sh': 'cd /home/u\n' })],
    ['a function called twice', 'f() { source ./b.sh; source ./mv.sh; }; f; f', stub({ ...F, '/home/u/proj/mv.sh': 'cd /home/u\n' })],
    ['bash b.sh instead of source (a child shell in the new directory)', 'for i in 1 2; do bash ./b.sh; source ./mv.sh; done', stub({ ...F, '/home/u/proj/mv.sh': 'cd /home/u\n' })],
  ]);
  allows('F7b', [
    ['straight line: b.sh runs before mv.sh, once', 'source ./b.sh; source ./mv.sh', stub({ ...F, '/home/u/proj/mv.sh': 'cd /home/u\n' })],
    ['a loop whose later file stays in the project (read-only first file; R18-B1: the move is an absolute path, a relative cd in a loop is unknown)', 'for i in 1 2; do source ./r.sh; source ./mv.sh; done', stub({ ...F, '/home/u/proj/r.sh': 'ls\n', '/home/u/proj/sub/r.sh': 'ls\n', '/home/u/proj/sub/mv.sh': 'cd /home/u/proj/sub\n', '/home/u/proj/mv.sh': 'cd /home/u/proj/sub\n' })],
    ['a loop of harmless files (R18-F1: both files exist in the directory the later file moves to too, a missing one there may have been made by the loop)', 'for i in 1 2; do source ./c.sh; source ./mv.sh; done', stub({ ...F, '/home/u/proj/c.sh': 'echo hi\n', '/home/u/c.sh': 'echo hi\n', '/home/u/mv.sh': 'cd /home/u\n', '/home/u/proj/mv.sh': 'cd /home/u\n' })],
  ]);
});

describe('R17 old pins that still hold', () => {
  denies('old', [
    ['an exported BASHOPTS and a bare cd (R19 owner decision: a plain cd name narrows unless CDPATH is set)', `${E}export BASHOPTS=cdable_vars; cd proj && find . -delete`],
    ['shopt -s cdable_vars and a bare cd (R19 owner decision: a plain cd name narrows unless CDPATH is set)', `${E}shopt -s cdable_vars; cd proj && find . -delete`],
    ['set -T (zsh) and a bare cd (R19 owner decision: a plain cd name narrows unless CDPATH is set)', `${E}set -T; cd proj && find . -delete`],
    ['zsh -T -c (R19 owner decision: a plain cd name narrows unless CDPATH is set)', `${E}zsh -T -c 'cd proj && find . -delete'`],
    ['-ocdablevars glued (R19 owner decision: a plain cd name narrows unless CDPATH is set)', `${E}zsh -ocdablevars ./a.sh`, A],
  ]);
});
