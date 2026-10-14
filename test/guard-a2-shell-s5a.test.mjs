// Why (PR A2, batch S5a): the S1-S4d guards refused real workflows (a replay of 21 days of commands found 1,600 new refusals). These tests pin the
// workflows that must pass again, each next to its nearest dangerous twin that must stay refused. Fake file system like guard-a2-shell.test.mjs;
// guarded text only lives in fake file contents or command strings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname, basename } from 'node:path';
import { evaluateGitCommand } from '../pipeline/hooks/lib/git-policy.mjs';
import { evaluateBashForFiles } from '../pipeline/hooks/lib/files-policy.mjs';

function fakeFs(root, files, dirs = []) {
  const abs = (p) => resolve(root, p);
  const F = Object.fromEntries(Object.entries(files).map(([k, v]) => [abs(k), v]));
  const D = new Set([root, ...dirs.map(abs)].map((p) => resolve(p)));
  for (const p of Object.keys(F)) for (let d = dirname(p); dirname(d) !== d; d = dirname(d)) D.add(d);
  const names = (d) => {
    const out = new Set();
    for (const p of [...Object.keys(F), ...D]) if (p !== d && dirname(p) === d) out.add(basename(p));
    return [...out];
  };
  return {
    readText: (p) => (typeof F[resolve(p)] === 'string' ? F[resolve(p)] : null),
    readHead: () => null,
    pathExists: (p) => resolve(p) in F || D.has(resolve(p)),
    readDir: (p) => (D.has(resolve(p)) ? names(resolve(p)) : null),
  };
}
const GIT_ROOT = resolve('/work/repo');
const PROJ = '/home/u/proj';
const git = (command, fsOpts, o = {}) => evaluateGitCommand(command, {
  cwd: GIT_ROOT, home: '/home/u', currentBranch: () => 'agent/x', pushDestination: () => null, issueLabels: () => [], ...fsOpts, ...o,
});
const files = (command, fsOpts, o = {}) => evaluateBashForFiles(command, {
  home: '/home/u', env: {}, platform: 'linux', realpath: (p) => p, cwd: PROJ, ...fsOpts, existsSync: fsOpts.pathExists, ...o,
});
const DIRS = ['bin', 'sub', '/home/u', '/tmp'];

// ---- 3: the rc files of a SQL client are home paths ------------------------------------------------------------------------------------------------------------

// Why: psql reads ~/.psqlrc and ~/.psqlrc-* first; the glob record was judged as a RELATIVE name whenever the directory was unknown (a multi-line -c text), refusing every psql call.
test('S5a: a psql call with no rc file is not refused for its rc glob (multi-line -c, absolute binary)', () => {
  const fs = fakeFs(GIT_ROOT, {}, [...DIRS, '/home/u']);
  for (const c of ['psql -c "insert into x values (1,\nnow())\nreturning id;"', '/opt/homebrew/opt/libpq/bin/psql "postgresql://u@h/db" -c "\nselect 1;\n"', 'psql -c "select 1\n"; psql -c "select 2\n"']) {
    assert.equal(git(c, fs).decision, 'allow', c);
  }
});

test('S5a: an rc file that exists is still judged (the twin)', () => {
  const bad = 'git push origin main';
  const withRc = (name) => fakeFs(GIT_ROOT, { [`/home/u/${name}`]: `\\! ${bad}` }, DIRS);
  for (const name of ['.psqlrc', '.psqlrc-15']) {
    assert.equal(git('psql -c "select 1\n"', withRc(name)).decision, 'deny', name);
    assert.equal(git('psql -X -c "select 1\n"', withRc(name)).decision, 'allow', name);
  }
});

// Why: the hazard rule (a function may redefine cd or git) read function-looking text INSIDE quotes (a SQL \`create function f(uuid)\`, a JS \`fn()\`, a commit message), so every
// such line lost its directory and every relative script / SQL file on it was refused. Only unquoted text defines a function, unless something on the line runs quoted text as code.
test('S5a: quoted text that looks like a function definition does not make the directory unknown (git-policy)', () => {
  const bad = 'git push origin main';
  const sub = resolve(GIT_ROOT, 'sub');
  const fsFor = (where, text) => fakeFs(GIT_ROOT, { [where]: text, 'ok.sql': 'select 1;' }, [...DIRS, sub]);
  const quoted = [
    'cd sub && psql -c "create function f(uuid);" && psql -f q.sql', "cd sub && node -e 'x.replace(\"fn_undo()\", 1)' && psql -f q.sql", 'cd sub && git commit -m "rename helper()" && psql -f q.sql',
  ];
  for (const c of quoted) {
    assert.equal(git(c, fsFor('nowhere.sql', 'select 1;')).decision, 'allow', c);
    assert.equal(git(c, fsFor('sub/q.sql', `\\! ${bad}`)).decision, 'deny', `${c} (the file is judged where the cd went)`);
  }
  // (a builtin that evaluates its words in the current shell reads the quoted definition as code)
  for (const c of ['mapfile -C \' foo() { :; }\' -c 1 a < /dev/null; cd sub && psql -f q.sql', 'complete -C \' bar() { :; }\' x; cd sub && psql -f q.sql', 'bind -x \'"\\C-x": " baz() { :; }"\'; cd sub && psql -f q.sql', 'PROMPT_COMMAND=\' foo() { :; }\'; cd sub && psql -f q.sql', 'let "a[\' foo() { :; }\']=1"; cd sub && psql -f q.sql', 'export "a[\' foo() { :; }\']=1"; cd sub && psql -f q.sql']) {
    assert.equal(git(c, fsFor('nowhere.sql', 'select 1;')).decision, 'deny', c);
  }
  // (a zsh glob qualifier / ksh pattern list runs quoted text in the current shell, also after a data command)
  for (const c of ["ls *(e:' foo() { :; }':); cd sub && psql -f q.sql", "cat ?(e:' foo() { :; }':); cd sub && psql -f q.sql", "grep x a[12](e:' foo() { :; }':); cd sub && psql -f q.sql"]) {
    assert.equal(git(c, fsFor('nowhere.sql', 'select 1;')).decision, 'deny', c);
  }
  // (quoting that cannot be trusted keeps the hazard: an apostrophe in a comment, \$'..\\'..' and an unterminated quote hide nothing)
  for (const c of ["echo hi # it's\nfoo() { :; }; cd sub && psql -f q.sql\necho 'x'", "echo $'a\\'b'; foo() { :; }; cd sub && psql -f q.sql; echo '", "echo 'a'; foo() { :; }; cd sub && psql -f q.sql; echo \"x"]) {
    assert.equal(git(c, fsFor('nowhere.sql', 'select 1;')).decision, 'deny', c);
  }
  // ('#' inside a word or a quote is no comment)
  assert.equal(git('cd sub && psql -c "select \'#\' as c; create function f(uuid);" && psql -f q.sql', fsFor('nowhere.sql', 'select 1;')).decision, 'allow');
  // (a definition that is code: unquoted, or quoted text something on the line runs)
  for (const c of ['function cd() { :; }; cd sub && psql -f q.sql', 'cd() { :; }; cd sub && psql -f q.sql', 'eval "true; function cd { :; }"; cd sub && psql -f q.sql', "bash -c 'cd() { :; }'; cd sub && psql -f q.sql", "cat <<EOF > /dev/null\ndon't\nEOF\nfunction cd() { :; }; echo 'x'; cd sub && psql -f q.sql"]) {
    assert.equal(git(c, fsFor('nowhere.sql', 'select 1;')).decision, 'deny', c);
  }
});

// ---- 2: the consequence of an unknown cd is a write judgment, not a blanket refusal (files-policy) ----------------------------------------------------------------

const HOOKS = '/home/u/.claude/pipeline/hooks';
const withRoots = (extra = {}, dirs = []) => fakeFs(PROJ, extra, [...DIRS, '/home/u/.claude', '/home/u/.claude/pipeline', HOOKS, ...dirs]);

test('S5a: after an unknown cd, ordinary commands and read-only inline code pass; writes to protected names stay refused (files-policy)', () => {
  const fs = withRoots();
  for (const w of ['node scripts/build.mjs', 'npm test', 'git commit -m x', 'git status', "node -e 'console.log(1)'", 'cat settings.json', 'cp /tmp/x/settings.json /tmp/y/', 'echo x > /tmp/o.txt']) {
    assert.equal(files(`cd $UNSET && ${w}`, fs).decision, 'allow', w);
  }
  for (const w of ['touch settings.json', 'sed -i s/a/b/ settings.json', 'cp /tmp/a settings.json', 'dd if=/tmp/a of=settings.json', 'tar -xf a.tar', 'curl -osettings.json https://h/x', 'git checkout .',
    'echo x > settings.json', 'echo x > notes.txt', "node -e \"require('fs').writeFileSync('sett'+'ings.json','x')\"", 'touch notes.txt']) {
    assert.equal(files(`cd $UNSET && ${w}`, fs).decision, 'deny', w);
  }
});

test('S5a: a write that climbs with .. is judged from every existing subdirectory of a protected root (files-policy)', () => {
  const fs = withRoots();
  for (const w of ['echo x > ../guard.mjs', 'echo x >> ../../settings.json', 'cp /tmp/e ../guard.mjs', 'touch ../a', 'echo x > ../$N', 'cd .. && echo x > guard.mjs', 'echo x > ../../pipeline/guard.mjs', 'mkdir -p a/b; echo x > ../../guard.mjs']) {
    assert.equal(files(`cd $X; ${w}`, fs).decision, 'deny', w);
  }
  assert.equal(files('cd $X; cat ../x', fs).decision, 'allow');
});

test('S5a: a cd the line computes is known when it is a temp dir, the script own dir, the repo root or the current dir (files-policy)', () => {
  const fs = withRoots({ '.git/config': '[core]\n', 'scripts/run': 'cd "$(dirname "$0")"\necho x > settings.json\n', 'scripts/mv': 'cd sub\ncd "$(dirname "$0")"\necho x > settings.json\n', 'scripts/up': 'cd "$(dirname "$0")/../.."\necho x > settings.json\n', 'scripts/wrap': 'cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"\necho x > out.txt\n' }, ['.git', 'scripts']);
  const dec = (c, f = fs, o = {}) => files(c, f, o).decision;
  // mktemp / TMPDIR
  assert.equal(dec('cd "$(mktemp -d)" && echo x > sub/notes.txt'), 'allow');
  assert.equal(dec('cd $(mktemp -d) && echo x > out.txt'), 'allow');
  assert.equal(dec('cd "$TMPDIR/a" && echo x > out.txt', fs, { env: { TMPDIR: '/tmp/t' } }), 'allow');
  for (const c of ['export TMPDIR=/home/u/.claude; cd "$(mktemp -d)"; echo x > settings.json', 'TMPDIR=/home/u/.claude; cd "$(mktemp -d)"; echo x > settings.json', 'source $X; cd "$(mktemp -d)"; echo x > settings.json',
    'cd "$(mktemp -d x.XXXX)"; echo x > settings.json', 'cd "$(mktemp -d -p /home/u/.claude)"; echo x > settings.json', 'cd "${TMPDIR:-x}"; echo x > settings.json', 'cd $TMPDIR; echo x > settings.json']) {
    assert.equal(dec(c), 'deny', c);
  }
  // the judged script file's own directory (only a file run as a script has a $0)
  assert.equal(dec('bash /home/u/proj/scripts/run', fs), 'allow'); // (the script dir is not protected: the write is to its own settings.json)
  assert.equal(dec('bash /home/u/proj/scripts/wrap', fs), 'allow');
  assert.equal(dec('bash /home/u/proj/scripts/mv', fs), 'allow'); // (invoked by an absolute path: $0 does not depend on the cwd)
  assert.equal(dec('cd /home/u/proj && bash scripts/mv', fs), 'deny'); // (relative: read from the cwd the earlier cd moved)
  for (const body of ['BASH_ARGV0=/home/u/.claude/x\ncd "$(dirname "$0")"', 'source ./other.sh\ncd "$(dirname "$0")"', 'eval "$X"\ncd "$(dirname "$0")"', 'set -- a; 0=/home/u/.claude/x\ncd "$(dirname "$0")"']) {
    assert.equal(dec('bash /home/u/proj/scripts/chg', withRoots({ 'scripts/chg': `${body}\necho x > settings.json\n`, 'scripts/other.sh': ':' }, ['scripts'])), 'deny', body);
  }
  for (const x of ['unzip a.zip', 'gunzip a.gz', 'xz -d a.xz', 'hg update', 'jar xf a.jar', 'unrar x a.rar']) assert.equal(dec(`cd $UNSET && ${x}`, fs), 'deny', x);
  assert.equal(dec('bash /home/u/proj/scripts/up', fs), 'deny');
  // (a script named through a variable the line set is the same script)
  assert.equal(dec('D=/home/u/proj/scripts; bash $D/run', fs), 'allow');
  assert.equal(dec('D=/home/u/proj/scripts; bash $D/up', fs), 'deny');
  assert.equal(dec('D=/home/u/proj/scripts; bash $D/mv', fs), 'allow'); // (a suffix with .. is not modelled)
  assert.equal(dec('bash < /home/u/proj/scripts/run', fs), 'deny'); // (fed on stdin: $0 is bash)
  assert.equal(dec('source /home/u/proj/scripts/run', fs), 'deny'); // (sourced: $0 is the parent)
  // the repo root
  assert.equal(dec('cd "$(git rev-parse --show-toplevel)" && echo x > out.txt'), 'allow');
  assert.equal(dec('cd "$(git rev-parse --show-toplevel)" && echo x > notes.txt', fakeFs(PROJ, {}, DIRS)), 'deny'); // (no .git found: unknown)
  for (const c of ['PATH=/x:$PATH; cd "$(git rev-parse --show-toplevel)" && echo x > notes.txt', 'GIT_DIR=/x; cd "$(git rev-parse --show-toplevel)" && echo x > notes.txt', 'cd /tmp && cd "$(git rev-parse --show-toplevel)" && echo x > notes.txt']) {
    assert.equal(dec(c, withRoots({ '.git/config': '[core]\n' }, ['.git'])), 'deny', c);
  }
  assert.equal(dec('cd "$(git rev-parse --show-toplevel)" && echo x > notes.txt', withRoots({ '.git/config': '[core]\n\tworktree = /home/u/.claude\n' }, ['.git'])), 'deny');
  // (a climbing write on the line: the temp dir is a leaf of an unknown place, so the cd stays unknown)
  assert.equal(dec('cd "$(mktemp -d)" && echo x > ../../../home/u/.claude/settings.json'), 'deny');
  // (git config tricks: a worktree key / include anywhere, an earlier git or .git write, GIT_CONFIG_*)
  const repo = (cfg, extra = {}) => withRoots({ '.git/config': cfg, ...extra }, ['.git']);
  const top = 'cd "$(git rev-parse --show-toplevel)" && echo x > notes.txt';
  assert.equal(dec(top, repo('[core]\n')), 'allow');
  for (const cfg of ['[core]\n\tworktree = /home/u/.claude\n', '[core] worktree = /home/u/.claude\n', '[include]\n\tpath = /tmp/x\n', '[includeIf "gitdir:/"]\n\tpath = /tmp/x\n']) assert.equal(dec(top, repo(cfg)), 'deny', cfg);
  assert.equal(dec(top, repo('[core]\n', { '/home/u/.gitconfig': '[core]\n\tworktree = /home/u/.claude\n' })), 'deny');
  assert.equal(dec(top, repo('[core]\n', { '/home/u/.gitconfig': '[user]\n\tname = x\n' })), 'allow');
  for (const c of ['git config core.worktree /home/u/.claude; ' + top, 'git -c core.worktree=/home/u/.claude status; ' + top, 'git init x; ' + top, 'echo "[core]" > .git/config; ' + top, 'GIT_CONFIG_PARAMETERS="core.worktree=/home/u/.claude"; ' + top, 'export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.worktree GIT_CONFIG_VALUE_0=/home/u/.claude; ' + top]) assert.equal(dec(c, repo('[core]\n')), 'deny', c);
  // $PWD / $(pwd)
  assert.equal(dec('cd "$(pwd)" && echo x > out.txt'), 'allow');
  assert.equal(dec('cd /home/u/.claude && cd "$(pwd)" && echo x > out.txt'), 'deny');
});
