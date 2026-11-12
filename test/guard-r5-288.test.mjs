// PR #288 round 5: the cd narrowing of round 4 and the glob / option checks had holes of their own. This round makes each check fail closed and lets through only what is positively safe.
//   R5-B1  `cd /tmp && env -C /home/u find . -delete`: a command's own wrapper directory is applied on top of the narrowed cd chain.
//   R5-B2  `find DIR *delete`, `find DIR -[[:alpha:]]elete`: an unquoted word with a glob character that can match a string starting with `-` is a possible option; one bracket scanner reads the shell's brackets.
//   R5-B3  `rsync -a --[d]elete SRC ~/`: a glob-spelled word is a possible --delete / --remove-source-files.
//   R5-B4  `git clean -fdx -e -n`: -n is the value of -e, no dry run.
//   R5-F1  `! cd X && cmd`, `chdir`, `eval`, `source` in an &&-chain: no narrowing (the cd may not have run or has been undone).
//   R5-F2  `rsync -a --delete SRC ~/ --timeout 30`: with a deletion flag every positional word and every option value is a possible destination.
//   R5-F3  `rm -rf /home/[[:alpha:]]`, `/home/[]u]`: every bracket expression is any one character.
//   R5-F4  an unknown wrapper directory (two wrappers, sudo -D, a run-time value): a relative operand is a home hit.
//   R5-F5  `..` after a symlink: the physical reading is tested too; a cd through a symlink keeps both the lexical and the real directory.
// Home is /home/u and the filesystem is faked (/tmp/l is a link to /home/u/proj, /tmp/h a link to home). Protected paths are built from parts so this file does not spell them either.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateBashForFiles } from '../pipeline/hooks/lib/files-policy.mjs';

const PROJ = '/home/u/proj';
const HOME = '/home/u';
const CFG = ['~', '.claude'].join('/');
const S = `${CFG}/settings.json`;
const DIR = `${CFG}/pipeline`;
const files = { '/home/u/proj/data.txt': 'x\n', '/home/u/proj/a.txt': 'x\n' };
const LINKS = { '/tmp/l': '/home/u/proj', '/tmp/h': '/home/u' };
const realpath = (p) => {
  for (const [from, to] of Object.entries(LINKS)) {
    if (p === from) return to;
    if (p.startsWith(`${from}/`)) return to + p.slice(from.length);
  }
  return p;
};
const BASE = { home: HOME, env: {}, platform: 'linux', realpath, existsSync: (p) => p in files || p in LINKS || p.startsWith('/tmp/l/') || p.startsWith('/tmp/h/'), readText: (p) => (typeof files[p] === 'string' ? files[p] : null) };
const run = (command, extra = {}) => evaluateBashForFiles(command, { ...BASE, cwd: PROJ, ...extra });

const denies = (label, cases) => {
  for (const [name, line, extra] of cases) {
    test(`#288 R5 ${label} denies: ${name}`, () => {
      const r = run(line, extra);
      assert.equal(r.decision, 'deny', `${line} -> ${r.decision}`);
    });
  }
};
const allows = (label, cases) => {
  for (const [name, line, extra] of cases) {
    test(`#288 R5 ${label} allows: ${name}`, () => {
      const r = run(line, extra);
      assert.equal(r.decision, 'allow', `${line} -> ${r.decision}: ${r.reason}`);
    });
  }
};
const AT_HOME = { cwd: HOME };
const AT_TMP = { cwd: '/tmp' };

describe('R5-B1 / R5-F4: the command\'s own directory', () => {
  denies('B1', [
    ['cd /tmp && env -C /home/u find . -delete', 'cd /tmp && env -C /home/u find . -delete'],
    ['cd /tmp && env --chdir=/home/u find . -delete', 'cd /tmp && env --chdir=/home/u find . -delete'],
    ['cd /tmp && env --chdir /home/u find . -delete', 'cd /tmp && env --chdir /home/u find . -delete'],
    ['cd /tmp && env -C ~ find . -delete', 'cd /tmp && env -C ~ find . -delete'],
    ['cd /tmp && env -C .. find . -delete (from /home/u/x)', 'cd /home/u/x && env -C .. find . -delete'],
    ['cd /tmp && git -C ~ clean -fdx', 'cd /tmp && git -C ~ clean -fdx'],
    ['cd /tmp && git -C /home/u clean -fdx', 'cd /tmp && git -C /home/u clean -fdx'],
    ['cd /tmp && make -C ~ clean', 'cd /tmp && make -C ~ clean'],
    ['cd /tmp && tar -C ~ -xf x.tgz .', 'cd /tmp && tar -C ~ -xf x.tgz .'],
    ['cd /tmp && env -C /home find u -delete', 'cd /tmp && env -C /home find u -delete'],
  ]);
  allows('B1', [
    ['cd /tmp && env -C /tmp/x find . -delete', 'cd /tmp && env -C /tmp/x find . -delete'],
    ['cd /tmp && git -C /tmp/x clean -fdx', 'cd /tmp && git -C /tmp/x clean -fdx'],
    ['cd /tmp && env -C x find . -delete', 'cd /tmp && env -C x find . -delete'],
    ['cwd home: env -C proj make clean', 'env -C proj make clean', AT_HOME],
  ]);
  denies('F4', [
    ['two wrappers', 'env -C /tmp env -C /home/u find . -delete'],
    ['a command-substitution value', 'env -C "$(printf /home/u)" find . -delete'],
    ['a variable value', 'env -C "$OLDPWD" git clean -fdx'],
    ['sudo -D ~', 'sudo -D ~ find . -delete'],
    ['sudo --chdir=~', 'sudo --chdir=/home/u find . -delete'],
    ['git -C "$X" clean (cwd home)', 'git -C "$X" clean -fdx', AT_HOME],
    ['git -C "$X" add . (cwd home)', 'git -C "$X" add .', AT_HOME],
    ['an unknown wrapper after a narrowed cd', 'cd /tmp && env -C "$X" find . -delete'],
    ['an unknown wrapper, a relative operand', 'env -C "$X" rm -rf ..'],
  ]);
  allows('F4', [
    ['git -C ~/Claude/proj add . (cwd home)', 'git -C ~/Claude/proj add .', AT_HOME],
    ['cd ~/Claude/proj && git add . (cwd home)', 'cd ~/Claude/proj && git add .', AT_HOME],
    ['an unknown wrapper, a read-only command', 'env -C "$X" find . -name x'],
    ['an unknown wrapper, an absolute operand', 'env -C "$X" rm -rf /tmp/build'],
    ['git -C "$X" status (the subcommand is no path)', 'git -C "$X" status', AT_HOME],
    ['git -C "$PWD" status', 'git -C "$PWD" status', AT_HOME],
    ['git -C proj add . (cwd home)', 'git -C proj add .', AT_HOME],
  ]);
});

describe('R5-F1 and the cd-narrowing security item: only a plain cd chain narrows', () => {
  denies('F1', [
    ['! cd X && find . -delete (the cd fails, ! makes it succeed)', '! cd /tmp/nonexistent/sub && find . -delete', AT_HOME],
    ['! cd X && find .. -delete from a project', '! cd /tmp/nonexistent/sub && find .. -delete'],
    ['a ! later in the chain', 'true && ! cd /tmp/nonexistent && find . -delete', AT_HOME],
    ['! after a semicolon', 'echo hi; ! cd /tmp/nonexistent && find . -delete', AT_HOME],
    ['chdir in the chain', 'cd proj && chdir .. && find . -delete', AT_HOME],
    ['eval in the chain', 'cd proj && eval "$X" && find . -delete', AT_HOME],
    ['eval of text', 'cd proj && eval "cd .." && find . -delete', AT_HOME],
    ['source in the chain', 'cd proj && source ./env.sh && find . -delete', AT_HOME],
    ['. in the chain', 'cd proj && . ./env.sh && find . -delete', AT_HOME],
    ['popd in the chain', 'cd proj && popd && find . -delete', AT_HOME],
    ['builtin cd in the chain', 'cd proj && builtin cd .. && find . -delete', AT_HOME],
    ['command cd in the chain', 'cd proj && command cd .. && find . -delete', AT_HOME],
    ['pushd with no target', 'cd proj && pushd && find . -delete', AT_HOME],
    ['a command name from a variable', 'cd proj && $C .. && find . -delete', AT_HOME],
    ['a command name from a substitution', 'cd proj && $(echo cd) .. && find . -delete', AT_HOME],
    ['a command name with a glob', 'cd proj && c? .. && find . -delete', AT_HOME],
    ['env cd (a program, not the builtin) does not move the shell', 'env cd /tmp && find . -delete', AT_HOME],
    ['sudo cd', 'sudo cd /tmp && find . -delete', AT_HOME],
    ['eval before the chain', 'eval "cd .."; cd proj && find . -delete', AT_HOME],
    ['alias in the chain', 'cd proj && alias x=y && find . -delete', AT_HOME],
    ['a relative cd after chdir', 'chdir /tmp/x && cd .. && find . -delete', AT_HOME],
  ]);
  allows('F1', [
    ['cd proj && npx eslint .', 'cd proj && npx eslint .', AT_HOME],
    ['cd ~/Claude/proj && git add .', 'cd ~/Claude/proj && git add .', AT_HOME],
    ['cd proj && make && git add .', 'cd proj && make && git add .', AT_HOME],
    ['cd proj && echo x && git add .', 'cd proj && echo x && git add .', AT_HOME],
    ['cd proj && mkdir out && git add out', 'cd proj && mkdir out && git add out', AT_HOME],
    ['cd proj && FOO=1 npm test && git add .', 'cd proj && FOO=1 npm test && git add .', AT_HOME],
    ['mkdir build && cd build && cmake .. (from proj)', 'mkdir build && cd build && cmake ..'],
    ['cd build && cmake .. (from proj)', 'cd build && cmake ..'],
    ['[ ! -d out ] with no cd', '[ ! -d out ] && mkdir out'],
    ['expr 8 / 2', 'expr 8 / 2'],
    ['a ! inside a test while cd narrows', 'cd proj && [ ! -d out ] && git add .', AT_HOME],
  ]);
  // a symlink: the lexical landing is /tmp/h or /tmp/l, the real one is home or the project
  denies('symlink cd', [
    ['cd /tmp/h && find . -delete (the link is home)', 'cd /tmp/h && find . -delete', AT_TMP],
    ['cd /tmp/l && find .. -delete (the link\'s parent is home)', 'cd /tmp/l && find .. -delete', AT_TMP],
    ['cd /tmp/l ; find .. -delete (no narrowing)', 'cd /tmp/l ; find .. -delete', AT_TMP],
    ['cd /tmp/l && cd .. && find . -delete', 'cd /tmp/l && cd .. && find . -delete', AT_TMP],
    ['env -C /tmp/l find .. -delete', 'env -C /tmp/l find .. -delete', AT_TMP],
    ['cd /tmp/l && rm -rf ../', 'cd /tmp/l && rm -rf ../', AT_TMP],
  ]);
  allows('symlink cd', [
    ['cd /tmp/l && find . -delete (the link is the project)', 'cd /tmp/l && find . -delete', AT_TMP],
    ['cd /tmp/x && find .. -delete (no link)', 'cd /tmp/x && find .. -delete', AT_TMP],
    ['cd /tmp/x && cmake ..', 'cd /tmp/x && cmake ..', AT_TMP],
  ]);
});

describe('R5-F5: physical ..', () => {
  denies('F5', [
    ['find /tmp/l/.. -delete', 'find /tmp/l/.. -delete', AT_TMP],
    ['rsync -a --delete /tmp/empty/ /tmp/l/../', 'rsync -a --delete /tmp/empty/ /tmp/l/../', AT_TMP],
    ['git -C /tmp/l/.. clean -fdx', 'git -C /tmp/l/.. clean -fdx', AT_TMP],
    ['rm -rf /tmp/l/..', 'rm -rf /tmp/l/..', AT_TMP],
    ['rm -rf l/.. from /tmp', 'rm -rf l/..', AT_TMP],
    ['rm -rf /tmp/l/../*', 'rm -rf /tmp/l/../*', AT_TMP],
    ['cd /tmp && find l/.. -delete', 'cd /tmp && find l/.. -delete', AT_TMP],
    ['env -C /tmp/l/.. find . -delete', 'env -C /tmp/l/.. find . -delete', AT_TMP],
    ['a protected directory through /tmp/l/..', `rm -rf /tmp/l/../${CFG.slice(2)}/pipeline`, AT_TMP],
    ['a protected file through /tmp/l/..', `cp x /tmp/l/../${CFG.slice(2)}/settings.json`, AT_TMP],
    ['a protected glob through /tmp/l/..', `rm -rf /tmp/l/../${CFG.slice(2, 6)}*`, AT_TMP],
  ]);
  allows('F5', [
    ['find /tmp/x/.. -delete (/tmp)', 'find /tmp/x/.. -delete', AT_TMP],
    ['rsync -a --delete /tmp/empty/ /tmp/x/../', 'rsync -a --delete /tmp/empty/ /tmp/x/../', AT_TMP],
    ['rm -rf /tmp/l/data (inside the project)', 'rm -rf /tmp/l/build', AT_TMP],
    ['find /tmp/l/. -delete', 'find /tmp/l/. -delete', AT_TMP],
    ['a read through /tmp/l/..', `cat /tmp/l/../${CFG.slice(2)}/settings.json`, AT_TMP],
    ['rm -rf /tmp/x/../build', 'rm -rf /tmp/x/../build', AT_TMP],
  ]);
});

describe('R5-F3 / R5-B2 (second half): every bracket expression is any one character', () => {
  denies('F3', [
    ['rm -rf /home/[[:alpha:]]', 'rm -rf /home/[[:alpha:]]'],
    ['rm -rf /home/[[:lower:]]*', 'rm -rf /home/[[:lower:]]*'],
    ['rm -rf /home/[]u]', 'rm -rf /home/[]u]'],
    ['rm -rf /home/[!]x]', 'rm -rf /home/[!]x]'],
    ['rm -rf /home/[^]x]', 'rm -rf /home/[^]x]'],
    ['rm -rf /home/[[=u=]]', 'rm -rf /home/[[=u=]]'],
    ['rm -rf /home/[[.u.]]', 'rm -rf /home/[[.u.]]'],
    ['find /home/[[:alpha:]] -delete', 'find /home/[[:alpha:]] -delete'],
    ['rm -rf /home/[[:alpha:][:digit:]]', 'rm -rf /home/[[:alpha:][:digit:]]'],
    ['rm -rf /[[:alpha:]]ome/u', 'rm -rf /[[:alpha:]]ome/u'],
    ['rm -rf /home/[a-z]', 'rm -rf /home/[a-z]'],
    ['rm -rf /home/[\\w-.]', 'rm -rf /home/[\\w-.]'],
    ['rm -rf /home/[z-a]', 'rm -rf /home/[z-a]'],
    ['rm -rf /ho[m]e/[]]u', 'rm -rf /hom[e]/u'],
  ]);
  allows('F3', [
    ['rm -rf /tmp/[[:alpha:]]', 'rm -rf /tmp/[[:alpha:]]'],
    ['rm -rf /tmp/[]x]', 'rm -rf /tmp/[]x]'],
    ['rm -rf ./build/[[:alpha:]]*', 'rm -rf ./build/[[:alpha:]]*'],
    ['rm -rf /home/u/proj/[[:alpha:]]*', 'rm -rf /home/u/proj/[[:alpha:]]*'],
    ['an unterminated bracket is a literal [', 'rm -rf /home/u/proj/[x'],
  ]);
});

describe('R5-B2 / R5-B3: glob-spelled options', () => {
  denies('B2', [
    ['find DIR *delete', `find ${DIR} *delete`],
    ['find DIR ?delete', `find ${DIR} ?delete`],
    ['find DIR [-]delete', `find ${DIR} [-]delete`],
    ['find DIR -[[:alpha:]]elete', `find ${DIR} -[[:alpha:]]elete`],
    ['find DIR -[]d]elete', `find ${DIR} -[]d]elete`],
    ['find DIR -[!x]elete', `find ${DIR} -[!x]elete`],
    ['find DIR -[[=d=]]elete', `find ${DIR} -[[=d=]]elete`],
    ['find DIR *', `find ${DIR} *`],
    ['find DIR *e', `find ${DIR} *e`],
    ['find DIR -*', `find ${DIR} -*`],
    ['git diff *utput=settings.json in the config dir', 'git diff *utput=settings.json', { cwd: ['/home/u', '.claude'].join('/') }],
    ['rg x DIR --p[r]e=cmd', `rg x ${DIR} --p[r]e=cmd`],
    ['rg x DIR *pre=cmd', `rg x ${DIR} *pre=cmd`],
    ['sort x [-]o FILE', `sort x [-]o ${S}`],
    ['sort x *o FILE', `sort x *o ${S}`],
    ['sed ?i s/a/b/ FILE', `sed ?i s/a/b/ ${S}`],
    ['awk with a glob option', `awk *f x ${S}`],
    ['sed with a glob that may start with a dash', `sed -n p *.md ${DIR}`],
    ['tree *o FILE', `tree *o ${S}`],
    ['jq *i', `jq *i . ${S}`],
    ['xxd ?r', `xxd ?r x ${S}`],
    ['openssl dgst *out', `openssl dgst *out ${S} x`],
  ]);
  denies('B3', [
    ['rsync -a --[d]elete SRC ~/', 'rsync -a --[d]elete /tmp/x/ ~/'],
    ['rsync -a *delete SRC ~/', 'rsync -a *delete /tmp/x/ ~/'],
    ['rsync -a ?-delete SRC ~/', 'rsync -a ?-delete /tmp/x/ ~/'],
    ['rsync -a [-]-delete SRC ~/', 'rsync -a [-]-delete /tmp/x/ ~/'],
    ['rsync -a --del* SRC ~/', 'rsync -a --del* /tmp/x/ ~/'],
    ['rsync -a --[[:alpha:]]elete SRC ~/', 'rsync -a --[[:alpha:]]elete /tmp/x/ ~/'],
    ['rsync -a --remove-[s]ource-files home ~/ /tmp', 'rsync -a --remove-[s]ource-files ~/ /tmp/x/'],
    ['rsync -a *source-files home as a source', 'rsync -a *source-files ~/ /tmp/x/'],
    ['rsync -a -- glob after a variable', 'rsync -a --d*te /tmp/x/ /home/'],
  ]);
  allows('B2/B3', [
    ['rg --glob=*.mjs', `rg --glob=*.mjs x ${DIR}`],
    ['rg -g*.ts', `rg -g*.ts x ${DIR}`],
    ['rg -g *.ts (quoted)', `rg -g '*.ts' x ${DIR}`],
    ['ls *.md in the project', 'ls *.md'],
    ['cat src/*.js in the project', 'cat src/*.js'],
    ['ls *.md from home', 'ls *.md', AT_HOME],
    ['cat src/*.js from home', 'cat src/*.js', AT_HOME],
    ['find DIR -name "*.mjs"', `find ${DIR} -name '*.mjs'`],
    ['find DIR -name "*e" (quoted)', `find ${DIR} -name '*e'`],
    ['find DIR ./*.mjs', `find ${DIR} ./*.mjs`],
    ['find DIR src/*', `find ${DIR} src/*`],
    ['sort src/*.txt', `sort ${DIR}/x src/*.txt`],
    ['sed on a quoted glob program', `sed -n 's/*/x/p' ${S}`],
    ['git log -- *.mjs', `git log -- *.mjs`],
    ['rsync -a SRC *.d (no option)', 'rsync -a /tmp/x/ ~/proj/out/*.d'],
    ['rsync -a -v SRC ~/proj/out', 'rsync -a ./*.d ~/proj/out/'],
    ['rsync --delete into the project', 'rsync -a --delete /tmp/x/ ~/proj/out/'],
  ]);
});

describe('R5-F2: rsync operands with a deletion flag', () => {
  denies('F2', [
    ['--timeout 30 after the operands', 'rsync -a --delete /tmp/x/ ~/ --timeout 30'],
    ['--exclude foo after the operands', 'rsync -a --delete /tmp/x/ ~/ --exclude foo'],
    ['-e ssh after the operands', 'rsync -a --delete /tmp/x/ ~/ -e ssh'],
    ['--bwlimit 100 after the operands', 'rsync -a --delete /tmp/x/ ~/ --bwlimit 100'],
    ['--log-file /tmp/l after the operands', 'rsync -a --delete /tmp/x/ ~/ --log-file /tmp/l'],
    ['--delete-after', 'rsync -a --delete-after /tmp/x/ ~/ --timeout 30'],
    ['a glob flag', 'rsync -a --[d]elete /tmp/x/ ~/ --timeout 30'],
    ['a run-time flag', 'rsync -a $OPT /tmp/x/ ~/ --timeout 30'],
    ['the home word is not last', 'rsync -a --delete /tmp/x/ ~/ /tmp/y/'],
    ['an option value naming home', 'rsync -a --delete /tmp/x/ /tmp/y/ --backup-dir ~/'],
    ['a parent of home', 'rsync -a --delete /tmp/x/ /home/ --timeout 30'],
    ['-t DIR style', 'rsync -a --delete --temp-dir ~/ /tmp/x/ /tmp/y/'],
  ]);
  allows('F2', [
    ['--delete into a project directory, option after', 'rsync -a --delete /tmp/x/ ~/proj/out/ --timeout 30'],
    ['no deletion flag', 'rsync -a /tmp/x/ ~/ --timeout 30'],
    ['--delete from a project directory to /tmp', 'rsync -a --delete ~/proj/out/ /tmp/y/ --timeout 30'],
    ['--delete between two project directories', 'rsync -a --delete -e ssh ~/proj/a/ ~/proj/b/'],
  ]);
});

describe('R5-B4: git clean dry-run', () => {
  denies('B4', [
    ['git clean -fdx -e -n', 'git clean -fdx -e -n', AT_HOME],
    ['git clean -fdx -enode_modules', 'git clean -fdx -enode_modules', AT_HOME],
    ['git clean -fdx --exclude=-n', 'git clean -fdx --exclude=-n', AT_HOME],
    ['git clean -fdx --exclude -n', 'git clean -fdx --exclude -n', AT_HOME],
    ['git clean -fdx --excl -n (an abbreviation)', 'git clean -fdx --excl -n', AT_HOME],
    ['git clean -fd -- -n', 'git clean -fd -- -n', AT_HOME],
    ['git clean -fdxe -n (a cluster ending in e)', 'git clean -fdxe -n', AT_HOME],
    ['git clean -fdxen', 'git clean -fdxen', AT_HOME],
    ['git clean -fd -e n -e -n', 'git clean -fd -e n -e -n', AT_HOME],
    ['git clean -fdx -e --dry-run', 'git clean -fdx -e --dry-run', AT_HOME],
    ['git clean -fdx --dry (an abbreviation is no literal dry run)', 'git clean -fdx --dry', AT_HOME],
    ['git clean -fdx -- --dry-run', 'git clean -fdx -- --dry-run', AT_HOME],
    ['git clean -fdx --no-n', 'git clean -fdx --no-n', AT_HOME],
    ['git clean -fdx -x-n', 'git clean -fdx -x-n', AT_HOME],
    ['git -C . clean -fdx -e -n', 'git -C . clean -fdx -e -n', AT_HOME],
  ]);
  allows('B4', [
    ['git clean -n', 'git clean -n', AT_HOME],
    ['git clean -nd', 'git clean -nd', AT_HOME],
    ['git clean -fdxn', 'git clean -fdxn', AT_HOME],
    ['git clean --dry-run -fdx', 'git clean --dry-run -fdx', AT_HOME],
    ['git clean -fdx -n -e foo', 'git clean -fdx -n -e foo', AT_HOME],
    ['git clean -fdx -e foo -n', 'git clean -fdx -e foo -n', AT_HOME],
    ['git clean -fdx --exclude=foo --dry-run', 'git clean -fdx --exclude=foo --dry-run', AT_HOME],
    ['git clean -n -- foo', 'git clean -n -- foo', AT_HOME],
    ['git clean -fdx from a project', 'git clean -fdx'],
  ]);
});

describe('R5 timing', () => {
  const timed = (label, line, extra, want) => test(`#288 R5 timing: ${label}`, () => {
    const t0 = performance.now();
    const r = run(line, extra);
    const ms = performance.now() - t0;
    assert.equal(r.decision, want, `${r.decision}: ${r.reason}`);
    assert.ok(ms < 3000, `took ${Math.round(ms)} ms`);
  });
  timed('a 190 kB bracket word', `rm -rf /home/[${'a'.repeat(190000)}]`, {}, 'deny');
  timed('a 100000-bracket unterminated word (too large to read: fails closed)', `rm -rf /home/u/proj/[${'['.repeat(100000)}`, {}, 'deny');
  timed('a 60000-star option word', `find ${DIR} *${'*'.repeat(60000)}e`, {}, 'deny');
  timed('a glob option of many brackets', `find ${DIR} ${'[[:alpha:]]'.repeat(5000)}`, {}, 'allow');
  timed('20 && chains with eval', `${'cd proj && '.repeat(20)}eval x && git add .`, AT_HOME, 'deny');
});
