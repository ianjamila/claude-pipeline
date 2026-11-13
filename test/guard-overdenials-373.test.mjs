// Issue #373: the everyday over-denials left after #288 R19. The cd narrowing of the bash files guard is a WHITELIST read from the parser (`cmds.shape`); it now also accepts
//   - `||`, `|`, `&` between simple commands,
//   - one top-level subshell `( … )`, brace group `{ …; }` or `if CD; then …; [else …;] fi` (none inside another),
//   - `git -C "$(git rev-parse --show-toplevel)"` (resolved at hook time).
// Everything else (a variable cd target, nested constructs, eval / source, loops, functions, `!`, a cd that may have run in another shell) still reads the command against every directory of the line.
// Home is /home/u and so is the cwd; the lines are read from there (a relative write from home reaches the protected folders, so an allow means the narrowing worked).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateBashForFiles } from '../pipeline/hooks/lib/files-policy.mjs';
import { simpleCommands } from '../pipeline/hooks/lib/shell-parse.mjs';
import { cpuTimed } from './helpers/timing.mjs';

const HOME = '/home/u';
const BASE = { home: HOME, env: {}, platform: 'linux', cwd: HOME, realpath: (p) => p, existsSync: () => false, readText: () => null };
const run = (command, extra = {}) => evaluateBashForFiles(command, { ...BASE, ...extra });
const P = 'cd /home/u/proj';
const TOP = '"$(git rev-parse --show-toplevel)"';

const denies = (label, cases) => {
  for (const [name, line, extra] of cases) {
    test(`#373 ${label} denies: ${name}`, () => {
      const r = run(line, extra);
      assert.equal(r.decision, 'deny', `${JSON.stringify(line)} -> ${r.decision}`);
    });
  }
};
const allows = (label, cases) => {
  for (const [name, line, extra] of cases) {
    test(`#373 ${label} allows: ${name}`, () => {
      const r = run(line, extra);
      assert.equal(r.decision, 'allow', `${JSON.stringify(line)} -> ${r.decision}: ${r.reason}`);
    });
  }
};

describe('#373 task 1: || | & between simple commands', () => {
  allows('joins', [
    ['|| after the write', `${P} && git clean -fd || echo failed`],
    ['| after the write', `${P} && git clean -fd | tail -5`],
    ['2>&1 | after the write', `${P} && git clean -fd 2>&1 | tail -5`],
    ['a background write', `${P} && rm -rf build &`],
    ['a join earlier on its own line', `true || false\n${P} && find . -delete`],
    ['a pipe earlier on its own line', `echo x | cat\n${P} && find . -delete`],
    ['a job earlier on its own line', `sleep 1 &\n${P} && find . -delete`],
  ]);
  denies('joins', [
    ['a cd after | (it may run in a subshell)', `a | ${P} && find . -delete`],
    ['a cd after || (it may be skipped)', `a || ${P} && find . -delete`],
    ['the cd is a stage of a pipeline', `${P} | true && find . -delete`],
    ['after || the chain is over', `${P} && b || c && find . -delete`],
    ['a cd in the background', `${P} & find . -delete`],
    ['a write after || (runs when the cd failed)', `${P} || find . -delete`],
    ['a write after a pipe stage', `${P} && a | find . -delete`],
    ['a second cd in a pipeline stage (zsh runs the last stage here)', `${P} && cd .. | true && find . -delete`],
    ['the cd in a pipeline before a ;', `${P} | true; find . -delete`],
  ]);
});

describe('#373 task 2: a subshell', () => {
  allows('subshell', [
    ['cd and write inside', `(${P} && git clean -fd)`],
    ['the subshell after a cd', `${P} && (git clean -fd)`],
    ['two writes inside after a cd', `${P} && (find . -delete; rm -rf build)`],
    ['a cd inside does not move the outer chain', `${P} && (cd sub && true) && find . -delete`],
    ['a pipeline stage', `(${P} && git clean -fd) | tail -5`],
    ['a subshell followed by ||', `(${P} && git clean -fd) || echo failed`],
  ]);
  denies('subshell', [
    ['the cd does not leak out', `(${P}) && find . -delete`],
    ['the cd does not leak out (;)', `(${P}); find . -delete`],
    ['; after the cd inside (the cd may fail)', `(${P}; find . -delete)`],
    ['a variable cd target inside', '(cd $X && find . -delete)'],
    ['a variable cd target before', 'cd $X && (find . -delete)'],
    ['nested subshells', `( (${P}) && find . -delete )`],
    ['a subshell inside a group', `{ (${P} && find . -delete); }`],
    ['arithmetic-looking double parentheses', `((${P} && find . -delete))`],
    ['eval inside', `(${P} && eval x; find . -delete)`],
    ['source inside', `(source x; find . -delete)`],
    ['a second cd up inside', `(${P} && cd .. && find . -delete)`],
    ['a subshell after a cd that left it', `${P} && cd .. && (find . -delete)`],
    ['an empty subshell then a group', `() { ${P}; } && find . -delete`],
  ]);
});

describe('#373 task 3: a brace group', () => {
  allows('group', [
    ['the group after a cd', `${P} && { git clean -fd; }`],
    ['a cd in the group persists', `{ ${P}; } && find . -delete`],
    ['cd and write in the group', `{ ${P} && rm -rf build; }`],
    ['the group on lines', `{\n${P} && find . -delete\n}`],
    ['two writes after a cd', `${P} && { find . -delete; rm -rf build; }`],
  ]);
  denies('group', [
    ['a command between the cd and the end of the group', `{ ${P}; true; } && find . -delete`],
    ['a write after ; in the group (the cd may fail)', `{ ${P}; find . -delete; }`],
    ['a variable cd target in the group', '{ cd $X; } && find . -delete'],
    ['a cd up in the group', `${P} && { cd ..; find . -delete; }`],
    ['a group inside a group', `{ { ${P}; } && find . -delete; }`],
    ['a group after ||', `a || { ${P}; } && find . -delete`],
    ['a group as a pipeline stage', `a | { ${P}; } && find . -delete`],
    ['eval in the group', `{ eval x; } && ${P} && find . -delete; find . -delete`],
    ['source in the group', `{ source x; } && find . -delete`],
    ['an empty group (zsh)', `${P} || { } && find . -delete`],
    ['a group that is a function body', `f() { ${P}; }; f && find . -delete`],
    ['the closing brace is no command (a word after it)', `{ ${P}; } b && find . -delete`],
  ]);
});

describe('#373 task 4: if CD; then …; fi', () => {
  allows('if', [
    ['one write', `if cd /home/u/proj; then git clean -fd; fi`],
    ['two writes in the body', `if cd /home/u/proj; then git clean -fd; rm -rf build; fi`],
    ['on lines', `if cd /home/u/proj\nthen\n  find . -delete\nfi`],
    ['with an else (read against every directory)', `if cd /home/u/proj; then find . -delete; else echo no; fi`],
    ['the cd after an &&', `cd /home/u && if cd proj; then find . -delete; fi`],
    ['a cd inside the body followed by &&', `if cd /home/u/proj; then cd sub && find . -delete; fi`],
  ]);
  denies('if', [
    ['after the fi the chain is over', `if ${P}; then :; fi; find . -delete`],
    ['the body of a negated condition', `if ! ${P}; then find . -delete; fi`],
    ['the condition has an ||', `if ${P} || true; then find . -delete; fi`],
    ['the condition has a second command', `if ${P}; true; then find . -delete; fi`],
    ['a cd up in the body', `if ${P}; then cd ..; find . -delete; fi`],
    ['the else body', `if ${P}; then :; else find . -delete; fi`],
    ['an elif', `if ${P}; then :; elif true; then find . -delete; fi`],
    ['a variable cd target', 'if cd $X; then find . -delete; fi'],
    ['a condition that is no cd', 'if true; then find . -delete; fi'],
    ['a background cd in the condition', `if ${P} & then find . -delete; fi`],
    ['an if inside an if', `if ${P}; then if ${P}; then :; fi; find . -delete; fi`],
    ['an if inside a group', `{ if ${P}; then find . -delete; fi; }`],
    ['a pipeline stage cd in the condition', `if a | ${P}; then find . -delete; fi`],
    ['a while loop', `while true; do ${P}; done; find . -delete`],
    ['a for loop', `for i in 1; do ${P}; done && find . -delete`],
    ['a function definition', `f() { :; }; ${P} && find . -delete`],
    ['a case', `case x in y) ${P};; esac; find . -delete`],
    ['eval in the body', `if ${P}; then eval x; find . -delete; fi`],
    ['source in the body', `if ${P}; then source x; find . -delete; fi`],
  ]);
});

describe('#373 task 5: git -C "$(git rev-parse --show-toplevel)"', () => {
  const repo = { existsSync: (p) => ['/home/u/proj/.git', '/home/u/proj/.git/config'].includes(p), readText: (p) => (p.endsWith('config') ? '[core]\n' : null) };
  const dotfiles = { existsSync: (p) => ['/home/u/.git', '/home/u/.git/config'].includes(p), readText: (p) => (p.endsWith('config') ? '[core]\n' : null) };
  allows('toplevel', [
    ['quoted, from home (no repository: git fails outside one)', `git -C ${TOP} clean -fd`],
    ['unquoted', 'git -C $(git rev-parse --show-toplevel) clean -fd'],
    ['from a repository below home', `git -C ${TOP} clean -fd`, { ...repo, cwd: '/home/u/proj/sub' }],
    ['after a literal cd', `${P} && git -C ${TOP} clean -fd`],
    ['a git add', `git -C ${TOP} add .`],
  ]);
  denies('toplevel', [
    ['GIT_DIR on the line', `GIT_DIR=/x git -C ${TOP} clean -fd`],
    ['GIT_WORK_TREE exported', `export GIT_WORK_TREE=/home/u; git -C ${TOP} clean -fd`],
    ['GIT_CEILING_DIRECTORIES on the line', `GIT_CEILING_DIRECTORIES=/home git -C ${TOP} clean -fd`],
    ['GIT_DIR in the environment', `git -C ${TOP} clean -fd`, { env: { GIT_DIR: '/x' } }],
    ['an earlier git init', `git init && git -C ${TOP} clean -fd`],
    ['an earlier git command', `git status && git -C ${TOP} clean -fd`],
    ['an extra command in the substitution', 'git -C "$(git rev-parse --show-toplevel; cd ~)" clean -fd'],
    ['a trailing space in the substitution text', 'git -C "$(git rev-parse --show-toplevel) " clean -fd'],
    ['a suffix that climbs', 'git -C "$(git rev-parse --show-toplevel)/.." clean -fd'],
    ['a different substitution', 'git -C "$(git rev-parse --git-dir)" clean -fd'],
    ['a repository at home itself', `git -C ${TOP} clean -fd`, dotfiles],
    ['a repository whose configuration moves the root', `git -C ${TOP} clean -fd`, { ...repo, readText: (p) => (p.endsWith('config') ? '[core]\n\tworktree = /home/u\n' : null), cwd: '/home/u/proj/sub' }],
    ['git clone into the directory', `git -C ${TOP} clone x .`],
    ['eval earlier', `eval 'x'; git -C ${TOP} clean -fd`],
    ['a variable cd target before it', `cd $X && git -C ${TOP} clean -fd`],
  ]);
});

describe('#373 task 6: a $\'…\' string no longer turns the narrowing off', () => {
  allows('ansi-c', [
    ["a $' string between the cd and the write", `${P} && echo $'x' && find . -delete`],
    ["a $' string in a subshell", `(${P} && echo $'x' && find . -delete)`],
  ]);
  denies('ansi-c', [
    ['a $" string still does', `${P} && echo $"x" && find . -delete`],
    ["a $' pair hiding a subshell cd", `echo $'\\'' ; (${P}) && find . -delete \\'`],
    ["a $' pair hiding a brace group cd", `echo $'\\'' ; { ${P}; true; } && find . -delete \\'`],
    ["a $' pair hiding an if", `echo $'\\'' ; if ${P}; then :; fi; find . -delete \\'`],
    ["a $' pair hiding a !", `echo $'\\'' ; ! cd /tmp/nonexistent && find . -delete \\'`],
  ]);
});

describe('#373: the parser reports the shapes (cmds.shape)', () => {
  const shape = (line) => simpleCommands(line).shape;
  test('#373 shape: null for every construct off the whitelist', () => {
    const lines = ['! a', 'a && ! b', 'time a', 'coproc a', '{ a } always { b }', 'f() { a; }', 'function f { a; }', 'while a; do b; done', 'for i in 1; do a; done', 'until a; do b; done', 'case x in y) a;; esac', '[[ a ]] && b',
      '( (a) )', '(( a ))', '{ { a; }; }', '(a; { b; })', '{ (a); }', 'if a; then if b; then c; fi; fi', 'if a; then b; elif c; then d; fi', 'if a; then b', 'if a; then b; fi fi', 'fi', 'a && }', '{ a', '( a', 'a )', '{ }', '( )', '{ a; } b', '(a) b c } d',
      'if a & then b; fi', 'if a; then b & fi', 'a && { }', 'cat <<EOF\nx\\\nEOF\n( a )', 'if a; fi', 'then a', 'else a', '() { a; }', 'if (a); then b; fi'];
    for (const line of lines) assert.equal(shape(line), null, JSON.stringify(line));
  });
  test('#373 shape: an event list for the whitelisted constructs', () => {
    const kinds = (line) => shape(line).map((e) => `${e.kind}@${e.at}${e.sep}`);
    assert.deepEqual(shape('cd a && b | c || d &'), []);
    assert.deepEqual(kinds('cd a && (b; c) && d'), ['(@1&&', ')@3;']);
    assert.deepEqual(kinds('{ cd a; } && b'), ['{@0;', '}@1;']);
    assert.deepEqual(kinds('if cd a; then b; else c; fi; d'), ['if@0;', 'then@1;', 'else@2;', 'fi@3;']);
    assert.deepEqual(kinds('(a) | (b)'), ['(@0;', ')@1;', '(@1|', ')@2;']);
  });
  test('#373 shape: a command that opens with if / then / else / { carries that word (lead)', () => {
    const cmds = simpleCommands('if cd a; then b; else c; fi\n{ d; }');
    assert.deepEqual(cmds.map((c) => c.lead), ['if', 'then', 'else', '{']);
  });
  test('#373 shape: plainSeq keeps its strict meaning', () => {
    for (const line of ['a || b', 'a | b', 'a &', '(a)', '{ a; }', 'if a; then b; fi']) assert.equal(simpleCommands(line).plainSeq, false, line);
  });
});

describe('#373 review round 1 (R1-B1, R1-B2, R1-B3, R1-F1, R1-F2, R1-F3)', () => {
  const fsOf = (files) => ({ existsSync: (p) => Object.hasOwn(files, p), readText: (p) => files[p] ?? null });
  const repoAtHome = fsOf({ '/home/u/.git': null, '/home/u/.git/config': '[core]\n' });
  const dotsDir = (extra = {}) => ({ '/home/u/proj/.git': null, '/home/u/proj/.git/config': '[core]\n', ...extra });
  test('R1-B1: a brace group entered by || | or & exports no chain through its }', () => {
    for (const line of ['true || { true; cd /tmp; } && find . -delete', 'true || { true && cd /tmp; } && find . -delete', 'a | { true; cd /tmp; } && find . -delete', 'a & { true; cd /tmp; } && find . -delete']) {
      assert.equal(run(line).decision, 'deny', line);
    }
  });
  test('R1-B1: a group entered by ; or && still carries the cd out', () => {
    for (const line of ['true; { true; cd /tmp; } && find . -delete', 'true && { true; cd /tmp; } && find . -delete']) {
      assert.equal(run(line).decision, 'allow', line);
    }
  });
  test('R1-B2: a toplevel word beside another -C or a wrapper chdir is unknown', () => {
    for (const line of [`git -C /tmp -C ${TOP} clean -fd`, `env -C /tmp git -C ${TOP} clean -fd`, `env --chdir=/tmp git -C ${TOP} clean -fd`, `sudo -D /tmp git -C ${TOP} clean -fd`]) {
      assert.equal(run(line, repoAtHome).decision, 'deny', line);
    }
  });
  test('R1-F2: a second -C after the toplevel word is unknown', () => {
    assert.equal(run(`git -C ${TOP} -C sub clean -fd`, repoAtHome).decision, 'deny');
    assert.equal(run(`git -C ${TOP} -C ../u clean -fd`, { ...repoAtHome, cwd: '/tmp' }).decision, 'deny');
  });
  test('R1-B3: a repository-selecting global option beside the toplevel word is unknown', () => {
    for (const opt of ['--git-dir=/tmp/repo', '--work-tree=/home/u', '-c core.worktree=/home/u', '--bare', '--namespace=x', '--git-dir /tmp/repo']) {
      assert.equal(run(`git ${opt} -C ${TOP} clean -fd`).decision, 'deny', opt);
    }
  });
  test('R1-B3: a harmless global option beside the toplevel word is still read', () => {
    assert.equal(run(`git --no-pager -C ${TOP} clean -fd`).decision, 'allow');
  });
  const linked = (cfg) => fsOf({
    '/home/u/wt/.git': 'gitdir: /home/u/main/.git/worktrees/x\n',
    '/home/u/main/.git/worktrees/x/commondir': '../..\n',
    '/home/u/main/.git/worktrees/x/HEAD': 'ref: refs/heads/agent/worktree-x\n',
    '/home/u/main/.git/worktrees/x/gitdir': '/home/u/wt/.git\n',
    '/home/u/main/.git/config': cfg,
  });
  const branchy = '[core]\n\trepositoryformatversion = 0\n[branch "agent/worktree-x"]\n\tremote = origin\n';
  test('R1-F1: a linked worktree (no config in its own git dir, a branch named worktree) is read', () => {
    const ex = { ...linked(branchy), cwd: '/home/u/wt/sub' };
    assert.equal(run(`git -C ${TOP} clean -fd`, ex).decision, 'allow');
    assert.equal(run(`cd ${TOP} && git clean -fd`, ex).decision, 'allow');
  });
  test('R1-F1: a main checkout whose config has a branch named worktree is read', () => {
    const ex = { ...fsOf(dotsDir({ '/home/u/proj/.git/config': branchy })), cwd: '/home/u/proj/sub' };
    assert.equal(run(`git -C ${TOP} clean -fd`, ex).decision, 'allow');
    assert.equal(run(`cd ${TOP} && git clean -fd`, ex).decision, 'allow');
  });
  test('R1-F1: a real core.worktree / extensions.worktreeConfig key still makes the root unknown', () => {
    for (const cfg of ['[core]\n\tworktree = /home/u\n', '[core]\nWorktree=/home/u\n', '[core] worktree = /home/u\n', '[extensions]\n  worktreeConfig = true\n']) {
      assert.equal(run(`git -C ${TOP} clean -fd`, { ...linked(cfg), cwd: '/home/u/wt/sub' }).decision, 'deny', cfg);
      assert.equal(run(`git -C ${TOP} clean -fd`, { ...fsOf(dotsDir({ '/home/u/proj/.git/config': cfg })), cwd: '/home/u/proj/sub' }).decision, 'deny', cfg);
    }
  });
  test('R1-F3: an ancestor that is itself a git directory makes the root unknown', () => {
    const ex = fsOf({ '/home/u/.git': 'gitdir: /home/u/sep.git\n', '/home/u/sep.git/config': '[core]\n\tbare = false\n', '/home/u/sep.git/HEAD': 'ref: refs/heads/main\n', '/home/u/sep.git/objects': null });
    assert.equal(run(`git -C ${TOP} clean -fd`, { ...ex, cwd: '/home/u/sep.git/refs' }).decision, 'deny');
    assert.equal(run(`git -C ${TOP} clean -fd`, { ...fsOf({ '/work/r.git/HEAD': null, '/work/r.git/objects': null }), cwd: '/work/r.git/refs' }).decision, 'deny');
  });
});

describe('#373: a long line of each new shape stays linear', () => {
  const timed = (name, line) => test(`#373 timing: ${name}`, () => {
    const t = cpuTimed(() => run(line));
    assert.ok(t.ms < 2000, `${name} took ${t.ms} ms`);
    const p = cpuTimed(() => simpleCommands(line));
    assert.ok(p.ms < 1000, `${name}: simpleCommands took ${p.ms} ms`);
  });
  const n = 3000;
  timed('| and || joins', `${P} && ` + Array.from({ length: n }, (_, i) => `a${i} | b || c`).join(' && '));
  timed('& jobs', `${P} && ` + Array.from({ length: n }, (_, i) => `a${i} &`).join(' '));
  timed('a long subshell', `${P} && (` + Array.from({ length: n }, (_, i) => `echo ${i}`).join('; ') + ')');
  timed('many subshells', `${P} && ` + Array.from({ length: n }, (_, i) => `(echo ${i})`).join(' && '));
  timed('a long brace group', `{ ${P}; ` + Array.from({ length: n }, (_, i) => `echo ${i}`).join('; ') + '; }');
  timed('many brace groups', Array.from({ length: n }, (_, i) => `{ echo ${i}; }`).join(' && '));
  timed('a long if body', `if ${P}; then ` + Array.from({ length: n }, (_, i) => `echo ${i}`).join('; ') + '; fi');
  timed('many ifs', Array.from({ length: n }, () => `if ${P}; then :; fi`).join('; '));
  timed('many git -C toplevel', Array.from({ length: 1000 }, () => `git -C ${TOP} status`).join('; '));
  timed('many unclosed openers', '( '.repeat(5000) + 'a');
  timed('many closers', ') '.repeat(5000));
  timed('many then words', 'if a; then '.repeat(2000));
});
