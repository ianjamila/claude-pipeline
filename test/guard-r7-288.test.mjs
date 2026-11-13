// PR #288 round 7: "fix + simplify" again. Fail closed, and remove whole areas of risk instead of listing spellings.
//   R7-B1/F2  a word of an option tool or rsync that holds a tangled character (`( ) # ^ < > ~ | @ + !`) together with a glob/tangled character is a possible option, whatever it starts with.
//   R7-B2     the real (symlink) reading of a path word is based on the joined, absolute `full`, so `cp payload s` with s a link is judged like `cp payload /tmp/s`.
//   R7-F1     withoutQuotes does not read comments or heredoc bodies: a `#` at a word start or a `<<` makes the text unreadable (fail closed).
//   R7-F4     the `$'` / `$"` test is part of the scan, at top level only: a `$` that ends a quoted string starts nothing. (#373: a real `$'…'` no longer turns the cd narrowing off; a real `$"…"` still does.)
//   R7-F3     the glob matcher folds the pattern and the text the same way (one code unit at a time).
//   R7-S1     a glob of more than 20000 elements is a hit in every caller (null = unreadable = fail closed); runs of `*` collapse first.
// Home is /home/u; /tmp/s is a link to the protected settings file. Protected paths are built from parts so this file does not spell them either.
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
const LINKS = { '/tmp/s': `/home/u/${CFG_REL}/settings.json`, '/tmp/d': `/home/u/${CFG_REL}` };
const realpath = (p) => {
  for (const [from, to] of Object.entries(LINKS)) {
    if (p === from) return to;
    if (p.startsWith(`${from}/`)) return to + p.slice(from.length);
  }
  return p;
};
const BASE = { home: HOME, env: {}, platform: 'linux', realpath, existsSync: (p) => p in files || p in LINKS || p.startsWith('/tmp/d/'), readText: (p) => (typeof files[p] === 'string' ? files[p] : null) };
const run = (command, extra = {}) => evaluateBashForFiles(command, { ...BASE, cwd: PROJ, ...extra });

const denies = (label, cases) => {
  for (const [name, line, extra] of cases) {
    test(`#288 R7 ${label} denies: ${name}`, () => {
      const r = run(line, extra);
      assert.equal(r.decision, 'deny', `${line} -> ${r.decision}`);
    });
  }
};
const allows = (label, cases) => {
  for (const [name, line, extra] of cases) {
    test(`#288 R7 ${label} allows: ${name}`, () => {
      const r = run(line, extra);
      assert.equal(r.decision, 'allow', `${line} -> ${r.decision}: ${r.reason}`);
    });
  }
};
const AT_HOME = { cwd: HOME };
const AT_TMP = { cwd: '/tmp' };

describe('R7-B1 / R7-F2: a tangled word that starts with a plain character', () => {
  denies('B1', [
    ['find DIR x#-delete', `find ${DIR} x#-delete`],
    ['find DIR @(-delete)', `find ${DIR} @(-delete)`],
    ['find DIR +(-delete)', `find ${DIR} +(-delete)`],
    ['find DIR x(#c0)-delete', `find ${DIR} x(#c0)-delete`],
    ['find DIR a~b-delete', `find ${DIR} a~b-delete`],
    ['sort x !(y) FILE', `sort x !(y) ${S}`],
    ['sort x y(#c0)-o FILE', `sort x y(#c0)-o ${S}`],
    ['rsync -a x#--delete SRC ~/', 'rsync -a x#--delete /tmp/empty/ ~/'],
    ['rsync -a @(--delete) SRC ~/', 'rsync -a @(--delete) /tmp/empty/ ~/'],
    ['rg x DIR p(#c0)--pre=cmd', `rg x ${DIR} p(#c0)--pre=cmd`],
  ]);
  allows('B1', [
    ['ls *.(jpg|png)', 'ls *.(jpg|png)'],
    ['rg --glob=*.mjs', `rg --glob=*.mjs x ${DIR}`],
    ['rg -g *.ts (quoted)', `rg -g '*.ts' x ${DIR}`],
    ['rg -g*.ts', `rg -g*.ts x ${DIR}`],
    ['a quoted regex with a group', `rg '(a|b)' ${DIR}`],
    ['a quoted program with a call', `awk '{ print length($0) }' ${S}`],
  ]);
});

describe('R7-B2: a relative operand that is a symlink to a protected file', () => {
  denies('B2', [
    ['cp payload s (s -> settings) from /tmp', 'cp payload s', AT_TMP],
    ['cp payload ./s', 'cp payload ./s', AT_TMP],
    ['cp payload d/settings.json (d -> config dir)', 'cp payload d/settings.json', AT_TMP],
    ['cp payload /tmp/s (the absolute spelling)', 'cp payload /tmp/s', AT_TMP],
    ['mv payload s', 'mv payload s', AT_TMP],
    ['cd /tmp && cp payload s', 'cd /tmp && cp payload s', AT_HOME],
  ]);
  allows('B2', [
    ['cp payload t (not a link)', 'cp payload t', AT_TMP],
    ['cat s (a read)', 'cat s', AT_TMP],
  ]);
});

describe('R7-F1: comments and heredoc bodies are no quotes', () => {
  denies('F1', [
    ['a comment quote hiding a !', "# '\n! cd /tmp/nonexistent && find . -delete #'", AT_HOME],
    ['a comment quote hiding a ! (double quote)', '# "\n! cd /tmp/nonexistent && find . -delete #"', AT_HOME],
    ['a heredoc quote hiding a !', "cat <<EOF\n'\nEOF\n! cd /tmp/nonexistent && find . -delete\n: '", AT_HOME],
    ['a comment quote hiding a while loop', "# '\nwhile false; do\ncd /tmp/nonexistent\ndone && find . -delete #'", AT_HOME],
    ['a comment quote hiding an if', "# '\nif true; then\ncd /tmp/nonexistent\nfi && find . -delete #'", AT_HOME],
    ['a comment quote after a command', "echo x # '\nwhile false; do\ncd /tmp/nonexistent\ndone && find . -delete # '", AT_HOME],
    ['a comment double quote hiding a while loop', '# "\nwhile false; do\ncd /tmp/nonexistent\ndone && find . -delete #"', AT_HOME],
    ['a heredoc quote hiding a while loop', "cat <<'EOF'\n'\nEOF\nwhile false; do\ncd /tmp/nonexistent\ndone && find . -delete\n: '", AT_HOME],
    ['a heredoc quote hiding a while loop (unquoted tag)', "cat <<EOF\n'\nEOF\nwhile false; do\ncd /tmp/nonexistent\ndone && find . -delete\n: '", AT_HOME],
  ]);
  allows('F1', [
    ['a plain cd ./narrowing', 'cd ./proj && git add .', AT_HOME],
    ['a # inside a word is no comment', 'cd ./proj && echo a#b && git add .', AT_HOME],
    ['a $# and a ${#x} are no comments', 'cd ./proj && echo $# ${#HOME} && git add .', AT_HOME],
    ['a heredoc inside a double-quoted substitution', 'cd proj && git commit -m "$(cat <<\'EOF\'\nit is\nEOF\n)"', AT_HOME],
  ]);
});

describe('R7-F4: a $ that ends a quoted string starts no ANSI-C string', () => {
  denies('F4', [
    ['a real $" still turns the narrowing off', 'cd proj && echo $"x" && find . -delete', AT_HOME],
  ]);
  allows('F4', [
    // (#373: these two were denies while a real `$'` turned the narrowing off; the parser reads the string, so the cd narrows the find)
    ["a real $' no longer turns the narrowing off", "cd proj && echo $'x' && find . -delete", AT_HOME],
    ["a quoted $ then a real $' no longer turns the narrowing off", "cd proj && echo 'a$' $'x' && find . -delete", AT_HOME],
    ['grep -q \'x$\' f then git add', "cd ~/Claude/proj && grep -q 'x$' f && git add .", AT_HOME],
    ['rg "bar$" src', 'rg "bar$" src', AT_HOME],
    ['a double-quoted regex ending in $ before a cd', 'cd ~/Claude/proj && grep -c "x$" f && git add .', AT_HOME],
    ['sed s/x$/y/', "cd ~/Claude/proj && sed 's/x$/y/' f && git add .", AT_HOME],
  ]);
});

describe('R7-F3: case folding on a case-insensitive platform', () => {
  const at = (home, platform, line) => run(line, { home, platform, cwd: home, realpath: (p) => p, existsSync: () => false });
  // (the issue's lines, plus a glob that names the home directory itself, which only the whole-path matcher reads)
  const cases = [
    ['/Users/ΝΙΚΟΣ', 'darwin', ['rm -rf ~/.cla*', 'rm -rf /Users/?ΙΚΟΣ', 'rm -rf /Users/ΝΙΚΟ?', 'rm -rf /Users/ΝΙΚΟΣ/.cl*', 'rm -rf /Users/Ν*Σ']],
    ['C:/Users/İbrahim', 'win32', ['rm -rf ~/.cla*', 'rm -rf C:/Users/İbrahi?', 'rm -rf C:/Users/İ*', 'rm -rf C:/Users/İbrahim/.cl*']],
    ['/Users/ΣΑΣ', 'darwin', ['rm -rf ~/.cla*', 'rm -rf /Users/ΣΑ?', 'rm -rf /Users/?ΑΣ']],
  ];
  for (const [home, platform, lines] of cases) {
    for (const line of lines) {
      test(`#288 R7 F3 denies: ${line} with home ${home} on ${platform}`, () => {
        const r = at(home, platform, line);
        assert.equal(r.decision, 'deny', `${line} -> ${r.decision}`);
      });
    }
  }
});

describe('R7-S1: a glob too large to read is a hit, in every caller', () => {
  const big = '*'.repeat(30000);
  denies('S1', [
    ['rm -rf of 30000 * then /.claude under home', `rm -rf ${HOME}/${big}/${CFG_REL}`],
    ['rm -rf ~/ of 30000 *', `rm -rf ~/${big}/${CFG_REL}/settings.json`],
    ['cp x of 30000 * then /.claude', `cp x ${HOME}/${big}/${CFG_REL}/settings.json`],
    ['30000 *? pairs under home', `rm -rf ${HOME}/${'*?'.repeat(15000)}/${CFG_REL}`],
    ['30000 ? as the last segment', `rm -rf ${HOME}/${'?'.repeat(30000)}`],
    ['30000 ? as a middle segment', `rm -rf ${HOME}/${'?'.repeat(30000)}/x`],
    ['a transcript glob of 30000 ?', `cp x ${HOME}/${'?'.repeat(30000)}/projects/-p/a.jsonl`],
    ['a segment that must reach a root (globReaches)', `rm -rf ${HOME}/${'?'.repeat(25000)}/${CFG_REL}/pipeline`],
    ['a review-folder glob of 25000 ? (can)', `cp x ./${'?'.repeat(25000)}/state.json`],
    ['a config-dir glob of 25000 ? (configDirGlob)', `tar -xf a.tar -C ${HOME}/${'?'.repeat(25000)}`],
    ['zsh *** is recursive like **', `rm -rf ${HOME}/***/${CFG_REL}/settings.json`],
    ['zsh *** before the config dir', `rm -rf ${HOME}/***/${CFG_REL}`],
    ['a run of 4 stars before the config dir', `rm -rf ${HOME}/****/${CFG_REL}`],
    ['mv a 30000-element glob under home', `mv ${HOME}/${'?'.repeat(30000)} /tmp/x`],
  ]);
  const timed = (label, line, want) => test(`#288 R7 S1 timing: ${label}`, () => {
    const t0 = performance.now();
    const r = run(line);
    const ms = performance.now() - t0;
    assert.equal(r.decision, want, `${r.decision}: ${r.reason}`);
    assert.ok(ms < 2000, `took ${Math.round(ms)} ms`);
  });
  timed('30000 * then /.claude', `rm -rf ${HOME}/${big}/${CFG_REL}`, 'deny');
  timed('30000 * as a find operand', `find ${HOME}/${big}/${CFG_REL} -delete`, 'deny');
  allows('S1', [['one star before a segment (not recursive)', `rm -rf ${HOME}/*/${CFG_REL}`], ['one star in a project path', `rm -rf ${PROJ}/*/x`]]);
  timed('a run of 30000 * in a harmless project path', `rm -rf ${PROJ}/${big}/x`, 'allow');
});

describe('R7 timing: the new scans are linear', () => {
  const timed = (label, line, extra, want) => test(`#288 R7 timing: ${label}`, () => {
    const t0 = performance.now();
    const r = run(line, extra);
    const ms = performance.now() - t0;
    assert.equal(r.decision, want, `${r.decision}: ${r.reason}`);
    assert.ok(ms < 1000, `took ${Math.round(ms)} ms`);
  });
  timed('a 200 kB run of # words', `cd proj && echo ${'a #'.repeat(100000)} ; rm -rf ~`, AT_HOME, 'deny');
  timed('a 100000-pair quoted regex ending in $', `cd proj && grep ${"'x$' ".repeat(100000)} f ; rm -rf ~`, AT_HOME, 'deny');
  timed('a 200 kB run of <<', `cd proj && echo ${'<<'.repeat(100000)} ; rm -rf ~`, AT_HOME, 'deny');
  timed('a 90000-char tangled option word', `find ${DIR} ${'x#('.repeat(30000)}`, {}, 'deny');
  timed('a 15000-char path folded', `rm -rf ~/${'a'.repeat(15000)}/x`, { home: '/Users/ΝΙΚΟΣ', platform: 'darwin', cwd: '/Users/ΝΙΚΟΣ' }, 'allow');
});
