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
    // R1-B1 (Codex round 1): a top-level `return` is an error and the shell goes on (only a function or a sourced file leaves), so it is no exit
    ['cd X || return 1 (a top-level return does not leave)', `${P} || return 1\nfind . -delete`],
    ['set +e; cd /missing || return 1; find . -delete', 'set +e; cd /missing || return 1; find . -delete'],
    ['cd X || { …; return 1; }', `${P} || { echo no; return 1; }; find . -delete`],
    // R1-B2: a failed redirection keeps the exit from running, so the shell goes on after the failed cd
    ['set +e; cd /missing || exit 1 < /missing; find . -delete', 'set +e; cd /missing || exit 1 < /missing; find . -delete'],
    ['cd X || exit 1 2>/dev/null (a redirection on the exit)', `${P} || exit 1 2>/dev/null\nfind . -delete`],
    ['cd X || { exit 1; } < /missing (a redirection on the group)', `${P} || { exit 1; } < /missing; find . -delete`],
    ['the same with the set +e of the report', 'set +e; cd /missing || { exit 1; } < /missing; find . -delete'],
    ['cd X || { echo e; exit 1 < /missing; } (a redirection on the exit inside the group)', `${P} || { echo e; exit 1 < /missing; }; find . -delete`],
    ['cd X || { exit 1; } 2>/dev/null (a redirection after the closer)', `${P} || { exit 1; } 2>/dev/null; find . -delete`],
  ]);
  decide('deny', [
    // R1-F1 (#425 round 1): an exit with extra arguments is refused ("too many arguments") and the shell goes on; a run-time word may split into two
    ['cd /missing || exit 1 2; find . -delete', 'cd /missing || exit 1 2; find . -delete'],
    ['cd X || exit 1 2 (two words after exit)', `${P} || exit 1 2\nfind . -delete`],
    ['cd X || exit 1 2 && write', `${P} || exit 1 2 && find . -delete`],
    ['cd X || { echo no; exit 1 2; } (the group form)', `${P} || { echo no; exit 1 2; }; find . -delete`],
    ['cd X || exit $X (a run-time word may split)', `${P} || exit $X; find . -delete`],
    ['cd X || exit "$X" 1', `${P} || exit "$X" 1; find . -delete`],
    ['cd X || exit abc (not a number: refused)', `${P} || exit abc; find . -delete`],
  ]);
  decide('allow', [
    ['cd X || exit 1 (still narrowed)', `${P} || exit 1; find . -delete`],
    ['cd X || exit (still narrowed)', `${P} || exit; find . -delete`],
    ['cd X || { echo no; exit 2; } (still narrowed)', `${P} || { echo no; exit 2; }; find . -delete`],
  ]);
  decide('allow', [
    // (the everyday shapes keep narrowing: a redirection on the echo is not one on the exit or the group)
    ['cd ~/Claude/proj || exit 1; npm test (the report\'s everyday shape)', 'cd ~/Claude/proj || exit 1; npm test'],
    ['cd X || { echo "no dir" >&2; exit 1; }; npm test', 'cd ~/Claude/proj || { echo "no dir" >&2; exit 1; }; npm test'],
    ['the same, a write after it', `${P} || { echo "no dir" >&2; exit 1; }; find . -delete`],
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

describe('#380 / #383: which argument words may vanish at run time (AUTO_CD: a lone run-time command word may be a directory)', () => {
  const at = { cwd: '/home/u/proj' };
  const runner = { cwd: '/home/u/proj', env: { RUNNER: '/home/u/.claude' } };
  decide('allow', [
    ['a quoted word whose name starts the unquoted command name ($PYTHON "$P")', '$PYTHON "$P"; find . -delete', at],
    ['the same with $NODE "$N"', '$NODE "$N"; find . -delete', at],
    ['a quoted word that is also the stem of an unquoted redirect target', '"$BIN" "$f" > $f.log; find . -delete', at],
    ['a quoted scalar is an empty word, not a vanished one', '$D "$X"; find . -delete', at],
    ['a partly quoted word never vanishes', '$D "a"$X; find . -delete', at],
    ['#425 R2-B1: the everyday quoted-dir glob alone stays allowed', '$RUNNER "$dir"/*.sh', runner],
    ['#425 R2-B1: the everyday quoted-dir glob then a command that writes nothing relative', '$RUNNER "$dir"/*.sh && echo ok', runner],
    ['#425 R2-B1: the quoted-dir glob with an unset runner, alone and then an echo', '$RUNNER "$dir"/*.sh && echo ok', at],
    ['#425 R2-B1: the quoted-dir glob alone with an unset runner', '$RUNNER "$dir"/*.sh', at],
    ['#425 R2-F1: an empty quote glued to a variable is a kept (empty) word', '$D ""$X; rm -f settings.json', runner],
  ]);
  decide('deny', [
    ['the same variable unquoted can vanish', '$D $P; find . -delete', at],
    ['an unquoted word beside a quoted one of the same text', '$D "$P" $P; find . -delete', at],
    ['a quoted "$@" vanishes with no parameters (#383)', '"$RUNNER" "$@"; rm -f settings.json', runner],
    ['a quoted "${@}" vanishes too', '"$RUNNER" "${@}"; rm -f settings.json', runner],
    ['a quoted "${arr[@]}" vanishes with an empty array', '"$RUNNER" "${arr[@]}"; rm -f settings.json', runner],
    ['an unquoted $@', '$RUNNER $@; rm -f settings.json', runner],
    ['#425 R1-F3: an empty quote then a glob (nullglob: no match, no word)', '$D ""*.nomatch; rm -f settings.json', runner],
    ['#425 R2-B1: a quoted dir then a glob may vanish (nullglob), a relative write follows', '$RUNNER "$dir"/*.sh; rm -f settings.json', runner],
    ['#425 R2-B1: the quoted-dir glob, then a relative destructive write from a cwd that reaches a protected folder (r19 / #383 precedent)', '$RUNNER "$dir"/*.sh; find . -delete', at],
    ['#425 R2-B1: a quoted word then a glob (nullglob)', '$D "x"*; rm -f settings.json', runner],
    ['#425 R2-F1: an empty quote glued to a zsh numeric range (nullglob)', '$D ""<->; rm -f settings.json', runner],
  ]);
});

describe('#379: CDPATH counts only when it may hold a value (an empty assignment and `unset CDPATH` do not)', () => {
  const files = (map) => ({ cwd: '/home/u/proj', existsSync: (p) => Object.hasOwn(map, p), readText: (p) => map[p] ?? null });
  const W = 'echo x > settings.json'; // (a protected file only in a directory above the project)
  decide('allow', [
    ['an empty prefix assignment', 'CDPATH= cd sub && find . -delete'],
    ['an empty assignment with quotes', 'CDPATH="" cd sub && find . -delete'],
    ['an empty assignment on its own', 'CDPATH=; cd sub && find . -delete'],
    ['the script idiom', 'CDPATH= cd -- sub && find . -delete'],
    ['unset CDPATH', 'unset CDPATH; cd sub && find . -delete'],
    ['unset -v CDPATH', 'unset -v CDPATH\ncd sub && find . -delete'],
    ['a sourced file with the empty idiom', `. /home/u/a.sh; ${W}`, files({ '/home/u/a.sh': 'CDPATH= cd sub\n' })],
    ['a sourced file with unset CDPATH', `. /home/u/a.sh; ${W}`, files({ '/home/u/a.sh': 'unset CDPATH\ncd sub\n' })],
  ]);
  decide('deny', [
    ['a value', 'CDPATH=/x cd sub && find . -delete'],
    ['a value after an unset', 'unset CDPATH; CDPATH=/x; cd sub && find . -delete'],
    ['a value after an empty one', 'CDPATH= true; CDPATH=/x; cd sub && find . -delete'],
    ['a run-time value', 'CDPATH=$X cd sub && find . -delete'],
    ['an export of the name', 'export CDPATH; cd sub && find . -delete'],
    ['a lowercase cdpath array', 'cdpath=(/x); cd sub && find . -delete'],
    ['unset of another name beside it', 'unset FOO CDPATH; cd sub && find . -delete'],
    ['a sourced file with a value', `. /home/u/a.sh; ${W}`, files({ '/home/u/a.sh': 'export CDPATH=/y\ncd sub\n' })],
    ['the environment', 'unset CDPATH; cd sub && find . -delete', { env: { CDPATH: '/x' } }],
  ]);
});

describe('#384: a subshell that surrounds a loop does not undo the loop\'s repeated climb', () => {
  const DEEP = { cwd: '/home/u/a/b/c/d/proj' };
  decide('deny', [
    ['a subshell around a for loop of cd ..', '(for i in 1 2 3 4 5; do cd ..; done; find . -delete)', DEEP],
    ['a subshell around a while loop', '(while true; do cd ..; done; find . -delete)', DEEP],
    ['a subshell around a function called repeatedly', '(f() { cd ..; }; f; f; f; f; find . -delete)', DEEP],
    ['no subshell at all (kept)', 'for i in 1 2 3 4 5; do cd ..; done; find . -delete', DEEP],
  ]);
  decide('allow', [
    ['a subshell inside the loop body (the cd is lost each time)', 'for i in 1 2 3 4 5; do (cd ..); done; find . -delete', DEEP],
    ['a subshell inside the loop body, then the write in it', 'for i in 1 2 3; do (cd ../web && rm -rf dist); done', DEEP],
    ['a subshell inside a function body', 'f() { (cd ..); }; f; f; find . -delete', DEEP],
    ['a subshell, no loop at all', '(cd .. && true); find . -delete', DEEP],
  ]);
});

describe('#385 / #386: a CDPATH set by an outer file or by a later source reaches the nested file and the cached verdict', () => {
  const files = (map) => ({ cwd: '/home/u/proj', existsSync: (p) => Object.hasOwn(map, p) || p === '/home/u/proj/skills', readText: (p) => map[p] ?? null });
  const W = 'echo x > settings.json';
  decide('deny', [
    ['#385: outer file sets CDPATH, then sources an inner file with a plain cd', `source ./outer.sh; ${W}`, files({ '/home/u/proj/outer.sh': 'export CDPATH=/home/u/lib\n. /home/u/proj/inner.sh\n', '/home/u/proj/inner.sh': 'cd skills\n' })],
    ['#386: a written script run before and after a source that sets CDPATH', `printf 'cd skills && find . -delete\\n' > n.sh; bash n.sh; source ./env.sh; bash n.sh`, files({ '/home/u/proj/env.sh': 'export CDPATH=/home/u/lib\n' })],
  ]);
  decide('allow', [
    ['#385: no CDPATH anywhere, a plain cd in the nested file narrows', `source ./outer.sh; ${W}`, files({ '/home/u/proj/outer.sh': 'export FOO=1\n. /home/u/proj/inner.sh\n', '/home/u/proj/inner.sh': 'cd skills\n' })],
  ]);
});
