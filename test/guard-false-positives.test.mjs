// Why: replaying ~118k real Bash commands (21 days of transcripts) through the guards of the T1-T3 commits showed false positives
// that blocked ordinary work. Each test below is the sanitised, minimal shape of one group, with its deny twin proving the bypass
// the rule exists for stays closed:
//   A. `${f%%(*}` (a `(` inside a parameter expansion) was lexed as a glob group and swallowed the rest of the line.
//   B. `sh -c 'echo $HOME'`: a `$` in the script TEXT made the shell look like a login/interactive one, so ~/.bash_profile was judged.
//   C. The real home's startup files are judged once per evaluation, on their own text (not with the whole line's text as context).
//   D. Computed producers (`grep -E '^(A|B)='`, `sed 's/^/export /'`): words quoted in the command are literal operands, not globs.
//   E. `$(( $(cmd) - 2 ))`: arithmetic re-evaluates the text (`a[$(cmd)]` runs code), so a substitution inside it still feeds a shell.
//   F. `$T` holding `npx vitest run x.test.tsx`: only the words a wrapper/interpreter really runs are script candidates.
//   G. A bracket expression JS cannot compile still matches exactly one character in the shell.
//   H. A script named by an absolute path, judged after the line made the directory unknown (a function definition, `export PATH=…`), crashed
//      the git guard (path.resolve(null)) when the script writes a file: an internal error, so the line was denied.
// The file system is faked (like test/guard-script-expansion.test.mjs); the guarded text only lives in fake file contents.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname, basename } from 'node:path';
import { evaluateGitCommand } from '../pipeline/hooks/lib/git-policy.mjs';
import { evaluateBashForFiles } from '../pipeline/hooks/lib/files-policy.mjs';
import { simpleCommands, startupFilesOf } from '../pipeline/hooks/lib/shell-parse.mjs';

function fakeFs(root, files, dirs = []) {
  const abs = (p) => resolve(root, p);
  const F = Object.fromEntries(Object.entries(files).map(([k, v]) => [abs(k), v]));
  const D = new Set([root, ...dirs.map(abs)].map((p) => resolve(p)));
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
const BAD_GIT = 'git push origin main';
const BAD_FILES = 'echo x > ~/.claude/settings.json';
const git = (command, fsOpts, o = {}) => evaluateGitCommand(command, {
  cwd: GIT_ROOT, home: '/home/u', currentBranch: () => 'agent/x', pushDestination: () => null, issueLabels: () => [], ...fsOpts, ...o,
});
const files = (command, fsOpts, o = {}) => evaluateBashForFiles(command, {
  home: '/home/u', env: {}, platform: 'linux', realpath: (p) => p, cwd: PROJ, ...fsOpts, existsSync: fsOpts.pathExists, ...o,
});

// spec: { name: 'bad' | 'ok' | <text> }; `bad` is the guarded text of each policy. `o`: extra options (env ...)
const DIRS = ['sub', 'src', 'd', 'e'];
function both(command, spec = {}, o = {}) {
  const mk = (bad, ok) => Object.fromEntries(Object.entries(spec).map(([k, v]) => [k, v === 'bad' ? bad : v === 'ok' ? ok : v]));
  return {
    git: git(command, fakeFs(GIT_ROOT, mk(BAD_GIT, 'git status'), DIRS), o),
    files: files(command, fakeFs(PROJ, mk(BAD_FILES, 'echo hi'), DIRS), o),
  };
}
const denyBoth = (command, spec, o) => {
  const r = both(command, spec, o);
  assert.equal(r.git.decision, 'deny', `git: ${command} -> ${r.git.reason}`);
  assert.equal(r.files.decision, 'deny', `files: ${command} -> ${r.files.reason}`);
  return r;
};
const allowBoth = (command, spec, o) => {
  const r = both(command, spec, o);
  assert.equal(r.git.decision, 'allow', `git: ${command} -> ${r.git.reason}`);
  assert.equal(r.files.decision, 'allow', `files: ${command} -> ${r.files.reason}`);
};

const SPEC = { 'f.sh': 'bad', 'ok.sh': 'ok', 'x.sh': 'ok', 'f.txt': 'bad' };
// JS text a shell cannot lex (a `(` glued to a word, an apostrophe): what a test file holds
const JS = "// it's a test (not shell)\ndescribe('suite', () => {\n  it('works', () => { expect(a(1)).toBe(2) })\n})\n";

// ---- A: parameter expansion ---------------------------------------------------------------------------------------------------

test('A: a ( inside ${...} is part of the word, not a glob group that swallows the line', () => {
  for (const line of [
    'n=${f%%(*}; echo $n',
    'echo ${f%%(*} x; echo y',
    'echo ${f#*(} ${g%(*}',
    'echo ${x:-a b;c} d',
    "echo ${x:-'a }'} d",
    'echo ${x:-${y%%(*}} d',
  ]) {
    const cmds = simpleCommands(line);
    assert.equal(cmds.truncated, false, line);
  }
  const cmds = simpleCommands('n=${f%%(*}; echo $n');
  assert.deepEqual(cmds.map((c) => c.argv), [[], ['echo', '$n']]);
  assert.deepEqual(simpleCommands('echo ${x:-a b;c} d').map((c) => c.argv), [['echo', '${x:-a b;c}', 'd']]);
});

test('A: the real shape (a function-signature loop, then a heredoc program) is allowed; a command after it is still judged', () => {
  const line = [
    'for f in "fn_a(uuid,uuid[],text)" "fn_b(uuid)"; do n=${f%%(*}; echo "$n" > /work/out-$n.txt; done; cat > /work/cmp.mjs <<\'EOF\'',
    'const a = `create function ${name}(`;',
    'EOF',
    'node /work/cmp.mjs',
  ].join('\n');
  allowBoth(line, SPEC);
  denyBoth(`${line}\nbash f.sh`, SPEC);
  denyBoth('n=${f%%(*}; bash f.sh', SPEC);
  // a parenthesised group inside the braces is judged too (nothing between parentheses is dropped)
  denyBoth('echo ${x:-(bash f.sh)}', SPEC);
  denyBoth('echo ${x:-a (cat f.sh | bash) b}', SPEC);
  // a process substitution in the operand word of ${x:-word} runs: such a span is lexed normally
  denyBoth('cat ${x:-<(bash f.sh)}', SPEC);
  denyBoth('bash ${x:-<(cat f.sh)}', SPEC);
  denyBoth('cat ${x:->(bash f.sh)}', SPEC);
  denyBoth('cat ${x:-=(bash f.sh)}', SPEC);
  denyBoth('cat ${x:-`bash f.sh`}', SPEC);
  denyBoth('cat ${x:-$(bash f.sh)}', SPEC);
  // an unclosed ${ falls back to the old reading: the rest of the line is still judged
  denyBoth('echo ${x:-(; bash f.sh', SPEC);
});

// ---- B: -c script text is not an option --------------------------------------------------------------------------------------

test('B: $ in the script text of sh -c is not a login/interactive flag', () => {
  const ofLine = (l) => { const cs = simpleCommands(l); return startupFilesOf(cs.find((c) => /^(?:ba|z)?sh$/.test(c.argv[0])), cs).map((x) => x.file); };
  assert.deepEqual(ofLine("sh -c 'echo $HOME'"), []);
  assert.deepEqual(ofLine('zsh -c "echo $HOME"'), ['~/.zshenv']);
  assert.deepEqual(ofLine("xargs -I{} sh -c 'echo {} $HOME'"), []);
  // an option word that expands, or a script word that does, could still be -l / -i
  assert.ok(ofLine('zsh $X -c true').includes('~/.zprofile'));
  assert.ok(ofLine('zsh "$X" true').includes('~/.zprofile'));
  assert.ok(ofLine('bash -${X} -c true').includes('~/.bash_profile'));
  assert.ok(ofLine('bash -l -c "echo $HOME"').includes('~/.bash_profile'));
});

test('B: a real-home login file holding guarded text still denies a login shell, not a plain sh -c', () => {
  const spec = { ...SPEC, '/home/u/.bash_profile': 'bad', '/home/u/.profile': 'bad', '/home/u/.zprofile': 'bad', '/home/u/.zshrc': 'bad' };
  allowBoth("sh -c 'echo $HOME'", spec);
  allowBoth("printf x | xargs -I{} sh -c 'echo {} $HOME'", spec);
  allowBoth('zsh -c "echo $HOME"', spec);
  denyBoth('bash -l -c "echo $HOME"', spec);
  denyBoth('zsh -l -c "echo $HOME"', spec);
  denyBoth('zsh $X -c true', spec);
});

// ---- C: the real home's startup files are an independent evaluation -----------------------------------------------------------

test('C: the real home startup file is judged on its own text, not with the whole line as context', () => {
  // a file that names a run-time file is fine unless IT mentions a guarded operation; the line around it does not matter
  const spec = { ...SPEC, '/home/u/.bash_profile': 'source "$LOCAL/env.sh"\n', '/home/u/.profile': 'source "$LOCAL/env.sh"\n' };
  const g = git('git push origin agent/x; bash -l -c true', fakeFs(GIT_ROOT, spec, DIRS));
  assert.equal(g.decision, 'allow', g.reason);
  // (the files policy judges the same file the same way: a clean file allows a login shell)
  const f = files('bash -l -c true', fakeFs(PROJ, spec, DIRS));
  assert.equal(f.decision, 'allow', f.reason);
  // the same file with guarded text of its own is denied, whatever the line says
  const bad = { ...SPEC, '/home/u/.bash_profile': `source "$LOCAL/env.sh"\n${BAD_GIT}\n`, '/home/u/.profile': 'ok' };
  assert.equal(git('bash -l -c true', fakeFs(GIT_ROOT, bad, DIRS)).decision, 'deny');
  const badF = { ...SPEC, '/home/u/.bash_profile': `source "$LOCAL/env.sh"\n${BAD_FILES}\n`, '/home/u/.profile': 'ok' };
  assert.equal(files('bash -l -c true', fakeFs(PROJ, badF, DIRS)).decision, 'deny');
  // a run-time name next to guarded text in the file is the file's own problem
  const both2 = { ...SPEC, '/home/u/.bash_profile': 'source "$LOCAL/env.sh"; git push origin agent/x\n', '/home/u/.profile': 'ok' };
  assert.equal(git('bash -l -c true', fakeFs(GIT_ROOT, both2, DIRS)).decision, 'deny');
});

test('C: explicit startup files (BASH_ENV=, ZDOTDIR=, HOME=) are still judged with the line as context', () => {
  const spec = { ...SPEC, 'rc.sh': 'source "$LOCAL/env.sh"\n' };
  const g = git('git push origin agent/x; BASH_ENV=rc.sh bash x.sh', fakeFs(GIT_ROOT, spec, DIRS));
  assert.equal(g.decision, 'deny', 'the line mentions push and the file names a run-time file');
  denyBoth('BASH_ENV=f.sh bash x.sh', SPEC);
});

test('C: the real-home verdict is computed once per evaluation (many shells, one read)', () => {
  const run = (line) => {
    let reads = 0;
    const fs0 = fakeFs(GIT_ROOT, { ...SPEC, '/home/u/.bash_profile': 'echo hi\n', '/home/u/.profile': 'echo hi\n' }, DIRS);
    const fs1 = { ...fs0, readText: (p) => { if (/bash_profile$/.test(p)) reads++; return fs0.readText(p); } };
    const g = git(line, fs1);
    assert.equal(g.decision, 'allow', g.reason);
    return reads;
  };
  assert.ok(run('bash -l -c a') >= 1);
  assert.equal(run('bash -l -c a; bash -l -c b; sh -l -c c; bash -l -c d'), run('bash -l -c a'));
});

// ---- D: quoted words of a computed producer are literal -----------------------------------------------------------------------

test('D: regex and sed programs quoted in a producer are not candidate scripts', () => {
  for (const c of [
    'eval "$(supabase status -o env | grep -E \'^(API_URL|SERVICE_ROLE_KEY)=\')"',
    "source <(grep -E '^(A|B)=' .env.local | head -1)",
    "source <(grep X .env | sed 's/^/export /')",
    'source <(sed -n "/^DIR=/,/^}/p" ok.sh | sed "s|a|b|")',
    "eval $(grep '^[A-Z_]*=' .env | cut -d: -f2-)",
  ]) allowBoth(c, SPEC);
});

test('D: a file operand of a computed producer is still judged; an unquoted unresolvable pattern is still refused', () => {
  denyBoth("sed 's/^/export /' f.sh | bash", SPEC);
  denyBoth("source <(sed -n '/^a/p' f.sh)", SPEC);
  denyBoth("eval \"$(grep -E '^(A|B)=' f.sh)\"", SPEC);
  denyBoth('sed p @(f|x).sh | bash', SPEC);
  denyBoth('eval "$(sed p ^ok.sh)"', SPEC);
  denyBoth("sed p 'f'@(x|y).sh | bash", SPEC);
  // quoting only part of the word does not hide an unquoted pattern in the rest
  denyBoth("sed p f.s'h'*(a) | bash", SPEC);
});

test('D: producers that read files nobody names are unknown; quoted patterns of other operands are not literals', () => {
  const stage = (c) => both(c, SPEC);
  // the line mentions a guarded operation / protected file, and the script text comes from files the producer finds itself
  for (const c of [
    "eval \"$(find . -name '*.sh' -exec cat {} +)\"; git push origin main",
    "grep -rh --include='*.sh' '' . | sh; git push origin main",
    "tar -xOf a.tar '*.sh' | sh; git push origin main",
    "eval \"$(rg -g '*.sh' '' .)\"; git push origin main",
    "eval \"$(git grep -h '' -- '*.sh')\"; git push origin main",
  ]) assert.equal(stage(c).git.decision, 'deny', c);
  for (const c of [
    "eval \"$(find . -name '*.sh' -exec cat {} +)\"; echo x > ~/.claude/settings.json",
    "grep -rh --include='*.sh' '' . | sh; echo x > ~/.claude/settings.json",
  ]) assert.equal(stage(c).files.decision, 'deny', c);
  // a quoted pattern that is NOT the program text still globs: it reaches a real file
  denyBoth("cat 'f*.sh' | sh", SPEC);
  denyBoth("sed -e p 'f*.sh' | sh", SPEC);
  denyBoth("eval \"$(grep -h '' --include='*.sh' f.sh)\"", SPEC);
  // without a guarded word on the line an unbounded producer alone is fine
  allowBoth("eval \"$(find . -name '*.sh' | head -1)\"", { 'ok.sh': 'ok' });
});

// ---- E: arithmetic expansion ----------------------------------------------------------------------------------------------------

test('E: text fed through $(( )) is still judged (a subscript like a[$(cmd)] runs code)', () => {
  const sub = { 'f.sh': 'a[$(git push origin main)]', 'ok.sh': 'echo hi' };
  const subF = { 'f.sh': 'a[$(echo x > ~/.claude/settings.json)]', 'ok.sh': 'echo hi' };
  const g = (c) => git(c, fakeFs(GIT_ROOT, sub, DIRS));
  const f = (c) => files(c, fakeFs(PROJ, subF, DIRS));
  for (const c of ['echo $(( $(cat f.sh) ))', 'n=$(($(cat f.sh) + 1))']) {
    assert.equal(g(c).decision, 'deny', c);
    assert.equal(f(c).decision, 'deny', c);
  }
  assert.equal(g('echo $(( $(cat ok.sh | wc -l) + 1 ))').decision, 'allow');
  // a producer that rewrites a file it reads is a scan: a file holding guarded text is refused even inside arithmetic
  allowBoth('sed -n "$(($(grep -n x ok.sh | cut -d: -f1)-2)),+4p" ok.sh', SPEC);
  denyBoth('sed -n "$(($(grep -n x f.txt | cut -d: -f1)-2)),+4p" f.txt', SPEC);
  // a subshell group that merely ends in )) is a command substitution: what it prints is run
  denyBoth('eval "$((cat f.sh); echo)"', SPEC);
  denyBoth('$($(cat f.sh))', SPEC);
  denyBoth('$(($(cat f.sh)) )', SPEC);
  denyBoth('$((cat f.sh) && (echo hi))', SPEC);
});

// ---- F: a variable holding a command line --------------------------------------------------------------------------------------

test('F: a variable holding a command line that runs files is judged as that line', () => {
  const spec = { ...SPEC, 'src/a.test.tsx': JS };
  denyBoth("X=\"bash -c 'bash f.sh'\"; $X", spec);
  denyBoth('X="sh -s"; $X < f.sh', spec);
  denyBoth('X="sh -s"; cat f.sh | $X', spec);
  denyBoth('X="eval bash f.sh"; $X', spec);
  denyBoth('X=". f.sh"; $X', spec);
  denyBoth('X="source f.sh"; $X', spec);
  denyBoth('X="nohup bash f.sh"; $X', spec);
  // it runs where the command runs, with the line's variables
  const sub = { ...spec, 'sub/f.sh': 'bad', 'sub/ok.sh': 'ok' };
  denyBoth('cd sub; X="bash f.sh"; $X', { ...sub, 'f.sh': 'ok' });
  denyBoth('F=f.sh; cd sub; X="bash $F"; $X', { ...sub, 'f.sh': 'ok' });
  // a custom IFS splits the value somewhere else: every part stays a candidate
  denyBoth('IFS=:; X=bash:f.sh; $X', spec);
  denyBoth('IFS=:; X="env:bash:f.sh"; $X', spec);
  // the shell only splits the value at blanks: quotes, # and ; are ordinary characters, so every part stays a candidate
  denyBoth('X="bash #x f.sh"; $X', spec);
  denyBoth("X=\"bash 'a f.sh\"; $X", spec);
  denyBoth('X="env ;x f.sh"; $X', spec);
  denyBoth('X="bash <x f.sh"; $X', spec);
  allowBoth('X="bash -c true"; $X', spec);
  allowBoth('X="sh -s"; $X < ok.sh', spec);
});

test('F: $T holding a runner and a test file runs the runner, not the test file as a shell script', () => {
  const spec = { ...SPEC, 'src/a.test.tsx': JS };
  allowBoth('T="npx vitest run src/a.test.tsx"; $T 2>&1 | head -5', spec);
  allowBoth('T="npx vitest run src/a.test.tsx"; $T', spec);
  // the words a shell, interpreter or wrapper really runs stay candidates
  denyBoth('T="bash f.sh"; $T', spec);
  denyBoth('T="env A=1 bash f.sh"; $T', spec);
  denyBoth('T="./f.sh arg"; $T', spec);
  denyBoth('T=./f.sh; $T', spec);
  denyBoth('T="sh -x f.sh"; $T', spec);
  denyBoth('T="env ./f.sh"; $T', spec);
  denyBoth('T="npx env bash f.sh"; $T', spec);
});

// ---- G: brackets JS cannot compile ----------------------------------------------------------------------------------------------

test('G: a bracket expression that does not compile still matches one character', () => {
  // `[\w-.]` is a valid shell bracket; JS refuses the range. It reaches ~/.claude/settings.json through `settings.json`'s own letters
  const f = (c) => files(c, fakeFs(PROJ, { 'ok.sh': 'echo hi' }, DIRS));
  assert.equal(f('echo x > ~/.clau[\\w-.]e/settings.json').decision, 'deny');
  assert.equal(f('echo x > ~/.clau[z-a]e/settings.json').decision, 'deny');
  assert.equal(f('echo x > ~/.claude/[\\w-.]ettings.json').decision, 'deny');
  // a word that cannot line up with a protected root stays allowed
  assert.equal(f('echo x > ./[...x]').decision, 'allow');
  assert.equal(f('echo x > /tmp/[z-a]/out.txt').decision, 'allow');
});

// ---- review findings ----------------------------------------------------------------------------------------------------------

test('B: an option word that globs or expands (extglob, zsh patterns, subshell text) may be -l / -i', () => {
  const ofLine = (l) => { const cs = simpleCommands(l); return startupFilesOf(cs.find((c) => /^(?:ba|z)?sh$/.test(c.argv[0])), cs).map((x) => x.file); };
  for (const l of ['bash @(-l) -c true', 'bash !(x) -c true', 'bash +(-l) -c true', 'bash ?(-l) -c true', 'bash *(-l) -c true', 'zsh ^x -c true', 'zsh [-]l -c true']) {
    assert.ok(ofLine(l).some((f) => /profile$/.test(f)), l);
  }
  // only the script text after -c is exempt
  assert.deepEqual(ofLine("sh -c '(cd d; make)'"), []);
  assert.deepEqual(ofLine("bash -c '[ -f x ] && true'"), []);
  // an unquoted expansion after -c can split into more options
  for (const l of ['bash -c $X true', 'bash -c ${=L} true', 'zsh -c $(echo -l) true', 'zsh -c "$X" true', 'bash -c `echo -l` true']) assert.ok(ofLine(l).some((f) => /profile$/.test(f)), l);
});

test('C: variables the line sets reach the real home startup file (NVM_DIR=d ... source "$NVM_DIR/nvm.sh")', () => {
  const rc = 'source "$NVM_DIR/nvm.sh"\n';
  const spec = (bad) => ({ ...SPEC, '/home/u/.bash_profile': rc, '/home/u/.profile': rc, '/home/u/.zshenv': rc, '/home/u/.zprofile': 'echo hi', 'd/nvm.sh': bad ? 'bad' : 'ok', 'e/nvm.sh': 'ok' });
  denyBoth("NVM_DIR=d bash -l -c 'echo'", spec(true));
  denyBoth('export NVM_DIR=d; zsh -c :', spec(true));
  denyBoth('NVM_DIR=d; export NVM_DIR; bash -l -c true', spec(true));
  denyBoth('NVM_DIR=$(echo d) bash -l -c true', spec(true));
  denyBoth('export NVM_DIR=$(pwd)/d; zsh -c :', spec(true));
  allowBoth("NVM_DIR=e bash -l -c 'echo'", spec(true));
  allowBoth('export NVM_DIR=e; zsh -c :', spec(true));
  allowBoth('NVM_DIR=d bash -l -c true', spec(false));
  // a relative value resolves where the shell starts, not in the hook's directory
  const rel = { ...spec(true), 'sub/d/nvm.sh': 'bad', 'sub/e/nvm.sh': 'ok', 'd/nvm.sh': 'ok' };
  denyBoth('cd sub && NVM_DIR=d bash -l -c true', rel);
  denyBoth('cd sub && export NVM_DIR=d; zsh -c :', rel);
  allowBoth('cd sub && NVM_DIR=e bash -l -c true', rel);
  // not set on the line: it comes from the real environment, which is judged independently
  allowBoth('bash -l -c true', spec(true));
});

test('H: a script by absolute path, judged where the directory is unknown, is judged (no internal error)', () => {
  const run = (command, spec) => git(command, fakeFs(GIT_ROOT, spec, DIRS));
  const lines = (s) => [`f() { :; }; bash ${s}`, `export PATH=/x:$PATH; bash ${s}`, `f() { :; }; bash ${s} && cd sub`];
  for (const l of lines('/work/repo/w.sh')) {
    const ok = run(l, { 'w.sh': 'echo hi > out.txt\ncd sub && echo hi > o2.txt\ncd /tmp; git status' });
    assert.equal(ok.decision, 'allow', `${l} -> ${ok.reason}`);
    const bad = run(l, { 'w.sh': `echo hi > out.txt\ncd sub && ${BAD_GIT}` });
    assert.equal(bad.decision, 'deny', l);
    assert.doesNotMatch(bad.reason, /internal error/, l);
  }
  // a script the judged one writes and then runs, from a directory that is not known: still refused
  const w = run('f() { :; }; bash /work/repo/w.sh', { 'w.sh': `cd sub; echo '${BAD_GIT}' > a.sh; bash /work/repo/sub/a.sh` });
  assert.equal(w.decision, 'deny');
  assert.doesNotMatch(w.reason, /internal error/);
});

// Why (replay 10-13): superpowers' task-brief runs its helper as `"${BASH:-bash}" "$(cd "$(dirname "$0")" && pwd)/sdd-workspace"`. The unresolved operand might have been
// `-l`, so bash was taken for a login shell reading ~/.bash_profile, whose `eval "$(brew shellenv)"` cannot be followed: every name became unknown and the helper was refused.
test('I: a helper named from the script\'s own directory (or by names the line set) is judged as that file, with no login files', () => {
  const run = (cmd, helper, extra = {}) => files(cmd, fakeFs(PROJ, {
    '/home/u/.bash_profile': 'export EDITOR=vi\neval "$(/opt/homebrew/bin/brew shellenv)"\n', 'scripts/helper': helper, ...extra,
  }, ['scripts']), { env: { HOME: '/home/u', ZDOTDIR: '/home/u' } });
  const words = ['"$(dirname "$0")/helper"', '"$(cd "$(dirname "$0")" && pwd)/helper"', '"${0%/*}/helper"', '"$(cd "$(dirname "$0")" && pwd -P)/helper"'];
  for (const w of words) {
    for (const outer of ['bash scripts/run.sh p', 'bash /home/u/proj/scripts/run.sh p', 'S=/home/u/proj/scripts; bash $S/run.sh p']) {
      const spec = { 'scripts/run.sh': `set -eu\nx=$("\${BASH:-bash}" ${w} "$1")\necho "$x"\n` };
      assert.equal(run(outer, 'echo hi', spec).decision, 'allow', `${outer} / ${w}`);
      assert.equal(run(outer, BAD_FILES, spec).decision, 'deny', `${outer} / ${w} (bad helper)`);
    }
  }
  // the operand may still be an option, or names a file elsewhere: unchanged
  assert.equal(run('X=-l; bash $X scripts/helper', 'echo hi').decision, 'deny');
  const login = { 'scripts/run.sh': 'bash "$(dirname "$0")/helper"\n', '/home/u/.bash_profile': BAD_FILES };
  assert.equal(run('bash -l scripts/run.sh', 'echo hi', login).decision, 'deny');
  // $0 changed before the word is read: not modelled, so the helper is not vouched for
  assert.equal(run('bash scripts/run.sh', 'echo hi', { 'scripts/run.sh': 'cd /tmp\nsource ./x.sh\nbash "$(dirname "$0")/helper"\n' }).decision, 'deny');
});

// Why (replay 10-13, 150 psql commands): a `:name` the psql model cannot place (`'{"a":null}'`, `':x'`: quotes are not tracked) leaves an unknown shell line, which is
// dynamic: refused when the line mentions a protected file. With a startup file that cannot be followed, every name was unknown, and the line's placeholder counted as a
// variable picking the script, so any such psql command was refused.
test('J: an unknown psql line is refused only with protected text around, also when a startup file cannot be followed', () => {
  const env = { env: { HOME: '/home/u', ZDOTDIR: '/home/u' } };
  const spec = { '/home/u/.zshenv': 'source "$(echo x)"\n' }; // (a sourced file that cannot be followed: every name is unknown)
  const run = (cmd) => files(cmd, fakeFs(PROJ, spec, DIRS), env);
  for (const sql of ["select ':x'", 'select \'{"a":null}\'::jsonb', "insert into t values ('{\"k\":\"v\"}')"]) {
    assert.equal(run(`psql -c "${sql.replaceAll('"', '\\"')}"`).decision, 'allow', sql);
    assert.equal(run(`psql -c "${sql.replaceAll('"', '\\"')}; select '/home/u/.claude/settings.json'"`).decision, 'deny', `${sql} + protected`);
  }
});
