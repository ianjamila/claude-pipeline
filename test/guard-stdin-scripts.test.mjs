// Why (issues #20 + item g + a T1 residual): the guards judged a script only when it was NAMED (`bash f.sh`). Script text that
// reaches a shell without being named was never read: `bash < f.sh`, `cat f.sh | bash`, `bash <(cat f.sh)`, `eval "$(cat f.sh)"`,
// `$(cat f.sh)` as the command. And a run-time word before `-c` or before a `<(...)` operand (`bash -o $X -c f.sh`,
// `bash $X <(cat f.sh)`) was not treated as ambiguous, although it decides which word the shell runs.
// Now the files such text comes from are judged like `bash F` (a reader of named files: cat/less, `< F`,
// here-strings, process and command substitutions); a producer that REWRITES what it reads (sed, awk, base64, tr, head, tail, tac ...) makes the
// text unknowable, so a named file that holds a guarded word is refused. A program run by path that is over the read cap
// is peeked at (`readHead`): a shell script is refused, a binary or an interpreter file keeps its old verdict.
// The file system is faked (like test/guard-script-expansion.test.mjs); the guarded text only lives in fake file contents.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname, basename } from 'node:path';
import { evaluateGitCommand } from '../pipeline/hooks/lib/git-policy.mjs';
import { evaluateBashForFiles } from '../pipeline/hooks/lib/files-policy.mjs';
import { scriptFileOf, scriptFeedsOf, simpleCommands } from '../pipeline/hooks/lib/shell-parse.mjs';

// `files`: path -> text (null = exists but cannot be read); `heads`: path -> the first bytes of a file readText cannot read.
// Every key is resolved, absolute ones too: lookups go through resolve(), which on Windows turns `/home/u` into `D:\home\u`.
function fakeFs(root, files, dirs = [], heads = {}) {
  const abs = (p) => resolve(root, p);
  const F = Object.fromEntries(Object.entries(files).map(([k, v]) => [abs(k), v]));
  const H = Object.fromEntries(Object.entries(heads).map(([k, v]) => [abs(k), v]));
  const D = new Set([root, ...dirs.map(abs)].map((p) => resolve(p)));
  const names = (d) => {
    const out = new Set();
    for (const p of [...Object.keys(F), ...D]) if (p !== d && dirname(p) === d) out.add(basename(p));
    return [...out];
  };
  return {
    readText: (p) => (typeof F[resolve(p)] === 'string' ? F[resolve(p)] : null),
    readHead: (p) => (typeof H[resolve(p)] === 'string' ? H[resolve(p)] : null),
    pathExists: (p) => resolve(p) in F || D.has(resolve(p)),
    readDir: (p) => (D.has(resolve(p)) ? names(resolve(p)) : null),
  };
}

const GIT_ROOT = resolve('/work/repo');
const PROJ = '/home/u/proj';
const BAD_GIT = 'git push origin main';
const BAD_FILES = 'echo x > ~/.claude/settings.json';
// text that is allowed when it is judged as the script it is, but mentions a guarded operation / a protected path
const MID_GIT = 'git push origin agent/x';
const MID_FILES = 'ls ~/.claude/pipeline';
const git = (command, fsOpts, o = {}) => evaluateGitCommand(command, {
  cwd: GIT_ROOT, home: '/home/u', currentBranch: () => 'agent/x', pushDestination: () => null, issueLabels: () => [], ...fsOpts, ...o,
});
const files = (command, fsOpts, o = {}) => evaluateBashForFiles(command, {
  home: '/home/u', env: {}, platform: 'linux', realpath: (p) => p, cwd: PROJ, ...fsOpts, existsSync: fsOpts.pathExists, ...o,
});

// spec: { name: 'bad' | 'ok' | <text> | null }; heads: the same keys -> head text
function both(command, spec = {}, heads = {}) {
  const mk = (bad, ok, mid) => Object.fromEntries(Object.entries(spec).map(([k, v]) => [k, v === 'bad' ? bad : v === 'ok' ? ok : v === 'mid' ? mid : v]));
  const dirs = ['sub', 'd'];
  return {
    git: git(command, fakeFs(GIT_ROOT, mk(BAD_GIT, 'git status', MID_GIT), dirs, heads)),
    files: files(command, fakeFs(PROJ, mk(BAD_FILES, 'echo hi', MID_FILES), dirs, heads)),
  };
}
const denyBoth = (command, spec, heads) => {
  const r = both(command, spec, heads);
  assert.equal(r.git.decision, 'deny', `git: ${command} -> ${r.git.reason}`);
  assert.equal(r.files.decision, 'deny', `files: ${command} -> ${r.files.reason}`);
  return r;
};
const allowBoth = (command, spec, heads) => {
  const r = both(command, spec, heads);
  assert.equal(r.git.decision, 'allow', `git: ${command} -> ${r.git.reason}`);
  assert.equal(r.files.decision, 'allow', `files: ${command} -> ${r.files.reason}`);
};

const SPEC = { 'f.sh': 'bad', 'ok.sh': 'ok', 'README.md': 'ok', 'sub/f.sh': 'bad', 'sub/ok.sh': 'ok', 'unreadable.sh': null };

// ---- #20: a run-time word before -c or before a <(...) operand ------------------------------------------------------------

test('#20: a run-time word before -c makes the script operand ambiguous: every word is a candidate file', () => {
  for (const c of [
    'bash -o $X -c f.sh', 'bash -$X -c f.sh', 'bash $(echo -o) -c f.sh', 'bash `echo -o` -c f.sh', 'sh -o $X -c f.sh', 'zsh -o $X -c f.sh',
    'bash -o $X -c "bash f.sh"', 'bash $X -c f.sh', 'bash -$X -s f.sh', 'bash -o $X -s f.sh', 'bash -$X - f.sh',
  ]) denyBoth(c, SPEC);
  for (const c of ['bash -o $X -c "echo hi"', 'bash -o $X -c ok.sh', 'bash -$X -c ok.sh']) allowBoth(c, SPEC);
});

test('#20: a run-time word before a <(...) operand: its output may be the script', () => {
  for (const c of ['bash $X <(cat f.sh)', 'bash -$X <(cat f.sh)', 'bash $(echo -x) <(cat f.sh)', 'source $X <(cat f.sh)', '. $X <(cat f.sh)', 'bash $X -x <(cat f.sh)'])
    denyBoth(c, SPEC);
  for (const c of ['bash $X <(cat ok.sh)', 'source $X <(cat ok.sh)']) allowBoth(c, SPEC);
});

test('#20: no run-time word, no ambiguity (controls)', () => {
  for (const c of ["bash -c 'echo hi'", "bash -o pipefail -c 'echo hi'", "bash -lc 'echo hi'", 'bash -c "$X"', "node -e 'console.log(1)'", 'bash ok.sh', "bash -c 'echo $HOME'"]) allowBoth(c, SPEC);
  assert.equal(scriptFileOf(['bash', '-c', 'echo hi']), null);
  assert.equal(scriptFileOf(['bash', '-o', 'pipefail', '-c', 'x']), null);
  assert.equal(scriptFileOf(['bash', '-c', '$X']), null);
  assert.deepEqual(scriptFileOf(['bash', '-o', '$X', '-c', 'f.sh']), { kind: 'shell', file: undefined, ambiguous: true, words: ['-o', '$X', '-c', 'f.sh'] });
  assert.deepEqual(scriptFileOf(['bash', '$X', '<(cat f.sh)']), { kind: 'shell', file: '$X', ambiguous: true, words: ['$X', '<(cat f.sh)'] });
  assert.equal(scriptFileOf(['bash', '<(cat f.sh)']), null);
  assert.deepEqual(scriptFileOf(['bash', '-$X', '<(cat f.sh)']), { kind: 'shell', file: '<(cat f.sh)', ambiguous: true, words: ['-$X', '<(cat f.sh)'] });
});

// ---- g: script text fed to a shell from a file ----------------------------------------------------------------------------

test('g: a stdin redirect from a file feeds a shell', () => {
  for (const c of [
    'bash < f.sh', 'sh < f.sh', 'bash -s < f.sh', 'zsh < f.sh', 'source /dev/stdin < f.sh', '. /dev/stdin < f.sh', 'bash - < f.sh', 'bash <f.sh',
    'bash < "f.sh"', 'bash 0< f.sh', 'bash -s -- a b < f.sh', 'sudo bash < f.sh', 'exec bash < f.sh', 'bash < sub/f.sh', 'bash < ./f.sh', 'bash < f.sh | cat',
    'bash <> f.sh',
  ]) denyBoth(c, SPEC);
});

test('g: a reader of named files piped into a shell feeds it', () => {
  for (const c of [
    'cat f.sh | bash', 'cat f.sh | zsh -s', 'head -c 999 f.sh | bash', 'head -n 3 f.sh | sh', 'tail -n 3 f.sh | sh', 'tail -n +2 f.sh | bash', 'tac f.sh | bash', 'less f.sh | bash',
    'cat ok.sh f.sh | bash', 'cat < f.sh | bash', 'cat -- f.sh | bash', 'cat f.sh | sh -s -- x', '{ cat f.sh; } | bash', '(cat f.sh) | bash', 'cat sub/f.sh | bash',
    'echo x | cat f.sh | bash', 'cat f.sh | source /dev/stdin', 'cat f.sh |& bash',
  ]) denyBoth(c, SPEC);
});

test('g: process substitution, here-strings and command substitution feed a shell', () => {
  for (const c of [
    'bash < <(cat f.sh)', 'bash <(cat f.sh)', 'bash <<< "$(cat f.sh)"', 'bash <<< `cat f.sh`', 'source <(cat f.sh)', '. <(cat f.sh)', 'bash -x <(cat f.sh)',
    'bash <(head -n 5 f.sh)', 'bash < <(cat < f.sh)', 'bash <(< f.sh)', 'bash <<< "$(<f.sh)"',
    'eval "$(cat f.sh)"', 'eval `cat f.sh`', 'eval "$(<f.sh)"', 'eval $(cat f.sh)', 'eval "$(head -c 99 f.sh)"', 'eval "x; $(cat f.sh)"',
    'echo "$(cat f.sh)" | bash', 'printf %s "$(cat f.sh)" | sh', "bash <<EOF\n$(cat f.sh)\nEOF", '$(cat f.sh)', '`cat f.sh`', '$(<f.sh)', '$(cat f.sh) --flag', 'bash -c "$(cat f.sh)"', 'sh -c "$(tac f.sh)"', 'zsh -c "$(< f.sh)"',
  ]) denyBoth(c, SPEC);
});

test('g: a producer that rewrites what it reads: a named file holding a guarded word is refused', () => {
  for (const c of [
    'sed s/a/b/ f.sh | bash', 'sed -n p f.sh | sh', 'awk 1 f.sh | bash', 'tr a b < f.sh | bash', 'grep -v zzz f.sh | sh', 'cat f.sh | tr a b | bash', 'cat f.sh | tee /dev/null | bash',
    'dd if=f.sh | bash', 'sed -f f.sh x | bash', 'cat f.sh | grep -v zzz | sh',
    'bash <<< "$(sed p f.sh)"', 'eval "$(awk 1 f.sh)"', 'bash <(sed p f.sh)', 'bash < <(tr a b < f.sh)', 'eval "$(cat f.sh | tr a b)"', '$(sed p f.sh)',
    'bash <<< "$(cat f.sh; echo hi)"',
  ]) denyBoth(c, SPEC);
  for (const c of ['sed s/a/b/ ok.sh | bash', 'awk 1 ok.sh | sh', 'tr a b < ok.sh | bash', 'cat ok.sh | tr a b | bash', 'eval "$(sed p ok.sh)"', 'bash <(sed p README.md)']) allowBoth(c, SPEC);
});

test('g: a plain reader feeds the file as the script (judged by what it runs); a rewriting producer only gets the word scan', () => {
  const spec = { 'mid.sh': 'mid' };
  for (const c of ['bash < mid.sh', 'cat mid.sh | bash', 'eval "$(cat mid.sh)"', 'bash <(cat mid.sh)', 'bash <<< "$(cat mid.sh)"', '$(cat mid.sh)']) allowBoth(c, spec);
  for (const c of ['sed p mid.sh | bash', 'cat mid.sh | tr a b | bash', 'eval "$(cat mid.sh | tr a b)"', 'bash <(awk 1 mid.sh)', 'cat mid.sh | tee /dev/null | sh', 'head -n 1 mid.sh | bash']) denyBoth(c, spec);
});

test('g: harmless controls stay allowed', () => {
  for (const c of [
    'bash < ok.sh', 'cat ok.sh | bash', 'cat README.md | grep x', "eval \"$(ssh-agent -s)\"", "bash -c 'echo hi'", "bash -o pipefail -c 'echo hi'", 'node -e "console.log(1)"',
    'curl -s https://x | sh', 'eval "$(cat ok.sh)"', 'bash <(cat ok.sh)', 'bash < <(cat ok.sh)', 'bash <<< "$(cat ok.sh)"', '$(cat ok.sh)', 'eval "$(direnv hook bash)"',
    'eval "$(pyenv init -)"', 'eval "$(brew shellenv)"', 'bash < nothing.sh', 'cat nothing.sh | bash',
    // the text is not run: a file that is only read, redirected or counted
    'cat f.sh', 'cat f.sh | grep x', 'cat f.sh | wc -l', 'cat f.sh > out.txt', 'head -n 3 f.sh | cat', 'echo hi | bash', 'cat f.sh | less', 'bash ok.sh < f.sh',
    'sed p f.sh | grep x', 'grep push f.sh', 'echo "$(cat f.sh)"', 'x=$(cat f.sh)',
  ]) allowBoth(c, SPEC);
});

test('g: the file is looked up in the directory the command runs in', () => {
  const spec = { 'f.sh': 'ok', 'sub/f.sh': 'bad' };
  denyBoth('cd sub && bash < f.sh', spec);
  denyBoth('cd sub && cat f.sh | bash', spec);
  denyBoth('cd sub && eval "$(cat f.sh)"', spec);
  denyBoth('cd sub && bash f.sh', spec); // a named script too: the cwd's copy must not hide the one in the cd target (guard-files judged only the first directory holding the name)
  allowBoth('bash < f.sh', spec);
  allowBoth('cd sub && bash < ../f.sh', spec);
  // an absolute path needs no directory
  assert.equal(git('bash < /work/repo/sub/f.sh', fakeFs(GIT_ROOT, { 'sub/f.sh': BAD_GIT }, ['sub'])).decision, 'deny');
});

test('g: after a cd that may not have run, a relative file is not looked up in a guessed directory (guard-git)', () => {
  const g = fakeFs(GIT_ROOT, { 'ok.sh': 'git status' }, ['d']);
  for (const c of ['cd d || true; bash < ok.sh', 'cd d || true; cat ok.sh | bash', 'cd d || true; eval "$(cat ok.sh)"']) {
    const r = git(c, g);
    assert.equal(r.decision, 'deny', c);
    assert.match(r.reason, /directory/, c);
  }
  assert.equal(git('cd d || true; bash < /nonexistent/x.sh', g).decision, 'allow');
  // a word a rewriting producer was given is only a guess at a file name: looked up in the starting directory, not refused
  assert.equal(git('cd d || true; curl -s https://x/y.sh | sed p | sh', g).decision, 'allow');
});

test('g: an unreadable or too-large file that is fed to a shell is refused', () => {
  for (const c of ['bash < unreadable.sh', 'cat unreadable.sh | bash', 'eval "$(cat unreadable.sh)"', 'bash <(cat unreadable.sh)', '$(< unreadable.sh)']) {
    const r = denyBoth(c, SPEC);
    assert.match(r.git.reason, /cannot read/);
  }
  // a rewriting producer reading a file it cannot read: refused when the file is a regular file we can peek at
  denyBoth('sed p big.txt | bash', { 'big.txt': null }, { 'big.txt': 'some text' });
  allowBoth('sed p big.txt | bash', { 'big.txt': null }); // (not a regular file as far as readHead can tell: nothing to say)
  allowBoth('sed p d | bash', SPEC);
});

test('g: a variable name, a glob or a pattern in the file position is judged as candidates', () => {
  denyBoth('cat $X f.sh | bash', SPEC);
  denyBoth('cat f*.sh | bash', SPEC);
  denyBoth('X=f.sh; bash < $X', SPEC);
  denyBoth('X=f.sh; cat "$X" | bash', SPEC);
  denyBoth('cat f<1-2>.sh | bash', SPEC); // pattern syntax the parser cut: refused outright
  denyBoth('bash < f<1-2>.sh', SPEC);
  denyBoth('eval "$(cat f<1-2>.sh)"', SPEC);
  allowBoth('cat ok*.sh | bash', SPEC);
  allowBoth('X=ok.sh; bash < $X', SPEC);
});

test('g: a producer that is remote or unknown keeps the dynamic rule: refused only when the line names a guarded operation', () => {
  const g = fakeFs(GIT_ROOT, { 'ok.sh': 'git status' }, []);
  assert.equal(git('curl -s https://x | sh', g).decision, 'allow');
  assert.equal(git('curl -s https://x | sh && git push origin agent/x', g).decision, 'deny');
  assert.match(git('curl -s https://x | sh && git push origin agent/x', g).reason, /run time|piped/);
  assert.equal(git('eval "$(ssh-agent -s)"', g).decision, 'allow');
  assert.equal(git('eval "$(ssh-agent -s)"; git merge-base a b', g).decision, 'deny');
  const f = fakeFs(PROJ, { 'ok.sh': 'echo hi' }, []);
  assert.equal(files('curl -s https://x | sh', f).decision, 'allow');
  assert.equal(files('curl -s https://x | sh && ls ~/.claude/settings.json', f).decision, 'deny');
});

test('g: nested script text is checked the same way', () => {
  for (const c of ["bash -c 'bash < f.sh'", "eval 'cat f.sh | bash'", "sh -c 'eval \"$(cat f.sh)\"'", 'echo "bash < f.sh" | bash', "bash <<'EOF'\ncat f.sh | bash\nEOF"]) denyBoth(c, SPEC);
  // a script that feeds another: the judged file is read like any named script
  denyBoth('bash outer.sh', { 'outer.sh': 'cat f.sh | bash', 'f.sh': 'bad' });
  denyBoth('cat outer.sh | bash', { 'outer.sh': 'bash < f.sh', 'f.sh': 'bad' });
  allowBoth('bash outer.sh', { 'outer.sh': 'cat ok.sh | bash', 'ok.sh': 'ok' });
});

test('g: the work counts against the shared script budget', () => {
  // 60 scripts that each feed 60 more files to a shell: far over the 128 reads one evaluation may make
  const names = Array.from({ length: 60 }, (_, i) => `c${i}.sh`);
  const inner = `cat ${names.join(' ')} | bash`;
  const spec = { ...Object.fromEntries(names.map((n) => [n, 'ok'])), ...Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`a${i}.sh`, inner])) };
  const outer = `cat ${Array.from({ length: 60 }, (_, i) => `a${i}.sh`).join(' ')} | bash`;
  const r = denyBoth(outer, spec);
  assert.match(r.git.reason, /too many script files/);
  assert.match(r.files.reason, /too many script files/);
  // more files than a feed list may hold are refused without reading any
  const many = Array.from({ length: 300 }, (_, i) => `m${i}.sh`).join(' ');
  denyBoth(`cat ${many} | bash`, { 'ok.sh': 'ok' });
  denyBoth(`bash <<< "$(cat ${many})"`, { 'ok.sh': 'ok' });
});

test('g: scriptFeedsOf lists the files that feed a command (pure parser API)', () => {
  const feeds = (line) => simpleCommands(line).flatMap((c) => scriptFeedsOf(c, line));
  assert.deepEqual(feeds('bash < f.sh'), [{ kind: 'shell', file: 'f.sh' }]);
  assert.deepEqual(feeds('cat f.sh | bash'), [{ kind: 'shell', file: 'f.sh' }]);
  assert.deepEqual(feeds('sed p f.sh | bash').map((f) => [f.kind, f.file]), [['scan', 'p'], ['scan', 'f.sh']]);
  assert.deepEqual(feeds('cat $X | bash'), [{ kind: 'shell', file: '$X', ambiguous: true, words: ['$X'] }]);
  assert.deepEqual(feeds('cat f.sh'), []);
  assert.deepEqual(feeds('echo hi | bash'), []);
  assert.deepEqual(feeds('bash ok.sh < f.sh'), []);
  assert.deepEqual(feeds('head -n 5 f.sh | bash').map((f) => [f.kind, f.file]), [['scan', 'f.sh']]); // head / tail / tac do not print the file as it is (review R1-B3)
  assert.equal(feeds('cat f<1-2>.sh | bash')[0].unresolvable, true);
  // feeds do not show up when the command is printed or compared
  assert.deepEqual(Object.keys(simpleCommands('bash < f.sh')[0]).sort(), ['argv', 'depth', 'env', 'raw', 'redirects']);
});

// ---- C: a program run by path that is over the read cap -------------------------------------------------------------------

test('C: a program run by path that is too large to read is judged by its first bytes', () => {
  const spec = { 'big.sh': null, 'bigplain': null, 'bigbin': null, 'bignode': null, 'bigpy': null, 'bigunread': null, 'ok.sh': 'ok' };
  const heads = {
    'big.sh': '#!/bin/bash\necho hi\n', 'bigplain': 'echo hi\n', 'bigbin': '\u007fELF\u0000\u0001\u0001', 'bignode': '#!/usr/bin/env node\nconsole.log(1)\n', 'bigpy': '#!/usr/bin/python3\nprint(1)\n',
  };
  for (const c of ['./big.sh', './bigplain', 'cd d && ../big.sh', './big.sh arg']) {
    const sp = c.startsWith('cd d') ? { 'big.sh': null } : spec;
    const r = both(c, sp, heads);
    assert.equal(r.git.decision, 'deny', `git: ${c}`);
    assert.equal(r.files.decision, 'deny', `files: ${c}`);
    assert.match(r.git.reason, /too large/);
    assert.match(r.files.reason, /too large/);
  }
  // a binary, an interpreter file and a file readHead cannot tell anything about keep their old verdict
  for (const c of ['./bigbin', './bignode', './bigpy', './bigunread']) allowBoth(c, spec, heads);
  // a small readable script is unchanged
  denyBoth('./f.sh', { 'f.sh': 'bad' });
  allowBoth('./ok.sh', spec, heads);
  // `bash big.sh` was already refused
  assert.match(both('bash big.sh', spec, heads).git.reason, /cannot read/);
});

test('C: readHead is optional: without it a too-large program keeps its old verdict', () => {
  const g = fakeFs(GIT_ROOT, { 'big.sh': null });
  const { readHead: _drop, ...noHead } = g;
  assert.equal(git('./big.sh', noHead).decision, 'allow');
});

test('C: a throwing readHead denies instead of letting the command through', () => {
  const g = { ...fakeFs(GIT_ROOT, { 'big.sh': null }), readHead: () => { throw new Error('boom'); } };
  const r = git('./big.sh', g);
  assert.equal(r.decision, 'deny');
  const f = { ...fakeFs(PROJ, { 'big.sh': null }), readHead: () => { throw new Error('boom'); } };
  assert.equal(files('./big.sh', f).decision, 'deny');
});

// ---- review R1-B3: head / tail / tac print PART of a file (or reverse it): the file is not the script ---------------------------------
// The whole file was parsed as the script, so `tail -n +2 payload | bash` with `echo "` / <push> / `"` in it was allowed: the quotes hide
// the push from the whole-file parse, but tail drops the first line and the shell runs it. They are rewriting producers now (word scan).
// Exact modelling of their output is a later step; refusing a guarded word in the file is the fail-closed reading.

// build(bad) -> { file: text } for each policy's own guarded line
function bothBuilt(command, build) {
  const dirs = ['sub', 'd'];
  return {
    git: git(command, fakeFs(GIT_ROOT, build(BAD_GIT), dirs)),
    files: files(command, fakeFs(PROJ, build(BAD_FILES), dirs)),
  };
}
const denyBuilt = (command, build) => {
  const r = bothBuilt(command, build);
  assert.equal(r.git.decision, 'deny', `git: ${command} -> ${r.git.reason}`);
  assert.equal(r.files.decision, 'deny', `files: ${command} -> ${r.files.reason}`);
};
const allowBuilt = (command, build) => {
  const r = bothBuilt(command, build);
  assert.equal(r.git.decision, 'allow', `git: ${command} -> ${r.git.reason}`);
  assert.equal(r.files.decision, 'allow', `files: ${command} -> ${r.files.reason}`);
};

test('R1-B3: tail -n +2 hides the first line; the quote pair that hid the guarded line from the whole-file parse is gone', () => {
  const payload = (bad) => ({ 'payload.sh': `echo "\n${bad}\n"\n` });
  for (const c of ['tail -n +2 payload.sh | bash', 'tail -n+2 payload.sh | sh', 'tail --lines=+2 payload.sh | bash', 'eval "$(tail -n +2 payload.sh)"', 'bash <(tail -n +2 payload.sh)', 'bash < <(tail -n +2 payload.sh)']) denyBuilt(c, payload);
});

test('R1-B3: tac reverses the lines; a heredoc body that hid the guarded line in file order does not in reversed order', () => {
  const payload = (bad) => ({ 'payload.sh': `cat <<EOF\n${bad}\nEOF\n` });
  for (const c of ['tac payload.sh | bash', 'eval "$(tac payload.sh)"', 'bash <(tac payload.sh)']) denyBuilt(c, payload);
});

test('R1-B3: head is a producer too: a file the exact reader used to allow (judged as the whole script) is now word-scanned', () => {
  const mid = { 'mid.sh': 'mid' };
  for (const c of ['head -n 1 mid.sh | bash', 'head -c 99 mid.sh | sh', 'tail -n 1 mid.sh | bash', 'tac mid.sh | bash', 'eval "$(head -n 1 mid.sh)"']) denyBoth(c, mid);
  for (const c of ['head -n 3 ok.sh | bash', 'tail -n +2 ok.sh | bash', 'tac ok.sh | sh', 'head -c 10 README.md | bash']) allowBoth(c, { 'ok.sh': 'ok' });
  // cat / less keep printing the file as it is
  for (const c of ['cat mid.sh | bash', 'bash < mid.sh']) allowBoth(c, mid);
});
