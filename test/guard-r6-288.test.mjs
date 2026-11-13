// PR #288 round 6: "fix + simplify". Each round found one more spelling, so this round removes whole areas of risk instead of listing spellings.
//   R6-F1  PLAIN_CD backtracked exponentially and bangLine / the quote strip were quadratic: linear scans, and a timing test for each.
//   R6-F2  `$'…\'…'`: the second quote reader is gone; a line holding `$'` or `$"` is read fail closed (a glob may be live, cd narrowing is off).
//   R6-F3  zsh glob groups / qualifiers `( ) < > | # ^ ~` in a word of an option tool or rsync: a possible option.
//   R6-B1  a glob option inside a variable (`D="--[d]elete"; rsync -a $D …`): every expanded piece is tested, whatever the raw text says.
//   R6-B2  `git clean -fdx -n --no-dry-run`: any later `--no-…` word means no dry run.
//   R6-F4  a symlink to home reached with no `..` (`find /tmp/h/ -delete`): the real reading of every absolute, glob-free word is tested.
// Home is /home/u; /tmp/l is a link to /home/u/proj, /tmp/h a link to home. Protected paths are built from parts so this file does not spell them either.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateBashForFiles } from '../pipeline/hooks/lib/files-policy.mjs';

const PROJ = '/home/u/proj';
const HOME = '/home/u';
const CFG = ['~', '.claude'].join('/');
const CFG_REL = ['.claude'].join('');
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
    test(`#288 R6 ${label} denies: ${name}`, () => {
      const r = run(line, extra);
      assert.equal(r.decision, 'deny', `${line} -> ${r.decision}`);
    });
  }
};
const allows = (label, cases) => {
  for (const [name, line, extra] of cases) {
    test(`#288 R6 ${label} allows: ${name}`, () => {
      const r = run(line, extra);
      assert.equal(r.decision, 'allow', `${line} -> ${r.decision}: ${r.reason}`);
    });
  }
};
const AT_HOME = { cwd: HOME };
const AT_TMP = { cwd: '/tmp' };

describe('R6-B1: a glob option inside a variable', () => {
  denies('B1', [
    ['rsync -a $D SRC ~/ with D="--[d]elete"', 'D="--[d]elete"; rsync -a $D /tmp/x/ ~/'],
    ['find DIR $D with D=-[d]elete', `D='-[d]elete'; find ${DIR} $D`],
    ['rsync -a $D with D="*delete"', 'D="*delete"; rsync -a $D /tmp/x/ ~/'],
    ['rsync -a $D with D="--del*"', 'D="--del*"; rsync -a $D /tmp/x/ ~/'],
    ['rsync -a $D with a blank-split value', 'D="-v --[d]elete"; rsync -a $D /tmp/x/ ~/'],
    ['find DIR $D with D=*delete', `D='*delete'; find ${DIR} $D`],
    ['sort x $D FILE with D=[-]o', `D='[-]o'; sort x $D ${S}`],
    ['rg x DIR $D with D=--p[r]e=cmd', `D='--p[r]e=cmd'; rg x ${DIR} $D`],
  ]);
  allows('B1', [
    ['ls $D with D=*.md', "D='*.md'; ls $D"],
    ['rsync -a $D SRC into the project', 'D="*.d"; rsync -a $D /tmp/x/ ~/proj/out/'],
  ]);
});

describe('R6-B2: git clean --no-dry-run', () => {
  denies('B2', [
    ['-n then --no-dry-run', 'git clean -fdx -n --no-dry-run', AT_HOME],
    ['--dry-run then --no-dry-run', 'git clean -fdx --dry-run --no-dry-run', AT_HOME],
    ['-n then --no-dry (an abbreviation)', 'git clean -fdx -n --no-dry', AT_HOME],
    ['-n then --no-d', 'git clean -fdx -n --no-d', AT_HOME],
    ['-n then --no-', 'git clean -fdx -n --no-', AT_HOME],
    ['-n then --no-anything', 'git clean -fdx -n --no-foo', AT_HOME],
    ['-nd then --no-dry-run', 'git clean -nd --no-dry-run', AT_HOME],
    ['--no-dry-run between', 'git clean -n --no-dry-run -f', AT_HOME],
  ]);
  allows('B2', [
    ['--no-dry-run then -n (the last one wins)', 'git clean -fdx --no-dry-run -n', AT_HOME],
    ['-n then --no-dry-run after the --', 'git clean -fdx -n -- --no-dry-run', AT_HOME],
    ['-e value --no-dry-run is the value of -e', 'git clean -n -e --no-dry-run', AT_HOME],
    ['plain -n', 'git clean -n', AT_HOME],
  ]);
});

describe('R6-F2: $\'…\' strings', () => {
  denies('F2', [
    ['find with an ANSI-C quote hiding a glob option', `find ${DIR} -name $'\\'' -o -[d]elete -name \\'`],
    ['rsync with an ANSI-C quote hiding a glob option', "rsync -a $'\\'' --[d]elete /tmp/empty/ ~/ \\'"],
    ['rsync $"…" hiding a glob option', 'rsync -a $"x" --[d]elete /tmp/empty/ ~/'],
    ['a $\' on the line turns the cd narrowing off', "cd proj && echo $'x' && find . -delete", AT_HOME],
    ['a $\' pair hiding a !', "echo $'\\'' ; ! cd /tmp/nonexistent && find . -delete \\'", AT_HOME],
    ['a $\' pair hiding a keyword', "echo $'\\'' ; if true; then cd proj; fi && find . -delete \\'", AT_HOME],
    ['a $" on the line turns the cd narrowing off', 'cd proj && echo $"x" && find . -delete', AT_HOME],
  ]);
  allows('F2', [
    ['plain quotes still narrow', "cd ./proj && echo 'x' && git add .", AT_HOME],
    ['find -name with a quoted glob', `find ${DIR} -name '*.mjs'`],
  ]);
});

describe('R6-F3: zsh glob groups and qualifiers', () => {
  denies('F3', [
    ['find DIR -delet(e|x)', `find ${DIR} -delet(e|x)`],
    ['find DIR -delete(.)', `find ${DIR} -delete(.)`],
    ['find DIR (-delete|x)', `find ${DIR} (-delete|x)`],
    ['find DIR -d(<->)elete', `find ${DIR} -d(<->)elete`],
    ['find DIR ^x', `find ${DIR} ^x`],
    ['find DIR -d~x', `find ${DIR} -d~x`],
    ['find DIR -delete#', `find ${DIR} -delete#`],
    ['sort x (-o|y) FILE', `sort x (-o|y) ${S}`],
    ['rsync -a (--delete|x) SRC ~/', 'rsync -a (--delete|x) /tmp/empty/ ~/'],
    ['rsync -a --delet(e) SRC ~/', 'rsync -a --delet(e) /tmp/empty/ ~/'],
    ['rsync -a --(delete) SRC ~/', 'rsync -a --(delete) /tmp/empty/ ~/'],
    ['sed (-i|x) FILE', `sed s/a/b/ (-i|x) ${S}`],
    ['jq (-i|x) FILE', `jq (-i|x) . ${S}`],
    ['rg x DIR --pr(e)=cmd', `rg x ${DIR} --pr(e)=cmd`],
  ]);
  allows('F3', [
    ['ls *.(jpg|png)', 'ls *.(jpg|png)'],
    ['ls *.(jpg|png) a(<1-3>)', 'ls *.(jpg|png) a(<1-3>)'],
    ['rg --glob=*.mjs', `rg --glob=*.mjs x ${DIR}`],
    ['rg -g *.ts (quoted)', `rg -g '*.ts' x ${DIR}`],
    ['rg -g*.ts', `rg -g*.ts x ${DIR}`],
    ['a quoted regex with a group', `rg '(a|b)' ${DIR}`],
    ['a quoted program with a call', `awk '{ print length($0) }' ${S}`],
  ]);
});

describe('R6-F4: a symlink to home reached with no ..', () => {
  denies('F4', [
    ['find /tmp/h/ -delete', 'find /tmp/h/ -delete', AT_TMP],
    ['find /tmp/h/. -delete', 'find /tmp/h/. -delete', AT_TMP],
    ['find /tmp/h -delete', 'find /tmp/h -delete', AT_TMP],
    ['rm -rf /tmp/h/', 'rm -rf /tmp/h/', AT_TMP],
    ['rm -rf /tmp/h', 'rm -rf /tmp/h', AT_TMP],
    ['rsync -a --delete /tmp/empty/ /tmp/h/', 'rsync -a --delete /tmp/empty/ /tmp/h/', AT_TMP],
    ['a protected file through the link', `cp x /tmp/h/${CFG_REL}/settings.json`, AT_TMP],
    ['a protected directory through the link', `rm -rf /tmp/h/${CFG_REL}/pipeline`, AT_TMP],
    ['mv /tmp/h /tmp/x', 'mv /tmp/h /tmp/x', AT_TMP],
  ]);
  allows('F4', [
    ['a read through /tmp/h', 'cat /tmp/h/proj/data.txt', AT_TMP],
    ['ls /tmp/h/', 'ls /tmp/h/', AT_TMP],
    ['find /tmp/h/ -name x', 'find /tmp/h/ -name x', AT_TMP],
    ['rm -rf a project directory through the link', 'rm -rf /tmp/h/proj/build', AT_TMP],
    ['rm -rf /tmp/l/build (a link to the project)', 'rm -rf /tmp/l/build', AT_TMP],
    ['rsync --delete into a project directory through the link', 'rsync -a --delete /tmp/empty/ /tmp/h/proj/out/', AT_TMP],
    ['a protected file read through the link', `cat /tmp/h/${CFG_REL}/settings.json`, AT_TMP],
  ]);
});

describe('R4 / R5 allow cases stay green', () => {
  allows('R4/R5', [
    ['cd ~/Claude/proj && git add . (cwd home)', 'cd ~/Claude/proj && git add .', AT_HOME],
    ['git -C ~/Claude/proj add . (cwd home)', 'git -C ~/Claude/proj add .', AT_HOME],
    ['cd ./proj && npx eslint .', 'cd ./proj && npx eslint .', AT_HOME],
    ['mkdir build && cd ./build && cmake ..', 'mkdir build && cd ./build && cmake ..'],
    ['expr 8 / 2', 'expr 8 / 2'],
    ['git clean -n', 'git clean -n', AT_HOME],
    ['A=x cd ./proj && git add . (cwd home)', 'A=x cd ./proj && git add .', AT_HOME],
  ]);
});

describe('R6-F1 timing: no regex of this PR backtracks or rescans', () => {
  const timed = (label, line, extra, want) => test(`#288 R6 timing: ${label}`, () => {
    const t0 = performance.now();
    const r = run(line, extra);
    const ms = performance.now() - t0;
    assert.equal(r.decision, want, `${r.decision}: ${r.reason}`);
    assert.ok(ms < 1000, `took ${Math.round(ms)} ms`);
  });
  timed('40 quoted assignments before a cd that fails PLAIN_CD', `${"A='x' ".repeat(40)}cd</dev/null; rm -rf ~`, {}, 'deny');
  timed('40 double-quoted assignments before a cd', `${'A="x" '.repeat(40)}cd</dev/null; rm -rf ~`, {}, 'deny');
  timed('a quoted cd word', `${"A='x' ".repeat(40)}'cd' /tmp; rm -rf ~`, {}, 'deny');
  timed('a 200 kB run of newlines', `${'\n'.repeat(200000)}rm -rf ~`, {}, 'deny');
  timed('a 200 kB run of newlines and blanks', `cd proj${' \n'.repeat(100000)}rm -rf ~`, AT_HOME, 'deny');
  timed('a 100000-pair unterminated double quote', `cd proj && echo "${'\\"'.repeat(100000)} ; rm -rf ~`, AT_HOME, 'deny');
  timed('a 100000-quote run', `cd proj && echo ${"'a".repeat(100000)} ; rm -rf ~`, AT_HOME, 'deny');
  timed('a 200 kB run of semicolons', `${';'.repeat(200000)} rm -rf ~`, {}, 'deny');
  // the audit of rounds 4 and 5: a glob became a RegExp (`.*[^/].*[^/]…` backtracked over every split: ten `**?` pairs took 12 s), and `/\/+$/` and `/^~([^/]*)(.*)$/` retried from every character
  timed('a glob of 40 "**?" pairs against the home chain', `rm -rf /${'**?'.repeat(40)}Z`, {}, 'allow');
  timed('a glob of 40 "*?" pairs under /home', `rm -rf /home/${'*?'.repeat(40)}Z`, {}, 'allow');
  timed('a glob of 400 "**?" pairs as a find operand', `find /${'**?'.repeat(400)}Z -delete`, {}, 'allow');
  timed('a 100000-slash run inside a rsync source', `rsync -a x${'/'.repeat(100000)}b /tmp/y/`, {}, 'allow');
  timed('a 100000-slash run at the end of a glob operand', `rm -rf /home/u/*${'/'.repeat(100000)}b`, {}, 'allow');
  timed('a ~name of 100000 characters with a newline after the slash', `rm -rf "~${'a'.repeat(100000)}/x\ny"`, {}, 'deny');
  timed('a 200 kB run of blanks before a !', `cd proj &&${' '.repeat(200000)}! cd x && rm -rf ~`, AT_HOME, 'deny');
});
