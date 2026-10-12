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
