import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitArgs, simpleCommands } from '../pipeline/hooks/lib/shell-parse.mjs';

const argvs = (s, o) => simpleCommands(s, o).map((c) => c.argv.join(' '));
const sorted = (a) => [...a].sort();

// [name, input, expected argv strings, mode]
//   'exact'    -> same set of commands, order ignored
//   'ordered'  -> same commands in the same order
//   'includes' -> every expected command is present (more are allowed)
const TABLE = [
  ['plain push', 'git push origin main', ['git push origin main'], 'exact'],
  ['cd then push', 'cd repo && git push origin main', ['cd repo', 'git push origin main'], 'ordered'],
  ['sequence and or', 'echo hi; git push -f || true', ['echo hi', 'git push -f', 'true'], 'ordered'],
  ['redirect then pipe', 'git push origin main 2>&1 | tail -5', ['git push origin main', 'tail -5'], 'exact'],
  ['bash -c double quotes', 'bash -c "git push origin main"', ['git push origin main'], 'includes'],
  ['sh -c single quotes', "sh -c 'git push -f'", ['git push -f'], 'includes'],
  ['zsh -lc compound', 'zsh -lc "cd x && git push origin HEAD:main"', ['git push origin HEAD:main', 'cd x'], 'includes'],
  ['eval one string', 'eval "git push origin main"', ['git push origin main'], 'includes'],
  ['eval bare words', 'eval git push origin main', ['git push origin main'], 'includes'],
  ['dollar-paren', 'echo $(git push origin main)', ['git push origin main'], 'includes'],
  ['backticks', 'echo `git push origin main`', ['git push origin main'], 'includes'],
  ['substitution inside double quotes', 'echo "result: $(gh pr edit 1 --add-label human-approved)"', ['gh pr edit 1 --add-label human-approved'], 'includes'],
  ['substitution inside an argument', 'echo pre-$(git push -f)-post', ['git push -f'], 'includes'],
  ['quoted text is not a command', 'echo "git push origin main"', ['echo git push origin main'], 'exact'],
  ['single-quoted text is not a command', "echo 'git push origin main; rm -rf x'", ['echo git push origin main; rm -rf x'], 'exact'],
  ['single-quoted substitution is inert', "echo '$(git push origin main)'", ["echo $(git push origin main)"], 'exact'],
  ['grep pattern is not a command', 'grep -r "git push origin main" docs/', ['grep -r git push origin main docs/'], 'exact'],
  ['semicolon inside quotes', 'git commit -m "push to main; force it"', ['git commit -m push to main; force it'], 'exact'],
  ['operators inside quotes', 'echo "a && b || c | d & e"', ['echo a && b || c | d & e'], 'exact'],
  ['heredoc body is data', 'cat <<EOF > notes.md\ngit push origin main\nEOF\necho done', ['cat', 'echo done'], 'exact'],
  ['quoted heredoc body is inert', "cat <<'EOF'\n$(git push origin main)\nEOF", ['cat'], 'exact'],
  ['double-quoted heredoc delimiter is inert', 'cat <<"EOF"\n$(git push origin main)\nEOF', ['cat'], 'exact'],
  ['tab-stripped heredoc', 'cat <<-EOF\n\tgit push origin main\n\tEOF\necho after', ['cat', 'echo after'], 'exact'],
  ['env -i with assignment', 'env -i FOO=1 git push --force', ['git push --force'], 'exact'],
  ['nohup and background', 'nohup git push -f origin x &', ['git push -f origin x'], 'exact'],
  ['sudo -u', 'sudo -u bob git push origin main', ['git push origin main'], 'exact'],
  ['sudo -E with env assignment', 'sudo -E FOO=1 git push origin main', ['git push origin main'], 'exact'],
  ['xargs with stdin redirect', 'xargs git push origin < branches.txt', ['git push origin'], 'exact'],
  ['xargs with options', 'xargs -n 1 -P4 -I {} git push origin {}', ['git push origin {}'], 'exact'],
  ['timeout', 'timeout 30 git push origin main', ['git push origin main'], 'exact'],
  ['timeout with options', 'timeout -s KILL -k 5 30 git push origin main', ['git push origin main'], 'exact'],
  ['nice -n', 'nice -n 5 git push origin main', ['git push origin main'], 'exact'],
  ['time -p', 'time -p git push origin main', ['git push origin main'], 'exact'],
  ['command and exec', 'command git push -f; exec git push -f', ['git push -f', 'git push -f'], 'exact'],
  ['command -v is a lookup only', 'command -v git', ['command -v git'], 'exact'],
  ['stacked wrappers', 'sudo env FOO=1 nohup time git push origin main', ['git push origin main'], 'exact'],
  ['wrapper by absolute path', '/usr/bin/env FOO=1 /usr/bin/sudo git push origin main', ['git push origin main'], 'exact'],
  ['subshell', '(cd repo && git push origin main)', ['cd repo', 'git push origin main'], 'exact'],
  ['brace group', '{ git push origin main; }', ['git push origin main'], 'exact'],
  ['process substitution', 'diff <(git show HEAD:a) b', ['git show HEAD:a'], 'includes'],
  ['output process substitution', 'tee >(git push origin main) < in', ['git push origin main'], 'includes'],
  ['pwsh -Command', 'pwsh -NoProfile -Command "git push origin main"', ['git push origin main'], 'includes'],
  ['powershell -c with several words', 'powershell -c git push origin main', ['git push origin main'], 'includes'],
  ['powershell positional script', 'powershell -NoProfile -ExecutionPolicy Bypass "git push -f"', ['git push -f'], 'includes'],
  ['cmd /c', 'cmd /c "git push -f && echo ok"', ['git push -f', 'echo ok'], 'includes'],
  ['pipeline helper keeps full argv', 'node ~/.claude/pipeline/bin/pipeline.mjs job start x -- gh pr edit 1 --add-label human-approved', ['node ~/.claude/pipeline/bin/pipeline.mjs job start x -- gh pr edit 1 --add-label human-approved'], 'exact'],
  ['line continuation', 'git push \\\n  origin main', ['git push origin main'], 'exact'],
  ['git -C is left alone', 'git -C ../other push origin main', ['git -C ../other push origin main'], 'exact'],
  ['nested bash -c three deep', 'bash -c "bash -c \\"bash -c \'git push -f\'\\""', ['git push -f'], 'includes'],
  ['export stays argv', 'export PIPELINE_ADMIN=1 && git push', ['export PIPELINE_ADMIN=1', 'git push'], 'exact'],
  ['newline separates commands', 'echo a\ngit push -f\necho b', ['echo a', 'git push -f', 'echo b'], 'ordered'],
  ['empty and whitespace', '  \n ; ;; \t', [], 'exact'],

  // shell keywords must not hide the command that follows them
  ['if/then', 'if git push origin main; then echo ok; fi', ['git push origin main', 'echo ok'], 'exact'],
  ['while/do', 'while ! git push origin main; do sleep 1; done', ['git push origin main', 'sleep 1'], 'exact'],
  ['for loop body', 'for b in a b; do git push origin $b; done', ['for b in a b', 'git push origin $b'], 'exact'],
  ['case branch', 'case $x in main) git push origin main ;; esac', ['case $x in main', 'git push origin main'], 'exact'],
  ['function body on one line', 'function f { git push -f; }; f', ['git push -f', 'f'], 'exact'],
  ['posix function definition', 'f() { git push -f; }', ['f', 'git push -f'], 'exact'],
  ['negation', '! git push -f', ['git push -f'], 'exact'],

  // comments are not commands
  ['trailing comment', 'echo hi # git push origin main; rm x', ['echo hi'], 'exact'],
  ['hash inside a word is not a comment', 'echo a#b; git push -f', ['echo a#b', 'git push -f'], 'exact'],
  ['comment line then command', '# note: git push origin main\ngit status', ['git status'], 'exact'],

  // redirections never become command words
  ['redirect forms', 'cmd1 >out 2>err <in >>app &>all >|force 2>&1 3>&- arg', ['cmd1 arg'], 'exact'],
  ['attached and spaced targets', 'echo a>f; echo b > g; echo c 1>h', ['echo a', 'echo b', 'echo c'], 'exact'],
  ['digit argument is kept when not glued to a redirect', 'echo 2 > f', ['echo 2'], 'exact'],
  ['here-string', 'cat <<< "git push origin main"', ['cat'], 'exact'],
  ['redirect before the command', '>out git push origin main', ['git push origin main'], 'exact'],
  ['arithmetic does not open a heredoc', 'echo $((1<<3))\ngit push -f', ['echo $((1<<3))', 'git push -f'], 'includes'],
  ['arithmetic command', '(( x = 1 << 2 ))\ngit push -f', ['git push -f'], 'includes'],

  // things a shell executes that are easy to overlook
  ['unquoted heredoc still expands substitutions', 'cat <<EOF\nhello $(git push origin main)\nEOF', ['git push origin main', 'cat'], 'exact'],
  ['unquoted heredoc backticks', 'cat <<EOF\n`git push -f`\nEOF', ['git push -f', 'cat'], 'exact'],
  ['escaped dollar in heredoc is inert', 'cat <<EOF\n\\$(git push -f)\nEOF', ['cat'], 'exact'],
  ['heredoc fed to bash is the script', "bash <<'EOF'\ngit push origin main\nEOF", ['git push origin main', 'bash'], 'exact'],
  ['heredoc fed to sh -s', 'sh -s <<EOF\ngit push -f\nEOF', ['git push -f', 'sh -s'], 'exact'],
  ['here-string fed to bash', 'bash <<< "git push origin main"', ['git push origin main', 'bash'], 'exact'],
  ['echo piped into bash', 'echo "git push origin main" | bash', ['echo git push origin main', 'bash', 'git push origin main'], 'exact'],
  ['printf piped into sh', "printf 'git push -f\\n' | sh", ['git push -f', 'sh'], 'includes'],
  ['cat heredoc piped into sh', 'cat <<EOF | sh\ngit push -f\nEOF', ['cat', 'sh', 'git push -f'], 'exact'],
  ['trap action runs as a script', 'trap "git push -f" EXIT', ['git push -f'], 'includes'],
  ['trap reset has no script', 'trap - EXIT; trap INT', ['trap - EXIT', 'trap INT'], 'exact'],
  ['bash script file is not guessed at', 'bash deploy.sh', ['bash deploy.sh'], 'exact'],
  ['find -exec', "find . -name '*.x' -exec git push -f {} \\;", ['git push -f {}'], 'includes'],
  ['ansi-c quoting decodes', "$'g\\x69t' push -f", ["git push -f"], 'exact'],
  ['assignment value substitution runs', 'X=$(git push -f) true', ['git push -f', 'true'], 'exact'],
  ['array literal is not a subshell', 'arr=(main dev); echo done', ['echo done'], 'includes'],
  ['pipe with trailing operator across newline', 'echo "git push -f" |\nbash', ['echo git push -f', 'bash', 'git push -f'], 'exact'],
];

for (const [name, input, expected, mode] of TABLE) {
  test(`simpleCommands: ${name}`, () => {
    const got = argvs(input);
    if (mode === 'ordered') assert.deepEqual(got, expected, `input: ${JSON.stringify(input)}`);
    else if (mode === 'exact') assert.deepEqual(sorted(got), sorted(expected), `input: ${JSON.stringify(input)}`);
    else for (const e of expected) assert.ok(got.includes(e), `missing ${JSON.stringify(e)} in ${JSON.stringify(got)} for ${JSON.stringify(input)}`);
  });
}

test('FOO=1 git push records env and strips it from argv', () => {
  const [c, ...more] = simpleCommands('FOO=1 git push origin main');
  assert.equal(more.length, 0);
  assert.deepEqual(c.argv, ['git', 'push', 'origin', 'main']);
  assert.deepEqual(c.env, { FOO: '1' });
});

test('quoted assignment values and several assignments', () => {
  const [c] = simpleCommands('FOO=1 BAR="x y" BAZ=\'q r\' git push');
  assert.deepEqual(c.argv, ['git', 'push']);
  assert.deepEqual(c.env, { FOO: '1', BAR: 'x y', BAZ: 'q r' });
});

test('a bare assignment line is still returned, with empty argv', () => {
  const cmds = simpleCommands('PIPELINE_ADMIN=1');
  assert.equal(cmds.length, 1);
  assert.deepEqual(cmds[0].argv, []);
  assert.deepEqual(cmds[0].env, { PIPELINE_ADMIN: '1' });
});

test('assignment then command on the next statement stays separate', () => {
  const cmds = simpleCommands('PIPELINE_ADMIN=1; git push origin main');
  assert.deepEqual(cmds.map((c) => [c.argv.join(' '), c.env]), [['', { PIPELINE_ADMIN: '1' }], ['git push origin main', {}]]);
});

test('a quoted NAME= is a command word, not an assignment', () => {
  const [c] = simpleCommands('"FOO=1" git push');
  assert.deepEqual(c.argv, ['FOO=1', 'git', 'push']);
  assert.deepEqual(c.env, {});
});

test('env wrapper and sudo record their assignments next to inline ones', () => {
  const [a] = simpleCommands('A=1 env B=2 git push');
  assert.deepEqual(a.argv, ['git', 'push']);
  assert.deepEqual(a.env, { A: '1', B: '2' });
  const [b] = simpleCommands('sudo PIPELINE_ADMIN=1 git push');
  assert.deepEqual(b.env, { PIPELINE_ADMIN: '1' });
});

test('env -S splits its string into the command line', () => {
  assert.deepEqual(simpleCommands('env -S "git push -f" origin')[0].argv, ['git', 'push', '-f', 'origin']);
  assert.deepEqual(simpleCommands('env --split-string="git push" -f')[0].argv, ['git', 'push', '-f']);
});

test('an assignment named __proto__ is recorded, not swallowed', () => {
  const [c] = simpleCommands('__proto__=x git push');
  assert.deepEqual(Object.keys(c.env), ['__proto__']);
});

test('raw keeps the whole simple command text including redirects and wrappers', () => {
  const cmds = simpleCommands('cd repo && sudo git push origin main 2>&1 | tail -5');
  assert.deepEqual(cmds.map((c) => c.raw), ['cd repo', 'sudo git push origin main 2>&1', 'tail -5']);
});

test('raw of a nested command is the nested text', () => {
  const cmds = simpleCommands('echo "x: $(gh pr edit 1 --add-label human-approved > /dev/null)"');
  assert.ok(cmds.some((c) => c.raw === 'gh pr edit 1 --add-label human-approved > /dev/null'));
});

test('depth is 0 at top level and grows through substitutions and interpreters', () => {
  const byArgv = (s) => Object.fromEntries(simpleCommands(s).map((c) => [c.argv.join(' '), c.depth]));
  assert.equal(byArgv('git push')['git push'], 0);
  assert.equal(byArgv('echo $(git push)')['git push'], 1);
  assert.equal(byArgv('echo "$(echo `git push`)"')['git push'], 2);
  assert.equal(byArgv('bash -c "git push"')['git push'], 1);
  assert.equal(byArgv('(cd x; git push)')['git push'], 0);
});

test('depth cap: deeper than maxDepth is not parsed and the result says so', () => {
  const nested = 'echo $(echo $(echo $(git push -f)))';
  const shallow = simpleCommands(nested, { maxDepth: 2 });
  assert.ok(!shallow.some((c) => c.argv.join(' ') === 'git push -f'));
  assert.equal(shallow.truncated, true);
  const deep = simpleCommands(nested, { maxDepth: 3 });
  assert.ok(deep.some((c) => c.argv.join(' ') === 'git push -f'));
  assert.equal(deep.truncated, false);
});

test('deep nesting within maxDepth still finds the command', () => {
  const s = 'bash -c "bash -c \\"bash -c \'git push -f\'\\""';
  assert.ok(argvs(s).includes('git push -f'));
  assert.ok(argvs(s, { maxDepth: 3 }).includes('git push -f'));
});

test('600 semicolon-separated commands are capped at 500 and flagged, never thrown', () => {
  const cmds = simpleCommands(Array(600).fill('true').join(';'));
  assert.ok(cmds.length <= 500);
  assert.equal(cmds.length, 500);
  assert.equal(cmds.truncated, true);
});

test('exactly 500 commands is not truncated', () => {
  const cmds = simpleCommands(Array(500).fill('true').join(';'));
  assert.equal(cmds.length, 500);
  assert.equal(cmds.truncated, false);
});

test('pathological nesting does not blow the stack or hang', () => {
  for (const s of ['$('.repeat(100000), '('.repeat(100000), '`'.repeat(100001), 'bash -c "'.repeat(5000), '{ '.repeat(50000), '<<'.repeat(50000)]) {
    const started = Date.now();
    const cmds = simpleCommands(s);
    assert.ok(Array.isArray(cmds));
    assert.ok(Date.now() - started < 5000, 'finished in reasonable time');
  }
});

test('truncated is a non-enumerable property so deepEqual on the array is unaffected', () => {
  const cmds = simpleCommands('git status');
  assert.equal(cmds.truncated, false);
  assert.deepEqual(Object.keys(cmds), ['0']);
});

test('unterminated constructs never throw and keep what they have', () => {
  for (const s of ['echo "abc', "echo 'abc", 'echo $(git push', 'echo `git push', 'echo $(git push "x', '(git push', '{ git push', 'cat <<EOF\ngit push', 'bash -c', 'bash -c "git push', 'echo \\', 'cmd >', 'a=(b', '$((1', "$'abc"]) {
    assert.doesNotThrow(() => simpleCommands(s), s);
  }
  assert.ok(argvs('echo $(git push origin main').includes('git push origin main'));
  assert.ok(argvs('(git push origin main').includes('git push origin main'));
  assert.deepEqual(argvs('echo "abc'), ['echo abc']);
});

test('non-string and odd input never throws', () => {
  for (const v of [undefined, null, 42, {}, [], '']) assert.doesNotThrow(() => simpleCommands(v));
  assert.deepEqual(simpleCommands(undefined), []);
  assert.doesNotThrow(() => simpleCommands('git push', null));
  assert.doesNotThrow(() => simpleCommands('git push', { maxDepth: Infinity }));
  assert.doesNotThrow(() => simpleCommands('git push', { maxDepth: -3 }));
});

test('random shell-ish garbage never throws (deterministic fuzz)', () => {
  const alphabet = ['a', 'git ', 'push', ' ', ' ', '"', "'", '`', '$(', ')', '(', '{', '}', ';', '&&', '||', '|', '&', '\n', '\\', '<<EOF', '<<-', '<', '>', '2>&1', '#', '$', '=', 'bash -c ', 'env ', 'sudo ', '$((', '<(', '>('];
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let k = 0; k < 3000; k++) {
    let s = '';
    for (let j = 0, len = 1 + Math.floor(rnd() * 40); j < len; j++) s += alphabet[Math.floor(rnd() * alphabet.length)];
    assert.doesNotThrow(() => { for (const c of simpleCommands(s)) assert.ok(Array.isArray(c.argv) && typeof c.raw === 'string'); }, JSON.stringify(s));
  }
});

test('pwsh -EncodedCommand is decoded', () => {
  const b64 = Buffer.from('git push -f', 'utf16le').toString('base64');
  assert.ok(argvs(`pwsh -NoProfile -EncodedCommand ${b64}`).includes('git push -f'));
  assert.ok(argvs(`powershell -ec ${b64}`).includes('git push -f'));
});

test('pwsh -File runs a script file, so nothing is guessed', () => {
  assert.deepEqual(argvs('pwsh -File run.ps1 -Command x'), ['pwsh -File run.ps1 -Command x']);
});

test('bash flags before -c: -o, -O and long options are skipped', () => {
  assert.ok(argvs('bash -o pipefail -c "git push -f"').includes('git push -f'));
  assert.ok(argvs('bash --norc --noprofile -c "git push -f"').includes('git push -f'));
  assert.ok(argvs('bash -O extglob -ec "git push -f"').includes('git push -f'));
  assert.ok(argvs('/bin/bash -c "git push -f" arg0 arg1').includes('git push -f'));
});

test('bash -c is found after env and sudo wrappers', () => {
  assert.ok(argvs('sudo -u bob env FOO=1 bash -c "git push -f"').includes('git push -f'));
  assert.ok(argvs('xargs -I{} sh -c "git push {}"').includes('git push {}'));
});

test('the outer interpreter command is included as well', () => {
  assert.deepEqual(sorted(argvs('bash -c "git push origin main"')), sorted(['bash -c git push origin main', 'git push origin main']));
  assert.deepEqual(sorted(argvs('eval "git push origin main"')), sorted(['eval git push origin main', 'git push origin main']));
});

test('nested subshell inside substitution inside quotes', () => {
  assert.ok(argvs('echo "a $(echo "b $(git push -f)" c) d"').includes('git push -f'));
});

test('command separator inside nested quotes of a substitution is not special', () => {
  const got = argvs('echo "$(echo \'a; git push -f\')"');
  assert.ok(!got.includes('git push -f'), JSON.stringify(got));
});

test('commands after a heredoc on the same line pipeline still parse', () => {
  assert.deepEqual(sorted(argvs('cat <<EOF | grep x\nbody git push -f\nEOF\ngit status')), sorted(['cat', 'grep x', 'git status']));
});

test('two heredocs on one line', () => {
  assert.deepEqual(sorted(argvs('diff <<A <<B\none\nA\ntwo\nB\necho end')), sorted(['diff', 'echo end']));
});

test('CRLF line endings are tolerated', () => {
  assert.deepEqual(argvs('echo a\r\ngit push -f\r\n'), ['echo a', 'git push -f']);
  assert.deepEqual(sorted(argvs('cat <<EOF\r\nx\r\nEOF\r\necho done')), sorted(['cat', 'echo done']));
});

// ---- splitArgs ---------------------------------------------------------------------------------

test('splitArgs: quotes, escaped quotes and escaped spaces', () => {
  assert.deepEqual(splitArgs('\'a b\' "c \\"d\\"" e\\ f'), ['a b', 'c "d"', 'e f']);
});

test('splitArgs: unterminated quote makes the rest one word', () => {
  assert.deepEqual(splitArgs('"abc'), ['abc']);
  assert.deepEqual(splitArgs("x 'a b c"), ['x', 'a b c']);
  assert.deepEqual(splitArgs('x "a b\\'), ['x', 'a b\\']);
});

test('splitArgs: empty quotes are empty words, empty input is no words', () => {
  assert.deepEqual(splitArgs('a "" \'\' b'), ['a', '', '', 'b']);
  assert.deepEqual(splitArgs(''), []);
  assert.deepEqual(splitArgs('   \t  '), []);
  assert.deepEqual(splitArgs(undefined), []);
});

test('splitArgs: double-quote escapes are only \\" \\\\ \\$ \\`', () => {
  assert.deepEqual(splitArgs('"a\\$b \\`c\\\\ \\n"'), ['a$b `c\\ \\n']);
});

test('splitArgs: single quotes are fully literal', () => {
  assert.deepEqual(splitArgs("'a\\b $x \"q\"'"), ['a\\b $x "q"']);
});

test('splitArgs: operators are ordinary characters and quoted pieces glue to neighbours', () => {
  assert.deepEqual(splitArgs('a;b && c|d'), ['a;b', '&&', 'c|d']);
  assert.deepEqual(splitArgs('pre"mid dle"post'), ['premid dlepost']);
});

test('splitArgs: line continuation and ANSI-C quoting', () => {
  assert.deepEqual(splitArgs('a \\\nb'), ['a', 'b']);
  assert.deepEqual(splitArgs("$'a\\tb' c"), ['a\tb', 'c']);
});

// ---- robustness additions ----------------------------------------------------------------------

test('depth cap also applies to interpreter and backtick recursion', () => {
  const viaBash = simpleCommands("bash -c \"bash -c 'git push -f'\"", { maxDepth: 1 });
  assert.ok(!viaBash.some((c) => c.argv.join(' ') === 'git push -f'));
  assert.equal(viaBash.truncated, true);
  assert.ok(simpleCommands("bash -c \"bash -c 'git push -f'\"", { maxDepth: 2 }).some((c) => c.argv.join(' ') === 'git push -f'));
  const viaTicks = simpleCommands('echo `echo \\`git push -f\\``', { maxDepth: 1 });
  assert.ok(!viaTicks.some((c) => c.argv.join(' ') === 'git push -f'));
  assert.equal(viaTicks.truncated, true);
  assert.equal(simpleCommands('git push', { maxDepth: 0 }).truncated, false);
  assert.equal(simpleCommands('bash -c "git push"', { maxDepth: 0 }).truncated, true);
});

test('an unterminated heredoc (or a << we misread) never hides the lines after it', () => {
  assert.ok(argvs('cat <<EOF\nhello\ngit push -f').includes('git push -f'));
  assert.ok(argvs('echo $[1<<3]\ngit push -f').includes('git push -f'));
});

test('arithmetic << is not mistaken for a heredoc (the next line is a real top-level command)', () => {
  for (const s of ['echo $((1<<3))\ngit push -f', '(( x = 1 << 2 ))\ngit push -f', 'echo $(( 1 << 3 ))\ngit push -f']) {
    const hit = simpleCommands(s).find((c) => c.argv.join(' ') === 'git push -f');
    assert.ok(hit && hit.depth === 0, s);
  }
});

test('a heredoc that IS terminated keeps its body hidden even when it looks like commands', () => {
  assert.deepEqual(argvs('cat <<EOF\ngit push -f\nrm -rf /\nEOF'), ['cat']);
});

test('PowerShell script blocks and call operator expose their commands', () => {
  assert.ok(argvs('Get-ChildItem | ForEach-Object { git push -f }').includes('git push -f'));
  assert.ok(argvs('if ($ok) { git push -f } else { echo no }').includes('git push -f'));
  assert.ok(argvs('& git push -f').includes('git push -f'));
});

test('PowerShell $env:NAME assignments are recorded as env', () => {
  const env = (s) => simpleCommands(s).filter((c) => c.argv.length === 0).map((c) => c.env);
  assert.deepEqual(env('$env:PIPELINE_ADMIN = "1"; git push'), [{ PIPELINE_ADMIN: '1' }]);
  assert.deepEqual(env("$env:PIPELINE_ADMIN='1'; git push"), [{ PIPELINE_ADMIN: '1' }]);
  assert.deepEqual(env('$Env:FOO=bar'), [{ FOO: 'bar' }]);
  assert.deepEqual(env('echo $env:FOO'), []);
  assert.ok(argvs('$env:X = 1; git push -f').includes('git push -f'));
});

test('an unclosed array literal does not swallow the commands after it', () => {
  assert.ok(argvs('a=(b; git push -f').includes('git push -f'));
  assert.ok(argvs('a=(b c) && git push -f').includes('git push -f'));
});

test('braces that are not standalone words stay inside their word', () => {
  assert.deepEqual(argvs('git stash show stash@{0}'), ['git stash show stash@{0}']);
  assert.deepEqual(argvs('find . -exec echo {} \\;').slice(0, 1), ['find . -exec echo {} ;']);
  assert.deepEqual(argvs('echo ${HOME}/x {a,b}'), ['echo ${HOME}/x {a,b}']);
});
