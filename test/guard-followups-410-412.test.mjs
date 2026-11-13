// Follow-ups from #409 / #373 (issues #410, #411, #412): the cd narrowing of the bash files guard.
// Home is /home/u and so is the cwd; the lines are read from there (a relative write from home reaches the protected folders, so an allow means the narrowing worked).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateBashForFiles } from '../pipeline/hooks/lib/files-policy.mjs';

const HOME = '/home/u';
const BASE = { home: HOME, env: {}, platform: 'linux', cwd: HOME, realpath: (p) => p, existsSync: () => false, readText: () => null };
const run = (command, extra = {}) => evaluateBashForFiles(command, { ...BASE, ...extra });
const P = 'cd /home/u/proj';
const decide = (decision, cases) => {
  for (const [name, line, extra] of cases) {
    test(`${decision}: ${name}`, () => {
      const r = run(line, extra);
      assert.equal(r.decision, decision, `${JSON.stringify(line)} -> ${r.decision}: ${r.reason}`);
    });
  }
};

describe('#410: a cd whose only || alternative leaves the shell surely succeeded for what follows', () => {
  decide('allow', [
    ['cd X || exit 1, write on the next line', `${P} || exit 1\nfind . -delete`],
    ['cd X || exit, write after ;', `${P} || exit; find . -delete`],
    ['cd X || return 1, write on the next line', `${P} || return 1\nfind . -delete`],
    ['cd X || exit 1 && write', `${P} || exit 1 && find . -delete`],
    ['a join before the cd does not matter', `true && ${P} || exit 1\nfind . -delete`],
    ['a subshell entered by ||', '[ -d x ] || (cd /home/u/proj && find . -delete)'],
    ['a subshell entered by | (its own cd runs first)', 'true | (cd /home/u/proj && find . -delete)'],
    ['a subshell entered by ||, exit alternative inside', '[ -d x ] || (cd /home/u/proj || exit 1; find . -delete)'],
    ['a brace group entered by ||', '[ -d x ] || { cd /home/u/proj && find . -delete; }'],
  ]);
  decide('deny', [
    ['cd X || exit 1 | cat (the exit is a pipeline stage: a subshell)', `${P} || exit 1 | cat\nfind . -delete`],
    ['cd X || exit 1 & (the exit is a background job)', `${P} || exit 1 &\nfind . -delete`],
    ['cd X || echo failed (the shell goes on)', `${P} || echo failed\nfind . -delete`],
    ['cd X || true', `${P} || true\nfind . -delete`],
    ['cd X || exit 1 in a pipeline stage before it', `a | ${P} || exit 1\nfind . -delete`],
    ['cd X after ||', `a || ${P} || exit 1\nfind . -delete`],
    ['write after || is still read widely', `${P} || find . -delete`],
    ['a subshell entered by ||: a write after the ) is read against every directory', '[ -d x ] || (cd /home/u/proj && true); find . -delete'],
    ['a cd inside the || subshell does not leak out of it', 'true || (cd /home/u/proj); find . -delete'],
    ['cd to the home itself still reaches home', `cd /home/u || exit 1\nfind . -delete`],
  ]);
});

describe('#411: a brace group entered by & runs in this shell (only the command before the & is the job)', () => {
  decide('allow', [
    ['the group cd carries out of the group', 'a & { true; cd /tmp; } && find . -delete'],
    ['the group cd is the narrowed directory (the write is not in the home)', 'a & { true; cd /home/u/proj; } && find . -delete'],
    ['a write inside the group after its cd', 'a & { cd /home/u/proj && find . -delete; }'],
  ]);
  decide('deny', [
    ['the group cd to home itself', 'a & { true; cd /home/u; } && find . -delete'],
    ['a group entered by || still exports no chain', 'true || { true; cd /tmp; } && find . -delete'],
    ['a group entered by | still exports no chain', 'a | { true; cd /tmp; } && find . -delete'],
    ['a group that is itself backgrounded runs in a subshell', '{ cd /tmp; } & find . -delete'],
  ]);
});

describe('#412 / #373: the repository root walk (git -C "$(git rev-parse --show-toplevel)") reads every configuration file that can move the root', () => {
  const TOP = '"$(git rev-parse --show-toplevel)"';
  const fsOf = (files) => ({ existsSync: (p) => Object.hasOwn(files, p), readText: (p) => files[p] ?? null });
  const WT = '/home/u/main/.git/worktrees/x';
  const linked = (extra) => fsOf({
    '/home/u/wt/.git': `gitdir: ${WT}\n`,
    [`${WT}/commondir`]: '../..\n',
    [`${WT}/HEAD`]: 'ref: refs/heads/agent/worktree-x\n',
    [`${WT}/gitdir`]: '/home/u/wt/.git\n',
    '/home/u/main/.git/config': '[core]\n\trepositoryformatversion = 0\n',
    ...extra,
  });
  const clean = (ex) => run(`git -C ${TOP} clean -fd`, { ...ex, cwd: '/home/u/wt/sub' });
  test('a linked worktree with plain configs is read (the baseline of the pins below)', () => {
    assert.equal(clean(linked({})).decision, 'allow');
  });
  for (const [name, files] of [
    ['its own config', { [`${WT}/config`]: '[core]\n\tworktree = /home/u\n' }],
    ['its config.worktree', { [`${WT}/config.worktree`]: '[core]\n\tworktree = /home/u\n' }],
    ['its own config, extensions.worktreeConfig', { [`${WT}/config`]: '[extensions]\n\tworktreeConfig = true\n' }],
    ['its config.worktree, in a section line', { [`${WT}/config.worktree`]: '[core] worktree = /home/u\n' }],
  ]) {
    test(`#412 pin: a worktree key in ${name} makes the toplevel unknown (deny)`, () => {
      assert.equal(clean(linked(files)).decision, 'deny');
    });
  }
  test('#412 pin: an unreadable own config of a linked worktree makes the toplevel unknown', () => {
    assert.equal(clean({ ...linked({}), existsSync: (p) => p === `${WT}/config` || linked({}).existsSync(p) }).decision, 'deny');
  });

  // #373 comment (from #409): the key test reads any whitespace, and a key with no value
  const rooted = (cfg) => ({ ...fsOf({ '/home/u/proj/.git': null, '/home/u/proj/.git/config': cfg }), cwd: '/home/u/proj/sub' });
  for (const [name, cfg] of [
    ['a key with no value', '[core]\n\tworktree\n'],
    ['a key with no value and no newline', '[core]\n\tworktree'],
    ['a key with trailing blanks and no value', '[core]\n\tworktree  \t\n'],
    ['a form feed before the key', '[core]\n\f worktree = /home/u\n'],
    ['a vertical tab before the key', '[core]\n\v worktree=/home/u\n'],
    ['a form feed before the equals sign', '[core]\n\tworktree\f= /home/u\n'],
    ['worktreeConfig with no value', '[extensions]\n\tworktreeConfig\n'],
  ]) {
    test(`#373 config key: ${name} makes the toplevel unknown (deny)`, () => {
      assert.equal(run(`git -C ${TOP} clean -fd`, rooted(cfg)).decision, 'deny', JSON.stringify(cfg));
    });
  }
  test('#373 config key: a key that only starts with worktree, or a branch / remote named so, is still read', () => {
    for (const cfg of ['[core]\n\tworktreeFoo = 1\n', '[branch "worktree"]\n\tremote = origin\n', '[remote "worktree"]\n\turl = x\n', '[core]\n\t# worktree = /x\n']) {
      assert.equal(run(`git -C ${TOP} clean -fd`, rooted(cfg)).decision, 'allow', JSON.stringify(cfg));
    }
  });
  test('#373 git dir: HEAD + objects + refs make a directory a git directory (root unknown)', () => {
    const ex = fsOf({ '/home/u/sep.git/HEAD': null, '/home/u/sep.git/objects': null, '/home/u/sep.git/refs': null, '/home/u/sep.git/config': '[core]\n' });
    assert.equal(run(`git -C ${TOP} clean -fd`, { ...ex, cwd: '/home/u/sep.git/refs' }).decision, 'deny');
  });
  test('#373 git dir: a folder with HEAD and objects but no refs (a case-insensitive disk finds `head`) is no git directory', () => {
    const ex = { ...fsOf({ '/home/u/proj/.git': null, '/home/u/proj/.git/config': '[core]\n', '/home/u/proj/sub/HEAD': null, '/home/u/proj/sub/objects': null }), cwd: '/home/u/proj/sub/x' };
    assert.equal(run(`git -C ${TOP} clean -fd`, ex).decision, 'allow');
  });
});
