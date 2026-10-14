// Why (PR A2, batch S8 — static text and files in one stream): since the Codex recheck of a5c0e5a a stream that mixes static text (echo, printf, a heredoc) with
// files was refused outright, which refused daily database work (`{ echo "begin;"; cat migration.sql; cat <<'SQL' ... SQL } | psql`, 7 of 8 new refusals in the
// 21-day replay 34bacb5 -> 828f36d). The stream is now rebuilt in the order its producers run, from the exact text each static producer prints (echo's newline,
// printf's format, a heredoc's last newline) and the files' texts, and judged as one text. A producer whose output cannot be rebuilt exactly (an expansion, a
// backslash echo may interpret, a format printf would process, an unquoted heredoc that expands) or that may not run / prints elsewhere still makes the stream
// refused. Each test pins the workflow that must pass next to the dangerous twin that must stay refused. Fake file systems like guard-a2-shell-s7.test.mjs.
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
const G = (command, spec = {}) => evaluateGitCommand(command, {
  cwd: GIT_ROOT, home: '/home/u', currentBranch: () => 'agent/x', pushDestination: () => null, issueLabels: () => [], ...fakeFs(GIT_ROOT, spec, ['sub', '/home/u']),
}).decision;
const PROJ = '/home/u/proj';
const F = (command, spec) => {
  const fs = fakeFs(PROJ, spec, ['sub', '/home/u', '/home/u/.claude']);
  return evaluateBashForFiles(command, { home: '/home/u', env: { HOME: '/home/u', ZDOTDIR: '/home/u' }, platform: 'linux', realpath: (p) => p, cwd: PROJ, ...fs, existsSync: fs.pathExists }).decision;
};
const both = (c, spec, want, why = c) => { assert.equal(G(c, spec), want, `git: ${why}`); assert.equal(F(c, spec), want, `files: ${why}`); };

const SQL = { 'm.sql': 'create table t (a int);\n', 't.sql': 'begin;\nselect 1;\nrollback;\n', 'ok.sh': 'echo ok\n' };
const DB = 'DB="postgresql://postgres:postgres@127.0.0.1:54322/postgres"; ';

test('S8: the database workflows of the replay are allowed (static text + migration file + heredoc, fed to psql)', () => {
  for (const c of [
    `${DB}{ echo "begin;"; cat m.sql; cat <<'SQL'\nselect p.proname from pg_proc p where p.proname in ('a','b') order by 1;\nrollback;\nSQL\n} | psql "$DB" -v ON_ERROR_STOP=1 -At 2>&1 | grep -v '^COMMENT$'`,
    `P=/opt/homebrew/opt/libpq/bin/psql; { echo "begin;"; cat m.sql; echo "select count(*) from pg_proc p where p.pronamespace='public'::regnamespace;\nrollback;"; } | $P "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -v ON_ERROR_STOP=1 -At`,
    `${DB}(echo "begin; revoke execute on function public.is_staff() from anon;"; sed -n '/^begin;$/,$p' t.sql | sed '1d;$d'; echo "rollback;") | psql "$DB" 2>&1 | grep -E "ERROR" | head -2`,
    `${DB}{ echo "begin;"; cat m.sql; echo "rollback;"; } | psql "$DB"`,
  ]) both(c, SQL, 'allow');
});

test('S8: static text and a script fed to one shell are judged as the stream they make (allowed when harmless)', () => {
  for (const c of [
    '{ echo "echo a"; cat ok.sh; } | bash',
    '{ cat ok.sh; echo hi; } | bash',
    "{ printf '%s\\n' 'echo a'; cat ok.sh; } | bash",
    "{ cat <<'EOF'\necho a\nEOF\ncat ok.sh; } | bash",
    'bash <(echo "echo a"; cat ok.sh)',
  ]) both(c, SQL, 'allow');
});

// a guarded line split between static text and a file
const SPLIT_G = { 'b.sh': 'sh origin main\n', 'c.sh': 'push origin main\n' };
const SPLIT_F = { 'b.sh': 'aude/settings.json\n' };
test('S8: a guarded command split between the static text and a file is found in the rebuilt stream: refused', () => {
  for (const c of [
    '{ echo -n "git pu"; cat b.sh; } | bash',
    "{ printf 'git pu'; cat b.sh; } | bash",
    "{ printf '%s' 'git pu'; cat b.sh; } | bash",
    "{ printf '%s%s' 'git ' 'pu'; cat b.sh; } | bash",
    'bash <(echo -n "git pu"; cat b.sh)',
    "(echo -n 'git pu'; sed -n p b.sh) | bash",
  ]) assert.equal(G(c, SPLIT_G), 'deny', c);
  // a heredoc ends with a newline, but a backslash before it continues the line into the file
  assert.equal(G("{ cat <<'EOF'\ngit \\\nEOF\ncat c.sh; } | bash", SPLIT_G), 'deny', '(line continuation into the file)');
  assert.equal(G("{ cat <<-'EOF'\n\tgit \\\n\tEOF\ncat c.sh; } | bash", SPLIT_G), 'deny', '(<<- strips the tabs)');
  for (const c of [
    '{ echo -n "echo x > /home/u/.cl"; cat b.sh; } | bash',
    "{ printf '%s' 'echo x > /home/u/.cl'; cat b.sh; } | bash",
  ]) assert.equal(F(c, SPLIT_F), 'deny', c);
});

test('S8: a psql meta-command split between printf text and a file is found in the rebuilt stream: refused', () => {
  const spec = { 'q.sql': ' git push origin main\n' };
  assert.equal(G(`${DB}{ printf '%s' '\\!'; cat q.sql; } | psql "$DB"`, spec), 'deny');
  assert.equal(F(`${DB}{ printf '%s' '\\!'; cat q.sql; } | psql "$DB"`, { 'q.sql': ' echo x > /home/u/.claude/settings.json\n' }), 'deny');
});

test('S8: static text that cannot be rebuilt exactly, or that may not reach the stream, keeps the stream refused', () => {
  const S = { 'a.sh': 'git pu', 'b.sh': 'sh origin main\n', 'ok.sh': 'echo ok\n' };
  for (const c of [
    '{ echo -n "$X"; cat b.sh; } | bash', // an expansion
    "{ echo 'git pu\\c'; cat b.sh; } | bash", // a backslash echo may interpret (zsh does by default)
    "{ printf '%d' 1; cat b.sh; } | bash", // a format printf processes
    "{ printf -- '%s' 'git pu'; cat b.sh; } | bash", // an option
    '{ cat <<EOF\n$X\nEOF\ncat b.sh; } | bash', // an unquoted heredoc that expands
    '{ true && echo -n "git pu"; cat b.sh; } | bash', // may not run
    '{ echo -n "#" > /dev/null; cat a.sh; cat b.sh; } | bash', // prints elsewhere: the join a+b must not get a "#" in front
    '{ echo -n "#" >&2; cat a.sh; cat b.sh; } | bash',
    '{ echo -n "#" & cat a.sh; cat b.sh; } | bash', // in the background
    '{ echo -n "git pu" | cat - b.sh; } | bash', // one command printing static text and a file
    'eval "$(echo -n \'git pu\'; cat b.sh)"', // not a stream the guard rebuilds
    'S=bash; { echo -n "git pu"; cat b.sh; } | $S',
  ]) assert.equal(G(c, S), 'deny', c);
});

// ---- found while building S8 (in 828f36d too) -------------------------------------------------------------------------------------------------------------------

test('S8: a substitution body inside a group prints into its word, not the stream: no part of the join (`{ X=$(cat x); cat a; cat b; } | bash`)', () => {
  const S = { 'x.sh': '#', 'a.sh': 'git pu', 'b.sh': 'sh origin main\n', 'ok.sh': 'echo ok\n' };
  assert.equal(G('{ X=$(cat x.sh); cat a.sh; cat b.sh; } | bash', S), 'deny');
  assert.equal(G('{ X=$(cat x.sh); cat a.sh; echo "sh origin main"; } | bash', S), 'deny');
  assert.equal(G('(X=$(cat x.sh); cat a.sh; cat b.sh) | bash', S), 'deny');
  assert.equal(G('{ X=$(cat x.sh); cat ok.sh; } | bash', S), 'allow');
});

test('S8: a substitution split into words, joined by eval or with text around it is not the exact script: its files are scanned', () => {
  const S = { 'a.sh': 'git\npush origin main\n', 'g.sh': 'git\n', 'p.sh': 'push origin main\n', 'ok.sh': 'echo ok\n' };
  for (const c of [
    'eval $(cat a.sh)', // the lines become ONE command
    'eval `cat a.sh`',
    'eval $(cat g.sh p.sh)',
    'eval "$(cat g.sh)" "$(cat p.sh)"', // eval joins its words with spaces
    'eval echo "$(cat p.sh)"',
    '$(cat a.sh)', // the command word
    '`cat a.sh`',
    'bash -c $(cat a.sh)',
  ]) assert.equal(G(c, S), 'deny', c);
  for (const c of ['eval "$(cat ok.sh)"', 'bash -c "$(cat ok.sh)"', 'eval $(cat ok.sh)']) assert.equal(G(c, S), 'allow', c);
});

test('S8: a `<<-` heredoc is judged without the leading tabs the shell strips (a tab hid a continued line)', () => {
  for (const c of ["bash <<-'EOF'\n\tgit pu\\\n\tsh origin main\n\tEOF", "bash <<-EOF\n\tgit pu\\\n\tsh origin main\n\tEOF", "{ cat <<-'EOF'\n\tgit pu\\\n\tEOF\ncat b.sh; } | bash"]) assert.equal(G(c, { 'b.sh': 'sh origin main\n' }), 'deny', c);
  assert.equal(G("bash <<-'EOF'\n\techo a\n\tEOF", {}), 'allow');
});

test('S8: printf reuses its format for the arguments left (`printf %s a b` prints ab)', () => {
  assert.equal(G("{ printf '%s' 'git ' 'pu'; cat b.sh; } | bash", { 'b.sh': 'sh origin main\n' }), 'deny');
  assert.equal(G("{ printf '%s\\n' 'echo a' 'echo b'; cat ok.sh; } | bash", { 'ok.sh': 'echo ok\n' }), 'allow');
});

test('S8: the rebuilt stream keeps the newline echo, printf and a heredoc print (a harmless stream stays allowed)', () => {
  const S = { 'c.sh': 'push origin main\n' }; // (`git ` then a newline, then `push ...`: two commands, no push)
  for (const c of ['{ echo "git "; cat c.sh; } | bash', "{ printf 'git \\n'; cat c.sh; } | bash", "{ cat <<'EOF'\ngit \nEOF\ncat c.sh; } | bash", '{ cat <<< "git "; cat c.sh; } | bash']) assert.equal(G(c, S), 'allow', c);
  for (const c of ['{ echo -n "git "; cat c.sh; } | bash', "{ printf 'git '; cat c.sh; } | bash"]) assert.equal(G(c, S), 'deny', c);
});

test('S8: more twins that stay refused (an empty heredoc, a stream cut short, a rewritten part that may not run or prints elsewhere, text before a substitution)', () => {
  const S = { 'a.sh': 'sh origin main', 'b.sh': 'sh origin main\n', 'c.sh': '-feature\n', 'x.sh': 'X', 't.sh': 't push origin main\n' };
  for (const c of [
    "{ echo -n 'git pu'; cat <<'EOF'\nEOF\ncat b.sh; } | bash", // an empty heredoc prints nothing (not a newline)
    '{ echo -n "git pu"; cat a.sh; exit 0; cat c.sh; } | bash', // the stream may stop before c.sh: `git push origin main`
    'set -e; { echo -n "git pu"; cat a.sh; false; cat c.sh; } | bash',
    "{ printf '#\\ngit pu'; cat a.sh; } | bash", // printf's \n is a newline: the push is not commented out
    "(echo -n 'git pu'; false && sed -n p x.sh; sed -n p b.sh) | bash",
    "(echo -n 'git pu'; echo -n X >&2; sed -n p b.sh) | bash",
    'eval "gi$(cat t.sh)"',
  ]) assert.equal(G(c, S), 'deny', c);
});

test('S8: a ( ) subshell after && / || may not run, as a { } group: it is no certain part of the stream (in 828f36d too)', () => {
  const S = { 'a.sh': 'git pu', 'x.sh': '\n#', 'c.sh': 'sh origin main\n' };
  for (const c of [
    '{ cat a.sh; true || (cat x.sh); cat c.sh; } | bash',
    '{ cat a.sh; true || { cat x.sh; }; cat c.sh; } | bash',
    "{ echo -n 'git pu'; true || (echo '#'); cat c.sh; } | bash",
    "(echo -n 'git pu'; true || (sed -n p x.sh); sed -n p c.sh) | bash",
  ]) assert.equal(G(c, S), 'deny', c);
  assert.equal(G('{ cat ok.sh; (cat ok.sh); } | bash', { 'ok.sh': 'echo ok\n' }), 'allow', '(a plain subshell surely runs)');
});

test('S8: eval of a program\'s output is unknown text that may cd anywhere: only `eval "$(cat f)"` is read as the file (replay of 828f36d vs S8)', () => {
  // (as in 828f36d: the text the script prints is run, then $L is used: refused like any run-time script choice; read as the file it would be allowed)
  assert.equal(F('L=sdd && eval "$(bash $L/stack.sh env)" && npm run x > $L/a.log 2>&1', { 'sdd/stack.sh': 'echo export X=1\n' }), 'deny');
  assert.equal(F('L=sdd && bash <<< "$(bash $L/stack.sh env)" && npm run x > $L/a.log 2>&1', { 'sdd/stack.sh': 'echo export X=1\n' }), 'deny');
  for (const c of ['eval "$(supabase status -o env)" && rm -f .claude/settings.json', 'bash <<< "$(supabase status -o env)"; rm -f .claude/settings.json']) assert.equal(F(c, {}), 'deny', c);
});
