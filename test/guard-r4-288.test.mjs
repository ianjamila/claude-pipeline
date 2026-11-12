// PR #288 round 4: the home-directory check of round 3 (a command that is not read-only and is given home or a parent of it) had holes and over-denials of its own.
//   R4-B1  `D=--delete; rsync -a "$D" /tmp/x/ ~/`: the --delete test read the words as written; now the expanded words are judged, and a word still holding a run-time part counts as a possible --delete.
//   R4-B2  a glob spelling of home (`/home/[u]`, `/home/*`, `/*`, `/hom?/u`) is matched against each member of the home chain.
//   R4-F1  `.` / `..` resolve against the directories THAT command can run in (after an &&-joined cd: the target only; with its own -C directory: that one), and a lone `/` is no path operand of expr / ssh / docker exec.
//   R4-F2  `~u` / `~$USER` are home, `~+` is each directory the command may be in, `~-` and any other `~NAME` are only known at run time; the chain also holds the resolved (realpath) home.
//   R4-F3  a glob-spelled option (`find DIR -[d]elete`) is no read-only call; a variable value with a glob character is no single token.
//   rsync --remove-source-files deletes its sources: they are judged like a destination.
// Home is /home/u and the filesystem is faked. Protected paths are built from parts so this file does not spell them either.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateBashForFiles } from '../pipeline/hooks/lib/files-policy.mjs';

const PROJ = '/home/u/proj';
const HOME = '/home/u';
const CFG = ['~', '.claude'].join('/');
const S = `${CFG}/settings.json`;
const files = { '/home/u/proj/data.txt': 'x\n', '/home/u/proj/a.txt': 'x\n' };
const BASE = { home: HOME, env: {}, platform: 'linux', realpath: (p) => p, existsSync: (p) => p in files, readText: (p) => (typeof files[p] === 'string' ? files[p] : null) };
const run = (command, extra = {}) => evaluateBashForFiles(command, { ...BASE, cwd: PROJ, ...extra });

const denies = (label, cases) => {
  for (const [name, line, extra] of cases) {
    test(`#288 R4 ${label} denies: ${name}`, () => {
      const r = run(line, extra);
      assert.equal(r.decision, 'deny', `${line} -> ${r.decision}`);
    });
  }
};
const allows = (label, cases) => {
  for (const [name, line, extra] of cases) {
    test(`#288 R4 ${label} allows: ${name}`, () => {
      const r = run(line, extra);
      assert.equal(r.decision, 'allow', `${line} -> ${r.decision}: ${r.reason}`);
    });
  }
};

describe('R4-B1 / item 6: rsync options read as expanded', () => {
  denies('B1', [
    ['literal --delete (control)', 'rsync -a --delete /tmp/x/ ~/'],
    ['--delete held in a same-line name', 'D=--delete; rsync -a "$D" /tmp/x/ ~/'],
    ['the name unquoted', 'D=--delete; rsync -a $D /tmp/x/ ~/'],
    ['a name glued to text (--del + ete)', 'D=--del; rsync -a ${D}ete /tmp/x/ ~/'],
    ['--delete-after in a name', 'D=--delete-after; rsync -a "$D" /tmp/x/ ~/'],
    ['an option from a command substitution', 'rsync -a "$(echo --delete)" /tmp/x/ ~/'],
    ['an option from an unset name', 'rsync -a $OPT /tmp/x/ ~/'],
    ['an option with a run-time part inside', 'rsync -a --del$X /tmp/x/ ~/'],
    ['a run-time option into a parent of home', 'rsync -a "$(echo --delete)" /tmp/x/ /home/'],
    ['a name holding two words', 'D="-v --delete"; rsync -a $D /tmp/x/ ~/'],
  ]);
  allows('B1', [
    ['a same-line name holding a harmless option', 'D=-v; rsync -a $D /tmp/x/ ~/'],
    ['rsync -a into home (no delete)', 'rsync -a /tmp/x/ ~/'],
    ['--delete into a project directory', 'D=--delete; rsync -a "$D" /tmp/x/ ~/proj/out/'],
    ['a run-time option into a project directory', 'rsync -a $OPT /tmp/x/ ~/proj/out/'],
  ]);
  denies('item 6', [
    ['--remove-source-files with a protected source', `rsync -a --remove-source-files ${CFG}/pipeline/ /tmp/x/`],
    ['--remove-sent-files with a protected source', `rsync -a --remove-sent-files ${S} /tmp/x/`],
    ['a name holding --remove-source-files', `D=--remove-source-files; rsync -a "$D" ${S} /tmp/x/`],
    ['--remove-source-files with home as a source', 'rsync -a --remove-source-files ~/ /tmp/x/'],
    ['--remove-source-files with a parent of home as a source', 'rsync -a --remove-source-files /home/ /tmp/x/'],
    ['a run-time option with home as a source', 'rsync -a $OPT ~/ /tmp/x/'],
  ]);
  allows('item 6', [
    ['rsync from a protected source without the option (a read)', `rsync -a ${CFG}/pipeline/ /tmp/x/`],
    ['--remove-source-files from a project directory', 'rsync -a --remove-source-files ~/proj/out/ /tmp/x/'],
    ['rsync from home without the option', 'rsync -a ~/ /tmp/x/'],
  ]);
});

describe('R4-B2: glob spellings of home', () => {
  denies('B2', [
    ['rm -rf /home/[u]', 'rm -rf /home/[u]'],
    ['rm -rf /home/*', 'rm -rf /home/*'],
    ['rm -rf /*', 'rm -rf /*'],
    ['find /hom?/u -delete', 'find /hom?/u -delete'],
    ['rm -rf /ho*', 'rm -rf /ho*'],
    ['rm -rf /home/u*', 'rm -rf /home/u*'],
    ['rm -rf /home/[!x]', 'rm -rf /home/[!x]'],
    ['rm -rf /h[o]me', 'rm -rf /h[o]me'],
    ['rm -rf ~/../*', 'rm -rf ~/../*'],
    ['rm -rf ../* from home', 'rm -rf ../*', { cwd: HOME }],
    ['rm -rf /home/** ', 'rm -rf /home/**'],
    ['a name holding a glob', 'G="/home/[u]"; rm -rf $G'],
    ['a brace form', 'rm -rf /home/{u,v}'],
    ['mv /home/[u] /tmp/x', 'mv /home/[u] /tmp/x'],
  ]);
  allows('B2', [
    ['ls /home/*', 'ls /home/*'],
    ['find /home/[u] -name x', 'find /home/[u] -name x'],
    ['rm -rf /home/u/proj/build/*', 'rm -rf /home/u/proj/build/*'],
    ['rm -rf ~/Desktop/*', 'rm -rf ~/Desktop/*'],
    ['rm -rf ./build/*', 'rm -rf ./build/*'],
    ['rm -rf *.log in the project', 'rm -rf *.log'],
    ['rm -rf /tmp/*', 'rm -rf /tmp/*'],
    ['rm -rf /home/v*', 'rm -rf /home/v*'],
  ]);
});

describe('R4-F1: a relative word resolves where the command can run', () => {
  denies('F1', [
    ['cwd home: rm -rf .', 'rm -rf .', { cwd: HOME }],
    ['cwd home: rm -rf ..', 'rm -rf ..', { cwd: HOME }],
    ['cwd home: cd ~ ; rm -rf .', 'cd ~ ; rm -rf .', { cwd: HOME }],
    ['cwd proj: cd ~ ; rm -rf .', 'cd ~ ; rm -rf .'],
    ['cwd proj: cd ~ && rm -rf .', 'cd ~ && rm -rf .'],
    ['cwd proj: cd .. && rm -rf .', 'cd .. && rm -rf .'],
    ['cwd home: cd proj && rm -rf ..', 'cd proj && rm -rf ..', { cwd: HOME }],
    ['cwd home: cd proj ; rm -rf . (the cd may fail)', 'cd proj ; rm -rf .', { cwd: HOME }],
    ['cwd home: cd proj || rm -rf . (runs when the cd failed)', 'cd proj || rm -rf .', { cwd: HOME }],
    ['cwd home: cd proj && x || rm -rf .', 'cd proj && true || rm -rf .', { cwd: HOME }],
    ['cwd home: true || cd proj && rm -rf . (the cd may be skipped)', 'true || cd proj && rm -rf .', { cwd: HOME }],
    ['cwd home: (cd proj) && rm -rf . (the cd ran in a subshell)', '(cd proj) && rm -rf .', { cwd: HOME }],
    ['cwd home: for-loop cd then rm', 'for d in a; do cd proj; done && rm -rf .', { cwd: HOME }],
    ['cwd home: a cd to an unknown name', 'cd $X && rm -rf .', { cwd: HOME }],
    ['cwd home: cd proj & rm -rf . (the cd ran in the background)', 'cd proj & rm -rf .', { cwd: HOME }],
    ['cwd proj: tar czf /tmp/o.tgz -C .. .', 'tar czf /tmp/o.tgz -C .. .'],
    ['cwd home: git -C . clean', 'git -C . rm -r .', { cwd: HOME }],
    ['cwd home: git -C .. add .  from proj', 'git -C .. rm -r .'],
    ['cwd home: cd proj && cd .. && rm -rf .', 'cd proj && cd .. && rm -rf .', { cwd: HOME }],
    ['cwd home: make -C . clean-all style', 'make -C .. install', { cwd: PROJ }],
    // (R9 whitelist: a `||` anywhere on the line turns the narrowing off, so this R4 allow case is now a deny)
    ['cwd home: cd proj && git add . || echo failed', 'cd proj && git add . || echo failed', { cwd: HOME }],
  ]);
  allows('F1', [
    ['cwd home: cd ~/Claude/proj && git add .', 'cd ~/Claude/proj && git add .', { cwd: HOME }],
    ['cwd home: git -C ~/Claude/proj add .', 'git -C ~/Claude/proj add .', { cwd: HOME }],
    ['cwd home: git -C proj add .', 'git -C proj add .', { cwd: HOME }],
    ['cwd home: cd proj && npx eslint .', 'cd proj && npx eslint .', { cwd: HOME }],
    ['cwd home: cd proj && prettier --write .', 'cd proj && prettier --write .', { cwd: HOME }],
    ['cwd home: cd proj && docker build .', 'cd proj && docker build .', { cwd: HOME }],
    ['cwd home: cd proj && cd src && git add .', 'cd proj && cd src && git add .', { cwd: HOME }],
    ['cwd home: cd proj && git add . && git commit -m x', 'cd proj && git add . && git commit -m x', { cwd: HOME }],
    ['cwd home: cd proj && git commit -m "$(cat msg)" && git add .', 'cd proj && git commit -m "$(cat msg)" && git add .', { cwd: HOME }],
    ['cwd home: mkdir build && cd build && cmake .. (from proj)', 'mkdir build && cd build && cmake ..', { cwd: PROJ }],
    ['cwd proj: cd build && cmake ..', 'cd build && cmake ..', { cwd: PROJ }],
    ['cwd proj: cd src && git add ../lib', 'cd src && git add ../lib', { cwd: PROJ }],
    ['cwd proj: make -C build install', 'make -C build install', { cwd: PROJ }],
    ['cwd proj: git -C src add ..', 'git -C src add ..', { cwd: PROJ }],
    ['cwd home: git -C proj/src add ..', 'git -C proj/src add ..', { cwd: HOME }],
    ['cwd home: git -C ~/Claude -C proj add .', 'git -C ~/Claude -C proj add .', { cwd: HOME }],
    ['cwd home: tar czf /tmp/o.tgz -C proj .', 'tar czf /tmp/o.tgz -C proj .', { cwd: HOME }],
    ['expr 8 / 2', 'expr 8 / 2'],
    ['expr 10 / 3 + 1', 'expr 10 / 3 + 1'],
    ['ssh host ls /', 'ssh host ls /'],
    ['ssh host ls -la /', 'ssh host ls -la /'],
    ['docker exec c ls /', 'docker exec c ls /'],
    ['vite build --base=/', 'vite build --base=/'],
    ['vite build --base /', 'vite build --base /'],
    ['rm -rf ./build (cwd proj)', 'rm -rf ./build'],
  ]);
});

describe('R4-F2: other spellings of home', () => {
  denies('F2', [
    ['rm -rf ~u', 'rm -rf ~u'],
    ['rm -rf ~$USER', 'rm -rf ~$USER'],
    ['rm -rf ~${USER}', 'rm -rf ~${USER}'],
    ['rm -rf ~u/', 'rm -rf ~u/'],
    ['rm -rf ~+ with cwd home', 'rm -rf ~+', { cwd: HOME }],
    ['cd ~ && rm -rf ~+', 'cd ~ && rm -rf ~+'],
    ['cd ~ ; rm -rf ~+', 'cd ~ ; rm -rf ~+'],
    ['rm -rf ~+/.. from proj', 'rm -rf ~+/..'],
    ['rm -rf ~- (OLDPWD is only known at run time)', 'rm -rf ~-'],
    ['rm -rf ~- after cd ~', 'cd ~; cd /tmp; rm -rf ~-'],
    ['rm -rf ~+2 (a directory-stack entry)', 'rm -rf ~+2'],
    ['rm -rf ~-2 (a directory-stack entry)', 'rm -rf ~-2'],
    ['a name holding ~+', "D='~+'; rm -rf $D", { cwd: HOME }],
    ['rm -rf ~root (another user: only known at run time)', 'rm -rf ~root'],
    ['find ~u -delete', 'find ~u -delete'],
    ['mv ~u /tmp/x', 'mv ~u /tmp/x'],
    ['rsync --delete into ~u', 'rsync -a --delete /tmp/x/ ~u/'],
  ]);
  allows('F2', [
    ['ls ~u', 'ls ~u'],
    ['ls ~+', 'ls ~+'],
    ['ls ~-', 'ls ~-'],
    ['ls ~root', 'ls ~root'],
    ['rm -rf ~u/Desktop/old', 'rm -rf ~u/Desktop/old'],
    ['rm -rf ~+/build (cwd proj)', 'rm -rf ~+/build'],
    ['cat ~u/notes.txt', 'cat ~u/notes.txt'],
    ['rm ~u/tmp-file.txt', 'rm ~u/tmp-file.txt'],
  ]);
  // $HOME is a symlink: /home/u -> /data/u
  const LINKED = { existsSync: (p) => p in files || p === '/home/u', realpath: (p) => (p === '/home/u' ? '/data/u' : p) };
  denies('F2 (symlinked home)', [
    ['rm -rf /data/u', 'rm -rf /data/u', LINKED],
    ['rm -rf /data', 'rm -rf /data', LINKED],
    ['rm -rf /data/[u]', 'rm -rf /data/[u]', LINKED],
    ['rm -rf /home/u (the lexical home)', 'rm -rf /home/u', LINKED],
    ['rm -rf ~', 'rm -rf ~', LINKED],
  ]);
  allows('F2 (symlinked home)', [
    ['rm -rf /data/u/Desktop/old', 'rm -rf /data/u/Desktop/old', LINKED],
    ['ls /data/u', 'ls /data/u', LINKED],
  ]);
});

describe('R4-F3: glob-spelled options', () => {
  const DIR = `${CFG}/pipeline`;
  denies('F3', [
    ['find DIR -delete (control)', `find ${DIR} -delete`],
    ['find DIR -[d]elete', `find ${DIR} -[d]elete`],
    ['find DIR -exe[c] rm {} +', `find ${DIR} -exe[c] rm {} +`],
    ['find DIR -?elete', `find ${DIR} -?elete`],
    ['find DIR -de*', `find ${DIR} -de*`],
    ['find DIR -[o]k', `find ${DIR} -[o]k rm {} ;`],
    ['find DIR -fprin[t]', `find ${DIR} -fprin[t] x`],
    ['a name holding -[d]elete', `D='-[d]elete'; find ${DIR} $D`],
    ['a name holding -de*', `D='-de*'; find ${DIR} $D`],
    ['a name holding a glob, quoted', `D='-[d]elete'; find ${DIR} "$D"`],
    ['sort -[o]FILE', `sort x -[o]${S}`],
    ['sort --out[p]ut=FILE', `sort x --outpu[t]=${S}`],
    ['tree -[o]FILE', `tree -[o]${S} ${CFG}`],
    ['xxd -[r]', `xxd -[r] x ${S}`],
    ['rg --pr[e]=cmd', `rg --pr[e]=cmd x ${DIR}`],
    ['rg --pre[=]cmd', `rg --pre[=]cmd x ${DIR}`],
    ['jq -[i]', `jq -[i] . ${S}`],
    ['openssl dgst -ou[t]', `openssl dgst -ou[t] ${S} x`],
    ['git diff --out[p]ut=FILE', `git diff --outpu[t]=${S}`],
    ['sed -[i]', `sed -[i] s/a/b/ ${S}`],
  ]);
  allows('F3', [
    ['find DIR -name x', `find ${DIR} -name x`],
    ['find DIR -name "*.mjs"', `find ${DIR} -name '*.mjs'`],
    ['find DIR -type f', `find ${DIR} -type f`],
    ['rg --glob=*.mjs', `rg --glob=*.mjs x ${DIR}`],
    ['rg -g*.ts', `rg -g*.ts x ${DIR}`],
    ['rg -g *.ts', `rg -g '*.ts' x ${DIR}`],
    ['rg x DIR --glob=!*.md', `rg x ${DIR} --glob='!*.md'`],
    ['a name holding a plain option', `D='-name'; find ${DIR} $D x`],
    ['git log -- *.mjs', `git log -- '*.mjs'`],
    ['sort a file', `sort ${S}`],
  ]);
});

describe('R4-F1 item 7: residual implicit-cwd and dot globs', () => {
  denies('item 7', [
    ['cwd home: rm -rf .[!.]*', 'rm -rf .[!.]*', { cwd: HOME }],
    ['cwd home: rm -rf .*', 'rm -rf .*', { cwd: HOME }],
    ['cwd home: git clean -fdx', 'git clean -fdx', { cwd: HOME }],
    ['cwd home: git clean -ffdx', 'git clean -ffdx', { cwd: HOME }],
    ['cwd home: cd . && git clean -fdx', 'cd . && git clean -fdx', { cwd: HOME }],
    ['cwd home: find -delete', 'find -delete', { cwd: HOME }],
    ['cwd /home: git clean -fd', 'git clean -fd', { cwd: '/home' }],
  ]);
  allows('item 7', [
    ['cwd proj: git clean -fdx', 'git clean -fdx'],
    ['cwd home: git clean -n', 'git clean -n', { cwd: HOME }],
    ['cwd home: git clean --dry-run -fd', 'git clean --dry-run -fd', { cwd: HOME }],
    ['cwd home: cd proj && git clean -fdx', 'cd proj && git clean -fdx', { cwd: HOME }],
    ['cwd home: git -C proj clean -fdx', 'git -C proj clean -fdx', { cwd: HOME }],
    ['cwd home: git status', 'git status', { cwd: HOME }],
  ]);
});

// the linear-scan discipline: long glob words and long chains of cd's are judged in well under a second
describe('R4 timing', () => {
  const timed = (label, line, extra, want) => test(`#288 R4 timing: ${label}`, () => {
    const t0 = performance.now();
    const r = run(line, extra);
    const ms = performance.now() - t0;
    assert.equal(r.decision, want, `${r.decision}: ${r.reason}`);
    assert.ok(ms < 2000, `took ${Math.round(ms)} ms`);
  });
  timed('a 190 kB glob option word', `find ${CFG}/pipeline -[${'a'.repeat(190000)}] x`, {}, 'allow');
  timed('a glob option of 60000 stars', `find ${CFG}/pipeline -${'*'.repeat(60000)}`, {}, 'deny');
  timed('a glob home word of 60000 stars', `rm -rf /${'*'.repeat(60000)}`, {}, 'deny');
  timed('20 cd && chains', `${'cd proj && '.repeat(20)}git add .`, { cwd: HOME }, 'allow');
  timed('60 cd && chains (more directories than are followed: fails closed)', `${'cd proj && '.repeat(60)}git add .`, { cwd: HOME }, 'deny');
});
