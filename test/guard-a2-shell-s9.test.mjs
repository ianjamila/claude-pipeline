// Why (PR A2, batch S9 — Codex review 4 of the stream rebuild, 375a463): rebuilding static text + files as one stream (S8) trusted that `echo` / `printf` / `cat`
// are the real ones (a function or alias defined on the line prints something else), kept the text after a NUL that bash drops from an argument (`$'git pu\0#'`),
// joined static text with a rewriting producer's file for a shell (`tr -d X b` prints a text the scan of b never sees), and compared the stream parts with a
// quadratic sort (60,000 parts ran past the host's 15 s hook limit, which ALLOWS the command). Each test pins the dangerous case next to the workflow that must pass.
// Fake file systems like guard-a2-shell-s8.test.mjs.
import { test } from 'node:test';
import { cpuTimed } from './helpers/timing.mjs';
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
const G = (command, spec = {}) => evaluateGitCommand(command, {
  cwd: GIT_ROOT, home: '/home/u', currentBranch: () => 'agent/x', pushDestination: () => null, issueLabels: () => [], ...fakeFs(GIT_ROOT, spec, ['sub', '/home/u']),
}).decision;
const PROJ = '/home/u/proj';
const F = (command, spec) => {
  const fs = fakeFs(PROJ, spec, ['sub', '/home/u', '/home/u/.claude']);
  return evaluateBashForFiles(command, { home: '/home/u', env: { HOME: '/home/u', ZDOTDIR: '/home/u' }, platform: 'linux', realpath: (p) => p, cwd: PROJ, ...fs, existsSync: fs.pathExists }).decision;
};
const both = (c, spec, want, why = c) => { assert.equal(G(c, spec), want, `git: ${why}`); assert.equal(F(c, spec), want, `files: ${why}`); };

// the guarded line split across two files: a push to main (git) and a write to the protected settings file (files)
const PUSH = { a: 'git p', b: 'ush origin main\n' };
const PUSH2 = { a: 'git pu', b: 'sh origin main\n' };
const WRITE = { a: 'echo x > /home/u/.cl', b: 'aude/settings.json\n' };
const SQL = { 'm.sql': 'create table t (a int);\n' };

test('S9: a static producer the line redefines (function, alias, enable) is not rebuilt as its builtin output', () => {
  for (const [c, spec] of [
    ["echo() { :; }; { echo -n '#'; cat a; cat b; } | bash", PUSH],
    ["echo() { :; }; { echo -n '#'; cat a; cat b; } | bash", WRITE],
    ["printf() { :; }; { printf '#'; cat a; cat b; } | bash", PUSH2],
    ["printf() { :; }; { printf '#'; cat a; cat b; } | bash", WRITE],
    ["function printf { :; }; { printf '#'; cat a; cat b; } | bash", PUSH2],
    ["function printf { :; }; { printf '#'; cat a; cat b; } | bash", WRITE],
    ["alias echo=:; { echo -n '#'; cat a; cat b; } | bash", PUSH],
    ["alias echo=:; { echo -n '#'; cat a; cat b; } | bash", WRITE],
    ["enable -n echo; { echo -n '#'; cat a; cat b; } | bash", WRITE],
  ]) {
    if (spec === WRITE) assert.equal(F(c, spec), 'deny', `files: ${c}`);
    else assert.equal(G(c, spec), 'deny', `git: ${c}`);
  }
  // static text and files fed to a SHELL are refused whatever the names (owner, Codex review 4: only a SQL client's stream is rebuilt)
  assert.equal(G("{ echo -n '#'; cat a; cat b; } | bash", PUSH), 'deny');
  assert.equal(F("{ echo -n '#'; cat a; cat b; } | bash", WRITE), 'deny');
  // a SQL client: rebuilt with the builtins, not when the line defines any function or can rename a command
  both("{ echo 'begin;'; cat m.sql; echo 'commit;'; } | psql", SQL, 'allow');
  for (const pre of ["f() { :; }; ", "echo() { :; }; ", "alias echo=:; ", "functions[echo]=:; ", "aliases=(echo :); ", "X=1 functions+=(echo :); ", "source ./env.sh; ", "eval 'x=1'; ", "trap '' EXIT; ", "read -A aliases <<< x; "]) {
    both(pre + "{ echo 'begin;'; cat m.sql; echo 'commit;'; } | psql", { ...SQL, 'env.sh': 'X=1\n' }, 'deny', pre);
  }
});

test('S9: static text holding a NUL (bash drops the rest of the argument) is not rebuilt', () => {
  for (const c of ["{ printf '%s' $'git pu\\0#'; cat b; } | bash", "{ echo -n $'git pu\\0#'; cat b; } | bash", "{ printf $'git pu\\0#'; cat b; } | bash"]) {
    assert.equal(G(c, { b: 'sh origin main\n' }), 'deny', `git: ${c}`);
  }
  assert.equal(F("{ printf '%s' $'echo x > /home/u/.cl\\0#'; cat b; } | bash", { b: 'aude/settings.json\n' }), 'deny');
  both("{ printf '%s' $'select 1;\\0'; cat m.sql; } | psql", SQL, 'deny');
  both("{ cat <<'EOF'\nselect 1;\0\nEOF\ncat m.sql; } | psql", SQL, 'deny'); // (a NUL byte in the command text itself)
  both("{ printf '%s\\n' 'select 1;'; cat m.sql; } | psql", SQL, 'allow');
});

test('S9: static text joined with a rewriting producer is refused for a shell, scanned for a SQL client', () => {
  for (const [c, spec, k] of [
    ["{ printf '%s' 'git pu'; tr -d X b; } | bash", { b: 'sXh origin main\n' }, 'git'],
    ["{ printf '%s' 'gi'; tr -d X b; } | bash", { b: 'Xt puXsh origin maXin\n' }, 'git'],
    ["{ printf '%s' 'echo x > /home/u/.cl'; tr -d X b; } | bash", { b: 'auXde/settings.json\n' }, 'files'],
    ["{ printf '%s' 'echo x > /home/u/.cl'; sed 's/X//' b; } | bash", { b: 'auXde/settings.json\n' }, 'files'],
    ["{ echo 'set -e'; sed -n '1,9p' b; } | node", { b: 'ok\n' }, 'git'],
  ]) assert.equal(k === 'git' ? G(c, spec) : F(c, spec), 'deny', `${k}: ${c}`);
  // the replay's database workflow: static text + a rewritten migration fed to psql (only its escapes run)
  both("{ echo 'begin;'; sed -n '1,5p' m.sql; echo 'rollback;'; } | psql", SQL, 'allow');
  both("(echo 'begin;'; sed -n '1,5p' m.sql) | psql", SQL, 'allow');
});

test('S9: a stream of many parts is refused quickly, not judged part by part past the hook limit', () => {
  const few = `{ echo "begin;"; cat ${Array(100).fill('a').join(' ')}; } | psql`;
  both(few, { a: 'select 1;\n' }, 'deny');
  const many = `{ echo "#"; cat ${Array(60000).fill('a').join(' ')}; } | psql`;
  const { ms } = cpuTimed(() => both(many, { a: 'select 1;\n' }, 'deny'));
  assert.ok(ms < 5000, `took ${Math.round(ms)} ms of CPU`);
  // a migration of a few parts stays allowed
  both(`{ echo "begin;"; cat ${Array(8).fill('m.sql').join(' ')}; echo "commit;"; } | psql`, SQL, 'allow');
});
