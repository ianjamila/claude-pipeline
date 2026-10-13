// Why (PR A2, batch S6, part 2): superpowers' SDD helpers (task-brief, review-package -> sdd-workspace) were still refused after the case-pattern fix: a cd inside
// `$( )` counted for the whole script, the cd sdd-workspace ends with counted for the writes before it, words in a comment (or in a grep pattern elsewhere on the
// line) switched off the `${BASH:-bash}` reading, an `if` at the top made every later write "maybe first", and the git policy read every assignment after an `if`
// as "may not run". Each test pins the workflow that must pass next to the nearest dangerous twin that must stay refused. Fake file systems like
// guard-a2-shell-s5d.test.mjs; guarded text only lives in fake file contents or command strings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname, basename } from 'node:path';
import { evaluateGitCommand } from '../pipeline/hooks/lib/git-policy.mjs';
import { evaluateBashForFiles } from '../pipeline/hooks/lib/files-policy.mjs';
import { simpleCommands, runsAfter } from '../pipeline/hooks/lib/shell-parse.mjs';

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
const REAL_ENV = { HOME: '/home/u', ZDOTDIR: '/home/u' };
const git = (command, fsOpts, o = {}) => evaluateGitCommand(command, {
  cwd: GIT_ROOT, home: '/home/u', currentBranch: () => 'agent/x', pushDestination: () => null, issueLabels: () => [], ...fsOpts, ...o,
});
const files = (command, fsOpts, o = {}) => evaluateBashForFiles(command, {
  home: '/home/u', env: REAL_ENV, platform: 'linux', realpath: (p) => p, cwd: PROJ, ...fsOpts, existsSync: fsOpts.pathExists, ...o,
});
const BAD_GIT = 'git push origin main';
const BAD_WRITE = 'echo x > /home/u/.claude/settings.json';
const DIRS = ['sub', '/home/u'];
const F = (command, spec, o) => files(command, fakeFs(PROJ, spec, DIRS), o).decision;
const Fr = (command, spec, o) => files(command, fakeFs(PROJ, spec, DIRS), o);
const G = (command, spec, o) => git(command, fakeFs(GIT_ROOT, spec, DIRS), o).decision;
const marks = (c) => Object.entries(c.ctl).filter(([, v]) => v).map(([k]) => k).join(',');

// ---- the parser's marks -----------------------------------------------------------------------------------------------------------------------------------

test('S6b parse: every command carries the subshells it runs in (grp): $( ), ( ), backticks, <( ), and a heredoc body expands where its command runs', () => {
  const cs = simpleCommands('a; x=$(b; (c)); `d`; e <(f); (g <<EOF\n$(h)\nEOF\n)');
  const by = Object.fromEntries(cs.filter((c) => c.argv.length).map((c) => [c.argv[0], c.grp]));
  assert.deepEqual(by.a, []);
  assert.equal(by.b.length, 1);
  assert.equal(by.c.length, 2);
  assert.deepEqual(by.c.slice(0, 1), by.b);
  assert.equal(by.d.length, 1);
  assert.deepEqual(by.e, []);
  assert.equal(by.f.length, 1);
  assert.equal(by.g.length, 1);
  assert.deepEqual(by.h.slice(0, by.g.length), by.g, 'the heredoc body of g expands in g\'s subshell');
  assert.equal(by.h.length, by.g.length + 1, '(in a substitution of its own)');
  // distinct subshells get distinct ids
  assert.notDeepEqual(by.b, by.d);
  // a heredoc whose body is read after its subshell closed: the body and the commands finished with it still belong to that subshell
  const late = simpleCommands('x=$(cat <<EOF); y\n$(h)\nEOF\n(cat <<EOF; bash -c "z")\nbody\nEOF');
  const cats = late.filter((c) => c.argv[0] === 'cat');
  const lh = late.find((c) => c.argv[0] === 'h');
  const lz = late.find((c) => c.argv[0] === 'z');
  assert.equal(cats.length, 2);
  for (const c of cats) assert.equal(c.grp.length, 1, 'cat runs in its subshell although the queue finishes it later');
  assert.deepEqual(lh.grp.slice(0, 1), cats[0].grp, 'the body of the first heredoc expands in the substitution');
  assert.deepEqual(lz.grp.slice(0, 1), cats[1].grp, 'bash -c text run in the subshell');
  assert.deepEqual(late.find((c) => c.argv[0] === 'y').grp, []);
});

test('S6b parse: loops, function bodies, trap actions and if / case branches are marked (ctl), and the names a text defines as functions are listed (fns)', () => {
  const cs = simpleCommands('f() { a; }; function g { b; }; function h() ( c ); k l () { d; }\nfor i in 1; do e; done; x\nwhile y; do z; done\ntrap "t" EXIT\nif p; then q; else r; fi; s\ncase $v in w) u ;; esac; after');
  const m = Object.fromEntries(cs.filter((c) => c.argv.length).map((c) => [c.argv.join(' '), marks(c)]));
  for (const k of ['a', 'b', 'c', 'd']) assert.equal(m[k], 'fn', k);
  assert.equal(m.e, 'loop');
  assert.equal(m.y, 'loop', 'the loop condition runs again too');
  assert.equal(m.z, 'loop');
  assert.equal(m.t, 'trap');
  for (const k of ['p', 'q', 'r', 'u']) assert.equal(m[k], 'cond', k);
  for (const k of ['x', 's', 'after']) assert.equal(m[k], '', `${k}: after the construct ended`);
  assert.deepEqual([...cs.fns].sort(), ['f', 'g', 'h', 'k', 'l']);
  // every command of a longer body, and none after it
  const body = simpleCommands('f() {\n  a1\n  a2; a3\n}\nfunction g {\n  b1\n  b2\n}\nafter');
  const bm = Object.fromEntries(body.filter((c) => c.argv.length).map((c) => [c.argv[0], marks(c)]));
  for (const k of ['a1', 'a2', 'a3', 'b1', 'b2']) assert.equal(bm[k], 'fn', k);
  assert.equal(bm.after, '');
  // a `done` / `}` / `fi` inside a substitution or a -c text closes nothing outside it
  const n = simpleCommands('while a; do x=$(done; fi); b; done; c');
  assert.equal(marks(n.find((c) => c.argv[0] === 'b')), 'loop');
  assert.equal(marks(n.find((c) => c.argv[0] === 'c')), '');
});

test('S6b parse: runsAfter lists what may run after a command (later ones in its subshell, trap actions), or null when the order cannot be told', () => {
  const at = (t, name) => { const cs = simpleCommands(t); return [cs, cs.findIndex((c) => c.argv[0] === name)]; };
  const names = (r) => (r === null ? null : r.map((c) => c.argv[0]));
  assert.deepEqual(names(runsAfter(...at('a; cd x; b; c', 'cd'))), ['b', 'c']);
  assert.deepEqual(names(runsAfter(...at('a; y=$(cd x; b); c', 'cd'))), ['b'], 'the subshell ends: c is not after it');
  assert.deepEqual(names(runsAfter(...at('trap "t" EXIT; cd x; b', 'cd'))), ['t', 'b'], 'a trap action fires later');
  assert.deepEqual(names(runsAfter(...at('f() { w; }; cd x; b', 'cd'))), ['b'], 'a function body only runs when called');
  for (const t of [
    'for i in 1; do cd x; done; b', // in a loop: runs again before the loop's earlier commands
    'f() { cd x; }; f', // in a function body
    'pwd() { w; }; cd x; pwd', // a later command named like a function the text defines
    'Pwd() { w; }; cd x; pwd', // (names compared without case)
    'chpwd() { w; }; cd x', // zsh runs chpwd after every cd
    'TRAPEXIT() { w; }; cd x', // zsh runs it at exit
    'source lib.sh; cd x; b', // a sourced file may set traps, functions, aliases
    'alias pwd=w; cd x; pwd',
    'eval "$X"; cd x',
    'functions[pwd]=w; cd x; pwd',
    '$CMD; cd x', // a command known only at run time
  ]) assert.equal(runsAfter(...at(t, 'cd')), null, t);
});

test('S6b parse: a word in a comment binds no BASH, a binder in code still does (also one a comment-looking line inside a quote hides)', () => {
  const bound = (t) => { const st = { bound: false, rewrote: false }; simpleCommands(t, { bashState: st, env: {} }); return st.bound; };
  assert.equal(bound('# Single source of truth\n# read or overwrite another plan\'s\necho hi'), false);
  assert.equal(bound('echo hi # eval it later'), false);
  for (const t of [
    'source x.sh',
    'eval "$X"',
    'read -r "$n"',
    'x=\'\n# \' ; read "$v" ; \'\n\'', // the `#` line is inside a quote: the read is code
    'cat <<EOF\n# source\nEOF', // a heredoc body is no comment to us: stricter
    'echo "# source"', // a quoted word is no comment
  ]) assert.equal(bound(t), true, JSON.stringify(t));
});

// ---- files policy: where a cd reaches ---------------------------------------------------------------------------------------------------------------------

test('S6b files: a cd inside a subshell where only reads run reaches nothing outside it; a write inside that subshell, or any non-read, keeps the old reading', () => {
  const spec = { 'r.txt': 'x' };
  assert.equal(F('d=$(cd "$Q" && pwd); echo hi > out.txt', spec), 'allow');
  assert.equal(F('d=$(CDPATH= cd -- "$(dirname "$P")" && pwd -P); echo hi > out.txt', spec), 'allow');
  assert.equal(F('(cd "$Q"; ls); echo hi > out.txt', spec), 'allow');
  assert.equal(F('d=$(cd "$Q" && echo hi > out.txt)', spec), 'deny');
  assert.equal(F('(cd "$Q"; echo hi > out.txt)', spec), 'deny');
  assert.equal(F('(cd "$Q"; touch out.txt)', spec), 'deny');
  assert.equal(F('cd "$Q"; echo hi > out.txt', spec), 'deny');
  // its target is no directory the line works in either (a protected one included); a write in that subshell still is judged there
  assert.equal(F('d=$(cd /home/u/.claude && pwd); echo hi > settings.json', spec), 'allow');
  assert.equal(F('(cd /home/u/.claude && echo hi > settings.json)', spec), 'deny');
});

const SCRIPT = (body) => ({ 's.sh': body, 'lib.sh': 'echo lib' });
test('S6b files: in a script run by a shell, a cd into an unknown directory that only reads come after reaches no write before it', () => {
  assert.equal(F('bash s.sh', SCRIPT('echo hi > out.txt\ncd "$U" && pwd\n')), 'allow');
  assert.equal(F('bash s.sh', SCRIPT('echo hi > out.txt\nCDPATH= cd -- "$U" && pwd\n')), 'allow');
  assert.equal(F('bash s.sh', SCRIPT('trap "echo bye" EXIT\necho hi > out.txt\ncd "$U" && pwd\n')), 'allow');
  assert.equal(F('bash s.sh', SCRIPT('f() { echo hi > out.txt; }\nf\ncd "$U" && pwd\n')), 'allow');
});

test('S6b files: ... and each way something may write after it keeps the old reading', () => {
  for (const body of [
    'cd "$U"\necho hi > out.txt\n', // a write after it
    'cd "$U" && touch out.txt\n',
    'for i in 1 2; do echo hi > out.txt; cd "$U"; done\n', // the loop's earlier write runs again after it
    'trap "echo bye > out.txt" EXIT\ncd "$U"\n', // the trap fires after it
    'pwd() { echo hi > out.txt; }\ncd "$U" && pwd\n', // `pwd` is the script's function
    'Pwd() { echo hi > out.txt; }\ncd "$U" && Pwd\n',
    'chpwd() { echo hi > out.txt; }\ncd "$U"\n', // zsh runs chpwd after the cd
    'f() { cd "$U"; }\necho hi > out.txt\nf\n', // the cd is in a function body
    'source lib.sh\necho hi > out.txt\ncd "$U"\n', // the sourced file may have set a trap
  ]) assert.equal(F('bash s.sh', SCRIPT(body)), 'deny', JSON.stringify(body));
  // the line itself, or a sourced file: the next command (or call) goes on in that directory
  assert.equal(F('echo hi > out.txt; cd "$U" && pwd', {}), 'deny');
  assert.equal(F('source s.sh', SCRIPT('echo hi > out.txt\ncd "$U" && pwd\n')), 'deny');
});

// ---- files policy: write order -----------------------------------------------------------------------------------------------------------------------------

test('S6b files: a write later in a script than the script it runs cannot change it, even after an `if`; in a loop, a function or a trap it can', () => {
  // (bad.sh holds the guarded write: the scripts below never spell a protected path, so only the order of the copy decides)
  const spec = (body) => ({ 's.sh': body, 'h.sh': 'echo hi', 'bad.sh': BAD_WRITE });
  assert.equal(F('bash s.sh', spec('if [ -n "$X" ]; then echo x; fi\nbash h.sh\ncp bad.sh h.sh\n')), 'allow');
  assert.equal(F('bash s.sh', spec('case "$X" in a) echo a ;; esac\nbash h.sh\n{ cat bad.sh; } > h.sh\n')), 'allow');
  for (const body of [
    'for i in 1 2; do bash h.sh; cp bad.sh h.sh; done\n',
    'while read l; do bash h.sh; cp bad.sh h.sh; done\n',
    'f() { bash h.sh; }\nf\ncp bad.sh h.sh\nf\n',
    'trap "bash h.sh" EXIT\ncp bad.sh h.sh\n',
    'cp bad.sh h.sh\nif [ -n "$X" ]; then echo x; fi\nbash h.sh\n', // (copied before: as always)
  ]) assert.equal(F('bash s.sh', spec(body)), 'deny', JSON.stringify(body));
});

// ---- files policy: BASH in a script run by bash -------------------------------------------------------------------------------------------------------------

const TB = '#!/usr/bin/env bash\n# Single source of truth: read or overwrite another plan\'s\nplan=$1\ndir=$("${BASH:-bash}" "$(cd "$(dirname "$0")" && pwd)/helper" "$plan")\necho "$dir"\n';
test('S6b files: in a script run by plain bash, `${BASH:-bash}` names bash whatever the rest of the line (or the script\'s comments) says', () => {
  // (a harmful login file: the old reading, `${BASH:-bash}` unknown, ends in a login shell that reads it; the bash reading never does)
  const ok = { 'scripts/tb': TB, 'scripts/helper': 'echo hi', '/home/u/.bash_profile': BAD_WRITE };
  const bad = { ...ok, 'scripts/helper': BAD_WRITE };
  const BIND = 'grep -n "export type X\\|export interface Y" f.ts; ';
  for (const pre of ['', BIND, 'read -r "$n" < f; ']) {
    assert.equal(F(`${pre}bash scripts/tb plan.md`, ok), 'allow', pre);
    assert.equal(F(`${pre}bash scripts/tb plan.md`, bad), 'deny', `${pre} (the helper is judged)`);
  }
  assert.equal(F(`S=scripts; ${BIND}bash $S/tb plan.md`, ok), 'allow', '(the script picked through a variable)');
  // the bash reads a startup file first (it may bind BASH), or the line may change which program `bash` is: the old reading
  assert.equal(F('BASH_ENV=rc bash scripts/tb plan.md', { ...ok, rc: 'read -r BASH' }), 'deny');
  assert.equal(F(`${BIND}PATH=/tmp/x:$PATH bash scripts/tb plan.md`, ok), 'deny');
});

// ---- git policy -------------------------------------------------------------------------------------------------------------------------------------------

test('S6b git: an assignment after an if / case has ended runs as surely as one before it; one inside a branch, a loop, a function or a subshell may not run', () => {
  assert.equal(G('if [ -n "$X" ]; then echo x; fi; B=agent/x; git push origin "$B"', {}), 'allow');
  assert.equal(G('case "$X" in a) echo a ;; esac; B=agent/x; git push origin "$B"', {}), 'allow');
  for (const c of [
    'B=agent/x; if [ -n "$X" ]; then B=main; fi; git push origin "$B"',
    'B=agent/x; case "$X" in a) B=main ;; esac; git push origin "$B"',
    'B=agent/x; for i in 1; do B=main; done; git push origin "$B"',
    'B=agent/x; f() { B=main; }; git push origin "$B"',
    '(B=main); git push origin "$B"',
  ]) assert.equal(G(c, {}), 'deny', c);
});

test('S6b git: in a script run by a shell, a cd into an unsure directory that nothing sensitive comes after is no refusal; on the line, in a sourced file, or before git, it is', () => {
  const sc = (body) => ({ 's.sh': body });
  const tail = 'D=a\nif [ -n "$X" ]; then D=b; fi\n';
  assert.equal(G('bash s.sh', sc(`${tail}cd "$D" && pwd\n`)), 'allow');
  assert.equal(G('bash s.sh', sc(`${tail}cd "$D" && git push origin main\n`)), 'deny');
  assert.equal(G('bash s.sh', sc(`${tail}cd "$D"\nbash run.sh\n`)), 'deny');
  assert.equal(G('bash s.sh', sc(`for i in 1; do ${tail}cd "$D"; done\n`)), 'deny');
  assert.equal(G('source s.sh', sc(`${tail}cd "$D" && pwd\n`)), 'deny');
  // a file a script sources runs in that script: what the script runs after it goes on in that directory
  assert.equal(G('bash s.sh', { 's.sh': 'source ./lib.sh\ngit status\n', 'lib.sh': `${tail}cd "$D" && pwd\n` }), 'deny');
  assert.equal(G(`${tail.replace(/\n/g, '; ')}cd "$D" && pwd`, {}), 'deny');
});

// ---- files policy: live replay groups (S6, part 3) ---------------------------------------------------------------------------------------------------------

test('S6b files: the real home\'s .zshenv named through ZDOTDIR is not taken to be rewritten by a program the guard does not model (as without ZDOTDIR); a modelled write still counts', () => {
  const env = { HOME: '/home/u', ZDOTDIR: '/home/u' };
  const spec = { '/home/u/.zshenv': 'export EDITOR=vi' };
  assert.equal(F('mytool --version; zsh -ic \'echo hi > "$OUT"\'', spec, { env }), 'allow');
  assert.equal(F('mytool --version; zsh -ic \'echo hi > "$OUT"\'', spec, { env: { HOME: '/home/u' } }), 'allow');
  // the line writes it first (a write the guard models), or ZDOTDIR is not the home: as before
  assert.equal(F('echo "OUT=/home/u/.claude/settings.json" > /home/u/.zshenv; zsh -ic \'echo hi > "$OUT"\'', spec, { env }), 'deny');
  assert.equal(F('mytool --version; zsh -ic \'echo hi > "$OUT"\'', { '/home/u/zd/.zshenv': 'export EDITOR=vi' }, { env: { HOME: '/home/u', ZDOTDIR: '/home/u/zd' } }), 'deny');
});

test('S6b files: a line run from inside ~/.claude that first cds to an existing directory outside it is judged there; each way it may still run inside keeps the refusal', () => {
  const o = { cwd: '/home/u/.claude/hooks' };
  const spec = { '/home/u/.claude/hooks/x.sh': 'echo hi' };
  assert.equal(F('cd /home/u/proj && cp "$A" b.txt', spec, o), 'allow');
  assert.equal(F('cd ~/proj; cp "$A" b.txt', spec, o), 'allow');
  for (const c of [
    'cp "$A" b.txt', // no cd
    'cp "$A" b.txt; cd /home/u/proj', // before it
    'cd /home/u/proj || cp "$A" b.txt', // runs only when the cd failed
    'cd /home/u/proj && true || cp "$A" b.txt',
    'true && cd /home/u/proj; cp "$A" b.txt', // the cd may not run
    'cd /home/u/proj | true; cp "$A" b.txt', // in a pipeline: a subshell
    '(cd /home/u/proj); cp "$A" b.txt', // in a subshell
    'cd /home/u/gone && cp "$A" b.txt', // no such directory: the cd fails
    'cd /home/u/proj; cd /home/u/.claude/hooks; cp "$A" b.txt', // back inside
    'cd /home/u/proj; popd; cp "$A" b.txt',
    'cd "$D"; cp "$A" b.txt', // a run-time target
    'f() { cp "$A" b.txt; }; cd /home/u/proj; f', // a function body may run at any time
    'HOME=/tmp; cd ~/proj; cp "$A" b.txt', // ~ is not the real home here
  ]) assert.equal(F(c, spec, o), 'deny', c);
});

test('S6b files: a file a script sources may source another by a literal name: its effects are followed; a run-time name, a relative one, arguments, a cycle or a binder in it are not', () => {
  const base = (envSh, fix = 'export Y=2') => ({ 's.sh': 'source /home/u/proj/env.sh\necho hi > "$1"\n', 'env.sh': envSh, 'fix.sh': fix });
  assert.equal(F('bash s.sh out.txt', base('set -a\n. /home/u/proj/fix.sh\nexport X=1\n')), 'allow');
  // what the nested file assigns is what the script sees
  const vs = (fix) => ({ 's.sh': 'source /home/u/proj/env.sh\necho hi > "$OUT"\n', 'env.sh': '. /home/u/proj/fix.sh\n', 'fix.sh': fix });
  assert.equal(F('bash s.sh', vs('OUT=/home/u/proj/out.txt')), 'allow');
  assert.equal(F('bash s.sh', vs('OUT=/home/u/.claude/settings.json')), 'deny');
  assert.equal(F('bash s.sh', vs('D=/home/u/.cl\nOUT=${D}aude/settings.json')), 'deny', '(spelled in pieces: only the value followed through both files finds it)');
  for (const [envSh, fix] of [
    ['set -a\n. /home/u/proj/fix.sh\n', 'set -- /home/u/.claude/settings.json'], // the nested file sets $1
    ['. /home/u/proj/fix.sh\n', 'eval "$Z"'],
    ['. "$F"\n', 'export Y=2'],
    ['. ./fix.sh\n', 'export Y=2'],
    ['. /home/u/proj/fix.sh a b\n', 'export Y=2'],
    ['. /home/u/proj/env.sh\n', 'export Y=2'],
    ['. /home/u/proj/missing.sh\n', 'export Y=2'],
    ['. /home/u/proj/fix.sh\nexport X=1\n', 'export Y=2\nset -- /home/u/.claude/settings.json'],
  ]) assert.equal(F('bash s.sh out.txt', base(envSh, fix)), 'deny', JSON.stringify(envSh + ' | ' + fix));
});
