// Issue #265 (d), (e), (g) and the `cd X || { …; exit 1; }` over-denial (#373 follow-up) of the bash files guard.
// Home is /home/u. A read of a protected file is allowed when the tool is read-only, so an allow below means "read-only" and a deny means the tool can run or write something.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateBashForFiles } from '../pipeline/hooks/lib/files-policy.mjs';
import { cpuTimed } from './helpers/timing.mjs';

const HOME = '/home/u';
const BASE = { home: HOME, env: {}, platform: 'linux', cwd: '/home/u/proj', realpath: (p) => p, existsSync: () => false, readText: () => null };
const run = (command, extra = {}) => evaluateBashForFiles(command, { ...BASE, ...extra });
const S = '/home/u/.claude/settings.json'; // a protected file
const decide = (decision, cases) => {
  for (const [name, line, extra] of cases) {
    test(`${decision}: ${name}`, () => {
      const r = run(line, extra);
      assert.equal(r.decision, decision, `${JSON.stringify(line)} -> ${r.decision}: ${r.reason}`);
    });
  }
};
const withEnv = (env) => ({ env });

describe('#265 (d): tool settings inherited from the hook\'s own environment', () => {
  decide('deny', [
    ['LESSOPEN runs a program for less', `less ${S}`, withEnv({ LESSOPEN: '|cmd %s' })],
    ['LESSOPEN for more', `more ${S}`, withEnv({ LESSOPEN: '|cmd %s' })],
    ['LESSCLOSE', `less ${S}`, withEnv({ LESSCLOSE: 'cmd %s %s' })],
    ['LESSKEY writes and reads a key file', `less ${S}`, withEnv({ LESSKEY: '/tmp/k' })],
    ['LESSHISTFILE names where less writes', `less ${S}`, withEnv({ LESSHISTFILE: '/tmp/h' })],
    ['an odd LESS value (not plain short options)', `less ${S}`, withEnv({ LESS: '--lesskey-src=/tmp/k' })],
    ['GIT_EXTERNAL_DIFF', `git diff --no-index /tmp/a ${S}`, withEnv({ GIT_EXTERNAL_DIFF: '/tmp/x.sh' })],
    ['GIT_PAGER that is no plain pager', `git log -p ${S}`, withEnv({ GIT_PAGER: '/tmp/p.sh' })],
    ['PAGER that is no plain pager', `git diff ${S}`, withEnv({ PAGER: '/tmp/p.sh' })],
    ['GIT_CONFIG_COUNT carries config', `git diff ${S}`, withEnv({ GIT_CONFIG_COUNT: '1' })],
    ['GIT_CONFIG_GLOBAL', `git diff ${S}`, withEnv({ GIT_CONFIG_GLOBAL: '/tmp/gc' })],
    ['GIT_EXEC_PATH', `git diff ${S}`, withEnv({ GIT_EXEC_PATH: '/tmp/x' })],
    ['GIT_TRACE writes a file', `git diff ${S}`, withEnv({ GIT_TRACE: '/tmp/t' })],
    ['an unknown GIT_ name is read as a risk', `git diff ${S}`, withEnv({ GIT_SOMETHING_NEW: '1' })],
    ['RIPGREP_CONFIG_PATH (the rc may carry --pre)', `rg x ${S}`, withEnv({ RIPGREP_CONFIG_PATH: '/tmp/rc' })],
    ['BAT_CONFIG_PATH', `bat ${S}`, withEnv({ BAT_CONFIG_PATH: '/tmp/b' })],
    ['BAT_PAGER that is no plain pager', `bat ${S}`, withEnv({ BAT_PAGER: '/tmp/p.sh' })],
  ]);
  // The choice (criterion c): a plain, everyday value does not turn a read of a protected file into a deny. A tool setting is a risk by its NAME (it names a program or a file)
  // or, for a pager and for LESS, by its VALUE (a bare pager such as `less -R` or `cat`, or short options, is what a terminal normally has).
  decide('allow', [
    ['LESS=-R', `less ${S}`, withEnv({ LESS: '-R' })],
    ['LESS=-FRX', `less ${S}`, withEnv({ LESS: '-FRX' })],
    ['LESS=-R --quit-if-one-screen', `less ${S}`, withEnv({ LESS: '-R --quit-if-one-screen' })],
    ['LESSCHARSET', `less ${S}`, withEnv({ LESSCHARSET: 'utf-8' })],
    ['PAGER=less', `git diff ${S}`, withEnv({ PAGER: 'less' })],
    ['PAGER=less -R', `git diff ${S}`, withEnv({ PAGER: 'less -R' })],
    ['PAGER=/usr/bin/less', `git diff ${S}`, withEnv({ PAGER: '/usr/bin/less' })],
    ['GIT_PAGER=cat', `git diff ${S}`, withEnv({ GIT_PAGER: 'cat' })],
    ['MANPAGER=less', `less ${S}`, withEnv({ MANPAGER: 'less -X' })],
    ['MORE=-c', `more ${S}`, withEnv({ MORE: '-c' })],
    ['BAT_THEME', `bat ${S}`, withEnv({ BAT_THEME: 'ansi' })],
    ['GIT_EDITOR / author / prompt settings', `git log -p ${S}`, withEnv({ GIT_EDITOR: 'true', GIT_AUTHOR_NAME: 'x', GIT_COMMITTER_EMAIL: 'x@y', GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/usr/bin/true', GIT_SSH_COMMAND: 'ssh -o X=1' })],
    ['a tool the variable does not touch (cat with LESSOPEN set)', `cat ${S}`, withEnv({ LESSOPEN: '|cmd %s', GIT_EXTERNAL_DIFF: '/tmp/x.sh', RIPGREP_CONFIG_PATH: '/tmp/rc' })],
    ['an unrelated environment', `less ${S}`, withEnv({ EDITOR: 'vim', LANG: 'C', NODE_ENV: 'test' })],
  ]);
});

describe('#265 (e): a line that shadows a name makes every later command on it not read-only', () => {
  decide('deny', [
    ['function cat { … }; cat FILE', `function cat { tee "$@"; }; echo x | cat ${S}`],
    ['function keyword with parens', `function cat() { tee "$@"; }; cat ${S}`],
    ['wc() { … }; wc FILE', `wc() { node evil.mjs "$@"; }; wc ${S}`],
    ['a definition on its own line', `cat() { tee "$@"; }\ncat ${S}`],
    ['alias cat=tee', `alias cat=tee; cat ${S}`],
    ['alias in a chain', `alias cat=tee && cat ${S}`],
    ['PATH=/tmp/evil:$PATH', `PATH=/tmp/evil:$PATH; cat ${S}`],
    ['export PATH=…', `export PATH=/tmp/evil:$PATH; cat ${S}`],
    ['declare -x PATH=…', `declare -x PATH=/tmp/evil:$PATH; cat ${S}`],
    ['PATH=… as the prefix of the command itself', `PATH=/tmp/evil cat ${S}`],
    ['PATH ending in the current directory', `export PATH=$PATH:.; cat ${S}`],
    ['PATH with an empty entry (the current directory)', `export PATH=/usr/bin::$PATH; cat ${S}`],
    ['PATH from a name', `export PATH=$X:$PATH; cat ${S}`],
    ['the later command, not the first, is the one read', `echo hi; alias cat=tee; echo there; cat ${S}`],
  ]);
  decide('allow', [
    ['a read BEFORE the definition', `cat ${S}; f() { echo hi; }`],
    ['a read before an alias', `cat ${S}; alias ll='ls -l'`],
    ['no definition at all', `echo hi; cat ${S}`],
    ['PATH with the usual system and tool folders', `export PATH=/opt/homebrew/bin:$PATH; cat ${S}`],
    ['PATH with the folders of the CLAUDE.md note', `export PATH="$HOME/.local/bin:/opt/homebrew/bin:$PATH"; cat ${S}`],
    ['PATH appended with a system folder', `PATH=$PATH:/usr/local/bin; cat ${S}`],
    ['PATH as a prefix with system folders', `PATH=/usr/bin:/bin cat ${S}`],
  ]);
  // The write after a definition is caught by the same rules as ever; a read-only tool is just no longer trusted.
  decide('deny', [
    ['the write itself is still a write', `f() { echo hi; }; echo x > ${S}`],
  ]);
});

describe('#265 (g): a long script is brace-expanded in bounded chunks', () => {
  const D = ['.cl', 'aude'].join('');
  const BR = ['.cla', '{ude,x}'].join('');
  const pad = (n) => '# padding line that says nothing\n'.repeat(n);
  const files = (path, text) => ({ existsSync: (p) => p === path, readText: (p) => (p === path ? text : null) });
  const prog = (body, n = 400) => ({ cmd: 'node /home/u/proj/big.mjs', ...files('/home/u/proj/big.mjs', `${pad(n)}${body}\n`) });
  const go = (c) => run(c.cmd, { existsSync: c.existsSync, readText: c.readText });
  test('a program past 5,000 characters with a brace-split protected path and a write is denied', () => {
    const c = prog(`execSync('echo x > ~/${BR}/settings.json');`);
    assert.ok(c.readText('/home/u/proj/big.mjs').length > 5000);
    const r = go(c);
    assert.equal(r.decision, 'deny', r.reason);
  });
  test('the same program with the path spelled whole is denied (control)', () => {
    assert.equal(go(prog(`execSync('echo x > ~/${D}/settings.json');`)).decision, 'deny');
  });
  test('a long program with another brace split of the folder name is read too', () => {
    assert.equal(go(prog(`fs.writeFileSync('/home/u/${['.cla','ud{e,f}'].join('')}/settings.json', 'x');`)).decision, 'deny');
  });
  test('a long program with braces that are no protected path stays allowed', () => {
    assert.equal(go(prog("execSync('cp a.txt b.{txt,bak}'); const o = { a: 1, b: 2 };")).decision, 'allow');
  });
  test('a long program with no braces at all stays allowed', () => {
    assert.equal(go(prog("execSync('echo hi');")).decision, 'allow');
  });
  test('a brace group split by the chunk edge is still read (the cut falls on whitespace only)', () => {
    for (const n of [150, 151, 152, 153, 154, 155, 156, 157]) {
      const r = go(prog(`execSync('echo x > ~/${BR}/settings.json');`, n));
      assert.equal(r.decision, 'deny', `pad ${n}`);
    }
  });
  test('a single 6,000-character word is cut where it stands and the program is still read', () => {
    const c = { cmd: 'node /home/u/proj/big.mjs', ...files('/home/u/proj/big.mjs', `x{a,b}${'y'.repeat(6000)}~/${BR}/settings.json\nexecSync('echo x > y')\n`) };
    const r = go(c);
    assert.equal(r.decision, 'deny', r.reason);
  });
  test('a 900 kB brace-heavy program stays inside the CPU bound', () => {
    const body = "execSync('echo {a,b}{c,d}{e,f} {1..9}');\n".repeat(20_000);
    const c = { cmd: 'node /home/u/proj/big.mjs', ...files('/home/u/proj/big.mjs', body) };
    assert.ok(c.readText('/home/u/proj/big.mjs').length < 1_000_000);
    const { r, ms } = cpuTimed(() => go(c));
    assert.ok(r.decision === 'allow' || r.decision === 'deny');
    assert.ok(ms < 4000, `${ms} ms`);
  });
  // #425 R1-F4: a minified bundle: long whitespace-free runs with a few comma groups and many lone `{` (the expansion regex is quadratic on such a run; one round can also grow a piece far past the cap)
  test('a 900 kB minified-like program (3,900-character runs, comma groups and many lone braces) stays inside the CPU bound', () => {
    const run = `f{a,b}${'{x=1;'.repeat(760)}g{c,d}${'{y'.repeat(20)}`.slice(0, 3900);
    const body = `${run}\n`.repeat(230);
    const c = { cmd: 'node /home/u/proj/big.mjs', ...files('/home/u/proj/big.mjs', body) };
    assert.ok(c.readText('/home/u/proj/big.mjs').length > 850_000 && c.readText('/home/u/proj/big.mjs').length < 1_000_000);
    const { r, ms } = cpuTimed(() => go(c));
    assert.ok(r.decision === 'allow' || r.decision === 'deny');
    assert.ok(ms < 4000, `${ms} ms`);
  });
});

describe('cd X || { …; exit 1; } narrows what follows (everyday shape, as cd X || exit 1)', () => {
  const HOMECWD = { cwd: HOME };
  const P = 'cd /home/u/proj';
  decide('allow', [
    ['the shape of the request', `${P} || { echo "no dir"; exit 1; }; npm test > ${'/home/u'}/x.log`, HOMECWD],
    ['a find -delete after it (a relative write from the home would reach the protected folders)', `${P} || { echo "no dir"; exit 1; }; find . -delete`, HOMECWD],
    ['a group on several lines', `${P} || {\n  echo "no dir"\n  exit 1\n}\nfind . -delete`, HOMECWD],
    ['exit alone in the group', `${P} || { exit 1; }; find . -delete`, HOMECWD],
    ['joined by && after the group', `${P} || { echo no; exit 1; } && find . -delete`, HOMECWD],
    ['a cd inside the group only runs when the first failed, and then leaves', `${P} || { cd /home/u; exit 1; }; find . -delete`, HOMECWD],
    ['two messages before the exit', `${P} || { echo a; echo b; exit 2; }; find . -delete`, HOMECWD],
  ]);
  decide('deny', [
    ['return in the group (R1-B1: a top-level return does not leave the shell)', `${P} || { echo no; return 1; }; find . -delete`, HOMECWD],
    ['a redirection on the group closer (R1-B2: a failed redirection keeps the exit from running)', `${P} || { echo no; exit 1; } < /missing; find . -delete`, HOMECWD],
    ['the group does not end in an exit', `${P} || { echo failed; }; find . -delete`, HOMECWD],
    ['the exit is only reached when echo succeeds (&&)', `${P} || { echo failed && exit 1; }; find . -delete`, HOMECWD],
    ['the exit is only reached when echo fails (||)', `${P} || { echo failed || exit 1; }; find . -delete`, HOMECWD],
    ['the exit is a background job', `${P} || { echo failed; exit 1 & }; find . -delete`, HOMECWD],
    ['the exit is a pipeline stage', `${P} || { echo failed; exit 1 | cat; }; find . -delete`, HOMECWD],
    ['the group is a pipeline stage after its closer', `${P} || { echo failed; exit 1; } | cat; find . -delete`, HOMECWD],
    ['the group is run in the background', `${P} || { echo failed; exit 1; } &\nfind . -delete`, HOMECWD],
    ['a write is not hidden in the group', `${P} || { find . -delete; exit 1; }; echo done`, HOMECWD],
    ['a protected write after the group is still caught', `${P} || { echo no; exit 1; }; echo x > ${S}`, HOMECWD],
    ['a relative protected write after a cd to the folder itself', `cd /home/u/.claude || { echo no; exit 1; }; echo x > settings.json`, HOMECWD],
    ['a cd to the home itself still reaches the home', `cd /home/u || { echo no; exit 1; }; find . -delete`, HOMECWD],
    ['a cd that follows ||', `a || ${P} || { echo no; exit 1; }; find . -delete`, HOMECWD],
  ]);
});
